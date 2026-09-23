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

pub(crate) fn safe_archive_entry_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.starts_with('\\')
        && !name.chars().any(char::is_control)
        && !name
            .split(['/', '\\'])
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn visible_archive_page_name(name: &str) -> bool {
    safe_archive_entry_name(name)
        && !name
            .split(['/', '\\'])
            .any(|part| part.starts_with('.') || part.eq_ignore_ascii_case("__MACOSX"))
}

fn supported_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_lowercase()))
        .is_some_and(|extension| crate::scanner::IMAGE_EXTENSIONS.contains(&extension.as_str()))
}

pub fn get_folder_images(folder_path: &Path) -> Vec<PathBuf> {
    let mut images = Vec::new();
    if let Ok(entries) = std::fs::read_dir(folder_path) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Never follow page symlinks. The scanner and protocol use the same
            // fail-closed rule so a link cannot become a ghost/escape page.
            if file_type.is_symlink() || !file_type.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            // The scanner excludes dot-prefixed filesystem entries. Keep the
            // reader page index aligned so a hidden thumbnail cannot become page 1.
            if file_name.starts_with('.') || file_name.eq_ignore_ascii_case("__MACOSX") {
                continue;
            }
            let path = entry.path();
            if supported_image_extension(&path) {
                images.push(path);
            }
        }
    }
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

    let mut entry_names = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| match error {
            zip::result::ZipError::UnsupportedArchive(_) => {
                ArchiveError::UnsupportedZip(error.to_string())
            }
            _ => ArchiveError::InvalidZip(error.to_string()),
        })?;
        let name = entry.name();
        if entry.is_dir()
            || entry.size() == 0
            || !visible_archive_page_name(name)
            || !supported_image_extension(Path::new(name))
        {
            continue;
        }
        entry_names.push(name.to_string());
    }

    entry_names.sort_by(|a, b| {
        let primary = natord::compare(a, b);
        if primary == std::cmp::Ordering::Equal {
            a.cmp(b)
        } else {
            primary
        }
    });
    // ZIP permits duplicate central-directory names. The reader addresses pages
    // by name, so exposing duplicates would render the same by_name() entry twice.
    entry_names.dedup();

    if entry_names.is_empty() {
        return Err(ArchiveError::NoSupportedImages);
    }

    let mut first_entry = archive
        .by_name(&entry_names[0])
        .map_err(|error| match error {
            zip::result::ZipError::UnsupportedArchive(_) => {
                ArchiveError::UnsupportedZip(error.to_string())
            }
            _ => ArchiveError::InvalidZip(error.to_string()),
        })?;
    let mut probe = [0_u8; 1];
    let read = first_entry
        .read(&mut probe)
        .map_err(|error| ArchiveError::InvalidZip(error.to_string()))?;
    if read == 0 {
        return Err(ArchiveError::InvalidZip(
            "第一個圖片項目宣告為非空但無法讀出內容".into(),
        ));
    }

    Ok(entry_names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_zip_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "gai-{name}-{}-{}.zip",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn archive_images_are_filtered_deduplicated_and_naturally_sorted() {
        let path = temp_zip_path("images");
        let file = std::fs::File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        for name in [
            "page10.jpg",
            "notes.txt",
            "page2.PNG",
            "page2.PNG",
            "__MACOSX/cover.jpg",
            ".thumb.jpg",
            "chapter/.cache/page3.jpg",
            "../escape.jpg",
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(b"test").unwrap();
        }
        writer.finish().unwrap();

        let images = get_archive_images(&path).unwrap();
        assert_eq!(images, ["page2.PNG", "page10.jpg"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn folder_images_match_scanner_hidden_file_policy() {
        let root = std::env::temp_dir().join(format!(
            "gai-folder-images-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".thumbnail.jpg"), b"hidden").unwrap();
        std::fs::write(root.join("page10.jpg"), b"ten").unwrap();
        std::fs::write(root.join("page2.jpg"), b"two").unwrap();

        let images = get_folder_images(&root);
        assert_eq!(
            images
                .iter()
                .filter_map(|path| path.file_name().and_then(|name| name.to_str()))
                .collect::<Vec<_>>(),
            ["page2.jpg", "page10.jpg"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsafe_archive_entry_names_are_rejected() {
        assert!(safe_archive_entry_name("chapter/page01.jpg"));
        assert!(!safe_archive_entry_name("../page.jpg"));
        assert!(!safe_archive_entry_name("chapter/../page.jpg"));
        assert!(!safe_archive_entry_name("chapter\\..\\page.jpg"));
        assert!(!safe_archive_entry_name("/absolute/page.jpg"));
        assert!(!safe_archive_entry_name("bad\nname.jpg"));
        assert!(!visible_archive_page_name(".cover.jpg"));
        assert!(!visible_archive_page_name("chapter/.cache/page.jpg"));
        assert!(!visible_archive_page_name("__MACOSX/page.jpg"));
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
