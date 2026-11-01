//! 安全的漫畫封存檔讀取核心。
//!
//! 這個模組只會把封存檔內容讀進記憶體，不會依照 entry 名稱建立檔案或目錄。
//! 7z 使用純 Rust 的 `sevenz-rust2`（Apache-2.0）；RAR/CBR 交給
//! 專案隨附的 BSD 授權 libarchive。兩種路徑都不會將 entry 解壓到檔案系統。

use serde::Serialize;
use sevenz_rust2::{ArchiveReader as SevenZArchiveReader, BlockDecoder, Password};
use std::collections::HashSet;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 單一 entry 可被讀取的最大解壓後大小。
pub const MAX_ENTRY_BYTES: usize = 128 * 1024 * 1024;
/// 單一封存檔所有 entry 宣告大小的總和上限。
pub const MAX_TOTAL_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 封存檔內可接受的 entry 數量上限。
pub const MAX_ENTRY_COUNT: usize = 100_000;
/// 讀取封存檔 header 時允許的輸入檔案大小上限。
pub const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ENTRY_NAME_BYTES: usize = 4096;
/// Aggregate UTF-8 bytes retained for all entry names in one archive.
pub const MAX_TOTAL_ENTRY_NAME_BYTES: usize = 16 * 1024 * 1024;

const SEVEN_Z_SIGNATURE: &[u8; 6] = b"7z\xBC\xAF\x27\x1C";
const RAR4_SIGNATURE: &[u8; 7] = b"Rar!\x1A\x07\x00";
const RAR5_SIGNATURE: &[u8; 8] = b"Rar!\x1A\x07\x01\x00";

/// 支援的封存檔種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveKind {
    SevenZip,
    Rar,
}

/// 封存檔內的一筆安全 metadata。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_directory: bool,
}

/// 讀取失敗。錯誤訊息會保留可供 UI 顯示的原因，但不會洩漏 entry 內容。
#[derive(Debug)]
pub enum ArchiveError {
    Io(String),
    UnsupportedFormat(String),
    UnsupportedFeature(String),
    Corrupt(String),
    UnsafeEntryPath(String),
    ArchiveTooLarge {
        bytes: u64,
        limit: u64,
    },
    TooManyEntries {
        count: usize,
        limit: usize,
    },
    ArchiveBomb {
        total: u64,
        limit: u64,
    },
    ArchiveMetadataTooLarge {
        bytes: usize,
        limit: usize,
    },
    EntryTooLarge {
        name: String,
        bytes: u64,
        limit: usize,
    },
    ReadLimitExceeded {
        name: String,
        limit: usize,
    },
    EntryNotFound(String),
    EntryIsDirectory(String),
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) => write!(f, "無法讀取封存檔：{message}"),
            Self::UnsupportedFormat(message) => write!(f, "不支援的封存檔格式：{message}"),
            Self::UnsupportedFeature(message) => write!(f, "封存檔功能尚未支援：{message}"),
            Self::Corrupt(message) => write!(f, "封存檔損毀或格式無效：{message}"),
            Self::UnsafeEntryPath(name) => write!(f, "封存檔 entry 路徑不安全：{name}"),
            Self::ArchiveTooLarge { bytes, limit } => {
                write!(f, "封存檔大小 {bytes} bytes 超過上限 {limit} bytes")
            }
            Self::TooManyEntries { count, limit } => {
                write!(f, "封存檔 entry 數量 {count} 超過上限 {limit}")
            }
            Self::ArchiveBomb { total, limit } => {
                write!(f, "封存檔宣告解壓大小 {total} bytes 超過上限 {limit} bytes")
            }
            Self::ArchiveMetadataTooLarge { bytes, limit } => {
                write!(
                    f,
                    "封存檔 entry metadata {bytes} bytes 超過上限 {limit} bytes"
                )
            }
            Self::EntryTooLarge { name, bytes, limit } => {
                write!(
                    f,
                    "entry {name} 宣告大小 {bytes} bytes 超過讀取上限 {limit} bytes"
                )
            }
            Self::ReadLimitExceeded { name, limit } => {
                write!(f, "entry {name} 解壓內容超過讀取上限 {limit} bytes")
            }
            Self::EntryNotFound(name) => write!(f, "找不到封存檔 entry：{name}"),
            Self::EntryIsDirectory(name) => write!(f, "entry 是目錄，不能讀取內容：{name}"),
        }
    }
}

impl std::error::Error for ArchiveError {}

impl From<io::Error> for ArchiveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// 已通過格式與輸入大小檢查的封存檔 handle。
#[derive(Debug, Clone)]
pub struct ArchiveReader {
    path: PathBuf,
    kind: ArchiveKind,
}

impl ArchiveReader {
    /// 開啟封存檔並辨識格式。這一步只讀 metadata 與最多 8 bytes signature。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ArchiveError> {
        let path = path.as_ref();
        let bytes = std::fs::metadata(path)?.len();
        if bytes > MAX_ARCHIVE_BYTES {
            return Err(ArchiveError::ArchiveTooLarge {
                bytes,
                limit: MAX_ARCHIVE_BYTES,
            });
        }

        let mut file = File::open(path)?;
        let mut signature = [0_u8; 8];
        let read = file.read(&mut signature)?;
        let kind = identify_kind(&signature[..read], path)?;
        Ok(Self {
            path: path.to_path_buf(),
            kind,
        })
    }

    pub fn kind(&self) -> ArchiveKind {
        self.kind
    }

    pub fn list_entries(&self) -> Result<Vec<ArchiveEntry>, ArchiveError> {
        list_entries_for_kind(&self.path, self.kind)
    }

    /// 讀取指定 entry，結果最多包含 `max_bytes` bytes。
    pub fn read_entry(&self, name: &str, max_bytes: usize) -> Result<Vec<u8>, ArchiveError> {
        read_entry_for_kind(&self.path, self.kind, name, max_bytes)
    }
}

/// 列出封存檔 entries；entry 名稱會在回傳前通過 traversal 與控制字元檢查。
pub fn list_entries(path: impl AsRef<Path>) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    ArchiveReader::open(path)?.list_entries()
}

/// 列出已由 capability root 開啟的 archive。`file` 的 descriptor 會一路
/// 傳給底層 reader，避免先做路徑檢查後又以可競態的字串路徑重開檔。
pub fn list_entries_from_file(
    mut file: File,
    path_hint: &Path,
) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    let kind = identify_kind_from_file(&mut file, path_hint)?;
    list_entries_for_file(file, kind, path_hint)
}

/// 讀取單一 entry 至 bounded memory buffer，不會將內容寫到檔案系統。
pub fn read_entry(
    path: impl AsRef<Path>,
    name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    ArchiveReader::open(path)?.read_entry(name, max_bytes)
}

/// 從已開啟且受授權的 descriptor 讀取單一 entry。
pub fn read_entry_from_file(
    mut file: File,
    path_hint: &Path,
    name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    let kind = identify_kind_from_file(&mut file, path_hint)?;
    read_entry_for_file(file, kind, path_hint, name, max_bytes)
}

fn identify_kind_from_file(file: &mut File, path: &Path) -> Result<ArchiveKind, ArchiveError> {
    let mut signature = [0_u8; 8];
    let read = file.read(&mut signature)?;
    file.seek(SeekFrom::Start(0))?;
    identify_kind(&signature[..read], path)
}

fn list_entries_for_file(
    file: File,
    kind: ArchiveKind,
    path: &Path,
) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    match kind {
        ArchiveKind::Rar => crate::rar_reader::list_entries_from_file(file, path),
        ArchiveKind::SevenZip => {
            let reader = open_sevenz_from_file(file)?;
            validate_sevenz_entries(&reader.archive().files)
        }
    }
}

fn read_entry_for_file(
    file: File,
    kind: ArchiveKind,
    path: &Path,
    name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    validate_entry_name(name)?;
    if max_bytes == 0 || max_bytes > MAX_ENTRY_BYTES {
        return Err(ArchiveError::ReadLimitExceeded {
            name: name.to_string(),
            limit: MAX_ENTRY_BYTES,
        });
    }
    match kind {
        ArchiveKind::Rar => crate::rar_reader::read_entry_from_file(file, path, name, max_bytes),
        ArchiveKind::SevenZip => read_sevenz_entry_from_file(file, path, name, max_bytes),
    }
}

fn identify_kind(signature: &[u8], path: &Path) -> Result<ArchiveKind, ArchiveError> {
    if signature.starts_with(SEVEN_Z_SIGNATURE) {
        return Ok(ArchiveKind::SevenZip);
    }
    if signature.starts_with(RAR4_SIGNATURE) || signature.starts_with(RAR5_SIGNATURE) {
        return Ok(ArchiveKind::Rar);
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "rar" | "cbr") {
        return Err(ArchiveError::Corrupt(
            "副檔名是 RAR/CBR，但檔頭不是 RAR4/RAR5 signature".into(),
        ));
    }
    if matches!(extension.as_str(), "7z" | "cb7") {
        return Err(ArchiveError::Corrupt(
            "副檔名是 7z/CB7，但檔頭不是 7z signature".into(),
        ));
    }
    Err(ArchiveError::UnsupportedFormat(
        "僅支援 7z/CB7 與 RAR/CBR".into(),
    ))
}

fn list_entries_for_kind(
    path: &Path,
    kind: ArchiveKind,
) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    match kind {
        ArchiveKind::Rar => crate::rar_reader::list_entries(path),
        ArchiveKind::SevenZip => {
            let reader = open_sevenz(path)?;
            validate_sevenz_entries(&reader.archive().files)
        }
    }
}

fn read_entry_for_kind(
    path: &Path,
    kind: ArchiveKind,
    name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    validate_entry_name(name)?;
    if max_bytes == 0 || max_bytes > MAX_ENTRY_BYTES {
        return Err(ArchiveError::ReadLimitExceeded {
            name: name.to_string(),
            limit: MAX_ENTRY_BYTES,
        });
    }

    match kind {
        ArchiveKind::Rar => crate::rar_reader::read_entry(path, name, max_bytes),
        ArchiveKind::SevenZip => read_sevenz_entry(path, name, max_bytes),
    }
}

fn open_sevenz(path: &Path) -> Result<SevenZArchiveReader<File>, ArchiveError> {
    open_sevenz_from_file(File::open(path)?)
}

fn open_sevenz_from_file(file: File) -> Result<SevenZArchiveReader<File>, ArchiveError> {
    let mut reader = SevenZArchiveReader::new(file, Password::empty())
        .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
    reader.set_thread_count(1);
    Ok(reader)
}

fn validate_sevenz_entries(
    entries: &[sevenz_rust2::ArchiveEntry],
) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    if entries.len() > MAX_ENTRY_COUNT {
        return Err(ArchiveError::TooManyEntries {
            count: entries.len(),
            limit: MAX_ENTRY_COUNT,
        });
    }

    let mut names = HashSet::with_capacity(entries.len());
    let mut name_bytes = 0_usize;
    let mut total = 0_u64;
    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let validation_name = if entry.is_directory {
            entry.name.trim_end_matches('/')
        } else {
            &entry.name
        };
        validate_entry_name(validation_name)?;
        name_bytes = checked_name_bytes(name_bytes, entry.name.len())?;
        if !names.insert(entry.name.as_str()) {
            return Err(ArchiveError::Corrupt(format!(
                "entry 名稱重複：{}",
                entry.name
            )));
        }
        total = total
            .checked_add(entry.size)
            .ok_or(ArchiveError::ArchiveBomb {
                total: u64::MAX,
                limit: MAX_TOTAL_UNPACKED_BYTES,
            })?;
        if total > MAX_TOTAL_UNPACKED_BYTES {
            return Err(ArchiveError::ArchiveBomb {
                total,
                limit: MAX_TOTAL_UNPACKED_BYTES,
            });
        }
        result.push(ArchiveEntry {
            name: entry.name.clone(),
            size: entry.size,
            compressed_size: entry.compressed_size,
            is_directory: entry.is_directory,
        });
    }
    Ok(result)
}

fn read_sevenz_entry(path: &Path, name: &str, max_bytes: usize) -> Result<Vec<u8>, ArchiveError> {
    read_sevenz_entry_from_file(File::open(path)?, path, name, max_bytes)
}

fn read_sevenz_entry_from_file(
    file: File,
    _path: &Path,
    name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    let block_source = file.try_clone()?;
    let mut reader = open_sevenz_from_file(file)?;
    let entries = validate_sevenz_entries(&reader.archive().files)?;
    let target = entries
        .iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| ArchiveError::EntryNotFound(name.to_string()))?;
    if target.is_directory {
        return Err(ArchiveError::EntryIsDirectory(name.to_string()));
    }
    if target.size > max_bytes as u64 {
        return Err(ArchiveError::EntryTooLarge {
            name: name.to_string(),
            bytes: target.size,
            limit: max_bytes,
        });
    }

    if !reader.archive().is_solid {
        // Non-solid archives have independent blocks. `read_file` can seek to
        // the target block directly instead of decoding every preceding entry.
        let output = reader
            .read_file(name)
            .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
        return enforce_output_limit(name, output, max_bytes);
    }

    read_solid_sevenz_entry(&mut reader, block_source, name, max_bytes)
}

fn read_solid_sevenz_entry(
    reader: &mut SevenZArchiveReader<File>,
    mut source: File,
    name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    let target_file_index = reader
        .archive()
        .files
        .iter()
        .position(|entry| entry.name == name)
        .ok_or_else(|| ArchiveError::EntryNotFound(name.to_string()))?;
    let target_entry = &reader.archive().files[target_file_index];
    if !target_entry.has_stream {
        // Empty files have no data stream and therefore no block to decode.
        return Ok(Vec::new());
    }
    let block_index = reader
        .archive()
        .stream_map
        .file_block_index
        .get(target_file_index)
        .copied()
        .flatten()
        .ok_or_else(|| {
            ArchiveError::Corrupt(format!("entry {} 有資料流但沒有對應的 7z block", name))
        })?;

    // A solid archive only carries dictionary state within each compression
    // block. Decode the target block directly instead of ArchiveReader's
    // for_each_entries, which always starts at block zero. Entries before the
    // target in this block still need to be drained, but earlier blocks do not.
    let archive = reader.archive();
    let password = Password::empty();
    let decoder = BlockDecoder::new(1, block_index, archive, &password, &mut source);
    let target_name = name.to_string();
    let mut output = Vec::new();
    let completed_block = decoder
        .for_each_entries(&mut |entry, source| {
            if entry.name == target_name {
                source.take(max_bytes as u64 + 1).read_to_end(&mut output)?;
                if output.len() > max_bytes {
                    return Err(io::Error::other(format!(
                        "entry {} exceeds bounded read",
                        target_name
                    ))
                    .into());
                }
                return Ok(false);
            }

            // Solid 7z blocks require earlier entries to be consumed before the
            // target can be decoded. Drain them directly to sink, never to memory.
            io::copy(source, &mut io::sink())?;
            Ok(true)
        })
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("bounded read") {
                ArchiveError::ReadLimitExceeded {
                    name: name.to_string(),
                    limit: max_bytes,
                }
            } else {
                ArchiveError::Corrupt(message)
            }
        })?;
    if completed_block {
        return Err(ArchiveError::Corrupt(format!(
            "找不到 entry {} 對應的 7z block stream",
            name
        )));
    }
    Ok(output)
}

fn enforce_output_limit(
    name: &str,
    output: Vec<u8>,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    if output.len() > max_bytes {
        return Err(ArchiveError::ReadLimitExceeded {
            name: name.to_string(),
            limit: max_bytes,
        });
    }
    Ok(output)
}

fn validate_entry_name(name: &str) -> Result<(), ArchiveError> {
    if name.is_empty() || name.len() > MAX_ENTRY_NAME_BYTES || name.contains('\0') {
        return Err(ArchiveError::UnsafeEntryPath(name.to_string()));
    }
    if name.starts_with('/') || name.starts_with('\\') || name.contains('\\') {
        return Err(ArchiveError::UnsafeEntryPath(name.to_string()));
    }
    if name.chars().any(char::is_control) {
        return Err(ArchiveError::UnsafeEntryPath(name.to_string()));
    }
    for component in name.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(ArchiveError::UnsafeEntryPath(name.to_string()));
        }
    }
    Ok(())
}

fn checked_name_bytes(total: usize, additional: usize) -> Result<usize, ArchiveError> {
    let total = total
        .checked_add(additional)
        .ok_or(ArchiveError::ArchiveMetadataTooLarge {
            bytes: usize::MAX,
            limit: MAX_TOTAL_ENTRY_NAME_BYTES,
        })?;
    if total > MAX_TOTAL_ENTRY_NAME_BYTES {
        return Err(ArchiveError::ArchiveMetadataTooLarge {
            bytes: total,
            limit: MAX_TOTAL_ENTRY_NAME_BYTES,
        });
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_platform_absolute_names() {
        for name in [
            "../page.jpg",
            "/page.jpg",
            "chapter\\page.jpg",
            "chapter/../page.jpg",
        ] {
            assert!(matches!(
                validate_entry_name(name),
                Err(ArchiveError::UnsafeEntryPath(_))
            ));
        }
        assert!(validate_entry_name("chapter/page.jpg").is_ok());
    }

    #[test]
    fn recognizes_rar_signature() {
        let path = std::env::temp_dir().join(format!(
            "gai-archive-reader-rar-test-{}.cbr",
            std::process::id()
        ));
        std::fs::write(&path, RAR5_SIGNATURE).unwrap();
        let reader = ArchiveReader::open(&path).unwrap();
        assert_eq!(reader.kind(), ArchiveKind::Rar);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_zero_and_unbounded_reads() {
        let error = read_entry_for_kind(Path::new("ignored"), ArchiveKind::SevenZip, "page.jpg", 0)
            .unwrap_err();
        assert!(matches!(error, ArchiveError::ReadLimitExceeded { .. }));
    }

    #[test]
    fn enforces_output_limit_for_random_access_reads() {
        let output = enforce_output_limit("page.jpg", vec![1, 2, 3], 3).unwrap();
        assert_eq!(output, vec![1, 2, 3]);

        let error = enforce_output_limit("page.jpg", vec![1, 2, 3, 4], 3).unwrap_err();
        assert!(matches!(
            error,
            ArchiveError::ReadLimitExceeded {
                name,
                limit: 3
            } if name == "page.jpg"
        ));
    }
}
