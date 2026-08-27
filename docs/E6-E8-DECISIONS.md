# E6–E8 架構與發行決策

更新日期：2026-08-26

## RAR／CBR 解碼邊界（COMIC-F6）

目前版本只把 `.rar`／`.cbr` 視為可索引、可讀相鄰 sidecar 的收藏項目，不宣稱能開啟內頁。ZIP／CBZ 的既有路徑保持不變。

後續解碼候選採 `libarchive`，不直接綁 RARLAB UnRAR：libarchive 公開列出 RAR 讀取、串流架構與 New BSD License，較容易同時覆蓋 macOS 與 iOS；RARLAB 的官方授權則包含不得用 UnRAR 重建 RAR 壓縮演算法的限制，需要額外法務與 App Store 分發確認。

正式啟用前必須另外通過：RAR4／RAR5、密碼檔、分卷、損壞檔、超大 entry、路徑穿越、解壓炸彈、iOS arm64 靜態連結、App Store 簽章與授權 notice。所有頁面必須按需串流並受單頁與單本位元組上限保護，不允許先把整本解壓到 RAM。

來源：[libarchive 功能與授權](https://www.libarchive.org/)、[libarchive COPYING](https://github.com/libarchive/libarchive/blob/master/COPYING)、[RARLAB 官方授權](https://www.rarlab.com/license.htm)。

## 快取契約（COMIC-K6）

- WebView 預讀最多保留 10 張，只保留目前頁附近；離開閱讀器會釋放 `src` 與 Map。
- Rust ZIP RAM 預載最多 5 頁／64 MiB，以 `preload_generation` 隔離舊工作；切書、關書與來源切換會清空。
- 封面與頁面協定回應可由 WebView 暫存一天，但所有路徑先以漫畫 capability ID 驗證；NAS 離線不會刪資料庫 metadata。
- 未來若加入持久縮圖，cache key 必須包含指紋版本、內容指紋、頁碼與縮圖器版本，並可整批失效；cache 永遠不是 metadata authority。

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

- 建置：unsigned arm64 先獨立通過；signed install、TestFlight 與提交由 `COMIC-D2` 的 Apple Account／profile 阻塞追蹤。
- 隱私：App Store Connect 與 App 內都要有隱私政策；明列線上比對／翻譯傳送的欄位、第三方、保存、刪除與撤回方式。
- 內容：App 只讀使用者自行匯入／連結的漫畫；不內建來源爬取、商店、帳號或下載站。若未來提供網路內容，需重新做分級、版權與審查評估。
- 付費：首選一次性付費的 App 本體；任何數位功能解鎖都要重新核對當時有效的 3.1 規則。Reader App entitlement 只有真的提供外部帳號／購買連結時才評估，不能為了繞過 IAP 先加。
- 發行資產：iPad 尺寸截圖、隱私標籤、支援／隱私 URL、年齡分級、第三方授權 notice、崩潰與離線 NAS 流程均須完成。

來源：[Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[Reader Apps 支援頁](https://developer.apple.com/support/reader-apps/)、[App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)。

## 可選線上服務契約（COMIC-S8）

線上來源比對、翻譯、同步與 OPDS server 四項各自預設關閉。啟用前要顯示實際 endpoint、將傳送的 metadata 欄位與撤銷方式，並記錄明確同意；停用後立即停止送出新請求。服務回傳只進 `metadata_candidates`／建議 Inbox，絕不直接寫 `user_field_overrides` 或 tag override。AI 只能提案，不能直接覆寫。
