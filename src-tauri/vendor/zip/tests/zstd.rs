#![cfg(feature = "zstd")]

use std::io::{Cursor, Read, Write};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const CONTENT: &[u8] = b"zstd zip roundtrip payload";

#[test]
fn zstd_zip_write_read_roundtrip() {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "payload.txt",
            FileOptions::default()
                .compression_method(CompressionMethod::Zstd)
                .compression_level(Some(3)),
        )
        .unwrap();
    writer.write_all(CONTENT).unwrap();
    let bytes = writer.finish().unwrap().into_inner();

    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut entry = archive.by_index(0).unwrap();
    assert_eq!(entry.compression(), CompressionMethod::Zstd);

    let mut decoded = Vec::new();
    entry.read_to_end(&mut decoded).unwrap();
    assert_eq!(decoded, CONTENT);
}

#[test]
fn reads_fixed_zstd_zip_frame() {
    // ZIP method 93 containing a standard Zstandard frame with a raw block.
    // This fixture is fixed so compatibility does not depend on the current encoder.
    let bytes = include_bytes!("data/zstd_raw_block.zip");
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut entry = archive.by_index(0).unwrap();
    assert_eq!(entry.compression(), CompressionMethod::Zstd);

    let mut decoded = Vec::new();
    entry.read_to_end(&mut decoded).unwrap();
    assert_eq!(decoded, b"hello");
}
