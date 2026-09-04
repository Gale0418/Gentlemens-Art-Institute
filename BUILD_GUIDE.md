# 紳士藝術研究所 Gentlemen's Art Institute — Tauri 建構與部署手冊

本專案現在是 **Tauri 2 + Rust + SQLite + Vanilla HTML/CSS/JavaScript** 的單一路線應用，支援 macOS 與 iPhone/iPad。Electron、Express、browser HTTP server 已正式移除；不要依照舊歷史文件復活第二套 runtime。

## 1. 專案結構

```text
${GAI_PROJECT_DIR}/
├── public/                         # Tauri WebView 前端
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── tauri-api.js                # native invoke / event bridge
├── src-tauri/
│   ├── src/                        # Rust backend
│   ├── capabilities/               # Tauri permissions
│   ├── icons/                      # 正式 bundle icons
│   ├── tauri-plugin-ios-folder/    # security-scoped folder / iCloud bridge
│   ├── vendor/wry/                 # iOS WebKit startup patch；不可隨意移除
│   └── Cargo.toml
├── tests/                          # Tauri-only Node regressions
├── package.json
├── package-lock.json
└── BUILD_GUIDE.md
```

`public/app.js` 仍會呼叫名為 `window.electronAPI` 的 facade；這是歷史 API 名稱，實體由 `public/tauri-api.js` 在 Tauri WebView 中建立，**不需要 Electron**。

## 2. 必要工具

- Node.js / npm
- Rust **1.98.1**（repository 的 `rust-toolchain.toml` 會固定版本）
- Xcode（macOS / iOS build）
- iOS 實機部署時需要 Apple signing identity / provisioning

第一次取得專案後：

```bash
cd "${GAI_PROJECT_DIR}"
npm ci
rustc --version
npm run quality
```

`package-lock.json` 只包含 `@tauri-apps/cli` 與對應平台 binary；不存在 Electron / Express runtime dependencies。

## 3. macOS

### 開發版

```bash
cd "${GAI_PROJECT_DIR}"
npm run tauri dev
```

### 正式 `.app` / `.dmg`

```bash
cd "${GAI_PROJECT_DIR}"
npm run build
```

bundle 通常位於：

```text
src-tauri/target/release/bundle/
```

正式 icon 來源是 `src-tauri/icons/`；根目錄不再有 Electron packaging icon。

## 4. iOS / iPadOS

### 4.1 不要在 SMB / exFAT checkout 直接跑 Xcode build

Xcode / Cargo / Tauri 會建立 symlink、修改 bundle metadata 並產生大量小檔。若專案本體位於 NAS 或不支援完整 macOS filesystem semantics 的磁碟，先同步到本機工作目錄。

建議使用未追蹤環境變數：

```bash
export GAI_PROJECT_DIR="/path/to/Gentlemens-Art-Institute"
export GAI_IOS_WORK_DIR="/tmp/gai-ios-work"
export GAI_IPA_EXTRACT_DIR="/tmp/gai-ipa-extract"
export GAI_DEVICE_ID="<xcrun devicectl list devices 取得>"
```

任何 device id、帳號、簽名資訊、NAS 位址都不要寫進 Git。

### 4.2 先驗證危險路徑

所有 `rm -rf` / `rsync` 前先執行：

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
  require_nonempty GAI_PROJECT_DIR "${GAI_PROJECT_DIR:-}"
  require_nonempty GAI_IOS_WORK_DIR "${GAI_IOS_WORK_DIR:-}"
  require_nonempty GAI_IPA_EXTRACT_DIR "${GAI_IPA_EXTRACT_DIR:-}"
  require_nonempty GAI_DEVICE_ID "${GAI_DEVICE_ID:-}"

  [ -d "$GAI_PROJECT_DIR" ] || fail_validation "GAI_PROJECT_DIR 必須是既有目錄"
  project_real=$(canonical_path "$GAI_PROJECT_DIR") || fail_validation "無法解析 GAI_PROJECT_DIR"
  work_real=$(canonical_path "$GAI_IOS_WORK_DIR") || fail_validation "無法解析 GAI_IOS_WORK_DIR"
  ipa_real=$(canonical_path "$GAI_IPA_EXTRACT_DIR") || fail_validation "無法解析 GAI_IPA_EXTRACT_DIR"

  case "$project_real" in /|"${HOME:-}") fail_validation "GAI_PROJECT_DIR 不可為 / 或 HOME";; esac
  case "$work_real" in /|"${HOME:-}"|"$project_real") fail_validation "GAI_IOS_WORK_DIR 是危險輸出目錄";; esac
  case "$ipa_real" in /|"${HOME:-}"|"$project_real") fail_validation "GAI_IPA_EXTRACT_DIR 是危險輸出目錄";; esac

  paths_overlap "$project_real" "$work_real" && fail_validation "來源與 GAI_IOS_WORK_DIR 重疊"
  paths_overlap "$project_real" "$ipa_real" && fail_validation "來源與 GAI_IPA_EXTRACT_DIR 重疊"
  paths_overlap "$work_real" "$ipa_real" && fail_validation "兩個輸出目錄重疊"
}
validate_build_paths
```

### 4.3 建立乾淨本機工作副本

Repository root 的 `.cargo/config.toml` 把一般 Cargo output 導到 `/tmp/gai-cargo-target`。iOS/Xcode 產物必須跟 Tauri generated Apple project 的預期位置一致，因此同步 iOS 工作副本時**排除 `.cargo`**，不要去刪 repository 的正式設定。

```bash
validate_build_paths
rm -rf "${GAI_IOS_WORK_DIR}"
rsync -av \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'src-tauri/target' \
  --exclude 'src-tauri/gen/apple/build' \
  --exclude '.cargo' \
  --exclude '.git' \
  "${GAI_PROJECT_DIR}/" "${GAI_IOS_WORK_DIR}/"

cd "${GAI_IOS_WORK_DIR}"
npm ci
```

### 4.4 建構 iOS

```bash
cd "${GAI_IOS_WORK_DIR}"
npm run tauri ios build
```

Tauri 會編譯 Rust static library、呼叫 Xcode project，再產生 signed app / IPA。實際輸出位置以當次 Tauri CLI 輸出為準，不要依賴歷史 blocker 文件記錄的舊絕對路徑。

### 4.5 安裝到實機

先確認裝置：

```bash
xcrun devicectl list devices
```

如果需要從 IPA 解出 `.app`：

```bash
validate_build_paths
rm -rf "${GAI_IPA_EXTRACT_DIR}"
unzip -q "/path/to/G.A.I.ipa" -d "${GAI_IPA_EXTRACT_DIR}"
```

再安裝：

```bash
xcrun devicectl device install app \
  --device "${GAI_DEVICE_ID}" \
  "${GAI_IPA_EXTRACT_DIR}/Payload/紳士藝術研究所 Gentlemen's Art Institute.app"
```

## 5. 本機品質閘門

目前不使用 GitHub Actions；不要為了驗證 build 又建立 workflow。

完整本機 gate：

```bash
npm run quality
```

等價於：

```bash
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --package gai -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --lib --bins --no-deps -- -D warnings
```

更強的 release 前人工驗證可追加：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
cargo test --manifest-path src-tauri/Cargo.toml --locked --doc
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --no-deps -- -D warnings
```

## 6. 不可隨意刪除的東西

- `src-tauri/vendor/wry/`：Cargo `[patch.crates-io]` 正在使用。
- `src-tauri/gen/apple/`：包含 Tauri iOS generated project、AppIcon / PrivacyInfo 等 Apple 專案資產。
- `public/assets/demo/`：乾淨安裝與 App Review 可直接驗證 reader 的全年齡 demo。
- `PRODUCT.md` / `DESIGN.md` / `.impeccable/design.json`：產品與設計 source-of-truth。

## 7. 已退休且禁止復活的路線

下列項目已在 2026-09-04 正式移除：

```text
main.js
preload.js
server.js
scan-depth.js
Electron
Electron Builder
Express
browser HTTP fallback
```

如果 Tauri 缺少某項能力，請修 `src-tauri/` 或 `public/tauri-api.js`，不要再建立第二套 runtime。
