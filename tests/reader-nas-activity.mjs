import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.ok(bodyStart >= 2, `missing function body ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

let timerSequence = 0;
const timers = new Map();
const clearedTimers = [];
const events = [];
const activeSnapshots = [];
const forceHideCalls = [];
const opened = new Map();
const state = {
  comics: [
    { id: 'comic-a', sourceId: 'smb:library' },
    { id: 'comic-b', sourceId: 'smb:library' },
  ],
  currentComic: null,
  currentComicPages: [],
  pendingComicId: null,
  pendingComicSourceId: '',
  readerOperation: 0,
  renderGeneration: 0,
  readerClosePromise: Promise.resolve(),
  aiExplainCache: new Map(),
  readerReadyPages: new Set(),
  readerFailedPages: new Set(),
};
const elements = {
  readerOverlay: {
    style: { display: 'none' },
    classList: { add() {}, remove() {} },
    contains: () => false,
    setAttribute() {},
  },
  readerComicTitle: { textContent: '' },
  readerAiToggle: { hidden: false },
  btnAiExplain: { hidden: false },
  btnAiAutoExplain: { hidden: false },
  pagesContainer: { replaceChildren() {} },
  statusLoading: { style: { display: 'none' } },
};
function setTimer(callback, delay) {
  const timer = { id: ++timerSequence, callback, delay, cleared: false };
  timers.set(timer.id, timer);
  return timer;
}
function clearTimer(timer) {
  if (!timer) return;
  timer.cleared = true;
  clearedTimers.push(timer);
  events.push(`clear:${timer.id}`);
}
const context = {
  state,
  elements,
  discoveryOpening: false,
  discoveryReaderContext: null,
  document: { activeElement: null, body: { style: {}, classList: { add() {}, remove() {} } } },
  window: {},
  eAPI: {
    openComic(id) {
      const request = deferred();
      opened.set(id, request);
      return request.promise;
    },
  },
  getSelectedComic: () => null,
  getComicSourceId: comic => comic?.sourceId || comic?.source_id || '',
  getComicSourceKey: comic => comic?.sourceId || '',
  createDirectoryLocation: (...values) => values,
  getParentPath: value => value,
  setSelectedComic() {},
  captureLibraryViewContext: () => null,
  isComicOffline: () => false,
  isBuiltInDemoComic: () => false,
  readReadingProgressFailures: () => new Map(),
  readingProgressFailureKey: () => '',
  adoptReadingProgressSequenceFloor() {},
  startReaderHistoryRecordingSession() {},
  endReaderHistoryRecordingSession() {},
  releasePreloadedImages() {},
  setAutoPageExplanation() {},
  updateReaderUiControls() {},
  applyFitMode() {},
  showReaderDiscoveryHint() {},
  hideReaderContextMenu() {},
  clearReaderPageNotice() {},
  renderPages() {},
  triggerControlsActive() {},
  focusReaderEntry() {},
  restoreReaderFocus() {},
  clearReaderImageError() {},
  showLibrarySourceRecovery() {},
  scheduleCoverLoadDrain() {},
  syncLibraryBackgroundActivity() {
    activeSnapshots.push(Boolean(state.smbDownloadActive));
    events.push('sync');
  },
  showLoader() { events.push('showLoader'); },
  hideLoader() { events.push('hideLoader'); },
  forceHideLoader() { forceHideCalls.push(state.readerOperation); events.push('forceHideLoader'); },
  setTimeout: setTimer,
  clearTimeout: clearTimer,
  alert(message) { throw new Error(`unexpected reader alert: ${message}`); },
  readerText: value => value,
  console: { error() {} },
};

vm.runInNewContext([
  extractFunction(appSource, 'openReader'),
  extractFunction(appSource, 'startSmbDownloadActivity'),
  extractFunction(appSource, 'finishSmbDownloadActivity'),
  'globalThis.openReader = openReader;',
  'globalThis.startSmbDownloadActivity = startSmbDownloadActivity;',
  'globalThis.finishSmbDownloadActivity = finishSmbDownloadActivity;',
].join('\n'), context);

const flushMicrotasks = async () => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
};
const readerData = id => ({
  id,
  sourceId: 'smb:library',
  title: id,
  pages: [`${id}-page-1`],
  progress: { currentPage: 0 },
  isDir: false,
  filenames: [],
});

// Both opens remain inside their actual openReader calls while eAPI.openComic is pending.
const openA = context.openReader('comic-a');
await flushMicrotasks();
assert.ok(opened.has('comic-a'), 'openReader A must reach its pending native openComic');
const openB = context.openReader('comic-b');
await flushMicrotasks();
assert.ok(opened.has('comic-b'), 'openReader B must reach its pending native openComic');
assert.equal(state.readerOperation, 2, 'B supersedes A as the current reader operation');

// Use the real start helper to install B's NAS activity, id, count, and timeout.
context.startSmbDownloadActivity({ id: 'download-b' });
const timerB = state._smbLoaderTimer;
assert.ok(timerB, 'B NAS activity installs its timeout');
assert.equal(state.smbDownloadId, 'download-b');
assert.equal(state.smbDownloadActive, true);

// A completes after B started. Its real openReader body returns at the operation guard,
// but its finally must not mutate B's SMB lifecycle.
opened.get('comic-a').resolve(readerData('comic-a'));
await openA;
assert.deepEqual(clearedTimers, [], 'stale open A must not clear B\'s timeout');
assert.equal(state._smbLoaderTimer, timerB, 'stale open A must leave B\'s timer installed');
assert.equal(state.smbDownloadActive, true, 'stale open A must leave NAS activity active');
assert.equal(state.smbDownloadId, 'download-b');
assert.equal(state.smbDownloadCount, 1);
assert.deepEqual(activeSnapshots, [true], 'stale open A must not publish a false idle state');
assert.deepEqual(events, ['showLoader', 'showLoader', 'sync'], 'stale open A must not hide B\'s loader');

// B is still current; its successful completion must release its own timer and activity,
// then preserve the established sync-before-hideLoader ordering.
opened.get('comic-b').resolve(readerData('comic-b'));
await openB;
assert.deepEqual(clearedTimers, [timerB], 'current open B clears its own NAS timeout');
assert.equal(state._smbLoaderTimer, null);
assert.equal(state.smbDownloadActive, false);
assert.equal(state.smbDownloadId, '');
assert.equal(state.smbDownloadCount, 0);
assert.deepEqual(activeSnapshots, [true, false], 'B publishes the completed idle state');
assert.deepEqual(events.slice(-3), [`clear:${timerB.id}`, 'sync', 'hideLoader']);
assert.equal(state.currentComic?.id, 'comic-b', 'B remains the active reader');

// Real end handling is keyed by native download id: an old A end cannot finish B.
context.startSmbDownloadActivity({ id: 'download-A' });
const timerA = state._smbLoaderTimer;
context.startSmbDownloadActivity({ id: 'download-B' });
const timerForB = state._smbLoaderTimer;
assert.equal(timerA.cleared, true, 'a new native download replaces the prior safety timeout');
assert.equal(context.finishSmbDownloadActivity({ id: 'download-A' }), false,
  'a late End for a different id is ignored');
assert.equal(state.smbDownloadActive, true);
assert.equal(state.smbDownloadId, 'download-B');
assert.equal(state._smbLoaderTimer, timerForB, 'late End cannot clear B\'s timeout');
assert.equal(timerForB.cleared, false);
assert.equal(context.finishSmbDownloadActivity({ id: 'download-B' }), true);
assert.equal(state.smbDownloadActive, false);
assert.equal(state._smbLoaderTimer, null);
assert.equal(timerForB.cleared, true, 'matching End clears its active timeout');

// Same-id starts are reference-counted: one End keeps the shared download active.
context.startSmbDownloadActivity({ id: 'download-same' });
const firstSameTimer = state._smbLoaderTimer;
context.startSmbDownloadActivity({ id: 'download-same' });
const secondSameTimer = state._smbLoaderTimer;
assert.equal(state.smbDownloadCount, 2);
assert.equal(firstSameTimer.cleared, true);
const snapshotBeforeOldTimeout = activeSnapshots.length;
firstSameTimer.callback();
assert.equal(state.smbDownloadActive, true, 'expired generation cannot clear newer same-id activity');
assert.equal(state.smbDownloadCount, 2);
assert.equal(state._smbLoaderTimer, secondSameTimer);
assert.equal(activeSnapshots.length, snapshotBeforeOldTimeout, 'stale timeout does not publish a false idle state');
assert.equal(context.finishSmbDownloadActivity({ id: 'download-same' }), false,
  'the first matching End decrements but does not finish overlapping same-id starts');
assert.equal(state.smbDownloadActive, true);
assert.equal(state.smbDownloadCount, 1);
assert.equal(state._smbLoaderTimer, secondSameTimer);
assert.equal(secondSameTimer.cleared, false);
assert.equal(context.finishSmbDownloadActivity({ id: 'download-same' }), true,
  'the second matching End finishes the same-id activity');
assert.equal(state.smbDownloadActive, false);
assert.equal(state.smbDownloadCount, 0);
assert.equal(secondSameTimer.cleared, true);

// A current timeout may release stale NAS activity, but an older reader operation
// must not hide the newer operation's foreground loader.
state.readerOperation += 1;
const timedOutOperation = state.readerOperation;
context.startSmbDownloadActivity({ id: 'timeout-old-reader' });
const operationTimer = state._smbLoaderTimer;
state.readerOperation = timedOutOperation + 1;
const forceHidesBeforeTimeout = forceHideCalls.length;
operationTimer.callback();
assert.equal(state.smbDownloadActive, false, 'the active generation timeout releases its own stale NAS activity');
assert.equal(state._smbLoaderTimer, null);
assert.equal(forceHideCalls.length, forceHidesBeforeTimeout,
  'an old reader-operation timeout cannot force-hide the newer foreground loader');

console.log('PASS: stale reader opens, id-matched End handling, same-id overlap counts, and timeout ownership.');
