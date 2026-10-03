# 第 55／56 版探索體驗驗收

日期：2026-10-03。產品仍未上市，App Store 1.0 回讀綁定第 44 版，狀態 `WAITING_FOR_REVIEW`。本次未撤回審查、未上傳新版或更新商店文案。

## 交付

- 第 55 版：首次入口「試讀原創風景」／「加入漫畫資料夾」；「隨手翻一本」只從目前來源、目錄、系列、搜尋與篩選結果抽選，排除離線，能換書時避免連續抽中同一本，防連點並保留返回情境。
- 第 56 版：書架「依標籤探索」提供自選 TAG 抽一本、隨機先抽 TAG 再抽一本。每個可用 TAG 等機率，該 TAG 內的書等機率；有其他 TAG 時避免連續抽到同一 TAG。沒有 TAG 提供「開啟標籤工具」入口。
- TAG 沿用既有 effective tags：人工 include/exclude、停用、canonical/redirect、來源及資料夾規則。以當前線上候選 runtime ID 查詢，唯讀 SQL 在背景執行；前端每批最多 1,000 本，排除過期回應與範圍變更。點按探索不另起整庫掃描。
- Gemini 提供商店、PTT 與 Reddit 文案，Codex 校訂產品事實。公開草案見 [推薦文案包](../marketing/recommendation-kit-2026-10-03.md)，尚未發布。

## 驗證

| 範圍 | 結果與界線 |
| --- | --- |
| 前端 | 15 組 Node 檢查通過；最後新增 1,001 本分成 1,000＋1 的回歸，再跑受影響 catalog scheduling 通過。涵蓋當前範圍、去重、連點、失敗解鎖、TAG 空值與錯誤、選標籤與隨機、過期回應、選項跳脫。 |
| Rust | 完整 185 項通過、0 失敗、1 既有 ignored。獨立審查後補上舊反斜線及尾斜線正規化，最後針對性回歸 1 項通過。 |
| 打包及隱私 | 第 56 版 package／privacy 檢查通過；root/stage 11 個檔案 SHA-256 一致。 |
| 獨立審查 | 第 55 版首輪找到 1 major（錯誤提示呼叫非全域函式），已修並以 8 檔 closure review 取得 0 findings。第 56 版正式 11 檔審查找到 1 minor（目錄格式正規化），已修與回歸通過，修正未再次獨立複審。Luna 額度不足，沒有宣稱新一輪多席子代理已通過。 |
| Mac | 桌面正式路徑覆蓋 `1.0.0 (56)`；自己的 Adventure／Comedy 不同內容測試書，空 TAG→工具→加 TAG→自選喜劇開 Comedy 1/2→隨機 TAG 開 Adventure 1/2→Escape 返回，全部實際操作成功。原 `/Volumes/docker` 來源已還原、22 系列及 knowledge 第 5 頁進度回讀。 |
| iPad | 第 55 版搜尋 SmokeTestComic→隨手翻一本→1/2 圖像解碼→返回與清搜尋成功；原照片 162 頁與三筆來源保留。第 56 版已覆蓋安裝，CoreDevice 回讀 `1.0.0 (56)`，TAG 原生操作尚待裝置解鎖；Xcode 明確回報 `Unlock ... to Continue`。 |
| 無障礙 | Mac Cua 的 AX 讀取在閱讀器與設定漏掉控制項；實際畫面、鍵盤 Escape、焦點及座標操作有確認。完整 VoiceOver 尚未驗收，不能視為全通過。 |

## 資源與版本界線

只清理確認屬於本專案、已完成的資源：舊 G.A.I App Store 12.9 模擬器移除，刪前 allocated 2,429,980 KiB（約 2.32 GiB）；MediBuddy 模擬器保留。第 56 版已核對保存 IPA 的 SHA-256，刪除解壓的安裝副本與 114,068 KiB 產生的 export；Mac 自建測試目錄已刪，Comedy 測試 TAG 已撤銷，Adventure 測試書有效 TAG 已排除。使用者漫畫、DB、Key 和共用 Cargo 快取保留。

3016 頁快速跨窗／縮圖目錄證據仍沿用第 47／51 版界線，不宣稱本輪重做。商業發行仍需完整 StoreKit 交易、Privacy UI 確認、公開 Mac 正式簽署／公證，以及新版 App Store 發行決定。Mac 本機使用 ad-hoc 簽署；iPad 包為 debugging export，並非 App Store 發行包。
