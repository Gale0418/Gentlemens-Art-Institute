const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverText = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const mainText = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const guideText = fs.readFileSync(path.join(root, 'BUILD_GUIDE.md'), 'utf8');

for (const extension of ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
  assert.match(serverText, new RegExp(`['"]${extension.replace('.', '\\.') }['"]`));
  assert.match(mainText, new RegExp(`['"]${extension.replace('.', '\\.') }['"]`));
}
assert.doesNotMatch(serverText, /const IMAGE_EXTENSIONS = [^\n]*\.svg/);
assert.doesNotMatch(mainText, /const IMAGE_EXTENSIONS = [^\n]*\.svg/);

assert.match(serverText, /function clearLibraryCaches/);
assert.match(serverText, /archiveEntriesCache\.clear\(\)/);
assert.match(serverText, /coverBufferCache\.clear\(\)/);
assert.match(serverText, /zipHandleCache\.clear\(\)/);
assert.match(serverText, /app\.get\('\/api\/cover',[\s\S]*serveComicPage/);
assert.match(serverText, /path\.resolve\(fullPath\) === path\.resolve\(SERVER_CACHE_DIR\)/);
assert.match(serverText, /app\.listen\(PORT, ['"]127\.0\.0\.1['"]/);
assert.doesNotMatch(serverText, /import cors from/);
assert.doesNotMatch(serverText, /app\.use\(cors\(\)\)/);
assert.match(serverText, /originUrl\.host\.toLowerCase\(\) !== requestHost/);
assert.doesNotMatch(serverText, /readdirSync\(COVER_CACHE_DIR\).*filter/);
assert.match(serverText, /function getCachedCoverPath/);
assert.match(
  serverText,
  /fs\.promises\.writeFile\(cacheFilePath, buffer\)[\s\S]{0,120}\.then\(\(\) => coverDiskCache\.set\(`\$\{id\}:0`, cacheFilePath\)\)/,
  'disk cover cache must only publish completed writes'
);
assert.match(serverText, /const MAX_IMAGE_BYTES = 64 \* 1024 \* 1024/);
assert.match(serverText, /entry\.uncompressedSize > MAX_IMAGE_BYTES/);
assert.match(serverText, /imageStat\.size > MAX_IMAGE_BYTES/);
assert.match(serverText, /canonicalRel\.startsWith\('\.\.'\)/);
assert.match(serverText, /imageRel\.startsWith\('\.\.'\)/);
assert.match(serverText, /case '\.svg': return 'application\/octet-stream'/);
assert.match(serverText, /function isStrictBase64Url/);
assert.match(serverText, /isStrictBase64Url\(id\)/);
assert.match(serverText, /function isStrictPageIndex/);
assert.match(serverText, /isStrictPageIndex\(rawPage\)/);
assert.doesNotMatch(serverText, /Number\.parseInt\(page,\s*10\)/);
assert.match(serverText, /X-Content-Type-Options', 'nosniff'/);
assert.match(serverText, /case '\.avif': return 'image\/avif'/);
assert.doesNotMatch(serverText, /app\._router\.handle\(req, res\)/);
assert.doesNotMatch(serverText, /depth > 3/);

assert.match(mainText, /function clearReaderCaches/);
assert.match(mainText, /zipHandleCache\.clear\(\)/);
assert.match(mainText, /coverMemCache\.clear\(\)/);
assert.match(mainText, /ramCachePool\.clear\(\)/);
assert.match(mainText, /preloadFailuresPool\.clear\(\)/);
assert.match(mainText, /bookCache = updatedCache/, 'preloader should follow the cache map recreated after eviction');
assert.match(mainText, /if \(ext === '\.svg'\) return 'application\/octet-stream'/);
assert.match(mainText, /isWithinDirectory\(resolvedFolder, resolvedScanDir\)/);
assert.match(mainText, /function isStrictPageIndex/);
assert.match(mainText, /totalPages > 0 && currentPage >= totalPages/, 'Electron progress should enforce zero-based page bounds');
assert.match(mainText, /\['ENOENT', 'ENOTDIR', 'ESTALE', 'EIO'\]\.includes\(e\.code\)[\s\S]{0,100}找不到漫畫！/);
assert.match(mainText, /e\.message === 'forbidden: path traversal detected'/);
assert.match(mainText, /ipcMain\.handle\('set-config',[\s\S]*clearReaderCaches\(\)/);
assert.doesNotMatch(mainText, /depth > 3/);

const appText = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
assert.match(appText, /function getCoverUrl\(comicId\)/);
assert.match(appText, /狀態已更新/);
assert.match(appText, /外部資料夾已更新，但舊資料夾權限釋放部分失敗/);
assert.match(appText, /let desiredBookmarks = null/);
assert.match(appText, /stateWasUpdated && desiredBookmarks/);
assert.match(appText, /JSON\.stringify\(desiredBookmarks\)/);
assert.match(guideText, /validate_build_paths\(\) \{/);
assert.match(guideText, /require_nonempty GAI_DEVICE_ID/);
assert.match(guideText, /paths_overlap/);
assert.match(guideText, /GAI_PROJECT_DIR 不可為 \/ 或 HOME/);
assert.ok(guideText.indexOf('validate_build_paths') < guideText.indexOf('rm -rf'), 'build paths must be validated before destructive commands');

const isStrictPageIndex = value => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
};
for (const value of ['0', '1', '9007199254740991', 0, 1, Number.MAX_SAFE_INTEGER]) {
  assert.equal(isStrictPageIndex(value), true, `expected valid page index: ${value}`);
}
for (const value of ['01', '1abc', '1.0', '-1', '9007199254740992', '1e2', '', ' 1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
  assert.equal(isStrictPageIndex(value), false, `expected invalid page index: ${value}`);
}

// Node environment evaluation test of getCoverUrl helper behavior
const vm = require('vm');
const sandbox = {
  window: {},
  httpAPI: { isElectron: false },
  encodeURIComponent
};
vm.createContext(sandbox);
vm.runInContext(appText.substring(appText.indexOf('function getCoverUrl'), appText.indexOf('const MAX_PRELOADED_IMAGES')), sandbox, { timeout: 1000 });
sandbox.classifyBookmarkUpdateError = undefined;
const classifierStart = appText.indexOf('function classifyBookmarkUpdateError');
const classifierEnd = appText.indexOf('function bindEvents', classifierStart);
vm.runInContext(appText.slice(classifierStart, classifierEnd), sandbox, { timeout: 1000 });
const partialError = sandbox.classifyBookmarkUpdateError({ message: 'BOOKMARKS_UPDATED: 權限釋放失敗' });
assert.equal(partialError.message, 'BOOKMARKS_UPDATED: 權限釋放失敗');
assert.equal(partialError.stateWasUpdated, true);
const rejectedError = sandbox.classifyBookmarkUpdateError(new Error('無法加入外部資料夾'));
assert.equal(rejectedError.message, '無法加入外部資料夾');
assert.equal(rejectedError.stateWasUpdated, false);
sandbox.eAPI = sandbox.httpAPI;
assert.strictEqual(sandbox.getCoverUrl('test/id'), '/api/cover?id=test%2Fid');
sandbox.eAPI = { isElectron: true };
assert.strictEqual(sandbox.getCoverUrl('test/id'), 'gai://cover/test%2Fid');

console.log('PASS: G.A.I cache and routing hardening checks look correct');

// Exercise the HTTP boundary with a disposable library. This catches the
// regressions that source-only assertions cannot: malformed tokens, page
// coercion, same-origin policy, and progress bounds.
(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-server-hardening-'));
  const testPort = 41000 + (process.pid % 1000);
  const library = path.join(fixture, 'library', 'series');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'page.jpg'), Buffer.from('fixture-image'));
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, GAI_BASE_DIR: fixture, GAI_PORT: String(testPort), ELECTRON_MODE: '1', GAI_SCAN_MAX_DEPTH: 'NaN' },
    stdio: 'ignore'
  });

  const request = async (url, options) => {
    const response = await fetch(`http://127.0.0.1:${testPort}${url}`, options);
    let body = null;
    try { body = await response.json(); } catch (e) {}
    return { status: response.status, body };
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      try {
        const probe = await request('/api/scan-status');
        ready = probe.status === 200;
      } catch (e) {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'server should start on loopback');

    assert.equal((await request('/api/comic/not-valid!')).status, 400);
    assert.equal((await request('/api/comic/ Li4vdG1w')).status, 400);
    assert.equal((await request('/api/comic/Li4vdG1zaG91bGRub3RleGlzdA')).status, 403);
    assert.equal((await request('/api/page?id=Li4vdG1w&page=NaN')).status, 400);
    assert.equal((await request('/api/page?id=Li4vdG1w&page=1.0')).status, 400);
    assert.equal((await request('/api/scan-status', { headers: { Origin: 'http://evil.example' } })).status, 403);

    const comicId = Buffer.from('library/series').toString('base64url');
    assert.equal((await request(`/api/comic/${comicId}`)).status, 200);
    assert.equal((await request('/api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: comicId, currentPage: '1abc', totalPages: 1 })
    })).status, 400);
    assert.equal((await request('/api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: comicId, currentPage: 1, totalPages: 1 })
    })).status, 400);
    assert.equal((await request('/api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: comicId, currentPage: 0, totalPages: 1 })
    })).status, 200);
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  console.log('PASS: HTTP runtime input and same-origin hardening checks look correct');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
