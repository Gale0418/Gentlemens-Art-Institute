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

        let mut output = Vec::with_capacity((size as usize).min(INITIAL_OUTPUT_CAPACITY));
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = opened
                .archive
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
        return Ok(output);
    }
    Err(ArchiveError::EntryNotFound(name.to_string()))
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
}
