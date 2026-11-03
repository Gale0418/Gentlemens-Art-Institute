//! Bounded RAR5 QuickOpen metadata indexing.
//!
//! QuickOpen is only an optimisation for the metadata pass.  The copied
//! headers are checked against the same authorised descriptor before they are
//! returned to callers; decompression is still performed by `rar_reader`.
//! Any format feature this small parser cannot prove safe is reported as
//! `None`, allowing the existing libarchive path to remain authoritative.

use crate::archive_reader::{
    ArchiveEntry, MAX_ARCHIVE_BYTES, MAX_ENTRY_COUNT, MAX_TOTAL_ENTRY_NAME_BYTES,
    MAX_TOTAL_UNPACKED_BYTES,
};
use crate::state::SourceRevision;
use std::collections::HashSet;
use std::fs::File;
use std::io;
#[cfg(not(any(unix, windows)))]
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::FileExt;
#[cfg(windows)]
use std::os::windows::fs::FileExt;
use std::path::Path;

const RAR5_SIGNATURE: &[u8; 8] = b"Rar!\x1A\x07\x01\x00";
const MAX_HEADER_BYTES: usize = 2 * 1024 * 1024;
// A QO record is metadata only.  Keep its aggregate allocation bounded even
// though the archive itself may be much larger.
const MAX_QO_DATA_BYTES: usize = MAX_TOTAL_ENTRY_NAME_BYTES;

const HFL_EXTRA_DATA: u64 = 0x01;
const HFL_DATA: u64 = 0x02;
const HFL_SPLIT_BEFORE: u64 = 0x08;
const HFL_SPLIT_AFTER: u64 = 0x10;
const HFL_KNOWN: u64 = 0x7f;
const MAIN_VOLUME: u64 = 0x01;
const MAIN_VOLUME_NUMBER: u64 = 0x02;
const MAIN_KNOWN: u64 = 0x1f;
const FILE_DIRECTORY: u64 = 0x01;
const FILE_UTIME: u64 = 0x02;
const FILE_CRC32: u64 = 0x04;
const FILE_UNKNOWN_SIZE: u64 = 0x08;
const FILE_KNOWN: u64 = 0x0f;
const FILE_ATTR_DIRECTORY: u64 = 0x10;
const HOST_WINDOWS: u64 = 0;
const HOST_UNIX: u64 = 1;
const UNIX_FILE_TYPE_MASK: u64 = 0o170000;
const UNIX_FILE_TYPE_REGULAR: u64 = 0o100000;
const UNIX_FILE_TYPE_DIRECTORY: u64 = 0o040000;
const EXTRA_ENCRYPTION: u64 = 0x01;
// libarchive gives these fields observable semantics instead of treating them
// as inert metadata: EX_VERSION changes the exposed pathname and EX_REDIR can
// turn a file into a link (and suppress its size).  QuickOpen only copies the
// file header, so it must defer both cases to the authoritative parser.
const EXTRA_VERSION: u64 = 0x04;
const EXTRA_REDIR: u64 = 0x05;

#[derive(Debug)]
struct BoundedReader {
    file: File,
    len: u64,
}

impl BoundedReader {
    fn new(file: File) -> io::Result<Self> {
        let len = file.metadata()?.len();
        Ok(Self { file, len })
    }

    fn read_range(&mut self, offset: u64, length: usize) -> io::Result<Option<Vec<u8>>> {
        if length > MAX_HEADER_BYTES.saturating_add(MAX_QO_DATA_BYTES) {
            return Ok(None);
        }
        match offset.checked_add(length as u64) {
            Some(end) if end <= self.len => {}
            _ => return Ok(None),
        }
        let mut bytes = vec![0_u8; length];
        #[cfg(unix)]
        {
            let mut read = 0usize;
            while read < length {
                let count = self
                    .file
                    .read_at(&mut bytes[read..], offset + read as u64)?;
                if count == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "RAR5 QuickOpen descriptor ended early",
                    ));
                }
                read += count;
            }
        }
        #[cfg(windows)]
        {
            let mut read = 0usize;
            while read < length {
                let count = self
                    .file
                    .seek_read(&mut bytes[read..], offset + read as u64)?;
                if count == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "RAR5 QuickOpen descriptor ended early",
                    ));
                }
                read += count;
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            self.file.seek(SeekFrom::Start(offset))?;
            self.file.read_exact(&mut bytes)?;
        }
        Ok(Some(bytes))
    }

    fn read_header(&mut self, offset: u64) -> io::Result<Option<Vec<u8>>> {
        let prefix_len = usize::try_from(self.len.saturating_sub(offset))
            .ok()
            .map(|length| length.min(14))
            .filter(|length| *length >= 5);
        let Some(prefix_len) = prefix_len else {
            return Ok(None);
        };
        let Some(prefix) = self.read_range(offset, prefix_len)? else {
            return Ok(None);
        };
        let Some((raw_size, size_len)) = read_vint(&prefix, 4) else {
            return Ok(None);
        };
        let Ok(raw_size) = usize::try_from(raw_size) else {
            return Ok(None);
        };
        if !(3..=MAX_HEADER_BYTES).contains(&raw_size) {
            return Ok(None);
        }
        let Some(total) = 4usize
            .checked_add(size_len)
            .and_then(|value| value.checked_add(raw_size))
        else {
            return Ok(None);
        };
        self.read_range(offset, total)
    }
}

#[derive(Debug, Clone)]
struct ParsedHeader {
    header_len: usize,
    header_type: u64,
    block_flags: u64,
    data_size: u64,
    unpacked_size: u64,
    is_directory: bool,
    name: String,
    compression_method: u64,
}

/// Try to list RAR5 entries from QuickOpen using only an already-authorised
/// descriptor. `Ok(None)` deliberately means "fall back to libarchive" for
/// missing, partial, stale, malformed, or unsupported QuickOpen data.
pub(crate) fn list_entries_from_file(
    source: &File,
    _path_hint: &Path,
) -> io::Result<Option<Vec<ArchiveEntry>>> {
    // `seek_read` on Windows is documented to update the shared file cursor.
    // The descriptor is also retained for the authoritative fallback, so a
    // Windows QuickOpen probe could otherwise perturb the caller's position.
    // Defer there until a truly positional API is available; Unix FileExt
    // reads remain cursor-independent and keep the fast path.
    #[cfg(windows)]
    {
        let _ = source;
        return Ok(None);
    }

    let before = SourceRevision::from_std_metadata(&source.metadata()?);
    if before.len > MAX_ARCHIVE_BYTES {
        return Ok(None);
    }
    let mut reader = BoundedReader::new(source.try_clone()?)?;
    let Some(signature) = reader.read_range(0, RAR5_SIGNATURE.len())? else {
        return Ok(None);
    };
    if signature.as_slice() != RAR5_SIGNATURE {
        return Ok(None);
    }
    let Some(main) = reader.read_header(8)? else {
        return Ok(None);
    };
    let Some((main_end, q_offset, recovery_offset)) = parse_main_header(&main, reader.len) else {
        return Ok(None);
    };
    let Some(q_position) = 8_u64.checked_add(q_offset) else {
        return Ok(None);
    };
    if q_position < main_end || q_position >= reader.len {
        return Ok(None);
    }
    let Some(qo_header) = reader.read_header(q_position)? else {
        return Ok(None);
    };
    let Some(qo) = parse_qo_header(&qo_header) else {
        return Ok(None);
    };
    let Some(qo_data_start) = q_position.checked_add(qo_header.len() as u64) else {
        return Ok(None);
    };
    let Some(qo_data_end) = qo_data_start.checked_add(qo.data_size) else {
        return Ok(None);
    };
    if qo.data_size == 0 || qo.data_size > MAX_QO_DATA_BYTES as u64 || qo_data_end > reader.len {
        return Ok(None);
    }
    let Ok(qo_data_size) = usize::try_from(qo.data_size) else {
        return Ok(None);
    };
    let Some(qo_data) = reader.read_range(qo_data_start, qo_data_size)? else {
        return Ok(None);
    };
    let file_len = reader.len;
    if !verify_qo_trailer(&mut reader, qo_data_end, recovery_offset, file_len)? {
        return Ok(None);
    }
    let Some(cached) = parse_qo_records(&qo_data, q_position, main_end, reader.len) else {
        return Ok(None);
    };

    // A valid QO CRC proves only the copied bytes. Compare each copied header
    // with the same descriptor before exposing names to the UI. This also
    // prevents a stale cache from changing the page order or target name.
    for record in &cached {
        let Some(actual) = reader.read_header(record.source_offset)? else {
            return Ok(None);
        };
        if actual != record.header {
            return Ok(None);
        }
        if parse_entry_header(&actual).is_none() {
            return Ok(None);
        }
    }

    let after = SourceRevision::from_std_metadata(&source.metadata()?);
    if before != after {
        return Ok(None);
    }
    Ok(Some(
        cached.into_iter().map(|record| record.entry).collect(),
    ))
}

#[derive(Debug)]
struct QuickOpenHeader {
    data_size: u64,
}

#[derive(Debug)]
struct CachedRecord {
    source_offset: u64,
    header: Vec<u8>,
    packed_size: u64,
    entry: ArchiveEntry,
}

fn parse_main_header(bytes: &[u8], file_len: u64) -> Option<(u64, u64, Option<u64>)> {
    let parsed = parse_common_header(bytes)?;
    if parsed.header_type != 1 || parsed.block_flags & !MAIN_KNOWN != 0 {
        return None;
    }
    let mut pos = 4 + read_vint(bytes, 4)?.1;
    pos = read_vint_at(bytes, pos)?.1; // header type
    let flags = read_vint_at(bytes, pos)?;
    pos = flags.1;
    if flags.0 & !HFL_KNOWN != 0 || flags.0 & HFL_DATA != 0 {
        return None;
    }
    let extra_len = read_vint_at(bytes, pos)?;
    pos = extra_len.1;
    let archive_flags = read_vint_at(bytes, pos)?;
    pos = archive_flags.1;
    if archive_flags.0 & !MAIN_KNOWN != 0
        || archive_flags.0 & (MAIN_VOLUME | MAIN_VOLUME_NUMBER) != 0
    {
        return None;
    }
    let extra_end = pos.checked_add(usize::try_from(extra_len.0).ok()?)?;
    if extra_end != bytes.len() || extra_len.0 == 0 {
        return None;
    }
    let _field_size = read_vint_at(bytes, pos)?;
    pos = _field_size.1;
    let field_id = read_vint_at(bytes, pos)?;
    pos = field_id.1;
    if field_id.0 != 1 {
        return None;
    }
    let locator_flags = read_vint_at(bytes, pos)?;
    pos = locator_flags.1;
    if locator_flags.0 & !0x03 != 0 || locator_flags.0 & 0x01 == 0 {
        return None;
    }
    let q_offset = read_vint_at(bytes, pos)?;
    pos = q_offset.1;
    if q_offset.0 == 0 {
        return None;
    }
    let recovery_offset = if locator_flags.0 & 0x02 != 0 {
        let value = read_vint_at(bytes, pos)?;
        pos = value.1;
        (value.0 != 0).then_some(value.0)
    } else {
        None
    };
    if locator_flags.0 & 0x02 != 0 && recovery_offset.is_none() {
        return None;
    }
    if pos != extra_end || 8_u64.checked_add(q_offset.0)? >= file_len {
        return None;
    }
    Some((
        8_u64.checked_add(parsed.header_len as u64)?,
        q_offset.0,
        recovery_offset,
    ))
}

fn verify_qo_trailer(
    reader: &mut BoundedReader,
    qo_data_end: u64,
    recovery_offset: Option<u64>,
    file_len: u64,
) -> io::Result<bool> {
    let mut next = qo_data_end;
    if let Some(recovery_offset) = recovery_offset {
        let Some(recovery_position) = 8_u64.checked_add(recovery_offset) else {
            return Ok(false);
        };
        if recovery_position != qo_data_end {
            return Ok(false);
        }
        let Some(recovery) = reader.read_header(recovery_position)? else {
            return Ok(false);
        };
        let Some(parsed) = parse_entry_header(&recovery) else {
            return Ok(false);
        };
        if parsed.header_type != 3 || parsed.name != "RR" || parsed.compression_method != 0 {
            return Ok(false);
        }
        next = match recovery_position
            .checked_add(recovery.len() as u64)
            .and_then(|value| value.checked_add(parsed.data_size))
        {
            Some(next) if next <= file_len => next,
            _ => return Ok(false),
        };
    }
    let Some(end) = reader.read_header(next)? else {
        return Ok(false);
    };
    let Some(parsed) = parse_common_header(&end) else {
        return Ok(false);
    };
    if parsed.header_type != 5 || parsed.block_flags & HFL_DATA != 0 {
        return Ok(false);
    }
    Ok(next
        .checked_add(end.len() as u64)
        .is_some_and(|end| end <= file_len))
}

fn parse_qo_header(bytes: &[u8]) -> Option<QuickOpenHeader> {
    let parsed = parse_entry_header(bytes)?;
    if parsed.header_type != 3
        || parsed.name != "QO"
        || parsed.compression_method != 0
        || parsed.is_directory
        || parsed.data_size != parsed.unpacked_size
    {
        return None;
    }
    Some(QuickOpenHeader {
        data_size: parsed.data_size,
    })
}

fn parse_qo_records(
    bytes: &[u8],
    qo_position: u64,
    main_end: u64,
    file_len: u64,
) -> Option<Vec<CachedRecord>> {
    let mut records: Vec<CachedRecord> = Vec::new();
    let mut pos = 0usize;
    let mut previous_source = None;
    let mut names = HashSet::new();
    let mut name_bytes = 0usize;
    let mut total_unpacked = 0u64;
    while pos < bytes.len() {
        let structure_start = pos;
        let saved_crc = read_u32(bytes, &mut pos)?;
        let structure_size = read_vint_at(bytes, pos)?;
        pos = structure_size.1;
        let structure_size = usize::try_from(structure_size.0).ok()?;
        let structure_end = pos.checked_add(structure_size)?;
        if structure_end > bytes.len() || structure_size > MAX_HEADER_BYTES {
            return None;
        }
        let flags = read_vint_at(bytes, pos)?;
        pos = flags.1;
        if flags.0 != 0 {
            return None;
        }
        let offset = read_vint_at(bytes, pos)?;
        pos = offset.1;
        let header_size = read_vint_at(bytes, pos)?;
        pos = header_size.1;
        let header_size = usize::try_from(header_size.0).ok()?;
        let header_end = pos.checked_add(header_size)?;
        if header_end != structure_end || header_size == 0 {
            return None;
        }
        if rar_crc32(&bytes[structure_start + 4..structure_end]) != saved_crc {
            return None;
        }
        let header = bytes[pos..header_end].to_vec();
        pos = structure_end;
        let parsed = parse_entry_header(&header)?;
        // The existing libarchive index exposes only FILE blocks as page
        // candidates. A service block named `*.jpg` would otherwise be a
        // semantic mismatch, so such archives safely use the old parser.
        if parsed.header_type != 2 {
            return None;
        }
        if header_size != parsed.header_len {
            return None;
        }
        let source_offset = qo_position.checked_sub(offset.0)?;
        if source_offset < main_end || source_offset >= file_len {
            return None;
        }
        if previous_source.is_some_and(|previous| source_offset <= previous) {
            return None;
        }
        if records.len() >= MAX_ENTRY_COUNT {
            return None;
        }
        validate_name(&parsed.name)?;
        name_bytes = name_bytes.checked_add(parsed.name.len())?;
        if name_bytes > MAX_TOTAL_ENTRY_NAME_BYTES {
            return None;
        }
        if !names.insert(parsed.name.clone()) {
            return None;
        }
        total_unpacked = total_unpacked.checked_add(parsed.unpacked_size)?;
        if total_unpacked > MAX_TOTAL_UNPACKED_BYTES {
            return None;
        }
        let next = source_offset
            .checked_add(header_size as u64)
            .and_then(|value| value.checked_add(parsed.data_size))?;
        if next > file_len {
            return None;
        }
        if let Some(previous) = records.last() {
            let expected = previous
                .source_offset
                .checked_add(previous.header.len() as u64)
                .and_then(|value| value.checked_add(previous.packed_size))?;
            if expected != source_offset {
                return None;
            }
        } else if source_offset != main_end {
            return None;
        }
        previous_source = Some(source_offset);
        records.push(CachedRecord {
            source_offset,
            header,
            packed_size: parsed.data_size,
            entry: ArchiveEntry {
                name: parsed.name,
                size: parsed.unpacked_size,
                compressed_size: 0,
                is_directory: parsed.is_directory,
            },
        });
    }
    let last = records.last()?;
    let end = last
        .source_offset
        .checked_add(last.header.len() as u64)
        .and_then(|value| value.checked_add(last.packed_size))?;
    (end == qo_position).then_some(records)
}

fn parse_common_header(bytes: &[u8]) -> Option<ParsedHeader> {
    if bytes.len() < 8 {
        return None;
    }
    let (_, size_len) = read_vint(bytes, 4)?;
    let (_, _, full) = {
        let (raw, size_len) = read_vint(bytes, 4)?;
        (
            raw,
            size_len,
            4usize
                .checked_add(size_len)?
                .checked_add(usize::try_from(raw).ok()?)?,
        )
    };
    if full != bytes.len() || rar_crc32(&bytes[4..]) != read_u32_at(bytes, 0)? {
        return None;
    }
    let mut pos = 4 + size_len;
    let header_type = read_vint_at(bytes, pos)?;
    pos = header_type.1;
    let block_flags = read_vint_at(bytes, pos)?;
    Some(ParsedHeader {
        header_len: full,
        header_type: header_type.0,
        block_flags: block_flags.0,
        data_size: 0,
        unpacked_size: 0,
        is_directory: false,
        name: String::new(),
        compression_method: 0,
    })
}

fn parse_entry_header(bytes: &[u8]) -> Option<ParsedHeader> {
    let common = parse_common_header(bytes)?;
    if common.block_flags & !HFL_KNOWN != 0
        || common.block_flags & (HFL_SPLIT_BEFORE | HFL_SPLIT_AFTER) != 0
    {
        return None;
    }
    let size_len = read_vint(bytes, 4)?.1;
    let mut pos = 4 + size_len;
    let header_type = read_vint_at(bytes, pos)?;
    pos = header_type.1;
    let block_flags = read_vint_at(bytes, pos)?;
    pos = block_flags.1;
    let extra_size = if block_flags.0 & HFL_EXTRA_DATA != 0 {
        let value = read_vint_at(bytes, pos)?;
        pos = value.1;
        usize::try_from(value.0).ok()?
    } else {
        0
    };
    let data_size = if block_flags.0 & HFL_DATA != 0 {
        let value = read_vint_at(bytes, pos)?;
        pos = value.1;
        value.0
    } else {
        0
    };
    let file_flags = read_vint_at(bytes, pos)?;
    pos = file_flags.1;
    if file_flags.0 & !FILE_KNOWN != 0 || file_flags.0 & FILE_UNKNOWN_SIZE != 0 {
        return None;
    }
    let unpacked_size = read_vint_at(bytes, pos)?;
    pos = unpacked_size.1;
    let file_attr = read_vint_at(bytes, pos)?;
    pos = file_attr.1;
    if file_flags.0 & FILE_UTIME != 0 {
        pos = pos.checked_add(4)?;
    }
    if file_flags.0 & FILE_CRC32 != 0 {
        pos = pos.checked_add(4)?;
    }
    let compression = read_vint_at(bytes, pos)?;
    pos = compression.1;
    let version = compression.0 & 0x3f;
    let dictionary = (compression.0 >> 10) & 0x0f;
    // Keep the fast path within the version-0/dictionary range supported by
    // the vendored decoder. Unknown extension bits safely use the fallback.
    if version != 0 || dictionary > 9 || compression.0 & 0xffff_0000 != 0 {
        return None;
    }
    let method = (compression.0 >> 7) & 0x07;
    if method > 5 {
        return None;
    }
    let host = read_vint_at(bytes, pos)?;
    pos = host.1;
    if host.0 > HOST_UNIX {
        return None;
    }
    let name_size = read_vint_at(bytes, pos)?;
    pos = name_size.1;
    let name_end = pos.checked_add(usize::try_from(name_size.0).ok()?)?;
    let name = String::from_utf8(bytes.get(pos..name_end)?.to_vec()).ok()?;
    pos = name_end;
    let extra_end = pos.checked_add(extra_size)?;
    if extra_end != bytes.len() || !validate_extra_area(bytes.get(pos..extra_end)?) {
        return None;
    }
    let is_directory = file_flags.0 & FILE_DIRECTORY != 0;
    // libarchive derives the exposed file type from the host-specific
    // attributes, independently of FILE_DIRECTORY.  A QO record only carries
    // the copied header, so reject every mismatch and every Unix special file
    // rather than returning metadata that differs from the fallback parser.
    let (host_is_directory, host_is_regular) = match host.0 {
        HOST_WINDOWS => (
            file_attr.0 & FILE_ATTR_DIRECTORY != 0,
            file_attr.0 & FILE_ATTR_DIRECTORY == 0,
        ),
        HOST_UNIX => {
            let file_type = file_attr.0 & UNIX_FILE_TYPE_MASK;
            (
                file_type == UNIX_FILE_TYPE_DIRECTORY,
                file_type == UNIX_FILE_TYPE_REGULAR,
            )
        }
        _ => return None,
    };
    if host_is_directory != is_directory || (!is_directory && !host_is_regular) {
        return None;
    }
    if is_directory && (data_size != 0 || unpacked_size.0 != 0) {
        return None;
    }
    if !is_directory && data_size == 0 && unpacked_size.0 != 0 {
        return None;
    }
    if !is_directory && block_flags.0 & HFL_DATA == 0 {
        return None;
    }
    Some(ParsedHeader {
        header_len: common.header_len,
        header_type: header_type.0,
        block_flags: block_flags.0,
        data_size,
        unpacked_size: unpacked_size.0,
        is_directory,
        name,
        compression_method: method,
    })
}

fn validate_extra_area(bytes: &[u8]) -> bool {
    let mut pos = 0;
    while pos < bytes.len() {
        let Some((field_size, next)) = read_vint_at(bytes, pos) else {
            return false;
        };
        let Some((field_id, field_pos)) = read_vint_at(bytes, next) else {
            return false;
        };
        let payload = match field_size.checked_sub((field_pos - next) as u64) {
            Some(payload) => match usize::try_from(payload) {
                Ok(payload) => payload,
                Err(_) => return false,
            },
            None => return false,
        };
        let end = match field_pos.checked_add(payload) {
            Some(end) if end <= bytes.len() => end,
            _ => return false,
        };
        if matches!(field_id, EXTRA_ENCRYPTION | EXTRA_VERSION | EXTRA_REDIR) {
            return false;
        }
        pos = end;
    }
    pos == bytes.len()
}

fn validate_name(name: &str) -> Option<()> {
    if name.is_empty()
        || name.len() > 4096
        || name.contains('\0')
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\\')
        || name.chars().any(char::is_control)
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(())
}

fn read_u32(bytes: &[u8], pos: &mut usize) -> Option<u32> {
    let end = pos.checked_add(4)?;
    let value = read_u32_at(bytes, *pos)?;
    *pos = end;
    Some(value)
}

fn read_u32_at(bytes: &[u8], pos: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(pos..pos.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn read_vint(bytes: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let start = pos;
    let mut value = 0u64;
    let mut shift = 0u32;
    while pos < bytes.len() && pos - start < 10 {
        let byte = bytes[pos];
        pos += 1;
        value = value.checked_add((u64::from(byte & 0x7f)).checked_shl(shift)?)?;
        if byte & 0x80 == 0 {
            return Some((value, pos - start));
        }
        shift += 7;
    }
    None
}

fn read_vint_at(bytes: &[u8], pos: usize) -> Option<(u64, usize)> {
    let (value, length) = read_vint(bytes, pos)?;
    Some((value, pos.checked_add(length)?))
}

fn rar_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in bytes {
        crc ^= u32::from(byte);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom};

    fn vint(value: u64) -> Vec<u8> {
        let mut result = Vec::new();
        let mut value = value;
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            result.push(byte);
            if value == 0 {
                return result;
            }
        }
    }

    fn block(mut body: Vec<u8>) -> Vec<u8> {
        let mut result = vint(body.len() as u64);
        result.append(&mut body);
        let mut block = rar_crc32(&result).to_le_bytes().to_vec();
        block.extend(result);
        block
    }

    fn file_header_with_dictionary(header_type: u8, name: &str, dictionary: u64) -> Vec<u8> {
        let name = name.as_bytes();
        let mut body = vec![header_type, HFL_DATA as u8];
        body.extend(vint(0)); // packed size
        body.extend(vint(0)); // file flags
        body.extend(vint(0)); // unpacked size
        body.extend(vint(0)); // attributes
        body.extend(vint(dictionary << 10)); // compression information
        body.extend(vint(0)); // Windows host
        body.extend(vint(name.len() as u64));
        body.extend(name);
        block(body)
    }

    fn file_header(header_type: u8, name: &str) -> Vec<u8> {
        file_header_with_dictionary(header_type, name, 0)
    }

    fn file_header_with_host(header_type: u8, name: &str, file_attr: u64, host_os: u64) -> Vec<u8> {
        let name = name.as_bytes();
        let mut body = vec![header_type, HFL_DATA as u8];
        body.extend(vint(0)); // packed size
        body.extend(vint(0)); // file flags
        body.extend(vint(0)); // unpacked size
        body.extend(vint(file_attr));
        body.extend(vint(0)); // compression information
        body.extend(vint(host_os));
        body.extend(vint(name.len() as u64));
        body.extend(name);
        block(body)
    }

    fn file_header_with_extra(header_type: u8, name: &str, extra: &[u8]) -> Vec<u8> {
        let name = name.as_bytes();
        let mut body = vec![header_type, HFL_EXTRA_DATA as u8 | HFL_DATA as u8];
        body.extend(vint(extra.len() as u64));
        body.extend(vint(0)); // packed size
        body.extend(vint(0)); // file flags
        body.extend(vint(0)); // unpacked size
        body.extend(vint(0)); // attributes
        body.extend(vint(0)); // compression information
        body.extend(vint(0)); // Windows host
        body.extend(vint(name.len() as u64));
        body.extend(name);
        body.extend(extra);
        block(body)
    }

    fn make_fixture(entries: &[(&str, u8)]) -> (Vec<u8>, usize) {
        let headers = entries
            .iter()
            .map(|(name, header_type)| file_header(*header_type, name))
            .collect::<Vec<_>>();
        make_fixture_with_headers(&headers)
    }

    fn make_fixture_with_headers(headers: &[Vec<u8>]) -> (Vec<u8>, usize) {
        let mut q_offset = 64_u64;
        let mut recovery_offset = 128_u64;
        for _ in 0..8 {
            let main = {
                let mut locator = vec![0x03];
                locator.extend(vint(q_offset));
                locator.extend(vint(recovery_offset));
                let mut extra = vint((locator.len() + 1) as u64);
                extra.push(1); // locator record id
                extra.extend(locator);
                let mut body = vec![1, HFL_EXTRA_DATA as u8 | 0x04];
                body.extend(vint(extra.len() as u64));
                body.extend(vint(0x0c)); // solid + recovery
                body.extend(extra);
                block(body)
            };
            let main_end = 8 + main.len() as u64;
            let q_position = main_end
                + headers
                    .iter()
                    .map(|header| header.len() as u64)
                    .sum::<u64>();
            let mut qdata = Vec::new();
            let mut source = main_end;
            for header in headers {
                let mut body = vec![0];
                body.extend(vint(q_position - source));
                body.extend(vint(header.len() as u64));
                body.extend(header);
                qdata.extend(block(body));
                source += header.len() as u64;
            }
            let qo = {
                let mut body = vec![3, HFL_DATA as u8];
                body.extend(vint(qdata.len() as u64));
                body.extend(vint(0));
                body.extend(vint(qdata.len() as u64));
                body.extend(vint(0));
                body.extend(vint(0));
                body.extend(vint(0));
                body.extend(vint(2));
                body.extend(b"QO");
                block(body)
            };
            let recovery = file_header(3, "RR");
            let end = block(vec![5, 4, 0]);
            let new_q_offset = q_position - 8;
            let new_recovery_offset = q_position + qo.len() as u64 + qdata.len() as u64 - 8;
            let mut output = RAR5_SIGNATURE.to_vec();
            output.extend(main);
            for header in headers {
                output.extend(header);
            }
            output.extend(&qo);
            let qdata_start = output.len();
            output.extend(&qdata);
            output.extend(recovery);
            output.extend(end);
            if new_q_offset == q_offset && new_recovery_offset == recovery_offset {
                return (output, qdata_start);
            }
            q_offset = new_q_offset;
            recovery_offset = new_recovery_offset;
        }
        panic!("fixture vint positions did not converge");
    }

    fn run_bytes(bytes: &[u8]) -> Option<Vec<ArchiveEntry>> {
        let path = std::env::temp_dir().join(format!(
            "gai-rar-qo-{}-{}.rar",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        let file = File::open(&path).unwrap();
        let result = list_entries_from_file(&file, &path).unwrap();
        drop(file);
        std::fs::remove_file(path).unwrap();
        result
    }

    fn run_fixture(entries: &[(&str, u8)]) -> (Vec<u8>, Option<Vec<ArchiveEntry>>) {
        let (bytes, _) = make_fixture(entries);
        let result = run_bytes(&bytes);
        (bytes, result)
    }

    fn run_fixture_with_headers(headers: &[Vec<u8>]) -> (Vec<u8>, Option<Vec<ArchiveEntry>>) {
        let (bytes, _) = make_fixture_with_headers(headers);
        let result = run_bytes(&bytes);
        (bytes, result)
    }

    #[test]
    fn varints_are_bounded_and_checked() {
        assert_eq!(read_vint(&[0x80, 0x01], 0), Some((128, 2)));
        assert!(read_vint(&[0x80; 10], 0).is_none());
    }

    #[test]
    fn rejects_unsafe_names_and_encrypted_extra() {
        for name in [
            "../page.jpg",
            "/page.jpg",
            "chapter\\page.jpg",
            "bad\nname.jpg",
        ] {
            assert!(validate_name(name).is_none());
        }
        assert!(!validate_extra_area(&[0x01, 0x01, 0x00]));
        assert!(validate_extra_area(&[]));
    }

    #[test]
    fn version_and_redirection_extras_use_authoritative_parser() {
        // EX_VERSION payload: flags=0, version=1. libarchive exposes this as
        // `page.jpg;1`, while QuickOpen only has the original copied header.
        let version = [0x03, EXTRA_VERSION as u8, 0x00, 0x01];
        assert!(!validate_extra_area(&version));
        let (_, version_entries) =
            run_fixture_with_headers(&[file_header_with_extra(2, "page.jpg", &version)]);
        assert!(version_entries.is_none());

        // EX_REDIR payload: Unix symlink, flags=0, target="target.jpg".
        // libarchive reports a link rather than a regular image with the
        // copied file size, so this must also go through the old parser.
        let mut redir_payload = vec![1, 0, 10];
        redir_payload.extend(b"target.jpg");
        let mut redir = vec![14, EXTRA_REDIR as u8];
        redir.extend(redir_payload);
        assert!(!validate_extra_area(&redir));
        let (_, redir_entries) =
            run_fixture_with_headers(&[file_header_with_extra(2, "page.jpg", &redir)]);
        assert!(redir_entries.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn host_attributes_must_describe_the_same_regular_file_type() {
        // Unix mode bits select the libarchive file type. A symlink (or any
        // other special mode) cannot be represented by QuickOpen's regular
        // image metadata safely.
        let unix_symlink = file_header_with_host(2, "page.jpg", 0o120777, HOST_UNIX);
        assert!(run_fixture_with_headers(&[unix_symlink]).1.is_none());

        // On Windows libarchive uses the DOS directory attribute, even when
        // FILE_DIRECTORY says this is a regular file.
        let windows_directory =
            file_header_with_host(2, "page.jpg", FILE_ATTR_DIRECTORY, HOST_WINDOWS);
        assert!(run_fixture_with_headers(&[windows_directory]).1.is_none());

        // A normal Unix regular-file mode is accepted when it agrees with the
        // FILE header flags.
        let unix_regular = file_header_with_host(2, "page.jpg", 0o100644, HOST_UNIX);
        assert!(run_fixture_with_headers(&[unix_regular]).1.is_some());
    }

    #[test]
    fn matches_vendored_dictionary_window_limit() {
        assert!(parse_entry_header(&file_header_with_dictionary(2, "page.jpg", 9)).is_some());
        assert!(parse_entry_header(&file_header_with_dictionary(2, "page.jpg", 10)).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn complete_fixture_indexes_file_headers_and_keeps_order() {
        let (_, entries) = run_fixture(&[("page10.jpg", 2), ("page2.jpg", 2)]);
        let entries = entries.unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["page10.jpg", "page2.jpg",]
        );
    }

    #[test]
    fn service_image_and_unsafe_name_fall_back() {
        let (_, service) = run_fixture(&[("fake.jpg", 3)]);
        assert!(service.is_none());
        let (_, unsafe_name) = run_fixture(&[("../escape.jpg", 2)]);
        assert!(unsafe_name.is_none());
    }

    #[test]
    fn missing_index_and_oversized_header_use_fallback() {
        assert!(run_bytes(b"not a RAR archive").is_none());

        let mut bytes = RAR5_SIGNATURE.to_vec();
        bytes.extend([0_u8; 4]);
        bytes.extend(vint((MAX_HEADER_BYTES as u64) + 1));
        let path = std::env::temp_dir().join(format!(
            "gai-rar-qo-oversized-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        let file = File::open(&path).unwrap();
        let mut reader = BoundedReader::new(file).unwrap();
        assert!(reader.read_header(8).unwrap().is_none());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn malformed_qo_crc_and_file_before_endarc_fall_back() {
        let (mut bytes, qdata_start) = make_fixture(&[("page.jpg", 2)]);
        bytes[qdata_start] ^= 1;
        assert!(run_bytes(&bytes).is_none());

        let (mut bytes, _) = make_fixture(&[("page.jpg", 2)]);
        let end = block(vec![5, 4, 0]);
        let end_start = bytes
            .windows(end.len())
            .rposition(|window| window == end.as_slice())
            .unwrap();
        bytes.splice(end_start..end_start, file_header(2, "late.jpg"));
        assert!(run_bytes(&bytes).is_none());
    }

    #[test]
    fn unknown_main_flags_fall_back_even_with_valid_crc() {
        let (mut bytes, _) = make_fixture(&[("page.jpg", 2)]);
        let (main_size, size_len) = read_vint(&bytes, 12).unwrap();
        let main_end = 8 + 4 + size_len + usize::try_from(main_size).unwrap();
        let flags_pos = 8 + 4 + size_len + 1;
        bytes[flags_pos] |= 0x80;
        let main_crc = rar_crc32(&bytes[12..main_end]);
        bytes[8..12].copy_from_slice(&main_crc.to_le_bytes());
        assert!(run_bytes(&bytes).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn positional_reads_preserve_authorized_file_position() {
        let (bytes, _) = make_fixture(&[("page.jpg", 2)]);
        let path = std::env::temp_dir().join(format!(
            "gai-rar-qo-position-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        let mut file = File::open(&path).unwrap();
        file.seek(SeekFrom::Start(3)).unwrap();
        let position = file.stream_position().unwrap();
        assert!(list_entries_from_file(&file, &path).unwrap().is_some());
        assert_eq!(file.stream_position().unwrap(), position);
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_fast_path_falls_back_without_changing_cursor() {
        let (bytes, _) = make_fixture(&[("page.jpg", 2)]);
        let path = std::env::temp_dir().join(format!(
            "gai-rar-qo-windows-fallback-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();
        let mut file = File::open(&path).unwrap();
        file.seek(SeekFrom::Start(3)).unwrap();
        let position = file.stream_position().unwrap();
        assert!(list_entries_from_file(&file, &path).unwrap().is_none());
        assert_eq!(file.stream_position().unwrap(), position);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn copied_header_mismatch_and_partial_qo_fall_back() {
        let (mut bytes, qdata_start) = make_fixture(&[("page.jpg", 2)]);
        let source_start = 8 + 24;
        bytes[source_start] ^= 1;
        let path = std::env::temp_dir().join(format!("gai-rar-qo-mismatch-{}", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let file = File::open(&path).unwrap();
        assert!(list_entries_from_file(&file, &path).unwrap().is_none());
        drop(file);
        std::fs::remove_file(&path).unwrap();

        let (bytes, _) = make_fixture(&[("page.jpg", 2)]);
        let path = std::env::temp_dir().join(format!("gai-rar-qo-partial-{}", std::process::id()));
        std::fs::write(&path, &bytes[..qdata_start + 1]).unwrap();
        let file = File::open(&path).unwrap();
        assert!(list_entries_from_file(&file, &path).unwrap().is_none());
        drop(file);
        std::fs::remove_file(path).unwrap();
    }
}
