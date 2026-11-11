# Third-party notices

G.A.I includes third-party Rust and native code. The generated [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt) bundles original readable UTF-8 license and notice files found for the normal runtime dependency union of the macOS arm64, macOS x86_64, and iOS arm64 targets. It lists each crate's declared SPDX expression, source file, repository, and SHA-256. The accompanying [`third-party-licenses-manifest.json`](third-party-licenses-manifest.json) records the locked inputs, targets, selection rules, source coverage, and any unresolved gaps. The generator also reads the immutable, hash-checked [`license-source-supplements.json`](license-source-supplements.json) and preserves each entry's source role and notes, including canonical SPDX templates that are references rather than package attribution. No source text or attribution is synthesized.

Regenerate both files from the repository root with:

```sh
python3.11 scripts/release/generate-third-party-notices.py
```

The generator uses `cargo metadata --locked --offline`, keeps normal dependency edges for the listed targets, and excludes build, dev, and proc-macro-only packages. It lists 348 third-party Cargo packages and records the first-party iOS folder plugin separately. Native Apple runtime components are tracked separately from Cargo packages. The runtime package union therefore does not claim to enumerate every crate in `Cargo.lock`.

## Directly vendored and notable licenses

- [`zip` 0.6.6 — LICENSE](../../src-tauri/vendor/zip/LICENSE) declares MIT.
- [`wry` 0.55.1 — LICENSE-MIT](../../src-tauri/vendor/wry/LICENSE-MIT) and [`LICENSE-APACHE`](../../src-tauri/vendor/wry/LICENSE-APACHE) are included with the vendored crate; [`LICENSE.spdx`](../../src-tauri/vendor/wry/LICENSE.spdx) is also retained.
- [`sevenz-rust2` 0.23.0 — LICENSE](../../src-tauri/vendor/sevenz-rust2/LICENSE) contains the package's Apache-2.0 license text.

The vendored [`libarchive2`](../../src-tauri/vendor/libarchive2/Cargo.toml) and [`libarchive2-sys`](../../src-tauri/vendor/libarchive2-sys/Cargo.toml) wrappers declare BSD-2-Clause. The bundled libarchive source is version 3.8.9 (`ARCHIVE_VERSION_NUMBER` 3008009 in the vendored `archive.h`). Its complete original notice and license summary is preserved at [`libarchive/COPYING`](../../src-tauri/vendor/libarchive2-sys/libarchive/COPYING). That file states that individual files control and records these exceptions:

- selected files also include the three-clause UC Regents license;
- `archive_parse_date.c` is public domain;
- the listed BLAKE2 files are triple-licensed under CC0 1.0 Universal, OpenSSL, or Apache 2.0, at the recipient's choice;
- build files and auxiliary scripts have varying individual license terms.

The original vendored `COPYING` and per-file notices are authoritative for those exceptions. The generated license bundle includes the upstream `COPYING` source through `libarchive2-sys`; this index preserves the existing summary of file-specific terms.

## SQLite

The app enables `rusqlite`'s `bundled` feature, so `libsqlite3-sys` compiles the SQLite 3.54.1 amalgamation into the app. The crate's MIT license applies to the Rust crate; SQLite source comments contain the author's public-domain dedication. The bundle includes verbatim source comments that explicitly disclaim copyright or state public-domain status, including the `printf.c` public-domain notice, and records hashes for the complete SQLite C source and headers. Generic third-party VFS/API mentions are not treated as license notices; the manifest records this scoped scan and its source hashes.

## Native Apple components

The iOS `Package.resolved` pin for `SwiftRs` is version 1.0.7; it is distinct from the Cargo crate `swift-rs` 1.0.8. Both original MIT and Apache-2.0 license files for the pinned native component are included with immutable source metadata. The Tauri Swift static package version 2.11.5 is covered by the corresponding `tauri` 2.11.5 Cargo package license files, as recorded in the manifest.

## Source coverage limits

The manifest distinguishes original package files, immutable source supplements, canonical license references, and source-coverage notes. The objc2 source declaration and MIT template are both included; the upstream declaration has no package-specific copyright holder line, and the generic template placeholders are not treated as actual ownership. Declared SPDX expressions remain metadata; the bundle does not claim legal certification.
