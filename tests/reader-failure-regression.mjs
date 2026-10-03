import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('../public/tauri-api.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = source.indexOf(') {', start) + 2;
  assert.ok(open >= 2, `missing function body ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing section ${startMarker}`);
  return source.slice(start, end);
}

// closeReader must flush a pending webtoon RAF-derived position and wait for
// the immutable snapshot before native closeComic is allowed to run.
{
  const functions = [
    extractFunction(appSource, 'createReadingProgressSnapshot'),
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'enqueueReadingProgressSnapshot'),
    extractFunction(appSource, 'closeReader'),
  ].join('\n');
  let sequence = 0;
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const saved = [];
  const closes = [];
  const state = {
    currentComic: { id: 'comic-a' },
    currentComicPages: ['a', 'b', 'c'],
    currentPageIndex: 0,
    readingMode: 'webtoon',
    readerReadyPages: new Set([0]),
    readerFailedPages: new Set(),
    readerLastReadyPageIndex: 0,
    readerReadyComicId: 'comic-a',
    webtoonScrollFrame: 42,
    webtoonMeasuredPageHeights: new Map(),
    webtoonMetricsComicId: 'comic-a',
    readerOperation: 0,
    renderGeneration: 1,
    pendingComicId: null,
    readerReturnComicFolder: null,
    readerReturnLibraryContext: null,
    readerReturnFocus: null,
    progressSaveTimer: null,
    aiExplainTimer: null,
    aiExplainPendingPage: null,
    aiExplainPendingRequest: null,
    readerClosePromise: Promise.resolve(),
    webtoonScrollFrame: 42,
  };
  const elements = {
    readerOverlay: { style: { display: 'flex' }, setAttribute() {}, classList: { remove() {} } },
    pagesContainer: { replaceChildren() {} },
    statusLoading: null,
    btnAiExplain: null,
    btnAiAutoExplain: null,
  };
  const context = {
    state,
    elements,
    readingProgressSaveQueue: Promise.resolve(),
    latestQueuedReadingProgressById: new Map(),
    nextReadingProgressSaveSequence: () => ++sequence,
    isBuiltInDemoComic: () => false,
    updateWebtoonScrollState: () => {
      state.currentPageIndex = 2;
      state.readerReadyPages.add(2);
      state.readerLastReadyPageIndex = 2;
    },
    cancelWebtoonAnchor() {},
    cancelCatalogResize() {},
    cancelCatalogVirtualRender() {},
    resetCatalogThumbnailLoader() {},
    captureLibraryFocus: () => null,
    setAutoPageExplanation() {},
    setAiPagePanelVisible() {},
    releasePreloadedImages() {},
    hideReaderContextMenu() {},
    dismissReaderDiscoveryHint() {},
    restoreReaderFocus() {},
    scheduleLibraryRefresh() {},
    clearTimeout,
    cancelAnimationFrame() {},
    document: { fullscreenElement: null, body: { style: {} } },
    window: {
      electronAPI: {
        closeComic: async id => { closes.push(id); },
      },
    },
    eAPI: {
      saveProgress: snapshot => {
        saved.push(snapshot);
        return saveGate;
      },
    },
    persistReadingProgressSnapshot: snapshot => context.eAPI.saveProgress(snapshot),
  };
  vm.runInNewContext(`${functions}\nglobalThis.closeReader = closeReader;`, context);
  const closing = context.closeReader();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(saved.map(item => item.currentPage), [2], 'close flush captures the last RAF-derived page');
  assert.deepEqual(closes, [], 'native close waits for the progress queue');
  releaseSave();
  await closing;
  assert.deepEqual(closes, ['comic-a']);
}

// Decode readiness, failed-page retry, and post-load progress use real helpers.
{
  const functions = [
    extractFunction(appSource, 'readerImageIsReady'),
    extractFunction(appSource, 'decodeReaderImage'),
    extractFunction(appSource, 'markReaderPageReady'),
    extractFunction(appSource, 'markReaderPageFailed'),
    extractFunction(appSource, 'clearReaderImageError'),
    extractFunction(appSource, 'retryReaderPages'),
  ].join('\n');
  let saves = 0;
  let renders = 0;
  const context = {
    state: {
      currentComic: { id: 'comic-b' },
      currentPageIndex: 1,
      currentComicPages: ['a', 'b'],
      renderGeneration: 4,
      readerReadyComicId: 'comic-b',
      readerReadyPages: new Set(),
      readerFailedPages: new Set(),
      readerLastReadyPageIndex: null,
      readingMode: 'single',
    },
    elements: { readerStatusPanel: { querySelectorAll: () => [], appendChild() {} } },
    saveReadingProgress: () => { saves += 1; },
    renderPages: () => { renders += 1; },
    clearReaderImageError() {},
    document: { createElement: () => ({ addEventListener() {}, setAttribute() {} }) },
    readerText: text => text,
  };
  vm.runInNewContext(`${functions}\nglobalThis.decodeReaderImage = decodeReaderImage;\nglobalThis.markReaderPageReady = markReaderPageReady;\nglobalThis.markReaderPageFailed = markReaderPageFailed;\nglobalThis.retryReaderPages = retryReaderPages;`, context);
  const good = { complete: true, naturalWidth: 10, decode: async () => {} };
  await context.decodeReaderImage(good);
  assert.equal(context.markReaderPageReady(1, good), true);
  assert.equal(saves, 1, 'a decoded current page schedules progress save');
  const broken = { complete: false, naturalWidth: 0, decode: async () => { throw new Error('decode failed'); } };
  await assert.rejects(context.decodeReaderImage(broken));
  assert.equal(context.markReaderPageFailed(1), true);
  context.retryReaderPages([1]);
  assert.equal(renders, 1, 'retry action rerenders the failed page');
  assert.equal(context.state.readerFailedPages.has(1), false);
}

// The IPC bridge keeps legacy payloads working while preserving safe sequence 0.
{
  const normalize = extractFunction(apiSource, 'normalizeProgressPayload');
  const context = { bridgeText: text => text };
  vm.runInNewContext(`${normalize}\nglobalThis.normalizeProgressPayload = normalizeProgressPayload;`, context);
  assert.equal(JSON.stringify(context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1 })), JSON.stringify({
    id: 'x', currentPage: 0, totalPages: 1,
  }));
  assert.equal(context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1, sequence: 0 }).sequence, 0);
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1, sequence: -1 })));
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1, sequence: 1.5 })));
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1, sequence: Number.MAX_SAFE_INTEGER + 1 })));
}

// A partial photo batch refreshes the shelf and retries only files that did
// not commit; the successful first file is never silently uploaded twice.
{
  const importSection = extractSection(appSource, '  // 相簿匯入', '  // 書架過濾器');
  const callbacks = {};
  const parent = { child: null, appendChild(button) { this.child = button; button.parentElement = this; } };
  const button = {
    parentElement: parent,
    disabled: false,
    addEventListener: (event, fn) => { callbacks[`button:${event}`] = fn; },
    setAttribute() {},
    removeAttribute() {},
    click() {},
  };
  const input = {
    value: '',
    addEventListener: (event, fn) => { callbacks[event] = fn; },
    click() {},
  };
  let retryButton;
  const createButton = () => {
    const listeners = {};
    return {
      type: 'button', hidden: false, disabled: false,
      addEventListener: (event, fn) => { listeners[event] = fn; },
      setAttribute() {}, removeAttribute() {},
      remove() { this.hidden = true; },
      click() { return listeners.click?.(); },
      get listeners() { return listeners; },
    };
  };
  const attempts = [];
  let scanCalls = 0;
  let fetchCalls = 0;
  const alerts = [];
  const context = {
    document: {
      getElementById: id => id === 'import-photo-btn' ? button : input,
      createElement: () => { retryButton = createButton(); return retryButton; },
    },
    eAPI: {
      saveImportedPhoto: async (filename) => {
        attempts.push(filename);
        if (filename.includes('second') && attempts.filter(item => item.includes('second')).length === 1) throw new Error('native write failed');
      },
      scanLibrary: async () => { scanCalls += 1; },
    },
    MAX_IMPORTED_PHOTO_BYTES: 64 * 1024 * 1024,
    TextEncoder,
    Uint8Array,
    readerText: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`)),
    showLoader() {}, hideLoader() {}, fetchLibrary: async () => { fetchCalls += 1; },
    setScanRecoveryVisible() {}, showReaderToast() {}, alert: message => alerts.push(message),
    console: { error() {} },
  };
  vm.runInNewContext(importSection, context);
  const first = { size: 3, name: 'first.jpg', arrayBuffer: async () => new Uint8Array([1]).buffer };
  const second = { size: 3, name: 'second.jpg', arrayBuffer: async () => new Uint8Array([2]).buffer };
  await callbacks.change({ target: { files: [first, second] } });
  assert.equal(scanCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(attempts.length, 2);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /成功 1 張/);
  assert.match(alerts[0], /失敗 1 張/);
  assert.match(alerts[0], /未處理 0 張/);
  assert.ok(retryButton && !retryButton.hidden, 'partial import exposes an explicit retry button');
  await retryButton.click();
  assert.equal(scanCalls, 2);
  assert.equal(fetchCalls, 2);
  assert.equal(attempts.length, 3);
  assert.equal(attempts.filter(item => item.includes('first')).length, 1, 'successful file is not reuploaded');
  assert.equal(attempts.filter(item => item.includes('second')).length, 2, 'only failed file is retried');
}

assert.match(appSource, /Promise\.allSettled\(decodeEntries/);
assert.match(appSource, /state\.readerReadyPages\.has\(activeIndex\)/);
assert.match(appSource, /\.then\(\(\) => progressQueueToFlush\)/);

// A cache-window call must belong to the same reader operation, render, page,
// and timer request after its native await. Reopening the same comic must not
// let an old success or failure mutate the new session.
{
  const schedule = extractFunction(appSource, 'scheduleReaderCacheWindowUpdate');
  let timerCallback;
  let timerId = 0;
  let resolveCache;
  let rejectCache;
  const context = {
    READER_CACHE_UPDATE_DELAY_MS: 0,
    state: {
      currentComic: { id: 'comic-cache', preloadGeneration: 3 },
      currentPageIndex: 1,
      readerCacheWindowPage: null,
      readerCacheReadyPage: null,
      readerCacheWindowTimer: null,
      readerCacheWindowToken: 0,
      readerOperation: 8,
      renderGeneration: 12,
    },
    eAPI: {
      updateReaderCacheWindow: () => new Promise((resolve, reject) => {
        resolveCache = resolve;
        rejectCache = reject;
      }),
    },
    isBuiltInDemoComic: () => false,
    clearTimeout() {},
    setTimeout: callback => { timerCallback = callback; timerId += 1; return timerId; },
    console: { warn() {} },
  };
  vm.runInNewContext(`${schedule}\nglobalThis.scheduleReaderCacheWindowUpdate = scheduleReaderCacheWindowUpdate;`, context);
  context.scheduleReaderCacheWindowUpdate();
  const firstRequest = timerCallback();
  context.state.currentComic = { id: 'comic-cache', preloadGeneration: 4 };
  context.state.currentPageIndex = 2;
  context.state.readerOperation = 9;
  context.state.renderGeneration = 13;
  context.state.readerCacheWindowPage = 2;
  resolveCache(99);
  await firstRequest;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(context.state.currentComic.preloadGeneration, 4, 'late cache success cannot poison a reopened same-id reader');

  context.state.currentPageIndex = 3;
  context.state.readerCacheWindowPage = 3;
  context.state.readerOperation = 10;
  context.state.renderGeneration = 14;
  context.scheduleReaderCacheWindowUpdate();
  const secondRequest = timerCallback();
  context.state.currentPageIndex = 4;
  context.state.readerCacheWindowPage = 4;
  context.state.readerOperation = 11;
  context.state.renderGeneration = 15;
  rejectCache(new Error('late cache failure'));
  await secondRequest;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(context.state.readerCacheWindowPage, 4, 'late cache failure cannot clear the new page request');
}

// Native progress rejection retries a bounded number of times, leaves a
// durable id/page/count/sequence journal, exposes manual retry, and lets a
// newer snapshot replace an older failed one.
{
  const functions = [
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'readReadingProgressFailures'),
    extractFunction(appSource, 'writeReadingProgressFailures'),
    extractFunction(appSource, 'rememberFailedReadingProgressSnapshot'),
    extractFunction(appSource, 'clearReadingProgressFailure'),
    extractFunction(appSource, 'nextReadingProgressSaveSequenceAfter'),
    extractFunction(appSource, 'persistReadingProgressSnapshot'),
    extractFunction(appSource, 'enqueueReadingProgressSnapshot'),
    extractFunction(appSource, 'retryFailedReadingProgressSnapshots'),
  ].join('\n');
  const storage = new Map();
  let sequence = 40;
  let attempts = 0;
  const savedSequences = [];
  let recoveryRenders = 0;
  let shouldSucceed = false;
  const context = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SEQUENCE_KEY: 'gai:readingProgressSequence',
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [0, 0],
    readingProgressFailuresLoaded: false,
    readingProgressFailures: new Map(),
    readingProgressFailuresStorageReliable: true,
    latestQueuedReadingProgressById: new Map(),
    readingProgressRetryPromise: null,
    readingProgressSaveSequence: 40,
    readingProgressSaveQueue: Promise.resolve(),
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    sessionStorage: {
      setItem: (key, value) => storage.set(key, value),
    },
    document: undefined,
    renderReadingProgressRecovery: () => { recoveryRenders += 1; },
    waitForReadingProgressRetry: async () => {},
    nextReadingProgressSaveSequence: () => ++sequence,
    eAPI: {
      saveProgress: async snapshot => {
        attempts += 1;
        savedSequences.push(snapshot.sequence);
        if (!shouldSucceed) throw new Error(`save failed ${snapshot.sequence}`);
        return false;
      },
    },
    console: { error() {} },
  };
  vm.runInNewContext(`${functions}\nglobalThis.enqueueReadingProgressSnapshot = enqueueReadingProgressSnapshot;\nglobalThis.retryFailedReadingProgressSnapshots = retryFailedReadingProgressSnapshots;\nglobalThis.persistReadingProgressSnapshot = persistReadingProgressSnapshot;\nglobalThis.rememberFailedReadingProgressSnapshot = rememberFailedReadingProgressSnapshot;\nglobalThis.writeReadingProgressFailures = writeReadingProgressFailures;`, context);

  const failed = { id: 'comic-progress', currentPage: 7, totalPages: 20, sequence: 41 };
  await context.enqueueReadingProgressSnapshot(failed);
  assert.equal(attempts, 3, 'progress save uses bounded automatic retry');
  const journalAfterFailure = JSON.parse(storage.get('gai:readingProgressFailures'));
  assert.deepEqual(journalAfterFailure, [failed], 'failed snapshot is durable and contains only progress identity fields');
  assert.ok(recoveryRenders > 0, 'a failed snapshot keeps the visible recovery path active');

  shouldSucceed = true;
  assert.equal(await context.retryFailedReadingProgressSnapshots(), true, 'manual retry clears a successful failure');
  assert.equal(attempts, 4, 'manual retry uses one queued native attempt after automatic retry');
  assert.ok(savedSequences.at(-1) > failed.sequence, 'manual retry allocates a native sequence newer than the journal');
  assert.equal(storage.get('gai:readingProgressFailures'), '[]');

  for (let index = 0; index < 25; index += 1) {
    context.rememberFailedReadingProgressSnapshot({
      id: `comic-${index}`,
      currentPage: index,
      totalPages: 30,
      sequence: 100 + index,
    });
  }
  assert.equal(JSON.parse(storage.get('gai:readingProgressFailures')).length, 25, 'all pending comics remain in the durable journal');

  const deferred = { id: 'comic-deferred', currentPage: 4, totalPages: 8, sequence: 200 };
  context.readingProgressFailures = new Map([[deferred.id, deferred]]);
  context.readingProgressFailuresLoaded = true;
  context.latestQueuedReadingProgressById = new Map();
  context.writeReadingProgressFailures();
  let releaseDeferred;
  context.eAPI.saveProgress = async () => new Promise(resolve => { releaseDeferred = resolve; });
  const manual = context.retryFailedReadingProgressSnapshots();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [deferred], 'manual retry keeps the old journal until native success');
  releaseDeferred();
  await manual;
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [], 'successful manual retry clears its journal entry');

  const oldSnapshot = { id: 'comic-race', currentPage: 1, totalPages: 4, sequence: 300 };
  const newerFailure = { ...oldSnapshot, currentPage: 3, sequence: 301 };
  context.eAPI.saveProgress = async () => { throw new Error('permanent failure'); };
  await context.enqueueReadingProgressSnapshot(oldSnapshot);
  await context.enqueueReadingProgressSnapshot(newerFailure);
  context.eAPI.saveProgress = async () => false;
  await context.persistReadingProgressSnapshot(oldSnapshot);
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [newerFailure], 'older success cannot clear a newer failure');

  context.eAPI.saveProgress = async () => false;
  await context.enqueueReadingProgressSnapshot({ ...newerFailure, currentPage: 2, sequence: 302 });
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [], 'newer native success clears older failure');
}

// Deferred queue regression: a newer native intent must win over an older
// journal retry whether it was queued first or appears before retry execution.
{
  const functions = [
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'readReadingProgressFailures'),
    extractFunction(appSource, 'writeReadingProgressFailures'),
    extractFunction(appSource, 'rememberFailedReadingProgressSnapshot'),
    extractFunction(appSource, 'clearReadingProgressFailure'),
    extractFunction(appSource, 'nextReadingProgressSaveSequenceAfter'),
    extractFunction(appSource, 'persistReadingProgressSnapshot'),
    extractFunction(appSource, 'enqueueReadingProgressSnapshot'),
    extractFunction(appSource, 'retryFailedReadingProgressSnapshots'),
  ].join('\n');
  const storage = new Map();
  const calls = [];
  let sequence = 100;
  let releaseNewIntent;
  const newIntentGate = new Promise(resolve => { releaseNewIntent = resolve; });
  const context = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SEQUENCE_KEY: 'gai:readingProgressSequence',
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [0, 0],
    readingProgressFailuresLoaded: true,
    readingProgressFailures: new Map(),
    readingProgressFailuresStorageReliable: true,
    latestQueuedReadingProgressById: new Map(),
    readingProgressRetryPromise: null,
    readingProgressSaveSequence: sequence,
    readingProgressSaveQueue: Promise.resolve(),
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    sessionStorage: { setItem() {} },
    document: undefined,
    renderReadingProgressRecovery() {},
    waitForReadingProgressRetry: async () => {},
    nextReadingProgressSaveSequence: () => ++sequence,
    eAPI: {
      saveProgress: async snapshot => {
        calls.push(snapshot);
        if (snapshot.currentPage === 9) await newIntentGate;
        return false;
      },
    },
    console: { error() {} },
  };
  vm.runInNewContext(`${functions}
    globalThis.enqueueReadingProgressSnapshot = enqueueReadingProgressSnapshot;
    globalThis.retryFailedReadingProgressSnapshots = retryFailedReadingProgressSnapshots;`, context);

  const oldJournal = { id: 'comic-deferred-order', currentPage: 1, totalPages: 20, sequence: 100 };
  context.readingProgressFailures = new Map([[oldJournal.id, oldJournal]]);
  context.writeReadingProgressFailures();
  const newerQueued = context.enqueueReadingProgressSnapshot({
    id: oldJournal.id, currentPage: 9, totalPages: 20, sequence: 200,
  });
  await new Promise(resolve => setImmediate(resolve));
  const skippedRetry = context.retryFailedReadingProgressSnapshots();
  assert.equal(await skippedRetry, false, 'retry remains pending while newer queued native intent is unresolved');
  assert.deepEqual(calls.map(snapshot => snapshot.currentPage), [9], 'newer queued intent runs without an older retry');
  releaseNewIntent();
  await newerQueued;
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [], 'newer native success clears the old journal');

  calls.length = 0;
  context.readingProgressFailures = new Map([[oldJournal.id, oldJournal]]);
  context.writeReadingProgressFailures();
  context.latestQueuedReadingProgressById = new Map();
  let releaseQueue;
  context.readingProgressSaveQueue = new Promise(resolve => { releaseQueue = resolve; });
  const queuedRetry = context.retryFailedReadingProgressSnapshots();
  await new Promise(resolve => setImmediate(resolve));
  const newerIntent = context.enqueueReadingProgressSnapshot({
    id: oldJournal.id, currentPage: 9, totalPages: 20, sequence: 202,
  });
  releaseQueue();
  await newerIntent;
  assert.equal(await queuedRetry, false, 'retry reports unresolved journal until the newer intent finishes');
  assert.deepEqual(calls.map(snapshot => snapshot.currentPage), [9], 'queue execution skips retry after a newer intent appears');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [], 'newer intent success removes the retry journal');

  calls.length = 0;
  context.readingProgressFailures = new Map([[oldJournal.id, oldJournal]]);
  context.writeReadingProgressFailures();
  context.latestQueuedReadingProgressById = new Map();
  let releaseDuplicate;
  const duplicateGate = new Promise(resolve => { releaseDuplicate = resolve; });
  context.eAPI.saveProgress = async snapshot => {
    calls.push(snapshot);
    await duplicateGate;
    return false;
  };
  const firstRetry = context.retryFailedReadingProgressSnapshots();
  const secondRetry = context.retryFailedReadingProgressSnapshots();
  assert.strictEqual(firstRetry, secondRetry, 'rapid retry clicks share one in-flight operation');
  releaseDuplicate();
  await firstRetry;
  assert.equal(calls.length, 1, 'rapid retry clicks make one native retry call');
}
console.log('PASS: close flush/queue, decode failure retry/load save, sequence compatibility, and partial import retry');
