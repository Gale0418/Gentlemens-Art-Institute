//! RAR/CBR backend backed by the vendored BSD-licensed libarchive fork.
//!
//! This module only reads archive data into bounded memory.  It never creates
//! files from entry names and rejects traversal, absolute, control-character,
//! duplicate, oversized, and excessive-entry archives.

use crate::archive_reader::{
    ArchiveEntry, ArchiveError, MAX_ARCHIVE_BYTES, MAX_ENTRY_BYTES, MAX_ENTRY_COUNT,
    MAX_TOTAL_ENTRY_NAME_BYTES, MAX_TOTAL_UNPACKED_BYTES,
};
#[cfg(windows)]
use libarchive2::CallbackReader;
use libarchive2::{FileType, ReadArchive};
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::io::AsRawFd;
use std::path::Path;

const MAX_ENTRY_NAME_BYTES: usize = 4096;
const INITIAL_OUTPUT_CAPACITY: usize = 64 * 1024;
// ENDARC is tiny in ordinary RAR5 files.  Keep the independent trailer scan
// bounded so a malformed archive cannot turn validation into a large search.
const MAX_RAR5_END_MARKER_BYTES: usize = 4096;
const RAR4_SIGNATURE: &[u8; 7] = b"Rar!\x1A\x07\x00";
const RAR5_SIGNATURE: &[u8; 8] = b"Rar!\x1A\x07\x01\x00";

#[derive(Debug)]
pub struct FirstImage {
    pub name: String,
    pub bytes: Vec<u8>,
}

// Field order is intentional: libarchive must be dropped before the file
// descriptor it borrows through archive_read_open_fd.
struct OpenedRar {
    archive: ReadArchive<'static>,
    file: File,
}

/// 列出 RAR/CBR entries 的 bounded metadata。
pub fn list_entries(path: &Path) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    let opened = File::open(path)?;
    list_entries_from_file(opened, path)
}

pub fn list_entries_from_file(
    file: File,
    path_hint: &Path,
) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    let mut opened = open_rar_file(file, path_hint)?;
    let mut names = HashSet::new();
    let mut result = Vec::new();
    let mut name_bytes = 0_usize;
    let mut total = 0_u64;

    let mut saw_entry = false;
    loop {
        let entry = match opened.archive.next_entry() {
            Ok(Some(entry)) => {
                saw_entry = true;
                entry
            }
            Ok(None) => break,
            Err(error) if saw_entry && is_verified_terminal_rar5(&opened.file, &error) => break,
            Err(error) => return Err(ArchiveError::Corrupt(error.to_string())),
        };
        if result.len() >= MAX_ENTRY_COUNT {
            return Err(ArchiveError::TooManyEntries {
                count: result.len() + 1,
                limit: MAX_ENTRY_COUNT,
            });
        }
        let name = entry
            .pathname()
            .ok_or_else(|| ArchiveError::Corrupt("RAR entry 缺少 pathname".into()))?;
        let is_directory = matches!(entry.file_type(), FileType::Directory);
        // libarchive preserves a directory's trailing `/`.  Validate the
        // canonical path while retaining the original archive name in the
        // returned metadata, matching the 7z reader's policy.
        let validation_name = if is_directory {
            name.trim_end_matches('/')
        } else {
            &name
        };
        validate_entry_name(validation_name)?;
        name_bytes = checked_name_bytes(name_bytes, name.len())?;
        if !names.insert(name.clone()) {
            return Err(ArchiveError::Corrupt(format!("entry 名稱重複：{name}")));
        }
        let size = non_negative_size(entry.size(), &name)?;
        total = total.checked_add(size).ok_or(ArchiveError::ArchiveBomb {
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
            name,
            size,
            // libarchive does not expose RAR's packed-size field through the
            // stable entry API; zero means "not reported", not zero bytes.
            compressed_size: 0,
            is_directory,
        });
        opened
            .archive
            .skip_data()
            .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
    }
    Ok(result)
}

/// 讀取 archive 實體順序中的第一個安全圖片，作為縮圖代表圖。
///
/// 這不是正式 reader 的 page 0：RAR/solid RAR 沒有可依賴的廉價隨機索引，
/// 在不讀完整 archive 的前提下無法證明自然排序後的最小名稱。封面因此只讀
/// 第一個可安全辨識且大小有界的圖片；若其前面出現非空非圖片 payload，直接放棄，
/// 避免為了找後續圖片而觸發大型 solid stream 或 Files provider materialization。
pub fn read_first_image_from_file(
    file: File,
    path_hint: &Path,
    max_bytes: usize,
) -> Result<FirstImage, ArchiveError> {
    if max_bytes == 0 || max_bytes > MAX_ENTRY_BYTES {
        return Err(ArchiveError::ReadLimitExceeded {
            name: "第一張圖片".into(),
            limit: MAX_ENTRY_BYTES,
        });
    }

    let mut opened = open_rar_file(file, path_hint)?;
    let mut names = HashSet::new();
    let mut name_bytes = 0_usize;
    let mut total = 0_u64;
    let mut saw_entry = false;

    loop {
        let entry = match opened.archive.next_entry() {
            Ok(Some(entry)) => {
                saw_entry = true;
                entry
            }
            Ok(None) => break,
            Err(error) if saw_entry && is_verified_terminal_rar5(&opened.file, &error) => break,
            Err(error) => return Err(ArchiveError::Corrupt(error.to_string())),
        };
        if names.len() >= MAX_ENTRY_COUNT {
            return Err(ArchiveError::TooManyEntries {
                count: names.len() + 1,
                limit: MAX_ENTRY_COUNT,
            });
        }

        let entry_name = entry
            .pathname()
            .ok_or_else(|| ArchiveError::Corrupt("RAR entry 缺少 pathname".into()))?;
        let is_directory = matches!(entry.file_type(), FileType::Directory);
        let validation_name = if is_directory {
            entry_name.trim_end_matches('/')
        } else {
            &entry_name
        };
        validate_entry_name(validation_name)?;
        name_bytes = checked_name_bytes(name_bytes, entry_name.len())?;
        if !names.insert(entry_name.clone()) {
            return Err(ArchiveError::Corrupt(format!(
                "entry 名稱重複：{entry_name}"
            )));
        }

        let size = non_negative_size(entry.size(), &entry_name)?;
        total = total.checked_add(size).ok_or(ArchiveError::ArchiveBomb {
            total: u64::MAX,
            limit: MAX_TOTAL_UNPACKED_BYTES,
        })?;
        if total > MAX_TOTAL_UNPACKED_BYTES {
            return Err(ArchiveError::ArchiveBomb {
                total,
                limit: MAX_TOTAL_UNPACKED_BYTES,
            });
        }

        match cover_entry_action(is_directory, size, &entry_name, max_bytes)? {
            CoverEntryAction::Read => {
                let bytes = read_entry_data(&mut opened.archive, &entry_name, size, max_bytes)?;
                return Ok(FirstImage {
                    name: entry_name,
                    bytes,
                });
            }
            // Empty metadata entries and directories do not carry a
            // compressed payload. They are safe to advance past before the
            // representative image, but no non-empty non-image is ever
            // skipped for a cover.
            CoverEntryAction::Skip => {
                opened
                    .archive
                    .skip_data()
                    .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
            }
        }
    }
    Err(ArchiveError::NoSupportedImages)
}

/// 讀取單一 RAR entry，最多配置 `max_bytes` bytes，不寫入檔案系統。
pub fn read_entry(path: &Path, name: &str, max_bytes: usize) -> Result<Vec<u8>, ArchiveError> {
    read_entry_from_file(File::open(path)?, path, name, max_bytes)
}

pub fn read_entry_from_file(
    file: File,
    path_hint: &Path,
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

    let mut opened = open_rar_file(file, path_hint)?;
    let mut names = HashSet::new();
    let mut name_bytes = 0_usize;
    let mut total = 0_u64;
    let mut saw_entry = false;
    loop {
        let entry = match opened.archive.next_entry() {
            Ok(Some(entry)) => {
                saw_entry = true;
                entry
            }
            Ok(None) => break,
            Err(error) if saw_entry && is_verified_terminal_rar5(&opened.file, &error) => break,
            Err(error) => return Err(ArchiveError::Corrupt(error.to_string())),
        };
        let entry_name = entry
            .pathname()
            .ok_or_else(|| ArchiveError::Corrupt("RAR entry 缺少 pathname".into()))?;
        let is_directory = matches!(entry.file_type(), FileType::Directory);
        let validation_name = if is_directory {
            entry_name.trim_end_matches('/')
        } else {
            &entry_name
        };
        validate_entry_name(validation_name)?;
        name_bytes = checked_name_bytes(name_bytes, entry_name.len())?;
        if names.len() >= MAX_ENTRY_COUNT {
            return Err(ArchiveError::TooManyEntries {
                count: names.len() + 1,
                limit: MAX_ENTRY_COUNT,
            });
        }
        if !names.insert(entry_name.clone()) {
            return Err(ArchiveError::Corrupt(format!(
                "entry 名稱重複：{entry_name}"
            )));
        }
        let size = non_negative_size(entry.size(), &entry_name)?;
        total = total.checked_add(size).ok_or(ArchiveError::ArchiveBomb {
            total: u64::MAX,
            limit: MAX_TOTAL_UNPACKED_BYTES,
        })?;
        if total > MAX_TOTAL_UNPACKED_BYTES {
            return Err(ArchiveError::ArchiveBomb {
                total,
                limit: MAX_TOTAL_UNPACKED_BYTES,
            });
        }
        if entry_name != name {
            opened
                .archive
                .skip_data()
                .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
            continue;
        }
        if is_directory {
            return Err(ArchiveError::EntryIsDirectory(name.to_string()));
        }
        if size > max_bytes as u64 {
            return Err(ArchiveError::EntryTooLarge {
                name: name.to_string(),
                bytes: size,
                limit: max_bytes,
            });
        }

        return read_entry_data(&mut opened.archive, name, size, max_bytes);
    }
    Err(ArchiveError::EntryNotFound(name.to_string()))
}

fn read_entry_data(
    archive: &mut ReadArchive<'static>,
    name: &str,
    size: u64,
    max_bytes: usize,
) -> Result<Vec<u8>, ArchiveError> {
    if size > max_bytes as u64 {
        return Err(ArchiveError::EntryTooLarge {
            name: name.to_string(),
            bytes: size,
            limit: max_bytes,
        });
    }

    let mut output = Vec::with_capacity((size as usize).min(INITIAL_OUTPUT_CAPACITY));
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = archive
            .read_data(&mut buffer)
            .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
        if read == 0 {
            break;
        }
        if output.len().saturating_add(read) > max_bytes {
            return Err(ArchiveError::ReadLimitExceeded {
                name: name.to_string(),
                limit: max_bytes,
            });
        }
        output.extend_from_slice(&buffer[..read]);
    }
    Ok(output)
}

fn open_rar_file(file: File, _path: &Path) -> Result<OpenedRar, ArchiveError> {
    let bytes = file.metadata()?.len();
    if bytes > MAX_ARCHIVE_BYTES {
        return Err(ArchiveError::ArchiveTooLarge {
            bytes,
            limit: MAX_ARCHIVE_BYTES,
        });
    }
    let mut file = file;
    let mut signature = [0_u8; 8];
    let read = file.read(&mut signature)?;
    file.seek(SeekFrom::Start(0))?;
    let is_rar = signature[..read].starts_with(RAR4_SIGNATURE)
        || signature[..read].starts_with(RAR5_SIGNATURE);
    if !is_rar {
        return Err(ArchiveError::UnsupportedFormat(
            "RAR/CBR 檔頭不是 RAR4/RAR5 signature".into(),
        ));
    }
    #[cfg(unix)]
    let archive = ReadArchive::open_fd(file.as_raw_fd())
        .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
    #[cfg(windows)]
    let (archive, file) = {
        let marker_file = file.try_clone()?;
        let archive = ReadArchive::open_callback(CallbackReader::new(file))
            .map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
        (archive, marker_file)
    };
    #[cfg(not(any(unix, windows)))]
    let archive =
        ReadArchive::open(_path).map_err(|error| ArchiveError::Corrupt(error.to_string()))?;
    Ok(OpenedRar { archive, file })
}

fn non_negative_size(size: i64, name: &str) -> Result<u64, ArchiveError> {
    u64::try_from(size).map_err(|_| ArchiveError::Corrupt(format!("entry {name} 大小無效")))
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

fn is_visible_supported_image(name: &str) -> bool {
    if name
        .split('/')
        .any(|part| part.starts_with('.') || part.eq_ignore_ascii_case("__MACOSX"))
    {
        return false;
    }
    let Some(extension) = Path::new(name).extension().and_then(|value| value.to_str()) else {
        return false;
    };
    crate::scanner::IMAGE_EXTENSIONS
        .iter()
        .any(|supported| supported[1..].eq_ignore_ascii_case(extension))
}

#[derive(Debug, PartialEq, Eq)]
enum CoverEntryAction {
    Skip,
    Read,
}

fn cover_entry_action(
    is_directory: bool,
    size: u64,
    name: &str,
    max_bytes: usize,
) -> Result<CoverEntryAction, ArchiveError> {
    if is_directory {
        if size > 0 {
            return Err(ArchiveError::Corrupt(format!(
                "目錄 entry 含有非空資料：{name}"
            )));
        }
        return Ok(CoverEntryAction::Skip);
    }
    if size == 0 {
        return Ok(CoverEntryAction::Skip);
    }
    if !is_visible_supported_image(name) {
        return Err(ArchiveError::NoSupportedImages);
    }
    if size > max_bytes as u64 {
        return Err(ArchiveError::EntryTooLarge {
            name: name.to_string(),
            bytes: size,
            limit: max_bytes,
        });
    }
    Ok(CoverEntryAction::Read)
}

/// libarchive 3.8.x has a RAR5 terminal-block bug (upstream issue #3352):
/// after returning all data it can report a fatal error with no errno/message
/// instead of `ARCHIVE_EOF`.  Only accept that exact opaque error when an
/// independently CRC-checked RAR5 ENDARC block is the final block in the file.
fn is_verified_terminal_rar5(file: &File, error: &libarchive2::Error) -> bool {
    if !matches!(
        error,
        libarchive2::Error::Archive {
            code: 0,
            message,
            ..
        } if message.starts_with("Unknown error")
    ) {
        return false;
    }
    has_valid_rar5_end_marker(file).unwrap_or(false)
}

fn has_valid_rar5_end_marker(source: &File) -> std::io::Result<bool> {
    let file_size = source.metadata()?.len();
    if file_size < 8 {
        return Ok(false);
    }
    let mut file = source.try_clone()?;
    file.seek(SeekFrom::Start(0))?;
    let mut signature = [0_u8; 8];
    file.read_exact(&mut signature)?;
    if signature != *RAR5_SIGNATURE {
        return Ok(false);
    }
    let window = (MAX_RAR5_END_MARKER_BYTES + 8).min(file_size as usize);
    file.seek(SeekFrom::End(-(window as i64)))?;
    let mut tail = vec![0_u8; window];
    file.read_exact(&mut tail)?;

    // The common RAR5 ENDARC marker has exactly three header bytes: type 5,
    // flags 4, and no optional data.  Check it first, then scan the bounded
    // final-header window for valid ENDARC variants.
    if tail.len() >= 8 && valid_rar5_end_candidate(&tail, tail.len() - 8) {
        return Ok(true);
    }
    for start in (0..tail.len().saturating_sub(7)).rev() {
        if valid_rar5_end_candidate(&tail, start) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn valid_rar5_end_candidate(bytes: &[u8], start: usize) -> bool {
    if start + 5 > bytes.len() {
        return false;
    }
    let expected_crc = u32::from_le_bytes([
        bytes[start],
        bytes[start + 1],
        bytes[start + 2],
        bytes[start + 3],
    ]);
    let (header_size, size_len) = match read_rar5_varint(bytes, start + 4) {
        Some(value) => value,
        None => return false,
    };
    if !(3..=MAX_RAR5_END_MARKER_BYTES).contains(&header_size) {
        return false;
    }
    let body_start = start + 4 + size_len;
    let end = match body_start.checked_add(header_size) {
        Some(end) if end == bytes.len() => end,
        _ => return false,
    };
    let (header_type, type_len) = match read_rar5_varint(bytes, body_start) {
        Some(value) => value,
        None => return false,
    };
    if header_type != 5 {
        return false;
    }
    let (flags, _) = match read_rar5_varint(bytes, body_start + type_len) {
        Some(value) => value,
        None => return false,
    };
    // An ENDARC data payload would mean the final bytes are not an ordinary
    // terminal marker.  Reject it rather than ignoring opaque bytes.
    if flags & 0x02 != 0 {
        return false;
    }
    rar_crc32(&bytes[start + 4..end]) == expected_crc
}

fn read_rar5_varint(bytes: &[u8], mut offset: usize) -> Option<(usize, usize)> {
    let start = offset;
    let mut value = 0_usize;
    let mut shift = 0_u32;
    loop {
        let byte = *bytes.get(offset)?;
        offset += 1;
        value = value.checked_add(((byte & 0x7f) as usize).checked_shl(shift)?)?;
        if byte & 0x80 == 0 {
            return Some((value, offset - start));
        }
        shift += 7;
        if shift >= usize::BITS {
            return None;
        }
    }
}

fn rar_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_libarchive_with_security_fix_release() {
        assert!(libarchive2::version_number() >= 3_008_009);
        assert!(libarchive2::version().starts_with("libarchive 3.8.9"));
    }

    #[test]
    fn rejects_unsafe_entry_names() {
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
    }

    #[test]
    fn validates_rar5_end_marker_crc() {
        let body = [0x05_u8, 0x04, 0x00];
        let mut marker = Vec::from(0x5156_771d_u32.to_le_bytes());
        marker.push(0x03);
        marker.extend_from_slice(&body);
        assert!(valid_rar5_end_candidate(&marker, 0));

        *marker.last_mut().expect("marker has body") ^= 1;
        assert!(!valid_rar5_end_candidate(&marker, 0));
    }

    #[test]
    fn rar5_end_marker_is_verified_with_source_positioned_at_eof() {
        let path = std::env::temp_dir().join(format!(
            "gai-rar5-eof-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut bytes = RAR5_SIGNATURE.to_vec();
        bytes.extend_from_slice(&0x5156_771d_u32.to_le_bytes());
        bytes.extend_from_slice(&[0x03, 0x05, 0x04, 0x00]);
        std::fs::write(&path, bytes).unwrap();
        let mut file = File::open(&path).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        assert!(has_valid_rar5_end_marker(&file).unwrap());
        assert!(has_valid_rar5_end_marker(&file).unwrap());
        drop(file);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cover_candidates_keep_visibility_and_extension_rules() {
        assert!(is_visible_supported_image("chapter/2.jpg"));
        assert!(is_visible_supported_image("chapter/2.PNG"));
        assert!(!is_visible_supported_image("chapter/.cover.jpg"));
        assert!(!is_visible_supported_image("__MACOSX/cover.jpg"));
        assert!(!is_visible_supported_image("chapter/2.bmp"));
    }

    #[test]
    fn cover_uses_archive_order_as_thumbnail_only() {
        let archive_order = ["10.jpg", "2.jpg"];
        assert_eq!(
            archive_order.iter().find(
                |name| cover_entry_action(false, 1, name, 8).unwrap() == CoverEntryAction::Read
            ),
            Some(&"10.jpg")
        );
        let mut formal_page_order = archive_order;
        formal_page_order.sort_by(|a, b| natord::compare(a, b).then_with(|| a.cmp(b)));
        assert_eq!(formal_page_order, ["2.jpg", "10.jpg"]);
    }

    #[test]
    fn cover_rejects_nonempty_prefix_without_scanning_later_entries() {
        assert!(matches!(
            cover_entry_action(false, 1, "notes.txt", 8),
            Err(ArchiveError::NoSupportedImages)
        ));
        assert!(matches!(
            cover_entry_action(false, 1, "1.jpg", 8),
            Ok(CoverEntryAction::Read)
        ));
    }

    #[test]
    fn cover_rejects_oversized_first_image_without_trying_later_images() {
        assert!(matches!(
            cover_entry_action(false, 9, "1.jpg", 8),
            Err(ArchiveError::EntryTooLarge {
                name,
                bytes: 9,
                limit: 8
            }) if name == "1.jpg"
        ));
        assert!(matches!(
            cover_entry_action(false, 1, "2.jpg", 8),
            Ok(CoverEntryAction::Read)
        ));
        assert!(matches!(
            cover_entry_action(true, 1, "pages/", 8),
            Err(ArchiveError::Corrupt(_))
        ));
    }

    #[test]
    fn first_image_rejects_invalid_read_budget_before_opening() {
        let error = read_first_image_from_file(
            File::open(std::env::current_exe().unwrap()).unwrap(),
            Path::new("archive.rar"),
            0,
        )
        .unwrap_err();
        assert!(matches!(error, ArchiveError::ReadLimitExceeded { .. }));
    }

    // Opt-in fixture: do not download automatically.  The synthetic archive was
    // introduced by upstream commit 7c685cd, reduced by 9385e4b, and finalized
    // in 6d0ee5a:
    // https://github.com/libarchive/libarchive/commit/6d0ee5a868d4428e419a2ec3fb41bc24ae37a69d
    // https://raw.githubusercontent.com/libarchive/libarchive/6d0ee5a868d4428e419a2ec3fb41bc24ae37a69d/libarchive/test/test_read_format_rar5_last_block.rar.uu
    // Decoded RAR SHA-256: 6d4abc7d924c06ec1c8bcc1d6f9f0ebe27585f8e8d2f8f30d09844ba95a8cb0b
    #[test]
    #[ignore = "requires a locally acquired upstream RAR5 final-block fixture"]
    fn rar5_final_block_fixture_reads_complete_entry_and_crc() {
        let path = std::env::var_os("GAI_RAR5_FINAL_BLOCK_FIXTURE")
            .map(std::path::PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| {
                panic!(
                    "GAI_RAR5_FINAL_BLOCK_FIXTURE must point to a locally acquired test_read_format_rar5_last_block.rar"
                )
            });
        let bytes = read_entry(&path, "synthetic_payload.bin", 16_635)
            .unwrap_or_else(|error| panic!("failed to read {path:?}: {error:?}"));
        assert_eq!(bytes.len(), 16_635);
        assert_eq!(rar_crc32(&bytes), 0x7a5e_9eaf);
    }

    // This test must run under an outer deadline: before the RAR5 truncation
    // guard, libarchive can retry an ARCHIVE_OK/zero-byte read indefinitely.
    #[test]
    #[ignore = "requires a locally acquired upstream RAR5 final-block fixture"]
    fn rar5_truncated_final_block_is_rejected() {
        let source = std::env::var_os("GAI_RAR5_FINAL_BLOCK_FIXTURE")
            .map(std::path::PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| {
                panic!(
                    "GAI_RAR5_FINAL_BLOCK_FIXTURE must point to a locally acquired test_read_format_rar5_last_block.rar"
                )
            });
        let mut truncated = std::fs::read(&source)
            .unwrap_or_else(|error| panic!("failed to read {source:?}: {error}"));
        assert!(truncated.len() >= 16_500);
        truncated.truncate(16_500);
        let path = std::env::temp_dir().join(format!(
            "gai-rar5-truncated-final-block-{}-{}.rar",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, truncated).unwrap();
        let result = read_entry(&path, "synthetic_payload.bin", 16_635);
        let _ = std::fs::remove_file(&path);

        match result {
            Err(ArchiveError::Corrupt(message)) => {
                assert!(
                    message.contains("Truncated RAR5 entry data"),
                    "unexpected corruption error: {message}"
                );
            }
            Err(error) => panic!("unexpected archive error: {error:?}"),
            Ok(bytes) => panic!("truncated RAR5 entry was accepted as {} bytes", bytes.len()),
        }
    }

    #[test]
    fn rar5_stored_fixture_reads_expected_entry() {
        let encoded = include_str!(
            "../vendor/libarchive2-sys/libarchive/libarchive/test/test_read_format_rar5_stored.rar.uu"
        );
        let path = std::env::temp_dir().join(format!(
            "gai-rar5-stored-{}-{}.rar",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, decode_uu_fixture(encoded)).unwrap();

        let result = read_entry(&path, "helloworld.txt", 64);
        let _ = std::fs::remove_file(&path);
        let bytes = result.expect("RAR5 stored fixture should be readable");
        assert_eq!(bytes, b"hello libarchive test suite!\n");
    }

    #[test]
    fn rar5_crc32_flag_with_zero_value_is_rejected() {
        let payload = b"hello libarchive test suite!\n";
        assert_ne!(rar_crc32(payload), 0);

        let encoded = include_str!(
            "../vendor/libarchive2-sys/libarchive/libarchive/test/test_read_format_rar5_stored.rar.uu"
        );
        let mut archive = decode_uu_fixture(encoded);
        rewrite_rar5_file_crc_to_zero(&mut archive);
        let path = std::env::temp_dir().join(format!(
            "gai-rar5-zero-crc-{}-{}.rar",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, archive).unwrap();

        let result = read_entry(&path, "helloworld.txt", payload.len());
        let _ = std::fs::remove_file(&path);
        match result {
            Err(ArchiveError::Corrupt(message)) => {
                assert!(
                    message.contains("Checksum error: CRC32"),
                    "unexpected corruption error: {message}"
                );
            }
            Err(error) => panic!("unexpected archive error: {error:?}"),
            Ok(bytes) => panic!(
                "RAR5 entry with zero CRC was accepted as {} bytes",
                bytes.len()
            ),
        }
    }

    #[test]
    fn real_rar_fixture_is_walked_without_finding_unsupported_images() {
        let encoded = include_str!("../vendor/libarchive2-sys/libarchive/libarchive/test/test_read_format_rar5_multiple_files.rar.uu");
        let path = std::env::temp_dir().join(format!(
            "gai-rar-cover-fixture-{}-{}.rar",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, decode_uu_fixture(encoded)).unwrap();
        let result =
            read_first_image_from_file(File::open(&path).unwrap(), &path, 64 * 1024 * 1024);
        let _ = std::fs::remove_file(path);
        assert!(matches!(result, Err(ArchiveError::NoSupportedImages)));
    }

    fn decode_uu_fixture(encoded: &str) -> Vec<u8> {
        let mut output = Vec::new();
        for line in encoded.lines() {
            if line.starts_with("begin ") || line == "end" || line.is_empty() {
                continue;
            }
            let bytes = line.as_bytes();
            let expected = (bytes[0].wrapping_sub(b' ') & 0x3f) as usize;
            let mut decoded = Vec::with_capacity(expected);
            for chunk in bytes[1..].chunks(4) {
                let mut values = [0_u8; 4];
                for (index, value) in chunk.iter().enumerate() {
                    values[index] = value.wrapping_sub(b' ') & 0x3f;
                }
                decoded.extend_from_slice(&[
                    (values[0] << 2) | (values[1] >> 4),
                    (values[1] << 4) | (values[2] >> 2),
                    (values[2] << 6) | values[3],
                ]);
            }
            output.extend_from_slice(&decoded[..expected.min(decoded.len())]);
        }
        output
    }

    fn rewrite_rar5_file_crc_to_zero(bytes: &mut [u8]) {
        let mut block_start = 8;
        while block_start + 5 <= bytes.len() {
            let (header_size, size_len) =
                read_rar5_varint(bytes, block_start + 4).expect("RAR5 block header size");
            let body_start = block_start + 4 + size_len;
            let header_end = body_start + header_size;
            assert!(
                header_end <= bytes.len(),
                "RAR5 block header exceeds fixture"
            );
            let (header_type, type_len) =
                read_rar5_varint(bytes, body_start).expect("RAR5 block type");
            let (header_flags, flags_len) =
                read_rar5_varint(bytes, body_start + type_len).expect("RAR5 block flags");
            let mut cursor = body_start + type_len + flags_len;
            if header_flags & 0x01 != 0 {
                let (_, field_len) = read_rar5_varint(bytes, cursor).expect("RAR5 extra-data size");
                cursor += field_len;
            }
            let data_size = if header_flags & 0x02 != 0 {
                let (size, field_len) = read_rar5_varint(bytes, cursor).expect("RAR5 data size");
                cursor += field_len;
                size
            } else {
                0
            };

            if header_type == 2 {
                let (file_flags, field_len) =
                    read_rar5_varint(bytes, cursor).expect("RAR5 file flags");
                cursor += field_len;
                let (_, field_len) = read_rar5_varint(bytes, cursor).expect("RAR5 unpacked size");
                cursor += field_len;
                let (_, field_len) = read_rar5_varint(bytes, cursor).expect("RAR5 file attributes");
                cursor += field_len;
                if file_flags & 0x02 != 0 {
                    cursor += 4;
                }
                if file_flags & 0x04 != 0 {
                    assert!(cursor + 4 <= header_end, "RAR5 CRC exceeds file header");
                    bytes[cursor..cursor + 4].fill(0);
                    let header_crc = rar_crc32(&bytes[block_start + 4..header_end]);
                    bytes[block_start..block_start + 4].copy_from_slice(&header_crc.to_le_bytes());
                    return;
                }
            }

            block_start = header_end + data_size;
        }
        panic!("stored RAR5 fixture has no FILE_CRC32 field");
    }
}
