# G.A.I build24 交付紀錄（2026-09-26）

## 艦載 AI 模型路由

- Google 工作階段現在以 26B、31B 輪流作為每筆請求的首選模型；首選回 HTTP 429 或 5xx 時，該筆請求會改試另一模型。HTTP 400／403 等非暫時性錯誤不重送。全域同時請求上限仍為 2。
- 漫畫 metadata 候選會記錄實際回答的模型，避免 31B 的結果誤標成 26B；設定畫面同步標示 26B／31B。
- [Google 官方速率限制文件](https://ai.google.dev/gemini-api/docs/rate-limits)說明限制按專案與模型計算，且會依用量等級變動，實際額度須以 AI Studio 為準。因此 App 不將「每模型 30 RPM」寫死成所有使用者的固定值。
- 本輪以工作區外 Google Key 送合成文字驗證：26B 回 HTTP 200；31B 兩次回 HTTP 500。這表示目前無法聲稱 31B 的額度已可使用；build24 的 5xx 轉試設計讓 26B 在 31B 暫時故障時可接手。沒有傳送漫畫頁面，Key 未寫入 Git。

## 本機檢查

- `npm run quality` 通過：前端測試、Rust 147 passed／1 ignored、rustfmt、Clippy。
- macOS Release App 已覆蓋桌面舊版，`CFBundleVersion=24`、`com.windsheep.gai`、ad hoc 簽章與深度嚴格驗證通過。實際啟動後書架載入 24 個系列。
- 使用者已在上一版將有效 Google Key 記入本機 Keychain；build24 重新啟動後，重新確認工作階段資料分享並從 Keychain 還原。設定畫面顯示 26B／31B，連續兩次合成文字測試均顯示「艦載 AI 連線成功。」。程式單測驗證兩次請求首選模型交替及 500 時轉試另一模型；UI 沒有逐次模型遙測，因此兩次成功畫面本身不能獨立證明各筆實際採用的模型。
- CodeRabbit 先前三次審查已用於 build23；本輪沒有再啟動審查，避免誤用使用者設定的一小時三次額度。build24 變更以單測、完整品質檢查與 App 合成文字測試驗證。

## 交付狀態

- iOS Release 編譯、archive、debugging export 成功。從 IPA 以 macOS `ditto` 解開的 App 為 `com.windsheep.gai` 1.0.0（24），Team `X3UYL4NRRN`；`codesign --verify --deep --strict` 通過。
- iPad Air（第 5 代）已覆蓋安裝，`devicectl device info apps` 回讀 1.0.0（24）。首次啟動因裝置鎖定被拒；使用者解鎖後，`devicectl device process launch` 成功，程序清單回讀到執行中的 App。iPad 上的 AI 與觸控閱讀操作尚未逐項驗收。
- 唯一最新版 IPA：`output/release/latest/G.A.I-1.0.0-build24-development.ipa`，SHA-256 `fa51407cbfbb14f87185c9e784706cca10fefaa2e0ecffde803bd0a899e257cb`；舊 build23 IPA 已移除。
