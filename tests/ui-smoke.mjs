import fs from 'fs';
import assert from 'node:assert/strict';

const readRequiredFile = (path, label) => {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${label} from ${path}: ${err.message}`);
  }
};

const app = readRequiredFile('public/app.js', 'frontend app');
const html = readRequiredFile('public/index.html', 'HTML');
const css = readRequiredFile('public/style.css', 'CSS');
const server = readRequiredFile('server.js', 'server');
const tauri = readRequiredFile('src-tauri/src/lib.rs', 'Tauri commands');
const tauriProtocol = readRequiredFile('src-tauri/src/protocol.rs', 'Tauri comic protocol');
const tauriConfig = readRequiredFile('src-tauri/tauri.conf.json', 'Tauri config');
const appleProject = readRequiredFile('src-tauri/gen/apple/project.yml', 'Apple project config');
const cargoManifest = readRequiredFile('src-tauri/Cargo.toml', 'Cargo manifest');
const patchedWry = readRequiredFile(
  'src-tauri/vendor/wry/src/wkwebview/mod.rs',
  'patched Wry WKWebView runtime'
);
const iosFolderPlugin = readRequiredFile(
  'src-tauri/tauri-plugin-ios-folder/ios/Sources/ExamplePlugin.swift',
  'iOS folder plugin'
);
const scanner = readRequiredFile('src-tauri/src/scanner.rs', 'Tauri scanner');
const catalog = readRequiredFile('src-tauri/src/catalog.rs', 'SQLite catalog');
const tauriApi = readRequiredFile('public/tauri-api.js', 'Tauri frontend bridge');
const capabilities = readRequiredFile('src-tauri/capabilities/default.json', 'Tauri capabilities');

const demoAssetRoot = 'public/assets/demo/moonlit-archive';
for (const asset of ['cover.jpg', 'page-01.jpg', 'page-02.jpg']) {
  const assetPath = `${demoAssetRoot}/${asset}`;
  const stat = fs.statSync(assetPath, { throwIfNoEntry: false });
  assert.ok(stat?.isFile() && stat.size > 0, `built-in demo asset should exist: ${assetPath}`);
}

const mustContain = (source, needle, label) => {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
};

const bracedBlock = (source, marker, label) => {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${label}: missing ${marker}`);
  const opening = source.indexOf('{', markerIndex + marker.length);
  assert.notEqual(opening, -1, `${label}: missing opening brace`);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  throw new Error(`${label}: missing closing brace`);
};

mustContain(html, 'id="continue-strip"', 'library layout');
mustContain(html, 'id="organize-bar"', 'catalog organizer');
mustContain(html, 'data-organize-panel="tags"', 'tag library organizer tab');
mustContain(html, 'id="tag-library-list"', 'tag inventory library');
mustContain(html, 'id="tag-editor-color"', 'custom tag color picker');
mustContain(html, 'id="catalog-load-more"', 'bounded catalog rendering');
mustContain(html, 'id="organize-inbox"', 'low-confidence organizer inbox');
mustContain(html, 'id="organize-duplicates"', 'duplicate candidate review');
mustContain(html, 'id="btn-ai-explain"', 'single-page AI explanation action');
mustContain(html, 'id="btn-ai-auto-explain"', 'cost-bounded whole-book read-along action');
mustContain(app, 'data-inspector-action="ai-suggest"', 'catalog AI metadata candidate action');
mustContain(app, 'data-inspector-action="organize"', 'inspector TAG organizer entry point');
mustContain(app, 'data-inspector-action="files"', 'inspector file manager entry point');
mustContain(app, 'Math.round(Math.min(100, Math.max(0, rawPercent)))', 'bounded integer reading progress');
mustContain(app, 'function scheduleLibraryRefresh', 'coalesced progressive library refresh');
mustContain(app, 'fetchLibrary({ background: true })', 'scan events use silent background refresh');
mustContain(app, 'skipUnchanged && renderSignature === lastGridRenderSignature', 'unchanged visible shelf skips DOM rebuild');
mustContain(app, "elements.comicGrid.classList.toggle('background-refresh', background)", 'changed background shelf suppresses replayed entrance motion');
mustContain(app, 'const existingItems = new Map(', 'series sidebar updates existing nodes instead of flashing the whole list');
assert.match(
  app,
  /if \(!item\) \{[\s\S]*?item\.append\(name, badge\);\s*\}\s*item\.onclick = \(\) => selectSeries\(seriesName\);\s*configureInteractiveItem/,
  'reused and static series entries must retain pointer and keyboard activation'
);
mustContain(app, "event.pointerType === 'touch' && readerTouchMoved", 'reader swipe must not also trigger pointer-zone navigation');
mustContain(app, "comic.comicsCount || 0", 'virtual folder count changes invalidate the grid render signature');
mustContain(app, 'ensureInspectorSelection({ skipUnchanged: Boolean(options.skipUnchanged) })', 'background scan updates only a changed visible inspector');
mustContain(app, 'renderSignature === lastContinueRenderSignature', 'unchanged continue-reading strip skips DOM rebuild');
mustContain(scanner, 'publish_partial_library', 'progressive scanner result publication');
mustContain(scanner, 'PARTIAL_LIBRARY_INTERVAL', 'bounded partial publication cadence');
mustContain(scanner, 'merge_discovered_comics', 'partial refresh keeps the previous shelf visible until scan completion');
assert.doesNotMatch(server, /import AdmZip from ['"]adm-zip['"]/, 'unused vulnerable adm-zip runtime must stay removed');
mustContain(app, 'AI 建議摘要與標籤', 'clear AI metadata candidate label');
mustContain(html, 'class="reader-rotate-icon"', 'unambiguous reader rotation icons');
mustContain(html, 'id="ai-api-key"', 'manual AI provider key input');
mustContain(html, 'id="scan-dir-status"', 'native folder picker status');
mustContain(html, 'id="library-source-btn"', 'unified library source action');
mustContain(html, 'id="library-source-alert"', 'offline library recovery status');
mustContain(html, 'id="library-source-settings-btn"', 'offline library recovery action');
mustContain(tauri, '"gpt-5.6-luna"', 'fixed low-cost Luna model');
mustContain(tauri, '"gemma-4-26b-a4b-it"', 'fixed free-tier Gemma 4 model');
mustContain(tauri, 'suggest_comic_metadata', 'AI metadata candidate command');
mustContain(tauriApi, "invoke('plugin:dialog|open'", 'native folder picker command');
mustContain(tauriApi, 'directory: true', 'folder-only native picker');
mustContain(tauriApi, 'defaultPath: defaultPath || undefined', 'native picker starts from current library');
mustContain(capabilities, 'dialog:allow-open', 'native open-dialog permission');
mustContain(capabilities, 'ios-folder:allow-pick-folder', 'iOS folder picker permission');
mustContain(tauri, 'fn gemma_response_text', 'Gemma final-answer filtering');
mustContain(tauri, '"thinkingLevel": "minimal"', 'cost-bounded Gemma reasoning');
mustContain(tauri, 'gemma-4-31b-it', 'single Gemma quota fallback');
mustContain(app, 'suggestInspectorMetadata', 'catalog AI metadata candidate handler');
mustContain(app, "'assets/demo/moonlit-archive/cover.jpg'", 'built-in demo cover asset');
mustContain(app, "'assets/demo/moonlit-archive/page-01.jpg'", 'built-in demo page 1 asset');
mustContain(app, "'assets/demo/moonlit-archive/page-02.jpg'", 'built-in demo page 2 asset');
mustContain(app, "relativePath: 'all-ages-demo'", 'built-in demo stays visible at the library root');
mustContain(app, "const supportsNativeInert = 'inert' in elements.librarySidebar", 'sidebar detects inert support');
mustContain(app, 'elements.librarySidebar.hidden = !supportsNativeInert && isCollapsed', 'sidebar has an iOS 14 keyboard-focus fallback');
assert.match(
  app,
  /const data = isBuiltInDemoComic\(shelfComic\)\s*\?\s*builtInDemoReaderData\(shelfComic\)\s*:\s*await eAPI\.openComic\(comicId\)/,
  'built-in demo opens static reader data without openComic'
);
assert.match(
  app,
  /if \(!state\.currentComic \|\| isBuiltInDemoComic\(state\.currentComic\)\) return;/,
  'built-in demo does not persist reading progress'
);
assert.match(
  app,
  /if \(!state\.currentComic \|\| isBuiltInDemoComic\(state\.currentComic\) \|\| typeof eAPI\.updateReaderCacheWindow !== 'function'\) return;/,
  'built-in demo does not call the formal reader cache command'
);
assert.doesNotMatch(
  app,
  /localStorage\.setItem\([^\n]*api[-_ ]?key/i,
  'AI API keys must never enter localStorage'
);
assert.match(
  tauri,
  /decoded\.len\(\) > 20 \* 1024 \* 1024/,
  'single-page AI requests should enforce a 20 MiB image cap'
);
mustContain(html, 'id="organize-save-alias"', 'tag alias editor');
mustContain(html, 'id="catalog-import-input"', 'versioned metadata exchange');
mustContain(html, 'id="btn-crop"', 'reader crop control');
mustContain(html, 'id="btn-brightness"', 'reader brightness control');
assert.equal(
  (app.match(/window\.electronAPI\.onCatalogChanged\(\(\) =>/g) || []).length,
  1,
  'catalog change listener should be registered exactly once'
);
assert.match(
  scanner,
  /schedule_catalog_sync\([\s\S]{0,240}generation: u64[\s\S]{0,900}scan_generation[\s\S]{0,240}!= generation[\s\S]{0,120}return;/,
  'queued catalog sync should reject stale scan generations'
);
mustContain(tauriConfig, 'com.windsheep.gai', 'Tauri bundle identifier');
mustContain(appleProject, 'com.windsheep.gai', 'Apple bundle identifier');
mustContain(cargoManifest, 'wry = { path = "vendor/wry" }', 'local Wry patch');
assert.match(
  patchedWry,
  /#\[cfg\(target_os = "ios"\)\]\s*(?:return Ok\("WKWebView \(iOS system framework\)"\.into\(\);|\{\s*let \(major, minor, patch\) = operating_system_version\(\);\s*return Ok\(format!\("\{major\}\.\{minor\}\.\{patch\}"\)\);\s*\})/,
  'iOS startup must not query the unavailable com.apple.WebKit bundle'
);
assert.match(
  patchedWry,
  /#\[cfg\(not\(target_os = "ios"\)\)\]\s*unsafe \{\s*let Some\(bundle\) = NSBundle::bundleWithIdentifier/,
  'non-iOS WebKit version detection should retain the upstream behavior'
);
mustContain(html, 'id="comic-inspector"', 'library layout');
mustContain(html, 'id="comic-grid" tabindex="-1"', 'library focus target');
mustContain(html, 'id="reader-context-menu"', 'reader context menu');
mustContain(html, 'class="nav-zone prev-zone" id="prev-zone"', 'invisible previous-page hit zone');
mustContain(html, 'class="nav-zone next-zone" id="next-zone"', 'invisible next-page hit zone');
assert.doesNotMatch(html, /class="nav-arrow"/, 'reader edge arrows should not cover comic pages');
assert.doesNotMatch(html, /id="(?:prev|next)-zone"[^>]*(?:role=|tabindex=)/, 'invisible reader hit zones must not enter keyboard focus order');
mustContain(html, 'id="theme-picker"', 'theme picker');
mustContain(html, 'id="library-card-size"', 'persistent library cover size control');
mustContain(html, 'viewport-fit=cover', 'iPad safe-area viewport');
mustContain(html, 'id="series-filter-list"', 'desktop series sidebar');
mustContain(html, 'id="sidebar-collapse-btn"', 'collapsible desktop and iPad series sidebar');
mustContain(html, 'id="series-filter-select"', 'compact series filter');
assert.doesNotMatch(html, /data-filter-shortcut=/, 'duplicate smart collection buttons should be removed');
assert.doesNotMatch(html, /id="smb-setup-btn-header"/, 'SMB setup should live in settings only');
mustContain(html, 'id="fallback-folder-browser"', 'web-only folder browser fallback');
mustContain(app, "elements.fallbackFolderBrowser.style.display = 'none'", 'native builds hide duplicate folder browser');
mustContain(html, 'role="dialog" aria-modal="true" aria-labelledby="reader-comic-title"', 'reader dialog semantics');
mustContain(html, 'role="dialog" aria-modal="true" aria-labelledby="settings-title"', 'settings dialog semantics');
assert.equal(
  (html.match(/id="progress-slider"/g) || []).length,
  1,
  'reader progress slider id should be unique'
);
for (const theme of ['midnight', 'sakura', 'ink', 'aurora']) {
  mustContain(html, `data-theme-option="${theme}"`, `theme option ${theme}`);
  mustContain(css, `html[data-theme="${theme}"]`, `theme styling ${theme}`);
}
for (const themeName of ['赤晶戰殿', '黑鉻指揮艙', '翡翠反應爐', '鎏金王座']) {
  mustContain(html, themeName, `premium chromatic theme ${themeName}`);
}
mustContain(css, '--on-accent:', 'accessible accent foreground tokens');
mustContain(css, '@keyframes showroom-sweep', 'mirror-plated showroom sweep');
assert.doesNotMatch(css, /animation:\s*showroom-sweep[^;]*infinite/);
const actionButtonBlock = css.slice(css.indexOf('.modal-action-btn,'), css.indexOf('.theme-preview i'));
assert.doesNotMatch(actionButtonBlock, /animation:\s*plated-flow/);

mustContain(css, '.continue-strip', 'library styling');
mustContain(css, '.organize-bar', 'catalog organizer styling');
mustContain(css, '.organize-mode .loader-mask', 'organizer-safe background status placement');
for (const tagColor of ['rose', 'amber', 'lime', 'cyan', 'blue', 'violet', 'fuchsia', 'slate']) {
  mustContain(css, `[data-tag-color="${tagColor}"]`, `tag palette ${tagColor}`);
}
const organizerActions = [...css.matchAll(/\.organize-actions\s*\{([^}]*)\}/g)]
  .map(match => match[1])
  .find(block => /grid-column:/.test(block));
assert.ok(organizerActions, 'organizer actions: missing grid layout block');
assert.match(organizerActions, /grid-column:\s*1\s*\/\s*-1;/);
assert.match(organizerActions, /grid-row:\s*2;/);
assert.match(organizerActions, /justify-content:\s*flex-end;/);
mustContain(css, '.organize-selected', 'catalog selection styling');
mustContain(css, '.comic-inspector', 'library styling');
mustContain(css, '.comic-grid.background-refresh .comic-card', 'background refresh does not replay card entrance animation');
mustContain(css, '.main-layout.sidebar-collapsed', 'persisted sidebar collapsed layout');
mustContain(css, '@media (min-width: 901px) and (max-width: 1180px)', 'iPad landscape master-detail layout');
mustContain(css, '.reader-context-menu', 'reader styling');
mustContain(css, '.reader-overlay.reader-idle', 'reader idle styling');
mustContain(css, 'Impeccable polish', 'bounded visual polish layer');
mustContain(css, '@media (hover: none), (pointer: coarse)', 'coarse pointer controls');
mustContain(css, 'env(safe-area-inset-bottom)', 'safe-area adaptation');

mustContain(app, 'function jumpToFirstPage()', 'keyboard navigation');
mustContain(app, 'function jumpToLastPage()', 'keyboard navigation');
mustContain(app, 'function handleReaderPointerClick', 'mouse navigation');
mustContain(app, 'function activateGridComic(comic)', 'two-stage comic card activation');
mustContain(app, 'if (state.selectedComicId === comic.id)', 'selected comic opens only on repeated activation');
mustContain(app, 'card.onclick = () => activateGridComic(comic)', 'grid cards route through staged activation');
mustContain(app, 'configureInteractiveItem(card, `開啟資料夾：${comic.title}`', 'folder cards retain single-step navigation');
assert.doesNotMatch(app, /continue-card'[\s\S]{0,300}mouseenter/, 'continue cards must not silently replace inspector selection on hover');
mustContain(app, 'function applySidebarCollapsed', 'persistent sidebar collapse behavior');
mustContain(app, 'elements.librarySidebar.inert = isCollapsed', 'collapsed sidebar leaves the keyboard focus order');
mustContain(app, "#ai-page-panel", 'AI panel reader-navigation boundary');
mustContain(app, 'function readerImageFitScale', 'rotation-aware reader fitting');
mustContain(app, 'function replaceReaderImages', 'reader transform refresh after image mount');
mustContain(app, 'function scheduleAutoPageExplanation', 'latest-page-only read-along queue');
mustContain(app, 'RESOURCE_EXHAUSTED', 'AI quota exhaustion should stop read-along retries');
mustContain(css, '.ai-page-panel.reader-rotated', 'lying-down AI panel orientation');
mustContain(app, 'function handleReaderContextMenu', 'mouse context menu');
mustContain(app, 'function handleReaderAuxClick', 'mouse side buttons');
mustContain(app, 'state._smbLoaderTimer = null;', 'SMB loader timer cleanup');
assert.doesNotMatch(app, /closest\?\.\('button, input, select, textarea'\) && e\.key/);
mustContain(app, 'function hideReaderContextMenu', 'mouse context menu');
mustContain(app, 'const httpAPI', 'browser fallback');
mustContain(app, "window.electronAPI || httpAPI", 'browser fallback');
mustContain(app, "'/api/library'", 'browser fallback');
mustContain(app, 'const MAX_PRELOADED_IMAGES', 'reader preload budget');
mustContain(app, 'const READER_PRELOAD_RADIUS = 10', 'reader sliding preload radius');
mustContain(app, 'function takePreloadedReaderImage', 'reader should reuse preloaded image elements');
mustContain(app, 'function scheduleReaderCacheWindowUpdate', 'reader backend cache window scheduling');
mustContain(tauriApi, "invoke('update_reader_cache_window'", 'reader cache window bridge');
mustContain(app, 'function prunePreloadedImages', 'reader preload budget');
mustContain(app, 'state.preloadedImages.delete(idx)', 'failed reader preload retry');
mustContain(app, 'decoding = \'async\'', 'async image decoding');
mustContain(app, 'fetchPriority = \'low\'', 'low-priority noncritical images');
mustContain(app, 'function showLoaderProgress', 'loader progress UI');
mustContain(tauriApi, "showItemInFolder: (comicId) => invoke('show_item_in_folder', { comicId })", 'Finder reveal must use a catalog identity instead of a raw path');
mustContain(tauri, 'mutate_comic_file', 'catalog-identity file mutation command');
mustContain(tauri, 'undo_comic_file_operation', 'recoverable file operation undo command');
mustContain(tauriApi, "invoke('mutate_comic_file'", 'frontend file mutation bridge');
mustContain(app, 'function setLoaderProgress', 'loader progress UI');
mustContain(css, 'pointer-events: none', 'background work status must not block interaction');
const performLibraryFetchBody = bracedBlock(
  app,
  'async function performLibraryFetch({ background = false } = {})',
  'performLibraryFetch'
);
assert.match(
  performLibraryFetchBody,
  /if \(scanStillRunning && !failed\)[\s\S]*updateLoaderScanProgress\(latestScanStatus\);[\s\S]*state\.loaderHideTimer = window\.setTimeout\(hideLoader, 6000\);[\s\S]*hideLoader\(\);/,
  'library loading must keep background scan status visible until completion'
);
assert.match(
  app,
  /function updateLoaderScanProgress\(status\)[\s\S]{0,420}if \(!status\.isScanning\)[\s\S]{0,220}stopScanStatusPolling\(\)[\s\S]{0,220}setTimeout\(hideLoader, 250\)/,
  'scan status polling must dismiss the loader when no library-changed event is emitted'
);
assert.match(
  app,
  /if \(!elements\.seriesFilterSelect\.value\) \{\s*state\.activeSeries = 'all';\s*state\.currentPath = '';\s*\}/,
  'missing series selections must reset both series and path filters'
);
assert.doesNotMatch(
  html,
  /class="filter-btn organize-toggle"/,
  'organizer toggle must not trigger the library filter handler'
);
mustContain(app, 'function applyTheme', 'theme switching');
mustContain(app, 'function applyLibraryCardSize', 'live library cover size preference');
mustContain(app, "value === null || value === undefined || value === ''", 'missing cover size preference uses the standard default');
mustContain(app, "localStorage.setItem(LIBRARY_CARD_SIZE_STORAGE_KEY, String(size))", 'persistent library cover size preference');
mustContain(css, 'var(--library-card-min-width, 150px)', 'responsive library cover sizing');
mustContain(app, 'function setOrganizeMode', 'catalog organizer behavior');
mustContain(app, "document.createElement(state.organizeMode && !comic.isDirectory ? 'button' : 'div')", 'organizer cards use native accessible buttons');
mustContain(css, '.comic-card.organize-selectable', 'organizer accessible button reset');
mustContain(css, '.comic-card.source-offline', 'offline comic styling');
mustContain(app, 'function applyOrganizerBatch', 'batch metadata behavior');
mustContain(app, 'function refreshCatalogSearch', 'SQLite catalog search behavior');
mustContain(app, 'function showOrganizerInbox', 'low-confidence inbox behavior');
mustContain(app, 'function showDuplicateCandidates', 'duplicate review behavior');
mustContain(app, 'function saveOrganizerAlias', 'tag alias behavior');
mustContain(app, 'function previewCatalogMetadataFile', 'metadata import preview');
mustContain(app, 'function toggleCropEdges', 'reader crop behavior');
mustContain(app, 'function cycleBrightness', 'reader brightness behavior');
mustContain(app, 'state.filteredComics.slice(0, state.renderLimit)', 'bounded catalog DOM rendering');
mustContain(app, 'function bindKeyboardActivation', 'keyboard activation helper');
mustContain(app, 'function configureInteractiveItem', 'dynamic interactive semantics');
mustContain(app, "setAttribute('aria-pressed'", 'pressed state semantics');
mustContain(app, "const THEME_STORAGE_KEY = 'gai:theme'", 'theme persistence');
mustContain(app, 'function getCoverUrl(comicId)', 'cross-runtime cover routing');
mustContain(app, "`/api/cover?id=${encodedId}`", 'browser cover routing');
mustContain(app, '`gai://cover/${encodedId}`', 'desktop cover routing');
mustContain(app, '!img.getAttribute(\'src\')', 'webtoon lazy image detection');
mustContain(app, 'img.removeAttribute(\'src\')', 'reader preload cleanup');
mustContain(app, 'renderGeneration', 'reader render invalidation');
mustContain(app, 'async function clearSmbConfig()', 'SMB cleanup');
assert.doesNotMatch(html, /id="status-ram"/, 'background RAM preload diagnostics should not cover comic pages');
assert.doesNotMatch(app, /function updateRamCacheProgress/, 'removed RAM badge must not retain dead rendering code');
mustContain(app, "console.warn('[RAM preload] 已改用逐頁讀取：'", 'preload errors silently fall back to per-page reads');
mustContain(scanner, 'external_bookmark: external_bookmark.map(str::to_owned)', 'bookmark ownership');
mustContain(scanner, 'store.mark_source_offline(&source_id)', 'missing local source retention');
mustContain(catalog, "source_id LIKE 'local:%'", 'local root drift retirement');
mustContain(tauri, 'store.get_runtime_item(&lookup_id)', 'catalog-only reader recovery');
mustContain(tauri, 'search_catalog', 'catalog search command');
mustContain(tauri, 'apply_batch_metadata', 'catalog batch command');
mustContain(tauri, 'list_tag_inventory', 'tag inventory command');
mustContain(tauri, 'rename_tag', 'tag rename command');
mustContain(tauri, 'merge_tags', 'tag merge command');
mustContain(tauri, 'undo_tag_operation', 'tag operation undo command');
mustContain(tauri, 'preview_catalog_import', 'catalog import preview command');
mustContain(tauri, 'get_online_services_config', 'offline-by-default service contract');
mustContain(iosFolderPlugin, 'startDownloadingUbiquitousItem', 'iCloud materialization');
mustContain(iosFolderPlugin, 'NSFileCoordinator()', 'file provider coordination');
mustContain(html, 'id="loader-progress"', 'loader progress UI');
mustContain(css, '.loader-progress', 'loader progress styling');
mustContain(server, 'folderImageListCache', 'folder image list cache');
mustContain(server, 'function getCachedFolderImageFiles', 'folder image list cache');
mustContain(server, 'process.env.GAI_BASE_DIR', 'server base dir');
const main = readRequiredFile('main.js', 'main script');
mustContain(main, 'folderImageListCache', 'electron folder image list cache');
mustContain(main, 'function getCachedFolderImages', 'electron folder image list cache');
assert.match(
  app,
  /const renderGeneration = \+\+state\.renderGeneration[\s\S]*state\.renderGeneration !== renderGeneration/,
  'stale reader decode callbacks should be invalidated'
);
assert.match(
  app,
  /async function clearSmbConfig\(\) \{[\s\S]*await eAPI\.setSmbConfig\(null\)[\s\S]*localStorage\.removeItem/,
  'SMB local state should clear only after backend success'
);
assert.match(
  app,
  /await window\.electronAPI\.setBookmarks\(bookmarks\);[\s\S]{0,180}localStorage\.setItem\('gai:externalBookmarks'/,
  'external bookmarks should persist only after backend activation succeeds'
);
assert.match(
  tauri,
  /if let Err\(error\) = std::fs::create_dir_all\(parent\)[\s\S]*smb-download-end[\s\S]*return Err/,
  'SMB temp directory failures should end progress and return an error'
);
assert.doesNotMatch(
  server,
  /const BASE_DIR = '\/Volumes\/MyGame\/G\.A\.I'/,
  'server should not hard-code a macOS-only base directory'
);

assert.match(
  app,
  /case 'ArrowUp':[\s\S]*jumpToFirstPage\(\)/,
  'ArrowUp should jump to the first page'
);
assert.match(
  app,
  /case 'ArrowDown':[\s\S]*jumpToLastPage\(\)/,
  'ArrowDown should jump to the last page'
);
assert.match(
  app,
  /readerOverlay\.classList\.add\('reader-idle'\)/,
  'reader should enter idle mode'
);
assert.match(
  app,
  /readerOverlay\.classList\.remove\('reader-idle'\)/,
  'reader should leave idle mode on activity'
);
assert.match(
  app,
  /case 'Escape':[\s\S]{0,260}hideReaderContextMenu\(\);\s*triggerControlsActive\(\);\s*break;/,
  'closing the context menu with Escape should restart the idle timer'
);
const preloadNextPagesBody = bracedBlock(app, 'function preloadNextPages()', 'preloadNextPages');
assert.match(preloadNextPagesBody, /prunePreloadedImages\(indicesToPreload\)/, 'preloading should prune images outside the active reading window');
assert.match(
  css,
  /\.reader-bottom-bar\s*\{[\s\S]{0,420}left:\s*max\(16px,[\s\S]{0,180}width:\s*auto;[\s\S]{0,180}transform:\s*translateY\(120%\)/,
  'reader bottom bar should use edge insets without a stale horizontal translation'
);
assert.match(
  css,
  /\.ai-page-btn\s*\{[\s\S]{0,260}flex:\s*0 0 auto;[\s\S]{0,260}white-space:\s*nowrap;/,
  'reader AI actions should remain on one line'
);
assert.match(
  app,
  /showLoaderProgress\([\s\S]{0,320}loaderProgress\.style\.display = 'block'/,
  'loader progress should toggle the progress UI'
);

assert.equal(
  (app.match(/gai:\/\/cover\//g) || []).length,
  1,
  'all cover consumers should route through getCoverUrl'
);

assert.match(
  tauriProtocol,
  /page_count > 0 && page_index >= page_count/,
  'unknown Tauri page counts should not reject cover page zero'
);

assert.match(
  tauriProtocol,
  /if full_path\.is_dir\(\)[\s\S]{0,900}get_folder_images/,
  'Tauri cover routing should read the first image from folder comics'
);
mustContain(tauriProtocol, 'canonical_image_within(img_path, &full_path)', 'Tauri folder cover boundary');

assert.match(
  app,
  /async function openReader\(comicId\) \{[\s\S]*await state\.readerClosePromise/,
  'openReader should await any pending backend cleanup'
);
assert.match(
  app,
  /state\.currentComic = null;[\s\S]*state\.readerClosePromise = state\.readerClosePromise/,
  'closeReader should clear UI state before serializing backend cleanup'
);
assert.match(
  tauri,
  /gai:\/\/folder\/\{\}\/\{\}", id, i/,
  'folder pages should use comic id as capability token'
);
assert.match(
  tauri,
  /fn write_progress_file[\s\S]*\.comic_progress\.json\.tmp[\s\S]*progress_file_lock\.lock\(\)\.await/,
  'save_progress should write to a temporary file before renaming atomically'
);
assert.match(
  app,
  /function renderCatalogGrid\(\)[\s\S]{0,260}pagesContainer\.replaceChildren\(\)/,
  'catalog redraw should replace the previous thumbnail grid'
);
assert.match(
  app,
  /expectedFingerprint:\s*panel\.dataset\.expectedFingerprint \|\| null/,
  'file mutations should return the capability fingerprint precondition'
);
assert.match(
  app,
  /const selected = state\.filteredComics\.find[\s\S]{0,260}renderInspectorEmpty\(\)/,
  'changing folders or filters should clear a stale inspector selection'
);
assert.match(
  app,
  /function resetLibraryNavigationState\(\)[\s\S]{0,700}catalogSearchItems\.clear\(\)[\s\S]{0,700}renderCatalogFacets\(\[\]\)/,
  'switching the library root should clear folder, selection, and catalog search state'
);
assert.match(
  app,
  /function selectSeries\(seriesName\)[\s\S]{0,700}state\.currentPath = ''/,
  'metadata series filtering should not masquerade as folder navigation'
);
assert.match(
  app,
  /if \(idx < state\.currentPageIndex\) state\.currentPageIndex -= 1/,
  'deleting an earlier catalog page should preserve the visible logical page'
);
assert.match(
  css,
  /@media \(hover: none\), \(pointer: coarse\)[\s\S]{0,650}\.inspector-primary,[\s\S]{0,650}min-height:\s*44px/,
  'iPad inspector actions should meet the 44px touch target floor'
);
assert.doesNotMatch(css, /var\(--bg-dark\)/, 'all UI surfaces should use defined design tokens');

console.log('UI smoke checks passed.');
