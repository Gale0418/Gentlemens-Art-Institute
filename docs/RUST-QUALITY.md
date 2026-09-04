# Rust 品質週期

## 受支援工具鏈

正式工具鏈固定為 **Rust 1.98.1**，`rust-toolchain.toml` 與 `src-tauri/Cargo.toml` 必須保持一致。1.98.0 不再作為 release compiler 使用；所有 release candidate 都應由 1.98.1 或之後經明確審核的修補版重新建置。

## 可重跑閘門

目前不使用 GitHub Actions，避免在 Actions 額度不可用時產生無法執行的紅燈與額度噪音。唯一的程式品質閘門是 repository 內可直接重跑的本機命令：

```sh
npm ci
npm run quality
```

`npm run quality` 等價於：

```sh
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --package gai -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --lib --bins --no-deps -- -D warnings
```

較快的功能驗證可用：

```sh
npm run verify
```

`.cargo/config.toml` 將 target-dir 固定在 `/tmp/gai-cargo-target`，並統一設定 `CARGO_INCREMENTAL=0`，避免把建置產物寫到漫畫／NAS 路徑，也避免外接或網路檔案系統不支援 Cargo incremental lock 的問題。

本機品質閘門不是 Apple 發行證據。iOS/iPadOS 仍必須另外完成簽名 archive、processed build、實體裝置安裝與錄影驗證。

## 2026-09-04 release-hardening 稽核

本輪從 platform API、來源生命週期、路徑邊界、檔案 journal、ZIP、RAM、iOS security scope 與前端/native 契約重新稽核。重要 invariants 已加入 `tests/release-hardening.mjs` 與 Rust unit tests：

- `os_proc_available_memory()` 只允許進 iOS binary；macOS 使用保守 fallback。
- SMB connect/share/metadata/rename/create-directory 都有 deadline；只有 typed `NotFound` 可視為目的地不存在。
- SMB runtime ID 使用 source-scoped capability，避免與同相對路徑的 local comic 碰撞。
- local／external／SMB scan 不再把空 `scanDir` 當工作目錄；symlink 在 scanner 與 page-serving 兩層 fail closed。
- NAS 掃描失敗時 SQLite 保留來源並可回填 offline shelf；成功時才重新標記 current SMB state。
- ZIP entry path 同時把 `/` 與 `\\` 視為路徑語意，拒絕 absolute、dot、dot-dot 與 control-char entry。
- 背景 RAM preload 單頁上限與 protocol 一致為 64 MiB。
- iOS security-scoped bookmarks 在失敗／deinit 路徑釋放；availability 檢查先 resolve symlink。
- Tauri bridge 在 open/save progress 時正規化 0-based reader page index，避免 stale/out-of-range progress 污染 reader state。

## panic 與 unsafe 稽核

- production Rust 的 `unsafe` 只允許出現在已隔離、可說明的系統邊界。目前 `state.rs` 使用 Apple `sysctlbyname` 與 iOS `os_proc_available_memory` FFI；macOS 不連結後者。
- 既有 `unwrap` 主要位於短生命週期鎖、測試 fixture 與 Tauri 啟動邊界；新增外部輸入路徑不可依賴 panic。
- 檔案、ZIP、HTTP、SMB 與 parser 邊界均應回傳 `Result`，呼叫端顯示可讀錯誤或寫入診斷，不以 panic 結束掃描。
- 檔案 mutation 必須維持 journal → filesystem mutation → catalog commit → rollback 的順序，rollback 失敗時必須明確要求人工檢查，不得宣稱已還原。

## 輸入邊界

`protocol` 測試涵蓋缺頁、損壞 ZIP、圖片大小上限、外部 bookmark 權限、capability parsing 與 symlink 逃逸；`catalog` 測試涵蓋指紋碰撞不自動合併、離線保留與 metadata 交易撤銷。Node regression suite 另涵蓋 HTTP same-origin、嚴格 page index、cache hardening、scan depth、第三方 AI explicit-consent 與本輪 release-hardening invariants。

## Tauri 契約

公開 command 以具名 serde payload 接收資料；catalog 與 metadata command 在 native 邊界驗證可接受格式。舊版相容 command 仍有少數 `serde_json::Value` payload，因此正式 UI 必須經 `public/tauri-api.js` bridge 做第二層正規化。

第三方 AI 的 **provider-neutral explicit consent** 由正式 UI 唯一使用的 Tauri bridge 在 `set_ai_session_config` 前強制執行：OpenAI 與 Google 都必須勾選；切換 provider 會撤銷先前同意並重新確認。現有 wire 欄位仍名為 `googleContentDisclosure`，只是為了避免大前端契約破壞，不代表只有 Google 需要同意。Release CSP 只允許 bundled self scripts；不要新增能繞過 bridge 直接呼叫 AI session command 的遠端或不受信任腳本。

AI 金鑰只存在工作階段記憶體，不進 SQLite、localStorage、log 或匯出檔。若未來要把 provider-neutral consent 與 progress normalization 下沉到大型 `lib.rs` native command，應做小型 typed-request migration 並同步前端、Rust unit test 與 release metadata，不要用無關的大型 rewrite 混入 release hardening。
