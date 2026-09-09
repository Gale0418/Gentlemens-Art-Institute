# iOS 隱私宣告建置與驗證

正式來源是 `src-tauri/ios-privacy/PrivacyInfo.xcprivacy`。`npm run build:ios` 在 Tauri 建置前執行 `sync:ios-privacy`，將檔案複製至產生的 Apple 專案，並確認 App target 的 Resources 包含此檔。

宣告涵蓋應用程式容器與使用者選取檔案的時間戳記，以及本 App 的 UserDefaults。此檔不是 App Store Connect 隱私問卷的替代品，也不代表第三方 SDK 或封裝成品已自動通過稽核。

## 本地檢查

```sh
npm run sync:ios-privacy
node scripts/sync-ios-privacy.mjs --check
node tests/ios-privacy-sync.mjs
plutil -lint src-tauri/ios-privacy/PrivacyInfo.xcprivacy
```

`--check` 不修改檔案。檔案不同、缺少資源引用或專案結構無法安全辨識時必須失敗。APFS staging 可把 Apple 專案目錄作為腳本的參數；不要把 root 的 app.xcodeproj 覆蓋到 gai.xcodeproj。

## 封裝後的必要驗收

每次準備送出的 IPA 必須另行解壓，確認 App bundle 根目錄只有一份 PrivacyInfo.xcprivacy，並用 plist 解析確認內容與 canonical 相同。再驗證簽章與 Xcode／App Store Connect 的實際檢查结果；腳本或 fixture 通過不能代替此步驟。

2026-09-09：root 與 APFS staging 的原始碼同步、Resources 引用檢查及 PBX plist 驗證通過；fixture 涵蓋缺引用與既有 group-relative 引用，不重複加入資源。既有 build 9 不含本輪新增的 C617.1，因此尚未完成新版 IPA 回讀。裝置本地網路提示、AI 同意流程和 ASC 問卷仍依 Mission Center 的 COMIC-P22 分別驗收。
