# Pro 購買驗收紀錄（2026-09-25）

本輪針對 build22 執行可用的本機、桌面與 App Store Connect 唯讀檢查；隨後使用者回報 G.A.I Pro 以 NT$150 購買成功。交易環境、裝置上的 build 與收據尚未獨立回讀，因此以下自動化測試結果與使用者回報分開記錄。

- 桌面 App：實際開啟設定，顯示「Pro 已啟用」，購買與恢復按鈕皆停用。這符合 `src-tauri/src/commerce.rs` 的非 iOS 政策（`supported: false`、`pro: true`）；桌面結果不可當作 iOS 免費／Pro 權益證據。
- 前端：`node tests/commerce-ui.mjs` 通過，涵蓋購買狀態、取消、還原不可用、過期權益與焦點管理。此測試使用 mock bridge，沒有呼叫 StoreKit。
- Swift 策略：`CommercePolicy.swift` 搭配 `tests/CommercePolicyChecks.swift` 執行，16 組權益與離線 payload 檢查通過；這不是交易測試。
- App Store Connect：App `6809937717` 與 Bundle ID `com.windsheep.gai` 回讀相符。IAP `6809937934`／`com.windsheep.gai.pro.v1` 為 `NON_CONSUMABLE`，台灣基準價 TWD 150；商品狀態 `MISSING_METADATA`。版本 1 為 `PREPARE_FOR_SUBMISSION`，有 zh-Hant／en-US／ja 三語本地化，但審查圖片關聯為空。缺圖片可能是 metadata 缺口之一，尚未取得 Apple 的逐欄診斷。
- TestFlight：`asc builds list --app 6809937717 --platform IOS --version 1.0.0` 回傳空清單；目前沒有可供同版 TestFlight 交易驗收的 processed build。
- StoreKit 本機 host：在隔離 APFS 副本補齊本機 `Tauri` Swift 套件後，Xcode 編譯了生產 Swift 插件、host App 與 `CommerceStoreKitTests.swift`，並驗證 host App bundle。專用 iPhone 17 模擬器雖顯示 Booted，但 `bootstatus` 長時間未完成；`xcodebuild test` 在測試案例開始前停住，最後由本輪中止，日誌為 `/tmp/gai-storekit-20260925-run2.log`（`** TEST INTERRUPTED **`）。未取得購買、`currentEntitlements` 或退款撤銷的新結果。
- Rust：本輪聚焦 `commerce::tests` 因 Debug 依賴從零編譯且與 Xcode 測試競爭本機資源，已中止，不能宣稱本輪通過。先前 build21 同一份 Rust 程式的完整測試為 144 passed／1 ignored；build22 僅變更閱讀器 CSS 與 bundleVersion。
- iPad：build22 已安裝、回讀與啟動。使用者於 2026-09-25 回報「GAI也購買成功啦 150唷」；這是 G.A.I Pro NT$150 購買成功的使用者實測回報，尚未取得交易收據、測試環境、購買後權益畫面，亦未驗證恢復、重啟離線或退款撤銷。

下一步需核對此筆交易的環境與購買後權益，補齊 ASC 商品 metadata；再驗證恢復、重啟離線與撤銷，最後以同一 processed TestFlight build 驗收正式發行路徑。
