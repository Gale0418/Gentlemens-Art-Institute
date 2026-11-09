# 第76版驗證紀錄

版本：`1.0.4 (76)`。日期：2026-11-10。基底：`5fc5648`。

最終 source manifest SHA-256：`60140b9bd4d6ad7c6503da25725e95abd5f9c11dcd48dd4498dd1a6ad3632a07`，包含101個runtime與25個test檔。Mac `release-v6`／安裝版及iPad `ios76-build-v4`／安裝版均綁定此manifest。

## 變更摘要

- 「頁面」總覽從閱讀模式獨立，保留單頁、雙頁、RTL雙頁與條漫狀態；選頁依原雙頁配對對齊，取消總覽返回閱讀。大量頁數仍分窗並限制縮圖載入。
- 底部進度條使用頁碼旁可用寬度並保留44px觸控區；工具列與調校面板補上選中、按下、滑過及鍵盤焦點回饋。
- 書架新增隨四主題配色的靜態書架與拱窗SVG紋理（1,176 bytes）；閱讀器維持素底，沒有新增背景動畫或遠端素材請求。
- 修正總覽標題遮蔽、偏移與快取時機、旋轉／重排縮圖及關閉焦點；重新開啟設定會清除舊路徑錯誤。新增總覽的繁中、英文、日文文案。

## 工程與平台驗證

| 項目 | 結果與範圍 |
| --- | --- |
| JavaScript | 最終v7完整 `npm test` exit 0；manifest與測試收據一致。涵蓋總覽所有權、分窗、雙頁相位、條漫、保存／重試、歷史及面板回歸。DOM／GPU stub不作原生證據。 |
| CodeRabbit | v7 exit 0，精確審查14個變更檔、0 issues、無error；包含修正先前v6的iOS hint問題。 |
| Mac產物 | `release-v6` 建置、deep strict簽章及安裝版與來源綁定已驗；本機adhoc簽章。 |
| iPad產物 | `ios76-build-v4-artifact.json`／receipt建置、簽章及安裝版與來源綁定已驗。IPA／payload有SHA收據；payload hash不代表從裝置獨立讀出的binary hash。 |
| Mac v7實機 | 最終原生報告記錄5項v7差異驗證與限制：雙頁總覽返回第9–10頁、phase 1 RTL保留第10–11頁、還原單頁及NAS書架等均有證據；`mac76-v7-native-report.json`已完成。 |
| iPad v7實機 | 四項delta均通過：原生來源提示、LTR／RTL雙頁總覽重選目前模式後返回第2–3頁、切回單頁、冷啟動後Home續讀。來源picker未開啟；冷啟動後背景掃描仍在進行，期間取得SQLite一致快照。未重跑完整persona矩陣。 |

Mac v5報告與iPad v5證據僅代表v5既有驗證；CSS、文案及大部分runtime未變，不能當作v7全矩陣重測。v7對兩平台採變更差異驗證，未重跑未受影響的全套原生矩陣。未修改Rust；沒有本輪完整 `cargo test`／clippy，Mac及iOS原生建置有編譯。未提交App Store Connect或TestFlight。

## 閱讀資料與NAS

17:04 UTC（台灣時間1:04）使用者確認曾將原179頁翻至第4頁；此為真實閱讀活動，應保留最新第4頁進度。`progress76-adjudication.json`佐證確認與歷史新增。Mac v7最終保全收據通過：64筆進度／57筆歷史；58筆原進度位置精確不變，另1筆保留使用者最新位置第3/179（畫面第4頁），29筆原始歷史tuple全數不變。初次比較只因百分比浮點往返差異（4.44e-16）誤報；最終比較採百分比絕對容差1e-12，頁碼與總頁數精確比對。

此前15:01 UTC另有一次原179頁變成第5頁的異常，原因仍未知且後續未重現；不得與17:04使用者操作混為一談，也未宣稱已修復。舊Mac v5報告的冷啟動／NAS流程觀察不能替代v7最終保全收據。

iPad v7保全收據通過：final為241筆進度／57筆歷史。相較v5基準232／42及v7前237／52，原有頁碼／總頁數均精確不變，非fixture進度完整tuple與原始歷史tuple均無遺失或變更；v7前後新增4筆進度、5筆歷史。A／B／C測試書分別為2／3／4頁，最終均在第2頁。SQLite `quick_check=ok`；快照擷取時背景掃描仍在進行。

## 驗證限制與收據

Mac尚未完成聚焦後End鍵原生端點測試；iPad首／中／尾觸控只有v5實機證據。VoiceOver、真實NAS斷線、AI資料傳輸／金鑰設定及購買交易未測。`test-matrix.json`／`.md`仍是75版規劃；角色測試報告保留已測／部分／未測界線，未宣稱24項所有平台組合通過。

私有收據包括`source76-manifest.json`、`npm-test76-final-v7.json`及log、`coderabbit76-v7-result.json`、`mac76-release-v6-artifact.json`、`ios76-build-v4-artifact.json`／安裝收據、`mac76-v7-*.png`／AX紀錄、`mac76-v7-native-report.json`、`mac-final76-v7/receipt.json`、`progress76-adjudication.json`、`ipad76-v7-delta/report.json`、`ipad76-v7-root-preservation.json`及平台資料保全收據。`mac76-final-report.json`與iPad v5 evidence/report是v5歷史證據。私有書名、路徑、資料庫及原始截圖不隨程式碼上傳；獨立專家、仲裁及main遠端SHA對帳另存Mission Center。
