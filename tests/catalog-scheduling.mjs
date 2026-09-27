import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
assert.match(appSource, /await restoreExternalBookmarks\(\)/, 'initial external bookmark restore must use the intent queue');
assert.match(appSource, /async function restoreExternalBookmarks\(\)[\s\S]{0,260}setBookmarks\(readExternalBookmarks\(\)\)/, 'empty initial bookmark restore must still clear native state');
assert.match(appSource, /const latestBookmarks = readExternalBookmarks\(\)[\s\S]{0,180}bookmark\.bookmark !== bookmarkIdentity/, 'bookmark deletion must resolve identity inside the queue');
assert.match(appSource, /async function initApp\(\)[\s\S]{0,180}sanitizeSmbConfig\(\)/, 'SMB legacy secrets must be sanitized during app initialization');
assert.match(appSource, /requestPriorityLibraryScan\(state\.scanStatus, state\.favorites\)/, 'scan progress must submit native priority scan hints');
assert.match(fs.readFileSync(new URL('../public/tauri-api.js', import.meta.url), 'utf8'), /invoke\('scan_priority_library', \{[\s\S]*favoriteIds/, 'native bridge must expose the priority scan command');

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(fn, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + Math.max(0, delay), interval: 0 });
    return id;
  }

  clearTimeout(id) { this.tasks.delete(id); }
  setInterval(fn, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + Math.max(1, delay), interval: Math.max(1, delay) });
    return id;
  }

  clearInterval(id) { this.tasks.delete(id); }

  tick(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      if (task.interval) task.at += task.interval;
      else this.tasks.delete(id);
      task.fn();
    }
    this.now = target;
  }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.dataset = Object.create(null);
    this.style = {};
    this.classList = new FakeClassList();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.isConnected = true;
    this.parentNode = null;
    this.nextElementSibling = null;
    this.textContent = '';
    this.innerHTML = '';
    this.src = '';
    this.replaceChildrenCalls = 0;
    this.appendChildCalls = 0;
  }

  appendChild(child) {
    this.appendChildCalls += 1;
    if (child?.isFragment) {
      for (const item of child.children.slice()) this.appendChild(item);
      child.children = [];
      return child;
    }
    if (child.parentNode && child.parentNode !== this) {
      child.parentNode.children = child.parentNode.children.filter(item => item !== child);
    } else if (child.parentNode === this) {
      this.children = this.children.filter(item => item !== child);
    }
    child.parentNode = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.replaceChildrenCalls += 1;
    this.children.forEach(child => { child.parentNode = null; child.isConnected = false; });
    this.children = [];
    children.forEach(child => this.appendChild(child));
  }

  addEventListener(type, handler, options = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: Boolean(options.once) });
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.handler !== handler));
  }

  dispatch(type) {
    for (const item of [...(this.listeners.get(type) || [])]) {
      item.handler({ target: this });
      if (item.once) this.removeEventListener(type, item.handler);
    }
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  closest(selector) {
    if (selector === '.comic-cover-wrapper') return this.coverWrapper || (this.coverWrapper = new FakeElement('div'));
    if (selector === '.comic-card') return this.card || (this.card = new FakeElement('div'));
    return null;
  }
  querySelector(selector) {
    if (selector.startsWith('img[data-index="')) {
      const index = selector.match(/data-index="(\d+)"/)?.[1];
      return this.children.find(child => child.dataset?.index === index) || null;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === 'img' || selector === '.lazy-cover') return this.children.filter(child => child.tagName === 'IMG');
    if (selector === 'img[data-src]') {
      const walk = node => node.children.flatMap(child => [child, ...walk(child)]);
      return walk(this).filter(child => child.tagName === 'IMG' && child.dataset.src);
    }
    return [];
  }
  scrollIntoView() {}
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
}

class FakeDocumentFragment extends FakeElement {
  constructor() { super('#fragment'); this.isFragment = true; }
}

function createHarness({ width = 1000, storageFails = false } = {}) {
  const clock = new FakeClock();
  const elements = new Map();
  const document = {
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    addEventListener() {},
    createDocumentFragment: () => new FakeDocumentFragment(),
    createElement: tag => new FakeElement(tag),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    fullscreenElement: null,
  };
  const localStorage = {
    values: new Map(),
    getItem(key) {
      if (storageFails) throw new Error('storage unavailable');
      return this.values.get(key) ?? null;
    },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  const electronAPI = {
    isElectron: true,
    getScanStatus: () => Promise.resolve({ isScanning: false }),
    scanPriorityLibrary: async () => {},
    saveProgress: async () => {},
  };
  const window = {
    electronAPI,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    setInterval: clock.setInterval.bind(clock),
    clearInterval: clock.clearInterval.bind(clock),
    requestAnimationFrame: fn => clock.setTimeout(fn, 0),
    cancelAnimationFrame: clock.clearTimeout.bind(clock),
    addEventListener() {},
    __GIA_TEST_HOOKS__: {},
    innerWidth: width,
    innerHeight: 800,
  };
  class FakeImage extends FakeElement {
    constructor() { super('img'); this.decode = async () => {}; }
  }
  const context = {
    window,
    document,
    localStorage,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Image: FakeImage,
    HTMLButtonElement: class {},
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0', objectFit: 'contain' }),
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    console,
    alert() {},
    confirm: () => true,
    navigator: { userAgent: '' },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    unescape,
  };
  context.IntersectionObserver = class FakeIntersectionObserver {
    static instances = [];
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnectCalls = 0;
      context.IntersectionObserver.instances.push(this);
    }
    observe(target) { this.targets.push(target); }
    unobserve(target) { this.targets = this.targets.filter(item => item !== target); }
    disconnect() { this.disconnectCalls += 1; this.targets = []; }
  };
  const RealDate = Date;
  context.Date = class TestDate extends RealDate {
    static now() { return clock.now; }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context, { filename: 'public/app.js' });
  return { clock, context, hooks: window.__GIA_TEST_HOOKS__, document };
}

const { clock, context, hooks } = createHarness();
assert.doesNotThrow(() => createHarness({ storageFails: true }), 'a blocked settings store must not prevent app script startup');
const makeCover = id => {
  const img = new FakeElement('img');
  img.dataset.coverId = id;
  img.dataset.src = `/cover/${id}`;
  return img;
};

// Continue 卡片的實際欄寬與排序欄位都必須進入簽名；未讀收藏不可偽裝成閱讀進度。
{
  const favorite = {
    id: 'favorite-unread',
    title: 'Favorite unread',
    relativePath: 'series/Favorite unread.cbz',
    type: 'archive',
    pageCount: 20,
    progress: { currentPage: 0, totalPages: 20, percent: 0, updatedAt: '2026-09-27T00:00:00Z' },
  };
  hooks.state.comics = [favorite];
  hooks.setFavorites(['favorite-unread']);
  hooks.renderContinueStrip();
  assert.match(hooks.elements.continueStrip.innerHTML, /width: 0%/, 'unread favorite does not claim fake reading progress');
  const firstMarkup = hooks.elements.continueStrip.innerHTML;
  favorite.progress.percent = 37;
  hooks.renderContinueStrip();
  assert.notEqual(hooks.elements.continueStrip.innerHTML, firstMarkup, 'progress changes invalidate the Continue render signature');
}

// 舊世代封面取消後不應釋放新世代名額，也不應把取消事件算成失敗。
{
  const first = makeCover('first');
  const second = makeCover('second');
  const third = makeCover('third');
  [first, second, third].forEach(img => hooks.setCoverVisibility(img, true));
  [first, second, third].forEach(img => hooks.enqueueCoverLoad(img));
  clock.tick(80);
  assert.equal(hooks.getCoverQueueState().active, 2);
  hooks.resetCoverLoadQueue();
  first.dispatch('error');
  assert.equal(hooks.getCoverQueueState().active, 0);
  assert.equal(hooks.getCoverQueueState().tasks, 0);
  assert.equal(hooks.getCoverQueueState().failed.size, 0);
  assert.equal(first.src, '');
}

// 離開視窗的 queued 項目會被移除；停滑後只啟動仍可見項目，且上限維持 2。
{
  const offscreen = makeCover('offscreen');
  const visibleA = makeCover('visible-a');
  const visibleB = makeCover('visible-b');
  hooks.setCoverVisibility(offscreen, true);
  hooks.enqueueCoverLoad(offscreen);
  hooks.setCoverVisibility(offscreen, false);
  [visibleA, visibleB].forEach(img => { hooks.setCoverVisibility(img, true); hooks.enqueueCoverLoad(img); });
  clock.tick(80);
  assert.equal(offscreen.src, '');
  assert.equal(visibleA.src, '/cover/visible-a');
  assert.equal(visibleB.src, '/cover/visible-b');
  assert.equal(hooks.getCoverQueueState().active, 2);
  hooks.resetCoverLoadQueue();
}

// 失敗黑名單有 TTL，掃描／來源刷新則可清空並重試。
{
  const failed = makeCover('retryable');
  hooks.markCoverUnavailable(failed);
  assert.equal(hooks.hasFailedCover('retryable'), true);
  clock.tick(30_000);
  assert.equal(hooks.hasFailedCover('retryable'), false);
}

// Timer 觸發時重新檢查 gate；解除捲動後只執行一次 deferred refresh。
{
  let refreshes = 0;
  hooks.setLibraryRefreshRunner(() => { refreshes += 1; });
  hooks.state.scanStatus = { isScanning: true };
  hooks.scheduleLibraryRefresh(0);
  clock.tick(0);
  assert.equal(refreshes, 0);
  hooks.state.scanStatus = { isScanning: false };
  hooks.runScheduledLibraryRefresh();
  assert.equal(refreshes, 1);
  hooks.noteCatalogScroll();
  hooks.scheduleLibraryRefresh(0);
  clock.tick(0);
  assert.equal(refreshes, 1);
  clock.tick(180);
  clock.tick(0);
  assert.equal(refreshes, 2);
  hooks.setLibraryRefreshRunner(null);
}

// 關閉閱讀器後，Continue／Inspector 由 innerHTML 重建時，焦點要回到同一本
// 的新入口；快照只消費一次，入口消失時則安全放棄。
{
  const continueCase = createHarness();
  const oldCard = new FakeElement('button');
  oldCard.dataset.comicId = 'continue-book';
  oldCard.classList.add('continue-card');
  oldCard.closest = selector => selector === '.continue-card[data-comic-id]' ? oldCard : null;
  continueCase.hooks.state.readerReturnFocus = oldCard;
  continueCase.hooks.state.currentComic = { id: 'continue-book' };
  await continueCase.hooks.closeReader();
  assert.equal(continueCase.hooks.state.libraryRefreshFocusSnapshot.area, 'continue');
  assert.equal(continueCase.hooks.state.libraryRefreshFocusSnapshot.comicId, 'continue-book');

  const newCard = new FakeElement('button');
  newCard.dataset.comicId = 'continue-book';
  newCard.classList.add('continue-card');
  continueCase.hooks.elements.continueStrip.children = [newCard];
  assert.equal(continueCase.hooks.restoreLibraryRefreshFocus(), true);
  assert.equal(newCard.focusCalls, 1, '重建後恢復 Continue 卡片焦點');
  assert.equal(continueCase.hooks.state.libraryRefreshFocusSnapshot, null);
  assert.equal(continueCase.hooks.restoreLibraryRefreshFocus(), false, '同一快照不重複搶焦點');

  const inspectorCase = createHarness();
  const oldOpen = new FakeElement('button');
  oldOpen.dataset.comicId = 'inspector-book';
  oldOpen.dataset.inspectorAction = 'open';
  oldOpen.closest = selector => selector === '[data-inspector-action="open"][data-comic-id]' ? oldOpen : null;
  inspectorCase.hooks.state.readerReturnFocus = oldOpen;
  inspectorCase.hooks.state.currentComic = { id: 'inspector-book' };
  await inspectorCase.hooks.closeReader();
  const newOpen = new FakeElement('button');
  newOpen.dataset.comicId = 'inspector-book';
  newOpen.dataset.inspectorAction = 'open';
  inspectorCase.hooks.elements.comicInspector.children = [newOpen];
  assert.equal(inspectorCase.hooks.restoreLibraryRefreshFocus(), true);
  assert.equal(newOpen.focusCalls, 1, '重建後恢復 Inspector 開始閱讀焦點');

  const removed = createHarness();
  removed.hooks.state.libraryRefreshFocusSnapshot = { area: 'continue', comicId: 'removed-book' };
  assert.equal(removed.hooks.restoreLibraryRefreshFocus(), false, '入口移除時不聚焦 body 以外的節點');
  assert.equal(removed.hooks.state.libraryRefreshFocusSnapshot, null);
}

// 從 Continue 進入深層漫畫時，返回應顯示該漫畫所在目錄；
// 一般書架入口則保留使用者原本的目錄。
{
  const continued = createHarness();
  continued.hooks.state.comics = [{ id: 'nested-book', title: 'Vol.1', relativePath: 'series/arc/Vol.1' }];
  continued.hooks.state.currentComic = { id: 'nested-book' };
  continued.hooks.state.readerReturnComicFolder = 'series/arc';
  continued.hooks.state.currentPath = '';
  continued.hooks.state.activeSeries = 'another-series';
  continued.hooks.state.activeFilter = 'unread';
  continued.hooks.elements.searchInput.value = 'unrelated search';
  await continued.hooks.closeReader();
  assert.equal(continued.hooks.state.currentPath, 'series/arc');
  assert.equal(continued.hooks.state.selectedComicId, 'nested-book');
  assert.equal(continued.hooks.state.activeSeries, 'all');
  assert.equal(continued.hooks.state.activeFilter, 'all');
  assert.equal(continued.hooks.elements.searchInput.value, '');
  assert.equal(continued.hooks.state.readerReturnComicFolder, null);

  const shelf = createHarness();
  shelf.hooks.state.currentPath = 'other/folder';
  shelf.hooks.state.currentComic = { id: 'shelf-book' };
  await shelf.hooks.closeReader();
  assert.equal(shelf.hooks.state.currentPath, 'other/folder');

  const switching = createHarness();
  switching.hooks.state.currentComic = { id: 'first-book' };
  switching.hooks.state.readerReturnComicFolder = 'series/arc';
  await switching.hooks.closeReader({ switchingComic: true });
  assert.equal(switching.hooks.state.readerReturnComicFolder, 'series/arc');
  assert.equal(switching.hooks.state.currentPath, '');
}

// 單純滑動而沒有任何資料變更，不應重抓整個書庫。
{
  let refreshes = 0;
  hooks.setLibraryRefreshRunner(() => { refreshes += 1; });
  hooks.state.libraryRefreshPending = false;
  hooks.noteCatalogScroll();
  clock.tick(180);
  assert.equal(refreshes, 0);
  hooks.setLibraryRefreshRunner(null);
}

// 掃描批次直接合併到目前書架；舊世代事件不得污染新來源，且不觸發整庫重抓。
{
  const incremental = createHarness();
  incremental.hooks.state.comics = [];
  incremental.hooks.state.scanStatus = { isScanning: true, generation: 12, found: 0 };
  incremental.hooks.state.currentComic = { id: 'reader-open' };
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 12,
    found: 2,
    items: [
      { id: 'book-a', title: 'A', relativePath: 'a.cbz', sourceId: 'local:test' },
      { id: 'book-b', title: 'B', relativePath: 'b.cbz', sourceId: 'local:test' },
    ],
  }), true);
  assert.deepEqual(incremental.hooks.state.comics.map(item => item.id), ['book-a', 'book-b']);
  assert.equal(incremental.hooks.state.scanStatus.found, 2);
  incremental.hooks.state.currentComic = null;
  vm.runInContext(`
    filterAndRenderGrid = () => { incrementalRenders += 1; };
    renderSidebar = () => {};
    renderContinueStrip = () => {};
    updateStats = () => {};
  `, incremental.context);
  incremental.context.incrementalRenders = 0;
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 12,
    found: 3,
    items: [{ id: 'book-c', title: 'C', relativePath: 'c.cbz', sourceId: 'local:test' }],
  }), true);
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 12,
    found: 4,
    items: [{ id: 'book-d', title: 'D', relativePath: 'd.cbz', sourceId: 'local:test' }],
  }), true);
  incremental.context.incrementalRenders = 0;
  incremental.clock.tick(0);
  // The frame callback is coalesced; the real library renderer is invoked once
  // for the two discoveries that arrived in the same frame.
  assert.equal(incremental.context.incrementalRenders, 1);
  incremental.hooks.updateLoaderScanProgress({ generation: 13, isScanning: true, found: 4 });
  incremental.hooks.updateLoaderScanProgress({ generation: 12, isScanning: true, found: 99 });
  assert.equal(incremental.hooks.state.scanStatus.generation, 13);
  incremental.hooks.updateLoaderScanProgress({
    generation: 13,
    isScanning: false,
    found: 4,
    completedAt: '2026-09-09T00:00:00Z',
  });
  incremental.hooks.updateLoaderScanProgress({ generation: 13, isScanning: true, found: 99 });
  assert.equal(incremental.hooks.state.scanStatus.isScanning, false);
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 13,
    found: 99,
    items: [{ id: 'late-book', title: 'Late', relativePath: 'late.cbz', sourceId: 'local:test' }],
  }), true);
  assert.equal(incremental.hooks.state.scanStatus.isScanning, false);
  assert.equal(incremental.hooks.state.comics.some(item => item.id === 'late-book'), false);
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 13,
    visible: true,
    found: 1,
    items: [{ id: 'visible-book', title: 'Visible', relativePath: 'folder/visible.cbz', sourceId: 'local:test' }],
  }), true);
  assert.equal(incremental.hooks.state.scanStatus.isScanning, false, 'visible updates must not revive the global scan');
  assert.equal(incremental.hooks.state.comics.some(item => item.id === 'visible-book'), true, 'current folder must update after global completion');
  incremental.hooks.state.currentPath = 'folder';
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 13,
    visible: true,
    visiblePath: 'folder',
    directories: ['folder/deeper'],
    found: 0,
    items: [],
  }), true);
  incremental.hooks.elements.searchInput.value = '';
  assert.equal(incremental.hooks.getDirectoryItems().some(item => item.isDirectory && item.relativePath === 'folder/deeper'), true,
    'current-level child folders must appear before recursive discovery');
  incremental.hooks.applyIncrementalLibraryBatch({
    generation: 13,
    visible: true,
    visiblePath: 'folder',
    directories: ['folder/other', 'folder/deeper'],
    found: 0,
    items: [],
  });
  assert.deepEqual(Array.from(incremental.hooks.getDirectoryItems().filter(item => item.isDirectory), item => item.relativePath),
    ['folder/deeper', 'folder/other'], 'local and SMB child directories merge without duplicates');
  assert.equal(incremental.hooks.state.comics.some(item => item.relativePath === 'folder/deeper'), false,
    'navigation folders must stay out of the comic catalog');
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 11,
    found: 99,
    items: [{ id: 'stale-book', title: 'Stale', relativePath: 'stale.cbz', sourceId: 'local:old' }],
  }), true);
  assert.deepEqual(incremental.hooks.state.comics.map(item => item.id), ['book-a', 'book-b', 'book-c', 'book-d', 'visible-book']);
}

// Poll 不重疊，舊世代回覆也不能覆蓋新一輪 scan 狀態；暫時故障不能假報完成。
{
  let calls = 0;
  let resolveOld;
  context.window.electronAPI.getScanStatus = () => {
    calls += 1;
    return new Promise(resolve => { resolveOld = resolve; });
  };
  hooks.startScanStatusPolling();
  clock.tick(700);
  clock.tick(700);
  assert.equal(calls, 1);
  hooks.startScanStatusPolling();
  resolveOld({ isScanning: false });
  await Promise.resolve();
  assert.equal(hooks.state.scanStatus.isScanning, true);

  // 暫時故障要顯示無法取得狀態，但保留真正的掃描中狀態。
  let failures = 0;
  context.window.electronAPI.getScanStatus = async () => { failures += 1; throw new Error('offline'); };
  hooks.startScanStatusPolling();
  for (let index = 0; index < 6; index += 1) {
    clock.tick(700);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  }
  assert.ok(failures >= 1);
  assert.equal(hooks.state.scanStatus.isScanning, true);
  assert.equal(hooks.state.scanStatus.pollError, true);
}

// 永不 resolve 的 native 查詢必須有單次 5 秒 deadline，且不因 700ms
// interval 產生無限未決呼叫；晚回覆仍可把同一輪狀態收斂為完成。
{
  const pending = createHarness();
  let calls = 0;
  let resolvePending;
  pending.context.window.electronAPI.getScanStatus = () => {
    calls += 1;
    return new Promise(resolve => { resolvePending = resolve; });
  };
  pending.hooks.startScanStatusPolling();
  pending.clock.tick(700);
  assert.equal(calls, 1);
  pending.clock.tick(5000);
  assert.equal(calls, 1);
  assert.equal(pending.hooks.state.scanStatus.isScanning, true);
  assert.equal(pending.hooks.state.scanStatus.pollError, true);
  assert.match(pending.hooks.elements.loaderProgressLabel.textContent, /暫時無法取得掃描狀態/);
  resolvePending({ generation: 1, isScanning: false, phase: 'complete', completedAt: '2026-09-09T00:00:00Z' });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(pending.hooks.state.scanStatus.isScanning, false);
  assert.equal(pending.hooks.state.scanStatus.phase, 'complete');
}

// stop/start 不能遺忘上一輪未決請求，也不能為同一個 native Promise 再開新呼叫。
{
  const restart = createHarness();
  let calls = 0;
  let resolvePending;
  restart.context.window.electronAPI.getScanStatus = () => {
    calls += 1;
    return new Promise(resolve => { resolvePending = resolve; });
  };
  restart.hooks.startScanStatusPolling();
  restart.clock.tick(700);
  restart.hooks.stopScanStatusPolling();
  restart.hooks.startScanStatusPolling();
  restart.clock.tick(700);
  assert.equal(calls, 1);
  resolvePending({ generation: 1, isScanning: false, phase: 'complete' });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(restart.hooks.state.scanStatus.isScanning, false);
}

// catalog 進度使用 backend 的 processed/total；total=0 時不能假設總數，
// complete 的 detailDeferred 與 error 也各自有明確文案。
{
  const phase = createHarness();
  phase.hooks.updateLoaderScanProgress({ generation: 1, isScanning: true, phase: 'catalog', processed: 64, total: 100 });
  assert.equal(phase.hooks.elements.loaderProgressBar.style.width, '64%');
  assert.match(phase.hooks.elements.loaderProgressLabel.textContent, /正在整理書架 64 \/ 100 本/);
  phase.hooks.updateLoaderScanProgress({ generation: 1, isScanning: true, phase: 'catalog', processed: 5, total: 0 });
  assert.equal(phase.hooks.elements.loaderProgress.classList.contains('indeterminate'), true);
  phase.hooks.updateLoaderScanProgress({ generation: 1, isScanning: false, phase: 'complete', detailDeferred: true });
  assert.match(phase.hooks.elements.loaderProgressLabel.textContent, /書架已更新；詳細資料可按需重新匯入/);
  assert.equal(phase.hooks.state.scanStatus.pollError, false);

  const error = createHarness();
  error.hooks.updateLoaderScanProgress({ generation: 1, isScanning: false, phase: 'error', error: '/private/source/catalog failed' });
  assert.match(error.hooks.elements.loaderProgressLabel.textContent, /書架整理失敗，請稍後再試/);
  assert.doesNotMatch(error.hooks.elements.loaderProgressLabel.textContent, /private|catalog failed/);
  error.clock.tick(3500);
  assert.equal(error.hooks.elements.loaderMask.style.display, 'none');
  assert.doesNotMatch(error.hooks.elements.loaderProgressLabel.textContent, /整理完成/);
}

// wallclock 上限停止輪詢後，沒有終態的晚回覆不能把 UI 推回無人接手的
// discovering 狀態；後端事件或終態回覆仍可另外收斂畫面。
{
  const wallclock = createHarness();
  let resolvePending;
  wallclock.context.window.electronAPI.getScanStatus = () => new Promise(resolve => { resolvePending = resolve; });
  wallclock.hooks.startScanStatusPolling();
  wallclock.clock.tick(700);
  wallclock.clock.tick(42 * 60 * 1000);
  assert.equal(wallclock.hooks.state.scanStatusPollTimer, null);
  resolvePending({ generation: 1, isScanning: true, phase: 'discovering', found: 4 });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(wallclock.hooks.state.scanStatus.phase, undefined);
  assert.equal(wallclock.hooks.state.scanStatus.isScanning, true);
}

// 關閱讀器後，延遲的前／後一本操作不可跨 readerOperation 重新開書。
{
  hooks.state.comics = [
    { id: 'a', title: 'A', relativePath: 'folder/a.cbz', isDirectory: false },
    { id: 'b', title: 'B', relativePath: 'folder/b.cbz', isDirectory: false },
  ];
  hooks.state.currentComic = hooks.state.comics[0];
  hooks.state.selectedComicId = null;
  hooks.state.pendingComicId = null;
  hooks.state.readerOperation = 10;
  hooks.openNextComicInFolder();
  hooks.state.readerOperation = 11;
  clock.tick(800);
  await Promise.resolve();
  assert.equal(hooks.state.pendingComicId, null);

  hooks.state.currentComic = hooks.state.comics[1];
  hooks.state.readerOperation = 20;
  hooks.openPrevComicInFolder();
  hooks.state.readerOperation = 21;
  clock.tick(800);
  await Promise.resolve();
  assert.equal(hooks.state.pendingComicId, null);
}

// webtoon branch 連續渲染兩次，頁面數量不應累加。
{
  const pages = hooks.elements.pagesContainer;
  hooks.state.currentComic = { id: 'comic-1' };
  hooks.state.currentComicPages = ['p1', 'p2', 'p3'];
  hooks.state.currentPageIndex = 0;
  hooks.state.readingMode = 'webtoon';
  hooks.renderPages();
  const firstGrid = pages.children.find(child => child.className === 'reader-catalog-grid');
  assert.equal(firstGrid, undefined, 'webtoon rendering does not create a catalog grid');
  assert.equal(pages.children.filter(child => child.className === 'webtoon-img').length, 3);
  hooks.renderPages();
  assert.equal(pages.children.filter(child => child.className === 'webtoon-img').length, 3);
}

// 目錄縮圖只保留固定頁窗，避免大本漫畫一次建立數千個節點。
{
  const catalog = createHarness();
  // 以舊 WKWebView fallback 路徑驗證沒有 IntersectionObserver 時仍受併發上限保護。
  catalog.context.IntersectionObserver = undefined;
  catalog.hooks.state.currentComic = { id: 'large-catalog' };
  catalog.hooks.state.currentComicPages = Array.from({ length: 5000 }, (_, index) => `p${index}`);
  catalog.hooks.state.currentPageIndex = 2500;
  catalog.hooks.state.readingMode = 'catalog';
  catalog.hooks.renderPages();
  const grid = catalog.hooks.elements.pagesContainer.children.find(child => child.className === 'reader-catalog-grid');
  assert.ok(grid, 'catalog mode renders a thumbnail grid');
  assert.ok(grid.children.length <= 160, 'large catalogs keep a bounded thumbnail window');
  assert.equal(catalog.hooks.state.catalogWindowStart, 2420);
  const imageLoadState = catalog.hooks.getCatalogThumbnailLoadState();
  assert.ok(imageLoadState.active <= 8, 'catalog thumbnails cap concurrent image loads');
  assert.ok(imageLoadState.queued > 0, 'catalog thumbnails queue deferred image loads');

  const focusedThumb = grid.children[4];
  catalog.document.activeElement = focusedThumb;
  catalog.hooks.renderCatalogGrid();
  const rerenderedThumb = catalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid')
    .children.find(child => child.dataset.index === focusedThumb.dataset.index);
  assert.equal(rerenderedThumb.focusCalls, 1, 'catalog redraw restores focus to the same thumbnail');

  const controls = catalog.hooks.elements.pagesContainer.children.find(child => child.className === 'reader-catalog-window-controls');
  const nextButton = controls.children.find(child => child.dataset.catalogWindowControl === 'next');
  catalog.document.activeElement = nextButton;
  nextButton.dispatch('click');
  assert.equal(catalog.hooks.state.catalogWindowStart, 2580, 'catalog next control keeps the requested window start');
  const rerenderedControls = catalog.hooks.elements.pagesContainer.children.find(child => child.className === 'reader-catalog-window-controls');
  const focusedNextButton = rerenderedControls.children.find(child => child.dataset.catalogWindowControl === 'next');
  assert.equal(focusedNextButton.focusCalls, 1, 'catalog window navigation restores focus to its replacement control');

  catalog.hooks.state.readingMode = 'catalog';
  catalog.hooks.updateReaderUiControls();
  for (const control of [catalog.hooks.elements.btnFitMode, catalog.hooks.elements.btnRotateLeft, catalog.hooks.elements.btnRotateRight]) {
    assert.equal(control.disabled, true, 'catalog mode disables image transform controls');
    assert.equal(control.getAttribute('aria-disabled'), 'true', 'catalog mode exposes disabled transform state to assistive technology');
  }
}

// 書架重繪使用 keyed patch：排序或背景刷新只移動既有卡片，保留 observer、焦點與捲動位置；
// 單一卡片內容變更時也只重建該卡片。
{
  const shelf = createHarness();
  const comics = Array.from({ length: 200 }, (_, index) => ({
    id: `shelf-${index}`,
    title: `Shelf ${index}`,
    type: 'archive',
    pageCount: 12,
    progress: { currentPage: 0, totalPages: 12 },
  }));
  shelf.hooks.state.filteredComics = comics;
  shelf.hooks.setFavorites([]);
  shelf.hooks.elements.contentArea = new FakeElement();
  shelf.hooks.elements.contentArea.scrollTop = 417;
  shelf.hooks.renderGrid();
  const firstCards = [...shelf.hooks.elements.comicGrid.children];
  const firstReplaceCount = shelf.hooks.elements.comicGrid.replaceChildrenCalls;
  const firstAppendCount = shelf.hooks.elements.comicGrid.appendChildCalls;
  const firstObserver = shelf.context.IntersectionObserver.instances.at(-1);
  assert.equal(firstCards.length, 200);

  shelf.hooks.renderGrid();
  assert.equal(shelf.hooks.elements.comicGrid.appendChildCalls, firstAppendCount, '同順序刷新不重排卡片');

  shelf.document.activeElement = firstCards[25];
  shelf.hooks.state.filteredComics = [...comics].reverse();
  shelf.hooks.renderGrid({ background: true });
  const reorderedCards = [...shelf.hooks.elements.comicGrid.children];
  assert.equal(reorderedCards[0], firstCards[199], '排序只移動既有卡片節點');
  assert.equal(reorderedCards[199], firstCards[0], '排序保留所有 keyed card');
  assert.equal(shelf.hooks.elements.comicGrid.replaceChildrenCalls, firstReplaceCount, '排序不再整批 replaceChildren');
  assert.equal(firstObserver.disconnectCalls, 0, 'keyed patch 不中斷舊封面 observer');
  assert.equal(shelf.document.activeElement, firstCards[25], 'keyed patch 保留目前焦點');
  assert.equal(shelf.hooks.elements.contentArea.scrollTop, 417, 'keyed patch 保留書架捲動位置');

  const changed = [...shelf.hooks.state.filteredComics];
  changed[25] = { ...changed[25], title: 'Shelf changed' };
  shelf.hooks.state.filteredComics = changed;
  shelf.hooks.renderGrid();
  const changedCards = [...shelf.hooks.elements.comicGrid.children];
  assert.equal(changedCards.find(card => card.dataset.comicId === 'shelf-25'), firstCards[25], '未變更卡片仍沿用原節點');
  assert.notEqual(changedCards.find(card => card.dataset.comicId === 'shelf-174'), firstCards[174], '變更卡片重建為新節點');
}

// 目錄快速切窗時，舊世代仍在解碼的 8 張圖不能占住新世代的併發槽位；
// 舊 load 回來也不得扣掉新世代計數。
{
  const slowCatalog = createHarness();
  slowCatalog.context.IntersectionObserver = undefined;
  slowCatalog.hooks.state.currentComic = { id: 'slow-catalog' };
  slowCatalog.hooks.state.currentComicPages = Array.from({ length: 320 }, (_, index) => `slow-${index}`);
  slowCatalog.hooks.state.currentPageIndex = 0;
  slowCatalog.hooks.state.readingMode = 'catalog';
  slowCatalog.hooks.renderPages();
  const firstGrid = slowCatalog.hooks.elements.pagesContainer.children.find(child => child.className === 'reader-catalog-grid');
  const oldActiveImages = firstGrid.children.slice(0, 8).map(thumb => thumb.children[0]);
  assert.equal(slowCatalog.hooks.getCatalogThumbnailLoadState().active, 8);

  slowCatalog.hooks.state.currentPageIndex = 319;
  slowCatalog.hooks.state.catalogWindowStart = 0;
  slowCatalog.hooks.renderCatalogGrid();
  assert.equal(slowCatalog.hooks.getCatalogThumbnailLoadState().active, 8, '新視窗立即取得完整併發額度');
  assert.ok(oldActiveImages.every(img => img.src === ''), '切窗會取消舊世代圖片 src');
  oldActiveImages[0].dispatch('load');
  assert.equal(slowCatalog.hooks.getCatalogThumbnailLoadState().active, 8, '舊世代 load 不扣新世代槽位');
}

// 書架重建取消 lazy-cover 載入時，queued/loading 卡片必須回到可重新排程的 idle。
{
  const covers = createHarness();
  const activeA = makeCover('active-reset-a');
  const activeB = makeCover('active-reset-b');
  const queued = makeCover('queued-reset');
  [activeA, activeB, queued].forEach(image => {
    image.closest('.comic-cover-wrapper').classList.add('cover-pending');
    covers.hooks.setCoverVisibility(image, true);
    covers.hooks.enqueueCoverLoad(image);
  });
  covers.clock.tick(80);
  assert.equal(covers.hooks.getCoverQueueState().active, 2);
  assert.equal(queued.dataset.coverState, 'queued');
  covers.hooks.resetCoverLoadQueue();
  for (const image of [activeA, activeB, queued]) {
    assert.equal(image.dataset.coverState, 'idle');
    assert.equal(image.dataset.coverQueued, undefined);
    assert.match(image.dataset.src, /^\/cover\//);
    assert.equal(image.closest('.comic-cover-wrapper').classList.contains('cover-pending'), true);
  }
}

// 舊版 SMB 設定若含 password，開啟設定視窗時必須立即移除並清空密碼欄位。
{
  const smb = createHarness();
  smb.context.localStorage.setItem('gai:smb', JSON.stringify({
    host: 'nas.local',
    share: 'comics',
    username: 'reader',
    password: 'legacy-secret',
  }));
  vm.runInContext('openSmbModal()', smb.context);
  assert.equal(smb.hooks.elements.smbPass.value, '', 'legacy SMB password never enters the form');
  assert.deepEqual(JSON.parse(smb.context.localStorage.getItem('gai:smb')), {
    host: 'nas.local',
    share: 'comics',
    username: 'reader',
  }, 'opening SMB settings scrubs the persisted legacy password');
}

// 初次 fetch 的 scan-status 查詢失敗後，仍要保留 polling 等待後端回報終態。
{
  const initial = createHarness();
  initial.context.window.electronAPI.getLibrary = async () => [{ id: 'book', title: 'Book' }];
  initial.context.window.electronAPI.getScanStatus = async () => { throw new Error('offline'); };
  // 本測試只隔離呈現函式；保留真正的 fetch / polling / finally 控制流程。
  vm.runInContext(`
    showLoader = () => {};
    hideLoader = () => {};
    setLoaderProgress = () => {};
    filterAndRenderGrid = () => {};
    renderSidebar = () => {};
    renderContinueStrip = () => {};
    updateStats = () => {};
  `, initial.context);
  await initial.hooks.performLibraryFetch();
  assert.equal(initial.hooks.state.scanStatus.isScanning, true);
  assert.equal(initial.hooks.state.scanStatus.pollError, true);
  assert.notEqual(initial.hooks.state.scanStatusPollTimer, null);
  initial.clock.tick(700);
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  assert.notEqual(initial.hooks.state.scanStatusPollTimer, null);
}

// 側欄視窗尺寸切換不得重新讀取書庫或重建書架。
{
  const panel = createHarness({ width: 820 });
  panel.hooks.elements.mainLayout = new FakeElement();
  vm.runInContext(`
    filterAndRenderGrid = () => { throw new Error('viewport change rebuilt grid'); };
    fetchLibrary = () => { throw new Error('viewport change fetched library'); };
    syncLibraryPanelsForViewport();
  `, panel.context);
  assert.equal(panel.hooks.elements.librarySidebar.getAttribute('aria-hidden'), 'true');
  assert.equal(panel.hooks.elements.comicInspector.getAttribute('aria-hidden'), 'true');
  vm.runInContext('applySidebarCollapsed(false)', panel.context);
  assert.equal(panel.hooks.elements.librarySidebar.getAttribute('aria-hidden'), 'false');
  assert.equal(panel.hooks.elements.comicInspector.getAttribute('aria-hidden'), 'true');
  vm.runInContext('applyInspectorCollapsed(false)', panel.context);
  assert.equal(panel.hooks.elements.librarySidebar.getAttribute('aria-hidden'), 'true');
  assert.equal(panel.hooks.elements.comicInspector.getAttribute('aria-hidden'), 'false');
  vm.runInContext('applyInspectorCollapsed(true)', panel.context);
  assert.equal(panel.hooks.elements.comicInspector.getAttribute('aria-hidden'), 'true');
  assert.equal(panel.hooks.elements.comicInspector.hidden, true, 'old WebView hidden fallback');

  panel.context.window.innerWidth = 1200;
  vm.runInContext('syncLibraryPanelsForViewport(); applySidebarCollapsed(false); applyInspectorCollapsed(false)', panel.context);
  assert.equal(panel.hooks.elements.librarySidebar.getAttribute('aria-hidden'), 'false');
  assert.equal(panel.hooks.elements.comicInspector.getAttribute('aria-hidden'), 'false');
  vm.runInContext('applySidebarCollapsed(true)', panel.context);
  assert.equal(panel.hooks.elements.comicInspector.getAttribute('aria-hidden'), 'false', 'wide panels are independent');
  // 現代 WebView 的 inert 分支，以及開啟狀態重套時不得搶走焦點。
  panel.hooks.elements.comicInspector.inert = false;
  panel.document.activeElement = panel.hooks.elements.comicInspector;
  const toggle = panel.hooks.elements.inspectorCollapseBtn;
  const previousFocusCalls = toggle.focusCalls || 0;
  vm.runInContext('applyInspectorCollapsed(false)', panel.context);
  assert.equal(toggle.focusCalls || 0, previousFocusCalls);
  vm.runInContext('applyInspectorCollapsed(true)', panel.context);
  assert.equal(toggle.focusCalls, previousFocusCalls + 1);
  assert.equal(panel.hooks.elements.comicInspector.inert, true);
  vm.runInContext('applyInspectorCollapsed(false)', panel.context);
  assert.equal(panel.hooks.elements.comicInspector.inert, false);
}

// 回上層逐層返回，不把來源根目錄當作可穿越的檔案系統路徑。
{
  const navigation = createHarness();
  const visibleScanPaths = [];
  navigation.context.window.electronAPI.scanVisibleDirectory = path => {
    visibleScanPaths.push(path);
    return Promise.resolve();
  };
  vm.runInContext('filterAndRenderGrid = () => {}', navigation.context);
  navigation.hooks.state.currentPath = '系列/第一部/第一冊';
  vm.runInContext('navigateLibraryUp()', navigation.context);
  assert.equal(navigation.hooks.state.currentPath, '系列/第一部');
  vm.runInContext('navigateLibraryUp(); navigateLibraryUp(); navigateLibraryUp()', navigation.context);
  await Promise.resolve();
  assert.deepEqual(visibleScanPaths, ['系列/第一部', '系列', ''], 'each navigated directory, including root, requests a shallow scan');
  assert.equal(navigation.hooks.state.currentPath, '');
  assert.equal(navigation.hooks.elements.libraryUpBtn.disabled, true);
}

// 一般漫畫第一次只開詳情，收合後第二次仍開啟原書，而非被抽屜狀態重置選取。
{
  const selection = createHarness({ width: 820 });
  vm.runInContext(`
    syncLibraryPanelsForViewport({ initial: true });
    window.readerOpens = [];
    openReader = id => window.readerOpens.push(id);
    renderComicInspector = comic => { state.selectedComicId = comic.id; };
    syncGridSelectionState = () => {};
    activateGridComic({ id: 'normal-book', title: '測試書' });
  `, selection.context);
  assert.equal(selection.context.window.readerOpens.length, 0);
  assert.equal(selection.hooks.elements.comicInspector.getAttribute('aria-hidden'), 'false');
  vm.runInContext(`
    applyInspectorCollapsed(true);
    activateGridComic({ id: 'normal-book', title: '測試書' });
  `, selection.context);
  assert.deepEqual(Array.from(selection.context.window.readerOpens), ['normal-book']);
  vm.runInContext(`
    const previewComic = createBuiltInDemoComics()[0];
    activateGridComic(previewComic);
  `, selection.context);
  assert.deepEqual(Array.from(selection.context.window.readerOpens), ['normal-book'], '示範卡第一次同樣只顯示詳情');
  vm.runInContext('activateGridComic(previewComic);', selection.context);
  assert.deepEqual(Array.from(selection.context.window.readerOpens), ['normal-book', 'builtin:landscape-mountains'], '示範卡第二次才開始試讀');
}

// 內建風景 catalog 固定為 8 組；page-01 是封面本身，不另加一張重複封面頁。
{
  const demo = createHarness();
  const groups = demo.hooks.createBuiltInDemoComics();
  assert.deepEqual(Array.from(groups, item => item.demoSlug), ['mountains', 'rivers', 'coasts', 'forests', 'lakes', 'deserts', 'snow', 'cosmos']);
  assert.deepEqual(Array.from(groups, item => item.pageCount), [2, 1, 2, 1, 2, 1, 1, 3]);
  assert.ok(groups.every(item => item.isBuiltInDemo && item.sourceId === 'builtin:landscapes'));
  assert.ok(groups.every(item => item.updatedAt === null), 'demo ordering must not use a fake future updatedAt');
  assert.deepEqual(
    Array.from(groups, item => Array.from(demo.hooks.builtInDemoReaderData(item).pages)),
    [
      ['assets/demo/landscapes/mountains/page-01.png', 'assets/demo/landscapes/mountains/page-02.png'],
      ['assets/demo/landscapes/rivers/page-01.png'],
      ['assets/demo/landscapes/coasts/page-01.png', 'assets/demo/landscapes/coasts/page-02.png'],
      ['assets/demo/landscapes/forests/page-01.png'],
      ['assets/demo/landscapes/lakes/page-01.png', 'assets/demo/landscapes/lakes/page-02.png'],
      ['assets/demo/landscapes/deserts/page-01.png'],
      ['assets/demo/landscapes/snow/page-01.png'],
      ['assets/demo/landscapes/cosmos/page-01.png', 'assets/demo/landscapes/cosmos/page-02.png', 'assets/demo/landscapes/cosmos/page-03.png'],
    ]
  );
}

// 有正式漫畫時隱藏內建示範；空書架仍可試讀。
{
  const catalog = createHarness();
  const demos = catalog.hooks.createBuiltInDemoComics();
  catalog.hooks.elements.searchInput.value = '';
  catalog.hooks.state.activeSeries = 'all';
  catalog.hooks.state.activeFilter = 'all';
  catalog.hooks.state.currentPath = '';
  catalog.hooks.state.catalogSearchIds = null;
  catalog.hooks.state.comics = [
    { id: 'formal-z', title: '正式 Z', series: '正式系列', relativePath: '正式 Z.cbz', pageCount: 2 },
    { id: 'formal-a', title: '正式 A', series: '正式系列', relativePath: '正式 A.cbz', pageCount: 2 },
    { id: 'folder-book', title: '子目錄書', series: '正式系列', relativePath: '正式系列/子目錄書.cbz', pageCount: 2 },
    ...demos,
  ];
  const root = catalog.hooks.getDirectoryItems();
  const formalFolder = root.find(item => item.isDirectory && item.title === '正式系列');
  assert.deepEqual(Array.from(root, item => item.id), [formalFolder.id, 'formal-a', 'formal-z']);
  assert.equal(root.some(item => item.isDirectory && item.title === '正式系列'), true, '正式庫項目仍留在根目錄折疊結果');

  catalog.hooks.state.comics = [{
    id: 'root-images',
    title: '目標資料夾',
    type: 'folder',
    relativePath: '.',
    pageCount: 3,
  }];
  catalog.hooks.state.currentPath = '';
  const rootImages = catalog.hooks.getDirectoryItems();
  assert.deepEqual(Array.from(rootImages, item => item.id), ['root-images']);
  assert.equal(rootImages[0].isDirectory, false, '掃描根目錄的圖片集合必須是可閱讀項目');

  catalog.hooks.state.comics = [
    { id: 'formal-z', title: '正式 Z', series: '正式系列', relativePath: '正式 Z.cbz', pageCount: 2 },
    { id: 'formal-a', title: '正式 A', series: '正式系列', relativePath: '正式 A.cbz', pageCount: 2 },
    { id: 'folder-book', title: '子目錄書', series: '正式系列', relativePath: '正式系列/子目錄書.cbz', pageCount: 2 },
    ...demos,
  ];
  catalog.hooks.state.currentPath = '正式系列';
  const child = catalog.hooks.getDirectoryItems();
  assert.deepEqual(Array.from(child, item => item.id), ['folder-book']);
  assert.equal(child.some(item => catalog.hooks.isBuiltInDemoComic(item)), false);

  catalog.hooks.state.currentPath = '';
  catalog.hooks.elements.searchInput.value = '宇宙';
  catalog.hooks.state.catalogSearchIds = new Set(['formal-a']);
  const search = catalog.hooks.getDirectoryItems();
  assert.deepEqual(Array.from(search, item => item.id), [], '正式書架搜尋不混入內建示範');

  catalog.hooks.elements.searchInput.value = '';
  catalog.hooks.state.catalogSearchIds = null;
  catalog.hooks.state.activeSeries = '風景選集';
  assert.deepEqual(Array.from(catalog.hooks.getDirectoryItems(), item => item.id), []);

  catalog.hooks.state.comics = demos;
  catalog.hooks.state.activeSeries = 'all';
  assert.deepEqual(Array.from(catalog.hooks.getDirectoryItems(), item => item.id), Array.from(demos, item => item.id));

  catalog.hooks.state.comics = [{ id: 'formal-a', title: '正式 A', relativePath: '正式 A.cbz' }, ...demos];
  catalog.hooks.state.activeSeries = 'all';
  catalog.hooks.state.activeFilter = 'favorite';
  catalog.hooks.setFavorites(['formal-a']);
  assert.equal(catalog.hooks.getDirectoryItems().some(item => catalog.hooks.isBuiltInDemoComic(item)), false);
}

// 收藏篩選與書架 render key 必須以 Set 查找，5000 筆收藏不應逐次掃描整個陣列。
{
  const catalog = createHarness();
  const favoriteIds = Array.from({ length: 5000 }, (_, index) => `favorite-${index}`);
  catalog.hooks.setFavorites(favoriteIds);
  assert.equal(typeof catalog.hooks.state.favoriteIds?.has, 'function', '收藏索引應提供 Set 查找介面');
  assert.equal(catalog.hooks.isFavoriteId('favorite-4999'), true, '收藏索引應命中尾端項目');
  assert.equal(catalog.hooks.isFavoriteId('not-favorite'), false, '收藏索引不應誤判未收藏項目');
  catalog.hooks.elements.searchInput = { value: '' };
  catalog.hooks.state.activeFilter = 'favorite';
  catalog.hooks.state.comics = favoriteIds.map(id => ({
    id,
    title: id,
    relativePath: `${id}.cbz`,
    pageCount: 1,
  }));
  assert.equal(catalog.hooks.getDirectoryItems().length, 5000, '大量收藏篩選應完整保留所有命中項目');
}

// 全庫掃描中的優先查找以 generation + 收藏 ID 去重，且收藏數量受限；
// 收藏切換只送提示，不等待 native I/O，也不會被目錄導覽重複啟動。
{
  const priority = createHarness();
  const calls = [];
  priority.context.window.electronAPI.scanPriorityLibrary = favoriteIds => {
    calls.push([...favoriteIds]);
    return new Promise(() => {});
  };
  priority.hooks.state.scanStatus = { isScanning: true, generation: 41 };
  const favorites = ['fav-a', 'fav-a', '', 42, ...Array.from({ length: 5000 }, (_, index) => `fav-${index}`)];
  priority.hooks.setFavorites(favorites);
  assert.equal(calls.length, 0, 'priority scan must be deferred without blocking the caller');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'initial favorite snapshot should trigger one priority scan');
  assert.equal(calls[0].length, 4096, 'priority scan IPC payload must be capped');
  assert.deepEqual(calls[0].slice(0, 2), ['fav-a', 'fav-0'], 'priority IDs should be filtered and deduplicated');

  priority.hooks.setFavorites(favorites);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'same generation and IDs must be deduplicated');

  priority.hooks.setFavorites(['new-favorite', ...favorites]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2, 'favorite changes must trigger a new priority scan');

  priority.hooks.updateLoaderScanProgress({ generation: 42, isScanning: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3, 'a new full scan generation must get a fresh priority scan');

  priority.context.window.electronAPI.isElectron = false;
  priority.hooks.updateLoaderScanProgress({ generation: 43, isScanning: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3, 'browser mode must never call the native priority scan');
}

// 目錄切換只觸發既有可見目錄掃描，不應重送同一個全庫優先查找；
// IPC 暫時失敗則允許相同 generation + IDs 在下一次狀態更新重試。
{
  const retry = createHarness();
  let attempts = 0;
  retry.context.console.warn = () => {};
  retry.context.window.electronAPI.scanPriorityLibrary = () => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error('temporary native failure')) : Promise.resolve();
  };
  retry.context.window.electronAPI.scanVisibleDirectory = () => Promise.resolve();
  retry.hooks.state.scanStatus = { isScanning: true, generation: 9 };
  retry.hooks.setFavorites(['retry-book']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1, 'priority scan should report one failed native attempt');
  retry.hooks.updateLoaderScanProgress({ generation: 9, isScanning: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2, 'failed priority scans should retry on a later matching status update');
  retry.context.window.electronAPI.isElectron = true;
  vm.runInContext('filterAndRenderGrid = () => {}; navigateLibraryToPath("series")', retry.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2, 'directory navigation must not restart the full-library priority scan');
}

// 初始全庫快照很慢時，favorites + scan status 仍應先送出 priority hint。
{
  const early = createHarness();
  const calls = [];
  let resolveLibrary;
  early.context.window.electronAPI.getLibrary = () => new Promise(resolve => { resolveLibrary = resolve; });
  early.context.window.electronAPI.getFavorites = async () => ['early-favorite'];
  early.context.window.electronAPI.getScanStatus = async () => ({ isScanning: true, generation: 12 });
  early.context.window.electronAPI.scanPriorityLibrary = ids => {
    calls.push([...ids]);
    return Promise.resolve();
  };
  vm.runInContext(`
    showLoader = () => {};
    hideLoader = () => {};
    setLoaderProgress = () => {};
    filterAndRenderGrid = () => {};
    renderSidebar = () => {};
    renderContinueStrip = () => {};
    updateStats = () => {};
  `, early.context);
  const loading = early.hooks.performLibraryFetch();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['early-favorite']], 'priority hint should precede the slow full-library snapshot');
  resolveLibrary([]);
  await loading;
  early.hooks.stopScanStatusPolling();
}

// 空庫與有正式庫都注入相同的 8 組前端衍生資料；不會把示範寫回 native library。
// 優先掃描先於舊 getLibrary 快照回來時，快照提交不能清掉剛找到的漫畫。
{
  const raced = createHarness();
  let resolveLibrary;
  raced.context.window.electronAPI.getLibrary = () => new Promise(resolve => { resolveLibrary = resolve; });
  raced.context.window.electronAPI.getFavorites = async () => [];
  raced.context.window.electronAPI.getScanStatus = async () => ({ isScanning: true, generation: 12 });
  vm.runInContext(`
    showLoader = () => {};
    hideLoader = () => {};
    setLoaderProgress = () => {};
    filterAndRenderGrid = () => {};
    renderSidebar = () => {};
    renderContinueStrip = () => {};
    updateStats = () => {};
  `, raced.context);
  const loading = vm.runInContext('fetchLibrary()', raced.context);
  await new Promise(resolve => setImmediate(resolve));
  raced.hooks.applyIncrementalLibraryBatch({
    generation: 12,
    found: 1,
    items: [{ id: 'priority-book', title: '優先找到', relativePath: 'priority-book.cbz' }],
  });
  resolveLibrary([]);
  await loading;
  assert.equal(raced.hooks.state.comics.some(comic => comic.id === 'priority-book'), true);
  raced.hooks.stopScanStatusPolling();
}

for (const formalLibrary of [
  [],
  [{ id: 'formal-book', title: '正式漫畫', relativePath: 'formal-book.cbz', pageCount: 4 }],
]) {
  const library = createHarness();
  library.context.window.electronAPI.getLibrary = async () => formalLibrary;
  library.context.window.electronAPI.getFavorites = async () => [];
  let scanReads = 0;
  library.context.window.electronAPI.getScanStatus = async () => { scanReads += 1; return { isScanning: false }; };
  vm.runInContext(`
    showLoader = () => {};
    hideLoader = () => {};
    setLoaderProgress = () => {};
    filterAndRenderGrid = () => {};
    renderSidebar = () => {};
    renderContinueStrip = () => {};
    updateStats = () => {};
  `, library.context);
  const loading = library.hooks.performLibraryFetch();
  for (let step = 0; step < 8; step++) {
    await new Promise(resolve => setImmediate(resolve));
    library.clock.tick(100);
  }
  await loading;
  assert.equal(scanReads, formalLibrary.length ? 1 : 7, '示範不能掩蓋正式空庫的六次啟動等待');
  const builtIns = library.hooks.state.comics.filter(library.hooks.isBuiltInDemoComic);
  assert.equal(builtIns.length, 8);
  assert.equal(library.hooks.state.comics.some(item => item.id === 'formal-book'), formalLibrary.length > 0);
}

// 首次正式庫讀取例外且目前沒有正式漫畫時，catch/finally 路徑也要留下 8 組示範。
{
  const failed = createHarness();
  failed.context.window.electronAPI.getLibrary = async () => { throw new Error('temporary catalog failure'); };
  vm.runInContext(`
    showLoader = () => {};
    hideLoader = () => {};
    setLoaderProgress = () => {};
    filterAndRenderGrid = () => {};
    renderSidebar = () => {};
    renderContinueStrip = () => {};
    updateStats = () => {};
  `, failed.context);
  await failed.hooks.performLibraryFetch();
  assert.equal(failed.hooks.state.comics.filter(failed.hooks.isBuiltInDemoComic).length, 8);
}

// getCoverUrl 只抽出函式放進 isolated VM 也要能處理內建路由，不依賴 eAPI lexical binding。
{
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const functionSource = source.match(/function getCoverUrl\(comicId\) \{[\s\S]*?\n\}\n\nconst READER_PRELOAD/)[0].replace(/\n\nconst READER_PRELOAD[\s\S]*$/, '');
  const isolated = {};
  vm.createContext(isolated);
  vm.runInContext(`${functionSource}\nresult = getCoverUrl('builtin:landscape-cosmos');`, isolated);
  assert.equal(isolated.result, 'assets/demo/landscapes/cosmos/page-01.png');
}

console.log('catalog scheduling behavior tests passed');

// 掃描目標根層的散圖是可直接選取的一頁項目，不能再被折成整個根資料夾。
{
  const looseImages = createHarness();
  looseImages.hooks.state.comics = [{
    id: 'root-png',
    title: '下載圖片',
    type: 'image',
    relativePath: '下載圖片.png',
    ext: '.png',
    pageCount: 1,
  }];
  looseImages.hooks.state.currentPath = '';
  looseImages.hooks.elements.searchInput.value = '';
  looseImages.hooks.state.activeSeries = 'all';
  looseImages.hooks.state.activeFilter = 'all';
  const items = looseImages.hooks.getDirectoryItems();
  const image = items.find(item => item.id === 'root-png');
  assert.ok(image, '根層 PNG 應直接出現在書架');
  assert.equal(image.isDirectory, false);
  assert.equal(looseImages.hooks.isLooseImage(image), true);
}

{
  const malformed = createHarness();
  malformed.hooks.state.comics = [{ id: 'missing-path', title: 'Missing path' }];
  malformed.hooks.state.currentPath = 'folder';
  malformed.hooks.elements.searchInput.value = '';
  malformed.hooks.state.activeSeries = 'all';
  malformed.hooks.state.activeFilter = 'all';
  assert.doesNotThrow(() => malformed.hooks.getDirectoryItems(), '缺少相對路徑的舊資料不能使目錄導覽崩潰');
}

// 外部資料夾新增 intent 必須在 queue 內重讀最新 localStorage；兩個 picker
// 交錯完成時，後者不能用舊 snapshot 覆蓋前者。
{
  const additions = createHarness();
  const nativeSnapshots = [];
  let releaseFirst;
  let pickerCalls = 0;
  let nativeCalls = 0;
  additions.context.showLoader = () => {};
  additions.context.startScanStatusPolling = () => {};
  additions.context.scheduleLibraryRefresh = () => {};
  additions.context.window.electronAPI.openExternalFolder = async () => (
    pickerCalls++ === 0
      ? { name: '來源 A', bookmark: 'bookmark-a' }
      : { name: '來源 B', bookmark: 'bookmark-b' }
  );
  additions.context.window.electronAPI.setBookmarks = bookmarks => {
    nativeSnapshots.push(Array.from(bookmarks, item => item.bookmark));
    nativeCalls += 1;
    if (nativeCalls === 1) return new Promise(resolve => { releaseFirst = resolve; });
    return Promise.resolve();
  };
  // The picker mock above uses nativeCalls, so both picker results are issued
  // before the first native commit releases the queue.
  const addSource = additions.context.addIOSLibrarySource || additions.context.window.__GIA_TEST_HOOKS__.addIOSLibrarySource;
  assert.equal(typeof addSource, 'function', 'test hook should expose iOS source addition');
  const firstAdd = addSource();
  const secondAdd = addSource();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nativeSnapshots, [['bookmark-a']], 'first add commits its own latest snapshot');
  releaseFirst();
  await Promise.all([firstAdd, secondAdd]);
  const persisted = JSON.parse(additions.context.localStorage.getItem('gai:externalBookmarks'));
  assert.deepEqual(persisted.map(item => item.bookmark), ['bookmark-a', 'bookmark-b'], 'queued adds preserve both intents');
  assert.deepEqual(nativeSnapshots, [['bookmark-a'], ['bookmark-a', 'bookmark-b']], 'second add reads first committed snapshot');
}

// 刪除按 bookmark identity 處理；兩個舊 row 同時操作時，第二個 intent
// 會在 queue 內讀到第一個刪除後的清單，不依賴 render 當下的 index。
{
  const removals = createHarness();
  const saved = [
    { name: '來源 A', bookmark: 'bookmark-a' },
    { name: '來源 B', bookmark: 'bookmark-b' },
  ];
  removals.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify(saved));
  const nativeSnapshots = [];
  let releaseFirst;
  let nativeCalls = 0;
  removals.context.window.electronAPI.setBookmarks = bookmarks => {
    nativeSnapshots.push(Array.from(bookmarks, item => item.bookmark));
    nativeCalls += 1;
    if (nativeCalls === 1) return new Promise(resolve => { releaseFirst = resolve; });
    return Promise.resolve();
  };
  removals.hooks.elements.refreshBtn.click = () => {};
  vm.runInContext('renderExternalBookmarks()', removals.context);
  const rows = removals.document.getElementById('external-bookmarks-list').children
    .filter(item => item.children.some(child => child.tagName === 'BUTTON'));
  const removeA = rows[0].children.find(child => child.tagName === 'BUTTON');
  const removeB = rows[1].children.find(child => child.tagName === 'BUTTON');
  const firstRemoval = removeA.onclick();
  const secondRemoval = removeB.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nativeSnapshots, [['bookmark-b']], 'first delete commits only its bookmark identity removal');
  releaseFirst();
  await Promise.all([firstRemoval, secondRemoval]);
  const persisted = JSON.parse(removals.context.localStorage.getItem('gai:externalBookmarks'));
  assert.deepEqual(persisted, [], 'queued deletes preserve both removal intents');
  assert.deepEqual(nativeSnapshots, [['bookmark-b'], []], 'second delete reads first committed snapshot');
}
console.log('external bookmark intent queue tests passed');

// 同一 bookmark 改名只更新保存名稱，不應觸發重新掃描；相同名稱才是重複加入。
{
  const duplicate = createHarness();
  duplicate.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify([
    { name: '舊名稱', bookmark: 'bookmark-same' },
  ]));
  duplicate.context.window.electronAPI.openExternalFolder = async () => ({
    name: '新名稱',
    bookmark: 'bookmark-same',
  });
  let nativeCalls = 0;
  duplicate.context.window.electronAPI.setBookmarks = async () => { nativeCalls += 1; };
  duplicate.context.showLoader = () => { throw new Error('rename must not show scan loader'); };
  duplicate.context.startScanStatusPolling = () => { throw new Error('rename must not start scan polling'); };
  duplicate.context.scheduleLibraryRefresh = () => { throw new Error('rename must not schedule a scan'); };
  await duplicate.hooks.addIOSLibrarySource();
  const persisted = JSON.parse(duplicate.context.localStorage.getItem('gai:externalBookmarks'));
  assert.deepEqual(persisted, [{ name: '新名稱', bookmark: 'bookmark-same' }], 'same bookmark rename must update the saved name');
  assert.equal(nativeCalls, 1, 'same bookmark rename must submit one updated native snapshot');
}

// SMB legacy config is sanitized before the modal opens; a failed rewrite removes
// the old record so a password cannot remain in localStorage.
{
  const smb = createHarness();
  smb.context.localStorage.setItem('gai:smb', JSON.stringify({
    host: 'nas.local',
    share: 'comics',
    username: 'reader',
    password: 'legacy-secret',
  }));
  vm.runInContext('sanitizeSmbConfig()', smb.context);
  assert.deepEqual(JSON.parse(smb.context.localStorage.getItem('gai:smb')), {
    host: 'nas.local',
    share: 'comics',
    username: 'reader',
  }, 'startup SMB sanitizer keeps connection fields and removes password');

  const failedWrite = createHarness();
  failedWrite.context.localStorage.setItem('gai:smb', JSON.stringify({ host: 'nas.local', password: 'legacy-secret' }));
  failedWrite.context.localStorage.setItem = () => { throw new Error('storage full'); };
  vm.runInContext('sanitizeSmbConfig()', failedWrite.context);
  assert.equal(failedWrite.context.localStorage.getItem('gai:smb'), null, 'failed SMB rewrite removes the legacy record');

  const failedRead = createHarness();
  failedRead.context.localStorage.setItem('gai:smb', JSON.stringify({ password: 'legacy-secret' }));
  failedRead.context.localStorage.getItem = () => { throw new Error('storage unavailable'); };
  vm.runInContext('sanitizeSmbConfig()', failedRead.context);
  assert.equal(failedRead.context.localStorage.values.has('gai:smb'), false, 'failed SMB read still attempts to remove the legacy record');
}

// 初始化 restore 即使 localStorage 為空，也要以空全量清單清掉同 process
// 可能殘留的 native 來源。
{
  const restore = createHarness();
  let restored;
  restore.context.window.electronAPI.setBookmarks = async bookmarks => {
    restored = Array.from(bookmarks);
  };
  await restore.hooks.restoreExternalBookmarks();
  assert.deepEqual(restored, [], 'empty restore must submit an empty native bookmark list');
}
console.log('external bookmark identity and empty restore tests passed');

// 原生清單已提交但權限釋放失敗時，移除後的清單仍須保存；真正失敗則保留原清單。
for (const [nativeError, expectedCount] of [
  [null, 0],
  ['清單已更新，舊權限可能未完全釋放；無法釋放外部資料夾權限', 0],
  ['無法更新來源清單', 1],
]) {
  const removal = createHarness();
  const saved = [{ name: '測試來源', bookmark: 'test-bookmark' }];
  removal.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify(saved));
  removal.context.window.electronAPI.setBookmarks = async () => {
    if (nativeError) throw new Error(nativeError);
  };
  removal.hooks.elements.refreshBtn.click = () => {};
  vm.runInContext('renderExternalBookmarks()', removal.context);
  const row = removal.document.getElementById('external-bookmarks-list').children[0];
  await row.children.find(child => child.tagName === 'BUTTON').onclick();
  const persisted = JSON.parse(removal.context.localStorage.getItem('gai:externalBookmarks'));
  assert.equal(persisted.length, expectedCount, 'removal persistence must follow native commit state');
}
console.log('bookmark removal persistence tests passed');

// Finder 入口只出現在桌面原生 App；iPad 桌面 UA 與照片虛擬來源也要排除。
{
  const finder = createHarness();
  finder.context.window.electronAPI.showItemInFolder = async () => {};
  finder.context.navigator.platform = 'MacIntel';
  const local = { id: 'local-book', sourceId: 'local:library' };
  assert.equal(finder.hooks.canShowFileLocation(local), true);
  finder.context.navigator.maxTouchPoints = 5;
  assert.equal(finder.hooks.canShowFileLocation(local), false);
  finder.context.navigator.maxTouchPoints = 0;
  assert.equal(finder.hooks.canShowFileLocation({ id: 'photos:album' }), false);
  delete finder.context.window.electronAPI.showItemInFolder;
  assert.equal(finder.hooks.canShowFileLocation(local), false);
}
console.log('Finder platform boundary tests passed');

assert.equal(hooks.getCoverUrl('photos:YWxidW0'), 'gai://cover/photos:YWxidW0', '照片封面ID保留protocol可識別的冒號');
