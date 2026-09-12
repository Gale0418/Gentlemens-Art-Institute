# build17 根目錄散圖逐張顯示

## 結果

build16 將掃描根目錄中的散圖聚合成一本「圖片資料夾」漫畫，雖然圖片可讀，卻不符合使用者希望每張 PNG/JPG 直接出現在書架的操作方式。build17 將掃描根目錄的支援圖片改為各自建立單頁項目；巢狀圖片資料夾仍維持一本漫畫，避免整個收藏展開成大量頁級卡片。

Downloads 根目錄唯讀盤點共有 1,036 個支援圖片檔。前端維持每批最多 200 張卡片與 lazy thumbnail，因此大量散圖不會一次建立全部 DOM／解碼全部縮圖。

## 驗證

- `npm test`：通過，翻譯字典 594 keys。
- `npm run test:rust`：131 passed、0 failed、1 ignored。
- `git diff --check`：通過。
- CodeRabbit：審查 9 個變更檔，0 finding。
- Mac build17：書架 accessibility 顯示 1,117 個項目，實際縮圖與圖片副檔名標籤可見；隨機根目錄散圖成功開啟並顯示 `第 1 / 1 頁`。

## 交付

- Mac App：`/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.app`
- Mac 回復備份：`/Users/chiudavid/Desktop/紳士藝術研究所 Gentlemen's Art Institute.previous-20260912-build16.app`
- iPad development IPA：`output/release/2026-09-13-build17/GAI-1.0.0-build17-development.ipa`
- IPA SHA-256：`1a76f65cadd20b94c7f3b43aaa939d70b1ef108e646ce9d8195ba427a096abf7`
- IPA 解包回讀：`com.windsheep.gai`、`1.0.0 (17)`，strict codesign 驗證通過。
- iPad Air（第 5 代）：localNetwork 安裝成功，CoreDevice 回讀 `1.0.0 (17)`；啟動時裝置為 Locked，SpringBoard 拒絕 launch，未將此記為 App 啟動成功。
- Mission Center：`doctor` pass、`sync` committed、`status` 顯示 source fresh／stale false；既有 `command_error` 未復發。

## 尚待人工驗收

iPad 實際手指開啟散圖、單頁模式開啟 AI 翻譯後翻下一頁，以及條漫自動排程翻譯的體感仍需在裝置上操作確認；不以建置或啟動成功取代這些人工驗收。
