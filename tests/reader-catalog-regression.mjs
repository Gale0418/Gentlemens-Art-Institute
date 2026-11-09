import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
assert.match(app, /state\.catalogOpen\)[\s\S]{0,120}scheduleCatalogResize\(\);\s*return;/);
assert.match(app, /catalogResizeFrame !== null/);
assert.match(app, /function catalogRenderOwner\(\)[\s\S]{0,300}catalogOpen: state\.catalogOpen/);
assert.match(app, /function isCatalogRenderOwnerCurrent\(owner\)[\s\S]{0,500}owner\.catalogOpen === true/);
assert.match(app, /function setReadingMode\(mode\)[\s\S]{0,280}catalogOpen && mode === state\.readingMode/);
assert.doesNotMatch(app, /readingMode\s*===\s*['"]catalog['"]/);
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
assert.match(style, /\.reader-catalog-return[\s\S]{0,200}min-height: 44px/);
assert.match(app, /ui\.pageOverviewTitle/);
assert.match(app, /ui\.returnToReading/);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

// Exercise the real search, shelf and discovery functions with unchanged cached
// metadata while runtime availability changes after a successful rediscovery.
{
  const functions = [
    extractFunction(app, 'isBuiltInDemoComic'),
    extractFunction(app, 'isComicOffline'),
    extractFunction(app, 'isComicOfflineForSearch'),
    extractFunction(app, 'getProgressInfo'),
    extractFunction(app, 'normalizeDirectorySourceId'),
    extractFunction(app, 'getComicSourceId'),
    extractFunction(app, 'getComicSourceKey'),
    extractFunction(app, 'getCatalogSearchKey'),
    extractFunction(app, 'normalizeDirectoryPath'),
    extractFunction(app, 'compareShelfItems'),
    extractFunction(app, 'getLibraryFilteredComics'),
    extractFunction(app, 'comicMatchesLibrarySearch'),
    extractFunction(app, 'getDiscoveryCandidates'),
    extractFunction(app, 'getDirectoryItems'),
  ].join('\n');
  const context = vm.createContext({
    BUILT_IN_DEMO_SOURCE_ID: 'builtin:demo',
    comicTitleCollator: new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }),
    isFavoriteId: () => false,
    isPhotoAlbum: () => false,
  });
  vm.runInContext(`${functions}\nglobalThis.api = { getDirectoryItems, getDiscoveryCandidates };`, context);

  const rediscovered = {
    id: 'shared-id', sourceId: 'source-a', relativePath: 'LOVELY01.cbz',
    title: 'LOVELY01', type: 'offline',
  };
  const otherSourceOffline = {
    id: 'shared-id', sourceId: 'source-b', relativePath: 'LOVELY01.cbz',
    title: 'LOVELY01', type: 'archive', offline: true,
  };
  const offlineType = {
    id: 'offline-type', sourceId: 'source-c', relativePath: 'LOVELY02.cbz',
    title: 'LOVELY02', type: 'offline',
  };
  const offlineFlag = {
    id: 'offline-flag', sourceId: 'source-d', relativePath: 'LOVELY03.cbz',
    title: 'LOVELY03', type: 'archive', offline: true,
  };
  const missingRuntimeType = {
    id: 'missing-type', sourceId: 'source-e', relativePath: 'LOVELY04.cbz',
    title: 'LOVELY04',
  };
  const searchKey = (comic) => JSON.stringify([comic.sourceId, comic.id, comic.relativePath]);
  const cachedItems = new Map([
    [searchKey(rediscovered), { title: 'Source A metadata', offline: true }],
    [searchKey(otherSourceOffline), { title: 'Source B metadata', offline: false }],
    [searchKey(missingRuntimeType), { title: 'LOVELY04', offline: true }],
  ]);
  context.state = {
    comics: [rediscovered, otherSourceOffline, offlineType, offlineFlag, missingRuntimeType],
    currentSourceId: '',
    currentPath: '',
    activeSeries: 'all',
    activeFilter: 'all',
    catalogSearchItems: cachedItems,
    catalogSearchIds: null,
  };
  context.elements = { searchInput: { value: 'lovely' } };

  assert.deepEqual(context.api.getDiscoveryCandidates().map(item => item.sourceId), [],
    'offline runtime sources stay out of discovery before rediscovery');
  rediscovered.type = 'archive';
  const shelf = context.api.getDirectoryItems();
  assert.equal(shelf.find(item => item.sourceId === 'source-a')?.offline, false,
    'rediscovered archive availability wins over stale metadata.offline');
  assert.equal(shelf.find(item => item.sourceId === 'source-a')?.title, 'Source A metadata',
    'availability fix keeps source-qualified metadata display');
  assert.equal(shelf.find(item => item.sourceId === 'source-b')?.offline, true,
    'same-id offline source keeps its runtime availability');
  assert.equal(shelf.find(item => item.sourceId === 'source-b')?.title, 'Source B metadata',
    'same id and path retain source-qualified metadata');
  assert.deepEqual(context.api.getDiscoveryCandidates().map(item => item.sourceId), ['source-a'],
    'rediscovered archive enters discovery while offline runtime sources remain blocked');
  assert.equal(shelf.find(item => item.sourceId === 'source-e')?.offline, true,
    'missing runtime type stays fail-closed when its source-qualified metadata is offline');
  assert.ok(shelf.some(item => item.sourceId === 'source-c')
    && shelf.some(item => item.sourceId === 'source-d'),
  'offline runtime cards remain searchable and can show their unavailable state');
}

console.log('reader catalog virtualization regression checks passed');
