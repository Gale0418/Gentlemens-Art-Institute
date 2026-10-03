# 第 54 版｜產品體驗修補與原生確認

## 範圍與結論

本輪依既有產品設計進行最小體驗修補，保留現有畫風。Mac 與 iPad 已覆蓋 `1.0.0 (54)`。本輪沒有新確認且未修復的程式缺陷；商業發行驗收仍有下列待辦，不能宣稱完整產品已可上市。

## 已修補

- 書庫來源設定移至語言之後、外觀與 Pro 之前，首次設定更容易找到。
- 外部來源移除按鈕至少 44 × 44；進階 NAS 展開列至少 44 高。依據 [Apple UI design tips](https://developer.apple.com/design/tips/) 的觸控尺寸建議。
- 繼續閱讀同名候選顯示來源與相對路徑，路徑變更會更新畫面。書名、路徑及 tooltip 保持 HTML escaping；封面作為裝飾圖，避免重複朗讀。

## 驗證

- 完整 Node 15 組通過；release hardening 與 iOS privacy 同步檢查通過。
- CodeRabbit 對本輪五個實際變更檔案完成獨立複查，0 findings。後續 Luna 額度已用盡，沒有宣稱新增多席專家仲裁。
- 根目錄與建置 stage 的十二檔來源／版號 SHA256 一致；兩端建置、簽章檢查、安裝及版號回讀完成。

### Mac 原生操作

使用 Computer Use 操作正式桌面 App。以專案內建 PNG 驗證單頁、雙頁、雙頁右至左、條漫捲動與返回單頁；關閉重開回讀第 3／3 頁及解碼圖片。另以本輪自建 Alpha／Beta 同名漫畫實際閱讀，繼續閱讀同時顯示兩筆來源路徑。原書庫 `/Volumes/docker` 已套用還原，重新整理後原資料夾與閱讀進度可見；設定檔亦回讀原路徑。

Mac 是本機 ad-hoc 簽署，deep strict 驗證通過；舊桌面副本已移除，未公證。

### iPad 實機操作

WDA 操作實體 iPad Air 5。設定第一屏可見三筆既有外部來源；三個移除按鈕 AX 實測各 44 × 44，未執行刪除。NAS 文字的 AX box 是 17 高，不能當作整個觸控範圍；實際點按文字下方 padding 成功展開 SMB 設定，之後收回。單次「儲存套用」返回書架，回讀原照片第 162 頁進度。沒有更動來源、私人照片、金鑰或購買狀態。

第 54 版沒有重播完整 3,016 頁快速拖曳。第 47 版快速跨窗、旋轉與尾部補圖，以及第 51 版初次定位／底部中央點按／Mac 5,000 頁原生目錄，保留各自版本界線，詳既有實機報告。

## 商業發行待辦

2026-10-03 直接回讀 App Store Connect：商店版本 `1.0` 仍綁定 build44，狀態 `WAITING_FOR_REVIEW`，核准後自動上架（`AFTER_APPROVAL`）。第 54 版未上傳或重送。本輪版本驗證器的阻塞是既有待審版本不可編輯，並非 Apple 拒絕通知。

- StoreKit IAP 設定驗證為 0 blocking／0 warnings；完整真實購買、恢復與退款交易流程尚未驗收，不能由設定檢查外推。
- App Privacy 公開 API 無法確認發布狀態，仍須官方 UI 確認。
- 此 Mac 本機未找到 Developer ID Application 或 Apple Distribution 簽署身分；公開 Mac 下載需正式簽署與公證。
- 是否撤回舊 build44 待審版本，須依 `asc-submission-health` 技能的取消審查確認規則由使用者決定；尚未取消。

## 證據與交付

私人裝置 XML／截圖、簽章／安裝收據、檢查輸出及 SHA manifest 存於 ignored 的 `output/audits/COMIC-A45-20261002/ipad-physical/build54`。公開源碼交付沿用 [草稿 PR #1](https://github.com/Gale0418/Gentlemens-Art-Institute/pull/1)，沒有改動遠端 main；私人證據、App 套件與尚未驗收的商店文案不包含在 PR。
