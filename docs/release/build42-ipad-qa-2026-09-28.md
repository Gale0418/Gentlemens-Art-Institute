# iPad build 42 實機驗證（2026-09-28）

- 裝置：iPad Air（第 5 代），iPadOS 26.5。
- 安裝：從 `gai_iOS.xcarchive` 輸出的已簽章 IPA 安裝；CoreDevice 回讀 `com.windsheep.gai`、版本 `1.0.0`、build `42`。
- 7z 區塊讀取效能修正後已重新封存並再次安裝 build `42`；CoreDevice 再次回讀 `1.0.0 (42)`。上述漫條操作驗證執行於同版號、修正前的實機安裝；重裝後驗證的是安裝與版本，沒有把它寫成重跑漫條互動。
- 操作：以已配對的 WebDriverAgent 點按實體 iPad，並讀取 accessibility tree；不是模擬器或單純安裝檢查。

## 漫條切換

1. 從「繼續閱讀」開啟已有進度的漫畫，點選「↕ 條漫」。accessibility tree 顯示「條漫直捲」。
2. 捲到頁尾，點「下一本」。閱讀器直接顯示同資料夾的下一本；沒有確認對話框。
3. 捲到頁首，點「上一本」。閱讀器直接回到前一本；沒有確認對話框。

使用者漫畫內容、畫面截圖及 NAS 路徑均未放入 Git。
