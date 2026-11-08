import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('../public/tauri-api.js', import.meta.url), 'utf8');
const styleSource = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const readerMessagesSource = fs.readFileSync(new URL('../public/locales/reader-messages.js', import.meta.url), 'utf8');
const featureMessagesSource = fs.readFileSync(new URL('../public/locales/feature-messages.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
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
    extractFunction(appSource, 'adoptReadingProgressSequenceFloor'),
    extractFunction(appSource, 'createReadingProgressSnapshot'),
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressKey'),
    extractFunction(appSource, 'readingProgressFailureKey'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'readingProgressNeedsManualCheck'),
    extractFunction(appSource, 'readReadingProgressFailures'),
    extractFunction(appSource, 'writeReadingProgressFailures'),
    extractFunction(appSource, 'rememberFailedReadingProgressSnapshot'),
    extractFunction(appSource, 'waitForReadingProgressSave'),
    extractFunction(appSource, 'persistReadingProgressSnapshot'),
    extractFunction(appSource, 'clearReadingProgressFailure'),
    extractFunction(appSource, 'enqueueReadingProgressSnapshot'),
    extractFunction(appSource, 'flushReadingProgressBeforeClose'),
    extractFunction(appSource, 'clearReaderPageNotice'),
    extractFunction(appSource, 'closeReader'),
  ].join('\n');
  let sequence = 0;
  let releaseSave;
  let releaseLateSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const saved = [];
  const closes = [];
  const failed = new Map();
  const timers = new Map();
  let timerId = 0;
  const setTimer = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimer = id => timers.delete(id);
  let loaderVisible = false;
  const alerts = [];
  let resolveLateOpen;
  const state = {
    comics: [{ id: 'comic-b', title: 'Book B', relativePath: 'book-b.cbz', sourceId: 'local:test' }],
    currentComic: { id: 'comic-a', sourceId: 'local:test' },
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
    aiExplainCache: new Map(),
    zoomPercentage: 100,
    rotationAngle: 0,
  };
  const elements = {
    readerOverlay: {
      style: { display: 'flex' },
      setAttribute() {},
      classList: { remove() {} },
      contains: () => false,
    },
    pagesContainer: { replaceChildren() {} },
    statusLoading: null,
    btnAiExplain: { hidden: false },
    btnAiAutoExplain: { hidden: false },
    readerComicTitle: { textContent: '' },
  };
  let closeError = true;
  const context = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SEQUENCE_KEY: 'gai:readingProgressSequence',
    readingProgressSaveSequence: 0,
    sessionStorage: { setItem() {} },
    readingProgressFailuresLoaded: true,
    readingProgressFailures: failed,
    readingProgressFailuresStorageReliable: true,
    localStorage: { setItem() {} },
    state,
    elements,
    readingProgressSaveQueue: Promise.resolve(),
    latestQueuedReadingProgressById: new Map(),
    discardedReadingProgressIntents: new Map(),
    nextReadingProgressSaveSequence: () => ++sequence,
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [],
    READING_PROGRESS_SAVE_TIMEOUT_MS: 8000,
    waitForReadingProgressRetry: async () => {},
    renderReadingProgressRecovery() {},
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    console: { error() {} },
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
    resumeCatalogAppendRenderIfReady() {},
    scheduleLibraryRefresh() {},
    scheduleCoverLoadDrain() {},
    clearTimeout: clearTimer,
    cancelAnimationFrame() {},
    document: { fullscreenElement: null, body: { style: {} } },
    window: {
      electronAPI: {
        closeComic: async (id, sourceId) => {
          closes.push({ id, sourceId });
          if (closeError) throw new Error('native close failed');
        },
      },
    },
    eAPI: {
      saveProgress: snapshot => {
        saved.push(snapshot);
        return saveGate;
      },
      recoverReadingProgress: async () => {},
      openComic: async id => id === 'comic-late'
        ? new Promise(resolve => { resolveLateOpen = resolve; })
        : ({
          id,
          sourceId: 'local:test',
          title: 'Book B',
          pages: Array.from({ length: 8 }, (_, index) => `b-${index}`),
          progress: { currentPage: 0 },
          recoveryToken: 'token-comic-b',
          isDir: false,
          filenames: [],
        }),
    },
    isComicOffline: () => false,
    captureLibraryViewContext: () => null,
    readerText: text => text,
    alert: message => alerts.push(message),
    updateReaderUiControls() {},
    applyFitMode() {},
    showReaderDiscoveryHint() {},
    triggerControlsActive() {},
    focusReaderEntry() {},
    renderPages() {},
    showLoader() { loaderVisible = true; },
    hideLoader() { loaderVisible = false; },
    hideReaderContextMenu() {},
    setAutoPageExplanation() {},
    setAiPagePanelVisible() {},
    restoreReaderFocus() {},
    scheduleLibraryRefresh() {},
  };
  vm.runInNewContext(`${extractFunction(appSource, 'getComicSourceId')}\n${extractFunction(appSource, 'getSelectedComic')}\n${extractFunction(appSource, 'setSelectedComic')}\n${functions}\n${extractFunction(appSource, 'openReader')}\nglobalThis.closeReader = closeReader;\nglobalThis.openReader = openReader;\nglobalThis.persistReadingProgressSnapshot = persistReadingProgressSnapshot;\nglobalThis.readingProgressFailureKey = readingProgressFailureKey;\nglobalThis.rememberFailure = rememberFailedReadingProgressSnapshot;`, context);
  const closing = context.closeReader();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(saved.map(item => item.currentPage), [2], 'close flush captures the last RAF-derived page');
  assert.deepEqual(closes, [], 'native close waits for the progress queue');
  releaseSave();
  await closing;
  assert.deepEqual(closes, [{ id: 'comic-a', sourceId: 'local:test' }],
    'delayed close keeps the source identity of the closing reader');

  closeError = false;
  await assert.doesNotReject(
    context.openReader('comic-b'),
    'a rejected native close must not poison the next reader open',
  );
  assert.equal(context.state.currentComic?.id, 'comic-b',
    'the next comic still becomes the active reader after close recovery');
  assert.deepEqual(alerts, [], 'a successful reopen does not show the reader failure alert');

  // Closing while openComic is still pending must release the global loader.
  // A native open that returns after cancellation must not revive the old reader.
  await context.closeReader();
  const lateOpen = context.openReader('comic-late');
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  assert.equal(context.state.pendingComicId, 'comic-late');
  assert.equal(loaderVisible, true, 'pending reader shows the loader');
  await context.closeReader();
  assert.equal(context.state.pendingComicId, null);
  assert.equal(loaderVisible, false, 'closing a pending reader hides its loader');
  resolveLateOpen({
    id: 'comic-late', sourceId: 'local:test', title: 'Late Book', pages: ['late'],
    progress: { currentPage: 0 }, isDir: false, filenames: [],
  });
  await lateOpen;
  assert.equal(context.state.currentComic, null, 'a late cancelled open cannot become active');
  assert.equal(elements.readerOverlay.style.display, 'none', 'a late cancelled open cannot restore the overlay');
  await context.openReader('comic-after-cancel');
  assert.equal(context.state.currentComic?.id, 'comic-after-cancel', 'a fresh reader can open after cancellation');

  const noTokenJournal = {
    id: 'comic-b', sourceId: 'local:test', currentPage: 4, totalPages: 8, sequence: 80,
  };
  context.rememberFailure(noTokenJournal);
  await context.closeReader();
  await context.openReader({ id: 'comic-b', sourceId: 'local:test' });
  assert.equal(context.state.currentComic.recoveryToken, 'token-comic-b');
  assert.equal(context.state.currentComic.progress.currentPage, 0,
    'a tokenless old journal cannot change a newly opened reader progress');

  const sameTokenJournal = {
    ...noTokenJournal, currentPage: 2, sequence: 81, recoveryToken: 'token-comic-b',
  };
  await context.closeReader();
  context.rememberFailure(sameTokenJournal);
  assert.equal(context.readReadingProgressFailures().has(context.readingProgressFailureKey(sameTokenJournal)), true,
    'actual remember helper stores the matching token version');
  assert.equal(context.readingProgressFailures.has(context.readingProgressFailureKey(sameTokenJournal)), true,
    'the same-token journal is stored under its exact version key');
  await context.openReader({ id: 'comic-b', sourceId: 'local:test' });
  assert.equal(context.state.currentComic.progress.currentPage, 2,
    'a journal with the matching native open token restores its pending page');

  // A hung native save must not let a queue of stale snapshots multiply the
  // close delay, and a late success racing timeout handling must not leave a
  // stale recovery journal behind.
  context.state.currentComic = { id: 'timeout-comic', sourceId: 'local:test' };
  context.state.currentComicPages = ['0', '1', '2', '3'];
  context.state.currentPageIndex = 3;
  context.state.readingMode = 'single';
  context.state.readerLoadTrackingActive = false;
  sequence = 100;
  context.eAPI.saveProgress = snapshot => {
    saved.push(snapshot);
    return new Promise(resolve => { releaseLateSave = resolve; });
  };
  context.enqueueReadingProgressSnapshot({
    id: 'timeout-comic', sourceId: 'local:test', currentPage: 1, totalPages: 4, sequence: 50,
  });
  context.enqueueReadingProgressSnapshot({
    id: 'timeout-comic', sourceId: 'local:test', currentPage: 2, totalPages: 4, sequence: 51,
  });
  const progressClose = context.closeReader();
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  assert.equal(saved.at(-1)?.currentPage, 3, 'the queued saves coalesce to the final page intent');
  assert.ok(timers.size >= 2, 'save and whole-close deadlines are both armed');
  const expired = Array.from(timers.values());
  timers.clear();
  // Resolve the native request after its save deadline but before yielding to
  // the timeout continuation. This reproduces the re-journal race.
  // close's overall deadline is armed first; save's own deadline is second.
  expired[1].callback();
  releaseLateSave();
  expired[0].callback();
  await progressClose;
  assert.equal(closes.at(-1)?.id, 'timeout-comic', 'native close proceeds after the shared deadline');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(!Array.from(context.readingProgressFailures.values()).some(item => item.id === 'timeout-comic'), true,
    'a native success racing the timeout continuation does not leave a stale journal');

  // If a newer intent is already journaled/queued, an older timed-out reply
  // must leave that newer recovery snapshot intact.
  const newer = {
    id: 'timeout-comic', sourceId: 'local:test', currentPage: 4, totalPages: 4, sequence: 102,
  };
  context.readingProgressFailures.set(context.readingProgressFailureKey(newer), newer);
  context.latestQueuedReadingProgressById.set(context.readingProgressFailureKey(newer), newer);
  context.state.currentComic = { id: 'timeout-comic', sourceId: 'local:test' };
  context.state.currentComicPages = ['0', '1', '2', '3'];
  context.state.currentPageIndex = 3;
  context.eAPI.saveProgress = () => new Promise(resolve => { releaseLateSave = resolve; });
  const oldRetry = context.persistReadingProgressSnapshot({
    id: 'timeout-comic', sourceId: 'local:test', currentPage: 2, totalPages: 4, sequence: 101,
  }, 101);
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  for (const timer of Array.from(timers.values())) timer.callback();
  timers.clear();
  await oldRetry;
  releaseLateSave();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Array.from(context.readingProgressFailures.values()).find(item => item.id === 'timeout-comic')?.sequence, 102,
    'a late older success preserves the newer journal snapshot');
  await context.openReader('comic-after-timeout');
  assert.equal(context.state.currentComic?.id, 'comic-after-timeout',
    'a new comic can open after progress save timeout');
}

// A failed reader open must release modal/scroll state, clear stale page DOM,
// and leave a clean status panel for the next open attempt.
{
  const openReader = extractFunction(appSource, 'openReader');
  const alerts = [];
  const context = {
    state: {
      comics: [{ id: 'broken', title: 'Broken' }],
      currentComic: null,
      currentComicPages: ['stale-page'],
      pendingComicId: null,
      readerOperation: 0,
      readerReturnFocus: null,
      readerReturnComicFolder: null,
      readerReturnLibraryContext: null,
      readerClosePromise: Promise.resolve(),
    },
    elements: {
      readerOverlay: {
        style: { display: 'flex' },
        contains: () => false,
        setAttribute(name, value) { this[name] = value; },
        classList: { remove() {} },
      },
      pagesContainer: { replaceChildren() { this.cleared = true; } },
      statusLoading: { style: { display: 'flex' } },
    },
    document: { activeElement: null, body: { style: { overflow: 'hidden' } } },
    eAPI: { openComic: async () => { throw new Error('temporary source loss'); } },
    isComicOffline: () => false,
    captureLibraryViewContext: () => null,
    showLoader() {},
    hideLoader() {},
    restoreReaderFocus() {},
    readerText: text => text,
    alert: message => alerts.push(message),
    console: { error() {} },
    clearTimeout,
    scheduleCoverLoadDrain() {},
  };
  vm.runInNewContext(`${extractFunction(appSource, 'getComicSourceId')}\n${extractFunction(appSource, 'setSelectedComic')}\n${extractFunction(appSource, 'clearReaderPageNotice')}\n${openReader}\nglobalThis.openReader = openReader;`, context);
  await context.openReader('broken');
  assert.equal(context.elements.readerOverlay.style.display, 'none');
  assert.equal(context.document.body.style.overflow, 'auto');
  assert.equal(context.elements.readerOverlay['aria-hidden'], 'true');
  assert.equal(context.elements.pagesContainer.cleared, true);
  assert.equal(context.elements.statusLoading.style.display, 'none');
  assert.equal(context.state.currentComic, null);
  assert.equal(context.state.pendingComicId, null);
  assert.equal(alerts.length, 1);
}

// Inspector cover failures must remain visible and actionable instead of
// silently leaving an empty gradient panel. Keep the fallback localized.
assert.match(appSource, /class="inspector-cover-fallback" hidden role="status"/);
assert.match(appSource, /data-inspector-cover-action="retry"/);
assert.doesNotMatch(appSource, /onerror="this\.style\.display='none';"/);
assert.match(styleSource, /\.inspector-cover-fallback\s*\{/);
assert.match(styleSource, /\.inspector-cover-fallback\[hidden\]\s*\{\s*display:\s*none;/);
assert.match(readerMessagesSource, /"封面暫時無法載入"\s*:/);
assert.match(readerMessagesSource, /"重試"\s*:/);
{
  const bindFallback = extractFunction(appSource, 'bindInspectorCoverFallback');
  const listeners = {};
  const attrs = { src: 'gai://cover/broken' };
  const image = {
    dataset: {},
    style: { display: '' },
    loading: 'lazy',
    complete: false,
    naturalWidth: 0,
    addEventListener(type, handler) { listeners[type] = handler; },
    getAttribute(name) { return attrs[name] || null; },
    removeAttribute(name) { delete attrs[name]; },
    setAttribute(name, value) { attrs[name] = value; },
    set src(value) { attrs.src = value; },
    get src() { return attrs.src || ''; },
  };
  const retry = { disabled: false, textContent: '', onclick: null };
  const message = { textContent: '封面暫時無法載入' };
  const fallback = {
    hidden: true,
    querySelector: selector => selector.includes('retry') ? retry : message,
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  };
  const root = {
    querySelector: selector => selector === '.inspector-cover img' ? image : fallback,
  };
  const context = { readerText: text => text };
  vm.runInNewContext(`${bindFallback}\nglobalThis.bind = bindInspectorCoverFallback;`, context);
  context.bind(root);
  listeners.error();
  assert.equal(image.style.display, 'none');
  assert.equal(image['aria-hidden'], undefined, 'ARIA state is set through setAttribute');
  assert.equal(attrs['aria-hidden'], 'true');
  assert.equal(fallback.hidden, false);
  retry.onclick();
  assert.equal(retry.disabled, true);
  assert.equal(fallback.hidden, false, 'retry keeps the fallback visible while loading');
  assert.equal(fallback['aria-busy'], 'true');
  assert.equal(message.textContent, '載入中…');
  assert.equal(image.style.display, 'none');
  assert.equal(image.loading, 'eager', 'retry forces eager loading before assigning src');
  assert.equal(image.src, 'gai://cover/broken');
  listeners.load();
  assert.equal(image.style.display, '');
  assert.equal(fallback.hidden, true);
  assert.equal(fallback['aria-busy'], undefined);
  assert.equal(retry.disabled, false);
  listeners.error();
  assert.equal(fallback.hidden, false, 'a later error returns to the retry state');
  assert.equal(message.textContent, '封面暫時無法載入');
  assert.equal(retry.disabled, false);
  retry.onclick();
  assert.equal(fallback.hidden, false);
  assert.equal(retry.disabled, true);
  listeners.error();
  assert.equal(fallback.hidden, false);
  assert.equal(fallback['aria-busy'], undefined);
  assert.equal(retry.disabled, false);
}

// Decode readiness, failed-page retry, and post-load progress use real helpers.
{
  const functions = [
    extractFunction(appSource, 'getComicSourceId'),
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
      readerReadyComicSourceId: '',
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

// A late webtoon image error belongs to its render generation.  It must not
// create a retry button after navigation, while a current-generation error
// still needs to expose the failed page to the reader.
{
  const functions = [
    extractFunction(appSource, 'getComicSourceId'),
    extractFunction(appSource, 'readerText'),
    extractFunction(appSource, 'clearReaderImageError'),
    extractFunction(appSource, 'showReaderImageError'),
    extractFunction(appSource, 'readerImageIsReady'),
    extractFunction(appSource, 'markReaderPageReady'),
    extractFunction(appSource, 'markReaderPageFailed'),
    extractFunction(appSource, 'createWebtoonPageImage'),
  ].join('\n');
  const buttons = [];
  const panel = {
    querySelectorAll: () => buttons,
    appendChild(button) { buttons.push(button); },
  };
  const createButton = () => ({
    type: 'button',
    className: '',
    textContent: '',
    setAttribute() {},
    addEventListener() {},
    remove() {
      const index = buttons.indexOf(this);
      if (index >= 0) buttons.splice(index, 1);
    },
  });
  const createImage = () => {
    const listeners = new Map();
    return {
      dataset: {},
      style: {},
      isConnected: true,
      complete: true,
      naturalWidth: 10,
      clientHeight: 240,
      addEventListener(type, handler) { listeners.set(type, handler); },
      set src(value) { this.source = value; },
      dispatch(type) { listeners.get(type)?.(); },
    };
  };
  const context = {
    window: {},
    state: {
      currentComic: { id: 'webtoon-race' },
      currentComicPages: ['a', 'b'],
      currentPageIndex: 0,
      readingMode: 'webtoon',
      renderGeneration: 2,
      webtoonPageHeights: [240, 240],
      readerFailedPages: new Set(),
      readerReadyPages: new Set(),
    },
    elements: {
      readerStatusPanel: panel,
      readerOverlay: panel,
      pagesContainer: { contains: image => image?.isConnected === true },
    },
    document: { createElement: tag => tag === 'img' ? createImage() : createButton() },
    WEBTOON_EAGER_IMAGES: 2,
    updateWebtoonPageHeight() {},
    applyImageEffects() {},
    saveReadingProgress() {},
  };
  vm.runInNewContext(`${functions}
globalThis.createWebtoonPageImage = createWebtoonPageImage;`, context);

  const staleImage = context.createWebtoonPageImage('stale-page', 0, 0, 1);
  staleImage.dispatch('error');
  assert.equal(buttons.length, 0,
    'stale webtoon image errors must not create a reader retry button');
  assert.deepEqual(Array.from(context.state.readerFailedPages), [],
    'stale webtoon image errors must not mutate current failed pages');

  const currentImage = context.createWebtoonPageImage('current-page', 1, 1, 2);
  currentImage.dispatch('error');
  assert.equal(buttons.length, 1,
    'current-generation webtoon image errors create a reader retry button');
  assert.match(buttons[0].textContent, /第 2 頁載入失敗/,
    'current-generation retry button identifies the failed page');

  buttons.length = 0;
  context.state.readerFailedPages.clear();
  context.state.readerReadyPages = new Set([1]);
  const detachedImage = context.createWebtoonPageImage('detached-page', 0, 0, 2);
  detachedImage.isConnected = false;
  detachedImage.dispatch('load');
  detachedImage.dispatch('error');
  assert.deepEqual(Array.from(context.state.readerReadyPages), [1],
    'a detached same-generation webtoon load cannot mark a stale page ready');
  assert.deepEqual(Array.from(context.state.readerFailedPages), [],
    'a detached same-generation webtoon error cannot mark a stale page failed');
  assert.equal(buttons.length, 0,
    'a detached same-generation webtoon error cannot create a retry button');

  const liveImage = context.createWebtoonPageImage('live-page', 1, 1, 2);
  liveImage.dispatch('load');
  assert.deepEqual(Array.from(context.state.readerReadyPages), [1],
    'the current-generation live webtoon image still marks its page ready');
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
  assert.equal(context.normalizeProgressPayload({
    id: 'x', currentPage: 0, totalPages: 1, recoveryToken: 'token-123',
  }).recoveryToken, 'token-123', 'the IPC bridge preserves the native recovery token');
  assert.equal(context.normalizeProgressPayload({ id: 'x', sourceId: 'local:A', currentPage: 0, totalPages: 1 }).sourceId, 'local:A');
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({ id: 'x', sourceId: '', currentPage: 0, totalPages: 1 })));
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1, sequence: -1 })));
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1, sequence: 1.5 })));
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({ id: 'x', currentPage: 0, totalPages: 1, sequence: Number.MAX_SAFE_INTEGER + 1 })));
  await assert.rejects(Promise.resolve().then(() => context.normalizeProgressPayload({
    id: 'x', currentPage: 0, totalPages: 1, recoveryToken: ' '.repeat(129),
  })));
}

// Fresh snapshots carry the native open token into the durable journal.
{
  const context = {
    state: {
      currentComic: { id: 'token-snapshot', sourceId: 'local:test', recoveryToken: 'native-token' },
      currentPageIndex: 2,
      currentComicPages: ['a', 'b', 'c'],
      readerLoadTrackingActive: false,
    },
    nextReadingProgressSaveSequence: () => 19,
    isBuiltInDemoComic: () => false,
  };
  vm.runInNewContext(`${extractFunction(appSource, 'createReadingProgressSnapshot')}
    globalThis.createSnapshot = createReadingProgressSnapshot;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.createSnapshot())), {
    id: 'token-snapshot', sourceId: 'local:test', recoveryToken: 'native-token',
    currentPage: 2, totalPages: 3, sequence: 19,
  }, 'a reading progress snapshot includes the recovery token from openComic');
}

// Authoritative progress overlays are source-scoped as well; a save from one
// local root must not bleed into an identically named runtime id elsewhere.
{
  const functions = [
    extractFunction(apiSource, 'progressIdentityKey'),
    extractFunction(apiSource, 'progressPercent'),
    extractFunction(apiSource, 'progressTimestamp'),
    extractFunction(apiSource, 'normalizeProgressPayload'),
    extractFunction(apiSource, 'rememberAuthoritativeLibraryProgress'),
    extractFunction(apiSource, 'overlayAuthoritativeLibraryProgress'),
    extractFunction(apiSource, 'readerDataWithAuthoritativeProgress'),
    extractFunction(apiSource, 'rememberSavedProgress'),
  ].join('\n');
  const context = {
    authoritativeProgressById: new Map(),
    progressSaveSequenceById: new Map(),
    bridgeText: text => text,
    Date,
  };
  vm.runInNewContext(`${functions}
    globalThis.remember = rememberSavedProgress;
    globalThis.overlay = overlayAuthoritativeLibraryProgress;
    globalThis.readerOverlay = readerDataWithAuthoritativeProgress;`, context);
  context.remember({ id: 'same-runtime-id', sourceId: 'local:A', currentPage: 8, totalPages: 10 });
  const items = [
    { id: 'same-runtime-id', sourceId: 'local:A', progress: { currentPage: 1, totalPages: 10, updatedAt: '2020-01-01T00:00:00Z' } },
    { id: 'same-runtime-id', sourceId: 'local:B', progress: { currentPage: 2, totalPages: 10, updatedAt: '2020-01-01T00:00:00Z' } },
  ];
  const overlaid = context.overlay(items);
  assert.equal(overlaid[0].progress.currentPage, 8, 'saved source A overlay is applied to source A');
  assert.equal(overlaid[1].progress.currentPage, 2, 'source B keeps its own progress');
  assert.equal(context.readerOverlay('same-runtime-id', {
    sourceId: 'local:B', pages: ['a'], progress: { currentPage: 2 },
  }).progress.currentPage, 2, 'reader source B does not receive source A overlay');

  context.remember({ id: 'ordered-save', sourceId: 'local:A', currentPage: 8, totalPages: 10, sequence: 20 });
  context.remember({ id: 'ordered-save', sourceId: 'local:A', currentPage: 2, totalPages: 10, sequence: 19 });
  const ordered = context.overlay([{
    id: 'ordered-save', sourceId: 'local:A',
    progress: { currentPage: 0, totalPages: 10, updatedAt: '2020-01-01T00:00:00Z' },
  }]);
  assert.equal(ordered[0].progress.currentPage, 8,
    'a late older save response cannot overwrite a newer authoritative page');
}

// Progress recovery identity is source-scoped. Two source lanes may expose the
// same runtime id (for example the same relative path under different local
// roots), so both pending snapshots must survive and retry independently.
{
  const functions = [
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressKey'),
    extractFunction(appSource, 'readingProgressFailureKey'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'readingProgressNeedsManualCheck'),
    extractFunction(appSource, 'readReadingProgressFailures'),
    extractFunction(appSource, 'writeReadingProgressFailures'),
    extractFunction(appSource, 'rememberFailedReadingProgressSnapshot'),
    extractFunction(appSource, 'clearReadingProgressFailure'),
    extractFunction(appSource, 'waitForReadingProgressSave'),
    extractFunction(appSource, 'nextReadingProgressSaveSequenceAfter'),
    extractFunction(appSource, 'persistReadingProgressSnapshot'),
    extractFunction(appSource, 'enqueueReadingProgressSnapshot'),
    extractFunction(appSource, 'retryFailedReadingProgressSnapshots'),
  ].join('\n');
  const storage = new Map();
  const saved = [];
  const recovered = [];
  let sequence = 100;
  const context = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SEQUENCE_KEY: 'gai:readingProgressSequence',
    READING_PROGRESS_SAVE_TIMEOUT_MS: 8000,
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [],
    readingProgressFailuresLoaded: true,
    readingProgressFailures: new Map(),
    readingProgressFailuresStorageReliable: true,
    latestQueuedReadingProgressById: new Map(),
    discardedReadingProgressIntents: new Map(),
    readingProgressRetryPromise: null,
    readingProgressSaveSequence: sequence,
    readingProgressSaveQueue: Promise.resolve(),
    state: { currentComic: null },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    sessionStorage: { setItem() {} },
    document: undefined,
    renderReadingProgressRecovery() {},
    nextReadingProgressSaveSequence: () => ++sequence,
    eAPI: {
      saveProgress: async snapshot => { saved.push(snapshot); },
      recoverReadingProgress: async snapshot => { recovered.push(snapshot); },
    },
    console: { error() {} },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(`${functions}
    globalThis.remember = rememberFailedReadingProgressSnapshot;
    globalThis.retry = retryFailedReadingProgressSnapshots;
    globalThis.readingProgressFailureKey = readingProgressFailureKey;`, context);

  const localA = { id: 'same-runtime-id', sourceId: 'local:A', currentPage: 4, totalPages: 10, sequence: 101 };
  const localB = { id: 'same-runtime-id', sourceId: 'local:B', currentPage: 7, totalPages: 10, sequence: 102 };
  localA.recoveryToken = 'token-A';
  localB.recoveryToken = 'token-B';
  context.remember(localA);
  context.remember(localB);
  assert.equal(context.readingProgressFailures.size, 2, 'same runtime id from two sources keeps two journal entries');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [localB, localA],
    'source identity is persisted with each pending snapshot');
  await context.retry();
  assert.deepEqual(saved, [], 'journal recovery does not use the active-reader-only save command');
  assert.deepEqual(recovered.map(snapshot => snapshot.sourceId), ['local:A', 'local:B'],
    'manual retry uses the recovery API and preserves source identity for each same-id snapshot');
  assert.deepEqual(recovered.map(snapshot => snapshot.recoveryToken), ['token-A', 'token-B'],
    'manual retry preserves native recovery tokens through the queue and bridge call');
  assert.equal(context.readingProgressFailures.size, 0, 'successful source-scoped retries clear both entries');

  const legacy = { id: 'same-runtime-id', currentPage: 2, totalPages: 10, sequence: 103 };
  context.remember(legacy);
  saved.length = 0;
  await context.retry();
  assert.equal(saved.length, 0, 'legacy source-less journal is not automatically retried');
  assert.equal(context.readingProgressFailures.size, 1, 'legacy journal remains recoverable until explicit discard');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [legacy],
    'legacy journal is not silently deleted during source migration');

  const oldNoToken = {
    id: 'same-version-id', sourceId: 'local:C', currentPage: 1, totalPages: 10, sequence: 104,
  };
  const currentVersion = {
    ...oldNoToken, currentPage: 6, sequence: 105, recoveryToken: 'token-current',
  };
  context.remember(oldNoToken);
  context.remember(currentVersion);
  assert.equal(context.readingProgressFailures.size, 3,
    'same source/id keeps both the old tokenless and current-token journal entries');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [currentVersion, oldNoToken, legacy],
    'journal persistence keeps distinct recovery versions without overwriting the old entry');
  await context.retry();
  assert.deepEqual(recovered.map(snapshot => snapshot.recoveryToken), ['token-A', 'token-B', 'token-current'],
    'retry sends only the current token version to native recovery');
  assert.equal(context.readingProgressFailures.has(context.readingProgressFailureKey(oldNoToken)), true,
    'successful current-token recovery does not clear the old tokenless journal');
  assert.equal(context.readingProgressFailures.has(context.readingProgressFailureKey(currentVersion)), false,
    'successful recovery clears only the matching token journal');

  const photo = {
    id: 'photos:album-a', sourceId: 'photos:library', currentPage: 3, totalPages: 12, sequence: 104,
  };
  context.state.currentComic = { id: photo.id, sourceId: photo.sourceId };
  context.eAPI.saveProgress = async snapshot => {
    assert.equal(context.state.currentComic?.id, snapshot.id,
      'photo progress retry uses saveProgress while the matching reader is active');
    saved.push(snapshot);
  };
  context.remember(photo);
  await context.retry();
  assert.deepEqual(saved, [], 'retry skips a photo album that is already open to avoid racing newer reading progress');
  assert.equal(recovered.length, 3, 'photo recovery does not use the source-scoped recovery API');
  assert.equal(context.readingProgressFailures.has(context.readingProgressFailureKey(photo)), true,
    'skipping the active photo keeps its journal for a later safe retry');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [oldNoToken, photo, legacy],
    'active and intentionally retained legacy entries stay in the journal');
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
assert.match(appSource, /flushReadingProgressBeforeClose\(progressQueueToFlush, closingProgress\)/);

// A cache-window call must belong to the same reader operation, render, page,
// and timer request after its native await. Reopening the same comic must not
// let an old success or failure mutate the new session.
{
  const schedule = extractFunction(appSource, 'scheduleReaderCacheWindowUpdate');
  let timerCallback;
  let timerId = 0;
  let resolveCache;
  let rejectCache;
  const cacheCalls = [];
  const context = {
    READER_CACHE_UPDATE_DELAY_MS: 0,
    state: {
      currentComic: { id: 'comic-cache', sourceId: 'local:A', preloadGeneration: 3 },
      currentPageIndex: 1,
      readerCacheWindowPage: null,
      readerCacheReadyPage: null,
      readerCacheWindowTimer: null,
      readerCacheWindowToken: 0,
      readerOperation: 8,
      renderGeneration: 12,
    },
    eAPI: {
      updateReaderCacheWindow: (...args) => new Promise((resolve, reject) => {
        cacheCalls.push(args);
        resolveCache = resolve;
        rejectCache = reject;
      }),
    },
    isBuiltInDemoComic: () => false,
    clearTimeout() {},
    setTimeout: callback => { timerCallback = callback; timerId += 1; return timerId; },
    console: { warn() {} },
  };
  vm.runInNewContext(`${extractFunction(appSource, 'getComicSourceId')}\n${schedule}\nglobalThis.scheduleReaderCacheWindowUpdate = scheduleReaderCacheWindowUpdate;`, context);
  context.scheduleReaderCacheWindowUpdate();
  const firstRequest = timerCallback();
  assert.deepEqual(cacheCalls[0], ['comic-cache', 1, 'local:A'],
    'cache-window request carries the active source identity');
  context.state.currentComic = { id: 'comic-cache', sourceId: 'smb:B', preloadGeneration: 4 };
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
  context.state.currentComic = { id: 'comic-cache', sourceId: 'smb:B', preloadGeneration: 4 };
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

// Recovery belongs inside the scrolling shelf, not in the workspace grid.
{
  let panel;
  let retryCalls = 0;
  let discardCalls = 0;
  const contentArea = { prepend: node => { panel = node; } };
  const workspace = { prepend: () => { throw new Error('recovery must not become a workspace grid item'); } };
  const failures = new Map([['comic-a', { id: 'comic-a', sourceId: 'local:test' }]]);
  const document = {
    getElementById: () => panel,
    createElement: tag => ({
      tag,
      style: { setProperty(name, value) { this[name] = value; } },
      classList: {
        values: new Set(),
        add(name) { this.values.add(name); },
        toggle(name, enabled) { if (enabled) this.values.add(name); else this.values.delete(name); },
      },
      children: [],
      setAttribute() {},
      addEventListener: function (_event, callback) { this.click = callback; },
      append: function (...children) { this.children.push(...children); },
      replaceChildren: function (...children) { this.children = children; },
      querySelector: function (selector) {
        for (const child of this.children) {
          if (selector === 'button' ? child.tag === 'button' : child.className?.split(' ').includes(selector.slice(1))) return child;
          const nested = child.querySelector(selector);
          if (nested) return nested;
        }
        return null;
      },
    }),
  };
  const context = {
    document,
    elements: { contentArea, libraryWorkspace: workspace },
    readReadingProgressFailures: () => failures,
    readingProgressFailuresStorageReliable: true,
    readingProgressRetryPromise: null,
    eAPI: { recoverReadingProgress() {} },
    readerText: (text, values = {}) => text.replace(/\{([a-zA-Z]+)\}/g, (token, key) => values[key] ?? token),
    retryFailedReadingProgressSnapshots: () => { retryCalls += 1; },
    discardFailedReadingProgressSnapshots: () => { discardCalls += 1; },
    clearReadingProgressFailureEntry(snapshot) { context.clearCalls = (context.clearCalls || []).concat(snapshot); },
  };
  const recoveryFunctions = [
    'readingProgressKey',
    'readingProgressFailureKey',
    'sanitizeReadingProgressDisplayText',
    'decodeReadingProgressIdFilename',
    'readingProgressComicCandidates',
    'readingProgressCandidatePath',
    'readingProgressCandidateLabel',
    'readingProgressCandidateSourceType',
    'readingProgressSourceBookmarkId',
    'sanitizeReadingProgressSourceName',
    'readingProgressExternalSourceNames',
    'readingProgressCandidateSourceLabel',
    'readingProgressCandidateDisplay',
    'readingProgressCandidateSourceContext',
    'readingProgressDetail',
    'readingProgressNeedsManualCheck',
    'readingProgressSnapshotCanRetry',
    'renderReadingProgressRecovery',
  ].map(name => extractFunction(appSource, name)).join('\n');
  vm.runInNewContext(`${recoveryFunctions}\nglobalThis.render = renderReadingProgressRecovery;`, context);
  context.render();
  assert.match(panel.querySelector('.reading-progress-recovery-message').textContent, /有 1 本漫畫的閱讀進度尚未保存。/);
  assert.match(panel.querySelector('.reading-progress-recovery-message').textContent, /缺少驗證資訊/,
    'tokenless old journals explain that automatic recovery is unavailable');
  assert.equal(panel.hidden, false);
  context.state = { scanStatus: { isScanning: true }, comics: [] };
  context.render();
  assert.match(panel.querySelector('.reading-progress-recovery-message').textContent, /候選可能變動/);
  panel.children[1].click();
  assert.equal(retryCalls, 1, 'recovery action still retries saving');
  panel.children[2].click();
  assert.equal(discardCalls, 1, 'recovery exposes a discard action');
  failures.set('comic-a', { id: 'comic-a' });
  context.render();
  assert.equal(panel.children[1].disabled, true, 'a source-less legacy entry cannot be retried automatically');
  assert.match(panel.querySelector('.reading-progress-recovery-message').textContent, /無法確認來源/);
  failures.clear();
  const manual = {
    id: 'comic-expired', sourceId: 'local:test', recoveryToken: 'old-token',
    currentPage: 8, totalPages: 24, sequence: 12, recoveryStatus: 'manual-check',
  };
  const retryable = {
    id: 'comic-online', sourceId: 'smb:v1:nas', recoveryToken: 'active-token',
    currentPage: 2, totalPages: 10, sequence: 13,
  };
  failures.set('expired', manual);
  failures.set('retryable', retryable);
  context.state = { scanStatus: { isScanning: false }, comics: [] };
  context.render();
  assert.equal(panel.children[1].disabled, false,
    'a manual-check entry does not disable retry for another recoverable item');
  assert.match(panel.querySelector('.reading-progress-recovery-message').textContent, /原生驗證資訊已失效/);
  assert.match(panel.querySelector('.reading-progress-recovery-entries').children[0].children[0].textContent, /第 9 \/ 24 頁/);
  const manualEntryButton = panel.querySelector('.reading-progress-clear-entry');
  assert.ok(manualEntryButton, 'each pending item exposes an individual clear action');
  context.state.scanStatus.isScanning = true;
  context.render();
  assert.equal(panel.querySelector('.reading-progress-clear-entry'), manualEntryButton,
    'scan progress updates preserve recovery button nodes and keyboard focus');
  manualEntryButton.click();
  assert.equal(context.clearCalls[0], manual, 'individual clear action is bound to its displayed snapshot');
  failures.delete('retryable');
  context.render();
  assert.equal(panel.children[1].disabled, true, 'all manual-check entries leave the retry button disabled');
  failures.clear();
  context.render();
  assert.equal(panel.hidden, true, 'recovery disappears once all failures are cleared');
  assert.match(featureMessagesSource, /"部分進度的原生驗證資訊已失效[^\n]+\n\s+"en": "Some progress can no longer be verified/);
  assert.match(featureMessagesSource, /"ja": "一部の進捗はアプリで確認できなくなりました/);
}

// Recovery details identify exact source matches without persisting private
// titles/paths. Legacy source-less entries show candidates as unconfirmed, or
// a strictly decoded terminal filename when the shelf has no candidate.
{
  const functions = [
    'sanitizeReadingProgressDisplayText',
    'decodeReadingProgressIdFilename',
    'readingProgressComicCandidates',
    'readingProgressCandidatePath',
    'readingProgressCandidateLabel',
    'readingProgressCandidateSourceType',
    'readingProgressSourceBookmarkId',
    'sanitizeReadingProgressSourceName',
    'readingProgressExternalSourceNames',
    'readingProgressCandidateSourceLabel',
    'readingProgressCandidateDisplay',
    'readingProgressCandidateSourceContext',
    'readingProgressDetail',
  ].map(name => extractFunction(appSource, name)).join('\n');
  const context = {
    state: {
      comics: [
        { id: 'shared', title: 'Same Book', relativePath: 'local/book.cbz', sourceId: 'local:one' },
        { id: 'shared', title: 'Same Book', relativePath: 'remote/book.cbz', sourceId: 'smb:two' },
      ],
    },
    isBuiltInDemoComic: () => false,
    BUILT_IN_DEMO_SOURCE_ID: 'builtin:landscapes',
    getComicSourceId: comic => comic?.sourceId || '',
    readerText: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`)),
  };
  vm.runInNewContext(`${functions}\nglobalThis.detail = readingProgressDetail;\nglobalThis.decode = decodeReadingProgressIdFilename;`, context);

  const exact = context.detail({ id: 'shared', sourceId: 'local:one', currentPage: 2, totalPages: 10 });
  assert.match(exact, /Same Book/);
  assert.match(exact, /第 3 \/ 10 頁/);

  const collision = context.detail({ id: 'shared', currentPage: 0, totalPages: 2757 });
  assert.match(collision, /來源未確認/);
  assert.match(collision, /可能候選（2，仍需確認）/);
  assert.equal((collision.match(/Same Book/g) || []).length, 2, 'same-title candidates remain separate');
  assert.match(collision, /本機/);
  assert.match(collision, /SMB/);
  assert.match(collision, /local\/book\.cbz/);
  assert.match(collision, /remote\/book\.cbz/);
  assert.match(collision, /第 1 \/ 2757 頁/);

  context.state.comics.push({ id: 'opaque', title: 'Opaque Book', relativePath: 'other/book.cbz', sourceId: 'secret-source-token' });
  const opaque = context.detail({ id: 'opaque', currentPage: 1, totalPages: 4 });
  assert.match(opaque, /其他來源/);
  assert.doesNotMatch(opaque, /secret-source-token/);

  context.state.comics = [
    { id: 'same-type', title: 'Same Local Book', relativePath: 'one/book.cbz', sourceId: 'local:one' },
    { id: 'same-type', title: 'Same Local Book', relativePath: 'two/book.cbz', sourceId: 'local:two' },
  ];
  const sameType = context.detail({ id: 'same-type', currentPage: 0, totalPages: 2 });
  assert.match(sameType, /可能候選（2，仍需確認）/);
  assert.equal((sameType.match(/本機/g) || []).length, 2, 'same-type sources remain visible as separate candidates');

  const externalBookmark = 'bookmark://folder-a';
  const externalSourceId = `external:${btoa(externalBookmark).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
  context.btoa = btoa;
  context.readExternalBookmarks = () => [{ bookmark: externalBookmark, name: '外接來源 A' }];
  context.state.comics = [{ id: 'external', title: 'External Book', relativePath: 'same/book.cbz', sourceId: externalSourceId }];
  const external = context.detail({ id: 'external', currentPage: 0, totalPages: 2 });
  assert.match(external, /外接來源 A/);
  assert.doesNotMatch(external, /bookmark:\/\/folder-a/);
  context.readExternalBookmarks = () => [{ bookmark: externalBookmark, name: '/private/secret/Folder' }];
  const externalPrivateName = context.detail({ id: 'external', currentPage: 0, totalPages: 2 });
  assert.doesNotMatch(externalPrivateName, /private\/secret|Folder/);

  const encodedPath = Buffer.from('private/library/old-book.cbz').toString('base64url');
  assert.equal(context.decode(encodedPath), 'old-book.cbz', 'legacy IDs expose only the terminal filename');
  const decodedFallback = context.detail({ id: encodedPath, currentPage: 0, totalPages: 2757 });
  assert.match(decodedFallback, /old-book\.cbz/);
  assert.doesNotMatch(decodedFallback, /private\/library/);
  const unknownPageCount = context.detail({ id: encodedPath, currentPage: 0, totalPages: 0 });
  assert.match(unknownPageCount, /第 \? \/ \? 頁/);

  const bidiId = Buffer.from('safe\u202Ename.cbz').toString('base64url');
  assert.equal(context.decode(bidiId), 'safename.cbz', 'bidi controls are removed from decoded filenames');

  const malformedUtf8 = Buffer.from([0xff, 0xfe]).toString('base64url');
  assert.equal(context.decode(malformedUtf8), '', 'invalid UTF-8 IDs stay unknown');
  assert.match(context.detail({ id: malformedUtf8, currentPage: 0, totalPages: 2 }), /未知作品/);

  const xssId = Buffer.from('<img src=x onerror=alert(1)>.cbz').toString('base64url');
  assert.match(context.detail({ id: xssId, currentPage: 0, totalPages: 1 }), /<img src=x/);
  const recoverySource = extractFunction(appSource, 'renderReadingProgressRecovery');
  assert.match(recoverySource, /message\.textContent/);
  assert.doesNotMatch(recoverySource, /message\.innerHTML/);
  assert.match(recoverySource, /if \(message\.textContent !== nextMessageText\)/);
  assert.match(recoverySource, /const comicIndex = new Map\(\)/);
  assert.match(recoverySource, /readingProgressDetail\(snapshot, recoveryContext\)/);
  assert.doesNotMatch(recoverySource, /ResizeObserver|marquee/);
  assert.match(styleSource, /\.reading-progress-recovery-message\s*\{[\s\S]*white-space:\s*pre-line/);
  assert.doesNotMatch(styleSource, /reading-progress-marquee|marquee-ready|is-overflowing/);
  assert.match(styleSource, /prefers-reduced-motion:\s*reduce/);

  assert.match(featureMessagesSource, /"未保存進度：\{name\}（\{pages\}）"/);
  assert.match(featureMessagesSource, /"未保存進度：來源未確認；可能候選：\{candidates\}（\{pages\}）"/);
  assert.match(featureMessagesSource, /"未保存進度：來源未確認；可能候選（\{count\}，仍需確認）：\{candidates\}（\{pages\}）"/);
  assert.match(featureMessagesSource, /"未保存進度：未知作品（來源未確認；\{pages\}）"/);
  assert.match(featureMessagesSource, /"書架仍在掃描，候選可能變動。"/);
  assert.match(featureMessagesSource, /"本機"|"SMB"|"Files"|"其他來源"/);
}

// Explicit discard clears only pending snapshots and cannot be undone by an
// older retry finishing after the user confirms it.
{
  let confirmed = false;
  let storageBlocked = false;
  let alertCount = 0;
  let rejectSave;
  const saved = new Map();
  const old = { id: 'deleted-comic', currentPage: 3, totalPages: 10, sequence: 40 };
  const context = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [],
    readingProgressFailures: new Map([[JSON.stringify(['\u0000deleted-comic', '']), old]]),
    readingProgressFailuresStorageReliable: true,
    discardedReadingProgressIntents: new Map(),
    latestQueuedReadingProgressById: new Map(),
    readReadingProgressFailures() { return context.readingProgressFailures; },
    renderReadingProgressRecovery() {},
    readerText: text => text,
    window: { confirm: () => confirmed, alert: () => { alertCount += 1; } },
    localStorage: { setItem(key, value) { if (storageBlocked) throw new Error('storage blocked'); saved.set(key, value); } },
    eAPI: { saveProgress: () => new Promise((_, reject) => { rejectSave = reject; }) },
    waitForReadingProgressSave: async (snapshot, recovery = false) => {
      const save = recovery && !snapshot.id.startsWith('photos:')
        && typeof context.eAPI.recoverReadingProgress === 'function'
        ? context.eAPI.recoverReadingProgress
        : context.eAPI.saveProgress;
      await save(snapshot);
      return { timedOut: false };
    },
    console: { error() {} },
  };
  const functions = [
    'normalizeReadingProgressSnapshot', 'readingProgressIntentSequence', 'writeReadingProgressFailures',
    'readingProgressKey', 'readingProgressFailureKey', 'discardFailedReadingProgressSnapshots', 'rememberFailedReadingProgressSnapshot', 'persistReadingProgressSnapshot',
  ].map(name => extractFunction(appSource, name)).join('\n');
  vm.runInNewContext(`${functions}\nglobalThis.discard = discardFailedReadingProgressSnapshots;\nglobalThis.persist = persistReadingProgressSnapshot;\nglobalThis.remember = rememberFailedReadingProgressSnapshot;`, context);
  context.discard();
  assert.equal(context.readingProgressFailures.size, 1, 'cancel keeps pending progress');
  confirmed = true;
  storageBlocked = true;
  context.discard();
  assert.equal(context.readingProgressFailures.size, 1, 'storage failure keeps the pending entry');
  assert.equal(alertCount, 1);
  storageBlocked = false;
  const retry = context.persist({ ...old, sequence: 41, intentSequence: 40 }, 40);
  context.discard();
  assert.equal(saved.get('gai:readingProgressFailures'), '[]');
  assert.equal(context.readingProgressFailures.size, 0);
  rejectSave(new Error('old retry failed'));
  await retry;
  assert.equal(context.readingProgressFailures.size, 0, 'late retry cannot restore discarded progress');
  const newer = { ...old, currentPage: 5, sequence: 42 };
  context.remember(newer);
  assert.deepEqual(JSON.parse(saved.get('gai:readingProgressFailures')), [newer], 'new progress is still recoverable');
}

// Native progress rejection retries a bounded number of times, leaves a
// durable id/page/count/sequence journal, exposes manual retry, and lets a
// newer snapshot replace an older failed one.
{
  const functions = [
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressKey'),
    extractFunction(appSource, 'readingProgressFailureKey'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'readingProgressNeedsManualCheck'),
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
    discardedReadingProgressIntents: new Map(),
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
    waitForReadingProgressSave: async (snapshot, recovery = false) => {
      const save = recovery && !snapshot.id.startsWith('photos:')
        && typeof context.eAPI.recoverReadingProgress === 'function'
        ? context.eAPI.recoverReadingProgress
        : context.eAPI.saveProgress;
      await save(snapshot);
      return { timedOut: false };
    },
    console: { error() {} },
  };
  vm.runInNewContext(`${functions}\nglobalThis.enqueueReadingProgressSnapshot = enqueueReadingProgressSnapshot;\nglobalThis.retryFailedReadingProgressSnapshots = retryFailedReadingProgressSnapshots;\nglobalThis.persistReadingProgressSnapshot = persistReadingProgressSnapshot;\nglobalThis.rememberFailedReadingProgressSnapshot = rememberFailedReadingProgressSnapshot;\nglobalThis.writeReadingProgressFailures = writeReadingProgressFailures;\nglobalThis.readingProgressFailureKey = readingProgressFailureKey;`, context);

  const failed = { id: 'comic-progress', sourceId: 'local:test', currentPage: 7, totalPages: 20, sequence: 41 };
  failed.recoveryToken = 'token-progress';
  await context.enqueueReadingProgressSnapshot(failed);
  assert.equal(attempts, 3, 'progress save uses bounded automatic retry');
  const journalAfterFailure = JSON.parse(storage.get('gai:readingProgressFailures'));
  assert.deepEqual(journalAfterFailure, [failed], 'failed snapshot durably retains its recovery token');
  assert.ok(recoveryRenders > 0, 'a failed snapshot keeps the visible recovery path active');

  shouldSucceed = true;
  assert.equal(await context.retryFailedReadingProgressSnapshots(), true, 'manual retry clears a successful failure');
  assert.equal(attempts, 4, 'manual retry uses one queued native attempt after automatic retry');
  assert.ok(savedSequences.at(-1) > failed.sequence, 'manual retry allocates a native sequence newer than the journal');
  assert.equal(storage.get('gai:readingProgressFailures'), '[]');

  for (let index = 0; index < 25; index += 1) {
    context.rememberFailedReadingProgressSnapshot({
      id: `comic-${index}`,
      sourceId: 'local:test',
      currentPage: index,
      totalPages: 30,
      sequence: 100 + index,
    });
  }
  assert.equal(JSON.parse(storage.get('gai:readingProgressFailures')).length, 25, 'all pending comics remain in the durable journal');

  const deferred = { id: 'comic-deferred', sourceId: 'local:test', currentPage: 4, totalPages: 8, sequence: 200 };
  context.readingProgressFailures = new Map([[context.readingProgressFailureKey(deferred), deferred]]);
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

  const oldSnapshot = { id: 'comic-race', sourceId: 'local:test', currentPage: 1, totalPages: 4, sequence: 300 };
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

// Expired/mismatched native reader evidence is terminal for that exact
// recovery token. Keep the page journal visible for manual recovery, skip it
// on later retries, and continue retrying other books in the same batch.
{
  const functions = [
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressKey'),
    extractFunction(appSource, 'readingProgressFailureKey'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'readingProgressNeedsManualCheck'),
    extractFunction(appSource, 'readingProgressSnapshotCanRetry'),
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
  let sequence = 30;
  let manualAttempts = 0;
  let transientAttempts = 0;
  let transientReady = false;
  const context = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SEQUENCE_KEY: 'gai:readingProgressSequence',
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [0],
    readingProgressFailuresLoaded: false,
    readingProgressFailures: new Map(),
    readingProgressFailuresStorageReliable: true,
    latestQueuedReadingProgressById: new Map(),
    discardedReadingProgressIntents: new Map(),
    readingProgressRetryPromise: null,
    readingProgressSaveSequence: 30,
    readingProgressSaveQueue: Promise.resolve(),
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    sessionStorage: { setItem: (key, value) => storage.set(key, value) },
    document: undefined,
    renderReadingProgressRecovery() {},
    waitForReadingProgressRetry: async () => {},
    nextReadingProgressSaveSequence: () => ++sequence,
    eAPI: {
      recoverReadingProgress: async snapshot => {
        if (snapshot.id === 'expired-book') {
          manualAttempts += 1;
          throw new Error('READING_PROGRESS_RECOVERY_MANUAL_CHECK: stale token');
        }
        transientAttempts += 1;
        if (!transientReady) throw new Error('SMB connection timeout');
      },
    },
    waitForReadingProgressSave: async (snapshot, recovery = false) => {
      const save = recovery ? context.eAPI.recoverReadingProgress : context.eAPI.saveProgress;
      await save(snapshot);
      return { timedOut: false };
    },
    console: { error() {} },
  };
  vm.runInNewContext(`${functions}\nglobalThis.retry = retryFailedReadingProgressSnapshots;\nglobalThis.remember = rememberFailedReadingProgressSnapshot;\nglobalThis.failures = readReadingProgressFailures;`, context);

  const expired = {
    id: 'expired-book', sourceId: 'local:library', recoveryToken: 'old-native-token',
    currentPage: 8, totalPages: 24, sequence: 31,
  };
  const transient = {
    id: 'nas-book', sourceId: 'smb:v1:nas', recoveryToken: 'active-native-token',
    currentPage: 3, totalPages: 12, sequence: 32,
  };
  context.remember(expired);
  context.remember(transient);

  assert.equal(await context.retry(), false, 'manual-check item keeps the aggregate recovery action pending');
  assert.equal(manualAttempts, 1, 'native evidence failure is classified without repeated attempts');
  assert.equal(transientAttempts, 2, 'transient NAS failure still receives bounded retries');
  assert.equal(context.failures().get(context.readingProgressFailureKey(expired)).recoveryStatus, 'manual-check');
  assert.equal(context.failures().get(context.readingProgressFailureKey(transient)).recoveryStatus, undefined,
    'ordinary connection errors stay retryable');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')).map(entry => [entry.id, entry.currentPage]), [
    ['nas-book', 3], ['expired-book', 8],
  ], 'both page numbers stay in the durable journal');
  assert.equal(context.readingProgressSnapshotCanRetry(
    context.failures().get(context.readingProgressFailureKey(expired))), false);
  assert.equal(context.readingProgressSnapshotCanRetry(transient), true);

  transientReady = true;
  assert.equal(await context.retry(), false, 'only the manual-check journal remains after transient recovery succeeds');
  assert.equal(manualAttempts, 1, 'later retry skips the permanently invalid token');
  assert.equal(transientAttempts, 3, 'later retry continues for the recoverable entry');
  assert.equal(context.failures().size, 1);
  assert.equal(context.failures().get(context.readingProgressFailureKey(expired)).recoveryStatus, 'manual-check');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')).map(entry => entry.id), ['expired-book']);
}

// Deferred queue regression: a newer native intent must win over an older
// journal retry whether it was queued first or appears before retry execution.
{
  const functions = [
    extractFunction(appSource, 'normalizeReadingProgressSnapshot'),
    extractFunction(appSource, 'readingProgressKey'),
    extractFunction(appSource, 'readingProgressFailureKey'),
    extractFunction(appSource, 'readingProgressIntentSequence'),
    extractFunction(appSource, 'readingProgressNeedsManualCheck'),
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
    discardedReadingProgressIntents: new Map(),
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
    waitForReadingProgressSave: async (snapshot, recovery = false) => {
      const save = recovery && !snapshot.id.startsWith('photos:')
        && typeof context.eAPI.recoverReadingProgress === 'function'
        ? context.eAPI.recoverReadingProgress
        : context.eAPI.saveProgress;
      await save(snapshot);
      return { timedOut: false };
    },
    console: { error() {} },
  };
  vm.runInNewContext(`${functions}
    globalThis.enqueueReadingProgressSnapshot = enqueueReadingProgressSnapshot;
    globalThis.retryFailedReadingProgressSnapshots = retryFailedReadingProgressSnapshots;
    globalThis.readingProgressFailureKey = readingProgressFailureKey;`, context);

  const oldJournal = { id: 'comic-deferred-order', sourceId: 'local:test', currentPage: 1, totalPages: 20, sequence: 100 };
  context.readingProgressFailures = new Map([[context.readingProgressFailureKey(oldJournal), oldJournal]]);
  context.writeReadingProgressFailures();
  const newerQueued = context.enqueueReadingProgressSnapshot({
    id: oldJournal.id, sourceId: oldJournal.sourceId, currentPage: 9, totalPages: 20, sequence: 200,
  });
  await new Promise(resolve => setImmediate(resolve));
  const skippedRetry = context.retryFailedReadingProgressSnapshots();
  assert.equal(await skippedRetry, false, 'retry remains pending while newer queued native intent is unresolved');
  assert.deepEqual(calls.map(snapshot => snapshot.currentPage), [9], 'newer queued intent runs without an older retry');
  releaseNewIntent();
  await newerQueued;
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [], 'newer native success clears the old journal');

  calls.length = 0;
  context.readingProgressFailures = new Map([[context.readingProgressFailureKey(oldJournal), oldJournal]]);
  context.writeReadingProgressFailures();
  context.latestQueuedReadingProgressById = new Map();
  let releaseQueue;
  context.readingProgressSaveQueue = new Promise(resolve => { releaseQueue = resolve; });
  const queuedRetry = context.retryFailedReadingProgressSnapshots();
  await new Promise(resolve => setImmediate(resolve));
  const newerIntent = context.enqueueReadingProgressSnapshot({
    id: oldJournal.id, sourceId: oldJournal.sourceId, currentPage: 9, totalPages: 20, sequence: 202,
  });
  releaseQueue();
  await newerIntent;
  assert.equal(await queuedRetry, false, 'retry reports unresolved journal until the newer intent finishes');
  assert.deepEqual(calls.map(snapshot => snapshot.currentPage), [9], 'queue execution skips retry after a newer intent appears');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [], 'newer intent success removes the retry journal');

  calls.length = 0;
  context.readingProgressFailures = new Map([[context.readingProgressFailureKey(oldJournal), oldJournal]]);
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

  // Queue coalescing and recovery serialization are token-scoped too. A
  // current open must not absorb a retry belonging to an older open token.
  const oldVersion = { ...oldJournal, recoveryToken: 'token-old', sequence: 400 };
  context.readingProgressFailures = new Map([[context.readingProgressFailureKey(oldVersion), oldVersion]]);
  context.writeReadingProgressFailures();
  context.latestQueuedReadingProgressById = new Map();
  const recoveryCalls = [];
  let releaseCurrentVersion;
  const currentVersionGate = new Promise(resolve => { releaseCurrentVersion = resolve; });
  context.eAPI.saveProgress = async snapshot => {
    calls.push(snapshot);
    await currentVersionGate;
  };
  context.eAPI.recoverReadingProgress = async snapshot => { recoveryCalls.push(snapshot); };
  calls.length = 0;
  const currentVersionQueued = context.enqueueReadingProgressSnapshot({
    ...oldVersion, recoveryToken: 'token-new', currentPage: 8, sequence: 500,
  });
  await new Promise(resolve => setImmediate(resolve));
  const oldVersionRetry = context.retryFailedReadingProgressSnapshots();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.latestQueuedReadingProgressById.size, 2,
    'same comic with different open tokens occupies separate queued versions');
  assert.deepEqual(calls.map(snapshot => snapshot.recoveryToken), ['token-new'],
    'the current token save runs without coalescing the old version retry');
  releaseCurrentVersion();
  await Promise.all([currentVersionQueued, oldVersionRetry]);
  assert.deepEqual(recoveryCalls.map(snapshot => snapshot.recoveryToken), ['token-old'],
    'the old journal retry keeps its own recovery token through the bridge call');
  assert.deepEqual(JSON.parse(storage.get('gai:readingProgressFailures')), [],
    'the exact old-version retry clears only its journal after native success');
}
// Individual confirmation preserves other tokens, handles storage failure,
// and fences a late failure from resurrecting a removed entry.
{
  const entries = new Map();
  let stored;
  let confirm = false;
  let failStorage = false;
  const context = {
    READING_PROGRESS_FAILURES_KEY: 'journal',
    readingProgressDetail: () => 'Book A, page 6 / 10',
    discardedReadingProgressIntents: new Map(),
    discardedReadingProgressFailureIntents: new Map(),
    readingProgressFailuresStorageReliable: true,
    readReadingProgressFailures: () => entries,
    renderReadingProgressRecovery() {},
    writeReadingProgressFailures() {},
    readerText: text => text,
    localStorage: { setItem(_key, value) { if (failStorage) throw new Error('storage'); stored = value; } },
    window: { confirm: text => { assert.match(text, /Book A, page 6 \/ 10/); return confirm; }, alert() {} },
  };
  const names = ['normalizeReadingProgressSnapshot', 'readingProgressKey', 'readingProgressFailureKey',
    'readingProgressIntentSequence', 'clearReadingProgressFailureEntry', 'rememberFailedReadingProgressSnapshot'];
  vm.runInNewContext(names.map(name => extractFunction(appSource, name)).join('\n'), context);
  const first = { id: 'same', sourceId: 'local:test', currentPage: 5, totalPages: 10, sequence: 1, recoveryToken: 'old' };
  const other = { ...first, sequence: 2, recoveryToken: 'new' };
  entries.set(context.readingProgressFailureKey(first), first);
  entries.set(context.readingProgressFailureKey(other), other);
  assert.equal(context.clearReadingProgressFailureEntry(first), false);
  assert.equal(entries.size, 2, 'cancel preserves both entries');
  confirm = true;
  failStorage = true;
  assert.equal(context.clearReadingProgressFailureEntry(first), false);
  assert.equal(entries.size, 2, 'failed durable removal retains session entries');
  failStorage = false;
  assert.equal(context.clearReadingProgressFailureEntry(first), true);
  assert.deepEqual(JSON.parse(stored), [other]);
  assert.equal(entries.size, 1);
  context.rememberFailedReadingProgressSnapshot(first);
  assert.equal(entries.size, 1, 'late old failure cannot resurrect a confirmed removal');
  const newer = { ...other, sequence: 3, currentPage: 7 };
  entries.set(context.readingProgressFailureKey(other), newer);
  assert.equal(context.clearReadingProgressFailureEntry(other), false, 'stale UI cannot clear newer progress');
  assert.equal(entries.get(context.readingProgressFailureKey(other)), newer);
}
console.log('PASS: close flush/queue, decode failure retry/load save, sequence compatibility, and partial import retry');
