use std::path::{Path, PathBuf};

pub fn get_folder_images(folder_path: &Path) -> Vec<PathBuf> {
    let mut images = Vec::new();
    if let Ok(entries) = std::fs::read_dir(folder_path) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    let ext_lower = format!(".{}", ext.to_lowercase());
                    if crate::scanner::IMAGE_EXTENSIONS.contains(&ext_lower.as_str()) && !p.to_string_lossy().contains("__MACOSX") {
                        images.push(p);
                    }
                }
            }
        }
    }
    // 自然排序
    images.sort_by(|a, b| natord::compare(a.to_str().unwrap_or(""), b.to_str().unwrap_or("")));
    images
}

pub fn get_archive_images(zip_path: &Path) -> Vec<String> {
    let mut entry_names = Vec::new();
    if let Ok(file) = std::fs::File::open(zip_path) {
        if let Ok(archive) = zip::ZipArchive::new(file) {
            entry_names = archive.file_names()
                .filter(|n| {
                    let ext = Path::new(n).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    crate::scanner::IMAGE_EXTENSIONS.contains(&format!(".{}", ext).as_str()) && !n.contains("__MACOSX")
                })
                .map(|s| s.to_string())
                .collect();
        }
    }
    // 自然排序（BUG-08 修正：改用 stable_sort_by 確保排序穩定、結果一致）
    entry_names.sort_by(|a, b| {
        let primary = natord::compare(a, b);
        if primary == std::cmp::Ordering::Equal {
            a.cmp(b) // 備援比較確保穩定性
        } else {
            primary
        }
    });
    entry_names
}
