# 首發三語本地化

> 歷史開發紀錄：下列測試數字與裝置狀態是當時的觀察，不代表最新版本已通過相同驗收。最新掃描維修紀錄見 [scan-progress-repair-2026-09-09.md](scan-progress-repair-2026-09-09.md)；未完成事項仍以任務中心追蹤。

使用者核准繁體中文、英文、日文；v1 Pro 首發台幣 150 元買斷已核准，App Store Connect 台灣基準價格已於 2026-09-09 設定並回讀為 TWD 150；尚未核准販售，完整交易與實機地區／幣別驗證仍待完成。

## 行為契約

- 首次依系統偏好選取支援語言；中文地區代碼使用繁中，英文與日文各自對應，其他語言回退英文。
- 設定可指定繁中／English／日本語，或跟隨系統。選擇儲存在裝置上，切換後重新載入介面。
- 只翻譯固定 UI 與明確標記的文案，不改漫畫書名、相簿名、作者、標籤、私人路徑、metadata 或使用者輸入。
- StoreKit 顯示價格依商店原生回傳，不以翻譯或台幣字串覆蓋當地價格。
- iOS 照片與本機網路提示使用 InfoPlist.strings，依裝置語言；App 內語言選擇不覆寫系統權限語言。
- 不以全域 DOM observer 比對中文後替換，避免誤改使用者資料與影響大型書庫捲動。

## 驗證範圍

已完成靜態／動態文案與 572 個翻譯項目；完整 `npm test` 通過，涵蓋語系偏好、持久化、插值安全、私人內容隔離、固定 UI 字典覆蓋與既有功能回歸。測試紀錄：`output/release/2026-09-09-localization/frontend-tests.log`。

英文／日文在手機與平板尺寸的 16 個 WKWebView 靜態案例已產生截圖；設定、Pro、相簿未發現水平溢出。閱讀工具列追加 4 案例，模擬 coarse pointer 規則後逐顆捲動驗證，每案 16/16 按鈕可達；初始超出可視區是橫向捲動的預期行為。build 7 已成功封裝，IPA 回讀確認三語 InfoPlist.strings、CFBundleLocalizations、版本 1.0.0(7)、iPhone/iPad family 與 codesign 驗證通過。兩台已安裝並回讀 build 7；iPad 啟動成功，iPhone 因 Locked 未啟動。實機語言切換與閱讀操作仍待使用者驗收。

封裝證據：`output/release/2026-09-09-build7/artifact-verification.json`；IPA SHA256：`c6d32f09c8576480badab4683f4a0f23d22adb97f7c31ccdc2d71d1a5e487625`。此為 development IPA，尚未上傳 TestFlight／App Store。

## 原生資源依據

依 Apple [隱私用途本地化說明](https://developer.apple.com/library/archive/qa/qa1937/_index.html)，各語言使用 InfoPlist.strings，並保留 Info.plist 基本文案；[CFBundleLocalizations](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundlelocalizations) 宣告手動處理的語系。同步腳本會將正式資源加入 Xcode Resources，不能只靠原始碼存在宣稱已打包。
