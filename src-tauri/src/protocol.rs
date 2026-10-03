use crate::state::{AppState, ComicItem};
use base64::{engine::general_purpose, Engine as _};
use cap_fs_ext::DirExt;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MUTABLE_IMAGE_CACHE_CONTROL: &str = "no-store";
const ARCHIVE_IMAGE_CACHE_CONTROL: &str = "private, max-age=300";

pub(crate) fn is_thumbnail_request(uri: &tauri::http::Uri) -> bool {
    uri.host() == Some("cover")
        || uri.path().starts_with("/cover/")
        || uri
            .query()
            .is_some_and(|query| query.split('&').any(|part| part == "thumbnail=1"))
}

fn route_uri_without_query(uri: &str) -> &str {
    uri.split_once('?').map_or(uri, |(route, _)| route)
}

#[derive(Debug)]
enum ArchivePageError {
    InvalidZip(String),
    MissingEntry(String),
    ImageTooLarge,
    ReadFailed(String),
}

impl ArchivePageError {
    fn status(&self) -> StatusCode {
        match self {
            Self::MissingEntry(_) => StatusCode::NOT_FOUND,
            Self::InvalidZip(_) | Self::ReadFailed(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::ImageTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        }
    }
}

impl std::fmt::Display for ArchivePageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidZip(error) => write!(f, "封存檔格式無效或不受支援：{error}"),
            Self::MissingEntry(name) => write!(f, "封存檔找不到頁面：{name}"),
            Self::ImageTooLarge => write!(f, "圖片超過 64 MiB 安全上限"),
            Self::ReadFailed(error) => write!(f, "封存檔頁面解壓失敗：{error}"),
        }
    }
}

fn read_image_limited<R: Read>(reader: R) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    reader.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_IMAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "image exceeds size limit",
        ));
    }
    Ok(buf)
}

fn get_mime(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".svg" => "application/octet-stream",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn is_page_out_of_range(page_count: usize, page_index: usize) -> bool {
    page_count > 0 && page_index >= page_count
}

fn route_shape_is_valid(parts: &[&str]) -> bool {
    matches!(
        (parts.first().copied(), parts.len()),
        (Some("folder"), 3) | (Some("page"), 3) | (Some("cover"), 2)
    )
}

fn cache_control_for_comic(comic: &ComicItem) -> &'static str {
    // Folder URLs are index-based: deleting page 3 makes the former page 4
    // become /3, so any WebView cache would serve the wrong image. Archive
    // entry indexes are stable for the current reader session and benefit from
    // a small private cache, especially when a large shelf asks for covers.
    if comic.r#type.contains("folder") || comic.r#type.contains("image") || comic.ext.is_empty() {
        MUTABLE_IMAGE_CACHE_CONTROL
    } else {
        ARCHIVE_IMAGE_CACHE_CONTROL
    }
}

fn decode_capability_path(id: &str) -> Result<String, ()> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| ())?;
    String::from_utf8(bytes).map_err(|_| ())
}

#[cfg(test)]
fn canonical_image_within(image_path: &Path, folder_path: &Path) -> Option<std::path::PathBuf> {
    let canonical_image = image_path.canonicalize().ok()?;
    let canonical_folder = folder_path.canonicalize().ok()?;
    canonical_image
        .starts_with(&canonical_folder)
        .then_some(canonical_image)
}

fn open_safe_file(
    root: Option<&cap_std::fs::Dir>,
    relative: Option<&Path>,
    _ambient_path: &Path,
) -> io::Result<File> {
    match (root, relative) {
        (Some(root), Some(relative)) => root.open(relative).map(|file| file.into_std()),
        _ => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "missing authorized root",
        )),
    }
}

fn open_safe_dir(
    root: Option<&cap_std::fs::Dir>,
    relative: Option<&Path>,
    _ambient_path: &Path,
) -> io::Result<cap_std::fs::Dir> {
    match (root, relative) {
        (Some(root), Some(relative)) => root.open_dir(relative),
        _ => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "missing authorized root",
        )),
    }
}

pub(crate) fn external_bookmark_capability(
    comic: &crate::state::ComicItem,
    path: &Path,
    state: &AppState,
) -> io::Result<(cap_std::fs::Dir, PathBuf)> {
    let bookmark = comic.external_bookmark.as_ref().ok_or_else(|| {
        io::Error::new(io::ErrorKind::PermissionDenied, "missing external bookmark")
    })?;
    let root = state
        .active_bookmarks
        .lock()
        .unwrap()
        .get(bookmark)
        .cloned()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "external bookmark is not active",
            )
        })?;
    let relative = path.strip_prefix(Path::new(&root)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "path is outside external bookmark",
        )
    })?;
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid bookmark-relative path",
        ));
    }
    let directory = cap_std::fs::Dir::open_ambient_dir(root, cap_std::ambient_authority())?;
    Ok((directory, relative.to_path_buf()))
}

/// Resolve a comic to a capability root and relative path for background
/// readers.  The returned path is display metadata only; all reads must use
/// the returned descriptor and relative path.
pub(crate) fn comic_capability(
    comic: &ComicItem,
    state: &AppState,
    smb_root_path: Option<&Path>,
) -> io::Result<(cap_std::fs::Dir, PathBuf, PathBuf)> {
    let is_smb = comic.source_id == "smb" || comic.r#type == "smb-archive";
    let is_external =
        comic.source_id.starts_with("external:") || comic.r#type.starts_with("external-");
    let (root, relative, full_path) = if is_smb {
        let root_path = smb_root_path.ok_or_else(|| {
            io::Error::new(io::ErrorKind::PermissionDenied, "missing SMB cache root")
        })?;
        let relative = PathBuf::from(&comic.relative_path);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid SMB relative path",
            ));
        }
        (
            open_smb_cache_root(root_path)?,
            relative.clone(),
            root_path.join(relative),
        )
    } else if is_external {
        let path = comic
            .source_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "missing external source"))?;
        let (root, relative) = external_bookmark_capability(comic, &path, state)?;
        (root, relative, path)
    } else {
        let scan_dir = state.scan_dir.read().unwrap().clone();
        if scan_dir.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "scan directory is not configured",
            ));
        }
        let root_path = Path::new(&scan_dir);
        let root = cap_std::fs::Dir::open_ambient_dir(root_path, cap_std::ambient_authority())?;
        let relative = if comic.r#type == "offline" {
            let source =
                comic.source_path.as_deref().map(Path::new).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "missing offline source")
                })?;
            source
                .strip_prefix(root_path)
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "offline source outside scan root",
                    )
                })?
                .to_path_buf()
        } else {
            PathBuf::from(&comic.relative_path)
        };
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid scan-relative path",
            ));
        }
        (root, relative.clone(), root_path.join(relative))
    };
    if !root.try_exists(&relative).unwrap_or(false) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "comic source unavailable",
        ));
    }
    Ok((root, relative, full_path))
}

pub(crate) fn open_smb_cache_root(root_path: &Path) -> io::Result<cap_std::fs::Dir> {
    let parent = root_path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid SMB cache root"))?;
    let name = root_path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid SMB cache root"))?;
    let parent = cap_std::fs::Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
    parent.open_dir_nofollow(name)
}

#[cfg(test)]
fn external_path_is_authorized(
    comic: &crate::state::ComicItem,
    path: &Path,
    state: &AppState,
) -> bool {
    external_bookmark_capability(comic, path, state)
        .is_ok_and(|(root, relative)| root.metadata(relative).is_ok())
}

fn read_folder_page_from_capability(
    folder: &cap_std::fs::Dir,
    folder_path: &Path,
    cached_path: Option<&Path>,
    index: usize,
) -> io::Result<(Vec<u8>, String)> {
    let names = crate::utils::get_folder_image_names_from_dir(folder);
    let name = names
        .get(index)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "page not found"))?;
    if let Some(cached) = cached_path {
        if cached.strip_prefix(folder_path).ok() != Some(Path::new(name)) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "folder page index changed",
            ));
        }
    }
    let file = folder.open(name)?;
    let bytes = read_image_limited(file)?;
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mime = detect_mime(&bytes, &format!(".{extension}"));
    Ok((bytes, mime.to_string()))
}

#[cfg(test)]
fn read_archive_page(
    zip_path: &Path,
    target_name: &str,
) -> Result<(Vec<u8>, String), ArchivePageError> {
    let file =
        File::open(zip_path).map_err(|error| ArchivePageError::InvalidZip(error.to_string()))?;
    read_archive_page_with_file(zip_path, target_name, file)
}

fn read_archive_page_with_file(
    zip_path: &Path,
    target_name: &str,
    safe_file: File,
) -> Result<(Vec<u8>, String), ArchivePageError> {
    if !crate::utils::safe_archive_entry_name(target_name) {
        return Err(ArchivePageError::InvalidZip(
            "archive entry path escapes the archive root".to_string(),
        ));
    }
    let extension = zip_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let buf = if matches!(
        extension.to_ascii_lowercase().as_str(),
        "7z" | "cb7" | "rar" | "cbr"
    ) {
        let result = crate::archive_reader::read_entry_from_file(
            safe_file,
            zip_path,
            target_name,
            MAX_IMAGE_BYTES as usize,
        );
        result.map_err(|error| match error {
            crate::archive_reader::ArchiveError::EntryNotFound(_) => {
                ArchivePageError::MissingEntry(target_name.to_string())
            }
            crate::archive_reader::ArchiveError::EntryTooLarge { .. }
            | crate::archive_reader::ArchiveError::ReadLimitExceeded { .. } => {
                ArchivePageError::ImageTooLarge
            }
            other => ArchivePageError::ReadFailed(other.to_string()),
        })?
    } else {
        let mut archive = crate::utils::open_zip_archive_for_page_from_file(safe_file)
            .map_err(|error| ArchivePageError::InvalidZip(error.to_string()))?;
        let mut entry = archive
            .by_name(target_name)
            .map_err(|_| ArchivePageError::MissingEntry(target_name.to_string()))?;
        read_image_limited(&mut entry).map_err(|error| {
            if error.kind() == io::ErrorKind::InvalidData
                && error.to_string() == "image exceeds size limit"
            {
                ArchivePageError::ImageTooLarge
            } else {
                ArchivePageError::ReadFailed(error.to_string())
            }
        })?
    };
    let extension = Path::new(target_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    Ok((buf, format!(".{extension}")))
}

pub fn detect_mime(buf: &[u8], ext_fallback: &str) -> &'static str {
    if buf.len() >= 8 && &buf[0..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if buf.len() >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        "image/webp"
    } else if buf.len() >= 6 && (&buf[0..6] == b"GIF87a" || &buf[0..6] == b"GIF89a") {
        "image/gif"
    } else if buf.len() >= 3 && &buf[0..3] == b"\xFF\xD8\xFF" {
        "image/jpeg"
    } else if buf.len() >= 12
        && &buf[4..8] == b"ftyp"
        && buf[8..buf.len().min(32)]
            .as_chunks::<4>()
            .0
            .iter()
            .any(|brand| brand == b"avif" || brand == b"avis")
    {
        "image/avif"
    } else {
        get_mime(ext_fallback)
    }
}

pub fn handle_comic_request(
    app: &tauri::AppHandle,
    request: Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>> {
    let uri = request.uri().to_string();
    // The query selects the image size; it is not part of a page index or
    // capability. Authorization still uses the same route and source scope.
    let route_uri = route_uri_without_query(&uri);
    let path_str = route_uri.strip_prefix("gai://").unwrap_or(route_uri);
    let path_str = path_str.strip_prefix("localhost/").unwrap_or(path_str);

    let parts: Vec<&str> = path_str
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if parts.is_empty() {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(b"bad request".to_vec())
            .map_err(Into::into);
    }

    let host = parts[0];
    if !route_shape_is_valid(&parts) {
        let status = if matches!(host, "folder" | "page" | "cover") {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::NOT_FOUND
        };
        return Response::builder()
            .status(status)
            .body(b"invalid comic route".to_vec())
            .map_err(Into::into);
    }
    let state = app.state::<Arc<AppState>>();

    if host == "folder" {
        let folder_id = parts[1];
        let index: usize = match parts[2].parse() {
            Ok(index) => index,
            Err(_) => {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(b"invalid page index".to_vec())
                    .map_err(Into::into)
            }
        };

        let comic_info = {
            let comics = state.comics.blocking_lock();
            comics.iter().find(|comic| comic.id == folder_id).cloned()
        };
        let comic_info = match comic_info {
            Some(info) => info,
            None => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(b"unknown folder comic".to_vec())
                    .map_err(Into::into)
            }
        };

        let relative_path_str = match decode_capability_path(folder_id) {
            Ok(path) => path,
            Err(()) => {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(b"invalid capability".to_vec())
                    .map_err(Into::into)
            }
        };
        if Path::new(&relative_path_str)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(b"forbidden".to_vec())
                .map_err(Into::into);
        }

        let is_external = comic_info.source_id.starts_with("external:")
            || comic_info.r#type.starts_with("external-");
        let folder_path = if is_external {
            PathBuf::from(&relative_path_str)
        } else {
            let scan_dir = state.scan_dir.read().unwrap().clone();
            if scan_dir.is_empty() {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"scan directory is not configured".to_vec())
                    .map_err(Into::into);
            }
            Path::new(&scan_dir).join(&relative_path_str)
        };
        let capability = if is_external {
            external_bookmark_capability(&comic_info, &folder_path, &state)
        } else {
            cap_std::fs::Dir::open_ambient_dir(
                state.scan_dir.read().unwrap().as_str(),
                cap_std::ambient_authority(),
            )
            .map(|root| (root, PathBuf::from(&relative_path_str)))
        };
        let folder = match capability.and_then(|(root, relative)| root.open_dir(relative)) {
            Ok(folder) => folder,
            Err(_) => {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"folder is outside authorized root".to_vec())
                    .map_err(Into::into)
            }
        };
        let cached_path = state
            .opened_comic_files
            .read()
            .unwrap()
            .get(folder_id)
            .and_then(|files| files.get(index).cloned())
            .map(PathBuf::from);
        match read_folder_page_from_capability(&folder, &folder_path, cached_path.as_deref(), index)
        {
            Ok((bytes, mime)) => {
                return Response::builder()
                    .header("Content-Type", mime)
                    .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .map_err(Into::into)
            }
            Err(error) => {
                let status = match error.kind() {
                    io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                    io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
                    io::ErrorKind::InvalidData => StatusCode::PAYLOAD_TOO_LARGE,
                    _ => StatusCode::UNPROCESSABLE_ENTITY,
                };
                return Response::builder()
                    .status(status)
                    .body(b"folder page unavailable".to_vec())
                    .map_err(Into::into);
            }
        }
    } else if host == "page" || host == "cover" {
        let id = parts[1];
        let page_index: usize = if host == "cover" {
            0
        } else {
            match parts[2].parse() {
                Ok(index) => index,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(b"invalid page index".to_vec())
                        .map_err(Into::into)
                }
            }
        };

        let comic_info = if crate::photo_library::is_photo_album_id(id) {
            crate::photo_library::item_for_id(&state, id)
        } else {
            let comics = state.comics.blocking_lock();
            comics.iter().find(|comic| comic.id == id).cloned()
        };
        let comic_info = match comic_info {
            Some(info) => info,
            None => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(b"unknown comic".to_vec())
                    .map_err(Into::into)
            }
        };

        if comic_info.source_id == "photos" || comic_info.r#type == "photo-album" {
            let (album_id, asset_id) =
                match crate::photo_library::page_asset(&state, id, page_index) {
                    Some(value) => value,
                    None => {
                        return Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body(b"photo album is unavailable".to_vec())
                            .map_err(Into::into)
                    }
                };
            let allow_network = state
                .photo_network_allowed
                .load(std::sync::atomic::Ordering::Acquire);
            let (path, mime_type) =
                match tauri::async_runtime::block_on(crate::photo_library::request_image(
                    app,
                    album_id,
                    asset_id,
                    is_thumbnail_request(request.uri()),
                    allow_network,
                )) {
                    Ok(value) => value,
                    Err(error) => {
                        return Response::builder()
                            .status(crate::photo_library::native_image_error_status(&error))
                            .body(b"photo image unavailable".to_vec())
                            .map_err(Into::into)
                    }
                };
            if mime_type != "image/jpeg" {
                return Response::builder()
                    .status(StatusCode::UNPROCESSABLE_ENTITY)
                    .body(b"photo image format is unsupported".to_vec())
                    .map_err(Into::into);
            }
            let cache_root = match photo_cache_root(app) {
                Ok(root) => root,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"photo cache is unavailable".to_vec())
                        .map_err(Into::into)
                }
            };
            let canonical_root = match cache_root.canonicalize() {
                Ok(root) => root,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"photo cache is unavailable".to_vec())
                        .map_err(Into::into)
                }
            };
            let canonical_path = match Path::new(&path).canonicalize() {
                Ok(path) if path.is_file() && path.starts_with(&canonical_root) => path,
                _ => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"photo cache path rejected".to_vec())
                        .map_err(Into::into)
                }
            };
            let mut file = match File::open(canonical_path) {
                Ok(file) => file,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(b"photo image not found".to_vec())
                        .map_err(Into::into)
                }
            };
            let buf = match read_image_limited(&mut file) {
                Ok(buf) => buf,
                Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                    return Response::builder()
                        .status(StatusCode::PAYLOAD_TOO_LARGE)
                        .body(b"photo image too large".to_vec())
                        .map_err(Into::into)
                }
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::UNPROCESSABLE_ENTITY)
                        .body(b"photo image read failed".to_vec())
                        .map_err(Into::into)
                }
            };
            return Response::builder()
                .header("Content-Type", "image/jpeg")
                .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                .header("X-Content-Type-Options", "nosniff")
                .header("Access-Control-Allow-Origin", "*")
                .body(buf)
                .map_err(Into::into);
        }
        let cache_control = cache_control_for_comic(&comic_info);
        let page_count = {
            let opened = state.opened_comic_files.read().unwrap();
            opened
                .get(id)
                .map(|pages| pages.len())
                .unwrap_or(comic_info.page_count)
        };
        if is_page_out_of_range(page_count, page_index) {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .body(b"page out of range".to_vec())
                .map_err(Into::into);
        }

        let relative_path_str = match decode_capability_path(id) {
            Ok(path) => path,
            Err(()) => {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(b"invalid capability".to_vec())
                    .map_err(Into::into)
            }
        };
        if Path::new(&relative_path_str)
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(b"forbidden".to_vec())
                .map_err(Into::into);
        }

        let is_smb = comic_info.source_id == "smb" || comic_info.r#type == "smb-archive";
        let is_external = comic_info.source_id.starts_with("external:")
            || comic_info.r#type.starts_with("external-");
        let authorized_root;
        let authorized_relative;
        let full_path = if is_smb {
            let root = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ComicTemp");
            let capability_root = match open_smb_cache_root(&root) {
                Ok(root) => root,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"forbidden".to_vec())
                        .map_err(Into::into)
                }
            };
            authorized_relative = Some(PathBuf::from(&relative_path_str));
            authorized_root = Some(capability_root);
            root.join(&relative_path_str)
        } else if is_external {
            let path = PathBuf::from(&relative_path_str);
            let (root, relative) = match external_bookmark_capability(&comic_info, &path, &state) {
                Ok(capability) => capability,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"external bookmark is not active".to_vec())
                        .map_err(Into::into)
                }
            };
            authorized_root = Some(root);
            authorized_relative = Some(relative);
            path
        } else {
            let scan_dir = state.scan_dir.read().unwrap().clone();
            if scan_dir.is_empty() {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"scan directory is not configured".to_vec())
                    .map_err(Into::into);
            }
            let capability_root =
                match cap_std::fs::Dir::open_ambient_dir(&scan_dir, cap_std::ambient_authority()) {
                    Ok(root) => root,
                    Err(_) => {
                        return Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body(b"forbidden".to_vec())
                            .map_err(Into::into)
                    }
                };
            let relative = PathBuf::from(&relative_path_str);
            if capability_root.canonicalize(&relative).is_err() {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"forbidden".to_vec())
                    .map_err(Into::into);
            }
            authorized_relative = Some(relative);
            authorized_root = Some(capability_root);
            Path::new(&scan_dir).join(&relative_path_str)
        };

        let path_exists = match (&authorized_root, &authorized_relative) {
            (Some(root), Some(relative)) => root.try_exists(relative).unwrap_or(false),
            _ => false,
        };
        if !path_exists {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(b"not found".to_vec())
                .map_err(Into::into);
        }

        // A RAM hit is still protected by the current capability grant.  Do
        // not serve stale preloaded bytes after a bookmark/root is revoked.
        let cached_buf = {
            let pool = state.ram_cache_pool.lock().unwrap();
            pool.get(id).and_then(|book| book.get(&page_index).cloned())
        };
        if let Some(buf) = cached_buf {
            let mime = detect_mime(&buf, &comic_info.ext);
            return Response::builder()
                .header("Content-Type", mime)
                .header("Cache-Control", cache_control)
                .header("X-Content-Type-Options", "nosniff")
                .header("Access-Control-Allow-Origin", "*")
                .body(buf)
                .map_err(Into::into);
        }

        if comic_info.r#type.contains("image") {
            let is_file = match (&authorized_root, &authorized_relative) {
                (Some(root), Some(relative)) => root.is_file(relative),
                _ => false,
            };
            if page_index != 0 || !is_file {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(b"image page not found".to_vec())
                    .map_err(Into::into);
            }
            let mut file = match open_safe_file(
                authorized_root.as_ref(),
                authorized_relative.as_deref(),
                &full_path,
            ) {
                Ok(file) => file,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(b"image not found".to_vec())
                        .map_err(Into::into)
                }
            };
            let buf = match read_image_limited(&mut file) {
                Ok(buf) => buf,
                Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                    return Response::builder()
                        .status(StatusCode::PAYLOAD_TOO_LARGE)
                        .body(b"image too large".to_vec())
                        .map_err(Into::into)
                }
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::UNPROCESSABLE_ENTITY)
                        .body(b"image read failed".to_vec())
                        .map_err(Into::into)
                }
            };
            let ext = full_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let mime = detect_mime(&buf, &format!(".{ext}"));
            return Response::builder()
                .header("Content-Type", mime)
                .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                .header("X-Content-Type-Options", "nosniff")
                .header("Access-Control-Allow-Origin", "*")
                .body(buf)
                .map_err(Into::into);
        } else if match (&authorized_root, &authorized_relative) {
            (Some(root), Some(relative)) => root.is_dir(relative),
            _ => false,
        } {
            if let Ok(directory) = open_safe_dir(
                authorized_root.as_ref(),
                authorized_relative.as_deref(),
                &full_path,
            ) {
                let images = crate::utils::get_folder_image_names_from_dir(&directory);
                if let Some(image_name) = images.get(page_index) {
                    let mut file = match directory.open(image_name).map(|file| file.into_std()) {
                        Ok(file) => file,
                        Err(_) => {
                            return Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .body(b"not found".to_vec())
                                .map_err(Into::into)
                        }
                    };
                    let buf = match read_image_limited(&mut file) {
                        Ok(buf) => buf,
                        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                            return Response::builder()
                                .status(StatusCode::PAYLOAD_TOO_LARGE)
                                .body(b"image too large".to_vec())
                                .map_err(Into::into)
                        }
                        Err(_) => {
                            return Response::builder()
                                .status(StatusCode::UNPROCESSABLE_ENTITY)
                                .body(b"image read failed".to_vec())
                                .map_err(Into::into)
                        }
                    };
                    let ext = Path::new(image_name)
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or("");
                    let mime = detect_mime(&buf, &format!(".{ext}"));
                    return Response::builder()
                        .header("Content-Type", mime)
                        .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                        .header("X-Content-Type-Options", "nosniff")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(buf)
                        .map_err(Into::into);
                }
            }
        } else {
            let target_name = {
                let opened = state.opened_comic_files.read().unwrap();
                opened
                    .get(id)
                    .and_then(|names| names.get(page_index).cloned())
            };
            let target_name = match target_name {
                Some(name) => name,
                None => match open_safe_file(
                    authorized_root.as_ref(),
                    authorized_relative.as_deref(),
                    &full_path,
                )
                .map_err(|error| crate::utils::ArchiveError::FileAccess(error.to_string()))
                .and_then(|file| crate::utils::get_archive_images_from_file(&full_path, file))
                {
                    Ok(names) => match names.get(page_index) {
                        Some(name) => name.clone(),
                        None => {
                            return Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .body(b"archive page not found".to_vec())
                                .map_err(Into::into)
                        }
                    },
                    Err(error) => {
                        return Response::builder()
                            .status(StatusCode::UNPROCESSABLE_ENTITY)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(error.to_string().into_bytes())
                            .map_err(Into::into);
                    }
                },
            };

            let page_file = match open_safe_file(
                authorized_root.as_ref(),
                authorized_relative.as_deref(),
                &full_path,
            ) {
                Ok(file) => file,
                Err(error) => {
                    let status = if error.kind() == io::ErrorKind::PermissionDenied {
                        StatusCode::FORBIDDEN
                    } else {
                        StatusCode::NOT_FOUND
                    };
                    return Response::builder()
                        .status(status)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(b"archive access denied or file missing".to_vec())
                        .map_err(Into::into);
                }
            };
            match read_archive_page_with_file(&full_path, &target_name, page_file) {
                Ok((buf, extension)) => {
                    let mime = detect_mime(&buf, &extension);
                    return Response::builder()
                        .header("Content-Type", mime)
                        .header("Cache-Control", ARCHIVE_IMAGE_CACHE_CONTROL)
                        .header("X-Content-Type-Options", "nosniff")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(buf)
                        .map_err(Into::into);
                }
                Err(error) => {
                    return Response::builder()
                        .status(error.status())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(error.to_string().into_bytes())
                        .map_err(Into::into);
                }
            }
        }
    }

    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Access-Control-Allow-Origin", "*")
        .body(b"not found".to_vec())
        .map_err(Into::into)
}

fn photo_cache_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, ()> {
    #[cfg(target_os = "ios")]
    {
        let documents = app.path().document_dir().map_err(|_| ())?;
        return Ok(documents
            .parent()
            .ok_or(())?
            .join("Library")
            .join("Caches")
            .join("GAIPhotoLibrary"));
    }
    #[cfg(not(target_os = "ios"))]
    {
        Ok(app
            .path()
            .app_cache_dir()
            .map_err(|_| ())?
            .join("GAIPhotoLibrary"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Progress;
    use std::io::Write;

    fn comic_item(runtime_type: &str, ext: &str) -> ComicItem {
        ComicItem {
            id: "id".into(),
            r#type: runtime_type.into(),
            relative_path: "book".into(),
            ext: ext.into(),
            title: "book".into(),
            series: "test".into(),
            updated_at: String::new(),
            page_count: 0,
            progress: Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            },
            source_id: "local:test".into(),
            source_path: None,
            external_bookmark: None,
        }
    }

    #[test]
    fn test_detect_mime_avif() {
        let mut header = vec![0u8; 16];
        header[4..8].copy_from_slice(b"ftyp");
        header[8..12].copy_from_slice(b"avif");
        assert_eq!(detect_mime(&header, ".avif"), "image/avif");
    }

    #[test]
    fn test_detect_mime_png() {
        let header = b"\x89PNG\r\n\x1a\n\x00\x00";
        assert_eq!(detect_mime(header, ".png"), "image/png");
    }

    #[test]
    fn test_detect_mime_webp() {
        let mut header = vec![0u8; 16];
        header[0..4].copy_from_slice(b"RIFF");
        header[8..12].copy_from_slice(b"WEBP");
        assert_eq!(detect_mime(&header, ".webp"), "image/webp");
    }

    #[test]
    fn test_detect_mime_avif_compatible_brand() {
        let mut header = vec![0u8; 24];
        header[4..8].copy_from_slice(b"ftyp");
        header[8..12].copy_from_slice(b"mif1");
        header[16..20].copy_from_slice(b"avif");
        assert_eq!(detect_mime(&header, ""), "image/avif");
    }

    #[test]
    fn test_detect_mime_unknown_is_not_jpeg() {
        assert_eq!(detect_mime(b"not an image", ""), "application/octet-stream");
    }

    #[test]
    fn svg_is_served_as_inert_binary() {
        assert_eq!(get_mime(".svg"), "application/octet-stream");
    }

    #[test]
    fn mutable_folder_indexes_and_archive_pages_use_distinct_cache_policies() {
        assert_eq!(
            cache_control_for_comic(&comic_item("folder", "")),
            MUTABLE_IMAGE_CACHE_CONTROL
        );
        assert_eq!(
            cache_control_for_comic(&comic_item("archive", ".cbz")),
            ARCHIVE_IMAGE_CACHE_CONTROL
        );
        assert_eq!(
            cache_control_for_comic(&comic_item("image", ".png")),
            MUTABLE_IMAGE_CACHE_CONTROL
        );
        assert_eq!(
            cache_control_for_comic(&comic_item("offline", "")),
            MUTABLE_IMAGE_CACHE_CONTROL
        );
    }

    #[test]
    fn route_shapes_reject_ignored_suffixes_and_missing_indexes() {
        assert!(route_shape_is_valid(&["cover", "id"]));
        assert!(route_shape_is_valid(&["page", "id", "0"]));
        assert!(route_shape_is_valid(&["folder", "id", "0"]));
        assert!(!route_shape_is_valid(&["cover", "id", "ignored"]));
        assert!(!route_shape_is_valid(&["page", "id"]));
        assert!(!route_shape_is_valid(&["folder", "id", "0", "ignored"]));
        assert!(!route_shape_is_valid(&["unknown", "id"]));
    }

    #[test]
    fn catalog_thumbnails_keep_the_requested_page_and_use_the_small_image_lane() {
        for value in [
            "gai://page/photos:album/243?thumbnail=1",
            "gai://localhost/page/photos:album/243?thumbnail=1",
            "gai://localhost/folder/capability/243?thumbnail=1",
            "gai://cover/photos:album",
            "gai://localhost/cover/photos:album",
        ] {
            let uri: tauri::http::Uri = value.parse().unwrap();
            assert!(is_thumbnail_request(&uri), "{value}");
        }
        let route = route_uri_without_query("gai://localhost/page/photos:album/243?thumbnail=1");
        assert_eq!(route.rsplit('/').next().unwrap().parse::<usize>(), Ok(243));
        assert_eq!(
            route_uri_without_query("gai://page/id/0"),
            "gai://page/id/0"
        );
        for value in [
            "gai://page/photos:album/243",
            "gai://localhost/page/photos:album/243?thumbnail=0",
            "gai://localhost/page/photos:album/243?not_thumbnail=1",
            "gai://localhost/page/photos:album/243?thumbnail=10",
        ] {
            let uri: tauri::http::Uri = value.parse().unwrap();
            assert!(!is_thumbnail_request(&uri), "{value}");
        }
    }

    #[test]
    fn capability_paths_fail_closed() {
        assert!(decode_capability_path("not*base64").is_err());
        let valid = general_purpose::URL_SAFE_NO_PAD.encode(b"./series/book.cbz");
        assert_eq!(decode_capability_path(&valid).unwrap(), "./series/book.cbz");
    }

    #[test]
    fn missing_archive_capability_never_opens_an_existing_ambient_path() {
        let path =
            std::env::temp_dir().join(format!("comic-no-capability-{}.zip", std::process::id()));
        std::fs::write(&path, b"ambient file exists").unwrap();
        let error = open_safe_file(None, None, &path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unknown_page_count_does_not_reject_cover_page() {
        assert!(!is_page_out_of_range(0, 0));
    }

    #[test]
    fn known_page_count_still_rejects_out_of_range_page() {
        assert!(is_page_out_of_range(3, 3));
        assert!(!is_page_out_of_range(3, 2));
    }

    #[test]
    fn corrupt_archive_page_reports_unprocessable_entity() {
        let path = std::env::temp_dir().join(format!("comic-corrupt-{}.zip", std::process::id()));
        std::fs::write(&path, b"not a zip").unwrap();
        let error = read_archive_page(&path, "page.jpg").unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn missing_archive_entry_reports_not_found() {
        let path =
            std::env::temp_dir().join(format!("comic-missing-page-{}.zip", std::process::id()));
        let file = File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("page1.jpg", zip::write::FileOptions::default())
            .unwrap();
        writer.write_all(b"image").unwrap();
        writer.finish().unwrap();

        let error = read_archive_page(&path, "page2.jpg").unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn archive_entry_path_escape_is_rejected_before_open() {
        let path =
            std::env::temp_dir().join(format!("comic-unsafe-entry-{}.zip", std::process::id()));
        let file = File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("../outside.jpg", zip::write::FileOptions::default())
            .unwrap();
        writer.write_all(b"image").unwrap();
        writer.finish().unwrap();

        let error = read_archive_page(&path, "../outside.jpg").unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn archive_entry_name_validator_is_shared_with_indexing() {
        assert!(!crate::utils::safe_archive_entry_name("/outside.jpg"));
        assert!(!crate::utils::safe_archive_entry_name(
            "chapter\\..\\outside.jpg"
        ));
        assert!(crate::utils::safe_archive_entry_name("chapter/001.jpg"));
    }

    #[test]
    fn external_path_requires_its_own_bookmark() {
        let root = std::env::temp_dir().join(format!("comic-bookmark-{}", std::process::id()));
        let other_root =
            std::env::temp_dir().join(format!("comic-other-bookmark-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other_root).unwrap();
        let archive = root.join("book.zip");
        std::fs::write(&archive, b"zip").unwrap();
        let state = AppState::new();
        state
            .active_bookmarks
            .lock()
            .unwrap()
            .insert("other".into(), root.to_string_lossy().into_owned());
        state
            .active_bookmarks
            .lock()
            .unwrap()
            .insert("owner".into(), other_root.to_string_lossy().into_owned());
        let comic = ComicItem {
            id: "id".into(),
            r#type: "external-archive".into(),
            relative_path: archive.to_string_lossy().into_owned(),
            ext: ".zip".into(),
            title: "book".into(),
            series: "test".into(),
            updated_at: String::new(),
            page_count: 0,
            progress: Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            },
            source_id: "external:owner".into(),
            source_path: Some(archive.to_string_lossy().into_owned()),
            external_bookmark: Some("owner".into()),
        };

        assert!(!external_path_is_authorized(&comic, &archive, &state));
        state
            .active_bookmarks
            .lock()
            .unwrap()
            .insert("owner".into(), root.to_string_lossy().into_owned());
        assert!(external_path_is_authorized(&comic, &archive, &state));
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(other_root).unwrap();
    }

    #[test]
    fn capability_fixture_covers_revoke_index_shift_and_descriptor_reads() {
        let fixture = std::env::temp_dir().join(format!(
            "comic-capability-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let own = fixture.join("own");
        let other = fixture.join("other");
        let outside = fixture.join("outside");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let write_zip = |path: &Path, bytes: &[u8]| {
            let file = File::create(path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("page.jpg", zip::write::FileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
            writer.finish().unwrap();
        };
        let archive = own.join("book.zip");
        write_zip(&archive, b"original");

        let state = AppState::new();
        state
            .active_bookmarks
            .lock()
            .unwrap()
            .insert("owner".into(), own.to_string_lossy().into_owned());
        let mut comic = ComicItem {
            id: "id".into(),
            r#type: "external-archive".into(),
            relative_path: archive.to_string_lossy().into_owned(),
            ext: ".zip".into(),
            title: "book".into(),
            series: "test".into(),
            updated_at: String::new(),
            page_count: 1,
            progress: Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: None,
            },
            source_id: "external:owner".into(),
            source_path: Some(archive.to_string_lossy().into_owned()),
            external_bookmark: Some("owner".into()),
        };

        let (root, relative, _) = comic_capability(&comic, &state, None).unwrap();
        let descriptor = root.open(&relative).unwrap().into_std();
        let replacement = own.join("replacement.zip");
        write_zip(&replacement, b"replacement");
        let old_path = own.join("book.old.zip");
        std::fs::rename(&archive, &old_path).unwrap();
        std::fs::rename(&replacement, &archive).unwrap();
        let (bytes, _) = read_archive_page_with_file(&archive, "page.jpg", descriptor)
            .expect("an already-open descriptor remains bound to the authorized file");
        assert!(bytes
            .windows(b"original".len())
            .any(|window| window == b"original"));

        comic.external_bookmark = Some("wrong".into());
        state
            .active_bookmarks
            .lock()
            .unwrap()
            .insert("wrong".into(), other.to_string_lossy().into_owned());
        assert!(comic_capability(&comic, &state, None).is_err());
        comic.external_bookmark = Some("owner".into());
        state.active_bookmarks.lock().unwrap().remove("owner");
        assert!(comic_capability(&comic, &state, None).is_err());

        // Local comics use the same descriptor-relative helper and cannot
        // borrow an external bookmark that was revoked above.
        *state.scan_dir.write().unwrap() = own.to_string_lossy().into_owned();
        comic.r#type = "archive".into();
        comic.source_id = "local:scan".into();
        comic.relative_path = "book.zip".into();
        comic.external_bookmark = None;
        assert!(comic_capability(&comic, &state, None).is_ok());

        let folder = own.join("pages");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("001.jpg"), b"one").unwrap();
        std::fs::write(folder.join("002.jpg"), b"two").unwrap();
        comic.r#type = "folder".into();
        comic.relative_path = "pages".into();
        comic.source_path = Some(folder.to_string_lossy().into_owned());
        let (root, relative, _) = comic_capability(&comic, &state, None).unwrap();
        let page_dir = root.open_dir(&relative).unwrap();
        let cached = folder.join("002.jpg");
        std::fs::write(folder.join("000.jpg"), b"zero").unwrap();
        assert!(read_folder_page_from_capability(&page_dir, &folder, Some(&cached), 1).is_err());

        #[cfg(unix)]
        {
            let escaped = outside.join("escaped.jpg");
            std::fs::write(&escaped, b"secret").unwrap();
            std::os::unix::fs::symlink(&escaped, folder.join("link.jpg")).unwrap();
            assert!(page_dir.open("link.jpg").is_err());
        }

        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn folder_comic_cover_reads_first_naturally_sorted_image() {
        let temp_dir =
            std::env::temp_dir().join(format!("comic_test_folder_cover_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let img2 = temp_dir.join("002.jpg");
        let img1 = temp_dir.join("001.jpg");
        std::fs::write(&img2, b"fake img2").unwrap();
        std::fs::write(&img1, b"fake img1").unwrap();

        let images = crate::utils::get_folder_images(&temp_dir);
        assert_eq!(images.len(), 2);
        assert_eq!(images[0], img1);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn folder_images_cannot_escape_through_symlinks() {
        let root =
            std::env::temp_dir().join(format!("comic_protocol_boundary_{}", std::process::id()));
        let folder = root.join("comic");
        let outside = root.join("outside.png");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&outside, b"outside").unwrap();

        #[cfg(unix)]
        {
            let link = folder.join("cover.png");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(canonical_image_within(&link, &folder).is_none());
        }

        std::fs::remove_dir_all(root).unwrap();
    }
}
