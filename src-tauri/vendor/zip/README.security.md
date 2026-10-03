# ZIP 0.6.6 security provenance

This vendor directory starts from the crates.io `zip-0.6.6.crate` artifact.

- SHA256: `760394e246e4c28189f19d488c058bf16f564016aefac5d32bb1f3b51d5e9261`
- Upstream repository: https://github.com/zip-rs/zip
- Version: `0.6.6`

The local patch only bounds central-directory metadata before the upstream
`ZipArchive` allocates its file/name maps. It does not reject traversal names,
because this application filters names and never extracts ZIP entries.

Additional local changes: ZIP64 recovery searches use a fixed 64 KiB buffer
with three-byte overlap instead of one seek per byte. This preserves large
self-extracting prefixes while bounding scratch memory and seek count. The
application independently caps archive input at 8 GiB. Names are limited both
before decoding and after UTF-8 decoding; aggregate metadata includes both
representations. Two compiler-only lifetime/mutability cleanups retain behavior.
