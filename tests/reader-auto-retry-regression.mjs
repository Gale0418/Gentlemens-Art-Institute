import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('../public/tauri-api.js', import.meta.url), 'utf8');
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const functionStart = asyncStart >= 0 ? asyncStart : start;
  assert.ok(functionStart >= 0, `missing function ${name}`);
  const open = source.indexOf(') {', functionStart) + 2;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(functionStart, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const names = [
  'adoptReadingProgressSequenceFloor',
  'normalizeReadingProgressSnapshot', 'readingProgressKey', 'readingProgressFailureKey',
  'readingProgressNeedsManualCheck', 'readingProgressIntentSequence', 'readReadingProgressFailures',
  'writeReadingProgressFailures', 'rememberFailedReadingProgressSnapshot', 'clearReadingProgressFailure',
  'waitForReadingProgressSave', 'nextReadingProgressSaveSequenceAfter', 'persistReadingProgressSnapshot',
  'enqueueReadingProgressSnapshot', 'retryFailedReadingProgressSnapshots',
  'autoRetryReadingProgressAfterLibraryCommit', 'flushPendingCompletedReadingProgressRetry',
];
const functions = names.map(extractFunction).join('\n');
const storage = new Map();
let sequence = 500;
let saveCalls = [];
let releaseSave;
let rejectSave;
const blockedSaveIds = new Set();
let failEligibleOnce = true;
let failBusyBootOnce = true;
let activeNativeSaves = 0;
let maxConcurrentNativeSaves = 0;
const context = {
  READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
  READING_PROGRESS_SEQUENCE_KEY: 'gai:readingProgressSequence',
  READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [],
  READING_PROGRESS_SAVE_TIMEOUT_MS: 1000,
  readingProgressFailuresLoaded: true,
  readingProgressFailures: new Map(),
  readingProgressFailuresStorageReliable: true,
  latestQueuedReadingProgressById: new Map(),
  discardedReadingProgressIntents: new Map(),
  discardedReadingProgressFailureIntents: new Map(),
  readingProgressRetryPromise: null,
  readingProgressSaveSequence: sequence,
  readingProgressSaveQueue: Promise.resolve(),
  readingProgressAutoRetryScope: '',
  readingProgressAutoRetryAttemptedEpoch: false,
  readingProgressAutoRetryBootAttempted: false,
  readingProgressPendingCompletedEpoch: null,
  state: { scanStatus: null, currentComic: null },
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  },
  sessionStorage: { setItem: (key, value) => storage.set(key, value) },
  renderReadingProgressRecovery() {},
  nextReadingProgressSaveSequence: () => ++sequence,
  waitForReadingProgressRetry: async () => {},
  setTimeout,
  clearTimeout,
  console: { error() {} },
  eAPI: {
    recoverReadingProgress: async snapshot => {
      activeNativeSaves += 1;
      maxConcurrentNativeSaves = Math.max(maxConcurrentNativeSaves, activeNativeSaves);
      try {
        saveCalls.push(snapshot);
        if (blockedSaveIds.has(snapshot.id)) {
          await new Promise((resolve, reject) => { releaseSave = resolve; rejectSave = reject; });
        }
        if (snapshot.id === 'eligible' && failEligibleOnce) {
          failEligibleOnce = false;
          throw new Error('temporary source startup delay');
        }
        if (snapshot.id === 'busyBoot' && failBusyBootOnce) {
          failBusyBootOnce = false;
          throw new Error('temporary boot failure');
        }
      } finally {
        activeNativeSaves -= 1;
      }
    },
    saveProgress: async snapshot => { saveCalls.push(snapshot); },
  },
};
vm.runInNewContext(`${functions}
  globalThis.autoRetry = autoRetryReadingProgressAfterLibraryCommit;
  globalThis.flushPending = flushPendingCompletedReadingProgressRetry;
  globalThis.retry = retryFailedReadingProgressSnapshots;
  globalThis.remember = rememberFailedReadingProgressSnapshot;
  globalThis.failureKey = readingProgressFailureKey;
  globalThis.readFailures = readReadingProgressFailures;`, context);

context.state.scanStatus = { generation: null, isScanning: false, phase: 'idle', completedAt: 'cached' };
assert.equal(context.autoRetry('local:library', true), false, 'null generation is unknown, not generation zero');
context.state.scanStatus = { isScanning: false, phase: 'idle', completedAt: 'cached' };
assert.equal(context.autoRetry('local:library', true), false, 'missing generation stays unknown');
context.state.scanStatus = { generation: 0, isScanning: false, phase: 'idle' };
assert.equal(context.autoRetry('local:library', true), true, 'known idle generation zero allows the boot pass');
context.readingProgressAutoRetryBootAttempted = false;
context.readingProgressAutoRetryScope = '';

assert.equal(context.adoptReadingProgressSequenceFloor(700), true, 'a valid native floor is adopted');
assert.equal(context.readingProgressSaveSequence, 700, 'future native attempts start above the canonical intent floor');
assert.equal(storage.get('gai:readingProgressSequence'), '700', 'the adopted floor survives a WebView reload');
assert.equal(context.adoptReadingProgressSequenceFloor(Number.MAX_SAFE_INTEGER + 1), false, 'unsafe floors are ignored');
assert.equal(context.adoptReadingProgressSequenceFloor(undefined), false, 'older open responses remain compatible');
context.readingProgressSaveSequence = sequence;
const apiContext = { bridgeText: text => text };
vm.runInNewContext(`${apiSource.slice(apiSource.indexOf('function normalizeProgressPayload('), apiSource.indexOf('\nfunction progressTimestamp('))}
  globalThis.normalize = normalizeProgressPayload;`, apiContext);
assert.equal(apiContext.normalize({ id: 'comic', currentPage: 0, totalPages: 2, sequence: 90, intentSequence: 40 }).intentSequence, 40,
  'the Tauri bridge preserves the original intent sequence alongside the fresh attempt sequence');
const openReaderSource = extractFunction('openReader');
assert.ok(openReaderSource.indexOf('adoptReadingProgressSequenceFloor(data?.sequenceFloor)')
  < openReaderSource.indexOf('state.currentComic = data'), 'openReader adopts the floor before the new comic can queue progress');

const eligible = { id: 'eligible', sourceId: 'local:library', currentPage: 2, totalPages: 12, sequence: 10, recoveryToken: 'proof' };
const sourceLess = { id: 'legacy', currentPage: 1, totalPages: 2, sequence: 11 };
const noProof = { id: 'no-proof', sourceId: 'local:library', currentPage: 1, totalPages: 2, sequence: 12 };
const manualCheck = { id: 'manual', sourceId: 'local:library', currentPage: 1, totalPages: 2, sequence: 13, recoveryToken: 'old', recoveryStatus: 'manual-check' };
for (const item of [eligible, sourceLess, noProof, manualCheck]) context.remember(item);

context.state.scanStatus = null;
assert.equal(context.autoRetry('local:library', true), false, 'unknown boot scan state does not retry');
context.state.scanStatus = { generation: 4, isScanning: true, phase: 'error', error: 'failed' };
assert.equal(context.autoRetry('local:library', true), false, 'error boot scan state does not retry');
context.state.scanStatus = { generation: 4, isScanning: true, phase: 'catalog' };
assert.equal(context.autoRetry('', true), false, 'boot waits for a known source configuration');
assert.equal(context.autoRetry('local:library', true), true, 'known scanning startup gets one boot pass after snapshot commit');
assert.equal(context.autoRetry('local:library', true), false, 'boot reentry does not start a second pass');
await context.readingProgressRetryPromise;
assert.equal(saveCalls.length, 1, 'the boot pass retries only the snapshot with source and recovery proof');
assert.equal(context.readFailures().get(context.failureKey(eligible))?.sequence, eligible.sequence,
  'a transient boot failure retains its original intent for the completion pass');

context.state.scanStatus = { generation: 4, isScanning: true, phase: 'catalog' };
assert.equal(context.autoRetry('local:library'), false, 'catalog updates do not start another retry pass');
context.state.scanStatus = { generation: 4, isScanning: false, phase: 'complete', completedAt: 'done-4' };
assert.equal(context.autoRetry('local:library'), true, 'completion gets a separate pass in the boot generation');
assert.equal(context.autoRetry('local:library'), false, 'the same completed scan epoch is attempted only once');
await context.readingProgressRetryPromise;
assert.equal(saveCalls.length, 2, 'the completion pass retries the transient boot failure exactly once');
assert.equal(saveCalls[1].intentSequence, eligible.sequence, 'fresh native sequence retains the original intent sequence');
assert.ok(saveCalls[1].sequence > eligible.sequence, 'native retry uses a fresh ordering sequence');
assert.equal(context.readFailures().has(context.failureKey(eligible)), false, 'native success clears the retried journal entry');
for (const retained of [sourceLess, noProof, manualCheck]) {
  assert.equal(context.readFailures().has(context.failureKey(retained)), true, 'unsafe or ambiguous entries remain recoverable');
}

context.state.scanStatus = { generation: 5, isScanning: true, phase: 'catalog' };
assert.equal(context.autoRetry('local:library'), false, 'a late prior-generation completion cannot retry during the new scan');
context.state.scanStatus = { generation: 5, isScanning: false, phase: 'complete', completedAt: 'done-5' };
assert.equal(context.autoRetry('local:library'), true, 'a new committed scan epoch receives one pass');
assert.equal(context.autoRetry('local:library'), false, 'repeated catalog notifications cannot create retry passes');

const activeBook = { id: 'active', sourceId: 'local:library', currentPage: 3, totalPages: 20, sequence: 30, recoveryToken: 'proof' };
context.remember(activeBook);
context.state.currentComic = { id: 'active', sourceId: 'local:library' };
const callsBeforeActiveBook = saveCalls.length;
await context.retry();
assert.equal(saveCalls.length, callsBeforeActiveBook, 'manual retry does not race the currently open copy of the same book');
context.state.currentComic = null;

const inflight = { id: 'inflight', sourceId: 'local:library', currentPage: 4, totalPages: 20, sequence: 40, recoveryToken: 'proof' };
context.remember(inflight);
blockedSaveIds.add(inflight.id);
const firstRetry = context.retry();
await new Promise(resolve => setImmediate(resolve));
const secondRetry = context.retry();
assert.equal(secondRetry, firstRetry, 'manual and automatic triggers share the in-flight retry promise');
releaseSave();
await firstRetry;
blockedSaveIds.delete(inflight.id);

const busyBoot = { id: 'busyBoot', sourceId: 'local:library', currentPage: 2, totalPages: 8, sequence: 50, recoveryToken: 'proof' };
context.remember(busyBoot);
context.state.scanStatus = { generation: 6, isScanning: true, phase: 'catalog' };
blockedSaveIds.add(busyBoot.id);
rejectSave = null;
context.readingProgressAutoRetryBootAttempted = false;
assert.equal(context.autoRetry('local:library', true), true, 'a later startup generation can receive its one boot pass');
const bootInFlight = context.readingProgressRetryPromise;
for (let tick = 0; tick < 10 && !rejectSave; tick += 1) await new Promise(resolve => setImmediate(resolve));
assert.equal(typeof rejectSave, 'function', 'the boot native request is in flight before scan completion');
context.state.scanStatus = { generation: 6, isScanning: false, phase: 'complete', completedAt: 'done-6' };
assert.equal(context.autoRetry('local:library'), true, 'completion records a bounded follow-up while boot is in flight');
assert.equal(context.autoRetry('local:library'), false, 'repeated completion notifications do not add follow-ups');
blockedSaveIds.delete(busyBoot.id);
rejectSave(new Error('temporary boot failure'));
await bootInFlight;
for (let tick = 0; tick < 10 && (!context.readingProgressRetryPromise || context.readingProgressRetryPromise === bootInFlight); tick += 1) {
  await Promise.resolve();
}
const completionFollowup = context.readingProgressRetryPromise;
assert.ok(completionFollowup && completionFollowup !== bootInFlight, 'boot settlement flushes one serial completion pass');
await completionFollowup;
assert.equal(saveCalls.filter(snapshot => snapshot.id === busyBoot.id).length, 2,
  'boot failure is retried exactly once after the same generation completes');
assert.equal(maxConcurrentNativeSaves, 1, 'the completion follow-up starts only after the boot native request settles');

const abandoned = { id: 'abandoned', sourceId: 'local:library', currentPage: 1, totalPages: 3, sequence: 55, recoveryToken: 'proof' };
context.remember(abandoned);
context.state.scanStatus = { generation: 7, isScanning: true, phase: 'catalog' };
blockedSaveIds.add(abandoned.id);
rejectSave = null;
context.readingProgressAutoRetryBootAttempted = false;
const staleBootAccepted = context.autoRetry('local:library', true);
assert.equal(staleBootAccepted, true);
const staleBootPromise = context.readingProgressRetryPromise;
for (let tick = 0; tick < 10 && !rejectSave; tick += 1) await new Promise(resolve => setImmediate(resolve));
context.state.scanStatus = { generation: 7, isScanning: false, phase: 'complete', completedAt: 'done-7' };
assert.equal(context.autoRetry('local:library'), true, 'completion queues its pass behind a boot attempt');
context.state.scanStatus = { generation: 8, isScanning: true, phase: 'catalog' };
assert.equal(context.autoRetry('local:new-library'), false, 'a new source generation invalidates the old follow-up');
blockedSaveIds.delete(abandoned.id);
rejectSave(new Error('old source interrupted'));
const callsBeforeStaleBootSettles = saveCalls.length;
await staleBootPromise;
for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
assert.equal(saveCalls.length, callsBeforeStaleBootSettles, 'an invalidated completion pass does not retry an old source journal');
assert.equal(context.readingProgressPendingCompletedEpoch, null, 'source change clears the pending completion epoch');
assert.equal(context.readFailures().has(context.failureKey(abandoned)), true, 'the old source journal remains available for a later explicit retry');

const uncleared = { id: 'storage-failure', sourceId: 'local:library', currentPage: 1, totalPages: 4, sequence: 60, recoveryToken: 'proof' };
context.remember(uncleared);
const originalSetItem = context.localStorage.setItem;
let failNextJournalWrite = true;
context.localStorage.setItem = (key, value) => {
  if (key === 'gai:readingProgressFailures' && failNextJournalWrite) {
    failNextJournalWrite = false;
    throw new Error('storage unavailable');
  }
  originalSetItem(key, value);
};
await context.persistReadingProgressSnapshot({ ...uncleared, sequence: 61, intentSequence: 60 }, 60, true);
assert.equal(context.readFailures().has(context.failureKey(uncleared)), true, 'storage failure keeps the successful save visible in the journal');
context.localStorage.setItem = originalSetItem;

const retryFailure = { id: 'retry-failure', sourceId: 'local:library', currentPage: 6, totalPages: 10, sequence: 70, recoveryToken: 'proof' };
context.eAPI.recoverReadingProgress = async () => { throw new Error('temporary failure'); };
await context.persistReadingProgressSnapshot({ ...retryFailure, sequence: 99, intentSequence: 70 }, 70, true);
assert.equal(context.readFailures().get(context.failureKey(retryFailure))?.sequence, 70,
  'a failed retry journals the original intent sequence instead of its fresh attempt sequence');

const catalogHandler = source.match(/onCatalogChanged\(\(\) => \{([\s\S]*?)\}\);/);
assert.ok(catalogHandler, 'catalog change listener exists');
assert.doesNotMatch(catalogHandler[1], /retryFailedReadingProgressSnapshots/, 'catalog event storms do not directly launch retries');

{
  const laneFunctions = [
    'normalizeReadingProgressSnapshot', 'readingProgressKey', 'readingProgressFailureKey',
    'readingProgressIntentSequence', 'readingProgressNeedsManualCheck', 'readReadingProgressFailures',
    'writeReadingProgressFailures', 'rememberFailedReadingProgressSnapshot', 'clearReadingProgressFailure',
    'waitForReadingProgressSave', 'persistReadingProgressSnapshot', 'enqueueReadingProgressSnapshot',
  ].map(extractFunction).join('\n');
  const laneStorage = new Map();
  const nativeCalls = [];
  let releaseRecovery;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  const laneContext = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SAVE_TIMEOUT_MS: 1000,
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [],
    readingProgressFailuresLoaded: true,
    readingProgressFailures: new Map(),
    readingProgressFailuresStorageReliable: true,
    latestQueuedReadingProgressById: new Map(),
    discardedReadingProgressIntents: new Map(),
    discardedReadingProgressFailureIntents: new Map(),
    readingProgressSaveQueue: Promise.resolve(),
    readingProgressRecoverySaveQueue: Promise.resolve(),
    localStorage: {
      getItem: key => laneStorage.get(key) || null,
      setItem: (key, value) => laneStorage.set(key, value),
    },
    sessionStorage: { setItem() {} },
    renderReadingProgressRecovery() {},
    setTimeout,
    clearTimeout,
    console: { error() {} },
    eAPI: {
      recoverReadingProgress: async snapshot => { nativeCalls.push(`recover:${snapshot.id}`); await recoveryGate; },
      saveProgress: async snapshot => { nativeCalls.push(`save:${snapshot.id}`); },
    },
  };
  vm.runInNewContext(`${laneFunctions}\nglobalThis.enqueue = enqueueReadingProgressSnapshot;`, laneContext);
  const recovery = laneContext.enqueue({
    id: 'blocked-recovery-A', sourceId: 'smb:test', currentPage: 1, totalPages: 5,
    sequence: 10, intentSequence: 10, recoveryToken: 'durable-proof',
  }, { recovery: true });
  await new Promise(resolve => setImmediate(resolve));
  const foreground = laneContext.enqueue({
    id: 'foreground-B', sourceId: 'local:test', currentPage: 2, totalPages: 6, sequence: 11,
  });
  await new Promise(resolve => setImmediate(resolve));
  const foregroundWasUnblocked = nativeCalls.includes('save:foreground-B');
  releaseRecovery();
  await Promise.all([recovery, foreground]);
  assert.equal(foregroundWasUnblocked, true,
    'foreground save B reaches native before deferred automatic recovery A settles');
  assert.deepEqual(nativeCalls, ['recover:blocked-recovery-A', 'save:foreground-B']);

  laneContext.readingProgressSaveQueue = Promise.resolve();
  laneContext.readingProgressRecoverySaveQueue = Promise.resolve();
  laneContext.latestQueuedReadingProgressById.clear();
  delete laneContext.eAPI.recoverReadingProgress;
  let releaseLegacyFallback;
  const legacyFallbackGate = new Promise(resolve => { releaseLegacyFallback = resolve; });
  laneContext.eAPI.saveProgress = async snapshot => {
    nativeCalls.push(`save:${snapshot.id}`);
    if (snapshot.id === 'legacy-recovery-A') await legacyFallbackGate;
  };
  const legacyRecovery = laneContext.enqueue({
    id: 'legacy-recovery-A', sourceId: 'local:test', currentPage: 1, totalPages: 4, sequence: 20,
  }, { recovery: true });
  await new Promise(resolve => setImmediate(resolve));
  const legacyForeground = laneContext.enqueue({
    id: 'legacy-foreground-B', sourceId: 'local:test', currentPage: 2, totalPages: 4, sequence: 21,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeCalls.includes('save:legacy-foreground-B'), false,
    'legacy saveProgress fallback stays on the normal ordered queue');
  releaseLegacyFallback();
  await Promise.all([legacyRecovery, legacyForeground]);
}

{
  const journalFunctions = [
    'normalizeReadingProgressSnapshot', 'readingProgressKey', 'readingProgressFailureKey',
    'readingProgressIntentSequence', 'readReadingProgressFailures', 'writeReadingProgressFailures',
    'rememberFailedReadingProgressSnapshot', 'clearReadingProgressFailure',
    'waitForReadingProgressSave', 'persistReadingProgressSnapshot',
  ].map(extractFunction).join('\n');
  const journalStorage = new Map();
  let releaseLateRetry;
  const lateRetryGate = new Promise(resolve => { releaseLateRetry = resolve; });
  const journalContext = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SAVE_TIMEOUT_MS: 1000,
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [],
    readingProgressFailuresLoaded: true,
    readingProgressFailures: new Map(),
    readingProgressFailuresStorageReliable: true,
    latestQueuedReadingProgressById: new Map(),
    discardedReadingProgressIntents: new Map(),
    discardedReadingProgressFailureIntents: new Map(),
    localStorage: {
      getItem: key => journalStorage.get(key) || null,
      setItem: (key, value) => journalStorage.set(key, value),
    },
    renderReadingProgressRecovery() {},
    setTimeout,
    clearTimeout,
    console: { error() {} },
    eAPI: { recoverReadingProgress: async () => { await lateRetryGate; } },
  };
  vm.runInNewContext(`${journalFunctions}
    globalThis.remember = rememberFailedReadingProgressSnapshot;
    globalThis.persist = persistReadingProgressSnapshot;
    globalThis.readFailures = readReadingProgressFailures;
    globalThis.failureKey = readingProgressFailureKey;`, journalContext);
  const original = {
    id: 'same-token-race', sourceId: 'smb:test', currentPage: 1, totalPages: 8,
    sequence: 10, recoveryToken: 'same-proof',
  };
  journalContext.remember(original);
  const lateRetry = journalContext.persist({ ...original, sequence: 100, intentSequence: 10 }, 10, true);
  await new Promise(resolve => setImmediate(resolve));
  const newer = { ...original, currentPage: 6, sequence: 20 };
  journalContext.remember(newer);
  releaseLateRetry();
  await lateRetry;
  const retained = journalContext.readFailures().get(journalContext.failureKey(original));
  assert.equal(retained?.sequence, newer.sequence,
    'late success from a fresh-sequence retry cannot clear a newer same-token intent');
  assert.equal(retained?.currentPage, newer.currentPage);
  assert.deepEqual(JSON.parse(journalStorage.get('gai:readingProgressFailures')), [newer],
    'durable journal retains the newer same-token snapshot after late retry success');
}

{
  const uiFunctions = [
    'normalizeReadingProgressSnapshot', 'readingProgressKey', 'readingProgressFailureKey',
    'readingProgressIntentSequence', 'readingProgressNeedsManualCheck', 'readingProgressSnapshotCanRetry',
    'readReadingProgressFailures', 'writeReadingProgressFailures', 'rememberFailedReadingProgressSnapshot',
    'clearReadingProgressFailure', 'waitForReadingProgressSave', 'nextReadingProgressSaveSequenceAfter',
    'persistReadingProgressSnapshot', 'enqueueReadingProgressSnapshot', 'retryFailedReadingProgressSnapshots',
    'renderReadingProgressRecovery',
  ].map(extractFunction).join('\n');
  const uiStorage = new Map();
  const makeNode = () => ({
    style: {}, attributes: {}, children: [], handlers: {}, textContent: '', hidden: false, isConnected: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.handlers[name] = callback; },
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); },
    replaceChildren(...items) { this.children = items; },
  });
  let panel = null;
  let liveStatus = null;
  const nodes = [];
  const uiContext = {
    READING_PROGRESS_FAILURES_KEY: 'gai:readingProgressFailures',
    READING_PROGRESS_SEQUENCE_KEY: 'gai:readingProgressSequence',
    READING_PROGRESS_SAVE_TIMEOUT_MS: 1000,
    READING_PROGRESS_AUTO_RETRY_DELAYS_MS: [],
    readingProgressFailuresLoaded: true,
    readingProgressFailures: new Map(),
    readingProgressFailuresStorageReliable: true,
    latestQueuedReadingProgressById: new Map(),
    discardedReadingProgressIntents: new Map(),
    discardedReadingProgressFailureIntents: new Map(),
    readingProgressRetryPromise: null,
    readingProgressSaveSequence: 100,
    readingProgressSaveQueue: Promise.resolve(),
    readingProgressRecoverySaveQueue: Promise.resolve(),
    state: { currentComic: null, comics: [], scanStatus: null },
    elements: { contentArea: { prepend(node) {
      panel = node;
      panel.querySelector = selector => nodes.find(item => String(item.className).split(/\s+/).includes(selector.slice(1))) || null;
    } } },
    localStorage: {
      getItem: key => uiStorage.get(key) || null,
      setItem: (key, value) => uiStorage.set(key, value),
    },
    sessionStorage: { setItem() {} },
    document: {
      body: { appendChild(node) { node.isConnected = true; liveStatus = node; } },
      getElementById: id => id === 'reading-progress-recovery' ? panel
        : id === 'reading-progress-recovery-live' ? liveStatus : null,
      createElement: () => {
        const node = makeNode();
        nodes.push(node);
        if (!panel) panel = node;
        return node;
      },
    },
    readerText: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? '')),
    readingProgressDetail: () => '測試漫畫，第 2 頁',
    readingProgressExternalSourceNames: () => [],
    isBuiltInDemoComic: () => false,
    setTimeout,
    clearTimeout,
    console: { error() {} },
  };
  let releaseUiNative;
  let uiNativeGate = new Promise(resolve => { releaseUiNative = resolve; });
  uiContext.eAPI = { recoverReadingProgress: async snapshot => {
    await uiNativeGate;
  } };
  uiContext.nextReadingProgressSaveSequence = () => ++uiContext.readingProgressSaveSequence;
  uiContext.waitForReadingProgressRetry = async () => {};
  vm.runInNewContext(`${uiFunctions}
    globalThis.retry = retryFailedReadingProgressSnapshots;
    globalThis.remember = rememberFailedReadingProgressSnapshot;`, uiContext);
  const uiFailure = {
    id: 'slow-ui-success', sourceId: 'smb:test', currentPage: 1, totalPages: 6,
    sequence: 80, recoveryToken: 'proof',
  };
  uiContext.remember(uiFailure);
  uiContext.renderReadingProgressRecovery();
  const message = nodes.find(node => node.className === 'reading-progress-recovery-message');
  const retryButton = nodes.find(node => String(node.className).split(/\s+/).includes('reading-progress-retry'));
  const clickRetry = retryButton.handlers.click;
  assert.equal(typeof clickRetry, 'function', 'the real recovery action is attached to its button');
  const retryPromise = clickRetry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retryButton.disabled, true, 'slow native recovery disables repeat activation');
  assert.equal(retryButton.attributes['aria-busy'], 'true', 'the retry control exposes its busy state');
  assert.equal(retryButton.textContent, '正在重試保存…', 'the button labels the active operation');
  assert.match(message.textContent, /正在重試保存 1 筆閱讀進度/,
    'the existing live region announces the active retry count');
  assert.ok(liveStatus?.isConnected, 'retry creates a persistent live node outside the dismissible recovery panel');
  assert.equal(liveStatus.hidden, false);
  releaseUiNative();
  await retryPromise;
  assert.equal(panel.hidden, true, 'a fully cleared journal hides the visual recovery panel');
  assert.ok(liveStatus.isConnected && !liveStatus.hidden, 'the independent live node remains available after the panel hides');
  assert.equal(liveStatus.textContent, '未保存閱讀進度已全部保存。', 'success is announced only after the journal is empty');

  const partialFailure = { ...uiFailure, id: 'slow-ui-partial', sequence: 81 };
  uiContext.remember(partialFailure);
  uiNativeGate = new Promise(resolve => { releaseUiNative = resolve; });
  uiContext.renderReadingProgressRecovery();
  const partialRetryPromise = clickRetry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retryButton.disabled, true, 'partial retry is disabled while the native request is pending');
  assert.equal(retryButton.attributes['aria-busy'], 'true');
  const originalSetItem = uiContext.localStorage.setItem;
  let failClearOnce = true;
  uiContext.localStorage.setItem = (key, value) => {
    if (key === 'gai:readingProgressFailures' && failClearOnce) {
      failClearOnce = false;
      throw new Error('storage clear failed');
    }
    originalSetItem(key, value);
  };
  releaseUiNative();
  await partialRetryPromise;
  uiContext.localStorage.setItem = originalSetItem;
  assert.equal(panel.hidden, false);
  assert.equal(retryButton.disabled, false, 'the retry control is available again for remaining retryable entries');
  assert.equal(retryButton.attributes['aria-busy'], 'false', 'settlement clears the busy state');
  assert.equal(retryButton.textContent, '重試保存閱讀進度');
  assert.match(liveStatus.textContent, /重試後仍有 1 筆閱讀進度尚未保存/,
    'a successful native save with failed journal clearing reports the remaining count, not full success');

  uiContext.remember({ ...partialFailure, recoveryStatus: 'manual-check' });
  uiContext.renderReadingProgressRecovery();
  const noWork = uiContext.retry();
  assert.equal(uiContext.readingProgressRetryPromise, null, 'an ineligible-only journal does not create a fake in-flight promise');
  assert.equal(retryButton.disabled, true, 'an ineligible-only journal keeps retry disabled');
  assert.equal(retryButton.attributes['aria-busy'], 'false', 'an ineligible-only journal is never marked busy');
  assert.equal(await noWork, false);
}

// Exercise the real full-snapshot commit path: a failed prerequisite must not
// consume the startup opportunity before a native retry actually begins.
for (const prerequisite of ['poll-error', 'missing-generation', 'null-generation', 'missing-config']) {
  let snapshot = 0;
  let retryCount = 0;
  const noOp = () => {};
  const commitContext = {
    readingProgressAutoRetryScope: '',
    readingProgressAutoRetryAttemptedEpoch: false,
    readingProgressAutoRetryBootAttempted: false,
    readingProgressPendingCompletedEpoch: null,
    readingProgressRetryPromise: null,
      incrementalLibraryRenderPending: false,
    incrementalItemsDuringFetch: new Map(),
    state: { comics: [], favorites: [], scanStatus: null, currentComic: null },
    elements: { comicGrid: { childElementCount: 1 } },
    console: { warn: noOp, error: error => { throw error; } },
    window: { setTimeout: () => 0 },
    setTimeout,
    readerText: text => text,
    readReadingProgressFailures: () => new Map([['retained', {}]]),
    retryFailedReadingProgressSnapshots: () => { retryCount += 1; },
    isBuiltInDemoComic: () => false,
    createBuiltInDemoComics: () => [],
    isLibraryRefreshBlocked: () => false,
    getComicIdentityKey: comic => comic.id,
    eAPI: {
      getLibrary: async () => [{ id: 'formal-fixture', sourceId: 'local:fixture' }],
      getFavorites: async () => [],
      getConfig: async () => {
        if (snapshot === 0 && prerequisite === 'missing-config') throw new Error('config temporarily unavailable');
        return { scanDir: 'local:fixture' };
      },
      getScanStatus: async () => {
        const status = { generation: 0, isScanning: false, phase: 'idle' };
        if (snapshot === 0 && prerequisite === 'poll-error') status.pollError = true;
        if (snapshot === 0 && prerequisite === 'missing-generation') delete status.generation;
        if (snapshot === 0 && prerequisite === 'null-generation') status.generation = null;
        return status;
      },
    },
  };
  for (const name of ['syncLibraryBackgroundActivity', 'showLoader', 'setLoaderProgress', 'startScanStatusPolling', 'stopScanStatusPolling',
    'requestPriorityLibraryScan', 'updateScanRecovery', 'sanitizeOrganizerSelection',
    'invalidateComicNavigationCache', 'setFavorites', 'filterAndRenderGrid', 'renderSidebar',
    'renderContinueStrip', 'renderReadingProgressRecovery', 'restoreLibraryRefreshFocus', 'updateStats',
    'updateLoaderScanProgress', 'hideLoader', 'setScanRecoveryVisible']) commitContext[name] = noOp;
  vm.runInNewContext(`${extractFunction('autoRetryReadingProgressAfterLibraryCommit')}
    ${extractFunction('performLibraryFetch')}
    globalThis.commit = performLibraryFetch;`, commitContext);
  await commitContext.commit();
  assert.equal(retryCount, 0, `${prerequisite}: an unsafe first snapshot does not retry`);
  assert.equal(commitContext.readingProgressAutoRetryBootAttempted, false,
    `${prerequisite}: an unsafe snapshot does not consume the startup opportunity`);
  snapshot += 1;
  await commitContext.commit();
  assert.equal(retryCount, 1, `${prerequisite}: a later safe snapshot performs the startup retry`);
  await commitContext.commit();
  assert.equal(retryCount, 1, `${prerequisite}: repeated commits cannot start a second boot retry`);
}

console.log('reader auto-retry regression checks passed');
