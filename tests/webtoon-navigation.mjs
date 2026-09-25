import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const messages = fs.readFileSync(new URL('../public/locales/reader-messages.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = app.indexOf(`function ${name}`);
  assert.ok(start >= 0, `app.js should define ${name}`);
  const bodyStart = app.indexOf(') {', start) + 2;
  let depth = 0;
  for (let index = bodyStart; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`unable to extract ${name}`);
}

const sourceKey = vm.runInNewContext(`(${extractFunction('getComicSourceKey')})`, {
  isBuiltInDemoComic: comic => comic?.sourceId === 'builtin:landscapes',
  isPhotoAlbum: comic => String(comic?.id || '').startsWith('photos:'),
});
assert.equal(sourceKey({ id: 'a', sourceId: 'local:one' }), 'local:one');
assert.equal(sourceKey({ id: 'demo', sourceId: 'builtin:landscapes' }), 'builtin:landscapes');
assert.equal(sourceKey({ id: 'photos:album-a', sourceId: 'photos:' }), 'photos:');
assert.notEqual(sourceKey({ id: 'a', sourceId: 'local:one' }), sourceKey({ id: 'photos:album-a', sourceId: 'photos:' }));

const readerAnchor = extractFunction('getReaderNavigationCurrent');
const adjacent = extractFunction('findAdjacentComicInFolder');
assert.match(readerAnchor, /state\.currentComic\?\.id \|\| state\.pendingComicId/);
assert.doesNotMatch(`${readerAnchor}\n${adjacent}`, /selectedComicId/);
assert.match(adjacent, /getComicNavigationCache\(\)\.groups\.get/);
assert.match(app, /groups\.forEach\(group => group\.sort\(\(a, b\) => comicTitleCollator\.compare/);

const pointer = extractFunction('handleReaderPointerClick');
assert.match(pointer, /state\.readingMode === 'webtoon'/);
assert.doesNotMatch(pointer, /requestWebtoonAdjacentComic/);
assert.doesNotMatch(pointer, /getWebtoonEdgeAtPoint/);
assert.match(app, /function createWebtoonNavigationButton\(direction\)/);
const focusableCheck = vm.runInNewContext(`(${extractFunction('isReaderElementActuallyFocusable')})`, {
  getComputedStyle: element => element.computedStyle || {},
  window: { innerWidth: 1000, innerHeight: 800 },
});
const visibleControl = {
  hidden: false,
  disabled: false,
  getAttribute: () => null,
  computedStyle: { display: 'block', visibility: 'visible', pointerEvents: 'auto', opacity: '1' },
};
assert.equal(focusableCheck(visibleControl), true, 'visible enabled reader control remains focusable');
assert.equal(focusableCheck({ ...visibleControl, disabled: true }), false, 'disabled reader control is excluded from focus trap');
assert.equal(focusableCheck({ ...visibleControl, computedStyle: { ...visibleControl.computedStyle, display: 'none' } }), false, 'CSS hidden reader control is excluded from focus trap');
const hiddenParent = { hidden: false, disabled: false, parentNode: null, getAttribute: () => null, computedStyle: { display: 'none' } };
assert.equal(focusableCheck({ ...visibleControl, parentNode: hiddenParent }), false, 'control under a CSS hidden reader bar is excluded from focus trap');
{
  const guard = extractFunction('guardReaderFocus');
  let redirected = 0;
  const modal = {
    hidden: false,
    getAttribute: name => name === 'aria-hidden' ? null : 'true',
  };
  const target = { closest: selector => selector === '[aria-modal="true"]' ? modal : null };
  const context = {
    state: { readerBoundaryDialog: null },
    elements: { readerOverlay: { style: { display: 'flex' }, contains: () => false } },
    getComputedStyle: () => ({ display: 'flex', visibility: 'visible' }),
    focusReaderEntry: () => { redirected += 1; },
  };
  vm.runInNewContext(`${guard}\nguardReaderFocus({ target: target });`, { ...context, target });
  assert.equal(redirected, 0, 'focus inside a visible aria-modal is allowed while the reader is open');
  modal.hidden = true;
  vm.runInNewContext(`${guard}\nguardReaderFocus({ target: target });`, { ...context, target });
  assert.equal(redirected, 1, 'focus inside a hidden aria-modal still returns to the reader entry');
  context.state.readerBoundaryDialog = { overlay: { contains: () => true } };
  vm.runInNewContext(`${guard}\nguardReaderFocus({ target: target });`, { ...context, target });
  assert.equal(redirected, 1, 'reader boundary dialog remains an explicit focus exception');
}
assert.match(extractFunction('trapReaderFocus'), /triggerControlsActive\(\)/, 'empty reader focus trap wakes idle chrome');
assert.match(css, /\.reader-overlay\.mode-webtoon \.webtoon-nav-button[\s\S]*min-height: 44px/);
assert.match(css, /\.reader-overlay\.mode-single \.reader-viewport[\s\S]*overflow: auto/);
assert.match(css, /\.reader-overlay\.mode-single \.reader-viewport[\s\S]*touch-action: pan-x pan-y/);
assert.match(css, /\.reader-overlay\.mode-single\.single-page-pannable \.nav-zone[\s\S]*pointer-events: none/);
assert.match(css, /\.nav-zone[\s\S]*pointer-events: none/, 'nav zones must not intercept viewport touch gestures');
assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*\.reader-bottom-bar[\s\S]*grid-template-columns: auto minmax\(0, 1fr\)/, 'iPad portrait reader controls use a compact two-row layout');
assert.match(css, /\.reader-bottom-bar \.bottom-bar-right[\s\S]*overflow-x: auto/, 'narrow reader controls remain horizontally scrollable');
assert.match(app, /if \(readerTouchClickHandled \|\| readerTouchMoved \|\| readerTouchMulti \|\| readerTouchCancelled\)/, 'reader pointer clicks must retain swipe guards');
assert.match(app, /e\.target === elements\.progressSlider \|\| e\.target\?\.id === 'progress-slider'/, 'range arrow keys must not trigger document page navigation');
assert.match(app, /let readingProgressSaveSequence = initialReadingProgressSaveSequence\(\)/, 'progress sequence must survive WebView reloads');
assert.match(app, /const nextWindow = getWebtoonWindowBounds\(state\.currentComicPages\.length, activeIndex\)/, 'webtoon scroll should compare the next window before rebuilding');
assert.match(messages, /"上一本"[\s\S]*"Previous comic"[\s\S]*"前のコミック"/);
assert.match(messages, /"下一本"[\s\S]*"Next comic"[\s\S]*"次のコミック"/);

// iPad 旋轉時，遠離 DOM 視窗的頁面也必須立即換算高度與 spacer。
{
  const topSpacer = { style: {} };
  const bottomSpacer = { style: {} };
  const viewport = { clientWidth: 400, scrollTop: 64 + 80 * 1200 + 300 };
  const state = {
    readingMode: 'webtoon',
    currentComicPages: Array(100).fill('page'),
    webtoonPageHeights: Array(100).fill(1200),
    webtoonPagePrefixHeights: Array.from({ length: 101 }, (_, index) => index * 1200),
    webtoonMeasuredPageHeights: new Map([[5, 1200]]),
    webtoonPendingPageHeights: new Map(),
    webtoonHeightUpdateFrame: null,
    webtoonMetricsViewportWidth: 800,
    webtoonWindowStart: 70,
    webtoonWindowEnd: 90,
    webtoonNavigationOffset: 0,
  };
  let visibleImages = [];
  const elements = {
    readerViewport: viewport,
    pagesContainer: {
      querySelector: selector => selector.includes('"top"') ? topSpacer : bottomSpacer,
      querySelectorAll: () => visibleImages,
    },
  };
  let anchored = false;
  let preserved = false;
  const resizeContext = {
    state, elements,
    cancelWebtoonPageHeightFlush() {},
    getWebtoonAnchorViewportOffset: () => 64,
    isActiveWebtoonAnchor: () => anchored,
    getWebtoonImage: () => ({}),
    getWebtoonImageOffsetTop: () => 64 + state.webtoonPagePrefixHeights[80],
    updateWebtoonPageHeight: index => state.webtoonPendingPageHeights.set(index, 299),
    flushWebtoonPageHeightUpdates: () => {
      assert.equal(state.webtoonAnchor.lastTargetTop, null, 'height flush cannot use the pre-resize anchor top');
      state.webtoonPendingPageHeights.clear();
    },
    preserveWebtoonAnchorPosition: () => {
      assert.equal(state.webtoonAnchor.lastTargetTop, null, 'old anchor position must not be compensated twice');
      preserved = true;
    },
  };
  const functions = ['webtoonPageOffset', 'webtoonPageIndexAtOffset', 'rebuildWebtoonPagePrefixHeights',
    'syncWebtoonWindowSpacers', 'refreshWebtoonPageMetricsForResize'];
  vm.runInNewContext(`${functions.map(extractFunction).join('\n')}\nrefreshWebtoonPageMetricsForResize();`, resizeContext);
  assert.equal(state.webtoonPageHeights[80], 600);
  assert.equal(state.webtoonMeasuredPageHeights.get(5), 600);
  assert.equal(topSpacer.style.height, '42000px');
  assert.equal(bottomSpacer.style.height, '6000px');
  assert.equal(viewport.scrollTop, 64 + 80 * 600 + 150, 'resize preserves the same page and relative location');
  anchored = true;
  state.webtoonAnchor = { index: 80, lastTargetTop: 98765 };
  visibleImages = [{ dataset: { index: '80' }, complete: true, naturalWidth: 100 }];
  viewport.clientWidth = 200;
  vm.runInNewContext('refreshWebtoonPageMetricsForResize();', resizeContext);
  assert.equal(viewport.scrollTop, 80 * 300, 'programmatic anchor remains under the scroll padding after resize');
  assert.equal(preserved, true);
}

class FakeClock {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
  setTimeout(fn, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + Math.max(0, delay) });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  tick(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= target);
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      this.tasks.delete(id);
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
  constructor(document, tagName = 'div', id = '') {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    Object.defineProperty(this, 'className', {
      get: () => [...this.classList.values].join(' '),
      set: value => {
        this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
      },
    });
    this.style = { display: 'none' };
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.clientHeight = 800;
    this.scrollHeight = 1600;
    this.scrollTop = 0;
    this._layoutHeight = this.tagName === 'IMG' ? 300 : 0;
    this.isConnected = true;
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  dispatch(type, detail = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: 0,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...detail,
    };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    if (typeof this[`on${type}`] === 'function') this[`on${type}`](event);
    return event;
  }
  append(...nodes) { nodes.filter(Boolean).forEach(node => this.appendChild(node)); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {
    this.isConnected = false;
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
  }
  querySelector(selector) {
    if (selector === 'i') {
      this.icon ||= new FakeElement(this.ownerDocument, 'i');
      return this.icon;
    }
    const match = selector.match(/^img\[data-index="(\d+)"\]$/);
    if (match) return walk(this).find(node => node.tagName === 'IMG' && String(node.dataset.index) === match[1]) || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.webtoon-img') return walk(this).filter(node => node.classList?.contains('webtoon-img'));
    return [];
  }
  closest() { return null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  get offsetTop() {
    if (!this.parentNode) return 0;
    const siblings = this.parentNode.children || [];
    const index = siblings.indexOf(this);
    return siblings.slice(0, index).reduce((sum, child) => sum + Number(child._layoutHeight || 0), 0);
  }
  getBoundingClientRect() {
    const viewport = this.ownerDocument.getElementById('reader-viewport');
    if (this === viewport) return { top: 0, left: 0 };
    return { top: this.offsetTop - (viewport?.scrollTop || 0), left: 0 };
  }
  focus() { this.ownerDocument.activeElement = this; }
  decode() { return Promise.resolve(); }
  scrollIntoView() {
    const viewport = this.ownerDocument.getElementById('reader-viewport');
    if (viewport && Number.isFinite(this.offsetTop)) viewport.scrollTop = Math.max(0, this.offsetTop - 64);
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.activeElement = null;
    this.body = this.createElement('body', 'body');
    this.documentElement = this.createElement('html', 'html');
  }
  createElement(tagName, id = '') {
    const element = new FakeElement(this, tagName, id);
    if (id) this.elements.set(id, element);
    return element;
  }
  createDocumentFragment() { return new FakeElement(this, '#fragment'); }
  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, this.createElement('div', id));
    return this.elements.get(id);
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener() {}
}

function walk(node) {
  return [node, ...node.children.flatMap(child => walk(child))];
}

function createRuntimeHarness(sharedSessionStorage = null) {
  const clock = new FakeClock();
  const document = new FakeDocument();
  const openCalls = [];
  const electronAPI = {
    isElectron: false,
    openComic: async id => {
      openCalls.push(id);
      return {
        id,
        title: id === 'b' ? 'plain b' : `webtoon ${id}`,
        relativePath: `folder/${id}.cbz`,
        sourceId: 'local:one',
        pages: ['/page.jpg'],
        progress: { currentPage: 0 },
      };
    },
    saveProgress: async () => {},
    getLibrary: async () => [],
  };
  const window = {
    electronAPI,
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener() {},
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    requestAnimationFrame: fn => clock.setTimeout(fn, 0),
    cancelAnimationFrame: clock.clearTimeout.bind(clock),
    __GIA_TEST_HOOKS__: {},
  };
  const storage = { values: new Map(), getItem(key) { return this.values.get(key) || null; }, setItem(key, value) { this.values.set(key, String(value)); } };
  const sessionStorage = sharedSessionStorage || { values: new Map(), getItem(key) { return this.values.get(key) || null; }, setItem(key, value) { this.values.set(key, String(value)); } };
  class FakeImage extends FakeElement { constructor() { super(document, 'img'); } }
  const context = {
    window,
    document,
    localStorage: storage,
    sessionStorage,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Image: FakeImage,
    Option: class {},
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0', objectFit: 'contain' }),
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    console,
    alert() {},
    navigator: { userAgent: '', platform: '' },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    unescape,
  };
  vm.createContext(context);
  vm.runInContext(app, context, { filename: 'public/app.js' });
  const hooks = window.__GIA_TEST_HOOKS__;
  hooks.bindEvents();
  return { clock, document, hooks, openCalls, context };
}

function comic(id, title = id) {
  return { id, title, relativePath: `folder/${id}.cbz`, sourceId: 'local:one' };
}

async function flushMicrotasks() {
  await new Promise(resolve => setImmediate(resolve));
}

// 快速前進、往回翻的進度快照必須依入隊順序落庫，且每筆快照捕獲呼叫當下頁碼。
{
  const runtime = createRuntimeHarness();
  const calls = [];
  const pending = [];
  runtime.context.window.electronAPI.saveProgress = payload => {
    calls.push({ ...payload });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  runtime.hooks.state.currentComic = comic('progress-book');
  runtime.hooks.state.currentComicPages = ['p1', 'p2', 'p3', 'p4'];
  runtime.hooks.state.currentPageIndex = 1;
  const first = runtime.hooks.saveReadingProgress();
  await flushMicrotasks();
  runtime.hooks.state.currentPageIndex = 3;
  const second = runtime.hooks.saveReadingProgress();
  runtime.hooks.state.currentComic = comic('other-progress-book');
  runtime.hooks.state.currentPageIndex = 0;
  const third = runtime.hooks.saveReadingProgress();
  await flushMicrotasks();
  assert.deepEqual(calls.map(call => call.currentPage), [1], 'only the first progress command starts immediately');

  pending.shift().resolve();
  await flushMicrotasks();
  assert.deepEqual(calls.map(call => call.currentPage), [1, 3], 'next progress snapshot waits for the previous command');
  pending.shift().resolve();
  await flushMicrotasks();
  assert.deepEqual(calls.map(call => call.currentPage), [1, 3, 0], 'backward progress snapshot keeps invocation order');
  pending.shift().resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls.map(call => call.id), ['progress-book', 'progress-book', 'other-progress-book']);
  const sequences = calls.map(call => call.sequence);
  assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]), 'progress sequence is strict across comics in one app session');
}

// 單筆 native failure 不得讓 queue 卡死，後續頁碼仍會送出。
{
  const runtime = createRuntimeHarness();
  runtime.context.console = { error() {} };
  const calls = [];
  const sequences = [];
  let callCount = 0;
  runtime.context.window.electronAPI.saveProgress = payload => {
    calls.push(payload.currentPage);
    sequences.push(payload.sequence);
    callCount += 1;
    return callCount === 1 ? Promise.reject(new Error('temporary native failure')) : Promise.resolve();
  };
  runtime.hooks.state.currentComic = comic('progress-retry');
  runtime.hooks.state.currentComicPages = ['p1', 'p2'];
  runtime.hooks.state.currentPageIndex = 0;
  const failed = runtime.hooks.saveReadingProgress();
  runtime.hooks.state.currentPageIndex = 1;
  const recovered = runtime.hooks.saveReadingProgress();
  await Promise.all([failed, recovered]);
  assert.deepEqual(calls, [0, 1], 'queue continues after one native progress failure');
  assert.ok(sequences[1] > sequences[0], 'failed progress still consumes one session sequence');
}
console.log('PASS: serialized reading progress preserves rapid and backward navigation order');

// WebView reload 不會重啟 Rust runtime；前一輪即使快速發出遠高於目前
// wall-clock baseline 的序號，下一輪也必須接在它後面。
{
  const sessionStorage = { values: new Map(), getItem(key) { return this.values.get(key) || null; }, setItem(key, value) { this.values.set(key, String(value)); } };
  const first = createRuntimeHarness(sessionStorage);
  first.hooks.state.currentComic = comic('reload-progress');
  first.hooks.state.currentComicPages = ['p1', 'p2'];
  const firstCalls = [];
  first.context.window.electronAPI.saveProgress = async payload => { firstCalls.push(payload.sequence); };
  await first.hooks.saveReadingProgress();
  const priorHighWater = firstCalls[0] + 10000;
  sessionStorage.setItem('gai:readingProgressSequence', String(priorHighWater));

  const reloaded = createRuntimeHarness(sessionStorage);
  reloaded.hooks.state.currentComic = comic('reload-progress');
  reloaded.hooks.state.currentComicPages = ['p1', 'p2'];
  const reloadedCalls = [];
  reloaded.context.window.electronAPI.saveProgress = async payload => { reloadedCalls.push(payload.sequence); };
  await reloaded.hooks.saveReadingProgress();
  assert.ok(reloadedCalls[0] > priorHighWater, 'first save after WebView reload advances the persisted high-water sequence');
}
console.log('PASS: progress save sequence survives a rapid WebView reload');

function webtoonButtons(pagesContainer) {
  return walk(pagesContainer).filter(node => node.classList?.contains('webtoon-nav-button'));
}

function findDialog(document) {
  return document.body.children.find(child => child.id === 'reader-navigation-confirm');
}

function renderWebtoonPages(hooks, count, currentPageIndex) {
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.readingMode = 'webtoon';
  hooks.state.currentComic = comic('anchor-book', 'Anchor book');
  hooks.state.currentComicPages = Array.from({ length: count }, (_, index) => `/page-${index}.svg`);
  hooks.state.currentPageIndex = currentPageIndex;
  hooks.renderPages();
  return hooks.elements.pagesContainer.querySelector(`img[data-index="${currentPageIndex}"]`);
}

// Continue 從書中後段恢復時，初始頁必須立即有 src；尚未載入的頁面
// 高度要與虛擬視窗計算相同，避免 iPad 實際看見第 34 頁卻仍停在第 16 頁。
{
  const { hooks } = createRuntimeHarness();
  const target = renderWebtoonPages(hooks, 223, 15);
  assert.equal(target.src, '/page-15.svg');
  assert.equal(target.loading, 'eager');
  const unloaded = hooks.elements.pagesContainer.querySelector('img[data-index="34"]');
  assert.equal(unloaded.src, undefined);
  assert.equal(unloaded.style.height, `${hooks.state.webtoonPageHeights[34]}px`);
}

// 書檔頁數變動後，舊的閱讀進度不能指向不存在的頁面，使條漫視窗全無 src。
{
  const runtime = createRuntimeHarness();
  runtime.hooks.state.comics = [comic('resumed', 'webtoon resumed')];
  runtime.context.window.electronAPI.openComic = async id => ({
    ...comic(id, 'webtoon resumed'),
    pages: Array.from({ length: 40 }, (_, index) => `/resumed-${index}.svg`),
    progress: { currentPage: 80 },
  });
  await runtime.hooks.openReader('resumed', { returnToComicFolder: true });
  assert.equal(runtime.hooks.state.currentPageIndex, 39);
  assert.equal(runtime.hooks.elements.pagesContainer.querySelector('img[data-index="39"]').src, '/resumed-39.svg');
}

// 舊條漫捲動的延遲存檔不可在關閉後寫進下一本漫畫。
{
  const runtime = createRuntimeHarness();
  const saved = [];
  runtime.context.window.electronAPI.saveProgress = payload => {
    saved.push(payload.id);
    return Promise.resolve();
  };
  runtime.hooks.state.currentComic = comic('old-webtoon');
  runtime.hooks.state.progressSaveTimer = runtime.clock.setTimeout(runtime.hooks.saveReadingProgress, 500);
  await runtime.hooks.closeReader();
  runtime.hooks.state.currentComic = comic('next-webtoon');
  runtime.clock.tick(500);
  await flushMicrotasks();
  assert.deepEqual(saved, []);
}

// Programmatic jumps keep the selected page at the reader's top padding even
// when an image above it finishes loading asynchronously. An initial scroll
// event must not overwrite the captured page index.
{
  const { hooks, clock } = createRuntimeHarness();
  const target = renderWebtoonPages(hooks, 20, 9);
  const viewport = hooks.elements.readerViewport;
  clock.tick(201);
  const initialTop = target.offsetTop - viewport.scrollTop;
  assert.equal(hooks.state.currentPageIndex, 9);
  assert.equal(initialTop, 64, 'initial anchor lands at scroll padding');
  viewport.dispatch('scroll');
  clock.tick(0);
  assert.equal(hooks.state.currentPageIndex, 9, 'programmatic scroll does not reset page');

  const pageAbove = hooks.elements.pagesContainer.querySelector('img[data-index="2"]');
  pageAbove._layoutHeight += 420;
  pageAbove.dispatch('load');
  clock.tick(0);
  assert.equal(target.offsetTop - viewport.scrollTop, 64, 'async layout shift is compensated');
}

// A real user gesture cancels the one-shot anchor so later image loads do not
// pull the user's manually chosen position back to the old page.
{
  const { hooks, clock } = createRuntimeHarness();
  const target = renderWebtoonPages(hooks, 20, 9);
  const viewport = hooks.elements.readerViewport;
  clock.tick(201);
  viewport.dispatch('wheel', { deltaY: 80, preventDefault() {} });
  assert.equal(hooks.state.webtoonAnchor, null, 'wheel cancels anchor');
  const before = viewport.scrollTop;
  const beforeTargetOffset = target.offsetTop - before;
  const pageAbove = hooks.elements.pagesContainer.querySelector('img[data-index="2"]');
  pageAbove._layoutHeight += 420;
  pageAbove.clientHeight = 1620;
  pageAbove.dispatch('load');
  clock.tick(0);
  assert.equal(viewport.scrollTop, before + 420, 'user scroll keeps its reading position after an image above loads');
  assert.equal(target.offsetTop - viewport.scrollTop, beforeTargetOffset, 'user scroll compensation preserves the visible page');
}

// Large webtoon books keep a bounded image window while preserving page metrics.
{
  const { hooks } = createRuntimeHarness();
  renderWebtoonPages(hooks, 5000, 2500);
  const renderedImages = walk(hooks.elements.pagesContainer).filter(node => node.classList?.contains('webtoon-img'));
  assert.ok(renderedImages.length <= 42, 'large webtoon books do not create one image node per page');
  assert.equal(hooks.state.webtoonWindowStart, 2488);
  assert.equal(hooks.state.webtoonWindowEnd, 2529);
}

// 中央區域只更新頁碼；靠近視窗邊緣才重建 window，且重建保留使用者 scrollTop。
{
  const runtime = createRuntimeHarness();
  renderWebtoonPages(runtime.hooks, 5000, 2500);
  runtime.hooks.cancelWebtoonAnchor();
  const viewport = runtime.hooks.elements.readerViewport;
  const originalRender = runtime.context.renderWebtoonWindow;
  let renderCount = 0;
  runtime.context.renderWebtoonWindow = (...args) => {
    renderCount += 1;
    return originalRender(...args);
  };
  viewport.scrollTop = 2500 * 1200;
  vm.runInContext('updateWebtoonScrollState()', runtime.context);
  assert.equal(renderCount, 0, 'middle-of-window scrolling must not rebuild the webtoon window');

  viewport.scrollTop = 2488 * 1200;
  const before = viewport.scrollTop;
  vm.runInContext('updateWebtoonScrollState()', runtime.context);
  assert.equal(renderCount, 1, 'near-edge scrolling rebuilds the webtoon window');
  assert.equal(viewport.scrollTop, before, 'webtoon window rebuild preserves scrollTop');
}

// 重建條漫 window 時，先前已量測頁高要先作為 placeholder；圖片載入後再更新量測。
{
  const runtime = createRuntimeHarness();
  const firstTarget = renderWebtoonPages(runtime.hooks, 20, 9);
  firstTarget.clientHeight = 300;
  firstTarget.dispatch('load');
  runtime.clock.tick(0);
  assert.equal(runtime.hooks.state.webtoonMeasuredPageHeights.get(9), 300);

  runtime.hooks.renderPages();
  const recreated = runtime.hooks.elements.pagesContainer.querySelector('img[data-index="9"]');
  assert.equal(recreated.style.height, '300px', 'recreated image reserves its previous valid measured height');
  recreated.clientHeight = 340;
  recreated.dispatch('load');
  runtime.clock.tick(0);
  assert.equal(runtime.hooks.state.webtoonMeasuredPageHeights.get(9), 340, 'loaded image replaces the placeholder measurement');
}

// Adjacent-comic lookup builds one sorted source/folder index per library
// generation, then reuses it across the two buttons in every render window.
{
  const { hooks } = createRuntimeHarness();
  hooks.state.comics = Array.from({ length: 5000 }, (_, index) => ({
    id: `book-${String(index).padStart(4, '0')}`,
    title: `Book ${String(index).padStart(4, '0')}`,
    relativePath: 'folder/book.cbz',
    sourceId: 'local:one',
    isDirectory: false,
  }));
  hooks.state.currentComic = hooks.state.comics[2500];
  const firstCache = hooks.getComicNavigationCache();
  assert.equal(hooks.findAdjacentComicInFolder('next').id, 'book-2501');
  assert.equal(hooks.findAdjacentComicInFolder('prev').id, 'book-2499');
  assert.equal(hooks.getComicNavigationCache(), firstCache, 'repeated adjacent lookup reuses the sorted cache');
  hooks.state.comics[2501].title = 'Book 0000';
  hooks.invalidateComicNavigationCache();
  const refreshedCache = hooks.getComicNavigationCache();
  assert.notEqual(refreshedCache, firstCache, 'metadata/order changes invalidate the sorted cache');
}

// Rapid mode/book changes invalidate callbacks from the previous render.
{
  const { hooks, clock } = createRuntimeHarness();
  const oldTarget = renderWebtoonPages(hooks, 20, 9);
  clock.tick(201);
  hooks.state.readingMode = 'catalog';
  hooks.renderPages();
  oldTarget._layoutHeight += 500;
  oldTarget.dispatch('load');
  assert.equal(hooks.state.webtoonAnchor, null, 'mode change clears old anchor');

  const nextTarget = renderWebtoonPages(hooks, 20, 9);
  clock.tick(201);
  const oldGeneration = hooks.state.renderGeneration;
  hooks.state.currentComic = comic('new-book', 'New book');
  hooks.state.currentComicPages = Array.from({ length: 20 }, (_, index) => `/new-${index}.svg`);
  hooks.renderPages();
  const newAnchor = hooks.state.webtoonAnchor;
  nextTarget._layoutHeight += 500;
  nextTarget.dispatch('load');
  assert.ok(hooks.state.renderGeneration > oldGeneration, 'book render has a new generation');
  assert.equal(hooks.state.webtoonAnchor, newAnchor, 'book change keeps only the new anchor');
}

// Opening an adjacent comic must keep the original shelf focus as the eventual
// close target; the intermediate close must not consume it.
{
  const runtime = createRuntimeHarness();
  const shelfFocus = runtime.document.createElement('button');
  runtime.document.activeElement = shelfFocus;
  runtime.hooks.state.comics = [comic('a', 'webtoon a'), comic('b', 'webtoon b')];
  runtime.hooks.state.currentComic = comic('a', 'webtoon a');
  runtime.hooks.state.currentComicPages = ['/old-page.svg'];
  runtime.hooks.state.readingMode = 'webtoon';
  runtime.hooks.elements.readerOverlay.style.display = 'flex';
  await runtime.hooks.openReader('b');
  assert.equal(runtime.hooks.state.readerReturnFocus, shelfFocus, 'adjacent open preserves original shelf return focus');
  await runtime.hooks.closeReader();
  assert.equal(runtime.document.activeElement, shelfFocus, 'closing the adjacent comic restores the shelf focus');
}

// Rendering a webtoon creates only the available adjacent buttons, with no
// invisible boundary tap path left on the reader viewport.
{
  const { hooks, document } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.readingMode = 'webtoon';
  hooks.state.currentComic = comic('b', 'B');
  hooks.state.currentComicPages = ['/page.jpg'];
  hooks.state.comics = [comic('a', 'A'), hooks.state.currentComic, comic('c', 'C')];
  hooks.renderPages();
  const buttons = webtoonButtons(hooks.elements.pagesContainer);
  assert.deepEqual(buttons.map(button => button.textContent), ['上一本', '下一本']);
  assert.equal(buttons.every(button => button.getAttribute('aria-label')), true);
  hooks.elements.readerViewport.dispatch('pointerdown', { pointerType: 'mouse', clientX: 500, clientY: 790 });
  hooks.elements.readerViewport.dispatch('pointerup', { pointerType: 'mouse', clientX: 500, clientY: 790 });
  assert.equal(findDialog(document), undefined, 'legacy boundary taps do not open a dialog');
  const touch = { clientX: 500, clientY: 790, screenX: 500, screenY: 790 };
  hooks.elements.readerViewport.dispatch('touchstart', { touches: [touch], changedTouches: [touch] });
  hooks.elements.readerViewport.dispatch('touchend', { touches: [], changedTouches: [touch] });
  hooks.elements.readerViewport.dispatch('pointerup', { pointerType: 'touch', clientX: 500, clientY: 790 });
  assert.equal(findDialog(document), undefined, 'legacy boundary touch taps do not open a dialog');
}

// The button retains the existing confirmation and delayed open safeguards.
{
  const { hooks, document, clock, openCalls } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.readingMode = 'webtoon';
  hooks.state.currentComic = comic('a', 'A');
  hooks.state.currentComicPages = ['/page.jpg'];
  hooks.state.comics = [hooks.state.currentComic, comic('b', 'B')];
  hooks.renderPages();
  const next = webtoonButtons(hooks.elements.pagesContainer).find(button => button.classList.contains('webtoon-nav-next'));
  next.dispatch('click');
  const dialog = findDialog(document);
  assert.ok(dialog, 'next button opens the existing confirmation modal');
  dialog.children[0].children[2].children[1].dispatch('click');
  await Promise.resolve();
  clock.tick(800);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(openCalls, ['b']);
}

// If there is no same-source, same-folder neighbor, no navigation button is rendered.
{
  const { hooks, document } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.readingMode = 'webtoon';
  hooks.state.currentComic = comic('a', 'A');
  hooks.state.currentComicPages = ['/page.jpg'];
  hooks.state.comics = [hooks.state.currentComic, { ...comic('other', 'Other'), sourceId: 'local:two' }];
  hooks.renderPages();
  assert.deepEqual(webtoonButtons(hooks.elements.pagesContainer), []);
  assert.equal(findDialog(document), undefined);
}

// Switching to a normally titled adjacent comic keeps the user's active webtoon mode.
{
  const { hooks } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.readingMode = 'webtoon';
  hooks.state.currentComic = comic('a', 'webtoon a');
  hooks.state.currentComicPages = ['/page.jpg'];
  hooks.state.comics = [hooks.state.currentComic, comic('b', 'plain b')];
  await hooks.openReader('b');
  assert.equal(hooks.state.readingMode, 'webtoon', 'adjacent open preserves webtoon mode');
}

// Reopening/closing clears the generated controls and stale confirmation state.
{
  const { hooks, document } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.readingMode = 'webtoon';
  hooks.state.currentComic = comic('a', 'A');
  hooks.state.currentComicPages = ['/page.jpg'];
  hooks.state.comics = [hooks.state.currentComic, comic('b', 'B')];
  hooks.renderPages();
  assert.equal(webtoonButtons(hooks.elements.pagesContainer).length, 1);
  await hooks.closeReader();
  assert.deepEqual(hooks.elements.pagesContainer.children, []);
  assert.equal(hooks.state.readerBoundaryDialog, null);
  assert.equal(findDialog(document), undefined);
}

console.log('PASS: webtoon navigation buttons, mode preservation, boundary absence, confirmation, and cleanup are covered');

// Two-page controls keep the cover exception, support a one-page offset, and
// retain that offset for the following two-page navigation.
{
  const { hooks } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.currentComic = comic('double-book', 'Double book');
  hooks.state.currentComicPages = Array.from({ length: 7 }, (_, index) => `/double-${index}.svg`);
  hooks.state.readingMode = 'double';
  hooks.state.currentPageIndex = 1;
  hooks.state.doublePairOffset = 1;
  hooks.renderPages();

  assert.equal(hooks.advanceDoubleBySinglePage(), true);
  assert.equal(hooks.state.currentPageIndex, 2, 'single-page shift advances one page');
  assert.equal(hooks.state.doublePairOffset, 0, 'single-page shift stores the offset phase');
  hooks.nextPage();
  assert.equal(hooks.state.currentPageIndex, 4, 'next page advances two pages after a shift');
  hooks.prevPage();
  assert.equal(hooks.state.currentPageIndex, 2, 'previous page returns by two pages after a shift');
  hooks.prevPage();
  assert.equal(hooks.state.currentPageIndex, 0, 'previous page reaches the cover boundary');
  hooks.nextPage();
  assert.equal(hooks.state.currentPageIndex, 1, 'leaving the cover restores the normal pair phase');
  assert.equal(hooks.state.doublePairOffset, 1);

  hooks.state.doublePairOffset = 0;
  hooks.jumpToPage(3);
  assert.equal(hooks.state.currentPageIndex, 2, 'jump keeps the shifted even pair start');
  hooks.state.readingMode = 'double';
  hooks.state.currentPageIndex = 2;
  hooks.toggleDoubleDirection();
  assert.equal(hooks.state.currentPageIndex, 2, 'direction toggle does not jump pages');
  assert.equal(hooks.state.readingMode, 'double-rtl');
  hooks.elements.btnModeDouble.dispatch('click');
  assert.equal(hooks.state.readingMode, 'double-rtl', 'active double button preserves reverse direction');
  hooks.advanceDoubleBySinglePage();
  hooks.advanceDoubleBySinglePage();
  assert.equal(hooks.state.currentPageIndex, 4, 'repeated one-shot actions each advance exactly one page');
  hooks.state.currentPageIndex = 5;
  hooks.advanceDoubleBySinglePage();
  assert.equal(hooks.state.currentPageIndex, 6);
  assert.equal(hooks.elements.btnDoubleShift.disabled, true, 'last page disables the one-shot action');
  assert.equal(hooks.advanceDoubleBySinglePage(), false, 'last-page shift is a no-op');
  assert.equal(hooks.state.currentComic.id, 'double-book', 'shift never opens another book');
  hooks.state.readingMode = 'single';
  assert.equal(hooks.advanceDoubleBySinglePage(), false, 'single mode ignores double shift');
  assert.equal(hooks.toggleDoubleDirection(), false, 'single mode ignores direction action');
}

// The unified two-page entry remains available while its two auxiliary
// controls are hidden outside two-page mode.
{
  const { hooks } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.currentComic = comic('entry-book', 'Entry book');
  hooks.state.currentComicPages = ['/entry-0.svg', '/entry-1.svg', '/entry-2.svg'];
  hooks.state.readingMode = 'single';
  hooks.elements.zoomValue.parentElement = { style: {} };
  hooks.elements.doubleModeControls.hidden = true;
  hooks.elements.btnModeDouble.dispatch('click');
  assert.equal(hooks.state.readingMode, 'double', 'single mode can enter unified two-page mode');
  assert.equal(hooks.elements.doubleModeControls.hidden, false, 'two-page auxiliary controls become visible');
}

console.log('PASS: two-page direction, one-page shift, parity snap, and boundaries are covered');

// Idle 後若 chrome 沒有可見 focusable，Tab 必須先喚醒工具列，再把焦點交回返回鍵，
// 不能 preventDefault 後把焦點留在隱藏控制列造成鍵盤卡死。
{
  const { hooks, document } = createRuntimeHarness();
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.elements.readerOverlay.classList.add('reader-idle');
  let prevented = false;
  hooks.trapReaderFocus({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'empty reader focus trap owns Tab');
  assert.equal(hooks.elements.readerOverlay.classList.contains('reader-idle'), false, 'empty focus trap wakes reader chrome');
  assert.equal(document.activeElement, hooks.elements.readerBackBtn, 'empty focus trap focuses visible keyboard entry');
}
console.log('PASS: idle reader chrome restores a keyboard focus entry');

// Webtoon taps toggle chrome, while swipes (including a swipe that returns to
// its start), cancelled touches, multi-touch and compatibility mouse movement
// must leave it hidden. Exercise the real listeners registered by bindEvents.
for (const scenario of ['tap-pointer-first', 'tap-touch-first', 'jitter', 'vertical-swipe', 'horizontal-swipe', 'return-swipe', 'multi-touch', 'cancelled']) {
  const { hooks } = createRuntimeHarness();
  renderWebtoonPages(hooks, 20, 9);
  const overlay = hooks.elements.readerOverlay;
  const viewport = hooks.elements.readerViewport;
  overlay.classList.add('reader-idle');
  const start = { clientX: 500, clientY: 400, screenX: 500, screenY: 400 };
  const end = { ...start };
  const second = { ...start, clientX: 600, screenX: 600 };
  viewport.dispatch('touchstart', { touches: scenario === 'multi-touch' ? [start, second] : [start], changedTouches: [start] });
  if (scenario.includes('swipe')) {
    const moved = { ...start, clientY: 480, screenY: 480 };
    if (scenario === 'horizontal-swipe') Object.assign(moved, { clientX: 600, screenX: 600, clientY: 400, screenY: 400 });
    viewport.dispatch('touchmove', { touches: [moved], changedTouches: [moved] });
    if (scenario !== 'return-swipe') Object.assign(end, moved);
    overlay.dispatch('mousemove', { clientY: 790, buttons: 0 });
    assert.equal(overlay.classList.contains('reader-idle'), true, 'compatibility mouse movement during swipe stays hidden');
  }
  if (scenario === 'jitter') Object.assign(end, { clientX: 504, screenX: 504 });
  if (scenario === 'cancelled') viewport.dispatch('touchcancel', { changedTouches: [start] });
  const pointerEnd = () => viewport.dispatch('pointerup', { pointerType: 'touch', ...end });
  const touchEnd = () => viewport.dispatch('touchend', { touches: [], changedTouches: [end] });
  if (scenario === 'tap-touch-first') { touchEnd(); pointerEnd(); } else { pointerEnd(); touchEnd(); }
  const isTap = scenario.startsWith('tap-') || scenario === 'jitter';
  assert.equal(overlay.classList.contains('reader-idle'), !isTap, scenario);
  assert.equal(hooks.state.currentPageIndex, 9, `${scenario}: chrome interaction does not turn the page`);
}

{
  const { hooks } = createRuntimeHarness();
  renderWebtoonPages(hooks, 20, 9);
  const overlay = hooks.elements.readerOverlay;
  const viewport = hooks.elements.readerViewport;
  overlay.classList.add('reader-idle');
  viewport.dispatch('pointerdown', { pointerType: 'mouse', clientX: 500, clientY: 400 });
  viewport.dispatch('pointermove', { pointerType: 'mouse', clientX: 500, clientY: 600 });
  overlay.dispatch('mousemove', { clientY: 790, buttons: 1 });
  viewport.dispatch('pointerup', { pointerType: 'mouse', clientX: 500, clientY: 600 });
  assert.equal(overlay.classList.contains('reader-idle'), true, 'mouse drag does not show chrome');
  const button = { closest: () => button };
  viewport.dispatch('pointerdown', { pointerType: 'mouse', clientX: 500, clientY: 400, target: button });
  viewport.dispatch('pointerup', { pointerType: 'mouse', clientX: 500, clientY: 400, target: button });
  assert.equal(overlay.classList.contains('reader-idle'), true, 'button taps do not also toggle chrome');
}
console.log('PASS: webtoon tap shows UI; swipes, drags, multi-touch and cancellation do not');

// A horizontally oversized single page owns the swipe gesture: native panning
// must not also advance the comic page.
{
  const { hooks } = createRuntimeHarness();
  const viewport = hooks.elements.readerViewport;
  hooks.elements.readerOverlay.style.display = 'flex';
  hooks.state.currentComic = comic('large-single-page');
  hooks.state.currentComicPages = ['/large-0.jpg', '/large-1.jpg', '/large-2.jpg'];
  hooks.state.currentPageIndex = 1;
  hooks.state.readingMode = 'single';
  viewport.clientWidth = 800;
  viewport.scrollWidth = 1400;
  assert.equal(hooks.readerViewportCanScroll('x'), true);
  const start = { clientX: 600, clientY: 400, screenX: 600, screenY: 400 };
  const end = { clientX: 480, clientY: 400, screenX: 480, screenY: 400 };
  viewport.dispatch('touchstart', { touches: [start], changedTouches: [start] });
  viewport.dispatch('touchmove', { touches: [end], changedTouches: [end] });
  viewport.dispatch('touchend', { touches: [], changedTouches: [end] });
  assert.equal(hooks.state.currentPageIndex, 1, 'oversized single-page swipe pans without turning the page');

  hooks.elements.readerOverlay.classList.add('single-page-pannable');
  hooks.state.readingMode = 'catalog';
  hooks.renderPages();
  assert.equal(
    hooks.elements.readerOverlay.classList.contains('single-page-pannable'),
    false,
    'leaving single-page mode clears the panning state',
  );
}
console.log('PASS: oversized single pages pan in both axes without accidental page turns');

// Scrolling layouts must leave vertical keyboard events to the browser.
for (const mode of ['webtoon', 'catalog', 'single', 'double', 'double-rtl']) {
  for (const key of ['ArrowUp', 'ArrowDown', ' ', 'Spacebar']) {
    const calls = [];
    const handle = vm.runInNewContext(`(${extractFunction('handleKeyDown')})`, {
      elements: { readerOverlay: { style: { display: 'flex' } } },
      state: { readingMode: mode },
      jumpToFirstPage: () => calls.push('first'),
      jumpToLastPage: () => calls.push('last'),
      nextPage: () => calls.push('next'),
      cancelWebtoonAnchorFromUserInput: () => {
        if (mode === 'webtoon') calls.push('cancel-anchor');
      },
    });
    let prevented = false;
    handle({ key, preventDefault() { prevented = true; } });
    const paged = ['single', 'double', 'double-rtl'].includes(mode);
    assert.equal(prevented, paged, `${mode} ${key}: native scrolling is preserved only for scrolling layouts`);
    const expectedCalls = paged
      ? [key === 'ArrowUp' ? 'first' : key === 'ArrowDown' ? 'last' : 'next']
      : (mode === 'webtoon' ? ['cancel-anchor'] : []);
    assert.deepEqual(calls, expectedCalls);
  }
}
console.log('PASS: vertical keyboard scrolling and paged navigation remain mode-specific');

// The native range control owns ArrowLeft/ArrowRight; document shortcuts must
// not turn the page a second time while the slider is focused.
{
  const calls = [];
  const slider = { id: 'progress-slider' };
  const handle = vm.runInNewContext(`(${extractFunction('handleKeyDown')})`, {
    elements: { readerOverlay: { style: { display: 'flex' } }, progressSlider: slider },
    state: { readingMode: 'single' },
    goPreviousByReadingDirection: () => calls.push('previous'),
    goNextByReadingDirection: () => calls.push('next'),
  });
  let prevented = false;
  handle({ target: slider, key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.deepEqual(calls, [], 'range ArrowRight does not also turn the page');
  assert.equal(prevented, false, 'range ArrowRight remains native');
}
console.log('PASS: progress range arrows have a single native input path');

// Slider navigation keys stay native, while reader shortcuts such as Escape
// still reach the document handler when the slider owns focus.
{
  const calls = [];
  const slider = { id: 'progress-slider' };
  const handle = vm.runInNewContext(`(${extractFunction('handleKeyDown')})`, {
    elements: { readerOverlay: { style: { display: 'flex' } }, progressSlider: slider },
    state: { readingMode: 'single', readerContextMenuOpen: false },
    closeReader: () => calls.push('close'),
  });
  let prevented = false;
  handle({ target: slider, key: 'Escape', preventDefault() { prevented = true; } });
  assert.deepEqual(calls, ['close'], 'slider focus must not swallow Escape');
  assert.equal(prevented, true, 'reader Escape keeps its default prevention');
}
console.log('PASS: progress range keeps reader shortcuts available');
