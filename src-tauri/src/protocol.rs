use crate::state::{self, AppState, ComicItem};
use base64::{engine::general_purpose, Engine as _};
#[cfg(windows)]
use cap_fs_ext::OpenOptionsMaybeDirExt;
use cap_fs_ext::{DirExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MUTABLE_IMAGE_CACHE_CONTROL: &str = "no-store";
// Archive page URLs are index-based and the underlying file can be atomically
// replaced without changing the URL. Letting WebView retain a response would
// bypass the native revision check on the next request.
const ARCHIVE_IMAGE_CACHE_CONTROL: &str = "no-store";

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

fn decode_query_component(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(());
            }
            let high = (bytes[index + 1] as char).to_digit(16).ok_or(())?;
            let low = (bytes[index + 2] as char).to_digit(16).ok_or(())?;
            decoded.push(((high << 4) | low) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| ())
}

pub(crate) fn encode_query_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0F) as usize] as char);
        }
    }
    encoded
}

/// Source-qualified URLs are accepted for reader page/folder routes and
/// covers. Legacy URLs without this selector retain their ID-only behavior.
fn source_id_from_query(uri: &str) -> Result<Option<String>, ()> {
    let Some((_, raw_query)) = uri.split_once('?') else {
        return Ok(None);
    };
    let raw_query = raw_query
        .split_once('#')
        .map_or(raw_query, |(query, _)| query);
    let mut source_id = None;
    for pair in raw_query.split('&').filter(|pair| !pair.is_empty()) {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        // Preserve the pre-existing handling of unrelated query parameters;
        // only a syntactically recognized `sourceId` is owned by this route.
        let Ok(key) = decode_query_component(raw_key) else {
            continue;
        };
        if key != "sourceId" {
            continue;
        }
        if source_id.is_some() {
            return Err(());
        }
        let value = decode_query_component(raw_value)?;
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(());
        }
        source_id = Some(value);
    }
    Ok(source_id)
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

/// Protocol URLs carry only the runtime id.  Reusing that id across sources
/// is safe only when every matching row belongs to the same source; otherwise
/// selecting the first row could read the wrong capability root.
fn unique_comic_for_runtime_id(
    comics: &[ComicItem],
    runtime_id: &str,
) -> Result<Option<ComicItem>, ()> {
    let matching = comics
        .iter()
        .filter(|comic| comic.id == runtime_id)
        .collect::<Vec<_>>();
    let online_exists = matching.iter().any(|comic| comic.r#type != "offline");
    let mut matches = matching
        .into_iter()
        .filter(|comic| !online_exists || comic.r#type != "offline");
    let Some(first) = matches.next() else {
        return Ok(None);
    };
    let source_id = first.source_id.clone();
    let relative_path = first.relative_path.clone();
    if matches.any(|comic| comic.source_id != source_id || comic.relative_path != relative_path) {
        return Err(());
    }
    Ok(Some(first.clone()))
}

fn unique_comic_for_source(
    comics: &[ComicItem],
    runtime_id: &str,
    source_id: &str,
) -> Result<Option<ComicItem>, ()> {
    let matching = comics
        .iter()
        .filter(|comic| comic.id == runtime_id && comic.source_id == source_id)
        .collect::<Vec<_>>();
    let online_exists = matching.iter().any(|comic| comic.r#type != "offline");
    let mut matches = matching
        .into_iter()
        .filter(|comic| !online_exists || comic.r#type != "offline");
    let Some(first) = matches.next() else {
        return Ok(None);
    };
    let relative_path = first.relative_path.clone();
    if matches.any(|comic| comic.relative_path != relative_path) {
        return Err(());
    }
    Ok(Some(first.clone()))
}

fn normalize_cover_source_id(source_id: &str, scan_dir: &str) -> String {
    if is_legacy_local_source_id(source_id) && !scan_dir.is_empty() {
        crate::scanner::local_source_id(Path::new(scan_dir))
    } else {
        source_id.to_owned()
    }
}

fn unique_comic_for_cover(
    comics: &[ComicItem],
    runtime_id: &str,
    requested_source_id: Option<&str>,
    scan_dir: &str,
) -> Result<Option<ComicItem>, ()> {
    let Some(requested_source_id) = requested_source_id else {
        return unique_comic_for_runtime_id(comics, runtime_id);
    };
    let scoped_source_id = normalize_cover_source_id(requested_source_id, scan_dir);
    // A root-bound identity is authoritative. Only if it is absent may a
    // legacy `local` row be selected and bound to this same captured root.
    let scoped = unique_comic_for_source(comics, runtime_id, &scoped_source_id)?;
    if scoped.is_some() || scoped_source_id == requested_source_id {
        return Ok(scoped);
    }
    unique_comic_for_source(comics, runtime_id, requested_source_id)
}

fn opened_archive_page_for_request(
    state: &AppState,
    runtime_id: &str,
    source_id: &str,
    page_index: usize,
    host: &str,
) -> Option<state::OpenedArchivePage> {
    // Cover requests may be source-qualified while the reader index is keyed
    // only by runtime ID. Never let a different active reader session decide
    // which source revision a cover belongs to.
    (host != "cover")
        .then(|| state.opened_archive_page(runtime_id, source_id, page_index))
        .flatten()
}

fn reader_response_if_current<F>(
    state: &AppState,
    runtime_id: &str,
    source_id: &str,
    reader_generation: u64,
    build: F,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>>
where
    F: FnOnce() -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>>,
{
    let Ok(_lifecycle) = state.comic_lifecycle.lock() else {
        return Response::builder()
            .status(StatusCode::CONFLICT)
            .body(b"reader source is no longer active".to_vec())
            .map_err(Into::into);
    };
    if state
        .reader_generation
        .load(std::sync::atomic::Ordering::Acquire)
        != reader_generation
        || !state.active_reader_matches_locked(runtime_id, source_id)
    {
        return Response::builder()
            .status(StatusCode::CONFLICT)
            .body(b"reader source is no longer active".to_vec())
            .map_err(Into::into);
    }
    build()
}

/// Local capability roots are selected from the current configured scan
/// directory. A catalog item from another local root must never be paired
/// with that directory's relative path. Offline items intentionally use
/// their recorded absolute source path and keep their legacy handling.
pub(crate) fn local_source_matches_scan_dir(comic: &ComicItem, scan_dir: &str) -> bool {
    !scan_dir.is_empty() && comic.source_id == crate::scanner::local_source_id(Path::new(scan_dir))
}

pub(crate) fn is_legacy_local_source_id(source_id: &str) -> bool {
    source_id.is_empty() || source_id == "local"
}

/// Bind pre-source-identity catalog entries to the current configured local
/// root before normalizing or opening them. The caller must still verify the
/// relative path through the returned capability root.
pub(crate) fn bind_legacy_local_source(comic: &ComicItem, scan_dir: &str) -> Option<ComicItem> {
    if comic.r#type == "offline" || !is_legacy_local_source_id(&comic.source_id) {
        return Some(comic.clone());
    }
    if scan_dir.is_empty() {
        return None;
    }
    let mut bound = comic.clone();
    bound.source_id = crate::scanner::local_source_id(Path::new(scan_dir));
    Some(bound)
}

fn cache_control_for_comic(comic: &ComicItem) -> &'static str {
    // Folder URLs are index-based: deleting page 3 makes the former page 4
    // become /3, so any WebView cache would serve the wrong image. Archives
    // can also be replaced at the same path, so each request must reach native
    // revision validation instead of reusing an unversioned WebView response.
    if comic.r#type.contains("folder") || comic.r#type.contains("image") || comic.ext.is_empty() {
        MUTABLE_IMAGE_CACHE_CONTROL
    } else {
        ARCHIVE_IMAGE_CACHE_CONTROL
    }
}

pub(crate) fn decode_capability_path(id: &str) -> Result<String, ()> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| ())?;
    let value = String::from_utf8(bytes).map_err(|_| ())?;
    if let Some(envelope) = value.strip_prefix("gai-smb-v1\0") {
        let (_, relative) = envelope.split_once('\0').ok_or(())?;
        return Ok(relative.to_string());
    }
    Ok(value)
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

/// Read metadata for a source-relative leaf without following symlinks in any
/// parent component. The returned metadata comes from the directory descriptor
/// rooted at the existing source capability, not an ambient absolute path.
pub(crate) fn symlink_metadata_from_capability(
    root: &cap_std::fs::Dir,
    relative: &Path,
) -> io::Result<std::fs::Metadata> {
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid source-relative path",
        ));
    }
    let leaf = relative
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "source path has no leaf"))?;
    let parent_path = relative.parent().unwrap_or_else(|| Path::new(""));
    let mut parent = root.try_clone()?;
    for component in parent_path.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "invalid source parent component",
            ));
        };
        parent = parent.open_dir_nofollow(name)?;
    }
    let path_metadata = parent.symlink_metadata(leaf)?;
    if path_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "source leaf is a symlink",
        ));
    }
    if !path_metadata.is_file() && !path_metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "source leaf is not a regular file or directory",
        ));
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options
        .read(true)
        .follow(cap_fs_ext::FollowSymlinks::No)
        .nonblock(true);
    #[cfg(windows)]
    options.maybe_dir(true);
    let file = parent.open_with(leaf, &options)?;
    file.into_std().metadata()
}

/// Resolve a comic to a capability root and relative path for background
/// readers.  The returned path is display metadata only; all reads must use
/// the returned descriptor and relative path.
pub(crate) fn comic_capability(
    comic: &ComicItem,
    state: &AppState,
    smb_root_path: Option<&Path>,
) -> io::Result<(cap_std::fs::Dir, PathBuf, PathBuf)> {
    let is_smb = state::is_smb_source_id(&comic.source_id) || comic.r#type == "smb-archive";
    let is_external =
        comic.source_id.starts_with("external:") || comic.r#type.starts_with("external-");
    let (root, relative, full_path) = if is_smb {
        let config = state.smb_config.read().map_err(|_| {
            io::Error::new(io::ErrorKind::PermissionDenied, "SMB config unavailable")
        })?;
        let config = config.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "SMB source is not connected",
            )
        })?;
        if !state::smb_source_matches_config(&comic.source_id, config) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "SMB legacy or foreign source is read-only",
            ));
        }
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
        let root_path = smb_cache_root_path(root_path, &comic.source_id);
        (
            open_smb_cache_root(&root_path)?,
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
        if comic.r#type != "offline" && is_legacy_local_source_id(&comic.source_id) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "legacy local source must be bound before capability lookup",
            ));
        }
        if comic.r#type != "offline" && !local_source_matches_scan_dir(comic, &scan_dir) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "comic source does not match the configured scan directory",
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

pub(crate) fn smb_cache_root_path(root_path: &Path, source_id: &str) -> PathBuf {
    let namespace = if source_id == state::LEGACY_SMB_SOURCE_ID {
        "legacy-smb".to_string()
    } else {
        source_id.replace(':', "_")
    };
    root_path.join(namespace)
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
        if entry.size() > MAX_IMAGE_BYTES {
            return Err(ArchivePageError::ImageTooLarge);
        }
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
    let requested_source_id = match source_id_from_query(&uri) {
        Ok(source_id) => source_id,
        Err(()) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(b"invalid source selector".to_vec())
                .map_err(Into::into)
        }
    };
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

        let legacy_scan_dir = state.scan_dir.read().unwrap().clone();
        let comic_info = {
            let comics = state.comics.blocking_lock();
            let selected = if requested_source_id.is_some() {
                unique_comic_for_cover(
                    &comics,
                    folder_id,
                    requested_source_id.as_deref(),
                    &legacy_scan_dir,
                )
            } else {
                unique_comic_for_runtime_id(&comics, folder_id)
            };
            match selected {
                Ok(comic) => comic,
                Err(()) => {
                    return Response::builder()
                        .status(StatusCode::CONFLICT)
                        .body(b"comic id is ambiguous across sources".to_vec())
                        .map_err(Into::into)
                }
            }
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
        let comic_info = {
            match bind_legacy_local_source(&comic_info, &legacy_scan_dir) {
                Some(info) => crate::normalize_runtime_item(info),
                None => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"legacy comic source is not bound to a scan directory".to_vec())
                        .map_err(Into::into)
                }
            }
        };
        let reader_generation =
            match state.active_reader_generation(folder_id, &comic_info.source_id) {
                Some(generation) => generation,
                None => {
                    return Response::builder()
                        .status(StatusCode::CONFLICT)
                        .body(b"reader source is no longer active".to_vec())
                        .map_err(Into::into);
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
        let local_scan_dir = if is_external {
            None
        } else {
            let scan_dir = state.scan_dir.read().unwrap().clone();
            if scan_dir.is_empty() {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"scan directory is not configured".to_vec())
                    .map_err(Into::into);
            }
            if comic_info.r#type != "offline"
                && !local_source_matches_scan_dir(&comic_info, &scan_dir)
            {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"comic source does not match the configured scan directory".to_vec())
                    .map_err(Into::into);
            }
            Some(scan_dir)
        };
        let folder_path = if is_external {
            PathBuf::from(&relative_path_str)
        } else {
            let scan_dir = local_scan_dir.as_deref().expect("local scan dir checked");
            Path::new(&scan_dir).join(&relative_path_str)
        };
        let capability = if is_external {
            external_bookmark_capability(&comic_info, &folder_path, &state)
        } else {
            cap_std::fs::Dir::open_ambient_dir(
                local_scan_dir.as_deref().expect("local scan dir checked"),
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
            .opened_comic_file(folder_id, &comic_info.source_id, index)
            .map(PathBuf::from);
        match read_folder_page_from_capability(&folder, &folder_path, cached_path.as_deref(), index)
        {
            Ok((bytes, mime)) => {
                return reader_response_if_current(
                    &state,
                    folder_id,
                    &comic_info.source_id,
                    reader_generation,
                    move || {
                        Response::builder()
                            .header("Content-Type", mime)
                            .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                            .header("X-Content-Type-Options", "nosniff")
                            .header("Access-Control-Allow-Origin", "*")
                            .body(bytes)
                            .map_err(Into::into)
                    },
                );
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

        let legacy_scan_dir = state.scan_dir.read().unwrap().clone();
        let comic_info = if crate::photo_library::is_photo_album_id(id) {
            crate::photo_library::item_for_id(&state, id)
        } else {
            let comics = state.comics.blocking_lock();
            let selected = if requested_source_id.is_some() {
                unique_comic_for_cover(
                    &comics,
                    id,
                    requested_source_id.as_deref(),
                    &legacy_scan_dir,
                )
            } else {
                unique_comic_for_runtime_id(&comics, id)
            };
            match selected {
                Ok(comic) => comic,
                Err(()) => {
                    return Response::builder()
                        .status(StatusCode::CONFLICT)
                        .body(b"comic id is ambiguous across sources".to_vec())
                        .map_err(Into::into)
                }
            }
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
        let comic_info = {
            match bind_legacy_local_source(&comic_info, &legacy_scan_dir) {
                Some(info) => crate::normalize_runtime_item(info),
                None => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"legacy comic source is not bound to a scan directory".to_vec())
                        .map_err(Into::into)
                }
            }
        };
        if let Some(requested_source_id) = requested_source_id.as_deref() {
            let expected_source_id =
                normalize_cover_source_id(requested_source_id, &legacy_scan_dir);
            if comic_info.source_id != expected_source_id {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"comic source selector is not authorized".to_vec())
                    .map_err(Into::into);
            }
        }
        let reader_generation = if host == "cover" {
            None
        } else {
            match state.active_reader_generation(id, &comic_info.source_id) {
                Some(generation) => Some(generation),
                None => {
                    return Response::builder()
                        .status(StatusCode::CONFLICT)
                        .body(b"reader source is no longer active".to_vec())
                        .map_err(Into::into);
                }
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
            let build = move || {
                Response::builder()
                    .header("Content-Type", "image/jpeg")
                    .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(buf)
                    .map_err(Into::into)
            };
            if host == "cover" {
                return build();
            }
            return reader_response_if_current(
                &state,
                id,
                &comic_info.source_id,
                reader_generation.expect("reader generation captured for page response"),
                build,
            );
        }
        let cache_control = cache_control_for_comic(&comic_info);
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

        let is_smb =
            state::is_smb_source_id(&comic_info.source_id) || comic_info.r#type == "smb-archive";
        let is_external = comic_info.source_id.starts_with("external:")
            || comic_info.r#type.starts_with("external-");
        let authorized_root;
        let authorized_relative;
        let full_path = if is_smb {
            let config = match state.smb_config.read() {
                Ok(config) => config,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::FORBIDDEN)
                        .body(b"SMB source is not connected".to_vec())
                        .map_err(Into::into)
                }
            };
            let Some(config) = config.as_ref() else {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"SMB source is not connected".to_vec())
                    .map_err(Into::into);
            };
            if !state::smb_source_matches_config(&comic_info.source_id, config) {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"SMB legacy or foreign source is read-only".to_vec())
                    .map_err(Into::into);
            }
            let root = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ComicTemp");
            let root = smb_cache_root_path(&root, &comic_info.source_id);
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
            if comic_info.r#type != "offline"
                && !local_source_matches_scan_dir(&comic_info, &scan_dir)
            {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(b"comic source does not match the configured scan directory".to_vec())
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

        let is_directory = match (&authorized_root, &authorized_relative) {
            (Some(root), Some(relative)) => root.is_dir(relative),
            _ => false,
        };
        // Open the archive once through the capability and bind the reader
        // session to that descriptor's revision before consulting either the
        // index or RAM cache. A same-path atomic replacement must fail closed.
        let archive_access = if !comic_info.r#type.contains("image") && !is_directory {
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
            let revision = state::SourceRevision::from_std_metadata(&match page_file.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(b"archive metadata unavailable".to_vec())
                        .map_err(Into::into);
                }
            });
            let indexed = opened_archive_page_for_request(
                &state,
                id,
                &comic_info.source_id,
                page_index,
                host,
            );
            if let Some(expected) = indexed.as_ref().map(|page| &page.revision) {
                if expected != &revision {
                    return Response::builder()
                        .status(StatusCode::CONFLICT)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(b"archive source changed; reopen".to_vec())
                        .map_err(Into::into);
                }
            }
            Some((page_file, revision, indexed))
        } else {
            None
        };

        // The descriptor has already been authorized and its revision checked
        // above.  Only archive cover requests use this small memory cache;
        // page requests still follow the reader RAM-cache path below.
        let cover_cache_key = if host == "cover" {
            archive_access.as_ref().map(|(_, revision, _)| {
                state::CoverCacheKey::for_comic(&comic_info, revision.clone())
            })
        } else {
            None
        };
        if let Some(key) = cover_cache_key.as_ref() {
            if let Some((buf, mime)) = state.cached_cover(key) {
                let build = move || {
                    Response::builder()
                        .header("Content-Type", mime)
                        .header("Cache-Control", cache_control)
                        .header("X-Content-Type-Options", "nosniff")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(buf)
                        .map_err(Into::into)
                };
                if host == "cover" {
                    return build();
                }
                return reader_response_if_current(
                    &state,
                    id,
                    &comic_info.source_id,
                    reader_generation.expect("reader generation captured for page response"),
                    build,
                );
            }
        }

        let page_count = archive_access
            .as_ref()
            .and_then(|(_, _, indexed)| indexed.as_ref().map(|page| page.total_pages))
            .unwrap_or_else(|| {
                if !comic_info.r#type.contains("image") && !is_directory {
                    return comic_info.page_count;
                }
                state
                    .opened_comic_page_count(id, &comic_info.source_id)
                    .unwrap_or(comic_info.page_count)
            });
        if is_page_out_of_range(page_count, page_index) {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .body(b"page out of range".to_vec())
                .map_err(Into::into);
        }

        // A RAM hit is still protected by the current capability grant.  Do
        // not serve stale preloaded bytes after a bookmark/root is revoked.
        let cached_buf = archive_access.as_ref().and_then(|(_, revision, indexed)| {
            indexed.as_ref()?;
            state.cached_page_for_revision(id, &comic_info.source_id, page_index, revision)
        });
        if let Some(buf) = cached_buf {
            let mime = detect_mime(&buf, &comic_info.ext);
            return reader_response_if_current(
                &state,
                id,
                &comic_info.source_id,
                reader_generation.expect("reader generation captured for page response"),
                move || {
                    Response::builder()
                        .header("Content-Type", mime)
                        .header("Cache-Control", cache_control)
                        .header("X-Content-Type-Options", "nosniff")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(buf)
                        .map_err(Into::into)
                },
            );
        }

        // RAR cover requests intentionally use archive order as a bounded
        // representative thumbnail. This must not be treated as formal page
        // zero: the reader below still uses its natural-sorted archive index.
        let is_rar_archive = full_path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "rar" | "cbr")
            });
        if host == "cover" && is_rar_archive {
            let Some((page_file, _, _)) = archive_access.as_ref() else {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(b"archive descriptor unavailable".to_vec())
                    .map_err(Into::into);
            };
            let page_file = match page_file.try_clone() {
                Ok(file) => file,
                Err(error) => {
                    return Response::builder()
                        .status(StatusCode::UNPROCESSABLE_ENTITY)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(format!("archive descriptor unavailable: {error}").into_bytes())
                        .map_err(Into::into);
                }
            };
            let image = match crate::rar_reader::read_first_image_from_file(
                page_file,
                &full_path,
                MAX_IMAGE_BYTES as usize,
            ) {
                Ok(image) => image,
                Err(error) => {
                    let status = match &error {
                        crate::archive_reader::ArchiveError::EntryTooLarge { .. }
                        | crate::archive_reader::ArchiveError::ReadLimitExceeded { .. } => {
                            StatusCode::PAYLOAD_TOO_LARGE
                        }
                        _ => StatusCode::UNPROCESSABLE_ENTITY,
                    };
                    return Response::builder()
                        .status(status)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(error.to_string().into_bytes())
                        .map_err(Into::into);
                }
            };
            let extension = Path::new(&image.name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let mime = detect_mime(&image.bytes, &format!(".{extension}"));
            if let Some(key) = cover_cache_key {
                state.cache_cover(key, image.bytes.clone(), mime);
            }
            return Response::builder()
                .header("Content-Type", mime)
                .header("Cache-Control", ARCHIVE_IMAGE_CACHE_CONTROL)
                .header("X-Content-Type-Options", "nosniff")
                .header("Access-Control-Allow-Origin", "*")
                .body(image.bytes)
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
            let build = move || {
                Response::builder()
                    .header("Content-Type", mime)
                    .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(buf)
                    .map_err(Into::into)
            };
            if host == "cover" {
                return build();
            }
            return reader_response_if_current(
                &state,
                id,
                &comic_info.source_id,
                reader_generation.expect("reader generation captured for page response"),
                build,
            );
        } else if is_directory {
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
                    let build = move || {
                        Response::builder()
                            .header("Content-Type", mime)
                            .header("Cache-Control", MUTABLE_IMAGE_CACHE_CONTROL)
                            .header("X-Content-Type-Options", "nosniff")
                            .header("Access-Control-Allow-Origin", "*")
                            .body(buf)
                            .map_err(Into::into)
                    };
                    if host == "cover" {
                        return build();
                    }
                    return reader_response_if_current(
                        &state,
                        id,
                        &comic_info.source_id,
                        reader_generation.expect("reader generation captured for page response"),
                        build,
                    );
                }
            }
        } else {
            let target_name = archive_access
                .as_ref()
                .and_then(|(_, _, indexed)| indexed.as_ref())
                .and_then(|page| page.page_name.clone());
            let target_name = match target_name {
                Some(name) => name,
                None => match archive_access
                    .as_ref()
                    .and_then(|(file, _, _)| file.try_clone().ok())
                    .ok_or_else(|| {
                        crate::utils::ArchiveError::FileAccess(
                            "archive descriptor unavailable".into(),
                        )
                    })
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

            let Some((page_file, _, _)) = archive_access else {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(b"archive descriptor unavailable".to_vec())
                    .map_err(Into::into);
            };
            match read_archive_page_with_file(&full_path, &target_name, page_file) {
                Ok((buf, extension)) => {
                    let mime = detect_mime(&buf, &extension);
                    if let Some(key) = cover_cache_key {
                        // Cache only a successfully decoded cover, after all
                        // authorization and revision checks have passed.
                        state.cache_cover(key, buf.clone(), mime);
                    }
                    let build = move || {
                        Response::builder()
                            .header("Content-Type", mime)
                            .header("Cache-Control", ARCHIVE_IMAGE_CACHE_CONTROL)
                            .header("X-Content-Type-Options", "nosniff")
                            .header("Access-Control-Allow-Origin", "*")
                            .body(buf)
                            .map_err(Into::into)
                    };
                    if host == "cover" {
                        return build();
                    }
                    return reader_response_if_current(
                        &state,
                        id,
                        &comic_info.source_id,
                        reader_generation.expect("reader generation captured for page response"),
                        build,
                    );
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
        assert_eq!(ARCHIVE_IMAGE_CACHE_CONTROL, "no-store");
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
    fn source_query_decodes_once_for_reader_routes() {
        assert_eq!(
            source_id_from_query("gai://cover/shared?sourceId=local%3Aroot-a")
                .unwrap()
                .as_deref(),
            Some("local:root-a")
        );
        assert!(source_id_from_query(
            "gai://cover/shared?sourceId=local%3Aroot-a&sourceId=local%3Aroot-b",
        )
        .is_err());
        assert_eq!(
            source_id_from_query("gai://page/shared/0?sourceId=local%3Aroot-a")
                .unwrap()
                .as_deref(),
            Some("local:root-a")
        );
        assert!(source_id_from_query("gai://cover/shared?sourceId=%ZZ").is_err());
    }

    #[test]
    fn cover_does_not_consult_id_only_reader_index() {
        let state = AppState::new();
        state
            .opened_comic_files
            .write()
            .unwrap()
            .insert("shared".into(), vec!["cover.jpg".into()]);
        state.opened_comic_revisions.write().unwrap().insert(
            "shared".into(),
            state::SourceRevision {
                len: 1,
                modified: None,
                ctime: None,
                file_id: None,
            },
        );
        *state.active_comic_id.lock().unwrap() = Some("shared".into());
        *state.active_comic_source_id.lock().unwrap() = Some("local:test".into());

        assert!(
            opened_archive_page_for_request(&state, "shared", "local:test", 0, "cover").is_none()
        );
        assert!(
            opened_archive_page_for_request(&state, "shared", "local:test", 0, "page").is_some()
        );
    }

    #[test]
    fn reader_response_linearization_rejects_reopened_same_id_source() {
        let state = AppState::new();
        *state.active_comic_id.lock().unwrap() = Some("shared".into());
        *state.active_comic_source_id.lock().unwrap() = Some("local:a".into());
        let generation = state.active_reader_generation("shared", "local:a").unwrap();

        let response = reader_response_if_current(&state, "shared", "local:a", generation, || {
            Ok(Response::builder()
                .status(StatusCode::OK)
                .body(vec![1u8])
                .unwrap())
        })
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // A same-ID reopen changes the lifecycle identity. An old A request
        // must fail at its response linearization point rather than publish
        // bytes selected before B became active.
        state
            .reader_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let response = reader_response_if_current(&state, "shared", "local:a", generation, || {
            Ok(Response::builder()
                .status(StatusCode::OK)
                .body(vec![1u8])
                .unwrap())
        })
        .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn runtime_id_lookup_allows_same_source_duplicates_but_rejects_cross_source_collision() {
        let first = comic_item("archive", ".cbz");
        let mut same_source = first.clone();
        same_source.title = "duplicate row".into();
        assert!(unique_comic_for_runtime_id(&[first.clone(), same_source], "id").is_ok());

        let mut different_path = first.clone();
        different_path.relative_path = "other/book.cbz".into();
        assert!(unique_comic_for_runtime_id(&[first.clone(), different_path], "id").is_err());

        let mut foreign = first.clone();
        foreign.source_id = "external:other".into();
        assert!(unique_comic_for_runtime_id(&[first, foreign], "id").is_err());
    }

    #[test]
    fn runtime_id_lookup_prefers_online_over_retired_offline_location() {
        let mut offline = comic_item("archive", ".cbz");
        offline.source_id = "local:new".into();
        offline.r#type = "offline".into();
        offline.relative_path = "old/book.cbz".into();
        let mut online = comic_item("archive", ".cbz");
        online.source_id = "local:new".into();
        online.relative_path = "new/book.cbz".into();
        assert_eq!(
            unique_comic_for_runtime_id(&[offline, online], "id")
                .unwrap()
                .unwrap()
                .source_id,
            "local:new"
        );
    }

    #[test]
    fn cover_lookup_selects_requested_online_source_without_cross_source_fallback() {
        let mut first = comic_item("archive", ".cbz");
        first.source_id = "local:root-a".into();
        let mut second = first.clone();
        second.source_id = "local:root-b".into();
        second.title = "B".into();

        assert!(unique_comic_for_runtime_id(&[first.clone(), second.clone()], "id").is_err());
        assert_eq!(
            unique_comic_for_cover(
                &[first.clone(), second.clone()],
                "id",
                Some("local:root-b"),
                "/books"
            )
            .unwrap()
            .unwrap()
            .source_id,
            "local:root-b"
        );
        assert!(
            unique_comic_for_cover(&[first, second], "id", Some("local:missing"), "/books")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn cover_lookup_keeps_explicit_retired_source_offline() {
        let mut offline = comic_item("archive", ".cbz");
        offline.source_id = "local:old".into();
        offline.r#type = "offline".into();
        let mut online = offline.clone();
        online.source_id = "local:new".into();
        online.r#type = "archive".into();

        let selected =
            unique_comic_for_cover(&[offline, online], "id", Some("local:old"), "/books")
                .unwrap()
                .unwrap();
        assert_eq!(selected.source_id, "local:old");
        assert_eq!(selected.r#type, "offline");
    }

    #[test]
    fn cover_lookup_prefers_online_path_within_requested_source() {
        let mut offline = comic_item("archive", ".cbz");
        offline.source_id = "local:root".into();
        offline.r#type = "offline".into();
        offline.relative_path = "old/book.cbz".into();
        let mut online = offline.clone();
        online.r#type = "archive".into();
        online.relative_path = "new/book.cbz".into();

        let selected =
            unique_comic_for_cover(&[offline, online], "id", Some("local:root"), "/books")
                .unwrap()
                .unwrap();
        assert_eq!(selected.relative_path, "new/book.cbz");
    }

    #[test]
    fn cover_lookup_rejects_two_active_paths_in_one_source() {
        let first = comic_item("archive", ".cbz");
        let mut second = first.clone();
        second.relative_path = "other/book.cbz".into();
        assert!(
            unique_comic_for_cover(&[first, second], "id", Some("local:test"), "/books",).is_err()
        );
    }

    #[test]
    fn legacy_cover_source_prefers_bound_root_then_falls_back_to_legacy_row() {
        let mut legacy = comic_item("archive", ".cbz");
        legacy.source_id = "local".into();
        let selected = unique_comic_for_cover(&[legacy], "id", Some("local"), "/books/current")
            .unwrap()
            .unwrap();
        assert_eq!(selected.source_id, "local");
        assert_eq!(
            normalize_cover_source_id("local", "/books/current"),
            crate::scanner::local_source_id(Path::new("/books/current"))
        );
    }

    #[test]
    fn runtime_id_lookup_returns_none_for_unknown_comic() {
        assert!(
            unique_comic_for_runtime_id(&[comic_item("archive", ".cbz")], "missing")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn local_source_match_rejects_same_relative_path_from_another_root() {
        let root = std::env::temp_dir().join(format!(
            "comic-local-source-match-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let old_root = root.join("old");
        let current_root = root.join("current");
        std::fs::create_dir_all(&old_root).unwrap();
        std::fs::create_dir_all(&current_root).unwrap();
        let mut comic = comic_item("archive", ".cbz");
        comic.source_id = crate::scanner::local_source_id(&old_root);

        assert!(!local_source_matches_scan_dir(
            &comic,
            &current_root.to_string_lossy()
        ));
        comic.source_id = crate::scanner::local_source_id(&current_root);
        assert!(local_source_matches_scan_dir(
            &comic,
            &current_root.to_string_lossy()
        ));
        assert!(!local_source_matches_scan_dir(&comic, ""));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_local_source_is_bound_only_to_the_current_scan_root() {
        let root = std::env::temp_dir().join(format!(
            "comic-legacy-source-bind-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut legacy = comic_item("archive", ".cbz");
        legacy.source_id = "local".into();
        let scan_dir = root.to_string_lossy().into_owned();
        let bound = bind_legacy_local_source(&legacy, &scan_dir).unwrap();
        assert_eq!(
            bound.source_id,
            crate::scanner::local_source_id(Path::new(&scan_dir))
        );
        let mut mislabeled = legacy.clone();
        mislabeled.r#type = "external-archive".into();
        assert_eq!(
            crate::normalize_runtime_item(
                bind_legacy_local_source(&mislabeled, &scan_dir).unwrap()
            )
            .r#type,
            "archive"
        );
        let other_scan_dir = root.join("other");
        std::fs::create_dir_all(&other_scan_dir).unwrap();
        assert!(!local_source_matches_scan_dir(
            &bound,
            &other_scan_dir.to_string_lossy()
        ));

        legacy.source_id.clear();
        assert_eq!(
            bind_legacy_local_source(&legacy, &scan_dir)
                .unwrap()
                .source_id,
            bound.source_id
        );
        assert!(bind_legacy_local_source(&legacy, "").is_none());

        legacy.r#type = "offline".into();
        legacy.source_id = "local".into();
        assert_eq!(
            bind_legacy_local_source(&legacy, &scan_dir)
                .unwrap()
                .source_id,
            "local"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn comic_capability_rejects_old_local_root_with_same_relative_path() {
        let root = std::env::temp_dir().join(format!(
            "comic-local-capability-roots-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let old_root = root.join("old");
        let current_root = root.join("current");
        std::fs::create_dir_all(&old_root).unwrap();
        std::fs::create_dir_all(&current_root).unwrap();
        std::fs::write(old_root.join("book.cbz"), b"old-root").unwrap();
        std::fs::write(current_root.join("book.cbz"), b"current-root").unwrap();

        let state = AppState::new();
        *state.scan_dir.write().unwrap() = current_root.to_string_lossy().into_owned();
        let comic = ComicItem {
            source_id: crate::scanner::local_source_id(&old_root),
            relative_path: "book.cbz".into(),
            ..comic_item("archive", ".cbz")
        };

        let error = match comic_capability(&comic, &state, None) {
            Ok(_) => panic!("a comic from the old local root must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error
            .to_string()
            .contains("does not match the configured scan directory"));

        std::fs::remove_dir_all(root).unwrap();
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
    fn page_output_remains_bounded_even_if_the_reader_never_ends() {
        let error = read_image_limited(std::io::repeat(0)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "image exceeds size limit");
    }

    #[test]
    fn zip_page_with_oversized_declared_length_is_rejected() {
        let path = std::env::temp_dir().join(format!("comic-oversized-{}.zip", std::process::id()));
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("page.jpg", zip::write::FileOptions::default())
            .unwrap();
        writer.write_all(b"image").unwrap();
        let mut bytes = writer.finish().unwrap().into_inner();
        let central = bytes
            .windows(4)
            .position(|signature| signature == b"PK\x01\x02")
            .unwrap();
        bytes[central + 24..central + 28]
            .copy_from_slice(&((MAX_IMAGE_BYTES + 1) as u32).to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            read_archive_page(&path, "page.jpg").unwrap_err().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    #[ignore = "requires an explicitly supplied real archive"]
    fn real_zip_index_and_sampled_pages_are_readable() {
        let path = std::env::var_os("GAI_TEST_ARCHIVE").expect("set GAI_TEST_ARCHIVE");
        let path = Path::new(&path);
        let pages = crate::utils::get_archive_images(path).unwrap();
        assert!(!pages.is_empty());
        for index in [0, pages.len() / 2, pages.len() - 1] {
            let (bytes, extension) = read_archive_page(path, &pages[index]).unwrap();
            assert!(!bytes.is_empty());
            assert_ne!(detect_mime(&bytes, &extension), "application/octet-stream");
        }
        eprintln!(
            "indexed {} pages and read first, middle and last",
            pages.len()
        );
    }

    #[test]
    #[ignore = "requires an explicitly supplied real archive directory"]
    fn real_zip_directory_index_and_sampled_pages_are_readable() {
        let root = std::env::var_os("GAI_TEST_ARCHIVE_DIR").expect("set GAI_TEST_ARCHIVE_DIR");
        let mut paths: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
            })
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no ZIP files found");
        let mut failures = Vec::new();
        for path in &paths {
            let result = (|| -> Result<usize, String> {
                let pages =
                    crate::utils::get_archive_images(path).map_err(|error| error.to_string())?;
                for index in [0, pages.len() / 2, pages.len() - 1] {
                    let (bytes, extension) = read_archive_page(path, &pages[index])
                        .map_err(|error| format!("page {}: {error}", index + 1))?;
                    if bytes.is_empty()
                        || detect_mime(&bytes, &extension) == "application/octet-stream"
                    {
                        return Err(format!("page {} has no recognized image data", index + 1));
                    }
                }
                Ok(pages.len())
            })();
            match result {
                Ok(count) => eprintln!("PASS {}: {count} pages", path.display()),
                Err(error) => {
                    eprintln!("FAIL {}: {error}", path.display());
                    failures.push(format!("{}: {error}", path.display()));
                }
            }
        }
        assert!(
            failures.is_empty(),
            "{} archive(s) failed: {}",
            failures.len(),
            failures.join("; ")
        );
        eprintln!("sampled {} ZIP archives", paths.len());
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
        comic.source_id = crate::scanner::local_source_id(&own);
        comic.relative_path = "book.zip".into();
        comic.external_bookmark = None;
        assert!(comic_capability(&comic, &state, None).is_ok());
        let mut legacy_local = comic.clone();
        legacy_local.source_id = "local".into();
        assert!(comic_capability(&legacy_local, &state, None).is_err());
        let bound_local = bind_legacy_local_source(&legacy_local, &own.to_string_lossy()).unwrap();
        assert!(comic_capability(&bound_local, &state, None).is_ok());

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
