---
name: 紳士藝術研究所 Gentlemen's Art Institute
description: 深色、沉浸且可長時間操作的私人漫畫收藏工作台
colors:
  midnight-canvas: "#140508"
  midnight-surface: "#24080e"
  midnight-raised: "#340d16"
  archive-red: "#ff3d54"
  archive-red-hover: "#ff6476"
  text-primary: "#fff5f2"
  text-secondary: "#d8aaa9"
  text-tertiary: "#c08d8f"
  line-subtle: "rgba(255, 151, 157, 0.18)"
typography:
  display:
    fontFamily: "Songti TC, Noto Serif TC, YuMincho, serif"
    fontSize: "clamp(1.55rem, 2.4vw, 2.25rem)"
    fontWeight: 600
    lineHeight: 1.15
  body:
    fontFamily: "Avenir Next, PingFang TC, Noto Sans TC, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Avenir Next, PingFang TC, Noto Sans TC, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
rounded:
  sm: "9px"
  md: "15px"
  lg: "22px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.archive-red}"
    textColor: "{colors.midnight-canvas}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  input:
    backgroundColor: "{colors.midnight-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
  card:
    backgroundColor: "{colors.midnight-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "16px"
---

# Design System: 紳士藝術研究所 Gentlemen's Art Institute

## Overview

**Creative North Star: "深夜私人藏書室"**

紳士藝術研究所 Gentlemen's Art Institute 把大型私人收藏呈現成一座安靜但有生命的深夜藏書室：內容永遠是主體，控制區則像可靠的整理桌。預設 Midnight 主題以酒紅黑、暖紅主操作與低亮度文字層級維持沉浸感；Sakura、Ink 與 Aurora 是同一結構的換裝，而不是各自另造元件。

介面密度偏工作型，但群組、標題和狀態要清楚。整理模式直接延伸既有書架，批次列貼近選取內容，metadata inspector 沿用右側閱讀順序。

**Key Characteristics:**

- 深色 local-first 收藏工作台
- 內容優先、控制緊湊、狀態可見
- 主題色透過語意 tokens 驅動
- 滑鼠、鍵盤與 iPad 觸控共用一套元件

## Colors

預設色盤以深酒紅表面、暖紅互動色與帶粉的中性文字組成；其他主題只替換同一組語意角色。

### Primary

- **Archive Red**：用於主要動作、焦點與已選狀態；必須保持稀少，不能把整個工作區染成警示色。

### Neutral

- **Midnight Canvas / Surface / Raised**：依序承載背景、內容區與浮起的互動控制。
- **Primary / Secondary / Tertiary Text**：依資訊重要性使用，不以任意灰色取代。
- **Subtle Line**：只用於區隔或控制外框，不與大面積陰影疊成厚重卡片。

**The Semantic Theme Rule.** 新元件只能使用現有語意變數；不得寫死某個主題的青綠、粉紅或橘色。

## Typography

**Display Font:** Songti TC（搭配 Noto Serif TC、YuMincho fallback）
**Body Font:** Avenir Next（搭配 PingFang TC、Noto Sans TC fallback）

**Character:** 標題保留漫畫藏書的編輯感，操作文字保持清楚、中性且適合長時間閱讀。英數資料與中文介面使用同一 UI 字族，不用 monospace 假裝技術感。

### Hierarchy

- **Display**（600，流動尺寸，1.15）：頁面或主要收藏標題。
- **Title**（600，16–20px）：區塊與漫畫名稱。
- **Body**（400，14px，1.5）：說明、摘要與 metadata 值。
- **Label**（500，12px，1.35）：欄位名、facet、狀態與次要操作。

**The Quiet Label Rule.** 標籤靠尺寸與色階退後，不使用全大寫 eyebrow 或多餘前導標語。

## Layout

桌面以頂部工具列、左側收藏導覽、中央書架和右側 inspector 組成。書架卡片採響應式網格；整理模式的批次列固定在內容底部，1280px 以下轉為單欄，760px 以下縮到安全邊界，粗指標裝置的控制高度至少 44px。內容可分頁或虛擬化，不得同時掛載整個五千本書架。

## Elevation & Depth

深度由深色表面層級與帶垂直偏移的柔和陰影共同建立。靜態卡片保持克制；浮動工具與 inspector 才使用中高層陰影。零偏移光暈只能作為主題微光，不能代替結構陰影。

**The Working Surface Rule.** 一個表面以邊框或陰影表達層級即可；避免寬陰影再疊高對比描邊。

## Shapes

一般控制使用小圓角，卡片與面板使用中圓角，較大圓角只留給主要容器。膠囊形僅用於 facet、badge 與小型狀態，不套在大型面板或整排工具上。

## Components

### Buttons

- **Shape:** 9px 圓角，觸控情境至少 44px 高。
- **Primary:** 使用目前主題的 accent 與 on-accent；一次操作群只保留一個主要按鈕。
- **Hover / Focus:** hover 提升對比，focus 使用可見 3px theme focus ring，不移除 outline。

### Chips

- **Style:** 低對比表面、細線框與小型膠囊形。
- **State:** 選取後改用 accent 衍生背景與文字，不另創固定顏色。

### Cards / Containers

- **Corner Style:** 15px 中圓角。
- **Background:** 使用 surface 或 raised 語意層級。
- **Shadow Strategy:** 靜態書架卡片偏平，浮動 inspector 與批次列使用有偏移的柔和陰影。

### Inputs / Fields

- **Style:** raised 深色表面、1px subtle line、9px 圓角。
- **Focus:** theme focus ring；placeholder 使用 tertiary text 且維持可讀。
- **Disabled:** 降低不透明度並保留文字狀態，不只依顏色表達。

### Navigation

桌面側欄與 iPad 快捷列共用 active 語意；目前位置同時透過背景、文字與 `aria-pressed` 表達。

### Organizer Bar

固定於書架內容底部，依序顯示選取數、欄位、動作與狀態。窄寬度轉為可捲動單欄；忙碌與錯誤必須在同一列以文字回報。

## Do's and Don'ts

### Do:

- **Do** 讓新控制跟隨 `--accent-color`、`--text-*`、`--surface-*` 與 `--focus-ring`。
- **Do** 為批次、離線、空狀態、錯誤與 loading 提供可讀文字。
- **Do** 在 iPad／粗指標環境維持至少 44px 的互動高度。

### Don't:

- **Don't** 為單一功能寫死只適合某個主題的色彩。
- **Don't** 使用 Unicode 字元或 emoji 代替新增功能的圖示；沿用既有一致圖示系統。
- **Don't** 把資料管理拆成另一套視覺與導覽完全不同的後台。
