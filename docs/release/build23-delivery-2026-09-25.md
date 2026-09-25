# G.A.I build23 交付紀錄（2026-09-25）

## 問題與修正

- 使用者畫面顯示「測試失敗：操作失敗，請稍後再試。」。新版桌面 App 當時使用本機 Keychain 已記住的舊 Google Key；Google 回 HTTP 403，指出**那把舊 Key**已停用。工作區外 `OWO.txt` 第 14 行另有可用的 Google Key：以 `gemma-4-26b-a4b-it`（App 首選模型）及 `gemini-2.5-flash` 合成文字測試均回 HTTP 200；`gemma-4-31b-it` 一次測試回 HTTP 500。該檔第 11 行的 OpenAI Key 也經合成文字 Responses API 測試回 HTTP 200、`completed`。任何 Key 均未寫入專案或交付物。
- 前端原本將含中文字的原生錯誤一律替換成泛用訊息，現在保留未辨識的後端錯誤。後端會遮蔽供應商錯誤中出現的使用中 API Key，避免診斷文字洩漏憑證。
- 閱讀器焦點限制現在容許可見的模態視窗互動；目錄索引完整性檢查調整為每個 store 實例只做一次。原有的可見目錄優先補掃、SMB 掃描及閱讀修正一併納入本版。
- iOS `bundleVersion` 22 → 23。

## CodeRabbit

- 遵守一小時最多三次、每次最多 150 檔。先把近期五次提交及本輪待交付變更中共 37 個程式／測試檔放入暫時審查工作樹；排除已確認無需審查的大型鎖檔、產生的 Apple 專案、交付文件與說明文件。暫時工作樹與分支均已移除。
- 第一次找到 3 個需處理的問題：原生錯誤被泛化、閱讀器模態視窗焦點、目錄 FTS 檢查成本。修正後第二次以受影響的 7 檔複查，0 個問題。第三次專看 AI Key 遮蔽修正，0 個問題。本小時不再啟動第四次審查。

## 驗證與交付

- `npm run quality` 通過：前端測試、Rust 146 passed／1 ignored、`rustfmt`、Clippy；`git diff --check` 通過。
- macOS Release App 已覆蓋桌面舊版；`CFBundleVersion=23`、ad hoc 簽章驗證通過。實際啟動並確認書架內容載入。
- iOS Release 編譯、archive、debugging export 成功。從 IPA 以 macOS `ditto` 解開的 App 為 `com.windsheep.gai` 1.0.0（23）；Team `X3UYL4NRRN`，`codesign --verify --deep --strict` 通過。Python ZIP 解壓會丟失執行權限，因此不可用該解壓結果判定簽章。
- iPad Air（第 5 代）已覆蓋安裝，`devicectl device info apps` 回讀版本 1.0.0（23）。啟動驗證目前被裝置鎖定拒絕，待解鎖後重試。
- 唯一新版 IPA：`output/release/latest/G.A.I-1.0.0-build23-development.ipa`（43 MiB），SHA-256 `f3d5176b01b3bafc98d4accc5796082e37daadddf1b06b1cb318c67c74f40f0a`；舊 build22 IPA 已移除。

## 待驗收

- App 原先在 Keychain 記住的 Google Key 已停用；`OWO.txt` 第 14 行是另一把有效 Key，目前尚未寫入 App 的安全輸入框或 Keychain。iPad 觸控閱讀、AI 圖像解說及 StoreKit 交易矩陣須以實機操作驗收，不能從建置或啟動推定通過。
