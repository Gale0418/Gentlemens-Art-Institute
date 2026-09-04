# G.A.I App Store Connect／TestFlight 發行資料與審查包

狀態：`draft-blocked`。本文件的人讀版本對應 canonical JSON：`docs/release/gai-app-store-connect-metadata.json`。修改欄位時先更新 JSON，再同步本文件；不要把 App Store Connect 私密資料、API key、SMB 密碼或真實裝置識別碼提交到 repo。

本輪只準備資料與證據清單，不呼叫遠端 ASC、不提交版本。`scripts/release/asc-dry-run.sh` 只做本地 JSON／欄位／秘密掃描與命令模板輸出。

## 已知發行身分

| 欄位 | 值 | 證據／備註 |
| --- | --- | --- |
| 產品名稱 | 紳士藝術研究所 Gentlemen's Art Institute | `PRODUCT.md`、Tauri 設定 |
| Bundle ID | `com.windsheep.gai` | `package.json`、`src-tauri/gen/apple/project.yml` |
| 平台 | iOS／iPadOS | Tauri 產生的 iOS target |
| 最低 OS | iOS 14.0 | `src-tauri/gen/apple/project.yml`；仍須以 processed build 回讀確認 |
| Rust release toolchain | `1.98.1` | `rust-toolchain.toml`、`src-tauri/Cargo.toml`、GitHub Actions |
| App Store Connect App ID | `TODO: 從 ASC 取得數字 App ID` | 不捏造 |
| Marketing version／Build | `TODO` | 以實際上傳並 processed 的 artifact 回讀 |
| 隱私政策 URL | `TODO` | 不捏造 URL |
| 支援 URL／聯絡方式 | `TODO` | 不捏造聯絡資訊 |

## Store Listing 草案

App Name（zh-Hant-TW）：`紳士藝術研究所`

英文名稱候選：`Gentlemen's Art Institute`；只有真的建立英文 localization 後才填入。

Subtitle：`本機與 NAS 漫畫書架閱讀器`

Promotional Text：`整理自己的漫畫收藏，離線也能安心閱讀。`

Keywords：`漫畫,閱讀器,書架,本機,NAS,SMB,收藏`

Description 草案以 canonical JSON 為準，定位是本機／NAS 漫畫書架與閱讀器。必須如實保留以下邊界：App 不內建漫畫、不提供來源爬取或下載站；可讀取使用者選擇的本機／掛載資料夾與 ZIP／CBZ；SMB 是使用者明確設定的進階路徑；AI 是選用功能，不得描述成核心必需或完全本機。使用者對匯入內容的權利與合法使用負責。

## Guideline 2.1 App Review Notes 草案

以下英文可在實機錄影與最終 build 證據完成後貼入 Notes；方括號 `TODO` 未補齊前不可送出。不要用缺少附件的宣稱，也不要把真實 SMB credentials 放在 Notes。

```text
REVIEW VIDEO
A screen recording from a physical [TODO: device model] running iOS [TODO: OS version] is attached as [TODO: exact filename]. It starts from TestFlight build [TODO: version (build)], opens the built-in all-ages demo on a clean install, demonstrates the library and image reader, and returns to Settings. The recording contains no real personal data, passwords, private NAS paths, or unlicensed review material.

TEST DEVICES AND OPERATING SYSTEMS
- Physical device: [TODO: iPhone/iPad model], iOS [TODO: version], app [TODO: version (build)].
- The minimum supported operating system is iOS 14.0; confirm this against the processed build.
- Additional simulator or desktop checks, if mentioned, are supplementary and do not replace the physical-device recording.

APP PURPOSE AND TARGET AUDIENCE
Gentlemen's Art Institute (紳士藝術研究所) is a general-purpose local-first comic library and reader for people managing their own files on iPhone or iPad. It indexes and reads user-selected image folders and ZIP/CBZ archives, keeps reading progress and catalog data locally, and can read from a user-selected mounted folder or optional SMB/NAS connection. It is not a medical, diagnostic, emergency, professional-advice, social, or content-hosting service.

ACCESS AND SETUP
No account, registration, login, purchase, subscription, demo credential, NAS, or external sample download is required. On a clean install, open the clearly labeled built-in all-ages demo card to read the bundled original three-page sample. The sample is isolated from the user's SQLite catalog, favorites, and reading history. Direct SMB and user-selected folders are optional advanced paths and are not required for review.

EXTERNAL SERVICES AND TOOLS
Core indexing, reading, catalog data, and progress run locally. A user-selected SMB/NAS server is contacted only when the user configures it and requests a scan or read. Optional AI is disabled by default and requires a user-supplied API key. OpenAI requests use https://api.openai.com/v1/responses; Google requests use https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent. Before either provider can be enabled, the app identifies the selected provider, states that the current page image and prompt may be sent to that provider, and requires explicit in-app consent for that session. Changing the provider revokes the previous consent and requires a new confirmation. API keys are held for the app session and are not included in review material; AI responses/candidates may remain in local App Data. The core reader does not require AI, analytics, advertising, third-party login, or an app-owned content server.

REGIONAL AVAILABILITY
There is no planned region-specific catalogue or core feature difference. The primary interface is Traditional Chinese (Taiwan). SMB and optional AI availability can depend on the user's network, region, account, and provider terms; neither is required for the core reader.

REGULATED INDUSTRY / PROTECTED CONTENT
Not applicable as a regulated service: the app provides no medical, diagnostic, emergency, financial, or other professional advice. The app does not bundle third-party comics or provide a source crawler/downloader, but it can display files selected by the user, including material for which the user must have appropriate rights. The attached recording uses only the bundled original all-ages demo. Age rating, rights declarations, and App Privacy answers are based on the actual release build and distribution library and are [TODO: complete before submission].
```

## 實機錄影腳本

1. 在實體 iPhone／iPad 開始錄影，顯示實際提交 build 啟動；不要用模擬器或桌面版代替。
2. 顯示安全的 reviewer library 與主要導覽，不要露出私人檔案路徑、通知、帳號、NAS 密碼或真實識別資料。
3. 直接開啟清楚標示的內建全年齡示範；核心審查路徑不需要 NAS、密碼或額外下載。
4. 閱讀內建原創三頁短篇，展示實際 build 中存在的翻頁與閱讀控制。
5. 展示搜尋、收藏、閱讀進度與設定。只展示已在此 build 驗證的功能。
6. 若要展示 AI，先拍到它是選用功能，再展示所選 provider、頁面影像／prompt 傳輸揭露與 explicit consent；頁面與 prompt 必須是合成或已授權內容。切換 provider 後要拍到 consent 被撤銷並重新確認。若 release notes 尚未宣告 provider path，就不要臨時展示 AI。
7. 若示範 direct SMB，必須說明伺服器由使用者選擇，只顯示 disposable review share，並確認核心閱讀器也能使用本機或已掛載資料夾；否則本輪略過此選用流程。
8. 結束後檢查影片可播放、文字可讀、實體裝置證據連續，且沒有 secrets、私人 metadata、未授權或不適合審查的素材。

## 七類資訊核對表

| 類別 | 目前狀態 | 送審前證據 |
| --- | --- | --- |
| 實機錄影 | `TODO` | 實體裝置、實際 build、可播放檔名 |
| 裝置／OS | 部分已知 | 最低 iOS 14.0；實機型號／OS／processed build `TODO` |
| 目的與對象 | 草案完成 | `PRODUCT.md` 與最終 listing |
| 設定與操作 | 草案完成 | 本機／掛載 NAS 流程，SMB credentials 另行安全提供 |
| 外部服務 | 草案完成，待 release build 確認 | SMB 使用者端點；可選 OpenAI／Google AI 的資料路徑、provider 揭露與 explicit consent |
| 區域差異 | 草案完成，待確認 | 主要語系、商店區域與 provider availability |
| 受管制／受保護內容 | 需主人決策 | reviewer sample 權利、年齡分級、App Privacy、export compliance |

## TestFlight-first Gate

- [ ] 取得 numeric App Store Connect App ID、marketing version、processed build 與 version/build IDs。
- [ ] 產出 signed IPA／archive，保存 artifact SHA-256 與 Apple processing readback；不把 artifact 或秘密放進 repo。
- [ ] 在實體裝置安裝同一 processed build，跑完整錄影腳本。
- [ ] 用安全授權 sample 驗證本機／掛載 NAS 匯入、閱讀、離線保留；若宣傳 direct SMB，再測 disposable share、斷線、timeout 與清除設定。
- [ ] 若宣傳可選 AI，驗證預設關閉、手動觸發、OpenAI／Google provider-specific disclosure、explicit consent、provider 切換重新同意、session-only key、候選人工審核；不要提交真實 key、頁面或回應。
- [ ] 補齊隱私政策 URL、支援 URL／聯絡方式、App Privacy、Age Rating、export compliance、截圖、icon、授權 notices 與地區 localization。
- [ ] 先跑 `npm run verify` 與 `scripts/release/asc-dry-run.sh`；之後由主人在自己的已驗證環境執行 `asc validate ... --dry-run`／對應 review dry-run，逐項核對輸出。
- [ ] 只有所有 TODO 完成且主人在 action-time 審閱後，才可考慮任何 `--confirm` 或提交操作。

## 目前不可代填的欄位

App ID、version／build／version ID／build ID、實機錄影附件、隱私政策與支援 URL、聯絡方式、App Privacy questionnaire、Age Rating、export compliance、reviewer sample 的權利與分級，均明確保留 `TODO`。這些值不能從本機推測，也不能為了讓審查通過而省略實際存在的 SMB 或可選 AI 行為。
