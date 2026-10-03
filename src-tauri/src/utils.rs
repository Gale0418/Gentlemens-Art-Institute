use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum ArchiveError {
    FileAccess(String),
    InvalidZip(String),
    UnsupportedZip(String),
    InvalidArchive(String),
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
            Self::InvalidArchive(error) => write!(f, "封存檔無法閱讀：{error}"),
            Self::NoSupportedImages => write!(f, "封存檔裡沒有支援的圖片檔案"),
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

fn zip_error(error: zip::result::ZipError) -> ArchiveError {
    match error {
        zip::result::ZipError::UnsupportedArchive(message) => {
            ArchiveError::UnsupportedZip(message.to_string())
        }
        other => ArchiveError::InvalidZip(other.to_string()),
    }
}

/// ZIP crate applies bounded central-directory metadata checks before its
/// `Vec`/`HashMap` allocation; this helper only adds the application file-size
/// cap and maps crate errors into the app error type.
pub(crate) fn open_zip_archive(path: &Path) -> Result<zip::ZipArchive<File>, ArchiveError> {
    open_zip_archive_from_file(
        File::open(path).map_err(|error| ArchiveError::FileAccess(error.to_string()))?,
    )
}

pub(crate) fn open_zip_archive_for_page(
    path: &Path,
) -> Result<zip::ZipArchive<File>, ArchiveError> {
    open_zip_archive_for_page_from_file(
        File::open(path).map_err(|error| ArchiveError::FileAccess(error.to_string()))?,
    )
}

pub(crate) fn open_zip_archive_from_file(
    file: File,
) -> Result<zip::ZipArchive<File>, ArchiveError> {
    open_zip_archive_with_file_size(file)
}

pub(crate) fn open_zip_archive_for_page_from_file(
    file: File,
) -> Result<zip::ZipArchive<File>, ArchiveError> {
    open_zip_archive_with_file_size(file)
}

fn open_zip_archive_with_file_size(file: File) -> Result<zip::ZipArchive<File>, ArchiveError> {
    let file_size = file
        .metadata()
        .map_err(|error| ArchiveError::FileAccess(error.to_string()))?
        .len();
    if file_size > crate::archive_reader::MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::InvalidZip(format!(
            "ZIP 檔案超過 {} bytes 上限",
            crate::archive_reader::MAX_ARCHIVE_BYTES
        )));
    }
    zip::ZipArchive::new(file).map_err(zip_error)
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

/// Capability-root 版本的資料夾 page index。名稱只來自已開啟的 directory
/// descriptor，呼叫者再以同一 descriptor 開啟實際 page。
pub(crate) fn get_folder_image_names_from_dir(folder: &cap_std::fs::Dir) -> Vec<String> {
    let mut images = Vec::new();
    let Ok(entries) = folder.read_dir(".") else {
        return images;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name.starts_with('.') || file_name.eq_ignore_ascii_case("__MACOSX") {
            continue;
        }
        if supported_image_extension(Path::new(file_name.as_ref())) {
            images.push(file_name.into_owned());
        }
    }
    images.sort_by(|a, b| natord::compare(a, b));
    images
}

pub fn get_archive_images(zip_path: &Path) -> Result<Vec<String>, ArchiveError> {
    get_archive_images_with_file(zip_path, None)
}

pub(crate) fn get_archive_images_from_file(
    zip_path: &Path,
    file: File,
) -> Result<Vec<String>, ArchiveError> {
    get_archive_images_with_file(zip_path, Some(file))
}

fn get_archive_images_with_file(
    zip_path: &Path,
    safe_file: Option<File>,
) -> Result<Vec<String>, ArchiveError> {
    let extension = zip_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "7z" | "cb7" | "rar" | "cbr") {
        let entries = match safe_file {
            Some(file) => crate::archive_reader::list_entries_from_file(file, zip_path),
            None => crate::archive_reader::list_entries(zip_path),
        }
        .map_err(|error| ArchiveError::InvalidArchive(error.to_string()))?;
        let mut names = entries
            .into_iter()
            .filter(|entry| !entry.is_directory && entry.size > 0)
            .map(|entry| entry.name)
            .filter(|name| {
                visible_archive_page_name(name) && supported_image_extension(Path::new(name))
            })
            .collect::<Vec<_>>();
        names.sort_by(|a, b| natord::compare(a, b).then_with(|| a.cmp(b)));
        names.dedup();
        return if names.is_empty() {
            Err(ArchiveError::NoSupportedImages)
        } else {
            Ok(names)
        };
    }
    let mut archive = match safe_file {
        Some(file) => open_zip_archive_from_file(file),
        None => open_zip_archive(zip_path),
    }?;

    let mut entry_names = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(zip_error)?;
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

    let mut first_entry = archive.by_name(&entry_names[0]).map_err(zip_error)?;
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

    #[test]
    fn zip64_pages_and_prepended_archives_remain_readable() {
        for prefix in [0, 128] {
            let path = temp_zip_path("zip64-valid");
            let cursor = std::io::Cursor::new(Vec::new());
            let mut writer = zip::ZipWriter::new(cursor);
            writer
                .start_file(
                    "page.jpg",
                    zip::write::FileOptions::default().large_file(true),
                )
                .unwrap();
            writer.write_all(b"image").unwrap();
            let bytes = writer.finish().unwrap().into_inner();
            let mut wrapped = vec![0_u8; prefix];
            wrapped.extend_from_slice(&bytes);
            std::fs::write(&path, wrapped).unwrap();
            let mut archive = open_zip_archive(&path).unwrap();
            let mut image = Vec::new();
            archive
                .by_name("page.jpg")
                .unwrap()
                .read_to_end(&mut image)
                .unwrap();
            assert_eq!(image, b"image");
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn zip64_large_self_extracting_prefix_remains_readable() {
        let path = temp_zip_path("zip64-sfx");
        let fixture = include_bytes!("../vendor/zip/tests/data/zip64_demo.zip");
        let mut bytes = vec![0_u8; 1024 * 1024 + 99];
        bytes.extend_from_slice(fixture);
        std::fs::write(&path, &bytes).unwrap();
        let archive = open_zip_archive(&path).unwrap();
        assert_eq!(archive.len(), 1);

        struct CountingReader {
            cursor: std::io::Cursor<Vec<u8>>,
            seeks: usize,
        }
        impl std::io::Read for CountingReader {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.cursor.read(bytes)
            }
        }
        impl std::io::Seek for CountingReader {
            fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
                self.seeks += 1;
                std::io::Seek::seek(&mut self.cursor, position)
            }
        }
        let measured = zip::ZipArchive::new(CountingReader {
            cursor: std::io::Cursor::new(bytes),
            seeks: 0,
        })
        .unwrap();
        let seeks = measured.into_inner().seeks;
        assert!(seeks < 100, "ZIP64 recovery performed {seeks} seeks");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn zip64_locator_count_is_checked_before_zip_archive_allocation() {
        let path = temp_zip_path("zip64-count");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0606_4b50_u32.to_le_bytes());
        bytes.extend_from_slice(&44_u64.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&(crate::archive_reader::MAX_ENTRY_COUNT as u64 + 1).to_le_bytes());
        bytes.extend_from_slice(&(crate::archive_reader::MAX_ENTRY_COUNT as u64 + 1).to_le_bytes());
        bytes.extend_from_slice(&0_u64.to_le_bytes());
        bytes.extend_from_slice(&0_u64.to_le_bytes());
        bytes.extend_from_slice(&0x0706_4b50_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u64.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();

        let error = open_zip_archive(&path).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("ZIP entry count exceeds the safety limit"),
            "{error}"
        );
        std::fs::remove_file(path).unwrap();
    }
}
