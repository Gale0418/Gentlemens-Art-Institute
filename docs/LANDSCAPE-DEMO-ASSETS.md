# 八組風景示範素材

> 歷史開發紀錄：下列測試數字與裝置狀態是當時的觀察，不代表最新版本已通過相同驗收。最新掃描維修紀錄見 [scan-progress-repair-2026-09-09.md](release/scan-progress-repair-2026-09-09.md)；未完成事項仍以任務中心追蹤。

使用內建 image_gen 工具生成，未使用 CLI/API fallback。工具介面未提供可指定或驗證的模型版本參數，因此不宣稱已核驗 gpt-image-2 型號。

共八個主題、13 張；各組第一張兼作封面，不重複計頁。生成原檔保留，專案使用獨立副本。

## 提示詞

共用模板（第一張的 natural-light 文字相同）：

```text
Use case: stylized-concept. A beautiful original fine-art landscape painting for an all-ages offline image album: {scene}. Rich painterly detail, atmospheric depth, elegant natural light. Landscape aspect ratio. Full-bleed single scene, no frames, no montage, no text, no signatures, no watermarks, no people.
```

| 專案資產 | 主題 | scene |
| --- | --- | --- |
| public/assets/demo/landscapes/mountains/page-01.png | 層疊群山 | misty emerald mountain ridges at dawn |
| public/assets/demo/landscapes/mountains/page-02.png | 層疊群山 | dramatic alpine peaks in golden sunset |
| public/assets/demo/landscapes/rivers/page-01.png | 蜿蜒河谷 | a winding turquoise river through a vast green canyon |
| public/assets/demo/landscapes/coasts/page-01.png | 潮汐海岸 | sunlit ocean cliffs and clear turquoise surf |
| public/assets/demo/landscapes/coasts/page-02.png | 潮汐海岸 | quiet rocky beach under a pink evening sky |
| public/assets/demo/landscapes/forests/page-01.png | 森林光影 | ancient forest with shafts of sunlight through mossy trees |
| public/assets/demo/landscapes/lakes/page-01.png | 靜謐湖泊 | mirror lake reflecting autumn mountains |
| public/assets/demo/landscapes/lakes/page-02.png | 靜謐湖泊 | blue mountain lake with early morning mist |
| public/assets/demo/landscapes/deserts/page-01.png | 沙丘遠行 | sweeping golden desert dunes under a clear cobalt sky |
| public/assets/demo/landscapes/snow/page-01.png | 雪原極光 | snow covered wilderness with aurora ribbons at night |
| public/assets/demo/landscapes/cosmos/page-01.png | 宇宙星空 | Milky Way arch above a remote mountain horizon |
| public/assets/demo/landscapes/cosmos/page-02.png | 宇宙星空 | vast colorful nebula and dense sparkling stars, deep space |
| public/assets/demo/landscapes/cosmos/page-03.png | 宇宙星空 | a ringed planet above a distant moon landscape against stars |

## 檢查

逐張檢視生成結果：山川、河流、海岸、森林、湖泊、沙漠、極光與星空內容吻合，無文字、人物或浮水印。天文畫面為藝術想像，不作科學圖解。

- 13 張 PNG 共約 34MB；圖片長邊 1402–1536px，保留生成檔原尺寸。
- `npm test` 四組通過，包含八組固定排序、有庫與空庫、讀取失敗 fallback、逐組頁數與檔案存在檢查。
- Chrome 合成書庫：DOM 前八卡依指定主題排序，第九卡才是正式測試漫畫；宇宙星空第三頁與河谷唯一一頁實際載入。
- 返回書架鍵盤 Enter 驗證通過；瀏覽器自動化 click 未能可靠關閉，尚未驗證原生 iPad 觸控返回，不因此宣稱實機驗收完成。
- 本次未重建或部署 macOS/iPad 原生安裝包。
