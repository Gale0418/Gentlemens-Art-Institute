pub mod cache;
pub mod cache_policy;
pub mod catalog;
pub mod commerce;
pub mod file_ops;
pub mod metadata;
pub mod photo_library;
pub mod protocol;
pub mod scanner;
pub mod smb_scanner;
pub mod state;
pub mod utils;

use state::{AppState, ComicItem, Progress};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

const SCAN_DIRECTORY_SETTINGS_FILE: &str = "scan-directory.txt";
const MAX_IMPORTED_PHOTO_BYTES: usize = 64 * 1024 * 1024;
const MAX_CATALOG_EXPORT_BYTES: usize = 64 * 1024 * 1024;

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
    let is_volume_root = resolved.parent() == Some(volumes_root);
    let is_home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .is_some_and(|home| resolved == home);
    if resolved.parent().is_none() || resolved == volumes_root || is_volume_root || is_home {
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
    let percent = if current_page > 0 && total_pages > 0 {
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

fn commit_smb_download_if_current(
    state: &AppState,
    generation: u64,
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
    std::fs::rename(partial_path, final_path)
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

    let full_path;
    let is_dir;

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
            let temp_dir = app_handle
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ComicTemp");
            if let Err(error) = std::fs::create_dir_all(&temp_dir) {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err(format!("無法建立 SMB 暫存目錄: {error}"));
            }
            full_path = temp_dir.join(relative);
            if let Some(parent) = full_path.parent() {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                    return Err(format!("無法建立 SMB 暫存目錄: {error}"));
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
            let partial_path = full_path.with_extension(format!(
                "{}.part-{}-{nonce}",
                full_path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or("download"),
                std::process::id()
            ));
            let download_result: Result<(), String> = async {
                use tokio::io::AsyncWriteExt;

                let mut download = client
                    .download(&tree, &smb_path)
                    .await
                    .map_err(|error| format!("SMB 讀取錯誤: {error:?}"))?;
                let mut file = tokio::fs::File::create(&partial_path)
                    .await
                    .map_err(|error| format!("無法建立 SMB 暫存檔: {error}"))?;
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
                    file.write_all(&bytes)
                        .await
                        .map_err(|error| format!("SMB 暫存檔寫入失敗: {error}"))?;
                }
                file.sync_all()
                    .await
                    .map_err(|error| format!("SMB 暫存檔同步失敗: {error}"))?;
                drop(file);
                commit_smb_download_if_current(
                    state.inner(),
                    reader_generation,
                    &partial_path,
                    &full_path,
                )?;
                Ok(())
            }
            .await;
            let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
            if let Err(error) = download_result {
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Err(error);
            }
            println!("✅ SMB 下載完成");
            is_dir = false;
        } else {
            return Err("未設定 SMB 連線".into());
        }
    } else if is_external || comic_info.r#type == "offline" {
        full_path = comic_info
            .source_path
            .as_deref()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| Path::new(&relative_path_str).to_path_buf());
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
            let canonical = full_path
                .canonicalize()
                .map_err(|error| format!("外部漫畫路徑無效: {error}"))?;
            let canonical_root = root_path
                .canonicalize()
                .map_err(|error| format!("外部資料夾路徑無效: {error}"))?;
            if !canonical.starts_with(canonical_root) {
                return Err("外部漫畫路徑超出授權範圍".into());
            }
        }
        if !full_path.exists() {
            return Err(format!(
                "漫畫來源目前離線：{}。請重新連線原本的磁碟，或在設定中選擇新的漫畫目錄後重新掃描。",
                full_path.display()
            ));
        }
        is_dir = full_path.is_dir();
    } else {
        let scan_dir = state.scan_dir.read().unwrap().clone();
        if scan_dir.is_empty() {
            return Err("漫畫目錄尚未設定".into());
        }
        full_path = Path::new(&scan_dir).join(&relative_path_str);

        if !full_path.exists() {
            return Err("找不到漫畫！".into());
        }

        let canon_scan = Path::new(&scan_dir)
            .canonicalize()
            .map_err(|error| format!("掃描目錄無效: {error}"))?;
        let canon_full = full_path
            .canonicalize()
            .map_err(|error| format!("無效路徑: {error}"))?;
        if !canon_full.starts_with(&canon_scan) {
            return Err("路徑越權！禁止存取掃描目錄外的檔案！".into());
        }

        is_dir = full_path.is_dir();
    }

    let mut pages = Vec::new();
    let opened_files = if is_dir {
        let images = crate::utils::get_folder_images(&full_path);
        let mut cached_files = Vec::new();
        for (index, path) in images.iter().enumerate() {
            pages.push(format!("gai://folder/{}/{}", id, index));
            cached_files.push(path.to_string_lossy().to_string());
        }
        cached_files
    } else if comic_info.r#type.contains("image") {
        pages.push(format!("gai://page/{id}/0"));
        vec![full_path.to_string_lossy().into_owned()]
    } else {
        let entry_names =
            crate::utils::get_archive_images(&full_path).map_err(|error| error.to_string())?;
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
                    let temp_dir = app_handle
                        .path()
                        .app_local_data_dir()
                        .unwrap_or_else(|_| std::env::temp_dir())
                        .join("ComicTemp");
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
                    let item_temp = temp_dir.join(relative);
                    if item_temp.is_dir() {
                        let _ = std::fs::remove_dir_all(&item_temp);
                    } else if item_temp.is_file() {
                        let _ = std::fs::remove_file(&item_temp);
                    }
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
async fn get_config(state: State<'_, Arc<AppState>>, app_handle: AppHandle) -> Result<serde_json::Value, String> {
    let dir = state.scan_dir.read().unwrap();
    let available = dir.is_empty() || Path::new(dir.as_str()).exists();
    #[cfg(target_os = "ios")]
    let is_local_library = app_handle.path().document_dir().ok()
        .is_some_and(|documents| Path::new(dir.as_str()) == documents);
    #[cfg(not(target_os = "ios"))]
    let is_local_library = { let _ = app_handle; false };
    Ok(serde_json::json!({ "scanDir": dir.clone(), "available": available, "isLocalLibrary": is_local_library }))
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
    let scan_dir = relocate_ios_documents(&scan_dir, &app_handle.path().document_dir().map_err(|error| error.to_string())?);
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
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionStatus {
    configured: bool,
    provider: Option<String>,
    model: Option<String>,
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
    data_url: String,
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
}

fn ai_status(config: Option<&crate::state::AiSessionConfig>) -> AiSessionStatus {
    AiSessionStatus {
        configured: config.is_some(),
        provider: config.map(|value| value.provider.clone()),
        model: config.map(|value| value.model.clone()),
    }
}

fn validate_ai_session(data: AiSessionRequest) -> Result<crate::state::AiSessionConfig, String> {
    let api_key = data.api_key.trim();
    if api_key.len() < 16 || api_key.len() > 512 {
        return Err("API Key 格式不正確".into());
    }
    if !data.google_content_disclosure {
        return Err("啟用第三方艦載 AI 前，必須明確同意傳送目前頁面影像與提示文字".into());
    }
    let (provider, model) = match data.provider.as_str() {
        "openai" => ("openai", "gpt-5.6-luna"),
        "google" => ("google", "gemma-4-26b-a4b-it"),
        _ => return Err("不支援的艦載 AI 供應商".into()),
    };
    Ok(crate::state::AiSessionConfig {
        provider: provider.to_string(),
        model: model.to_string(),
        api_key: api_key.to_string(),
        google_content_disclosure: true,
    })
}

#[tauri::command]
async fn get_ai_session_status(state: State<'_, Arc<AppState>>) -> Result<AiSessionStatus, String> {
    let config = state.ai_session.read().unwrap();
    Ok(ai_status(config.as_ref()))
}

#[tauri::command]
async fn set_ai_session_config(
    app_handle: AppHandle,
    data: AiSessionRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiSessionStatus, String> {
    commerce::require_pro(&app_handle).await?;
    let config = validate_ai_session(data)?;
    let status = ai_status(Some(&config));
    *state.ai_session.write().unwrap() = Some(config);
    Ok(status)
}

#[tauri::command]
async fn clear_ai_session_config(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.ai_session.write().unwrap() = None;
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
        .find(|item| item.get("type").and_then(serde_json::Value::as_str) == Some("output_text"))
        .and_then(|item| item.get("text").and_then(serde_json::Value::as_str))
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

fn should_try_gemma_fallback(status: reqwest::StatusCode, model: &str) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS && model == "gemma-4-26b-a4b-it"
}

async fn call_ai(
    config: crate::state::AiSessionConfig,
    image: Option<(&str, &str)>,
    prompt: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    if config.provider == "openai" {
        let mut content = Vec::new();
        if let Some((mime, data)) = image {
            content.push(serde_json::json!({
                "type": "input_image",
                "image_url": format!("data:{mime};base64,{data}")
            }));
        }
        content.push(serde_json::json!({ "type": "input_text", "text": prompt }));
        let response = client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(&config.api_key)
            .json(&serde_json::json!({
                "model": config.model,
                "reasoning": { "effort": "low" },
                "input": [{ "role": "user", "content": content }],
                "max_output_tokens": 700
            }))
            .send()
            .await
            .map_err(|error| format!("Luna 連線失敗：{error}"))?;
        let status = response.status();
        let value: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
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
        response_text(&value).ok_or_else(|| "Luna 沒有回傳可顯示文字".to_string())
    } else {
        let mut parts = Vec::new();
        if let Some((mime, data)) = image {
            parts.push(serde_json::json!({ "inlineData": { "mimeType": mime, "data": data } }));
        }
        parts.push(serde_json::json!({ "text": prompt }));
        let models = [config.model.as_str(), "gemma-4-31b-it"];
        for (index, model) in models.iter().enumerate() {
            let endpoint = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            );
            let response = client
                .post(endpoint)
                .header("x-goog-api-key", &config.api_key)
                .json(&serde_json::json!({
                    "contents": [{ "role": "user", "parts": parts.clone() }],
                    "generationConfig": {
                        "maxOutputTokens": 700,
                        "thinkingConfig": { "thinkingLevel": "minimal" }
                    }
                }))
                .send()
                .await
                .map_err(|error| format!("Gemma 4 連線失敗：{error}"))?;
            let status = response.status();
            let value: serde_json::Value =
                response.json().await.map_err(|error| error.to_string())?;
            if status.is_success() {
                return gemma_response_text(&value)
                    .ok_or_else(|| "Gemma 4 沒有回傳可顯示文字".to_string());
            }
            if index == 0 && should_try_gemma_fallback(status, model) {
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

#[tauri::command]
async fn test_ai_session(
    app_handle: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commerce::require_pro(&app_handle).await?;
    let config = state
        .ai_session
        .read()
        .unwrap()
        .clone()
        .ok_or_else(|| "請先輸入 API Key".to_string())?;
    call_ai(
        config,
        None,
        "請只回答：艦載 AI 連線成功。不要補充其他內容。",
    )
    .await
}

#[tauri::command]
async fn explain_page(
    app_handle: AppHandle,
    data: ExplainPageRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commerce::require_pro(&app_handle).await?;
    let config = state
        .ai_session
        .read()
        .unwrap()
        .clone()
        .ok_or_else(|| "請先到設定輸入艦載 AI API Key".to_string())?;
    let (mime, encoded) = validate_page_data_url(&data.data_url)?;
    if !config.google_content_disclosure {
        return Err("尚未同意第三方 AI 資料分享".into());
    }
    let prompt = explain_page_prompt(&data.target_locale)?;
    call_ai(config, Some((mime, encoded)), prompt).await
}

fn validate_page_data_url(data_url: &str) -> Result<(&str, &str), String> {
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
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "頁面圖片 base64 損壞".to_string())?;
    if decoded.is_empty() || decoded.len() > 20 * 1024 * 1024 {
        return Err("頁面圖片必須介於 1 byte 與 20 MiB".into());
    }
    Ok((mime, encoded))
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
    let values: Vec<AiMetadataSuggestion> =
        serde_json::from_str(cleaned).map_err(|_| "艦載 AI 回傳的候選格式無法解析".to_string())?;
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

#[tauri::command]
async fn suggest_comic_metadata(
    app_handle: AppHandle,
    data: SuggestMetadataRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AiMetadataSuggestion>, String> {
    commerce::require_pro(&app_handle).await?;
    let config = state
        .ai_session
        .read()
        .map_err(|_| "艦載 AI 工作階段鎖定失敗".to_string())?
        .clone()
        .ok_or_else(|| "請先到設定輸入艦載 AI API Key".to_string())?;
    let (mime, encoded) = validate_page_data_url(&data.data_url)?;
    let provider = config.provider.clone();
    let model = config.model.clone();
    let response = call_ai(
        config,
        Some((mime, encoded)),
        "請只回傳 JSON array，不要 Markdown。從目前這一頁提出可人工審核的漫畫 metadata 候選，格式為 [{\"field\":\"summary\",\"value\":\"繁中摘要\",\"confidence\":0.0},{\"field\":\"tags\",\"value\":[{\"namespace\":\"general\",\"value\":\"標籤\"}],\"confidence\":0.0}]。只可使用 summary 或 tags；看不清楚就不要猜，最多 8 筆。",
    )
    .await?;
    let suggestions = parse_ai_metadata_suggestions(&response)?;
    let store = catalog_store(&state)?;
    let comic_id = data.comic_id;
    let raw = response.clone();
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
    #[cfg(target_os = "ios")]
    let mut stop_accessing_errors: Vec<String> = Vec::new();
    #[cfg(not(target_os = "ios"))]
    let stop_accessing_errors: Vec<String> = Vec::new();

    #[cfg(target_os = "ios")]
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
                source_ids.into_iter().try_fold(0usize, |removed, source_id| {
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
    let full_path = item
        .source_path
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "漫畫沒有可修改的已登記位置".to_string())?;
    let _lifecycle = state.comic_lifecycle.lock().unwrap();
    let canon_full = full_path
        .canonicalize()
        .map_err(|error| format!("無效路徑: {error}"))?;

    if canon_full.is_dir() {
        let images = crate::utils::get_folder_images(&canon_full);
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
                let source_dir =
                    cap_std::fs::Dir::open_ambient_dir(&canon_full, cap_std::ambient_authority())
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
            {
                let mut pool = state.ram_cache_pool.lock().unwrap();
                if let Some(book_cache) = pool.get_mut(&comic_id) {
                    let new_cache: std::collections::HashMap<usize, Vec<u8>> = book_cache
                        .iter()
                        .filter_map(|(index, data)| {
                            if *index < page_index {
                                Some((*index, data.clone()))
                            } else if *index > page_index {
                                Some((*index - 1, data.clone()))
                            } else {
                                None
                            }
                        })
                        .collect();
                    *book_cache = new_cache;
                }
            }

            return Ok(serde_json::json!({ "success": true }));
        }
    } else {
        return Err("無法刪除壓縮檔內的單一頁面！".into());
    }

    Ok(serde_json::json!({ "success": false }))
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
            next.insert(id, progress);
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
        return Ok(());
    }
    let scan_dir = state.scan_dir.read().unwrap().clone();
    let now = chrono::Utc::now().to_rfc3339();
    let (progress, is_local_source) = {
        let mut comics = state.comics.lock().await;
        let comic = comics
            .iter_mut()
            .find(|comic| comic.id == id)
            .ok_or_else(|| "找不到閱讀中的漫畫，已拒絕寫入孤兒進度".to_string())?;
        comic.progress.current_page = current_page;
        comic.progress.total_pages = total_pages;
        comic.progress.percent = percent;
        comic.progress.updated_at = Some(now);
        comic.page_count = total_pages;
        (
            comic.progress.clone(),
            comic.source_id.starts_with("local:"),
        )
    };

    let store = catalog_store(&state)?;
    let identifier = id.clone();
    let sqlite_progress = progress.clone();
    tokio::task::spawn_blocking(move || store.save_progress(&identifier, &sqlite_progress))
        .await
        .map_err(|error| format!("穩定進度儲存工作失敗: {error}"))??;

    if is_local_source && !scan_dir.is_empty() {
        let _file_guard = state.progress_file_lock.lock().await;
        let scan_dir = std::path::PathBuf::from(scan_dir);
        if let Err(error) =
            tokio::task::spawn_blocking(move || write_progress_file(&scan_dir, &id, progress))
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
            let workers = if request.uri().host() == Some("cover")
                || request.uri().path().starts_with("/cover/")
            {
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
            scan_library,
            search_catalog,
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
    use std::fs;

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
        let partial = root.join("book.part");
        let final_path = root.join("book.cbz");
        fs::write(&partial, b"complete").unwrap();
        let state = AppState::new();
        state
            .reader_generation
            .store(4, std::sync::atomic::Ordering::Release);
        commit_smb_download_if_current(&state, 4, &partial, &final_path).unwrap();
        assert_eq!(fs::read(&final_path).unwrap(), b"complete");

        let stale_partial = root.join("stale.part");
        fs::write(&stale_partial, b"stale").unwrap();
        state
            .reader_generation
            .store(5, std::sync::atomic::Ordering::Release);
        assert!(commit_smb_download_if_current(&state, 4, &stale_partial, &final_path).is_err());
        assert!(stale_partial.exists());
        assert_eq!(fs::read(&final_path).unwrap(), b"complete");
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
        assert_eq!(relocate_ios_documents(&current.to_string_lossy(), current), current.to_string_lossy());
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
        assert!(validate_ai_session(AiSessionRequest {
            provider: "openai".into(),
            api_key: "not-a-real-api-key-for-tests".into(),
            google_content_disclosure: false,
        })
        .is_err());
        let openai = validate_ai_session(AiSessionRequest {
            provider: "openai".into(),
            api_key: "not-a-real-api-key-for-tests".into(),
            google_content_disclosure: true,
        })
        .unwrap();
        assert_eq!(openai.model, "gpt-5.6-luna");

        assert!(validate_ai_session(AiSessionRequest {
            provider: "google".into(),
            api_key: "not-a-real-api-key-for-tests".into(),
            google_content_disclosure: false,
        })
        .is_err());
        let google = validate_ai_session(AiSessionRequest {
            provider: "google".into(),
            api_key: "not-a-real-api-key-for-tests".into(),
            google_content_disclosure: true,
        })
        .unwrap();
        assert_eq!(google.model, "gemma-4-26b-a4b-it");
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
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            "gemma-4-26b-a4b-it"
        ));
        assert!(!should_try_gemma_fallback(
            reqwest::StatusCode::BAD_REQUEST,
            "gemma-4-26b-a4b-it"
        ));
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
    fn page_data_url_validation_rejects_unsupported_mime_and_bad_base64() {
        assert!(validate_page_data_url("data:text/plain;base64,SGk=").is_err());
        assert!(validate_page_data_url("data:image/png;base64,***").is_err());
        assert!(validate_page_data_url("data:image/png;base64,AA==").is_ok());
    }
}
