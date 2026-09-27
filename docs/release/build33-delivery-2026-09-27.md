# build 33 交付與實機驗收｜2026-09-27

## 修正

- 左側目錄樹：點資料夾名稱展開／收合，點右側箭頭進入；兩者都保留 44px 觸控範圍。
- 已可閱讀的圖片資料夾若沒有已知子目錄，書架優先顯示漫畫卡，不顯示會通往空書架的重複目錄卡。樹狀目錄在淺掃完成前仍保留入口。
- AI 未啟用時，書外「AI 掃描」與閱讀中的 AI 操作開啟設定並定位到「艦載 AI」；已啟用時執行原功能。設定焦點只落在可用控制，文字輸入及設定視窗不觸發閱讀快捷鍵。
- macOS 允許以 `/Volumes/<掛載名稱>` 作漫畫來源，仍拒絕 `/`、`/Volumes` 與家目錄。

## 已完成驗證

- `npm test` 全部通過，包含目錄樹、AI 未啟用導向、閱讀快捷鍵與空書架重複入口回歸；`node --check public/app.js`、`cargo fmt --check`、`git diff --check` 通過。
- CodeRabbit 本輪三次，每次範圍少於 150 個 tracked source/test 檔；第一輪 3 項已核實與修正，第二輪 1 項測試完整性提醒已修正，第三輪 0 finding。
- Mac build 33 簽章驗證、安裝與啟動。實際把 `/Volumes/docker` 掛載根目錄設為來源，按「儲存套用」後視窗關閉，直屬資料夾先出現，背景掃描再補齊書架；重新啟動後來源仍保存在本機設定。點資料夾名稱可展開而不切換目前書架路徑。
- iPad 1.0.0（33）已簽章、安裝、啟動並由 CoreDevice 回讀版號。實際點目錄名稱展開／收合，右側箭頭才進入；外部來源的當層目錄可顯示。未啟用 AI 時按書外「AI 掃描」，設定直接捲到「艦載 AI」且沒有送出頁面。
- 最終 iPad 包再次驗證：根目錄的 `SmokeTestComic` 只顯示可閱讀漫畫卡，沒有通往空書架的重複目錄卡；點「開始閱讀」後第 1／2 頁圖片可見，返回回到書架。Mac 與 iPad 已安裝 App 均回讀 build 33。

## 最終包確認

- macOS：`output/release/latest/G.A.I-1.0.0-build33-macOS.dmg`
- iPad：`output/release/latest/G.A.I-1.0.0-build33-development.ipa`
- iPad 截圖：`output/release/latest/build33-ipad-library-final.png`、`build33-ipad-folder-tree.png`、`build33-ipad-ai-settings.png`、`build33-ipad-reader.png`

## 實測邊界

- 既有 iPad build 29 曾驗證 7,003 項全域掃描時仍可逛當層；本輪沒有建立 10 萬本合成書庫或讓失效 NAS 長時間斷線來量測延遲。全域掃描目前沒有任意漫畫數上限，但極大資料量的耗時取決於磁碟／NAS 回應。
- AI 六頁長篇取樣、不同供應商語言回覆、正式 StoreKit 購買與權限撤銷矩陣未在本輪重新執行；先前 2 頁真實 AI 候選與背景掃描並行已於 build 30 驗證。
