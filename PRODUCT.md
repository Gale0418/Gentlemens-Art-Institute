# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Tauri 2 native app：macOS + iPhone/iPadOS。

## Users

主要使用者是擁有大量本機或 NAS 漫畫收藏、需要在 Mac 與 iPad 上整理及閱讀的個人收藏者。核心工作是快速找到、批次整理並可靠閱讀數千本缺少結構化詮釋資料的漫畫。

## Product Purpose

紳士藝術研究所 Gentlemen's Art Institute 是一套 local-first、NAS-first 的私人漫畫書架與閱讀器。成功代表使用者不必搬動或改寫原始漫畫檔，也能為大量收藏建立可搜尋、可維護且離線仍保留的整理資料。

## Positioning

以本機 SQLite 作為權威資料庫，將本機資料夾、iOS security-scoped 外部資料夾、單一 SMB NAS、ZIP/CBZ 與多種既有漫畫 metadata 格式統一成可人工覆寫的收藏目錄；來源暫時離線時仍保留完整整理成果。

## Operating Context

- 漫畫主要來自本機資料夾、外接裝置與一組 SMB NAS；要換 NAS 就更新連線設定並重新掃描，不維護多 NAS namespace。
- 現有收藏多數沒有 sidecar，檔名也不足以可靠推斷作者或標籤。
- 使用者會在書架內多選漫畫、批次套用標籤、建立資料夾繼承規則，並以作者、系列、語言與標籤搜尋。
- 漫畫檔與 sidecar 預設只讀；整理資料寫入 App Local Data。

## Capabilities and Constraints

- **唯一 runtime 是 Tauri 2 + Rust + vanilla HTML/CSS/JavaScript**；Electron、Express 與 browser HTTP fallback 不屬於產品架構，也不應重新加入。
- 既有閱讀進度、收藏、單頁／雙頁／RTL／Webtoon／目錄模式、ZIP/CBZ、圖片資料夾與 SMB 行為不可退化。
- 首批 metadata 匯入涵蓋 ComicInfo.xml、gallery-dl JSON、HDoujin JSON/TXT、galleryinfo.txt、EHDL info.txt 與低信心檔名推測。
- 使用者覆寫永遠高於外部匯入；來源失聯不得刪除資料。
- 網路比對、AI 自動寫入、跨裝置同步、RAR/CBR 內嵌解析與多 NAS namespace 不屬於目前里程碑。
- 圖片讀取維持既有 byte-size 安全上限；目前不額外引入 decode 前的像素總量限制。

## Brand Commitments

- 產品名稱為「紳士藝術研究所 Gentlemen's Art Institute」。
- 保留深色主題系統（預設 Midnight，另有 Sakura／Ink／Aurora）、Archive Red（#ff3d54）主操作色、精緻但熟悉的工作型介面與繁體中文語氣。

## Evidence on Hand

- 現有產品介面與設計 tokens：`public/index.html`、`public/style.css`。
- 現有閱讀器與掃描流程：`public/app.js`、`src-tauri/src/scanner.rs`、`src-tauri/src/smb_scanner.rs`。
- 真實 NAS 樣本約五千本，絕大多數無 ComicInfo、JSON 或 TXT sidecar。

## Product Principles

- 本機權威，原檔只讀。
- 人工決定勝過自動猜測。
- 大型收藏操作必須批次、可撤銷且保持流暢。
- 離線是正常狀態，不是刪除訊號。
- 匯入器可替換，核心資料模型不綁特定網站。
- 單一路線優先：缺 native 能力時修 Tauri/Rust bridge，不建立第二套 runtime。

## 首發商業模式（交易驗收中）

首發採「基本閱讀免費＋v1 Pro 單次買斷」，不做訂閱，也不隨購買附送 API 額度。StoreKit 2 原始碼與權益檢查已整合，端到端交易與實機驗收仍待完成；以下是首發規格，不代表目前已可正式購買。

| 能力 | 免費基本版 | v1 Pro（一次買斷） |
| --- | --- | --- |
| 本機圖片、ZIP／CBZ、正常閱讀模式 | 包含 | 包含 |
| 閱讀進度、收藏、搜尋、基本標籤 | 包含 | 包含 |
| 資料匯出、基本復原，以及可撤銷／安全復原流程 | 包含 | 包含 |
| 透過系統檔案選擇器存取已掛載 NAS | 包含 | 包含 |
| 直接 SMB／NAS 連線 | — | 包含 |
| 批次標籤與進階整理 | — | 包含 |
| 重複候選 | — | 包含 |
| AI 解說與整理工具 | — | 包含 |

透過系統檔案選擇器取得的已掛載 NAS 路徑仍屬免費基本版；不能因為路徑位於 NAS 就粗暴鎖定。資料安全的 undo／復原、已產生的 AI 結果與資料匯出不以付費作為解鎖條件。AI 僅走使用者自備金鑰（BYOK）的雲端供應商路徑，不提供裝置端模型，也不保證供應商帳單或免費額度。

「v1 Pro」代表首發版本的功能範圍與一次買斷權益，不代表所有未來新增功能都永久免費。已購得的 v1 Pro 權益必須在後續支援的版本中保留，不因 v2 發布或日後新增訂閱方案而收回；新方案只能另行定義新增權益與遷移規則。正式發行前必須補齊 StoreKit 商品 ID、價格、購買／恢復、離線權益判定與撤銷驗證；TestFlight 應驗證完整功能與沙盒購買流程，沙盒權益不得流入正式環境。

## Accessibility & Inclusion

整理模式需同時支援鍵盤、滑鼠與 iPad 觸控；互動元件要有可見焦點、狀態文字與足夠觸控尺寸。
