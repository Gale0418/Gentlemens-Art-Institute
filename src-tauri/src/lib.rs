use cap_fs_ext::DirExt;
pub mod archive_reader;
mod bookmark_recovery;
pub mod cache;
pub mod cache_policy;
pub mod catalog;
pub mod commerce;
pub mod file_ops;
pub(crate) mod ios_documents;
pub mod metadata;
pub mod photo_library;
pub mod protocol;
pub(crate) mod rar_quick_open;
pub mod rar_reader;
pub mod scanner;
pub mod smb_scanner;
pub mod state;
pub mod utils;

use state::{AppState, ComicItem, Progress};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Manager, State};

const SCAN_DIRECTORY_SETTINGS_FILE: &str = "scan-directory.txt";
const EXTERNAL_BOOKMARKS_SETTINGS_FILE: &str = "external-bookmarks.json";
const MAX_IMPORTED_PHOTO_BYTES: usize = 64 * 1024 * 1024;
const MAX_CATALOG_EXPORT_BYTES: usize = 64 * 1024 * 1024;
const MAX_AI_IMAGE_BYTES: usize = 20 * 1024 * 1024;
#[cfg(test)]
const MAX_AI_BASE64_BYTES: usize = MAX_AI_IMAGE_BYTES.div_ceil(3) * 4;
const MAX_AI_METADATA_IMAGE_COUNT: usize = 6;
const MAX_AI_METADATA_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_AI_METADATA_TOTAL_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_AI_RESPONSE_BYTES: usize = 1024 * 1024;
const SMB_DISK_RESERVE_BYTES: u64 = 256 * 1024 * 1024;
const SMB_SPACE_CHECK_INTERVAL_BYTES: u64 = 16 * 1024 * 1024;

fn smb_download_budget(declared_bytes: u64, available_bytes: u64) -> Result<u64, String> {
    let budget = archive_reader::MAX_ARCHIVE_BYTES
        .min(available_bytes.saturating_sub(SMB_DISK_RESERVE_BYTES));
    if declared_bytes == 0 || declared_bytes > budget {
        return Err("SMB_DOWNLOAD_CAPACITY".into());
    }
    Ok(budget)
}

fn checked_smb_download_size(
    received: u64,
    chunk_bytes: usize,
    declared_bytes: u64,
    budget: u64,
) -> Result<u64, String> {
    received
        .checked_add(chunk_bytes as u64)
        .filter(|total| *total <= declared_bytes && *total <= budget)
        .ok_or_else(|| "SMB_DOWNLOAD_SIZE_MISMATCH".into())
}

fn smb_recovery_content_matches(expected: [u8; 32], observed: [u8; 32]) -> bool {
    expected == observed
}

fn smb_stat_stable_during_read(before: &smb2::FileInfo, after: &smb2::FileInfo) -> bool {
    !before.is_directory
        && !after.is_directory
        && before.size == after.size
        && before.created == after.created
        && before.modified == after.modified
}

async fn smb_remote_content_hash(
    config: &state::SmbConfig,
    relative_path: &str,
) -> Result<(u64, [u8; 32]), String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("SMB 漫畫路徑不安全，已拒絕驗證進度來源".into());
    }
    let addr = format!("{}:445", config.host);
    let username = config.username.as_deref().unwrap_or("guest");
    let password = config.password.as_deref().unwrap_or("");
    let mut client = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        smb2::connect(&addr, username, password),
    )
    .await
    .map_err(|_| "SMB 進度來源連線逾時".to_string())?
    .map_err(|error| format!("SMB 進度來源連線失敗: {error}"))?;
    let mut tree = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.connect_share(&config.share),
    )
    .await
    .map_err(|_| "SMB 進度來源共用資料夾連線逾時".to_string())?
    .map_err(|error| format!("SMB 進度來源共用資料夾連線失敗: {error}"))?;
    let smb_path = relative_path.replace('/', "\\");
    let before = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.stat(&mut tree, &smb_path),
    )
    .await
    .map_err(|_| "SMB 進度來源驗證逾時".to_string())?
    .map_err(|error| format!("SMB 進度來源驗證失敗: {error}"))?;
    if before.is_directory {
        return Err("SMB 進度來源不是檔案".into());
    }
    let mut download = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.download(&tree, &smb_path),
    )
    .await
    .map_err(|_| "SMB 進度來源讀取逾時".to_string())?
    .map_err(|error| format!("SMB 進度來源讀取失敗: {error:?}"))?;
    let declared_bytes = download.size();
    if declared_bytes == 0
        || declared_bytes > archive_reader::MAX_ARCHIVE_BYTES
        || declared_bytes != before.size
    {
        return Err("SMB 進度來源大小無效".into());
    }
    let mut received = 0_u64;
    let mut hasher = blake3::Hasher::new();
    loop {
        let next = tokio::time::timeout(std::time::Duration::from_secs(30), download.next_chunk())
            .await
            .map_err(|_| "SMB 進度來源傳輸逾時".to_string())?;
        let Some(chunk) = next else { break };
        let bytes = chunk.map_err(|error| format!("SMB 進度來源傳輸失敗: {error:?}"))?;
        received = checked_smb_download_size(
            received,
            bytes.len(),
            declared_bytes,
            archive_reader::MAX_ARCHIVE_BYTES,
        )?;
        hasher.update(&bytes);
    }
    if received != declared_bytes {
        return Err("SMB 進度來源傳輸長度不符".into());
    }
    drop(download);
    let after = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client.stat(&mut tree, &smb_path),
    )
    .await
    .map_err(|_| "SMB 進度來源二次驗證逾時".to_string())?
    .map_err(|error| format!("SMB 進度來源二次驗證失敗: {error}"))?;
    if !smb_stat_stable_during_read(&before, &after) {
        return Err("SMB 進度來源在驗證期間變更".into());
    }
    Ok((declared_bytes, *hasher.finalize().as_bytes()))
}

async fn smb_available_space(path: std::path::PathBuf) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || fs4::available_space(path))
        .await
        .map_err(|_| "SMB_SPACE_CHECK_FAILED".to_string())?
        .map_err(|_| "SMB_SPACE_CHECK_FAILED".to_string())
}

static AI_HTTP_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

// `AppState::ai_send_lifecycle` predates concurrent AI sends and is a
// `Mutex<()>`, which cannot express the read/write barrier needed here. Keep
// this barrier in this module so sends can share a read guard while session
// transitions take the write side. The app has one process-wide AppState.
static AI_SEND_LIFECYCLE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
static AI_SEND_CANCELLATION: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();

fn ai_send_lifecycle() -> &'static tokio::sync::RwLock<()> {
    AI_SEND_LIFECYCLE.get_or_init(|| tokio::sync::RwLock::new(()))
}

fn ai_send_cancellation() -> &'static tokio::sync::watch::Sender<u64> {
    AI_SEND_CANCELLATION.get_or_init(|| {
        let (sender, _) = tokio::sync::watch::channel(0);
        sender
    })
}

fn cancel_ai_sends(generation: u64) {
    // A send can already be waiting on the request gate or in reqwest's
    // connection setup. The generation check handles the former; the watch
    // signal interrupts the latter so the transition can acquire the write
    // side promptly.
    let _ = ai_send_cancellation().send(generation);
}

async fn wait_for_ai_sends() {
    drop(ai_send_lifecycle().write().await);
}

pub(crate) fn normalize_runtime_item(mut item: ComicItem) -> ComicItem {
    if item.r#type == "offline" {
        return item;
    }
    let is_folder = item.r#type.contains("folder");
    let is_image = item.r#type.contains("image");
    item.r#type = if state::is_smb_source_id(&item.source_id) {
        "smb-archive"
    } else if item.source_id.starts_with("external:") {
        if is_folder {
            "external-folder"
        } else if is_image {
            "external-image"
        } else {
            "external-archive"
        }
    } else if item.source_id.starts_with("local:") {
        if is_folder {
            "folder"
        } else if is_image {
            "image"
        } else {
            "archive"
        }
    } else {
        return item;
    }
    .to_string();
    item
}

fn register_comic_capability(comics: &mut Vec<ComicItem>, item: &ComicItem) {
    let normalized = normalize_runtime_item(item.clone());
    if let Some(existing) = comics.iter_mut().find(|comic| {
        comic.id == normalized.id
            && comic.source_id == normalized.source_id
            && comic.relative_path == normalized.relative_path
    }) {
        if existing.r#type != normalized.r#type {
            existing.r#type.clone_from(&normalized.r#type);
        }
        return;
    }

    if let Some(existing) = comics.iter_mut().find(|comic| {
        comic.id == normalized.id
            && comic.relative_path == normalized.relative_path
            && protocol::is_legacy_local_source_id(&comic.source_id)
            && normalized.source_id.starts_with("local:")
            && normalized.r#type != "offline"
    }) {
        // Legacy catalog entries had no root identity. `item` has already
        // been bound to the current scan snapshot, so same-path promotion is
        // safe; unrelated retired locations remain available for recovery.
        existing.source_id.clone_from(&normalized.source_id);
        existing.r#type.clone_from(&normalized.r#type);
        return;
    }

    comics.push(normalized);
}

fn validate_scan_directory(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err("漫畫目錄必須是非空白的絕對路徑".into());
    }

    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let volumes_root = Path::new("/Volumes");
    let is_home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .is_some_and(|home| resolved == home);
    // /Volumes/<name> is a mounted share or disk root, not the computer root.
    // Canonicalization still rejects aliases that resolve to / or HOME.
    if resolved.parent().is_none() || resolved == volumes_root || is_home {
        return Err("為避免掃描整台電腦，請選擇磁碟內實際存放漫畫的子資料夾".into());
    }
    Ok(trimmed.to_string())
}

fn validate_smb_config(data: Option<state::SmbConfig>) -> Result<Option<state::SmbConfig>, String> {
    let Some(data) = data else {
        return Ok(None);
    };
    let host = data.host.trim();
    let share = data.share.trim();
    let username = data.username.as_deref().map(str::trim).unwrap_or("");
    let password = data.password.as_deref().unwrap_or("");
    if host.is_empty()
        || host.len() > 255
        || host.contains(['/', '\\'])
        || host.chars().any(char::is_control)
    {
        return Err("NAS 主機名稱／IP 格式不正確".into());
    }
    if share.is_empty()
        || share.len() > 255
        || matches!(share, "." | "..")
        || share.contains(['/', '\\'])
        || share.chars().any(char::is_control)
    {
        return Err("NAS Share 名稱格式不正確".into());
    }
    if username.len() > 256 || username.chars().any(char::is_control) {
        return Err("NAS 使用者名稱格式不正確".into());
    }
    if password.len() > 1024 || password.chars().any(char::is_control) {
        return Err("NAS 密碼格式不正確".into());
    }
    Ok(Some(state::SmbConfig {
        host: host.to_string(),
        share: share.to_string(),
        username: (!username.is_empty()).then(|| username.to_string()),
        password: (!password.is_empty()).then(|| password.to_string()),
    }))
}

fn normalize_progress_values(
    current_page: u64,
    total_pages: u64,
) -> Result<(usize, usize, f64), String> {
    let total_pages = usize::try_from(total_pages).map_err(|_| "總頁數超出平台上限")?;
    let current_page = usize::try_from(current_page).map_err(|_| "目前頁碼超出平台上限")?;
    let current_page = if total_pages == 0 {
        0
    } else {
        current_page.min(total_pages - 1)
    };
    let percent = if total_pages > 0 && (current_page > 0 || total_pages == 1) {
        ((current_page + 1) as f64 / total_pages as f64) * 100.0
    } else {
        0.0
    };
    Ok((current_page, total_pages, percent.clamp(0.0, 100.0)))
}

fn authoritative_total_pages(
    opened_total_pages: Option<usize>,
    requested_total_pages: u64,
) -> Result<u64, String> {
    match opened_total_pages {
        Some(total) => u64::try_from(total).map_err(|_| "已開啟漫畫頁數超出平台上限".into()),
        None => Ok(requested_total_pages),
    }
}

fn runtime_id_has_multiple_locations(comics: &[ComicItem], id: &str) -> bool {
    let matching = comics
        .iter()
        .filter(|comic| comic.id == id)
        .collect::<Vec<_>>();
    let online_exists = matching.iter().any(|comic| comic.r#type != "offline");
    matching
        .into_iter()
        .filter(|comic| !online_exists || comic.r#type != "offline")
        .map(|comic| (comic.source_id.as_str(), comic.relative_path.as_str()))
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        > 1
}

fn runtime_id_has_multiple_locations_for_source(
    comics: &[ComicItem],
    id: &str,
    source_id: &str,
) -> bool {
    let matching = comics
        .iter()
        .filter(|comic| comic.id == id && comic.source_id == source_id)
        .collect::<Vec<_>>();
    let online_exists = matching.iter().any(|comic| comic.r#type != "offline");
    matching
        .into_iter()
        .filter(|comic| !online_exists || comic.r#type != "offline")
        .map(|comic| comic.relative_path.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        > 1
}

#[cfg(test)]
fn runtime_id_conflicts_with_requested_source(
    comics: &[ComicItem],
    id: &str,
    requested_source_id: &str,
    requested_item_is_offline: bool,
) -> bool {
    comics.iter().any(|comic| {
        comic.id == id
            && comic.source_id != requested_source_id
            && (requested_item_is_offline || comic.r#type != "offline")
    })
}

fn normalize_requested_source_id(source_id: Option<String>, scan_dir: &str) -> Option<String> {
    source_id.map(|source| {
        if protocol::is_legacy_local_source_id(&source) && !scan_dir.is_empty() {
            scanner::local_source_id(Path::new(scan_dir))
        } else {
            source
        }
    })
}

fn parse_requested_source_id(source_id: Option<&str>) -> Result<Option<String>, String> {
    let requested = source_id
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .map(str::to_owned);
    if source_id.is_some() && requested.is_none() {
        return Err("漫畫來源識別碼格式不正確".into());
    }
    Ok(requested)
}

fn require_reader_pages(page_paths: &[String]) -> Result<(), String> {
    if page_paths.is_empty() {
        return Err("漫畫沒有可讀取的圖片頁面".into());
    }
    Ok(())
}

fn reader_route_url(route: &str, id: &str, page_index: usize, source_id: &str) -> String {
    format!(
        "gai://{route}/{id}/{page_index}?sourceId={}",
        protocol::encode_query_component(source_id)
    )
}

fn close_request_matches_reader(
    id: &str,
    requested_source_id: Option<&str>,
    active_id: Option<&str>,
    active_source_id: Option<&str>,
    pending_id: Option<&str>,
    pending_source_id: Option<&str>,
) -> bool {
    let source_matches =
        |source: Option<&str>| requested_source_id.is_none() || requested_source_id == source;
    (active_id == Some(id) && source_matches(active_source_id))
        || (pending_id == Some(id) && source_matches(pending_source_id))
}

fn cleanup_source_id_for_close(
    id: &str,
    requested_source_id: Option<&str>,
    active_id: Option<&str>,
    active_source_id: Option<&str>,
    pending_id: Option<&str>,
    pending_source_id: Option<&str>,
) -> Option<String> {
    let source_matches =
        |source: Option<&str>| requested_source_id.is_none() || requested_source_id == source;
    if active_id == Some(id) && source_matches(active_source_id) {
        active_source_id.map(str::to_owned)
    } else if pending_id == Some(id) && source_matches(pending_source_id) {
        pending_source_id.map(str::to_owned)
    } else {
        None
    }
}

fn select_runtime_item_from_state(
    comics: &[ComicItem],
    id: &str,
    requested_source_id: Option<&str>,
) -> Option<ComicItem> {
    let online_exists = comics
        .iter()
        .any(|comic| comic.id == id && comic.r#type != "offline");
    let requested_online_exists = requested_source_id.is_some_and(|source| {
        comics
            .iter()
            .any(|comic| comic.id == id && comic.source_id == source && comic.r#type != "offline")
    });
    comics
        .iter()
        .find(|comic| {
            comic.id == id
                && if requested_source_id.is_some() {
                    !requested_online_exists || comic.r#type != "offline"
                } else {
                    !online_exists || comic.r#type != "offline"
                }
                && requested_source_id
                    .map(|source| comic.source_id == source)
                    .unwrap_or(true)
        })
        .cloned()
}

fn unique_catalog_runtime_item(items: Vec<ComicItem>) -> Result<Option<ComicItem>, String> {
    let items = items
        .into_iter()
        .filter(|item| !catalog::is_quarantine_relative_path(&item.relative_path))
        .collect::<Vec<_>>();
    let online_items = items
        .iter()
        .filter(|item| item.r#type != "offline")
        .collect::<Vec<_>>();
    let candidates = if online_items.is_empty() {
        items.iter().collect::<Vec<_>>()
    } else {
        online_items
    };
    let Some(first) = candidates.first().cloned().cloned() else {
        return Ok(None);
    };
    if candidates
        .iter()
        .any(|item| item.source_id != first.source_id || item.relative_path != first.relative_path)
    {
        return Err("漫畫識別碼不唯一，請提供 sourceId".into());
    }
    Ok(Some(first))
}

fn unique_catalog_runtime_item_for_operation(
    items: Vec<ComicItem>,
) -> Result<Option<ComicItem>, String> {
    let Some(first) = items.first() else {
        return Ok(None);
    };
    if items
        .iter()
        .any(|item| item.source_id != first.source_id || item.relative_path != first.relative_path)
    {
        return Err("漫畫有多個來源位置，為避免誤操作，暫時無法管理檔案".into());
    }
    let fallback = first.clone();
    Ok(items
        .into_iter()
        .find(|item| item.r#type != "offline")
        .or(Some(fallback)))
}

fn replace_file_operation_state(
    comics: &mut Vec<ComicItem>,
    source_id: &str,
    before_relative_path: &str,
    refreshed: Option<ComicItem>,
) {
    comics.retain(|current| {
        !(current.source_id == source_id && current.relative_path == before_relative_path)
    });
    if let Some(item) = refreshed {
        comics.push(normalize_runtime_item(item));
    }
}

async fn refresh_file_operation_state(
    state: &Arc<AppState>,
    source_id: &str,
    before_relative_path: &str,
    hide_quarantine: bool,
    refreshed: Result<Option<ComicItem>, String>,
) -> state::ScanProgress {
    let (refreshed, refresh_error) = match refreshed {
        Ok(Some(item)) if hide_quarantine && is_quarantine_relative_path(&item.relative_path) => {
            (None, None)
        }
        Ok(Some(item)) => (Some(item), None),
        Ok(None) => (
            None,
            Some("漫畫位置刷新未找到精確來源位置，請重新整理書庫".into()),
        ),
        Err(error) => (None, Some(error)),
    };
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    let generation = state
        .scan_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let mut comics = state.comics.lock().await;
    replace_file_operation_state(comics.as_mut(), source_id, before_relative_path, refreshed);
    let mut progress = state.scan_progress.lock().await;
    progress.generation = generation;
    progress.is_scanning = false;
    progress.phase = if refresh_error.is_some() {
        "refresh-required".into()
    } else {
        "complete".into()
    };
    progress.error = refresh_error;
    progress.found = comics.len();
    progress.completed_at = Some(chrono::Utc::now().to_rfc3339());
    progress.clone()
}

fn is_quarantine_relative_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    normalized == ".gai-quarantine" || normalized.starts_with(".gai-quarantine/")
}

fn prefer_online_catalog_item(
    state_item: Option<ComicItem>,
    catalog_item: Option<ComicItem>,
) -> Option<ComicItem> {
    if state_item
        .as_ref()
        .is_some_and(|item| item.r#type == "offline")
    {
        catalog_item
            .filter(|item| item.r#type != "offline")
            .or(state_item)
    } else {
        state_item
    }
}

fn reader_generation_is_current(state: &AppState, generation: u64) -> bool {
    state
        .reader_generation
        .load(std::sync::atomic::Ordering::Acquire)
        == generation
}

/// Clears a pending open if `open_comic` exits before publishing a reader.
///
/// The frontend can reject/cancel an open before it gets a chance to call
/// `close_comic`. Keeping this guard scoped to the generation and source is
/// important: an older open must never clear a newer same-ID/source request.
struct PendingOpenGuard {
    state: Arc<AppState>,
    id: String,
    source_id: Option<String>,
    generation: u64,
}

impl PendingOpenGuard {
    fn new(state: Arc<AppState>, id: String, source_id: Option<String>, generation: u64) -> Self {
        Self {
            state,
            id,
            source_id,
            generation,
        }
    }
}

impl Drop for PendingOpenGuard {
    fn drop(&mut self) {
        let Ok(_lifecycle) = self.state.comic_lifecycle.lock() else {
            return;
        };
        // The generation must be checked while the lifecycle is held. An
        // unlocked pre-check could race a newer same-ID open that updates the
        // generation and pending slot immediately afterwards.
        if self
            .state
            .reader_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != self.generation
        {
            return;
        }
        let Ok(mut pending_id) = self.state.pending_open_id.lock() else {
            return;
        };
        let Ok(mut pending_source_id) = self.state.pending_open_source_id.lock() else {
            return;
        };
        let source_matches = match self.source_id.as_deref() {
            Some(source_id) => pending_source_id.as_deref() == Some(source_id),
            None => pending_source_id.is_none(),
        };
        if pending_id.as_deref() == Some(self.id.as_str()) && source_matches {
            *pending_id = None;
            *pending_source_id = None;
        }
    }
}

fn begin_pending_open(state: &AppState, id: &str, source_id: Option<String>) -> u64 {
    let _lifecycle = state.comic_lifecycle.lock().unwrap();
    let generation = state
        .reader_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    *state.pending_open_id.lock().unwrap() = Some(id.to_owned());
    *state.pending_open_source_id.lock().unwrap() = source_id;
    generation
}

fn bind_pending_open_source(
    state: &AppState,
    id: &str,
    generation: u64,
    source_id: String,
) -> Result<(), String> {
    let _lifecycle = state.comic_lifecycle.lock().unwrap();
    if !reader_generation_is_current(state, generation)
        || state.pending_open_id.lock().unwrap().as_deref() != Some(id)
    {
        return Err("開啟漫畫已取消".into());
    }
    *state.pending_open_source_id.lock().unwrap() = Some(source_id);
    Ok(())
}

fn open_smb_temp_root(temp_base: &Path, source_id: &str) -> Result<cap_std::fs::Dir, String> {
    std::fs::create_dir_all(temp_base)
        .map_err(|error| format!("無法建立 SMB 暫存根目錄: {error}"))?;
    let base = cap_std::fs::Dir::open_ambient_dir(temp_base, cap_std::ambient_authority())
        .map_err(|error| format!("無法開啟 SMB 暫存根目錄: {error}"))?;
    base.create_dir_all("ComicTemp")
        .map_err(|error| format!("無法建立 SMB 暫存目錄: {error}"))?;
    let comic_temp = base
        .open_dir_nofollow("ComicTemp")
        .map_err(|error| format!("無法開啟 SMB 暫存目錄: {error}"))?;
    let namespace = protocol::smb_cache_root_path(Path::new("."), source_id);
    let namespace = namespace
        .file_name()
        .ok_or_else(|| "SMB 暫存來源識別碼無效".to_string())?;
    comic_temp
        .create_dir_all(namespace)
        .map_err(|error| format!("無法建立 SMB 來源暫存目錄: {error}"))?;
    comic_temp
        .open_dir_nofollow(namespace)
        .map_err(|error| format!("無法開啟 SMB 暫存目錄: {error}"))
}

/// Atomically detach the fixed SMB temp child so a newer open can create its
/// own `ComicTemp` after the lifecycle lock is released.
fn retire_smb_temp_namespace(temp_base: &Path) -> Option<PathBuf> {
    let current = temp_base.join("ComicTemp");
    let retired = temp_base.join(format!(".ComicTemp-retired-{}", uuid::Uuid::new_v4()));
    std::fs::rename(current, &retired).ok()?;
    Some(retired)
}

fn remove_retired_smb_temp_namespace(retired: &Path) {
    let _ = std::fs::remove_dir_all(retired);
}

fn cleanup_retired_smb_temp_namespace(retired: PathBuf) {
    // Dropping the handle detaches the already-spawned blocking cleanup.
    drop(tauri::async_runtime::spawn_blocking(move || {
        remove_retired_smb_temp_namespace(&retired);
    }));
}

fn remove_smb_temp_entry(temp_base: &Path, source_id: &str, relative: &Path) -> Result<(), String> {
    let base = match cap_std::fs::Dir::open_ambient_dir(temp_base, cap_std::ambient_authority()) {
        Ok(base) => base,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("無法開啟 SMB 暫存根目錄: {error}")),
    };
    let comic_temp = match base.open_dir_nofollow("ComicTemp") {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("無法開啟 SMB 暫存目錄: {error}")),
    };
    let namespace = protocol::smb_cache_root_path(Path::new("."), source_id);
    let namespace = namespace
        .file_name()
        .ok_or_else(|| "SMB 暫存來源識別碼無效".to_string())?;
    let temp_root = match comic_temp.open_dir_nofollow(namespace) {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("無法開啟 SMB 來源暫存目錄: {error}")),
    };
    match temp_root.symlink_metadata(relative) {
        Ok(metadata) if metadata.file_type().is_dir() => temp_root
            .remove_dir_all(relative)
            .map_err(|error| format!("無法清除 SMB 暫存目錄: {error}")),
        Ok(_) => temp_root
            .remove_file(relative)
            .map_err(|error| format!("無法清除 SMB 暫存檔: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("無法檢查 SMB 暫存檔: {error}")),
    }
}

fn commit_smb_download_if_current(
    state: &AppState,
    generation: u64,
    temp_root: &cap_std::fs::Dir,
    partial_path: &Path,
    final_path: &Path,
) -> Result<(), String> {
    // close_comic and a newer open both take this same lifecycle lock before
    // advancing the generation. The final generation check and filesystem
    // commit are therefore atomic with respect to cancellation: a stale task
    // can never publish its completed partial after the reader was closed.
    let _lifecycle = state
        .comic_lifecycle
        .lock()
        .map_err(|_| "漫畫生命週期鎖定失敗".to_string())?;
    if !reader_generation_is_current(state, generation) {
        return Err("開啟漫畫已取消".into());
    }
    temp_root
        .rename(partial_path, temp_root, final_path)
        .map_err(|error| format!("SMB 暫存檔提交失敗: {error}"))
}

fn persist_scan_directory(app_handle: &AppHandle, scan_dir: &str) -> Result<(), String> {
    let settings_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("無法取得 App 設定目錄：{error}"))?;
    std::fs::create_dir_all(&settings_dir)
        .map_err(|error| format!("無法建立 App 設定目錄：{error}"))?;
    std::fs::write(
        settings_dir.join(SCAN_DIRECTORY_SETTINGS_FILE),
        scan_dir.as_bytes(),
    )
    .map_err(|error| format!("無法儲存漫畫目錄設定：{error}"))
}

fn load_persisted_scan_directory(settings_dir: &Path) -> Option<String> {
    let saved = std::fs::read_to_string(settings_dir.join(SCAN_DIRECTORY_SETTINGS_FILE)).ok()?;
    validate_scan_directory(&saved).ok()
}

fn persist_external_bookmarks(
    app_handle: &AppHandle,
    bookmarks: &[state::ExternalBookmark],
) -> Result<(), String> {
    let settings_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("無法取得 App 設定目錄：{error}"))?;
    std::fs::create_dir_all(&settings_dir)
        .map_err(|error| format!("無法建立 App 設定目錄：{error}"))?;
    let data =
        serde_json::to_vec(bookmarks).map_err(|error| format!("外部來源格式錯誤：{error}"))?;
    persist_settings_file_atomically(&settings_dir, EXTERNAL_BOOKMARKS_SETTINGS_FILE, &data)
        .map_err(|error| format!("無法儲存外部資料夾授權：{error}"))
}

fn persist_settings_file_atomically(
    settings_dir: &Path,
    file_name: &str,
    data: &[u8],
) -> std::io::Result<()> {
    let destination = settings_dir.join(file_name);
    let temporary = settings_dir.join(format!("{file_name}.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &destination)?;
        #[cfg(unix)]
        std::fs::File::open(settings_dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn load_persisted_external_bookmarks(
    settings_dir: &Path,
) -> Result<Vec<state::ExternalBookmark>, String> {
    external_bookmarks_for_restore(settings_dir, Vec::new(), true)
}

fn external_bookmarks_for_restore(
    settings_dir: &Path,
    legacy_bookmarks: Vec<state::ExternalBookmark>,
    legacy_cache_readable: bool,
) -> Result<Vec<state::ExternalBookmark>, String> {
    match std::fs::read(settings_dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE)) {
        Ok(data) => serde_json::from_slice(&data)
            .map_err(|error| format!("BOOKMARKS_CORRUPT: 無法讀取已保存的外部資料夾授權：{error}")),
        // 只允許未保存過原生設定的舊版遷移。保存的空清單也具有權威，
        // 不可因瀏覽器殘留快取而重新加入已被使用者移除的來源。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if legacy_cache_readable {
                Ok(legacy_bookmarks)
            } else {
                Err("舊外部資料夾清單暫時無法讀取，未保存任何變更；請稍後重試".into())
            }
        }
        Err(error) => Err(format!("無法讀取已保存的外部資料夾授權：{error}")),
    }
}

// iOS 更新 App 後容器 UUID 可能改變；只重定位內建 Documents，不改外部來源。
#[cfg(any(target_os = "ios", test))]
fn relocate_ios_documents(saved: &str, documents: &Path) -> String {
    let Some(saved_container) = ios_documents::documents_container_id(saved) else {
        return saved.to_string();
    };
    let Some(current_container) = documents
        .to_str()
        .and_then(ios_documents::documents_container_id)
    else {
        return saved.to_string();
    };
    if saved_container == current_container {
        return saved.to_string();
    }
    documents.to_string_lossy().into_owned()
}

fn catalog_store(state: &State<'_, Arc<AppState>>) -> Result<catalog::CatalogStore, String> {
    state
        .catalog
        .read()
        .map_err(|_| "漫畫目錄鎖定失敗".to_string())?
        .clone()
        .ok_or_else(|| "漫畫目錄尚未初始化".to_string())
}

#[tauri::command]
async fn get_commerce(app_handle: AppHandle) -> Result<commerce::CommerceStatus, String> {
    commerce::status(&app_handle, commerce::CommerceAction::Status).await
}

#[tauri::command]
async fn purchase_pro(app_handle: AppHandle) -> Result<commerce::CommerceStatus, String> {
    commerce::status(&app_handle, commerce::CommerceAction::Purchase).await
}

#[tauri::command]
async fn restore_pro(app_handle: AppHandle) -> Result<commerce::CommerceStatus, String> {
    commerce::status(&app_handle, commerce::CommerceAction::Restore).await
}

#[tauri::command]
async fn search_catalog(
    query: catalog::CatalogQuery,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::CatalogSearchResult, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.search(query))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_discovery_tags(
    runtime_ids: Vec<String>,
    targets: Option<Vec<catalog::BatchEditTarget>>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::DiscoveryTagGroup>, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || match targets {
        Some(targets) if !targets.is_empty() => store.discovery_tags_for_targets(&targets),
        _ => store.discovery_tags(&runtime_ids),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_comic_metadata(
    id: String,
    source_id: Option<String>,
    relative_path: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::ComicMetadataView, String> {
    if let Some(item) = photo_library::find_item(state.inner(), &id).await {
        let album_available = if let Some(album_id) = photo_library::album_id_from_photo_id(&id) {
            state
                .photo_albums
                .lock()
                .await
                .iter()
                .any(|album| album.id == album_id && album.available)
        } else {
            false
        };
        return Ok(catalog::ComicMetadataView {
            comic_id: item.id.clone(),
            runtime_id: Some(item.id),
            title: item.title,
            series: Some(item.series),
            volume: None,
            number: None,
            summary: None,
            language: None,
            reading_direction: None,
            published_at: None,
            relative_path: Some(item.relative_path),
            source_id: Some(item.source_id),
            offline: !album_available,
            locations: Vec::new(),
            creators: std::collections::BTreeMap::new(),
            tags: Vec::new(),
            candidates: Vec::new(),
            locked_fields: Vec::new(),
            diagnostics: Vec::new(),
        });
    }
    let store = catalog_store(&state)?;
    if source_id.is_some() != relative_path.is_some() {
        return Err("漫畫來源位置資訊不完整，已拒絕 metadata 查詢".into());
    }
    tokio::task::spawn_blocking(move || match (source_id, relative_path) {
        (Some(source_id), Some(relative_path)) => {
            store.get_metadata_for_source(&id, &source_id, &relative_path)
        }
        (None, None) => store.get_metadata(&id),
        _ => unreachable!("source metadata arguments were checked above"),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn apply_batch_metadata(
    app_handle: AppHandle,
    request: catalog::BatchEditRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::BatchEditResult, String> {
    let commerce_batch_ids = if request.targets.is_empty() {
        request.comic_ids.clone()
    } else {
        request
            .targets
            .iter()
            .map(|target| {
                format!(
                    "{}\0{}\0{}",
                    target.runtime_id, target.source_id, target.relative_path
                )
            })
            .collect()
    };
    if commerce::is_batch(&commerce_batch_ids) {
        commerce::require_pro(&app_handle).await?;
    }
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.apply_batch(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn undo_batch_metadata(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<usize, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.undo_batch(&token))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn upsert_folder_tag_rule(
    app_handle: AppHandle,
    rule: catalog::FolderTagRule,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::FolderTagRule, String> {
    commerce::require_pro(&app_handle).await?;
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.upsert_folder_rule(rule))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reimport_metadata(
    app_handle: AppHandle,
    request: catalog::ReimportRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::ReimportResult, String> {
    let commerce_batch_ids = if request.targets.is_empty() {
        request.comic_ids.clone()
    } else {
        request
            .targets
            .iter()
            .map(|target| {
                format!(
                    "{}\0{}\0{}",
                    target.runtime_id, target.source_id, target.relative_path
                )
            })
            .collect()
    };
    if commerce_batch_ids.is_empty() || commerce::is_batch(&commerce_batch_ids) {
        commerce::require_pro(&app_handle).await?;
    }
    let _catalog_sync = state.catalog_sync.lock().await;
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.reimport(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_import_diagnostics(
    limit: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::ImportDiagnostic>, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.diagnostics(limit.unwrap_or(200)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn upsert_tag_alias(
    app_handle: AppHandle,
    alias: catalog::TagAlias,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::TagAlias, String> {
    commerce::require_pro(&app_handle).await?;
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.upsert_tag_alias(alias))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_tag_aliases(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::TagAlias>, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.tag_aliases())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_tag_inventory(
    query: catalog::TagInventoryQuery,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::TagInventoryResult, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.tag_inventory(query))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn update_tag_state(
    update: catalog::TagStateUpdate,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.update_tag_state(update))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn rename_tag(
    app_handle: AppHandle,
    tag_id: i64,
    display_value: String,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::TagMutationResult, String> {
    commerce::require_pro(&app_handle).await?;
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.rename_tag(tag_id, &display_value))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn merge_tags(
    app_handle: AppHandle,
    source_tag_id: i64,
    target_tag_id: i64,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::TagMutationResult, String> {
    commerce::require_pro(&app_handle).await?;
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.merge_tags(source_tag_id, target_tag_id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_tag_disabled(
    app_handle: AppHandle,
    tag_id: i64,
    disabled: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::TagMutationResult, String> {
    let store = catalog_store(&state)?;
    if disabled {
        commerce::require_pro(&app_handle).await?;
    }
    tokio::task::spawn_blocking(move || store.set_tag_disabled(tag_id, disabled))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn undo_tag_operation(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.undo_tag_operation(&token))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_organizer_inbox(
    app_handle: AppHandle,
    limit: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::OrganizerInboxItem>, String> {
    commerce::require_pro(&app_handle).await?;
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.organizer_inbox(limit.unwrap_or(200)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_duplicate_candidates(
    app_handle: AppHandle,
    limit: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::DuplicateCandidate>, String> {
    commerce::require_pro(&app_handle).await?;
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.duplicate_candidates(limit.unwrap_or(200)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_related_tags(
    id: String,
    limit: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::TagSuggestion>, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.related_tags(&id, limit.unwrap_or(8)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn export_catalog_metadata(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.export_exchange_json())
        .await
        .map_err(|error| error.to_string())?
}

fn validate_export_filename(filename: &str) -> Result<&str, String> {
    let path = Path::new(filename);
    if filename.is_empty()
        || filename.len() > 255
        || filename.chars().any(char::is_control)
        || path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
        || path.extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Err("metadata 匯出檔名必須是單一 .json 檔名".into());
    }
    Ok(filename)
}

#[tauri::command]
fn default_catalog_export_path(app: AppHandle, filename: String) -> Result<String, String> {
    let filename = validate_export_filename(filename.trim())?;
    let directory = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|error| format!("找不到 metadata 匯出目錄：{error}"))?;
    Ok(directory.join(filename).to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_catalog_metadata(
    app: AppHandle,
    path: String,
    payload: String,
) -> Result<String, String> {
    if payload.len() > MAX_CATALOG_EXPORT_BYTES {
        return Err("metadata 匯出內容超過 64 MiB 上限".into());
    }
    let target = std::path::PathBuf::from(path);
    if target.as_os_str().is_empty() || !target.is_absolute() {
        return Err("匯出路徑必須是絕對路徑".into());
    }
    let filename = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "匯出檔名無效".to_string())?;
    validate_export_filename(filename)?;
    let allowed_roots = [app.path().download_dir(), app.path().app_local_data_dir()]
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|root| root.canonicalize().ok())
        .collect::<Vec<_>>();
    let parent = target
        .parent()
        .ok_or_else(|| "匯出路徑缺少父資料夾".to_string())?
        .canonicalize()
        .map_err(|error| format!("匯出目錄不存在或無法存取：{error}"))?;
    if !allowed_roots.iter().any(|root| parent.starts_with(root)) {
        return Err("匯出只能寫入下載或 App 私有資料夾".into());
    }
    let directory = cap_std::fs::Dir::open_ambient_dir(&parent, cap_std::ambient_authority())
        .map_err(|error| format!("無法開啟 metadata 匯出目錄：{error}"))?;
    let filename = std::ffi::OsString::from(filename);
    let saved_path = parent.join(&filename);
    tokio::task::spawn_blocking(move || {
        let mut file = directory
            .open_with(
                &filename,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .map_err(|error| format!("寫入 metadata 匯出檔失敗：{error}"))?;
        file.write_all(payload.as_bytes())
            .map_err(|error| format!("寫入 metadata 匯出檔失敗：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步 metadata 匯出檔失敗：{error}"))?;
        Ok(saved_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn preview_catalog_import(
    payload: String,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::CatalogImportPreview, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.preview_exchange_json(&payload))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn apply_catalog_import(
    request: catalog::CatalogImportRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::CatalogImportResult, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.apply_exchange(request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_photo_library_status(
    app_handle: AppHandle,
    request_authorization: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<photo_library::PhotoLibraryStatusView, String> {
    photo_library::status(&app_handle, state.inner(), request_authorization).await
}

#[tauri::command]
async fn set_linked_photo_albums(
    app_handle: AppHandle,
    album_ids: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<photo_library::PhotoMutationResult, String> {
    let result = photo_library::set_linked_albums(&app_handle, state.inner(), album_ids).await?;
    use tauri::Emitter;
    let _ = app_handle.emit("library-changed", ());
    Ok(result)
}

#[tauri::command]
fn set_photo_network_allowed(
    allowed: bool,
    state: State<'_, Arc<AppState>>,
) -> photo_library::PhotoNetworkPolicy {
    photo_library::set_network_allowed(state.inner(), allowed)
}

#[tauri::command]
async fn get_library(
    app_handle: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ComicItem>, String> {
    if let Err(error) = photo_library::refresh(&app_handle, state.inner()).await {
        // A transient PhotoKit failure must not hide local/NAS books. Keep
        // the virtual albums visible but unreadable until the next refresh.
        eprintln!("⚠️ 照片圖庫刷新失敗：{error}");
        photo_library::mark_unavailable(state.inner()).await;
    }
    let comics = state.comics.lock().await;
    let mut items = comics.clone();
    drop(comics);
    if let Ok(store) = catalog_store(&state) {
        let scan_dir = state.scan_dir.read().unwrap().clone();
        let external_bookmarks_readable = state
            .external_bookmarks_readable
            .load(std::sync::atomic::Ordering::Acquire);
        items = tokio::task::spawn_blocking(move || {
            let mut catalog_only_sources = BTreeSet::new();
            if !scan_dir.is_empty() && !Path::new(&scan_dir).exists() {
                catalog_only_sources.insert(scanner::local_source_id(Path::new(&scan_dir)));
            }
            store.overlay_library_with_options(
                items,
                &catalog_only_sources,
                !external_bookmarks_readable,
            )
        })
        .await
        .map_err(|error| error.to_string())??;
    }
    items.extend(photo_library::items(state.inner()).await);
    Ok(items.into_iter().map(normalize_runtime_item).collect())
}

#[tauri::command]
async fn get_scan_status(state: State<'_, Arc<AppState>>) -> Result<state::ScanProgress, String> {
    let progress = state.scan_progress.lock().await;
    Ok(progress.clone())
}

#[tauri::command]
async fn scan_visible_directory(
    app_handle: AppHandle,
    state: State<'_, Arc<AppState>>,
    relative_path: String,
    source_id: Option<String>,
) -> Result<(), String> {
    scanner::scan_visible_directory(state.inner().clone(), app_handle, relative_path, source_id)
        .await
}

#[tauri::command]
async fn scan_priority_library(
    app_handle: AppHandle,
    state: State<'_, Arc<AppState>>,
    favorite_ids: Vec<String>,
) -> Result<(), String> {
    scanner::scan_priority_library(state.inner().clone(), app_handle, favorite_ids).await
}

async fn optional_directory_source_revision(
    root: &cap_std::fs::Dir,
    relative: &Path,
) -> Option<state::SourceRevision> {
    let metadata_root = root.try_clone().ok()?;
    let metadata_relative = relative.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        metadata_root
            .metadata(&metadata_relative)
            .ok()
            .map(|metadata| state::SourceRevision::from_cap_metadata(&metadata))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn open_comic(
    id: String,
    source_id: Option<String>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if photo_library::is_photo_album_id(&id) {
        let item = photo_library::find_item(state.inner(), &id)
            .await
            .ok_or_else(|| "找不到照片相簿，請重新整理照片圖庫".to_string())?;
        let album_id = photo_library::album_id_from_photo_id(&id)
            .ok_or_else(|| "照片相簿識別碼無效".to_string())?;
        let assets = state
            .photo_albums
            .lock()
            .await
            .iter()
            .find(|album| album.id == album_id && album.available)
            .map(|album| album.asset_ids.clone())
            .ok_or_else(|| "照片相簿目前不可用".to_string())?;
        require_reader_pages(&assets)?;
        let reader_generation =
            begin_pending_open(state.inner(), &id, Some(item.source_id.clone()));
        let history_token = uuid::Uuid::new_v4().to_string();
        let _pending_open_guard = PendingOpenGuard::new(
            state.inner().clone(),
            id.clone(),
            Some(item.source_id.clone()),
            reader_generation,
        );
        let preload_generation = {
            let _lifecycle = state.comic_lifecycle.lock().unwrap();
            if !reader_generation_is_current(state.inner(), reader_generation) {
                return Err("開啟照片相簿已取消".into());
            }
            state
                .opened_comic_files
                .write()
                .unwrap()
                .insert(id.clone(), assets.clone());
            state.ram_cache_pool.lock().unwrap().clear();
            state.ram_cache_revisions.lock().unwrap().clear();
            state.opened_comic_revisions.write().unwrap().remove(&id);
            *state.active_comic_id.lock().unwrap() = Some(id.clone());
            *state.active_comic_source_id.lock().unwrap() = Some(item.source_id.clone());
            *state.active_reading_history_token.lock().unwrap() = Some(history_token.clone());
            *state.active_reading_history_comic.lock().unwrap() = Some(item.clone());
            *state.pending_open_id.lock().unwrap() = None;
            *state.pending_open_source_id.lock().unwrap() = None;
            state
                .preload_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1
        };
        let pages = (0..assets.len())
            .map(|index| reader_route_url("page", &id, index, &item.source_id))
            .collect::<Vec<_>>();
        return Ok(serde_json::json!({
            "id": id,
            "sourceId": item.source_id,
            "type": item.r#type,
            "title": item.title,
            "isDir": false,
            "pages": pages,
            "progress": item.progress,
            "preloadGeneration": preload_generation,
            "historyToken": history_token
        }));
    }
    let requested_source_id = parse_requested_source_id(source_id.as_deref())?;
    // Keep the legacy spelling long enough to permit a narrowly scoped
    // catalog fallback.  Once a configured root is captured, `local` is
    // normalized to its root-bound identity; arbitrary source IDs must never
    // receive this fallback.
    let requested_legacy_local = requested_source_id.as_deref() == Some("local");
    // Snapshot the root before looking up/cloning a legacy item.  Such items
    // carry no source identity, so binding them after a concurrent scan-root
    // switch could silently attach an old catalog row to the new root.
    let legacy_scan_dir = state.scan_dir.read().unwrap().clone();
    let requested_source_id = normalize_requested_source_id(requested_source_id, &legacy_scan_dir);
    // Publish the open intent before the first comics/catalog lookup. A scan
    // publication may hold `comics` for an O(N) merge; reader priority must
    // already be visible before this command can wait on that mutex.
    let reader_generation = begin_pending_open(state.inner(), &id, requested_source_id.clone());
    let mut pending_open_guard = PendingOpenGuard::new(
        state.inner().clone(),
        id.clone(),
        requested_source_id.clone(),
        reader_generation,
    );
    let state_item = {
        let comics = state.comics.lock().await;
        // ID-only opens remain fail-closed when multiple live locations exist;
        // an explicit source is resolved and bound below.
        let ambiguous = requested_source_id.as_deref().map_or_else(
            || runtime_id_has_multiple_locations(&comics, &id),
            |source| runtime_id_has_multiple_locations_for_source(&comics, &id, source),
        );
        if ambiguous {
            return Err("漫畫識別碼對應多個來源位置，請先提供唯一來源".into());
        }
        select_runtime_item_from_state(&comics, &id, requested_source_id.as_deref())
    };
    let comic_info = if state_item
        .as_ref()
        .is_some_and(|item| item.r#type == "offline")
        && requested_source_id.is_none()
    {
        let catalog_online = if let Ok(store) = catalog_store(&state) {
            let lookup_id = id.clone();
            let catalog_item = tokio::task::spawn_blocking(move || {
                unique_catalog_runtime_item(store.get_runtime_items_for_id(&lookup_id)?)
            })
            .await
            .map_err(|error| error.to_string())??;
            catalog_item.filter(|item| item.r#type != "offline")
        } else {
            None
        };
        prefer_online_catalog_item(state_item, catalog_online)
            .ok_or_else(|| "找不到漫畫資料，請重新掃描書庫".to_string())?
    } else if let Some(item) = state_item {
        item
    } else {
        let store = catalog_store(&state)?;
        let lookup_id = id.clone();
        let lookup_source_id = requested_source_id.clone();
        let allow_legacy_local_fallback = requested_legacy_local;
        tokio::task::spawn_blocking(move || {
            if let Some(source) = lookup_source_id.as_deref() {
                let scoped = store.get_runtime_items_for_source(&lookup_id, source)?;
                if !scoped.is_empty() || !allow_legacy_local_fallback {
                    return unique_catalog_runtime_item(scoped);
                }
                // Old catalog rows used the unscoped `local` marker.  Only a
                // caller that explicitly supplied that legacy spelling may
                // reach this query; the returned item is rebound to the
                // captured root below before any capability is opened.
                return unique_catalog_runtime_item(
                    store.get_runtime_items_for_source(&lookup_id, "local")?,
                );
            }
            unique_catalog_runtime_item(store.get_runtime_items_for_id(&lookup_id)?)
        })
        .await
        .map_err(|error| error.to_string())??
        .ok_or_else(|| "找不到漫畫資料，請重新掃描書庫".to_string())?
    };
    let comic_info = {
        protocol::bind_legacy_local_source(&comic_info, &legacy_scan_dir)
            .ok_or_else(|| "舊版本機漫畫缺少可綁定的目前掃描目錄".to_string())?
    };
    let comic_info = normalize_runtime_item(comic_info);
    if catalog::is_quarantine_relative_path(&comic_info.relative_path) {
        return Err("隔離區漫畫不可直接開啟，請先還原檔案操作".into());
    }
    if let Some(requested_source_id) = requested_source_id.as_deref() {
        if comic_info.source_id != requested_source_id {
            return Err("漫畫識別碼已綁定其他來源，拒絕切換來源開啟".into());
        }
    }
    let is_smb =
        state::is_smb_source_id(&comic_info.source_id) || comic_info.r#type == "smb-archive";
    let is_external =
        comic_info.source_id.starts_with("external:") || comic_info.r#type.starts_with("external-");
    if commerce::is_direct_smb(&comic_info.source_id, &comic_info.r#type) {
        commerce::require_pro(&app_handle).await?;
    }
    if !is_smb && !is_external && comic_info.r#type != "offline" {
        let scan_dir = state.scan_dir.read().unwrap().clone();
        if scan_dir.is_empty() || !protocol::local_source_matches_scan_dir(&comic_info, &scan_dir) {
            return Err("漫畫來源與目前的掃描目錄不符，請重新掃描書庫".into());
        }
    }
    {
        let mut comics = state.comics.lock().await;
        register_comic_capability(&mut comics, &comic_info);
    }
    let relative_path_str = comic_info.relative_path.clone();
    bind_pending_open_source(
        state.inner(),
        &id,
        reader_generation,
        comic_info.source_id.clone(),
    )?;
    pending_open_guard.source_id = Some(comic_info.source_id.clone());

    let full_path: PathBuf;
    let is_dir: bool;
    let mut opened_source_revision: Option<state::SourceRevision> = None;
    let mut opened_smb_content_hash: Option<[u8; 32]> = None;
    // Every local, external, offline and SMB open keeps the capability root
    // used for discovery alive through page enumeration.  Later protocol
    // reads independently reacquire the same root and remain descriptor based.
    let authorized_root: Option<cap_std::fs::Dir>;
    let authorized_relative: Option<PathBuf>;

    if is_smb {
        let relative = Path::new(&relative_path_str);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err("SMB 漫畫路徑不安全，已拒絕存取".into());
        }
        let smb_cfg = state.smb_config.read().unwrap().clone();
        if let Some(cfg) = smb_cfg {
            if !state::smb_source_matches_config(&comic_info.source_id, &cfg) {
                return Err("舊版或其他 NAS 來源未確認端點，已拒絕開啟".into());
            }
            use tauri::Emitter;
            let _ = app_handle.emit("smb-download-start", serde_json::json!({"id": id}));

            println!("🌐 準備下載 SMB 漫畫: {relative_path_str}");
            let temp_base = app_handle.path().app_local_data_dir().map_err(|error| {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                format!("無法建立 SMB 暫存目錄: {error}")
            })?;
            let temp_root = match open_smb_temp_root(&temp_base, &comic_info.source_id) {
                Ok(root) => root,
                Err(error) => {
                    let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                    return Err(error);
                }
            };
            let temp_dir =
                protocol::smb_cache_root_path(&temp_base.join("ComicTemp"), &comic_info.source_id);
            full_path = temp_dir.join(relative);
            if let Some(parent) = relative.parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(error) = temp_root.create_dir_all(parent) {
                        let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                        return Err(format!("無法建立 SMB 暫存目錄: {error}"));
                    }
                }
            }
            if !reader_generation_is_current(state.inner(), reader_generation) {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err("開啟漫畫已取消".into());
            }

            let addr = format!("{}:445", cfg.host);
            let username = cfg.username.unwrap_or_else(|| "guest".to_string());
            let password = cfg.password.unwrap_or_default();
            let mut client = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                smb2::connect(&addr, &username, &password),
            )
            .await
            .map_err(|_| {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                "SMB 連線逾時（10 秒），請檢查 NAS IP 或連線".to_string()
            })?
            .map_err(|error| {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                format!("SMB 連線錯誤: {error}")
            })?;
            if !reader_generation_is_current(state.inner(), reader_generation) {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err("開啟漫畫已取消".into());
            }
            let tree = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                client.connect_share(&cfg.share),
            )
            .await
            .map_err(|_| {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                format!("SMB Share '{}' 連線逾時（10 秒）", cfg.share)
            })?
            .map_err(|error| {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                format!("SMB Share 連線錯誤: {error}")
            })?;

            let smb_path = relative_path_str.replace('/', "\\");
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let partial_path = relative.with_file_name(format!(
                "{}.part-{}-{nonce}",
                relative
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("download"),
                std::process::id()
            ));
            let download_result: Result<[u8; 32], String> = async {
                use tokio::io::AsyncWriteExt;

                let mut download = tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    client.download(&tree, &smb_path),
                )
                .await
                .map_err(|_| "SMB_OPEN_TIMEOUT".to_string())?
                .map_err(|error| format!("SMB 讀取錯誤: {error:?}"))?;
                // CREATE supplies the size before any data chunk is received.
                let declared_bytes = download.size();
                let budget = smb_download_budget(
                    declared_bytes,
                    smb_available_space(temp_dir.clone()).await?,
                )?;
                let mut received = 0_u64;
                let mut hasher = blake3::Hasher::new();
                let mut next_space_check = SMB_SPACE_CHECK_INTERVAL_BYTES;
                let partial_file = temp_root
                    .open_with(
                        &partial_path,
                        cap_std::fs::OpenOptions::new().write(true).create_new(true),
                    )
                    .map_err(|error| format!("無法建立 SMB 暫存檔: {error}"))?;
                let mut file = tokio::fs::File::from_std(partial_file.into_std());
                loop {
                    if !reader_generation_is_current(state.inner(), reader_generation) {
                        return Err("開啟漫畫已取消".into());
                    }
                    let next = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        download.next_chunk(),
                    )
                    .await
                    .map_err(|_| "SMB 傳輸逾時（30 秒未收到資料）".to_string())?;
                    if !reader_generation_is_current(state.inner(), reader_generation) {
                        return Err("開啟漫畫已取消".into());
                    }
                    let Some(chunk) = next else { break };
                    let bytes = chunk.map_err(|error| format!("SMB 傳輸錯誤: {error:?}"))?;
                    let next_received =
                        checked_smb_download_size(received, bytes.len(), declared_bytes, budget)?;
                    hasher.update(&bytes);
                    if next_received >= next_space_check {
                        let available = smb_available_space(temp_dir.clone()).await?;
                        if available.saturating_sub(SMB_DISK_RESERVE_BYTES) < bytes.len() as u64 {
                            return Err("SMB_DOWNLOAD_NO_SPACE".into());
                        }
                        next_space_check =
                            next_received.saturating_add(SMB_SPACE_CHECK_INTERVAL_BYTES);
                    }
                    file.write_all(&bytes)
                        .await
                        .map_err(|error| format!("SMB 暫存檔寫入失敗: {error}"))?;
                    received = next_received;
                }
                if received != declared_bytes {
                    return Err("SMB_DOWNLOAD_INCOMPLETE".into());
                }
                file.sync_all()
                    .await
                    .map_err(|error| format!("SMB 暫存檔同步失敗: {error}"))?;
                drop(file);
                commit_smb_download_if_current(
                    state.inner(),
                    reader_generation,
                    &temp_root,
                    &partial_path,
                    relative,
                )?;
                Ok(*hasher.finalize().as_bytes())
            }
            .await;
            let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
            opened_smb_content_hash = match download_result {
                Ok(hash) => Some(hash),
                Err(error) => {
                    let _ = temp_root.remove_file(&partial_path);
                    return Err(error);
                }
            };
            println!("✅ SMB 下載完成");
            authorized_root = Some(temp_root);
            authorized_relative = Some(relative.to_path_buf());
            is_dir = false;
        } else {
            return Err("未設定 SMB 連線".into());
        }
    } else if is_external || comic_info.r#type == "offline" {
        full_path = comic_info
            .source_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| "漫畫來源位置已遺失，請重新加入或重新掃描書庫".to_string())?;
        if is_external {
            #[cfg(target_os = "ios")]
            {
                use tauri_plugin_ios_folder::{EnsureAvailableRequest, TauriPluginIosFolderExt};

                let bookmark = comic_info
                    .external_bookmark
                    .as_ref()
                    .ok_or_else(|| "外部漫畫缺少資料夾權限關聯，請重新掃描書庫".to_string())?;
                let active_root = state
                    .active_bookmarks
                    .lock()
                    .unwrap()
                    .get(bookmark)
                    .cloned()
                    .ok_or_else(|| "外部資料夾權限尚未啟用，請重新加入資料夾".to_string())?;
                let root_path = Path::new(&active_root);
                if !full_path.starts_with(root_path) {
                    return Err("外部漫畫不屬於原先授權的資料夾".into());
                }
                let ensure_handle = app_handle.clone();
                let request = EnsureAvailableRequest {
                    bookmark: bookmark.clone(),
                    path: full_path.to_string_lossy().into_owned(),
                };
                tauri::async_runtime::spawn_blocking(move || {
                    ensure_handle
                        .tauri_plugin_ios_folder()
                        .ensure_available(request)
                })
                .await
                .map_err(|error| format!("檢查漫畫檔案時發生錯誤：{error}"))?
                .map_err(|error| format!("外部漫畫尚未下載完成或無法讀取：{error}"))?;
            }
            let (root, relative) =
                protocol::external_bookmark_capability(&comic_info, &full_path, state.inner())
                    .map_err(|_| {
                        "外部資料夾權限尚未啟用或漫畫已超出授權範圍，請重新加入資料夾".to_string()
                    })?;
            if !root.try_exists(&relative).unwrap_or(false) {
                return Err(format!(
                    "漫畫來源目前離線：{}。請重新連線原本的磁碟，或在設定中選擇新的漫畫目錄後重新掃描。",
                    full_path.display()
                ));
            }
            is_dir = root.is_dir(&relative);
            authorized_root = Some(root);
            authorized_relative = Some(relative);
        } else {
            // Offline entries without a bookmark are valid only while their
            // original source still belongs to the current local scan root.
            let scan_dir = state.scan_dir.read().unwrap().clone();
            if scan_dir.is_empty() {
                return Err("離線漫畫不屬於目前的掃描目錄，請重新加入或重新掃描書庫".into());
            }
            let root = cap_std::fs::Dir::open_ambient_dir(&scan_dir, cap_std::ambient_authority())
                .map_err(|_| "目前掃描目錄無法開啟，請重新加入漫畫目錄".to_string())?;
            let relative = full_path.strip_prefix(Path::new(&scan_dir)).map_err(|_| {
                "離線漫畫不屬於目前的掃描目錄，請重新加入或重新掃描書庫".to_string()
            })?;
            if relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            }) || !root.try_exists(relative).unwrap_or(false)
            {
                return Err("離線漫畫不屬於目前的掃描目錄，請重新加入或重新掃描書庫".into());
            }
            is_dir = root.is_dir(relative);
            authorized_root = Some(root);
            authorized_relative = Some(relative.to_path_buf());
        }
    } else {
        let scan_dir = state.scan_dir.read().unwrap().clone();
        if scan_dir.is_empty() {
            return Err("漫畫目錄尚未設定".into());
        }
        if !protocol::local_source_matches_scan_dir(&comic_info, &scan_dir) {
            return Err("漫畫來源與目前的掃描目錄不符，請重新掃描書庫".into());
        }
        let root = cap_std::fs::Dir::open_ambient_dir(&scan_dir, cap_std::ambient_authority())
            .map_err(|error| format!("掃描目錄無法開啟: {error}"))?;
        let relative = PathBuf::from(&relative_path_str);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
            || !root.try_exists(&relative).unwrap_or(false)
        {
            return Err("找不到漫畫或路徑越權！".into());
        }
        full_path = Path::new(&scan_dir).join(&relative);
        is_dir = root.is_dir(&relative);
        authorized_root = Some(root);
        authorized_relative = Some(relative);
    }

    let mut pages = Vec::new();
    let opened_files = if is_dir {
        let root = authorized_root
            .as_ref()
            .ok_or_else(|| "漫畫缺少授權目錄".to_string())?;
        let relative = authorized_relative
            .as_deref()
            .ok_or_else(|| "漫畫缺少授權路徑".to_string())?;
        opened_source_revision = optional_directory_source_revision(root, relative).await;
        let folder = root
            .open_dir(relative)
            .map_err(|error| format!("無法開啟漫畫資料夾: {error}"))?;
        let image_names = crate::utils::get_folder_image_names_from_dir(&folder);
        let mut cached_files = Vec::new();
        for (index, name) in image_names.iter().enumerate() {
            pages.push(reader_route_url(
                "folder",
                &id,
                index,
                &comic_info.source_id,
            ));
            cached_files.push(full_path.join(name).to_string_lossy().to_string());
        }
        cached_files
    } else if comic_info.r#type.contains("image") {
        let root = authorized_root
            .as_ref()
            .ok_or_else(|| "漫畫缺少授權目錄".to_string())?;
        let relative = authorized_relative
            .as_deref()
            .ok_or_else(|| "漫畫缺少授權路徑".to_string())?;
        root.open(relative)
            .map_err(|error| format!("無法開啟漫畫圖片: {error}"))?;
        pages.push(reader_route_url("page", &id, 0, &comic_info.source_id));
        vec![full_path.to_string_lossy().into_owned()]
    } else {
        let root = authorized_root
            .as_ref()
            .ok_or_else(|| "漫畫缺少授權目錄".to_string())?;
        let relative = authorized_relative
            .as_deref()
            .ok_or_else(|| "漫畫缺少授權路徑".to_string())?;
        let archive_file = root
            .open(relative)
            .map_err(|error| format!("無法開啟漫畫封存檔: {error}"))?;
        opened_source_revision = Some(state::SourceRevision::from_cap_metadata(
            &archive_file
                .metadata()
                .map_err(|error| format!("無法讀取漫畫封存檔 metadata: {error}"))?,
        ));
        let archive_file = archive_file.into_std();
        let archive_path = full_path.clone();
        let entry_names = tauri::async_runtime::spawn_blocking(move || {
            crate::utils::get_archive_images_from_file(&archive_path, archive_file)
        })
        .await
        .map_err(|error| format!("讀取漫畫封存檔的背景工作失敗：{error}"))?
        .map_err(|error| error.to_string())?;
        for index in 0..entry_names.len() {
            pages.push(reader_route_url("page", &id, index, &comic_info.source_id));
        }
        entry_names
    };

    // Reject an empty folder/archive before committing active reader state.
    // The frontend also validates pages, but native must not leave an active
    // reader behind when that validation raises after open_comic returns.
    require_reader_pages(&opened_files)?;

    let title = comic_info.title.clone();
    let r#type = comic_info.r#type.clone();
    let verified_page_count = opened_files.len();
    let history_token = uuid::Uuid::new_v4().to_string();

    let progress_identity = format!("{}\0{}", comic_info.source_id, id);
    let progress_state = state.inner().clone();
    let progress_comic = comic_info.clone();
    let (preload_generation, recovery_token, progress) = with_comic_progress_lifecycle_prepared(
        state.inner(),
        &progress_identity,
        || async move {
            open_comic_progress_snapshot(
                &progress_state,
                &progress_comic,
                verified_page_count,
                is_dir,
            )
            .await
        },
        |progress| {
            if !reader_generation_is_current(state.inner(), reader_generation) {
                return Err(String::from("開啟漫畫已取消"));
            }
            let recovery_token = state
                .inner()
                .remember_progress_recovery_evidence_with_smb_hash(
                    &id,
                    &comic_info.source_id,
                    &comic_info.relative_path,
                    verified_page_count,
                    reader_generation,
                    opened_source_revision.clone(),
                    opened_smb_content_hash,
                );
            // A directory's metadata does not prove that its enumerated page
            // set stayed unchanged, so only archive files receive cold proofs.
            let recovery_token = if !is_dir {
                recovery_token.and_then(|token| {
                    let revision = opened_source_revision.as_ref()?;
                    let store = state.inner().catalog.read().ok()?.clone()?;
                    store
                        .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                            identifier: &id,
                            source_id: &comic_info.source_id,
                            relative_path: &comic_info.relative_path,
                            token: &token,
                            total_pages: verified_page_count,
                            revision,
                            smb_content_hash: opened_smb_content_hash,
                        })
                        .ok()?;
                    Some(token)
                })
            } else {
                None
            };
            state
                .opened_comic_files
                .write()
                .unwrap()
                .insert(id.clone(), opened_files);
            state.ram_cache_pool.lock().unwrap().clear();
            state.ram_cache_revisions.lock().unwrap().clear();
            let mut revisions = state.opened_comic_revisions.write().unwrap();
            revisions.remove(&id);
            if let Some(revision) = opened_source_revision.as_ref() {
                revisions.insert(id.clone(), revision.clone());
            }
            *state.active_comic_id.lock().unwrap() = Some(id.clone());
            *state.active_comic_source_id.lock().unwrap() = Some(comic_info.source_id.clone());
            *state.active_reading_history_token.lock().unwrap() = Some(history_token.clone());
            *state.active_reading_history_comic.lock().unwrap() = Some(comic_info.clone());
            *state.pending_open_id.lock().unwrap() = None;
            *state.pending_open_source_id.lock().unwrap() = None;
            let preload_generation = state
                .preload_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            Ok((preload_generation, recovery_token, progress))
        },
    )
    .await?;
    let state_clone = state.inner().clone();
    let id_clone = id.clone();
    let source_id_clone = comic_info.source_id.clone();
    let handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        crate::cache::preload_comic(
            state_clone,
            handle_clone,
            id_clone,
            source_id_clone,
            preload_generation,
        )
        .await;
    });

    let floor_state = state.inner().clone();
    let floor_id = id.clone();
    let floor_source_id = comic_info.source_id.clone();
    let floor_relative_path = comic_info.relative_path.clone();
    let sequence_floor = tokio::task::spawn_blocking(move || {
        floor_state
            .catalog
            .read()
            .ok()
            .and_then(|store| store.clone())
            .and_then(|store| {
                store
                    .progress_intent_floor(&floor_id, &floor_source_id, &floor_relative_path)
                    .ok()
            })
    })
    .await
    .map_err(|error| format!("讀取閱讀意圖序號底線背景工作失敗：{error}"))?
    .unwrap_or(0);
    Ok(serde_json::json!({
        "id": id,
        "sourceId": comic_info.source_id,
        "relativePath": comic_info.relative_path,
        "type": r#type,
        "title": title,
        "isDir": is_dir,
        "pages": pages,
        "progress": progress,
        "recoveryToken": recovery_token,
        "historyToken": history_token,
        "sequenceFloor": sequence_floor,
        "preloadGeneration": preload_generation
    }))
}

#[tauri::command]
async fn record_reading_history(
    id: String,
    source_id: String,
    request_token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if request_token.is_empty() || request_token.len() > 64 {
        return Err("閱讀紀錄開書 token 無效".into());
    }
    let (opened_page_count, item, opened_at) = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let active_id = state.active_comic_id.lock().unwrap();
        let active_source = state.active_comic_source_id.lock().unwrap();
        let active_token = state.active_reading_history_token.lock().unwrap();
        let active_comic = state.active_reading_history_comic.lock().unwrap();
        if !reading_history_session_matches(
            active_id.as_deref(),
            active_source.as_deref(),
            active_token.as_deref(),
            Some(id.as_str()),
            Some(source_id.as_str()),
            Some(request_token.as_str()),
        ) {
            return Err("閱讀紀錄開書 session 已過期".into());
        }
        let opened = state.opened_comic_files.read().unwrap();
        let page_count = opened
            .get(&id)
            .map(Vec::len)
            .filter(|count| *count > 0)
            .ok_or_else(|| "漫畫尚未成功開啟".to_string())?;
        let item = active_comic
            .as_ref()
            .filter(|comic| comic.id == id && comic.source_id == source_id)
            .cloned()
            .ok_or_else(|| "已開啟漫畫快照已過期".to_string())?;
        let opened_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        (page_count, item, opened_at)
    };

    // The opened session supplies the trusted source identity and item snapshot;
    // the catalog lookup only refreshes progress and never touches source files.
    if item.source_id != source_id {
        return Err("閱讀紀錄來源與已開啟漫畫不符".into());
    }
    let mut progress = item.progress.clone();
    if !photo_library::is_photo_album_id(&id) {
        if let Ok(store) = catalog_store(&state) {
            let lookup_id = id.clone();
            let lookup_source = source_id.clone();
            let lookup_path = item.relative_path.clone();
            if let Ok(Ok(Some(current))) = tauri::async_runtime::spawn_blocking(move || {
                store.get_runtime_item_for_source_path(&lookup_id, &lookup_source, &lookup_path)
            })
            .await
            {
                progress = current.progress;
            }
        }
    }
    let snapshot = catalog::ReadingHistoryComic {
        id: item.id,
        source_id: item.source_id,
        relative_path: item.relative_path,
        title: item.title,
        page_count: opened_page_count,
        progress,
        offline: item.r#type == "offline",
    };
    let store = catalog_store(&state)?;
    let session_key = request_token;
    tauri::async_runtime::spawn_blocking(move || {
        store
            .record_reading_history(&session_key, &snapshot, &opened_at)
            .map(|_| ())
    })
    .await
    .map_err(|error| format!("寫入閱讀紀錄背景工作失敗：{error}"))?
}

fn reading_history_session_matches(
    active_id: Option<&str>,
    active_source_id: Option<&str>,
    active_token: Option<&str>,
    requested_id: Option<&str>,
    requested_source_id: Option<&str>,
    requested_token: Option<&str>,
) -> bool {
    active_id.is_some()
        && active_id == requested_id
        && active_source_id == requested_source_id
        && active_token.is_some()
        && active_token == requested_token
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingHistoryQuery {
    period: String,
    offset: usize,
    limit: usize,
    time_zone_offset_minutes: i32,
}

#[cfg(any(target_os = "ios", test))]
type IosDocumentsHistoryContext = (PathBuf, String);

#[cfg(any(target_os = "ios", test))]
fn ios_history_documents_context(
    native_documents: Option<&Path>,
    configured_dir: &str,
) -> (
    Option<IosDocumentsHistoryContext>,
    Option<IosDocumentsHistoryContext>,
) {
    let Some(native_documents) = native_documents
        .filter(|documents| ios_documents::current_documents_source_id(documents).is_some())
    else {
        return (None, None);
    };
    let configured_documents = Path::new(configured_dir);
    if !configured_dir.is_empty()
        && ios_documents::same_documents_root(native_documents, configured_documents)
    {
        if let Some(source_id) = ios_documents::current_documents_source_id(configured_documents) {
            let context = (configured_documents.to_path_buf(), source_id);
            return (Some(context.clone()), Some(context));
        }
    }
    let Some(source_id) = ios_documents::current_documents_source_id(native_documents) else {
        return (None, None);
    };
    (Some((native_documents.to_path_buf(), source_id)), None)
}

#[tauri::command]
async fn get_reading_history(
    query: ReadingHistoryQuery,
    state: State<'_, Arc<AppState>>,
    _app_handle: AppHandle,
) -> Result<catalog::ReadingHistoryPage, String> {
    let store = catalog_store(&state)?;
    #[cfg(target_os = "ios")]
    let (documents_for_query, hydration_context) = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        let native_documents = _app_handle.path().document_dir().ok();
        let configured_dir = state.scan_dir.read().unwrap().clone();
        let (query_context, hydration_context) =
            ios_history_documents_context(native_documents.as_deref(), &configured_dir);
        let hydration = hydration_context.map(|(documents, source_id)| {
            (
                documents,
                source_id,
                configured_dir,
                state
                    .scan_generation
                    .load(std::sync::atomic::Ordering::Acquire),
            )
        });
        (query_context, hydration)
    };
    #[cfg(target_os = "ios")]
    let documents_for_query = documents_for_query.clone();
    #[cfg(target_os = "ios")]
    let hydration_store = store.clone();
    let mut page = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "ios")]
        if let Some((documents, _)) = documents_for_query {
            return store.get_reading_history_for_ios_documents(
                &query.period,
                query.offset,
                query.limit,
                query.time_zone_offset_minutes,
                &documents,
            );
        }
        store.get_reading_history(
            &query.period,
            query.offset,
            query.limit,
            query.time_zone_offset_minutes,
        )
    })
    .await
    .map_err(|error| format!("查詢閱讀紀錄背景工作失敗：{error}"))??;
    let current_photos = if page
        .items
        .iter()
        .any(|history| history.comic.source_id == "photos:")
    {
        Some(photo_library::items(state.inner()).await)
    } else {
        None
    };
    for history in &mut page.items {
        if history.comic.source_id == "photos:" {
            let current = current_photos
                .as_ref()
                .and_then(|items| items.iter().find(|item| item.id == history.comic.id));
            refresh_photo_history_item(&mut history.comic, current);
        }
    }
    #[cfg(target_os = "ios")]
    if let Some((documents, current_source_id, configured_dir, generation)) = hydration_context {
        let eligible_paths = page
            .items
            .iter()
            .filter(|history| {
                history.comic.offline
                    && (history.comic.source_id == current_source_id
                        || ios_documents::is_previous_documents_source_id(
                            &history.comic.source_id,
                            &documents,
                        ))
            })
            .map(|history| history.comic.relative_path.clone())
            .collect::<std::collections::BTreeSet<_>>();
        if !eligible_paths.is_empty() {
            let current_items = {
                let _scan_lifecycle = state.scan_lifecycle.lock().await;
                if !ios_documents_hydration_snapshot_is_current(
                    &configured_dir,
                    generation,
                    &state.scan_dir.read().unwrap(),
                    state
                        .scan_generation
                        .load(std::sync::atomic::Ordering::Acquire),
                ) {
                    Vec::new()
                } else {
                    let comics = state.comics.lock().await;
                    comics
                        .iter()
                        .filter(|item| {
                            item.source_id == current_source_id
                                && item.r#type != "offline"
                                && eligible_paths.contains(&item.relative_path)
                        })
                        .cloned()
                        .collect::<Vec<_>>()
                }
            };
            if !current_items.is_empty() {
                let original_page = page.clone();
                let hydrated_page = tauri::async_runtime::spawn_blocking(move || {
                    let mut current_items = hydration_store
                        .overlay_library_with_options(
                            current_items.clone(),
                            &BTreeSet::new(),
                            false,
                        )
                        .unwrap_or(current_items);
                    current_items = current_items
                        .into_iter()
                        .map(normalize_runtime_item)
                        .collect();
                    let Ok(root) = cap_std::fs::Dir::open_ambient_dir(
                        &documents,
                        cap_std::ambient_authority(),
                    ) else {
                        return page;
                    };
                    for history in &mut page.items {
                        refresh_ios_documents_history_item(
                            &mut history.comic,
                            &current_items,
                            &documents,
                            &current_source_id,
                            &current_source_id,
                            &root,
                        );
                    }
                    page
                })
                .await
                .map_err(|error| format!("驗證本機閱讀紀錄位置背景工作失敗：{error}"))?;
                let _scan_lifecycle = state.scan_lifecycle.lock().await;
                page = if ios_documents_hydration_snapshot_is_current(
                    &configured_dir,
                    generation,
                    &state.scan_dir.read().unwrap(),
                    state
                        .scan_generation
                        .load(std::sync::atomic::Ordering::Acquire),
                ) {
                    hydrated_page
                } else {
                    original_page
                };
            }
        }
    }
    Ok(page)
}

fn refresh_photo_history_item(
    history: &mut catalog::ReadingHistoryComic,
    current: Option<&ComicItem>,
) {
    let Some(current) =
        current.filter(|item| item.id == history.id && item.source_id == history.source_id)
    else {
        history.offline = true;
        return;
    };
    history.title = current.title.clone();
    history.progress = current.progress.clone();
    if current.page_count > 0 {
        history.page_count = current.page_count;
        history.offline = false;
    } else {
        history.offline = true;
    }
}

#[cfg(any(target_os = "ios", test))]
fn refresh_ios_documents_history_item(
    history: &mut catalog::ReadingHistoryComic,
    current_items: &[ComicItem],
    documents: &Path,
    current_source_id: &str,
    configured_source_id: &str,
    root: &cap_std::fs::Dir,
) {
    if !history.offline
        || current_source_id != configured_source_id
        || ios_documents::current_documents_source_id(documents).as_deref()
            != Some(current_source_id)
    {
        return;
    }
    if history.source_id != current_source_id
        && !ios_documents::is_previous_documents_source_id(&history.source_id, documents)
    {
        return;
    }
    let Some(relative) = safe_ios_history_relative_path(&history.relative_path) else {
        return;
    };
    let Some(current) = current_items.iter().find(|item| {
        item.source_id == current_source_id
            && item.relative_path == history.relative_path
            && matches!(item.r#type.as_str(), "archive" | "folder" | "image")
            && item.external_bookmark.is_none()
    }) else {
        return;
    };
    let Ok(metadata) = protocol::symlink_metadata_from_capability(root, &relative) else {
        return;
    };
    let expected_kind_matches = if current.r#type == "folder" {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    if !expected_kind_matches {
        return;
    }

    history.id = current.id.clone();
    history.source_id = current_source_id.to_string();
    history.title.clone_from(&current.title);
    let progress = if current_history_progress_is_newer(&current.progress, &history.progress) {
        current.progress.clone()
    } else {
        history.progress.clone()
    };
    history.page_count = if current.page_count > 0 {
        current.page_count
    } else if progress.total_pages > 0 {
        progress.total_pages
    } else {
        history.page_count
    };
    history.progress = progress;
    history.offline = false;
}

#[cfg(any(target_os = "ios", test))]
fn ios_documents_hydration_snapshot_is_current(
    expected_root: &str,
    expected_generation: u64,
    current_root: &str,
    current_generation: u64,
) -> bool {
    expected_root == current_root && expected_generation == current_generation
}

#[cfg(any(target_os = "ios", test))]
fn safe_ios_history_relative_path(relative_path: &str) -> Option<PathBuf> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative_path.contains('\\')
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(relative.to_path_buf())
}

#[cfg(any(target_os = "ios", test))]
fn valid_history_progress(progress: &Progress) -> bool {
    progress.total_pages > 0
        && progress.current_page <= progress.total_pages
        && progress.percent.is_finite()
        && (0.0..=100.0).contains(&progress.percent)
}

#[cfg(any(target_os = "ios", test))]
fn current_history_progress_is_newer(current: &Progress, snapshot: &Progress) -> bool {
    if !valid_history_progress(current) {
        return false;
    }
    if !valid_history_progress(snapshot) {
        return true;
    }
    match (
        current
            .updated_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok()),
        snapshot
            .updated_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok()),
    ) {
        (Some(current), Some(snapshot)) => current >= snapshot,
        (Some(_), None) => true,
        _ => false,
    }
}

#[tauri::command]
async fn open_folder_dialog(_app: tauri::AppHandle) -> Result<String, String> {
    Ok(String::new())
}

#[tauri::command]
async fn close_comic(
    comic_id: Option<String>,
    source_id: Option<String>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(ref id) = comic_id {
        let requested_source_id = source_id
            .as_deref()
            .map(str::trim)
            .filter(|source| !source.is_empty())
            .map(str::to_owned);
        if source_id.is_some() && requested_source_id.is_none() {
            return Err("關閉漫畫來源識別碼格式不正確".into());
        }
        // Capture the root and normalize legacy `local` while the reader
        // lifecycle is held. A concurrent source transition must not bind an
        // old close request to whichever root happens to be current later.
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let scan_dir = state.scan_dir.read().unwrap().clone();
        let requested_source_id = normalize_requested_source_id(requested_source_id, &scan_dir);
        let mut active_id = state.active_comic_id.lock().unwrap();
        let mut active_source_id = state.active_comic_source_id.lock().unwrap();
        let mut pending_open_id = state.pending_open_id.lock().unwrap();
        let mut pending_source_id = state.pending_open_source_id.lock().unwrap();
        if !close_request_matches_reader(
            id,
            requested_source_id.as_deref(),
            active_id.as_deref(),
            active_source_id.as_deref(),
            pending_open_id.as_deref(),
            pending_source_id.as_deref(),
        ) {
            return Ok(());
        }
        state
            .reader_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        state
            .preload_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let cleanup_source_id = cleanup_source_id_for_close(
            id,
            requested_source_id.as_deref(),
            active_id.as_deref(),
            active_source_id.as_deref(),
            pending_open_id.as_deref(),
            pending_source_id.as_deref(),
        )
        .unwrap_or_default();
        // A matching close ends the single reader session. This also drops a
        // superseded pending open so an old same-ID worker cannot republish.
        *active_id = None;
        *active_source_id = None;
        *state.active_reading_history_token.lock().unwrap() = None;
        *state.active_reading_history_comic.lock().unwrap() = None;
        *pending_open_id = None;
        *pending_source_id = None;
        state.ram_cache_pool.lock().unwrap().remove(id);
        state.ram_cache_revisions.lock().unwrap().remove(id);
        state.opened_comic_files.write().unwrap().remove(id);
        state.opened_comic_revisions.write().unwrap().remove(id);
        if state::is_smb_source_id(&cleanup_source_id) {
            if let Ok(relative_text) = protocol::decode_capability_path(id) {
                let relative = Path::new(&relative_text);
                if relative.is_absolute()
                    || relative.components().any(|part| {
                        matches!(
                            part,
                            std::path::Component::ParentDir
                                | std::path::Component::RootDir
                                | std::path::Component::Prefix(_)
                        )
                    })
                {
                    return Err("拒絕清除不安全的 SMB 暫存路徑".into());
                }
                let cleanup = app_handle
                    .path()
                    .app_local_data_dir()
                    .map_err(|error| error.to_string())
                    .and_then(|temp_base| {
                        remove_smb_temp_entry(&temp_base, &cleanup_source_id, relative)
                    });
                if let Err(error) = cleanup {
                    // Closing the reader remains successful when best-effort
                    // cache cleanup fails, but leave a diagnostic for recovery.
                    eprintln!("SMB cache cleanup failed: {error}");
                }
            }
        }
    } else {
        let temp_base = app_handle.path().app_local_data_dir().ok();
        let retired_temp_dir = {
            let _lifecycle = state.comic_lifecycle.lock().unwrap();
            state
                .reader_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            state
                .preload_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *state.active_comic_id.lock().unwrap() = None;
            *state.active_comic_source_id.lock().unwrap() = None;
            *state.active_reading_history_token.lock().unwrap() = None;
            *state.active_reading_history_comic.lock().unwrap() = None;
            *state.pending_open_id.lock().unwrap() = None;
            *state.pending_open_source_id.lock().unwrap() = None;
            state.ram_cache_pool.lock().unwrap().clear();
            state.ram_cache_revisions.lock().unwrap().clear();
            state.opened_comic_files.write().unwrap().clear();
            state.opened_comic_revisions.write().unwrap().clear();
            temp_base.as_deref().and_then(retire_smb_temp_namespace)
        };
        if let Some(retired_temp_dir) = retired_temp_dir {
            cleanup_retired_smb_temp_namespace(retired_temp_dir);
        }
    }

    Ok(())
}

#[tauri::command]
async fn update_reader_cache_window(
    comic_id: String,
    page_index: usize,
    source_id: Option<String>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<u64, String> {
    let active_source_id = state
        .active_reader_source(&comic_id)
        .ok_or_else(|| "漫畫目前不是閱讀中的漫畫".to_string())?;
    let requested_source_id = source_id
        .as_deref()
        .map(str::trim)
        .filter(|source| !source.is_empty());
    if source_id.is_some() && requested_source_id.is_none() {
        return Err("閱讀快取來源識別碼格式不正確".into());
    }
    let scan_dir = state.scan_dir.read().unwrap().clone();
    let requested_source_id = requested_source_id
        .map(str::to_owned)
        .and_then(|source| normalize_requested_source_id(Some(source), &scan_dir));
    if requested_source_id.as_deref() != Some(active_source_id.as_str()) && source_id.is_some() {
        return Err("閱讀快取來源已不是目前開啟的漫畫".into());
    }
    let total_pages = {
        let opened = state.opened_comic_files.read().unwrap();
        opened.get(&comic_id).map(Vec::len).unwrap_or(0)
    };
    if total_pages > 0 && page_index >= total_pages {
        return Err("頁碼超出漫畫範圍".into());
    }

    {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        if !state.active_reader_matches_locked(&comic_id, &active_source_id) {
            return Err("漫畫目前不是閱讀中的漫畫".into());
        }
    }

    // A complete cache for the same opened archive revision needs no new
    // preload worker. Protocol requests still verify the live FD revision,
    // so an atomic replacement cannot turn this fast path into stale bytes.
    if crate::cache::whole_book_cache_matches_index(state.inner(), &comic_id, &active_source_id) {
        return Ok(state
            .preload_generation
            .load(std::sync::atomic::Ordering::Acquire));
    }

    let generation = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        if !state.active_reader_matches_locked(&comic_id, &active_source_id) {
            return Err("漫畫目前不是閱讀中的漫畫".into());
        }

        state
            .preload_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    };

    let state_clone = state.inner().clone();
    let id_clone = comic_id.clone();
    tauri::async_runtime::spawn(async move {
        crate::cache::preload_comic_window(
            state_clone,
            app_handle,
            id_clone,
            active_source_id,
            page_index,
            generation,
        )
        .await;
    });

    Ok(generation)
}

#[tauri::command]
async fn get_config(
    state: State<'_, Arc<AppState>>,
    app_handle: AppHandle,
) -> Result<serde_json::Value, String> {
    let dir = state.scan_dir.read().unwrap();
    let available = dir.is_empty() || Path::new(dir.as_str()).exists();
    #[cfg(target_os = "ios")]
    let is_local_library = app_handle
        .path()
        .document_dir()
        .ok()
        .is_some_and(|documents| Path::new(dir.as_str()) == documents);
    #[cfg(not(target_os = "ios"))]
    let is_local_library = {
        let _ = app_handle;
        false
    };
    Ok(
        serde_json::json!({ "scanDir": dir.clone(), "available": available, "isLocalLibrary": is_local_library }),
    )
}

#[tauri::command]
fn get_memory_status(state: State<'_, Arc<AppState>>) -> serde_json::Value {
    let budget = state.refresh_cache_budget();
    serde_json::json!({
        "pressure": state.memory_pressure_level().as_str(),
        "cacheBudgetBytes": budget,
        "cacheCeilingBytes": crate::state::MAX_COMPRESSED_PAGE_CACHE_BYTES,
    })
}

#[tauri::command]
async fn set_config(
    data: serde_json::Value,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let scan_dir = data
        .get("scanDir")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "設定缺少 scanDir 字串".to_string())?;
    let scan_dir = validate_scan_directory(scan_dir)?;
    #[cfg(target_os = "ios")]
    let scan_dir = relocate_ios_documents(
        &scan_dir,
        &app_handle
            .path()
            .document_dir()
            .map_err(|error| error.to_string())?,
    );
    let _source_authorization = state.source_authorization_lifecycle.write().await;
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    let current_scan_dir = state.scan_dir.read().unwrap().clone();
    if current_scan_dir == scan_dir {
        return Ok(serde_json::json!({ "success": true, "changed": false, "scanDir": scan_dir }));
    }

    let settings_handle = app_handle.clone();
    let saved_scan_dir = scan_dir.clone();
    tokio::task::spawn_blocking(move || persist_scan_directory(&settings_handle, &saved_scan_dir))
        .await
        .map_err(|error| format!("漫畫目錄設定工作失敗：{error}"))??;

    state
        .source_authorization_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    *state.scan_dir.write().unwrap() = scan_dir.clone();
    state.comics.lock().await.clear();
    state.invalidate_reader_cache();
    let generation = state
        .scan_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    state.scan_progress.lock().await.generation = generation;

    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        crate::scanner::start_background_scan(state_clone, app_handle).await;
    });
    Ok(serde_json::json!({ "success": true, "changed": true, "scanDir": scan_dir }))
}

#[tauri::command]
async fn set_smb_config(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    data: Option<crate::state::SmbConfig>,
) -> Result<serde_json::Value, String> {
    if data.is_some() {
        commerce::require_pro(&app_handle).await?;
    }
    let data = validate_smb_config(data)?;
    let _source_authorization = state.source_authorization_lifecycle.write().await;
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    state
        .source_authorization_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    *state.smb_config.write().unwrap() = data;
    state.comics.lock().await.clear();
    state.invalidate_reader_cache();
    let generation = state
        .scan_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    state.scan_progress.lock().await.generation = generation;

    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        crate::scanner::start_background_scan(state_clone, app_handle).await;
    });

    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn get_online_services_config(
    state: State<'_, Arc<AppState>>,
) -> Result<crate::state::OnlineServicesConfig, String> {
    Ok(state.online_services.read().unwrap().clone())
}

#[tauri::command]
async fn set_online_services_config(
    data: crate::state::OnlineServicesConfig,
    state: State<'_, Arc<AppState>>,
) -> Result<crate::state::OnlineServicesConfig, String> {
    let data = data.validate()?;
    *state.online_services.write().unwrap() = data.clone();
    Ok(data)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionRequest {
    provider: String,
    api_key: String,
    google_content_disclosure: bool,
    #[serde(default)]
    remember_key: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionRestoreRequest {
    provider: String,
    google_content_disclosure: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionStatus {
    configured: bool,
    provider: Option<String>,
    model: Option<String>,
    remembered: bool,
    remembered_provider: Option<String>,
    remembered_lookup_failed: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplainPageRequest {
    data_url: String,
    #[serde(default = "default_explain_page_locale")]
    target_locale: String,
}

fn default_explain_page_locale() -> String {
    "zh-Hant".to_string()
}

/// Explain written dialogue and narration without adding visual commentary.
fn explain_page_prompt(target_locale: &str) -> Result<&'static str, String> {
    match target_locale {
        "zh-Hant" => Ok(
            "請只針對本頁圖片中的「文字部分」（對白與敘事），依漫畫閱讀順序按各個對話或敘事段落提煉主要意思，以繁體中文（台灣）分短段呈現。請確保每個主要文字段落的重點都有交代，避免將整頁濃縮成單一句話而遺漏情節。讀者自己看得到畫面，不要額外描述圖像的背景、動作、外觀或構圖；若對白或敘事文字本身提到這些內容，仍要轉述其意思。可合併重複與贅詞、不需逐字翻譯，但必須保留文字中的重要數字、條件、限制、角色立場與語氣，不可虛構人物關係或因果；角色名稱可保留原名，無關的裝飾文字可略過。不設固定字數限制，僅輸出純文字短段，不附原文、不加清單編號、不使用任何 Markdown 格式。文字模糊處請簡短標記「[看不清楚]」，切勿杜撰；若本頁無文字可處理，請簡短說明「本頁無可翻譯文字」。\n輸出全文只能使用繁體中文（台灣用語）；除了角色姓名或作品專有名詞，不得留下日文原句。請特別核對誰受到能力影響、誰能看見誰，以及條件的否定或例外；文字沒有說的事情不要補上，無法辨識就標記，不要猜出另一個能力名稱。",
        ),
        "en" => Ok(
            "Focus strictly on the written text (dialogue and narration) on this comic page and convey the key meaning of each dialogue or narration block in short, natural English paragraphs following the reading order—like helping the reader smoothly understand what is written without translating word for word or sentence by sentence. The reader can already see the artwork, so do not add visual descriptions of actions, expressions, clothing, backgrounds, or composition; preserve these details when the written dialogue or narration itself mentions them. You may merge repetition and trim wordiness, but always preserve important numbers, conditions, restrictions, character stances, and tone without inventing relationships or cause-and-effect. Character names may be kept as-is, and irrelevant decorative text can be ignored. Do not impose a fixed word limit; output plain text only without source text, numbering, or Markdown formatting. Briefly mark illegible text as '[illegible]' without guessing; if there is no text on the page, briefly state 'No translatable text on this page.' Output entirely in English, apart from proper names. Check who affects whom, negations, exceptions, numbers, and limits; mark uncertain text instead of guessing another ability name.",
        ),
        "ja" => Ok(
            "このページの画像内の「文字部分」（セリフやナレーション）のみを対象とし、漫画の読み順に沿って、各会話や叙述のまとまりの要点を、短い段落に分けて自然な日本語でわかりやすく伝えてください。一語一句の逐語訳や文ごとの対訳ではなく、読者が文字の内容をスムーズに理解できるよう転述してください。絵は読者自身が見ているため、背景、動作、外見、構図などを絵から推測して付け加えないでください。ただし、セリフや叙述自体に書かれている内容は省かないでください。重複や冗長な表現はまとめて構いませんが、文字に含まれる重要な数値、条件、制約、キャラクターの立場や口調は必ず残し、人間関係や因果関係を創作しないでください。人名は原表記のままで構わず、無関係な装飾文字は省いてください。固定の文字数制限は設けず、プレーンテキストのみを出力し、原文の併記、番号付け、Markdown記法は一切使用しないでください。不鮮明な文字は推測せず短く「[判読不能]」と記し、対象となる文字がない場合は「このページに翻訳可能な文字はありません」と短く記載してください。 固有名詞を除き、出力はすべて日本語にしてください。誰が誰に影響するか、否定、例外、数値や条件を確認し、不確かな能力名を創作しないでください。",
        ),
        unknown => Err(format!("不支援的 AI 輸出語言：{unknown}")),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestMetadataRequest {
    comic_id: String,
    data_urls: Vec<String>,
    #[serde(default = "default_metadata_locale")]
    target_locale: String,
}

fn default_metadata_locale() -> String {
    "zh-Hant".to_string()
}

fn metadata_prompt(target_locale: &str) -> Result<&'static str, String> {
    match target_locale {
        "zh-Hant" => Ok(
            "請只回傳 JSON array，不要 Markdown。請共同分析依序提供的最多六張漫畫取樣頁面，圖片順序是閱讀順序：通常依序代表第 1、2、3 頁，以及全書約 40%、50%、60% 的位置；若是短書而前端已去除重複位置，請依收到的去重順序判讀。請提出一組待人工確認的 metadata 候選，格式為 [{\"field\":\"summary\",\"value\":\"繁體中文摘要\",\"confidence\":0.0},{\"field\":\"tags\",\"value\":[{\"namespace\":\"general\",\"value\":\"標籤\"}],\"confidence\":0.0}]。摘要與介面語言一致，使用自然的繁體中文（台灣用語）；標籤可以保留原語或翻譯，但整組標籤必須一致地使用同一種語言策略。只可使用 summary 或 tags；只根據清楚看見的內容，不要猜測或杜撰，看不清楚就不要提出該候選，最多 8 筆。若完全無法辨識或必須拒絕，請改以一句話說明具體原因，不要回傳空陣列。",
        ),
        "en" => Ok(
            "Return only a JSON array, with no Markdown. Analyze the up to six comic sample pages together in the order provided. The sequence usually represents pages 1, 2, and 3, followed by approximately 40%, 50%, and 60% through the book; if the book is short and the frontend removed duplicate positions, interpret the remaining images in their deduplicated order. Produce metadata candidates for human review, using [{\"field\":\"summary\",\"value\":\"English summary\",\"confidence\":0.0},{\"field\":\"tags\",\"value\":[{\"namespace\":\"general\",\"value\":\"tag\"}],\"confidence\":0.0}]. Keep the summary in the interface language, English; tags may preserve the source language or be translated, but use one consistent language strategy across the whole tag set. Use only summary or tags; rely only on clearly visible content, do not guess or invent, omit a candidate when the content is unclear, and return at most 8 candidates. If nothing can be read reliably or you must refuse, instead give one short sentence with the specific reason rather than an empty array.",
        ),
        "ja" => Ok(
            "Markdownを使わず、JSON arrayだけを返してください。提供された最大6枚の漫画サンプルを、受け取った順序でまとめて分析してください。通常は1、2、3ページ、その後に本全体のおよそ40%、50%、60%の位置を表します。短い本でフロントエンドが重複する位置を除去した場合は、残った画像の順序で判断してください。人が確認するためのmetadata候補を [{\"field\":\"summary\",\"value\":\"日本語の要約\",\"confidence\":0.0},{\"field\":\"tags\",\"value\":[{\"namespace\":\"general\",\"value\":\"タグ\"}],\"confidence\":0.0}] の形式で返してください。要約はインターフェースの言語である日本語にしてください。タグは原語のままでも翻訳しても構いませんが、タグ全体で同じ言語方針を一貫して使ってください。summaryまたはtagsだけを使用し、明確に見える内容だけに基づいてください。推測や創作はせず、不明瞭な場合は候補を出さず、最大8件までにしてください。全く判読できない場合や拒否が必要な場合は、空の配列ではなく、具体的な理由を短い一文で返してください。",
        ),
        unknown => Err(format!("不支援的 AI 輸出語言：{unknown}")),
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiMetadataSuggestion {
    field: String,
    value: serde_json::Value,
    confidence: f64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProgressRequest {
    id: String,
    /// Source identity returned by `open_comic`. Runtime IDs are only unique
    /// within a source; omitting this keeps legacy clients working when the
    /// catalog can prove that the ID has one unambiguous comic identity.
    #[serde(default)]
    source_id: Option<String>,
    current_page: u64,
    total_pages: u64,
    /// Optional during the migration; UI clients should send a strictly
    /// increasing value per comic so an older request cannot overwrite a
    /// newer page after it was delayed by the runtime.
    #[serde(default)]
    sequence: Option<u64>,
    /// Stable user-intent order. Retries may get a fresh `sequence` while
    /// retaining this value so an old journal cannot impersonate new work.
    #[serde(default)]
    intent_sequence: Option<u64>,
    /// Native token returned by `open_comic`, persisted with the UI journal so
    /// an old journal cannot borrow evidence from a later app runtime/open.
    #[serde(default)]
    recovery_token: Option<String>,
}

fn ai_status(
    config: Option<&crate::state::AiSessionConfig>,
    remembered_provider: Option<String>,
) -> AiSessionStatus {
    AiSessionStatus {
        configured: config.is_some(),
        provider: config.map(|value| value.provider.clone()),
        model: config.map(|value| value.model.clone()),
        remembered: remembered_provider.is_some(),
        remembered_provider,
        remembered_lookup_failed: false,
    }
}

fn validate_ai_session(
    provider_name: &str,
    raw_api_key: &str,
    google_content_disclosure: bool,
) -> Result<crate::state::AiSessionConfig, String> {
    let api_key = raw_api_key.trim();
    if api_key.len() < 16 || api_key.len() > 512 {
        return Err("API Key 格式不正確".into());
    }
    if api_key.chars().any(char::is_control) {
        return Err("API Key 格式不正確".into());
    }
    if !google_content_disclosure {
        return Err("啟用第三方艦載 AI 前，必須明確同意傳送目前頁面影像與提示文字".into());
    }
    let (provider, model) = match provider_name {
        "openai" => ("openai", "gpt-6-luna"),
        "google" => ("google", "gemma-4-26b-a4b-it / gemma-4-31b-it"),
        _ => return Err("不支援的艦載 AI 供應商".into()),
    };
    Ok(crate::state::AiSessionConfig {
        provider: provider.to_string(),
        model: model.to_string(),
        api_key: api_key.to_string(),
        google_content_disclosure: true,
    })
}

/// Revoke the in-memory AI session before any potentially fallible cleanup.
/// Incrementing first also invalidates requests that are waiting on the AI gate.
fn revoke_ai_session_in_memory(state: &AppState) -> Result<(), String> {
    let mut session = state
        .ai_session
        .write()
        .map_err(|_| "艦載 AI 工作階段鎖定失敗".to_string())?;
    // Keep the generation and config transition under the same write lock so
    // snapshots can never pair an old key with a new generation.
    let generation = state
        .ai_session_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .wrapping_add(1);
    cancel_ai_sends(generation);
    *session = None;
    Ok(())
}

fn ai_session_snapshot_locked(
    state: &AppState,
) -> Result<(crate::state::AiSessionConfig, u64), String> {
    let session = state
        .ai_session
        .read()
        .map_err(|_| "艦載 AI 工作階段鎖定失敗".to_string())?;
    let config = session
        .clone()
        .ok_or_else(|| "請先到設定輸入艦載 AI API Key".to_string())?;
    let generation = state
        .ai_session_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    Ok((config, generation))
}

async fn ai_session_snapshot(
    state: &AppState,
) -> Result<(crate::state::AiSessionConfig, u64), String> {
    let _lifecycle = state.ai_session_lifecycle.lock().await;
    ai_session_snapshot_locked(state)
}

#[cfg(target_os = "macos")]
const MACOS_AI_KEYCHAIN_SERVICE: &str = "com.windsheep.gai.ai-api-key";

#[cfg(target_os = "macos")]
// Security.framework's documented `errSecItemNotFound` OSStatus.
const MACOS_ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
fn macos_ai_keychain_save(provider: &str, api_key: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        MACOS_AI_KEYCHAIN_SERVICE,
        provider,
        api_key.as_bytes(),
    )
    .map_err(|error| format!("macOS Keychain 儲存 AI API Key 失敗：{error}"))
}

#[cfg(target_os = "macos")]
fn macos_ai_keychain_load(provider: &str) -> Result<String, String> {
    let bytes =
        security_framework::passwords::get_generic_password(MACOS_AI_KEYCHAIN_SERVICE, provider)
            .map_err(|error| format!("macOS Keychain 讀取 AI API Key 失敗：{error}"))?;
    String::from_utf8(bytes).map_err(|_| "macOS Keychain 的 AI API Key 格式不正確".into())
}

#[cfg(target_os = "macos")]
fn macos_ai_keychain_has(provider: &str) -> Result<bool, String> {
    // Presence checks return item attributes only; they do not read the secret.
    let mut options = security_framework::item::ItemSearchOptions::new();
    options
        .class(security_framework::item::ItemClass::generic_password())
        .service(MACOS_AI_KEYCHAIN_SERVICE)
        .account(provider)
        .load_attributes(true)
        .limit(1);
    match options.search() {
        Ok(items) => Ok(!items.is_empty()),
        Err(error) if error.code() == MACOS_ERR_SEC_ITEM_NOT_FOUND => Ok(false),
        Err(error) => Err(format!("macOS Keychain 查詢 AI API Key 失敗：{error}")),
    }
}

#[cfg(target_os = "macos")]
fn macos_ai_keychain_delete(provider: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(
        MACOS_AI_KEYCHAIN_SERVICE,
        provider,
    ) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == MACOS_ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(error) => Err(format!("macOS Keychain 刪除 AI API Key 失敗：{error}")),
    }
}

async fn ai_keychain_load_for_provider(
    app_handle: &AppHandle,
    provider: &str,
) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let app_handle = app_handle.clone();
        let provider = provider.to_string();
        let response = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            app_handle.tauri_plugin_ios_folder().load_ai_key(&provider)
        })
        .await
        .map_err(|error| format!("讀取 iOS Keychain 背景工作失敗：{error}"))?
        .map_err(|error| error.to_string())?;
        response
            .get("apiKey")
            .and_then(serde_json::Value::as_str)
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "iOS Keychain 沒有此供應商的 API Key".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app_handle;
        let provider = provider.to_string();
        tauri::async_runtime::spawn_blocking(move || macos_ai_keychain_load(&provider))
            .await
            .map_err(|error| format!("macOS Keychain 讀取背景工作失敗：{error}"))?
    }
    #[cfg(all(not(target_os = "ios"), not(target_os = "macos")))]
    {
        let _ = (app_handle, provider);
        Err("此平台沒有已保存的 API Key".into())
    }
}

async fn ai_keychain_remembered_provider(app_handle: &AppHandle) -> Result<Option<String>, String> {
    for provider in ["openai", "google"] {
        #[cfg(target_os = "ios")]
        {
            let app_handle = app_handle.clone();
            let provider_name = provider.to_string();
            let response = tauri::async_runtime::spawn_blocking(move || {
                use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
                app_handle
                    .tauri_plugin_ios_folder()
                    .has_ai_key(&provider_name)
            })
            .await
            .map_err(|error| format!("查詢 iOS Keychain 背景工作失敗：{error}"))?
            .map_err(|error| error.to_string())?;
            if response.get("present").and_then(serde_json::Value::as_bool) == Some(true) {
                return Ok(Some(provider.to_string()));
            }
        }
        #[cfg(target_os = "macos")]
        {
            let _ = app_handle;
            let provider_name = provider.to_string();
            let present =
                tauri::async_runtime::spawn_blocking(move || macos_ai_keychain_has(&provider_name))
                    .await
                    .map_err(|error| format!("macOS Keychain 查詢背景工作失敗：{error}"))??;
            if present {
                return Ok(Some(provider.to_string()));
            }
        }
        #[cfg(all(not(target_os = "ios"), not(target_os = "macos")))]
        {
            let _ = (app_handle, provider);
        }
    }
    Ok(None)
}

async fn ai_keychain_save(
    app_handle: &AppHandle,
    provider: &str,
    api_key: &str,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let app_handle = app_handle.clone();
        let provider = provider.to_string();
        let api_key = api_key.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            app_handle
                .tauri_plugin_ios_folder()
                .save_ai_key(&provider, &api_key)
        })
        .await
        .map_err(|error| format!("保存 iOS Keychain 背景工作失敗：{error}"))?
        .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app_handle;
        let provider = provider.to_string();
        let api_key = api_key.to_string();
        tauri::async_runtime::spawn_blocking(move || macos_ai_keychain_save(&provider, &api_key))
            .await
            .map_err(|error| format!("macOS Keychain 儲存背景工作失敗：{error}"))??;
        Ok(())
    }
    #[cfg(all(not(target_os = "ios"), not(target_os = "macos")))]
    {
        let _ = (app_handle, provider, api_key);
        Ok(())
    }
}

async fn ai_keychain_delete(app_handle: &AppHandle, provider: &str) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let app_handle = app_handle.clone();
        let provider = provider.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            app_handle
                .tauri_plugin_ios_folder()
                .delete_ai_key(&provider)
        })
        .await
        .map_err(|error| format!("刪除 iOS Keychain 背景工作失敗：{error}"))?
        .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app_handle;
        let provider = provider.to_string();
        tauri::async_runtime::spawn_blocking(move || macos_ai_keychain_delete(&provider))
            .await
            .map_err(|error| format!("macOS Keychain 刪除背景工作失敗：{error}"))??;
        Ok(())
    }
    #[cfg(all(not(target_os = "ios"), not(target_os = "macos")))]
    {
        let _ = (app_handle, provider);
        Ok(())
    }
}

async fn ai_keychain_delete_all(app_handle: &AppHandle) -> Result<(), String> {
    let mut errors = Vec::new();
    for provider in ["openai", "google"] {
        if let Err(error) = ai_keychain_delete(app_handle, provider).await {
            errors.push(format!("{provider}: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "刪除已記住的 AI API Key 時發生錯誤：{}",
            errors.join("; ")
        ))
    }
}

#[tauri::command]
async fn get_ai_session_status(
    app_handle: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AiSessionStatus, String> {
    let _lifecycle = state.ai_session_lifecycle.lock().await;
    let (remembered_provider, remembered_lookup_failed) =
        match ai_keychain_remembered_provider(&app_handle).await {
            Ok(provider) => (provider, false),
            Err(_) => {
                // A Keychain status failure must not hide an otherwise valid RAM
                // session. Do not log the underlying provider error because
                // native implementations may include security details.
                log::warn!("查詢已記住的 AI API Key 狀態失敗；保留記憶體中的工作階段狀態");
                (None, true)
            }
        };
    let config = state
        .ai_session
        .read()
        .map_err(|_| "艦載 AI 工作階段鎖定失敗".to_string())?;
    let mut status = ai_status(config.as_ref(), remembered_provider);
    status.remembered_lookup_failed = remembered_lookup_failed;
    Ok(status)
}

#[tauri::command]
async fn set_ai_session_config(
    app_handle: AppHandle,
    data: AiSessionRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiSessionStatus, String> {
    let config = validate_ai_session(
        &data.provider,
        &data.api_key,
        data.google_content_disclosure,
    )?;
    let _lifecycle = state.ai_session_lifecycle.lock().await;
    // Acquire the lifecycle before any asynchronous entitlement check.  A
    // clear/revoke that is issued while this command is waiting must not be
    // followed by a late commit from this older transition.
    commerce::require_pro(&app_handle).await?;
    // Revoke before touching Keychain so a failed save/delete can never leave
    // the previous provider usable through an already queued request.
    revoke_ai_session_in_memory(state.inner())?;
    // Wait for a request that already passed its generation check to finish
    // sending before this transition can commit and return.
    wait_for_ai_sends().await;
    if data.remember_key {
        let other_provider = if config.provider == "openai" {
            "google"
        } else {
            "openai"
        };
        ai_keychain_save(&app_handle, &config.provider, &config.api_key).await?;
        if let Err(delete_error) = ai_keychain_delete(&app_handle, other_provider).await {
            let rollback = ai_keychain_delete(&app_handle, &config.provider).await;
            return match rollback {
                Ok(()) => Err(format!(
                    "刪除舊的 {other_provider} API Key 失敗，已回復目前 Key：{delete_error}"
                )),
                Err(rollback_error) => {
                    // Make a best-effort cleanup pass so a failed rollback
                    // cannot silently leave both provider keys persisted.
                    match ai_keychain_delete_all(&app_handle).await {
                        Ok(()) => Err(format!(
                            "切換 API Key 儲存供應商失敗，已清除已記住的 Key：{delete_error}；回復目前 Key 失敗：{rollback_error}"
                        )),
                        Err(cleanup_error) => Err(format!(
                            "切換 API Key 儲存供應商失敗，Keychain 清除也失敗：{delete_error}；回復目前 Key 失敗：{rollback_error}；清除失敗：{cleanup_error}"
                        )),
                    }
                }
            };
        }
    } else {
        ai_keychain_delete_all(&app_handle).await?;
    }
    let remembered_provider = ai_keychain_remembered_provider(&app_handle).await?;
    let status = ai_status(Some(&config), remembered_provider);
    *state
        .ai_session
        .write()
        .map_err(|_| "艦載 AI 工作階段鎖定失敗".to_string())? = Some(config);
    Ok(status)
}

#[tauri::command]
async fn restore_ai_session_config(
    app_handle: AppHandle,
    data: AiSessionRestoreRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiSessionStatus, String> {
    if !matches!(data.provider.as_str(), "openai" | "google") {
        return Err("不支援的艦載 AI 供應商".into());
    }
    let _lifecycle = state.ai_session_lifecycle.lock().await;
    // See set_ai_session_config: entitlement lookup is part of the session
    // transition, so it cannot race a clear/revoke and restore stale RAM.
    commerce::require_pro(&app_handle).await?;
    revoke_ai_session_in_memory(state.inner())?;
    wait_for_ai_sends().await;
    let api_key = ai_keychain_load_for_provider(&app_handle, &data.provider).await?;
    let config = validate_ai_session(&data.provider, &api_key, data.google_content_disclosure)?;
    let status = ai_status(Some(&config), Some(config.provider.clone()));
    *state
        .ai_session
        .write()
        .map_err(|_| "艦載 AI 工作階段鎖定失敗".to_string())? = Some(config);
    Ok(status)
}

#[tauri::command]
async fn clear_ai_session_config(
    app_handle: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let _lifecycle = state.ai_session_lifecycle.lock().await;
    revoke_ai_session_in_memory(state.inner())?;
    wait_for_ai_sends().await;
    // Cleanup may fail (for example while the device is locked), but RAM was
    // already revoked, so the caller cannot continue using the old AI key.
    ai_keychain_delete_all(&app_handle).await
}

#[tauri::command]
async fn revoke_ai_session_config(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let _lifecycle = state.ai_session_lifecycle.lock().await;
    revoke_ai_session_in_memory(state.inner())?;
    wait_for_ai_sends().await;
    Ok(())
}

const AI_OUTPUT_INCOMPLETE_PREFIX: &str = "AI_OUTPUT_INCOMPLETE:";

fn response_text(value: &serde_json::Value) -> Option<String> {
    let content = value.get("output")?.as_array()?.iter().flat_map(|item| {
        item.get("content")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
    });
    let mut text = String::new();
    let mut found_text = false;
    for item in content {
        match item.get("type").and_then(serde_json::Value::as_str) {
            Some("output_text") => {
                if let Some(segment) = item.get("text").and_then(serde_json::Value::as_str) {
                    text.push_str(segment);
                    found_text = true;
                }
            }
            Some("refusal") if !found_text => {
                if let Some(refusal) = item.get("refusal").and_then(serde_json::Value::as_str) {
                    return Some(refusal.to_string());
                }
            }
            _ => {}
        }
    }
    (found_text && !text.trim().is_empty()).then_some(text)
}

fn openai_response_text(value: &serde_json::Value) -> Result<Option<String>, String> {
    match value.pointer("/status").and_then(serde_json::Value::as_str) {
        Some("incomplete") => Err(format!(
            "{AI_OUTPUT_INCOMPLETE_PREFIX}OpenAI response status is incomplete"
        )),
        Some("completed") => Ok(response_text(value)),
        _ => Ok(None),
    }
}

fn gemma_response_text(value: &serde_json::Value) -> Option<String> {
    let mut text = String::new();
    let mut found_text = false;
    for part in value
        .pointer("/candidates/0/content/parts")?
        .as_array()?
        .iter()
        .filter(|part| part.get("thought").and_then(serde_json::Value::as_bool) != Some(true))
    {
        if let Some(segment) = part.get("text").and_then(serde_json::Value::as_str) {
            text.push_str(segment);
            found_text = true;
        }
    }
    (found_text && !text.trim().is_empty()).then_some(text)
}

fn gemma_response_result(value: &serde_json::Value) -> Result<Option<String>, String> {
    let finish_reason = value
        .pointer("/candidates/0/finishReason")
        .and_then(serde_json::Value::as_str);
    match finish_reason {
        Some("MAX_TOKENS") => Err(format!(
            "{AI_OUTPUT_INCOMPLETE_PREFIX}Gemma 4 reached its output token limit"
        )),
        Some("STOP") => Ok(gemma_response_text(value)),
        // Safety and other non-terminal finishes must not expose partial text.
        // The caller retains its existing reason-based display for these cases.
        _ => Ok(None),
    }
}

fn gemma_model_order(request_number: u64) -> [&'static str; 2] {
    const MODELS: [&str; 2] = ["gemma-4-26b-a4b-it", "gemma-4-31b-it"];
    let first = (request_number % MODELS.len() as u64) as usize;
    [MODELS[first], MODELS[1 - first]]
}

fn should_try_gemma_fallback(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

async fn send_ai_request(
    state: &AppState,
    expected_generation: u64,
    request: reqwest::RequestBuilder,
    failure_prefix: &str,
) -> Result<reqwest::Response, String> {
    // The shared read guard covers the generation check and request start
    // together. A revoke first advances the generation and notifies active
    // sends, then takes the write side; this lets concurrent sends proceed
    // without serializing while still closing the check/start race.
    let _send_lifecycle = ai_send_lifecycle().read().await;
    let mut cancellation = ai_send_cancellation().subscribe();
    if state
        .ai_session_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        != expected_generation
    {
        return Err("艦載 AI 工作階段已撤銷或切換，請重新提交".into());
    }
    tokio::select! {
        result = request.send() => result
            .map_err(|error| format!("{failure_prefix}{error}")),
        _ = cancellation.changed() => Err("艦載 AI 工作階段已撤銷或切換，請重新提交".into()),
    }
}

fn redact_ai_error(error: String, api_key: &str) -> String {
    if api_key.is_empty() {
        return error;
    }
    error.replace(api_key, "[REDACTED API KEY]")
}

struct AiCompletion {
    text: String,
    model: String,
}

fn openai_image_content(images: &[(&str, &str)]) -> Vec<serde_json::Value> {
    images
        .iter()
        .map(|(mime, data)| {
            serde_json::json!({
                "type": "input_image",
                "image_url": format!("data:{mime};base64,{data}")
            })
        })
        .collect()
}

fn gemma_image_parts(images: &[(&str, &str)]) -> Vec<serde_json::Value> {
    images
        .iter()
        .map(|(mime, data)| serde_json::json!({ "inlineData": { "mimeType": mime, "data": data } }))
        .collect()
}

async fn call_ai(
    state: &AppState,
    config: crate::state::AiSessionConfig,
    expected_generation: u64,
    images: &[(&str, &str)],
    prompt: &str,
    reasoning_effort: &str,
) -> Result<AiCompletion, String> {
    let api_key = config.api_key.clone();
    call_ai_inner(
        state,
        config,
        expected_generation,
        images,
        prompt,
        reasoning_effort,
    )
    .await
    .map_err(|error| redact_ai_error(error, &api_key))
}

async fn call_ai_inner(
    state: &AppState,
    config: crate::state::AiSessionConfig,
    expected_generation: u64,
    images: &[(&str, &str)],
    prompt: &str,
    reasoning_effort: &str,
) -> Result<AiCompletion, String> {
    let _permit = state
        .ai_request_gate
        .acquire()
        .await
        .map_err(|_| "艦載 AI 併發限制已關閉".to_string())?;
    if state
        .ai_session_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        != expected_generation
    {
        return Err("艦載 AI 工作階段已撤銷或切換，請重新提交".into());
    }
    let client = AI_HTTP_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    if config.provider == "openai" {
        let mut content = openai_image_content(images);
        content.push(serde_json::json!({ "type": "input_text", "text": prompt }));
        let response = send_ai_request(
            state,
            expected_generation,
            client
                .post("https://api.openai.com/v1/responses")
                .bearer_auth(&config.api_key)
                .json(&serde_json::json!({
                    "model": &config.model,
                    "reasoning": { "effort": reasoning_effort },
                    "input": [{ "role": "user", "content": content }]
                })),
            "Luna 連線失敗：",
        )
        .await?;
        let (status, value) = limited_ai_json_response(response).await?;
        if !status.is_success() {
            return Err(format!(
                "Luna 拒絕請求（HTTP {}）：{}",
                status.as_u16(),
                value
                    .pointer("/error/message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("未知錯誤")
            ));
        }
        openai_response_text(&value)?
            .map(|text| AiCompletion {
                text,
                model: config.model,
            })
            .ok_or_else(|| "Luna 沒有回傳可顯示文字".to_string())
    } else {
        let mut parts = gemma_image_parts(images);
        parts.push(serde_json::json!({ "text": prompt }));
        let request_number = state
            .ai_gemma_request_number
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let models = gemma_model_order(request_number);
        for (index, model) in models.iter().enumerate() {
            let endpoint = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            );
            let response = send_ai_request(
                state,
                expected_generation,
                client
                    .post(endpoint)
                    .header("x-goog-api-key", &config.api_key)
                    .json(&serde_json::json!({
                        "contents": [{ "role": "user", "parts": parts.clone() }],
                        "generationConfig": {
                            "thinkingConfig": { "thinkingLevel": "minimal" }
                        }
                    })),
                "Gemma 4 連線失敗：",
            )
            .await?;
            let (status, value) = limited_ai_json_response(response).await?;
            if status.is_success() {
                return gemma_response_result(&value)?
                    .map(|text| AiCompletion {
                        text,
                        model: model.to_string(),
                    })
                    .ok_or_else(|| {
                        let reason = value
                            .pointer("/candidates/0/finishReason")
                            .or_else(|| value.pointer("/promptFeedback/blockReason"))
                            .and_then(serde_json::Value::as_str);
                        reason.map_or_else(
                            || "Gemma 4 沒有回傳可顯示文字".to_string(),
                            |reason| format!("Gemma 4 沒有回傳可顯示文字（原因：{reason}）"),
                        )
                    });
            }
            if index == 0 && should_try_gemma_fallback(status) {
                continue;
            }
            return Err(format!(
                "Gemma 4 拒絕請求（{model}，HTTP {}）：{}",
                status.as_u16(),
                value
                    .pointer("/error/message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("未知錯誤")
            ));
        }
        Err("Gemma 4 沒有可用的備援模型".to_string())
    }
}

async fn limited_ai_json_response(
    mut response: reqwest::Response,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("艦載 AI 回應讀取失敗：{error}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_AI_RESPONSE_BYTES {
            return Err("艦載 AI 回應超過 1 MiB 安全上限".into());
        }
        body.extend_from_slice(&chunk);
    }
    match serde_json::from_slice(&body) {
        Ok(value) => Ok((status, value)),
        Err(_) if !status.is_success() => Ok((status, serde_json::Value::Null)),
        Err(error) => Err(format!("艦載 AI 回應格式不正確：{error}")),
    }
}

#[tauri::command]
async fn test_ai_session(
    app_handle: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commerce::require_pro(&app_handle).await?;
    let (config, generation) = ai_session_snapshot(state.inner()).await?;
    call_ai(
        state.inner(),
        config,
        generation,
        &[],
        "請只回答：艦載 AI 連線成功。不要補充其他內容。",
        "low",
    )
    .await
    .map(|response| response.text)
}

#[tauri::command]
async fn explain_page(
    app_handle: AppHandle,
    data: ExplainPageRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commerce::require_pro(&app_handle).await?;
    let (config, generation) = ai_session_snapshot(state.inner()).await?;
    let (mime, encoded) = validate_page_data_url(&data.data_url)?;
    if !config.google_content_disclosure {
        return Err("尚未同意第三方 AI 資料分享".into());
    }
    let prompt = explain_page_prompt(&data.target_locale)?;
    let images = [(mime, encoded)];
    call_ai(state.inner(), config, generation, &images, prompt, "medium")
        .await
        .map(|response| response.text)
}

fn validate_page_data_url(data_url: &str) -> Result<(&str, &str), String> {
    validate_page_data_url_with_limit(data_url, MAX_AI_IMAGE_BYTES, "20 MiB")
        .map(|(mime, encoded, _)| (mime, encoded))
}

fn validate_page_data_url_with_limit<'a>(
    data_url: &'a str,
    max_decoded_bytes: usize,
    max_size_label: &str,
) -> Result<(&'a str, &'a str, usize), String> {
    use base64::Engine as _;
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "頁面圖片格式不正確".to_string())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "頁面圖片必須是 base64 data URL".to_string())?;
    if !matches!(
        mime,
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        return Err("艦載 AI 目前只接受 JPEG、PNG、WebP 或 GIF".into());
    }
    let max_base64_bytes = max_decoded_bytes.div_ceil(3) * 4;
    if encoded.len() > max_base64_bytes {
        return Err(format!("頁面圖片超過 {max_size_label} 安全上限"));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "頁面圖片 base64 損壞".to_string())?;
    if decoded.is_empty() || decoded.len() > max_decoded_bytes {
        return Err(format!("頁面圖片必須介於 1 byte 與 {max_size_label}"));
    }
    Ok((mime, encoded, decoded.len()))
}

fn parse_ai_metadata_suggestions(text: &str) -> Result<Vec<AiMetadataSuggestion>, String> {
    let cleaned = text
        .trim()
        .strip_prefix("```json")
        .or_else(|| text.trim().strip_prefix("```"))
        .unwrap_or(text.trim())
        .strip_suffix("```")
        .unwrap_or_else(|| {
            text.trim()
                .strip_prefix("```json")
                .or_else(|| text.trim().strip_prefix("```"))
                .unwrap_or(text.trim())
        })
        .trim();
    let values: Vec<AiMetadataSuggestion> = serde_json::from_str(cleaned).map_err(|_| {
        if let Some(reason) = metadata_refusal_reason(cleaned) {
            let message = cleaned
                .chars()
                .filter(|character| !character.is_control() || *character == '\t')
                .take(240)
                .collect::<String>();
            format!("艦載 AI 無法產生 metadata 候選：{reason}（模型訊息：{message}）")
        } else if !cleaned.is_empty() {
            let message = cleaned
                .chars()
                .filter(|character| !character.is_control() || *character == '\t')
                .take(240)
                .collect::<String>();
            format!("艦載 AI 未回傳 JSON 候選，模型訊息：{message}")
        } else {
            "艦載 AI 回傳的候選格式無法解析".to_string()
        }
    })?;
    if values.len() > 8 {
        return Err("艦載 AI 候選數量超過 8 筆上限".into());
    }
    for item in &values {
        if !matches!(item.field.as_str(), "summary" | "tags")
            || !(0.0..=1.0).contains(&item.confidence)
        {
            return Err("艦載 AI 回傳了不支援的候選欄位或信心值".into());
        }
        if item.field == "summary"
            && item
                .value
                .as_str()
                .is_none_or(|value| value.chars().count() > 800)
        {
            return Err("艦載 AI 摘要超過 800 字上限".into());
        }
        if item.field == "tags" {
            let tags = item.value.as_array().ok_or("艦載 AI 標籤格式錯誤")?;
            if tags.len() > 12
                || tags.iter().any(|tag| {
                    tag.get("namespace")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(|value| value.is_empty() || value.chars().count() > 64)
                        || tag
                            .get("value")
                            .and_then(serde_json::Value::as_str)
                            .is_none_or(|value| value.is_empty() || value.chars().count() > 128)
                })
            {
                return Err("艦載 AI 標籤超過格式或數量上限".into());
            }
        }
    }
    Ok(values)
}

fn metadata_refusal_reason(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    if [
        "blurry",
        "unclear",
        "illegible",
        "low quality",
        "看不清",
        "模糊",
        "無法辨識",
        "読み取れません",
        "判読できません",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        Some("圖片品質不足或文字無法可靠辨識，請改用較清晰的取樣頁面")
    } else if [
        "cannot",
        "can't",
        "unable",
        "refuse",
        "拒絕",
        "お断り",
        "できません",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        Some("模型拒絕根據目前圖片提出候選，請確認頁面內容清楚且適合分析")
    } else {
        None
    }
}

fn metadata_ai_error(error: String) -> String {
    const MAX_REASON_CHARS: usize = 240;
    let reason = error.replace(['\r', '\n'], " ");
    let bounded = reason.chars().take(MAX_REASON_CHARS).collect::<String>();
    if reason.chars().count() > MAX_REASON_CHARS {
        format!("艦載 AI metadata 請求失敗：{bounded}…")
    } else {
        format!("艦載 AI metadata 請求失敗：{bounded}")
    }
}

fn validate_metadata_images(data_urls: &[String]) -> Result<Vec<(&str, &str)>, String> {
    if data_urls.is_empty() {
        return Err("至少需要一張漫畫取樣頁面".into());
    }
    if data_urls.len() > MAX_AI_METADATA_IMAGE_COUNT {
        return Err("漫畫 metadata 最多只能分析 6 張取樣頁面".into());
    }
    let mut total_decoded_bytes = 0usize;
    let mut images = Vec::with_capacity(data_urls.len());
    for data_url in data_urls {
        let (mime, encoded, decoded_bytes) =
            validate_page_data_url_with_limit(data_url, MAX_AI_METADATA_IMAGE_BYTES, "2 MiB")?;
        total_decoded_bytes = total_decoded_bytes.saturating_add(decoded_bytes);
        if total_decoded_bytes > MAX_AI_METADATA_TOTAL_IMAGE_BYTES {
            return Err("漫畫 metadata 取樣圖片總大小不得超過 10 MiB".into());
        }
        images.push((mime, encoded));
    }
    Ok(images)
}

#[tauri::command]
async fn suggest_comic_metadata(
    app_handle: AppHandle,
    data: SuggestMetadataRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AiMetadataSuggestion>, String> {
    commerce::require_pro(&app_handle).await?;
    let (config, generation) = ai_session_snapshot(state.inner()).await?;
    if !config.google_content_disclosure {
        return Err("尚未同意第三方 AI 資料分享".into());
    }
    let images = validate_metadata_images(&data.data_urls)?;
    let prompt = metadata_prompt(&data.target_locale)?;
    let provider = config.provider.clone();
    let response = call_ai(state.inner(), config, generation, &images, prompt, "low")
        .await
        .map_err(metadata_ai_error)?;
    let suggestions = parse_ai_metadata_suggestions(&response.text)?;
    let _lifecycle = state.ai_session_lifecycle.lock().await;
    if state
        .ai_session_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        != generation
    {
        return Err("艦載 AI 工作階段已撤銷或切換，候選未寫入目錄".into());
    }
    // 背景掃描也會寫入 catalog；候選必須等同一把鎖，避免 SQLite writer 互搶。
    let _catalog_sync = state.catalog_sync.lock().await;
    let store = catalog_store(&state)?;
    let comic_id = data.comic_id;
    let raw = response.text;
    let model = response.model;
    let suggestions_for_store = suggestions
        .iter()
        .map(|item| (item.field.clone(), item.value.clone(), item.confidence))
        .collect::<Vec<_>>();
    tokio::task::spawn_blocking(move || {
        store.store_ai_candidates(&comic_id, &provider, &model, &raw, suggestions_for_store)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(suggestions)
}

fn reconcile_bookmark_reader_cache(
    state: &AppState,
    removed_bookmarks: bool,
    removed_comics: bool,
) {
    if removed_bookmarks || removed_comics {
        state.invalidate_reader_cache();
    }
}

#[tauri::command]
async fn set_bookmarks(
    data: Vec<crate::state::ExternalBookmark>,
    restore_from_saved: Option<bool>,
    legacy_cache_readable: Option<bool>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<crate::state::ExternalBookmark>, String> {
    update_bookmarks(
        data,
        restore_from_saved,
        legacy_cache_readable,
        false,
        state,
        app_handle,
    )
    .await
}

#[tauri::command]
async fn repair_external_bookmarks(
    data: Vec<crate::state::ExternalBookmark>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<crate::state::ExternalBookmark>, String> {
    update_bookmarks(data, None, None, true, state, app_handle).await
}

async fn update_bookmarks(
    data: Vec<crate::state::ExternalBookmark>,
    restore_from_saved: Option<bool>,
    legacy_cache_readable: Option<bool>,
    repair_corrupt: bool,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<crate::state::ExternalBookmark>, String> {
    // Serialize disk persistence with the matching in-memory update. Otherwise
    // an older request can finish writing after a newer request has applied.
    let _bookmark_lifecycle = state.bookmark_lifecycle.lock().await;
    let _source_authorization = state.source_authorization_lifecycle.write().await;
    let data = if restore_from_saved.unwrap_or(false) {
        let settings_dir = app_handle
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("無法取得 App 設定目錄：{error}"))?;
        let restored = tokio::task::spawn_blocking(move || {
            external_bookmarks_for_restore(
                &settings_dir,
                data,
                legacy_cache_readable.unwrap_or(true),
            )
        })
        .await
        .map_err(|error| format!("外部來源還原工作失敗：{error}"))?;
        match restored {
            Ok(bookmarks) => bookmarks,
            Err(error) => {
                state
                    .external_bookmarks_readable
                    .store(false, std::sync::atomic::Ordering::Release);
                return Err(error);
            }
        }
    } else {
        data
    };
    let committed_bookmarks = data.clone();
    let bookmarks_to_persist = data.clone();
    let settings_handle = app_handle.clone();
    let recovery_warning =
        tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
            if !repair_corrupt {
                persist_external_bookmarks(&settings_handle, &bookmarks_to_persist)?;
                return Ok(None);
            }
            let settings_dir = settings_handle
                .path()
                .app_local_data_dir()
                .map_err(|error| format!("無法取得 App 設定目錄：{error}"))?;
            let path = settings_dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE);
            let outcome = bookmark_recovery::recover_external_bookmarks(
                &path,
                bookmark_recovery::RecoveryRequest {
                    user_confirmed: true,
                    new_sources: bookmarks_to_persist,
                },
            )
            .map_err(|error| format!("無法備份或重建外部來源清單：{error}"))?;
            match &outcome {
                bookmark_recovery::RecoveryOutcome::AlreadyValid(bookmarks) => {
                    log::warn!("外部來源清單已變更，包含 {} 個來源", bookmarks.len());
                    return Err("外部來源清單已改變，請重新整理後再試。".into());
                }
                bookmark_recovery::RecoveryOutcome::NotFound => {
                    return Err("外部來源清單已改變，請重新整理後再試。".into());
                }
                _ => {}
            }
            let count = outcome.committed_bookmarks().map_or(0, |items| items.len());
            log::info!(
                "已重建 {count} 個外部來源；損壞清單備份：{:?}",
                outcome.backup_path()
            );
            Ok(outcome
                .warning()
                .map(|warning| format!("重建後的保存確認未完成：{warning}")))
        })
        .await
        .map_err(|error| format!("外部來源設定工作失敗：{error}"))??;

    let old_bookmarks = state.external_bookmarks.read().unwrap().clone();
    let removed_bookmarks: Vec<_> = old_bookmarks
        .into_iter()
        .filter(|old| {
            !data
                .iter()
                .any(|new_bookmark| new_bookmark.bookmark == old.bookmark)
        })
        .collect();
    let selected_source_ids = data
        .iter()
        .map(|bookmark| scanner::external_source_id(&bookmark.bookmark))
        .collect::<BTreeSet<_>>();
    let mut cleanup_errors: Vec<String> = Vec::new();
    if let Some(warning) = recovery_warning {
        cleanup_errors.push(warning);
    }

    #[cfg(any(target_os = "ios", target_os = "macos"))]
    for removed in &removed_bookmarks {
        use tauri_plugin_ios_folder::StopAccessingRequest;
        use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
        app_handle
            .tauri_plugin_ios_folder()
            .stop_accessing(StopAccessingRequest {
                bookmark: removed.bookmark.clone(),
            })
            .unwrap_or_else(|error| {
                cleanup_errors.push(format!("無法釋放 {} 的舊權限：{error}", removed.name));
            });
    }

    {
        let _catalog_sync = state.catalog_sync.lock().await;
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        // Persistence has committed. Reconcile the durable catalog on every
        // call so a previous cleanup failure is retryable with the same list.
        let cleanup_result = async {
            let store = catalog_store(&state)?;
            let selected = selected_source_ids.clone();
            tokio::task::spawn_blocking(move || {
                store.reconcile_external_source_locations(&selected)
            })
            .await
            .map_err(|error| error.to_string())?
        }
        .await;
        if let Err(error) = cleanup_result {
            cleanup_errors.push(format!("舊來源目錄清理未完成：{error}"));
        }
        {
            let mut active = state.active_bookmarks.lock().unwrap();
            for removed in &removed_bookmarks {
                active.remove(&removed.bookmark);
            }
        }
        let mut comics = state.comics.lock().await;
        let previous_comic_count = comics.len();
        comics.retain(|comic| {
            !comic.source_id.starts_with("external:")
                || selected_source_ids.contains(&comic.source_id)
        });
        let removed_comics = comics.len() != previous_comic_count;
        state
            .source_authorization_generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        *state.external_bookmarks.write().unwrap() = data;
        state
            .external_bookmarks_readable
            .store(true, std::sync::atomic::Ordering::Release);
        drop(comics);
        reconcile_bookmark_reader_cache(&state, !removed_bookmarks.is_empty(), removed_comics);
        state
            .scan_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        crate::scanner::start_background_scan(state_clone, app_handle).await;
    });
    if cleanup_errors.is_empty() {
        Ok(committed_bookmarks)
    } else {
        Err(format!(
            "清單已更新，部分舊來源清理未完成：{}",
            cleanup_errors.join("; ")
        ))
    }
}

#[tauri::command]
async fn get_bookmarks(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<crate::state::ExternalBookmark>, String> {
    Ok(state.external_bookmarks.read().unwrap().clone())
}

#[tauri::command]
async fn browse_folders(_dir_path: Option<String>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "currentPath": "", "folders": [] }))
}

#[tauri::command]
async fn show_item_in_folder(
    comic_id: String,
    source_id: Option<String>,
    relative_path: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if photo_library::is_photo_album_id(&comic_id) {
        return Err("照片相簿沒有可在檔案管理器顯示的檔案位置".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, source_id, relative_path);
        return Err("目前平台不支援在檔案管理器顯示漫畫".into());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let source_id = source_id.ok_or("缺少漫畫來源識別，已拒絕開啟檔案位置")?;
        let relative_path = relative_path.ok_or("缺少漫畫來源位置，已拒絕開啟檔案位置")?;
        let store = catalog_store(&state)?;
        let location = tokio::task::spawn_blocking(move || {
            store.get_location_for_source(&comic_id, &source_id, &relative_path)
        })
        .await
        .map_err(|error| format!("漫畫位置查詢失敗: {error}"))??;
        if !location.online {
            return Err("漫畫來源目前離線".into());
        }
        let path = location
            .actual_path
            .ok_or_else(|| "漫畫沒有可顯示的已登記位置".to_string())?;
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .map_err(|error| error.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(&path)
                .spawn()
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[tauri::command]
async fn get_file_capability(
    app_handle: AppHandle,
    comic_id: String,
    source_id: Option<String>,
    relative_path: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<file_ops::FileCapability, String> {
    let store = catalog_store(&state)?;
    let source_id = source_id.ok_or("缺少漫畫來源識別，已拒絕檔案管理")?;
    let relative_path = relative_path.ok_or("缺少漫畫來源位置，已拒絕檔案管理")?;
    let location = tokio::task::spawn_blocking(move || {
        store.get_location_for_source(&comic_id, &source_id, &relative_path)
    })
    .await
    .map_err(|error| error.to_string())??;
    let smb_config = state
        .smb_config
        .read()
        .map_err(|_| "NAS 設定鎖定失敗")?
        .clone();
    if state::is_smb_source_id(&location.source_id) {
        if let Err(reason) = commerce::require_pro(&app_handle).await {
            // Inspecting the library must not trigger a purchase sheet or a NAS probe.
            // Recovery remains available through its separate, ungated command.
            return Ok(file_ops::FileCapability {
                source_kind: location.source_id.clone(),
                online: location.online,
                expected_fingerprint: None,
                can_reveal: false,
                can_rename: false,
                can_move: false,
                can_trash: false,
                reason: Some(reason),
            });
        }
    }
    Ok(file_ops::capability_with_smb_config(&location, smb_config).await)
}

#[tauri::command]
async fn mutate_comic_file(
    request: file_ops::FileMutationRequest,
    state: State<'_, Arc<AppState>>,
    app_handle: AppHandle,
) -> Result<file_ops::FileMutationResult, String> {
    let _guard = state.file_lifecycle.lock().await;
    let _catalog_sync = state.catalog_sync.lock().await;
    let store = catalog_store(&state)?;
    let requested_id = request.comic_id.clone();
    let smb = state
        .smb_config
        .read()
        .map_err(|_| "NAS 設定鎖定失敗")?
        .clone();
    let location_store = store.clone();
    let location_id = requested_id.clone();
    let location_source = request
        .source_id
        .clone()
        .ok_or("缺少漫畫來源識別，已拒絕檔案操作")?;
    let location_path = request
        .relative_path
        .clone()
        .ok_or("缺少漫畫來源位置，已拒絕檔案操作")?;
    let location = tokio::task::spawn_blocking(move || {
        location_store.get_location_for_source(&location_id, &location_source, &location_path)
    })
    .await
    .map_err(|error| error.to_string())??;
    if state::is_smb_source_id(&location.source_id) {
        commerce::require_pro(&app_handle).await?;
    }
    let target_source_id = location.source_id.clone();
    let target_before_relative_path = location.relative_path.clone();
    let result = file_ops::mutate(&store, smb, request).await?;
    let lookup_store = store.clone();
    let lookup_id = result.comic_id.clone();
    let lookup_source = target_source_id.clone();
    let lookup_path = result.relative_path.clone();
    let refreshed = tokio::task::spawn_blocking(move || {
        lookup_store.get_runtime_item_for_source_path(&lookup_id, &lookup_source, &lookup_path)
    })
    .await
    .map_err(|error| format!("漫畫位置刷新工作失敗：{error}"))
    .and_then(|result| result.map_err(|error| format!("漫畫位置刷新工作失敗：{error}")));
    let scan_status = refresh_file_operation_state(
        state.inner(),
        &target_source_id,
        &target_before_relative_path,
        result.action == "trash",
        refreshed,
    )
    .await;
    use tauri::Emitter;
    let _ = app_handle.emit("scan-progress", scan_status);
    let _ = app_handle.emit("library-changed", 0usize);
    let _ = app_handle.emit("catalog-changed", 0usize);
    Ok(result)
}

#[tauri::command]
async fn undo_comic_file_operation(
    token: String,
    state: State<'_, Arc<AppState>>,
    app_handle: AppHandle,
) -> Result<file_ops::FileMutationResult, String> {
    let _guard = state.file_lifecycle.lock().await;
    let _catalog_sync = state.catalog_sync.lock().await;
    let store = catalog_store(&state)?;
    let operation_store = store.clone();
    let operation_token = token.clone();
    let operation = tokio::task::spawn_blocking(move || {
        operation_store.file_operation_for_undo(&operation_token)
    })
    .await
    .map_err(|error| format!("檔案操作紀錄查詢失敗：{error}"))??;
    let target_source_id = operation.source_id.clone();
    let target_before_relative_path = operation
        .after_relative_path
        .clone()
        .ok_or("操作沒有可還原位置")?;
    let smb = state
        .smb_config
        .read()
        .map_err(|_| "NAS 設定鎖定失敗")?
        .clone();
    let result = file_ops::undo(&store, smb, &token).await?;
    let lookup_store = store.clone();
    let lookup_id = result.comic_id.clone();
    let lookup_source = target_source_id.clone();
    let lookup_path = result.relative_path.clone();
    let refreshed = tokio::task::spawn_blocking(move || {
        lookup_store.get_runtime_item_for_source_path(&lookup_id, &lookup_source, &lookup_path)
    })
    .await
    .map_err(|error| format!("漫畫位置刷新工作失敗：{error}"))
    .and_then(|result| result.map_err(|error| format!("漫畫位置刷新工作失敗：{error}")));
    let scan_status = refresh_file_operation_state(
        state.inner(),
        &target_source_id,
        &target_before_relative_path,
        false,
        refreshed,
    )
    .await;
    use tauri::Emitter;
    let _ = app_handle.emit("scan-progress", scan_status);
    let _ = app_handle.emit("library-changed", 0usize);
    let _ = app_handle.emit("catalog-changed", 0usize);
    Ok(result)
}

#[tauri::command]
async fn trash_page(
    comic_id: String,
    page_index: usize,
    source_id: Option<String>,
    relative_path: Option<String>,
    expected_page_name: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    // Keep the command registered for future clients, but do not expose
    // pathname-based deletion until a safe page journal can bind the opened
    // page identity to the filesystem mutation atomically.
    require_safe_single_page_trash()?;
    let _bookmark_lifecycle = state.bookmark_lifecycle.lock().await;
    let _file_lifecycle = state.file_lifecycle.lock().await;
    let source_id = source_id.ok_or("缺少漫畫來源識別，已拒絕刪除頁面")?;
    let relative_path = relative_path.ok_or("缺少漫畫來源位置，已拒絕刪除頁面")?;
    let expected_page_name = expected_page_name.ok_or("缺少預期頁面識別，已拒絕刪除頁面")?;
    let store = catalog_store(&state)?;
    let lookup_id = comic_id.clone();
    let lookup_source = source_id.clone();
    let lookup_path = relative_path.clone();
    let item = tokio::task::spawn_blocking(move || {
        let location = store.get_location_for_source(&lookup_id, &lookup_source, &lookup_path)?;
        let items = store.get_runtime_items_for_source(&lookup_id, &lookup_source)?;
        let item = unique_catalog_runtime_item_for_operation(items)?
            .ok_or_else(|| "找不到已登記的漫畫位置".to_string())?;
        if item.relative_path != location.relative_path {
            return Err("漫畫來源位置已變更，已拒絕刪除頁面".to_string());
        }
        Ok(item)
    })
    .await
    .map_err(|error| format!("漫畫位置查詢失敗: {error}"))??;
    if item.r#type == "offline" {
        return Err("漫畫來源目前離線".into());
    }
    if state::is_smb_source_id(&item.source_id) {
        return Err("NAS 壓縮檔不支援刪除單頁".into());
    }
    // Source changes and bookmark removal share this gate. Keep permission
    // validation and deletion in the same lifecycle, including blocking I/O.
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        if !state.active_reader_matches_locked(&comic_id, &item.source_id) {
            return Err("目前閱讀器未綁定這個漫畫來源，為避免誤刪已停止操作".into());
        }
        let scan_dir = state.scan_dir.read().unwrap().clone();
        let bookmarks = state.external_bookmarks.read().unwrap().clone();
        let active = state.active_bookmarks.lock().unwrap().clone();
        let canon_full = authorized_page_comic_path(&item, &scan_dir, &bookmarks, &active)?;
        if canon_full.is_dir() {
            let images = crate::utils::get_folder_images(&canon_full);
            let opened = state.opened_comic_files.read().unwrap();
            let registered_pages = opened.get(&comic_id).ok_or("請先開啟漫畫再刪除頁面")?;
            if registered_pages.len() != images.len()
                || registered_pages
                    .iter()
                    .zip(&images)
                    .any(|(registered, current)| {
                        Path::new(registered).canonicalize().ok().as_ref()
                            != current.canonicalize().ok().as_ref()
                    })
            {
                return Err("漫畫頁面已變更，請重新開啟後再刪除".into());
            }
            drop(opened);
            if page_index < images.len() {
                let target = expected_trash_page_path(&images, page_index, &expected_page_name)?;
                let canonical_target = target
                    .canonicalize()
                    .map_err(|error| format!("頁面路徑無效: {error}"))?;
                if !canonical_target.starts_with(&canon_full) || !canonical_target.is_file() {
                    return Err("頁面超出已登記漫畫資料夾".into());
                }
                #[cfg(not(target_os = "ios"))]
                trash::delete(&canonical_target).map_err(|error| error.to_string())?;
                #[cfg(target_os = "ios")]
                {
                    let parent = canon_full.parent().ok_or("漫畫資料夾沒有可用父層")?;
                    let parent_dir =
                        cap_std::fs::Dir::open_ambient_dir(parent, cap_std::ambient_authority())
                            .map_err(|error| format!("無法開啟漫畫父資料夾: {error}"))?;
                    let quarantine_path = Path::new(".gai-quarantine").join("pages");
                    parent_dir
                        .create_dir_all(&quarantine_path)
                        .map_err(|error| format!("無法建立隔離區: {error}"))?;
                    let quarantine_dir = parent_dir
                        .open_dir(&quarantine_path)
                        .map_err(|error| format!("隔離區無效: {error}"))?;
                    let source_dir = cap_std::fs::Dir::open_ambient_dir(
                        &canon_full,
                        cap_std::ambient_authority(),
                    )
                    .map_err(|error| format!("無法開啟漫畫資料夾: {error}"))?;
                    let filename = canonical_target.file_name().ok_or("頁面檔名無效")?;
                    let display_name = filename.to_string_lossy();
                    let destination = format!("{}-{display_name}", uuid::Uuid::new_v4());
                    source_dir
                        .rename(filename, &quarantine_dir, &destination)
                        .map_err(|error| format!("無法將頁面移入隔離區: {error}"))?;
                }

                // Invalidate page responses that were resolved against the
                // pre-delete index. The next reader request must be opened
                // against the updated page list and expected page identity.
                state
                    .reader_generation
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                {
                    let mut opened = state.opened_comic_files.write().unwrap();
                    if let Some(files) = opened.get_mut(&comic_id) {
                        if page_index < files.len() {
                            files.remove(page_index);
                        }
                    }
                }
                // An in-flight preload still uses the old page indexes. Cancel it
                // before clearing rather than cloning/reindexing up to a GiB of data.
                state
                    .preload_generation
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                state.ram_cache_pool.lock().unwrap().remove(&comic_id);
                state.ram_cache_revisions.lock().unwrap().remove(&comic_id);

                return Ok(serde_json::json!({ "success": true }));
            }
        } else {
            return Err("無法刪除壓縮檔內的單一頁面！".into());
        }

        Ok(serde_json::json!({ "success": false }))
    })
    .await
    .map_err(|error| format!("刪除頁面背景工作失敗: {error}"))?
}

fn require_safe_single_page_trash() -> Result<(), String> {
    Err("刪除單頁暫不提供：安全頁面日誌尚未完成，為避免誤刪目前不會刪除檔案".into())
}

fn expected_trash_page_path(
    images: &[PathBuf],
    page_index: usize,
    expected_page_name: &str,
) -> Result<PathBuf, String> {
    let target = images
        .get(page_index)
        .ok_or_else(|| "頁面超出已登記漫畫資料夾".to_string())?;
    let actual_page_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "頁面檔名無效".to_string())?;
    if actual_page_name != expected_page_name {
        return Err("漫畫頁面已變更，已拒絕刪除頁面".into());
    }
    Ok(target.clone())
}

fn authorized_page_comic_path(
    item: &ComicItem,
    scan_dir: &str,
    bookmarks: &[state::ExternalBookmark],
    active: &std::collections::HashMap<String, String>,
) -> Result<std::path::PathBuf, String> {
    let root = if let Some(bookmark) = item.external_bookmark.as_deref() {
        if !bookmarks.iter().any(|entry| entry.bookmark == bookmark)
            || item.source_id != scanner::external_source_id(bookmark)
        {
            return Err("外部漫畫來源已移除，請重新加入資料夾".into());
        }
        active
            .get(bookmark)
            .ok_or("外部資料夾權限尚未啟用")?
            .as_str()
    } else {
        if scan_dir.is_empty() || item.source_id != scanner::local_source_id(Path::new(scan_dir)) {
            return Err("漫畫已不屬於目前的掃描目錄".into());
        }
        scan_dir
    };
    let root = Path::new(root)
        .canonicalize()
        .map_err(|error| format!("授權目錄無效: {error}"))?;
    let path = item
        .source_path
        .as_deref()
        .ok_or("漫畫沒有可修改的已登記位置")?;
    let path = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("漫畫路徑無效: {error}"))?;
    if !path.starts_with(&root) {
        return Err("漫畫路徑超出目前授權範圍".into());
    }
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoverySourceAuthorization {
    generation: u64,
    identity: String,
}

fn recovery_external_bookmark(state: &AppState, comic: &ComicItem) -> Result<String, String> {
    if !state
        .external_bookmarks_readable
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("外部來源清單目前無法讀取，稍後可重試".into());
    }
    let bookmarks = state
        .external_bookmarks
        .read()
        .map_err(|_| "外部來源清單鎖定失敗".to_string())?;
    let mut matches = bookmarks
        .iter()
        .filter(|item| scanner::external_source_id(&item.bookmark) == comic.source_id);
    let bookmark = matches
        .next()
        .map(|item| item.bookmark.clone())
        .ok_or_else(|| "外部漫畫來源目前未授權，重新加入後可重試".to_string())?;
    if matches.next().is_some()
        || comic
            .external_bookmark
            .as_deref()
            .is_some_and(|saved| saved != bookmark)
    {
        return Err("外部漫畫來源授權識別不唯一，稍後可重試".into());
    }
    Ok(bookmark)
}

fn current_recovery_source_identity(state: &AppState, comic: &ComicItem) -> Result<String, String> {
    if state::is_smb_source_id(&comic.source_id) {
        let config = state
            .smb_config
            .read()
            .map_err(|_| "SMB 設定鎖定失敗".to_string())?
            .clone()
            .ok_or_else(|| "SMB 來源目前未授權，請重新連線後重試".to_string())?;
        if !state::smb_source_matches_config(&comic.source_id, &config) {
            return Err("SMB 來源目前未授權，請重新連線後重試".into());
        }
        return Ok(format!("smb:{}", comic.source_id));
    }

    if comic.source_id.starts_with("external:") {
        let bookmark = recovery_external_bookmark(state, comic)?;
        let path = comic
            .source_path
            .as_deref()
            .map(Path::new)
            .ok_or_else(|| "外部漫畫來源目前未啟用，重新掃描後可重試".to_string())?;
        let active_root = state
            .active_bookmarks
            .lock()
            .map_err(|_| "外部來源權限鎖定失敗".to_string())?
            .get(&bookmark)
            .cloned()
            .ok_or_else(|| "外部漫畫來源目前未啟用，重新掃描後可重試".to_string())?;
        // Catalog rows intentionally do not persist security-scoped bookmark
        // values. Rehydrate only from the current authoritative bookmark list,
        // then let the normal capability gate verify that path is beneath the
        // active root. Never trust a journal or stale catalog bookmark value.
        let mut authorized_comic = comic.clone();
        authorized_comic.external_bookmark = Some(bookmark.clone());
        protocol::external_bookmark_capability(&authorized_comic, path, state)
            .map_err(|_| "外部漫畫來源目前未授權或未啟用，稍後可重試".to_string())?;
        return Ok(format!("external:{bookmark}\0{active_root}"));
    }

    #[cfg(test)]
    if state
        .progress_recovery_test_sources
        .lock()
        .is_ok_and(|sources| sources.contains(&comic.source_id))
    {
        // Existing recovery unit fixtures use synthetic source IDs and paths;
        // authorization behavior is exercised separately with real roots.
        return Ok(format!("test-local:{}", comic.source_id));
    }

    let scan_dir = state
        .scan_dir
        .read()
        .map_err(|_| "漫畫目錄設定鎖定失敗".to_string())?
        .clone();
    if scan_dir.is_empty()
        || !protocol::local_source_matches_scan_dir(comic, &scan_dir)
        || protocol::is_legacy_local_source_id(&comic.source_id)
    {
        return Err("漫畫來源目前不屬於已設定的掃描目錄，稍後可重試".into());
    }
    let relative = Path::new(&comic.relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("漫畫來源目前未授權，稍後可重試".into());
    }
    let expected = Path::new(&scan_dir).join(relative);
    let actual = comic
        .source_path
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| "漫畫來源目前未啟用，重新掃描後可重試".to_string())?;
    if actual != expected {
        return Err("漫畫來源目前不屬於已設定的掃描目錄，稍後可重試".into());
    }
    Ok(format!("local:{}", comic.source_id))
}

fn recovery_source_metadata(
    state: &AppState,
    comic: &ComicItem,
) -> Result<std::fs::Metadata, String> {
    #[cfg(test)]
    if state
        .progress_recovery_test_sources
        .lock()
        .is_ok_and(|sources| sources.contains(&comic.source_id))
    {
        let path = comic
            .source_path
            .as_deref()
            .map(Path::new)
            .ok_or_else(|| "來源位置缺少實際路徑，已保留待復原紀錄".to_string())?;
        return std::fs::symlink_metadata(path)
            .map_err(|_| "原漫畫位置目前無法驗證，已保留待復原紀錄".to_string());
    }

    let metadata = if comic.source_id.starts_with("external:") {
        let bookmark = recovery_external_bookmark(state, comic)?;
        let mut authorized_comic = comic.clone();
        authorized_comic.external_bookmark = Some(bookmark);
        let path = comic
            .source_path
            .as_deref()
            .map(Path::new)
            .ok_or_else(|| "外部漫畫來源目前未啟用，重新掃描後可重試".to_string())?;
        let (root, relative) =
            protocol::external_bookmark_capability(&authorized_comic, path, state)
                .map_err(|_| "外部漫畫來源目前未授權或未啟用，稍後可重試".to_string())?;
        protocol::symlink_metadata_from_capability(&root, &relative)
    } else {
        let scan_dir = state
            .scan_dir
            .read()
            .map_err(|_| "漫畫目錄設定鎖定失敗".to_string())?
            .clone();
        if scan_dir.is_empty()
            || !protocol::local_source_matches_scan_dir(comic, &scan_dir)
            || protocol::is_legacy_local_source_id(&comic.source_id)
        {
            return Err("漫畫來源目前不屬於已設定的掃描目錄，稍後可重試".into());
        }
        let relative = Path::new(&comic.relative_path);
        if relative.as_os_str().is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("漫畫來源目前未授權，稍後可重試".into());
        }
        let expected = Path::new(&scan_dir).join(relative);
        if comic.source_path.as_deref().map(Path::new) != Some(expected.as_path()) {
            return Err("漫畫來源目前不屬於已設定的掃描目錄，稍後可重試".into());
        }
        let root = cap_std::fs::Dir::open_ambient_dir(&scan_dir, cap_std::ambient_authority())
            .map_err(|_| "漫畫來源目前無法安全開啟，稍後可重試".to_string())?;
        protocol::symlink_metadata_from_capability(&root, relative)
    }
    .map_err(|_| "原漫畫位置目前無法在授權目錄內安全驗證，已保留待復原紀錄".to_string())?;
    Ok(metadata)
}

async fn recovery_source_authorization_snapshot(
    state: &Arc<AppState>,
    comic: &ComicItem,
) -> Result<RecoverySourceAuthorization, String> {
    let _lease = state
        .source_authorization_lifecycle
        .clone()
        .read_owned()
        .await;
    let identity = current_recovery_source_identity(state, comic)?;
    Ok(RecoverySourceAuthorization {
        generation: state
            .source_authorization_generation
            .load(std::sync::atomic::Ordering::Acquire),
        identity,
    })
}

fn verify_recovery_source_authorization(
    state: &AppState,
    comic: &ComicItem,
    expected: &RecoverySourceAuthorization,
) -> Result<(), String> {
    let generation = state
        .source_authorization_generation
        .load(std::sync::atomic::Ordering::Acquire);
    if generation != expected.generation
        || current_recovery_source_identity(state, comic)? != expected.identity
    {
        return Err("漫畫來源授權在復原驗證期間已變更，稍後可重試".into());
    }
    Ok(())
}

fn save_imported_photo_to_root(
    scan_dir: &Path,
    filename: &str,
    data: &[u8],
    timestamp_millis: i64,
    timestamp_micros: i64,
) -> Result<(), String> {
    if data.is_empty() || data.len() > MAX_IMPORTED_PHOTO_BYTES {
        return Err("匯入圖片必須介於 1 byte 與 64 MiB".into());
    }
    let scan_root = scan_dir
        .canonicalize()
        .map_err(|error| format!("掃描目錄無效: {error}"))?;
    let root = cap_std::fs::Dir::open_ambient_dir(&scan_root, cap_std::ambient_authority())
        .map_err(|error| format!("無法開啟掃描目錄: {error}"))?;
    let import_dir = Path::new("相簿匯入").join(format!("匯入_{}", timestamp_millis / 100000));
    root.create_dir_all(&import_dir)
        .map_err(|error| format!("無法建立匯入目錄: {error}"))?;
    let import_handle = root
        .open_dir(&import_dir)
        .map_err(|error| format!("無法開啟匯入目錄: {error}"))?;
    write_import_file(&import_handle, filename, data, timestamp_micros)
}

fn import_photo_payload(filename_header: &str, bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    use base64::Engine as _;
    if bytes.is_empty() || bytes.len() > MAX_IMPORTED_PHOTO_BYTES {
        return Err("匯入圖片必須介於 1 byte 與 64 MiB".into());
    }
    if filename_header.len() > 512 {
        return Err("匯入檔名過長".into());
    }
    let filename = base64::engine::general_purpose::STANDARD
        .decode(filename_header)
        .map_err(|_| "匯入檔名格式無效")?;
    let filename = String::from_utf8(filename).map_err(|_| "匯入檔名必須使用 UTF-8")?;
    if filename.len() > 200 || !is_safe_import_filename(&filename) {
        return Err("匯入檔名不安全或過長".into());
    }
    Ok((filename, bytes.to_vec()))
}

#[tauri::command]
async fn import_photo_bytes(
    state: State<'_, Arc<AppState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("匯入圖片需要二進位資料".into());
    };
    let filename_header = request
        .headers()
        .get("x-gai-filename")
        .and_then(|value| value.to_str().ok())
        .ok_or("匯入圖片缺少檔名")?;
    // Validate the borrowed transport body before making the one owned copy
    // needed by the background writer.
    let (filename, data) = import_photo_payload(filename_header, bytes)?;
    save_imported_photo(state, filename, data).await
}

#[tauri::command]
async fn save_imported_photo(
    state: State<'_, Arc<AppState>>,
    filename: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let scan_dir = state.scan_dir.read().unwrap().clone();
    if scan_dir.is_empty() {
        return Err("掃描目錄尚未設定".into());
    }
    let now = chrono::Utc::now();
    tokio::task::spawn_blocking(move || {
        save_imported_photo_to_root(
            Path::new(&scan_dir),
            &filename,
            &data,
            now.timestamp_millis(),
            now.timestamp_micros(),
        )
    })
    .await
    .map_err(|error| format!("匯入圖片背景工作失敗: {error}"))?
}

fn is_safe_import_filename(filename: &str) -> bool {
    let path = Path::new(filename);
    !filename.is_empty()
        && !filename.contains('/')
        && !filename.contains('\\')
        && !filename.contains(':')
        && !filename.chars().any(char::is_control)
        && path.components().count() == 1
        && matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
        && path.file_name().and_then(|name| name.to_str()) == Some(filename)
}

fn write_import_file(
    import_dir: &cap_std::fs::Dir,
    filename: &str,
    data: &[u8],
    timestamp_micros: i64,
) -> Result<(), String> {
    if !is_safe_import_filename(filename) {
        return Err("匯入檔名不安全".into());
    }

    for attempt in 0..100_u32 {
        let unique_filename = if attempt == 0 {
            format!("{timestamp_micros}_{filename}")
        } else {
            format!("{timestamp_micros}_{attempt}_{filename}")
        };
        let mut file = match import_dir.open_with(
            &unique_filename,
            cap_std::fs::OpenOptions::new().write(true).create_new(true),
        ) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("無法建立匯入檔案: {error}")),
        };

        if let Err(error) = file.write_all(data) {
            let _ = import_dir.remove_file(&unique_filename);
            return Err(format!("無法寫入匯入檔案: {error}"));
        }
        file.sync_all()
            .map_err(|error| format!("無法同步匯入檔案: {error}"))?;
        return Ok(());
    }

    Err("匯入檔案名稱碰撞，請稍後再試".into())
}

fn write_progress_file(scan_dir: &Path, id: &str, progress: Progress) -> Result<(), String> {
    let progress_file = scan_dir.join(".comic_progress.json");
    let mut all_progress: std::collections::HashMap<String, Progress> =
        match std::fs::read_to_string(&progress_file) {
            Ok(content) => serde_json::from_str(&content)
                .map_err(|error| format!("進度檔已損壞，為避免覆蓋資料已取消儲存: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::collections::HashMap::new()
            }
            Err(error) => return Err(format!("無法讀取進度檔: {error}")),
        };
    all_progress.insert(id.to_string(), progress);

    let json =
        serde_json::to_vec(&all_progress).map_err(|error| format!("無法序列化進度: {error}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_file = scan_dir.join(format!(
        ".comic_progress.json.tmp.{}_{nanos}",
        std::process::id()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp_file)
            .map_err(|error| format!("無法建立進度暫存檔: {error}"))?;
        file.write_all(&json)
            .map_err(|error| format!("無法寫入進度暫存檔: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("無法同步進度暫存檔: {error}"))?;
        std::fs::rename(&tmp_file, &progress_file)
            .map_err(|error| format!("無法原子替代進度檔: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_file);
    }
    result
}

async fn comic_progress_lock(state: &AppState, comic_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = state.progress_locks.lock().await;
    locks
        .entry(comic_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Serialize a reader publication with progress writes for that exact
/// source/id. Lock order matches save_progress: per-comic progress lock, then
/// comic_lifecycle. The closure must only perform synchronous state changes.
#[cfg(test)]
async fn with_comic_progress_lifecycle<T, F>(
    state: &Arc<AppState>,
    progress_identity: &str,
    publish: F,
) -> T
where
    F: FnOnce() -> T,
{
    let progress_lock = comic_progress_lock(state, progress_identity).await;
    let _progress_lifecycle = progress_lock.lock().await;
    let _reader_lifecycle = state.comic_lifecycle.lock().unwrap();
    publish()
}

/// Prepare a source-scoped progress snapshot while holding the same per-book
/// lifecycle used by SQLite saves, then publish it under the synchronous reader
/// lifecycle gate. The std mutex is acquired only after the final await.
async fn with_comic_progress_lifecycle_prepared<T, R, Prepare, Fut, Publish>(
    state: &Arc<AppState>,
    progress_identity: &str,
    prepare: Prepare,
    publish: Publish,
) -> Result<R, String>
where
    Prepare: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
    Publish: FnOnce(T) -> Result<R, String>,
{
    let progress_lock = comic_progress_lock(state, progress_identity).await;
    let _progress_lifecycle = progress_lock.lock().await;
    let prepared = prepare().await?;
    let _reader_lifecycle = state.comic_lifecycle.lock().unwrap();
    publish(prepared)
}

/// Read the progress for the exact location selected by `open_comic`.
/// Newly discovered, not-yet-indexed entries may use their exact in-memory
/// snapshot; catalog read failures and ambiguous in-memory matches stay errors.
async fn open_comic_progress_snapshot(
    state: &Arc<AppState>,
    comic: &ComicItem,
    verified_pages: usize,
    is_directory: bool,
) -> Result<Progress, String> {
    let id = comic.id.as_str();
    let source_id = comic.source_id.as_str();
    let relative_path = comic.relative_path.as_str();
    let store = state
        .catalog
        .read()
        .map_err(|_| "漫畫目錄鎖定失敗".to_string())?
        .clone();
    if let Some(store) = store {
        let register_comic = comic.clone();
        return tokio::task::spawn_blocking(move || {
            if let Some(item) = store.get_runtime_item_for_source_path(
                &register_comic.id,
                &register_comic.source_id,
                &register_comic.relative_path,
            )? {
                if item.source_id != register_comic.source_id
                    || item.relative_path != register_comic.relative_path
                {
                    return Err("目錄中的漫畫進度來源位置與目前漫畫不符".into());
                }
                return Ok(item.progress);
            }
            store.register_opened_location(&register_comic, verified_pages, is_directory)
        })
        .await
        .map_err(|error| format!("登記或讀取已驗證漫畫背景工作失敗：{error}"))?;
    }

    let comics = state.comics.lock().await;
    let mut exact = comics.iter().filter(|comic| {
        comic.id == id && comic.source_id == source_id && comic.relative_path == relative_path
    });
    let Some(item) = exact.next() else {
        return Err("找不到指定來源位置的漫畫進度".into());
    };
    if exact.next().is_some() {
        return Err("指定來源位置的漫畫進度不唯一".into());
    }
    Ok(item.progress.clone())
}

async fn progress_sequence_is_current(
    state: &AppState,
    comic_id: &str,
    sequence: Option<u64>,
) -> Result<(), String> {
    let Some(sequence) = sequence else {
        return Ok(());
    };
    catalog::validate_intent_sequence(sequence)?;
    let sequences = state.progress_sequences.lock().await;
    if sequences
        .get(comic_id)
        .is_some_and(|last| sequence <= *last)
    {
        return Err("閱讀進度請求已過期，已保留較新的進度".into());
    }
    Ok(())
}

async fn commit_progress_sequence(state: &AppState, comic_id: &str, sequence: Option<u64>) {
    if let Some(sequence) = sequence {
        state
            .progress_sequences
            .lock()
            .await
            .insert(comic_id.to_string(), sequence);
    }
}

/// Run the authoritative SQLite write in a detached task that owns the
/// per-comic lifecycle lock. Dropping the command future must not leave a
/// successful database write without its matching in-memory sequence fence.
async fn persist_progress_and_commit_sequence<F>(
    state: Arc<AppState>,
    progress_identity: String,
    sequence: Option<u64>,
    progress_lifecycle: tokio::sync::OwnedMutexGuard<()>,
    persist: F,
) -> Result<tokio::sync::OwnedMutexGuard<()>, String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(persist)
            .await
            .map_err(|error| format!("穩定進度儲存工作失敗: {error}"))?;
        if result.is_ok() {
            commit_progress_sequence(&state, &progress_identity, sequence).await;
        }
        result.map(|()| progress_lifecycle)
    })
    .await
    .map_err(|error| format!("進度儲存工作失敗: {error}"))?
}

fn progress_recovery_token_is_current(
    state: &AppState,
    id: &str,
    source_id: &str,
    request_token: &str,
) -> bool {
    state.progress_recovery_token(id, source_id).as_deref() == Some(request_token)
}

async fn recover_reading_progress_inner(
    state: &Arc<AppState>,
    data: SaveProgressRequest,
) -> Result<(), String> {
    recover_reading_progress_inner_with_smb_hash(state, data, |config, relative_path| {
        Box::pin(smb_remote_content_hash(config, relative_path))
    })
    .await
}

async fn recover_reading_progress_inner_with_smb_hash<F>(
    state: &Arc<AppState>,
    data: SaveProgressRequest,
    hash_smb_content: F,
) -> Result<(), String>
where
    F: for<'a> Fn(
        &'a state::SmbConfig,
        &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(u64, [u8; 32]), String>> + Send + 'a>,
    >,
{
    let id = data.id.trim().to_string();
    if id.is_empty() || id.len() > 4096 {
        return Err("閱讀進度漫畫識別碼格式不正確".into());
    }
    let source_id = data
        .source_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "手動復原進度必須指定 sourceId".to_string())?;
    if source_id != data.source_id.as_deref().unwrap_or_default() {
        return Err("閱讀進度來源識別碼格式不正確".into());
    }
    if photo_library::is_photo_album_id(&id) {
        return Err("照片相簿不支援漫畫閱讀進度復原".into());
    }
    let sequence = data
        .sequence
        .ok_or_else(|| "手動復原進度缺少序號，已保留待復原紀錄".to_string())?;
    let intent_sequence = data
        .intent_sequence
        .ok_or_else(|| "手動復原進度缺少原始閱讀意圖序號，已保留待復原紀錄".to_string())?;
    catalog::validate_intent_sequence(intent_sequence)?;
    let recovery_token = data
        .recovery_token
        .as_deref()
        .filter(|token| !token.is_empty() && token.len() <= 64)
        .ok_or_else(|| "待復原紀錄缺少原生開書 token，已保留待復原紀錄".to_string())?;
    let progress_identity = format!("{source_id}\0{id}");
    let progress_lock = comic_progress_lock(state, &progress_identity).await;
    let mut progress_lifecycle = Some(progress_lock.clone().lock_owned().await);
    let sequence_snapshot = state
        .progress_sequences
        .lock()
        .await
        .get(&progress_identity)
        .copied();
    progress_sequence_is_current(state, &progress_identity, Some(sequence)).await?;

    let store = state
        .catalog
        .read()
        .map_err(|_| "漫畫目錄鎖定失敗".to_string())?
        .clone()
        .ok_or_else(|| "漫畫目錄尚未初始化，已保留待復原紀錄".to_string())?;
    let query_store = store.clone();
    let lookup_id = id.clone();
    let lookup_source = source_id.to_string();
    let mut matches = tokio::task::spawn_blocking(move || {
        query_store.get_runtime_items_for_source(&lookup_id, &lookup_source)
    })
    .await
    .map_err(|error| format!("讀取來源漫畫位置背景工作失敗：{error}"))??;
    if matches.len() != 1 {
        return Err(if matches.is_empty() {
            "來源漫畫尚未進入目錄，已保留待復原紀錄".into()
        } else {
            "來源漫畫位置不唯一，已保留待復原紀錄".into()
        });
    }
    let comic = matches.pop().unwrap();
    if comic.id != id || comic.source_id != source_id {
        return Err("來源漫畫識別不一致，已保留待復原紀錄".into());
    }
    let source_authorization = recovery_source_authorization_snapshot(state, &comic).await?;
    let memory_evidence = state.progress_recovery_evidence(&id, source_id, &comic.relative_path);
    let evidence_was_in_memory = memory_evidence.is_some();
    let evidence = if let Some(evidence) = memory_evidence {
        Some(evidence)
    } else {
        let lookup_store = store.clone();
        let lookup_id = id.clone();
        let lookup_source = source_id.to_string();
        let lookup_path = comic.relative_path.clone();
        let lookup_token = recovery_token.to_string();
        tokio::task::spawn_blocking(move || {
            lookup_store.load_progress_recovery_evidence(
                &lookup_id,
                &lookup_source,
                &lookup_path,
                &lookup_token,
            )
        })
        .await
        .map_err(|error| format!("讀取原生開書憑證背景工作失敗：{error}"))??
    };
    let evidence_snapshot = evidence.clone();
    let trusted_total = if let Some(evidence) = evidence {
        if evidence.total_pages == 0
            || evidence.source_id != source_id
            || evidence.token != recovery_token
        {
            return Err("READING_PROGRESS_RECOVERY_MANUAL_CHECK: 原生開書憑證不符".into());
        }
        let revision = evidence.revision.ok_or_else(|| {
            "READING_PROGRESS_RECOVERY_MANUAL_CHECK: 原生開書身分證據不存在".to_string()
        })?;
        if state::is_smb_source_id(source_id) {
            let expected_hash = evidence.smb_content_hash.ok_or_else(|| {
                "READING_PROGRESS_RECOVERY_MANUAL_CHECK: SMB 原生內容憑證不存在".to_string()
            })?;
            let smb_config = state
                .smb_config
                .read()
                .map_err(|_| "SMB 設定鎖定失敗".to_string())?
                .clone()
                .ok_or_else(|| "未設定 SMB 連線，已保留待復原紀錄".to_string())?;
            if !state::smb_source_matches_config(source_id, &smb_config) {
                return Err("SMB 來源端點已變更，已保留待復原紀錄".into());
            }
            // SMB hashing may wait on up to the full bounded archive transfer.
            // Release the per-book publication gate so close/reopen can proceed,
            // then reacquire it and prove the entire recovery snapshot is still
            // current before allowing the eventual SQLite write.
            drop(progress_lifecycle.take());
            let (observed_bytes, observed_hash) =
                hash_smb_content(&smb_config, &comic.relative_path).await?;
            progress_lifecycle = Some(progress_lock.clone().lock_owned().await);

            let current_sequence = state
                .progress_sequences
                .lock()
                .await
                .get(&progress_identity)
                .copied();
            if current_sequence != sequence_snapshot {
                return Err(
                    "READING_PROGRESS_RECOVERY_MANUAL_CHECK: 等待來源驗證期間閱讀進度已改變".into(),
                );
            }
            progress_sequence_is_current(state, &progress_identity, Some(sequence)).await?;
            if evidence_was_in_memory
                && state.progress_recovery_evidence(&id, source_id, &comic.relative_path)
                    != evidence_snapshot
            {
                return Err(
                    "READING_PROGRESS_RECOVERY_MANUAL_CHECK: 等待來源驗證期間開書憑證已改變".into(),
                );
            }

            let verify_store = store.clone();
            let verify_id = id.clone();
            let verify_source = source_id.to_string();
            let mut current_matches = tokio::task::spawn_blocking(move || {
                verify_store.get_runtime_items_for_source(&verify_id, &verify_source)
            })
            .await
            .map_err(|error| format!("重新確認來源漫畫背景工作失敗：{error}"))??;
            if current_matches.len() != 1 {
                return Err(
                    "READING_PROGRESS_RECOVERY_MANUAL_CHECK: 等待來源驗證期間漫畫位置已改變".into(),
                );
            }
            let current_comic = current_matches.pop().unwrap();
            if current_comic.id != id
                || current_comic.source_id != source_id
                || current_comic.relative_path != comic.relative_path
                || current_comic.progress.current_page != comic.progress.current_page
                || current_comic.progress.total_pages != comic.progress.total_pages
                || current_comic.progress.updated_at != comic.progress.updated_at
            {
                return Err(
                    "READING_PROGRESS_RECOVERY_MANUAL_CHECK: 等待來源驗證期間漫畫位置已改變".into(),
                );
            }

            let current_smb_config = state
                .smb_config
                .read()
                .map_err(|_| "SMB 設定鎖定失敗".to_string())?
                .clone()
                .ok_or_else(|| "SMB 設定已移除，已保留待復原紀錄".to_string())?;
            if current_smb_config.host != smb_config.host
                || current_smb_config.share != smb_config.share
                || current_smb_config.username != smb_config.username
                || current_smb_config.password != smb_config.password
                || !state::smb_source_matches_config(source_id, &current_smb_config)
            {
                return Err("SMB 設定於來源驗證期間已變更，已保留待復原紀錄".into());
            }
            if observed_bytes != revision.len
                || !smb_recovery_content_matches(expected_hash, observed_hash)
            {
                return Err("SMB 原漫畫內容已變更，已保留待復原紀錄".into());
            }
        } else {
            if evidence.smb_content_hash.is_some() {
                return Err("進度來源版本證據類型不符，已保留待復原紀錄".into());
            }
            let metadata_comic = comic.clone();
            let metadata_state = state.clone();
            let metadata = tokio::task::spawn_blocking(move || {
                recovery_source_metadata(&metadata_state, &metadata_comic)
            })
            .await
            .map_err(|error| format!("原漫畫位置驗證背景工作失敗：{error}"))??;
            if (!metadata.is_file() && !metadata.is_dir())
                || metadata.file_type().is_symlink()
                || state::SourceRevision::from_std_metadata(&metadata) != revision
            {
                return Err("原漫畫位置已變更，已保留待復原紀錄".into());
            }
        }
        evidence.total_pages
    } else {
        return Err("READING_PROGRESS_RECOVERY_MANUAL_CHECK: 原生開書頁數證據不存在".into());
    };
    let requested_total = usize::try_from(data.total_pages)
        .map_err(|_| "待復原總頁數超出平台上限，已保留待復原紀錄")?;
    let current_page = usize::try_from(data.current_page)
        .map_err(|_| "待復原頁碼超出平台上限，已保留待復原紀錄")?;
    if requested_total != trusted_total || requested_total == 0 || current_page >= trusted_total {
        return Err("待復原頁數與可信漫畫頁數不符，已保留待復原紀錄".into());
    }
    let (current_page, total_pages, percent) =
        normalize_progress_values(current_page as u64, trusted_total as u64)?;
    let progress = Progress {
        current_page,
        total_pages,
        percent,
        updated_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    let save_store = store.clone();
    let save_id = id.clone();
    let save_source = source_id.to_string();
    let save_relative_path = comic.relative_path.clone();
    let save_progress = progress.clone();
    let proof_revision = evidence_snapshot
        .as_ref()
        .and_then(|evidence| evidence.revision.clone())
        .ok_or_else(|| {
            "READING_PROGRESS_RECOVERY_MANUAL_CHECK: 原生開書身分證據不存在".to_string()
        })?;
    let proof_hash = evidence_snapshot
        .as_ref()
        .and_then(|evidence| evidence.smb_content_hash);
    let save_token = recovery_token.to_string();
    let source_authorization_lease = state
        .source_authorization_lifecycle
        .clone()
        .read_owned()
        .await;
    verify_recovery_source_authorization(state, &comic, &source_authorization)?;
    let progress_lifecycle = progress_lifecycle
        .take()
        .ok_or_else(|| "閱讀進度復原生命週期鎖定遺失".to_string())?;
    {
        // This is the recovery's reader-intent linearization point. A same-book
        // open already in flight must win even before it publishes new evidence;
        // an open starting afterwards waits to publish behind our progress lock.
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let pending_id = state.pending_open_id.lock().unwrap();
        let pending_source = state.pending_open_source_id.lock().unwrap();
        if pending_id.as_deref() == Some(id.as_str())
            && (pending_source.is_none() || pending_source.as_deref() == Some(source_id))
        {
            return Err("READING_PROGRESS_RECOVERY_MANUAL_CHECK: 此漫畫正在重新開啟".into());
        }
    }
    let _progress_lifecycle = persist_progress_and_commit_sequence(
        state.clone(),
        progress_identity.clone(),
        Some(sequence),
        progress_lifecycle,
        move || {
            let _source_authorization_lease = source_authorization_lease;
            save_store
                .recover_progress_for_source_location(catalog::ProgressRecoveryCommit {
                    identifier: &save_id,
                    source_id: &save_source,
                    relative_path: &save_relative_path,
                    token: &save_token,
                    revision: &proof_revision,
                    smb_content_hash: proof_hash,
                    total_pages: trusted_total,
                    current_page,
                    intent_sequence,
                    progress: &save_progress,
                })
                .map_err(|error| error.to_string())
        },
    )
    .await?;

    let committed_progress = {
        let read_store = store.clone();
        let read_id = id.clone();
        let read_source = source_id.to_string();
        let read_path = comic.relative_path.clone();
        tokio::task::spawn_blocking(move || {
            read_store.progress_for_source_location(&read_id, &read_source, &read_path)
        })
        .await
        .map_err(|error| format!("讀取已提交進度背景工作失敗：{error}"))??
        .ok_or_else(|| "已提交閱讀進度不存在".to_string())?
    };

    // Publish to memory only after SQLite confirms the exact source-scoped
    // location write. Never create a transient in-memory orphan.
    {
        let mut comics = state.comics.lock().await;
        let matching = comics
            .iter_mut()
            .filter(|item| {
                item.id == id
                    && item.source_id == source_id
                    && item.relative_path == comic.relative_path
            })
            .collect::<Vec<_>>();
        if matching.len() == 1 {
            let comic = matching.into_iter().next().unwrap();
            comic.progress = committed_progress.clone();
            comic.page_count = committed_progress.total_pages;
        }
    }

    let scan_dir = state.scan_dir.read().unwrap().clone();
    if source_id.starts_with("local:")
        && !scan_dir.is_empty()
        && source_id == scanner::local_source_id(Path::new(&scan_dir))
    {
        let _file_guard = state.progress_file_lock.lock().await;
        let dir = PathBuf::from(scan_dir);
        let sidecar_id = id.clone();
        let sidecar_progress = committed_progress.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || {
            write_progress_file(&dir, &sidecar_id, sidecar_progress)
        })
        .await
        .map_err(|error| format!("進度相容檔背景工作失敗：{error}"))?
        {
            eprintln!("⚠️ SQLite 進度已復原，但相容 sidecar 寫入失敗：{error}");
        }
    }
    Ok(())
}

#[tauri::command]
async fn recover_reading_progress(
    app_handle: AppHandle,
    data: SaveProgressRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if data
        .source_id
        .as_deref()
        .is_some_and(state::is_smb_source_id)
    {
        commerce::require_pro(&app_handle).await?;
    }
    recover_reading_progress_inner(state.inner(), data).await
}

#[tauri::command]
async fn save_progress(
    app_handle: AppHandle,
    data: SaveProgressRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let id = data.id.trim().to_string();
    if id.is_empty() || id.len() > 4096 {
        return Err("閱讀進度漫畫識別碼格式不正確".into());
    }
    let requested_source_id = data
        .source_id
        .as_deref()
        .map(str::trim)
        .filter(|source_id| !source_id.is_empty())
        .map(str::to_owned);
    if data.source_id.is_some() && requested_source_id.is_none() {
        return Err("閱讀進度來源識別碼格式不正確".into());
    }
    let scan_dir = state.scan_dir.read().unwrap().clone();
    let requested_source_id = normalize_requested_source_id(requested_source_id, &scan_dir);
    // Capture the validated active source before choosing the sequence lock.
    // Legacy requests without sourceId must still serialize per source; an
    // id-only sequence key would let A and B suppress each other's updates.
    let captured_source_id = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let active_source_id = state
            .active_comic_id
            .lock()
            .unwrap()
            .as_deref()
            .filter(|active_id| *active_id == id)
            .and_then(|_| state.active_comic_source_id.lock().unwrap().clone())
            .ok_or_else(|| "漫畫目前不是閱讀中的漫畫".to_string())?;
        if let Some(requested_source_id) = requested_source_id.as_deref() {
            if active_source_id != requested_source_id {
                return Err("閱讀進度來源已不是目前開啟的漫畫".into());
            }
        }
        active_source_id
    };
    if let Some(request_token) = data.recovery_token.as_deref() {
        if !progress_recovery_token_is_current(
            state.inner(),
            &id,
            &captured_source_id,
            request_token,
        ) {
            return Err("閱讀進度開書 token 已過期".into());
        }
    }
    let progress_identity = format!("{captured_source_id}\0{id}");
    let progress_lock = comic_progress_lock(state.inner(), &progress_identity).await;
    let progress_lifecycle = progress_lock.lock_owned().await;
    progress_sequence_is_current(state.inner(), &progress_identity, data.sequence).await?;
    // Keep the source selected by this lifecycle snapshot for the rest of
    // the write. Without this binding, B can reopen the same runtime ID
    // after the progress lock and the later catalogue lookup could silently
    // persist A's page count into B.
    let (requested_source_id, opened_total_pages) = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let active_source_id = state
            .active_comic_id
            .lock()
            .unwrap()
            .as_deref()
            .filter(|active_id| *active_id == id)
            .and_then(|_| state.active_comic_source_id.lock().unwrap().clone());
        if active_source_id.as_deref() != Some(captured_source_id.as_str()) {
            return Err("閱讀進度來源已不是目前開啟的漫畫".into());
        }
        // A same-source reopen can replace the page-count/revision evidence
        // while this request waits on its per-source lock. Recheck while
        // holding comic_lifecycle so the token snapshot is atomic with reopen.
        if let Some(request_token) = data.recovery_token.as_deref() {
            if !progress_recovery_token_is_current(
                state.inner(),
                &id,
                &captured_source_id,
                request_token,
            ) {
                return Err("閱讀進度開書 token 已過期".into());
            }
        }
        let opened_total_pages = state
            .opened_comic_files
            .read()
            .unwrap()
            .get(&id)
            .map(Vec::len);
        (Some(captured_source_id.clone()), opened_total_pages)
    };
    let total_pages = authoritative_total_pages(opened_total_pages, data.total_pages)?;
    let (current_page, total_pages, percent) =
        normalize_progress_values(data.current_page, total_pages)?;
    if photo_library::is_photo_album_id(&id) {
        let progress = Progress {
            current_page,
            total_pages,
            percent,
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        let _file_guard = state.progress_file_lock.lock().await;
        let photo_progress = {
            let stored = state.photo_progress.lock().await;
            let mut next = stored.clone();
            next.insert(id.clone(), progress);
            next
        };
        let directory = app_handle
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("無法取得照片進度目錄：{error}"))?;
        let persisted_progress = photo_progress.clone();
        tokio::task::spawn_blocking(move || {
            photo_library::persist_progress(&directory, &persisted_progress)
        })
        .await
        .map_err(|error| format!("照片進度背景工作失敗：{error}"))??;
        *state.photo_progress.lock().await = photo_progress;
        commit_progress_sequence(state.inner(), &progress_identity, data.sequence).await;
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let (progress, is_local_source) = {
        let comics = state.comics.lock().await;
        let matching = comics.iter().filter(|comic| {
            comic.id == id
                && requested_source_id
                    .as_deref()
                    .map(|source_id| comic.source_id == source_id)
                    .unwrap_or(true)
        });
        let matching = matching.collect::<Vec<_>>();
        if matching.is_empty() {
            return Err(if requested_source_id.is_some() {
                "漫畫來源與閱讀進度來源不匹配，已拒絕寫入".into()
            } else {
                "找不到閱讀中的漫畫，已拒絕寫入孤兒進度".into()
            });
        }
        if requested_source_id.is_none()
            && matching
                .iter()
                .map(|comic| comic.source_id.as_str())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                > 1
        {
            return Err("閱讀進度漫畫識別碼不唯一，請提供 sourceId".into());
        }
        let comic = matching[0];
        let progress = Progress {
            current_page,
            total_pages,
            percent,
            updated_at: Some(now),
        };
        (progress, comic.source_id.starts_with("local:"))
    };

    let store = catalog_store(&state)?;
    let identifier = id.clone();
    let source_id_for_save = requested_source_id.clone();
    let sqlite_progress = progress.clone();
    let intent_sequence = data.intent_sequence;
    let _progress_lifecycle = persist_progress_and_commit_sequence(
        state.inner().clone(),
        progress_identity.clone(),
        data.sequence,
        progress_lifecycle,
        move || {
            if let Some(source_id) = source_id_for_save.as_deref() {
                store.save_progress_for_source_with_intent(
                    &identifier,
                    source_id,
                    &sqlite_progress,
                    intent_sequence,
                )
            } else {
                store.save_progress(&identifier, &sqlite_progress)
            }
            .map_err(|error| error.to_string())
        },
    )
    .await?;

    // SQLite is authoritative. Only publish to the in-memory catalogue after
    // persistence succeeds, otherwise a failed write would display fake
    // progress until the next scan.
    {
        let mut comics = state.comics.lock().await;
        if let Some(comic) = comics.iter_mut().find(|comic| {
            comic.id == id
                && requested_source_id
                    .as_deref()
                    .map(|source_id| comic.source_id == source_id)
                    .unwrap_or(true)
        }) {
            comic.progress = progress.clone();
            comic.page_count = total_pages;
        }
    }

    let sidecar_matches_source = requested_source_id
        .as_deref()
        .map(|source_id| source_id == scanner::local_source_id(Path::new(&scan_dir)))
        .unwrap_or(true);
    if is_local_source && !scan_dir.is_empty() && sidecar_matches_source {
        let _file_guard = state.progress_file_lock.lock().await;
        let scan_dir = std::path::PathBuf::from(scan_dir);
        let progress_id = id.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || {
            write_progress_file(&scan_dir, &progress_id, progress)
        })
        .await
        .map_err(|error| format!("進度相容檔背景工作失敗: {error}"))?
        {
            eprintln!("⚠️ SQLite 進度已儲存，但相容 sidecar 寫入失敗：{error}");
        }
    }
    Ok(())
}

#[tauri::command]
async fn scan_library(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        scanner::start_background_scan(state_clone, app_handle).await;
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState::new());
    // 封面與閱讀頁各自限流，NAS 讀取／ZIP 解壓不可占住 WebView 回呼。
    let cover_workers = Arc::new(tokio::sync::Semaphore::new(2));
    let page_workers = Arc::new(tokio::sync::Semaphore::new(4));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_ios_folder::init())
        .manage(app_state.clone())
        .register_asynchronous_uri_scheme_protocol("gai", move |app, request, responder| {
            let handle = app.app_handle().clone();
            let workers = if protocol::is_thumbnail_request(request.uri()) {
                cover_workers.clone()
            } else {
                page_workers.clone()
            };
            tauri::async_runtime::spawn(async move {
                let result = match workers.acquire_owned().await {
                    Ok(permit) => tauri::async_runtime::spawn_blocking(move || {
                        let _permit = permit;
                        protocol::handle_comic_request(&handle, request)
                            .map_err(|error| error.to_string())
                    })
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result),
                    Err(error) => Err(error.to_string()),
                };
                responder.respond(result.unwrap_or_else(|error| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(error.into_bytes())
                        .unwrap()
                }));
            });
        })
        .setup(move |app| {
            state::register_process_state(&app_state);
            let catalog_dir = app
                .path()
                .app_local_data_dir()
                .map_err(std::io::Error::other)?;
            let catalog = catalog::CatalogStore::new(catalog_dir.join("catalog.sqlite3"))
                .map_err(std::io::Error::other)?;
            catalog
                .reconcile_file_operations()
                .map_err(std::io::Error::other)?;
            *app_state
                .catalog
                .write()
                .map_err(|_| std::io::Error::other("無法初始化漫畫目錄"))? = Some(catalog);
            if let Ok(photo_progress) = photo_library::load_progress(&catalog_dir) {
                *app_state.photo_progress.blocking_lock() = photo_progress;
            }
            if let Some(scan_dir) = load_persisted_scan_directory(&catalog_dir) {
                *app_state
                    .scan_dir
                    .write()
                    .map_err(|_| std::io::Error::other("無法載入漫畫目錄設定"))? = scan_dir;
            }
            match load_persisted_external_bookmarks(&catalog_dir) {
                Ok(bookmarks) => {
                    *app_state
                        .external_bookmarks
                        .write()
                        .map_err(|_| std::io::Error::other("無法載入外部資料夾授權"))? = bookmarks;
                }
                Err(error) => {
                    app_state
                        .external_bookmarks_readable
                        .store(false, std::sync::atomic::Ordering::Release);
                    log::warn!("外部來源清單暫時不可讀，保留現有目錄狀態：{error}");
                }
            }
            #[cfg(target_os = "ios")]
            {
                if let Ok(document_dir) = app.path().document_dir() {
                    let mut scan_dir = app_state.scan_dir.write().unwrap();
                    if scan_dir.is_empty() {
                        *scan_dir = document_dir.to_string_lossy().to_string();
                    } else {
                        let relocated = relocate_ios_documents(&scan_dir, &document_dir);
                        if relocated != *scan_dir {
                            *scan_dir = relocated;
                            if let Err(error) = persist_scan_directory(app.handle(), &scan_dir) {
                                log::warn!("本機書庫位置已更新，但設定暫時無法保存：{error}");
                            }
                        }
                    }
                }
            }

            let handle = app.handle().clone();
            let state_clone = app_state.clone();
            tauri::async_runtime::spawn(async move {
                scanner::start_background_scan(state_clone, handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_commerce,
            purchase_pro,
            restore_pro,
            get_library,
            get_scan_status,
            scan_visible_directory,
            scan_priority_library,
            open_comic,
            record_reading_history,
            get_reading_history,
            close_comic,
            update_reader_cache_window,
            save_progress,
            recover_reading_progress,
            get_config,
            get_memory_status,
            set_config,
            set_smb_config,
            get_online_services_config,
            set_online_services_config,
            get_ai_session_status,
            set_ai_session_config,
            restore_ai_session_config,
            revoke_ai_session_config,
            clear_ai_session_config,
            test_ai_session,
            explain_page,
            suggest_comic_metadata,
            get_photo_library_status,
            set_linked_photo_albums,
            set_photo_network_allowed,
            set_bookmarks,
            repair_external_bookmarks,
            get_bookmarks,
            open_folder_dialog,
            browse_folders,
            show_item_in_folder,
            get_file_capability,
            mutate_comic_file,
            undo_comic_file_operation,
            trash_page,
            save_imported_photo,
            import_photo_bytes,
            scan_library,
            search_catalog,
            get_discovery_tags,
            get_comic_metadata,
            apply_batch_metadata,
            undo_batch_metadata,
            upsert_folder_tag_rule,
            reimport_metadata,
            list_import_diagnostics,
            upsert_tag_alias,
            list_tag_aliases,
            list_tag_inventory,
            update_tag_state,
            rename_tag,
            merge_tags,
            set_tag_disabled,
            undo_tag_operation,
            list_organizer_inbox,
            list_duplicate_candidates,
            list_related_tags,
            export_catalog_metadata,
            default_catalog_export_path,
            save_catalog_metadata,
            preview_catalog_import,
            apply_catalog_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mock_limited_ai_json_response(
        status: u16,
        content_type: &str,
        body: Vec<u8>,
    ) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
        use std::io::Read;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let content_type = content_type.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.ends_with(b"\r\n\r\n") {
                let bytes = stream.read(&mut buffer).unwrap();
                assert!(bytes > 0, "mock HTTP request ended before its headers");
                request.extend_from_slice(&buffer[..bytes]);
                assert!(request.len() <= 8192, "mock HTTP request headers too large");
            }
            let headers = format!(
                "HTTP/1.1 {status} Mock Response\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).unwrap();
            let _ = stream.write_all(&body);
        });

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(format!("http://{address}/mock-ai-response"))
            .send()
            .await
            .unwrap();
        let result = limited_ai_json_response(response).await;
        server.join().unwrap();
        result
    }

    #[test]
    fn ios_history_uses_native_documents_for_custom_scan_roots() {
        let native = test_documents_root("22222222-2222-4222-8222-222222222222");
        let custom = Path::new("/Volumes/External/Comics");
        let (query, hydration) =
            ios_history_documents_context(Some(&native), custom.to_str().unwrap());
        assert_eq!(query.unwrap().0, native);
        assert!(hydration.is_none());

        let invalid_native = Path::new("/Volumes/External/Documents");
        let (query, hydration) =
            ios_history_documents_context(Some(invalid_native), custom.to_str().unwrap());
        assert!(query.is_none());
        assert!(hydration.is_none());
    }

    #[test]
    fn ios_history_context_keeps_configured_source_for_private_var_alias() {
        let native = test_documents_root("22222222-2222-4222-8222-222222222222");
        let configured = Path::new(
            "/var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents",
        );
        let (query, hydration) =
            ios_history_documents_context(Some(&native), configured.to_str().unwrap());
        assert_eq!(query.as_ref().unwrap().0, configured);
        assert_eq!(
            query.as_ref().unwrap().1,
            scanner::local_source_id(configured)
        );
        assert_eq!(hydration.unwrap().0, configured);
    }

    #[test]
    fn ios_documents_history_hydration_rejects_stale_scan_root_or_generation() {
        assert!(ios_documents_hydration_snapshot_is_current(
            "/documents",
            7,
            "/documents",
            7
        ));
        assert!(!ios_documents_hydration_snapshot_is_current(
            "/documents",
            7,
            "/other-documents",
            7
        ));
        assert!(!ios_documents_hydration_snapshot_is_current(
            "/documents",
            7,
            "/documents",
            8
        ));
    }

    #[test]
    fn reading_history_requires_the_current_reader_session_and_source() {
        assert!(reading_history_session_matches(
            Some("book"),
            Some("local:root"),
            Some("open-uuid"),
            Some("book"),
            Some("local:root"),
            Some("open-uuid"),
        ));
        assert!(!reading_history_session_matches(
            Some("book"),
            Some("local:root"),
            Some("reopened"),
            Some("book"),
            Some("local:root"),
            Some("open-uuid"),
        ));
        assert!(!reading_history_session_matches(
            Some("book"),
            Some("smb:v1:source-a"),
            Some("open-uuid"),
            Some("book"),
            Some("smb:v1:source-b"),
            Some("open-uuid"),
        ));
        assert!(!reading_history_session_matches(
            Some("book"),
            Some("local:root"),
            None,
            Some("book"),
            Some("local:root"),
            Some("open-uuid"),
        ));
    }

    #[test]
    fn photo_history_refresh_uses_current_photo_progress_and_marks_missing_album_offline() {
        let mut history = catalog::ReadingHistoryComic {
            id: "photo-album-1".into(),
            source_id: "photos:".into(),
            relative_path: "photo-album-1".into(),
            title: "Title at open".into(),
            page_count: 3,
            progress: Progress {
                current_page: 0,
                total_pages: 3,
                percent: 0.0,
                updated_at: None,
            },
            offline: false,
        };
        let current = ComicItem {
            id: history.id.clone(),
            r#type: "photo-album".into(),
            relative_path: history.relative_path.clone(),
            ext: ".jpg".into(),
            title: "Updated album title".into(),
            series: "Photos".into(),
            updated_at: String::new(),
            page_count: 5,
            progress: Progress {
                current_page: 2,
                total_pages: 5,
                percent: 60.0,
                updated_at: Some("2026-11-09T00:00:00Z".into()),
            },
            source_id: "photos:".into(),
            source_path: None,
            external_bookmark: None,
        };
        refresh_photo_history_item(&mut history, Some(&current));
        assert_eq!(history.title, "Updated album title");
        assert_eq!(history.page_count, 5);
        assert_eq!(history.progress.current_page, 2);
        assert!(!history.offline);

        refresh_photo_history_item(&mut history, None);
        assert!(history.offline);
        assert_eq!(history.progress.current_page, 2);
    }

    fn history_hydration_fixture(
        relative_path: &str,
        history_source_id: String,
        current_source_id: &str,
        progress: Progress,
    ) -> (catalog::ReadingHistoryComic, ComicItem) {
        (
            catalog::ReadingHistoryComic {
                id: "old-runtime-id".into(),
                source_id: history_source_id,
                relative_path: relative_path.into(),
                title: "Title at open".into(),
                page_count: 8,
                progress: Progress {
                    current_page: 2,
                    total_pages: 8,
                    percent: 25.0,
                    updated_at: Some("2026-11-08T10:00:00Z".into()),
                },
                offline: true,
            },
            ComicItem {
                id: "current-runtime-id".into(),
                r#type: "archive".into(),
                relative_path: relative_path.into(),
                ext: ".cbz".into(),
                title: "Current title".into(),
                series: "Current series".into(),
                updated_at: "2026-11-09T00:00:00Z".into(),
                page_count: 0,
                progress,
                source_id: current_source_id.into(),
                source_path: None,
                external_bookmark: None,
            },
        )
    }

    fn test_documents_root(container: &str) -> PathBuf {
        PathBuf::from(format!(
            "/private/var/mobile/Containers/Data/Application/{container}/Documents"
        ))
    }

    #[test]
    fn live_current_documents_history_hydrates_exact_capability_checked_item() {
        let current_root = test_documents_root("22222222-2222-4222-8222-222222222222");
        let old_root = test_documents_root("11111111-1111-4111-8111-111111111111");
        let current_source_id = scanner::local_source_id(&current_root);
        let old_source_id = scanner::local_source_id(&old_root);
        let temp_root =
            std::env::temp_dir().join(format!("gai_history_live_docs_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp_root.join("Audit69")).unwrap();
        std::fs::write(temp_root.join("Audit69/Audit68-A.cbz"), b"book").unwrap();
        let capability =
            cap_std::fs::Dir::open_ambient_dir(&temp_root, cap_std::ambient_authority()).unwrap();
        let (mut history, current) = history_hydration_fixture(
            "Audit69/Audit68-A.cbz",
            old_source_id,
            &current_source_id,
            Progress {
                current_page: 4,
                total_pages: 12,
                percent: 33.3,
                updated_at: Some("2026-11-08T10:30:00Z".into()),
            },
        );
        refresh_ios_documents_history_item(
            &mut history,
            &[current],
            &current_root,
            &current_source_id,
            &current_source_id,
            &capability,
        );
        assert_eq!(history.id, "current-runtime-id");
        assert_eq!(history.source_id, current_source_id);
        assert_eq!(history.relative_path, "Audit69/Audit68-A.cbz");
        assert_eq!(history.title, "Current title");
        assert_eq!(history.page_count, 12);
        assert_eq!(history.progress.current_page, 4);
        assert!(!history.offline);

        let (mut snapshot_history, current_without_progress) = history_hydration_fixture(
            "Audit69/Audit68-A.cbz",
            scanner::local_source_id(&old_root),
            &current_source_id,
            Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            },
        );
        refresh_ios_documents_history_item(
            &mut snapshot_history,
            &[current_without_progress],
            &current_root,
            &current_source_id,
            &current_source_id,
            &capability,
        );
        assert!(!snapshot_history.offline);
        assert_eq!(snapshot_history.progress.current_page, 2);
        assert_eq!(snapshot_history.page_count, 8);
        std::fs::remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn live_documents_hydration_keeps_snapshot_progress_and_rejects_bad_context_or_sources() {
        let current_root = test_documents_root("22222222-2222-4222-8222-222222222222");
        let old_root = test_documents_root("11111111-1111-4111-8111-111111111111");
        let current_source_id = scanner::local_source_id(&current_root);
        let old_source_id = scanner::local_source_id(&old_root);
        let temp_root = std::env::temp_dir().join(format!(
            "gai_history_live_docs_negative_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&temp_root).unwrap();
        let capability =
            cap_std::fs::Dir::open_ambient_dir(&temp_root, cap_std::ambient_authority()).unwrap();
        let (mut history, current) = history_hydration_fixture(
            "missing.cbz",
            old_source_id,
            &current_source_id,
            Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            },
        );
        let before = (
            history.id.clone(),
            history.source_id.clone(),
            history.progress.current_page,
        );
        refresh_ios_documents_history_item(
            &mut history,
            std::slice::from_ref(&current),
            &current_root,
            &current_source_id,
            &current_source_id,
            &capability,
        );
        assert!(history.offline, "missing current file must fail closed");
        assert_eq!(
            (
                history.id.clone(),
                history.source_id.clone(),
                history.progress.current_page
            ),
            before
        );

        refresh_ios_documents_history_item(
            &mut history,
            std::slice::from_ref(&current),
            &current_root,
            &current_source_id,
            "local:other-configured-root",
            &capability,
        );
        assert!(history.offline, "configured root mismatch must fail closed");
        assert_eq!(
            (
                history.id.clone(),
                history.source_id.clone(),
                history.progress.current_page
            ),
            before
        );

        refresh_ios_documents_history_item(
            &mut history,
            std::slice::from_ref(&current),
            Path::new("/Volumes/External/Documents"),
            &current_source_id,
            &current_source_id,
            &capability,
        );
        assert!(
            history.offline,
            "invalid native Documents context must fail closed"
        );

        history.source_id = "smb:v1:nas".into();
        refresh_ios_documents_history_item(
            &mut history,
            std::slice::from_ref(&current),
            &current_root,
            &current_source_id,
            &current_source_id,
            &capability,
        );
        assert!(
            history.offline,
            "NAS history must not borrow an identical relative path"
        );

        history.source_id = scanner::local_source_id(&old_root);
        history.relative_path = "different.cbz".into();
        refresh_ios_documents_history_item(
            &mut history,
            &[current],
            &current_root,
            &current_source_id,
            &current_source_id,
            &capability,
        );
        assert!(history.offline, "relative path must match exactly");
        assert_eq!(
            history.progress.current_page, 2,
            "missing live progress preserves history snapshot"
        );
        std::fs::remove_dir_all(temp_root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_documents_hydration_rejects_symlinks_and_unsafe_relative_paths() {
        use std::os::unix::fs::symlink;

        let current_root = test_documents_root("22222222-2222-4222-8222-222222222222");
        let old_root = test_documents_root("11111111-1111-4111-8111-111111111111");
        let current_source_id = scanner::local_source_id(&current_root);
        let temp_root = std::env::temp_dir().join(format!(
            "gai_history_live_docs_symlinks_{}",
            uuid::Uuid::new_v4()
        ));
        let outside = temp_root.with_extension("outside");
        std::fs::create_dir_all(&temp_root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("book.cbz"), b"outside").unwrap();
        symlink(outside.join("book.cbz"), temp_root.join("leaf-link.cbz")).unwrap();
        symlink(&outside, temp_root.join("parent-link")).unwrap();
        let capability =
            cap_std::fs::Dir::open_ambient_dir(&temp_root, cap_std::ambient_authority()).unwrap();

        for relative_path in [
            "leaf-link.cbz",
            "parent-link/book.cbz",
            "../book.cbz",
            "/outside/book.cbz",
            "a\\..\\book.cbz",
        ] {
            let (mut history, current) = history_hydration_fixture(
                relative_path,
                scanner::local_source_id(&old_root),
                &current_source_id,
                Progress {
                    current_page: 0,
                    total_pages: 0,
                    percent: 0.0,
                    updated_at: None,
                },
            );
            refresh_ios_documents_history_item(
                &mut history,
                &[current],
                &current_root,
                &current_source_id,
                &current_source_id,
                &capability,
            );
            assert!(
                history.offline,
                "unsafe path should stay offline: {relative_path}"
            );
        }
        std::fs::remove_dir_all(temp_root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn smb_temp_root_symlink_is_rejected_even_inside_temp_base() {
        let root = std::env::temp_dir().join(format!("gai_smb_root_link_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("other-cache")).unwrap();
        std::os::unix::fs::symlink("other-cache", root.join("ComicTemp")).unwrap();
        std::fs::write(root.join("other-cache/book.cbz"), b"keep").unwrap();
        assert!(open_smb_temp_root(&root, "smb:v1:test").is_err());
        assert!(remove_smb_temp_entry(&root, "smb:v1:test", Path::new("book.cbz")).is_err());
        assert_eq!(
            std::fs::read(root.join("other-cache/book.cbz")).unwrap(),
            b"keep"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn smb_download_limits_reject_oversize_low_space_and_invalid_stream_lengths() {
        let reserve = SMB_DISK_RESERVE_BYTES;
        assert!(smb_download_budget(1, reserve).is_err());
        assert!(smb_download_budget(0, reserve + 100).is_err());
        assert_eq!(smb_download_budget(100, reserve + 100).unwrap(), 100);
        assert!(smb_download_budget(101, reserve + 100).is_err());
        assert!(smb_download_budget(archive_reader::MAX_ARCHIVE_BYTES + 1, u64::MAX).is_err());
        assert_eq!(checked_smb_download_size(90, 10, 100, 100).unwrap(), 100);
        assert!(checked_smb_download_size(90, 11, 100, 100).is_err());
        assert!(checked_smb_download_size(90, 10, 200, 99).is_err());
        assert!(checked_smb_download_size(u64::MAX, 1, u64::MAX, u64::MAX).is_err());
    }
    use std::fs;

    #[test]
    fn bookmark_additions_preserve_reader_but_removals_invalidate_it() {
        for (removed_bookmark, removed_comic, should_invalidate) in [
            (false, false, false),
            (true, false, true),
            (false, true, true),
        ] {
            let state = AppState::new();
            *state.active_comic_id.lock().unwrap() = Some("reading".into());
            state
                .opened_comic_files
                .write()
                .unwrap()
                .insert("reading".into(), vec!["page.jpg".into()]);
            let before = state
                .reader_generation
                .load(std::sync::atomic::Ordering::SeqCst);
            reconcile_bookmark_reader_cache(&state, removed_bookmark, removed_comic);
            assert_eq!(
                state.active_comic_id.lock().unwrap().is_none(),
                should_invalidate
            );
            assert_eq!(
                state.opened_comic_files.read().unwrap().is_empty(),
                should_invalidate
            );
            assert_eq!(
                state
                    .reader_generation
                    .load(std::sync::atomic::Ordering::SeqCst),
                before + u64::from(should_invalidate)
            );
        }
    }

    #[test]
    fn close_cleanup_source_follows_the_matching_reader_slot() {
        // A new open can leave the old active reader in place while its
        // replacement is pending. Closing the pending ID must not clean the
        // old active source's temporary SMB entry.
        assert_eq!(
            cleanup_source_id_for_close(
                "pending-book",
                None,
                Some("active-book"),
                Some("smb:active"),
                Some("pending-book"),
                Some("smb:pending"),
            )
            .as_deref(),
            Some("smb:pending")
        );
        assert_eq!(
            cleanup_source_id_for_close(
                "same-runtime",
                Some("smb:pending"),
                Some("same-runtime"),
                Some("smb:active"),
                Some("same-runtime"),
                Some("smb:pending"),
            )
            .as_deref(),
            Some("smb:pending")
        );
        assert_eq!(
            cleanup_source_id_for_close(
                "broken-reader",
                None,
                Some("broken-reader"),
                None,
                Some("other-book"),
                Some("smb:pending"),
            ),
            None
        );
    }

    #[test]
    fn trash_page_rejects_reusing_an_old_index_after_page_removal() {
        let mut images = vec![
            PathBuf::from("001.jpg"),
            PathBuf::from("002.jpg"),
            PathBuf::from("003.jpg"),
        ];
        assert_eq!(
            expected_trash_page_path(&images, 1, "002.jpg").unwrap(),
            PathBuf::from("002.jpg")
        );

        images.remove(1);
        assert!(expected_trash_page_path(&images, 1, "002.jpg").is_err());
        assert_eq!(
            expected_trash_page_path(&images, 1, "003.jpg").unwrap(),
            PathBuf::from("003.jpg")
        );
    }

    #[test]
    fn trash_page_guard_is_fail_closed_until_safe_page_journal_exists() {
        let error = require_safe_single_page_trash().unwrap_err();
        assert!(error.starts_with("刪除單頁暫不提供："));
        assert!(error.contains("安全頁面日誌"));
    }

    #[tokio::test]
    async fn file_operation_refresh_is_source_path_scoped_and_reports_failure() {
        let state = Arc::new(AppState::new());
        let mut old_a = capability_comic("same-runtime", "A");
        old_a.source_id = "local:a".into();
        old_a.relative_path = "book.cbz".into();
        let mut same_runtime_b = capability_comic("same-runtime", "B");
        same_runtime_b.source_id = "local:b".into();
        same_runtime_b.relative_path = "book.cbz".into();
        let mut same_path_c = capability_comic("other-runtime", "C");
        same_path_c.source_id = "local:c".into();
        same_path_c.relative_path = "book.cbz".into();
        state
            .comics
            .lock()
            .await
            .extend([old_a, same_runtime_b, same_path_c]);

        let mut renamed_a = capability_comic("renamed-runtime", "A");
        renamed_a.source_id = "local:a".into();
        renamed_a.relative_path = "renamed.cbz".into();
        let progress =
            refresh_file_operation_state(&state, "local:a", "book.cbz", false, Ok(Some(renamed_a)))
                .await;
        assert_eq!(progress.phase, "complete");
        assert!(progress.error.is_none());
        {
            let comics = state.comics.lock().await;
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:a" && item.relative_path == "renamed.cbz"));
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:b" && item.relative_path == "book.cbz"));
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:c" && item.relative_path == "book.cbz"));
        }

        let mut quarantined_a = capability_comic("quarantined-runtime", "A");
        quarantined_a.source_id = "local:a".into();
        quarantined_a.relative_path = ".gai-quarantine/comics/op/book.cbz".into();
        let progress = refresh_file_operation_state(
            &state,
            "local:a",
            "renamed.cbz",
            true,
            Ok(Some(quarantined_a)),
        )
        .await;
        assert_eq!(progress.phase, "complete");
        {
            let comics = state.comics.lock().await;
            assert!(!comics.iter().any(|item| item.source_id == "local:a"));
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:b" && item.relative_path == "book.cbz"));
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:c" && item.relative_path == "book.cbz"));
        }

        let mut restored_a = capability_comic("restored-runtime", "A");
        restored_a.source_id = "local:a".into();
        restored_a.relative_path = "book.cbz".into();
        let progress = refresh_file_operation_state(
            &state,
            "local:a",
            ".gai-quarantine/comics/op/book.cbz",
            false,
            Ok(Some(restored_a)),
        )
        .await;
        assert_eq!(progress.phase, "complete");
        {
            let comics = state.comics.lock().await;
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:a" && item.relative_path == "book.cbz"));
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:b" && item.relative_path == "book.cbz"));
            assert!(comics
                .iter()
                .any(|item| item.source_id == "local:c" && item.relative_path == "book.cbz"));
        }

        let progress = refresh_file_operation_state(
            &state,
            "local:a",
            "book.cbz",
            false,
            Err("漫畫位置刷新工作失敗：database is locked".into()),
        )
        .await;
        assert_eq!(progress.phase, "refresh-required");
        assert!(progress
            .error
            .as_deref()
            .is_some_and(|error| error.contains("database is locked")));
        let comics = state.comics.lock().await;
        assert!(!comics
            .iter()
            .any(|item| item.source_id == "local:a" && item.relative_path == "book.cbz"));
        assert!(comics
            .iter()
            .any(|item| item.source_id == "local:b" && item.relative_path == "book.cbz"));
        assert!(comics
            .iter()
            .any(|item| item.source_id == "local:c" && item.relative_path == "book.cbz"));
    }

    #[test]
    fn atomically_replaces_settings_without_leaving_temporary_files() {
        let settings_dir =
            std::env::temp_dir().join(format!("gai-settings-write-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&settings_dir).unwrap();
        let destination = settings_dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE);
        fs::write(&destination, br#"[{"bookmark":"old"}]"#).unwrap();

        persist_settings_file_atomically(
            &settings_dir,
            EXTERNAL_BOOKMARKS_SETTINGS_FILE,
            br#"[{"bookmark":"new"}]"#,
        )
        .unwrap();

        assert_eq!(fs::read(&destination).unwrap(), br#"[{"bookmark":"new"}]"#);
        assert_eq!(fs::read_dir(&settings_dir).unwrap().count(), 1);
        fs::remove_dir_all(settings_dir).unwrap();
    }

    #[test]
    fn bookmark_restore_migrates_legacy_only_when_native_file_is_missing() {
        let dir =
            std::env::temp_dir().join(format!("gai-bookmark-restore-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let legacy = vec![state::ExternalBookmark {
            bookmark: "legacy-grant".into(),
            name: "Legacy".into(),
        }];
        let migrated = external_bookmarks_for_restore(&dir, legacy.clone(), true).unwrap();
        assert_eq!(migrated[0].bookmark, "legacy-grant");
        assert!(!dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE).exists());

        fs::write(
            dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE),
            br#"[{"bookmark":"native-grant","name":"Native"}]"#,
        )
        .unwrap();
        for browser in [Vec::new(), legacy] {
            let restored = external_bookmarks_for_restore(&dir, browser, true).unwrap();
            assert_eq!(restored.len(), 1);
            assert_eq!(restored[0].bookmark, "native-grant");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bookmark_restore_defers_migration_when_legacy_cache_cannot_be_read() {
        let dir =
            std::env::temp_dir().join(format!("gai-bookmark-cache-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(external_bookmarks_for_restore(&dir, Vec::new(), false).is_err());
        assert!(!dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE).exists());
        std::fs::write(dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE), b"[]").unwrap();
        assert!(external_bookmarks_for_restore(&dir, Vec::new(), false)
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bookmark_restore_preserves_an_explicitly_saved_empty_native_list() {
        let dir = std::env::temp_dir().join(format!("gai-bookmark-empty-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE), b"[]").unwrap();
        let stale = vec![state::ExternalBookmark {
            bookmark: "removed-grant".into(),
            name: "Removed".into(),
        }];
        assert!(external_bookmarks_for_restore(&dir, stale, true)
            .unwrap()
            .is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bookmark_restore_never_treats_corrupt_or_unreadable_native_data_as_missing() {
        let dir =
            std::env::temp_dir().join(format!("gai-bookmark-invalid-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE);
        let legacy = vec![state::ExternalBookmark {
            bookmark: "legacy-grant".into(),
            name: "Legacy".into(),
        }];
        for invalid in [
            b"not JSON".as_slice(),
            br#"[{"bookmark":"missing-name"}]"#.as_slice(),
        ] {
            fs::write(&file, invalid).unwrap();
            assert!(external_bookmarks_for_restore(&dir, legacy.clone(), true).is_err());
            assert_eq!(fs::read(&file).unwrap(), invalid);
        }
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(external_bookmarks_for_restore(&dir, legacy, true).is_err());
        assert!(file.is_dir());
        fs::remove_dir_all(dir).unwrap();
    }

    fn capability_comic(id: &str, title: &str) -> ComicItem {
        ComicItem {
            id: id.into(),
            r#type: "external-archive".into(),
            relative_path: "book.zip".into(),
            ext: ".zip".into(),
            title: title.into(),
            series: "系列".into(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            page_count: 1,
            progress: Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: None,
            },
            external_bookmark: None,
            source_id: "local:test".into(),
            source_path: Some("/tmp/book.zip".into()),
        }
    }

    fn progress_recovery_request(
        id: &str,
        source_id: &str,
        current_page: u64,
        total_pages: u64,
        sequence: u64,
        recovery_token: &str,
    ) -> SaveProgressRequest {
        SaveProgressRequest {
            id: id.into(),
            source_id: Some(source_id.into()),
            current_page,
            total_pages,
            sequence: Some(sequence),
            intent_sequence: Some(sequence),
            recovery_token: Some(recovery_token.into()),
        }
    }

    async fn progress_recovery_state(comics: &[ComicItem]) -> (Arc<AppState>, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("gai-progress-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = catalog::CatalogStore::new(root.join("catalog.sqlite3")).unwrap();
        store.sync_library(comics).unwrap();
        let state = Arc::new(AppState::new());
        *state.catalog.write().unwrap() = Some(store);
        *state.comics.lock().await = comics.to_vec();
        state.progress_recovery_test_sources.lock().unwrap().extend(
            comics
                .iter()
                .filter(|comic| comic.source_id.starts_with("local:"))
                .map(|comic| comic.source_id.clone()),
        );
        (state, root)
    }

    #[tokio::test]
    async fn recovery_rejects_root_change_during_validation_but_allows_later_reauthorization() {
        let root_a =
            std::env::temp_dir().join(format!("gai-recovery-auth-a-{}", uuid::Uuid::new_v4()));
        let root_b =
            std::env::temp_dir().join(format!("gai-recovery-auth-b-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root_a).unwrap();
        fs::create_dir_all(&root_b).unwrap();
        let archive = root_a.join("book.zip");
        fs::write(&archive, b"archive").unwrap();
        let mut comic = capability_comic("book", "Book");
        comic.relative_path = "book.zip".into();
        comic.source_id = scanner::local_source_id(&root_a);
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        let state = Arc::new(AppState::new());
        *state.scan_dir.write().unwrap() = root_a.to_string_lossy().into_owned();
        let initial = recovery_source_authorization_snapshot(&state, &comic)
            .await
            .unwrap();

        // A committed-but-stale catalog row may survive a source transition;
        // its persisted page and intent fence must stay untouched on rejection.
        let catalog_root =
            std::env::temp_dir().join(format!("gai-recovery-auth-db-{}", uuid::Uuid::new_v4()));
        let store = catalog::CatalogStore::new(catalog_root.join("catalog.sqlite3")).unwrap();
        store.sync_library(&[comic.clone()]).unwrap();
        let baseline = store
            .progress_for_source_location("book", &comic.source_id, "book.zip")
            .unwrap();
        let fence = store
            .progress_intent_floor("book", &comic.source_id, "book.zip")
            .unwrap();
        *state.catalog.write().unwrap() = Some(store.clone());

        {
            let _lease = state.source_authorization_lifecycle.write().await;
            *state.scan_dir.write().unwrap() = root_b.to_string_lossy().into_owned();
            state
                .source_authorization_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
        let final_lease = state
            .source_authorization_lifecycle
            .clone()
            .read_owned()
            .await;
        let rejected = verify_recovery_source_authorization(&state, &comic, &initial);
        drop(final_lease);
        assert!(rejected.is_err());
        assert!(!rejected.unwrap_err().contains("MANUAL_CHECK"));
        let after = store
            .progress_for_source_location("book", &comic.source_id, "book.zip")
            .unwrap();
        let progress_key = |value: &Option<Progress>| {
            value
                .as_ref()
                .map(|item| (item.current_page, item.total_pages, item.updated_at.clone()))
        };
        assert_eq!(progress_key(&after), progress_key(&baseline));
        assert_eq!(
            store
                .progress_intent_floor("book", &comic.source_id, "book.zip")
                .unwrap(),
            fence
        );

        // Returning to the same configured root permits a later safe retry of
        // the unchanged native proof; no online flag is part of authorization.
        {
            let _lease = state.source_authorization_lifecycle.write().await;
            *state.scan_dir.write().unwrap() = root_a.to_string_lossy().into_owned();
            state
                .source_authorization_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }
        let reauthorized = recovery_source_authorization_snapshot(&state, &comic)
            .await
            .unwrap();
        let retry_lease = state
            .source_authorization_lifecycle
            .clone()
            .read_owned()
            .await;
        assert!(verify_recovery_source_authorization(&state, &comic, &reauthorized).is_ok());
        drop(retry_lease);
        fs::remove_dir_all(root_a).unwrap();
        fs::remove_dir_all(root_b).unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[tokio::test]
    async fn full_recovery_command_rejects_a_persisted_proof_after_local_root_switch() {
        let root_a = std::env::temp_dir().join(format!(
            "gai-recovery-command-root-a-{}",
            uuid::Uuid::new_v4()
        ));
        let root_b = std::env::temp_dir().join(format!(
            "gai-recovery-command-root-b-{}",
            uuid::Uuid::new_v4()
        ));
        let catalog_root = std::env::temp_dir().join(format!(
            "gai-recovery-command-catalog-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root_a).unwrap();
        fs::create_dir_all(&root_b).unwrap();
        fs::create_dir_all(&catalog_root).unwrap();
        let archive = root_a.join("book.cbz");
        fs::write(&archive, b"unchanged verified local archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());

        let mut comic = capability_comic("book", "Book");
        comic.source_id = scanner::local_source_id(&root_a);
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        comic.page_count = 7;
        comic.progress = Progress {
            current_page: 0,
            total_pages: 7,
            percent: 0.0,
            updated_at: None,
        };

        let store = catalog::CatalogStore::new(catalog_root.join("catalog.sqlite3")).unwrap();
        store.sync_library(&[comic.clone()]).unwrap();
        let proof_state = AppState::new();
        let token = proof_state
            .remember_progress_recovery_evidence(
                "book",
                &comic.source_id,
                "book.cbz",
                7,
                1,
                Some(revision.clone()),
            )
            .unwrap();
        store
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: &comic.source_id,
                relative_path: "book.cbz",
                token: &token,
                total_pages: 7,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();

        // A cold state has no in-memory evidence or test-only source grant;
        // recovery must load the durable proof and validate the configured root.
        let cold_a = Arc::new(AppState::new());
        *cold_a.scan_dir.write().unwrap() = root_a.to_string_lossy().into_owned();
        *cold_a.catalog.write().unwrap() = Some(store.clone());
        *cold_a.comics.lock().await = vec![comic.clone()];
        assert!(cold_a
            .progress_recovery_test_sources
            .lock()
            .unwrap()
            .is_empty());
        recover_reading_progress_inner(
            &cold_a,
            progress_recovery_request("book", &comic.source_id, 2, 7, 1, &token),
        )
        .await
        .unwrap();

        let committed_progress = store
            .progress_for_source_location("book", &comic.source_id, "book.cbz")
            .unwrap()
            .unwrap();
        assert_eq!(committed_progress.current_page, 2);
        let committed_fence = store
            .progress_intent_floor("book", &comic.source_id, "book.cbz")
            .unwrap();
        assert_eq!(committed_fence, 1);

        // The catalog row and A's source bytes remain intact, but B is now the
        // only configured local root. A second real recovery command must fail
        // before it can advance either the persisted page or intent fence.
        let cold_b = Arc::new(AppState::new());
        *cold_b.scan_dir.write().unwrap() = root_b.to_string_lossy().into_owned();
        *cold_b.catalog.write().unwrap() = Some(store.clone());
        *cold_b.comics.lock().await = vec![comic.clone()];
        assert!(cold_b
            .progress_recovery_test_sources
            .lock()
            .unwrap()
            .is_empty());
        let rejected = recover_reading_progress_inner(
            &cold_b,
            progress_recovery_request("book", &comic.source_id, 4, 7, 2, &token),
        )
        .await;
        assert!(rejected.is_err());
        let after = store
            .progress_for_source_location("book", &comic.source_id, "book.cbz")
            .unwrap()
            .unwrap();
        assert_eq!(after.current_page, committed_progress.current_page);
        assert_eq!(after.total_pages, committed_progress.total_pages);
        assert_eq!(after.updated_at, committed_progress.updated_at);
        assert_eq!(
            store
                .progress_intent_floor("book", &comic.source_id, "book.cbz")
                .unwrap(),
            committed_fence
        );

        fs::remove_dir_all(root_a).unwrap();
        fs::remove_dir_all(root_b).unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn full_recovery_rejects_parent_symlinks_for_local_and_external_roots() {
        use std::os::unix::fs::symlink;

        let mut observations = Vec::new();
        for external in [false, true] {
            let case_root = std::env::temp_dir().join(format!(
                "gai-recovery-parent-symlink-{}-{}",
                if external { "external" } else { "local" },
                uuid::Uuid::new_v4()
            ));
            let authorized_root = case_root.join("authorized");
            let outside_root = case_root.join("outside");
            let catalog_root = case_root.join("catalog");
            fs::create_dir_all(authorized_root.join("sub")).unwrap();
            fs::create_dir_all(&outside_root).unwrap();
            fs::create_dir_all(&catalog_root).unwrap();
            let archive = authorized_root.join("sub/book.cbz");
            fs::write(&archive, b"same inode outside the authorized root").unwrap();
            let revision =
                state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
            let bookmark = format!("parent-symlink-{}", uuid::Uuid::new_v4());
            let mut comic = capability_comic("book", "Book");
            comic.r#type = if external {
                "external-archive".into()
            } else {
                "archive".into()
            };
            comic.relative_path = "sub/book.cbz".into();
            comic.source_id = if external {
                scanner::external_source_id(&bookmark)
            } else {
                scanner::local_source_id(&authorized_root)
            };
            comic.source_path = Some(archive.to_string_lossy().into_owned());
            comic.external_bookmark = external.then(|| bookmark.clone());
            comic.page_count = 7;
            comic.progress = Progress {
                current_page: 0,
                total_pages: 7,
                percent: 0.0,
                updated_at: None,
            };
            let store = catalog::CatalogStore::new(catalog_root.join("catalog.sqlite3")).unwrap();
            store.sync_library(&[comic.clone()]).unwrap();
            let proof_state = AppState::new();
            let token = proof_state
                .remember_progress_recovery_evidence(
                    "book",
                    &comic.source_id,
                    &comic.relative_path,
                    7,
                    1,
                    Some(revision.clone()),
                )
                .unwrap();
            store
                .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                    identifier: "book",
                    source_id: &comic.source_id,
                    relative_path: &comic.relative_path,
                    token: &token,
                    total_pages: 7,
                    revision: &revision,
                    smb_content_hash: None,
                })
                .unwrap();
            let baseline = store
                .progress_for_source_location("book", &comic.source_id, &comic.relative_path)
                .unwrap();
            let baseline_fence = store
                .progress_intent_floor("book", &comic.source_id, &comic.relative_path)
                .unwrap();

            // Preserve the opened archive inode and its revision while the
            // authorized path now traverses a symlinked parent directory.
            let moved_subdirectory = outside_root.join("sub");
            fs::rename(authorized_root.join("sub"), &moved_subdirectory).unwrap();
            symlink(&moved_subdirectory, authorized_root.join("sub")).unwrap();

            let cold = Arc::new(AppState::new());
            *cold.catalog.write().unwrap() = Some(store.clone());
            *cold.comics.lock().await = vec![comic.clone()];
            if external {
                *cold.external_bookmarks.write().unwrap() = vec![state::ExternalBookmark {
                    bookmark: bookmark.clone(),
                    name: "外部授權".into(),
                }];
                cold.active_bookmarks
                    .lock()
                    .unwrap()
                    .insert(bookmark, authorized_root.to_string_lossy().into_owned());
            } else {
                *cold.scan_dir.write().unwrap() = authorized_root.to_string_lossy().into_owned();
            }
            assert!(cold
                .progress_recovery_test_sources
                .lock()
                .unwrap()
                .is_empty());

            let result = recover_reading_progress_inner(
                &cold,
                progress_recovery_request("book", &comic.source_id, 2, 7, 1, &token),
            )
            .await;
            let saved = store
                .progress_for_source_location("book", &comic.source_id, &comic.relative_path)
                .unwrap();
            let fence = store
                .progress_intent_floor("book", &comic.source_id, &comic.relative_path)
                .unwrap();
            let progress_key = |progress: &Option<Progress>| {
                progress.as_ref().map(|item| {
                    (
                        item.current_page,
                        item.total_pages,
                        item.percent,
                        item.updated_at.clone(),
                    )
                })
            };
            observations.push((
                if external { "external" } else { "local" },
                result.is_err(),
                progress_key(&saved) == progress_key(&baseline),
                fence == baseline_fence,
            ));
            fs::remove_dir_all(case_root).unwrap();
        }
        assert_eq!(
            observations,
            vec![("local", true, true, true), ("external", true, true, true)],
            "each parent-symlink recovery must reject without changing page or fence"
        );
    }

    #[tokio::test]
    async fn removed_bookmark_denies_retained_catalog_row_and_reauthorized_offline_source_works() {
        let root =
            std::env::temp_dir().join(format!("gai-recovery-bookmark-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join("book.zip");
        fs::write(&archive, b"archive").unwrap();
        let bookmark = "persistent-grant";
        let mut comic = capability_comic("book", "Book");
        comic.r#type = "offline".into();
        comic.relative_path = "book.zip".into();
        comic.source_id = scanner::external_source_id(bookmark);
        comic.external_bookmark = Some(bookmark.into());
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        let catalog_root =
            std::env::temp_dir().join(format!("gai-recovery-bookmark-db-{}", uuid::Uuid::new_v4()));
        let store = catalog::CatalogStore::new(catalog_root.join("catalog.sqlite3")).unwrap();
        store.sync_library(&[comic.clone()]).unwrap();
        let state = Arc::new(AppState::new());
        *state.catalog.write().unwrap() = Some(store.clone());
        state
            .active_bookmarks
            .lock()
            .unwrap()
            .insert(bookmark.into(), root.to_string_lossy().into_owned());
        // Simulate failed catalog cleanup after bookmark removal: the old row
        // remains queryable but the authoritative list revokes its capability.
        assert!(store
            .get_runtime_item_for_source("book", &comic.source_id)
            .unwrap()
            .is_some());
        let error = current_recovery_source_identity(&state, &comic).unwrap_err();
        assert!(!error.contains("MANUAL_CHECK"));

        *state.external_bookmarks.write().unwrap() = vec![state::ExternalBookmark {
            bookmark: bookmark.into(),
            name: "NAS".into(),
        }];
        assert!(current_recovery_source_identity(&state, &comic).is_ok());
        // `offline` is deliberately accepted only with the current bookmark
        // list and active root; its catalog online bit is not authorization.
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[tokio::test]
    async fn catalog_backed_external_recovery_uses_current_authoritative_bookmark() {
        let root = std::env::temp_dir().join(format!(
            "gai-catalog-external-recovery-{}",
            uuid::Uuid::new_v4()
        ));
        let catalog_root = std::env::temp_dir().join(format!(
            "gai-catalog-external-recovery-db-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&catalog_root).unwrap();
        let archive = root.join("book.cbz");
        fs::write(&archive, b"authorized external archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let bookmark = "external-proof-grant";
        let mut comic = capability_comic("book", "Book");
        comic.r#type = "external-archive".into();
        comic.relative_path = "book.cbz".into();
        comic.source_id = scanner::external_source_id(bookmark);
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        comic.external_bookmark = Some(bookmark.into());
        comic.page_count = 7;
        comic.progress = Progress {
            current_page: 0,
            total_pages: 7,
            percent: 0.0,
            updated_at: None,
        };
        let store = catalog::CatalogStore::new(catalog_root.join("catalog.sqlite3")).unwrap();
        store.sync_library(&[comic.clone()]).unwrap();

        let proof_state = AppState::new();
        let token = proof_state
            .remember_progress_recovery_evidence(
                "book",
                &comic.source_id,
                "book.cbz",
                7,
                1,
                Some(revision.clone()),
            )
            .unwrap();
        store
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: &comic.source_id,
                relative_path: "book.cbz",
                token: &token,
                total_pages: 7,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();

        let make_cold_state = |authorized: bool| {
            let state = Arc::new(AppState::new());
            *state.catalog.write().unwrap() = Some(store.clone());
            state
                .active_bookmarks
                .lock()
                .unwrap()
                .insert(bookmark.into(), root.to_string_lossy().into_owned());
            if authorized {
                *state.external_bookmarks.write().unwrap() = vec![state::ExternalBookmark {
                    bookmark: bookmark.into(),
                    name: "授權來源".into(),
                }];
            }
            state
        };

        // The catalog query reconstructs the row without its security-scoped
        // bookmark value. Current authoritative state must rehydrate it.
        let cold_authorized = make_cold_state(true);
        let catalog_row = store
            .get_runtime_item_for_source("book", &comic.source_id)
            .unwrap()
            .unwrap();
        assert!(catalog_row.external_bookmark.is_none());
        assert!(cold_authorized
            .progress_recovery_test_sources
            .lock()
            .unwrap()
            .is_empty());
        recover_reading_progress_inner(
            &cold_authorized,
            progress_recovery_request("book", &comic.source_id, 2, 7, 1, &token),
        )
        .await
        .unwrap();
        let saved = store
            .progress_for_source_location("book", &comic.source_id, "book.cbz")
            .unwrap()
            .unwrap();
        let saved_fence = store
            .progress_intent_floor("book", &comic.source_id, "book.cbz")
            .unwrap();
        assert_eq!(saved.current_page, 2);
        assert_eq!(saved_fence, 1);

        // Simulate cleanup failure: the catalog row and active handle remain,
        // while removal from the authoritative list revokes this capability.
        let cold_revoked = make_cold_state(false);
        let rejected = recover_reading_progress_inner(
            &cold_revoked,
            progress_recovery_request("book", &comic.source_id, 4, 7, 2, &token),
        )
        .await;
        assert!(rejected.is_err());
        let after_revoke = store
            .progress_for_source_location("book", &comic.source_id, "book.cbz")
            .unwrap()
            .unwrap();
        assert_eq!(after_revoke.current_page, saved.current_page);
        assert_eq!(after_revoke.total_pages, saved.total_pages);
        assert_eq!(after_revoke.updated_at, saved.updated_at);
        assert_eq!(
            store
                .progress_intent_floor("book", &comic.source_id, "book.cbz")
                .unwrap(),
            saved_fence
        );

        // Regranting the same opaque bookmark permits a later cold retry with
        // the unchanged durable proof and freshly advanced user intent.
        let cold_regranted = make_cold_state(true);
        recover_reading_progress_inner(
            &cold_regranted,
            progress_recovery_request("book", &comic.source_id, 4, 7, 2, &token),
        )
        .await
        .unwrap();
        assert_eq!(
            store
                .progress_for_source_location("book", &comic.source_id, "book.cbz")
                .unwrap()
                .unwrap()
                .current_page,
            4
        );
        assert_eq!(
            store
                .progress_intent_floor("book", &comic.source_id, "book.cbz")
                .unwrap(),
            2
        );

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[tokio::test]
    async fn recovery_commit_holds_source_lease_until_database_fence_commits() {
        let root_a =
            std::env::temp_dir().join(format!("gai-recovery-lease-a-{}", uuid::Uuid::new_v4()));
        let root_b =
            std::env::temp_dir().join(format!("gai-recovery-lease-b-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root_a).unwrap();
        fs::create_dir_all(&root_b).unwrap();
        let archive = root_a.join("book.zip");
        fs::write(&archive, b"archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.relative_path = "book.zip".into();
        comic.source_id = scanner::local_source_id(&root_a);
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        let catalog_root =
            std::env::temp_dir().join(format!("gai-recovery-lease-db-{}", uuid::Uuid::new_v4()));
        let store = catalog::CatalogStore::new(catalog_root.join("catalog.sqlite3")).unwrap();
        store.sync_library(&[comic.clone()]).unwrap();
        let token = "authorized-commit-proof";
        store
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: &comic.source_id,
                relative_path: "book.zip",
                token,
                total_pages: 1,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();
        let state = Arc::new(AppState::new());
        *state.scan_dir.write().unwrap() = root_a.to_string_lossy().into_owned();
        let snapshot = recovery_source_authorization_snapshot(&state, &comic)
            .await
            .unwrap();
        let final_lease = state
            .source_authorization_lifecycle
            .clone()
            .read_owned()
            .await;
        verify_recovery_source_authorization(&state, &comic, &snapshot).unwrap();

        let state_for_transition = Arc::clone(&state);
        let next_root = root_b.to_string_lossy().into_owned();
        let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
        let (changed_tx, mut changed_rx) = tokio::sync::oneshot::channel();
        let transition = tokio::spawn(async move {
            attempted_tx.send(()).unwrap();
            let _write = state_for_transition
                .source_authorization_lifecycle
                .clone()
                .write_owned()
                .await;
            *state_for_transition.scan_dir.write().unwrap() = next_root;
            state_for_transition
                .source_authorization_generation
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            changed_tx.send(()).unwrap();
        });
        attempted_rx.await.unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(
            changed_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        let commit_store = store.clone();
        let commit_revision = revision.clone();
        let commit_source_id = comic.source_id.clone();
        tokio::task::spawn_blocking(move || {
            let _authorization_lease = final_lease;
            let progress = Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: Some("committed".into()),
            };
            commit_store.recover_progress_for_source_location(catalog::ProgressRecoveryCommit {
                identifier: "book",
                source_id: &commit_source_id,
                relative_path: "book.zip",
                token,
                revision: &commit_revision,
                smb_content_hash: None,
                total_pages: 1,
                current_page: 0,
                intent_sequence: 1,
                progress: &progress,
            })
        })
        .await
        .unwrap()
        .unwrap();
        changed_rx.await.unwrap();
        transition.await.unwrap();
        assert_eq!(
            store
                .progress_intent_floor("book", &comic.source_id, "book.zip")
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .progress_for_source_location("book", &comic.source_id, "book.zip")
                .unwrap()
                .unwrap()
                .updated_at
                .as_deref(),
            Some("committed")
        );
        fs::remove_dir_all(root_a).unwrap();
        fs::remove_dir_all(root_b).unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[test]
    fn progress_recovery_evidence_is_optional_when_revision_is_unavailable() {
        let state = AppState::new();
        assert!(state
            .remember_progress_recovery_evidence(
                "book",
                "external:bookmarks",
                "book.cbz",
                12,
                1,
                None,
            )
            .is_none());
        assert!(state
            .progress_recovery_evidence("book", "external:bookmarks", "book.cbz")
            .is_none());
    }

    #[test]
    fn smb_progress_evidence_rotates_token_when_content_changes() {
        let source_root = std::env::temp_dir().join(format!(
            "gai-smb-progress-evidence-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&source_root).unwrap();
        let archive = source_root.join("book.cbz");
        fs::write(&archive, b"verified original bytes").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let state = AppState::new();
        let first_hash = *blake3::hash(b"verified original bytes").as_bytes();
        let replacement_hash = *blake3::hash(b"replacement bytes").as_bytes();
        let first_token = state
            .remember_progress_recovery_evidence_with_smb_hash(
                "book",
                "smb:v1:test",
                "book.cbz",
                7,
                1,
                Some(revision.clone()),
                Some(first_hash),
            )
            .unwrap();
        let same_token = state
            .remember_progress_recovery_evidence_with_smb_hash(
                "book",
                "smb:v1:test",
                "book.cbz",
                7,
                2,
                Some(revision.clone()),
                Some(first_hash),
            )
            .unwrap();
        let replacement_token = state
            .remember_progress_recovery_evidence_with_smb_hash(
                "book",
                "smb:v1:test",
                "book.cbz",
                7,
                3,
                Some(revision.clone()),
                Some(replacement_hash),
            )
            .unwrap();
        assert_eq!(first_token, same_token);
        assert_ne!(first_token, replacement_token);
        fs::remove_dir_all(source_root).unwrap();
    }

    #[test]
    fn smb_recovery_rejects_replaced_content_and_unstable_remote_metadata() {
        let root = std::env::temp_dir().join(format!(
            "gai-smb-progress-replaced-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join("book.cbz");
        fs::write(&archive, b"original archive bytes").unwrap();
        let expected = *blake3::hash(&fs::read(&archive).unwrap()).as_bytes();
        assert!(smb_recovery_content_matches(expected, expected));
        fs::write(&archive, b"replacement archive bytes").unwrap();
        let replacement = *blake3::hash(&fs::read(&archive).unwrap()).as_bytes();
        assert!(!smb_recovery_content_matches(expected, replacement));

        let timestamp = smb2::pack::FileTime::from_system_time(std::time::UNIX_EPOCH);
        let before = smb2::FileInfo {
            size: 22,
            is_directory: false,
            created: timestamp,
            modified: timestamp,
            accessed: timestamp,
        };
        assert!(smb_stat_stable_during_read(&before, &before));
        let mut after = before.clone();
        after.modified = smb2::pack::FileTime::from_system_time(
            std::time::UNIX_EPOCH + std::time::Duration::from_secs(1),
        );
        assert!(!smb_stat_stable_during_read(&before, &after));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn direct_smb_progress_recovery_fails_closed_without_content_evidence() {
        let root = std::env::temp_dir().join(format!(
            "gai-smb-progress-missing-digest-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join("book.cbz");
        fs::write(&archive, b"archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "smb:v1:test".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = None;
        let (state, catalog_root) = progress_recovery_state(&[comic]).await;
        let token = state
            .remember_progress_recovery_evidence(
                "book",
                "smb:v1:test",
                "book.cbz",
                7,
                1,
                Some(revision),
            )
            .unwrap();

        let error = recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "smb:v1:test", 0, 7, 1, &token),
        )
        .await
        .unwrap_err();
        assert!(error.contains("SMB"));
        fs::remove_dir_all(catalog_root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn smb_progress_recovery_releases_publication_lock_and_rechecks_snapshot() {
        let smb_config = state::SmbConfig {
            host: "example.invalid".into(),
            share: "comics".into(),
            username: Some("reader".into()),
            password: Some("secret".into()),
        };
        let smb_source = state::smb_source_id(&smb_config);
        let mut comic = capability_comic("book", "Book");
        comic.source_id = smb_source.clone();
        comic.relative_path = "book.cbz".into();
        comic.source_path = None;
        comic.progress = Progress {
            current_page: 1,
            total_pages: 7,
            percent: 14.3,
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        let (state, catalog_root) = progress_recovery_state(&[comic]).await;
        *state.smb_config.write().unwrap() = Some(smb_config);
        let content_hash = *blake3::hash(b"smb archive bytes").as_bytes();
        let revision = state::SourceRevision {
            len: b"smb archive bytes".len() as u64,
            modified: Some((1, 0)),
            ctime: None,
            file_id: None,
        };
        let old_token = state
            .remember_progress_recovery_evidence_with_smb_hash(
                "book",
                &smb_source,
                "book.cbz",
                7,
                10,
                Some(revision.clone()),
                Some(content_hash),
            )
            .unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();
        let started_tx = std::sync::Mutex::new(Some(started_tx));
        let continue_rx = std::sync::Mutex::new(Some(continue_rx));
        let hash = content_hash;
        let recovery_source = smb_source.clone();
        let recovery_state = state.clone();
        let recovery_token = old_token.clone();
        let recovery = tokio::spawn(async move {
            recover_reading_progress_inner_with_smb_hash(
                &recovery_state,
                progress_recovery_request("book", &recovery_source, 5, 7, 1, &recovery_token),
                move |_, _| {
                    let started_tx = started_tx.lock().unwrap().take();
                    let continue_rx = continue_rx.lock().unwrap().take().unwrap();
                    Box::pin(async move {
                        if let Some(started_tx) = started_tx {
                            let _ = started_tx.send(());
                        }
                        continue_rx.await.map_err(|error| error.to_string())?;
                        Ok((b"smb archive bytes".len() as u64, hash))
                    })
                },
            )
            .await
        });

        started_rx.await.unwrap();
        let identity = format!("{smb_source}\0book");
        let publication_state = state.clone();
        let publication_revision = revision.clone();
        let publication_source = smb_source.clone();
        let publication_identity = identity.clone();
        let publication = tokio::spawn(async move {
            with_comic_progress_lifecycle(&publication_state, &publication_identity, || {
                publication_state.remember_progress_recovery_evidence_with_smb_hash(
                    "book",
                    &publication_source,
                    "book.cbz",
                    7,
                    11,
                    Some(publication_revision),
                    Some(hash),
                )
            })
            .await
        });
        let reopened_token = tokio::time::timeout(std::time::Duration::from_secs(1), publication)
            .await
            .expect("SMB hashing must not hold the open publication lock")
            .unwrap()
            .unwrap();
        assert_eq!(reopened_token, old_token);
        assert_eq!(
            state
                .progress_recovery_evidence("book", &smb_source, "book.cbz")
                .unwrap()
                .generation,
            11
        );

        continue_tx.send(()).unwrap();
        let error = recovery.await.unwrap().unwrap_err();
        assert!(error.contains("READING_PROGRESS_RECOVERY_MANUAL_CHECK"));
        assert_eq!(
            state
                .catalog
                .read()
                .unwrap()
                .clone()
                .unwrap()
                .get_runtime_item_for_source("book", &smb_source)
                .unwrap()
                .unwrap()
                .progress
                .current_page,
            1
        );
        assert_eq!(state.progress_sequences.lock().await.get(&identity), None);
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[tokio::test]
    async fn smb_progress_recovery_rejects_intervening_intents_and_legacy_writes() {
        for mutation in 0..3 {
            let smb_config = state::SmbConfig {
                host: "example.invalid".into(),
                share: "comics".into(),
                username: Some("reader".into()),
                password: Some("secret".into()),
            };
            let smb_source = state::smb_source_id(&smb_config);
            let mut comic = capability_comic("book", "Book");
            comic.source_id = smb_source.clone();
            comic.relative_path = "book.cbz".into();
            comic.source_path = None;
            comic.progress = Progress {
                current_page: 1,
                total_pages: 7,
                percent: 14.3,
                updated_at: Some(chrono::Utc::now().to_rfc3339()),
            };
            let (state, catalog_root) = progress_recovery_state(&[comic]).await;
            *state.smb_config.write().unwrap() = Some(smb_config);
            let content_hash = *blake3::hash(b"smb archive bytes").as_bytes();
            let revision = state::SourceRevision {
                len: b"smb archive bytes".len() as u64,
                modified: Some((1, 0)),
                ctime: None,
                file_id: None,
            };
            let token = state
                .remember_progress_recovery_evidence_with_smb_hash(
                    "book",
                    &smb_source,
                    "book.cbz",
                    7,
                    10,
                    Some(revision),
                    Some(content_hash),
                )
                .unwrap();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();
            let started_tx = std::sync::Mutex::new(Some(started_tx));
            let continue_rx = std::sync::Mutex::new(Some(continue_rx));
            let recovery_source = smb_source.clone();
            let recovery_state = state.clone();
            let recovery = tokio::spawn(async move {
                recover_reading_progress_inner_with_smb_hash(
                    &recovery_state,
                    progress_recovery_request("book", &recovery_source, 5, 7, 1, &token),
                    move |_, _| {
                        let started_tx = started_tx.lock().unwrap().take();
                        let continue_rx = continue_rx.lock().unwrap().take().unwrap();
                        Box::pin(async move {
                            if let Some(started_tx) = started_tx {
                                let _ = started_tx.send(());
                            }
                            continue_rx.await.map_err(|error| error.to_string())?;
                            Ok((b"smb archive bytes".len() as u64, content_hash))
                        })
                    },
                )
                .await
            });

            started_rx.await.unwrap();
            let identity = format!("{smb_source}\0book");
            match mutation {
                0 => commit_progress_sequence(&state, &identity, Some(2)).await,
                1 => {
                    begin_pending_open(&state, "book", Some(smb_source.clone()));
                }
                _ => {
                    // Legacy/native callers may omit sequence; SQLite must still
                    // fence an intervening successful write during the unlocked I/O.
                    state
                        .catalog
                        .read()
                        .unwrap()
                        .clone()
                        .unwrap()
                        .save_progress_for_source(
                            "book",
                            &smb_source,
                            &Progress {
                                current_page: 4,
                                total_pages: 7,
                                percent: 57.1,
                                updated_at: Some(chrono::Utc::now().to_rfc3339()),
                            },
                        )
                        .unwrap();
                }
            }
            continue_tx.send(()).unwrap();
            let error = recovery.await.unwrap().unwrap_err();
            assert!(error.contains("READING_PROGRESS_RECOVERY_MANUAL_CHECK"));
            assert_eq!(
                state
                    .catalog
                    .read()
                    .unwrap()
                    .clone()
                    .unwrap()
                    .get_runtime_item_for_source("book", &smb_source)
                    .unwrap()
                    .unwrap()
                    .progress
                    .current_page,
                if mutation == 2 { 4 } else { 1 }
            );
            assert_eq!(
                state.progress_sequences.lock().await.get(&identity),
                if mutation == 0 { Some(&2) } else { None }
            );
            fs::remove_dir_all(catalog_root).unwrap();
        }
    }

    #[tokio::test]
    async fn missing_folder_revision_is_an_optional_probe() {
        let root = std::env::temp_dir().join(format!(
            "gai-folder-revision-probe-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let authorized =
            cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
        assert!(
            optional_directory_source_revision(&authorized, Path::new("missing-folder"))
                .await
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn manual_progress_recovery_persists_after_reader_close_with_exact_evidence() {
        let source_root = std::env::temp_dir().join(format!(
            "gai-progress-recovery-source-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&source_root).unwrap();
        let archive = source_root.join("book.cbz");
        fs::write(&archive, b"archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "local:recovery".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        comic.progress.total_pages = 0;
        comic.progress.current_page = 0;
        let (state, root) = progress_recovery_state(&[comic.clone()]).await;
        let token = state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                7,
                3,
                Some(revision.clone()),
            )
            .unwrap();
        state
            .catalog
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: "local:recovery",
                relative_path: "book.cbz",
                token: &token,
                total_pages: 7,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();

        recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 5, 7, 1, &token),
        )
        .await
        .unwrap();

        let store = state.catalog.read().unwrap().clone().unwrap();
        let saved = store
            .get_runtime_item_for_source("book", "local:recovery")
            .unwrap()
            .unwrap();
        assert_eq!(saved.progress.current_page, 5);
        assert_eq!(saved.progress.total_pages, 7);
        let memory = state.comics.lock().await;
        assert_eq!(memory[0].progress.current_page, 5);
        assert_eq!(memory[0].progress.total_pages, 7);
        drop(memory);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(source_root).unwrap();
    }

    #[tokio::test]
    async fn manual_progress_recovery_fails_closed_without_exact_trusted_bounds() {
        let source_root = std::env::temp_dir().join(format!(
            "gai-progress-recovery-bounds-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&source_root).unwrap();
        let archive = source_root.join("book.cbz");
        fs::write(&archive, b"archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "local:recovery".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        comic.progress.total_pages = 0;
        let (state, root) = progress_recovery_state(&[comic.clone()]).await;
        let missing_evidence = recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 7, 1, "missing-token"),
        )
        .await;
        assert!(missing_evidence.is_err());

        let token = state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                7,
                3,
                Some(revision),
            )
            .unwrap();
        let mut legacy_request =
            progress_recovery_request("book", "local:recovery", 0, 7, 1, &token);
        legacy_request.recovery_token = None;
        assert!(recover_reading_progress_inner(&state, legacy_request)
            .await
            .is_err());
        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 6, 1, &token),
        )
        .await
        .is_err());
        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 7, 7, 1, &token),
        )
        .await
        .is_err());
        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:wrong-source", 0, 7, 1, &token),
        )
        .await
        .is_err());
        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("photo-album:test", "local:recovery", 0, 7, 1, &token),
        )
        .await
        .is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(source_root).unwrap();
    }

    #[tokio::test]
    async fn manual_progress_recovery_rejects_ambiguous_catalog_locations() {
        let mut first = capability_comic("book", "Book A");
        first.source_id = "local:recovery".into();
        first.relative_path = "a/book.cbz".into();
        let mut second = first.clone();
        second.relative_path = "b/book.cbz".into();
        second.title = "Book B".into();
        let (state, root) = progress_recovery_state(&[first, second]).await;

        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 7, 1, "missing-token"),
        )
        .await
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn manual_progress_recovery_rejects_replaced_archive_and_stale_sequence() {
        let root = std::env::temp_dir().join(format!(
            "gai-progress-recovery-revision-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join("book.cbz");
        fs::write(&archive, b"first archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "local:recovery".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        comic.progress.total_pages = 0;
        let (state, catalog_root) = progress_recovery_state(&[comic]).await;
        let token = state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                7,
                3,
                Some(revision),
            )
            .unwrap();
        fs::write(&archive, b"replacement archive with different identity").unwrap();
        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 7, 1, &token),
        )
        .await
        .is_err());

        // A newer sequence committed through the same per-source lock fences
        // an older recovery even when the file evidence remains valid.
        commit_progress_sequence(&state, "local:recovery\0book", Some(4)).await;
        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 7, 3, &token),
        )
        .await
        .is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[tokio::test]
    async fn reopening_same_location_with_a_different_page_count_invalidates_old_evidence() {
        let source_root = std::env::temp_dir().join(format!(
            "gai-progress-recovery-reopen-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&source_root).unwrap();
        let archive = source_root.join("book.cbz");
        fs::write(&archive, b"archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "local:recovery".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        comic.progress.total_pages = 0;
        let (state, catalog_root) = progress_recovery_state(&[comic]).await;
        let old_token = state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                7,
                3,
                Some(revision.clone()),
            )
            .unwrap();
        state
            .catalog
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: "local:recovery",
                relative_path: "book.cbz",
                token: &old_token,
                total_pages: 7,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();
        let new_token = state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                8,
                4,
                Some(revision.clone()),
            )
            .unwrap();
        state
            .catalog
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: "local:recovery",
                relative_path: "book.cbz",
                token: &new_token,
                total_pages: 8,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();

        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 7, 1, &old_token),
        )
        .await
        .is_err());
        assert!(recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 8, 1, &old_token),
        )
        .await
        .is_err());
        recover_reading_progress_inner(
            &state,
            progress_recovery_request("book", "local:recovery", 0, 8, 1, &new_token),
        )
        .await
        .unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
        fs::remove_dir_all(source_root).unwrap();
    }

    #[tokio::test]
    async fn open_publication_waits_for_cancelled_sqlite_progress_write() {
        let source_root =
            std::env::temp_dir().join(format!("gai-progress-token-race-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&source_root).unwrap();
        let archive = source_root.join("book.cbz");
        fs::write(&archive, b"archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "local:recovery".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        let (state, catalog_root) = progress_recovery_state(&[comic]).await;
        let old_token = state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                7,
                3,
                Some(revision.clone()),
            )
            .unwrap();
        let identity = "local:recovery\0book";
        let progress_lock = comic_progress_lock(&state, identity).await;
        let lifecycle = progress_lock.clone().lock_owned().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        let store = state.catalog.read().unwrap().clone().unwrap();
        let command_state = state.clone();
        let command = tokio::spawn(async move {
            let _lifecycle = persist_progress_and_commit_sequence(
                command_state,
                identity.to_string(),
                Some(12),
                lifecycle,
                move || {
                    let _ = started_tx.send(());
                    continue_rx.recv().unwrap();
                    store
                        .save_progress_for_source(
                            "book",
                            "local:recovery",
                            &Progress {
                                current_page: 5,
                                total_pages: 7,
                                percent: 71.4,
                                updated_at: Some(chrono::Utc::now().to_rfc3339()),
                            },
                        )
                        .map_err(|error| error.to_string())
                },
            )
            .await
            .unwrap();
        });

        // Cancel the command waiter while the real catalog write is paused.
        // The same publication gate used by open_comic must wait for SQLite
        // and its sequence fence before replacing the recovery token.
        started_rx.await.unwrap();
        command.abort();
        let open_state = state.clone();
        let open_revision = revision.clone();
        let open = tokio::spawn(async move {
            with_comic_progress_lifecycle(&open_state, identity, || {
                open_state.remember_progress_recovery_evidence(
                    "book",
                    "local:recovery",
                    "book.cbz",
                    8,
                    4,
                    Some(open_revision),
                )
            })
            .await
        });
        tokio::task::yield_now().await;
        continue_tx.send(()).unwrap();

        let new_token = open.await.unwrap().unwrap();
        assert_ne!(old_token, new_token);
        let saved = state
            .catalog
            .read()
            .unwrap()
            .clone()
            .unwrap()
            .get_runtime_item_for_source("book", "local:recovery")
            .unwrap()
            .unwrap();
        assert_eq!(saved.progress.current_page, 5);
        assert_eq!(saved.progress.total_pages, 7);
        assert_eq!(
            state.progress_sequences.lock().await.get(identity),
            Some(&12)
        );
        fs::remove_dir_all(catalog_root).unwrap();
        fs::remove_dir_all(source_root).unwrap();
    }

    #[tokio::test]
    async fn open_progress_snapshot_waits_for_exact_sqlite_progress_write() {
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "local:recovery".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some("/tmp/book.cbz".into());
        comic.progress = Progress {
            current_page: 1,
            total_pages: 7,
            percent: 14.3,
            updated_at: None,
        };
        let opened_comic = comic.clone();
        let (state, catalog_root) = progress_recovery_state(&[comic]).await;
        let store = state.catalog.read().unwrap().clone().unwrap();
        let identity = "local:recovery\0book";
        let progress_lock = comic_progress_lock(&state, identity).await;
        let lifecycle = progress_lock.clone().lock_owned().await;
        let (write_started_tx, write_started_rx) = tokio::sync::oneshot::channel();
        let (write_continue_tx, write_continue_rx) = std::sync::mpsc::channel();
        let write_state = state.clone();
        let write = tokio::spawn(async move {
            let _lifecycle = persist_progress_and_commit_sequence(
                write_state,
                identity.to_string(),
                Some(2),
                lifecycle,
                move || {
                    let _ = write_started_tx.send(());
                    write_continue_rx.recv().unwrap();
                    store.save_progress_for_source_location(
                        "book",
                        "local:recovery",
                        "book.cbz",
                        &Progress {
                            current_page: 5,
                            total_pages: 7,
                            percent: 71.4,
                            updated_at: Some("2026-11-08T00:00:00Z".into()),
                        },
                    )
                },
            )
            .await
            .unwrap();
        });
        write_started_rx.await.unwrap();

        let (open_requested_tx, open_requested_rx) = tokio::sync::oneshot::channel();
        let (snapshot_started_tx, mut snapshot_started_rx) = tokio::sync::oneshot::channel();
        let open_state = state.clone();
        let snapshot_state = open_state.clone();
        let snapshot_comic = opened_comic;
        let open_identity = identity.to_string();
        let open = tokio::spawn(async move {
            let _ = open_requested_tx.send(());
            with_comic_progress_lifecycle_prepared(
                &open_state,
                &open_identity,
                || async move {
                    let _ = snapshot_started_tx.send(());
                    open_comic_progress_snapshot(&snapshot_state, &snapshot_comic, 7, false).await
                },
                Ok,
            )
            .await
        });
        open_requested_rx.await.unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(
            snapshot_started_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        write_continue_tx.send(()).unwrap();
        write.await.unwrap();
        snapshot_started_rx.await.unwrap();
        let opened_progress = open.await.unwrap().unwrap();
        assert_eq!(opened_progress.current_page, 5);
        assert_eq!(opened_progress.total_pages, 7);
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[tokio::test]
    async fn open_progress_snapshot_falls_back_to_exact_unindexed_location() {
        let mut exact = capability_comic("book", "Book");
        exact.source_id = "local:new-root".into();
        exact.relative_path = "new/book.cbz".into();
        exact.progress = Progress {
            current_page: 4,
            total_pages: 9,
            percent: 44.4,
            updated_at: None,
        };
        let mut decoy = exact.clone();
        decoy.source_id = "external:other".into();
        decoy.relative_path = "elsewhere/book.cbz".into();
        decoy.progress.current_page = 8;
        let state = Arc::new(AppState::new());
        *state.comics.lock().await = vec![decoy, exact.clone()];

        let progress = open_comic_progress_snapshot(&state, &exact, 9, false)
            .await
            .unwrap();
        assert_eq!(progress.current_page, 4);
        assert_eq!(progress.total_pages, 9);
    }

    #[tokio::test]
    async fn opened_state_only_location_registers_without_retiring_catalog_and_saves() {
        let mut keep_a = capability_comic("keep-a", "Retained A");
        keep_a.source_id = "external:keep-a".into();
        keep_a.relative_path = "A/retained.cbz".into();
        let mut keep_b = capability_comic("keep-b", "Retained B");
        keep_b.source_id = "external:keep-b".into();
        keep_b.relative_path = "B/retained.cbz".into();
        let (state, catalog_root) =
            progress_recovery_state(&[keep_a.clone(), keep_b.clone()]).await;

        let mut opened = capability_comic("new-runtime", "03 new book");
        opened.source_id = "local:new-root".into();
        opened.relative_path = "03/new-book.cbz".into();
        opened.source_path = Some("/authorized/root/03/new-book.cbz".into());
        opened.progress = Progress {
            current_page: 0,
            total_pages: 3,
            percent: 0.0,
            updated_at: None,
        };
        state.comics.lock().await.push(opened.clone());
        let store = state.catalog.read().unwrap().clone().unwrap();
        let existing_ids = vec![keep_a.id.clone(), keep_b.id.clone()];
        assert_eq!(
            store.get_runtime_items_by_ids(&existing_ids).unwrap().len(),
            2
        );
        let retained_snapshots = [keep_a.clone(), keep_b.clone()]
            .into_iter()
            .map(|retained| {
                let metadata = store.get_metadata(&retained.id).unwrap();
                let location = store
                    .get_location_for_source(
                        &retained.id,
                        &retained.source_id,
                        &retained.relative_path,
                    )
                    .unwrap();
                (retained, metadata, location)
            })
            .collect::<Vec<_>>();

        let initial = open_comic_progress_snapshot(&state, &opened, 3, false)
            .await
            .unwrap();
        assert_eq!(initial.current_page, 0);
        store
            .save_progress_for_source_location(
                &opened.id,
                &opened.source_id,
                &opened.relative_path,
                &Progress {
                    current_page: 1,
                    total_pages: 3,
                    percent: 33.3,
                    updated_at: Some("2026-11-08T00:00:00Z".into()),
                },
            )
            .unwrap();

        let reopened = open_comic_progress_snapshot(&state, &opened, 3, false)
            .await
            .unwrap();
        assert_eq!(reopened.current_page, 1);
        assert_eq!(reopened.total_pages, 3);

        let all_ids = vec![keep_a.id.clone(), keep_b.id.clone(), opened.id.clone()];
        assert_eq!(store.get_runtime_items_by_ids(&all_ids).unwrap().len(), 3);
        for (retained, metadata_before, location_before) in retained_snapshots {
            let existing = store
                .get_runtime_item_for_source_path(
                    &retained.id,
                    &retained.source_id,
                    &retained.relative_path,
                )
                .unwrap()
                .expect("其他來源位置應保留");
            assert_eq!(existing.title, metadata_before.title);
            let metadata_after = store.get_metadata(&retained.id).unwrap();
            assert_eq!(metadata_after.comic_id, metadata_before.comic_id);
            assert_eq!(metadata_after.title, metadata_before.title);
            assert_eq!(metadata_after.series, metadata_before.series);
            assert_eq!(metadata_after.creators, metadata_before.creators);
            assert_eq!(metadata_after.tags, metadata_before.tags);
            let location = store
                .get_location_for_source(&retained.id, &retained.source_id, &retained.relative_path)
                .unwrap();
            assert_eq!(location.id, location_before.id);
            assert_eq!(location.comic_id, location_before.comic_id);
            assert_eq!(location.online, location_before.online);
        }
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[tokio::test]
    async fn restarted_runtime_cannot_reuse_a_previous_journal_token() {
        let source_root = std::env::temp_dir().join(format!(
            "gai-progress-recovery-restart-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&source_root).unwrap();
        let archive = source_root.join("book.cbz");
        fs::write(&archive, b"archive").unwrap();
        let revision = state::SourceRevision::from_std_metadata(&fs::metadata(&archive).unwrap());
        let mut comic = capability_comic("book", "Book");
        comic.source_id = "local:recovery".into();
        comic.relative_path = "book.cbz".into();
        comic.source_path = Some(archive.to_string_lossy().into_owned());
        comic.progress.total_pages = 0;
        let (old_state, catalog_root) = progress_recovery_state(&[comic.clone()]).await;
        let old_token = old_state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                7,
                3,
                Some(revision.clone()),
            )
            .unwrap();
        old_state
            .catalog
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: "local:recovery",
                relative_path: "book.cbz",
                token: &old_token,
                total_pages: 7,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();

        // Reuse the persistent catalog but create fresh native runtime state.
        let new_state = Arc::new(AppState::new());
        *new_state.catalog.write().unwrap() = old_state.catalog.read().unwrap().clone();
        *new_state.comics.lock().await = vec![comic];
        new_state
            .progress_recovery_test_sources
            .lock()
            .unwrap()
            .insert("local:recovery".into());
        let new_token = new_state
            .remember_progress_recovery_evidence(
                "book",
                "local:recovery",
                "book.cbz",
                7,
                1,
                Some(revision.clone()),
            )
            .unwrap();
        new_state
            .catalog
            .read()
            .unwrap()
            .as_ref()
            .unwrap()
            .register_progress_recovery_proof(catalog::ProgressRecoveryProof {
                identifier: "book",
                source_id: "local:recovery",
                relative_path: "book.cbz",
                token: &new_token,
                total_pages: 7,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();
        assert_ne!(old_token, new_token);

        assert!(recover_reading_progress_inner(
            &new_state,
            progress_recovery_request("book", "local:recovery", 0, 7, 1, &old_token),
        )
        .await
        .is_err());
        recover_reading_progress_inner(
            &new_state,
            progress_recovery_request("book", "local:recovery", 0, 7, 1, &new_token),
        )
        .await
        .unwrap();
        fs::remove_dir_all(catalog_root).unwrap();
        fs::remove_dir_all(source_root).unwrap();
    }

    #[test]
    fn duplicate_runtime_ids_from_different_sources_cannot_open() {
        let first = capability_comic("shared", "A");
        let mut second = capability_comic("shared", "B");
        assert!(!runtime_id_has_multiple_locations(
            &[first.clone(), second.clone()],
            "shared"
        ));
        second.source_id = "external:other".into();
        assert!(runtime_id_has_multiple_locations(
            &[first, second],
            "shared"
        ));
    }

    #[test]
    fn explicit_source_cannot_replace_a_live_runtime_id_from_another_source() {
        let first = capability_comic("shared", "A");
        assert!(runtime_id_conflicts_with_requested_source(
            &[first],
            "shared",
            "external:other",
            true
        ));
    }

    #[test]
    fn explicit_online_source_ignores_retired_offline_source() {
        let mut retired = capability_comic("shared", "old");
        retired.r#type = "offline".into();
        retired.source_id = "local:old".into();
        assert!(!runtime_id_conflicts_with_requested_source(
            &[retired],
            "shared",
            "local:new",
            false
        ));
        let mut online = capability_comic("shared", "new");
        online.source_id = "local:new".into();
        assert!(runtime_id_conflicts_with_requested_source(
            &[online],
            "shared",
            "local:old",
            true
        ));
    }

    #[test]
    fn runtime_id_with_same_source_but_different_path_is_ambiguous() {
        let first = capability_comic("shared", "A");
        let mut second = first.clone();
        second.relative_path = "other.cbz".into();
        assert!(runtime_id_has_multiple_locations(
            &[first, second],
            "shared"
        ));
    }

    #[test]
    fn explicit_source_still_rejects_multiple_online_paths() {
        let first = capability_comic("shared", "A");
        let mut second = first.clone();
        second.relative_path = "other.cbz".into();
        assert!(runtime_id_has_multiple_locations_for_source(
            &[first, second],
            "shared",
            "local:test"
        ));
    }

    #[test]
    fn close_request_cannot_close_a_different_source_with_same_id() {
        assert!(!close_request_matches_reader(
            "shared",
            Some("local:old"),
            Some("shared"),
            Some("local:new"),
            None,
            None,
        ));
        assert!(close_request_matches_reader(
            "shared",
            Some("local:new"),
            Some("shared"),
            Some("local:new"),
            None,
            None,
        ));
        assert!(close_request_matches_reader(
            "shared",
            None,
            Some("shared"),
            Some("local:new"),
            Some("shared"),
            Some("local:pending"),
        ));
    }

    #[test]
    fn runtime_id_location_ambiguity_ignores_retired_offline_rows_when_online_exists() {
        let mut offline = capability_comic("shared", "old");
        offline.r#type = "offline".into();
        offline.source_id = "local:old".into();
        let online = capability_comic("shared", "new");
        assert!(!runtime_id_has_multiple_locations(
            &[offline, online],
            "shared"
        ));
    }

    #[test]
    fn state_selection_prefers_online_path_for_explicit_source() {
        let mut offline = capability_comic("shared", "old");
        offline.r#type = "offline".into();
        offline.source_id = "local:new".into();
        offline.relative_path = "old/book.cbz".into();
        let mut online = capability_comic("shared", "new");
        online.source_id = "local:new".into();
        online.relative_path = "new/book.cbz".into();
        let selected =
            select_runtime_item_from_state(&[offline, online], "shared", Some("local:new"))
                .unwrap();
        assert_eq!(selected.title, "new");
        assert_eq!(selected.relative_path, "new/book.cbz");
    }

    #[test]
    fn unqualified_open_prefers_catalog_online_over_retired_state_item() {
        let mut retired = capability_comic("shared", "Old");
        retired.r#type = "offline".into();
        retired.source_id = "local:old".into();
        let online = capability_comic("shared", "New");
        let selected = prefer_online_catalog_item(Some(retired), Some(online)).unwrap();
        assert_eq!(selected.title, "New");
    }

    #[test]
    fn legacy_requested_local_is_normalized_to_captured_root() {
        let scan_dir = "/books/current";
        let expected = scanner::local_source_id(Path::new(scan_dir));
        assert_eq!(
            normalize_requested_source_id(Some("local".into()), scan_dir),
            Some(expected.clone())
        );
        assert_eq!(
            normalize_requested_source_id(Some(expected.clone()), scan_dir),
            Some(expected)
        );
    }

    #[test]
    fn catalog_runtime_fallback_rejects_cross_source_duplicates() {
        let first = capability_comic("shared", "A");
        let mut second = capability_comic("shared", "B");
        second.source_id = "external:other".into();
        assert!(unique_catalog_runtime_item(vec![first, second]).is_err());
    }

    #[test]
    fn catalog_runtime_fallback_rejects_same_source_different_paths() {
        let first = capability_comic("shared", "A");
        let mut second = first.clone();
        second.relative_path = "other.cbz".into();
        assert!(unique_catalog_runtime_item(vec![first, second]).is_err());
    }

    #[test]
    fn catalog_runtime_fallback_hides_quarantine_but_keeps_normal_location() {
        let mut quarantined = capability_comic("quarantined", "隔離");
        quarantined.relative_path = ".gai-quarantine/operation/book.cbz".into();
        quarantined.r#type = "offline".into();
        assert!(unique_catalog_runtime_item(vec![quarantined])
            .unwrap()
            .is_none());

        let mut normal = capability_comic("normal", "正常");
        normal.relative_path = "library/book.cbz".into();
        let selected = unique_catalog_runtime_item(vec![normal]).unwrap().unwrap();
        assert_eq!(selected.relative_path, "library/book.cbz");
    }

    #[test]
    fn catalog_runtime_fallback_prefers_online_over_retired_offline_item() {
        let mut offline = capability_comic("shared", "old");
        offline.r#type = "offline".into();
        offline.source_id = "local:old".into();
        let online = capability_comic("shared", "new");
        assert_eq!(
            unique_catalog_runtime_item(vec![offline, online])
                .unwrap()
                .unwrap()
                .title,
            "new"
        );
    }

    #[test]
    fn runtime_item_normalization_uses_explicit_source_identity() {
        let mut smb = capability_comic("smb", "NAS");
        smb.source_id = "smb".into();
        assert_eq!(normalize_runtime_item(smb).r#type, "smb-archive");

        let local = capability_comic("local", "本機");
        assert_eq!(normalize_runtime_item(local).r#type, "archive");

        let mut external = capability_comic("external", "外部");
        external.source_id = "external:bookmark".into();
        external.r#type = "folder".into();
        assert_eq!(normalize_runtime_item(external).r#type, "external-folder");

        let mut local_image = capability_comic("local-image", "本機圖片");
        local_image.r#type = "image".into();
        assert_eq!(normalize_runtime_item(local_image).r#type, "image");

        let mut external_image = capability_comic("external-image", "外部圖片");
        external_image.source_id = "external:bookmark".into();
        external_image.r#type = "image".into();
        assert_eq!(
            normalize_runtime_item(external_image).r#type,
            "external-image"
        );

        let mut unknown = capability_comic("unknown", "舊來源");
        unknown.source_id = "legacy-unknown".into();
        assert_eq!(normalize_runtime_item(unknown).r#type, "external-archive");
    }

    #[test]
    fn register_comic_capability_promotes_legacy_local_identity() {
        let root = std::env::temp_dir().join(format!(
            "gai-legacy-local-register-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let source_id = scanner::local_source_id(&root);
        let mut legacy = capability_comic("legacy", "Legacy");
        legacy.source_id = "local".into();
        let mut current = legacy.clone();
        current.source_id = source_id.clone();
        current.r#type = "archive".into();

        let mut comics = vec![legacy];
        register_comic_capability(&mut comics, &current);
        assert_eq!(comics[0].source_id, source_id);
        assert_eq!(comics[0].r#type, "archive");
    }

    #[test]
    fn register_comic_capability_replaces_retired_offline_location_with_online() {
        let mut retired = capability_comic("same", "Old");
        retired.r#type = "offline".into();
        retired.source_id = "local:old".into();
        retired.relative_path = "old/book.zip".into();
        let mut online = capability_comic("same", "New");
        online.source_id = "local:new".into();
        online.relative_path = "new/book.zip".into();

        let mut comics = vec![retired];
        register_comic_capability(&mut comics, &online);
        assert_eq!(comics.len(), 2);
        assert_eq!(comics[0].source_id, "local:old");
        assert_eq!(comics[0].r#type, "offline");
        assert_eq!(comics[1].source_id, "local:new");
        assert_eq!(comics[1].title, "New");
        assert_eq!(
            select_runtime_item_from_state(&comics, "same", None)
                .unwrap()
                .source_id,
            "local:new"
        );
    }

    #[test]
    fn explain_page_request_defaults_to_traditional_chinese() {
        let request: ExplainPageRequest =
            serde_json::from_value(serde_json::json!({"dataUrl": "data:image/png;base64,AA=="}))
                .unwrap();
        assert_eq!(request.target_locale, "zh-Hant");
    }

    #[test]
    fn explain_page_prompts_focus_on_written_meaning_in_the_selected_language() {
        for (locale, language) in [("zh-Hant", "繁體中文"), ("en", "English"), ("ja", "日本語")]
        {
            let prompt = explain_page_prompt(locale).unwrap();
            assert!(prompt.contains(language));
            assert!(prompt.contains("Markdown"));
            assert!(
                prompt.contains("杜撰") || prompt.contains("guessing") || prompt.contains("創作")
            );
        }
        assert!(explain_page_prompt("fr").is_err());
    }

    #[test]
    fn catalog_only_comic_registers_protocol_capability_without_replacing_existing_item() {
        let existing = capability_comic("existing", "目前書架資料");
        let mut comics = vec![existing.clone()];
        register_comic_capability(&mut comics, &capability_comic("existing", "較舊的目錄資料"));
        register_comic_capability(&mut comics, &capability_comic("catalog-only", "目錄找回"));

        assert_eq!(comics.len(), 2);
        assert_eq!(comics[0].title, existing.title);
        assert_eq!(comics[0].r#type, "archive");
        assert!(comics.iter().any(|comic| comic.id == "catalog-only"));
    }

    #[test]
    fn progress_values_clamp_stale_indexes_and_finish_on_the_last_page() {
        assert_eq!(normalize_progress_values(99, 3).unwrap(), (2, 3, 100.0));
        assert_eq!(normalize_progress_values(0, 3).unwrap(), (0, 3, 0.0));
        assert_eq!(normalize_progress_values(0, 1).unwrap(), (0, 1, 100.0));
        assert_eq!(normalize_progress_values(5, 0).unwrap(), (0, 0, 0.0));
        assert_eq!(authoritative_total_pages(Some(7), 999).unwrap(), 7);
        assert_eq!(authoritative_total_pages(None, 9).unwrap(), 9);
    }

    #[test]
    fn smb_commit_is_atomic_with_reader_cancellation() {
        let root = std::env::temp_dir().join(format!(
            "gai-smb-commit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source_id = "smb:v1:test";
        let temp_root = open_smb_temp_root(&root, source_id).unwrap();
        let partial = Path::new("book.part");
        let final_path = Path::new("book.cbz");
        let mut partial_file = temp_root
            .open_with(
                partial,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .unwrap()
            .into_std();
        partial_file.write_all(b"complete").unwrap();
        let state = AppState::new();
        state
            .reader_generation
            .store(4, std::sync::atomic::Ordering::Release);
        commit_smb_download_if_current(&state, 4, &temp_root, partial, final_path).unwrap();
        assert_eq!(
            fs::read(
                root.join("ComicTemp")
                    .join(source_id.replace(':', "_"))
                    .join("book.cbz"),
            )
            .unwrap(),
            b"complete"
        );

        let stale_partial = Path::new("stale.part");
        let mut stale_file = temp_root
            .open_with(
                stale_partial,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .unwrap()
            .into_std();
        stale_file.write_all(b"stale").unwrap();
        state
            .reader_generation
            .store(5, std::sync::atomic::Ordering::Release);
        assert!(
            commit_smb_download_if_current(&state, 4, &temp_root, stale_partial, final_path)
                .is_err()
        );
        assert!(temp_root.try_exists(stale_partial).unwrap());
        temp_root.remove_file(stale_partial).unwrap();
        assert!(!temp_root.try_exists(stale_partial).unwrap());
        assert_eq!(
            fs::read(
                root.join("ComicTemp")
                    .join(source_id.replace(':', "_"))
                    .join("book.cbz"),
            )
            .unwrap(),
            b"complete"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn idless_close_retires_temp_root_before_a_new_smb_partial_is_created() {
        let root = std::env::temp_dir().join(format!("gai-smb-retire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source_id = "smb:v1:test";
        let old_temp_root = open_smb_temp_root(&root, source_id).unwrap();
        let stale_partial = Path::new("book.part");
        let mut stale_file = old_temp_root
            .open_with(
                stale_partial,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .unwrap()
            .into_std();
        stale_file.write_all(b"stale").unwrap();
        drop(stale_file);

        let state = AppState::new();
        state
            .reader_generation
            .store(7, std::sync::atomic::Ordering::Release);
        let retired = {
            let _lifecycle = state.comic_lifecycle.lock().unwrap();
            state
                .reader_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            retire_smb_temp_namespace(&root).unwrap()
        };
        assert!(retired.join("smb_v1_test/book.part").exists());
        assert!(!reader_generation_is_current(&state, 7));

        let new_temp_root = open_smb_temp_root(&root, source_id).unwrap();
        let new_partial = Path::new("book.part");
        let mut new_file = new_temp_root
            .open_with(
                new_partial,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .unwrap()
            .into_std();
        new_file.write_all(b"new").unwrap();
        drop(new_file);

        remove_retired_smb_temp_namespace(&retired);

        assert!(!retired.exists());
        assert!(new_temp_root.try_exists(new_partial).unwrap());
        assert_eq!(
            std::fs::read(root.join("ComicTemp").join("smb_v1_test").join("book.part")).unwrap(),
            b"new"
        );
        assert!(commit_smb_download_if_current(
            &state,
            7,
            &old_temp_root,
            stale_partial,
            Path::new("book.cbz")
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn smb_temp_root_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "gai-smb-symlink-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("ComicTemp")).unwrap();

        assert!(open_smb_temp_root(&root, "smb:v1:test").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn smb_config_is_trimmed_and_rejects_path_components() {
        let validated = validate_smb_config(Some(state::SmbConfig {
            host: " nas.local ".into(),
            share: " Comics ".into(),
            username: Some(" test-user ".into()),
            password: Some("secret".into()),
        }))
        .unwrap()
        .unwrap();
        assert_eq!(validated.host, "nas.local");
        assert_eq!(validated.share, "Comics");
        assert_eq!(validated.username.as_deref(), Some("test-user"));
        assert!(validate_smb_config(Some(state::SmbConfig {
            host: "nas/local".into(),
            share: "Comics".into(),
            username: None,
            password: None,
        }))
        .is_err());
    }

    #[test]
    fn export_filename_is_a_single_json_component() {
        assert_eq!(
            validate_export_filename("catalog.json").unwrap(),
            "catalog.json"
        );
        assert!(validate_export_filename("../catalog.json").is_err());
        assert!(validate_export_filename("catalog.txt").is_err());
    }

    #[test]
    fn scan_directory_rejects_broad_system_roots() {
        assert!(validate_scan_directory("/").is_err());
        assert!(validate_scan_directory("/Volumes").is_err());
        if let Some(home) = std::env::var_os("HOME") {
            assert!(validate_scan_directory(&home.to_string_lossy()).is_err());
        }
        assert!(validate_scan_directory("/Volumes/ExampleNAS").is_ok());
        assert!(validate_scan_directory("/Volumes/ExampleNAS/Comics").is_ok());
    }

    #[test]
    fn ios_documents_relocates_old_container_without_changing_external_sources() {
        let current = Path::new("/private/var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents");
        for old in [
            "/private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents",
            "/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents",
        ] {
            assert_eq!(relocate_ios_documents(old, current), current.to_string_lossy());
        }
        for external in [
            "/private/var/mobile/Containers/Shared/AppGroup/provider/Documents",
            "/Volumes/NAS/Comics",
            "/private/var/mobile/Containers/Data/Application/not-a-container/Documents",
            "/private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/../Library",
        ] {
            assert_eq!(relocate_ios_documents(external, current), external);
        }
        assert_eq!(
            relocate_ios_documents(&current.to_string_lossy(), current),
            current.to_string_lossy()
        );
    }

    #[test]
    fn progress_write_is_atomic_and_preserves_existing_entries() {
        let temp_dir =
            std::env::temp_dir().join(format!("comic_test_save_progress_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let old = Progress {
            current_page: 1,
            total_pages: 10,
            percent: 10.0,
            updated_at: None,
        };
        fs::write(
            temp_dir.join(".comic_progress.json"),
            serde_json::json!({"old": old}).to_string(),
        )
        .unwrap();

        let new = Progress {
            current_page: 5,
            total_pages: 10,
            percent: 50.0,
            updated_at: None,
        };
        write_progress_file(&temp_dir, "new", new).unwrap();

        let progress_file = temp_dir.join(".comic_progress.json");
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(progress_file).unwrap()).unwrap();
        assert_eq!(parsed["old"]["currentPage"], 1);
        assert_eq!(parsed["new"]["currentPage"], 5);
        assert!(fs::read_dir(&temp_dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp.")));

        fs::remove_dir_all(temp_dir).unwrap_or_default();
    }

    #[test]
    fn import_filename_rejects_paths_and_dot_components() {
        for filename in [
            "",
            ".",
            "..",
            "nested/photo.jpg",
            "..\\photo.jpg",
            "/photo.jpg",
            "photo:stream.jpg",
            "photo\0.jpg",
        ] {
            assert!(
                !is_safe_import_filename(filename),
                "accepted unsafe filename: {filename:?}"
            );
        }
        for filename in ["photo.jpg", "照片.png"] {
            assert!(
                is_safe_import_filename(filename),
                "rejected safe filename: {filename:?}"
            );
        }
    }

    #[test]
    fn import_file_uses_create_new_on_collision() {
        let temp_dir = std::env::temp_dir().join(format!(
            "comic_test_import_create_new_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(temp_dir.join("123_photo.jpg"), b"existing").unwrap();

        let import_dir =
            cap_std::fs::Dir::open_ambient_dir(&temp_dir, cap_std::ambient_authority()).unwrap();
        write_import_file(&import_dir, "photo.jpg", b"new", 123).unwrap();

        assert_eq!(
            fs::read(temp_dir.join("123_photo.jpg")).unwrap(),
            b"existing"
        );
        assert_eq!(fs::read(temp_dir.join("123_1_photo.jpg")).unwrap(), b"new");
        fs::remove_dir_all(temp_dir).unwrap_or_default();
    }

    #[test]
    fn binary_photo_payload_validates_filename_before_copy() {
        use base64::Engine as _;
        let encode = |name: &str| base64::engine::general_purpose::STANDARD.encode(name);
        let (name, bytes) = import_photo_payload(&encode("照片.png"), b"image").unwrap();
        assert_eq!(name, "照片.png");
        assert_eq!(bytes, b"image");
        assert!(import_photo_payload(&encode("../escape.png"), b"image").is_err());
        assert!(import_photo_payload(&encode("photo.png"), b"").is_err());
        assert!(import_photo_payload("invalid*base64", b"image").is_err());
        assert!(import_photo_payload(&encode(&"x".repeat(201)), b"image").is_err());
        let oversized = vec![0; MAX_IMPORTED_PHOTO_BYTES + 1];
        assert!(import_photo_payload(&encode("photo.png"), &oversized).is_err());
    }

    #[test]
    fn page_deletion_requires_current_source_and_active_bookmark() {
        let temp = std::env::temp_dir().join(format!("gai-page-auth-{}", uuid::Uuid::new_v4()));
        let old = temp.join("old");
        let new = temp.join("new");
        fs::create_dir_all(old.join("book")).unwrap();
        fs::create_dir_all(&new).unwrap();
        let mut item = capability_comic("book", "Book");
        item.source_id = scanner::local_source_id(&old);
        item.source_path = Some(old.join("book").to_string_lossy().into_owned());
        let mut active = std::collections::HashMap::new();
        assert!(authorized_page_comic_path(&item, old.to_str().unwrap(), &[], &active).is_ok());
        assert!(authorized_page_comic_path(&item, new.to_str().unwrap(), &[], &active).is_err());
        item.source_path = Some(new.to_string_lossy().into_owned());
        assert!(authorized_page_comic_path(&item, old.to_str().unwrap(), &[], &active).is_err());
        item.source_path = Some(old.join("book").to_string_lossy().into_owned());
        item.external_bookmark = Some("grant".into());
        item.source_id = scanner::external_source_id("grant");
        let bookmarks = vec![state::ExternalBookmark {
            bookmark: "grant".into(),
            name: "Old".into(),
        }];
        assert!(authorized_page_comic_path(&item, "", &bookmarks, &active).is_err());
        active.insert("grant".into(), old.to_string_lossy().into_owned());
        assert!(authorized_page_comic_path(&item, "", &bookmarks, &active).is_ok());
        assert!(authorized_page_comic_path(&item, "", &[], &active).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&new, old.join("escape")).unwrap();
            item.source_path = Some(old.join("escape").to_string_lossy().into_owned());
            assert!(authorized_page_comic_path(&item, "", &bookmarks, &active).is_err());
        }
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn imported_photo_uses_a_capability_beneath_the_scan_root() {
        let temp_dir =
            std::env::temp_dir().join(format!("comic_test_import_root_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        save_imported_photo_to_root(&temp_dir, "photo.jpg", b"image", 100_000, 123).unwrap();
        assert_eq!(
            fs::read(temp_dir.join("相簿匯入/匯入_1/123_photo.jpg")).unwrap(),
            b"image"
        );
        assert!(save_imported_photo_to_root(&temp_dir, "photo.jpg", &[], 100_000, 124).is_err());
        fs::remove_dir_all(temp_dir).unwrap_or_default();
    }

    #[test]
    fn corrupted_progress_is_not_overwritten() {
        let temp_dir =
            std::env::temp_dir().join(format!("comic_test_bad_progress_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let progress_file = temp_dir.join(".comic_progress.json");
        fs::write(&progress_file, "{broken").unwrap();

        let progress = Progress {
            current_page: 5,
            total_pages: 10,
            percent: 50.0,
            updated_at: None,
        };
        assert!(write_progress_file(&temp_dir, "new", progress).is_err());
        assert_eq!(fs::read_to_string(progress_file).unwrap(), "{broken");
        fs::remove_dir_all(temp_dir).unwrap_or_default();
    }

    #[test]
    fn ai_session_locks_models_and_requires_provider_neutral_disclosure() {
        assert!(validate_ai_session("openai", "not-a-real-api-key-for-tests", false,).is_err());
        let openai = validate_ai_session("openai", "not-a-real-api-key-for-tests", true).unwrap();
        assert_eq!(openai.model, "gpt-6-luna");

        assert!(validate_ai_session("google", "not-a-real-api-key-for-tests", false,).is_err());
        let google = validate_ai_session("google", "not-a-real-api-key-for-tests", true).unwrap();
        assert_eq!(google.model, "gemma-4-26b-a4b-it / gemma-4-31b-it");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_ai_keychain_roundtrip_is_provider_scoped_and_removable() {
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let provider = format!("gai-test-openai-{suffix}");
        let other_provider = format!("gai-test-google-{suffix}");
        macos_ai_keychain_delete(&provider).unwrap();
        macos_ai_keychain_delete(&other_provider).unwrap();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert!(!macos_ai_keychain_has(&provider).unwrap());
            macos_ai_keychain_save(&provider, "first-test-key").unwrap();
            assert!(macos_ai_keychain_has(&provider).unwrap());
            assert!(!macos_ai_keychain_has(&other_provider).unwrap());
            assert_eq!(macos_ai_keychain_load(&provider).unwrap(), "first-test-key");

            macos_ai_keychain_save(&provider, "second-test-key").unwrap();
            assert_eq!(
                macos_ai_keychain_load(&provider).unwrap(),
                "second-test-key"
            );
        }));
        macos_ai_keychain_delete(&provider).unwrap();
        macos_ai_keychain_delete(&other_provider).unwrap();
        result.unwrap();
        assert!(!macos_ai_keychain_has(&provider).unwrap());
    }

    #[test]
    fn ai_session_generation_cannot_advance_before_revoke_lock() {
        let state = Arc::new(AppState::new());
        *state.ai_session.write().unwrap() =
            Some(validate_ai_session("openai", "not-a-real-api-key-for-tests", true).unwrap());
        let read_guard = state.ai_session.read().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let state_for_revoke = state.clone();
        let revoke_thread = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            revoke_ai_session_in_memory(&state_for_revoke).unwrap();
        });
        started_rx.recv().unwrap();
        // The writer is blocked by the snapshot's read lock, so no caller can
        // observe a new generation paired with the old config.
        assert_eq!(
            state
                .ai_session_generation
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        drop(read_guard);
        revoke_thread.join().unwrap();
        assert!(ai_session_snapshot_locked(&state).is_err());
        assert_eq!(
            state
                .ai_session_generation
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn ai_transition_waits_for_shared_send_barrier_before_revoke_returns() {
        let state = Arc::new(AppState::new());
        *state.ai_session.write().unwrap() =
            Some(validate_ai_session("openai", "not-a-real-api-key-for-tests", true).unwrap());
        let send_guard = ai_send_lifecycle().read().await;
        let mut cancellation = ai_send_cancellation().subscribe();
        let state_for_revoke = state.clone();
        let revoke = tokio::spawn(async move {
            let _lifecycle = state_for_revoke.ai_session_lifecycle.lock().await;
            revoke_ai_session_in_memory(&state_for_revoke).unwrap();
            wait_for_ai_sends().await;
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), cancellation.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(!revoke.is_finished());
        drop(send_guard);
        revoke.await.unwrap();
        assert!(ai_session_snapshot_locked(&state).is_err());
    }

    #[tokio::test]
    async fn comic_progress_lock_serializes_late_persistence() {
        let state = Arc::new(AppState::new());
        let order = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let first_lock = comic_progress_lock(&state, "comic").await;
        let first_guard = first_lock.lock().await;
        let state_for_late = state.clone();
        let order_for_late = order.clone();
        let late = tokio::spawn(async move {
            let lock = comic_progress_lock(&state_for_late, "comic").await;
            let _guard = lock.lock().await;
            order_for_late.lock().await.push("late");
        });
        order.lock().await.push("first");
        tokio::task::yield_now().await;
        assert!(!late.is_finished());
        drop(first_guard);
        late.await.unwrap();
        assert_eq!(&*order.lock().await, &["first", "late"]);
    }

    #[tokio::test]
    async fn progress_sequence_rejects_older_request_after_newer_commit() {
        let state = AppState::new();
        let max_safe = catalog::MAX_SAFE_INTENT_SEQUENCE;
        progress_sequence_is_current(&state, "safe-comic", Some(max_safe))
            .await
            .unwrap();
        commit_progress_sequence(&state, "safe-comic", Some(max_safe)).await;
        let unsafe_error = progress_sequence_is_current(&state, "safe-comic", Some(max_safe + 1))
            .await
            .unwrap_err();
        assert!(unsafe_error.contains("安全整數"));
        assert_eq!(
            state
                .progress_sequences
                .lock()
                .await
                .get("safe-comic")
                .copied(),
            Some(max_safe)
        );

        progress_sequence_is_current(&state, "comic", Some(2))
            .await
            .unwrap();
        commit_progress_sequence(&state, "comic", Some(2)).await;
        let error = progress_sequence_is_current(&state, "comic", Some(1))
            .await
            .unwrap_err();
        assert!(error.contains("過期"));
        assert!(progress_sequence_is_current(&state, "comic", Some(3))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn progress_sequence_isolated_by_validated_source_snapshot() {
        let state = AppState::new();
        commit_progress_sequence(&state, "local:a\0shared", Some(2)).await;
        assert!(
            progress_sequence_is_current(&state, "local:b\0shared", Some(1))
                .await
                .is_ok()
        );
        assert!(
            progress_sequence_is_current(&state, "local:a\0shared", Some(1))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn bookmark_lifecycle_serializes_full_list_updates() {
        let state = Arc::new(AppState::new());
        let first_guard = state.bookmark_lifecycle.lock().await;
        let state_for_update = state.clone();
        let update = tokio::spawn(async move {
            let _guard = state_for_update.bookmark_lifecycle.lock().await;
        });
        tokio::task::yield_now().await;
        assert!(!update.is_finished());
        drop(first_guard);
        update.await.unwrap();
    }

    #[tokio::test]
    async fn scan_lifecycle_serializes_configured_root_transitions() {
        let state = Arc::new(AppState::new());
        let first_guard = state.scan_lifecycle.lock().await;
        let state_for_update = state.clone();
        let update = tokio::spawn(async move {
            let _guard = state_for_update.scan_lifecycle.lock().await;
        });
        tokio::task::yield_now().await;
        assert!(!update.is_finished());
        drop(first_guard);
        update.await.unwrap();
    }

    #[tokio::test]
    async fn non_json_ai_error_responses_preserve_status_for_http_errors_and_gemma_fallback() {
        for (status, content_type, body) in [
            (502, "text/html", b"<html>Bad Gateway</html>".to_vec()),
            (503, "application/json", Vec::new()),
        ] {
            let (observed_status, value) =
                mock_limited_ai_json_response(status, content_type, body)
                    .await
                    .unwrap();

            assert_eq!(observed_status.as_u16(), status);
            assert_eq!(value, serde_json::Value::Null);
            assert!(should_try_gemma_fallback(observed_status));
        }
    }

    #[tokio::test]
    async fn malformed_successful_ai_response_keeps_the_existing_parse_error() {
        let error = mock_limited_ai_json_response(200, "application/json", b"{malformed".to_vec())
            .await
            .unwrap_err();

        assert!(error.starts_with("艦載 AI 回應格式不正確："));
    }

    #[tokio::test]
    async fn valid_ai_json_response_keeps_its_status_and_value() {
        let (status, value) = mock_limited_ai_json_response(
            200,
            "application/json",
            br#"{"ok":true,"value":3}"#.to_vec(),
        )
        .await
        .unwrap();

        assert_eq!(status, reqwest::StatusCode::OK);
        assert_eq!(value, serde_json::json!({ "ok": true, "value": 3 }));

        let (status, value) = mock_limited_ai_json_response(
            503,
            "application/json",
            br#"{"error":{"message":"temporarily unavailable"}}"#.to_vec(),
        )
        .await
        .unwrap();

        assert_eq!(status, reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            value,
            serde_json::json!({ "error": { "message": "temporarily unavailable" } })
        );
    }

    #[tokio::test]
    async fn non_json_ai_error_body_still_obeys_the_response_size_cap() {
        let body = vec![b'x'; MAX_AI_RESPONSE_BYTES + 1];
        let error = mock_limited_ai_json_response(502, "text/html", body)
            .await
            .unwrap_err();

        assert_eq!(error, "艦載 AI 回應超過 1 MiB 安全上限");
    }

    #[test]
    fn gemma_response_hides_thinking_parts() {
        let response = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "thought": true, "text": "internal reasoning" },
                        { "text": "艦載 AI " },
                        { "thought": true, "text": "more internal reasoning" },
                        { "text": "連線成功。" }
                    ]
                },
                "finishReason": "STOP"
            }]
        });
        assert_eq!(
            gemma_response_result(&response).unwrap().as_deref(),
            Some("艦載 AI 連線成功。")
        );
        assert!(should_try_gemma_fallback(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(should_try_gemma_fallback(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert!(!should_try_gemma_fallback(reqwest::StatusCode::BAD_REQUEST));
        assert!(!should_try_gemma_fallback(reqwest::StatusCode::FORBIDDEN));
    }

    #[test]
    fn gemma_max_tokens_rejects_partial_text_and_other_finish_reasons_keep_text() {
        let truncated = serde_json::json!({
            "candidates": [{
                "content": { "parts": [{ "text": "半句未完成" }] },
                "finishReason": "MAX_TOKENS"
            }]
        });
        let error = gemma_response_result(&truncated).unwrap_err();
        assert!(error.starts_with(AI_OUTPUT_INCOMPLETE_PREFIX));

        let blocked = serde_json::json!({
            "candidates": [{
                "content": { "parts": [{ "text": "安全拒答" }] },
                "finishReason": "SAFETY"
            }]
        });
        assert_eq!(gemma_response_result(&blocked).unwrap().as_deref(), None);
        let empty_stop = serde_json::json!({
            "candidates": [{
                "content": { "parts": [{ "text": " \n" }] },
                "finishReason": "STOP"
            }]
        });
        assert_eq!(gemma_response_result(&empty_stop).unwrap(), None);
    }

    #[test]
    fn gemma_requests_alternate_models_and_retry_the_other_one() {
        assert_eq!(
            gemma_model_order(0),
            ["gemma-4-26b-a4b-it", "gemma-4-31b-it"]
        );
        assert_eq!(
            gemma_model_order(1),
            ["gemma-4-31b-it", "gemma-4-26b-a4b-it"]
        );
        assert_eq!(gemma_model_order(2), gemma_model_order(0));
    }

    #[test]
    fn ai_provider_errors_never_echo_the_active_key() {
        let key = "test-google-key-1234567890";
        let error = format!("Permission denied: Consumer 'api_key:{key}' has been suspended.");
        let redacted = redact_ai_error(error, key);
        assert!(!redacted.contains(key));
        assert!(redacted.contains("has been suspended"));
        assert!(redacted.contains("[REDACTED API KEY]"));
    }

    #[test]
    fn ai_response_text_ignores_non_text_content() {
        let payload = serde_json::json!({
            "output": [{"content": [
                {"type": "reasoning", "text": "hidden"},
                {"type": "output_text", "text": "艦載 AI 連線成功。"}
            ]}]
        });
        assert_eq!(
            response_text(&payload).as_deref(),
            Some("艦載 AI 連線成功。")
        );
        let refusal = serde_json::json!({
            "output": [{"content": [{"type": "refusal", "refusal": "The sample is too blurry to read."}]}]
        });
        assert_eq!(
            response_text(&refusal).as_deref(),
            Some("The sample is too blurry to read.")
        );
    }

    #[test]
    fn openai_completed_response_collects_all_text_and_skips_reasoning() {
        let response = serde_json::json!({
            "status": "completed",
            "output": [
                { "type": "reasoning", "content": [{ "type": "reasoning_text", "text": "hidden" }] },
                { "type": "message", "content": [
                    { "type": "output_text", "text": "完整" },
                    { "type": "reasoning", "text": "hidden too" },
                    { "type": "output_text", "text": "翻譯。" }
                ] }
            ]
        });
        assert_eq!(
            openai_response_text(&response).unwrap().as_deref(),
            Some("完整翻譯。")
        );
        let whitespace = serde_json::json!({
            "status": "completed",
            "output": [{ "content": [{ "type": "output_text", "text": " \n\t" }] }]
        });
        assert_eq!(openai_response_text(&whitespace).unwrap(), None);
    }

    #[test]
    fn openai_incomplete_response_rejects_partial_text_and_failed_status_is_not_success() {
        let incomplete = serde_json::json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": [{ "content": [{ "type": "output_text", "text": "半句未完成" }] }]
        });
        let error = openai_response_text(&incomplete).unwrap_err();
        assert!(error.starts_with(AI_OUTPUT_INCOMPLETE_PREFIX));

        let failed = serde_json::json!({
            "status": "failed",
            "output": [{ "content": [{ "type": "output_text", "text": "供應商失敗回覆" }] }]
        });
        assert_eq!(openai_response_text(&failed).unwrap().as_deref(), None);
    }

    #[test]
    fn ai_metadata_suggestions_are_bounded_and_parse_json_only() {
        let parsed = parse_ai_metadata_suggestions(
            "```json\n[{\"field\":\"tags\",\"value\":[{\"namespace\":\"general\",\"value\":\"百合\"}],\"confidence\":0.8}]\n```",
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].field, "tags");
        assert!(parse_ai_metadata_suggestions(
            "[{\"field\":\"title\",\"value\":\"不允許\",\"confidence\":1.0}]"
        )
        .is_err());
    }

    #[test]
    fn metadata_request_defaults_to_traditional_chinese_and_limits_locale() {
        let request: SuggestMetadataRequest = serde_json::from_value(serde_json::json!({
            "comicId": "comic",
            "dataUrls": ["data:image/png;base64,AA=="]
        }))
        .unwrap();
        assert_eq!(request.target_locale, "zh-Hant");
        assert!(metadata_prompt("zh-Hant").is_ok());
        assert!(metadata_prompt("en").is_ok());
        assert!(metadata_prompt("ja").is_ok());
        assert!(metadata_prompt("fr").is_err());
    }

    #[test]
    fn provider_image_parts_keep_page_order_before_text() {
        let images = [("image/png", "first"), ("image/jpeg", "second")];
        assert!(openai_image_content(&[]).is_empty());
        assert!(gemma_image_parts(&[]).is_empty());
        let openai = openai_image_content(&images);
        assert_eq!(openai.len(), 2);
        assert_eq!(openai[0]["type"], "input_image");
        assert!(openai[0]["image_url"].as_str().unwrap().contains("first"));
        assert!(openai[1]["image_url"].as_str().unwrap().contains("second"));

        let gemma = gemma_image_parts(&images);
        assert_eq!(gemma.len(), 2);
        assert_eq!(gemma[0]["inlineData"]["mimeType"], "image/png");
        assert_eq!(gemma[1]["inlineData"]["data"], "second");
    }

    #[test]
    fn metadata_image_limits_enforce_six_pages_two_mib_each_and_ten_mib_total() {
        use base64::Engine as _;
        let small = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode([0u8; 1])
        );
        assert_eq!(
            validate_metadata_images(&vec![small.clone(); 6])
                .unwrap()
                .len(),
            6
        );
        assert!(validate_metadata_images(&vec![small.clone(); 7]).is_err());
        assert!(validate_metadata_images(&[]).is_err());

        let too_large = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD
                .encode(vec![0u8; MAX_AI_METADATA_IMAGE_BYTES + 1])
        );
        assert!(validate_metadata_images(&[too_large]).is_err());

        let two_mib = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD
                .encode(vec![0u8; MAX_AI_METADATA_IMAGE_BYTES])
        );
        assert_eq!(
            validate_metadata_images(&vec![two_mib; 5]).unwrap().len(),
            5
        );
        let six_mib = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD
                .encode(vec![0u8; MAX_AI_METADATA_IMAGE_BYTES])
        );
        assert!(validate_metadata_images(&vec![six_mib; 6]).is_err());
    }

    #[test]
    fn metadata_refusal_is_specific_and_bounded() {
        let error = parse_ai_metadata_suggestions("I cannot read the blurry pages").unwrap_err();
        assert!(error.contains("圖片品質不足"));
        assert!(metadata_ai_error("x\n".repeat(500)).chars().count() < 300);
    }

    #[test]
    fn page_data_url_validation_rejects_unsupported_mime_and_bad_base64() {
        assert!(validate_page_data_url("data:text/plain;base64,SGk=").is_err());
        assert!(validate_page_data_url("data:image/png;base64,***").is_err());
        assert!(validate_page_data_url("data:image/png;base64,AA==").is_ok());
    }

    #[test]
    fn page_data_url_rejects_oversized_base64_before_decoding() {
        let encoded = "A".repeat(MAX_AI_BASE64_BYTES + 4);
        let data_url = format!("data:image/png;base64,{encoded}");
        assert!(validate_page_data_url(&data_url).is_err());
    }

    #[test]
    fn failed_pending_open_is_cleared_only_for_its_generation_and_source() {
        let state = Arc::new(AppState::new());
        let generation = state
            .reader_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        *state.pending_open_id.lock().unwrap() = Some("book".into());
        *state.pending_open_source_id.lock().unwrap() = Some("external:bookmark".into());
        {
            let _guard = PendingOpenGuard::new(
                state.clone(),
                "book".into(),
                Some("external:bookmark".into()),
                generation,
            );
        }
        assert!(state.pending_open_id.lock().unwrap().is_none());
        assert!(state.pending_open_source_id.lock().unwrap().is_none());

        *state.pending_open_id.lock().unwrap() = Some("book".into());
        *state.pending_open_source_id.lock().unwrap() = Some("external:bookmark".into());
        let stale = PendingOpenGuard::new(
            state.clone(),
            "book".into(),
            Some("external:bookmark".into()),
            generation,
        );
        state
            .reader_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *state.pending_open_source_id.lock().unwrap() = Some("external:new-bookmark".into());
        drop(stale);
        assert_eq!(
            state.pending_open_id.lock().unwrap().as_deref(),
            Some("book")
        );
        assert_eq!(
            state.pending_open_source_id.lock().unwrap().as_deref(),
            Some("external:new-bookmark")
        );
    }

    #[test]
    fn early_open_intent_switches_same_id_without_clearing_new_reader() {
        let state = Arc::new(AppState::new());
        let first_generation = begin_pending_open(&state, "same-id", None);
        let first = PendingOpenGuard::new(state.clone(), "same-id".into(), None, first_generation);
        assert_eq!(
            state.pending_open_id.lock().unwrap().as_deref(),
            Some("same-id")
        );
        assert!(state.pending_open_source_id.lock().unwrap().is_none());

        let second_generation =
            begin_pending_open(&state, "same-id", Some("external:new-source".into()));
        let second = PendingOpenGuard::new(
            state.clone(),
            "same-id".into(),
            Some("external:new-source".into()),
            second_generation,
        );
        drop(first);
        assert_eq!(
            state.pending_open_source_id.lock().unwrap().as_deref(),
            Some("external:new-source")
        );
        drop(second);
        assert!(state.pending_open_id.lock().unwrap().is_none());
        assert!(state.pending_open_source_id.lock().unwrap().is_none());
    }

    #[test]
    fn cancelled_early_intent_is_cleared_by_reader_invalidation() {
        let state = Arc::new(AppState::new());
        let generation =
            begin_pending_open(&state, "photo-or-book", Some("external:source".into()));
        let guard = PendingOpenGuard::new(
            state.clone(),
            "photo-or-book".into(),
            Some("external:source".into()),
            generation,
        );
        state.invalidate_reader_cache();
        drop(guard);
        assert!(state.pending_open_id.lock().unwrap().is_none());
        assert!(state.pending_open_source_id.lock().unwrap().is_none());
    }

    #[test]
    fn invalid_source_is_rejected_before_early_open_intent() {
        let state = Arc::new(AppState::new());
        assert!(parse_requested_source_id(Some("  ")).is_err());
        assert!(state.pending_open_id.lock().unwrap().is_none());
        assert!(state.pending_open_source_id.lock().unwrap().is_none());
    }

    #[test]
    fn empty_reader_pages_are_rejected_before_active_commit() {
        assert!(require_reader_pages(&[]).is_err());
        assert!(require_reader_pages(&["page://one".into()]).is_ok());
    }
}
