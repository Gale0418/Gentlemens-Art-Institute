# 第79版 Mac／iPad 驗證紀錄

版本：`1.0.4 (79)`。日期：2026-11-11。Mac 與 iPad 均已安裝同一 v3 來源並完成原生驗收。

## 變更範圍

- 書架原有四種主題新增亞歷山大（Alexandria），五種主題各有 Mac、iPad 橫向、iPad 直向版本，共 15 張背景；另有 5 張選擇器預覽圖。主題名稱支援繁體中文、英文、日文，品牌標題依介面語言顯示並接上 GAI。
- 修正原生驗收發現的兩項顯示問題：照片預覽圖從舊式網格欄位改為區塊呈現；Ink 深色主題的副標與區段標籤改用既有 muted text token，維持對比。
- 最終來源以 `source79-v3-manifest.json` SHA-256 `135274c081ac8ffde6dbdbe514d6848281cddf3cce6033fd2bfd3932668007eb` 識別。背景資產 manifest SHA-256 為 `ce30d5a0eca9f34174dfb5ede08b09e7839a17edc5578ceff18848c82e87144e`，含 20 張 JPG、合計 6,336,114 bytes。本次書架背景正式資產只採 JPG；依使用者要求，匯出核對後移除 15 張大型原始 PNG（36,305,383 bytes），保留 prompts 與來源 provenance。

## 品質與複審

| 項目 | 結果 |
| --- | --- |
| 前端完整測試 | `npm test` 26 個測試腳本全部通過，exit code 0。 |
| 背景聚焦測試 | `node tests/library-backgrounds.mjs` 通過，涵蓋主題、視窗對應與 JPG 尺寸；CSS／測試修正後的聚焦測試及最終 `git diff --check` 也通過。 |
| Rust 品質閘門 | 相對基底 commit `84c3ff40941d7ddd27bf539e5a1dc3ac05c245a1`，2,063 個 tracked native 檔案只有版本設定例外，native source diff 為 0；沿用[第78版既有品質收據](build78-validation.md)：`cargo fmt --check`、strict Clippy 通過，library tests 384 passed、0 failed、5 ignored。本輪沒有重跑 Rust 全套。 |
| CodeRabbit | 三輪分別覆蓋 8、2、1 個檔案；三輪皆 0 findings、0 errors。 |

背景樣式位於 `public/library-ambience.css`。

## Mac 產物與原生驗收

最終來源 manifest 對應的 Mac app 已建置並安裝為 `1.0.4 (79)`。Binary SHA-256：`3e3c2b41492417411cfd294a829893373b4420f1addd9363e61d2563d7242f31`；bundle tree SHA-256：`205040d3f3238b2bcab53728521835394e2a47f059382318d9efcf4e7dd62df6`。簽章檢查通過；簽章為本機 ad hoc development，未 notarize，亦非商店簽章。

以實際 Mac Tauri app 進行 12 項原生檢查：更新保留既有偏好、五主題畫面、照片預覽、Ink 標籤可讀性、方向鍵選主題、主題重啟後保留、繁中／英文／日文名稱與單語品牌標題、寬窄視窗、QA79-A/B 換書與存檔、閱讀器黑底、冷啟動續讀、最後還原既有來源與偏好。QA79-A/B 均從第 1／3 頁翻至第 2／3 頁後返回；冷啟動後兩本仍顯示第 2 頁，QA79-A 實際續讀至第 2／3 頁。閱讀器畫面範圍外維持黑底，書架背景沒有透入。

Mac 最終快照逐筆比對通過，SQLite `quick_check` 均為 `ok`：原有 74 筆閱讀進度、84 筆閱讀歷史、34 筆 progress intent fence、39 筆 recovery proof 全部 unchanged，changed/missing 均為 0。另新增 2 筆 QA 進度、3 筆 QA 歷史、2 筆 QA fence、2 筆 QA proof，沒有未分類的新資料；QA79-A 歷史新增 2 筆、QA79-B 新增 1 筆。完成驗收後已還原原有來源、自動語言、赤晶主題及 150px 封面；原有書庫與繼續閱讀位置仍在，並正常結束 App。

## 已修正發現

最終來源 manifest 範圍的 findings ledger 記錄 4 項 P2，均標為 fixed，未解確認缺陷數為 0：

| 發現 | 修正與驗證 |
| --- | --- |
| 未初始化 theme 時，media rule specificity 可能選錯直向背景 | 修正 root fallback；聚焦回歸涵蓋橫向與直向。 |
| 亞歷山大暖金主按鈕與前景對比不足 | 調整色階；聚焦測試檢查所有色階對比至少 4.5:1。 |
| 照片縮圖受舊 grid 影響，只佔第一欄 | 改為 `display: block`；回歸測試及 Mac v2/v3 實際畫面確認。 |
| 深色主題的副標與區段標籤沿用深灰字，難以辨識 | 改用既有 muted text token；Mac v3 實際確認可辨。 |

本輪確認的四項顯示缺陷均已修正。

## iPad 產物與原生驗收

iPad Air（第5代）安裝的是同源 v3 建置 `1.0.4 (79)`。Debugging IPA 大小 97,054,855 bytes，SHA-256：`bcaa5d1bc5bd7c8125b36e10381f0de4f0482873656dd6ae2bc0b82ec44d45d7`；54 個公開資產的樹 SHA-256 為 `ba73dda16e5ce69e5144dee8e700bd266945894b89c4b6e4ba1443fe5f2d0ff9`，全部符合凍結來源檔案，簽章驗證成功且佈建描述檔包含目標裝置。

同一 iPad 原生 App 完成 12 項檢查：五種主題的直向與橫向共 10 個畫面、照片選擇器縮圖、繁中／英文／日文主題名稱與單語品牌標題、左右抽屜開關與遮擋、A/B 各由 1/3 頁翻至 2/3 頁後使用可見返回並換書、閱讀器黑底，以及冷啟動續讀。Home 後以 SIGTERM 停止並確認 GAI 程序結束，再冷啟動；書架上的 A/B 均在第 2 頁，實際打開 A 為第 2/3 頁。背景掃描進行時，主題、設定、抽屜及閱讀操作仍可使用；本次未量測完整掃描吞吐。

## 資料保留與限制

iPad 安裝前後的離線 SQLite 快照 `quick_check` 均為 `ok`。閱讀進度由 253 筆增至 259 筆：原有 253 筆皆保留，其中 251 筆完整列逐欄相同，另 2 筆僅 `updated_at` 小數秒精度正規化，時間仍落在相同 UTC 秒且閱讀位置欄位不變；沒有遺失列。新增 6 筆包含兩筆 QA 書籍進度及四筆既有來源重新索引。閱讀歷史由 73 筆增至 80 筆；原有 73 筆完整保留，新增 7 筆均為 QA 記錄。`progress_intent_fences` 與 `progress_recovery_proofs` 各由 36 筆增至 38 筆，原有列完整保留，各新增兩筆皆對應 QA 保存操作。未宣稱所有既有來源 metadata 未變。

完成驗收後已還原 iPad 原有 aurora 主題、自動語言、150px 封面與直向設定；移除測試用外部書籤，保留原有兩個外部書籤。安裝前 `readerMode` 的 accessibility 值未取得，本輪未另切換持久化閱讀模式設定，因此不聲稱該設定的基線已比對。

本輪未重新執行 Rust 全套；Rust 格式檢查、strict Clippy 與 library tests 沿用[第78版既有結果](build78-validation.md)：384 passed、0 failed、5 ignored。未涵蓋 AI 供應商呼叫、完整 StoreKit 交易、VoiceOver、notarization 或 App Store Connect 上傳；本紀錄不是商店發布聲明。
