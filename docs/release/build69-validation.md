# 第69版建置與驗證紀錄

建置日期：2026-11-08；實機驗收更新：2026-11-09

候選版本：iOS／macOS `1.0.4 (69)`

## 來源與狀態

- source-v6 manifest SHA-256：`564236aabb20167429fdb5382a1125694243b989519201cedbbea967bc884020`。
- source-v7 manifest SHA-256：`6c72ba1794511850c1371b30c660b42e76bfa1d8354ecf0c05b3dfd6a0fb4ad9`；公開 manifest：[build69-source-manifest.json](build69-source-manifest.json)。
- source-v7 相對 v6 唯一差異是 iPad 橫向頁碼換行與全螢幕工具列越界的 P3 CSS 修正；Rust 與 JavaScript SHA 均相同。
- macOS 與 iPad source-v7 `1.0.4 (69)` 均已建置並原地安裝；本輪列出的兩端實機操作、冷啟動與版面範圍已完成，原始資料備份保留。
- 本版未上傳 App Store Connect；當前商店狀態未查驗。

## 品質與程式複查

| 項目 | 結果 | 證據與範圍 |
| --- | --- | --- |
| npm 測試 | **通過** | `npm-test-v8.log`：exit 0。 |
| Rust 測試 | **通過** | `rust-test-v7.log`：361 passed、0 failed、5 ignored。source-v7 只有 CSS 差異，Rust 輸入未變。 |
| strict Clippy | **通過** | `clippy-v6.log`：含 tests 與 bins，exit 0。 |
| rustfmt／diff check | **通過** | `rustfmt-v6.log`：fmt check 與 `git diff --check` 均 exit 0。 |
| source-v7 Chrome 版面 | **通過** | 1180×820、820×1180、390×844 三種尺寸的短／長版面共 6 格通過；滑桿寬度至少 120px；全螢幕按鈕可捲入畫面並實際點擊。受影響 reader regression exit 0。 |
| CodeRabbit source-v7 | **通過** | CSS 1 檔複查完成，0 issues。 |
| CodeRabbit 程式複查 | **通過** | baseline 79 檔、feature 13 檔、final-v4 9 檔、final-v6 5 檔；final-v6 為 0 issues。確認成立的歷史 3 項與 feature 2 項問題均已修正；active-book 背景 retry 屬 UI 不可達反例。 |
| Gemini source 仲裁 | **CODE_PASS** | 已收到 source、測試與三席原文 inline 封包，回報 0 個新增缺陷。Gemini 沒有本機檔案工具；SHA 判斷沿用 chair 與 3 席實檔驗證。這不是最終交付批准。原始回覆檔名：`antigravity-arbiter-inline-v6.md`。 |

## macOS 實機結果

- source-v6 `1.0.4 (69)` 已安裝。NAS 書庫換書／進度往返涵蓋 A 第 2→3 頁、B 第 73 頁及回到 A 第 3→2 頁。
- 冷啟動 DB busy 故障注入：catalog DB 原存第 2 頁，真實 journal 記錄第 3 頁；未保存紀錄總數由 4 筆降為 3 筆。冷啟動後 DB 為第 3 頁，原有 3 筆 journal 項目未變。證據：`mac-native-cold-recovery-v6.json`。
- source-v7 build exit 0、deep strict 簽章檢查通過並原地安裝 `1.0.4 (69)`。CUA 實際操作 A 第 2→3→2 頁後返回書架；唯讀 DB 回讀第 2 頁，原有 3 筆 journal 維持不變。證據：`mac-native-flow-v7.json`、`mac-build69-v7-install.json`。
- 原有 3 筆無 token 紀錄經向使用者說明後，由使用者自行選擇放棄；CUA 與 WebKit 均讀回 0 筆，原備份仍保留第 1／1／175 頁狀態。這不是 App 自動清除或代理替紀錄回寫。證據：`mac-legacy-clear-observed.json`。

A／B 為去識別化代稱，不代表私人書名。

## iPad 實機結果

- source-v6 `1.0.4 (69)` 完成 9 項實機案例，包含 A 第 4 頁→B 第 2 頁→A 第 4 頁、結束 App 後冷啟動回到 A 第 4 頁及 B 第 2 頁；損壞 CBZ 顯示 `Invalid zip header` 後，仍可開啟資料夾第 1→2/5 頁及單頁作品第 1/1 頁。證據：`ipad-native-flow-v6.json`。
- source-v6 另完成真實 NAS 圖像來源翻頁第 1/852→2→1；關閉 App 後，quiescent catalog 回讀 page 1、total 852、quickcheck OK。Rust／JavaScript 在 source-v7 未變，該項 v6 原生結果沿用。證據：`ipad-nas-native-v6.json`。
- source-v7 IPA build／archive／export exit 0，簽章與 profile 有效，已原地安裝 `1.0.4 (69)`；IPA SHA-256：`b06fb06e23207b31f539c532d0488100d6c3e6e5624ae368b69c956f1a85b084`。沒有上傳 App Store Connect。證據：`ios-artifact-v7-evidence.json`、`ipad-local-artifact-v7.json`、`ipad-install69-v7-exit.json`、`ipad-apps-after69-v7.json`。
- WDA 實測：A 既存第 3/12 頁讀回後真觸控第 3→4 頁，退出可開啟 B；重新開啟 B 明確回到第 2/9 頁。證據：`ipad-v7-B-loaded-controls.xml` 與對應 PNG。
- 原生版面：橫向 1180×820 與直向 820×1180 的頁碼均為 72×20、一行顯示。橫向工具列經實際橫捲後，全螢幕控制項位於 x=1091..1136、仍在 1180px 視窗內；直向橫捲後控制項位於 x=749..794、仍在 820px 視窗內。直向 AX 擷取時頁面已 idle，控制項 y 座標已移出，因此不宣稱當時可點擊或已成功切換全螢幕。Chrome 六格測試另已實際確認按鈕可捲入並點擊。
- source-v7 冷啟動後，A 的第 4/12 頁確實讀回；同版另實際開啟 NAS 的第 1/852 頁圖像。最後已將 iPad 回到主頁。證據：`ipad-native-flow-v7.json`。
- 原有 1 筆舊 journal 的相同 NAS 位置已由正常閱讀保存，catalog 核對為第 1/852 頁；最終 WebKit journal 讀回 0 筆。代理沒有執行 iPad 放棄操作，此結果不列為無 token 背景補存或故障注入通過。原備份仍保留。A／B、資料夾與單頁名稱均為驗證代稱。

## 行為與驗收邊界

- App 完成啟動書庫 snapshot 後，可序列重試帶有 durable native proof 的未保存紀錄；全庫掃描成功後另排一次序列重試。
- 重試核對根目錄、bookmark 或 SMB 授權，沿用原始 intent fence，不覆寫較新的閱讀進度；只有成功原生回寫後才清除紀錄，不因路徑仍存在就刪除。
- 舊紀錄缺少 token／來源，或資料夾來源沒有可持久驗證的證明時，保留紀錄並要求手動確認。SMB 背景復原與前景存檔分開排隊；閱讀期間的掃描以低負載方式持續。
- source-v7 只有 CSS 差異，因此 v6 的完整 Rust 測試、native 程式回歸及 macOS 冷啟動故障注入可沿用；不因 CSS 修改而要求重跑兩端原生故障注入。iPad 實機自動補存故障注入本輪未執行；只有 macOS 有真實故障注入通過證據。
- 完整 VoiceOver、實體外接裝置拔插、Photos 大型圖庫容量及 Windows 行為仍為 **unknown**。App Store Connect 當前狀態未查驗；2026-11-03 商店狀態只屬歷史紀錄，不宣稱本版已上傳、送審、核准或上架。

## 公開紀錄界線

本文件只保留可公開的去識別化驗收摘要。不要加入私人絕對路徑、IP、UDID／序號、私人書名、資料庫或備份 journal、原始截圖、憑證、帳號或 NAS 連線資訊。
