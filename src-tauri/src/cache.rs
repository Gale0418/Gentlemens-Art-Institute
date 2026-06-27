use crate::state::AppState;
use base64::{engine::general_purpose, Engine as _};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use tauri::Emitter;

pub async fn preload_comic(state: Arc<AppState>, app_handle: tauri::AppHandle, id: String) {
    // 取得 relative_path
    let relative_path_bytes = match general_purpose::URL_SAFE_NO_PAD.decode(&id) {
        Ok(b) => b,
        Err(_) => return,
    };
    let relative_path_str = match String::from_utf8(relative_path_bytes) {
        Ok(s) => s,
        Err(_) => return,
    };

    let scan_dir = { state.scan_dir.read().unwrap().clone() };
    let full_path = Path::new(&scan_dir).join(&relative_path_str);

    if !full_path.exists() || full_path.is_dir() {
        // 資料夾模式速度極快，不太需要預載到記憶體
        let _ = app_handle.emit("ram-cache-progress", serde_json::json!({
            "id": id, "loaded": 0, "total": 0, "finished": true
        }));
        return;
    }

    // 只預載 Zip
    // BUG-03 修正：對 spawn_blocking 加上 .await 確保任務確實執行完畢
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(file) = File::open(&full_path) {
            if let Ok(mut archive) = zip::ZipArchive::new(file) {
                // 從 opened_comic_files 快取讀取，省去重新掃描跟排序的時間
                let entry_names = {
                    let opened = state.opened_comic_files.read().unwrap();
                    opened.get(&id).cloned().unwrap_or_else(Vec::new)
                };

                // 預載前 20 頁進記憶體
                let preload_count = entry_names.len().min(20);
                for i in 0..preload_count {
                    let target_name = &entry_names[i];
                    if let Ok(mut file) = archive.by_name(target_name) {
                        let mut buf = Vec::new();
                        if file.read_to_end(&mut buf).is_ok() {
                            // 寫入快取
                            let state_clone = state.clone();
                            let id_clone = id.clone();
                            let mut pool = state_clone.ram_cache_pool.lock().unwrap();
                            let book_cache = pool.entry(id_clone.clone()).or_insert_with(std::collections::HashMap::new);
                            book_cache.insert(i, buf);
                            
                            // 發送進度到前端
                            let _ = app_handle.emit("ram-cache-progress", serde_json::json!({
                                "id": id_clone,
                                "loaded": i + 1,
                                "total": preload_count,
                                "finished": (i + 1) == preload_count
                            }));
                        }
                    }
                }
            }
        }
    }).await;
}
