# 書架與背景掃描效能稽核（2026-09-08）

本文件是 2026-09-08 的歷史紀錄；目前掃描狀態與修正進度以 [2026-09-09 掃描進度修正紀錄](release/scan-progress-repair-2026-09-09.md) 為準。

任務：COMIC-PERF23。目標是掃描、封面讀取與開關書時仍能操作書架。沿用 Rust 1.98.1；本輪不更動正式漫畫內容，不上傳私人書庫。

## 已確認問題與處置

| 問題 | 證據與影響 | 處置 |
| --- | --- | --- |
| 同步圖片協定阻塞 WebView 回呼 | lib.rs 使用 register_uri_scheme_protocol 直接執行 protocol 讀檔／ZIP 解壓；本機 Tauri API 說明及 vendored Wry start_task 呼叫鏈可確認 | 改非同步 responder + spawn_blocking，封面 2、頁面 4 個工作名額 |
| 掃描中檔案操作取消後狀態不結束 | mutation／undo 只增加 scan_generation，舊掃描不再能 finish | 在 scan_lifecycle 下取消、更新書庫及掃描狀態，發送 scan-progress |
| get_library 在 async worker 探測 NAS | Path::exists 可受磁碟／網路延遲影響 | 探測移入既有 spawn_blocking |
| 封面佇列生命週期 | 切目錄不釋放 active；observer 立即 unobserve；failed ids 永久保留 | 世代取消、離屏退佇列、30 秒 TTL／2048 筆上限；行為測試通過 |
| 背景刷新與捲動競態 | timer 排入後不再檢查狀態，fetch 回來也可能在捲動時提交 DOM | 排程及提交前檢查；純捲動不再多抓書庫 |
| 條漫切換重複頁面 | renderPages webtoon 分支直接 appendChild，未先替換舊內容 | fragment 一次替換；重複渲染測試通過 |
| 關書後延遲自動開書 | 上／下本 setTimeout 未檢查 readerOperation | 加操作世代檢查；回歸測試通過 |
| 掃描完成早於索引同步／舊 SMB 結果回填 | detached catalog sync；offline 快照 await 後缺世代檢查 | await 索引匯入；回填前檢查世代 |
| SMB 合併 O(n²) | 每本新增漫畫逐一遍歷既有清單查重 | HashSet 保留既有 ID 優先語意 |
| 自然排序反覆初始化 | localeCompare 每次傳入 options | 重用 Intl.Collator，保留自然排序語意 |
| 桌面仍是舊實體 App | Desktop 二進位為 8/30；Applications 為 9/7 | 已分別備份、替換並核對雜湊 |

## 驗證紀錄

- npm test 四組通過，已納入 catalog-scheduling 行為測試；修正 release-hardening 舊文案斷言。
- Rust 1.98.1：HashSet 修改後 109 測試通過；Clippy --lib --bins --no-deps -D warnings 通過（修正 file_ops.rs 既有 single_match）。vendored Wry 仍有依賴警告。
- 三個修改 Rust 檔案 rustfmt 通過；全庫 fmt 因 cache/protocol/state/utils 等既有格式差異失敗，未擴大重排。
- 首次 Chrome synthetic 5000 本／200 張可見卡：p95 33.5ms、max 234.2ms。工具原本僅檢查事件就標 PASS，此結果不採計效能通過；已補幀時間門檻並排除 buffered 舊 longtask。後續修正一次替換 grid、Collator 後尚待重測；Chrome 連線中斷。
- Node 5000 筆反向卷數排序：localeCompare 163.34ms、重用 Collator 8.56ms，輸出相同。僅單次局部成本量測，不代表實機 FPS。
- macOS Release 建置通過（15m23s）；Tauri 產物只有 linker 簽章、缺資源封存，已補本機 ad-hoc 簽章後 deep/strict 驗證通過。原 DMG 是補簽前產物，未作交付。
- Desktop 與 Applications 兩份 App 已替換；兩份舊版集中保留在 Applications，名稱分別含 `.desktop-previous-20260908-1104.app` 與 `.previous-20260908-1104.app`，桌面不留易混淆的舊入口。新版二進位 SHA256 同為 `5089dd6a34ef9ccca6611b41143bd2a04fb5ec5e85bc676b2c04bc93a4c4d06e`，兩份 codesign deep/strict 驗證通過。
- 精確由 Desktop 路徑啟動。實際畫面顯示書架及背景掃描 544→548 本；掃描期間 AX 操作側欄可收合，點一次漫畫顯示 inspector、不自動開書。這是功能 smoke，不等於 FPS 驗收。
- iOS Release build／archive／development export 通過，11:17 Wi-Fi devicectl install 成功，bundleID=com.windsheep.gai。IPA SHA256=`ba3f3a9cc1610dc90376391c325ddbf82c703c2fa6f6ce0fd2c1c481a9bd52a0`；解包 App deep/strict 簽章通過。
- 使用者補充「App 的封面」指主畫面圖示，非漫畫封面。已停止無關 SMB 封面延伸調查；確認 iOS AppIcon 為 Tauri 預設圖，已由既有 src-tauri/icons/icon.png 透過 Tauri icon 工具產生 18 個 iOS 尺寸，同步正式 repo 與建置副本，逐檔 byte-equality 檢查通過。新增 sync:ios-icons／build:ios 避免下次漏同步；最終 IPA 的 AppIcon76x76@2x~ipad.png 經 pngcrush 解碼後目視確認為正式圖示，Info.plist 的 CFBundleIcons~ipad 指向 AppIcon。仍需使用者確認主畫面顯示與實際捲動手感。
- 2026-09-08 iPad 啟動實測：CoreDevice 回報 Locked。前版 IPA 已安裝，不能視為本輪實機驗收通過。
- 10:50 使用者解鎖後，CoreDevice tunnelState=connected、ddiServicesAvailable=true；連線恢復。
- 11:17:48 devicectl process launch com.windsheep.gai 成功。裝置主畫面圖示與觸控捲動仍待使用者實際確認，任務維持 In Progress，不宣稱全負載零掉幀。所有本輪 Luna worker 已關閉，fixture server 已停止。
- GitHub connector 確認 private repo Gale0418/Gentlemens-Art-Institute、main；未進行遠端寫入。

## 審查限制

CodeRabbit completed，提出 1 個 major issue：初次 performLibraryFetch 的 getScanStatus 失敗、finally 停止輪詢後可能留下掃描 gate。已核對修正，新增保留實際 fetch／polling／finally 的 VM 測試並通過。此為修正前審查結果，不宣稱修正後零 issues。

Antigravity 同一 request `gai-20260908-reader-audit-01` 已回覆 COMPLETED，但報告使用推測行號及專案不存在的 openBook 等名稱，因此不採計六項推測為實際發現。Luna 後端唯讀結果已由主代理抽查呼叫鏈；修正仍需測試驗收。

NAS 系統呼叫即使移出主執行緒，也可能無法立即取消；大型圖片解碼及 OS 記憶體壓力仍需實機量測。本輪不宣稱所有裝置／任何負載下零掉幀。

Mission Center Rust binary resume 顯示 derived view stale；sync 使用相對／絕對 root 均回傳 command_error，doctor 的 tasks 檢查通過。維持 canonical tasks／本報告記錄，不用 Python fallback。
