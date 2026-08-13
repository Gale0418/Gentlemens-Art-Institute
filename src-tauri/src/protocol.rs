use crate::state::AppState;
use base64::{engine::general_purpose, Engine as _};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path};
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};
use tauri::Manager;

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

fn read_image_limited<R: Read>(reader: R) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    reader.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_IMAGE_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "image exceeds size limit"));
    }
    Ok(buf)
}

fn get_mime(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".svg" => "image/svg+xml",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn is_page_out_of_range(page_count: usize, page_index: usize) -> bool {
    page_count > 0 && page_index >= page_count
}

fn canonical_image_within(image_path: &Path, folder_path: &Path) -> Option<std::path::PathBuf> {
    let canonical_image = image_path.canonicalize().ok()?;
    let canonical_folder = folder_path.canonicalize().ok()?;
    canonical_image.starts_with(&canonical_folder).then_some(canonical_image)
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
            .chunks_exact(4)
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

        // IDs are capabilities: reject unknown IDs before touching any cache or path.
        let comic_info = {
            let comics = state.comics.blocking_lock();
            comics.iter().find(|c| c.id == folder_id).cloned()
        };
        let comic_info = match comic_info {
            Some(info) => info,
            None => return Response::builder().status(StatusCode::NOT_FOUND).body(b"unknown folder comic".to_vec()).map_err(Into::into),
        };

        let relative_path_bytes = general_purpose::URL_SAFE_NO_PAD.decode(folder_id).unwrap_or_default();
        let relative_path_str = String::from_utf8(relative_path_bytes).unwrap_or_default();
        if Path::new(&relative_path_str).components().any(|component| matches!(component, Component::ParentDir)) {
            return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
        }

        let is_external = comic_info.r#type.starts_with("external-");

        let folder_path = if is_external {
            let path = Path::new(&relative_path_str).to_path_buf();
            #[cfg(target_os = "ios")]
            {
                let allowed = match path.canonicalize() {
                    Ok(canonical) => state
                        .active_bookmarks
                        .lock()
                        .unwrap()
                        .values()
                        .filter_map(|root| Path::new(root).canonicalize().ok())
                        .any(|root| canonical.starts_with(root)),
                    Err(_) => false,
                };
                if !allowed {
                    return Response::builder().status(StatusCode::FORBIDDEN).body(b"external bookmark is not active".to_vec()).map_err(Into::into);
                }
            }
            path
        } else {
            let scan_dir = { state.scan_dir.read().unwrap().clone() };
            if scan_dir.is_empty() {
                return Response::builder().status(StatusCode::FORBIDDEN).body(b"scan directory is not configured".to_vec()).map_err(Into::into);
            }
            let p = Path::new(&scan_dir).join(&relative_path_str);
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
            // 從快取讀取檔案路徑（以 capability folder_id 作 key）
            let cached_path = {
                let opened = state.opened_comic_files.read().unwrap();
                opened.get(folder_id).and_then(|files| files.get(index).cloned())
            };

            if let Some(img_path_str) = cached_path {
                let img_path = Path::new(&img_path_str);
                if let Some(canonical_image) = canonical_image_within(img_path, &folder_path) {
                    let mut f = match File::open(&canonical_image) {
                        Ok(file) => file,
                        Err(_) => return Response::builder().status(StatusCode::NOT_FOUND).body(b"not found".to_vec()).map_err(Into::into),
                    };
                    let buf = match read_image_limited(&mut f) {
                        Ok(buf) => buf,
                        Err(_) => return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(b"image too large".to_vec()).map_err(Into::into),
                    };
                    let ext = canonical_image.extension().and_then(|s| s.to_str()).unwrap_or("");
                    let mime = detect_mime(&buf, &format!(".{}", ext));

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
                    if let Some(canonical_image) = canonical_image_within(img_path, &folder_path) {
                        let mut f = match File::open(&canonical_image) {
                            Ok(file) => file,
                            Err(_) => return Response::builder().status(StatusCode::NOT_FOUND).body(b"not found".to_vec()).map_err(Into::into),
                        };
                        let buf = match read_image_limited(&mut f) {
                            Ok(buf) => buf,
                            Err(_) => return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(b"image too large".to_vec()).map_err(Into::into),
                        };
                        let ext = canonical_image.extension().and_then(|s| s.to_str()).unwrap_or("");
                        let mime = detect_mime(&buf, &format!(".{}", ext));

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
        let page_index: usize = if host == "cover" {
            0
        } else {
            match parts.get(2).and_then(|s| s.parse().ok()) {
                Some(index) => index,
                None => return Response::builder().status(StatusCode::BAD_REQUEST).body(b"invalid page index".to_vec()).map_err(Into::into),
            }
        };

        // IDs are capabilities: reject unknown IDs before touching any cache or path.
        let comic_info = {
            let comics = state.comics.blocking_lock();
            comics.iter().find(|c| c.id == id).cloned()
        };
        let comic_info = match comic_info {
            Some(info) => info,
            None => return Response::builder().status(StatusCode::NOT_FOUND).body(b"unknown comic".to_vec()).map_err(Into::into),
        };
        let page_count = {
            let opened = state.opened_comic_files.read().unwrap();
            opened.get(id).map(|pages| pages.len()).unwrap_or(comic_info.page_count)
        };
        // 掃描階段的 0 代表「尚未計算」，不是一本零頁漫畫。
        // 封面與尚未開啟的頁面請求應繼續交由實體檔案內容判斷。
        if is_page_out_of_range(page_count, page_index) {
            return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).body(b"page out of range".to_vec()).map_err(Into::into);
        }

        // 🚀 檢查極致 RAM 快取池
        let cached_buf = {
            let pool = state.ram_cache_pool.lock().unwrap();
            if let Some(book) = pool.get(id) {
                book.get(&page_index).cloned()
            } else {
                None
            }
        };

        if let Some(buf) = cached_buf {
            let mime = detect_mime(&buf, &comic_info.ext);
            return Response::builder()
                .header("Content-Type", mime)
                .header("Cache-Control", "public, max-age=86400")
                .header("Access-Control-Allow-Origin", "*")
                .body(buf).map_err(Into::into);
        }

        let relative_path_bytes = general_purpose::URL_SAFE_NO_PAD.decode(id).unwrap_or_default();
        let relative_path_str = String::from_utf8(relative_path_bytes).unwrap_or_default();
        if Path::new(&relative_path_str).components().any(|component| matches!(component, Component::ParentDir)) {
            return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
        }

        let is_smb = comic_info.r#type == "smb-archive";
        let is_external = comic_info.r#type.starts_with("external-");

        let full_path;
        if is_smb {
            let temp_dir = app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
            full_path = temp_dir.join(&relative_path_str);
        } else if is_external {
            full_path = Path::new(&relative_path_str).to_path_buf();
        } else {
            let scan_dir = { state.scan_dir.read().unwrap().clone() };
            if scan_dir.is_empty() {
                return Response::builder().status(StatusCode::FORBIDDEN).body(b"scan directory is not configured".to_vec()).map_err(Into::into);
            }
            full_path = Path::new(&scan_dir).join(&relative_path_str);
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

        if is_smb {
            let temp_root = app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("ComicTemp");
            match (full_path.canonicalize(), temp_root.canonicalize()) {
                (Ok(canon_full), Ok(canon_root)) if !canon_full.starts_with(&canon_root) => {
                    return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
                }
                (Err(_), _) | (_, Err(_)) => {
                    return Response::builder().status(StatusCode::FORBIDDEN).body(b"forbidden".to_vec()).map_err(Into::into);
                }
                _ => {}
            }
        }

        if full_path.is_dir() {
            let images = crate::utils::get_folder_images(&full_path);
            if let Some(img_path) = images.get(page_index) {
                if let Some(canonical_image) = canonical_image_within(img_path, &full_path) {
                    let mut file = match File::open(&canonical_image) {
                        Ok(file) => file,
                        Err(_) => return Response::builder().status(StatusCode::NOT_FOUND).body(b"not found".to_vec()).map_err(Into::into),
                    };
                    let buf = match read_image_limited(&mut file) {
                        Ok(buf) => buf,
                        Err(_) => return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(b"image too large".to_vec()).map_err(Into::into),
                    };
                    let ext = canonical_image.extension().and_then(|value| value.to_str()).unwrap_or("");
                    let mime = detect_mime(&buf, &format!(".{}", ext));

                    return Response::builder()
                        .header("Content-Type", mime)
                        .header("Cache-Control", "public, max-age=86400")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(buf).map_err(Into::into);
                }
            }
        } else if full_path.is_file() {
            if let Ok(file) = File::open(&full_path) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    // 從快取讀取進入點名稱
                    let cached_name = {
                        let opened = state.opened_comic_files.read().unwrap();
                        opened.get(id).and_then(|names| names.get(page_index).cloned())
                    };

                    if let Some(target_name) = cached_name {
                        if let Ok(mut file) = archive.by_name(&target_name) {
                            let buf = match read_image_limited(&mut file) {
                                Ok(buf) => buf,
                                Err(_) => return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(b"image too large".to_vec()).map_err(Into::into),
                            };
                            let ext = Path::new(&target_name).extension().and_then(|s| s.to_str()).unwrap_or("");
                            let mime = detect_mime(&buf, &format!(".{}", ext));

                            return Response::builder()
                                .header("Content-Type", mime)
                                .header("Cache-Control", "public, max-age=86400")
                                .header("Access-Control-Allow-Origin", "*")
                                .body(buf).map_err(Into::into);
                        }
                    } else {
                        // Fallback
                        let entry_names = crate::utils::get_archive_images(&full_path).unwrap_or_default();
                        if page_index < entry_names.len() {
                            let target_name = &entry_names[page_index];
                            if let Ok(mut file) = archive.by_name(target_name) {
                                let buf = match read_image_limited(&mut file) {
                                    Ok(buf) => buf,
                                    Err(_) => return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(b"image too large".to_vec()).map_err(Into::into),
                                };
                                let ext = Path::new(target_name).extension().and_then(|s| s.to_str()).unwrap_or("");
                                let mime = detect_mime(&buf, &format!(".{}", ext));

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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn unknown_page_count_does_not_reject_cover_page() {
        assert!(!is_page_out_of_range(0, 0));
    }

    #[test]
    fn known_page_count_still_rejects_out_of_range_page() {
        assert!(is_page_out_of_range(3, 3));
        assert!(!is_page_out_of_range(3, 2));
    }

    #[test]
    fn unopened_comic_page_count_zero_allows_cover_request() {
        // When comic has not been opened yet, page_count is 0 (unknown).
        // Cover request (page_index = 0) must not be rejected with 416.
        assert!(!is_page_out_of_range(0, 0));
    }

    #[test]
    fn folder_comic_cover_reads_first_naturally_sorted_image() {
        let temp_dir = std::env::temp_dir().join(format!("comic_test_folder_cover_{}", std::process::id()));
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
        let root = std::env::temp_dir().join(format!("comic_protocol_boundary_{}", std::process::id()));
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
