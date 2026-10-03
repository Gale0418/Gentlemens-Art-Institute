# 第58版：外部來源還原與發行收尾

## 狀態

第57版 iOS 與 macOS 的待審 submission 已撤回，避免已確認的啟動書籤 P1 自動上架。第58版正式建置中，尚未上傳／送審。

## 修正

- 原生 external-bookmarks.json 為還原依據，包含明確保存的空清單。只有檔案不存在才遷移合法的舊瀏覽器快取；讀取或解析失敗不覆寫原檔。
- 還原與新增／改名／刪除共用 intent queue 和原生生命週期鎖。首次使用者操作會先還原，避免啟動前新增覆蓋原生來源。
- 讀取舊瀏覽器快取失敗且尚無原生設定時暫停遷移；恢復後可重試。已有原生設定仍正常還原。
- session snapshot 保持 native 清單；localStorage 滿額或不可寫不破壞已提交設定。過濾不符合原生 schema 的 legacy 快取項目。
- 原生設定已提交後，舊權限或 catalog 清理失敗仍發布相符的 process state，再回報「清單已更新」的部分成功。
- catalog每次依已提交的來源清單核對；故障後相同清單或重啟均能重試。SQLite trigger故障注入測試確認未解除的外部及本機来源保留。
- iOS privacy fixture 僅在 macOS 執行 plutil；可攜的同步回歸仍在其他平台執行，Linux platform preload模擬通過。

## 驗證

- 舊版 isolated startup fixture 已重現：空瀏覽器清單會清掉原生來源。測試使用合成資料，未碰使用者書庫。
- 最新 npm test：15組通過。
- 原生資料保存與前端queue專家複查已完成先前修補；清理重試的最終獨立複查進行中。
- 最新 Rust release：192 passed、0 failed、1項既有ignored。
- CodeRabbit前兩輪各1項major均已核實修復；最後9檔複審0 issues；本輪共3次，遵守每小時3次／每次150檔限制。

## 發行與範圍

目標 iOS 1.0 (58)、macOS 1.0.1 (58) universal。沿用已接受的 Gemini 商店文案與原隱私揭露。正式支援及本輪發行範圍為 macOS、iOS；Windows 不在本輪範圍。

Mac／iPad實機TAG證據沿用56版；第58版尚未安裝实機。完整VoiceOver、StoreKit交易及iPadTAG操作仍待驗收，不以單元測試冒充。
