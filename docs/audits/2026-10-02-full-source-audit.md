# COMIC-A45 全程式修復與獨立專家驗收

## 驗收結果

已完成程式整合，全部 24 項已確認缺陷關閉（P1=7、P2=17），最終無未解 P0/P1/P2/P3。三個獨立領域席位及另一位證據仲裁者，均綁定相同最終快照。結論限定於程式、單元、合成回歸與明列的桌面瀏覽器操作證據；未宣稱 iPad 實機或原生 GUI 全流程驗收。

- 最終 snapshot SHA256：`e9926a0465f0cd3b3a86481a47d41213f63118feddacee0f16473074d3015271`
- 完整封存：[快照 archive](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/final-reviewed-snapshot.tar.gz)
- [逐檔 manifest](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/manifest.json)、[artifact checksums](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/artifact-checksums.json)
- [專家提詞](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/council/prompts.md)、[全部缺陷 ledger](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/council/finding-ledger.json)
- 最終獨立報告：[玩家／閱讀](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/council/wave5/reader.md)、[原生安全](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/council/wave5/native.md)、[資料／效能](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/council/wave5/data.md)、[仲裁](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/council/wave5/arbiter.md)
- [整合與原始來源驗證](/Volumes/MyGame/G.A.I/output/audits/COMIC-A45-20261002/integration-verification.json)

## 待完成的實機驗收

macOS 原生 GUI 全流程與 iPad 實機目錄仍未驗收。Computer Use 工具未向本聊天暴露，因此商用品質的最終操作驗收尚未完成；MissionCenter 保留 In Progress。

## 已確認缺陷清單

| ID | 級別 | 修補目標 | 結果 |
|---|---|---|---|
| R1 | P1 | 條漫關閉/切本進度flush | 關閉 |
| R2 | P1 | 圖片decode失敗重試與成功後進度 | 關閉 |
| R3 | P2 | IPC保留progress sequence | 關閉 |
| R4 | P2 | 照片部分匯入刷新與只重試失敗項 | 關閉 |
| S1 | P1 | RAR libarchive3.8.9 linked parser | 關閉 |
| S2 | P1 | SMB容量/空間/串流長度限制 | 關閉 |
| S3 | P2 | ZIP中央metadata配置前邊界 | 關閉 |
| S4 | P1 | local/external/offline/SMB首次索引、HTTP與預載descriptor授權；合併NATIVE-W2-001 | 關閉 |
| D1 | P1 | 相同fingerprint多位置metadata scope | 關閉 |
| D2 | P2 | 20k exclusion搜尋批次化 | 關閉 |
| S5 | P2 | ZIP64大型SFX恢復分塊搜尋 | 關閉 |
| S6 | P2 | SMB暫存descriptor寫入防symlink | 關閉 |
| F-W2-01 | P2 | 快取回應綁定閱讀session與頁碼 | 關閉 |
| F-W2-02 | P2 | 進度失敗boundedretry與保留durable恢復journal | 關閉 |
| D3 | P2 | 資料夾children與archive旁JSON納入dataset signature | 關閉 |
| F-W3-01 | P2 | 手動重試不得越過較新的閱讀進度 intent | 關閉 |
| NATIVE-W3-001 | P2 | 書庫或bookmark變更失效RAM preload generation | 關閉 |
| NATIVE-W3-002 | P2 | local move與undo使用capability descriptor | 關閉 |
| P2-W4-01 | P2 | 檔案版本驗證與搬移使用同一capability parent | 關閉 |
| P2-W4-02 | P2 | undo雙重失敗保留durable reconcile journal | 關閉 |
| P2-W4-03 | P2 | 搬移與undo同transaction刷新FTS路徑索引 | 關閉 |
| NATIVE-W4-001 | P2 | 本機mutation root以parent descriptor nofollow取得 | 關閉 |
| P2-W4-04 | P2 | 搬移及回滾原子no-clobber避免覆蓋競態目的檔 | 關閉 |
| IPAD-CATALOG-001 | P1 | 千頁閱讀目錄完整scroll geometry與連續虛擬視窗更新 | 關閉 |

## 本次最終檢查

- Rust：`test result: ok. 183 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 5.78s`
- Node：完整 `npm test` 15 組通過。
- rustfmt、Clippy（專案 `-D warnings`）、iOS aarch64 `--locked --lib` 編譯檢查通過。
- ZIP vendor 40、7z security 6、Swift cache 執行 fixture 通過。
- 封存快照排除 generated Apple project，因此從 archive 直接執行全 npm suite 會缺 `gen/apple/project.yml`；完整 15 組結果來自含既有 generated project 的隔離工作目錄，受影響 VM reader fixtures 可獨立執行。

## 主要修補

- 長篇目錄：完整本 scroll spacer、viewport scroll 虛擬更新與 resize 欄數重算，5,000 頁只維持附近縮圖 DOM，避免 160 頁視窗到底後失去下一頁。

- 閱讀與匯入：關閉或切本先保存最後條漫位置；圖片失敗可重試，僅成功載入才保存進度；IPC 保留進度 sequence；照片部分成功刷新書庫，只重試失敗檔案。
- 非同步與恢復：遲到 cache 回應綁定 session、render 和頁碼；進度保存 bounded retry，失敗保留 journal 與手動恢復；儲存配額不足保留 session 記憶體並明示尚未可靠備份；舊 retry 不越過新閱讀 intent。
- 檔案授權：首次索引、protocol、預載使用 capability root 與 descriptor；缺授權直接拒絕；切換書庫、撤銷 bookmark 同步失效 RAM cache；local move/trash/undo 使用 descriptor。
- 壓縮與資源：libarchive 升至官方 3.8.9；ZIP/7z/RAR 在配置或展開前檢查項目數、metadata、字典與輸出大小；ZIP64 大型 SFX 使用固定分塊搜尋；SMB 8 GiB 上限、256 MiB 空間保留、exact EOF、逾時及 partial cleanup，暫存寫入與 commit 防 symlink。
- 資料與效能：reimport 依實際來源更新 metadata，多位置 fingerprint 保留共用資料；parse 失敗保留上次候選，真正刪除才清理；folder children 與壓縮旁 JSON 納入 signature；搜尋批次載入 creators/tags，只有返回頁 hydrate 完整 metadata，掃描不複製整個 outcome。

## 效能量測界線

20,000 筆合成 SQLite、exclusion-only 搜尋，修正前 3.7079 秒，修正後主代理複測 0.3324 秒，約 11.2 倍改善。這是單次合成查詢 latency；不是 p95、100k RSS 或實際 NAS/device benchmark。搜尋批次仍有 O(C+metadata) 記憶體成本，RSS 尚未量測。

## 驗證範圍與限制

- 確實執行 Node 回歸、Rust lib tests、rustfmt、Clippy、iOS aarch64 編譯檢查、Swift cache fixture、ZIP/7z vendor tests 和 dependency audit。精確結果見 evidence。
- cargo-audit 沒有已知 vulnerability，但有 unmaintained／Linux-only glib unsound warning；vendored wry 有既存 deprecated/unused-unsafe warning，不能宣稱零警告。
- 實機 PhotoKit、macOS/iOS security scope、撤權後已開 FD 語義、Windows、實際 SMB 斷線／磁碟壓力未驗證。
- Chrome 前景自然捲動驗收已通過：5,000 頁中段 window 2448–2547、末段 4941–5000、尾頁 click 4999 與 progress 5000/5000，圖片可載入、關閉重開成功，視窗 resize 實際改变並還原。背景分頁 RAF 節流的失敗另留對照；最終結果見專項報告。桌面 Chrome 不等於 iPad 實機或原生 WebView。Computer Use 插件未向本聊天暴露操作工具，不能宣稱原生 GUI 全流程通過。
- CodeRabbit 有兩次有效審查，但早於最後獨立席位修補，未聲稱 CodeRabbit 審過全部最終 source。
- 已送審的 build 44 不含本次修補。本次修補 source 並建置 macOS 桌面驗收版，尚未上傳／重新送審新版，也未推 GitHub。

## 備份與重現

原始已修改檔案保留於 output/audits/COMIC-A45-20261002/pre-audit-originals。官方 C source 採完整替換，移除舊版本殘留；整合後逐檔 hash 與審查 source 比較。完整最終快照、manifest、專家提詞、ledger、每輪席位與仲裁報告、檢查 evidence 一起封存於永久 audit artifact。

## 上游來源與維護

- [libarchive 官方 3.8.9 release](https://github.com/libarchive/libarchive/releases/tag/v3.8.9)：release tar SHA256 `888c934f9d95648ecb9163dc8e23ab80a476ecb81a8f1154704a227b5b676dde`。
- [zip-rs upstream](https://github.com/zip-rs/zip)：vendor 0.6.6 crate SHA256 `760394e246e4c28189f19d488c058bf16f564016aefac5d32bb1f3b51d5e9261`，本地限制及 ZIP64 相容修改見 vendor README.security.md。
- [sevenz-rust2 upstream](https://github.com/hasenbanck/sevenz-rust)：vendor 0.23.0 crate SHA256 `0a4f883677093690e91fef8ae81fad8bce9e2c3a079b61054f05ce0d3ecf681e`，revision `8fa733090e422c1c583d87a4cd87193b59115317`；配置前限制見 vendor README.security.md。
- rustls 鎖定至 0.23.45；保留其餘 lockfile 既有版本，沒有批次降級依賴。
- local mutation 的符號連結 parent 會安全拒絕。版本驗證與搬移綁定同一 capability parent；POSIX 最終 directory entry 被另一程序替換的原子 CAS、實機 filesystem race 未宣稱完全解決。

## 檔案操作的一致性

搬移／改名與 undo 同一 SQLite transaction 更新 location 和 FTS／短字索引；版本驗證、目錄與 rename 使用同一 capability parent。Undo 的 catalog commit 和 filesystem rollback 都失敗時，保存 needs_reconcile 紀錄供安全調和／人工檢查，避免正常成功紀錄掩蓋實體路徑分歧。檔案操作根目錄從父 descriptor 以 nofollow 開啟，拒絕被替換成書庫外的符號連結。

Rust 的 1 項 ignored 是明確 opt-in 的 discovery 大書庫 benchmark，不是測試失敗；單次 20k 搜尋量測另有真實 evidence。

Windows 使用原生 FILE_RENAME_INFO 的 ReplaceIfExists=false、相對檔名及 RootDirectory handle 保留原子防覆蓋；[官方 FILE_RENAME_INFO 文件](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)。已對相同 production helper body 做 Windows GNU target 編譯檢查；未驗證完整 Windows app 與 Windows runtime。不支援的 filesystem/provider 會安全失敗，不退回普通覆蓋式 rename。


## macOS 桌面交付

已在桌面原路徑以最佳化 release build 45 替換 build 27；原始桌面 app 和隔離驗收 app 均移除。Bundle ID 維持 `com.windsheep.gai`，正式 appData 未改動；執行檔 SHA256 `a3e7af7f0be97f6f4eeb1c2e6597c3f09926a3cbc0394239b986d3bd326c02bc`。codesign deep/strict 驗證通過，動態依賴都屬 `/System/Library` 或 `/usr/lib`。使用 ad-hoc 簽署，沒有 notarization，因此這是本機交付版本，不能把它宣稱為已完成公證的公開下載版。

本輪隔離原生 app 確實啟動，並索引 5,000 頁 CBZ、SQLite integrity=ok；Computer Use 操作工具尚未暴露，原生 GUI 與 iPad 實機驗收仍待完成。使用者確認僅使用 macOS/iPad，不再展開 Windows App 驗收；本輪新增 Windows Rust std 已移除。自有測試漫畫、測試 appData 與測試程序已清理。


## 資源清理

Chrome fixture 分頁與 server 已關閉，自有原生測試程序、352 MiB CBZ、隔離 appData、測試圖片、兩份 123 MiB audit `.app`、新增 Windows std／helper harness 已移除。舊四輪來源快照逐檔校验後封存至共享工作磁碟，移除本機複本。正式桌面只留原路徑最新版；未清理使用者或其他任務的程序／共享 Cargo cache。


## 報告勘誤與仲裁界線

sealed native report 一處 libarchive C source 路徑少列 `libarchive2-sys`；實際正確目錄為 `src-tauri/vendor/libarchive2-sys/libarchive`，仲裁核對 digest 与 canonical source 一致。保留原始 sealed report 以維持hash，使用本勘誤補正閱讀路徑，非程式缺陷。Snapshot內 ledger 是冻结當時的待驗收狀態；最終關閉裁定保存在canonical council/finding-ledger.json與wave5/arbiter-result.json，不修改已封存snapshot。

## 第 46 版目錄效能後續

第45版 iPad 真實自然滑動已跨越舊160頁界線，但使用者回報仍卡，實機效能 gate 因此保留待驗。第46版改為批次且保留重疊縮圖、遠處回收、512px PhotoKit請求；另修尾頁、窗按鈕連續、旋轉anchor、stale RAF、初始容量邊界及模式離開／關閉資源回收。獨立前端複查與仲裁目前沒有未解的已確認 P0–P3，完整Node15組、Rust新增protocol測試、rustfmt/Clippy通過。

此後續來源以原 frozen snapshot 加上六檔 source/test overlay 記錄；舊 snapshot hash 不代表新的四檔 production code。最終 build46尚待簽章套件完成及實機驗收，詳 [iPad後續紀錄](2026-10-02-ipad-physical-qa.md)。Mac原生GUI／商業gate仍待驗，不由本輪source通過外推。

### 第 46 版實機重新開啟（第 47 版修補中）

第 46 版已簽章覆蓋安裝並回讀版號，自然滑動到達 1,701–1,725，未重現舊 160 頁上限。但實機中段旋轉會回到 1–32，來源測試漏掉 WKWebView 重建時的 scrollTop clamp。另使用者快速滑到尾部後缺圖，回正直向才補上；尾頁圖片可讀。兩項都保留實機未通過，依 [實機記錄](2026-10-02-ipad-physical-qa.md) 接續修補第 47 版，不以先前來源複查收斂代替實機結果。

## 2026-10-03｜第 51 版目前結果

第 47 版已用 iPad 原生快速跨窗拖曳、旋轉、尾頁點按及關閉重開驗證補圖與錨點。後續另修照片虛擬來源假掃描錯誤、idle 工具列與底部縮圖點按競爭，以及初次目錄延遲定位；兩平台現已覆蓋交付 `1.0.0 (51)`。

第 51 版 iPad 初次目錄、直橫旋轉、底部中央單次點按與圖片解碼通過，進度已還原；Mac 原生 5,000 頁尾窗、視窗放大／縮回、自然捲動、尾頁點按及重開通過，原書庫已恢復。完整 Node 15 組通過；凍結 overlay 七檔與工作來源逐檔 SHA256 一致。CodeRabbit 對第 47→51 版兩個實際變更檔案完成獨立複查，回報 `0 issues`。

先前三領域與仲裁的 24 項關閉裁定保留；48–51 因 Luna 額度用盡，未新增多席複查。此處原生通過僅涵蓋上述操作，沒有把來源回歸或較早版本重播外推為所有實機流程均通過。StoreKit 交易、全原生模式與失敗流程、公開 Mac 公證和 App Store 新版上傳／重送仍待完成。詳細版本界線與清理證據見 [實機紀錄](2026-10-02-ipad-physical-qa.md)。

## 第 53 版設定返回與初始化修補

使用者追加回報 iPad「儲存套用」不返回書架。第 52 版將 iPad 完成操作移至固定標題列，保留桌面路徑套用；第 53 版補上 modal 焦點 traversal 的非 Element 邊界，避免設定初始化在 Document 中斷，並統一來源選擇的原生能力檢查。

完整 Node 15 組通過，正式打包版號與 iOS privacy 同步檢查通過；CodeRabbit 對四個實際變更檔案完成修補迴圈，最終 `0 issues`。來源九檔及三個打包設定以 SHA256 凍結，和實際建置 stage 一致。iPad／Mac 現已覆蓋 `1.0.0 (53)`：iPad 單次套用返回、重新開設定後三筆來源仍可見；Mac 原路徑自動預填並套用返回，原設定保留。詳 [實機紀錄](2026-10-02-ipad-physical-qa.md)。

以上新增實機驗收只涵蓋設定流程；既有目錄驗收保留其版本界線。沒有把 CodeRabbit 回報當成新增多席 Luna 仲裁，也沒有把設定通過外推為所有商業 gate 完成。新版上傳送審、StoreKit 實際交易、公開 Mac 公證仍待完成，送審 build44 未變更。
