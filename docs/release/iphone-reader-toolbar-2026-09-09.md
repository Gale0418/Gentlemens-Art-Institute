# iPhone 閱讀工具列修正（2026-09-09）

> 歷史開發紀錄：下列測試數字與裝置狀態是當時的觀察，不代表最新版本已通過相同驗收。最新掃描維修紀錄見 [scan-progress-repair-2026-09-09.md](scan-progress-repair-2026-09-09.md)；未完成事項仍以任務中心追蹤。

使用者回報底部工具列只顯示一半，收起時跑到左下角並殘留一截。經 iPhone 鏡像觀察，目錄模式的底部頁碼和模式按鈕也有擠壓直向折行；鏡像中的相簿目錄可載入，但此觀察不等於 iPhone／iPad 所有相簿流程均已驗收。

原因：舊 idle 規則仍有 `translateX(-50%)`，而新版工具列已改成左右 inset 定位；只移動自身高度的 120% 也不足以越過底部安全區。手機仍沿用固定 60px 高的單列工具列，使大量控制項擠壓。

修正：idle 和預設收起狀態只沿 Y 軸移動，距離為自身高度＋底部安全區＋8px，完全離開視窗；idle 禁止指標事件。寬度 820px 以下改為頁碼／進度第一列、可橫向滑動工具第二列。按鈕不縮窄、不折行，保留既有觸控大小。桌面入口和功能保持原行為。

前端完整測試已通過（/tmp/gai-build4-ui-tests.log），CSS diff whitespace 檢查通過。build 4 建置完成，iPhone 與 iPad 均安裝並啟動成功；仍待以鏡像確認顯示和收起兩種狀態。未把 build 3 的安裝結果當成這次修正的證據。

使用者另回報 iPad 小圖應置中。01:13 已透過 Xcode 的 Devices and Simulators → Take Screenshot 取得 iPad Air 5 的 build 4 實機截圖，觀察森林橫圖貼上、下方大片留黑；原始碼的適應寬度模式固定靠上。已為單頁與雙頁容器加入上下 auto margin，讓短圖分配剩餘留白、長圖保留頂端捲動。此變更尚未包含在 build 4，也尚未完成實機視覺驗收。

擷取方式更正：`idevice_id` 空清單不代表 Xcode CoreDevice 無法截圖。Xcode 26.6 可透過已連線的網路 iPad 按下 Take Screenshot，PNG 自動存到使用者 Desktop。本次檔案為 `Screenshot 2026-09-09 at 1.13.36 AM.png`；不得再把 CLI 截圖服務不可用等同所有實機畫面途徑不可用。

Build 5 已完成 development IPA 封裝與 codesign strict 驗證，1.0.0 (5)、minimum iOS 15、iPhone/iPad family 均回讀一致；SHA-256 `de9c8a4e0ec57ebb11fc68803185852ae3c2082e2dd557a7a0179f9520fef8cf`。iPad 安裝與啟動成功，等待使用者重新開啟森林圖片以取得修正後截圖。WebKit 合成單／雙頁短圖置中、長圖頂端保留已量測；證據與 harness 保存在 `output/release/2026-09-09-build5`。本版未包含後續追加的條漫邊界點擊確認功能。
