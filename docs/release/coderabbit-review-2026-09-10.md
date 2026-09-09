# CodeRabbit 審查與修正紀錄（2026-09-10）

本輪涵蓋目前完整第一方程式、測試、Apple WebView 整合與較早功能。使用與工作目錄逐檔 SHA-256 相符的隔離快照；排除二進位、建置產物、dependency lock、生成權限與大部分未修改 vendor。核心大型 app.js、catalog.rs 仍在範圍內。沒有把私人書庫、API Key 或 MissionCenter 送出。

使用者授權每小時最多 3 次、每次最多 150 檔。第 1 次 136 檔在本機判定 base branch 失敗；第 2 次以明確 main base 審查 150 檔，收到 9 個 issues 後發生 `Connection failed: WebSocket closed`，不能視為完整審查通過。第 3 次以 light 模式複查 150 檔完整結束（exit 0、review_completed），提出 10 個 issues。兩輪合計 19 個 issues（8 major、11 minor）均已核實處理；第三輪後的修正未再送外部複查，沒有宣稱零問題審查。

| 等級 | 問題 | 核實與處理 |
| --- | --- | --- |
| Major | 決策文件仍使用舊付費 App 模式 | 改為免費核心與 v1 Pro 非消耗型 IAP；商業化文件對齊既有 App Store Connect 設定紀錄。 |
| Major | 隱私同步可能採到其他 target 的 Info.plist | 多個不同 INFOPLIST_FILE 時明確失敗，不寫錯目標；加入歧義 fixture。 |
| Major | 固定共用 /tmp Cargo 目錄可遭預先建立 | 建置與 Rust 檢查改用使用者私人快取；檢查擁有者、symlink 與父目錄權限，並驗證 0700。 |
| Major | 漫條／目錄上下鍵和空白鍵被翻頁快捷鍵攔截 | 保留瀏覽器原生垂直捲動；單頁與雙頁行為維持。 |
| Major | CSP 保留已移除的 localhost:4000 來源 | 移除 connect-src 與 img-src 的舊服務來源。 |
| Minor | 商店多語資料缺繁體中文 | 加入 zh-Hant，與 canonical 商店文案做一致性檢查。 |
| Minor | 效能 fixture 缺少 npm 入口 | 加入 test:perf；這是持續運作的手動 HTTP fixture，不塞進自動 test 造成不退出。 |
| Minor | Pro 對話框焦點循環包含停用控制項 | 排除 :disabled（含 fieldset）與負 tabindex，補鍵盤焦點回歸測試。 |
| Minor | Wry 等待時間註解與實作不符 | 註解改為實際 1 秒，不改 Rust 執行行為。 |

驗證：完整 npm test 通過（588 個翻譯鍵），包含新增鍵盤、焦點、私人快取、三語商店資料、隱私同步案例。私人快取的實際 cargo metadata --locked --offline 通過，手動效能 fixture 啟動與 HTTP 回應通過並已關閉；未測量 FPS。StoreKitHost Swift 語法與 XcodeGen 設定解析通過，不代表購買交易驗收通過。本輪 Rust 修改僅註解，沒有重新宣稱執行完整 Rust 測試。

本次程式修正已交付 Mac／iPad build 14，詳見 [交付紀錄](build14-delivery-2026-09-10.md)。iPad 掃描、StoreKit 交易與 App 內 AI 操作仍須完成實機驗收。Repository 維持 private，舊內容清除申請處理完畢前不改公開。

第三輪已核實的補充修正：

- Major：建置文件的清理路徑驗證拒絕 `/tmp`、`/var/tmp`、使用者系統暫存根目錄及其 canonical 別名；執行文件中的驗證函式（不執行任何刪除）確認兩個輸出變數都受保護。測試也揭露原函式在合法路徑下回傳 1，已補明確成功回傳。
- Minor：canonical metadata 的 unknowns 移除已知 App ID、marketing version、商品 ID、設定價格與語系選擇，保留 processed build、交易與實機幣別驗證。
- Minor：移除已不存在的 GitHub Actions 證據，改指向本機品質指令。
- Minor：人讀版發行文件同步已記錄的 App ID、v1 Pro 商品／價格與三語上傳狀態。

補充驗證：`node tests/release-hardening.mjs` 通過；metadata 本機 dry-run 格式檢查可執行，但仍明確回報 `BLOCKED`（51 個 TODO），沒有進行 ASC 或網路提交。第三輪後的補充修正尚未再送 CodeRabbit，遵守本小時三次上限。

第三輪其他六項修正：

- Minor：Photos 有限存取仍連結不可用相簿時，只在不可用集合出現新項目時清理一次快取；重複快照保留有效圖片，權限再失效仍清理。
- Minor：CommercePolicy 遮蔽 UUID 之外的長十進位識別碼；修正文案，不宣稱 regex 能移除所有 secrets。
- Minor：移除未被 Package.swift 引用、匯入不存在 ExamplePlugin 模組且無 assertion 的歷史空測試。
- Minor：閱讀器目錄模式與放大檢視採各自翻譯鍵，避免與檔案夾及介面尺寸共用詞意。
- Major：相簿有限存取／不可用提示在 hidden 屬性存在時明確 display:none，避免作者樣式覆蓋原生隱藏。
- Major：AI 同意文字更新既有 span，清除舊文字與該 span 的靜態翻譯標記，保留勾選框與切換供應商時撤銷同意。

全部修正後再次執行完整 npm test 通過（589 翻譯鍵）。CommercePolicy 實際 Swift 編譯與執行通過，包含 16 種權益條件與數字識別碼遮蔽；PhotoLibraryPlugin Swift 語法解析通過。Photos 平台編譯已由 build 14 iOS 建置通過，完整 Photos 裝置操作仍待驗收。

實際 WKWebView 六項檢查通過：OpenAI／Google 同意文字切換、單一 span、兩種照片提示的 hidden／visible 顯示。以原始碼實際快取判斷區塊執行 Swift 轉換測試，重複快照、撤權、恢復後再撤權均通過；這不是 Photos 完整實機測試。
