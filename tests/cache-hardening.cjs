const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const serverText = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const mainText = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

assert.match(serverText, /function clearLibraryCaches/);
assert.match(serverText, /archiveEntriesCache\.clear\(\)/);
assert.match(serverText, /coverBufferCache\.clear\(\)/);
assert.match(serverText, /zipHandleCache\.clear\(\)/);
assert.match(serverText, /app\.get\('\/api\/cover',[\s\S]*serveComicPage/);
assert.match(serverText, /path\.resolve\(fullPath\) === path\.resolve\(SERVER_CACHE_DIR\)/);
assert.match(serverText, /const MAX_IMAGE_BYTES = 64 \* 1024 \* 1024/);
assert.match(serverText, /entry\.uncompressedSize > MAX_IMAGE_BYTES/);
assert.match(serverText, /imageStat\.size > MAX_IMAGE_BYTES/);
assert.match(serverText, /canonicalRel\.startsWith\('\.\.'\)/);
assert.match(serverText, /imageRel\.startsWith\('\.\.'\)/);
assert.match(serverText, /case '\.svg': return 'image\/svg\+xml'/);
assert.match(serverText, /case '\.avif': return 'image\/avif'/);
assert.doesNotMatch(serverText, /app\._router\.handle\(req, res\)/);
assert.doesNotMatch(serverText, /depth > 3/);

assert.match(mainText, /function clearReaderCaches/);
assert.match(mainText, /zipHandleCache\.clear\(\)/);
assert.match(mainText, /coverMemCache\.clear\(\)/);
assert.match(mainText, /ramCachePool\.clear\(\)/);
assert.match(mainText, /preloadFailuresPool\.clear\(\)/);
assert.match(mainText, /ipcMain\.handle\('set-config',[\s\S]*clearReaderCaches\(\)/);
assert.doesNotMatch(mainText, /depth > 3/);

const appText = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
assert.match(appText, /function getCoverUrl\(comicId\)/);

// Node environment evaluation test of getCoverUrl helper behavior
const vm = require('vm');
const sandbox = {
  window: {},
  httpAPI: { isElectron: false },
  encodeURIComponent
};
vm.createContext(sandbox);
vm.runInContext(appText.substring(appText.indexOf('function getCoverUrl'), appText.indexOf('const MAX_PRELOADED_IMAGES')), sandbox);
sandbox.eAPI = sandbox.httpAPI;
assert.strictEqual(sandbox.getCoverUrl('test/id'), '/api/cover?id=test%2Fid');
sandbox.eAPI = { isElectron: true };
assert.strictEqual(sandbox.getCoverUrl('test/id'), 'comic://cover/test%2Fid');

console.log('PASS: ComicReader cache and routing hardening checks look correct');
