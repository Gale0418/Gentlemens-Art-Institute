use crate::state::AppState;
use base64::{engine::general_purpose, Engine as _};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;

fn get_mime(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".svg" => "image/svg+xml",
        ".jpg" | ".jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

pub fn handle_comic_request(
    app: &tauri::AppHandle,
    request: Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>> {
    let uri = request.uri().to_string();
    let path_str = uri.strip_prefix("comic://").unwrap_or(&uri);
    let path_str = path_str.strip_prefix("localhost/").unwrap_or(path_str);
    
    let parts: Vec<&str> = path_str.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Response::builder().status(StatusCode::BAD_REQUEST).body(b"bad request".to_vec()).map_err(Into::into);
    }

    let host = parts[0]; 
    let state = app.state::<Arc<AppState>>();

    if host == "folder" && parts.len() >= 3 {
        let folder_id = parts[1];
        let index: usize = parts[2].parse().unwrap_or(0);
        let folder_path_bytes = general_purpose::URL_SAFE_NO_PAD.decode(folder_id).unwrap_or_default();
        let folder_path_str = String::from_utf8(folder_path_bytes).unwrap_or_default();
        
        let comic_info = {
            let comics = state.comics.blocking_lock();
            comics.iter().find(|c| c.id == folder_id).cloned()
        };
        let is_external = comic_info.as_ref().map(|c| c.r#type.starts_with("external-")).unwrap_or(false);
        
        let folder_path = if is_external {
            Path::new(&folder_path_str).to_path_buf()
        } else {
            let scan_dir = { state.scan_dir.read().unwrap().clone() };
            let p = Path::new(&scan_dir).join(&folder_path_str);
            // BUG-04 修正：用 canonicalize 取代 starts_with 字串比對，防止 symlink 越權
            if !scan_dir.is_empty() {
                match (p.canonicalize(), Path::new(&scan_dir).canonicalize()) {
                    (Ok(canon_p), Ok(canon_scan)) if !canon_p.starts_with(&canon_scan) => {
                        return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
                    }
                    (Err(_), _) => {
                        return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
                    }
                    _ => {}
                }
            }
            p
        };

        if folder_path.is_dir() {
            // 從快取讀取檔案路徑
            let cached_path = {
                let opened = state.opened_comic_files.read().unwrap();
                opened.get(folder_id).and_then(|files| files.get(index).cloned())
            };
            
            if let Some(img_path_str) = cached_path {
                let img_path = Path::new(&img_path_str);
                if let Ok(mut f) = File::open(img_path) {
                    let mut buf = Vec::new();
                    let _ = f.read_to_end(&mut buf);
                    let ext = img_path.extension().and_then(|s| s.to_str()).unwrap_or("");
                    let mime = get_mime(&format!(".{}", ext));
                    
                    return Response::builder()
                        .header("Content-Type", mime)
                        .header("Cache-Control", "public, max-age=86400")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(buf).map_err(Into::into);
                }
            } else {
                // Fallback (cache miss)
                let images = crate::utils::get_folder_images(&folder_path);
                if index < images.len() {
                    let img_path = &images[index];
                    if let Ok(mut f) = File::open(img_path) {
                        let mut buf = Vec::new();
                        let _ = f.read_to_end(&mut buf);
                        let ext = img_path.extension().and_then(|s| s.to_str()).unwrap_or("");
                        let mime = get_mime(&format!(".{}", ext));
                        
                        return Response::builder()
                            .header("Content-Type", mime)
                            .header("Cache-Control", "public, max-age=86400")
                            .header("Access-Control-Allow-Origin", "*")
                            .body(buf).map_err(Into::into);
                    }
                }
            }
        }

    } else if (host == "page" || host == "cover") && parts.len() >= 2 {
        let id = parts[1];
        let page_index: usize = if host == "cover" { 0 } else { parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0) };
        
        // 🚀 檢查極致 RAM 快取池
        let cached_buf = {
            let pool = state.ram_cache_pool.lock().unwrap();
            if let Some(book) = pool.get(id) {
                if let Some(buf) = book.get(&page_index) {
                    Some(buf.clone())
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(buf) = cached_buf {
            // 目前快取沒存附檔名，根據魔術數字推測
            let mime = if buf.len() > 8 && &buf[0..8] == b"\x89PNG\r\n\x1a\n" {
                "image/png"
            } else if buf.len() > 4 && &buf[0..4] == b"RIFF" {
                "image/webp"
            } else if buf.len() > 3 && &buf[0..3] == b"GIF" {
                "image/gif"
            } else {
                "image/jpeg"
            };
            return Response::builder()
                .header("Content-Type", mime)
                .header("Cache-Control", "public, max-age=86400")
                .header("Access-Control-Allow-Origin", "*")
                .body(buf).map_err(Into::into);
        }

        let relative_path_bytes = general_purpose::URL_SAFE_NO_PAD.decode(id).unwrap_or_default();
        let relative_path_str = String::from_utf8(relative_path_bytes).unwrap_or_default();
        
        let comic_info = {
            let comics = state.comics.blocking_lock();
            comics.iter().find(|c| c.id == id).cloned()
        };
        let is_smb = comic_info.as_ref().map(|c| c.r#type == "smb-archive").unwrap_or(false);
        let is_external = comic_info.as_ref().map(|c| c.r#type.starts_with("external-")).unwrap_or(false);
        
        let full_path;
        if is_smb {
            let temp_dir = app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
            full_path = temp_dir.join(&relative_path_str);
        } else if is_external {
            full_path = Path::new(&relative_path_str).to_path_buf();
        } else {
            let scan_dir = { state.scan_dir.read().unwrap().clone() };
            full_path = Path::new(&scan_dir).join(&relative_path_str);
            // BUG-04 修正：用 canonicalize 取代 starts_with 字串比對
            if !scan_dir.is_empty() {
                match (full_path.canonicalize(), Path::new(&scan_dir).canonicalize()) {
                    (Ok(canon_full), Ok(canon_scan)) if !canon_full.starts_with(&canon_scan) => {
                        return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
                    }
                    (Err(_), _) => {
                        return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
                    }
                    _ => {}
                }
            }
        }

        if full_path.is_file() {
            if let Ok(file) = File::open(&full_path) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    // 從快取讀取進入點名稱
                    let cached_name = {
                        let opened = state.opened_comic_files.read().unwrap();
                        opened.get(id).and_then(|names| names.get(page_index).cloned())
                    };
                    
                    if let Some(target_name) = cached_name {
                        if let Ok(mut file) = archive.by_name(&target_name) {
                            let mut buf = Vec::new();
                            let _ = file.read_to_end(&mut buf);
                            let ext = Path::new(&target_name).extension().and_then(|s| s.to_str()).unwrap_or("");
                            let mime = get_mime(&format!(".{}", ext));
                            
                            return Response::builder()
                                .header("Content-Type", mime)
                                .header("Cache-Control", "public, max-age=86400")
                                .header("Access-Control-Allow-Origin", "*")
                                .body(buf).map_err(Into::into);
                        }
                    } else {
                        // Fallback
                        let entry_names = crate::utils::get_archive_images(&full_path);
                        if page_index < entry_names.len() {
                            let target_name = &entry_names[page_index];
                            if let Ok(mut file) = archive.by_name(target_name) {
                                let mut buf = Vec::new();
                                let _ = file.read_to_end(&mut buf);
                                let ext = Path::new(target_name).extension().and_then(|s| s.to_str()).unwrap_or("");
                                let mime = get_mime(&format!(".{}", ext));
                                
                                return Response::builder()
                                    .header("Content-Type", mime)
                                    .header("Cache-Control", "public, max-age=86400")
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(buf).map_err(Into::into);
                            }
                        }
                    }
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
