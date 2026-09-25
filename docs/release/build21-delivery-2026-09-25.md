# G.A.I build21 交付紀錄（2026-09-25）

- 來源：`main` 的 `9daf15a`，加上當時既有的掃描／導覽工作樹修改，以及 iOS `bundleVersion` 20 → 21；這八個檔案的 `git diff --binary` SHA-256 為 `c68213d4f2bbd6ca22d2c70b8d59ed37a64c9525fdc8b2b168fb860bef38b3d6`。未將原有工作樹改動視為已提交版本。
- 桌面：以同一份來源建置 Release Rust binary，封裝成單一桌面 App，`CFBundleVersion` 為 21。`codesign --verify --deep --strict` 通過；啟動後實際看到書架、搜尋與設定，舊桌面 App、build10–15 備份及 build17 舊版已移除。
- iPad：本機 APFS staging 的 Tauri iOS Release/archive/debugging export 成功；IPA 內為 `com.windsheep.gai` 1.0.0（21），Team `X3UYL4NRRN`，`codesign --verify --deep --strict` 通過。當時交付包 SHA-256 為 `aadb4d3433b1fe2e8ee8567eaf32efb19a420c80e5d674685edee4aca35a5903`；已由 build22 覆蓋並移除舊 IPA。
- 驗證：`npm test` 全套通過；`npm run check:rustfmt` 通過；Rust 144 passed、1 ignored。iOS IPA 成功建立不等於實機互動驗收。
- 裝置安裝：首次 Wi-Fi 覆蓋安裝遭 `IXRemoteErrorDomain error 6`（連線中斷），當時回讀仍是 build20。iPad 解鎖後經 Wi-Fi 重試成功；2026-09-25 14:12 裝置回讀 `com.windsheep.gai` 1.0.0（21），`devicectl` 啟動成功，程序仍在執行。閱讀、觸控與 AI 目前頁面仍待實機互動驗收。
