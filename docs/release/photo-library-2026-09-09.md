# 照片相簿連結與來源介面修正（2026-09-09）

> 歷史開發紀錄：下列測試數字與裝置狀態是當時的觀察，不代表最新版本已通過相同驗收。最新掃描維修紀錄見 [scan-progress-repair-2026-09-09.md](scan-progress-repair-2026-09-09.md)；未完成事項仍以任務中心追蹤。

狀態：原生 PhotoKit、相簿設定介面與 Rust 閱讀器已整合，build 3 已完成建置、安裝與啟動；相簿觸控／權限流程仍待使用者實機驗收，尚不可宣稱功能驗收完成。

## 使用者確認

- 首發目標同時支援 iPhone 與 iPad；兩者的相簿權限、閱讀與進度流程仍待實機驗收。
- macOS 書本右鍵保留「在 Finder 中顯示」，方便找到原始位置；iPhone／iPad 不顯示。
- 目錄縮圖只作選頁，移除容易被誤認為關閉圖片的刪頁快捷按鈕。
- 相簿應能持續讀取新增照片；匯入圖片的複製流程仍可使用。

## 實作邊界

使用者主動點「連結相簿」才要求 Photos 權限；啟動只讀既有授權狀態。完整權限允許選擇相簿或所有照片，有限權限只列出系統允許的照片。取消連結不修改或刪除 Photos 內容，拒絕權限後仍可解除既有連結。

閱讀時才產生圖片快取，缩圖上限 512 像素、閱讀圖片長邊上限 4096 像素，最多同時兩筆原生影像請求。專用快取位於 App Library/Caches/GAIPhotoLibrary，容量上限 128 MiB。iCloud 下載預設關閉，由使用者主動允許；此設定不代表允許傳送圖片至 AI。

相簿連結使用 App 自己的 UserDefaults 儲存，因此新增 Privacy Manifest 的 NSPrivacyAccessedAPICategoryUserDefaults／CA92.1；依 Apple 的用途限制，只讀寫此 App 自有設定。[Apple API reason 文件](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons)。Photos 權限用途說明同步加入產生用 project.yml 與 Info.plist。

## 驗證證據與待驗收

- Finder 平台邊界 VM 測試通過：Mac 可用、iPad 桌面 UA 排除、照片虛擬來源排除、非原生環境排除（/tmp/gai-finder-tests.log）。
- Swift 初次 target check 發現 availability 與 explicit self 錯誤，已修正；APFS Release 中 Swift 編譯階段通過，完整 archive 尚在執行。
- 主代理完整 Rust 測試 118 passed（/tmp/gai-build3-rust-tests.log），包含相簿進度持久化與凍結順序／失效拒讀。前端契約與 VM 行為測試通過（/tmp/gai-photos-ui-verified.log）；最後介面微調將再驗證。
- iPhone／iPad 新版建置安裝仍在驗收；不可套用 build 2 的成功結果。
- 實機需驗證：拒絕／有限／完整授權、選擇空相簿、開書翻頁、相簿新增照片後返回書庫、取消所有連結、系統撤權、離線與 iCloud 明確允許、重啟進度。

照片相簿目前是唯讀來源，提供閱讀、進度與本機收藏；相簿內容由系統照片 App 整理，不呈現檔案改名／搬移／隔離與 catalog 批次編輯入口。此來源尚未納入 catalog metadata 的批次編輯，不能把一般檔案書籍的 TAG 功能驗收套用至 PhotoKit。

## Build 3 實際交付

- 1.0.0 (3)，最低 iOS 15.0，UIDeviceFamily [1, 2]。
- IPA：[GAI-1.0.0-build3-development.ipa](../../output/release/2026-09-09-build3/GAI-1.0.0-build3-development.ipa)。SHA-256：`012363e07948cc1f3a7fd2f350dee099b11c0e5d02d9f8cd511fec93c1a38d17`。
- 簽章 strict/deep、照片用途說明、UserDefaults CA92.1 與 FileTimestamp 3B52.1 回讀通過；12 個關鍵來源檔與 APFS 建置副本 hash 相符。
- 2026-09-09 00:51 iPhone／iPad 均安裝並啟動成功。後續 process 回讀 iPad PID 27951、iPhone PID 2156 仍存在；此證據不等於照片選擇或翻頁操作已驗收。
- 最新前端完整測試通過；Rust 完整 118 項通過，後續針對開書後新增照片不得突破凍結頁數的修正，3 項相簿測試再次通過。
- 完整 build log、來源 hash、測試與裝置 receipt 保存在 `output/release/2026-09-09-build3/`。
- 已請使用者分別在 iPhone／iPad 操作連結相簿、開書、翻頁、返回；等待回覆。此 IPA 為 development/debugging export，不是 App Store 提交成品。

新增討論：使用者考慮多國語言，尚未決定實作範圍。已建議繁中＋英文優先，日文依需求再加入；未採信每新增語言固定十倍銷量。此討論不取代既有相簿驗收與上架目標。
