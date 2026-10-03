# 紳士藝術研究所 Gentlemen's Art Institute

**自己的漫畫，找得到、接著看。**

硬碟裡的收藏堆成山，找一本還得像在考古？G.A.I 把自己的漫畫檔與圖集放上書架，讓搜尋、收藏與閱讀進度都在同一個地方。圖片資料夾、ZIP／CBZ、RAR／CBR、7z／CB7 不用先手動解壓；單頁、雙頁、右至左與條漫，依作品切換。

基本閱讀免費，不要求建立 App 帳號。可從本機、外接硬碟或已透過系統掛載的 NAS 選擇資料夾。首發 v1 Pro 採一次買斷，提供直接 SMB／NAS、批次整理、重複候選與選用 AI 工具；AI 需自備金鑰，API 費用另計。

已取得測試版時，先試讀內建原創風景，再加入自己的收藏。內建圖集供操作體驗；App 不提供漫畫下載或內容庫。NAS 離線時會保留已整理紀錄，原始頁面仍需來源可讀；進度保存在當前裝置，未提供跨裝置自動同步。

**發布狀態：Mac 1.0 已可販售；iOS 1.0 (57) 與 Mac 1.0.1 (57) 已送審，均為 WAITING_FOR_REVIEW。** 2026-10-03 Apple 回讀確認。本輪65檔 CodeRabbit 審查的4項問題均已修正，10檔複審0 issues，前端15組與Rust187項通過；程式碼已整合main。版本、簽章與提交證據見 [發行收尾](docs/release/build57-appstore-closeout-2026-10-03.md)。原生TAG探索的Mac驗收沿用56版，iPad56已覆蓋但TAG操作待解鎖；完整VoiceOver與StoreKit交易仍列後續驗收。

[隱私政策](#隱私政策) · [支援與使用說明](SUPPORT.md)

[看看七張宣傳圖](docs/release/PROMO_ART.md)：沿用 App 畫面構圖、替換示範內容；圖中的漫畫不隨 App 提供。

專案現在是 **Tauri 2 + Rust + SQLite + Vanilla HTML/CSS/JavaScript** 的單一路線產品。2026-09-04 起，舊 Electron / Express / browser fallback runtime、對應套件、scripts、測試與包裝資產已正式移除；不再維護第二套後端。

> `public/app.js` 仍透過 `window.electronAPI` 這個歷史名稱呼叫 native facade，實際物件由 `public/tauri-api.js` 在 Tauri WebView 內建立。這只是為了避免大規模重寫共享前端 API 名稱，**不是 Electron runtime 或相依套件**。

## Current status

- **唯一正式分支：`main`**；repository 採 trunk-only。
- **唯一 runtime：Tauri 2**；Electron、Express、`main.js`、`preload.js`、`server.js`、`scan-depth.js` 都已移除。
- **Rust release toolchain：1.98.1**，由 `rust-toolchain.toml` 與 `src-tauri/Cargo.toml` 同步鎖定。
- **目前不使用 GitHub Actions**；Actions 額度不可用期間，品質閘門全部改成 repository 內可重跑的 `npm run quality`。
- SQLite catalog 是 metadata / location / progress 的主要本機 authority；來源離線不等於資料刪除。
- 本機、iOS security-scoped folder 與單一 SMB/NAS 是獨立來源；其中一個來源離線不應清除其他來源或 catalog 紀錄。
- 內建全年齡原創 demo 可在乾淨安裝、沒有 NAS／帳號／第三方下載的情況下直接驗證核心 reader。
- 2026-10-03：iOS商店 `1.0` 綁定 build44，狀態 `WAITING_FOR_REVIEW`；Mac `1.0` 已 `READY_FOR_DISTRIBUTION`；本機 Mac／iPad 第54版的實機證據見 [產品體驗報告](docs/audits/2026-10-03-product-experience.md)。完整 StoreKit 交易、Privacy UI 確認、公開 Mac 正式簽署／公證與新版上傳重送仍待完成。第56版已覆蓋兩平台；TAG 探索的 Mac 驗收與實機限制見 [探索體驗報告](docs/audits/2026-10-03-discovery-experience.md)，勿把源碼變更視為已上架。
- `src-tauri/vendor/wry/` 是**刻意保留的 iOS WebKit startup patch**，目前仍由 Cargo `[patch.crates-io]` 使用；不要因為它看起來像 vendor 目錄就清掉。

## 隱私政策

更新日期：2026-09-09。適用於 G.A.I（紳士藝術研究所）的 macOS、iPhone 與 iPad 版本。開發與隱私問題請聯絡 [coderb0418@gmail.com](mailto:coderb0418@gmail.com)。

### 本機書庫與照片

G.A.I 不要求建立自有帳號，也未整合廣告或第三方行為分析服務。書籍索引、檔名與來源路徑、標籤、收藏、閱讀進度、整理結果及復原紀錄保存在裝置上的 App 資料中。閱讀時會產生縮圖與頁面快取；這些資料不會因一般閱讀操作而上傳給開發者。

透過「匯入圖片」加入的內容會建立書庫副本；直接連結的外部資料夾、NAS 與照片相簿則依原有來源讀取，不代表整份內容已複製或可離線使用。只有主動連結相簿才要求照片讀取權限：有限權限只讀取你允許的照片，完整權限可列出相簿及其中可讀取的照片。解除相簿連結會移除 App 的連結及相關快取，不會刪除照片圖庫的原圖。

### 網路、AI 與購買

- **SMB／NAS：** App 使用你提供的主機、共享資料夾與登入資訊，直接連到指定伺服器讀取內容。伺服器由你或其管理者控制；「清除連線」可移除 App 保存的連線設定。
- **選用 AI：** 你提供自己的 OpenAI 或 Google API Key，並同意傳送後，主動選擇的頁面影像與提示文字才會送到該供應商。預設只保留於目前工作階段；在 Mac、iPhone 或 iPad 主動選擇「記住金鑰」時，金鑰會保存在本機 Keychain，供下次啟動使用，直到你從設定清除。重新啟用 AI 或切換供應商仍須明確同意傳送。回應與整理候選可保存在本機。API 費用由供應商另計，Pro 不包含額度。資料送出後的處理由所選供應商的條款及隱私政策管理。
- **Pro 購買：** 付款由 Apple 的 App Store 處理，App 使用 StoreKit 驗證購買權益。開發者不透過 App 取得你的信用卡或銀行付款資料。
- **主動聯絡：** 若你寄信求助，郵件地址、描述及自行附上的內容會用於回覆與處理問題。請勿寄送 API Key、NAS 密碼或不希望分享的私人圖片。

### 保留、刪除與控制

本機資料保留至你刪除相關內容、清除 App 資料或解除安裝；系統備份與自行匯出的副本須依各自儲存位置另行管理。移除書庫來源或相簿連結不等於刪除原始檔案。你可在系統設定撤回照片及檔案存取權限，停止 AI 使用並清除工作階段金鑰與已記住的本機 Keychain 金鑰；已送到供應商的資料須依其資料控制方式處理。

開發者無法代你讀取或刪除裝置上的私人書庫。若要處理曾寄給支援的資料，請來信說明；涉及必要的問題處理紀錄或依法須保留的資料，會於回覆中說明。政策變更會更新本段日期；新增資料用途仍須依實際功能提供相應告知與選擇。

## 原始碼授權與內容聲明

本 repository 已公開供檢視，**不採開源授權**。G.A.I 原創程式碼、文件與專案資產保留所有權利；除適用法律或託管平台條款允許的範圍外，未經書面許可，不授權使用、修改、再散布或販售。完整條款見 [LICENSE](LICENSE)。第三方元件仍依各自授權提供，包含 `src-tauri/vendor/wry/` 中保留的授權文件。

G.A.I 是讀取使用者自行提供內容的漫畫閱讀工具，不提供漫畫下載、來源站或任何第三方漫畫的使用權。請僅匯入你有權使用的內容。公開原始碼不代表 App 已上架；目前版本與商店驗收狀態請見上方 Current status。第三方元件的授權與 notices 見 [`docs/release/THIRD_PARTY_NOTICES.md`](docs/release/THIRD_PARTY_NOTICES.md)。

請勿將 API Key、NAS 密碼、Apple 簽章私鑰或私人書庫提交至 repository。開發時使用自己的帳號與簽章設定；安全問題請以電子郵件聯絡，勿在公開 issue 貼出憑證。

## Architecture

| Layer | Authority / role |
| --- | --- |
| `public/` | Tauri WebView UI、reader、catalog organizer、native bridge |
| `src-tauri/src/` | native backend：scanner、protocol、cache、catalog、file ops、AI session |
| SQLite (`catalog.sqlite3`) | catalog / metadata / location / progress 的本機權威資料 |
| Original comic files / sidecars | 預設只讀；不因整理或來源離線被自動改寫／刪除 |
| `src-tauri/tauri-plugin-ios-folder/` | iOS security-scoped folder / iCloud materialization bridge |
| `src-tauri/vendor/wry/` | iOS WebKit startup patch，受 Cargo patch 明確引用 |

### Reader cache

前端只保留有界的鄰近頁工作集；Rust 壓縮頁快取依裝置記憶體、process 可用記憶體與 OS memory pressure 動態調整，並以實際封存檔 entry bytes 決定 nearest-first page window。背景 preload 單頁最多 64 MiB，與正式 protocol 的單頁 serving safety limit 一致。完整契約見 [`docs/E6-E8-DECISIONS.md`](docs/E6-E8-DECISIONS.md)。

### Source lifecycle

- 進入目錄時只即時掃描該層的漫畫檔與子資料夾；全域掃描、收藏與最近閱讀各自維持背景優先通道。子資料夾可先導航，點入後再掃下一層。
- Local source ID 使用**使用者已配置的 root 字串**衍生，刻意保持來源拔除後仍可重現；不要在每次掃描時動態 canonicalize，否則同一 removable/NAS-backed source 可能在 online/offline 狀態得到不同 ID。若未來要改成 canonical identity，必須先把 resolved identity 持久化再做 migration。
- iOS external folder 使用 security-scoped bookmark；symlink 不可逃出使用者選擇的 root。
- 專案目前只支援**一組 SMB/NAS 設定**。要換 NAS 就更新設定並重新掃描，不維護多 NAS namespace。
- SMB 掃描與檔案操作均有 timeout；成功掃描才把 current NAS state 標 online，失敗則保留 SQLite location 並回填 offline shelf。
- offline 是 location 狀態，不代表 comic metadata 被刪除。

## 2026-09-04 hardening highlights

近期完整 audit 已修正：

- macOS 不再連結 Apple 標示 unavailable 的 `os_proc_available_memory()`；只有 iOS 使用該 advisory API。
- SMB connect/share/read/stat/rename/create-directory 都有 deadline，避免 NAS 異常時無限等待。
- SMB mutation 使用 typed `NotFound`、journal、版本前置條件與誠實 rollback 狀態。
- SMB-only library 與 cold-start offline shelf 由 SQLite 正確恢復。
- ZIP／CBZ、RAR／CBR、7z／CB7、folder scanner、protocol 同步拒絕 traversal、symlink、hidden/unsafe entry 與超大 page preload。
- iOS security-scoped bookmark 會正確釋放並先 resolve symlink 再驗授權 root。
- reader progress 由 SQLite 權威資料與 Tauri bridge 正規化，不讓 stale background refresh 倒退閱讀位置。
- mutable folder page URL 使用 `no-store`，刪頁後不會被 WebView 舊快取污染。
- catalog migration / backfill 不再混入每次 connection 的熱路徑。
- 舊 Electron / Express runtime 已在功能與 hardening 全部移到 Tauri 後正式退役。

## Quick start

```sh
npm ci
rustc --version
npm run quality
```

`npm run quality` 會執行：

1. Tauri-only Node regressions：UI/native packaging smoke、AI consent、release hardening。
2. `cargo fmt --check`。
3. `cargo test --locked --lib`。
4. `cargo clippy --locked --lib --bins --no-deps -- -D warnings`。

較快的日常功能驗證：

```sh
npm run verify
```

`package-lock.json` 現在只鎖 `@tauri-apps/cli` 與其平台 binary；沒有 Electron、Express 或舊 browser-server runtime dependencies。

`npm run build`、`test:rust` 與 `check:clippy` 會使用目前使用者的私人 Cargo cache（macOS：`~/Library/Caches/com.windsheep.gai/cargo`），確認目錄擁有者並限制權限為 700。保留明確的 `CARGO_TARGET_DIR` 覆寫，但同樣檢查擁有者與權限；不再使用固定共享 `/tmp` 路徑。直接執行 Cargo 時可用 `node scripts/with-private-cargo-cache.mjs cargo <參數>`。incremental compilation 仍關閉，避免外接磁碟／NAS 的 lock 問題。

## Development & builds

```sh
# Tauri 開發版
npm run tauri dev

# 正式 macOS app / DMG
npm run build

# iOS/iPadOS
npm run tauri ios build
```

iOS/iPadOS 有額外的本機檔案系統、Xcode、簽名與實機驗證要求，請依 [`BUILD_GUIDE.md`](BUILD_GUIDE.md) 操作；不要從歷史 blocker 文件複製舊路徑或假設舊磁碟狀態仍成立。

## Data & privacy boundaries

- 原始漫畫、sidecar 與 NAS 內容預設不由 catalog organizer 自動覆寫。
- 使用者人工 metadata 永遠高於 importer / AI candidate。
- API key 預設只保留目前 App session；macOS／iOS／iPadOS 可經使用者明確選擇存入本機 Keychain。不寫入 SQLite、localStorage、log 或 metadata export。
- OpenAI 與 Google AI 都是選用功能；正式 Tauri UI 在建立 session 前會指出選定頁面影像與 prompt 可能送往所選第三方 provider，並要求 explicit consent。
- 切換 AI provider 會撤銷前一次同意並要求重新確認。
- 書本外的「AI 掃描」最多取樣開頭三頁與全書 40%、50%、60% 位置，合併成一次請求；短篇會去除重複頁。摘要跟隨介面語言，AI 回傳只做頁面說明或可人工審核的 metadata candidate，不直接覆寫人工資料。

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
├── docs/
│   ├── release/             # canonical App Store / TestFlight preparation and notices
│   ├── E6-E8-DECISIONS.md   # durable architecture / release decisions
│   └── RUST-QUALITY.md      # local Rust / release quality contract
├── public/                  # Tauri WebView frontend
├── scripts/release/         # local-only release metadata guard
├── src-tauri/               # Tauri / Rust application
├── tests/                   # Tauri-only Node regression suite
├── BUILD_GUIDE.md
├── DESIGN.md
├── PRODUCT.md
├── README.md
├── package.json
└── package-lock.json
```

## Documentation authority

### Current source of truth

- [`PRODUCT.md`](PRODUCT.md) — durable product scope and exclusions。
- [`DESIGN.md`](DESIGN.md) — current design / UX contract。
- [`docs/E6-E8-DECISIONS.md`](docs/E6-E8-DECISIONS.md) — durable technical and release decisions。
- [`docs/RUST-QUALITY.md`](docs/RUST-QUALITY.md) — Rust 1.98.1 local quality gate and native trust boundaries。
- [`BUILD_GUIDE.md`](BUILD_GUIDE.md) — current Tauri macOS / iOS build workflow。
- [`docs/release/`](docs/release/) — current TestFlight / App Store metadata and outstanding evidence。

### Historical evidence

私人書庫與裝置的歷史驗收紀錄僅留在本機，不隨公開 repository 提供。公開文件以目前程式碼與可重複的驗證方式為準。

## Tauri-only policy

- 不重新加入 Electron、Express、browser HTTP fallback 或第二套 native backend。
- 不新增 `main.js`、`preload.js`、`server.js`、Electron Builder packaging config 或對應 runtime dependencies。
- 新能力直接落在 `src-tauri/` 與 `public/`。
- 如果某個功能在 Tauri 上缺能力，應修 Tauri bridge / Rust command，而不是復活舊 runtime。

## Release gate

發行資料來源：

- [`docs/release/gai-app-store-connect-metadata.json`](docs/release/gai-app-store-connect-metadata.json) — canonical release metadata。
- [`docs/release/app-store-connect-ios-metadata.md`](docs/release/app-store-connect-ios-metadata.md) — 人讀版審查包。
- [`scripts/release/asc-dry-run.sh`](scripts/release/asc-dry-run.sh) — **local-only** metadata / secret / TODO gate；本身不提交版本。

任何 signed artifact、實機資訊、API key、NAS 密碼或真實裝置 identifier 都不應提交進 repository。

## Repository policy

- `main` 是唯一正式 branch。
- 不建立 feature / release branch 作為長期狀態。
- 直接進 `main` 的變更必須保持 `npm run quality` 可重跑。
- GitHub Actions 在額度不可用期間不作為 release gate；恢復 CI 前先確認額度與 runner 可實際執行，再重新建立 workflow。
- 私人驗收紀錄留在 Git 忽略的本機目錄，不提交到公開 repository。
- 不提交 build artifacts、runtime cache、Impeccable local/session state 或 secrets。
