import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 這個 fixture 只讀取 public 內的 UI 與示範封面；不接觸 config、SQLite、NAS 或正式漫畫庫。
// 不註冊 service worker，也不啟動任何 app worker，避免影響 public app 的 runtime。
const HOST = '127.0.0.1';
const PORT = 4179;
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(TESTS_DIR, '..', 'public');
const DEMO_COVER_URL = '/assets/demo/moonlit-archive/cover.jpg';
const INDEX_PATH = path.join(PUBLIC_ROOT, 'index.html');

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const FIXTURE_BOOTSTRAP = String.raw`
<script>
(() => {
  'use strict';

  const FIXTURE_COUNT = 5000;
  const ACCEPTANCE_MS = 5000;
  const fixtureComics = Array.from({ length: FIXTURE_COUNT }, (_, offset) => {
    const number = offset + 1;
    const id = 'fixture-' + String(number).padStart(5, '0');
    return {
      id,
      type: 'archive',
      ext: '.cbz',
      title: 'Fixture 漫畫 ' + String(number).padStart(5, '0'),
      series: 'Fixture 平面書庫',
      relativePath: id + '.cbz',
      updatedAt: '2026-01-01T00:00:00.000Z',
      pageCount: 3,
      progress: number % 41 === 0
        ? { currentPage: 1, totalPages: 3, percent: 66.67, updatedAt: '2026-01-02T00:00:00.000Z' }
        : { currentPage: 0, totalPages: 3, percent: 0, updatedAt: null },
      sourceId: 'fixture:synthetic-flat',
    };
  });

  let fixtureMode = true;
  let fixtureRevision = 0;
  let scanState = { isScanning: false, found: FIXTURE_COUNT, total: FIXTURE_COUNT };
  let acceptanceTimers = [];
  let electronReads = 0;
  const originalScanDir = (() => {
    try { return localStorage.getItem('gai:scanDir'); } catch (_) { return null; }
  })();
  const eventStats = {
    scanTrue: 0,
    scanFalse: 0,
    libraryChanged: 0,
  };
  const listeners = {
    libraryChanged: new Set(),
    catalogChanged: new Set(),
    scanProgress: new Set(),
  };

  function emitScanStatus(status) {
    if (status.isScanning) eventStats.scanTrue += 1;
    else eventStats.scanFalse += 1;
    for (const listener of listeners.scanProgress) listener({ ...status });
  }

  function emitLibraryChanged() {
    fixtureRevision += 1;
    const changedIndex = (fixtureRevision - 1) % fixtureComics.length;
    const changedComic = fixtureComics[changedIndex];
    fixtureComics[changedIndex] = {
      ...changedComic,
      // 真的改動回傳給 app.js 的 comic 內容，避免 skipUnchanged 以相同 signature 假通過。
      title: changedComic.title + ' · library event ' + fixtureRevision,
    };
    eventStats.libraryChanged += 1;
    for (const listener of listeners.libraryChanged) listener();
    for (const listener of listeners.catalogChanged) listener();
  }

  function clearAcceptanceTimers() {
    for (const timer of acceptanceTimers) clearTimeout(timer);
    acceptanceTimers = [];
  }

  function beginAcceptance() {
    clearAcceptanceTimers();
    scanState = { isScanning: true, found: 0, total: FIXTURE_COUNT };
    emitScanStatus(scanState);

    const schedule = (delay, callback) => {
      acceptanceTimers.push(setTimeout(callback, delay));
    };
    // 前半段故意保持掃描中，讓 app 的 refresh coalescing 路徑可被觀察。
    schedule(650, emitLibraryChanged);
    schedule(1450, emitLibraryChanged);
    schedule(2250, emitLibraryChanged);
    schedule(3000, () => {
      scanState = { isScanning: false, found: FIXTURE_COUNT, total: FIXTURE_COUNT };
      emitScanStatus(scanState);
      emitLibraryChanged();
    });
    schedule(3800, emitLibraryChanged);
    schedule(4650, emitLibraryChanged);
  }

  function stopAcceptance() {
    clearAcceptanceTimers();
    scanState = { isScanning: false, found: fixtureMode ? FIXTURE_COUNT : 0, total: fixtureMode ? FIXTURE_COUNT : 0 };
  }

  function getLibrary() {
    if (!fixtureMode) return [];
    const revisionSuffix = fixtureRevision ? ' · 驗收批次 ' + fixtureRevision : '';
    return fixtureComics.map((comic) => ({ ...comic, title: comic.title + revisionSuffix }));
  }

  function addListener(collection, listener) {
    if (typeof listener !== 'function') return () => {};
    collection.add(listener);
    return () => collection.delete(listener);
  }

  const api = {
    // 這些方法對齊 public/app.js 在瀏覽器頁面初始載入與人工操作會呼叫的介面。
    getLibrary: async () => getLibrary(),
    getConfig: async () => fixtureMode
      ? { scanDir: 'fixture://synthetic-flat-library', source: 'fixture-only' }
      : { scanDir: '', source: 'built-in-demo-only' },
    setConfig: async () => ({ success: true, fixtureOnly: true }),
    getScanStatus: async () => ({ ...scanState }),
    getFavorites: async () => [],
    setBookmarks: async () => ({ success: true, fixtureOnly: true }),
    openComic: async (id) => {
      const comic = fixtureComics.find((item) => item.id === String(id));
      return {
        ...(comic || fixtureComics[0]),
        pages: [
          'assets/demo/moonlit-archive/page-01.jpg',
          'assets/demo/moonlit-archive/page-02.jpg',
        ],
        isDir: false,
        filenames: [],
      };
    },
    saveProgress: async () => ({ success: true, fixtureOnly: true }),
    toggleFavorite: async () => [],
    closeComic: async () => ({ success: true, fixtureOnly: true }),
    scanLibrary: async () => {
      scanState = { isScanning: false, found: fixtureMode ? FIXTURE_COUNT : 0, total: fixtureMode ? FIXTURE_COUNT : 0 };
      return { success: true, fixtureOnly: true };
    },
    onLibraryChanged: (listener) => addListener(listeners.libraryChanged, listener),
    onCatalogChanged: (listener) => addListener(listeners.catalogChanged, listener),
    onScanProgress: (listener) => addListener(listeners.scanProgress, listener),
  };

  // app.js 需要 isElectron=true 才會接上原本的 scan/library event listener；
  // 但 getCoverUrl() 必須走瀏覽器 fallback。只讓 bindEvents 的一次初始化檢查讀到 true。
  Object.defineProperty(api, 'isElectron', {
    enumerable: true,
    get() { return electronReads++ === 0; },
  });

  window.electronAPI = api;
  window.__gaiFixture = {
    count: FIXTURE_COUNT,
    acceptanceMs: ACCEPTANCE_MS,
    eventStats,
    beginAcceptance,
    stopAcceptance,
    get mode() { return fixtureMode ? 'fixture' : 'built-in-demo'; },
    toggleMode() {
      stopAcceptance();
      fixtureMode = !fixtureMode;
      fixtureRevision = 0;
      try {
        if (fixtureMode) {
          if (originalScanDir !== null) localStorage.setItem('gai:scanDir', originalScanDir);
        } else {
          localStorage.removeItem('gai:scanDir');
        }
      } catch (_) {}
      return fixtureMode ? 'fixture' : 'built-in-demo';
    },
    refresh() {
      document.getElementById('refresh-btn')?.click();
    },
  };

  function percentile(values, ratio) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  }

  function installOverlay() {
    if (document.getElementById('gai-fixture-overlay')) return;

    const style = document.createElement('style');
    style.textContent = [
      '#gai-fixture-overlay{position:fixed;top:12px;right:12px;width:min(370px,calc(100vw - 24px));z-index:2147483647;padding:14px 16px;color:#f5eee4;background:rgba(20,18,16,.96);border:1px solid rgba(229,122,94,.7);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;text-align:left}',
      '#gai-fixture-overlay strong{display:block;color:#ffd5bf;font-size:14px;margin-bottom:4px}',
      '#gai-fixture-overlay .gai-fixture-badge{display:inline-block;margin:0 0 8px;padding:2px 7px;color:#21130f;background:#ffc7ae;border-radius:999px;font-size:11px;font-weight:700}',
      '#gai-fixture-overlay .gai-fixture-copy{margin:0 0 10px;color:#dfd5ca}',
      '#gai-fixture-overlay .gai-fixture-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '#gai-fixture-overlay button{border:1px solid rgba(255,213,191,.7);border-radius:6px;padding:7px 10px;color:#fff7f1;background:#8e3c2f;font:inherit;font-weight:700;cursor:pointer}',
      '#gai-fixture-overlay button:hover{background:#b4513e}',
      '#gai-fixture-overlay button:disabled{opacity:.6;cursor:wait}',
      '#gai-fixture-overlay .gai-fixture-result{margin:10px 0 0;padding:9px;white-space:pre-wrap;color:#f5eee4;background:rgba(255,255,255,.06);border-radius:6px;min-height:34px}',
    ].join('');
    document.head.appendChild(style);

    const overlay = document.createElement('aside');
    overlay.id = 'gai-fixture-overlay';
    overlay.setAttribute('aria-label', 'fixture 效能驗收');
    overlay.innerHTML = [
      '<span class="gai-fixture-badge">fixture非實機</span>',
      '<strong>書架捲動效能預覽</strong>',
      '<p class="gai-fixture-copy">程式內 synthetic 5000 本平面漫畫；不讀取 config、正式 DB 或 NAS。</p>',
      '<div class="gai-fixture-actions">',
      '<button type="button" id="gai-run-acceptance">執行捲動驗收</button>',
      '<button type="button" id="gai-toggle-demo">開關示範驗收</button>',
      '</div>',
      '<div class="gai-fixture-result" id="gai-fixture-result" aria-live="polite">等待驗收；可切換至原 app 內建 demo 供人工操作。</div>',
    ].join('');
    document.body.appendChild(overlay);

    const runButton = document.getElementById('gai-run-acceptance');
    const toggleButton = document.getElementById('gai-toggle-demo');
    const result = document.getElementById('gai-fixture-result');
    let running = false;
    let rafId = 0;
    let mutationObserver = null;
    let longTaskObserver = null;
    let acceptanceStartedAt = 0;
    let framePrevious = 0;
    let frameSamples = [];
    let longTasks = [];
    let gridChildListMutations = 0;
    let gridReplacementNodes = 0;
    let startedStats = { ...eventStats };

    function setModeText(mode) {
      result.textContent = mode === 'fixture'
        ? '已開啟 fixture 5000 筆資料；按「執行捲動驗收」開始。'
        : '已切回原 app 內建 demo，可人工操作。fixture 驗收目前關閉。';
    }

    function finishAcceptance() {
      running = false;
      fixture.stopAcceptance();
      if (mutationObserver) mutationObserver.disconnect();
      if (longTaskObserver) longTaskObserver.disconnect();
      mutationObserver = null;
      longTaskObserver = null;
      runButton.disabled = false;

      const scanTrue = eventStats.scanTrue - startedStats.scanTrue;
      const scanFalse = eventStats.scanFalse - startedStats.scanFalse;
      const libraryChanged = eventStats.libraryChanged - startedStats.libraryChanged;
      const p95 = percentile(frameSamples, 0.95);
      const max = frameSamples.length ? Math.max(...frameSamples) : 0;
      const passed = scanTrue > 0 && scanFalse > 0 && libraryChanged >= 3
        && gridChildListMutations > 0 && p95 <= 34 && max <= 100;
      const content = document.querySelector('.content-area');
      if (content) content.scrollTop = 0;

      result.textContent = [
        '結果：' + (passed ? 'PASS（捲動幀時間門檻）' : 'FAIL（事件、重繪或幀時間未達門檻）'),
        'fixture非實機（synthetic data，未讀取正式 DB／NAS）',
        '資料：' + FIXTURE_COUNT + ' 本，同一平面目錄；目前 renderer 顯示上限 200 cards',
        '捲動：content-area 上下約 5 秒；requestAnimationFrame 採樣 ' + frameSamples.length + ' 次',
        '掃描事件：isScanning=true ' + scanTrue + ' 次；library-changed ' + libraryChanged + ' 次；isScanning=false ' + scanFalse + ' 次',
        'DOM：comic-grid childList 替換 ' + gridChildListMutations + ' 次；節點變動 ' + gridReplacementNodes + ' 個節點',
        'Long Task：' + (longTasks.length ? longTasks.length + ' 次，最長 ' + Math.round(Math.max(...longTasks)) + ' ms' : '未觀察到（瀏覽器未提供或本次沒有）'),
        'Frame：p95 ' + p95.toFixed(1) + ' ms；max ' + max.toFixed(1) + ' ms',
      ].join('\n');
    }

    function sampleFrame(now) {
      if (!running) return;
      if (!acceptanceStartedAt) acceptanceStartedAt = now;
      if (framePrevious) frameSamples.push(Math.max(0, now - framePrevious));
      framePrevious = now;

      const elapsed = now - acceptanceStartedAt;
      const content = document.querySelector('.content-area');
      if (content) {
        const maxScroll = Math.max(0, content.scrollHeight - content.clientHeight);
        const progress = Math.min(1, elapsed / ACCEPTANCE_MS);
        const wave = progress < 0.5 ? progress * 2 : 2 - progress * 2;
        content.scrollTop = maxScroll * wave;
      }

      if (elapsed >= ACCEPTANCE_MS) {
        cancelAnimationFrame(rafId);
        rafId = 0;
        setTimeout(finishAcceptance, 350);
        return;
      }
      rafId = requestAnimationFrame(sampleFrame);
    }

    function runAcceptance() {
      if (running || fixture.mode !== 'fixture') {
        if (fixture.mode !== 'fixture') setModeText(fixture.mode);
        return;
      }
      const grid = document.getElementById('comic-grid');
      const content = document.querySelector('.content-area');
      if (!grid || !content) {
        result.textContent = '找不到 comic-grid 或 content-area，無法驗收。';
        return;
      }

      running = true;
      runButton.disabled = true;
      startedStats = { ...eventStats };
      frameSamples = [];
      longTasks = [];
      gridChildListMutations = 0;
      gridReplacementNodes = 0;
      acceptanceStartedAt = 0;
      framePrevious = 0;
      result.textContent = '驗收執行中：正在上下捲動 content-area，請稍候約 5 秒…';

      mutationObserver = new MutationObserver((records) => {
        if (!running) return;
        for (const record of records) {
          if (record.type !== 'childList') continue;
          gridChildListMutations += 1;
          gridReplacementNodes += record.addedNodes.length + record.removedNodes.length;
        }
      });
      mutationObserver.observe(grid, { childList: true });

      if (window.PerformanceObserver) {
        try {
          const supported = PerformanceObserver.supportedEntryTypes || [];
          if (supported.includes('longtask')) {
            longTaskObserver = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) longTasks.push(entry.duration);
            });
            longTaskObserver.observe({ type: 'longtask', buffered: false });
          }
        } catch (_) {
          longTaskObserver = null;
        }
      }

      fixture.beginAcceptance();
      rafId = requestAnimationFrame(sampleFrame);
    }

    runButton.addEventListener('click', runAcceptance);
    toggleButton.addEventListener('click', () => {
      if (running) {
        if (rafId) cancelAnimationFrame(rafId);
        finishAcceptance();
      }
      const mode = fixture.toggleMode();
      setModeText(mode);
      fixture.refresh();
    });
  }

  const fixture = window.__gaiFixture;
  const waitForDom = () => {
    if (document.body && document.getElementById('comic-grid')) installOverlay();
    else setTimeout(waitForDom, 100);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(waitForDom, 250), { once: true });
  else setTimeout(waitForDom, 250);
})();
</script>
`;

function injectFixtureIntoIndex(source) {
  const marker = '<script src="app.js"></script>';
  if (!source.includes(marker)) {
    throw new Error('public/index.html 缺少 app.js script marker，拒絕啟動 fixture server。');
  }
  return source.replace(marker, FIXTURE_BOOTSTRAP + '\n  ' + marker);
}

function decodePathname(pathname) {
  try {
    const decoded = decodeURIComponent(pathname);
    if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

function resolvePublicAsset(pathname) {
  const decoded = decodePathname(pathname);
  if (decoded === null || decoded.split('/').some((part) => part === '..')) return null;
  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  const target = path.resolve(PUBLIC_ROOT, relative);
  if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + path.sep)) return null;
  return target;
}

async function readPublicAsset(pathname) {
  const target = resolvePublicAsset(pathname);
  if (!target) return { status: 403, body: 'Forbidden\n', contentType: 'text/plain; charset=utf-8' };

  let realPath;
  try {
    realPath = await fs.promises.realpath(target);
    const realRoot = await fs.promises.realpath(PUBLIC_ROOT);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
      return { status: 403, body: 'Forbidden\n', contentType: 'text/plain; charset=utf-8' };
    }
    const stat = await fs.promises.stat(realPath);
    if (!stat.isFile()) return { status: 404, body: 'Not found\n', contentType: 'text/plain; charset=utf-8' };
    const body = await fs.promises.readFile(realPath);
    return {
      status: 200,
      body,
      contentType: MIME_TYPES.get(path.extname(realPath).toLowerCase()) || 'application/octet-stream',
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { status: 404, body: 'Not found\n', contentType: 'text/plain; charset=utf-8' };
    }
    return { status: 500, body: 'Fixture asset read failed\n', contentType: 'text/plain; charset=utf-8' };
  }
}

function send(response, request, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    ...extraHeaders,
  });
  if (request.method === 'HEAD') response.end();
  else response.end(body);
}

function getCoverId(requestUrl) {
  if (requestUrl.pathname === '/api/cover') return requestUrl.searchParams.get('id');
  if (requestUrl.pathname.startsWith('/api/cover/')) {
    const encodedId = requestUrl.pathname.slice('/api/cover/'.length);
    try { return decodeURIComponent(encodedId); } catch (_) { return null; }
  }
  return null;
}

async function serveCover(request, response, requestUrl) {
  const id = getCoverId(requestUrl);
  if (!id || !/^fixture-\d{5}$/.test(id)) {
    send(response, request, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'fixture cover id required' }));
    return;
  }

  const number = Number(id.slice(-5));
  const delay = 12 + (number % 5) * 18;
  const missing = number % 17 === 0 || number % 43 === 0;
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (missing) {
    send(response, request, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'synthetic cover miss', id }));
    return;
  }

  const asset = await readPublicAsset(DEMO_COVER_URL);
  send(response, request, asset.status, asset.contentType, asset.body, { 'X-Fixture-Cover': 'demo-cover' });
}

const indexSource = await fs.promises.readFile(INDEX_PATH, 'utf8');
const injectedIndex = Buffer.from(injectFixtureIntoIndex(indexSource), 'utf8');

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, request, 405, 'text/plain; charset=utf-8', 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  } catch (_) {
    send(response, request, 400, 'text/plain; charset=utf-8', 'Bad Request\n');
    return;
  }

  if (requestUrl.pathname === '/api/cover' || requestUrl.pathname.startsWith('/api/cover/')) {
    await serveCover(request, response, requestUrl);
    return;
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
    send(response, request, 200, 'text/html; charset=utf-8', injectedIndex);
    return;
  }

  const asset = await readPublicAsset(requestUrl.pathname);
  send(response, request, asset.status, asset.contentType, asset.body);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`fixture server 無法啟動：${HOST}:${PORT} 已被使用。請關閉該測試 server 後再重試。`);
  } else {
    console.error('fixture server error:', error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`G.A.I perf fixture 已啟動：http://${HOST}:${PORT}/`);
  console.log('資料來源：程式內 synthetic 5000 筆平面漫畫；未讀取 config、正式 DB、NAS。');
  console.log('按頁面 overlay 的「執行捲動驗收」開始約 5 秒驗收；「開關示範驗收」可切回原 app demo。');
  console.log('停止：Ctrl-C');
});

function shutdown(signal) {
  server.close(() => {
    console.log(`\nfixture server 已停止（${signal}）。`);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
