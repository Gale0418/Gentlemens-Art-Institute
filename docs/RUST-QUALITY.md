# Rust 品質週期

## 可重跑閘門

所有指令都從專案根目錄執行，Cargo manifest 位於 `src-tauri/Cargo.toml`：

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --package gai -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --bins --no-deps -- -D warnings
```

`.cargo/config.toml` 將 target-dir 固定在 `/tmp/gai-cargo-target`，避免把建置產物寫到主人選定的漫畫／NAS 路徑，也避開 `/Volumes/MyGame` 不支援 incremental lock 的檔案系統限制。

## panic 與 unsafe 稽核

- production code 沒有 `unsafe`；目前 `unwrap` 主要是既有的短生命週期鎖、測試 fixture 與 Tauri 啟動邊界。
- 檔案、ZIP、HTTP 與 parser 邊界均回傳 `Result`，呼叫端會顯示可讀錯誤或寫入診斷，不以 panic 結束掃描。
- 不在這個週期盲目替換鎖定錯誤處理；每個替換需保留相同的生命週期與回歸測試。

## 輸入邊界

`protocol` 測試涵蓋缺頁、損壞 ZIP、圖片大小上限、外部 bookmark 權限與 symlink 逃逸；`catalog` 測試涵蓋指紋碰撞不自動合併、離線保留與 metadata 交易撤銷。

## Tauri 契約

公開 command 以具名 serde payload 接收資料；catalog、metadata 與 AI 設定均在 command 邊界驗證長度、provider、同意狀態與可接受格式。唯一保留的 `serde_json::Value` 是舊版前端相容用的 `set_config`，其只讀取 `scanDir` 字串並拒絕其他型別。AI 金鑰只存在工作階段記憶體，不進 SQLite、localStorage、log 或匯出檔。
