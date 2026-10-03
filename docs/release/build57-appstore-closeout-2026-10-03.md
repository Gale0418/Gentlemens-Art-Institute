# 第57版發行收尾

> 歷史紀錄：第57版已撤回，原P1／P2已於第58版修正。第58版兩平台已重新送審，現況見 [第58版收尾](build58-bookmark-restore-closeout-2026-10-03.md)。

日期：2026-10-03。主人明確授權 CodeRabbit 審查、修正、整合 main、移除工作分支，以及換新版提交 Apple。

## Apple 狀態與目標

最新官方 API 回讀：Mac 1.0 為 READY_FOR_DISTRIBUTION（已可販售），iOS 1.0 (44) 為 WAITING_FOR_REVIEW。修正先前「兩平台均未上市」的過時描述。

iOS 1.0 (57) 已於 2026-10-03 12:51（台灣時間）正式提交並回讀 WAITING_FOR_REVIEW，包含原本的 Pro 項目。Mac 1.0.1 (57) 已於12:55（台灣時間）正式提交並回讀 WAITING_FOR_REVIEW；新版簽章、雙架構及安裝包權限檢查均完成。

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

- GitHub PR #1 已合併 main，程式碼提交 `2d8a96f784cac5a6fbab7c5c466644d069f28aa4`。2026-10-03 Chrome 已恢復操作，經 PR 頁面 Delete branch 刪除 `codex/comic-a45-build53-audit`；GitHub 插件回讀僅剩 `main`。
- iOS version ID：`f2110298-4d29-4ba1-8fa4-9310c72ee321`。
- iOS build ID：`d247b334-7b35-403c-8c35-0287e0426511`，1.0 (57)，VALID。
- iOS submission ID：`90383c71-4499-46a2-9450-77ffb65f3388`，WAITING_FOR_REVIEW，2026-10-03T04:51:01.830Z；原44版提交已取消。
- iOS 發行 IPA SHA256：`66f0ed52ee8620493b63dd420a7d18064318c6aa243239b377fdf0c19367377d`。
- Mac version ID：`cc371f96-660a-4453-847c-e6a79c98a8eb`。
- Mac build ID：`5afa6bcf-2217-406b-a813-b40a1dd44973`，1.0.1 (57)，VALID。
- Mac submission ID：`00f4e6cc-5c99-4a45-b98c-b7bfdd1f2eec`，WAITING_FOR_REVIEW，2026-10-03T04:55:07.640Z。
- Mac universal PKG SHA256：`02cf7287a28106f9ef47fb4ff64eff8d9b0289823331913fb993e558674ec2c5`。
- Gemini 繁中版本描述、關鍵字與宣傳文字已套用兩平台新版；Mac 另更新三語版本更新說明。

## Mac 封裝檢查

Tauri universal 編譯後沒有自動合併附屬 `catalog-import`，本輪以 lipo 合併兩架構後重新 bundle。主程式及附屬工具均為 arm64 + x86_64；正式應用簽章與 installer 簽章驗證通過。Apple 首次拒絕 90255 的原因是 icon.icns 模式為0700；改0644重新封裝，展開 PKG 檢查全部 payload 可供非 root 使用者讀取。僅修改包裝權限，原碼與簽章驗證仍通過。

Mac 全包檢查的 `asc validate` 因同時存在已發布與待審 App Info 而無法選定年齡分級。改以確切 App Info ID 回讀兩筆分級（內容一致）、主分類 BOOKS、免費價格、既有完整商店截圖與審查聯絡資料；版本三語描述、關鍵字、支援網址與更新說明均已核對。Pro IAP 獨立檢查0 blocking；已加入iOS提交。兩平台提交成功後再回讀版本與submission的 WAITING_FOR_REVIEW，未把CLI總檢查誤稱通過。

## 第57版送審後的審查留言（第58版已修正）

GitHub Codex reviewer 後續提出兩項留言，已核對當前第57版原碼；本輪未進行這兩個案例的實機重現：

- **P1：啟動還原會覆蓋原生資料夾授權。** 原生啟動 setup 已把保存的書籤載入 state，`initApp()` 呼叫的 `restoreExternalBookmarks()` 仍使用 `readExternalBookmarks()` 的 WebView localStorage 清單呼叫 `setBookmarks()`。localStorage 被清空或落後時，原生 `set_bookmarks` 會保存該空／舊清單、停止移除來源的授權並移除其目錄索引。需要以原生資料作為權威，另明確處理舊版遷移；不得把自動啟動還原當成使用者刪除來源。[留言](https://github.com/Gale0418/Gentlemens-Art-Institute/pull/1#discussion_r4171729099)
- **P2：非 Mac 的 Node 測試相容性。** iOS 在地化 fixture 無條件執行 `/usr/bin/plutil`；非 Mac 執行 `npm test` 會失敗。需要將 Mac 平台專用檢查明確限制於 Mac，或改用可攜解析器。[留言](https://github.com/Gale0418/Gentlemens-Art-Institute/pull/1#discussion_r4171729103)

這些留言在本次既有 CodeRabbit 複審之後確認；CodeRabbit 的0 issues僅代表該輪結果。當時第57版兩平台仍待 Apple 審查，分支清理尚未修改程式或撤回提交；後續已撤回57、修完兩項並完成第58版複審與重送。


## 第58版修補接續

2026-10-03 第57版兩平台 submission 已撤回；後續確認的啟動書籤P1與非Mac測試P2已修，第58版已通過最終回歸／CodeRabbit複審並完成兩平台重送，均等待審查。此頁保留第57版歷史證據；現況見 [第58版收尾](build58-bookmark-restore-closeout-2026-10-03.md)。
