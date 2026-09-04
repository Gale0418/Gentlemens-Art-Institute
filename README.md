# 紳士藝術研究所 Gentlemen's Art Institute

**G.A.I** 是一套 **local-first / NAS-first** 的私人漫畫書架、整理器與閱讀器，目標是在 macOS 與 iPhone/iPad 上管理大型本機或 NAS 收藏，同時讓原始漫畫檔維持預設只讀。

正式產品路線使用 **Tauri 2 + Rust + SQLite + Vanilla HTML/CSS/JavaScript**。Electron / Express 仍保留為相容與緊急回退層，但新功能與 release hardening 應優先落在 `src-tauri/` 與共享 `public/`。

## Current status

- **唯一正式分支：`main`**；repository 採 trunk-only。
- **Rust release toolchain：1.98.1**，由 `rust-toolchain.toml` 與 `src-tauri/Cargo.toml` 同步鎖定。
- **目前不使用 GitHub Actions**；Actions 額度不可用期間，品質閘門全部改成 repository 內可重跑的 `npm run quality`。
- SQLite catalog 是 metadata / location / progress 的主要本機 authority；來源離線不等於資料刪除。
- 本機、iOS security-scoped folder 與 SMB/NAS 是獨立來源；其中一個來源離線不應清除其他來源或 catalog 紀錄。
- 內建全年齡原創 demo 可在乾淨安裝、沒有 NAS／帳號／第三方下載的情況下直接驗證核心 reader。
- App Store / TestFlight 資料目前仍是 **`draft-blocked`**；未完成真實 processed build、實機錄影、Privacy Policy / Support URL、App Privacy、Age Rating、export compliance 等證據前，不應送審。
- `src-tauri/vendor/wry/` 是**刻意保留的 iOS WebKit startup patch**，目前仍由 Cargo `[patch.crates-io]` 使用；不要因為它看起來像 vendor 目錄就清掉。

## 2026-09-04 hardening audit

本輪從平台 API、scanner、SMB、ZIP、file mutation journal、RAM preload、iOS security scope、protocol 與 frontend/native 契約重新檢查。已修正的高價值問題包括：

- macOS 不再連結 Apple 標示 unavailable 的 `os_proc_available_memory()`；只有 iOS 使用該 process advisory API。
- SMB connect/share/metadata/rename/create-directory 加入 deadline，避免 NAS 異常時無限等待。
- SMB 檔案操作只有 typed `NotFound` 才視為「目的地不存在」；AccessDenied、ConnectionLost、timeout 等全部 fail closed。
- SMB runtime capability 加入 source scope，避免與相同 relative path 的 local comic 產生 ID collision。
- SMB-only library 可以啟動掃描；NAS cold-start 離線時會從 SQLite 回填 offline shelf，而不是把收藏看成消失。
- 空 `scanDir` 不再被當成 current working directory；filesystem symlink 在 scanner 與 page-serving 兩層拒絕。
- ZIP entry 同時防 `/`、`\\`、absolute、`.`、`..` 與 control-character path；不安全 entry 不會先進書架再等翻頁時才報錯。
- RAM preload 單頁上限與 serving protocol 統一為 64 MiB，超大頁仍可 on-demand 讀取但不進背景 cache。
- iOS security-scoped bookmark 在失敗與 plugin deinit 路徑正確釋放；availability check 先 resolve symlink。
- Tauri bridge 會正規化 stale / out-of-range reader progress；最後一頁 progress 可一致呈現為 100%。
- 新增 `tests/release-hardening.mjs` 鎖定上述 invariants，避免後續重構讓這批 bug 復活。

## Architecture

| Layer | Authority / role |
| --- | --- |
| `public/` | 共享 UI、reader、catalog organizer、Tauri bridge |
| `src-tauri/src/` | 正式 native backend：scanner、protocol、cache、catalog、file ops、AI session |
| SQLite (`catalog.sqlite3`) | catalog / metadata / location / progress 的本機權威資料 |
| Original comic files / sidecars | 預設只讀；不因整理或來源離線被自動改寫／刪除 |
| `main.js` / `preload.js` | Legacy Electron fallback |
| `server.js` / `scan-depth.js` | Legacy browser / HTTP fallback 與 regression compatibility |

### Reader cache

前端只保留有界的鄰近頁工作集；Rust 壓縮頁快取依裝置記憶體、process 可用記憶體與 OS memory pressure 動態調整，並以實際 ZIP entry bytes 決定 nearest-first page window。背景 preload 單頁最多 64 MiB，與正式 protocol 的單頁 serving safety limit 一致。完整契約見 [`docs/E6-E8-DECISIONS.md`](docs/E6-E8-DECISIONS.md)。

### Source lifecycle

- Local source ID 使用**使用者已配置的 root 字串**衍生，刻意保持來源拔除後仍可重現；不要在每次掃描時動態 canonicalize，否則同一 removable/NAS-backed source 可能在 online/offline 狀態得到不同 ID。若未來要改成 canonical identity，必須先把 resolved identity 持久化再做 migration。
- iOS external folder 使用 security-scoped bookmark；symlink 不可逃出使用者選擇的 root。
- SMB 掃描與檔案操作均有 timeout；成功掃描才把 current NAS state 標 online，失敗則保留 SQLite location 並回填 offline shelf。
- offline 是 location 狀態，不代表 comic metadata 被刪除。

## Quick start

```sh
npm ci
rustc --version
npm run quality
```

`npm run quality` 會執行：

1. Node regression suite：UI / HTTP / cache / scan-depth / AI consent / release-hardening。
2. `cargo fmt --check`。
3. `cargo test --locked --lib`。
4. `cargo clippy --locked --lib --bins --no-deps -- -D warnings`。

較快的日常功能驗證：

```sh
npm run verify
```

Cargo build output 統一放在 `/tmp/gai-cargo-target`，並關閉 incremental compilation，避免外接磁碟／NAS-backed checkout 的 lock 與大量 local target 問題。

## Development & builds

```sh
# Tauri 開發版
npm run tauri dev

# 正式 macOS app / DMG
npm run build

# Legacy Electron fallback
npm run electron

# Legacy browser fallback
npm start
```

iOS/iPadOS 有額外的本機檔案系統、Xcode、簽名與實機驗證要求，請依 [`BUILD_GUIDE.md`](BUILD_GUIDE.md) 操作；不要從歷史 blocker 文件複製舊路徑或假設舊磁碟狀態仍成立。

## Data & privacy boundaries

- 原始漫畫、sidecar 與 NAS 內容預設不由 catalog organizer 自動覆寫。
- 使用者人工 metadata 永遠高於 importer / AI candidate。
- API key 只保留目前 App session，不寫入 SQLite、localStorage、log 或 metadata export。
- OpenAI 與 Google AI 都是選用功能；正式 Tauri UI 在建立 session 前會指出目前頁面影像與 prompt 可能送往所選第三方 provider，並要求 explicit consent。
- 切換 AI provider 會撤銷前一次同意並要求重新確認。
- AI 回傳只做頁面說明或可人工審核的 metadata candidate，不直接覆寫人工資料。

## Impeccable design state

Impeccable 的共享專案檔案可以進 Git：

- `.impeccable/config.json` — workflow default；目前 `buildPath` 為 `code`。
- `.impeccable/design.json` — shared design-system artifact。

`.impeccable/config.local.json`、hook cache、live session、preview、annotation、screenshot 等 runtime / per-machine state 已由 `.gitignore` 排除。

`DESIGN.md` 是人類可讀的設計規範；`.impeccable/design.json` 保存較結構化的 tokens、components 與設計 metadata。兩者用途不同，不要把 `design.json` 當暫存垃圾刪除。

## Repository map

```text
.
├── .cargo/                  # shared Cargo build policy
├── .impeccable/             # shared Impeccable config + design artifact
├── assets/                  # legacy Electron packaging source icon
├── docs/
│   ├── history/             # dated evidence / old blockers; not current truth
│   ├── release/             # canonical App Store / TestFlight preparation
│   ├── E6-E8-DECISIONS.md   # durable architecture / release decisions
│   └── RUST-QUALITY.md      # local Rust / release quality contract
├── public/                  # shared frontend
├── scripts/release/         # local-only release metadata guard
├── src-tauri/               # formal Tauri / Rust application
├── tests/                   # Node regression suite
├── BUILD_GUIDE.md
├── DESIGN.md
├── LEGACY.md
├── PRODUCT.md
└── README.md
```

## Documentation authority

### Current source of truth

- [`PRODUCT.md`](PRODUCT.md) — durable product scope and exclusions。
- [`DESIGN.md`](DESIGN.md) — current design / UX contract。
- [`docs/E6-E8-DECISIONS.md`](docs/E6-E8-DECISIONS.md) — durable technical and release decisions。
- [`docs/RUST-QUALITY.md`](docs/RUST-QUALITY.md) — Rust 1.98.1 local quality gate and native trust boundaries。
- [`BUILD_GUIDE.md`](BUILD_GUIDE.md) — current build and iOS workflow。
- [`docs/release/`](docs/release/) — current TestFlight / App Store metadata and outstanding evidence。

### Historical evidence

[`docs/history/`](docs/history/) 保留特定日期的匯入結果、舊 blocker 與舊診斷。它們用來回答「當時發生了什麼」，**不能優先於目前程式碼或 current-source-of-truth 文件**。

## Legacy policy

`main.js`、`preload.js`、`server.js`、`scan-depth.js` 暫時保留，因為 package scripts 與 regression tests 仍使用 Electron / browser fallback。不要在沒有先移除對應 scripts、dependencies、tests 與 `LEGACY.md` 契約的情況下單獨刪除它們。

新功能不得只做在 legacy layer；正式產品能力應優先實作於 Tauri/Rust backend 與共享 frontend。Legacy fallback 仍需維持 loopback-only browser server、context isolation、nodeIntegration off 與相同的 path traversal / image size safety boundary。

## Release gate

發行資料來源：

- [`docs/release/gai-app-store-connect-metadata.json`](docs/release/gai-app-store-connect-metadata.json) — canonical release metadata。
- [`docs/release/app-store-connect-ios-metadata.md`](docs/release/app-store-connect-ios-metadata.md) — 人讀版審查包。
- [`scripts/release/asc-dry-run.sh`](scripts/release/asc-dry-run.sh) — **local-only** metadata / secret / TODO gate；本身不提交版本。

任何 signed artifact、實機資訊、API key、NAS 密碼或真實裝置 identifier 都不應提交進 repository。

## Repository policy

這個 repository 採 **trunk-only**：

- `main` 是唯一正式 branch。
- 不建立 feature / release branch 作為長期狀態。
- 直接進 `main` 的變更必須保持 `npm run quality` 可重跑。
- GitHub Actions 在額度不可用期間不作為 release gate；恢復 CI 前先確認額度與 runner 可實際執行，再重新建立 workflow。
- dated one-off reports 放 `docs/history/`，避免它們污染現況推理。
- 不提交 build artifacts、runtime cache、Impeccable local/session state 或 secrets。
