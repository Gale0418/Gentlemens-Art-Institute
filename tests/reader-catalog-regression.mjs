import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

// 這些回歸檢查鎖定 iPad 大頁數目錄的三個契約：完整頁數由 spacer 表示、
// DOM 只掛載捲動視窗、捲動容器本身驅動下一個 bounded window。
assert.match(app, /const CATALOG_WINDOW_PAGE_COUNT = CATALOG_RENDER_PAGE_SIZE - 2/);
assert.match(app, /const CATALOG_WINDOW_SHIFT_RATIO = 0\.5/);
assert.match(app, /function getCatalogVirtualBounds\(totalPages/);
assert.match(app, /function handleCatalogScroll\(\)/);
assert.match(app, /function handleReaderResize\(\)[\s\S]{0,180}scheduleCatalogResize\(\)/);
assert.match(app, /function scheduleCatalogResize\(\)[\s\S]{0,1500}renderCatalogGrid\(\{ fromScroll: true/);
assert.match(app, /oldScrollTop: Number\(elements\.readerViewport\?\.scrollTop\)/);
assert.match(app, /state\.readingMode === 'catalog'[\s\S]{0,120}scheduleCatalogResize\(\);\s*return;/);
assert.match(app, /catalogResizeFrame !== null/);
assert.match(app, /function catalogRenderOwner\(\)[\s\S]{0,240}readerOperation/);
assert.match(app, /isCatalogRenderOwnerCurrent\(geometry\.owner\)/);
assert.match(app, /cancelCatalogResize\(\);\s*cancelCatalogVirtualRender\(\);/);
assert.match(app, /elements\.readerViewport\.onscroll = handleCatalogScroll/);
assert.match(app, /topSpacer\.dataset\.catalogSpacer = 'top'/);
assert.match(app, /bottomSpacer\.dataset\.catalogSpacer = 'bottom'/);
assert.match(app, /Math\.ceil\(renderEnd \/ columns\)\) \* rowHeight/);
assert.match(app, /if \(fromScroll\)[\s\S]{0,1800}firstVisibleRow/);
assert.match(app, /if \(fromScroll[\s\S]{0,320}state\.catalogWindowStart === bounds\.windowStart/);
assert.match(app, /catalogImageObserver = new IntersectionObserver/);
assert.match(app, /patchCatalogThumbnailWindow\(existingGrid, bounds\.renderStart, bounds\.renderEnd\)/);
assert.match(app, /startCatalogThumbnailLoads\(existingGrid, \{ reset: false \}\)/);
assert.match(app, /catalogThumbnailURL\(source\)/);
assert.match(app, /img\.draggable = false/);
assert.match(app, /currentBounds\.renderEnd/);
assert.match(app, /alignedEnd = Math\.ceil\(currentBounds\.renderStart \/ currentBounds\.columns\)/);
assert.match(app, /bounds\.renderCapacity/);
assert.match(app, /catalogImageActive < CATALOG_IMAGE_CONCURRENCY/);
assert.match(app, /taskGeneration !== catalogImageGeneration/);
assert.match(app, /img\.removeAttribute\?\.\('src'\)/);
assert.match(app, /function handleReaderPointerClick\([\s\S]{0,260}isCatalogThumbnailInteraction/,
  'catalog thumbnail pointerup is excluded from reader chrome navigation');
assert.match(app, /function isVirtualDirectorySourceId\([\s\S]{0,220}BUILT_IN_DEMO_SOURCE_ID/,
  'virtual demo source skips filesystem visible scans');
assert.doesNotMatch(app, /state\.currentComicPages\.slice\(windowStart, windowEnd\)/,
  'catalog must not materialize only the old page window as the complete document');

assert.match(style, /\.catalog-virtual-spacer\s*\{/);
assert.match(style, /\.reader-catalog-grid\s*\{[\s\S]{0,500}contain:\s*layout paint style/);
assert.match(style, /\.reader-catalog-grid\[data-catalog-start-column\]/);

console.log('reader catalog virtualization regression checks passed');
