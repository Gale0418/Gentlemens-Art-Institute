pub mod cache;
pub mod protocol;
pub mod scanner;
pub mod smb_scanner;
pub mod state;
pub mod utils;

use state::{AppState, ComicItem, Progress};
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
    };
    
    let is_smb = comic_info.as_ref().map(|c| c.r#type == "smb-archive").unwrap_or(false);
    let is_external = comic_info.as_ref().map(|c| c.r#type.starts_with("external-")).unwrap_or(false);
    
    let full_path;
    let is_dir;
    
    if is_smb {
        let smb_cfg = { state.smb_config.read().unwrap().clone() };
        if let Some(cfg) = smb_cfg {
            use tauri::Emitter;
            let _ = app_handle.emit("smb-download-start", serde_json::json!({"id": id}));
            
            println!("🌐 準備下載 SMB 漫畫: {}", relative_path_str);
            let temp_dir = app_handle.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
            std::fs::create_dir_all(&temp_dir).unwrap_or_default();
            full_path = temp_dir.join(&relative_path_str);
            
            let addr = format!("{}:445", cfg.host);
            let username = cfg.username.unwrap_or_else(|| "guest".to_string());
            let password = cfg.password.unwrap_or_else(|| "".to_string());
            
            let client_result = smb2::connect(&addr, &username, &password).await;
            if client_result.is_err() {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err(format!("SMB 連線錯誤: {:?}", client_result.err().unwrap()));
            }
            let mut client = client_result.unwrap();
            
            let tree_result = client.connect_share(&cfg.share).await;
            if tree_result.is_err() {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err(format!("SMB Share 連線錯誤: {:?}", tree_result.err().unwrap()));
            }
            let mut tree = tree_result.unwrap();
            
            let smb_path = relative_path_str.clone();
            let data_result = client.read_file(&mut tree, &smb_path).await;
            if data_result.is_err() {
                let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
                return Err(format!("SMB 讀取錯誤: {:?}", data_result.err().unwrap()));
            }
            let data = data_result.unwrap();
            
            let write_res = tokio::fs::write(&full_path, data).await;
            let _ = app_handle.emit("smb-download-end", serde_json::json!({"id": id}));
            if let Err(e) = write_res {
                return Err(e.to_string());
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

    if is_dir {
        let folder_base64 = general_purpose::URL_SAFE_NO_PAD.encode(full_path.to_string_lossy().as_bytes());
        let images = crate::utils::get_folder_images(&full_path);
        
        // 將結果存入快取
        let mut cached_files = Vec::new();
        for (i, p) in images.iter().enumerate() {
            pages.push(format!("comic://folder/{}/{}", folder_base64, i));
            cached_files.push(p.to_string_lossy().to_string());
        }
        
        let mut opened = state.opened_comic_files.write().unwrap();
        opened.insert(id.clone(), cached_files);
    } else {
        // Zip file
        let entry_names = crate::utils::get_archive_images(&full_path);
        for i in 0..entry_names.len() {
            pages.push(format!("comic://page/{}/{}", id, i));
        }
        
        // 將結果存入快取
        let mut opened = state.opened_comic_files.write().unwrap();
        opened.insert(id.clone(), entry_names);
    }

    // 從 comics 清單中找尋漫畫的 Metadata
    let (title, r#type, progress) = {
        let comics = state.comics.lock().await;
        if let Some(c) = comics.iter().find(|c| c.id == id) {
            (c.title.clone(), c.r#type.clone(), c.progress.clone())
        } else {
            ("".to_string(), if is_dir { "folder".to_string() } else { "archive".to_string() }, Progress { current_page: 0, total_pages: pages.len(), percent: 0.0, updated_at: None })
        }
    };

    // 觸發背景預載任務
    let state_clone = state.inner().clone();
    let id_clone = id.clone();
    let handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        crate::cache::preload_comic(state_clone, handle_clone, id_clone).await;
    });

    Ok(serde_json::json!({ 
        "id": id, 
        "type": r#type,
        "title": title,
        "isDir": is_dir,
        "pages": pages,
        "progress": progress
    }))
}

#[tauri::command]
async fn open_folder_dialog(_app: tauri::AppHandle) -> Result<String, String> {
    // 這裡只是預留給自訂對話框的，因為目前前端直接使用 tauri-plugin-dialog
    Ok("".to_string())
}

#[tauri::command]
async fn close_comic(state: State<'_, Arc<AppState>>, app_handle: tauri::AppHandle) -> Result<(), String> {
    // 釋放記憶體快取
    let mut pool = state.ram_cache_pool.lock().unwrap();
    pool.clear();
    
    // 清空打開的檔案列表快取
    let mut opened = state.opened_comic_files.write().unwrap();
    opened.clear();
    
    // 釋放 SMB 等網路暫存檔
    let temp_dir = app_handle.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
    if temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
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
async fn set_bookmarks(data: Vec<crate::state::ExternalBookmark>, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.external_bookmarks.write().unwrap() = data.clone();
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
            trash::delete(&target_file).map_err(|e| e.to_string())?;
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

#[tauri::command]
async fn save_progress(data: serde_json::Value, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(obj) = data.as_object() {
        if let (Some(id), Some(page), Some(total)) = (
            obj.get("id").and_then(|v| v.as_str()),
            obj.get("currentPage").and_then(|v| v.as_u64()),
            obj.get("totalPages").and_then(|v| v.as_u64()),
        ) {
            // BUG-02 修正：先讀取 scan_dir (RwLock)，再鎖定 comics (Mutex)，防止死鎖
            let scan_dir = { state.scan_dir.read().unwrap().clone() };
            
            let mut comics = state.comics.lock().await;
            if let Some(c) = comics.iter_mut().find(|c| c.id == id) {
                c.progress.current_page = page as usize;
                c.progress.total_pages = total as usize;
                c.progress.percent = if total > 0 { (page as f64 / total as f64) * 100.0 } else { 0.0 };
                c.progress.updated_at = Some(chrono::Utc::now().to_rfc3339());
                
                // 將進度寫入 .comic_progress.json
                if !scan_dir.is_empty() {
                    let progress_file = std::path::Path::new(&scan_dir).join(".comic_progress.json");
                    let mut all_progress: std::collections::HashMap<String, crate::state::Progress> = std::collections::HashMap::new();
                    if let Ok(content) = std::fs::read_to_string(&progress_file) {
                        if let Ok(parsed) = serde_json::from_str(&content) {
                            all_progress = parsed;
                        }
                    }
                    all_progress.insert(id.to_string(), c.progress.clone());
                    if let Ok(json) = serde_json::to_string(&all_progress) {
                        if let Err(e) = std::fs::write(progress_file, json) {
                            return Err(format!("無法儲存進度: {}", e));
                        }
                    } else {
                        return Err("無法序列化進度".into());
                    }
                }
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
