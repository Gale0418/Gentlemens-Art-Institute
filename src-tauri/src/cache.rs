use crate::state::AppState;
use base64::{engine::general_purpose, Engine as _};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};

const MAX_PRELOAD_PAGES: usize = 5;
const MAX_PRELOAD_BYTES: usize = 64 * 1024 * 1024;

fn resolve_preload_path(
    comic_type: Option<&str>,
    scan_dir: &Path,
    smb_temp_dir: &Path,
    relative_path: &str,
) -> PathBuf {
    match comic_type {
        Some("smb-archive") => smb_temp_dir.join(relative_path),
        Some(kind) if kind.starts_with("external-") => PathBuf::from(relative_path),
        _ => scan_dir.join(relative_path),
    }
}

pub async fn preload_comic(state: Arc<AppState>, app_handle: tauri::AppHandle, id: String, generation: u64) {
    // 取得 relative_path
    let relative_path_bytes = match general_purpose::URL_SAFE_NO_PAD.decode(&id) {
        Ok(b) => b,
        Err(_) => return,
    };
    let relative_path_str = match String::from_utf8(relative_path_bytes) {
        Ok(s) => s,
        Err(_) => return,
    };

    let comic_type = {
        let comics = state.comics.lock().await;
        comics
            .iter()
            .find(|comic| comic.id == id)
            .map(|comic| comic.r#type.clone())
    };
    let scan_dir = { state.scan_dir.read().unwrap().clone() };
    let smb_temp_dir = app_handle
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("ComicTemp");
    let full_path = resolve_preload_path(
        comic_type.as_deref(),
        Path::new(&scan_dir),
        &smb_temp_dir,
        &relative_path_str,
    );

    if !full_path.exists() || full_path.is_dir() {
        // 資料夾模式速度極快，不太需要預載到記憶體
        let _ = app_handle.emit("ram-cache-progress", serde_json::json!({
            "id": id, "generation": generation, "loaded": 0, "total": 0, "finished": true
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

                let preload_count = entry_names.len().min(MAX_PRELOAD_PAGES);
                let mut cached_bytes = 0;
                let mut loaded_count = 0;
                for (i, target_name) in entry_names.iter().take(preload_count).enumerate() {
                    if state.preload_generation.load(std::sync::atomic::Ordering::Acquire) != generation {
                        return;
                    }
                    if let Ok(mut file) = archive.by_name(target_name) {
                        let expected_size = file.size() as usize;
                        if expected_size > MAX_PRELOAD_BYTES.saturating_sub(cached_bytes) {
                            break;
                        }
                        let mut buf = Vec::new();
                        let remaining = MAX_PRELOAD_BYTES.saturating_sub(cached_bytes);
                        if file.by_ref().take((remaining + 1) as u64).read_to_end(&mut buf).is_ok() {
                            if buf.len() > remaining {
                                break;
                            }
                            if state.preload_generation.load(std::sync::atomic::Ordering::Acquire) != generation {
                                return;
                            }
                            cached_bytes += buf.len();
                            // generation check 與寫入必須在同一個 lifecycle 區段內。
                            let id_clone = id.clone();
                            {
                                let _lifecycle = state.comic_lifecycle.lock().unwrap();
                                if state.preload_generation.load(std::sync::atomic::Ordering::Acquire) != generation {
                                    return;
                                }
                                let mut pool = state.ram_cache_pool.lock().unwrap();
                                let book_cache = pool.entry(id_clone.clone()).or_default();
                                book_cache.insert(i, buf);
                            }
                            loaded_count = i + 1;
                            
                            // 發送進度到前端
                            let _ = app_handle.emit("ram-cache-progress", serde_json::json!({
                                "id": id_clone,
                                "generation": generation,
                                "loaded": i + 1,
                                "total": preload_count,
                                "finished": false
                            }));
                        }
                    }
                }

                if state.preload_generation.load(std::sync::atomic::Ordering::Acquire) == generation {
                    let _ = app_handle.emit("ram-cache-progress", serde_json::json!({
                        "id": id,
                        "generation": generation,
                        "loaded": loaded_count,
                        "total": preload_count,
                        "finished": true
                    }));
                }
            }
        }
    }).await;
}

#[cfg(test)]
mod tests {
    use super::resolve_preload_path;
    use std::path::Path;

    #[test]
    fn preload_path_uses_smb_download_cache() {
        let resolved = resolve_preload_path(
            Some("smb-archive"),
            Path::new("/library"),
            Path::new("/app-data/ComicTemp"),
            "series/book.zip",
        );

        assert_eq!(resolved, Path::new("/app-data/ComicTemp/series/book.zip"));
    }

    #[test]
    fn preload_path_preserves_external_absolute_path() {
        let resolved = resolve_preload_path(
            Some("external-archive"),
            Path::new("/library"),
            Path::new("/app-data/ComicTemp"),
            "/external/book.zip",
        );

        assert_eq!(resolved, Path::new("/external/book.zip"));
    }
}
