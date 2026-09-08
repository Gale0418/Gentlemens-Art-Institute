import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
  }

  appendChild(child) {
    if (child?.isFragment) {
      for (const item of child.children.slice()) this.appendChild(item);
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
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
    return [];
  }
  scrollIntoView() {}
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
}

class FakeDocumentFragment extends FakeElement {
  constructor() { super('#fragment'); this.isFragment = true; }
}

function createHarness({ width = 1000 } = {}) {
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
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  const electronAPI = {
    isElectron: true,
    getScanStatus: () => Promise.resolve({ isScanning: false }),
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
  const RealDate = Date;
  context.Date = class TestDate extends RealDate {
    static now() { return clock.now; }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context, { filename: 'public/app.js' });
  return { clock, context, hooks: window.__GIA_TEST_HOOKS__, document };
}

const { clock, context, hooks } = createHarness();
const makeCover = id => {
  const img = new FakeElement('img');
  img.dataset.coverId = id;
  img.dataset.src = `/cover/${id}`;
  return img;
};

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

// Poll 不重疊，舊世代回覆也不能覆蓋新一輪 scan 狀態；故障會解除 isScanning。
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

  // 連續故障六次應明確結束狀態，而不是只隱藏 loader。
  let failures = 0;
  context.window.electronAPI.getScanStatus = async () => { failures += 1; throw new Error('offline'); };
  hooks.startScanStatusPolling();
  for (let index = 0; index < 6; index += 1) {
    clock.tick(700);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  }
  assert.equal(failures, 6);
  assert.equal(hooks.state.scanStatus.isScanning, false);
  assert.equal(hooks.state.scanStatus.pollError, true);
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
  assert.equal(pages.children.length, 3);
  hooks.renderPages();
  assert.equal(pages.children.length, 3);
}

// 初次 fetch 的 scan-status 查詢失敗後，finally 停止 polling 不可遺留 gate。
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
  assert.equal(initial.hooks.state.scanStatus.isScanning, false);
  assert.equal(initial.hooks.state.scanStatus.pollError, true);
  assert.equal(initial.hooks.state.scanStatusPollTimer, null);
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
  vm.runInContext('filterAndRenderGrid = () => {}', navigation.context);
  navigation.hooks.state.currentPath = '系列/第一部/第一冊';
  vm.runInContext('navigateLibraryUp()', navigation.context);
  assert.equal(navigation.hooks.state.currentPath, '系列/第一部');
  vm.runInContext('navigateLibraryUp(); navigateLibraryUp(); navigateLibraryUp()', navigation.context);
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

// 根目錄固定排序；正式庫存在時仍顯示，進入正式子目錄則不混入示範。
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
  assert.deepEqual(Array.from(root.slice(0, 8), item => item.id), Array.from(demos, item => item.id));
  assert.equal(root.some(item => item.isDirectory && item.title === '正式系列'), true, '正式庫項目仍留在根目錄折疊結果');

  catalog.hooks.state.currentPath = '正式系列';
  const child = catalog.hooks.getDirectoryItems();
  assert.deepEqual(Array.from(child, item => item.id), ['folder-book']);
  assert.equal(child.some(item => catalog.hooks.isBuiltInDemoComic(item)), false);

  catalog.hooks.state.currentPath = '';
  catalog.hooks.elements.searchInput.value = '宇宙';
  catalog.hooks.state.catalogSearchIds = new Set(['formal-a']);
  const search = catalog.hooks.getDirectoryItems();
  assert.deepEqual(Array.from(search, item => item.id), ['builtin:landscape-cosmos'], 'local demo search must survive SQLite result filtering');

  catalog.hooks.elements.searchInput.value = '';
  catalog.hooks.state.catalogSearchIds = null;
  catalog.hooks.state.activeSeries = '風景選集';
  assert.deepEqual(Array.from(catalog.hooks.getDirectoryItems(), item => item.id), Array.from(demos, item => item.id));

  catalog.hooks.state.activeSeries = 'all';
  catalog.hooks.state.activeFilter = 'favorite';
  catalog.hooks.state.favorites = ['formal-a'];
  assert.equal(catalog.hooks.getDirectoryItems().some(item => catalog.hooks.isBuiltInDemoComic(item)), false);
}

// 空庫與有正式庫都注入相同的 8 組前端衍生資料；不會把示範寫回 native library。
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

{
  const malformed = createHarness();
  malformed.hooks.state.comics = [{ id: 'missing-path', title: 'Missing path' }];
  malformed.hooks.state.currentPath = 'folder';
  malformed.hooks.elements.searchInput.value = '';
  malformed.hooks.state.activeSeries = 'all';
  malformed.hooks.state.activeFilter = 'all';
  assert.doesNotThrow(() => malformed.hooks.getDirectoryItems(), '缺少相對路徑的舊資料不能使目錄導覽崩潰');
}

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
