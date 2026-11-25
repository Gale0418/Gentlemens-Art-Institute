# G.A.I App Store Connect／TestFlight 發行資料與審查包

2026-11-25 已回讀 iPhone／iPad 與 Mac 的 1.0.7 (90) 均為 `READY_FOR_DISTRIBUTION`。現行上架版本與內購文案狀態見 [App Store Connect 回讀紀錄](gai-app-store-connect-metadata.json) 的 `currentDistributionReadback`，正式商店文案見 [商店在地化資料](store-localizations.json)。

本文件保留 1.0.2／1.0.3 時期的發行資料、草稿和證據清單。歷史套件的本機檢查仍為 `BLOCKED（local evidence）`，僅適用當時的準備紀錄。`scripts/release/asc-dry-run.sh` 做本機 JSON、欄位和秘密掃描，並依該套件的 `activeEvidence` 判定。提交到 repo 的紀錄應排除 App Store Connect 私密資料、API Key、SMB 密碼及實機識別碼。

只有八項 active evidence 全部具備 `VERIFIED`、`verifiedAt`、`evidenceRef`，八個固定 TestFlight gate 項目完整且唯一、七類 review category 完成，且 App Privacy questionnaire 沒有佔位文字時，才可進入 READY；parser 只驗證紀錄形狀，不能自動證明外部事實，仍需人工核對。

## 2026-11-02 歷史遠端回讀

- iOS 1.0.2（build 63）：processing `VALID`、`READY_FOR_DISTRIBUTION`，review `COMPLETE`，無遠端 blocking issue。
- macOS 1.0.2（build 59）：processing `VALID`、`READY_FOR_DISTRIBUTION`，review `COMPLETE`，無遠端 blocking issue。
- IAP `com.windsheep.gai.pro.v1`：`APPROVED`，台灣基準價格回讀為 TWD 150；購買、恢復、離線權益與撤銷仍需實機證據。
- iOS 的 zh-Hant／en-US／ja 截圖集合回讀為 `COMPLETE`；macOS 截圖本輪未獨立回讀。
- Age Rating 有 declaration；ASC App Privacy 頁面唯讀回讀約一個月前已發布，聲明 1 種「照片或影片」資料用於 App 功能且與使用者身分連結，隱私政策指向 README `#隱私政策`；1.0.3 真實行為與第三方資料流仍未對照驗證。build 63 回讀 `usesNonExemptEncryption=false`，但加密 declaration 為 `CREATED` 且與 build 63 的關聯尚未確認。

1.0.0／build 42 與早期 macOS 1.0 首發失敗資料已移至 canonical JSON 的 `historical` 區段，僅供追溯，不代表目前版本狀態。

1.0.3 在當時的紀錄中仍屬本機準備，JSON 標為 `BLOCKED`，未取得該版本的 ASC version/build 回讀。

## 現行商業政策

現行收費政策見[monetization.md](monetization.md)：閱讀、本機與已掛載／直接 SMB NAS、標籤（含批次）、手動整理、重複候選檢查、資料匯出，以及產品實際提供的撤銷與復原功能免費；只有選用的雲端 AI 翻譯、解說與整理建議需要一次買斷 AI Pro。AI Pro 可由同一個 App Store Apple 帳號在 Mac、iPhone 與 iPad 共用；Mac AI Pro 需要 macOS 12 或更新版本。使用者自備 API Key，供應商費用另計。

產品實際提供的撤銷／復原、資料匯出與權益變更前仍可用的 AI 結果不以付費封鎖；不得暗示所有手動操作都能撤銷，也不保證所有 AI 結果均持久保存或可匯出。AI 僅走使用者自備金鑰（BYOK）的雲端路徑，不提供內含 API 額度。AI Pro 是首發版本的買斷範圍，不承諾所有未來新增功能永久免費；已購得的 AI Pro 權益必須在後續支援版本中保留。正式支援資訊見[根目錄 SUPPORT.md](../../SUPPORT.md)。

現行商品 ID 為 `com.windsheep.gai.pro.v1`。售價由當地 App Store 顯示。購買、恢復、離線權益和退款／撤銷證據依各次實測紀錄確認，TestFlight 沙盒權益只用於測試。

## 已知發行身分

| 欄位 | 值 | 證據／備註 |
| --- | --- | --- |
| 產品名稱 | 紳士藝術研究所 Gentlemen's Art Institute | `PRODUCT.md`、Tauri 設定 |
| Bundle ID | `com.windsheep.gai` | `package.json`、`src-tauri/gen/apple/project.yml` |
| 平台 | iOS／iPadOS | Tauri 產生的 iOS target |
| 最低 OS | iOS 15.0 | `src-tauri/gen/apple/project.yml`；仍須以 processed build 回讀確認 |
| Rust release toolchain | `1.98.1` | `rust-toolchain.toml`、`src-tauri/Cargo.toml`、本機品質檢查 |
| App Store Connect App ID | `6809937717` | canonical JSON 既有回讀紀錄 |
| Marketing version／Build | `1.0.2`／processed build `63` | ASC 回讀為 `VALID`；本機 signed artifact hash 與實機錄影仍待補 |
| 隱私政策 URL | README 隱私政策段落；公開回讀 `TODO` | 使用者指定 README，不另架站；推送後驗證 GitHub main 公開連結 |
| 支援 URL／聯絡方式 | URL 待發布；公開支援信箱 `coderb0418@gmail.com` | 依使用者指定參考 MediBuddy 上架文件第 57 行；尚未寄信 |

## Store Listing 草案

App Name（zh-Hant-TW）：`紳士藝術研究所`

首發規劃包含繁體中文、英文（en-US）與日文（ja）；英文名稱為 `Gentlemen's Art Institute`。既有三語文案同步是歷史回讀紀錄，不能視為本輪 source changes 已上傳；隱私／支援 URL 與審查素材仍待補齊。

Subtitle：`專門整理本機漫畫的好用閱讀器`

Promotional Text：`漫畫散落在資料夾和壓縮檔，找書找得像在考古？G.A.I 幫你整理自有收藏，條漫、單頁、雙頁都能看。v1 Pro 一次買斷 NT$150，沒有訂閱。App 不附漫畫、不提供下載。`

Keywords：`CBZ,CBR,ZIP,RAR,7z,CB7,條漫,雙頁,相簿,圖集,看圖,NAS,SMB,自炊,離線,書庫,匯入,標籤`

Description 草案以 canonical JSON 為準，定位是圖片資料夾與 ZIP／CBZ、RAR／CBR、7z／CB7 的本機／NAS 漫畫書架與閱讀器。必須如實保留以下邊界：App 不內建漫畫、不提供來源爬取或下載站；SMB 是使用者明確設定的進階路徑；AI 是選用功能，不得描述成核心必需或完全本機。使用者對匯入內容的權利與合法使用負責。

## Guideline 2.1 App Review Notes 草案

以下英文可在實機錄影與最終 build 證據完成後貼入 Notes；方括號 `TODO` 未補齊前不可送出。不要用缺少附件的宣稱，也不要把真實 SMB credentials 放在 Notes。

```text
REVIEW VIDEO
A screen recording from a physical [TODO: device model] running iOS [TODO: OS version] is attached as [TODO: exact filename]. It starts from TestFlight build [TODO: version (build)], opens the built-in all-ages landscape demo on a clean install, demonstrates the library and image reader, and returns to Settings. The exact eight-group, 13-image demo contents must be verified against the final submitted package. The recording contains no real personal data, passwords, private NAS paths, or unlicensed review material.

TEST DEVICES AND OPERATING SYSTEMS
- Physical device: [TODO: iPhone/iPad model], iOS [TODO: version], app [TODO: version (build)].
- The minimum supported operating system is iOS 15.0; confirm this against the processed build.
- Additional simulator or desktop checks, if mentioned, are supplementary and do not replace the physical-device recording.

APP PURPOSE AND TARGET AUDIENCE
Gentlemen's Art Institute (紳士藝術研究所) is a general-purpose local-first comic library and reader for people managing their own files on iPhone or iPad. It indexes and reads user-selected image folders and ZIP/CBZ, RAR/CBR, and 7z/CB7 archives, keeps reading progress and catalog data locally, and can read from a user-selected mounted folder or optional SMB/NAS connection. It is not a medical, diagnostic, emergency, professional-advice, social, or content-hosting service.

ACCESS AND SETUP
The one-time AI Pro purchase unlocks only optional cloud AI translation, commentary, and organization suggestions. Reading, local and system-mounted sources (including mounted NAS folders), direct SMB/NAS connections, tagging including batch tagging, manual organization, duplicate-candidate review, data export, and the undo or recovery actions explicitly supported by the app are free. Do not imply that every manual action can be undone. No subscription or API quota is included. AI requires a user-supplied API key, and the provider bills API usage separately. The same App Store Apple Account can share AI Pro across Mac, iPhone, and iPad; AI Pro on Mac requires macOS 12 or later. On a clean install, open the clearly labeled built-in all-ages landscape demo with eight groups and 13 images; use the build under review to verify the exact demo contents. No purchase, demo credential, NAS, or external sample download is required to review the free reader. Direct SMB and optional AI are disclosed rather than hidden, but are not required for the free core review path.

EXTERNAL SERVICES AND TOOLS
Core indexing, reading, catalog data, and progress run locally. A user-selected SMB/NAS server is contacted only when the user configures it and requests a scan or read. Optional AI is disabled by default, cloud-only, and requires a user-supplied API key. The launch specification includes no on-device model and no bundled API quota. OpenAI requests use https://api.openai.com/v1/responses; Google requests use https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent. Before either provider can be enabled, the app identifies the selected provider, states that selected page images (up to six for AI Scan) and the prompt may be sent to that provider, and requires explicit in-app consent for that session. Changing the provider revokes the previous consent and requires a new confirmation. API keys are held for the app session by default; iOS/iPadOS users may explicitly save a key in the device Keychain. A saved key does not restore consent and keys are not included in review material; AI responses/candidates may remain in local App Data. The core reader does not require AI, analytics, advertising, third-party login, or an app-owned content server.

REGIONAL AVAILABILITY
There is no planned region-specific catalogue or core feature difference. The primary interface is Traditional Chinese (Taiwan). SMB and optional AI availability can depend on the user's network, region, account, and provider terms; neither is required for the core reader.

REGULATED INDUSTRY / PROTECTED CONTENT
Not applicable as a regulated service: the app provides no medical, diagnostic, emergency, financial, or other professional advice. The app does not bundle third-party comics or provide a source crawler/downloader, but it can display files selected by the user, including material for which the user must have appropriate rights. The attached recording uses only the bundled original all-ages landscape demo. Age rating, rights declarations, and App Privacy answers are based on the actual release build and distribution library and are [TODO: complete before submission].
```

## 實機錄影腳本

1. 在實體 iPhone／iPad 開始錄影，顯示實際提交 build 啟動；不要用模擬器或桌面版代替。
2. 顯示安全的 reviewer library 與主要導覽，不要露出私人檔案路徑、通知、帳號、NAS 密碼或真實識別資料。
3. 直接開啟清楚標示的內建全年齡示範；核心審查路徑不需要 NAS、密碼或額外下載。
4. 開啟內建八組、13 張風景示範，展示實際最終包中存在的翻頁與閱讀控制；不要沿用先前的舊示範作為版本證據。
5. 展示搜尋、收藏、閱讀進度與設定。只展示已在此 build 驗證的功能。
6. 若要展示 AI，先拍到它是選用功能，再展示所選 provider、頁面影像／prompt 傳輸揭露與 explicit consent；頁面與 prompt 必須是合成或已授權內容。切換 provider 後要拍到 consent 被撤銷並重新確認。若 release notes 尚未宣告 provider path，就不要臨時展示 AI。
7. 若示範 direct SMB，必須說明伺服器由使用者選擇，只顯示 disposable review share，並確認核心閱讀器也能使用本機或已掛載資料夾；否則本輪略過此選用流程。
8. 若最終包已完成 StoreKit，另驗證 Pro 購買、恢復、離線權益與 revocation／退款後收回；TestFlight 沙盒權益不得流入正式環境。
9. 結束後檢查影片可播放、文字可讀、實體裝置證據連續，且沒有 secrets、私人 metadata、未授權或不適合審查的素材。

## 七類資訊核對表

| 類別 | 目前狀態 | 送審前證據 |
| --- | --- | --- |
| 實機錄影 | `TODO` | 實體裝置、實際 build、可播放檔名 |
| 裝置／OS | 部分已知 | processed iOS 1.0.2（63）有效；實機型號／OS／錄影證據仍為 `TODO` |
| 目的與對象 | 草案完成 | `PRODUCT.md` 與最終 listing |
| 設定與操作 | 草案完成 | 本機／掛載 NAS 流程，SMB credentials 另行安全提供 |
| 外部服務 | 草案完成，待 release build 確認 | SMB 使用者端點；可選 OpenAI／Google AI 的資料路徑、provider 揭露與 explicit consent |
| 商業模型／IAP | StoreKit 已整合；ASC 商品回讀為 `APPROVED`、台灣基準價格 TWD 150；交易、撤銷與實機完整驗收仍待完成 | 最終包可驗證購買、恢復、離線權益與 revocation；不得把遠端商品核准當成本機交易證據 |
| 區域差異 | 草案完成，待確認 | 主要語系、商店區域與 provider availability |
| 受管制／受保護內容 | 需主人決策 | reviewer sample 權利、App Privacy、export compliance；Age Rating 有 declaration 但仍須核對最終分發資料 |

## TestFlight-first Gate

- [x] 取得 numeric App Store Connect App ID、marketing version、processed build 與 version/build IDs；iOS 1.0.2（63）與 macOS 1.0.2（59）已記錄於 canonical JSON。
- [ ] 產出 signed IPA／archive，保存 artifact SHA-256 與 Apple processing readback；不把 artifact 或秘密放進 repo。
- [ ] 在實體裝置安裝同一 processed build，跑完整錄影腳本。
- [ ] 用安全授權 sample 驗證本機／掛載 NAS 匯入、閱讀、離線保留；若宣傳 direct SMB，再測 disposable share、斷線、timeout 與清除設定。
- [ ] 若宣傳可選 AI，驗證預設關閉、手動觸發、OpenAI／Google provider-specific disclosure、explicit consent、provider 切換重新同意、預設 session-only 與 iOS Keychain 選用保存／清除、候選人工審核；不要提交真實 key、頁面或回應。
- [ ] 核對 App Privacy、Age Rating、export compliance 與 reviewer rights；截圖／icon／授權 notices／地區 localization 仍需對最終包完成證據閉環。
- [ ] 由帳號持有人檢視並接受 ASC App list 顯示的 Developer Program 協議更新；未接受前不得更新或送審。
- [ ] 先跑 `npm run verify` 與 `scripts/release/asc-dry-run.sh`；之後由主人在自己的已驗證環境執行 `asc validate ... --dry-run`／對應 review dry-run，逐項核對輸出。
- [ ] 只有 `activeEvidence` 全部完成且主人在 action-time 審閱後，才可考慮任何 `--confirm` 或提交操作。

## 目前不可代填的欄位

實機錄影附件、App Privacy questionnaire、export compliance 與 reviewer sample 的權利／分級仍明確保留 `TODO`；App ID、version／build／version ID／build ID 已由 2026-11-02 遠端唯讀回讀填入。這些未解項不能從本機推測，也不能為了讓審查通過而省略實際存在的 SMB 或可選 AI 行為。
