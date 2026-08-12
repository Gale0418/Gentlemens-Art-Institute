# Legacy 與相容層

本專案的正式桌面與 iPad 版本皆以 `src-tauri/` 為主。

根目錄的 `main.js`、`preload.js`、`server.js` 與 `scan-depth.js` 是舊 Electron／瀏覽器相容層，目前仍保留，讓既有測試與緊急回退路徑可繼續使用：

- `npm run build`：正式 Tauri macOS App 與 DMG。
- `npm run build:electron`：舊 Electron 備援建置。
- `npm run electron`：啟動 Electron 備援版。
- `npm start`：啟動瀏覽器備援版。

不要把新功能只加到 Electron／Express；正式功能應優先實作於 `src-tauri/`，並共用 `public/` 前端。
