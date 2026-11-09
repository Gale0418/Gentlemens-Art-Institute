import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(signature, `missing ${name}`);
  let paramsDepth = 1;
  let paramsEnd = signature.index + signature[0].length;
  while (paramsEnd < source.length && paramsDepth > 0) {
    if (source[paramsEnd] === '(') paramsDepth += 1;
    if (source[paramsEnd] === ')') paramsDepth -= 1;
    paramsEnd += 1;
  }
  const bodyStart = source.indexOf('{', paramsEnd);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(signature.index, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

class FakeElement {
  constructor(tagName = 'div', text = '') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textContent = text;
    this.hidden = false;
    this.disabled = false;
    this.parentElement = null;
  }
  get lastElementChild() { return this.children.at(-1) || null; }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    const found = [];
    const visit = node => {
      if (className && String(node.className).split(/\s+/).includes(className)) found.push(node);
      node.children.forEach(visit);
    };
    this.children.forEach(visit);
    return found;
  }
}

function historyHarness(api, { removeReturnGuard = false } = {}) {
  const closeReaderSource = extractFunction(app, 'closeReader');
  const closeReaderForTest = removeReturnGuard
    ? closeReaderSource.replace(
      'if (!switchingComic && returnToHistory && state.readingHistoryVisible)',
      'if (!switchingComic && returnToHistory)',
    )
    : closeReaderSource;
  if (removeReturnGuard) assert.notEqual(closeReaderForTest, closeReaderSource, 'negative control removes only the visibility guard');
  const context = {
    console,
    clearTimeout,
    setTimeout,
    atob,
    TextDecoder,
    Uint8Array,
    removeScheduledCover() {},
    document: {
      fullscreenElement: null,
      body: { style: {} },
      createElement: tag => new FakeElement(tag),
      createTextNode: text => new FakeElement('#text', text),
    },
    window: {},
    elements: {},
    state: {},
    readerText: text => text,
    renderReadingHistory() {},
    getComicSourceId: comic => comic?.sourceId || '',
    isBuiltInDemoComic: comic => comic?.id === 'demo',
    readerImageIsReady: image => Boolean(image?.complete && image?.naturalWidth > 0),
    ensureCoverObserver: () => ({ observe() {} }),
    escapeHtml: value => String(value ?? ''),
    getProgressInfo: () => ({ currentPage: 0, totalPages: 0 }),
    isComicOffline: comic => Boolean(comic?.offline),
    getCoverUrl: () => 'cover:test',
    saveReadingProgress() {},
    filterAndRenderGrid() {},
    refreshCatalogSearch() {},
    ...api,
  };
  context.testAPI = api.eAPI;
  vm.createContext(context);
  vm.runInContext(`
    const READING_HISTORY_PAGE_SIZE = 40;
    const READING_HISTORY_RECORD_RETRY_DELAYS_MS = [300, 900];
    let readingHistoryRequestGeneration = 0;
    let readingHistoryRefreshGeneration = 0;
    let readingHistoryLivePendingPaths = new Map();
    let readingHistoryRefreshInFlight = false;
    let readingHistoryRefreshActiveGeneration = 0;
    let readingHistoryRecordGeneration = 0;
    let readingHistoryRecordInFlight = null;
    let readingHistoryRecordRetryTimer = null;
    let readingHistoryRecordAttempts = 0;
    let catalogSearchTimer = null;
    let catalogSearchAppendInFlight = null;
    const eAPI = testAPI;
    ${extractFunction(app, 'startReaderHistoryRecordingSession')}
    ${extractFunction(app, 'endReaderHistoryRecordingSession')}
    ${extractFunction(app, 'recordCurrentComicHistoryOnce')}
    ${extractFunction(app, 'markReaderPageReady')}
    ${extractFunction(app, 'openReadingHistory')}
    ${extractFunction(app, 'closeReadingHistory')}
    ${extractFunction(app, 'setReadingHistoryPeriod')}
    ${extractFunction(app, 'readingHistoryTime')}
    ${extractFunction(app, 'readingHistoryGroupLabel')}
    ${extractFunction(app, 'readingHistoryDateKey')}
    ${extractFunction(app, 'renderReadingHistory')}
    ${extractFunction(app, 'renderReadingHistoryStatus')}
    ${extractFunction(app, 'loadReadingHistory')}
    ${extractFunction(app, 'refreshReadingHistoryAfterReader')}
    ${extractFunction(app, 'currentIOSDocumentsSource')}
    ${extractFunction(app, 'queueReadingHistoryRefreshForLibraryBatch')}
    ${extractFunction(app, 'drainReadingHistoryLiveRefresh')}
    ${extractFunction(app, 'handleSearch')}
    ${extractFunction(app, 'navigateLibraryToPath')}
    ${extractFunction(app, 'openReader')}
    ${closeReaderForTest}
    globalThis.run = { startReaderHistoryRecordingSession, endReaderHistoryRecordingSession, recordCurrentComicHistoryOnce, markReaderPageReady, openReadingHistory, closeReadingHistory, setReadingHistoryPeriod, renderReadingHistory, renderReadingHistoryStatus, loadReadingHistory, refreshReadingHistoryAfterReader, currentIOSDocumentsSource, queueReadingHistoryRefreshForLibraryBatch, drainReadingHistoryLiveRefresh, handleSearch, navigateLibraryToPath, openReader, closeReader };
  `, context);
  return context;
}

function liveDocumentsSource(uuid = 'A1234567-B123-4234-9234-A123456789AB') {
  const root = `/private/var/mobile/Containers/Data/Application/${uuid}/Documents`;
  return `local:${Buffer.from(root).toString('base64url')}`;
}

function liveRefreshHarness(getReadingHistory) {
  const context = historyHarness({
    eAPI: { getReadingHistory },
    isComicOffline: comic => Boolean(comic?.offline),
    getComicSourceId: comic => comic?.sourceId || '',
  });
  context.state = {
    readingHistoryVisible: true,
    readingHistoryPeriod: 'month',
    readingHistoryItems: [],
    readingHistoryOffset: 0,
    readingHistoryLoadedCount: 40,
    readingHistoryTotal: 0,
    readingHistoryLoading: false,
    readingHistoryError: '',
    readingHistoryReturnComicId: '',
    readingHistoryReturnSourceId: '',
    readingHistoryScrollTop: 67,
    readingHistoryReturnToReader: false,
    comics: [],
  };
  context.elements = { contentArea: { scrollTop: 67 }, readingHistoryList: new FakeElement('div') };
  return context;
}

// A live refresh retains the previous multi-page target, scroll, and return
// focus while reconstructing the same loaded window from native pages.
{
  const requests = [];
  const context = liveRefreshHarness(async args => {
    requests.push(args);
    return {
      items: Array.from({ length: 40 }, (_, index) => ({
        openedAt: '2026-11-09T10:00:00Z', comic: { id: `book-${args.offset + index}`, sourceId: 'source', offline: false },
      })),
      total: 80,
    };
  });
  vm.runInContext('renderReadingHistory = () => {}; renderReadingHistoryStatus = () => {};', context);
  context.state.readingHistoryLoadedCount = 80;
  context.state.readingHistoryOffset = 80;
  context.state.readingHistoryTotal = 80;
  context.state.readingHistoryReturnComicId = 'return-book';
  context.state.readingHistoryReturnSourceId = 'source';
  let focusCalls = 0;
  context.elements.readingHistoryList = {
    querySelectorAll: selector => selector === '.reading-history-row'
      ? [{ dataset: { historyComicId: 'return-book', historySourceId: 'source' }, focus() { focusCalls += 1; } }]
      : [],
  };
  await context.run.refreshReadingHistoryAfterReader();
  assert.deepEqual(requests.map(request => request.offset), [0, 40], 'refresh reloads all previously loaded pages');
  assert.equal(context.state.readingHistoryLoadedCount, 80);
  assert.equal(context.state.readingHistoryOffset, 80);
  assert.equal(context.elements.contentArea.scrollTop, 67);
  assert.equal(focusCalls, 1, 'refresh returns focus to the same history row');
}

// A current iOS Documents discovery batch hydrates only the exact offline
// history source/path, then a second batch during the refresh is coalesced.
{
  let finishFirst;
  const requests = [];
  const context = liveRefreshHarness(args => {
    requests.push(args);
    return new Promise(resolve => { finishFirst = resolve; });
  });
  const sourceId = liveDocumentsSource();
  const offlineA = { id: 'A', sourceId, relativePath: 'series/A.cbz', offline: true };
  context.state.readingHistoryItems = [{ comic: offlineA, openedAt: '2026-11-09T10:00:00Z' }];
  context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'A', sourceId, relativePath: 'series/A.cbz' }]);
  assert.equal(requests.length, 1, 'exact offline own-Documents row starts one refresh');
  context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'B', sourceId, relativePath: 'series/B.cbz' }]);
  context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'A', sourceId, relativePath: 'series/A.cbz' }]);
  assert.equal(requests.length, 1, 'batches coalesce while the multi-page refresh is active');
  finishFirst({ items: [
    { comic: { ...offlineA, offline: false }, openedAt: '2026-11-09T10:00:00Z' },
    { comic: { id: 'B', sourceId, relativePath: 'series/B.cbz', offline: true }, openedAt: '2026-11-09T09:00:00Z' },
  ], total: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2, 'one pending matching path gets one follow-up refresh');
  assert.equal(context.state.readingHistoryItems[0].comic.offline, false, 'follow-up enables the newly live history row');
  assert.equal(context.elements.contentArea.scrollTop, 67, 'refresh preserves history scroll position');
  assert.equal(context.state.readingHistoryLoadedCount, 40, 'refresh preserves loaded-count paging contract');
  finishFirst({ items: [
    { comic: { ...offlineA, offline: false }, openedAt: '2026-11-09T10:00:00Z' },
    { comic: { id: 'B', sourceId, relativePath: 'series/B.cbz', offline: false }, openedAt: '2026-11-09T09:00:00Z' },
  ], total: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2, 'online rows are not refreshed again');
}

// A first request can be in flight before it has returned any history rows.
// Keep its discovery intent until those rows arrive, then issue one follow-up.
{
  let resolveInitial;
  let calls = 0;
  const sourceId = liveDocumentsSource();
  const historyComic = { id: 'first', sourceId, relativePath: 'one.cbz', offline: true };
  const context = liveRefreshHarness(() => {
    calls += 1;
    if (calls === 1) return new Promise(resolve => { resolveInitial = resolve; });
    return Promise.resolve({ items: [{ comic: { ...historyComic, offline: false } }], total: 1 });
  });
  const initialLoad = context.run.loadReadingHistory({ reset: true });
  context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'first', sourceId, relativePath: 'one.cbz' }]);
  assert.equal(calls, 1, 'discovery waits while the first empty-items request is pending');
  resolveInitial({ items: [{ comic: historyComic }], total: 1 });
  await initialLoad;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'completed first request is compared with pending discovery paths');
  assert.equal(context.state.readingHistoryItems[0].comic.offline, false);
}

// The path must be the same current local Documents source. Similar paths from
// SMB, NAS, Files bookmarks, or another local folder are inert.
{
  let calls = 0;
  const context = liveRefreshHarness(async () => { calls += 1; return { items: [], total: 0 }; });
  const sourceId = liveDocumentsSource();
  for (const comic of [
    { sourceId: 'smb:server', relativePath: 'same.cbz' },
    { sourceId: 'external:bookmark', relativePath: 'same.cbz' },
    { sourceId: 'local:library', relativePath: 'same.cbz' },
  ]) {
    context.state.readingHistoryItems = [{ comic: { ...comic, offline: true } }];
    context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'same', ...comic }]);
  }
  assert.equal(calls, 0, 'foreign source IDs and UUIDs never refresh a same-path row');
  context.state.readingHistoryItems = [{ comic: { id: 'same', sourceId, relativePath: 'same.cbz', offline: false } }];
  context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'same', sourceId, relativePath: 'same.cbz' }]);
  assert.equal(calls, 0, 'already online rows do not refresh');
}

// Hidden history or an active reader must not retain discovery intent that can
// reopen or steal focus from the user's current screen.
{
  let calls = 0;
  const context = liveRefreshHarness(async () => { calls += 1; return { items: [], total: 0 }; });
  const sourceId = liveDocumentsSource();
  context.state.readingHistoryItems = [{ comic: { id: 'A', sourceId, relativePath: 'A.cbz', offline: true } }];
  context.state.readingHistoryVisible = false;
  context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'A', sourceId, relativePath: 'A.cbz' }]);
  context.state.readingHistoryVisible = true;
  context.run.drainReadingHistoryLiveRefresh();
  assert.equal(calls, 0, 'leaving history discards later refresh eligibility');
  context.state.currentComic = { id: 'reader' };
  context.run.queueReadingHistoryRefreshForLibraryBatch([{ id: 'A', sourceId, relativePath: 'A.cbz' }]);
  context.state.currentComic = null;
  context.run.drainReadingHistoryLiveRefresh();
  assert.equal(calls, 0, 'reader-covered history does not schedule or resurrect a page');
}

async function runNativeCloseHistoryRace({ removeReturnGuard = false } = {}) {
  let releaseFlush;
  let releaseNativeClose;
  let noteFlushStarted;
  let noteNativeCloseStarted;
  const flushHold = new Promise(resolve => { releaseFlush = resolve; });
  const nativeCloseHold = new Promise(resolve => { releaseNativeClose = resolve; });
  const flushStarted = new Promise(resolve => { noteFlushStarted = resolve; });
  const nativeCloseStarted = new Promise(resolve => { noteNativeCloseStarted = resolve; });
  const classes = new Set(['history-visible']);
  const book = { id: 'closing-book', sourceId: 'local:library', title: 'Closing book' };
  const context = historyHarness({
    createReadingProgressSnapshot: () => null,
    enqueueReadingProgressSnapshot: () => Promise.resolve(),
    cancelCatalogResize() {},
    cancelCatalogVirtualRender() {},
    resetCatalogThumbnailLoader() {},
    cancelWebtoonAnchor() {},
    getComicSourceId: comic => comic?.sourceId || '',
    captureLibraryFocus: () => null,
    setAutoPageExplanation() {},
    setAiPagePanelVisible() {},
    releasePreloadedImages() {},
    hideReaderContextMenu() {},
    clearReaderPageNotice() {},
    dismissReaderDiscoveryHint() {},
    flushReadingProgressBeforeClose: () => {
      noteFlushStarted();
      return flushHold;
    },
    scheduleCoverLoadDrain() {},
    restoreReaderFocus() {},
    scheduleLibraryRefresh() {},
    resumeCatalogAppendRenderIfReady() {},
    isBuiltInDemoComic: () => false,
    eAPI: {},
  }, { removeReturnGuard });
  context.window.electronAPI = {
    closeComic: () => {
      noteNativeCloseStarted();
      return nativeCloseHold;
    },
  };
  context.state = {
    currentComic: book, currentComicPages: [{}], currentPageIndex: 0,
    pendingComicId: null, pendingComicSourceId: '', readingMode: 'single',
    webtoonScrollFrame: null, progressSaveTimer: null, readerOperation: 1, renderGeneration: 1,
    readerReturnComicFolder: null, readerReturnLibraryContext: null, readerReturnFocus: null,
    readerReadyPages: new Set(), readerFailedPages: new Set(), readerLastReadyPageIndex: 0,
    readerReadyComicId: book.id, readerReadyComicSourceId: book.sourceId, readerLoadTrackingActive: true,
    readerOpenRequestToken: 'history-token', readingHistoryReturnToReader: true,
    readingHistoryVisible: true, readingHistoryScrollTop: 48, readingHistoryLibraryScrollTop: 0,
    webtoonMeasuredPageHeights: new Map(), webtoonMetricsComicId: null, webtoonMetricsComicSourceId: '',
    aiExplainTimer: null, aiExplainPendingPage: null, aiExplainPendingRequest: null,
    readerClosePromise: Promise.resolve(), libraryRefreshFocusSnapshot: null,
  };
  context.elements = {
    readingHistoryPage: { hidden: false, querySelectorAll: () => [] },
    readingHistoryEntry: { focus() {} },
    readingHistoryList: null, readingHistoryStatus: null, readingHistoryMore: null,
    statusLoading: null,
    pagesContainer: { replaceChildren() {} },
    readerOverlay: { style: {}, setAttribute() {}, classList: { remove() {} } },
    contentArea: { scrollTop: 0, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    mainLayout: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    btnAiExplain: null, btnAiAutoExplain: null,
  };

  const closing = context.run.closeReader();
  await flushStarted;
  releaseFlush();
  await nativeCloseStarted;
  assert.equal(context.state.readingHistoryVisible, true, 'history is still visible while native close is held');
  context.run.closeReadingHistory();
  assert.equal(context.elements.readingHistoryPage.hidden, true, 'user can close history during native close');
  releaseNativeClose();
  await closing;
  return { context, classes };
}

// A successful decoded page records one opening; failures and repeated load
// callbacks never create additional history writes.
{
  const calls = [];
  const context = historyHarness({
    eAPI: { recordReadingHistory: payload => { calls.push(payload); return Promise.resolve(); } },
  });
  context.state = {
    renderGeneration: 4,
    currentComic: { id: 'book-1', sourceId: 'local:library' },
    currentPageIndex: 2,
    readerOpenRequestToken: 'session-1',
    readerHistoryRecorded: false,
    readerReadyPages: new Set(),
    readerFailedPages: new Set(),
  };
  context.run.markReaderPageReady(2, { complete: true, naturalWidth: 100 }, 4);
  context.run.markReaderPageReady(2, { complete: true, naturalWidth: 100 }, 4);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(JSON.stringify(calls), JSON.stringify([
    { id: 'book-1', sourceId: 'local:library', requestToken: 'session-1' },
  ]));
  assert.equal(calls.length, 1, 'repeated first-ready decode cannot submit duplicate history writes');

  const failedContext = historyHarness({
    eAPI: { recordReadingHistory: () => { throw new Error('must not record'); } },
  });
  failedContext.state = { ...context.state, readerHistoryRecorded: false, readerReadyPages: new Set(), readerFailedPages: new Set() };
  assert.equal(failedContext.run.markReaderPageReady(1, { complete: true, naturalWidth: 0 }, 4), false);
  assert.equal(failedContext.state.readerHistoryRecorded, false);
}

// A stale failed write cannot schedule retries or mutate a new reader session;
// closing a current session releases its pending retry timer.
{
  let rejectOld;
  const timers = [];
  const context = historyHarness({
    setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    eAPI: { recordReadingHistory: () => new Promise((resolve, reject) => { rejectOld = reject; }) },
  });
  context.state = { currentComic: { id: 'old-book', sourceId: 'local:library' }, readerHistoryRecorded: false };
  context.run.startReaderHistoryRecordingSession('old-token');
  context.run.recordCurrentComicHistoryOnce();
  await Promise.resolve();
  context.run.startReaderHistoryRecordingSession('new-token');
  context.state.currentComic = { id: 'new-book', sourceId: 'local:library' };
  context.state.readerHistoryRecorded = true;
  rejectOld(new Error('old session failed'));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(context.state.readerHistoryRecorded, true, 'old rejection cannot reset new session success state');
  assert.equal(timers.length, 0, 'old rejection cannot schedule a retry for the new session');

  context.run.startReaderHistoryRecordingSession('close-token');
  context.run.recordCurrentComicHistoryOnce();
  await Promise.resolve();
  rejectOld(new Error('close session failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 1);
  context.run.endReaderHistoryRecordingSession();
  assert.equal(timers[0].cleared, true, 'closing the reader cancels its retry timer');
}

// A rejected history write remains unrecorded and can recover on a later
// decoded-page signal after a bounded retry.
{
  const calls = [];
  const timers = [];
  const context = historyHarness({
    setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    eAPI: {
      recordReadingHistory: payload => {
        calls.push(payload);
        return calls.length === 1 ? Promise.reject(new Error('temporary bridge failure')) : Promise.resolve(true);
      },
    },
  });
  context.state = {
    currentComic: { id: 'retry-book', sourceId: 'local:library' },
    readerOpenRequestToken: 'retry-session', readerHistoryRecorded: false,
  };
  context.run.recordCurrentComicHistoryOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.state.readerHistoryRecorded, false, 'failed write does not claim the session is recorded');
  assert.equal(calls.length, 1);
  assert.equal(timers.length, 1, 'first rejection schedules a bounded retry');
  timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(context.state.readerHistoryRecorded, true, 'successful retry records the session');
}

// The history page's actual hidden property follows entry and back navigation.
{
  const context = historyHarness({ eAPI: {} });
  const focus = { focus() {} };
  const classes = new Set();
  context.state = {
    readingHistoryScrollTop: 18,
    readingHistoryLibraryScrollTop: 0,
    readingHistoryVisible: false,
    readingHistoryItems: [{ id: 'already-loaded' }],
    readingHistoryLoading: false,
  };
  context.elements = {
    readingHistoryPage: { hidden: true, querySelectorAll: () => [] },
    readingHistoryTitle: focus,
    readingHistoryEntry: focus,
    contentArea: {
      scrollTop: 61,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    },
  };
  context.run.openReadingHistory();
  assert.equal(context.elements.readingHistoryPage.hidden, false, 'open makes the initially hidden history page visible');
  assert.equal(context.state.readingHistoryVisible, true);
  assert.equal(context.elements.contentArea.scrollTop, 18, 'history restores its own scroll position');
  context.run.closeReadingHistory();
  assert.equal(context.elements.readingHistoryPage.hidden, true, 'back hides the history page');
  assert.equal(context.state.readingHistoryVisible, false);
  assert.equal(context.elements.contentArea.scrollTop, 61, 'back restores the shelf scroll position');
  assert.equal(classes.has('history-visible'), false);
}

// Reopening after a cached view always queries native again; an older query
// resolving afterward cannot replace the newer rows.
{
  const pending = [];
  const context = historyHarness({
    eAPI: { getReadingHistory: args => new Promise(resolve => pending.push({ args, resolve })) },
  });
  const classes = new Set();
  context.state = {
    readingHistoryPeriod: 'month', readingHistoryScrollTop: 88,
    readingHistoryLibraryScrollTop: 0, readingHistoryVisible: false,
    readingHistoryItems: Array(80).fill({ id: 'cached-A' }), readingHistoryOffset: 80,
    readingHistoryLoadedCount: 80,
    readingHistoryTotal: 80, readingHistoryLoading: false, readingHistoryError: '',
    readingHistoryReturnComicId: '', readingHistoryReturnSourceId: '',
  };
  context.elements = {
    readingHistoryPage: { hidden: true, querySelectorAll: () => [] },
    readingHistoryTitle: { focus() {} }, readingHistoryEntry: { focus() {} },
    contentArea: { scrollTop: 12, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    readingHistoryList: null, readingHistoryStatus: null, readingHistoryMore: null,
  };
  const firstOpen = context.run.openReadingHistory({ focus: false });
  assert.equal(pending.length, 1);
  context.run.closeReadingHistory();
  const secondOpen = context.run.openReadingHistory({ focus: false });
  assert.equal(pending.length, 2, 'reopen refreshes even when cached rows exist');
  const nativePage = offset => Array.from({ length: 40 }, (_, index) => ({ id: `native-B-${offset + index}` }));
  pending[1].resolve({ items: nativePage(0), total: 80 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pending.length, 3, 'reopen reloads the previously loaded second page');
  assert.equal(pending[2].args.offset, 40);
  assert.equal(context.state.readingHistoryLoadedCount, 80, 'a partial refresh retains the old loaded-page target');
  pending[2].resolve({ items: nativePage(40), total: 80 });
  await secondOpen;
  pending[0].resolve({ items: [{ id: 'native-A' }], total: 1 });
  await firstOpen;
  assert.equal(context.state.readingHistoryItems[0].id, 'native-B-0');
  assert.equal(context.state.readingHistoryItems.length, 80);
  assert.equal(context.state.readingHistoryScrollTop, 88, 'reopen preserves history scroll position');
}

// Switching ranges starts at the top so newest entries remain immediately visible.
{
  const context = historyHarness({ eAPI: { getReadingHistory: async () => ({ items: [], total: 0 }) } });
  const options = [{ setAttribute(name, value) { this[name] = value; } }, { setAttribute(name, value) { this[name] = value; } }];
  context.state = {
    readingHistoryPeriod: 'month', readingHistoryScrollTop: 240,
    readingHistoryItems: [{ id: 'older' }], readingHistoryOffset: 40,
    readingHistoryTotal: 80, readingHistoryLoading: false, readingHistoryError: '',
    readingHistoryVisible: true,
  };
  context.elements = {
    contentArea: { scrollTop: 240 },
    readingHistoryPage: { querySelectorAll: () => options },
    readingHistoryList: null, readingHistoryStatus: null, readingHistoryMore: null,
  };
  context.run.setReadingHistoryPeriod('year', options[1]);
  assert.equal(context.state.readingHistoryScrollTop, 0);
  assert.equal(context.elements.contentArea.scrollTop, 0);
  assert.equal(context.state.readingHistoryItems.length, 0, 'range change clears rows from the previous period immediately');
  assert.equal(context.state.readingHistoryTotal, 0);
  assert.equal(options[0]['aria-pressed'], 'false');
  assert.equal(options[1]['aria-pressed'], 'true');
}

// Range changes invalidate the old native response, even when it resolves last.
{
  const pending = [];
  const context = historyHarness({
    eAPI: {
      getReadingHistory: args => new Promise(resolve => pending.push({ args, resolve })),
    },
  });
  context.state = {
    readingHistoryPeriod: 'month', readingHistoryItems: [], readingHistoryOffset: 0,
    readingHistoryTotal: 0, readingHistoryLoading: false, readingHistoryError: '', readingHistoryVisible: true,
  };
  context.elements = { readingHistoryList: null, readingHistoryStatus: null, readingHistoryMore: null, contentArea: { scrollTop: 0 } };
  const monthRequest = context.run.loadReadingHistory({ reset: true });
  context.state.readingHistoryPeriod = 'year';
  const yearRequest = context.run.loadReadingHistory({ reset: true });
  pending[1].resolve({ items: [{ id: 'newer' }], total: 1 });
  await yearRequest;
  pending[0].resolve({ items: [{ id: 'stale' }], total: 1 });
  await monthRequest;
  assert.equal(context.state.readingHistoryItems[0].id, 'newer');
  assert.equal(JSON.stringify(pending.map(request => [request.args.period, request.args.offset, request.args.limit])), JSON.stringify([
    ['month', 0, 40], ['year', 0, 40],
  ]));
}

// Paging requests exactly 40 rows at the next offset and appends the result.
{
  const requests = [];
  const context = historyHarness({
    eAPI: {
      getReadingHistory: async args => {
        requests.push(args);
        return { items: Array.from({ length: 40 }, (_, index) => ({ id: `${args.offset + index}` })), total: 80 };
      },
    },
  });
  context.state = {
    readingHistoryPeriod: 'month', readingHistoryItems: [], readingHistoryOffset: 0,
    readingHistoryTotal: 0, readingHistoryLoading: false, readingHistoryError: '', readingHistoryVisible: true,
  };
  context.elements = { readingHistoryList: null, readingHistoryStatus: null, readingHistoryMore: null, contentArea: { scrollTop: 0 } };
  await context.run.loadReadingHistory({ reset: true });
  await context.run.loadReadingHistory();
  assert.deepEqual(requests.map(request => request.offset), [0, 40]);
  assert.equal(context.state.readingHistoryItems.length, 80);
}

// Same-period reset is transactional: a native rejection keeps cached rows.
{
  const cached = [{ id: 'cached', openedAt: '2026-11-09T10:00:00Z', comic: { id: 'cached', sourceId: 'local:library' } }];
  let rejectRefresh;
  const context = historyHarness({
    eAPI: { getReadingHistory: () => new Promise((resolve, reject) => { rejectRefresh = reject; }) },
  });
  context.state = {
    readingHistoryPeriod: 'month', readingHistoryItems: cached, readingHistoryOffset: 1,
    readingHistoryLoadedCount: 1, readingHistoryTotal: 1, readingHistoryLoading: false,
    readingHistoryError: '', readingHistoryVisible: true,
  };
  const list = new FakeElement('div');
  context.elements = { readingHistoryList: list, readingHistoryStatus: new FakeElement('p'), readingHistoryMore: new FakeElement('button'), contentArea: { scrollTop: 42 } };
  context.run.renderReadingHistory({ reset: true });
  const cachedRow = list.querySelector('.reading-history-row');
  const refresh = context.run.loadReadingHistory({ reset: true, preserveLoadedCount: true });
  assert.equal(list.querySelector('.reading-history-row'), cachedRow, 'loading status does not rebuild cached rows');
  rejectRefresh(new Error('temporary history outage'));
  await refresh;
  assert.equal(context.state.readingHistoryItems, cached, 'failed refresh preserves the original rows and their identity');
  assert.equal(list.querySelector('.reading-history-row'), cachedRow, 'failed refresh keeps original row DOM nodes');
  assert.equal(context.state.readingHistoryTotal, 1);
  assert.equal(context.state.readingHistoryError, '閱讀紀錄載入失敗，請重試。');
  assert.equal(context.state.readingHistoryOffset, 1);
  assert.equal(context.state.readingHistoryErrorIsReset, true, 'retry remains a refresh of the same period');
}

// Pagination preserves existing row and cover nodes, observes only appended
// covers, and merges items into the final date group when the date matches.
{
  const observed = [];
  const removed = [];
  const context = historyHarness({
    document: {
      createElement: tag => new FakeElement(tag),
      createTextNode: text => new FakeElement('#text', text),
      fullscreenElement: null, body: { style: {} },
    },
    ensureCoverObserver: () => ({ observe: element => observed.push(element) }),
    removeScheduledCover: element => removed.push(element),
    getComicSourceId: comic => comic.sourceId,
    getProgressInfo: () => ({ currentPage: 0, totalPages: 8 }),
    getCoverUrl: id => `cover:${id}`,
    isComicOffline: () => false,
  });
  const dateA = '2026-11-09T10:00:00Z';
  const dateB = '2026-11-08T10:00:00Z';
  const makeItem = (id, openedAt) => ({ openedAt, comic: { id, sourceId: 'local:library', title: id } });
  const list = new FakeElement('div');
  context.elements = { readingHistoryList: list, readingHistoryStatus: new FakeElement('p'), readingHistoryMore: new FakeElement('button') };
  context.state = {
    readingHistoryItems: [makeItem('first', dateA)], readingHistoryLoading: false,
    readingHistoryError: '', readingHistoryTotal: 3,
  };
  context.run.renderReadingHistory({ reset: true });
  const firstRow = list.querySelector('.reading-history-row');
  const firstCover = list.querySelector('.lazy-cover');
  context.run.renderReadingHistoryStatus();
  assert.equal(list.querySelector('.reading-history-row'), firstRow, 'status updates preserve row DOM identity');
  context.state.readingHistoryItems.push(makeItem('same-day', '2026-11-09T09:00:00Z'), makeItem('prior-day', dateB));
  context.run.renderReadingHistory({ appendFrom: 1 });
  assert.equal(list.querySelector('.reading-history-row'), firstRow, 'append preserves prior row DOM identity');
  assert.equal(firstRow.querySelector('.lazy-cover'), firstCover, 'append preserves prior cover identity');
  assert.equal(list.children.length, 2, 'same-day append merges into existing group and new day adds one group');
  assert.equal(list.children[0].querySelectorAll('.reading-history-row').length, 2);
  assert.equal(list.children[1].querySelectorAll('.reading-history-row').length, 1);
  assert.equal(observed.length, 3, 'only the three newly rendered covers are observed once');
  assert.equal(removed.length, 0, 'append does not cancel existing cover scheduling');
}

// A backend that reports a larger total but returns no rows cannot spin forever.
{
  let requests = 0;
  const context = historyHarness({
    eAPI: { getReadingHistory: async () => { requests += 1; return { items: [], total: 120 }; } },
  });
  context.state = {
    readingHistoryPeriod: 'month', readingHistoryItems: Array(80).fill({ id: 'old' }),
    readingHistoryOffset: 80, readingHistoryTotal: 120, readingHistoryLoading: false,
    readingHistoryError: '', readingHistoryVisible: true,
    readingHistoryReturnComicId: '', readingHistoryReturnSourceId: '', readingHistoryScrollTop: 0,
  };
  context.elements = {
    readingHistoryList: new FakeElement('div'),
    readingHistoryStatus: null,
    readingHistoryMore: { hidden: false, disabled: false, textContent: '' },
    contentArea: { scrollTop: 0 },
  };
  await context.run.refreshReadingHistoryAfterReader();
  assert.equal(requests, 1, 'no-progress response stops bounded history refresh');
  assert.equal(context.state.readingHistoryOffset, 0);
}

// Search input and folder navigation exit the history view without stealing
// focus back to the history entry button.
{
  const context = historyHarness({
    normalizeDirectoryLocation: () => { throw new Error('reached folder navigation'); },
  });
  let entryFocusCount = 0;
  const classes = new Set(['history-visible']);
  const searchInput = { value: '' };
  context.document.activeElement = searchInput;
  context.state = {
    readingHistoryVisible: true,
    readingHistoryLibraryScrollTop: 30,
    catalogSearchItems: new Map(),
    expandedFolderPaths: new Set(),
  };
  context.elements = {
    readingHistoryPage: { hidden: false, querySelectorAll: () => [] },
    readingHistoryEntry: { focus() { entryFocusCount += 1; } },
    contentArea: { scrollTop: 50, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    clearSearchBtn: { style: {} },
    searchInput,
  };
  context.run.handleSearch({ target: { value: '作者' } });
  assert.equal(context.state.readingHistoryVisible, false);
  assert.equal(context.elements.readingHistoryPage.hidden, true);
  assert.equal(context.document.activeElement, searchInput, 'search keeps keyboard focus in the field');
  assert.equal(entryFocusCount, 0);

  context.state.readingHistoryVisible = true;
  context.elements.readingHistoryPage.hidden = false;
  assert.throws(() => context.run.navigateLibraryToPath('folder'), /reached folder navigation/);
  assert.equal(context.state.readingHistoryVisible, false, 'folder navigation exits history before rendering shelf results');
  assert.equal(entryFocusCount, 0);
}

// Offline rows are genuinely disabled, and selected range text uses the high
// contrast primary token instead of accent text over an accent-tinted fill.
{
  const context = historyHarness({
    document: {
      createElement: tag => new FakeElement(tag),
      createTextNode: text => new FakeElement('#text', text),
      fullscreenElement: null, body: { style: {} },
    },
    escapeHtml: value => String(value ?? ''),
    getProgressInfo: () => ({ currentPage: 2, totalPages: 12 }),
    isComicOffline: comic => Boolean(comic.offline),
    getCoverUrl: () => 'cover:test',
    ensureCoverObserver: () => ({ observe() {} }),
  });
  const list = new FakeElement('div');
  context.state = {
    readingHistoryItems: [{ openedAt: new Date().toISOString(), comic: {
      id: 'offline-1', sourceId: 'nas:test', title: '離線作品', offline: true,
    } }],
    readingHistoryLoading: false, readingHistoryError: '', readingHistoryTotal: 1,
  };
  context.elements = {
    readingHistoryList: list,
    readingHistoryStatus: { textContent: '' },
    readingHistoryMore: { hidden: true, disabled: false, textContent: '' },
  };
  context.run.renderReadingHistory();
  const offlineRow = list.querySelector('.reading-history-row');
  assert.equal(offlineRow.disabled, true);
  assert.equal(offlineRow.attributes['aria-label'], '離線作品 · 來源離線');
  assert.equal(offlineRow.querySelector('.reading-history-offline').textContent, '來源離線');
  const selectedRangeRule = style.match(/\.reading-history-ranges button\[aria-pressed="true"\]\s*\{[^}]*\}/)?.[0] || '';
  assert.match(selectedRangeRule, /color:\s*var\(--text-main\)/);
  assert.match(selectedRangeRule, /background:\s*var\(--theme-surface-raised\)/);
  assert.doesNotMatch(selectedRangeRule, /^\s*color:\s*var\(--accent-color\)/m);
  assert.match(style, /\.reading-history-row:disabled\s*\{[^}]*opacity:\s*1;[^}]*cursor:\s*default;/);
  assert.match(style, /\.reading-history-row:not\(:disabled\):hover/);
  assert.match(style, /@media \(min-width: 761px\) and \(max-width: 900px\)[\s\S]*?\.header-actions \.action-btn\s*\{[\s\S]*?width: 44px;[\s\S]*?min-height: 44px;[\s\S]*?\.header-actions \.action-btn span\s*\{\s*display: none;/);
  assert.match(app, /document\.querySelectorAll\('\.header-actions \.action-btn'\)[\s\S]{0,250}button\.setAttribute\('aria-label', accessibleName\)/);
  assert.match(app, /elements\.refreshBtn\?\.setAttribute\('aria-label', readerText\('重新整理'\)\)/);
  assert.match(app, /elements\.settingsBtn\?\.setAttribute\('aria-label', readerText\('設定'\)\)/);
  assert.match(html, /<a class="skip-link" href="#main-content"/);
  assert.match(html, /<main class="content-area" id="main-content" tabindex="-1">/);
}

// Closing history while openReader waits on an earlier close must cancel its
// return intent; a later reader close cannot resurrect the hidden history page.
{
  let releaseReaderClose;
  const priorClose = new Promise(resolve => { releaseReaderClose = resolve; });
  const classes = new Set();
  const book = { id: 'race-book', sourceId: 'local:library', title: 'Race book' };
  const context = historyHarness({
    isComicOffline: () => false,
    showLoader() {},
    hideLoader() {},
    createReadingProgressSnapshot: () => null,
    enqueueReadingProgressSnapshot: () => Promise.resolve(),
    cancelCatalogResize() {},
    cancelCatalogVirtualRender() {},
    resetCatalogThumbnailLoader() {},
    cancelWebtoonAnchor() {},
    captureLibraryFocus: () => null,
    setAutoPageExplanation() {},
    setAiPagePanelVisible() {},
    releasePreloadedImages() {},
    hideReaderContextMenu() {},
    clearReaderPageNotice() {},
    dismissReaderDiscoveryHint() {},
    flushReadingProgressBeforeClose: async () => {},
    scheduleCoverLoadDrain() {},
    restoreReaderFocus() {},
    scheduleLibraryRefresh() {},
    resumeCatalogAppendRenderIfReady() {},
    isBuiltInDemoComic: () => false,
    eAPI: {
      openComic: async () => {
        context.state.currentComic = book;
        context.state.readerOperation += 1;
        return { id: book.id, sourceId: book.sourceId, pages: [{}] };
      },
      getReadingHistory: async () => ({ items: [], total: 0 }),
    },
  });
  context.state = {
    readingHistoryVisible: true,
    readingHistoryReturnToReader: false,
    readingHistoryScrollTop: 0,
    readingHistoryLibraryScrollTop: 0,
    readerReturnFocus: {},
    readerReturnLibraryContext: null,
    readerReturnComicFolder: null,
    readerClosePromise: priorClose,
    readerOperation: 10,
    renderGeneration: 1,
    currentComic: null,
    currentComicPages: [],
    currentPageIndex: 0,
    currentPath: '',
    currentSourceId: '',
    comics: [book],
    selectedComicId: null,
    readingMode: 'single',
    readerReadyPages: new Set(),
    readerFailedPages: new Set(),
    readerLastReadyPageIndex: null,
    readerReadyComicId: null,
    readerReadyComicSourceId: '',
    readerLoadTrackingActive: false,
    readerOpenRequestToken: null,
    webtoonMeasuredPageHeights: new Map(),
    webtoonMetricsComicId: null,
    webtoonMetricsComicSourceId: '',
    webtoonScrollFrame: null,
    progressSaveTimer: null,
    aiExplainTimer: null,
    aiExplainPendingPage: null,
    aiExplainPendingRequest: null,
    libraryRefreshFocusSnapshot: null,
    readerClosePromise: Promise.resolve(),
    pendingComicId: null,
    pendingComicSourceId: '',
    currentComicIsDir: false,
    currentComicFilenames: [],
    aiExplainCache: new Map(),
  };
  context.elements = {
    readingHistoryPage: { hidden: false, querySelectorAll: () => [] },
    readingHistoryEntry: { focus() {} },
    readerOverlay: {
      style: { display: 'none' }, contains: () => true, setAttribute() {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    },
    contentArea: { scrollTop: 0, classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    pagesContainer: { replaceChildren() {} },
    statusLoading: null, btnAiExplain: null, btnAiAutoExplain: null,
    readingHistoryList: null, readingHistoryStatus: null, readingHistoryMore: null,
  };
  const open = context.run.openReader(book);
  assert.equal(context.state.readingHistoryReturnToReader, true, 'open captures the history return intent');
  context.run.closeReadingHistory();
  assert.equal(context.state.readingHistoryReturnToReader, false, 'closing history cancels the pending intent');
  releaseReaderClose();
  await open;
  assert.equal(context.state.currentComic, book, 'the delayed open completed');
  await context.run.closeReader();
  assert.equal(context.elements.readingHistoryPage.hidden, true);
  assert.equal(context.state.readingHistoryVisible, false);
  assert.equal(classes.has('history-visible'), false, 'reader close must not resurrect the hidden history view');
}

// Closing a reader launched from history restores that view and refreshes it.
{
  let refreshCount = 0;
  const classNames = new Set();
  const noop = () => {};
  const context = historyHarness({
    eAPI: { getReadingHistory: async () => { refreshCount += 1; return { items: [], total: 0 }; } },
    createReadingProgressSnapshot: () => null,
    enqueueReadingProgressSnapshot: () => Promise.resolve(),
    cancelCatalogResize: noop,
    cancelCatalogVirtualRender: noop,
    resetCatalogThumbnailLoader: noop,
    cancelWebtoonAnchor: noop,
    getComicSourceId: () => '',
    captureLibraryFocus: () => null,
    setAutoPageExplanation: noop,
    setAiPagePanelVisible: noop,
    releasePreloadedImages: noop,
    hideReaderContextMenu: noop,
    clearReaderPageNotice: noop,
    dismissReaderDiscoveryHint: noop,
    flushReadingProgressBeforeClose: async () => {},
    scheduleCoverLoadDrain: noop,
    restoreReaderFocus: noop,
    refreshReadingHistoryAfterReader: () => { refreshCount += 1; },
    scheduleLibraryRefresh: noop,
    resumeCatalogAppendRenderIfReady: noop,
    isBuiltInDemoComic: () => false,
  });
  context.state = {
    currentComic: null, pendingComicId: null, pendingComicSourceId: '', readingMode: 'single',
    webtoonScrollFrame: null, progressSaveTimer: null, readerOperation: 1, renderGeneration: 1,
    readerReturnComicFolder: null, readerReturnLibraryContext: null, readerReturnFocus: null,
    readerReadyPages: new Set(), readerFailedPages: new Set(), readerLastReadyPageIndex: null,
    readerReadyComicId: null, readerReadyComicSourceId: '', readerLoadTrackingActive: false,
    readerOpenRequestToken: 'history-token', readingHistoryReturnToReader: true,
    webtoonMeasuredPageHeights: new Map(), webtoonMetricsComicId: null, webtoonMetricsComicSourceId: '',
    aiExplainTimer: null, aiExplainPendingPage: null, aiExplainPendingRequest: null,
    readerClosePromise: Promise.resolve(), libraryRefreshFocusSnapshot: null, readingHistoryScrollTop: 73,
    readingHistoryVisible: true,
    readingHistoryItems: [], readingHistoryOffset: 0, readingHistoryLoadedCount: 0,
    readingHistoryTotal: 0, readingHistoryLoading: false, readingHistoryError: '',
  };
  context.elements = {
    statusLoading: null,
    pagesContainer: { replaceChildren: noop },
    readerOverlay: { style: {}, setAttribute: noop, classList: { remove: noop } },
    contentArea: { scrollTop: 0, classList: { add: name => classNames.add(name) } },
    btnAiExplain: null, btnAiAutoExplain: null,
  };
  await context.run.closeReader();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.state.readingHistoryVisible, true);
  assert.ok(classNames.has('history-visible'));
  assert.equal(context.elements.contentArea.scrollTop, 73);
  assert.equal(refreshCount, 1);
}

// closeReader has already captured returnToHistory before flush/native close.
// Closing history while closeComic is held must keep it closed afterward.
{
  const guarded = await runNativeCloseHistoryRace();
  assert.equal(guarded.context.state.readingHistoryReturnToReader, false);
  assert.equal(guarded.context.state.readingHistoryVisible, false);
  assert.equal(guarded.context.elements.readingHistoryPage.hidden, true);
  assert.equal(guarded.classes.has('history-visible'), false);

  // Negative control: the same held-close race with only the visibility guard
  // removed must reproduce the stale local-return resurrection.
  const unguarded = await runNativeCloseHistoryRace({ removeReturnGuard: true });
  assert.equal(unguarded.context.state.readingHistoryVisible, true);
  assert.equal(unguarded.context.elements.readingHistoryPage.hidden, true);
  assert.equal(unguarded.classes.has('history-visible'), true);
  console.log('PASS: held native close keeps history closed; negative control reproduced stale return');
}

console.log('PASS: reading history loading, pagination, first-ready recording, and reader return');
