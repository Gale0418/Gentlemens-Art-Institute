# G.A.I｜推薦文案與書架探索

狀態：本機草案，尚未更新商店或發送社群貼文。Gemini 提供文案，Codex 核對產品事實並校訂；第55版探索已完成兩平台原生驗收；第56版已覆蓋兩平台；TAG 探索的 Mac 原生驗收通過，iPad TAG 驗收待解鎖。

## 一句話推薦

**自己的漫畫，找得到、接著看。**

適合手邊已有漫畫檔、圖片資料夾或 NAS 收藏，想把「找一本」和「接著上次那頁」放在同一個書架的人。

- 找得到：搜尋、標籤與收藏；繼續閱讀遇到同名作品時附來源位置。
- 看得順手：單頁、雙頁與右至左、條漫，依作品切換。
- 接得回去：進度保存在當前裝置；來源離線仍保留已整理紀錄。未提供跨裝置自動同步。

## 第一次體驗

標題：找漫畫像考古？先翻一本。

說明：加入本機、外接硬碟或已掛載 NAS 的漫畫資料夾；也能先試讀原創風景圖集。

主動作：試讀原創風景。次動作：加入漫畫資料夾。

原創風景是操作示範。內建八組共十三頁，首組兩頁；示範不寫入私人閱讀進度。App 不提供漫畫下載或內容庫。

## 書架的小驚喜：隨手翻一本

點按後從目前來源、資料夾範圍與篩選條件的已載入作品挑一本，可包含子資料夾；搜尋沿用書架的目前來源搜尋範圍。略過離線項目；有其他候選時避免連續抽到同一本。回到書架保留原來的位置與篩選。沒有倒數、連續登入獎勵、音效、額外追蹤或強制推銷。

只在點按時挑選，不另起整庫掃描。來源與篩選沒有可讀作品時，按鈕停用或提示換個資料夾。第55版已覆蓋 Mac／iPad並完成抽選驗收。


### 第56版 TAG 探索（Mac 已驗收）

- 自選 TAG：選一個目前範圍內的標籤，再從符合的作品抽一本。
- 隨機 TAG：先等機率抽一個可用 TAG，再抽一本；有其他類型時避免連抽同一 TAG。
- 沒標籤時清楚提示並開啟標籤工具；不自動添加或接受 AI 猜測標籤。
- 背景讀取 SQLite 中的有效標籤，保留目前資料夾／篩選範圍；不重新掃漫畫檔。

## 商店文案草案

正式欄位見 [待發布 JSON](store-copy.proposed-2026-10-03.json)。沒有覆寫既有上傳紀錄，沒有上傳新文案。

### 副標題

本機漫畫圖集閱讀器，雙頁條漫隨心切換

### 宣傳文字

硬碟裡藏了一堆漫畫壓縮檔，每次找書都像在考古？不用手動解壓，加入資料夾立即閱讀。支援雙頁並排、日漫方向切換與直向條漫，當前裝置自動記住閱讀頁數，介面乾淨零廣告。

### 介紹

硬碟與資料夾裡塞滿 ZIP、CBZ、RAR 與 7z，每次想重溫一部作品，找書過程都像在翻考古遺跡？打開看圖工具不是排版跑掉，就是忘了上次看到第幾話。

《紳士藝術研究所》（Gentlemen's Art Institute）為本機漫畫收藏者而生，專心做好閱讀與整理：

【輕鬆開卷，排版由你選】
支援圖片資料夾、ZIP／CBZ、RAR／CBR、7z／CB7；選取包含檔案的資料夾即可開讀，不用先手動解壓。支援雙頁並排、左右閱讀方向切換，以及順暢向下捲動的連續條漫模式。

【進度清楚，同名不混淆】
閱讀器在當前裝置自動記住每本漫畫的閱讀頁數。「繼續閱讀」遇到同名作品，會附上來源位置，方便辨別不同版本。

【乾淨純粹，內容由你作主】
本程式不提供任何漫畫下載、線上爬蟲或內容庫。首次開啟內建原創風景圖集，供你無負擔測試翻頁與雙頁效果。

【核心功能免費，Pro 買斷升級】
• 基本閱讀完全免費：支援本機、外接硬碟與已掛載至系統的 NAS 資料夾，無第三方廣告、不強制註冊帳號。
• 首發 v1 Pro 一次買斷（無訂閱制，定價依商店顯示，已購功能於後續支援版本持續保留）：支援 App 內直連 SMB、批次標籤、進階整理與重複候選檢查。
• 選用智慧整理：自備 OpenAI 或 Google 金鑰，API 費用另計；各工作階段明確同意並主動使用後，才會依啟用功能傳送頁面與提示詞，整理建議經人工確認後才正式套用。

## PTT 草案

只在目標看板允許開發者介紹時使用；本稿尚未發送。

**[開發] 紳士藝術研究所：自幹本機漫畫閱讀器 (找書不再考古)**

各位好，我是開發者。硬碟裡本機漫畫一多，找書常像在考古，因此我替 Mac/iPad 寫了專用閱讀器《紳士藝術研究所》。

不用先手動解壓，支援雙頁並排、方向切換與垂直條漫，當前裝置自動記住閱讀進度。核心功能免費（支援本機與已掛載 NAS 資料夾），規劃中 v1 Pro 為買斷制（直連 SMB、批次標籤與進階整理；選用智慧輔助自備 Key 且費用另計）。

商店版目前正等待審核，新版本持續本機實測中。想向常看漫畫的朋友請教：
1. 包含大量圖檔的封存資料夾，上下滑動條漫是否順暢？
2. 繼續閱讀遇到同名作品時，候選項目的來源位置標記是否清楚？

專案進度與原始碼展示請見 GitHub：https://github.com/Gale0418/Gentlemens-Art-Institute （保留權利非開源，不提供現成安裝檔）。歡迎推文交流！

## Reddit 草案

本稿尚未發送。以開發者身分揭露關係，發布前查目標社群規則。[Reddit 官方 Spam 說明](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam) 明確提醒先確認各社群規定；不將所有社群當作允許宣傳。

**Building a native Mac/iPad comic reader so finding your archives doesn't feel like archaeology**

Hi everyone, I'm the developer of Gentlemen's Art Institute (G.A.I). Whenever I wanted to reread my local manga and comic archives, finding the right file inside nested folders always felt like digital archaeology. I built this reader for macOS and iPad to fix that.

It opens archive folders directly without manual extraction, featuring side-by-side dual pages, reading direction toggles, vertical webtoon scrolling, and local progress tracking on your current device.

The core reading experience is free (including local and system-mounted NAS folders). A planned v1 Pro one-time purchase will add in-app SMB connections, batch tagging, and advanced organization. Optional AI assistance requires your own API key with separate usage costs.

Build 44 is currently waiting for App Store review while internal testing continues on local builds. I’d love feedback on two real edge cases:
1. How smoothly does continuous vertical scrolling handle very large archive folders on your hardware?
2. In Continue Reading, does showing the relative path for duplicate titles clearly resolve version confusion?

Project status: https://github.com/Gale0418/Gentlemens-Art-Institute (rights reserved, not an open-source release or ready-to-run installer).

## 實機展示腳本（待拍攝）

【待拍攝 18 秒實機腳本】全程使用原創風景圖像與自備測試圖檔，不演示未核驗之付費流程。
[00:00-00:06 內建圖集展示] 開啟空書架，點擊「試讀原創風景」，直接載入內建 2 頁 mountains 原創風景圖集，展示無需選檔即可開卷。
[00:06-00:11 排版模式切換] 在閱讀器內切換雙頁並排與日漫方向翻頁，隨即切換至垂直條漫模式流暢上下滑動展示版面適配。
[00:11-00:18 進度記憶分鏡（另拍自備圖集）] （因內建示範圖集設計不保留進度快照，此段另拍自備 3 頁風景測試資料夾示範）：加入自備資料夾並讀至第 2 頁後返回書架；書架卡片顯示第 2 頁進度，再次點開即精確回到第 2 頁接續閱讀。

另拍攝探索入口：在自有風景測試書架按「隨手翻一本」，開讀後返回，再點選可見另一候選。未拍攝前不把腳本稱為影片，不使用私人漫畫或置換後的假介面。

## 推薦界線與發布狀態

截至2026-10-03的回讀，商店1.0仍是44版WAITING_FOR_REVIEW；本機第55版探索已驗收，第56版已覆蓋兩平台，TAG 探索已完成 Mac 驗收，iPad TAG 實機驗收待解鎖。完整StoreKit交易、Privacy UI確認、公開Mac簽署／公證及新版上傳重送仍待完成。

基本閱讀免費；首發v1 Pro規格是一次買斷，AI自備金鑰且費用另計。已透過系統掛載的NAS資料夾屬免費路徑。已購v1權益在後續支援版本保留，未承諾所有未來新功能永久免費。

本輪不做「絕不卡」、自動跨頁辨識、完全不占快取、所有內容絕不離開裝置、NAS離線能讀所有原始頁面，或已公開可下載的承諾。

商店欄位依 [Apple 產品頁說明](https://developer.apple.com/app-store/product-page/) 核對：副標題30字元、宣傳文字170字元；關鍵字官方上限100字元，本稿另保守檢查UTF-8不超過100bytes。這些是長度檢查，不代表Apple核准。

