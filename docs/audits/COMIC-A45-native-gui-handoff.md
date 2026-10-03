# COMIC-A45 原生操作驗收交接

目前來源：/Volumes/MyGame/G.A.I。歷史驗收曾使用 MyGame-1 掛載名稱；不可直接沿用舊絕對路徑。

## 最新狀態：2026-10-03，第 54 版

兩平台已覆蓋第 54 版。來源設定提前、來源移除觸控尺寸與同名漫畫路徑辨識完成修補；Node 15 組及打包檢查通過，CodeRabbit 五檔 0 findings。Mac 原生單頁／雙頁／右至左／條漫及重開進度、兩本同名路徑辨識通過，原書庫已還原；iPad 三筆來源第一屏可見、44 × 44 移除按鈕、NAS padding 點按、單次套用返回與第 162 頁回讀通過。詳 [本輪產品體驗報告](2026-10-03-product-experience.md)。

App Store Connect 仍是 build44 的 WAITING_FOR_REVIEW，核准後自動上架；54 尚未上傳，未取消既有審查。完整 StoreKit 交易與公開 Mac 簽署／公證仍待完成。COMIC-A45 保留進行中。

## 歷史結果：2026-10-03，第 53 版

iPad 與正式桌面路徑已覆蓋 `1.0.0 (53)`。iPad 設定標題列「儲存套用」一次原生點按返回書架；重新開啟並滑動後，原有三筆外部來源可見，再次套用返回，照片第 162 頁進度保留。Mac 既有路徑自動預填、空來源說明與套用返回均完成原生驗收，設定檔原路徑保留。

第 53 版修正 library modal 焦點 traversal 在 Document 中斷初始化，並補齊 iPad 來源選擇的原生能力檢查。完整 Node 15 組與打包版號／iOS privacy 檢查通過，CodeRabbit 四檔最終複查 0 issues。私人證據封存於 `output/audits/COMIC-A45-20261002/ipad-physical/build53`。沒有新增多席 Luna 複查，額度限制仍在。

第 53 版只新增設定實機驗收，以下第 51／47 版目錄結果保留原版本界線。StoreKit 交易、全原生模式與失敗流程、公開 Mac 公證與新版 App Store 上傳／重送仍待完成，送審 build44 未變更。

## 歷史結果：第 51 版

以下舊版內容是歷史記錄；目前 iPad 與桌面正式路徑都已覆蓋為 `1.0.0 (51)`。Computer Use 與 WDA 連線阻礙已解除，原生實際操作已完成：iPad 初次目錄、旋轉、底部中央一次點按成功；Mac 5,000 頁目錄尾窗、視窗縮放、自然捲動、尾頁點按與關閉重開成功。iPad 還原第 162 頁並返回書架；Mac 還原原書庫。

完整 Node 15 組通過，CodeRabbit 對第 47→51 版實際變更的兩檔完成獨立複查，0 issues；48–51 沒有新增多席 Luna 複查，額度限制仍在。私有證據與 hash 存於 `output/audits/COMIC-A45-20261002/ipad-physical/build51`，自建漫畫、review 暫存、自有 WDA session／host 已清理；沒有新增模擬器。

後續待驗：原生所有閱讀模式／失敗重試／設定／焦點全流程、StoreKit 實際交易；公開 Mac 發行仍須公證，App Store 新版仍待上傳與重送。GitHub 交付先核對遠端 main 差異，再使用 GitHub 插件推送；目前送審 build44 不包含此次完整修補。COMIC-A45 保留進行中，不能由目錄範圍通過宣稱所有商業 gate 已完成。

桌面最佳化 macOS build 45：/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.app，以原路徑覆蓋舊版 27。Bundle ID com.windsheep.gai，執行檔 SHA256 a3e7af7f0be97f6f4eeb1c2e6597c3f09926a3cbc0394239b986d3bd326c02bc。ad-hoc 簽署、codesign 驗證通過，尚未公證。

24 個程式缺陷經三個独立專家及第四席仲裁關閉。Snapshot e9926a0465f0cd3b3a86481a47d41213f63118feddacee0f16473074d3015271。總報告 docs/audits/2026-10-02-full-source-audit.md，全部證據 output/audits/COMIC-A45-20261002。

Rust 183 passed/1 opt-in ignored，Node 15 組，Clippy/iOS check/Swift/ZIP/7z fixtures通過。Chrome前景5000頁自然捲動、末頁點擊、圖片載入、關閉重開、實際resize通過。隔離Mac原生程序啟動與5000頁CBZ索引通過。

## 待完成

### 2026-10-03 接續狀態

第 47 版已在 iPad 實際快速反向／往尾端滑動、中段旋轉、尾頁點擊及正常關閉重開通過，詳實機報告。收尾另外確認兩個 P2（虛擬來源假掃描錯誤、底部中央縮圖點按），已修於第 48 版；完整 Node 與補強 click／Enter／Space 的 catalog 回歸通過，48 實機結果待回填。

Computer Use 本聊天現在已可用，已讀取正式桌面版書架並正常退出舊版，準備同路徑覆蓋第 48 版。下列「工具未暴露」是較早階段的歷史阻礙，已解除。實體 iPad 解鎖後 CoreDevice 與 WDA 已重新連線；第 48 版仍須先完成簽章、安裝與版號回讀。

本聊天未暴露 Computer Use/cua_repl，使用者確認插件一直運作，可能與長對話工具載入有關。原生 GUI 與 iPad 實機 gate 仍 PENDING，MissionCenter COMIC-A45 保留 In Progress。

2026-10-02 後續：iPad 解鎖後已恢復既有 WDA Wi-Fi 控制，設定點按／關閉與實際滑動通過。裝置當時仍為 build42，同一個 3,016 頁來源已重現目錄停在第160頁；正在準備最新原始碼的本機 build45。新版實機 gate 尚待安裝及自然滑動驗收，詳 [iPad 實機驗收](2026-10-02-ipad-physical-qa.md)。

在有官方電腦工具的對話接續：確認可用工具後開啟桌面 app，驗收書庫/搜尋/排序、單頁/雙頁/條漫、進度保存與重開、失敗重試、設定、鍵盤焦點、resize。建立自有5000頁小型CBZ，在原生縮圖目錄自然捲至中段/末頁、點末頁、換模式與重開。iPad實機或既有模擬器另驗旋轉、大圖記憶體與快速捲動；不能由Chrome外推。

使用者只用 macOS/iPad，Windows不擴展。容量有限，更新桌面 app 用覆蓋；記錄並恢復測試前的書庫/設定，清理自己建立且完成的測試檔、程序和模擬器。正式app、使用者/其他任務程序與共享Cargo cache保留。

有證據的新缺陷做最小修補與必要回歸，再獨立closure；GUI都通過後更新任務狀態。本輪沒有推GitHub、上傳或重新送審；送審build44未包含本輪修補。後續推送使用GitHub插件並處理本地/遠端main差異。
