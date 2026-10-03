# 第57版發行收尾

日期：2026-10-03。主人明確授權 CodeRabbit 審查、修正、整合 main、移除工作分支，以及換新版提交 Apple。

## Apple 狀態與目標

最新官方 API 回讀：Mac 1.0 為 READY_FOR_DISTRIBUTION（已可販售），iOS 1.0 (44) 為 WAITING_FOR_REVIEW。修正先前「兩平台均未上市」的過時描述。

iOS 目標 1.0 (57)，Mac 更新目標 1.0.1 (57)。先驗證正式發行包，再撤回舊 iOS 提交、換成新版，保留 Pro 項目。目前尚未宣稱上傳／送審成功。

## CodeRabbit 與修正

使用獨立暫存 Git repository，比對原本主專案 HEAD 與目前原碼，正式審查65檔；排除第三方 vendor、二進位圖片、產物、快取與私人資料，沒有移除本輪變更的核心大檔。未為湊150檔加入無關文件。

CodeRabbit 提出4個 issues：3 major、1 minor，均核對成立並修正：

1. 相機用途字串可能插入巢狀 plist dict，或被巢狀同名 key 遮住。改由 plutil 解析根層，在根層插入並檢查，增加巢狀 key 與冪等回歸。
2. 壓縮頁面 open_safe_file 失敗被轉為 None，可能以未授權的 ambient path 重新開檔。現在失敗回403/404，讀取函式必須收到已授權 File，移除路徑 fallback，增加無權限但檔案存在回歸。
3. RAR5尾標記檢查 clone共享的檔案位置在EOF時讀不到signature。檢查前seek到0，增加EOF及重複驗證回歸。
4. 圖片重試提示用了三個句點而翻譯註冊為單一省略號。統一為確切key，增加翻譯key回歸。

最後10檔 CodeRabbit 獨立複審0 issues。完整前端15組通過；Rust187 passed、0 failed、1既有ignored。兩次正式審查均遵守每小時3次／單次150檔限制，沒有使用付費credits。

## 尚有界線

Mac TAG實機驗收沿用56版，iPad TAG尚待解鎖驗收。完整VoiceOver、完整StoreKit交易、退款及失敗交易尚未全程實測，不能把提交成功當成這些項目的驗收。Chrome的管理政策安全檢查目前無法驗證，沒有繞過瀏覽器保護；官方CLI處理可覆蓋的發行操作。既有隱私發布證據保留，目前沒有變更隱私問卷。

## 提交紀錄

建置、簽署、Git main與Apple上傳／送審完成後補入確切版本、build ID、submission ID與回讀狀態。任務中心保持可回查的證據與未完成項目。
