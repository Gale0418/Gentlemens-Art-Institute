pub mod cache;
pub mod catalog;
pub mod metadata;
pub mod protocol;
pub mod scanner;
pub mod smb_scanner;
pub mod state;
pub mod utils;

use state::{AppState, ComicItem, Progress};
use std::io::Write;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

fn catalog_store(state: &State<'_, Arc<AppState>>) -> Result<catalog::CatalogStore, String> {
    state
        .catalog
        .read()
        .map_err(|_| "漫畫目錄鎖定失敗".to_string())?
        .clone()
        .ok_or_else(|| "漫畫目錄尚未初始化".to_string())
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
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.get_metadata(&id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn apply_batch_metadata(
    request: catalog::BatchEditRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::BatchEditResult, String> {
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
    rule: catalog::FolderTagRule,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::FolderTagRule, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.upsert_folder_rule(rule))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reimport_metadata(
    request: catalog::ReimportRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::ReimportResult, String> {
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
    alias: catalog::TagAlias,
    state: State<'_, Arc<AppState>>,
) -> Result<catalog::TagAlias, String> {
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
async fn list_organizer_inbox(
    limit: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::OrganizerInboxItem>, String> {
    let store = catalog_store(&state)?;
    tokio::task::spawn_blocking(move || store.organizer_inbox(limit.unwrap_or(200)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_duplicate_candidates(
    limit: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<catalog::DuplicateCandidate>, String> {
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

#[tauri::command]
fn default_catalog_export_path(app: AppHandle, filename: String) -> Result<String, String> {
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
    let target = std::path::PathBuf::from(path);
    if target.as_os_str().is_empty() || !target.is_absolute() {
        return Err("匯出路徑不可為空".into());
    }
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
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("寫入 metadata 匯出檔失敗：{error}"))?;
        file.write_all(payload.as_bytes())
            .map_err(|error| format!("寫入 metadata 匯出檔失敗：{error}"))?;
        Ok(target.to_string_lossy().into_owned())
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
async fn get_library(state: State<'_, Arc<AppState>>) -> Result<Vec<ComicItem>, String> {
    let comics = state.comics.lock().await;
    let mut items = comics.clone();
    drop(comics);
    if let Ok(store) = catalog_store(&state) {
        items = tokio::task::spawn_blocking(move || store.overlay_library(items))
            .await
            .map_err(|error| error.to_string())??;
    }
    Ok(items)
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
    use base64::{engine::general_purpose, Engine as _};
    use std::path::Path;

    let relative_path_bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(&id)
        .map_err(|e| e.to_string())?;
    let relative_path_str = String::from_utf8(relative_path_bytes).map_err(|e| e.to_string())?;

    let comic_info = {
        let comics = state.comics.lock().await;
        comics.iter().find(|c| c.id == id).cloned()
    }
    .ok_or_else(|| "找不到漫畫資料".to_string())?;
    let reader_generation = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let generation = state
            .reader_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        *state.pending_open_id.lock().unwrap() = Some(id.clone());
        generation
    };

    let is_smb = comic_info.r#type == "smb-archive";
    let is_external = comic_info.r#type.starts_with("external-");

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
        let smb_cfg = { state.smb_config.read().unwrap().clone() };
        if let Some(cfg) = smb_cfg {
            use tauri::Emitter;
            let _ = app_handle.emit("smb-download-start", serde_json::json!({"id": id}));

            println!("🌐 準備下載 SMB 漫畫: {}", relative_path_str);
            let temp_dir = app_handle
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ComicTemp");
            std::fs::create_dir_all(&temp_dir).unwrap_or_default();
            full_path = temp_dir.join(relative);
            if let Some(parent) = full_path.parent() {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                    return Err(format!("無法建立 SMB 暫存目錄: {error}"));
                }
            }

            let addr = format!("{}:445", cfg.host);
            let username = cfg.username.unwrap_or_else(|| "guest".to_string());
            let password = cfg.password.unwrap_or_else(|| "".to_string());

            let client_result = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                smb2::connect(&addr, &username, &password),
            )
            .await
            .map_err(|_| {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                "SMB 連線逾時（10 秒），請檢查 NAS IP 或連線".to_string()
            })?;
            if client_result.is_err() {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err(format!("SMB 連線錯誤: {:?}", client_result.err().unwrap()));
            }
            let mut client = client_result.unwrap();

            let tree_result = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                client.connect_share(&cfg.share),
            )
            .await
            .map_err(|_| {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                format!("SMB Share '{}' 連線逾時（10 秒）", cfg.share)
            })?;
            if tree_result.is_err() {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err(format!(
                    "SMB Share 連線錯誤: {:?}",
                    tree_result.err().unwrap()
                ));
            }
            let tree = tree_result.unwrap();

            let smb_path = relative_path_str.replace("/", "\\");
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let partial_path = full_path.with_extension(format!(
                "{}.part-{}-{nonce}",
                full_path
                    .extension()
                    .and_then(|ext| ext.to_str())
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
                    let next = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        download.next_chunk(),
                    )
                    .await
                    .map_err(|_| "SMB 傳輸逾時（30 秒未收到資料）".to_string())?;
                    let Some(chunk) = next else { break };
                    let bytes = chunk.map_err(|error| format!("SMB 傳輸錯誤: {error:?}"))?;
                    file.write_all(&bytes)
                        .await
                        .map_err(|error| format!("SMB 暫存檔寫入失敗: {error}"))?;
                }
                file.sync_all()
                    .await
                    .map_err(|error| format!("SMB 暫存檔同步失敗: {error}"))?;
                tokio::fs::rename(&partial_path, &full_path)
                    .await
                    .map_err(|error| format!("SMB 暫存檔提交失敗: {error}"))?;
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
    } else if is_external {
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
            return Err("找不到外部漫畫！".into());
        }
        is_dir = full_path.is_dir();
    } else {
        let scan_dir = { state.scan_dir.read().unwrap().clone() };
        full_path = Path::new(&scan_dir).join(&relative_path_str);

        if !full_path.exists() {
            return Err("找不到漫畫！".into());
        }

        // Path Traversal 漏洞防護
        let canon_scan = std::path::Path::new(&scan_dir)
            .canonicalize()
            .map_err(|e| format!("掃描目錄無效: {}", e))?;
        let canon_full = full_path
            .canonicalize()
            .map_err(|e| format!("無效路徑: {}", e))?;
        if !canon_full.starts_with(&canon_scan) {
            return Err("路徑越權！禁止存取掃描目錄外的檔案！".into());
        }

        is_dir = full_path.is_dir();
    }

    let mut pages = Vec::new();

    let opened_files = if is_dir {
        let images = crate::utils::get_folder_images(&full_path);

        // 將結果存入快取 (URL 統一使用 capability token id)
        let mut cached_files = Vec::new();
        for (i, p) in images.iter().enumerate() {
            pages.push(format!("comic://folder/{}/{}", id, i));
            cached_files.push(p.to_string_lossy().to_string());
        }

        cached_files
    } else {
        // Zip file
        let entry_names =
            crate::utils::get_archive_images(&full_path).map_err(|error| error.to_string())?;
        for i in 0..entry_names.len() {
            pages.push(format!("comic://page/{}/{}", id, i));
        }

        // 將結果存入快取
        entry_names
    };

    // 從 comics 清單中找尋漫畫的 Metadata
    let (title, r#type, progress) = {
        let comics = state.comics.lock().await;
        let c = comics
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| "漫畫已從書庫移除".to_string())?;
        (c.title.clone(), c.r#type.clone(), c.progress.clone())
    };

    // 只允許最新的 open command 提交 reader session，避免關閉後舊請求復活。
    let preload_generation = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        if state
            .reader_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != reader_generation
        {
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
    // 這裡只是預留給自訂對話框的，因為目前前端直接使用 tauri-plugin-dialog
    Ok("".to_string())
}

#[tauri::command]
async fn close_comic(
    comic_id: Option<String>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};
    if let Some(ref id) = comic_id {
        let comic_type = {
            let comics = state.comics.lock().await;
            comics
                .iter()
                .find(|comic| comic.id == *id)
                .map(|comic| comic.r#type.clone())
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
        // Scoped 清理指定 comic_id 的快取
        {
            let mut pool = state.ram_cache_pool.lock().unwrap();
            pool.remove(id);
        }
        {
            let mut opened = state.opened_comic_files.write().unwrap();
            opened.remove(id);
        }
        if comic_type.as_deref() == Some("smb-archive") {
            if let Ok(relative_bytes) = general_purpose::URL_SAFE_NO_PAD.decode(id) {
                if let Ok(rel_str) = String::from_utf8(relative_bytes) {
                    let temp_dir = app_handle
                        .path()
                        .app_local_data_dir()
                        .unwrap_or_else(|_| std::env::temp_dir())
                        .join("ComicTemp");
                    let relative = std::path::Path::new(&rel_str);
                    if relative.is_absolute()
                        || relative
                            .components()
                            .any(|part| matches!(part, std::path::Component::ParentDir))
                    {
                        return Err("拒絕清除不安全的 SMB 暫存路徑".into());
                    }
                    let item_temp = temp_dir.join(relative);
                    if item_temp.exists() {
                        if item_temp.is_dir() {
                            let _ = std::fs::remove_dir_all(&item_temp);
                        } else if item_temp.is_file() {
                            let _ = std::fs::remove_file(&item_temp);
                        }
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
async fn get_config(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let dir = state.scan_dir.read().unwrap();
    Ok(serde_json::json!({ "scanDir": dir.clone() }))
}

#[tauri::command]
async fn set_config(
    data: serde_json::Value,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if let Some(scan_dir) = data.get("scanDir").and_then(|v| v.as_str()) {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        {
            let mut sd = state.scan_dir.write().unwrap();
            *sd = scan_dir.to_string();
        }

        {
            let mut comics = state.comics.lock().await;
            comics.clear();
        }

        state
            .scan_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // 更新設定後自動觸發重新掃描
        let state_clone = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            crate::scanner::start_background_scan(state_clone, app_handle).await;
        });
    }
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn set_smb_config(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    data: Option<crate::state::SmbConfig>,
) -> Result<serde_json::Value, String> {
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    {
        let mut config = state.smb_config.write().unwrap();
        *config = data;
    }

    // 清除舊的漫畫快取與資料
    {
        let mut comics = state.comics.lock().await;
        comics.clear();
    }

    state
        .scan_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    // 更新設定後自動觸發重新掃描
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
    let (provider, model) = match data.provider.as_str() {
        "openai" => ("openai", "gpt-5.6-luna"),
        "google" if data.google_content_disclosure => ("google", "gemma-4-26b-a4b-it"),
        "google" => return Err("使用 Gemma 4 前請先同意 Google 免費層資料揭露".into()),
        _ => return Err("不支援的艦載 AI 供應商".into()),
    };
    Ok(crate::state::AiSessionConfig {
        provider: provider.to_string(),
        model: model.to_string(),
        api_key: api_key.to_string(),
        google_content_disclosure: data.google_content_disclosure,
    })
}

#[tauri::command]
async fn get_ai_session_status(state: State<'_, Arc<AppState>>) -> Result<AiSessionStatus, String> {
    let config = state.ai_session.read().unwrap();
    Ok(ai_status(config.as_ref()))
}

#[tauri::command]
async fn set_ai_session_config(
    data: AiSessionRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AiSessionStatus, String> {
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
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
        })
        .find(|item| item.get("type").and_then(|value| value.as_str()) == Some("output_text"))
        .and_then(|item| item.get("text").and_then(|value| value.as_str()))
        .map(str::to_string)
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
                    .and_then(|v| v.as_str())
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
        let endpoint = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            config.model
        );
        let response = client
            .post(endpoint)
            .header("x-goog-api-key", &config.api_key)
            .json(&serde_json::json!({
                "contents": [{ "role": "user", "parts": parts }],
                "generationConfig": { "maxOutputTokens": 700 }
            }))
            .send()
            .await
            .map_err(|error| format!("Gemma 4 連線失敗：{error}"))?;
        let status = response.status();
        let value: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "Gemma 4 拒絕請求（HTTP {}）：{}",
                status.as_u16(),
                value
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知錯誤")
            ));
        }
        value
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or_else(|| "Gemma 4 沒有回傳可顯示文字".to_string())
    }
}

#[tauri::command]
async fn test_ai_session(state: State<'_, Arc<AppState>>) -> Result<String, String> {
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
    data: ExplainPageRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let config = state
        .ai_session
        .read()
        .unwrap()
        .clone()
        .ok_or_else(|| "請先到設定輸入艦載 AI API Key".to_string())?;
    let (mime, encoded) = validate_page_data_url(&data.data_url)?;
    if config.provider == "google" && !config.google_content_disclosure {
        return Err("尚未同意 Google 資料揭露".into());
    }
    call_ai(
        config,
        Some((mime, encoded)),
        "請用自然、簡潔的繁體中文（台灣用語）說明這一頁漫畫在講什麼：先概述劇情，再整理對話大意；看不清楚或無法確定的地方要明說，不要杜撰。",
    )
        .await
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
                        .and_then(|value| value.as_str())
                        .is_none_or(|value| value.is_empty() || value.chars().count() > 64)
                        || tag
                            .get("value")
                            .and_then(|value| value.as_str())
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
    data: SuggestMetadataRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AiMetadataSuggestion>, String> {
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
        "請只回傳 JSON array，不要 Markdown。從目前這一頁提出可人工審核的漫畫 metadata 候選，格式為 [{\"field\":\"summary\",\"value\":\"繁中摘要\",\"confidence\":0.0},{\"field\":\"tags\",\"value\":[{\"namespace\":\"general\",\"value\":\"標籤\"}],\"confidence\":0.0}]。只可使用 summary 或 tags；看不清楚就不要猜，最多 8 筆。
        ",
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
    let old_bookmarks = { state.external_bookmarks.read().unwrap().clone() };
    let removed_bookmarks: Vec<_> = old_bookmarks
        .into_iter()
        .filter(|old| !data.iter().any(|new_b| new_b.bookmark == old.bookmark))
        .collect();
    #[cfg(target_os = "ios")]
    let mut stop_accessing_errors: Vec<String> = Vec::new();
    #[cfg(not(target_os = "ios"))]
    let stop_accessing_errors: Vec<String> = Vec::new();

    // External permission calls stay outside scan_lifecycle; they may block or call platform code.
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
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        let mut active = state.active_bookmarks.lock().unwrap();
        for removed in &removed_bookmarks {
            active.remove(&removed.bookmark);
        }
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
async fn show_item_in_folder(_path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn trash_page(
    comic_id: String,
    page_index: usize,
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    use base64::{engine::general_purpose, Engine as _};

    let relative_path_bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(&comic_id)
        .map_err(|e| e.to_string())?;
    let relative_path_str = String::from_utf8(relative_path_bytes).map_err(|e| e.to_string())?;

    let scan_dir = { state.scan_dir.read().unwrap().clone() };
    let full_path = std::path::Path::new(&scan_dir).join(&relative_path_str);
    let _lifecycle = state.comic_lifecycle.lock().unwrap();

    // Path Traversal 漏洞防護
    let canon_scan = std::path::Path::new(&scan_dir)
        .canonicalize()
        .map_err(|e| format!("掃描目錄無效: {}", e))?;
    let canon_full = full_path
        .canonicalize()
        .map_err(|e| format!("無效路徑: {}", e))?;
    if !canon_full.starts_with(&canon_scan) {
        return Err("路徑越權！禁止存取掃描目錄外的檔案！".into());
    }

    if full_path.is_dir() {
        let images = crate::utils::get_folder_images(&full_path);
        if page_index < images.len() {
            let target_file = &images[page_index];
            // 檔案路徑正確，搬到垃圾桶 (iOS 用直接刪除)
            #[cfg(not(target_os = "ios"))]
            trash::delete(target_file).map_err(|e| e.to_string())?;
            #[cfg(target_os = "ios")]
            std::fs::remove_file(&target_file).map_err(|e| e.to_string())?;

            // BUG-14 修正：更新 opened_comic_files 快取
            {
                let mut opened = state.opened_comic_files.write().unwrap();
                if let Some(files) = opened.get_mut(&comic_id) {
                    if page_index < files.len() {
                        files.remove(page_index);
                    }
                }
            }

            // BUG-14 修正：重建 ram_cache_pool 索引，防止刪頁後索引錯位
            // 把刪除頁面後的索引全部往前移動一位
            {
                let mut pool = state.ram_cache_pool.lock().unwrap();
                if let Some(book_cache) = pool.get_mut(&comic_id) {
                    let new_cache: std::collections::HashMap<usize, Vec<u8>> = book_cache
                        .iter()
                        .filter_map(|(idx, data)| {
                            if *idx < page_index {
                                Some((*idx, data.clone()))
                            } else if *idx > page_index {
                                Some((*idx - 1, data.clone()))
                            } else {
                                None // 跳過被刪除的那一頁
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

#[tauri::command]
async fn save_imported_photo(
    state: State<'_, Arc<AppState>>,
    filename: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let scan_dir = { state.scan_dir.read().unwrap().clone() };
    if scan_dir.is_empty() {
        return Err("掃描目錄尚未設定".into());
    }

    // 使用時間戳建立獨立的匯入資料夾，避免全部混在一起
    let timestamp = chrono::Utc::now().timestamp_millis();
    let import_dir_name = format!("匯入_{}", timestamp / 100000); // 100秒內的匯入算作同一次
    let import_dir = std::path::Path::new(&scan_dir)
        .join("相簿匯入")
        .join(&import_dir_name);

    if !import_dir.exists() {
        std::fs::create_dir_all(&import_dir).map_err(|e| e.to_string())?;
    }

    // 以 canonical 路徑確認匯入資料夾沒有透過 symlink 越出掃描根目錄，
    // 並使用 canonical 目錄進行後續建立，避免父路徑在檢查後被替換。
    let scan_root = std::path::Path::new(&scan_dir)
        .canonicalize()
        .map_err(|error| format!("掃描目錄無效: {error}"))?;
    let canonical_import_dir = import_dir
        .canonicalize()
        .map_err(|error| format!("匯入目錄無效: {error}"))?;
    if !canonical_import_dir.starts_with(&scan_root) || !canonical_import_dir.is_dir() {
        return Err("匯入目錄超出掃描目錄".into());
    }

    let import_handle =
        cap_std::fs::Dir::open_ambient_dir(&canonical_import_dir, cap_std::ambient_authority())
            .map_err(|error| format!("無法開啟匯入目錄: {error}"))?;
    write_import_file(
        &import_handle,
        &filename,
        &data,
        chrono::Utc::now().timestamp_micros(),
    )?;

    Ok(())
}

fn is_safe_import_filename(filename: &str) -> bool {
    let path = std::path::Path::new(filename);
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

    for attempt in 0..100u32 {
        let unique_filename = if attempt == 0 {
            format!("{timestamp_micros}_{filename}")
        } else {
            format!("{timestamp_micros}_{attempt}_{filename}")
        };
        // A retained directory capability plus create_new keeps the final component
        // relative to the verified directory and refuses an existing symlink atomically.
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
        return Ok(());
    }

    Err("匯入檔案名稱碰撞，請稍後再試".into())
}

fn write_progress_file(
    scan_dir: &std::path::Path,
    id: &str,
    progress: Progress,
) -> Result<(), String> {
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
    data: serde_json::Value,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Some(obj) = data.as_object() {
        if let (Some(id), Some(page), Some(total)) = (
            obj.get("id").and_then(|v| v.as_str()),
            obj.get("currentPage").and_then(|v| v.as_u64()),
            obj.get("totalPages").and_then(|v| v.as_u64()),
        ) {
            let scan_dir = { state.scan_dir.read().unwrap().clone() };

            // 在 comics lock 下僅更新記憶體中的 progress，並複製進度資料
            let updated_progress = {
                let mut comics = state.comics.lock().await;
                if let Some(c) = comics.iter_mut().find(|c| c.id == id) {
                    c.progress.current_page = page as usize;
                    c.progress.total_pages = total as usize;
                    c.progress.percent = if total > 0 {
                        (page as f64 / total as f64) * 100.0
                    } else {
                        0.0
                    };
                    c.progress.updated_at = Some(chrono::Utc::now().to_rfc3339());
                    Some(c.progress.clone())
                } else {
                    None
                }
            };

            // 釋放 comics lock 後，在 progress_file_lock 保護下完成檔案原子寫入
            if let (Some(progress), false) = (updated_progress, scan_dir.is_empty()) {
                let _file_guard = state.progress_file_lock.lock().await;
                let id = id.to_string();
                let scan_dir = std::path::PathBuf::from(scan_dir);
                tokio::task::spawn_blocking(move || write_progress_file(&scan_dir, &id, progress))
                    .await
                    .map_err(|error| format!("進度儲存工作失敗: {error}"))??;
            }
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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_ios_folder::init())
        .manage(app_state.clone())
        .register_uri_scheme_protocol("comic", |app, request| {
            protocol::handle_comic_request(app.app_handle(), request).unwrap_or_else(|e| {
                tauri::http::Response::builder()
                    .status(500)
                    .body(e.to_string().into_bytes())
                    .unwrap()
            })
        })
        .setup(move |app| {
            let catalog_dir = app
                .path()
                .app_local_data_dir()
                .map_err(std::io::Error::other)?;
            let catalog = catalog::CatalogStore::new(catalog_dir.join("catalog.sqlite3"))
                .map_err(std::io::Error::other)?;
            *app_state
                .catalog
                .write()
                .map_err(|_| std::io::Error::other("無法初始化漫畫目錄"))? = Some(catalog);
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                if let Ok(doc_dir) = app.path().document_dir() {
                    let mut sd = app_state.scan_dir.write().unwrap();
                    if sd.is_empty() {
                        *sd = doc_dir.to_string_lossy().to_string();
                    }
                }
            }

            // 啟動時自動觸發第一次掃描
            let handle = app.handle().clone();
            let state_clone = app_state.clone();
            tauri::async_runtime::spawn(async move {
                scanner::start_background_scan(state_clone, handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            get_scan_status,
            open_comic,
            close_comic,
            save_progress,
            get_config,
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
            set_bookmarks,
            get_bookmarks,
            open_folder_dialog,
            browse_folders,
            show_item_in_folder,
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
    fn ai_session_locks_models_and_requires_google_disclosure() {
        let openai = validate_ai_session(AiSessionRequest {
            provider: "openai".into(),
            api_key: "not-a-real-api-key-for-tests".into(),
            google_content_disclosure: false,
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
