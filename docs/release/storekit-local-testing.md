# StoreKit 本機交易驗收

> 歷史開發紀錄：下列測試數字與裝置狀態是當時的觀察，不代表最新版本已通過相同驗收。最新掃描維修紀錄見 [scan-progress-repair-2026-09-09.md](scan-progress-repair-2026-09-09.md)；未完成事項仍以任務中心追蹤。

這組測試使用 Apple `StoreKitTest` 的 `SKTestSession` 載入
`src-tauri/tauri-plugin-ios-folder/ios/Tests/StoreKitCommerceTests/GAI.storekit`，再呼叫生產
`CommerceManager`。流程會驗證：初始無 Pro 權益、實際本機購買、
`Transaction.currentEntitlements` 讀到權益，以及退款撤銷後不再授予權益。

`GAI.storekit` 的 `com.windsheep.gai.pro.v1` 是一次買斷商品，價格固定為 **1.00 美元**，只供本機測試；它不是 App Store Connect 的正式售價，也不會建立或修改正式商品。

測試 target 另外帶入 `Tests/StoreKitTestSupport/MemoryPressureStub.c`。它只補上生產插件在 Tauri app runtime 取得的 `gai_memory_pressure` 連結符號，避免獨立 SwiftPM XCTest 因沒有 Rust app runtime 而無法連結；不會進入生產 target。

## 執行前提

- macOS 上安裝含 iOS Simulator runtime 的 Xcode，並以 Xcode toolchain 執行。
- 使用 iOS 15 或更新版本的 Simulator；StoreKitTest framework 由 Xcode 提供。
- 測試要序列執行，避免多個 `SKTestSession` 同時改寫同一個 StoreKit 本機環境。
- 交易測試不需要 App Store Connect 商品或 sandbox Apple ID；商品資料來自 `.storekit`。首次解析 SwiftPM 依賴可能仍需網路。

## 指令

先確認本機磁碟空間充足。建議使用 `bash scripts/release/stage-ios-build.sh` 建立本機副本，再進入該副本執行；不要在 SMB 上建立 SwiftPM 中間產物。

在建置副本根目錄執行以下指令。先由 XcodeGen 產生帶有 iOS host app 的 Xcode project。本輪直接以 SwiftPM XCTest 執行時已完成編譯與連結，但 StoreKit 回報 `SKInternalErrorDomain Code=3`，錯誤中的測試程序為 `com.apple.dt.xctest.tool`；改用明確的 App 宿主驗證，仍需以實際交易結果判斷是否解決。

```sh
cd src-tauri/tauri-plugin-ios-folder/ios/Tests/StoreKitHost
xcodegen generate --spec project.yml
xcodebuild test \
  -project GAIStoreKitHost.xcodeproj \
  -scheme GAIStoreKitHost \
  -destination 'platform=iOS Simulator,id=77507FC2-88B2-4861-B0B5-22132424A427' \
  -parallel-testing-enabled NO \
  -derivedDataPath /tmp/gai-storekit-derived
```

若該 Simulator 尚未啟動，可先執行：

```sh
xcrun simctl boot 77507FC2-88B2-4861-B0B5-22132424A427
xcrun simctl bootstatus 77507FC2-88B2-4861-B0B5-22132424A427 -b
```

完成條件是測試輸出顯示
`CommerceStoreKitTests.testPurchaseCurrentEntitlementAndRevocation` 通過。
`Tests/StoreKitHost/project.yml` 會建立 `com.windsheep.gai.storekittest` host app，測試 target 明確設定 `TEST_HOST` 與 `BUNDLE_LOADER`，並在 scheme 指定 `GAI.storekit`。測試仍直接 `@testable import tauri_plugin_ios_folder` 並呼叫生產 `CommerceManager`；host app 只提供 StoreKitTest 所需的 app runtime。

## 隔離 host 人工驗收 UI

`Tests/StoreKitHost/App/StoreKitHostApp.swift` 現在提供最小 SwiftUI 驗收畫面。畫面會在啟動時呼叫生產 `CommerceManager.getCommerce()`，並提供三個動作：重新整理權益、購買 Pro、恢復購買。畫面直接顯示 `pro`、`status`、商品 ID、價格與生產 payload 的訊息，因此可以在退款後按「重新整理權益」觀察 `currentEntitlements` 的結果；沒有複製商務規則、假造 Pro 狀態或自行推導交易 ID。

host app 以 `@testable import tauri_plugin_ios_folder` 存取未公開的生產 `CommerceManager`，只在隔離測試專案使用，沒有擴大生產 API。package 由 host app 實際連結；單元測試保留 `link: false` 的 package 編譯依賴以解析既有 `@testable import`，但不再次連結靜態 library，避免 app 與 test target 產生雙重靜態連結。

### 之後的 build 與人工測試

在 `src-tauri/tauri-plugin-ios-folder/ios/Tests/StoreKitHost` 執行：

```sh
xcodegen generate --spec project.yml
xcodebuild build \
  -project GAIStoreKitHost.xcodeproj \
  -scheme GAIStoreKitHost \
  -destination 'platform=iOS Simulator,id=77507FC2-88B2-4861-B0B5-22132424A427' \
  -derivedDataPath /tmp/gai-storekit-host-derived
```

也可以用 Xcode 開啟產生的 `GAIStoreKitHost.xcodeproj`，選 iPhone 17（或其他 iOS 15+ Simulator）執行 `GAIStoreKitHost`。啟動後先觀察初始 `Pro` 與 `狀態`，再按「購買 Pro」完成本機購買；接著在 Xcode 的 StoreKit Configuration／Manage Transactions 對該本機交易執行退款，回到 host 按「重新整理權益」，確認 Pro 狀態依生產 `currentEntitlements` 更新。必要時可按「恢復購買」觀察生產 `restorePro()` 的結果。

這些步驟只描述之後要執行的人工驗收；本輪沒有重新 build、沒有驗證購買或退款，也沒有宣稱退款撤銷已通過。既有自動化測試在 `SKTestSession.allTransactions()` 仍可能得到 `SKInternalErrorDomain Code=3`，該環境問題不由 host UI 偽裝成成功。

## Apple API 依據

### 2026-09-08 實跑結果

磁碟空間恢復後，已在 APFS 副本實際執行。SwiftPM 無宿主測試完成編譯，但 StoreKit 回報 `SKInternalErrorDomain Code=3`。改用 App 宿主後，另修正重複靜態連結及商品設定檔未加入 Resources 的問題；宿主測試仍在儲存設定、清除交易及取得交易時回報相同 Code 3，購買結果為 `unavailable`，因此**未通過交易驗收**。

最近一次日誌為 `/tmp/gai-storekit-host-03.log`，結果輸出目標為 `/tmp/gai-storekit-host-03.xcresult`；環境為 Xcode 26.6、iOS 26.5 Simulator。Apple 開發者論壇有相似的 CLI／iOS 26.5 回報，但目前只能視為線索，不能據此排除專案設定問題。2026-09-09 已補跑 Xcode IDE，仍回報相同錯誤；下一步應查 StoreKit 本機服務或使用另一個 runtime，本機目前只有 iOS 26.5。

- [Apple Developer Forums：XCTest 相關回報](https://developer.apple.com/forums/tags/xctest)

測試採用 Apple 官方 `sample-food-truck` 的 StoreKit 設定檔格式：其
`App/Store/Products.storekit` 使用 `NonConsumable` 產品與 `displayPrice`，本測試只保留 G.A.I 的單一商品 ID。
自動化控制使用 Apple `StoreKitTest` 的 `SKTestSession(contentsOf:)`、`clearTransactions()`、
`refundTransaction(identifier:)` 與 `disableDialogs`；這些 API 用來建立與清理本機交易環境。

參考：

- [Apple sample-food-truck Products.storekit](https://github.com/apple/sample-food-truck/blob/main/App/Store/Products.storekit)
- [Apple SKTestSession](https://developer.apple.com/documentation/storekittest/sktestsession)
- [Apple init(contentsOf:)](https://developer.apple.com/documentation/storekittest/sktestsession/init(contentsof:))
- [Apple clearTransactions()](https://developer.apple.com/documentation/storekittest/sktestsession/cleartransactions())

### 2026-09-09 Xcode IDE 對照

在隔離 APFS 宿主專案以 Xcode 26.6 選定 iPhone 17（iOS 26.5）並執行 Test。啟動期間曾長時間停留於 dyld 的偵錯器載入通知，但之後自行進入測試；01:26 結束，1 個測試失敗、0 通過。主控台再次出現 `SKInternalErrorDomain Code=3`，購買為 `unavailable`，並未建立 Pro 權益。此結果表示 IDE 啟動本身不足以排除問題，不能據此認定是 CLI 獨有問題。

`xcresulttool get test-results summary` 的機器結果已保存 `output/release/2026-09-09-storekit-ide/summary.json`；啟動階段取樣保存 `startup-sample.txt`。原始 xcresult 在本機 Xcode DerivedData，日期為 `2026.09.09_01-17-24-+0800`。本輪未修改生產交易邏輯，未將模擬權益當成真實購買。

另一個待驗證線索：Apple Developer Forums 的 XCTest 使用者回報需先由 IDE Run 啟動，再停止並 Test，單獨 Test 不一定同步設定；這是第三方實測線索，不是 Apple 保證或本專案已通過的結果。來源：https://developer.apple.com/forums/tags/xctest 。本輪繼續以現有隔離宿主驗證，不安裝額外 runtime。

#### 先 Run 再 Test 的實測結果

本輪由 IDE Run 啟動宿主後停止，再 Test。初始設定／清除交易／disableDialogs 仍回 Code 3，但出現 G.A.I Pro (Test) 的 Xcode 本機購買單，明示不會收費；手動點購買與成功提示後，測試的 purchased、pro=true 與 currentEntitlements 斷言均未失敗。唯一失敗移至第 53 行：SKTestSession.allTransactions() 仍回 Code 3，無法取回測試交易，因此未進入 refundTransaction 與撤銷驗證。01:47 結束，1 測試、1 失敗；機器結果及 xcresult 保存於 `output/release/2026-09-09-storekit-ide/warmup-test-summary.json` 與 `warmup-ide-test.xcresult`。

這只證明 Xcode 本機購買與權益讀取的部分流程，並非 StoreKit 自動化、退款撤銷、TestFlight sandbox 或正式環境通過。兩次 IDE 測試皆已結束；Run 的 LLDB RPC server 曾由 Xcode 終止，僅針對本次測試宿主執行 simctl terminate 清理，未終止使用者其他程序。
