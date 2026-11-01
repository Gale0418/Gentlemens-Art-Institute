# 第59版：商店圖組與三語介紹更新

## 已送審

使用者已授權將 Mac、iPad、iPhone 新宣傳圖隨新版送 Apple 審查，三語文案由 Gemini 撰寫並使用自然顏文字。

目標：iOS 1.0.1 (59)、Mac 1.0.2 (59) universal。第58版兩平台均已核准上架，這輪不增加程式功能。以已核准正式 IPA／PKG 重新封裝版本資訊與簽章；未重新編譯、未新增實機驗收。已核對與第58版的程式 __TEXT,__text 指令區段一致，版本／簽章以外的資源維持原值。

## 商店文案與圖片

- zh-Hant、en-US、ja 的描述、宣傳文字、關鍵字、更新說明，由 Gemini 起稿，Codex 僅核對功能、修正少量措辭及 UTF-8 關鍵字長度。來源：`docs/marketing/store-copy.proposed-2026-10-17.json`。
- 圖片沿用使用者已確認的設計；本輪共用同一套圖，未宣稱中文字圖片已翻譯成英日文。Apple 支援依語言配置圖組，沒有文字的圖片容易共用，帶中文宣傳文字的圖未來可另做語言版本。
- Mac：2張1440×900；iPad：7張，2064×2752／2752×2064；iPhone：1張新設計，1179×2556及1242×2688兩個裝置尺寸。舊6.5吋實機圖保留。

## 正式產物與證據

- iOS IPA：`output/release/build59/Gentlemens-Art-Institute-1.0.1-59-appstore.ipa`，SHA256 `37495381145170fcddc3ede7f2dcb939e7ac9435c422635aca5585ffcf5a079d`。
- Mac PKG：`output/release/build59/Gentlemens-Art-Institute-1.0.2-59-universal.pkg`，SHA256 `7b57c7e3104b9ef02e3284361fe915aea55c14326c714586293413a1558ca2dc`。
- 兩平台正式簽章、版本、免額外加密文件宣告已檢查；iOS三語隱私用途字串、無內嵌靜態archive，Mac雙架構與封包可讀權限已檢查。
- 私有證據：`output/audits/COMIC-RELEASE59-20261017/`。

## 邊界

沒有新增程式邏輯，因此未重跑程式回歸或 CodeRabbit。未把重新簽章、圖組上傳當作實機翻譯、StoreKit完整交易或VoiceOver驗收。API 與 Chrome 審查清單均回讀 WAITING_FOR_REVIEW；第59版尚未核准或上架。

## Apple 送審結果

- iOS 1.0.1 (59)：build `50d1d088-3404-4b29-9efd-594c59e9962f`，VALID；submission `94e5721b-7a5e-42b4-819c-fbc0fc6dc8e2`，WAITING_FOR_REVIEW，2026-10-17T10:59:25.581Z（台灣18:59）。
- Mac 1.0.2 (59)：build `d84fdf6e-481e-4d62-bd7c-0ac2171b2e16`，VALID；submission `95a7dbe4-605c-4dc1-8248-73bf93907382`，WAITING_FOR_REVIEW，2026-10-17T10:56:44.267Z（台灣18:56）。
- 兩平台均為 AFTER_APPROVAL；三語文案逐欄回讀一致，三語相同圖組 COMPLETE 並核對檔案 checksum。
- Mac canonical validate：0 errors／0 warnings；App Privacy 另由 Chrome 發佈資訊確認。iOS canonical validate 因兩份 AppInfo 歧義失敗，未宣稱完整 validator PASS；用 pending `7c51c14c-81e2-4a72-ae6a-5642bb5bcea6` 與 live `94ca32b9-0ab4-4c7f-bd41-54d68bbf231d` 核對27個分級欄位一致。先前唯一 build 缺項已補 VALID59，三語新增功能已補，IAP 0 blocking；送審 dry-run 與正式提交成功。
- Chrome 審查清單已確認兩筆59新版各1個項目等待審查，舊58兩平台已審核完畢。本次Pro既有商品不重複送審。
- 清理僅針對本次封裝建立的 APFS暫存與掛載；正式IPA／PKG與私有證據保留，沒有建立模擬器。
