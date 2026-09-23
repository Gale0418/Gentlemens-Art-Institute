# Rust 品質週期

## 受支援工具鏈

正式工具鏈固定為 **Rust 1.98.1**，`rust-toolchain.toml` 與 `src-tauri/Cargo.toml` 必須保持一致。1.98.0 不再作為 release compiler 使用；所有 release candidate 都應由 1.98.1 或之後經明確審核的修補版重新建置。

## Runtime policy

G.A.I 現在只有 **Tauri 2** 一套 runtime。Electron、Express、browser HTTP server 與對應 Node runtime dependencies 已在 2026-09-04 正式移除。

`public/app.js` 使用的 `window.electronAPI` 只是歷史相容 facade 名稱；物件由 `public/tauri-api.js` 在 Tauri WebView 中建立。不要把這個名字誤判成 Electron 仍是支援平台，也不要因為某項 Tauri 能力缺失就復活第二套 backend。

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

Node regression suite 現在只測正式路線：

- `tests/tauri-ui-smoke.mjs` — Tauri UI / packaging / native-authority smoke checks。
- `tests/ai-consent.mjs` — Rust toolchain、local gate、第三方 AI consent。
- `tests/release-hardening.mjs` — scanner、SMB、ZIP、cache、iOS security scope、reader progress 等 hardening invariants。

Rust 測試與 Clippy 的 npm scripts 透過 `scripts/with-private-cargo-cache.mjs` 使用目前使用者的私人本機 cache；macOS 預設位於 `~/Library/Caches/com.windsheep.gai/cargo`。目錄必須由目前使用者擁有且不可為符號連結，權限設為 700；明確的 `CARGO_TARGET_DIR` 覆寫同樣驗證。`.cargo/config.toml` 只統一設定 `CARGO_INCREMENTAL=0`。直接 Cargo 指令可使用同一 wrapper；iOS/Xcode staging 依 `BUILD_GUIDE.md` 保留副本內的 target，避免改變生成專案預期的路徑。

本機品質閘門不是 Apple 發行證據。iOS/iPadOS 仍必須另外完成簽名 archive、processed build、實體裝置安裝與錄影驗證。

## 2026-09-04 release-hardening 稽核

重要 invariants 已加入 Node regressions 與 Rust unit tests：

- `os_proc_available_memory()` 只允許進 iOS binary；macOS 使用保守 fallback。
- SMB connect/share/read/stat/rename/create-directory 都有 deadline；只有 typed `NotFound` 可視為目的地不存在。
- SMB runtime ID 使用 source-scoped capability，避免與同相對路徑的 local comic 碰撞。
- local／external／SMB scan 不把空 `scanDir` 當工作目錄；symlink 在 scanner 與 page-serving 兩層 fail closed。
- NAS 掃描失敗時 SQLite 保留來源並可回填 offline shelf；成功時才重新標記 current SMB state。
- ZIP entry path 同時把 `/` 與 `\\` 視為路徑語意，拒絕 absolute、hidden、dot、dot-dot、duplicate 與 control-char page entry。
- 背景 RAM preload 單頁上限與 protocol 一致為 64 MiB，whole-book selection 仍採 nearest-first。
- iOS security-scoped bookmarks 在失敗／deinit 路徑釋放；availability 檢查先 resolve symlink。
- Tauri bridge 在 open/save progress 時正規化 0-based reader page index，並以 SQLite-overlay progress 防止 background refresh 倒退閱讀位置。
- mutable folder page URL 使用 `Cache-Control: no-store`，刪頁後不會取得舊 index cache。
- catalog migration / canonical-tag backfill 只在 store 初始化生命週期執行，不混進每次短生命週期 connection 的熱路徑。

## panic 與 unsafe 稽核

- production Rust 的 `unsafe` 只允許出現在已隔離、可說明的系統邊界。目前 `state.rs` 使用 Apple `sysctlbyname` 與 iOS `os_proc_available_memory` FFI；macOS 不連結後者。
- 既有 `unwrap` 主要位於短生命週期鎖、測試 fixture 與 Tauri 啟動邊界；新增外部輸入路徑不可依賴 panic。
- 檔案、ZIP、SMB、protocol 與 parser 邊界均應回傳 `Result`，呼叫端顯示可讀錯誤或寫入診斷，不以 panic 結束掃描。
- 檔案 mutation 必須維持 journal → filesystem mutation → catalog commit → rollback 的順序，rollback 失敗時必須明確要求人工檢查，不得宣稱已還原。

## 輸入邊界

`protocol` / `utils` 測試涵蓋缺頁、損壞 ZIP、圖片大小上限、capability parsing、hidden/duplicate entry 與 symlink 逃逸；`catalog` 測試涵蓋指紋碰撞不自動合併、離線保留、progress authority 與 metadata 交易撤銷。Node regression suite 鎖定 Tauri packaging、AI consent、SMB path/error semantics、cache policy、iOS security scope 與 reader lifecycle。

## Tauri 契約

公開 command 優先使用具名 serde payload；catalog 與 metadata command 在 native 邊界驗證可接受格式。仍保留少數相容性的 `serde_json::Value` payload，因此正式 UI 必須經 `public/tauri-api.js` bridge 做第二層正規化。

第三方 AI 的 **provider-neutral explicit consent** 必須同時在正式 Tauri bridge 與 native command 邊界成立：OpenAI 與 Google 都需要明確同意；切換 provider 會撤銷先前同意並重新確認。現有 wire 欄位仍名為 `googleContentDisclosure`，只是為了避免大前端契約破壞，不代表只有 Google 需要同意。

AI 金鑰預設只存在工作階段記憶體；macOS／iOS／iPadOS 在使用者明確選擇後可存入 Keychain，清除設定時需刪除。金鑰不進 SQLite、localStorage、log 或匯出檔。即使 Keychain 中有金鑰，重新啟用 AI 仍需當次明確同意第三方傳送。Release CSP 只允許 bundled self scripts；不要新增能繞過 bridge 直接呼叫 AI session command 的遠端或不受信任腳本。
