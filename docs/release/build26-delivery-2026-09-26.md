# G.A.I build26 交付紀錄（2026-09-26）

## 修正

- 從「繼續閱讀」開啟漫畫後，返回書架會顯示該漫畫所在的資料夾，並清除會遮住該漫畫的系列、狀態與搜尋篩選。一般書架入口仍保留原本的目錄；閱讀器切換相鄰漫畫時延續返回目標。
- macOS 與 iOS 的 bundle build number 同步設為 26；macOS App 使用 ad hoc 簽章。

## 驗證與交付

- `npm test` 通過；新增 Continue 返回深層資料夾、一般書架入口與相鄰漫畫切換的回歸案例。
- CodeRabbit 針對 `public/app.js`、`src-tauri/tauri.conf.json`、`tests/catalog-scheduling.mjs` 提出 0 個 issues。
- macOS Release App 與 DMG 建置成功。桌面使用中的 App 已更新到 `com.windsheep.gai` 1.0.0（26），`codesign --verify --deep --strict` 通過且啟動成功。
- iOS debugging IPA 匯出成功。IPA 內 App 為 `com.windsheep.gai` 1.0.0（26），Team `X3UYL4NRRN`；深度嚴格簽章驗證通過。iPad 安裝後 `devicectl device info apps` 回讀 1.0.0（26），程序啟動成功。
- 最新安裝包：`output/release/latest/G.A.I-1.0.0-build26-macOS.dmg`，SHA-256 `c33245412d42eda66e270d8aed855e4b0becc5d441a7c23ba9f1a55550340e7d`；`output/release/latest/G.A.I-1.0.0-build26-development.ipa`，SHA-256 `18dab28618b52b629fb5ffac8cb89268533dd6b428a4799e4ffddb259d4a0fd7`。
- iPad 上的實際觸控返回流程仍待人工操作確認；開發版 IPA 不是 App Store 發行包。
