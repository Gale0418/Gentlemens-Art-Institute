# G.A.I build27 交付紀錄（2026-09-26）

## 問題與修正

- iPad 條漫從「繼續閱讀」恢復後，實機截圖顯示可見區是第 34–36 頁的黑色未載入圖片，但頁碼仍顯示第 16／223 頁。這表示虛擬視窗使用的預估頁高與未載入 `img` 的實際佔位高度不一致，並且恢復頁附近未被保證立即載入。
- 現在未載入圖片明確採用虛擬視窗的預估高度，恢復頁附近的圖片立即設置 `src` 並使用 eager 載入；載入完成後才改用實際圖片高度。
- 恢復進度會限制在目前書檔的有效頁數內；關閉閱讀器時清除舊條漫延遲存檔，避免寫進下一本漫畫。

## 驗證與交付

- `npm test` 通過；新增 223 頁漫畫後段恢復、過期超界進度及關閉後延遲存檔測試。
- macOS Release App 與 DMG 建置成功；桌面 App 更新為 1.0.0（27），簽章驗證及啟動成功。
- iOS debugging IPA 匯出成功，內部 App build 27 簽章驗證通過；iPad 安裝後 `devicectl device info apps` 回讀 1.0.0（27），程序啟動成功。重新擷取的實機畫面在單頁模式已顯示圖片；條漫模式仍待使用者切換後截圖確認。
- 最新安裝包：`output/release/latest/G.A.I-1.0.0-build27-macOS.dmg`，SHA-256 `bec4a7668bb93618b1e4c8661821d9c3d6ea1edbe14635ce3115e75ad980f0d3`；`output/release/latest/G.A.I-1.0.0-build27-development.ipa`，SHA-256 `58476587f41cca1464b61b633cc6bf12e4ab893a8a56c8735cfb49eed0ec8339`。
- CodeRabbit CLI 審查因免費額度 3 次已用完而回報 `Rate limit exceeded`；本輪未取得 CodeRabbit 結果。
