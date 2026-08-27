# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要使用者是擁有大量本機或 NAS 漫畫收藏、需要在 Mac 與 iPad 上整理及閱讀的個人收藏者。核心工作是快速找到、批次整理並可靠閱讀數千本缺少結構化詮釋資料的漫畫。

## Product Purpose

少女漫畫閣是一套 local-first、NAS-first 的私人漫畫書架與閱讀器。成功代表使用者不必搬動或改寫原始漫畫檔，也能為大量收藏建立可搜尋、可維護且離線仍保留的整理資料。

## Positioning

以本機 SQLite 作為權威資料庫，將瀏覽器直載、資料夾、ZIP/CBZ 與多種既有漫畫 metadata 格式統一成可人工覆寫的收藏目錄；NAS 暫時離線時仍保留完整整理成果。

## Operating Context

- 漫畫主要來自本機資料夾、外接裝置與 SMB NAS。
- 現有收藏多數沒有 sidecar，檔名也不足以可靠推斷作者或標籤。
- 使用者會在書架內多選漫畫、批次套用標籤、建立資料夾繼承規則，並以作者、系列、語言與標籤搜尋。
- 漫畫檔與 sidecar 預設只讀；整理資料寫入 App Local Data。

## Capabilities and Constraints

- 既有 Tauri 2、Rust 與 vanilla HTML/CSS/JavaScript 架構必須保留。
- 既有閱讀進度、收藏、單頁／雙頁／RTL／Webtoon／目錄模式、ZIP/CBZ、圖片資料夾與 SMB 行為不可退化。
- 首批 metadata 匯入涵蓋 ComicInfo.xml、gallery-dl JSON、HDoujin JSON/TXT、galleryinfo.txt、EHDL info.txt 與低信心檔名推測。
- 使用者覆寫永遠高於外部匯入；NAS 失聯不得刪除資料。
- 網路比對、AI 自動寫入、跨裝置同步與 RAR/CBR 內嵌解析不屬於目前里程碑。

## Brand Commitments

- 產品名稱為「少女漫畫閣」。
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

## Accessibility & Inclusion

整理模式需同時支援鍵盤、滑鼠與 iPad 觸控；互動元件要有可見焦點、狀態文字與足夠觸控尺寸。
