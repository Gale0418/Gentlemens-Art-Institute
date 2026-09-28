# Third-party notices

G.A.I includes the vendored `libarchive2` Rust wrapper and its `libarchive2-sys` FFI crate for reading RAR/CBR archives. The vendored source is retained under `src-tauri/vendor/` and its original notices remain unchanged.

## libarchive2 and libarchive2-sys

The wrapper crates `libarchive2` (version 0.2.1) and `libarchive2-sys` (version 0.2.0) declare the BSD-2-Clause license in their vendored `Cargo.toml` files. Their source is distributed with the application under those terms.

The bundled libarchive source is version 3.8.1. Its complete original notice and license summary is preserved at [`src-tauri/vendor/libarchive2-sys/libarchive/COPYING`](../../src-tauri/vendor/libarchive2-sys/libarchive/COPYING). The libarchive distribution is generally under its two-clause BSD-style terms, but the `COPYING` file states that individual files control and records these exceptions:

- selected files also include the three-clause UC Regents license;
- `archive_parse_date.c` is public domain;
- the listed BLAKE2 files are triple-licensed under CC0 1.0 Universal, OpenSSL, or Apache 2.0, at the recipient's choice;
- build files and auxiliary scripts have varying individual license terms.

The original vendored `COPYING` and per-file notices are the authoritative notices for those exceptions. This document is a release index and does not replace them.

## sevenz-rust2

The app uses `sevenz-rust2` version 0.23.0 for 7z archive support, as pinned in [`src-tauri/Cargo.lock`](../../src-tauri/Cargo.lock). The crate declares the Apache License 2.0 (`Apache-2.0`) and includes its complete license text in the package [`LICENSE`](https://docs.rs/crate/sevenz-rust2/0.23.0/source/LICENSE). The 0.23.0 package contains no separate `NOTICE` file or additional attribution notice; the Apache License 2.0 attribution and redistribution conditions therefore apply as stated in that license.
