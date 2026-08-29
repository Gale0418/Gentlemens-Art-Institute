use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum ArchiveError {
    FileAccess(String),
    InvalidZip(String),
    UnsupportedZip(String),
    NoSupportedImages,
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileAccess(error) => write!(f, "無法存取漫畫檔案：{error}"),
            Self::InvalidZip(error) => write!(f, "ZIP 檔案損壞或格式無效：{error}"),
            Self::UnsupportedZip(error) => {
                write!(f, "ZIP 使用了目前不支援的格式或加密方式：{error}")
            }
            Self::NoSupportedImages => write!(f, "ZIP 裡沒有支援的圖片檔案"),
        }
    }
}

pub fn get_folder_images(folder_path: &Path) -> Vec<PathBuf> {
    let mut images = Vec::new();
    if let Ok(entries) = std::fs::read_dir(folder_path) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    let ext_lower = format!(".{}", ext.to_lowercase());
                    if crate::scanner::IMAGE_EXTENSIONS.contains(&ext_lower.as_str())
                        && !p.to_string_lossy().contains("__MACOSX")
                    {
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

pub fn get_archive_images(zip_path: &Path) -> Result<Vec<String>, ArchiveError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|error| ArchiveError::FileAccess(error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| match error {
        zip::result::ZipError::UnsupportedArchive(_) => {
            ArchiveError::UnsupportedZip(error.to_string())
        }
        _ => ArchiveError::InvalidZip(error.to_string()),
    })?;

    let mut entry_names: Vec<String> = archive
        .file_names()
        .filter(|n| {
            let ext = Path::new(n)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            crate::scanner::IMAGE_EXTENSIONS.contains(&format!(".{}", ext).as_str())
                && !n.contains("__MACOSX")
        })
        .map(|s| s.to_string())
        .collect();

    if entry_names.is_empty() {
        return Err(ArchiveError::NoSupportedImages);
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

    let mut first_entry = archive
        .by_name(&entry_names[0])
        .map_err(|error| match error {
            zip::result::ZipError::UnsupportedArchive(_) => {
                ArchiveError::UnsupportedZip(error.to_string())
            }
            _ => ArchiveError::InvalidZip(error.to_string()),
        })?;
    let mut probe = [0_u8; 1];
    first_entry
        .read(&mut probe)
        .map_err(|error| ArchiveError::InvalidZip(error.to_string()))?;

    Ok(entry_names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_zip_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("gai-{name}-{}.zip", std::process::id()))
    }

    #[test]
    fn archive_images_are_filtered_and_naturally_sorted() {
        let path = temp_zip_path("images");
        let file = std::fs::File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        for name in ["page10.jpg", "notes.txt", "page2.PNG", "__MACOSX/cover.jpg"] {
            writer.start_file(name, options).unwrap();
            writer.write_all(b"test").unwrap();
        }
        writer.finish().unwrap();

        let images = get_archive_images(&path).unwrap();
        assert_eq!(images, ["page2.PNG", "page10.jpg"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn empty_archive_reports_no_supported_images() {
        let path = temp_zip_path("empty");
        let file = std::fs::File::create(&path).unwrap();
        zip::ZipWriter::new(file).finish().unwrap();

        assert_eq!(
            get_archive_images(&path),
            Err(ArchiveError::NoSupportedImages)
        );
        std::fs::remove_file(path).unwrap();
    }
}
