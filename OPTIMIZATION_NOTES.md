# 多專家視角優化分析報告

> 模擬多位技術專家，從各個角度深度審查「紳士藝術研究所 Gentlemen's Art Institute」的打包流程與程式架構。

---

## 🔴 Bug 診斷：無限轉圈圈問題

**根本原因分析：**

目前已識別出 **3 個導致無限 Loader 的獨立觸發路徑**：

### 路徑 1：SMB 下載 Loader 沒有被隱藏（最高嫌疑）

```javascript
// app.js L507-517
if (window.electronAPI.onSmbDownloadStart) {
  window.electronAPI.onSmbDownloadStart((data) => {
    showLoader('正在從 NAS 雲端下載漫畫...');  // ← 顯示 Loader
  });
}
if (window.electronAPI.onSmbDownloadEnd) {
  window.electronAPI.onSmbDownloadEnd((data) => {
    hideLoader();  // ← 只有在收到 smb-download-end 事件才隱藏
  });
}
```

**問題**：如果 SMB 連線在中途失敗（例如 NAS 掉線、timeout），`smb-download-end` 事件可能根本不會送出，導致 Loader 永遠卡住。

雖然 `lib.rs` 的 SMB 路徑在大部分錯誤時都有 `emit("smb-download-end")` 的呼叫，但如果 `open_comic` 本身在 SMB 區塊以外的地方拋出例外（例如 `get_archive_images` 讀取 ZIP 失敗），`hideLoader()` 就不會被呼叫（因為那時候是靠 `finally { hideLoader() }` 處理）— 但同時 `showLoader` 已經被 `smb-download-start` 觸發了，兩者的 Loader 疊加，`finally` 的 `hideLoader` 只關掉了 `openReader` 的那一層，SMB 的那一層 Loader 就永遠卡住了。

**嚴格來說這裡的問題是：`showLoader` 和 `hideLoader` 是全局共用的，沒有計數器（reference counting）機制。**

### 路徑 2：`fetchLibrary` 在 alert 後沒有 `hideLoader`

```javascript
// app.js L600-604
} catch (e) {
  console.error('無法獲取書架清單：', e);
  alert('讀取漫畫庫失敗：' + e.message);  // ← 沒有 hideLoader()！
} finally {
  stopScanStatusPolling();  // ← finally 只停了 polling，沒有 hideLoader
}
```

`initApp()` 呼叫了 `showLoader` 之後呼叫 `fetchLibrary()`，`fetchLibrary()` 的 catch 區塊沒有 `hideLoader()`，`hideLoader()` 只有在 `initApp()` 的 `await fetchLibrary()` 回來之後才呼叫（L230）。**如果 `alert()` 彈出後使用者按下 OK，`hideLoader()` 是有機會執行的，但如果前端 Tauri invoke 失敗但沒有拋出 JS Error 而是回傳 `null`，就不會觸發 catch，也就不會進到 `hideLoader`。**

### 路徑 3：`preload_comic` 在快取路徑永遠提早返回

```rust
// cache.rs L26-32
if !full_path.exists() || full_path.is_dir() {
    let _ = app_handle.emit("ram-cache-progress", json!({
        "id": id, "loaded": 0, "total": 0, "finished": true
    }));
    return;  // ← 提早返回
}
```

`cache.rs` 用的是 `scan_dir`（本機路徑），但 SMB 漫畫的 `relative_path_str` 是 NAS 上的相對路徑，本機不存在，所以每次點 SMB 漫畫，`preload_comic` 都會立刻跑這個分支返回，RAM 快取進度條永遠顯示 0/0 然後消失。這本身不是 Loader 的問題，但是個邏輯 bug。

---

## 👩‍💻 角色 1：Rust 架構師

### 問題：`open_comic` 函式太肥（God Function 反模式）

`lib.rs` 的 `open_comic` 處理了：SMB 連線、本機路徑、外部路徑、ZIP 解析、資料夾掃描、快取初始化、背景預載觸發——統統塞在一個函式裡，將近 150 行！

**建議重構**：
```rust
// 拆分成多個小函式
async fn resolve_comic_path(state: &AppState, id: &str, comic_info: &Option<ComicItem>) -> Result<(PathBuf, bool), String>
async fn open_smb_comic(state: &AppState, cfg: SmbConfig, relative_path: &str, app_handle: &tauri::AppHandle) -> Result<PathBuf, String>
fn build_page_list(state: &AppState, id: &str, full_path: &PathBuf, is_dir: bool) -> Vec<String>
```

### 問題：`ram_cache_pool` 使用 `std::sync::Mutex` 而非 `tokio::sync::Mutex`

`cache.rs` 裡的 `spawn_blocking` 使用了 `state.ram_cache_pool.lock().unwrap()`，因為是在阻塞執行緒裡，所以沒有問題。但如果有天把 cache 改成 async，這裡會造成阻塞 async 執行緒的問題。

### 問題：`smb2::connect` 沒有 timeout 設定

```rust
let client_result = smb2::connect(&addr, &username, &password).await;
```

如果 NAS 主機不存在或網路異常，這個連線可能會等待非常久（預設系統 TCP timeout 可能超過 30 秒）。建議加上 `tokio::time::timeout`：

```rust
use tokio::time::{timeout, Duration};
let client_result = timeout(
    Duration::from_secs(10),
    smb2::connect(&addr, &username, &password)
).await
    .map_err(|_| "SMB 連線逾時（10秒）".to_string())?;
```

### 問題：每次讀圖片都即時解壓縮 ZIP

```
gai://page/{id}/{index}  → protocol.rs 每次請求都打開 ZIP 檔、找到第 N 個 entry、讀取
```

對於 100+ 頁的漫畫，每翻一頁都重新打開 ZIP 是 I/O 浪費。建議在 `opened_comic_files` 之外，用 `Mutex<ZipArchive>` 或把已解壓縮的頁面緩存在 `ram_cache_pool` 裡（目前只預載前 5 頁，後面的頁面都是即時解壓）。

---

## 🎨 角色 2：前端 UX 工程師

### 問題：`showLoader` / `hideLoader` 沒有計數器機制（引用計數 Bug）

這是造成「無限轉圈」的核心設計缺陷：

```javascript
// 現在的設計
showLoader()  // 呼叫一次
showLoader()  // 又呼叫一次（SMB download start）
hideLoader()  // 只呼叫一次 → Loader 消失，但其實應該還在顯示
```

**建議修改**：
```javascript
let _loaderRefCount = 0;

function showLoader(text, options = {}) {
  _loaderRefCount++;
  // ...現有邏輯
}

function hideLoader() {
  _loaderRefCount = Math.max(0, _loaderRefCount - 1);
  if (_loaderRefCount === 0) {
    elements.loaderMask.style.display = 'none';
  }
}

function forceHideLoader() {
  _loaderRefCount = 0;
  elements.loaderMask.style.display = 'none';
}
```

### 問題：超大漫畫在條漫模式下一次插入全部 `<img>` 標籤

```javascript
// app.js L1413
state.currentComicPages.forEach((src, idx) => {
  const img = document.createElement('img');
  // ...
  elements.pagesContainer.appendChild(img);  // 500 張全插！
});
```

即使有 `loading="lazy"`，一次建立 500 個 DOM 節點本身就是效能問題，會造成 Layout Thrashing。

**建議**：使用虛擬化滾動（Virtual Scroll），只渲染可視範圍前後各 3~5 張圖片，其餘 placeholder 佔位。

### 問題：Loader 文字硬編碼，沒有辦法讓使用者知道「哪個操作」卡住了

如果轉圈圈，使用者看到的是「天才少女正在為主人召喚漫畫中...」，但不知道是 SMB 連線、還是 ZIP 解析、還是書架掃描卡住了。建議在 Loader 加上更細緻的狀態資訊。

---

## 🔒 角色 3：資安審計師

### 問題：Path Traversal 只在本機路徑做了防護，SMB 路徑沒有驗證

```rust
// lib.rs L110-114（本機路徑有保護）
let canon_scan = std::path::Path::new(&scan_dir).canonicalize()?;
let canon_full = full_path.canonicalize()?;
if !canon_full.starts_with(&canon_scan) {
    return Err("路徑越權！".into());
}

// lib.rs L78（SMB 路徑完全沒有驗證！）
let smb_path = relative_path_str.replace("/", "\\");
let data_result = client.read_file(&mut tree, &smb_path).await;
```

理論上，如果惡意的 `id` 經過 base64 decode 後是 `../../etc/passwd` 之類的路徑（雖然在 SMB share 內可能無法達到），仍應該做路徑正規化和防護。

**建議**：
```rust
// 確保 smb_path 不包含 .. 路徑遍歷
if relative_path_str.contains("..") {
    return Err("非法路徑！".into());
}
```

### 問題：SMB 密碼存在 Tauri 的 AppState（記憶體中）

每次 App 重啟，SMB 設定需要重新輸入（因為存在 `state.smb_config`，是 in-memory state）。但也因此密碼沒有持久化到磁碟，這其實是相對安全的設計。如果要做持久化，應使用 iOS Keychain 或 macOS Keychain 而非明文存在設定檔。

---

## ⚡ 角色 4：效能工程師

### 問題：每次 `fetchLibrary` 都傳輸全部漫畫列表

```rust
// lib.rs
async fn get_library(state: State<'_, Arc<AppState>>) -> Result<Vec<ComicItem>, String> {
    let comics = state.comics.lock().await;
    Ok(comics.clone())  // 把全部資料都傳回前端
}
```

如果書庫有 1000 本漫畫，每次刷新都序列化並傳輸一個大型 JSON 陣列。建議實作分頁（pagination）或 delta 更新（只傳有變動的項目）。

### 問題：SMB 掃描沒有增量更新

```rust
// smb_scanner.rs
// 每次掃描都從根目錄重新遍歷所有檔案
Box::pin(scan_smb_dir(...)).await?;
```

如果 NAS 上有大量檔案，每次重新整理都要全部重新掃描。建議快取上次的掃描結果並加上 ETag 或 Last-Modified 比對。

### 問題：`preload_comic` 預載上限只有 5 頁

```rust
// cache.rs
const MAX_PRELOAD_PAGES: usize = 5;
const MAX_PRELOAD_BYTES: usize = 64 * 1024 * 1024;  // 64 MB
```

現代設備（iPad Pro）有 8~16 GB RAM，預載 64 MB 太保守了。可以根據設備記憶體動態調整，或至少提高到 256 MB。

---

## 📋 優先修復清單

### P0（立刻修）- 無限轉圈圈

```javascript
// app.js - 修改 fetchLibrary 的 catch，確保有 hideLoader
} catch (e) {
  console.error('無法獲取書架清單：', e);
  hideLoader();  // ← 加這行！
  alert('讀取漫畫庫失敗：' + (e?.message || e));
}
```

```javascript
// app.js - 改成 Loader 引用計數設計（見 UX 工程師建議）
```

### P1（高優先）- SMB Timeout

```rust
// lib.rs - 加上連線逾時
use tokio::time::{timeout, Duration};
let client_result = timeout(Duration::from_secs(10), smb2::connect(...)).await
    .map_err(|_| "SMB 連線超時".to_string())?
    .map_err(|e| format!("SMB 錯誤: {:?}", e))?;
```

### P2（中優先）- SMB cache.rs 路徑問題

```rust
// cache.rs - 加上 SMB 漫畫的識別，避免嘗試用本機路徑查找 SMB 漫畫
let is_smb = {
    let opened = state.opened_comic_files.read().unwrap();
    // 或者在 state 中儲存 is_smb 的資訊
};
if is_smb || !full_path.exists() || full_path.is_dir() {
    // ...
}
```

### P3（低優先）- 長期架構改善

- 條漫模式虛擬化滾動
- SMB 路徑防護
- 分頁 API
- 動態預載上限

---

*分析日期：2026-07-21*
