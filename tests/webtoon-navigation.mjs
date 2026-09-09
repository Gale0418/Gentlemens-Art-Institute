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
assert.match(adjacent, /getComicSourceKey\(comic\) === sourceKey/);
assert.match(adjacent, /getParentPath\(comic\.relativePath\) === parentPath/);

const pointer = extractFunction('handleReaderPointerClick');
assert.match(pointer, /state\.readingMode === 'webtoon'/);
assert.doesNotMatch(pointer, /requestWebtoonAdjacentComic/);
assert.doesNotMatch(pointer, /getWebtoonEdgeAtPoint/);
assert.match(app, /function createWebtoonNavigationButton\(direction\)/);
assert.match(css, /\.reader-overlay\.mode-webtoon \.webtoon-nav-button[\s\S]*min-height: 44px/);
assert.match(messages, /"上一本"[\s\S]*"Previous comic"[\s\S]*"前のコミック"/);
assert.match(messages, /"下一本"[\s\S]*"Next comic"[\s\S]*"次のコミック"/);

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

function createRuntimeHarness() {
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
  class FakeImage extends FakeElement { constructor() { super(document, 'img'); } }
  const context = {
    window,
    document,
    localStorage: storage,
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
  return { clock, document, hooks, openCalls };
}

function comic(id, title = id) {
  return { id, title, relativePath: `folder/${id}.cbz`, sourceId: 'local:one' };
}

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
  const pageAbove = hooks.elements.pagesContainer.querySelector('img[data-index="2"]');
  pageAbove._layoutHeight += 420;
  pageAbove.dispatch('load');
  assert.equal(viewport.scrollTop, before, 'cancelled anchor does not force scroll');
  assert.notEqual(target.offsetTop - viewport.scrollTop, 64);
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
