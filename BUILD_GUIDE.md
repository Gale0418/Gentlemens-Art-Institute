# 少女漫畫閣 — 完整建構與部署手冊

> 寫給未來的 AI 代理人（Antigravity / Codex）看的，如果妳不懂背景請從頭看！

---

## 📐 一、專案架構概覽

這是一個用 **Tauri 2 + Rust** 後端、**Vanilla HTML/JS/CSS** 前端所建構的漫畫閱讀器 App，支援 **macOS 桌面版** 與 **iPad iOS 版**。

```
${COMIC_PROJECT_DIR}/                ← 主專案（路徑由未追蹤環境設定提供）
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
└── BUILD_GUIDE.md                   ← 本檔案
```

---

## 🔑 二、關鍵系統資訊

| 項目 | 值 |
|---|---|
| 主專案路徑 | `${COMIC_PROJECT_DIR}`（未追蹤環境設定） |
| NAS（漫畫）主機 | `${COMIC_NAS_COMICS_HOST}`（未追蹤環境設定） |
| NAS（專案）主機 | `${COMIC_NAS_PROJECT_HOST}`（未追蹤環境設定） |
| iPad 裝置識別碼 | `${COMIC_DEVICE_ID}`（執行 `xcrun devicectl list devices` 取得） |
| iPad 裝置名稱 | `${COMIC_DEVICE_NAME}`（未追蹤環境設定） |
| Apple 開發者帳號 | `${APPLE_DEVELOPMENT_EMAIL}`（未追蹤環境設定） |
| Bundle ID | `com.windsheep.comicreader` |
| 簽名 Identity | `${APPLE_SIGNING_IDENTITY}`（未追蹤環境設定） |

請在本機未追蹤的 `.env.local`（或 CI secret store）設定上述變數，並在執行命令前載入；不要把裝置識別碼、帳號、簽名或 NAS 位址寫入版本庫。

---

## 🍎 三、macOS 桌面版建構流程

macOS 版可在 `${COMIC_PROJECT_DIR}` 建構；實際路徑請使用本機未追蹤環境設定。

### 3.1 開發測試（Hot Reload）

```bash
cd "${COMIC_PROJECT_DIR}"
npm run tauri dev
```

> 會直接開啟一個桌面視窗，程式碼改完立即熱更新。

### 3.2 打包為 .app / .dmg

```bash
cd "${COMIC_PROJECT_DIR}"
npm run tauri build
```

> 輸出位置：`${COMIC_PROJECT_DIR}/src-tauri/target/release/bundle/`
> - `macos/comic-reader.app` — 直接拖入 Applications 可用
> - `dmg/comic-reader_*.dmg` — 安裝包

---

## 📱 四、iPad / iOS 版建構與空投流程

### ⚠️ 最重要的注意事項

**不要在 `${COMIC_PROJECT_DIR}`（外接硬碟或 SMB 路徑）直接建構 iOS 版！**

原因：macOS 在外接硬碟（SMB / exFAT）上無法建立 symlink 與修改 `Info.plist` 的擴展屬性，Xcode 的建構腳本會報 `Operation not supported` 錯誤。

### ⚠️ 另一個超級重要的陷阱

`.cargo/config.toml`（如果存在）裡面若設定了 `target-dir`，會讓 `xcodebuild` 找不到編譯好的靜態庫 `libapp_lib.a`，導致 `BUILD FAILED`。**在編譯前務必刪除這個檔案！**

### 4.1 準備編譯環境

以下檢查必須放在任何 `rm`、`rsync` 或其他會覆寫/刪除檔案的命令之前。輸出目錄不可是 `/`、`$HOME`、專案根目錄，也不可與來源或彼此重疊。

```bash
fail_validation() { echo "❌ 建構路徑設定不安全：$1" >&2; exit 2; }
require_nonempty() { [ -n "$2" ] || fail_validation "$1 不可為空"; }
canonical_path() {
  if [ -d "$1" ]; then
    (cd -- "$1" && pwd -P)
  else
    local parent base
    parent=$(dirname -- "$1")
    base=$(basename -- "$1")
    parent=$(cd -- "$parent" 2>/dev/null && pwd -P) || return 1
    printf '%s/%s\n' "$parent" "$base"
  fi
}
paths_overlap() {
  case "$1" in "$2"|"$2"/*) return 0;; esac
  case "$2" in "$1"|"$1"/*) return 0;; esac
  return 1
}
validate_build_paths() {
  require_nonempty COMIC_PROJECT_DIR "${COMIC_PROJECT_DIR:-}"
  require_nonempty COMIC_IOS_WORK_DIR "${COMIC_IOS_WORK_DIR:-}"
  require_nonempty COMIC_IPA_EXTRACT_DIR "${COMIC_IPA_EXTRACT_DIR:-}"
  require_nonempty COMIC_DEVICE_ID "${COMIC_DEVICE_ID:-}"
  [ -d "$COMIC_PROJECT_DIR" ] || fail_validation "COMIC_PROJECT_DIR 必須是既有目錄"
  project_real=$(canonical_path "$COMIC_PROJECT_DIR") || fail_validation "無法解析 COMIC_PROJECT_DIR"
  case "$project_real" in /|"${HOME:-}") fail_validation "COMIC_PROJECT_DIR 不可為 / 或 HOME";; esac
  work_real=$(canonical_path "$COMIC_IOS_WORK_DIR") || fail_validation "無法解析 COMIC_IOS_WORK_DIR 的父目錄"
  ipa_real=$(canonical_path "$COMIC_IPA_EXTRACT_DIR") || fail_validation "無法解析 COMIC_IPA_EXTRACT_DIR 的父目錄"
  case "$work_real" in /|"${HOME:-}"|"$project_real") fail_validation "COMIC_IOS_WORK_DIR 是危險輸出目錄";; esac
  case "$ipa_real" in /|"${HOME:-}"|"$project_real") fail_validation "COMIC_IPA_EXTRACT_DIR 是危險輸出目錄";; esac
  paths_overlap "$project_real" "$work_real" && fail_validation "來源與 COMIC_IOS_WORK_DIR 重疊"
  paths_overlap "$project_real" "$ipa_real" && fail_validation "來源與 COMIC_IPA_EXTRACT_DIR 重疊"
  paths_overlap "$work_real" "$ipa_real" && fail_validation "兩個輸出目錄重疊"
}
validate_build_paths

# 1. 清除舊的暫存並同步最新程式碼
rm -rf "${COMIC_IOS_WORK_DIR}"
rsync -av \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'src-tauri/target' \
  --exclude 'src-tauri/gen/apple/build' \
  --exclude '.cargo' \
  --exclude '.git' \
  "${COMIC_PROJECT_DIR}/" "${COMIC_IOS_WORK_DIR}/"

# 2. 安裝前端依賴
cd "${COMIC_IOS_WORK_DIR}"
npm install
```

### 4.2 編譯 iOS App（底層直接呼叫 xcodebuild，完全不用打開 Xcode）

```bash
cd "${COMIC_IOS_WORK_DIR}"
npm run tauri ios build
```

> 這個指令背後做的事：
> 1. 呼叫 `cargo build --target aarch64-apple-ios --release` 編譯 Rust 靜態庫
> 2. 呼叫 `xcodebuild` 把靜態庫連結進 `.app` 並簽名
> 3. 打包成 `.ipa` 輸出到 `${COMIC_IOS_WORK_DIR}/src-tauri/gen/apple/build/arm64/comic-reader.ipa`
>
> 編譯時間約 **4~6 分鐘**（第一次需要下載所有 crate 依賴，更久）

### 4.3 解壓縮 IPA（⚠️ 關鍵步驟，千萬別跳過）

下列命令必須接在 4.1 的 `validate_build_paths` 成功之後執行，不要跳過路徑檢查單獨使用。

```bash
rm -rf "${COMIC_IPA_EXTRACT_DIR}"
unzip -q "${COMIC_IOS_WORK_DIR}/src-tauri/gen/apple/build/arm64/comic-reader.ipa" -d "${COMIC_IPA_EXTRACT_DIR}"
```

> ❌ **絕對不要**使用 `app_iOS.xcarchive` 裡面的 `.app`！
> 那個資料夾是 Xcode 歸檔用的，`tauri ios build` 不會更新它，永遠是舊版本！

### 4.4 空投進 iPad（用傳輸線連接後執行）

```bash
# 確認裝置已連線
xcrun devicectl list devices

# 安裝（識別碼由未追蹤環境設定提供）
xcrun devicectl device install app \
  --device "${COMIC_DEVICE_ID}" \
  "${COMIC_IPA_EXTRACT_DIR}/Payload/comic-reader.app"
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

fail_validation() { echo "❌ 建構路徑設定不安全：$1" >&2; exit 2; }
require_nonempty() { [ -n "$2" ] || fail_validation "$1 不可為空"; }
canonical_path() {
  if [ -d "$1" ]; then
    (cd -- "$1" && pwd -P)
  else
    local parent base
    parent=$(dirname -- "$1")
    base=$(basename -- "$1")
    parent=$(cd -- "$parent" 2>/dev/null && pwd -P) || return 1
    printf '%s/%s\n' "$parent" "$base"
  fi
}
paths_overlap() {
  case "$1" in "$2"|"$2"/*) return 0;; esac
  case "$2" in "$1"|"$1"/*) return 0;; esac
  return 1
}
validate_build_paths() {
  require_nonempty COMIC_PROJECT_DIR "${COMIC_PROJECT_DIR:-}"
  require_nonempty COMIC_IOS_WORK_DIR "${COMIC_IOS_WORK_DIR:-}"
  require_nonempty COMIC_IPA_EXTRACT_DIR "${COMIC_IPA_EXTRACT_DIR:-}"
  require_nonempty COMIC_DEVICE_ID "${COMIC_DEVICE_ID:-}"
  [ -d "$COMIC_PROJECT_DIR" ] || fail_validation "COMIC_PROJECT_DIR 必須是既有目錄"
  project_real=$(canonical_path "$COMIC_PROJECT_DIR") || fail_validation "無法解析 COMIC_PROJECT_DIR"
  case "$project_real" in /|"${HOME:-}") fail_validation "COMIC_PROJECT_DIR 不可為 / 或 HOME";; esac
  work_real=$(canonical_path "$COMIC_IOS_WORK_DIR") || fail_validation "無法解析 COMIC_IOS_WORK_DIR 的父目錄"
  ipa_real=$(canonical_path "$COMIC_IPA_EXTRACT_DIR") || fail_validation "無法解析 COMIC_IPA_EXTRACT_DIR 的父目錄"
  case "$work_real" in /|"${HOME:-}"|"$project_real") fail_validation "COMIC_IOS_WORK_DIR 是危險輸出目錄";; esac
  case "$ipa_real" in /|"${HOME:-}"|"$project_real") fail_validation "COMIC_IPA_EXTRACT_DIR 是危險輸出目錄";; esac
  paths_overlap "$project_real" "$work_real" && fail_validation "來源與 COMIC_IOS_WORK_DIR 重疊"
  paths_overlap "$project_real" "$ipa_real" && fail_validation "來源與 COMIC_IPA_EXTRACT_DIR 重疊"
  paths_overlap "$work_real" "$ipa_real" && fail_validation "兩個輸出目錄重疊"
}
validate_build_paths

echo "📦 同步程式碼到 ${COMIC_IOS_WORK_DIR}..."
rm -rf "${COMIC_IOS_WORK_DIR}"
rsync -av --exclude 'node_modules' --exclude 'dist' \
  --exclude 'src-tauri/target' --exclude 'src-tauri/gen/apple/build' \
  --exclude '.cargo' --exclude '.git' \
  "${COMIC_PROJECT_DIR}/" "${COMIC_IOS_WORK_DIR}/"

cd "${COMIC_IOS_WORK_DIR}"
npm install

echo "🔨 開始 iOS 編譯..."
npm run tauri ios build

echo "📦 解壓縮 IPA..."
rm -rf "${COMIC_IPA_EXTRACT_DIR}"
unzip -q src-tauri/gen/apple/build/arm64/comic-reader.ipa -d "${COMIC_IPA_EXTRACT_DIR}"

echo "🚀 空投進 iPad..."
xcrun devicectl device install app \
  --device "${COMIC_DEVICE_ID}" \
  "${COMIC_IPA_EXTRACT_DIR}/Payload/comic-reader.app"

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
| 1 | iPad 看不到 SMB 按鈕 | 在外接硬碟建構失敗，裝了舊版本 | 改用 `${COMIC_IOS_WORK_DIR}` 建構 |
| 2 | BUILD FAILED: libapp_lib.a 找不到 | `.cargo/config.toml` 的 `target-dir` 設定錯誤 | 刪除 `.cargo/config.toml` |
| 3 | 裝完 App 功能沒更新 | 誤用 `xcarchive` 裡的舊 `.app` | 必須從 `.ipa` 解壓後安裝 |
| 4 | 點擊子目錄 NAS 漫畫打不開 | 寫檔前忘記建立父資料夾 | 已在 `lib.rs` 補上 `create_dir_all` |
| 5 | `${COMIC_IOS_WORK_DIR}` 消失了 | 暫存目錄可能在 Mac 重開機後清除 | 每次改完程式碼重新 rsync |
| 6 | Xcode 找不到 Provisioning Profile | `project.pbxproj` 內的 Bundle ID 被手動開啟 Xcode 修改污染（與 `tauri.conf.json` 不一致） | 不要開 Xcode，直接修改 `project.pbxproj` 中的 `PRODUCT_BUNDLE_IDENTIFIER` 確保正確，或刪除 `gen/apple` 重建 |

---

## 🔍 七、偵錯技巧

### 查看 iPad App 的 console log

```bash
# 用 idevicesyslog 過濾 App 日誌（需要安裝 libimobiledevice）
idevicesyslog | grep "comic-reader"
```

### 查詢裝置識別碼

```bash
xcrun devicectl list devices
```

### 確認 IPA 裡的內容是最新的

```bash
# 在解壓縮後查看編譯時間
ls -la "${COMIC_IPA_EXTRACT_DIR}/Payload/comic-reader.app/comic-reader"
```

---

## 💡 八、優化建議（待實作）

詳見 `OPTIMIZATION_NOTES.md`（同目錄）。

---

*最後更新：2026-07-21*
