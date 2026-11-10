# 第78版 Mac 驗證紀錄

版本：`1.0.4 (78)`。日期：2026-11-10。交付範圍：macOS。iPad 依使用者安排延後；本輪未安裝或驗收 iPad 78。對 iPad 執行的 WDA 操作僅回到 Home，不構成版本驗收。

## 變更範圍

- AI 頁面說明改以自然段落精簡意譯，保留條件、數字與否定；翻頁時隱藏舊譯文，並改善新頁載入及快取呈現。翻譯結果直接顯示內容，AI 按鈕同寬對齊。
- v4 完成的跨語言功能與 v6 的繁中、英文、日文品牌圖文沿用；介面相對 v6 未改動。v7 調整 Keychain 存在狀態檢查，只查詢 metadata、不讀取秘密值；實際還原儲存金鑰仍由作業系統正常驗證。
- 過期 AI 回應仍依目前書籍、來源、頁面、語言、工作階段及開書世代核對後丟棄；已送出的請求無法由 App 撤回。

## 品質、來源與審查收據

最終來源 manifest SHA-256：`30b3955d5ad7d17654708295d27c2334234d04961e1fb726ccdeadd4ebf30789`。

| 項目 | 結果 |
| --- | --- |
| npm 品質腳本 | 25 組全部通過 |
| Rust 格式 | `cargo fmt --check` 通過 |
| Release library tests | 384 passed、0 failed、5 ignored |
| Strict release Clippy | 通過，`-D warnings` |
| CodeRabbit | v7 對 `lib.rs` 完成，0 findings、0 errors；9 個未變更檔依先前審查及雜湊沿用，總覆蓋 10 個唯一檔案 |

v4 已驗證繁中、英文、日文的 AI 回應流程；本版人工驗收確認翻譯內容完整到最後一段。AI 輸出仍需使用者判讀，不保證語意絕對正確。

## Mac 產物與原生驗收

來源 manifest 對應的正式 Mac bundle 已建置、簽章檢查並安裝為 `1.0.4 (78)`。Binary SHA-256：`63a495523bd88d94db0095ffc491ed21527d9ec6a8acefdb306fb85ad0c8601e`；bundle tree SHA-256：`5ffd90fbd991864fb493422a30136fc5f16439170b8d04d06bec4d768551dbb3`。簽章為本機 ad hoc development；未 notarize，亦非商店簽章。

人工實機驗收確認：完成正常 Keychain 授權後可使用已儲存金鑰；翻譯完整顯示至最後段；畫面未出現可見 AI 面板標題；重啟後續讀至第 4／44 頁。對應本機證據為 `native78-v7-result.png`、`native78-v7-cold-page4.png`、`native78-v7-ai-restored.png`。私人頁面內容及資料未納入 repository 或外部審查。

正常結束 App 後，以獨立 APFS 快照逐筆比對：v7 前 74 筆閱讀進度的位置與 82 筆完整歷史均保留；更新後為 74 筆進度與 84 筆歷史，新增兩筆對應原生續讀驗收。第78版前最初的 71 筆進度位置與 71 筆歷史也完整保留。只有正常離開閱讀器的時間戳更新，沒有重設閱讀位置；SQLite `quick_check` 為 `ok`。擷取前後正式資料庫雜湊相同。

## 儲存空間處理

已依官方 `simctl` 正常刪除舊 iOS simulator runtime，後續確認 simulator disk image 總數為 0；iPhoneOS 26.5 SDK 保留。刪除未使用強制方式、sudo 或終止程序。磁碟淨變化同時包含建置及系統活動，不視為單一 runtime 的隔離容量測量。最後另回收已無開啟控制代碼的 release 編譯快取及八份舊候選 App，保留最新第78版與第77版回復包；該批實測可用空間從 27,322,257,408 增至 30,695,329,792 bytes。這是當時讀值，並非回收項目邏輯大小的加總。

## 獨立複審與交付邊界

執行流程、視覺體驗、資料與發行三席獨立複審，均已核對凍結來源、原生收據及其負責範圍，沒有未解已確認缺陷。最後的獨立仲裁、Git 提交與遠端精確 SHA 回讀由任務中心保留機器收據；評論不代替原生測試。

交付採 `main` 直推流程。iPad 78 本輪未安裝或驗收；沒有 notarization、App Store Connect 上傳或上架聲明。
