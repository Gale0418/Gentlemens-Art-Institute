# 少女漫畫閣 — 完整建構與部署手冊

> 寫給未來的 AI 代理人（Antigravity / Codex）看的，如果妳不懂背景請從頭看！

---

## 📐 一、專案架構概覽

這是一個用 **Tauri 2 + Rust** 後端、**Vanilla HTML/JS/CSS** 前端所建構的漫畫閱讀器 App，支援 **macOS 桌面版** 與 **iPad iOS 版**。

```
/Volumes/MyGame/comic/               ← 主專案（位於 SMB 外接硬碟）
├── public/                          ← 前端
│   ├── index.html                   ← 主畫面（382行）
│   ├── style.css                    ← 全部樣式（2263行）
│   ├── app.js                       ← 主邏輯（2711行）
│   └── tauri-api.js                 ← Tauri/Electron 橋接層（75行）
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                   ← Tauri 命令入口（495行）
│   │   ├── state.rs                 ← 全域共享狀態
│   │   ├── scanner.rs               ← 本機漫畫掃描器
│   │   ├── smb_scanner.rs           ← SMB/NAS 掃描器
│   │   ├── cache.rs                 ← 預載 RAM 快取
│   │   ├── protocol.rs              ← comic:// 自訂協議（圖片伺服）
│   │   └── utils.rs                 ← ZIP 解析、資料夾讀取
│   ├── tauri-plugin-ios-folder/     ← 自製 iOS 資料夾書籤外掛
│   └── Cargo.toml
├── DEV_NOTES.md                     ← 踩坑歷史紀錄（必讀！）
└── BUILD_GUIDE.md                   ← 本檔案
```

---

## 🔑 二、關鍵系統資訊

| 項目 | 值 |
|---|---|
| 主專案路徑 | `/Volumes/MyGame/comic` |
| NAS（漫畫）IP | `192.168.0.50` (`DavidCNAS.local`) |
| NAS（專案）IP | `192.168.0.60` |
| iPad UUID（xcrun） | `YOUR_DEVICE_UUID` |
| iPad 裝置名稱 | Pe的 iPad (2) |
| Apple 開發者帳號 | `wiuwwror@hotmail.com` |
| Bundle ID | `com.windsheep.comicreader` |
| 簽名 Identity | `B6A670B80A7585975850D5E3F0D3F31AA846CDB0` |

---

## 🍎 三、macOS 桌面版建構流程

macOS 版可以直接在外接硬碟（`/Volumes/MyGame/comic`）建構，沒有限制。

### 3.1 開發測試（Hot Reload）

```bash
cd /Volumes/MyGame/comic
npm run tauri dev
```

> 會直接開啟一個桌面視窗，程式碼改完立即熱更新。

### 3.2 打包為 .app / .dmg

```bash
cd /Volumes/MyGame/comic
npm run tauri build
```

> 輸出位置：`/Volumes/MyGame/comic/src-tauri/target/release/bundle/`
> - `macos/comic-reader.app` — 直接拖入 Applications 可用
> - `dmg/comic-reader_*.dmg` — 安裝包

---

## 📱 四、iPad / iOS 版建構與空投流程

### ⚠️ 最重要的注意事項

**絕對不能在 `/Volumes/MyGame/comic`（外接硬碟）直接建構 iOS 版！**

原因：macOS 在外接硬碟（SMB / exFAT）上無法建立 symlink 與修改 `Info.plist` 的擴展屬性，Xcode 的建構腳本會報 `Operation not supported` 錯誤。

### ⚠️ 另一個超級重要的陷阱

`.cargo/config.toml`（如果存在）裡面若設定了 `target-dir`，會讓 `xcodebuild` 找不到編譯好的靜態庫 `libapp_lib.a`，導致 `BUILD FAILED`。**在編譯前務必刪除這個檔案！**

### 4.1 準備編譯環境

```bash
# 1. 清除舊的暫存並同步最新程式碼
rm -rf /tmp/comic
rsync -av \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'src-tauri/target' \
  --exclude 'src-tauri/gen/apple/build' \
  --exclude '.cargo' \
  --exclude '.git' \
  /Volumes/MyGame/comic/ /tmp/comic/

# 2. 安裝前端依賴
cd /tmp/comic
npm install
```

### 4.2 編譯 iOS App（底層直接呼叫 xcodebuild，完全不用打開 Xcode）

```bash
cd /tmp/comic
npm run tauri ios build
```

> 這個指令背後做的事：
> 1. 呼叫 `cargo build --target aarch64-apple-ios --release` 編譯 Rust 靜態庫
> 2. 呼叫 `xcodebuild` 把靜態庫連結進 `.app` 並簽名
> 3. 打包成 `.ipa` 輸出到 `/tmp/comic/src-tauri/gen/apple/build/arm64/comic-reader.ipa`
>
> 編譯時間約 **4~6 分鐘**（第一次需要下載所有 crate 依賴，更久）

### 4.3 解壓縮 IPA（⚠️ 關鍵步驟，千萬別跳過）

```bash
rm -rf /tmp/ipa_extract
unzip -q /tmp/comic/src-tauri/gen/apple/build/arm64/comic-reader.ipa -d /tmp/ipa_extract
```

> ❌ **絕對不要**使用 `app_iOS.xcarchive` 裡面的 `.app`！
> 那個資料夾是 Xcode 歸檔用的，`tauri ios build` 不會更新它，永遠是舊版本！

### 4.4 空投進 iPad（用傳輸線連接後執行）

```bash
# 確認裝置已連線
xcrun devicectl list devices

# 安裝（UUID 固定，不需每次查）
xcrun devicectl device install app \
  --device YOUR_DEVICE_UUID \
  /tmp/ipa_extract/Payload/comic-reader.app
```

成功輸出範例：
```
App installed:
• bundleID: com.windsheep.comicreader
• installationURL: file:///private/var/containers/...
```

### 4.5 完整一鍵腳本（每次有新改動時執行）

```bash
#!/bin/bash
set -e

echo "📦 同步程式碼到 /tmp/comic..."
rm -rf /tmp/comic
rsync -av --exclude 'node_modules' --exclude 'dist' \
  --exclude 'src-tauri/target' --exclude 'src-tauri/gen/apple/build' \
  --exclude '.cargo' --exclude '.git' \
  /Volumes/MyGame/comic/ /tmp/comic/

cd /tmp/comic
npm install

echo "🔨 開始 iOS 編譯..."
npm run tauri ios build

echo "📦 解壓縮 IPA..."
rm -rf /tmp/ipa_extract
unzip -q src-tauri/gen/apple/build/arm64/comic-reader.ipa -d /tmp/ipa_extract

echo "🚀 空投進 iPad..."
xcrun devicectl device install app \
  --device YOUR_DEVICE_UUID \
  /tmp/ipa_extract/Payload/comic-reader.app

echo "✅ 完成！iPad 上請重新開啟 App。"
```

---

## 🏗️ 五、系統架構深度說明

### 5.1 前端橋接層設計（tauri-api.js）

前端使用一個「橋接層」的設計模式：

```
前端 app.js
    ↓ 呼叫 window.electronAPI.xxx()
tauri-api.js  ←── 偵測到 window.__TAURI__ 時，把 electronAPI 覆寫成 Tauri invoke
    ↓
Rust 後端命令
```

這個設計讓前端完全不用知道自己是在 Electron 還是 Tauri 環境！

### 5.2 圖片伺服機制（protocol.rs）

後端實作了一個自訂的 `comic://` 協議，讓前端可以直接用 `<img src="comic://page/{id}/{index}">` 的方式載入圖片：

- `comic://page/{comic_id}/{page_index}` → 從 ZIP 解壓縮特定頁面
- `comic://folder/{folder_base64}/{image_index}` → 從資料夾讀取圖片

### 5.3 SMB/NAS 連線流程

```
前端點擊漫畫 → invoke('open_comic')
  → is_smb = true
  → 發送 smb-download-start 事件（前端顯示 loader）
  → smb2::connect(host:445, username, password)
  → client.connect_share(share_name)
  → client.read_file(路徑，斜線轉反斜線)
  → 寫入本機 ComicTemp 目錄（含父目錄建立）
  → 發送 smb-download-end 事件（前端隱藏 loader）
  → 回傳頁面列表給前端
```

### 5.4 記憶體預載快取（cache.rs）

開啟漫畫後，後台會非同步預載前 5 頁（最多 64MB）進 RAM：

```
open_comic() 成功
  → 觸發背景任務 preload_comic()
  → 用 spawn_blocking 在執行緒池讀取 ZIP
  → 寫入 ram_cache_pool (HashMap<ComicId, HashMap<PageIndex, Vec<u8>>>)
  → 每載入一頁發送 ram-cache-progress 事件
```

---

## 🐛 六、已知踩坑歷史（必讀）

| # | 問題 | 原因 | 解法 |
|---|---|---|---|
| 1 | iPad 看不到 SMB 按鈕 | 在外接硬碟建構失敗，裝了舊版本 | 改用 `/tmp/comic` 建構 |
| 2 | BUILD FAILED: libapp_lib.a 找不到 | `.cargo/config.toml` 的 `target-dir` 設定錯誤 | 刪除 `.cargo/config.toml` |
| 3 | 裝完 App 功能沒更新 | 誤用 `xcarchive` 裡的舊 `.app` | 必須從 `.ipa` 解壓後安裝 |
| 4 | 點擊子目錄 NAS 漫畫打不開 | 寫檔前忘記建立父資料夾 | 已在 `lib.rs` 補上 `create_dir_all` |
| 5 | `/tmp/comic` 消失了 | Mac 重開機後 `/tmp` 自動清除 | 每次改完程式碼重新 rsync |
| 6 | Xcode 找不到 Provisioning Profile | `project.pbxproj` 內的 Bundle ID 被手動開啟 Xcode 修改污染（與 `tauri.conf.json` 不一致） | 不要開 Xcode，直接修改 `project.pbxproj` 中的 `PRODUCT_BUNDLE_IDENTIFIER` 確保正確，或刪除 `gen/apple` 重建 |

---

## 🔍 七、偵錯技巧

### 查看 iPad App 的 console log

```bash
# 用 idevicesyslog 過濾 App 日誌（需要安裝 libimobiledevice）
idevicesyslog | grep "comic-reader"
```

### 查詢裝置 UUID

```bash
xcrun devicectl list devices
```

### 確認 IPA 裡的內容是最新的

```bash
# 在解壓縮後查看編譯時間
ls -la /tmp/ipa_extract/Payload/comic-reader.app/comic-reader
```

---

## 💡 八、優化建議（待實作）

詳見 `OPTIMIZATION_NOTES.md`（同目錄）。

---

*最後更新：2026-07-21*
