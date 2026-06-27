const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = 'D:/MyGame/comic';
const serverText = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const mainText = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

assert.match(serverText, /function clearLibraryCaches/);
assert.match(serverText, /archiveEntriesCache\.clear\(\)/);
assert.match(serverText, /coverBufferCache\.clear\(\)/);
assert.match(serverText, /zipHandleCache\.clear\(\)/);
assert.match(serverText, /app\.get\('\/api\/cover',[\s\S]*serveComicPage/);
assert.doesNotMatch(serverText, /app\._router\.handle\(req, res\)/);
assert.doesNotMatch(serverText, /depth > 3/);

assert.match(mainText, /function clearReaderCaches/);
assert.match(mainText, /zipHandleCache\.clear\(\)/);
assert.match(mainText, /coverMemCache\.clear\(\)/);
assert.match(mainText, /ramCachePool\.clear\(\)/);
assert.match(mainText, /preloadFailuresPool\.clear\(\)/);
assert.match(mainText, /ipcMain\.handle\('set-config',[\s\S]*clearReaderCaches\(\)/);
assert.doesNotMatch(mainText, /depth > 3/);

console.log('PASS: ComicReader cache and routing hardening checks look correct');
