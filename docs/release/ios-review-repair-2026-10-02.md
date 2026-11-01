# iOS 審查修復（2026-10-02）

## 審查證據

- App 6809937717，iOS 1.0 (43)，Submission c6e3d075-2fb5-4958-8334-2717254ddeb9。
- Apple 2026-09-29 審查，Guideline 2.1(a)：在 iPhone 17 Pro Max / iOS 27.2 點 Take Photo 後崩潰；審查環境亦列 iPad Air 11-inch (M3)。
- 附件 crashlog-3CC94D26-4284-4968-9C25-54739B7D4873.ips 明確 termination.namespace=TCC、EXC_CRASH/SIGABRT，缺 NSCameraUsageDescription。
- Screenshot-0930-141218.png 顯示 WebKit 圖片匯入選單 Photo Library / Take Photo / Choose Files。

## 修正

相機用途說明加入 XcodeGen project.yml、Info.plist、繁中／英文／日文 InfoPlist.strings；同步脚本對重新生成的 target 補回用途key。照片匯入是既有功能，保留其路由。未新增沒有使用的麥克風或相簿寫入權限。

## 狀態

- plist 與三語用途字串：plutil -lint 成功。
- Gemini RPC 完成，但檔案工具不可用；其回覆含未經讀檔的假設，未當成修改或驗證證據。Codex自行實作並安排唯讀交叉檢查。
- MyGame SMB恢復；既有HFS建置映像I/O error，正常detach回報資源忙碌。新APFS image attach亦無可裝載filesystem。改以本機獨立stage建置。
- 新版44 Release編譯與發行IPA匯出成功。重簽與codesign --verify --deep --strict通過。
- IPA回讀：1.0 (44)，NSCameraUsageDescription基礎字串與en/ja/zh-Hant三語均存在，ITSAppUsesNonExemptEncryption=false，無libapp.a。
- SHA-256：73d5424f6439507d9d1b88e89e65f82fa641bf65bba6c359628f10b3b5fa91dd。
- Apple已將build44標為VALID，usesNonExemptEncryption=false；版本1.0已回讀確定掛上build44。
- asc validate：0 errors、0 blocking；Pro警告已確認是同份提交的既有READY_FOR_REVIEW項目。Chrome隱私頁確認4天前已發布。
- 舊REJECTED項目已resolved，同一submission於2026-10-02 15:02（台灣）重新提交成功：WAITING_FOR_REVIEW。App版本與submission雙重回讀一致。
- 發行IPA內Mach-O含修正後照片IPC與能力判斷的codegen資源，已比對原始資源bytes。
- 尚未執行完整自動測試；iPhone與iPad均unavailable，尚未實機重驗Take Photo、拒絕權限、拍照後匯入。
- 照片匯入IPC缺失已補上：saveImportedPhoto → save_imported_photo；以原生能力限制iOS匯入入口。JS語法檢查成功。
- GitHub plugin已將8檔精準修正快轉至main，commit 1b9f9fcc62662c53177f552dbb0f00e59fef4002；回讀確認IPC已存在。未覆盖本機其他既有Rust與metadata變更。
