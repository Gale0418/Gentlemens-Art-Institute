# sevenz-rust2 security pin

Source pinned from `sevenz-rust2 0.23.0`, upstream source revision
`8fa733090e422c1c583d87a4cd87193b59115317`.
The verified registry crate archive SHA-256 is
`0a4f883677093690e91fef8ae81fad8bce9e2c3a079b61054f05ce0d3ecf681e`.

This local copy keeps the upstream archive grammar and applies bounded header
counts, a 64 MiB encoded-header limit, 4 KiB per-name and 16 MiB aggregate
name metadata limits, and aggregate decoder memory checks for LZMA/LZMA2/PPMD.
The patch prevents untrusted 7z metadata and dictionaries from allocating
beyond the iOS memory budget before or during decoding.
