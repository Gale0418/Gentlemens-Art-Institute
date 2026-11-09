# 第75版 Mac／iPad 交付驗證紀錄

版本：`1.0.4 (75)`　日期：2026-11-09　狀態：Mac 與 iPad 本機交付驗證完成。

## 範圍

本輪驗證 Mac 與 iPad 第75版候選。來源 manifest v5 SHA-256：`96f76ece97bf2e0986ebad5505027b649e74e4df99f753280cf7bfa98ac91cd5`。此紀錄描述兩平台的本機建置、安裝、原生操作及資料保存證據。獨立複審及發布 exact SHA 收據另存 Mission Center。

介面新增 28 項語意化文案。i18n 保留 literal 回退，並支援 zh-Hant context keys，讓相同英文 literal 能依情境使用不同翻譯。本文不重列介面文案。

## 功能範圍

- 書庫 Inspector 管理抽屜整合 metadata 與管理詳情，保留正常標籤；使用同一份 source-qualified metadata snapshot，關聯建議在展開後才顯示。
- 閱讀器的顯示、模式與 AI 面板互斥；保留快捷鍵及觸控焦點行為，點外關閉不觸發翻頁。亮度與銳利化提供調整控制，適配方式使用選擇器。
- 真實書庫掃描與 NAS 傳輸顯示 2px 低對比活動條。支援 reduced-motion；文件隱藏、閱讀器顯示或側欄收合時停止動畫。
- 修正舊 reader open、舊下載 End 事件及 timer 清理新 NAS 活動狀態的競態。

## 工程檢查與程式複審

- `npm75-v5-result.json` 記錄 v5 `npm test` exit 0、25 組通過，綁定上述 v5 source manifest SHA。
- Rust 檢查來自 v1 `npm run quality`：381 passed、0 failed、5 ignored；`cargo fmt --check` 與 Clippy 通過。v5 新增內容為前端 JavaScript／CSS，v5 後未重跑 Rust，因此本文不宣稱 v5 整體 `npm run quality` 通過。
- CodeRabbit v5 檢查 20 個檔案，exit 0、0 issues，綁定 v5 source manifest SHA；收據為 `coderabbit75-result.json`。
- Mac v5 release build exit 0，codesign 驗證 exit 0；桌面安裝讀回 `1.0.4 (75)`，binary 與 bundle tree 雜湊均與建置產物一致。
- iPad `1.0.4 (75)` IPA 簽章、Team／provisioning profile、zh-Hant／en／ja bundles 與 privacy tracking 設定已驗證；裝置安裝及版本讀回通過。

## Mac 原生驗收與資料保存

`mac75-production-ui-flow.json` 記錄正式安裝 app 的原生流程通過：管理詳情 disclosure；CBZ A→B→C 開啟、翻至第2頁、返回及續讀；顯示調校時鍵盤箭頭不翻頁；閱讀紀錄 30 天／一年／全部；正常結束並冷啟動後恢復 B 第2/3頁。

`mac75-production-final/receipt.json` 與 `mac75-nas-current/receipt.json` 記錄安裝前 45 筆閱讀位置完整 tuple、14 筆 raw history 均逐筆保留，無 baseline 變更。最新資料庫收據為 53 筆 progress、23 筆 history，`quick_check` 為 `ok`。先前書架測試收據記錄三本測試作品的閱讀位置與冷啟動續讀；更新後已還原掃描目錄及自動語言設定，既有快取書架保留。

## iPad 原生驗收與資料保存

`ipad75-native-flow.json` 記錄實機流程通過：A 第3/12頁與 B 第2/9頁互切；B 第2→3→2；亮度、銳利化、旋轉調整後還原；點外關閉不翻頁；條漫模式停用適配、旋轉與縮放；直向 popup 操作；雙頁與目錄縮圖顯示；閱讀紀錄 30 天預設、一年及全部範圍；橫向 Inspector 管理區開啟與關閉；結束並重啟後從 Continue 恢復 B 第2/9頁。測試完成後回到 Home，畫面為橫向。

`ipad75-before/receipt.json` 記錄安裝前第73版 227 筆閱讀位置與19筆 raw history。`ipad75-final/receipt.json` 記錄安裝後 227 筆 baseline positions 全部一致、19筆 raw history 完整保留，0 筆 baseline 位置變更；更新後資料為232筆 progress、27筆 history，`quick_check` 為 `ok`。

第74版延期的探索流程也由本版補驗：三本自製 CBZ 在同一探索輪次互不重複，每本保存第2頁，C 冷啟動回到第2/4頁。收據 `ipad75-explore-check.json`、`ipad75-final/receipt.json` 同時記錄三本位置。測試遙控曾因工具列自動隱藏誤觸上一頁；已修正測試節奏並重新驗證，未將該次操作誤判為存檔問題。

實機操作證據另見 `ipad75-a-touch-after.xml`、`ipad75-b-restored2.xml`、`ipad75-tuning-values-after.xml`、`ipad75-outside-dismiss-verified.xml`、`ipad75-webtoon-tuning.xml`、`ipad75-history-30.xml`、`ipad75-history-year.xml`、`ipad75-history-all.xml`、`ipad75-inspector-management.xml`、`ipad75-cold-b-resume.xml` 與 `ipad75-final-home-confirmed.xml`。本文不包含畫面、資料列或使用者內容。

## NAS H 探測與驗收邊界

NAS H 的掛載及抽樣 metadata 可讀性見 `nas75-external-h-probe.json`。`mac75-nas-current/receipt.json` 記錄來源存在、原45筆 progress tuple 與14筆 raw history 均完整保留，最新資料庫為53筆 progress、23筆 history。首次 CUA AX 狀態曾取得閱讀器頁碼及影像元素；後續畫面擷取與控制讀取逾時，因此沒有確認 NAS 頁面影像已解碼，也沒有效能量測或速度主張。

Mac 與 iPad 均未完成 VoiceOver 驗收。其餘原生畫面及資料保存結論限於本文件列出的流程與收據。

## 證據索引

- 來源與品質：`source75-manifest.json`、`npm75-v5-result.json`、`quality75-final-result.json`。
- 程式複審：`coderabbit75-result.json`。
- Mac 建置與原生驗收：`mac75-release-v5-artifact.json`、`mac75-installed.json`、`mac75-production-ui-flow.json`、`mac75-production-final/receipt.json`、`mac75-nas-current/receipt.json`。
- iPad 匯出、安裝與實機驗收：`ios75-export-verified.json`、`ipad75-install.json`、`ipad75-apps-installed.json`、`ipad75-native-flow.json`、`ipad75-before/receipt.json`、`ipad75-final/receipt.json`。
- NAS 探測：`nas75-external-h-probe.json`。

本紀錄支持第75版 Mac 與 iPad 本機交付驗證結論。NAS 畫面內容解碼、效能及 VoiceOver 不在已通過範圍；獨立複審及發布 exact SHA 收據另存 Mission Center。第74版歷史紀錄維持不變。
