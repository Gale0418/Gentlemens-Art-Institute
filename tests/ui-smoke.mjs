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

const mustContain = (source, needle, label) => {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
};

mustContain(html, 'id="continue-strip"', 'library layout');
mustContain(html, 'id="comic-inspector"', 'library layout');
mustContain(html, 'id="reader-context-menu"', 'reader context menu');

mustContain(css, '.continue-strip', 'library styling');
mustContain(css, '.comic-inspector', 'library styling');
mustContain(css, '.reader-context-menu', 'reader styling');
mustContain(css, '.reader-overlay.reader-idle', 'reader idle styling');

mustContain(app, 'function jumpToFirstPage()', 'keyboard navigation');
mustContain(app, 'function jumpToLastPage()', 'keyboard navigation');
mustContain(app, 'function handleReaderPointerClick', 'mouse navigation');
mustContain(app, 'function handleReaderContextMenu', 'mouse context menu');
mustContain(app, 'function handleReaderAuxClick', 'mouse side buttons');
mustContain(app, 'function hideReaderContextMenu', 'mouse context menu');
mustContain(app, 'const httpAPI', 'browser fallback');
mustContain(app, "window.electronAPI || httpAPI", 'browser fallback');
mustContain(app, "'/api/library'", 'browser fallback');
mustContain(app, 'const MAX_PRELOADED_IMAGES', 'reader preload budget');
mustContain(app, 'function prunePreloadedImages', 'reader preload budget');
mustContain(app, 'decoding = \'async\'', 'async image decoding');
mustContain(app, 'fetchPriority = \'low\'', 'low-priority noncritical images');
mustContain(app, 'function showLoaderProgress', 'loader progress UI');
mustContain(app, 'function setLoaderProgress', 'loader progress UI');
mustContain(app, '!img.getAttribute(\'src\')', 'webtoon lazy image detection');
mustContain(app, 'img.removeAttribute(\'src\')', 'reader preload cleanup');
mustContain(app, 'renderGeneration', 'reader render invalidation');
mustContain(app, 'async function clearSmbConfig()', 'SMB cleanup');
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

console.log('UI smoke checks passed.');
