# 第58版：外部來源還原與發行收尾

## 狀態

第57版 iOS 與 macOS 的待審 submission 已撤回，避免已確認的啟動書籤 P1 自動上架。iOS 1.0 (58) 與 Pro 已送審，版本與 submission 均回讀 WAITING_FOR_REVIEW。macOS 1.0.1 (58) universal 也已正式送審；兩平台版本與 submission 均回讀 WAITING_FOR_REVIEW，Chrome 審查清單亦顯示兩項等待審查。

## 修正

- 原生 external-bookmarks.json 為還原依據，包含明確保存的空清單。只有檔案不存在才遷移合法的舊瀏覽器快取；讀取或解析失敗不覆寫原檔。
- 還原與新增／改名／刪除共用 intent queue 和原生生命週期鎖。首次使用者操作會先還原，避免啟動前新增覆蓋原生來源。
- 讀取舊瀏覽器快取失敗且尚無原生設定時暫停遷移；恢復後可重試。已有原生設定仍正常還原。
- session snapshot 保持 native 清單；localStorage 滿額或不可寫不破壞已提交設定。過濾不符合原生 schema 的 legacy 快取項目。
- 原生設定已提交後，舊權限或 catalog 清理失敗仍發布相符的 process state，再回報「清單已更新」的部分成功。
- catalog每次依已提交的來源清單核對；故障後相同清單或重啟均能重試。SQLite trigger故障注入測試確認未解除的外部及本機來源保留。
- iOS privacy fixture 僅在 macOS 執行 plutil；可攜的同步回歸仍在其他平台執行，Linux platform preload模擬通過。

## 驗證

- 舊版 isolated startup fixture 已重現：空瀏覽器清單會清掉原生來源。測試使用合成資料，未碰使用者書庫。
- 最新 npm test：15組通過。
- 原生資料保存與前端queue專家最終複查完成，本批macOS／iOS修補無剩餘成立P0／P1／P2。
- 最新 Rust release：192 passed、0 failed、1項既有ignored。
- CodeRabbit前兩輪各1項major均已核實修復；最後9檔複審0 issues；本輪共3次，遵守每小時3次／每次150檔限制。

## 發行與範圍

目標 iOS 1.0 (58)、macOS 1.0.1 (58) universal。沿用已接受的 Gemini 商店文案與原隱私揭露。正式支援及本輪發行範圍為 macOS、iOS；Windows 不在本輪範圍。

Mac／iPad實機TAG證據沿用56版；第58版尚未安裝實機。完整VoiceOver、StoreKit交易及iPadTAG操作仍待驗收，不以單元測試冒充。

## 正式證據

- 修補main：`6bd6616d6f1edf8a38a4bf71b60a6fc3828acbd7`；12檔GitHub SHA核對，其他2159個blob保持原SHA。兩則原P1／P2審查討論已resolved，遠端僅main。
- iOS build：`6a7a0546-1a2a-4dc0-afc3-c73d73424489`，VALID、免額外加密文件；版本`f2110298-4d29-4ba1-8fa4-9310c72ee321`綁58。
- iOS submission：`7c2ebffe-c726-4e4c-ad6e-6eb43e55754f`，WAITING_FOR_REVIEW；同批含Pro版本`6b96eddf-2d1c-449e-b658-5275997dc026`。
- IPA SHA-256：`5d3f80bd50526719e754a550f09328116bfea3ebf2ca95b1f3e839ffcaacfffc`。正式profile、簽章、1.0(58)、三語相機說明及無.a檢查通過；Brotli解碼與實際Mach-O內嵌的app.js／bridge逐位元相符。
- PKG SHA-256：`68627029006f2b9a229c8b6ac9ae0f2fa1ce30aff783dcfbe0ef77bb7bce2249`。1.0.1(58)、gai與catalog-import的arm64+x86_64、正式App／Installer簽章、展開封包可讀權限及兩架構內嵌前端核對通過。此為Mac App Store包，未宣稱Developer ID公證。
- ASC canonical validate因兩份AppInfo歧義失敗，未宣稱總閘門PASS；以確切AppInfo核對年齡分級／BOOKS、三語欄位長度、截圖COMPLETE、聯絡資訊／review notes、內容權利、免費價格、可用地區、build VALID及IAP0 blocking。
- Chrome本輪實際看到App隱私權「已發佈」，私有證據截圖已保存。法國／中國available=false，台灣／美國true。
- 正式IPA／PKG已保存`output/release/build58`，私有驗證證據位於`output/audits/COMIC-A45-20261003-build58`。

- Mac build：`5a1a795b-7cb5-4adb-bd23-edcada62a9dd`，VALID、免額外加密文件；版本`cc371f96-660a-4453-847c-e6a79c98a8eb`綁58。
- Mac submission：`0c30e3c5-dd02-4134-b906-7e506a312785`，WAITING_FOR_REVIEW，2026-10-03T07:45:49.486Z。
- 2026-10-03T15:48:53+08:00：API與Chrome兩平台待審狀態一致；第57版兩項在Chrome顯示已移除。

## 資源回收

正式IPA／PKG及SHA證據保存後，已清除此輪完成的Mac三個target cache、隔離兔子repository、IPA／PKG上傳副本及封包展開目錄，合計約2.65 GiB。沒有新建模擬器；保留共用iOS／release快取、APFS來源stage與使用者書庫。
