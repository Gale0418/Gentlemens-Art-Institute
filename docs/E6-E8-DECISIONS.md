# E6–E8 架構與發行決策

更新日期：2026-09-04

本文件只保留仍適用的 durable architecture / release decisions。特定日期的匯入數字、裝置狀態、磁碟空間與一次性 blocker 僅保留於本機私人紀錄，不應在這裡形成第二套現況來源。

## RAR／CBR 解碼邊界（COMIC-F6）

目前版本只把 `.rar`／`.cbr` 視為可索引、可讀相鄰 sidecar 的收藏項目，不宣稱能開啟內頁。ZIP／CBZ 的既有路徑保持不變。

後續解碼候選採 `libarchive`，不直接綁 RARLAB UnRAR：libarchive 公開列出 RAR 讀取、串流架構與 New BSD License，較容易同時覆蓋 macOS 與 iOS；RARLAB 的官方授權則包含不得用 UnRAR 重建 RAR 壓縮演算法的限制，需要額外法務與 App Store 分發確認。

正式啟用前必須另外通過：RAR4／RAR5、密碼檔、分卷、損壞檔、超大 entry、路徑穿越、解壓炸彈、iOS arm64 靜態連結、App Store 簽章與授權 notice。所有頁面必須按需串流並受單頁與單本位元組上限保護，不允許先把整本解壓到 RAM。

來源：[libarchive 功能與授權](https://www.libarchive.org/)、[libarchive COPYING](https://github.com/libarchive/libarchive/blob/master/COPYING)、[RARLAB 官方授權](https://www.rarlab.com/license.htm)。

## 快取契約（COMIC-K6）

現行快取是**有界工作集**，不是固定「前 5 頁／64 MiB」模型：

- WebView 預讀以目前頁為中心，`READER_PRELOAD_RADIUS = 10`，最多保留 20 個預載 image；Webtoon 只 eager 載入少量可見前頁，其餘按需要載入。
- Rust 壓縮頁快取依裝置實體記憶體、process 可用記憶體與 OS memory pressure 動態決定預算；裝置 tier 上限依序為 256 MiB、512 MiB、1 GiB，且仍受 process-safe budget 與全域 1 GiB ceiling 約束。
- Warning memory pressure 立即降預算；Critical 直接把壓縮頁快取預算降為 0。恢復到 Normal 時不一次吃回全部 RAM，而是逐步回升。
- ZIP 頁面選擇依實際 entry bytes 計算；小本在預算內可整本快取，大本則由目前頁開始 nearest-first 擴張，單一超大頁不會阻塞附近較小頁。
- `preload_generation`、reader generation 與 active comic lifecycle 隔離舊工作；切書、關書、來源切換與 memory pressure 會使舊快取失效或縮減。
- 封面與頁面協定仍必須先以漫畫 capability ID 驗證；NAS 離線不得刪除 SQLite metadata。
- 若未來加入持久縮圖，cache key 必須包含指紋版本、內容指紋、頁碼與縮圖器版本，並可整批失效；cache 永遠不是 metadata authority。

現行演算法以 `src-tauri/src/cache_policy.rs`、`src-tauri/src/state.rs` 與 `src-tauri/src/cache.rs` 為準。

## 版本化交換與衝突（COMIC-X7／COMIC-C7）

- 交換 envelope 固定帶 `schemaVersion`、`exportedAt` 與逐本穩定 UUID／唯一指紋。
- 匯入分成 preview 與 apply；未知版本、非唯一指紋與無法配對項目均拒絕自動套用。
- 本機手動欄位是預設勝者。只有呼叫端逐一提供衝突 key 的 `useIncoming` resolution，才可覆寫該欄位。
- Tag include／exclude 同樣以單本人工決策為最高權威；交換不搬漫畫檔、不寫 sidecar，也不開網路連線。

## OPDS／本機服務邊界（COMIC-O7）

OPDS 2.0 只作唯讀目錄交換：標題、作者、語言、修改時間、封面與使用者明確允許的 acquisition link。SQLite 仍是唯一 metadata authority，外部 OPDS 回應不得直接寫入覆寫表。

本機服務預設關閉且不開 port。未來啟用時必須由使用者指定介面（預設 loopback）、隨機高強度 token、TLS／可信區網提示、速率限制與一鍵撤銷；不得把 NAS 認證、絕對路徑或成人 tag 放入未授權 feed。規格媒體型別採 `application/opds+json`。

來源：[OPDS 2.0 官方規格](https://specs.opds.io/opds-2.0)。

## iPad／TestFlight／App Store 清單（COMIC-P8）

- 建置：正式發行必須使用 repo 鎖定的 Rust toolchain 與 release gate；目前為 Rust 1.98.1。
- 發行：TestFlight-first。signed install、processed build、實體裝置錄影與 App Store Connect 欄位以 `docs/release/` 的 canonical metadata / gate 為準；舊裝置或磁碟 blocker 僅保存在本機私人紀錄。
- 隱私：App Store Connect 與 App 內都要有隱私政策；明列線上服務／AI 傳送的資料、第三方、保存、刪除與撤回方式。
- 內容：App 只讀使用者自行匯入／連結的漫畫；不內建第三方來源爬取、商店、帳號或下載站。內建 reviewer demo 必須維持原創全年齡內容。
- 付費：依 PRODUCT.md 與 README，App 免費提供基本閱讀，v1 Pro 採非消耗型 App 內購買（non-consumable IAP）一次買斷。正式發行前，依實際上架 storefront 核對數位功能購買與外部連結適用的 App Review 規則並保留驗證紀錄。Reader App entitlement 只有確實提供對應的外部帳號／購買連結流程時才評估，不能只為了繞過 IAP 加入。
- 發行資產：iPad／iPhone 尺寸截圖、隱私標籤、支援／隱私 URL、年齡分級、第三方授權 notice、崩潰與離線 NAS 流程均須完成。

來源：[Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[Reader Apps 支援頁](https://developer.apple.com/support/reader-apps/)、[App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)。

## 可選線上服務契約（COMIC-S8）

線上來源比對、翻譯、同步與 OPDS server 各自預設關閉。啟用前要顯示實際 endpoint、將傳送的 metadata 欄位與撤銷方式，並記錄明確同意；停用後立即停止送出新請求。服務回傳只進 `metadata_candidates`／建議 Inbox，絕不直接寫 `user_field_overrides` 或 tag override。

艦載 AI 也是選用功能：API key 只保留本次 App session；正式 UI 在啟用 OpenAI 或 Google 前必須明確指出所選 provider，說明目前頁面影像與 prompt 可能離開裝置，取得 explicit consent 後才建立 AI session。切換 provider 會撤銷先前同意並要求重新確認。AI 只能提案或說明，不能直接覆寫人工 metadata。
