# build18 單頁大圖四向捲動

## 行為

- 單頁模式的閱讀區支援原生水平與垂直捲動。
- 以縮放控制放大圖片時，承載容器會同步擴大，因此尺寸會真正進入瀏覽器的 scroll geometry，不再只是視覺 transform 後被裁掉。
- 單頁橫向確實溢位時，水平滑動只移動畫面，不會同時翻頁。
- 圖片溢位時，左右隱形翻頁熱區不攔截拖曳；仍可用閱讀區輕點分區、鍵盤與控制列翻頁。
- 離開單頁模式會清除 pannable 狀態，不影響雙頁、條漫或目錄模式。

## 驗證

- `npm test`：通過，包含新增的大圖滑動／防誤翻頁／模式清理回歸；翻譯字典維持 594 keys。
- `git diff --check`：通過。
- 實際瀏覽器量測：1280×720 閱讀區在 150% 放大後產生 1920×1080 scroll geometry；`overflow-x/y: auto`、`touch-action: pan-x pan-y`、pannable 狀態與熱區穿透均符合預期。
- CodeRabbit：審查 4 個變更檔，提出 1 個 minor；已修正離開單頁模式時的狀態清理並新增回歸測試。
- Mac build18：Release bundle 建置、ad-hoc 簽章與安裝完成，版本 `1.0.0 (18)`。
- iPad build18：development IPA archive/export、簽章驗證、安裝與版本回讀完成；裝置回讀 `1.0.0 (18)`。自動啟動因 iPad 鎖定被 SpringBoard 以 `Locked` 拒絕，並非安裝或簽章失敗。
- Mission Center：`doctor` 通過；`sync` 回傳 `status: committed`；`status` 回讀 `sourceFresh=true`、`dateFresh=true`、`stale=false`，未再出現既有 `command_error`。

## 交付

- Mac App：`/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.app`
- Mac 回復備份：`/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.previous-20260913-build17.app`
- iPad development IPA：`output/release/2026-09-13-build18/GAI-1.0.0-build18-development.ipa`
- IPA SHA-256：`6473a0911f4e27c9ca7810cab639e529b7071ac84cde48a3d3370ba8157e8b7f`
- iPad：Pe的 iPad (2)，iPad Air（第 5 代）；已安裝並回讀 build 18，待解鎖後人工開啟。

## 尚待人工驗收

iPad 實際手指在放大圖片上進行上下／左右滑動，以及切回 100% 後的閱讀體感，仍需在裝置上操作確認；不以模擬瀏覽器或安裝成功取代手指驗收。
