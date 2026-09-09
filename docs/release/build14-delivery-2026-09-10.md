# build 14 本機交付（2026-09-10）

CodeRabbit 兩輪取得的 19 個 issues 已核實處理，程式提交 `8577c2a` 已推送 GitHub main。第三次審查完整完成 150 檔；修正後未超過每小時三次限制再送第四輪。詳見 [審查紀錄](coderabbit-review-2026-09-10.md)。

- macOS：本機 debug 測試 App，版本 1.0.0／build 14；補齊 ad hoc bundle 簽章後 deep／strict 驗證通過。已替換桌面 App、保留舊 App 備份與原有使用者資料，啟動後原生 accessibility 可讀到書架。
- iPad：development IPA 1.0.0／build 14，完整 Xcode 編譯、archive 與 export 成功；簽章、Bundle ID、iPhone／iPad device family、三語用途字串及 canonical Privacy Manifest 均通過。
- 使用者拔線後，CoreDevice 回報 `transportType=localNetwork`、`tunnelState=connected`。同一無線連線完成安裝、版本回讀、啟動；安裝後再次確認仍走 localNetwork。原有配對保持有效，沒有解除配對或重設網路。
- Xcode Devices 顯示版本 14 與網路圖示；無線 Take Screenshot 取得 iPad 書架畫面。截圖保留在本機忽略的交付證據中，不隨 Git 上傳。

本輪完整 npm test 通過（589 翻譯鍵）、WKWebView 6/6、CommercePolicy Swift 編譯執行、Photos Swift 語法及實際快取判斷區塊轉換測試通過。原生 Photos 修改也已由上述 iOS 正式建置流程編譯通過。

這次完成的是本機裝置交付，沒有提交 TestFlight／App Store。大書庫完整掃描、閱讀觸控手感、StoreKit 購買／恢復／退款與 App 內 AI 全流程仍需實機驗收；啟動成功與一張書架截圖不替代這些結果。iPhone 本輪未更新。Repository 維持 private，等待既有 GitHub 舊內容清除處理。

產物雜湊：

- iOS IPA SHA-256：`93fbf5bb455248d488e25632a0a145677d6ba340861ef738d78a2bb1f5e3cc0b`
- macOS 已安裝執行檔 SHA-256：`6494db6a790e665ae8833bc6437867ad1bccf65510156022d977cf44927c4f64`
