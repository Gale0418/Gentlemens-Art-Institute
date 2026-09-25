# G.A.I build22 交付紀錄（2026-09-25）

- 變更：閱讀器「寬度適應」短圖在單頁與雙頁模式垂直置中；圖片超出視窗時仍能從頂端捲動。自動與高度適應既有置中規則維持有效。iOS `bundleVersion` 21 → 22。
- 驗證：`npm test` 全套通過、`git diff --check` 通過、Tauri 設定 JSON 可解析。macOS Release binary 建置成功；iOS Release、archive、debugging export 成功。
- 桌面：`/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.app` 已覆蓋成唯一桌面版本。`CFBundleVersion` 為 22；`codesign --verify --deep --strict` 通過，實際啟動並看到書架畫面。
- iPad：`com.windsheep.gai` 1.0.0（22），Team `X3UYL4NRRN`，IPA 驗簽通過。2026-09-25 14:30 透過 Wi-Fi 覆蓋安裝；裝置回讀 1.0.0（22），啟動成功且程序持續執行。實際手指操作與閱讀互動仍待使用者驗收。
- 唯一新版交付包：`output/release/latest/G.A.I-1.0.0-build22-development.ipa`，SHA-256 `feec066d25d0760ed3ff1cf57d9d8599a66547c00840231695e7b244b18092b0`。build21 IPA 已移除。
