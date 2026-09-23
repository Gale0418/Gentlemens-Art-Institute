use crate::state::{AppState, ComicItem};
use base64::{engine::general_purpose, Engine as _};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path};
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MUTABLE_IMAGE_CACHE_CONTROL: &str = "no-store";
const ARCHIVE_IMAGE_CACHE_CONTROL: &str = "private, max-age=300";

#[derive(Debug)]
enum ArchivePageError {
    FileAccess(io::Error),
    InvalidZip(String),
    MissingEntry(String),
    ImageTooLarge,
    ReadFailed(String),
}

impl ArchivePageError {
    fn status(&self) -> StatusCode {
        match self {
            Self::FileAccess(error) if error.kind() == io::ErrorKind::NotFound => {
                StatusCode::NOT_FOUND
            }
            Self::FileAccess(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                StatusCode::FORBIDDEN
            }
            Self::FileAccess(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::MissingEntry(_) => StatusCode::NOT_FOUND,
            Self::InvalidZip(_) | Self::ReadFailed(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::ImageTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        }
    }
}

impl std::fmt::Display for ArchivePageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileAccess(error) => write!(f, "無法讀取 ZIP 檔案：{error}"),
            Self::InvalidZip(error) => write!(f, "ZIP 格式無效或不受支援：{error}"),
            Self::MissingEntry(name) => write!(f, "ZIP 找不到頁面：{name}"),
            Self::ImageTooLarge => write!(f, "圖片超過 64 MiB 安全上限"),
            Self::ReadFailed(error) => write!(f, "ZIP 頁面解壓失敗：{error}"),
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

fn canonical_image_within(image_path: &Path, folder_path: &Path) -> Option<std::path::PathBuf> {
    let canonical_image = image_path.canonicalize().ok()?;
    let canonical_folder = folder_path.canonicalize().ok()?;
    canonical_image
        .starts_with(&canonical_folder)
        .then_some(canonical_image)
}

#[cfg(any(target_os = "ios", test))]
fn external_path_is_authorized(
    comic: &crate::state::ComicItem,
    path: &Path,
    state: &AppState,
) -> bool {
    let Some(bookmark) = comic.external_bookmark.as_ref() else {
        return false;
    };
    let active = state.active_bookmarks.lock().unwrap();
    let Some(root) = active.get(bookmark) else {
        return false;
    };
    match (path.canonicalize(), Path::new(root).canonicalize()) {
        (Ok(canonical_path), Ok(canonical_root)) => canonical_path.starts_with(canonical_root),
        _ => false,
    }
}

fn read_archive_page(
    zip_path: &Path,
    target_name: &str,
) -> Result<(Vec<u8>, String), ArchivePageError> {
    if !crate::utils::safe_archive_entry_name(target_name) {
        return Err(ArchivePageError::InvalidZip(
            "archive entry path escapes the archive root".to_string(),
        ));
    }
    let file = File::open(zip_path).map_err(ArchivePageError::FileAccess)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| ArchivePageError::InvalidZip(error.to_string()))?;
    let mut entry = archive
        .by_name(target_name)
        .map_err(|_| ArchivePageError::MissingEntry(target_name.to_string()))?;
    let buf = read_image_limited(&mut entry).map_err(|error| {
        if error.kind() == io::ErrorKind::InvalidData
            && error.to_string() == "image exceeds size limit"
        {
            ArchivePageError::ImageTooLarge
        } else {
            ArchivePageError::ReadFailed(error.to_string())
        }
    })?;
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
    let path_str = uri.strip_prefix("gai://").unwrap_or(&uri);
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
            let path = Path::new(&relative_path_str).to_path_buf();
            #[cfg(target_os = "ios")]
            {
                if !external_path_is_authorized(&comic_info, &path, &state) {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"external bookmark is not active".to_vec())
                        .map_err(Into::into);
                }
            }
            path
        } else {
            let scan_dir = state.scan_dir.read().unwrap().clone();
            if scan_dir.is_empty() {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"scan directory is not configured".to_vec())
                    .map_err(Into::into);
            }
            let path = Path::new(&scan_dir).join(&relative_path_str);
            match (path.canonicalize(), Path::new(&scan_dir).canonicalize()) {
                (Ok(canonical_path), Ok(canonical_scan))
                    if !canonical_path.starts_with(&canonical_scan) =>
                {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"forbidden".to_vec())
                        .map_err(Into::into)
                }
                (Err(_), _) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"forbidden".to_vec())
                        .map_err(Into::into)
                }
                _ => {}
            }
            path
        };

        if folder_path.is_dir() {
            let cached_path = {
                let opened = state.opened_comic_files.read().unwrap();
                opened
                    .get(folder_id)
                    .and_then(|files| files.get(index).cloned())
            };
            let image_path = cached_path.map(std::path::PathBuf::from).or_else(|| {
                crate::utils::get_folder_images(&folder_path)
                    .get(index)
                    .cloned()
            });
            if let Some(image_path) = image_path {
                if let Some(canonical_image) = canonical_image_within(&image_path, &folder_path) {
                    let mut file = match File::open(&canonical_image) {
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
                    let ext = canonical_image
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
                    host == "cover",
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
        let full_path = if is_smb {
            app.path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ComicTemp")
                .join(&relative_path_str)
        } else if is_external {
            let path = Path::new(&relative_path_str).to_path_buf();
            #[cfg(target_os = "ios")]
            if !external_path_is_authorized(&comic_info, &path, &state) {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"external bookmark is not active".to_vec())
                    .map_err(Into::into);
            }
            path
        } else {
            let scan_dir = state.scan_dir.read().unwrap().clone();
            if scan_dir.is_empty() {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"scan directory is not configured".to_vec())
                    .map_err(Into::into);
            }
            let path = Path::new(&scan_dir).join(&relative_path_str);
            match (path.canonicalize(), Path::new(&scan_dir).canonicalize()) {
                (Ok(canonical_path), Ok(canonical_scan))
                    if !canonical_path.starts_with(&canonical_scan) =>
                {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"forbidden".to_vec())
                        .map_err(Into::into)
                }
                (Err(_), _) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"forbidden".to_vec())
                        .map_err(Into::into)
                }
                _ => {}
            }
            path
        };

        if !full_path.exists() {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(b"not found".to_vec())
                .map_err(Into::into);
        }

        if is_smb {
            let temp_root = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ComicTemp");
            match (full_path.canonicalize(), temp_root.canonicalize()) {
                (Ok(canonical_path), Ok(canonical_root))
                    if !canonical_path.starts_with(&canonical_root) =>
                {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"forbidden".to_vec())
                        .map_err(Into::into)
                }
                (Err(_), _) | (_, Err(_)) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"forbidden".to_vec())
                        .map_err(Into::into)
                }
                _ => {}
            }
        }

        if comic_info.r#type.contains("image") {
            if page_index != 0 || !full_path.is_file() {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(b"image page not found".to_vec())
                    .map_err(Into::into);
            }
            let mut file = match File::open(&full_path) {
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
        } else if full_path.is_dir() {
            let images = crate::utils::get_folder_images(&full_path);
            if let Some(image_path) = images.get(page_index) {
                if let Some(canonical_image) = canonical_image_within(image_path, &full_path) {
                    let mut file = match File::open(&canonical_image) {
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
                    let ext = canonical_image
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
                None => match crate::utils::get_archive_images(&full_path) {
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

            match read_archive_page(&full_path, &target_name) {
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
    fn capability_paths_fail_closed() {
        assert!(decode_capability_path("not*base64").is_err());
        let valid = general_purpose::URL_SAFE_NO_PAD.encode(b"./series/book.cbz");
        assert_eq!(decode_capability_path(&valid).unwrap(), "./series/book.cbz");
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
