pub mod cache;
pub mod protocol;
pub mod scanner;
pub mod smb_scanner;
pub mod state;
pub mod utils;

use state::{AppState, ComicItem, Progress};
use std::io::Write;
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
async fn get_library(state: State<'_, Arc<AppState>>) -> Result<Vec<ComicItem>, String> {
    let comics = state.comics.lock().await;
    Ok(comics.clone())
}

#[tauri::command]
async fn get_scan_status(state: State<'_, Arc<AppState>>) -> Result<state::ScanProgress, String> {
    let progress = state.scan_progress.lock().await;
    Ok(progress.clone())
}

#[tauri::command]
async fn open_comic(id: String, state: State<'_, Arc<AppState>>, app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use base64::{engine::general_purpose, Engine as _};
    use std::path::Path;

    let relative_path_bytes = general_purpose::URL_SAFE_NO_PAD.decode(&id).map_err(|e| e.to_string())?;
    let relative_path_str = String::from_utf8(relative_path_bytes).map_err(|e| e.to_string())?;

    let comic_info = {
        let comics = state.comics.lock().await;
        comics.iter().find(|c| c.id == id).cloned()
    }.ok_or_else(|| "找不到漫畫資料".to_string())?;
    let reader_generation = state.reader_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

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
            let temp_dir = app_handle.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
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
                smb2::connect(&addr, &username, &password)
            ).await
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
                client.connect_share(&cfg.share)
            ).await
                .map_err(|_| {
                    let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                    format!("SMB Share '{}' 連線逾時（10 秒）", cfg.share)
                })?;
            if tree_result.is_err() {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err(format!("SMB Share 連線錯誤: {:?}", tree_result.err().unwrap()));
            }
            let tree = tree_result.unwrap();

            let smb_path = relative_path_str.replace("/", "\\");
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let partial_path = full_path.with_extension(format!(
                "{}.part-{}-{nonce}",
                full_path.extension().and_then(|ext| ext.to_str()).unwrap_or("download"),
                std::process::id()
            ));
            let download_result: Result<(), String> = async {
                use tokio::io::AsyncWriteExt;

                let mut download = client.download(&tree, &smb_path).await
                    .map_err(|error| format!("SMB 讀取錯誤: {error:?}"))?;
                let mut file = tokio::fs::File::create(&partial_path).await
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
                    file.write_all(&bytes).await.map_err(|error| format!("SMB 暫存檔寫入失敗: {error}"))?;
                }
                file.sync_all().await.map_err(|error| format!("SMB 暫存檔同步失敗: {error}"))?;
                tokio::fs::rename(&partial_path, &full_path).await
                    .map_err(|error| format!("SMB 暫存檔提交失敗: {error}"))?;
                Ok(())
            }.await;
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
        full_path = Path::new(&relative_path_str).to_path_buf();
        if !full_path.exists() {
            return Err("找不到外部漫畫！".into());
        }
        #[cfg(target_os = "ios")]
        {
            let canonical = full_path.canonicalize().map_err(|error| format!("外部漫畫路徑無效: {error}"))?;
            let allowed = state.active_bookmarks.lock().unwrap().values()
                .filter_map(|root| Path::new(root).canonicalize().ok())
                .any(|root| canonical.starts_with(root));
            if !allowed {
                return Err("外部資料夾權限尚未啟用，請重新加入資料夾".into());
            }
        }
        is_dir = full_path.is_dir();
    } else {
        let scan_dir = { state.scan_dir.read().unwrap().clone() };
        full_path = Path::new(&scan_dir).join(&relative_path_str);

        if !full_path.exists() {
            return Err("找不到漫畫！".into());
        }

        // Path Traversal 漏洞防護
        let canon_scan = std::path::Path::new(&scan_dir).canonicalize().map_err(|e| format!("掃描目錄無效: {}", e))?;
        let canon_full = full_path.canonicalize().map_err(|e| format!("無效路徑: {}", e))?;
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
        let entry_names = crate::utils::get_archive_images(&full_path).map_err(|error| error.to_string())?;
        for i in 0..entry_names.len() {
            pages.push(format!("comic://page/{}/{}", id, i));
        }

        // 將結果存入快取
        entry_names
    };

    // 從 comics 清單中找尋漫畫的 Metadata
    let (title, r#type, progress) = {
        let comics = state.comics.lock().await;
        let c = comics.iter().find(|c| c.id == id).ok_or_else(|| "漫畫已從書庫移除".to_string())?;
        (c.title.clone(), c.r#type.clone(), c.progress.clone())
    };

    // 只允許最新的 open command 提交 reader session，避免關閉後舊請求復活。
    let preload_generation = {
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        if state.reader_generation.load(std::sync::atomic::Ordering::Acquire) != reader_generation {
            return Err("開啟漫畫已取消".into());
        }
        state.opened_comic_files.write().unwrap().insert(id.clone(), opened_files);
        state.ram_cache_pool.lock().unwrap().clear();
        *state.active_comic_id.lock().unwrap() = Some(id.clone());
        state.preload_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
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
async fn close_comic(comic_id: Option<String>, state: State<'_, Arc<AppState>>, app_handle: tauri::AppHandle) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};
    if let Some(ref id) = comic_id {
        let comic_type = {
            let comics = state.comics.lock().await;
            comics.iter().find(|comic| comic.id == *id).map(|comic| comic.r#type.clone())
        };
        let _lifecycle = state.comic_lifecycle.lock().unwrap();
        let mut active_id = state.active_comic_id.lock().unwrap();
        if active_id.as_ref().map(|active| active == id).unwrap_or(true) {
            state.reader_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            state.preload_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *active_id = None;
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
                let temp_dir = app_handle.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
                let relative = std::path::Path::new(&rel_str);
                if relative.is_absolute() || relative.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
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
            state.reader_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            state.preload_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *state.active_comic_id.lock().unwrap() = None;
            state.ram_cache_pool.lock().unwrap().clear();
            state.opened_comic_files.write().unwrap().clear();
        }
        let temp_dir = app_handle.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
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
async fn set_config(data: serde_json::Value, state: State<'_, Arc<AppState>>, app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if let Some(scan_dir) = data.get("scanDir").and_then(|v| v.as_str()) {
        {
            let mut sd = state.scan_dir.write().unwrap();
            *sd = scan_dir.to_string();
        }

        {
            let mut comics = state.comics.lock().await;
            comics.clear();
        }

        state.scan_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // 更新設定後自動觸發重新掃描
        let state_clone = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            crate::scanner::start_background_scan(state_clone, app_handle).await;
        });
    }
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn set_smb_config(app_handle: tauri::AppHandle, state: State<'_, Arc<AppState>>, data: Option<crate::state::SmbConfig>) -> Result<serde_json::Value, String> {
    {
        let mut config = state.smb_config.write().unwrap();
        *config = data;
    }

    // 清除舊的漫畫快取與資料
    {
        let mut comics = state.comics.lock().await;
        comics.clear();
    }

    state.scan_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    // 更新設定後自動觸發重新掃描
    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        crate::scanner::start_background_scan(state_clone, app_handle).await;
    });

    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn set_bookmarks(data: Vec<crate::state::ExternalBookmark>, state: State<'_, Arc<AppState>>, app_handle: tauri::AppHandle) -> Result<(), String> {
    let old_bookmarks = { state.external_bookmarks.read().unwrap().clone() };

    let removed_bookmarks: Vec<_> = old_bookmarks.into_iter()
        .filter(|old| !data.iter().any(|new_b| new_b.bookmark == old.bookmark))
        .collect();

    for removed in removed_bookmarks {
        #[cfg(target_os = "ios")]
        {
            use tauri_plugin_ios_folder::StopAccessingRequest;
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            app_handle.tauri_plugin_ios_folder().stop_accessing(StopAccessingRequest {
                bookmark: removed.bookmark.clone(),
            }).map_err(|error| format!("無法釋放外部資料夾權限: {error}"))?;
        }
        let mut active = state.active_bookmarks.lock().unwrap();
        active.remove(&removed.bookmark);
    }

    *state.external_bookmarks.write().unwrap() = data;
    state.scan_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        crate::scanner::start_background_scan(state_clone, app_handle).await;
    });
    Ok(())
}

#[tauri::command]
async fn get_bookmarks(state: State<'_, Arc<AppState>>) -> Result<Vec<crate::state::ExternalBookmark>, String> {
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
async fn trash_page(comic_id: String, page_index: usize, state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    use base64::{engine::general_purpose, Engine as _};

    let relative_path_bytes = general_purpose::URL_SAFE_NO_PAD.decode(&comic_id).map_err(|e| e.to_string())?;
    let relative_path_str = String::from_utf8(relative_path_bytes).map_err(|e| e.to_string())?;

    let scan_dir = { state.scan_dir.read().unwrap().clone() };
    let full_path = std::path::Path::new(&scan_dir).join(&relative_path_str);

    // Path Traversal 漏洞防護
    let canon_scan = std::path::Path::new(&scan_dir).canonicalize().map_err(|e| format!("掃描目錄無效: {}", e))?;
    let canon_full = full_path.canonicalize().map_err(|e| format!("無效路徑: {}", e))?;
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
async fn save_imported_photo(state: State<'_, Arc<AppState>>, filename: String, data: Vec<u8>) -> Result<(), String> {
    let scan_dir = { state.scan_dir.read().unwrap().clone() };
    if scan_dir.is_empty() {
        return Err("掃描目錄尚未設定".into());
    }

    // 使用時間戳建立獨立的匯入資料夾，避免全部混在一起
    let timestamp = chrono::Utc::now().timestamp_millis();
    let import_dir_name = format!("匯入_{}", timestamp / 100000); // 100秒內的匯入算作同一次
    let import_dir = std::path::Path::new(&scan_dir).join("相簿匯入").join(&import_dir_name);

    if !import_dir.exists() {
        std::fs::create_dir_all(&import_dir).map_err(|e| e.to_string())?;
    }

    // 為了防止同檔名覆蓋（例如多張 IMG_0001.JPG），加上精確的毫秒級前綴
    let unique_filename = format!("{}_{}", chrono::Utc::now().timestamp_micros(), filename);
    let file_path = import_dir.join(&unique_filename);
    std::fs::write(&file_path, data).map_err(|e| e.to_string())?;

    Ok(())
}

fn write_progress_file(scan_dir: &std::path::Path, id: &str, progress: Progress) -> Result<(), String> {
    let progress_file = scan_dir.join(".comic_progress.json");
    let mut all_progress: std::collections::HashMap<String, Progress> = match std::fs::read_to_string(&progress_file) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|error| format!("進度檔已損壞，為避免覆蓋資料已取消儲存: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::collections::HashMap::new(),
        Err(error) => return Err(format!("無法讀取進度檔: {error}")),
    };
    all_progress.insert(id.to_string(), progress);

    let json = serde_json::to_vec(&all_progress).map_err(|error| format!("無法序列化進度: {error}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_file = scan_dir.join(format!(".comic_progress.json.tmp.{}_{nanos}", std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp_file).map_err(|error| format!("無法建立進度暫存檔: {error}"))?;
        file.write_all(&json).map_err(|error| format!("無法寫入進度暫存檔: {error}"))?;
        file.sync_all().map_err(|error| format!("無法同步進度暫存檔: {error}"))?;
        std::fs::rename(&tmp_file, &progress_file).map_err(|error| format!("無法原子替代進度檔: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_file);
    }
    result
}

#[tauri::command]
async fn save_progress(data: serde_json::Value, state: State<'_, Arc<AppState>>) -> Result<(), String> {
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
                    c.progress.percent = if total > 0 { (page as f64 / total as f64) * 100.0 } else { 0.0 };
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
async fn scan_library(app_handle: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
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
            protocol::handle_comic_request(app.app_handle(), request)
                .unwrap_or_else(|e| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(e.to_string().into_bytes())
                        .unwrap()
                })
        })
        .setup(move |app| {
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
            set_bookmarks,
            get_bookmarks,
            open_folder_dialog,
            browse_folders,
            show_item_in_folder,
            trash_page,
            save_imported_photo,
            scan_library
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
        let temp_dir = std::env::temp_dir().join(format!("comic_test_save_progress_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let old = Progress { current_page: 1, total_pages: 10, percent: 10.0, updated_at: None };
        fs::write(temp_dir.join(".comic_progress.json"), serde_json::json!({"old": old}).to_string()).unwrap();

        let new = Progress { current_page: 5, total_pages: 10, percent: 50.0, updated_at: None };
        write_progress_file(&temp_dir, "new", new).unwrap();

        let progress_file = temp_dir.join(".comic_progress.json");
        let parsed: serde_json::Value = serde_json::from_str(&fs::read_to_string(progress_file).unwrap()).unwrap();
        assert_eq!(parsed["old"]["currentPage"], 1);
        assert_eq!(parsed["new"]["currentPage"], 5);
        assert!(fs::read_dir(&temp_dir).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().contains(".tmp.")));

        fs::remove_dir_all(temp_dir).unwrap_or_default();
    }

    #[test]
    fn corrupted_progress_is_not_overwritten() {
        let temp_dir = std::env::temp_dir().join(format!("comic_test_bad_progress_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let progress_file = temp_dir.join(".comic_progress.json");
        fs::write(&progress_file, "{broken").unwrap();

        let progress = Progress { current_page: 5, total_pages: 10, percent: 50.0, updated_at: None };
        assert!(write_progress_file(&temp_dir, "new", progress).is_err());
        assert_eq!(fs::read_to_string(progress_file).unwrap(), "{broken");
        fs::remove_dir_all(temp_dir).unwrap_or_default();
    }
}
