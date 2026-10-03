use cap_fs_ext::DirExt;
pub mod archive_reader;
pub mod cache;
pub mod cache_policy;
pub mod catalog;
pub mod commerce;
pub mod file_ops;
pub mod metadata;
pub mod photo_library;
pub mod protocol;
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

fn normalize_runtime_item(mut item: ComicItem) -> ComicItem {
    if item.r#type == "offline" {
        return item;
    }
    let is_folder = item.r#type.contains("folder");
    let is_image = item.r#type.contains("image");
    item.r#type = if item.source_id == "smb" {
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
    if let Some(existing) = comics.iter_mut().find(|comic| comic.id == normalized.id) {
        if existing.source_id == normalized.source_id && existing.r#type != normalized.r#type {
            existing.r#type.clone_from(&normalized.r#type);
        }
    } else {
        comics.push(normalized);
    }
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

fn reader_generation_is_current(state: &AppState, generation: u64) -> bool {
    state
        .reader_generation
        .load(std::sync::atomic::Ordering::Acquire)
        == generation
}

fn open_smb_temp_root(temp_base: &Path) -> Result<cap_std::fs::Dir, String> {
    std::fs::create_dir_all(temp_base)
        .map_err(|error| format!("無法建立 SMB 暫存根目錄: {error}"))?;
    let base = cap_std::fs::Dir::open_ambient_dir(temp_base, cap_std::ambient_authority())
        .map_err(|error| format!("無法開啟 SMB 暫存根目錄: {error}"))?;
    base.create_dir_all("ComicTemp")
        .map_err(|error| format!("無法建立 SMB 暫存目錄: {error}"))?;
    base.open_dir_nofollow("ComicTemp")
        .map_err(|error| format!("無法開啟 SMB 暫存目錄: {error}"))
}

fn remove_smb_temp_entry(temp_base: &Path, relative: &Path) -> Result<(), String> {
    let base = match cap_std::fs::Dir::open_ambient_dir(temp_base, cap_std::ambient_authority()) {
        Ok(base) => base,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("無法開啟 SMB 暫存根目錄: {error}")),
    };
    let temp_root = match base.open_dir_nofollow("ComicTemp") {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("無法開啟 SMB 暫存目錄: {error}")),
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
        std::fs::File::open(settings_dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn load_persisted_external_bookmarks(settings_dir: &Path) -> Vec<state::ExternalBookmark> {
    std::fs::read(settings_dir.join(EXTERNAL_BOOKMARKS_SETTINGS_FILE))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

// iOS 更新 App 後容器 UUID 可能改變；只重定位內建 Documents，不改外部來源。
#[cfg(any(target_os = "ios", test))]
fn relocate_ios_documents(saved: &str, documents: &Path) -> String {
    let stripped = saved.strip_prefix("/private").unwrap_or(saved);
    let Some(rest) = stripped.strip_prefix("/var/mobile/Containers/Data/Application/") else {
        return saved.to_string();
    };
    let Some((container, suffix)) = rest.split_once('/') else {
        return saved.to_string();
    };
    if uuid::Uuid::parse_str(container).is_err() || suffix != "Documents" {
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
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::DiscoveryTagGroup>, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.discovery_tags(&runtime_ids))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_comic_metadata(
    id: String,
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
            creators: std::collections::BTreeMap::new(),
            tags: Vec::new(),
            candidates: Vec::new(),
            locked_fields: Vec::new(),
            diagnostics: Vec::new(),
        });
    }
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.get_metadata(&id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn apply_batch_metadata(
    app_handle: AppHandle,
    request: catalog::BatchEditRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::BatchEditResult, String> {
    if commerce::is_batch(&request.comic_ids) {
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
    if request.comic_ids.is_empty() || commerce::is_batch(&request.comic_ids) {
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
        items = tokio::task::spawn_blocking(move || {
            let mut catalog_only_sources = BTreeSet::new();
            if !scan_dir.is_empty() && !Path::new(&scan_dir).exists() {
                catalog_only_sources.insert(scanner::local_source_id(Path::new(&scan_dir)));
            }
            store.overlay_library(items, &catalog_only_sources)
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

#[tauri::command]
async fn open_comic(
    id: String,
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
        let reader_generation = {
            let _lifecycle = state.comic_lifecycle.lock().unwrap();
            let generation = state
                .reader_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            *state.pending_open_id.lock().unwrap() = Some(id.clone());
            generation
        };
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
            *state.active_comic_id.lock().unwrap() = Some(id.clone());
            *state.pending_open_id.lock().unwrap() = None;
            state
                .preload_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1
        };
        let pages = (0..assets.len())
            .map(|index| format!("gai://page/{id}/{index}"))
            .collect::<Vec<_>>();
        return Ok(serde_json::json!({
            "id": id,
            "type": item.r#type,
            "title": item.title,
            "isDir": false,
            "pages": pages,
            "progress": item.progress,
            "preloadGeneration": preload_generation
        }));
    }
    let comic_info = if let Some(item) = {
        let comics = state.comics.lock().await;
        comics.iter().find(|comic| comic.id == id).cloned()
    } {
        item
    } else {
        let store = catalog_store(&state)?;
        let lookup_id = id.clone();
        tokio::task::spawn_blocking(move || store.get_runtime_item(&lookup_id))
            .await
            .map_err(|error| error.to_string())??
            .ok_or_else(|| "找不到漫畫資料，請重新掃描書庫".to_string())?
    };
    let comic_info = normalize_runtime_item(comic_info);
    if commerce::is_direct_smb(&comic_info.source_id, &comic_info.r#type) {
        commerce::require_pro(&app_handle).await?;
    }
    {
        let mut comics = state.comics.lock().await;
        register_comic_capability(&mut comics, &comic_info);
    }
    let relative_path_str = comic_info.relative_path.clone();
    let reader_generation = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let generation = state
            .reader_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        *state.pending_open_id.lock().unwrap() = Some(id.clone());
        generation
    };

    let is_smb = comic_info.source_id == "smb" || comic_info.r#type == "smb-archive";
    let is_external =
        comic_info.source_id.starts_with("external:") || comic_info.r#type.starts_with("external-");

    let full_path: PathBuf;
    let is_dir: bool;
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
            use tauri::Emitter;
            let _ = app_handle.emit("smb-download-start", serde_json::json!({"id": id}));

            println!("🌐 準備下載 SMB 漫畫: {relative_path_str}");
            let temp_base = app_handle
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let temp_root = match open_smb_temp_root(&temp_base) {
                Ok(root) => root,
                Err(error) => {
                    let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                    return Err(error);
                }
            };
            let temp_dir = temp_base.join("ComicTemp");
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
            let download_result: Result<(), String> = async {
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
                Ok(())
            }
            .await;
            let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
            if let Err(error) = download_result {
                let _ = temp_root.remove_file(&partial_path);
                return Err(error);
            }
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
                app_handle
                    .tauri_plugin_ios_folder()
                    .ensure_available(EnsureAvailableRequest {
                        bookmark: bookmark.clone(),
                        path: full_path.to_string_lossy().into_owned(),
                    })
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
        let folder = root
            .open_dir(relative)
            .map_err(|error| format!("無法開啟漫畫資料夾: {error}"))?;
        let image_names = crate::utils::get_folder_image_names_from_dir(&folder);
        let mut cached_files = Vec::new();
        for (index, name) in image_names.iter().enumerate() {
            pages.push(format!("gai://folder/{}/{}", id, index));
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
        pages.push(format!("gai://page/{id}/0"));
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
            .map_err(|error| format!("無法開啟漫畫封存檔: {error}"))?
            .into_std();
        let archive_path = full_path.clone();
        let entry_names = tauri::async_runtime::spawn_blocking(move || {
            crate::utils::get_archive_images_from_file(&archive_path, archive_file)
        })
        .await
        .map_err(|error| format!("讀取漫畫封存檔的背景工作失敗：{error}"))?
        .map_err(|error| error.to_string())?;
        for index in 0..entry_names.len() {
            pages.push(format!("gai://page/{}/{}", id, index));
        }
        entry_names
    };

    let title = comic_info.title.clone();
    let r#type = comic_info.r#type.clone();
    let progress = comic_info.progress.clone();

    let preload_generation = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        if !reader_generation_is_current(state.inner(), reader_generation) {
            return Err("開啟漫畫已取消".into());
        }
        state
            .opened_comic_files
            .write()
            .unwrap()
            .insert(id.clone(), opened_files);
        state.ram_cache_pool.lock().unwrap().clear();
        *state.active_comic_id.lock().unwrap() = Some(id.clone());
        *state.pending_open_id.lock().unwrap() = None;
        state
            .preload_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    };
    let state_clone = state.inner().clone();
    let id_clone = id.clone();
    let handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        crate::cache::preload_comic(state_clone, handle_clone, id_clone, preload_generation).await;
    });

    Ok(serde_json::json!({
        "id": id,
        "type": r#type,
        "title": title,
        "isDir": is_dir,
        "pages": pages,
        "progress": progress,
        "preloadGeneration": preload_generation
    }))
}

#[tauri::command]
async fn open_folder_dialog(_app: tauri::AppHandle) -> Result<String, String> {
    Ok(String::new())
}

#[tauri::command]
async fn close_comic(
    comic_id: Option<String>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};
    if let Some(ref id) = comic_id {
        let is_smb = {
            let comics = state.comics.lock().await;
            comics
                .iter()
                .find(|comic| comic.id == *id)
                .is_some_and(|comic| comic.source_id == "smb" || comic.r#type == "smb-archive")
        };
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let mut active_id = state.active_comic_id.lock().unwrap();
        let mut pending_open_id = state.pending_open_id.lock().unwrap();
        let closes_current = active_id.as_ref().is_some_and(|active| active == id)
            || pending_open_id
                .as_ref()
                .is_some_and(|pending| pending == id);
        if closes_current {
            state
                .reader_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            state
                .preload_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if active_id.as_ref().is_some_and(|active| active == id) {
                *active_id = None;
            }
            if pending_open_id
                .as_ref()
                .is_some_and(|pending| pending == id)
            {
                *pending_open_id = None;
            }
        }
        state.ram_cache_pool.lock().unwrap().remove(id);
        state.opened_comic_files.write().unwrap().remove(id);
        if is_smb {
            if let Ok(relative_bytes) = general_purpose::URL_SAFE_NO_PAD.decode(id) {
                if let Ok(relative_text) = String::from_utf8(relative_bytes) {
                    let temp_base = app_handle
                        .path()
                        .app_local_data_dir()
                        .unwrap_or_else(|_| std::env::temp_dir());
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
                    let _ = remove_smb_temp_entry(&temp_base, relative);
                }
            }
        }
    } else {
        {
            let _lifecycle = state.comic_lifecycle.lock().unwrap();
            state
                .reader_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            state
                .preload_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *state.active_comic_id.lock().unwrap() = None;
            *state.pending_open_id.lock().unwrap() = None;
            state.ram_cache_pool.lock().unwrap().clear();
            state.opened_comic_files.write().unwrap().clear();
        }
        let temp_dir = app_handle
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("ComicTemp");
        if temp_dir.exists() {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
    }

    Ok(())
}

#[tauri::command]
async fn update_reader_cache_window(
    comic_id: String,
    page_index: usize,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<u64, String> {
    let total_pages = {
        let opened = state.opened_comic_files.read().unwrap();
        opened.get(&comic_id).map(Vec::len).unwrap_or(0)
    };
    if total_pages > 0 && page_index >= total_pages {
        return Err("頁碼超出漫畫範圍".into());
    }

    let whole_book_cached = state
        .ram_cache_pool
        .lock()
        .unwrap()
        .get(&comic_id)
        .is_some_and(|pages| total_pages > 0 && pages.len() == total_pages);
    if whole_book_cached {
        return Ok(state
            .preload_generation
            .load(std::sync::atomic::Ordering::Acquire));
    }

    let generation = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let is_active = state
            .active_comic_id
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|active_id| active_id == &comic_id);
        if !is_active {
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
    let current_scan_dir = state.scan_dir.read().unwrap().clone();
    if current_scan_dir == scan_dir {
        return Ok(serde_json::json!({ "success": true, "changed": false, "scanDir": scan_dir }));
    }

    let settings_handle = app_handle.clone();
    let saved_scan_dir = scan_dir.clone();
    tokio::task::spawn_blocking(move || persist_scan_directory(&settings_handle, &saved_scan_dir))
        .await
        .map_err(|error| format!("漫畫目錄設定工作失敗：{error}"))??;

    let _scan_lifecycle = state.scan_lifecycle.lock().await;
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
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
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

/// Production prompt for page explanation. Keep the requested output language
/// explicit so the model translates dialogue before giving a short summary.
fn explain_page_prompt(target_locale: &str) -> Result<&'static str, String> {
    match target_locale {
        "zh-Hant" => Ok(
            "請逐句辨識並列出圖片中看見的對話原文，再提供對應的自然、簡潔繁體中文（台灣用語）翻譯；保留完整詞彙語意，不要逐字拆解，不確定處要標註。接著簡要說明這一頁漫畫在講什麼。摘要只能根據明確可見內容，不要推定角色身分，不要補上未顯示的動作、先後或因果，也不要把請求當成已發生事件；沒有對白時要明說。看不清楚或無法確定的地方要明說，不要杜撰。",
        ),
        "en" => Ok(
            "Identify and list the visible dialogue line by line in its original wording, then provide a corresponding natural, concise English translation. Preserve the complete meaning of each word or phrase; do not split it into literal word-by-word fragments, and mark uncertain readings. Then briefly explain what this comic page is about. Base the summary only on clearly visible content; do not infer character identities or add actions, order, or causality that is not shown, and do not treat a request as an event that already happened. If there is no dialogue, say so. Clearly say when text or details are unclear or uncertain; do not invent content.",
        ),
        "ja" => Ok(
            "画像内で読める会話を一文ずつ原文のまま示し、その後に対応する自然で簡潔な日本語訳を示してください。各語句の完全な意味を保ち、逐語的に分解せず、読み取りに確信がない箇所は明記してください。続けて、この漫画ページの内容を短く説明してください。あらすじは明確に見えている内容だけに基づき、登場人物の身元を推測したり、表示されていない動作・順序・因果関係を補ったり、依頼をすでに起きた出来事として扱ったりしないでください。会話がない場合はその旨を明記してください。文字や内容が読めない、または確信できない場合はその旨を明記し、内容を推測して創作しないでください。",
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
    current_page: u64,
    total_pages: u64,
    /// Optional during the migration; UI clients should send a strictly
    /// increasing value per comic so an older request cannot overwrite a
    /// newer page after it was delayed by the runtime.
    #[serde(default)]
    sequence: Option<u64>,
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
    match security_framework::passwords::get_generic_password(MACOS_AI_KEYCHAIN_SERVICE, provider) {
        Ok(_) => Ok(true),
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

fn response_text(value: &serde_json::Value) -> Option<String> {
    value
        .get("output")?
        .as_array()?
        .iter()
        .flat_map(|item| {
            item.get("content")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
        })
        .find(|item| {
            matches!(
                item.get("type").and_then(serde_json::Value::as_str),
                Some("output_text" | "refusal")
            )
        })
        .and_then(|item| {
            item.get("text")
                .or_else(|| item.get("refusal"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::to_string)
}

fn gemma_response_text(value: &serde_json::Value) -> Option<String> {
    value
        .pointer("/candidates/0/content/parts")?
        .as_array()?
        .iter()
        .filter(|part| part.get("thought").and_then(serde_json::Value::as_bool) != Some(true))
        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
        .next_back()
        .map(str::to_string)
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
) -> Result<AiCompletion, String> {
    let api_key = config.api_key.clone();
    call_ai_inner(state, config, expected_generation, images, prompt)
        .await
        .map_err(|error| redact_ai_error(error, &api_key))
}

async fn call_ai_inner(
    state: &AppState,
    config: crate::state::AiSessionConfig,
    expected_generation: u64,
    images: &[(&str, &str)],
    prompt: &str,
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
                    "reasoning": { "effort": "low" },
                    "input": [{ "role": "user", "content": content }],
                    "max_output_tokens": 700
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
        response_text(&value)
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
                            "maxOutputTokens": 700,
                            "thinkingConfig": { "thinkingLevel": "minimal" }
                        }
                    })),
                "Gemma 4 連線失敗：",
            )
            .await?;
            let (status, value) = limited_ai_json_response(response).await?;
            if status.is_success() {
                return gemma_response_text(&value)
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
    serde_json::from_slice(&body)
        .map(|value| (status, value))
        .map_err(|error| format!("艦載 AI 回應格式不正確：{error}"))
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
    call_ai(state.inner(), config, generation, &images, prompt)
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
    let response = call_ai(state.inner(), config, generation, &images, prompt)
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

#[tauri::command]
async fn set_bookmarks(
    data: Vec<crate::state::ExternalBookmark>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Serialize disk persistence with the matching in-memory update. Otherwise
    // an older request can finish writing after a newer request has applied.
    let _bookmark_lifecycle = state.bookmark_lifecycle.lock().await;
    let bookmarks_to_persist = data.clone();
    let settings_handle = app_handle.clone();
    tokio::task::spawn_blocking(move || {
        persist_external_bookmarks(&settings_handle, &bookmarks_to_persist)
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
    let removed_source_ids = removed_bookmarks
        .iter()
        .map(|bookmark| scanner::external_source_id(&bookmark.bookmark))
        .collect::<BTreeSet<_>>();
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    let mut stop_accessing_errors: Vec<String> = Vec::new();
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    let stop_accessing_errors: Vec<String> = Vec::new();

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
                stop_accessing_errors.push(format!("{}: {error}", removed.name));
            });
    }

    {
        let _catalog_sync = state.catalog_sync.lock().await;
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        if !removed_source_ids.is_empty() {
            let store = catalog_store(&state)?;
            let source_ids = removed_source_ids.iter().cloned().collect::<Vec<_>>();
            tokio::task::spawn_blocking(move || {
                source_ids
                    .into_iter()
                    .try_fold(0usize, |removed, source_id| {
                        store
                            .forget_source_locations(&source_id)
                            .map(|count| removed + count)
                    })
            })
            .await
            .map_err(|error| error.to_string())??;
        }
        {
            let mut active = state.active_bookmarks.lock().unwrap();
            for removed in &removed_bookmarks {
                active.remove(&removed.bookmark);
            }
        }
        let mut comics = state.comics.lock().await;
        comics.retain(|comic| !removed_source_ids.contains(&comic.source_id));
        *state.external_bookmarks.write().unwrap() = data;
        drop(comics);
        state.invalidate_reader_cache();
        state
            .scan_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        crate::scanner::start_background_scan(state_clone, app_handle).await;
    });
    if stop_accessing_errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "清單已更新，舊權限可能未完全釋放；無法釋放外部資料夾權限: {}",
            stop_accessing_errors.join("; ")
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
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if photo_library::is_photo_album_id(&comic_id) {
        return Err("照片相簿沒有可在檔案管理器顯示的檔案位置".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = state;
        return Err("目前平台不支援在檔案管理器顯示漫畫".into());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let store = catalog_store(&state)?;
        let item = tokio::task::spawn_blocking(move || store.get_runtime_item(&comic_id))
            .await
            .map_err(|error| format!("漫畫位置查詢失敗: {error}"))??
            .map(normalize_runtime_item)
            .ok_or_else(|| "找不到已登記的漫畫位置".to_string())?;
        if item.r#type == "offline" {
            return Err("漫畫來源目前離線".into());
        }
        let path = item
            .source_path
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
    state: State<'_, Arc<AppState>>,
) -> Result<file_ops::FileCapability, String> {
    let store = catalog_store(&state)?;
    let location = tokio::task::spawn_blocking(move || store.get_location(&comic_id))
        .await
        .map_err(|error| error.to_string())??;
    let smb_config = state
        .smb_config
        .read()
        .map_err(|_| "NAS 設定鎖定失敗")?
        .clone();
    if location.source_id == "smb" {
        if let Err(reason) = commerce::require_pro(&app_handle).await {
            // Inspecting the library must not trigger a purchase sheet or a NAS probe.
            // Recovery remains available through its separate, ungated command.
            return Ok(file_ops::FileCapability {
                source_kind: "smb".into(),
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
    let location = tokio::task::spawn_blocking(move || location_store.get_location(&location_id))
        .await
        .map_err(|error| error.to_string())??;
    if location.source_id == "smb" {
        commerce::require_pro(&app_handle).await?;
    }
    let result = file_ops::mutate(&store, smb, request).await?;
    let lookup_store = store.clone();
    let lookup_id = result.comic_id.clone();
    let refreshed = tokio::task::spawn_blocking(move || lookup_store.get_runtime_item(&lookup_id))
        .await
        .map_err(|error| format!("漫畫位置刷新工作失敗：{error}"))??
        .map(normalize_runtime_item);
    let scan_status = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        let generation = state
            .scan_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let mut comics = state.comics.lock().await;
        comics.retain(|item| item.id != requested_id && item.id != result.comic_id);
        if let Some(item) = refreshed {
            comics.push(item);
        }
        let mut progress = state.scan_progress.lock().await;
        progress.generation = generation;
        progress.is_scanning = false;
        progress.phase = "complete".into();
        progress.error = None;
        progress.found = comics.len();
        progress.completed_at = Some(chrono::Utc::now().to_rfc3339());
        progress.clone()
    };
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
    let smb = state
        .smb_config
        .read()
        .map_err(|_| "NAS 設定鎖定失敗")?
        .clone();
    let result = file_ops::undo(&store, smb, &token).await?;
    let lookup_store = store.clone();
    let lookup_id = result.comic_id.clone();
    let refreshed = tokio::task::spawn_blocking(move || lookup_store.get_runtime_item(&lookup_id))
        .await
        .map_err(|error| format!("漫畫位置刷新工作失敗：{error}"))??
        .map(normalize_runtime_item);
    let scan_status = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        let generation = state
            .scan_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let mut comics = state.comics.lock().await;
        comics.retain(|current| {
            refreshed.as_ref().is_none_or(|item| {
                current.id != item.id && current.relative_path != item.relative_path
            }) && operation
                .after_relative_path
                .as_deref()
                .is_none_or(|path| current.relative_path != path)
        });
        if let Some(item) = refreshed {
            comics.push(item);
        }
        let mut progress = state.scan_progress.lock().await;
        progress.generation = generation;
        progress.is_scanning = false;
        progress.phase = "complete".into();
        progress.error = None;
        progress.found = comics.len();
        progress.completed_at = Some(chrono::Utc::now().to_rfc3339());
        progress.clone()
    };
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
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    let _bookmark_lifecycle = state.bookmark_lifecycle.lock().await;
    let _file_lifecycle = state.file_lifecycle.lock().await;
    let store = catalog_store(&state)?;
    let lookup_id = comic_id.clone();
    let item = tokio::task::spawn_blocking(move || store.get_runtime_item(&lookup_id))
        .await
        .map_err(|error| format!("漫畫位置查詢失敗: {error}"))??
        .map(normalize_runtime_item)
        .ok_or_else(|| "找不到已登記的漫畫位置".to_string())?;
    if item.r#type == "offline" {
        return Err("漫畫來源目前離線".into());
    }
    if item.source_id == "smb" {
        return Err("NAS 壓縮檔不支援刪除單頁".into());
    }
    // Source changes and bookmark removal share this gate. Keep permission
    // validation and deletion in the same lifecycle, including blocking I/O.
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
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
                let canonical_target = images[page_index]
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

async fn progress_sequence_is_current(
    state: &AppState,
    comic_id: &str,
    sequence: Option<u64>,
) -> Result<(), String> {
    let Some(sequence) = sequence else {
        return Ok(());
    };
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
    let progress_lock = comic_progress_lock(state.inner(), &id).await;
    let _progress_lifecycle = progress_lock.lock().await;
    progress_sequence_is_current(state.inner(), &id, data.sequence).await?;
    let opened_total_pages = state
        .opened_comic_files
        .read()
        .unwrap()
        .get(&id)
        .map(Vec::len);
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
        commit_progress_sequence(state.inner(), &id, data.sequence).await;
        return Ok(());
    }
    let scan_dir = state.scan_dir.read().unwrap().clone();
    let now = chrono::Utc::now().to_rfc3339();
    let (progress, is_local_source) = {
        let comics = state.comics.lock().await;
        let comic = comics
            .iter()
            .find(|comic| comic.id == id)
            .ok_or_else(|| "找不到閱讀中的漫畫，已拒絕寫入孤兒進度".to_string())?;
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
    let sqlite_progress = progress.clone();
    tokio::task::spawn_blocking(move || store.save_progress(&identifier, &sqlite_progress))
        .await
        .map_err(|error| format!("穩定進度儲存工作失敗: {error}"))??;

    // SQLite is authoritative. Only publish to the in-memory catalogue after
    // persistence succeeds, otherwise a failed write would display fake
    // progress until the next scan.
    {
        let mut comics = state.comics.lock().await;
        if let Some(comic) = comics.iter_mut().find(|comic| comic.id == id) {
            comic.progress = progress.clone();
            comic.page_count = total_pages;
        }
    }

    if is_local_source && !scan_dir.is_empty() {
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
    commit_progress_sequence(state.inner(), &id, data.sequence).await;
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
            *app_state
                .external_bookmarks
                .write()
                .map_err(|_| std::io::Error::other("無法載入外部資料夾授權"))? =
                load_persisted_external_bookmarks(&catalog_dir);
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
            close_comic,
            update_reader_cache_window,
            save_progress,
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

    #[cfg(unix)]
    #[test]
    fn smb_temp_root_symlink_is_rejected_even_inside_temp_base() {
        let root = std::env::temp_dir().join(format!("gai_smb_root_link_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("other-cache")).unwrap();
        std::os::unix::fs::symlink("other-cache", root.join("ComicTemp")).unwrap();
        std::fs::write(root.join("other-cache/book.cbz"), b"keep").unwrap();
        assert!(open_smb_temp_root(&root).is_err());
        assert!(remove_smb_temp_entry(&root, Path::new("book.cbz")).is_err());
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
    fn explain_page_request_defaults_to_traditional_chinese() {
        let request: ExplainPageRequest =
            serde_json::from_value(serde_json::json!({"dataUrl": "data:image/png;base64,AA=="}))
                .unwrap();
        assert_eq!(request.target_locale, "zh-Hant");
    }

    #[test]
    fn explain_page_prompts_translate_then_summarize_without_inventing() {
        for locale in ["zh-Hant", "en", "ja"] {
            let prompt = explain_page_prompt(locale).unwrap();
            assert!(
                prompt.contains("summary")
                    || prompt.contains("摘要")
                    || prompt.contains("あらすじ")
            );
            assert!(
                prompt.contains("invent") || prompt.contains("杜撰") || prompt.contains("創作")
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
        let temp_root = open_smb_temp_root(&root).unwrap();
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
            fs::read(root.join("ComicTemp/book.cbz")).unwrap(),
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
            fs::read(root.join("ComicTemp/book.cbz")).unwrap(),
            b"complete"
        );
        fs::remove_dir_all(root).unwrap();
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

        assert!(open_smb_temp_root(&root).is_err());
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

    #[test]
    fn gemma_response_hides_thinking_parts() {
        let response = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "thought": true, "text": "internal reasoning" },
                        { "text": "艦載 AI 連線成功。" }
                    ]
                }
            }]
        });
        assert_eq!(
            gemma_response_text(&response).as_deref(),
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
}
