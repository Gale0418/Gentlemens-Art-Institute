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

const mustContain = (source, needle, label) => {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
};

mustContain(html, 'id="continue-strip"', 'library layout');
mustContain(html, 'id="organize-toggle"', 'catalog organizer');
mustContain(html, 'id="organize-bar"', 'catalog organizer');
mustContain(html, 'id="catalog-load-more"', 'bounded catalog rendering');
mustContain(html, 'id="organize-inbox"', 'low-confidence organizer inbox');
mustContain(html, 'id="organize-duplicates"', 'duplicate candidate review');
mustContain(html, 'id="btn-ai-explain"', 'single-page AI explanation action');
mustContain(html, 'id="btn-ai-suggest"', 'single-page AI metadata candidate action');
mustContain(html, 'id="ai-api-key"', 'manual AI provider key input');
mustContain(tauri, '"gpt-5.6-luna"', 'fixed low-cost Luna model');
mustContain(tauri, '"gemma-4-26b-a4b-it"', 'fixed free-tier Gemma 4 model');
mustContain(tauri, 'suggest_comic_metadata', 'AI metadata candidate command');
mustContain(app, 'suggestCurrentPageMetadata', 'AI metadata candidate handler');
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
mustContain(tauriConfig, 'com.windsheep.comicreader', 'Tauri bundle identifier');
mustContain(appleProject, 'com.windsheep.comicreader', 'Apple bundle identifier');
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
mustContain(html, 'id="theme-picker"', 'theme picker');
mustContain(html, 'viewport-fit=cover', 'iPad safe-area viewport');
mustContain(html, 'class="tablet-collections"', 'tablet collection shortcuts');
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
mustContain(css, '.organize-selected', 'catalog selection styling');
mustContain(css, '.comic-inspector', 'library styling');
mustContain(css, '.reader-context-menu', 'reader styling');
mustContain(css, '.reader-overlay.reader-idle', 'reader idle styling');
mustContain(css, 'Impeccable polish', 'bounded visual polish layer');
mustContain(css, '@media (hover: none), (pointer: coarse)', 'coarse pointer controls');
mustContain(css, 'env(safe-area-inset-bottom)', 'safe-area adaptation');

mustContain(app, 'function jumpToFirstPage()', 'keyboard navigation');
mustContain(app, 'function jumpToLastPage()', 'keyboard navigation');
mustContain(app, 'function handleReaderPointerClick', 'mouse navigation');
mustContain(app, 'function handleReaderContextMenu', 'mouse context menu');
mustContain(app, 'function handleReaderAuxClick', 'mouse side buttons');
mustContain(app, 'state._smbLoaderTimer = null;', 'SMB loader timer cleanup');
assert.doesNotMatch(app, /closest\?\.\('button, input, select, textarea'\) && e\.key/);
mustContain(app, 'function hideReaderContextMenu', 'mouse context menu');
mustContain(app, 'const httpAPI', 'browser fallback');
mustContain(app, "window.electronAPI || httpAPI", 'browser fallback');
mustContain(app, "'/api/library'", 'browser fallback');
mustContain(app, 'const MAX_PRELOADED_IMAGES', 'reader preload budget');
mustContain(app, 'function prunePreloadedImages', 'reader preload budget');
mustContain(app, 'state.preloadedImages.delete(idx)', 'failed reader preload retry');
mustContain(app, 'decoding = \'async\'', 'async image decoding');
mustContain(app, 'fetchPriority = \'low\'', 'low-priority noncritical images');
mustContain(app, 'function showLoaderProgress', 'loader progress UI');
mustContain(app, 'function setLoaderProgress', 'loader progress UI');
mustContain(app, 'function applyTheme', 'theme switching');
mustContain(app, 'function setOrganizeMode', 'catalog organizer behavior');
mustContain(app, "document.createElement(state.organizeMode && !comic.isDirectory ? 'button' : 'div')", 'organizer cards use native accessible buttons');
mustContain(css, '.comic-card.organize-selectable', 'organizer accessible button reset');
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
mustContain(app, "const THEME_STORAGE_KEY = 'comic-reader:theme'", 'theme persistence');
mustContain(app, 'function getCoverUrl(comicId)', 'cross-runtime cover routing');
mustContain(app, "`/api/cover?id=${encodedId}`", 'browser cover routing');
mustContain(app, '`comic://cover/${encodedId}`', 'desktop cover routing');
mustContain(app, '!img.getAttribute(\'src\')', 'webtoon lazy image detection');
mustContain(app, 'img.removeAttribute(\'src\')', 'reader preload cleanup');
mustContain(app, 'renderGeneration', 'reader render invalidation');
mustContain(app, 'async function clearSmbConfig()', 'SMB cleanup');
mustContain(app, 'RAM 預載略過，將改為逐頁讀取', 'preload error fallback');
mustContain(scanner, 'external_bookmark: external_bookmark.map(str::to_owned)', 'bookmark ownership');
mustContain(tauri, 'search_catalog', 'catalog search command');
mustContain(tauri, 'apply_batch_metadata', 'catalog batch command');
mustContain(tauri, 'preview_catalog_import', 'catalog import preview command');
mustContain(tauri, 'get_online_services_config', 'offline-by-default service contract');
mustContain(iosFolderPlugin, 'startDownloadingUbiquitousItem', 'iCloud materialization');
mustContain(iosFolderPlugin, 'NSFileCoordinator()', 'file provider coordination');
mustContain(html, 'id="loader-progress"', 'loader progress UI');
mustContain(css, '.loader-progress', 'loader progress styling');
mustContain(server, 'folderImageListCache', 'folder image list cache');
mustContain(server, 'function getCachedFolderImageFiles', 'folder image list cache');
mustContain(server, 'process.env.COMIC_BASE_DIR', 'server base dir');
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
  /await window\.electronAPI\.setBookmarks\(bookmarks\);[\s\S]{0,180}localStorage\.setItem\('comic-reader:externalBookmarks'/,
  'external bookmarks should persist only after backend activation succeeds'
);
assert.match(
  tauri,
  /if let Err\(error\) = std::fs::create_dir_all\(parent\)[\s\S]*smb-download-end[\s\S]*return Err/,
  'SMB temp directory failures should end progress and return an error'
);
assert.doesNotMatch(
  server,
  /const BASE_DIR = '\/Volumes\/MyGame\/comic'/,
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
assert.match(
  app,
  /preloadNextPages[\s\S]{0,900}prunePreloadedImages\(indicesToPreload\)/,
  'preloading should prune images outside the active reading window'
);
assert.match(
  app,
  /showLoaderProgress\([\s\S]{0,320}loaderProgress\.style\.display = 'block'/,
  'loader progress should toggle the progress UI'
);

assert.equal(
  (app.match(/comic:\/\/cover\//g) || []).length,
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
  /comic:\/\/folder\/\{\}\/\{\}", id, i/,
  'folder pages should use comic id as capability token'
);
assert.match(
  tauri,
  /fn write_progress_file[\s\S]*\.comic_progress\.json\.tmp[\s\S]*progress_file_lock\.lock\(\)\.await/,
  'save_progress should write to a temporary file before renaming atomically'
);

console.log('UI smoke checks passed.');
