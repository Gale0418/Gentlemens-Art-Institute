# build 16 散圖資料夾可見性修正與本機交付（2026-09-11）

本輪修正「圖片直接放在目標資料夾根目錄時，書架看不到」的可見性問題，並重新交付 Mac 與 iPad。本產品的語意仍是「一個圖片資料夾代表一本可連續閱讀的漫畫」，不是把每張圖片拆成獨立書卡。

- 書庫掃描：根目錄圖片資料夾現在保留實際 `page_count`，不再顯示 `---`。
- 書架 UI：散圖資料夾顯示「圖片資料夾」與「共 N 張圖片」，可存取性標籤也明確說明再次操作即可閱讀。
- 回歸測試：新增 root image directory fixture，確認根目錄項目不是虛擬目錄；`npm test` 全部通過；`npm run test:rust` 為 129 passed／0 failed／1 ignored。
- Rust 格式檢查：`cargo fmt --check` 仍被既有未相關檔案的格式差異阻擋，本輪沒有進行全專案無關格式化；`git diff --check` 通過。

## 實機交付

- macOS build16 App：`/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.app`。
- Mac 實測：重新由系統資料夾選擇器授權 `Downloads` 後，書架顯示「圖片資料夾：Downloads」、`1084 頁`，進入閱讀器顯示 `第 1 / 1084 頁` 並成功載入圖片。
- iPad：iPad Air（第 5 代），透過 `localNetwork` 安裝；`com.windsheep.gai` 安裝、版本回讀 `1.0.0`／bundle version `16`，launch 成功。
- IPA：`output/release/2026-09-11-build16/GAI-1.0.0-build16-development.ipa`。
- IPA SHA-256：`07db08f3dc012d3af1ea127d030ec075f88d3b5fa825ac39ba7d94797c739349`。
- iPad 連線狀態：`paired`、`transportType=localNetwork`、`tunnelState=connected`。

## 限制與後續驗收

- macOS 重新簽章後，系統可能要求首次重新選取受隱私保護的資料夾；這是 TCC 授權狀態，不是掃描器把圖片遺漏。已用 `Downloads` 的系統選擇器重新授權並完成實測。
- 本輪已完成程式回歸、Mac 可見性／開讀、iPad 安裝／版本／啟動驗證；iPad 實際手指操作、AI 單頁翻頁與條漫隨讀翻譯仍保留給主人做最後體感驗收。

## Evidence

- [IPA](../../output/release/2026-09-11-build16/GAI-1.0.0-build16-development.ipa)
- [iPad install result](../../output/release/2026-09-11-build16/ipad-install.json)
- [iPad launch result](../../output/release/2026-09-11-build16/ipad-launch.json)
- [iPad version result](../../output/release/2026-09-11-build16/ipad-version.json)
- [iPad connection details](../../output/release/2026-09-11-build16/ipad-connection-details.json)
