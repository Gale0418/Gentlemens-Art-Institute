# Pro 實作與上架研究紀錄

> 歷史開發紀錄：下列測試數字與裝置狀態是當時的觀察，不代表最新版本已通過相同驗收。最新掃描維修紀錄見 [scan-progress-repair-2026-09-09.md](scan-progress-repair-2026-09-09.md)；未完成事項仍以任務中心追蹤。

日期：2026-09-08。狀態：原始碼已整合，交易與正式發行驗收仍未完成。

## 採用的技能與來源

已讀取本機 `asc-cli-usage`、`asc-signing-setup`、`asc-testflight-orchestration`、`asc-submission-health` 與 digital-goods 參考，並核對 GitHub 的 [app-store-connect-cli-skills](https://github.com/rorkai/app-store-connect-cli-skills)。[digital-goods 指引](https://github.com/rorkai/app-store-connect-cli-skills/blob/main/skills/asc-submission-health/references/digital-goods.md) 提醒首次 IAP 應隨版本準備審查，需核對商品、價格、在地化與審查截圖；CLI 支援不足的步驟需使用正式 ASC 介面，不假造成功。

原生依據為 [Apple StoreKit](https://developer.apple.com/storekit/) 與 [currentEntitlements](https://developer.apple.com/documentation/storekit/transaction/currententitlements)。曾比較 [tauri-plugin-iap](https://github.com/Choochmeque/tauri-plugin-iap)，此版本採既有 iOS 插件中的小型 StoreKit 2 模組，減少單一非消耗商品需要的依賴與維運。iOS 最低版本統一為 15.0。

## 多角度取捨（模擬審查視角）

- 產品：免費閱讀與資料出口完整；付費集中於直接 NAS、批次整理、重複候選、雲端 BYOK AI。系統檔案選擇器的掛載資料夾維持免費。
- iOS／安全：權益取自 StoreKit 已驗證交易；Rust 在執行 Pro 命令前再次檢查。前端旗標不構成授權。
- 體驗：價格只採 Apple 當地格式，查不到價格就停用購買；取消、等待核准、恢復失敗各自顯示。瀏覽器預覽沒有假解鎖。
- 資料保護：退款不刪除書庫、既有 AI 結果、匯出與復原資料；檔案能力查詢不觸發付費視窗或未授權 NAS 探測。
- 維運：不引入訂閱伺服器或自建收據資料庫；雲端 AI 使用使用者自己的 API key，API 費用另計。不提供裝置端模型。

Antigravity 提供原生 Swift 草稿，主代理實際落地並修正 actor 初始化、價格查詢失敗與恢復錯誤；Luna 完成前端，另進行獨立唯讀稽核。角色模擬不是外部專業人士背書。

## 可重現檢查

- `npm test`：五組前端／安全／排程／商業流程檢查通過。
- `swiftc src-tauri/tauri-plugin-ios-folder/ios/Sources/CommercePolicy.swift tests/CommercePolicyChecks.swift -o /tmp/gai-commerce-policy-check && /tmp/gai-commerce-policy-check`：16 組權益條件及離線 payload JSON 通過。此為純邏輯測試，不是交易驗收。
- `cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios --locked --lib`：通過，包含 Swift 插件編譯。現有 wry 警告與 iOS 條件編譯的未使用變數警告仍存在；不是 archive、簽章或實機證據。

- `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`：112 項通過。
- Chrome 人工操作確認設定與 Pro 對話框可開啟，預覽不提供購買價格；修正不可用交易狀態與預覽恢復按鈕。

## 發行仍缺少的證據

本次登入帳號的 ASC 唯讀查詢未找到 `com.windsheep.gai` App record。程式暫用 `com.windsheep.gai.pro.v1`；尚未建立遠端商品、定價、上傳或送審。

需完成 StoreKit／sandbox 購買、取消、pending、恢復、重啟、離線、退款撤銷與免費資料存取矩陣，並補齊實機、TestFlight、隱私與商店素材。不得用本紀錄的邏輯測試替代真實交易證據。

## 獨立稽核處理

已補進階待整理清單與停用標籤的後端權益檢查；重新啟用與 undo 保持免費。標籤釘選／顏色歸基本標籤，不因 UI 分類誤鎖。AI 全書隨讀遇到權益拒絕即停止，不由背景請求跳出付款框；後端拒絕也會使前端過期的 Pro 狀態失效。

稽核提出撤銷後已開啟的 NAS 暫存仍可閱讀：保留此行為，因 protocol 僅讀既有本機暫存，沒有新 NAS 網路請求；撤銷不刪除使用者已取得內容。新的直接 NAS 掃描、開啟與修改仍須原生權益。此為資料保留取捨，需在實機退款測試確認沒有新增網路活動。

Chrome 最後驗收確認預覽中的購買／恢復都停用，對話框顯示不可交易原因，Escape 關閉後焦點回到「查看完整範圍」。新增回歸測試確認恢復不可用訊息保留與過期前端 Pro 失效。

2026-09-08 目標續作：SMB 工作磁碟恢復可讀後，最終增量 iOS cargo check 再次通過（53.63 秒）；日誌 `/tmp/gai-goal-ios-check.log`。Chrome 本輪因管理政策安全檢查無法驗證而拒絕預覽存取，沒有繞過、不採計 PERF23 通過。

## Goal 續作驗證

- 新增 StoreKitTest 真實本機交易 harness（購買、權益、退款撤銷）及測試配置，詳 `storekit-local-testing.md`；只做了結構檢查，未跑實際交易。缺少配置會失敗，不會以 skip 冒充成功。
- 修正示範卡使正式空庫啟動等待失效的問題，回歸測試驗證空庫仍有六次等待、有正式資料只查一次。
- 修正 AI 同意標籤因空白 text node 殘留舊 Google 文字；行為測試確認供應商切換後只顯示對應文案，並清除先前同意。
- 修正 fixture 封面讀取失敗未回 HTTP 回應、圖示檢查缺檔訊息，以及 Pro 錯誤理由被覆蓋。
- `npm test` 通過；新增 AI 同意行為測試單獨通過；18 張正式 iOS 圖示一致性通過。
- `stage-ios-build.sh` 建立唯一乾淨本機副本，排除使用者設定、進度、DB、舊產物與 `.cargo`。已驗證 syntax 與低於 6 GiB 的 fail-closed 分支。
- Mac 可用磁碟由約 1.4 GiB 降至 761 MiB；已回收本輪唯一 staging，不清理其他任務產物。完整 archive／Xcode StoreKit 測試等待空間。

CodeRabbit light review 超過 10 分鐘未完成，已停止；已回傳 10 issues（2 major、8 minor），不能宣稱完成複審。兩個 major 是示範卡掩蓋冷啟動空庫與 fixture 封面未捕捉讀取例外，均已修正。7 個 minor 已修正文案、空路徑、錯誤理由與圖示缺檔處理；另 1 個建議將 PRODUCT Platform 的 `adaptive` 改成句子不採用：Impeccable `scripts/context.mjs` 的 `extractPlatform` 要求第一行為精確 schema 值，改寫會破壞平台識別。

## 磁碟恢復後的實際驗證

- 本機空間恢復至 12 GiB 以上，建立新的 APFS 建置副本。從 SMB 複製的 `node_modules/.bin/tauri` 是失去連結語意的一般檔案，造成 `Cannot find module './main'`；改以副本內 `npm ci --ignore-scripts` 成功修復，staging 腳本也停止複製依賴目錄。
- 真實 StoreKit 測試已啟動：補上 App 宿主，修正重複靜態連結與資源打包。最新宿主執行仍回報 `SKInternalErrorDomain Code=3`，購買為 `unavailable`，未通過。詳見 `storekit-local-testing.md`。
- Release CLI 發現 Cargo 的 `gai` 與舊 Xcode `app` 專案名稱不一致，尚未進入 archive；不能沿用先前 IPA 作為目前 Pro 版本證據。
- Mission Center 的 `sync` 在 APFS 副本也回報 `command_error`，因此先前的 SMB 假設不足以解釋問題；未擅自重寫任務生命週期。

後續已完成 staging 專案改名與獨立 iOS build 版本修正，成功匯出並驗證 `1.0.0 (2)` 開發 IPA。iPad 安裝成功，啟動因裝置鎖定被拒絕；iPhone 安裝前的開發映像掛載也因鎖定失敗。最新產物、SHA-256、簽章與未完成項目見 [build 2 實機驗收紀錄](ios-build2-2026-09-08.md)。

23:51–23:53 使用者解鎖後，iPad、iPhone 均成功啟動 build 2；iPad 約 30 秒後仍在程序清單。使用者確認 iPad 畫面、示範書開啟、翻頁與返回書庫正常，基本閱讀 smoke 通過；交易與完整實機矩陣仍未完成。
