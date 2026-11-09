import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const readerCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
assert.match(appSource, /await restoreExternalBookmarks\(\)/, 'initial external bookmark restore must use the intent queue');
assert.match(appSource, /eAPI\.restoreBookmarks\(readExternalBookmarks\(\), externalBookmarksLegacyReadable\)/, 'startup and first mutation must obtain an authoritative native bookmark snapshot');
assert.match(appSource, /const latestBookmarks = readExternalBookmarks\(\)[\s\S]{0,180}bookmark\.bookmark !== bookmarkIdentity/, 'bookmark deletion must resolve identity inside the queue');
assert.match(appSource, /async function initApp\(\)[\s\S]{0,180}sanitizeSmbConfig\(\)/, 'SMB legacy secrets must be sanitized during app initialization');
assert.match(appSource, /requestPriorityLibraryScan\(state\.scanStatus, state\.favorites\)/, 'scan progress must submit native priority scan hints');
const nativeSource = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const nativeBookmarkMutation = nativeSource.slice(nativeSource.indexOf('async fn set_bookmarks('), nativeSource.indexOf('async fn get_bookmarks('));
assert.match(nativeBookmarkMutation, /if let Err\(error\) = cleanup_result[\s\S]*active\.remove[\s\S]*external_bookmarks\.write[\s\S]*if cleanup_errors\.is_empty/, 'post-commit cleanup errors must be retained until the matching process state is published');
const tauriBridgeSource = fs.readFileSync(new URL('../public/tauri-api.js', import.meta.url), 'utf8');
assert.match(tauriBridgeSource, /restoreBookmarks: \(data, legacyCacheReadable\) => invoke\('set_bookmarks', \{ data, restoreFromSaved: true, legacyCacheReadable \}\)/, 'startup restore must explicitly select native authority and legacy migration semantics');
assert.match(tauriBridgeSource, /repairExternalBookmarks: \(data\) => invoke\('repair_external_bookmarks', \{ data \}\)/, 'corrupt bookmark recovery must use the dedicated native repair command');
assert.match(tauriBridgeSource, /invoke\('scan_priority_library', \{[\s\S]*favoriteIds/, 'native bridge must expose the priority scan command');
assert.match(tauriBridgeSource, /scanVisibleDirectory: \(relativePath, sourceId\) => invoke\('scan_visible_directory', \{[\s\S]*\.\.\.\(sourceId \? \{ sourceId \} : \{\}\)/, 'visible directory bridge must accept an optional source id');
assert.match(appSource, /eAPI\.listRelatedTags\(mutationTarget\.comicId, 8\)/, 'related tags must use the stable canonical metadata id');
assert.match(appSource, /標籤建議暫時無法載入。/, 'related tag failures must have a dedicated warning');
assert.match(appSource, /let inspectorMetadataRequestGeneration = 0;/, 'inspector metadata must use one bounded global request generation');
assert.doesNotMatch(appSource, /inspectorMetadataRequestTokens/, 'inspector metadata must not retain a per-comic token map');
assert.match(appSource, /function buildOrganizerIdentityIndex\(\)/, 'organizer selection must build one identity index per resolution');

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

  tickOne() {
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) return false;
    const [id, task] = due;
    this.now = task.at;
    if (task.interval) task.at += task.interval;
    else this.tasks.delete(id);
    task.fn();
    return true;
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
    this._innerHTML = '';
    this.src = '';
    this.replaceChildrenCalls = 0;
    this.appendChildCalls = 0;
    this.fragmentAppendChildCalls = 0;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value ?? '');
    this.lazyCover = this._innerHTML.includes('lazy-cover') ? new FakeElement('img') : null;
    if (this.lazyCover) this.lazyCover.parentNode = this;
  }

  appendChild(child) {
    this.appendChildCalls += 1;
    if (child?.isFragment) {
      this.fragmentAppendChildCalls += 1;
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

  insertBefore(child, anchor) {
    if (!anchor || !this.children.includes(anchor)) return this.appendChild(child);
    if (child.parentNode && child.parentNode !== this) {
      child.parentNode.children = child.parentNode.children.filter(item => item !== child);
    } else if (child.parentNode === this) {
      this.children = this.children.filter(item => item !== child);
    }
    child.parentNode = this;
    child.isConnected = true;
    this.children.splice(this.children.indexOf(anchor), 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) throw new Error('child is not present');
    this.children.splice(index, 1);
    const detach = node => {
      node.parentNode = null;
      node.isConnected = false;
      node.children?.forEach(detach);
    };
    detach(child);
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
    if (selector === '.comic-card[data-comic-id]' && this.dataset.comicId) return this;
    if (selector === '.comic-card') return this.card || (this.card = new FakeElement('div'));
    return null;
  }
  querySelector(selector) {
    if (selector === '.catalog-thumb.current') {
      return this.children.find(child => child.classList.contains('current')) || null;
    }
    if (selector.startsWith('img[data-index="')) {
      const index = selector.match(/data-index="(\d+)"/)?.[1];
      return this.children.find(child => child.dataset?.index === index) || null;
    }
    if (selector === '.reader-catalog-grid' || selector === '.reader-catalog-window-controls'
      || selector === '.reader-catalog-heading') {
      return this.children.find(child => child.className === selector.slice(1)) || null;
    }
    if (selector === '[data-catalog-spacer="top"]' || selector === '[data-catalog-spacer="bottom"]') {
      const value = selector.includes('top') ? 'top' : 'bottom';
      return this.children.find(child => child.dataset?.catalogSpacer === value) || null;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.lazy-cover' && this.lazyCover) return [this.lazyCover];
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
    querySelectorAll(selector) {
      if (selector !== '.lazy-cover') return [];
      const walk = node => [
        ...(node.lazyCover ? [node.lazyCover] : []),
        ...node.children.flatMap(walk),
      ];
      return [...elements.values()].flatMap(walk);
    },
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
    atob,
    TextDecoder,
    Uint8Array,
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
const catalogSearchKey = (testHooks, runtimeId, sourceId = '', relativePath = '') =>
  testHooks.getCatalogSearchKey(runtimeId, sourceId, relativePath);
const makeCover = id => {
  const img = new FakeElement('img');
  img.dataset.coverId = id;
  img.dataset.src = `/cover/${id}`;
  return img;
};

assert.equal(hooks.catalogThumbnailURL('gai://page/photo-id/3'), 'gai://page/photo-id/3?thumbnail=1',
  'native page thumbnails request the PhotoKit thumbnail variant');
assert.equal(hooks.catalogThumbnailURL('gai://folder/photo-id/3?existing=1#image'),
  'gai://folder/photo-id/3?existing=1&thumbnail=1#image',
  'native folder thumbnails preserve existing query and fragment');
assert.equal(hooks.catalogThumbnailURL('/fixture/page-3.png'), '/fixture/page-3.png',
  'fixture thumbnail sources remain unchanged');

// Reader image refresh must schedule catalog virtualization only in catalog
// mode; the transform helper is also used by fullscreenchange and must not
// accidentally move a catalog window while a normal reader is active.
{
  const catalog = createHarness({ width: 1000 });
  catalog.context.IntersectionObserver = undefined;
  vm.runInContext(
    'window.__GIA_TEST_HOOKS__.scheduleReaderImageTransformRefresh = scheduleReaderImageTransformRefresh;',
    catalog.context,
  );
  catalog.hooks.state.currentComic = { id: 'refresh-catalog' };
  catalog.hooks.state.currentComicPages = Array.from({ length: 5000 }, (_, index) => `p${index}`);
  catalog.hooks.state.currentPageIndex = 0;
  catalog.hooks.state.readingMode = 'single';
  catalog.hooks.state.catalogOpen = true;
  catalog.hooks.renderPages();
  const initialWindowStart = catalog.hooks.state.catalogWindowStart;
  catalog.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(3000 / 6) * 194);
  catalog.hooks.scheduleReaderImageTransformRefresh();
  catalog.clock.tick(0);
  assert.notEqual(catalog.hooks.state.catalogWindowStart, initialWindowStart,
    'catalog image refresh schedules virtual rendering for the visible window');

  const reader = createHarness({ width: 1000 });
  reader.context.IntersectionObserver = undefined;
  vm.runInContext(
    'window.__GIA_TEST_HOOKS__.scheduleReaderImageTransformRefresh = scheduleReaderImageTransformRefresh;',
    reader.context,
  );
  reader.hooks.state.currentComic = { id: 'refresh-reader' };
  reader.hooks.state.currentComicPages = Array.from({ length: 5000 }, (_, index) => `p${index}`);
  reader.hooks.state.currentPageIndex = 0;
  reader.hooks.state.readingMode = 'single';
  reader.hooks.state.catalogOpen = true;
  reader.hooks.renderPages();
  const readerGrid = reader.hooks.elements.pagesContainer.querySelector('.reader-catalog-grid');
  const readerWindowStart = reader.hooks.state.catalogWindowStart;
  reader.hooks.state.readingMode = 'single';
  reader.hooks.state.catalogOpen = false;
  reader.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(3000 / 6) * 194);
  reader.hooks.scheduleReaderImageTransformRefresh();
  reader.clock.tick(0);
  assert.equal(reader.hooks.state.catalogWindowStart, readerWindowStart,
    'normal reader image refresh does not schedule catalog virtualization');
  assert.equal(reader.hooks.elements.pagesContainer.querySelector('.reader-catalog-grid'), readerGrid,
    'normal reader image refresh leaves the catalog grid untouched');
}

// Continue 卡片的實際欄寬與排序欄位都必須進入簽名；未讀收藏不可偽裝成閱讀進度。
// Fullscreen/AI changes and an already queued frame must never apply reader
// rotation/zoom or webtoon geometry to overview thumbnails.
{
  const runtime = createHarness();
  const { hooks, context, clock } = runtime;
  vm.runInContext(`window.__GIA_TEST_HOOKS__.refreshReaderImageTransforms = refreshReaderImageTransforms;
    window.__GIA_TEST_HOOKS__.scheduleReaderImageTransformRefresh = scheduleReaderImageTransformRefresh;`, context);
  const image = new FakeElement('img');
  image.style.transform = 'unchanged-thumbnail';
  let imageQueries = 0;
  hooks.elements.pagesContainer.querySelectorAll = selector => {
    if (selector === 'img') { imageQueries += 1; return [image]; }
    return [];
  };
  hooks.state.readingMode = 'double';
  hooks.state.rotationAngle = 90;
  hooks.state.zoomPercentage = 150;
  hooks.scheduleReaderImageTransformRefresh();
  hooks.state.catalogOpen = true;
  clock.tick(0);
  hooks.refreshReaderImageTransforms();
  hooks.scheduleReaderImageTransformRefresh();
  clock.tick(0);
  assert.equal(imageQueries, 0, 'open overview rejects direct and queued reader transform refreshes');
  assert.equal(image.style.transform, 'unchanged-thumbnail');
  hooks.state.catalogOpen = false;
  hooks.scheduleReaderImageTransformRefresh();
  clock.tick(0);
  assert.match(image.style.transform, /scale\(1\.5\) rotate\(90deg\)/,
    'normal reader transforms remain active after returning from the overview');
}

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

// Continue 卡片已有閱讀時間時，檔案 updatedAt 改變仍必須重新建立封面 URL／DOM。
{
  const continueRender = createHarness();
  const strip = continueRender.hooks.elements.continueStrip;
  let renderWrites = 0;
  let markup = '';
  Object.defineProperty(strip, 'innerHTML', {
    configurable: true,
    get: () => markup,
    set: value => {
      renderWrites += 1;
      markup = String(value);
    },
  });
  const comic = {
    id: 'continue-file-revision',
    title: 'Continue revision',
    relativePath: 'continue/revision.cbz',
    type: 'archive',
    pageCount: 20,
    updatedAt: '2026-11-01T00:00:00Z',
    progress: { currentPage: 3, totalPages: 20, percent: 15, updatedAt: '2026-11-01T01:00:00Z' },
  };
  continueRender.hooks.state.comics = [comic];
  continueRender.hooks.setFavorites([]);
  continueRender.hooks.renderContinueStrip();
  const firstRenderWrites = renderWrites;
  comic.updatedAt = '2026-11-02T12:00:00Z';
  continueRender.hooks.renderContinueStrip();
  assert.equal(renderWrites, firstRenderWrites + 1,
    '閱讀時間存在時，檔案 updatedAt 改變仍會重新 render Continue 封面');
}

// 同名的繼續閱讀卡片顯示來源路徑，路徑改動也必須更新畫面。
{
  const sharedProgress = { currentPage: 3, totalPages: 20, percent: 15, updatedAt: '2026-10-03T00:00:00Z' };
  const books = [
    { id: 'same-a', title: 'Knowledge', relativePath: 'first/knowledge', sourceId: 'local', progress: sharedProgress },
    { id: 'same-b', title: 'Knowledge', relativePath: 'second/<knowledge>&"', sourceId: 'smb', progress: sharedProgress },
  ];
  hooks.state.comics = books;
  hooks.renderContinueStrip();
  let markup = hooks.elements.continueStrip.innerHTML;
  assert.equal((markup.match(/class="continue-context"/g) || []).length, 2);
  assert.ok(markup.includes('first/knowledge'));
  assert.ok(markup.includes('second/&lt;knowledge&gt;&amp;&quot;'), 'source context is escaped in text and tooltip');
  assert.ok(!markup.includes('second/<knowledge>'), 'paths never inject markup');
  assert.equal((markup.match(/alt=""/g) || []).length, 2, 'decorative covers do not repeat the accessible book title');
  books[0].relativePath = 'moved/knowledge';
  hooks.renderContinueStrip();
  assert.ok(hooks.elements.continueStrip.innerHTML.includes('moved/knowledge'), 'path change invalidates cached Continue markup');
  books[1].title = 'Unique';
  hooks.renderContinueStrip();
  assert.ok(!hooks.elements.continueStrip.innerHTML.includes('continue-context'), 'unique names keep the compact card');
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

// 開書意圖一旦成立，queued shelf covers 必須讓路給 reader；待返回書架
// 後才恢復，避免 external archive 的 cover route 在 cold open 期間繼續堆積。
{
  const opening = createHarness();
  const cover = makeCover('reader-priority-cover');
  opening.hooks.state.pendingComicId = 'cold-open-book';
  opening.hooks.setCoverVisibility(cover, true);
  opening.hooks.enqueueCoverLoad(cover);
  opening.hooks.drainCoverLoadQueue();
  assert.equal(cover.src, '', 'pending reader keeps new shelf cover work queued');
  assert.equal(opening.hooks.getCoverQueueState().active, 0);
  opening.hooks.state.pendingComicId = null;
  opening.hooks.drainCoverLoadQueue();
  assert.equal(cover.src, '/cover/reader-priority-cover', 'cover queue resumes after reader intent clears');
  opening.hooks.resetCoverLoadQueue();
}

// Reader open failure clears pendingComicId without closeReader; the failure
// path itself must restart the real cover pump rather than leaving it paused.
{
  const failedOpen = createHarness();
  const comic = {
    id: 'failed-reader-cover',
    title: 'Failed reader cover',
    relativePath: 'external/H/book.cbz',
    sourceId: 'external:files',
    type: 'external-archive',
    pageCount: 12,
  };
  const cover = makeCover(comic.id);
  failedOpen.context.window.electronAPI.openComic = async () => {
    throw new Error('temporary provider failure');
  };
  failedOpen.hooks.setCoverVisibility(cover, true);
  failedOpen.hooks.enqueueCoverLoad(cover);
  const open = failedOpen.hooks.openReader(comic);
  await Promise.resolve();
  failedOpen.clock.tick(80);
  assert.equal(cover.src, '', 'failed reader intent keeps shelf cover paused while open is pending');
  await open;
  assert.equal(failedOpen.hooks.state.pendingComicId, null);
  failedOpen.clock.tick(0);
  assert.equal(cover.src, `/cover/${comic.id}`, 'open failure finally resumes the real cover pump');
  failedOpen.hooks.resetCoverLoadQueue();
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

// IntersectionObserver 判定可視封面後，應立即啟動既有限流 pump；
// 不增加 concurrency 或預載範圍，非可視／一般 enqueue 仍保留 80ms 延遲。
{
  const immediate = makeCover('immediate-visible');
  hooks.setCoverVisibility(immediate, true);
  hooks.enqueueCoverLoad(immediate, { immediate: true });
  clock.tick(0);
  assert.equal(immediate.src, '/cover/immediate-visible', '可視封面立即開始載入');
  assert.equal(hooks.getCoverQueueState().active, 1, '立即載入仍維持單一 task 生命週期');
  hooks.resetCoverLoadQueue();
}

// 目前資料夾的可見封面優先於「繼續閱讀」，舊卡片取消不佔名額。
{
  const shelf = createHarness();
  const recent = makeCover('recent-secondary');
  recent.dataset.coverPriority = 'secondary';
  const folderBookA = makeCover('current-folder-a');
  const folderBookB = makeCover('current-folder-b');
  [recent, folderBookA, folderBookB].forEach(image => {
    shelf.hooks.setCoverVisibility(image, true);
    shelf.hooks.enqueueCoverLoad(image);
  });
  shelf.clock.tick(80);
  assert.equal(folderBookA.src, '/cover/current-folder-a', 'current folder wins even if recent cover queued first');
  assert.equal(folderBookB.src, '/cover/current-folder-b');
  assert.equal(recent.src, '', 'recent cover waits while the current folder occupies both slots');
  folderBookA.dispatch('load');
  shelf.clock.tick(0);
  assert.equal(recent.src, '/cover/recent-secondary', 'recent cover loads when a slot is free');
  shelf.hooks.removeScheduledCover(recent);
  recent.dispatch('error');
  assert.equal(shelf.hooks.getCoverQueueState().active, 1, 'replaced recent cover releases only its own slot');
  assert.equal(shelf.hooks.getCoverQueueState().failed.size, 0, 'cancelled recent cover does not poison shelf retry');
  assert.equal(recent.dataset.coverState, 'idle', 'cancelled image can be reused');
  assert.equal(recent.dataset.src, '/cover/recent-secondary');
  shelf.hooks.setCoverVisibility(recent, true);
  shelf.hooks.enqueueCoverLoad(recent);
  shelf.clock.tick(0);
  assert.equal(recent.src, '/cover/recent-secondary', 'reused image can be scheduled again');
  shelf.hooks.resetCoverLoadQueue();
}

// 失敗黑名單有 TTL，掃描／來源刷新則可清空並重試。
{
  const failed = makeCover('retryable');
  hooks.markCoverUnavailable(failed);
  assert.equal(hooks.hasFailedCover('retryable'), true);
  clock.tick(30_000);
  assert.equal(hooks.hasFailedCover('retryable'), false);
}

// 封面失敗黑名單必須包含來源；A 來源失敗不可阻擋同 id 的 B 來源。
{
  const failedLocal = makeCover('shared-cover');
  failedLocal.dataset.coverSourceId = 'local:one';
  const failedSmb = makeCover('shared-cover');
  failedSmb.dataset.coverSourceId = 'smb:two';
  hooks.markCoverUnavailable(failedLocal);
  assert.equal(hooks.hasFailedCover('shared-cover', 'local:one'), true);
  assert.equal(hooks.hasFailedCover('shared-cover', 'smb:two'), false,
    '同 id 的另一來源封面仍可嘗試');
  hooks.markCoverUnavailable(failedSmb);
  assert.equal(hooks.hasFailedCover('shared-cover', 'local:one'), true);
  assert.equal(hooks.hasFailedCover('shared-cover', 'smb:two'), true);
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
  assert.equal(incremental.hooks.applyIncrementalLibraryBatch({
    generation: 12,
    found: 3,
    items: [{ id: 'book-a', title: 'A（SMB）', relativePath: 'a.cbz', sourceId: 'smb:test' }],
  }), true);
  assert.deepEqual(
    incremental.hooks.state.comics.filter(item => item.id === 'book-a').map(item => item.sourceId),
    ['local:test', 'smb:test'],
    '增量 merge 以 sourceId + id 辨識，不能覆蓋另一來源同 id 書籍',
  );
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
  assert.deepEqual(incremental.hooks.state.comics.map(item => item.id), ['book-a', 'book-b', 'book-a', 'book-c', 'book-d', 'visible-book']);
}

// 增量批次若在滑動期間抵達，停止滑動後應補一次增量 render；掃描尚未完成時
// 不應因 visual render 被 gate 擋下而重抓整個書庫。
{
  const scrolling = createHarness();
  let refreshes = 0;
  scrolling.hooks.setLibraryRefreshRunner(() => { refreshes += 1; });
  scrolling.hooks.state.scanStatus = { isScanning: true, generation: 21, found: 0 };
  vm.runInContext('filterAndRenderGrid = () => { incrementalRenders += 1; }; renderSidebar = () => {}; renderContinueStrip = () => {}; updateStats = () => {};', scrolling.context);
  scrolling.context.incrementalRenders = 0;
  scrolling.hooks.noteCatalogScroll();
  assert.equal(scrolling.hooks.applyIncrementalLibraryBatch({
    generation: 21,
    found: 1,
    items: [{ id: 'scroll-book', title: 'Scroll', relativePath: 'scroll.cbz', sourceId: 'local:scroll' }],
  }), true);
  scrolling.clock.tick(0);
  assert.equal(scrolling.context.incrementalRenders, 0, '滑動期間先不執行增量 render');
  assert.equal(refreshes, 0, '掃描中不能因滑動 gate 觸發 full refresh');
  scrolling.clock.tick(180);
  scrolling.clock.tick(0);
  assert.equal(scrolling.context.incrementalRenders, 1, '停止滑動後補一次被 gate 的增量 render');
  assert.equal(refreshes, 0, '增量 render 補償不應重抓整庫');
  scrolling.hooks.setLibraryRefreshRunner(null);
}

// History live hydration is scheduled only after applyIncrementalLibraryBatch
// accepts the current generation; the real stale-generation early return must
// not enqueue an otherwise matching own-Documents source/path.
{
  const ownDocuments = `local:${Buffer.from('/private/var/mobile/Containers/Data/Application/A1234567-B123-4234-9234-A123456789AB/Documents').toString('base64url')}`;
  const makeHistoryBatchHarness = () => {
    const h = createHarness();
    vm.runInContext('renderReadingHistory = () => {}; renderReadingHistoryStatus = () => {};', h.context);
    let requests = 0;
    h.context.window.electronAPI.getReadingHistory = async () => {
      requests += 1;
      return { items: [{ openedAt: '2026-11-09T10:00:00Z', comic: {
        id: 'history-A', sourceId: ownDocuments, relativePath: 'A.cbz', offline: false,
      } }], total: 1 };
    };
    h.hooks.state.readingHistoryVisible = true;
    h.hooks.state.readingHistoryPeriod = 'month';
    h.hooks.state.readingHistoryItems = [{ comic: {
      id: 'history-A', sourceId: ownDocuments, relativePath: 'A.cbz', offline: true,
    }, openedAt: '2026-11-09T10:00:00Z' }];
    h.hooks.state.readingHistoryOffset = 1;
    h.hooks.state.readingHistoryLoadedCount = 1;
    h.hooks.state.readingHistoryTotal = 1;
    h.hooks.state.readingHistoryLoading = false;
    h.hooks.state.readingHistoryScrollTop = 51;
    h.hooks.elements.contentArea = { scrollTop: 51 };
    h.hooks.state.scanStatus = { isScanning: true, generation: 50, found: 1 };
    return { ...h, get requests() { return requests; } };
  };
  const accepted = makeHistoryBatchHarness();
  accepted.hooks.applyIncrementalLibraryBatch({
    generation: 50,
    items: [{ id: 'history-A', sourceId: ownDocuments, relativePath: 'A.cbz' }],
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted.requests, 1, 'accepted own-Documents discovery refreshes its exact offline history row');
  assert.equal(accepted.hooks.state.readingHistoryItems[0].comic.offline, false);
  assert.equal(accepted.hooks.elements.contentArea.scrollTop, 51, 'batch hydration preserves history scroll');

  const stale = makeHistoryBatchHarness();
  stale.hooks.state.scanStatus.generation = 51;
  stale.hooks.applyIncrementalLibraryBatch({
    generation: 50,
    items: [{ id: 'history-A', sourceId: ownDocuments, relativePath: 'A.cbz' }],
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stale.requests, 0, 'stale batch generation returns before queuing a history refresh');
  const foreign = makeHistoryBatchHarness();
  foreign.hooks.applyIncrementalLibraryBatch({
    generation: 50,
    items: [{ id: 'history-A', sourceId: 'smb:server', relativePath: 'A.cbz' }],
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(foreign.requests, 0, 'same relative path from SMB cannot refresh own-Documents history');
}

// 已完成掃描後的 visible batch 仍需保留 full refresh，避免局部目錄快照取代
// 權威全庫 reconciliation；增量 render 只負責先讓目前畫面及時更新。
{
  const visible = createHarness();
  let refreshes = 0;
  visible.hooks.setLibraryRefreshRunner(() => { refreshes += 1; });
  visible.hooks.state.scanStatus = { isScanning: false, generation: 22, found: 1 };
  vm.runInContext('filterAndRenderGrid = () => { incrementalRenders += 1; }; renderSidebar = () => {}; renderContinueStrip = () => {}; updateStats = () => {};', visible.context);
  visible.context.incrementalRenders = 0;
  visible.hooks.noteCatalogScroll();
  assert.equal(visible.hooks.applyIncrementalLibraryBatch({
    generation: 22,
    visible: true,
    found: 1,
    items: [{ id: 'visible-scroll-book', title: 'Visible', relativePath: 'visible.cbz', sourceId: 'local:visible' }],
  }), true);
  visible.clock.tick(0);
  assert.equal(visible.context.incrementalRenders, 0, 'visible batch 仍尊重滑動 gate');
  visible.clock.tick(180);
  visible.clock.tick(0);
  assert.equal(visible.context.incrementalRenders, 1, 'visible batch 停止滑動後先補增量 render');
  assert.equal(refreshes, 1, '已完成掃描的 visible batch 仍執行權威 full refresh');
  visible.hooks.setLibraryRefreshRunner(null);
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

// 書架接近尾端時只增加下一批可見卡片；遠離尾端不應提前建立整庫 DOM。
{
  const shelf = createHarness();
  shelf.hooks.state.comics = Array.from({ length: 401 }, (_, index) => ({
    id: 'shelf-' + index, title: 'Shelf ' + index, relativePath: 'shelf/' + index + '.cbz',
    sourceId: 'local:test', type: 'archive', pageCount: 1,
  }));
  shelf.hooks.state.filteredComics = shelf.hooks.state.comics.slice();
  shelf.hooks.state.renderLimit = 200;
  shelf.hooks.elements.contentArea = shelf.document.body;
  shelf.hooks.elements.contentArea.scrollTop = 100;
  shelf.hooks.elements.contentArea.scrollHeight = 4000;
  shelf.hooks.elements.contentArea.clientHeight = 800;
  assert.equal(shelf.hooks.maybeAutoLoadCatalogBatch(), false, '遠離尾端不提前載入下一批');
  assert.equal(shelf.hooks.state.renderLimit, 200);
  shelf.hooks.elements.contentArea.scrollTop = 2700;
  assert.equal(shelf.hooks.maybeAutoLoadCatalogBatch(), true, '接近尾端會載入下一批');
  assert.equal(shelf.hooks.state.renderLimit, 200, '分幀載入尚未在同一呼叫堆疊同步擴張');
  shelf.clock.tick(0);
  assert.equal(shelf.hooks.state.renderLimit, 400);
  assert.equal(shelf.hooks.elements.comicGrid.children.length, 400, '401 本只建立目前兩批卡片');
  const initialObserver = shelf.context.IntersectionObserver.instances.at(-1);
  assert.equal(initialObserver.targets.length, 400, '初次 observer 必須涵蓋目前所有封面');
  const observedPrefix = initialObserver.targets.slice();
  shelf.hooks.elements.contentArea.scrollTop = 3200;
  assert.equal(shelf.hooks.maybeAutoLoadCatalogBatch(), true);
  shelf.clock.tick(0);
  assert.equal(shelf.hooks.state.renderLimit, 401, '尾批只補到實際總數');
  assert.equal(initialObserver.targets.length, 401, 'append-only 只需向既有 observer 加入新封面');
  assert.deepEqual(initialObserver.targets.slice(0, observedPrefix.length), observedPrefix, 'append 不得重建或重複 observe 舊封面');

  const rebuilt = createHarness();
  rebuilt.hooks.state.comics = shelf.hooks.state.comics.slice(0, 201);
  rebuilt.hooks.state.filteredComics = rebuilt.hooks.state.comics.slice(0, 200);
  rebuilt.hooks.state.renderLimit = 200;
  rebuilt.hooks.renderGrid();
  const previousObserver = rebuilt.context.IntersectionObserver.instances.at(-1);
  rebuilt.hooks.setCoverObserver(null);
  rebuilt.hooks.renderGrid();
  const rebuiltObserver = rebuilt.context.IntersectionObserver.instances.at(-1);
  assert.notEqual(rebuiltObserver, previousObserver, 'observer 重建時必須建立新實例');
  assert.equal(rebuiltObserver.targets.length, 200, 'observer 重建仍須涵蓋既有封面');
}

// lazy append 執行第一個 chunk 後若進入閱讀器，後續 frame 不得繼續建立書架卡片；
// 關閉閱讀器後，同一個安全 context 才能恢復剩餘意圖。
{
  const gated = createHarness();
  gated.hooks.state.comics = Array.from({ length: 401 }, (_, index) => ({
    id: 'gate-' + index, title: 'Gate ' + index, relativePath: 'gate/' + index,
  }));
  gated.hooks.state.filteredComics = gated.hooks.state.comics.slice();
  gated.hooks.state.renderLimit = 200;
  gated.hooks.renderGrid();
  assert.equal(gated.hooks.requestNextCatalogBatch(), true);
  assert.equal(gated.clock.tickOne(), true, '第一個 append frame 必須可單獨執行');
  assert.equal(gated.hooks.state.renderLimit, 232);
  assert.equal(gated.hooks.elements.comicGrid.children.length, 232);
  gated.hooks.state.currentComic = { id: 'reading-now' };
  assert.equal(gated.clock.tickOne(), true, '讀者切換後仍應消費已排程 frame 以觸發 gate');
  assert.equal(gated.hooks.state.renderLimit, 232, '讀者開啟後不得再建立卡片');
  assert.equal(gated.hooks.elements.comicGrid.children.length, 232, '讀者開啟後 DOM 不得繼續增加');
  gated.hooks.state.currentComic = null;
  assert.equal(gated.hooks.resumeCatalogAppendRenderIfReady(), true, '返回書架應恢復同 context 的 append 意圖');
  gated.clock.tick(0);
  assert.equal(gated.hooks.state.renderLimit, 400);
  assert.equal(gated.hooks.elements.comicGrid.children.length, 400);
}

// reader gate 下若連續發生兩次背景 filter refresh，deferred-only intent 仍須保存；
// 真實 closeReader 路徑解除 gate 後才恢復剩餘 append。
{
  const repeatedRefresh = createHarness();
  repeatedRefresh.hooks.state.comics = Array.from({ length: 401 }, (_, index) => ({
    id: 'repeat-' + index, title: 'Repeat ' + index, relativePath: 'repeat-' + index,
  }));
  repeatedRefresh.hooks.state.filteredComics = repeatedRefresh.hooks.state.comics.slice();
  repeatedRefresh.hooks.state.renderLimit = 200;
  repeatedRefresh.hooks.elements.searchInput.value = '';
  repeatedRefresh.hooks.renderGrid();
  assert.equal(repeatedRefresh.hooks.requestNextCatalogBatch(), true);
  assert.equal(repeatedRefresh.clock.tickOne(), true);
  repeatedRefresh.hooks.state.currentComic = { id: 'repeat-reading' };
  assert.equal(repeatedRefresh.clock.tickOne(), true);
  assert.equal(repeatedRefresh.hooks.state.renderLimit, 232);
  repeatedRefresh.hooks.filterAndRenderGrid({ skipUnchanged: true });
  repeatedRefresh.hooks.filterAndRenderGrid({ skipUnchanged: true });
  assert.equal(repeatedRefresh.hooks.state.renderLimit, 232, 'reader 中連續 refresh 不得建立卡片或遺失 intent');
  await repeatedRefresh.hooks.closeReader();
  repeatedRefresh.clock.tick(0);
  assert.equal(repeatedRefresh.hooks.state.renderLimit, 400, '真實 closeReader 後應恢復 deferred append');
}

// 掃描增量刷新會取消當前 frame；同 path/query 的 render 必須保留尾端 intent，
// 而 query/path 改變時則不可把舊 append 洩漏到新畫面。
{
  const scan = createHarness();
  scan.hooks.state.comics = Array.from({ length: 401 }, (_, index) => ({
    id: 'scan-' + index, title: 'Scan ' + index, relativePath: 'scan-' + index,
  }));
  scan.hooks.state.filteredComics = scan.hooks.state.comics.slice();
  scan.hooks.state.renderLimit = 200;
  scan.hooks.renderGrid();
  assert.equal(scan.hooks.requestNextCatalogBatch(), true);
  assert.equal(scan.clock.tickOne(), true);
  assert.equal(scan.hooks.state.renderLimit, 232);
  scan.hooks.elements.searchInput.value = '';
  scan.hooks.state.comics[0] = { ...scan.hooks.state.comics[0], title: 'Scan updated' };
  scan.hooks.filterAndRenderGrid({ skipUnchanged: true });
  assert.equal(scan.hooks.state.renderLimit, 232, '掃描刷新不得同步建立剩餘卡片');
  for (let attempt = 0; attempt < 8 && scan.hooks.state.renderLimit === 232; attempt += 1) {
    assert.equal(scan.clock.tickOne(), true, '同 context 的掃描刷新應恢復下一個 append frame');
  }
  assert.equal(scan.hooks.state.renderLimit, 264);
  scan.hooks.elements.searchInput.value = 'different-query';
  scan.hooks.filterAndRenderGrid({ skipUnchanged: true });
  scan.clock.tick(0);
  assert.equal(scan.hooks.state.renderLimit, 264, 'query 改變後不得執行舊 context append');
}

// 搜尋 append 必須去重 in-flight；舊 query 回覆不得覆蓋新 query。
{
  const search = createHarness();
  search.hooks.state.catalogSearchIds = new Set([catalogSearchKey(search.hooks, 'old-0'), catalogSearchKey(search.hooks, 'old-1')]);
  search.hooks.state.catalogSearchItems = new Map([
    [catalogSearchKey(search.hooks, 'old-0'), { runtimeId: 'old-0', title: 'old' }],
    [catalogSearchKey(search.hooks, 'old-1'), { runtimeId: 'old-1', title: 'old' }],
  ]);
  search.hooks.state.catalogSearchTotal = 401;
  search.hooks.state.catalogSearchBackendOffset = 2;
  search.hooks.state.renderLimit = 200;
  search.hooks.elements.contentArea = search.document.body;
  search.hooks.elements.searchInput.value = 'old';
  let appendResolve;
  const searchCalls = [];
  search.context.window.electronAPI.searchCatalog = request => {
    searchCalls.push(request);
    if (request.query === 'old' && request.offset === 2) {
      return new Promise(resolve => { appendResolve = resolve; });
    }
    return Promise.resolve({ items: [{ runtimeId: request.query + '-0' }], total: 1, facets: {} });
  };
  assert.equal(search.hooks.requestNextCatalogBatch(), true);
  assert.equal(search.hooks.requestNextCatalogBatch(), false, '同一搜尋 append 不得重複 in-flight');
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].offset, 2);
  appendResolve({ items: [{ runtimeId: 'old-2' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(search.hooks.state.catalogSearchItems.has(catalogSearchKey(search.hooks, 'old-2')), true);

  const oldQuery = search.hooks.refreshCatalogSearch('old');
  const newQuery = search.hooks.refreshCatalogSearch('new');
  await newQuery;
  appendResolve?.({ items: [{ runtimeId: 'late-old' }], total: 401, facets: {} });
  await oldQuery;
  assert.equal(search.hooks.state.catalogSearchItems.has(catalogSearchKey(search.hooks, 'new-0')), true, '新 query 應提交');
  assert.equal(search.hooks.state.catalogSearchItems.has(catalogSearchKey(search.hooks, 'late-old')), false, '過時 query 不得覆蓋新結果');
}

// 新 query 的 debounce 期間也不能沿用舊 append cursor；舊 append 回來後
// 不得重新填回已清空的 snapshot。
{
  const interleaved = createHarness();
  interleaved.hooks.elements.contentArea = interleaved.document.body;
  interleaved.hooks.state.comics = Array.from({ length: 401 }, (_, index) => ({
    id: 'debounce-' + index, title: 'new item ' + index, relativePath: 'new/' + index,
  }));
  // This scenario exercises backend append gating; local results are filled
  // only after the new query refresh, so they must not preempt the old append.
  interleaved.hooks.state.filteredComics = [];
  interleaved.hooks.state.catalogSearchIds = new Set([catalogSearchKey(interleaved.hooks, 'old-0'), catalogSearchKey(interleaved.hooks, 'old-1')]);
  interleaved.hooks.state.catalogSearchItems = new Map([
    [catalogSearchKey(interleaved.hooks, 'old-0'), { runtimeId: 'old-0' }],
    [catalogSearchKey(interleaved.hooks, 'old-1'), { runtimeId: 'old-1' }],
  ]);
  interleaved.hooks.state.catalogSearchTotal = 401;
  interleaved.hooks.state.catalogSearchBackendOffset = 2;
  interleaved.hooks.state.renderLimit = 200;
  interleaved.hooks.elements.searchInput.value = 'old';
  let resolveOldAppend;
  let resolveNewAppend;
  const calls = [];
  interleaved.context.window.electronAPI.searchCatalog = request => {
    calls.push(request);
    if (request.query === 'old') return new Promise(resolve => { resolveOldAppend = resolve; });
    if (request.offset === 1) return new Promise(resolve => { resolveNewAppend = resolve; });
    return Promise.resolve({ items: [{ runtimeId: 'new-0' }], total: 401, facets: {} });
  };
  assert.equal(interleaved.hooks.requestNextCatalogBatch(), true);
  const input = interleaved.hooks.elements.searchInput;
  input.value = 'new';
  interleaved.hooks.handleSearch({ target: input });
  assert.equal(interleaved.hooks.state.catalogSearchIds, null, '輸入新 query 立即清除舊 ids');
  assert.equal(interleaved.hooks.state.catalogSearchItems.size, 0, '輸入新 query 立即清除舊結果');
  const callsBeforeDebounceScroll = calls.length;
  interleaved.hooks.requestNextCatalogBatch();
  assert.equal(calls.length, callsBeforeDebounceScroll, 'debounce 期間 scroll 不得以舊 offset append');
  interleaved.clock.tick(180);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).query, 'new');
  assert.equal(calls.at(-1).offset, 0, '新 query 初次請求必須從 offset 0 開始');
  assert.equal(interleaved.hooks.requestNextCatalogBatch(), true, '舊 query pending 不得阻塞新 query append');
  assert.equal(calls.at(-1).query, 'new');
  assert.equal(calls.at(-1).offset, 1);
  resolveNewAppend({ items: [{ runtimeId: 'new-1' }], total: 401, facets: {} });
  resolveOldAppend({ items: [{ runtimeId: 'late-old' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interleaved.hooks.state.catalogSearchItems.has(catalogSearchKey(interleaved.hooks, 'new-1')), true);
  assert.equal(interleaved.hooks.state.catalogSearchItems.has(catalogSearchKey(interleaved.hooks, 'late-old')), false);
}

// ABA query 交錯：舊 A append pending，A -> B -> A 後，新 A append 不得被
// 舊 A gate 擋住；舊 A finally 也不得清掉新 A token。
{
  const aba = createHarness();
  aba.hooks.elements.contentArea = aba.document.body;
  aba.hooks.state.catalogSearchIds = new Set([catalogSearchKey(aba.hooks, 'a-old-0'), catalogSearchKey(aba.hooks, 'a-old-1')]);
  aba.hooks.state.catalogSearchItems = new Map([
    [catalogSearchKey(aba.hooks, 'a-old-0'), { runtimeId: 'a-old-0' }],
    [catalogSearchKey(aba.hooks, 'a-old-1'), { runtimeId: 'a-old-1' }],
  ]);
  aba.hooks.state.catalogSearchTotal = 401;
  aba.hooks.state.catalogSearchBackendOffset = 2;
  aba.hooks.elements.searchInput.value = 'A';
  let resolveOldA;
  let resolveNewA;
  const calls = [];
  aba.context.window.electronAPI.searchCatalog = request => {
    calls.push(request);
    if (request.query === 'A' && request.offset === 2) {
      return new Promise(resolve => { resolveOldA = resolve; });
    }
    if (request.query === 'A' && request.offset === 1) {
      return new Promise(resolve => { resolveNewA = resolve; });
    }
    return Promise.resolve({
      items: [{ runtimeId: request.query + '-0' }],
      total: 401,
      facets: {},
    });
  };
  assert.equal(aba.hooks.requestNextCatalogBatch(), true);
  const input = aba.hooks.elements.searchInput;
  input.value = 'B';
  aba.hooks.handleSearch({ target: input });
  aba.clock.tick(180);
  await new Promise(resolve => setImmediate(resolve));
  input.value = 'A';
  aba.hooks.handleSearch({ target: input });
  aba.clock.tick(180);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aba.hooks.requestNextCatalogBatch(), true, '新 A append 不得被舊 A gate 擋住');
  assert.equal(calls.at(-1).query, 'A');
  assert.equal(calls.at(-1).offset, 1);
  resolveOldA({ items: [{ runtimeId: 'late-old-A' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aba.hooks.requestNextCatalogBatch(), false, '舊 A finally 不得清掉新 A gate');
  resolveNewA({ items: [{ runtimeId: 'new-A-1' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aba.hooks.state.catalogSearchItems.has(catalogSearchKey(aba.hooks, 'new-A-1')), true);
  assert.equal(aba.hooks.state.catalogSearchItems.has(catalogSearchKey(aba.hooks, 'late-old-A')), false);
}

// restoreLibraryViewContext 也會使搜尋 snapshot 失效；pending A 回來時，
// 恢復 A 的新 append 不得被舊 token 卡住。
{
  const restored = createHarness();
  restored.hooks.state.comics = [{ id: 'restore-a', title: 'A', relativePath: 'a' }];
  restored.hooks.elements.searchInput.value = 'A';
  restored.hooks.state.catalogSearchIds = new Set([catalogSearchKey(restored.hooks, 'restore-a')]);
  restored.hooks.state.catalogSearchItems = new Map([[catalogSearchKey(restored.hooks, 'restore-a'), { runtimeId: 'restore-a' }]]);
  restored.hooks.state.catalogSearchTotal = 401;
  restored.hooks.state.catalogSearchBackendOffset = 1;
  let resolveOld;
  let resolveNew;
  let oldStarted = false;
  const calls = [];
  restored.context.window.electronAPI.searchCatalog = request => {
    calls.push(request);
    if (request.offset === 1 && !oldStarted) {
      oldStarted = true;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    if (request.offset === 1) {
      return new Promise(resolve => { resolveNew = resolve; });
    }
    return Promise.resolve({ items: [{ runtimeId: 'restore-a' }], total: 401, facets: {} });
  };
  assert.equal(restored.hooks.requestNextCatalogBatch(), true);
  restored.hooks.restoreLibraryViewContext({
    currentPath: '',
    currentSourceId: '',
    activeSeries: 'all',
    activeFilter: 'all',
    searchQuery: 'A',
    selectedComicId: null,
    selectedComicSourceId: '',
    catalogSearchIds: new Set([catalogSearchKey(restored.hooks, 'restore-a')]),
    catalogSearchItems: new Map([[catalogSearchKey(restored.hooks, 'restore-a'), { runtimeId: 'restore-a' }]]),
    catalogSearchTotal: 401,
    catalogSearchBackendOffset: 1,
    scrollTop: null,
  });
  assert.equal(restored.hooks.requestNextCatalogBatch(), true, 'restore 後 A 可重新 append');
  assert.equal(calls.length, 2);
  resolveOld({ items: [{ runtimeId: 'old-restore' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.hooks.requestNextCatalogBatch(), false, '舊 A finally 不得解除恢復後的新 gate');
  resolveNew({ items: [{ runtimeId: 'new-restore' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.hooks.state.catalogSearchItems.has(catalogSearchKey(restored.hooks, 'new-restore')), true);
  assert.equal(restored.hooks.state.catalogSearchItems.has(catalogSearchKey(restored.hooks, 'old-restore')), false);
}

// 非 append refresh 會替換搜尋 snapshot；它也必須解除舊 append gate，
// 讓同 query 的新 append 不被 pending 舊請求永久卡住。
{
  const refreshed = createHarness();
  refreshed.hooks.elements.searchInput.value = 'A';
  refreshed.hooks.state.catalogSearchIds = new Set([catalogSearchKey(refreshed.hooks, 'a-0')]);
  refreshed.hooks.state.catalogSearchItems = new Map([[catalogSearchKey(refreshed.hooks, 'a-0'), { runtimeId: 'a-0' }]]);
  refreshed.hooks.state.catalogSearchTotal = 401;
  refreshed.hooks.state.catalogSearchBackendOffset = 1;
  let resolveOldAppend;
  let resolveNewAppend;
  let appendCount = 0;
  refreshed.context.window.electronAPI.searchCatalog = request => {
    if (request.offset === 0) {
      return Promise.resolve({ items: [{ runtimeId: 'a-0' }], total: 401, facets: {} });
    }
    appendCount += 1;
    if (appendCount === 1) return new Promise(resolve => { resolveOldAppend = resolve; });
    return new Promise(resolve => { resolveNewAppend = resolve; });
  };
  assert.equal(refreshed.hooks.requestNextCatalogBatch(), true);
  await refreshed.hooks.refreshCatalogSearch('A');
  assert.equal(refreshed.hooks.requestNextCatalogBatch(), true, 'refresh 後可重新啟動同 query append');
  assert.equal(appendCount, 2);
  resolveOldAppend({ items: [{ runtimeId: 'old-refresh' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshed.hooks.requestNextCatalogBatch(), false, '舊 finally 不得解除新 append gate');
  resolveNewAppend({ items: [{ runtimeId: 'new-refresh' }], total: 401, facets: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshed.hooks.state.catalogSearchItems.has(catalogSearchKey(refreshed.hooks, 'new-refresh')), true);
  assert.equal(refreshed.hooks.state.catalogSearchItems.has(catalogSearchKey(refreshed.hooks, 'old-refresh')), false);
}

// 搜尋結果必須以來源 + runtimeId + exact relativePath 去重；同一來源的
// 相同 runtimeId 只要位置不同，也不得互相覆蓋。
{
  const collision = createHarness();
  collision.hooks.elements.searchInput.value = 'same';
  collision.context.window.electronAPI.searchCatalog = async request => {
    assert.equal(request.offset, 0);
    return {
      items: [
        { runtimeId: 'same', sourceId: 'local:A', relativePath: 'Shelf/Local.cbz', title: 'Local copy' },
        { runtimeId: 'same', sourceId: 'smb:B', relativePath: 'Shelf/SMB.cbz', title: 'SMB copy' },
      ],
      total: 3,
      facets: {},
    };
  };
  await collision.hooks.refreshCatalogSearch('same');
  const localKey = collision.hooks.getCatalogSearchKey('same', 'local:A', 'Shelf/Local.cbz');
  const smbKey = collision.hooks.getCatalogSearchKey('same', 'smb:B', 'Shelf/SMB.cbz');
  assert.notEqual(localKey, smbKey, '不同來源的相同 runtimeId 必須有不同 identity');
  assert.equal(collision.hooks.state.catalogSearchItems.size, 2);
  assert.equal(collision.hooks.state.catalogSearchItems.get(localKey).title, 'Local copy');
  assert.equal(collision.hooks.state.catalogSearchItems.get(smbKey).title, 'SMB copy');
  assert.equal(collision.hooks.state.catalogSearchBackendOffset, 2);

  const sameSourceDifferentPath = createHarness();
  sameSourceDifferentPath.hooks.elements.searchInput.value = 'same';
  sameSourceDifferentPath.context.window.electronAPI.searchCatalog = async () => ({
    items: [
      { runtimeId: 'same', sourceId: 'local:A', relative_path: 'Shelf/One.cbz', title: 'One' },
      { runtimeId: 'same', sourceId: 'local:A', relative_path: 'Shelf/Two.cbz', title: 'Two' },
    ],
    total: 2,
    facets: {},
  });
  await sameSourceDifferentPath.hooks.refreshCatalogSearch('same');
  const oneKey = sameSourceDifferentPath.hooks.getCatalogSearchKey('same', 'local:A', 'Shelf/One.cbz');
  const twoKey = sameSourceDifferentPath.hooks.getCatalogSearchKey('same', 'local:A', 'Shelf/Two.cbz');
  assert.notEqual(oneKey, twoKey, '同來源同 runtimeId 的不同 relativePath 必須有不同 identity');
  assert.equal(sameSourceDifferentPath.hooks.state.catalogSearchItems.size, 2);
  assert.equal(sameSourceDifferentPath.hooks.state.catalogSearchItems.get(oneKey).title, 'One');
  assert.equal(sameSourceDifferentPath.hooks.state.catalogSearchItems.get(twoKey).title, 'Two');

  const workLocations = createHarness();
  workLocations.hooks.elements.searchInput.value = 'work';
  workLocations.context.window.electronAPI.searchCatalog = async () => ({
    items: [{
      runtimeId: 'work-runtime', sourceId: 'local:A', relativePath: 'Shelf/Online.cbz', offline: false,
      title: 'One work',
      locations: [
        { runtimeId: 'work-runtime', sourceId: 'local:A', relativePath: 'Shelf/Online.cbz', offline: false },
        { runtimeId: 'work-runtime', sourceId: 'smb:B', relativePath: 'Archive/Offline.cbz', offline: true },
      ],
    }],
    total: 1,
    facets: {},
  });
  await workLocations.hooks.refreshCatalogSearch('work');
  const onlineLocationKey = workLocations.hooks.getCatalogSearchKey(
    'work-runtime', 'local:A', 'Shelf/Online.cbz',
  );
  const offlineLocationKey = workLocations.hooks.getCatalogSearchKey(
    'work-runtime', 'smb:B', 'Archive/Offline.cbz',
  );
  assert.equal(workLocations.hooks.state.catalogSearchItems.size, 2,
    '單一 work 的 locations 必須展開成各自可查詢的位置');
  assert.equal(workLocations.hooks.state.catalogSearchItems.get(onlineLocationKey).offline, false);
  assert.equal(workLocations.hooks.state.catalogSearchItems.get(offlineLocationKey).offline, true,
    '每個 location 必須保留自己的 offline 狀態');
  assert.equal(workLocations.hooks.state.catalogSearchBackendOffset, 1,
    'locations 展開不得把 per-work offset 誤增為位置數');

  const expanded = createHarness();
  const expandedLocations = Array.from({ length: 201 }, (_, index) => ({
    runtimeId: 'expanded-work',
    sourceId: 'local:expanded',
    relativePath: `Shelf/location-${index}.cbz`,
    offline: index === 200,
  }));
  expanded.hooks.state.comics = expandedLocations.map(location => ({
    id: location.runtimeId,
    sourceId: location.sourceId,
    relativePath: location.relativePath,
    title: location.relativePath,
    pageCount: 1,
  }));
  expanded.hooks.elements.searchInput.value = 'expanded';
  let expandedCalls = 0;
  expanded.context.window.electronAPI.searchCatalog = async () => {
    expandedCalls += 1;
    return {
      items: [{
        runtimeId: 'expanded-work', sourceId: 'local:expanded', relativePath: expandedLocations[0].relativePath,
        title: 'Expanded work', locations: expandedLocations,
      }],
      total: 1,
      facets: {},
    };
  };
  await expanded.hooks.refreshCatalogSearch('expanded');
  assert.equal(expanded.hooks.state.filteredComics.length, 201);
  assert.equal(expanded.hooks.state.renderLimit, 200);
  assert.equal(expanded.hooks.requestNextCatalogBatch({ manual: true }), true,
    'backend 已到 work 尾端時，手動按鈕仍先補完本地 location 卡片');
  expanded.clock.tick(0);
  assert.equal(expanded.hooks.state.renderLimit, 201);
  assert.equal(expandedCalls, 1, '本地 location 尚未顯示完不得再 append backend');
  expanded.hooks.state.renderLimit = 200;
  expanded.hooks.elements.contentArea = expanded.document.body;
  expanded.hooks.elements.contentArea.scrollTop = 2000;
  expanded.hooks.elements.contentArea.scrollHeight = 2500;
  expanded.hooks.elements.contentArea.clientHeight = 800;
  assert.equal(expanded.hooks.maybeAutoLoadCatalogBatch(), true,
    '接近尾端時自動分頁也必須先補本地 location');
  expanded.clock.tick(0);
  assert.equal(expanded.hooks.state.renderLimit, 201);
  assert.equal(expandedCalls, 1, '自動補本地 location 不得重打已耗盡的 backend work');

  const loadMore = createHarness();
  const loadMoreLocations = Array.from({ length: 200 }, (_, index) => ({
    runtimeId: 'load-more-work',
    sourceId: 'local:load-more',
    relativePath: `Shelf/location-${index}.cbz`,
  }));
  loadMore.hooks.state.comics = loadMoreLocations.map(location => ({
    id: location.runtimeId,
    sourceId: location.sourceId,
    relativePath: location.relativePath,
    title: location.relativePath,
    pageCount: 1,
  }));
  loadMore.hooks.elements.searchInput.value = 'load-more';
  loadMore.context.window.electronAPI.searchCatalog = async () => ({
    items: [{
      runtimeId: 'load-more-work', sourceId: 'local:load-more',
      relativePath: loadMoreLocations[0].relativePath,
      locations: loadMoreLocations,
    }],
    total: 2,
    facets: {},
  });
  await loadMore.hooks.refreshCatalogSearch('load-more');
  assert.equal(loadMore.hooks.state.catalogSearchBackendOffset, 1);
  assert.equal(loadMore.hooks.state.filteredComics.length, 200);
  assert.equal(loadMore.hooks.state.renderLimit, 200);
  assert.equal(loadMore.hooks.elements.catalogLoadMore.hidden, false,
    '位置數已顯示完但 backend 尚有 work 時，手動分頁按鈕不可隱藏');

  const scopedSearch = createHarness();
  scopedSearch.hooks.state.currentSourceId = 'local:target';
  scopedSearch.hooks.state.comics = [{
    id: 'target-work', sourceId: 'local:target', relativePath: 'Target/book.cbz', title: 'scoped Target book',
  }];
  scopedSearch.hooks.elements.searchInput.value = 'scoped';
  const scopedCalls = [];
  scopedSearch.context.window.electronAPI.searchCatalog = async request => {
    scopedCalls.push(request);
    if (request.offset === 0) {
      return {
        items: [{ runtimeId: 'other-work', sourceId: 'local:other', relativePath: 'Other/book.cbz' }],
        total: 2,
        facets: {},
      };
    }
    return {
      items: [{ runtimeId: 'target-work', sourceId: 'local:target', relativePath: 'Target/book.cbz', title: 'scoped Target book' }],
      total: 2,
      facets: {},
    };
  };
  await scopedSearch.hooks.refreshCatalogSearch('scoped');
  assert.equal(scopedSearch.hooks.elements.catalogLoadMore.hidden, false,
    '目前 source 無結果但 backend 尚有後頁時，空狀態仍提供手動載入');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(scopedCalls.map(request => request.offset), [0, 1],
    '目前 source 無結果時會串行推進 backend 到下一個可見 work');
  assert.equal(scopedSearch.hooks.state.filteredComics.length, 1);
  assert.equal(scopedSearch.hooks.state.catalogSearchBackendOffset, 2);
  assert.equal(scopedSearch.hooks.elements.catalogLoadMore.hidden, true,
    '找到目前 source 結果且 backend 已耗盡後隱藏載入按鈕');
}

// 沒有 runtimeId 的孤兒列不能進顯示 Map，但仍必須消耗 backend offset，
// 否則下一次 append 會重讀同一頁，並可能被錯誤判成無進展。
{
  const orphan = createHarness();
  orphan.hooks.elements.searchInput.value = 'orphan';
  const calls = [];
  orphan.context.window.electronAPI.searchCatalog = async request => {
    calls.push(request);
    if (request.offset === 0) {
      return { items: [{ runtimeId: 'known', sourceId: 'local:A' }], total: 3, facets: {} };
    }
    if (request.offset === 1) {
      return { items: [{ title: 'orphan row without runtime id' }], total: 3, facets: {} };
    }
    return { items: [{ runtimeId: 'last', sourceId: 'local:A' }], total: 3, facets: {} };
  };
  await orphan.hooks.refreshCatalogSearch('orphan');
  assert.equal(orphan.hooks.requestNextCatalogBatch(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(orphan.hooks.state.catalogSearchBackendOffset, 2);
  assert.equal(orphan.hooks.state.catalogSearchItems.size, 1, '孤兒列不應污染可顯示結果');
  assert.equal(orphan.hooks.state.catalogSearchNoProgress, false, '孤兒列仍代表 backend 有前進');
  orphan.clock.tick(0);
  assert.equal(orphan.hooks.requestNextCatalogBatch(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(request => request.offset), [0, 1, 2]);
  assert.equal(orphan.hooks.state.catalogSearchBackendOffset, 3);
  assert.equal(orphan.hooks.state.catalogSearchItems.size, 2);
}

// 伺服器回傳零進展時停止自動重試；手動按鈕仍可明確重試一次。
{
  const stalled = createHarness();
  stalled.hooks.state.catalogSearchIds = new Set([catalogSearchKey(stalled.hooks, 'same-0'), catalogSearchKey(stalled.hooks, 'same-1')]);
  stalled.hooks.state.catalogSearchItems = new Map([
    [catalogSearchKey(stalled.hooks, 'same-0'), { runtimeId: 'same-0' }],
    [catalogSearchKey(stalled.hooks, 'same-1'), { runtimeId: 'same-1' }],
  ]);
  stalled.hooks.state.catalogSearchTotal = 401;
  stalled.hooks.state.catalogSearchBackendOffset = 2;
  stalled.hooks.elements.contentArea = stalled.document.body;
  stalled.hooks.elements.searchInput.value = 'same';
  let stalledCalls = 0;
  stalled.context.window.electronAPI.searchCatalog = async () => {
    stalledCalls += 1;
    return { items: [], total: 401, facets: {} };
  };
  assert.equal(stalled.hooks.requestNextCatalogBatch(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stalled.hooks.state.catalogSearchNoProgress, true);
  stalled.hooks.elements.contentArea.scrollTop = 2000;
  stalled.hooks.elements.contentArea.scrollHeight = 2500;
  stalled.hooks.elements.contentArea.clientHeight = 800;
  assert.equal(stalled.hooks.maybeAutoLoadCatalogBatch(), false, '零進展不得形成自動請求迴圈');
  assert.equal(stalledCalls, 1);
  assert.equal(stalled.hooks.requestNextCatalogBatch({ manual: true }), true, '手動按鈕可明確重試');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stalledCalls, 2);
}

// Catalog positioning measures live scroll geometry, including viewport padding,
// heading/control margins, and removes the currently materialized virtual top spacer.
{
  const runtime = createHarness();
  vm.runInContext('window.__GIA_TEST_HOOKS__.catalogGridOffset = catalogGridOffset;', runtime.context);
  const hooks = runtime.hooks;
  const pages = hooks.elements.pagesContainer;
  const viewport = hooks.elements.readerViewport;
  const cssPixels = (selector, property) => {
    const rule = readerCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] || '';
    const match = rule.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)px`));
    assert.ok(match, `CSS rule ${selector} defines ${property} in px`);
    return Number(match[1]);
  };
  const viewportPadding = cssPixels('\\.reader-overlay\\.mode-catalog \\.reader-viewport', 'padding');
  const headingMargin = cssPixels('\\.reader-catalog-heading', 'margin-bottom');
  const controlMargin = cssPixels('\\.reader-catalog-window-controls', 'margin-bottom');
  const headingHeight = 39;
  const controlsHeight = 47;
  const borderTop = 3;
  const scrollOriginTop = 80;
  const viewportRect = { top: scrollOriginTop };
  const spacer = new FakeElement('div');
  spacer.dataset.catalogSpacer = 'top';
  spacer.style.height = '3456px';
  const heading = new FakeElement('div');
  heading.className = 'reader-catalog-heading';
  heading.offsetHeight = headingHeight;
  const controls = new FakeElement('div');
  controls.className = 'reader-catalog-window-controls';
  controls.offsetHeight = controlsHeight;
  const grid = new FakeElement('div');
  grid.className = 'reader-catalog-grid';
  pages.replaceChildren(heading, controls, spacer, grid);
  viewport.clientTop = borderTop;
  viewport.scrollTop = 137;
  viewport.getBoundingClientRect = () => viewportRect;
  const getGridTop = () => scrollOriginTop + borderTop + viewportPadding
    + headingHeight + headingMargin + controlsHeight + controlMargin
    + Number.parseFloat(spacer.style.height) - viewport.scrollTop;
  grid.getBoundingClientRect = () => ({ top: getGridTop() });

  const expectedBaseOffset = viewportPadding + headingHeight + headingMargin
    + controlsHeight + controlMargin;
  assert.equal(hooks.catalogGridOffset(), expectedBaseOffset,
    'first logical grid row aligns after viewport padding, heading and controls');
  spacer.style.height = '9876px';
  viewport.scrollTop = 321;
  assert.equal(hooks.catalogGridOffset(), expectedBaseOffset,
    'scroll position and the virtual window top spacer do not shift the logical page origin');

  pages.replaceChildren(heading, controls);
  hooks.state.catalogControlOffset = 73;
  viewport.getBoundingClientRect = undefined;
  assert.equal(hooks.catalogGridOffset(), 73,
    'layout-less runtimes keep the existing catalog offset fallback');

  // The cached resize origin must be measured after the newly created grid
  // has entered the DOM, rather than retaining the pre-attachment fallback.
  viewport.getBoundingClientRect = () => viewportRect;
  const createElement = runtime.document.createElement.bind(runtime.document);
  runtime.document.createElement = tag => {
    const node = createElement(tag);
    node.getBoundingClientRect = () => ({ top: scrollOriginTop + borderTop + expectedBaseOffset
      + (Number.parseFloat(pages.querySelector('[data-catalog-spacer="top"]')?.style?.height) || 0)
      - viewport.scrollTop });
    return node;
  };
  hooks.state.currentComic = { id: 'attached-grid-origin' };
  hooks.state.currentComicPages = Array.from({ length: 30 }, (_, index) => `page-${index}`);
  hooks.state.currentPageIndex = 0;
  hooks.state.catalogOpen = true;
  hooks.renderCatalogGrid();
  assert.equal(hooks.state.catalogControlOffset, expectedBaseOffset,
    'resize cache uses the attached grid geometry instead of its old fallback');
}

// 目錄縮圖只保留固定頁窗，避免大本漫畫一次建立數千個節點。
{
  const catalog = createHarness();
  // 以舊 WKWebView fallback 路徑驗證沒有 IntersectionObserver 時仍受併發上限保護。
  catalog.context.IntersectionObserver = undefined;
  catalog.hooks.state.currentComic = { id: 'large-catalog' };
  catalog.hooks.state.currentComicPages = Array.from({ length: 5000 }, (_, index) => `p${index}`);
  catalog.hooks.state.currentPageIndex = 2500;
  catalog.hooks.state.readingMode = 'single';
  catalog.hooks.state.catalogOpen = true;
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
  assert.equal(catalog.hooks.state.catalogWindowStart, 2574, 'catalog next control advances by the actual row capacity');
  const rerenderedControls = catalog.hooks.elements.pagesContainer.children.find(child => child.className === 'reader-catalog-window-controls');
  const focusedNextButton = rerenderedControls.children.find(child => child.dataset.catalogWindowControl === 'next');
  assert.equal(focusedNextButton.focusCalls, 1, 'catalog window navigation restores focus to its replacement control');

  // 捲動跨過批次邊界時只回收離窗節點；重疊頁面的 thumbnail node 與 img 必須保留。
  const currentGrid = catalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const reusedThumb = currentGrid.children.find(child => child.dataset.index === '2660');
  const reusedImage = reusedThumb.children.find(child => child.tagName === 'IMG');
  const evictedThumb = currentGrid.children.find(child => child.dataset.index === '2574');
  catalog.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(2680 / 6) * 194);
  catalog.hooks.renderCatalogGrid({ fromScroll: true });
  const shiftedGrid = catalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  assert.equal(shiftedGrid.children.find(child => child.dataset.index === '2660'), reusedThumb,
    '批次滑動保留重疊 thumbnail identity');
  assert.equal(shiftedGrid.children.find(child => child.dataset.index === '2660')
    .children.find(child => child.tagName === 'IMG'), reusedImage,
    '批次滑動保留重疊 image identity');
  assert.equal(shiftedGrid.children.includes(evictedThumb), false,
    '批次滑動回收離窗 thumbnail');

  catalog.hooks.state.readingMode = 'single';
  catalog.hooks.state.catalogOpen = true;
  catalog.hooks.updateReaderUiControls();
  for (const control of [catalog.hooks.elements.btnFitMode, catalog.hooks.elements.btnRotateLeft, catalog.hooks.elements.btnRotateRight]) {
    assert.equal(control.disabled, true, 'catalog mode disables image transform controls');
    assert.equal(control.getAttribute('aria-disabled'), 'true', 'catalog mode exposes disabled transform state to assistive technology');
  }
}

// 尾批必須在所有欄數與頁數組合下包含最後一頁；非尾批 renderEnd 維持列對齊，
// spacer 加上部分起始列後仍等於完整文件的 totalRows。
for (let columns = 1; columns <= 12; columns += 1) {
  const width = 40 + (130 * columns) + (14 * (columns - 1));
  const catalog = createHarness({ width });
  catalog.context.IntersectionObserver = undefined;
  for (const totalPages of [3016, 5000, 160, 161]) {
    const capacity = Math.max(columns, Math.floor(160 / columns) * columns);
    catalog.hooks.state.currentComic = { id: `tail-${columns}-${totalPages}` };
    catalog.hooks.state.currentComicPages = Array.from({ length: totalPages }, (_, index) => `p${index}`);
    catalog.hooks.state.currentPageIndex = totalPages - 1;
    catalog.hooks.state.catalogWindowStart = 0;
    catalog.hooks.state.catalogWindowEnd = 0;
    catalog.hooks.state.catalogColumns = 0;
    catalog.hooks.state.readingMode = 'single';
  catalog.hooks.state.catalogOpen = true;
    catalog.hooks.renderPages();
    const bounds = catalog.hooks.getCatalogVirtualBounds(totalPages, { preserveWindow: true });
    const grid = catalog.hooks.elements.pagesContainer.children
      .find(child => child.className === 'reader-catalog-grid');
    const first = grid.children[0];
    const last = grid.children.at(-1);
    const expectedStart = Math.max(0, totalPages - capacity);
    assert.equal(catalog.hooks.state.catalogWindowStart, expectedStart,
      `tail window start stays clamped for columns=${columns}, total=${totalPages}`);
    assert.equal(first.dataset.index, String(expectedStart),
      `tail render starts at the full-capacity tail for columns=${columns}, total=${totalPages}`);
    assert.equal(last.dataset.index, String(totalPages - 1),
      `tail render includes final page for columns=${columns}, total=${totalPages}`);
    assert.ok(grid.children.length <= 160,
      `tail DOM stays bounded for columns=${columns}, total=${totalPages}`);
    const topRows = Math.floor(bounds.renderStart / columns);
    const gridRows = Math.ceil(((bounds.renderStart % columns) + (bounds.renderEnd - bounds.renderStart)) / columns);
    const bottomRows = Math.max(0, bounds.totalRows - Math.ceil(bounds.renderEnd / columns));
    assert.equal(topRows + gridRows + bottomRows, bounds.totalRows,
      `tail spacer geometry covers all rows for columns=${columns}, total=${totalPages}`);
    if (bounds.renderEnd !== totalPages) {
      assert.equal(bounds.renderEnd % columns, 0,
        `non-tail renderEnd is row aligned for columns=${columns}, total=${totalPages}`);
    }
  }
}

// incremental fromScroll 進入欄數不整除的尾批時，top spacer 仍必須採完整列高度。
{
  const columns = 5;
  const totalPages = 3016;
  const tail = createHarness({ width: 40 + (130 * columns) + (14 * (columns - 1)) });
  tail.context.IntersectionObserver = undefined;
  tail.hooks.state.currentComic = { id: 'incremental-tail' };
  tail.hooks.state.currentComicPages = Array.from({ length: totalPages }, (_, index) => `p${index}`);
  tail.hooks.state.currentPageIndex = 0;
  tail.hooks.state.readingMode = 'single';
  tail.hooks.state.catalogOpen = true;
  tail.hooks.renderPages();
  tail.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(3000 / columns) * 194);
  tail.hooks.renderCatalogGrid({ fromScroll: true });
  const topSpacer = tail.hooks.elements.pagesContainer.children
    .find(child => child.dataset.catalogSpacer === 'top');
  assert.equal(topSpacer.style.height, `${Math.floor((totalPages - 160) / columns) * 194}px`,
    'incremental tail top spacer uses complete rows');
}

// 初始 catalog window 必須依實際列容量判斷 current page；capacity 邊界附近不得漏目前頁。
for (let columns = 1; columns <= 12; columns += 1) {
  const width = 40 + (130 * columns) + (14 * (columns - 1));
  const capacity = Math.max(columns, Math.floor(160 / columns) * columns);
  const current = createHarness({ width });
  current.context.IntersectionObserver = undefined;
  current.hooks.state.currentComicPages = Array.from({ length: 5000 }, (_, index) => `p${index}`);
  current.hooks.state.currentComic = { id: `current-boundary-${columns}` };
  current.hooks.state.readingMode = 'single';
  current.hooks.state.catalogOpen = true;
  for (const pageIndex of [Math.max(0, capacity - 3), capacity - 2, capacity - 1,
    capacity, capacity + 1, capacity + 2, capacity + 3]) {
    current.hooks.state.currentPageIndex = pageIndex;
    current.hooks.state.catalogWindowStart = 0;
    current.hooks.state.catalogWindowEnd = 0;
    current.hooks.state.catalogColumns = 0;
    current.hooks.renderPages();
    const grid = current.hooks.elements.pagesContainer.children
      .find(child => child.className === 'reader-catalog-grid');
    assert.ok(grid.children.some(child => child.dataset.index === String(pageIndex)),
      `initial window keeps current page for columns=${columns}, index=${pageIndex}`);
  }
}

// 初次跳到長篇尾窗必須同步完成，不能留下會在 resize 後移動 viewport 的動畫。
{
  const entry = createHarness({ width: 800 });
  entry.context.IntersectionObserver = undefined;
  entry.hooks.state.currentComic = { id: 'catalog-entry-race' };
  entry.hooks.state.currentComicPages = Array.from({ length: 5000 }, (_, index) => `p${index}`);
  entry.hooks.state.currentPageIndex = 4999;
  entry.hooks.state.readingMode = 'single';
  entry.hooks.state.catalogOpen = true;
  entry.hooks.renderPages();
  assert.ok(entry.hooks.elements.readerViewport.scrollTop > 1000,
    'catalog entry positions the current page before returning');
  const oldGrid = entry.hooks.elements.pagesContainer.querySelector('.reader-catalog-grid');
  const oldCurrent = oldGrid.querySelector('.catalog-thumb.current');
  let staleScrolls = 0;
  oldCurrent.scrollIntoView = () => { staleScrolls += 1; entry.hooks.elements.readerViewport.scrollTop = 0; };
  entry.context.window.innerWidth = 1440;
  entry.hooks.handleReaderResize();
  entry.clock.tick(0);
  const resizedTop = entry.hooks.elements.readerViewport.scrollTop;
  entry.clock.tick(200);
  assert.equal(staleScrolls, 0, 'detached entry thumbnail cannot run a delayed scroll');
  assert.equal(entry.hooks.elements.readerViewport.scrollTop, resizedTop,
    'entry positioning cannot overwrite the resize anchor');
  assert.ok(resizedTop > 1000, 'tail anchor survives the column change');
}

// resize 只在欄數真的改變時重算；同一 frame 的 5→8→5 與 no-op 不重建 DOM，
// 欄數改變則以目錄可見列作 anchor，currentPageIndex 不得被改寫。
{
  const resize = createHarness({ width: 40 + (130 * 5) + (14 * 4) });
  resize.context.IntersectionObserver = undefined;
  resize.hooks.state.currentComic = { id: 'catalog-resize' };
  resize.hooks.state.currentComicPages = Array.from({ length: 3016 }, (_, index) => `p${index}`);
  resize.hooks.state.currentPageIndex = 17;
  resize.hooks.state.readingMode = 'single';
  resize.hooks.state.catalogOpen = true;
  resize.hooks.renderPages();
  resize.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(1500 / 5) * 194) + 20;
  const beforeResizeGrid = resize.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const beforeGeneration = resize.hooks.getCatalogThumbnailLoadState().generation;
  const originalReplaceChildren = resize.hooks.elements.pagesContainer.replaceChildren.bind(
    resize.hooks.elements.pagesContainer,
  );
  resize.hooks.elements.pagesContainer.replaceChildren = (...children) => {
    originalReplaceChildren(...children);
    // Simulate WKWebView clamping scrollTop while a resize render replaces DOM.
    resize.hooks.elements.readerViewport.scrollTop = 0;
  };

  resize.context.window.innerWidth = 40 + (130 * 8) + (14 * 7);
  resize.hooks.handleReaderResize();
  resize.clock.tick(0);
  assert.equal(resize.hooks.state.catalogColumns, 8, 'resize applies the new catalog columns');
  assert.equal(resize.hooks.state.currentPageIndex, 17, 'resize does not change reader current page');
  assert.ok(resize.hooks.elements.readerViewport.scrollTop > 1000,
    'mid catalog resize preserves a logical visible anchor');
  assert.notEqual(resize.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid'), beforeResizeGrid,
  'column change may rebuild the catalog grid');
  assert.ok(resize.hooks.getCatalogThumbnailLoadState().generation > beforeGeneration,
    'column change resets the thumbnail generation');

  resize.context.window.innerWidth = 40 + (130 * 5) + (14 * 4);
  resize.hooks.handleReaderResize();
  resize.clock.tick(0);
  assert.equal(resize.hooks.state.catalogColumns, 5, 'resize back restores the original columns');
  assert.ok(resize.hooks.elements.readerViewport.scrollTop > 1000,
    'resize back preserves the logical visible anchor');

  const stableGrid = resize.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const stableGeneration = resize.hooks.getCatalogThumbnailLoadState().generation;
  resize.context.window.innerWidth = 40 + (130 * 8) + (14 * 7);
  resize.hooks.handleReaderResize();
  resize.context.window.innerWidth = 40 + (130 * 5) + (14 * 4);
  resize.hooks.handleReaderResize();
  resize.clock.tick(0);
  assert.equal(resize.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid'), stableGrid,
  'rapid same-frame resize coalesces without rebuilding');
  assert.equal(resize.hooks.getCatalogThumbnailLoadState().generation, stableGeneration,
    'rapid same-frame resize does not reset thumbnail loading');

  resize.hooks.handleReaderResize();
  resize.clock.tick(0);
  assert.equal(resize.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid'), stableGrid,
  'no-op resize preserves catalog node identity');
  assert.equal(resize.hooks.getCatalogThumbnailLoadState().generation, stableGeneration,
    'no-op resize does not reset thumbnail loading');

  resize.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(1500 / 5) * 194) + 20;
  resize.hooks.handleCatalogScroll();
  resize.context.window.innerWidth = 40 + (130 * 8) + (14 * 7);
  resize.hooks.handleReaderResize();
  resize.clock.tick(0);
  assert.equal(resize.hooks.state.catalogColumns, 8, 'scroll and resize same frame use resize path');
  assert.ok(resize.hooks.elements.readerViewport.scrollTop > 1000,
    'scroll and resize same frame restore the captured anchor after DOM clamp');
}

// 關閉 reader 後才執行的 resize/scroll RAF 不得搬移下一本漫畫的 catalog viewport。
{
  const stale = createHarness({ width: 40 + (130 * 5) + (14 * 4) });
  stale.context.IntersectionObserver = undefined;
  stale.hooks.state.currentComic = { id: 'stale-old' };
  stale.hooks.state.currentComicPages = Array.from({ length: 3016 }, (_, index) => `old-${index}`);
  stale.hooks.state.currentPageIndex = 0;
  stale.hooks.state.readingMode = 'single';
  stale.hooks.state.catalogOpen = true;
  stale.hooks.renderPages();
  stale.context.window.innerWidth = 40 + (130 * 8) + (14 * 7);
  stale.hooks.handleReaderResize();
  stale.hooks.handleCatalogScroll();
  await stale.hooks.closeReader();

  stale.context.window.innerWidth = 40 + (130 * 5) + (14 * 4);
  stale.hooks.state.currentComic = { id: 'stale-new' };
  stale.hooks.state.currentComicPages = Array.from({ length: 80 }, (_, index) => `new-${index}`);
  stale.hooks.state.currentPageIndex = 0;
  stale.hooks.state.readingMode = 'single';
  stale.hooks.state.catalogOpen = true;
  stale.hooks.renderPages();
  const newGrid = stale.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const newScrollTop = stale.hooks.elements.readerViewport.scrollTop;
  stale.clock.tick(0);
  assert.equal(stale.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid'), newGrid,
  'closed reader cancels stale catalog RAF before reopening');
  assert.equal(stale.hooks.state.catalogColumns, 5, 'stale resize cannot apply old columns to new comic');
  assert.equal(stale.hooks.elements.readerViewport.scrollTop, newScrollTop,
    'stale resize cannot move the new comic viewport');
}

// 前後按鈕依實際列容量接續；實際 click 往返時，所有視窗聯集不得漏頁。
for (let columns = 1; columns <= 12; columns += 1) {
  const width = 40 + (130 * columns) + (14 * (columns - 1));
  for (const totalPages of [3016, 5000, 160, 161]) {
    const catalog = createHarness({ width });
    catalog.context.IntersectionObserver = undefined;
    catalog.hooks.state.currentComic = { id: `buttons-${columns}-${totalPages}` };
    catalog.hooks.state.currentComicPages = Array.from({ length: totalPages }, (_, index) => `p${index}`);
    catalog.hooks.state.currentPageIndex = 0;
    catalog.hooks.state.readingMode = 'single';
  catalog.hooks.state.catalogOpen = true;
    catalog.hooks.renderPages();
    const capacity = Math.max(columns, Math.floor(160 / columns) * columns);
    const forward = [];
    let steps = 0;
    while (steps < 100) {
      const grid = catalog.hooks.elements.pagesContainer.children
        .find(child => child.className === 'reader-catalog-grid');
      const first = Number(grid.children[0].dataset.index);
      const last = Number(grid.children.at(-1).dataset.index);
      forward.push([first, last]);
      const controls = catalog.hooks.elements.pagesContainer.children
        .find(child => child.className === 'reader-catalog-window-controls');
      const previous = controls.children.find(child => child.dataset.catalogWindowControl === 'previous');
      const next = controls.children.find(child => child.dataset.catalogWindowControl === 'next');
      if (steps === 0) assert.equal(previous.disabled, true, 'first catalog window disables previous');
      if (next.disabled) {
        assert.match(next.textContent, new RegExp(String(capacity)), 'next label uses row capacity');
        break;
      }
      next.dispatch('click');
      steps += 1;
    }
    assert.ok(steps < 100, `forward catalog navigation terminates for columns=${columns}, total=${totalPages}`);
    assert.equal(forward[0][0], 0, 'forward navigation starts at page 1');
    assert.equal(forward.at(-1)[1], totalPages - 1, 'forward navigation reaches final page');
    for (let index = 1; index < forward.length; index += 1) {
      assert.ok(forward[index][0] <= forward[index - 1][1] + 1,
        `forward windows have no gap for columns=${columns}, total=${totalPages}`);
    }

    const backward = [];
    steps = 0;
    while (steps < 100) {
      const grid = catalog.hooks.elements.pagesContainer.children
        .find(child => child.className === 'reader-catalog-grid');
      backward.push([Number(grid.children[0].dataset.index), Number(grid.children.at(-1).dataset.index)]);
      const controls = catalog.hooks.elements.pagesContainer.children
        .find(child => child.className === 'reader-catalog-window-controls');
      const previous = controls.children.find(child => child.dataset.catalogWindowControl === 'previous');
      if (previous.disabled) break;
      previous.dispatch('click');
      steps += 1;
    }
    assert.ok(steps < 100, `backward catalog navigation terminates for columns=${columns}, total=${totalPages}`);
    assert.equal(backward.at(-1)[0], 0, 'backward navigation returns to page 1');
    for (let index = 1; index < backward.length; index += 1) {
      assert.ok(backward[index - 1][0] <= backward[index][1] + 1,
        `backward windows have no gap for columns=${columns}, total=${totalPages}`);
    }
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
  const firstFragmentAppendCount = shelf.hooks.elements.comicGrid.fragmentAppendChildCalls;
  const firstObserver = shelf.context.IntersectionObserver.instances.at(-1);
  assert.equal(firstCards.length, 200);

  const appendedComics = [...comics, ...Array.from({ length: 200 }, (_, index) => ({
    id: `shelf-appended-${index}`,
    title: `Shelf appended ${index}`,
    type: 'archive',
    pageCount: 12,
    progress: { currentPage: 0, totalPages: 12 },
  }))];
  shelf.hooks.state.filteredComics = appendedComics;
  shelf.hooks.state.renderLimit = 400;
  shelf.hooks.renderGrid();
  const appendedCards = [...shelf.hooks.elements.comicGrid.children];
  const appendBatchAppendCount = shelf.hooks.elements.comicGrid.appendChildCalls;
  assert.equal(appendedCards.length, 400, 'append-only render adds the next card batch');
  assert.deepEqual(appendedCards.slice(0, 200), firstCards, 'append-only render preserves the existing card prefix');
  assert.equal(shelf.hooks.elements.comicGrid.fragmentAppendChildCalls, firstFragmentAppendCount + 1,
    'append-only render inserts the new suffix with one DocumentFragment');
  shelf.hooks.state.filteredComics = comics;
  shelf.hooks.state.renderLimit = 200;

  shelf.hooks.renderGrid();
  assert.equal(shelf.hooks.elements.comicGrid.appendChildCalls, appendBatchAppendCount, '同順序刷新不重排卡片');

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
  assert.equal(shelf.hooks.elements.comicGrid.replaceChildrenCalls, firstReplaceCount, '單一卡片變更不整批 replaceChildren');
  assert.equal(firstObserver.disconnectCalls, 0, '單一卡片變更不中斷舊封面 observer');

  const updatedAtChanged = changed.map(comic => comic.id === 'shelf-100'
    ? { ...comic, updatedAt: '2026-11-02T12:00:00.000Z' }
    : comic);
  const beforeUpdatedAtCard = changedCards.find(card => card.dataset.comicId === 'shelf-100');
  shelf.hooks.state.filteredComics = updatedAtChanged;
  shelf.hooks.renderGrid();
  const updatedAtCards = [...shelf.hooks.elements.comicGrid.children];
  assert.notEqual(updatedAtCards.find(card => card.dataset.comicId === 'shelf-100'), beforeUpdatedAtCard,
    '同 id 檔案更新時，該書封面卡片必須重新建立');
  assert.equal(updatedAtCards.find(card => card.dataset.comicId === 'shelf-25'), firstCards[25],
    '只有 updatedAt 改變的書受影響，其他卡片仍沿用原節點');
}

// 分幀 append 遇到新的書架快照時必須取消舊工作，不得把舊批次接回新結果；
// 仍要保留目前卡片的焦點與封面 observer。
{
  const cancelled = createHarness();
  const comics = Array.from({ length: 200 }, (_, index) => ({
    id: `cancel-${index}`,
    title: `Cancel ${index}`,
    type: 'archive',
    pageCount: 12,
  }));
  const appended = [...comics, ...Array.from({ length: 200 }, (_, index) => ({
    id: `cancel-appended-${index}`,
    title: `Cancel appended ${index}`,
    type: 'archive',
    pageCount: 12,
  }))];
  cancelled.hooks.state.filteredComics = comics;
  cancelled.hooks.state.renderLimit = 200;
  cancelled.hooks.elements.contentArea = new FakeElement();
  cancelled.hooks.renderGrid();
  const initialCards = [...cancelled.hooks.elements.comicGrid.children];
  const observer = cancelled.context.IntersectionObserver.instances.at(-1);
  cancelled.document.activeElement = initialCards[25];

  cancelled.hooks.state.filteredComics = appended;
  assert.equal(cancelled.hooks.requestNextCatalogBatch(), true);
  assert.equal(cancelled.hooks.state.renderLimit, 200, '分幀工作尚未同步擴張 renderLimit');

  const replacement = comics.map(comic => ({ ...comic, title: `${comic.title} replacement` }));
  cancelled.hooks.state.filteredComics = replacement;
  cancelled.hooks.renderGrid();
  cancelled.clock.tick(0);
  assert.equal(cancelled.hooks.state.renderLimit, 200, '新快照會取消舊 append target');
  assert.equal(cancelled.hooks.elements.comicGrid.children.length, 200, '舊批次不可混入新快照');
  assert.equal(cancelled.hooks.elements.comicGrid.children[0].dataset.renderKey.includes('replacement'), true);
  assert.equal(observer.disconnectCalls, 0, '取消分幀工作不應中斷封面 observer');
}

// 虛擬資料夾的封面版本必須跟隨選中的 coverComicId；封面書更新時只重建對應資料夾。
{
  const shelf = createHarness();
  shelf.hooks.elements.searchInput.value = '';
  shelf.hooks.state.activeSeries = 'all';
  shelf.hooks.state.activeFilter = 'all';
  shelf.hooks.state.currentPath = '';
  shelf.hooks.state.comics = [
    {
      id: 'folder-a-cover', title: 'A cover', relativePath: 'Series A/cover.cbz',
      sourceId: 'local:test', updatedAt: '2026-11-01T00:00:00.000Z', pageCount: 3,
    },
    {
      id: 'folder-b-cover', title: 'B cover', relativePath: 'Series B/cover.cbz',
      sourceId: 'local:test', updatedAt: '2026-11-01T00:00:00.000Z', pageCount: 3,
    },
  ];
  shelf.hooks.state.filteredComics = shelf.hooks.getDirectoryItems();
  shelf.hooks.renderGrid();
  const firstCards = new Map([...shelf.hooks.elements.comicGrid.children]
    .map(card => [card.dataset.comicId, card]));
  const firstFolders = new Map(shelf.hooks.state.filteredComics
    .filter(item => item.isDirectory)
    .map(item => [item.relativePath, item]));
  assert.equal(firstFolders.get('Series A').coverUpdatedAt, '2026-11-01T00:00:00.000Z');

  shelf.hooks.state.comics = shelf.hooks.state.comics.map(comic => comic.id === 'folder-a-cover'
    ? { ...comic, updatedAt: '2026-11-02T12:00:00.000Z' }
    : comic);
  shelf.hooks.state.filteredComics = shelf.hooks.getDirectoryItems();
  shelf.hooks.renderGrid();
  const updatedCards = new Map([...shelf.hooks.elements.comicGrid.children]
    .map(card => [card.dataset.comicId, card]));
  const updatedFolders = new Map(shelf.hooks.state.filteredComics
    .filter(item => item.isDirectory)
    .map(item => [item.relativePath, item]));
  assert.equal(updatedFolders.get('Series A').coverUpdatedAt, '2026-11-02T12:00:00.000Z');
  assert.notEqual(updatedCards.get(firstFolders.get('Series A').id), firstCards.get(firstFolders.get('Series A').id),
    '封面書 updatedAt 改變時，對應虛擬資料夾必須重新建立');
  assert.equal(updatedCards.get(firstFolders.get('Series B').id), firstCards.get(firstFolders.get('Series B').id),
    '其他虛擬資料夾仍沿用原節點');
}

// merged root 可同時保留相同 id 的在線／離線來源；refresh、selection 與焦點都必須以 sourceId + id 辨識。
{
  const collision = createHarness();
  const offline = {
    id: 'same-runtime-id',
    title: '離線副本',
    relativePath: 'offline/book.cbz',
    sourceId: 'smb:offline',
    type: 'offline',
    pageCount: 12,
    progress: { currentPage: 0, totalPages: 12 },
  };
  const online = {
    id: 'same-runtime-id',
    title: '在線副本',
    relativePath: 'online/book.cbz',
    sourceId: 'local:online',
    type: 'archive',
    pageCount: 12,
    progress: { currentPage: 0, totalPages: 12 },
  };
  collision.hooks.state.comics = [offline, online];
  collision.hooks.state.filteredComics = [offline, online];
  collision.hooks.elements.contentArea = new FakeElement();
  collision.hooks.renderGrid();
  const firstCards = new Map([...collision.hooks.elements.comicGrid.children]
    .map(card => [card.dataset.sourceId, card]));
  assert.equal(firstCards.size, 2, '同 id 不同 source 必須保留兩張書卡');
  assert.equal(firstCards.get('smb:offline').dataset.comicId, offline.id);
  assert.equal(firstCards.get('local:online').dataset.comicId, online.id);

  collision.hooks.activateGridComic(online);
  assert.equal(collision.hooks.state.selectedComicId, online.id);
  assert.equal(collision.hooks.state.selectedComicSourceId, online.sourceId,
    'Inspector selection 必須同步保存在線 sourceId');
  collision.document.activeElement = firstCards.get(online.sourceId);
  collision.hooks.state.filteredComics = [online, offline];
  collision.hooks.renderGrid({ background: true });
  const refreshedCards = new Map([...collision.hooks.elements.comicGrid.children]
    .map(card => [card.dataset.sourceId, card]));
  assert.equal(refreshedCards.get(online.sourceId), firstCards.get(online.sourceId),
    '在線卡片 refresh 後沿用原節點');
  assert.equal(refreshedCards.get(offline.sourceId), firstCards.get(offline.sourceId),
    '離線卡片 refresh 後沿用原節點');
  assert.equal(refreshedCards.get(online.sourceId).classList.contains('selected'), true,
    '焦點／選取仍指向在線 source');
  assert.equal(refreshedCards.get(offline.sourceId).classList.contains('selected'), false,
    '離線同 id 卡片不可誤套在線選取狀態');
  assert.equal(collision.document.activeElement, firstCards.get(online.sourceId),
    '同 id 不同 source 的 focus refresh 後不應跳到另一來源');

  let recoveryPrompts = 0;
  collision.context.window.confirm = () => { recoveryPrompts += 1; return false; };
  await collision.hooks.openReader(offline);
  assert.equal(recoveryPrompts, 1, '離線來源仍走各自的來源復原流程');
  assert.equal(collision.hooks.state.selectedComicSourceId, online.sourceId,
    '離線復原提示不可污染目前在線 Inspector selection');
}

// Native organizer commands still receive id-only payloads.  If the same id
// is visible from multiple roots, refuse selection and batch mutation instead
// of risking a write to the wrong source.
{
  const organizer = createHarness();
  for (const id of ['organizeTag', 'organizeAuthor', 'organizeSeries', 'organizeLanguage', 'organizeDirection']) {
    organizer.hooks.elements[id].value = '';
  }
  const offline = { id: 'organizer-collision', title: '離線', sourceId: 'smb:offline', relativePath: 'offline/book.cbz' };
  const online = { id: 'organizer-collision', title: '在線', sourceId: 'local:online', relativePath: 'online/book.cbz' };
  organizer.hooks.state.comics = [offline, online];
  organizer.hooks.toggleOrganizerSelection(online);
  assert.equal(organizer.hooks.state.organizeSelection.size, 0, '同 id 多來源不可建立無法表達 source 的選取');
  assert.match(organizer.hooks.elements.organizeStatus.textContent, /多個來源/);
  let batchCalls = 0;
  organizer.context.window.electronAPI.applyBatchMetadata = async () => { batchCalls += 1; return { updated: 1 }; };
  organizer.hooks.state.organizeSelection.add(offline.id);
  await organizer.hooks.applyOrganizerBatch('include');
  assert.equal(batchCalls, 0, '既有歧義選取也必須在 native 呼叫前 fail closed');
  assert.match(organizer.hooks.elements.organizeStatus.textContent, /避免誤改/);
}

// Large selections resolve through one library-wide identity index while
// retaining source ambiguity and same-source duplicate protection.
{
  const organizer = createHarness();
  const scale = 4000;
  const comics = Array.from({ length: scale }, (_, index) => ({
    id: `organizer-scale-${index}`,
    sourceId: index % 2 ? 'smb:library' : 'local:library',
    relativePath: `books/${index}.cbz`,
  }));
  organizer.hooks.state.comics = comics;
  organizer.hooks.state.organizeSelection = new Set(comics.map(comic => comic.id));
  organizer.hooks.state.organizeSelectionSources = new Map(comics.map(comic => [comic.id, comic.sourceId]));
  const resolved = organizer.hooks.resolveOrganizerSelection();
  assert.equal(resolved.ambiguous.length, 0, 'large unique selection remains source-safe');
  assert.equal(resolved.selected.length, scale, 'large selection resolves every selected comic');
  assert.equal(resolved.selected[3999].relativePath, 'books/3999.cbz');

  const sameSourceA = { id: 'organizer-same-source', sourceId: 'local:library', relativePath: 'books/a.cbz' };
  const sameSourceB = { id: 'organizer-same-source', sourceId: 'local:library', relativePath: 'books/b.cbz' };
  const otherSource = { id: 'organizer-other-source', sourceId: 'smb:library', relativePath: 'books/c.cbz' };
  organizer.hooks.state.comics = [sameSourceA, sameSourceB, otherSource];
  organizer.hooks.state.organizeSelection = new Set([sameSourceA.id, otherSource.id]);
  organizer.hooks.state.organizeSelectionSources = new Map([
    [sameSourceA.id, sameSourceA.sourceId],
    [otherSource.id, otherSource.sourceId],
  ]);
  const collision = organizer.hooks.resolveOrganizerSelection();
  assert.deepEqual([...collision.ambiguous], [sameSourceA.id], 'duplicate locations in one source remain ambiguous');
  assert.equal(collision.selected.length, 1, 'unrelated unique source remains selectable beside collision');
  assert.equal(collision.selected[0].id, otherSource.id);
  assert.equal(collision.selected[0].relativePath, otherSource.relativePath);
  assert.equal(organizer.hooks.isOrganizerIdentitySafe(sameSourceA), false,
    'duplicate locations in one source cannot enter organizer selection');

  const missingSource = { id: 'organizer-missing-source', relativePath: 'books/missing-source.cbz' };
  organizer.hooks.state.comics = [missingSource];
  organizer.hooks.state.organizeSelection = new Set([missingSource.id]);
  organizer.hooks.state.organizeSelectionSources = new Map([[missingSource.id, '']]);
  const missingSourceResolution = organizer.hooks.resolveOrganizerSelection();
  assert.deepEqual([...missingSourceResolution.ambiguous], [missingSource.id], 'missing source must fail closed');
  assert.equal(organizer.hooks.isOrganizerIdentitySafe(missingSource), false, 'missing source cannot enter organizer selection');

  const missingPath = { id: 'organizer-missing-path', sourceId: 'local:library' };
  organizer.hooks.state.comics = [missingPath];
  organizer.hooks.state.organizeSelection = new Set([missingPath.id]);
  organizer.hooks.state.organizeSelectionSources = new Map([[missingPath.id, missingPath.sourceId]]);
  const missingPathResolution = organizer.hooks.resolveOrganizerSelection();
  assert.deepEqual([...missingPathResolution.ambiguous], [missingPath.id], 'missing path must fail closed');
  assert.equal(organizer.hooks.isOrganizerIdentitySafe(missingPath), false, 'missing path cannot enter organizer selection');

  const noSelectedSource = { id: 'organizer-no-selected-source', sourceId: 'local:library', relativePath: 'books/no-source-selection.cbz' };
  organizer.hooks.state.comics = [noSelectedSource];
  organizer.hooks.state.organizeSelection = new Set([noSelectedSource.id]);
  organizer.hooks.state.organizeSelectionSources = new Map();
  const noSelectedSourceResolution = organizer.hooks.resolveOrganizerSelection();
  assert.deepEqual([...noSelectedSourceResolution.ambiguous], [noSelectedSource.id], 'missing selected source must not guess the first match');
}

// Organizer requests carry the selected source and path. If source A vanishes
// before a later apply, the saved source identity must not fall through to B.
{
  const race = createHarness();
  for (const id of ['organizeTag', 'organizeAuthor', 'organizeLanguage', 'organizeDirection']) {
    race.hooks.elements[id].value = '';
  }
  race.hooks.elements.organizeSeries.value = 'Stable series';
  const sourceA = { id: 'organizer-race', title: 'A', sourceId: 'local:A', relativePath: 'a/book.cbz' };
  const sourceB = { id: 'organizer-race', title: 'B', sourceId: 'smb:B', relativePath: 'b/book.cbz' };
  race.hooks.state.comics = [sourceA];
  race.hooks.state.filteredComics = [sourceA];
  race.hooks.toggleOrganizerSelection(sourceA);
  let applyCalls = 0;
  let request;
  race.context.window.electronAPI.applyBatchMetadata = async payload => {
    applyCalls += 1;
    request = payload;
    return { updated: 1, undoToken: 'undo-race' };
  };
  await race.hooks.applyOrganizerBatch('include');
  assert.equal(applyCalls, 1, 'unique organizer selection remains usable');
  assert.equal(request.targets.length, 1);
  assert.equal(request.targets[0].runtimeId, 'organizer-race');
  assert.equal(request.targets[0].sourceId, 'local:A');
  assert.equal(request.targets[0].relativePath, 'a/book.cbz', 'organizer request must include source-qualified runtime target');
  race.hooks.state.comics = [sourceB];
  await race.hooks.applyOrganizerBatch('include');
  assert.equal(applyCalls, 1, 'removed source must not be applied to replacement source');
  assert.match(race.hooks.elements.organizeStatus.textContent, /多個來源|避免誤改/);
}

// 已選取的唯一 id 在背景掃描帶入第二來源後，也要立即撤銷 UI 選取。
{
  const refreshed = createHarness();
  for (const id of ['organizeTag', 'organizeAuthor', 'organizeSeries', 'organizeLanguage', 'organizeDirection']) {
    refreshed.hooks.elements[id].value = '';
  }
  const online = { id: 'late-organizer-collision', title: '在線', sourceId: 'local:online', relativePath: 'online/book.cbz' };
  const offline = { id: 'late-organizer-collision', title: '離線', sourceId: 'smb:offline', relativePath: 'offline/book.cbz' };
  refreshed.hooks.state.organizeMode = true;
  refreshed.hooks.state.comics = [online];
  refreshed.hooks.state.filteredComics = [online];
  refreshed.hooks.state.organizeSelection.add(online.id);
  refreshed.hooks.renderGrid();
  assert.equal(refreshed.hooks.elements.comicGrid.children[0].classList.contains('organize-selected'), true);
  refreshed.hooks.state.scanStatus = { generation: 77, isScanning: true };
  refreshed.hooks.applyIncrementalLibraryBatch({ generation: 77, items: [offline], found: 2 });
  assert.equal(refreshed.hooks.state.organizeSelection.has(online.id), false,
    '背景 merge 產生來源衝突時會移除不安全 organizer selection');
  assert.match(refreshed.hooks.elements.organizeStatus.textContent, /多個來源/);
  refreshed.hooks.state.filteredComics = [online, offline];
  refreshed.hooks.renderGrid();
  assert.equal([...refreshed.hooks.elements.comicGrid.children]
    .some(card => card.classList.contains('organize-selected')), false,
  '來源衝突後兩張卡都不可顯示假選取');
}

// 目錄快速切窗時，舊世代仍在解碼的 8 張圖不能占住新世代的併發槽位；
// 舊 load 回來也不得扣掉新世代計數。
{
  const slowCatalog = createHarness();
  slowCatalog.context.IntersectionObserver = undefined;
  slowCatalog.hooks.state.currentComic = { id: 'slow-catalog' };
  slowCatalog.hooks.state.currentComicPages = Array.from({ length: 320 }, (_, index) => `slow-${index}`);
  slowCatalog.hooks.state.currentPageIndex = 0;
  slowCatalog.hooks.state.readingMode = 'single';
  slowCatalog.hooks.state.catalogOpen = true;
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

// 快速 fling 直接跳到不重疊尾窗時，必須先 detach 整批舊節點再取消 task；
// 否則 active task 的同步 cancel callback 會先 pump 舊 queue，餓死新尾窗。
{
  const flingCatalog = createHarness({ width: 1000 });
  flingCatalog.context.IntersectionObserver = undefined;
  flingCatalog.hooks.state.currentComic = { id: 'fling-catalog' };
  flingCatalog.hooks.state.currentComicPages = Array.from({ length: 500 }, (_, index) => `fling-${index}`);
  flingCatalog.hooks.state.currentPageIndex = 0;
  flingCatalog.hooks.state.readingMode = 'single';
  flingCatalog.hooks.state.catalogOpen = true;
  flingCatalog.hooks.renderPages();
  const firstGrid = flingCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const oldActiveImage = firstGrid.children[0].children.find(child => child.tagName === 'IMG');
  const oldQueuedThumb = firstGrid.children[8];
  const oldQueuedImage = oldQueuedThumb.children.find(child => child.tagName === 'IMG');
  const oldQueuedSource = oldQueuedImage.dataset.src;
  assert.equal(oldActiveImage.loading, 'eager', 'catalog queue owns lazy scheduling');
  assert.equal(flingCatalog.hooks.getCatalogThumbnailLoadState().active, 8);
  assert.equal(oldQueuedImage.isConnected, true);
  assert.equal(oldQueuedImage.dataset.catalogLoadQueued, 'true');

  // 模擬一口氣滑到底，使用 incremental patch 路徑而非整批 reset。
  flingCatalog.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(490 / 6) * 194);
  flingCatalog.hooks.renderCatalogGrid({ fromScroll: true });
  const tailGrid = flingCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  assert.equal(tailGrid.children[0].dataset.index, '344', 'fling 直接落在正確尾窗');
  assert.equal(tailGrid.children.at(-1).dataset.index, '499');
  assert.equal(oldQueuedThumb.isConnected, false, '舊 queued thumbnail 先 detach');
  assert.equal(oldQueuedImage.dataset.catalogLoadQueued, undefined, '舊 queued task 已移除');
  assert.equal(oldQueuedImage.dataset.src, oldQueuedSource, '舊 queued image 未曾被 pump 啟動');
  assert.equal(oldActiveImage.src, '', '舊 active image 已取消');
  assert.equal(flingCatalog.hooks.getCatalogThumbnailLoadState().active, 8,
    '新尾窗補滿併發槽位');
  assert.ok(tailGrid.children.slice(0, 8).every(thumb => thumb.children[0].src.includes('fling-')),
    '新尾窗優先開始載入');
  oldActiveImage.dispatch('load');
  assert.equal(flingCatalog.hooks.getCatalogThumbnailLoadState().active, 8,
    '舊 active late callback 不污染新尾窗');
}

// IntersectionObserver 在 detach 後仍可能送出已排程的 late entry；不可讓它把舊圖重新放回 queue。
{
  const observerCatalog = createHarness({ width: 1000 });
  observerCatalog.hooks.state.currentComic = { id: 'observer-fling-catalog' };
  observerCatalog.hooks.state.currentComicPages = Array.from({ length: 500 }, (_, index) => `observer-${index}`);
  observerCatalog.hooks.state.currentPageIndex = 0;
  observerCatalog.hooks.state.readingMode = 'single';
  observerCatalog.hooks.state.catalogOpen = true;
  observerCatalog.hooks.renderPages();
  const observer = observerCatalog.context.IntersectionObserver.instances.at(-1);
  const firstGrid = observerCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const oldQueuedImage = firstGrid.children[8].children.find(child => child.tagName === 'IMG');
  const oldSource = oldQueuedImage.dataset.src;
  observer.callback(firstGrid.children.slice(0, 8).map(thumb => ({
    isIntersecting: true,
    target: thumb.children.find(child => child.tagName === 'IMG'),
  })));
  assert.equal(observerCatalog.hooks.getCatalogThumbnailLoadState().active, 8);
  observerCatalog.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(490 / 6) * 194);
  observerCatalog.hooks.renderCatalogGrid({ fromScroll: true });
  assert.equal(oldQueuedImage.isConnected, false);
  observer.callback([{ isIntersecting: true, target: oldQueuedImage }]);
  assert.equal(oldQueuedImage.dataset.src, oldSource, 'late entry 不會啟動 detached 舊圖');
  assert.equal(oldQueuedImage.dataset.catalogLoadQueued, undefined, 'late entry 不會留下 stale queue flag');
  const tailGrid = observerCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  observer.callback(tailGrid.children.map(thumb => ({
    isIntersecting: true,
    target: thumb.children.find(child => child.tagName === 'IMG'),
  })));
  assert.equal(observerCatalog.hooks.getCatalogThumbnailLoadState().active, 8,
    '尾窗 entry 只啟動尾部圖片並填滿併發額度');
  tailGrid.children[0].children.find(child => child.tagName === 'IMG').dispatch('load');
  assert.equal(observerCatalog.hooks.getCatalogThumbnailLoadState().active, 8,
    '尾窗 load 後會繼續補下一張 queued 圖');
}

// overlap 窗若剛好讓舊 8 active 全部離窗，保留區 queued task 沒有新的 IO entry
// 也必須由 patch 完成後主動補泵，不能停在 active=0。
{
  const overlapCatalog = createHarness({ width: 1000 });
  overlapCatalog.hooks.state.currentComic = { id: 'observer-overlap-catalog' };
  overlapCatalog.hooks.state.currentComicPages = Array.from({ length: 500 }, (_, index) => `overlap-${index}`);
  overlapCatalog.hooks.state.currentPageIndex = 0;
  overlapCatalog.hooks.state.readingMode = 'single';
  overlapCatalog.hooks.state.catalogOpen = true;
  overlapCatalog.hooks.renderPages();
  const observer = overlapCatalog.context.IntersectionObserver.instances.at(-1);
  const firstGrid = overlapCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  observer.callback(firstGrid.children.map(thumb => ({
    isIntersecting: true,
    target: thumb.children.find(child => child.tagName === 'IMG'),
  })));
  assert.equal(overlapCatalog.hooks.getCatalogThumbnailLoadState().active, 8);
  overlapCatalog.hooks.elements.readerViewport.scrollTop = 60 + (Math.floor(100 / 6) * 194);
  overlapCatalog.hooks.renderCatalogGrid({ fromScroll: true });
  const overlapGrid = overlapCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  assert.equal(overlapGrid.children[0].dataset.index, '78', 'overlap scroll 只平移到下一批');
  assert.equal(overlapCatalog.hooks.getCatalogThumbnailLoadState().active, 8,
    '舊 active 離窗後仍立即補滿保留 queue');
}

// closeReader 在 detach 前必須清空 catalog observer、queue 與 active task；
// 舊圖片晚回呼也不得污染重新開啟的漫畫世代。
{
  const closingCatalog = createHarness();
  closingCatalog.hooks.state.currentComic = { id: 'closing-catalog' };
  closingCatalog.hooks.state.currentComicPages = Array.from({ length: 320 }, (_, index) => `closing-${index}`);
  closingCatalog.hooks.state.currentPageIndex = 0;
  closingCatalog.hooks.state.readingMode = 'single';
  closingCatalog.hooks.state.catalogOpen = true;
  closingCatalog.hooks.renderPages();
  const closingGrid = closingCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const lateImage = closingGrid.children[0].children.find(child => child.tagName === 'IMG');
  const observer = closingCatalog.context.IntersectionObserver.instances.at(-1);
  observer.callback([{ isIntersecting: true, target: lateImage }]);
  assert.equal(closingCatalog.hooks.getCatalogThumbnailLoadState().active, 1);
  assert.equal(closingCatalog.hooks.getCatalogThumbnailLoadState().observerConnected, true);
  await closingCatalog.hooks.closeReader();
  const closedState = closingCatalog.hooks.getCatalogThumbnailLoadState();
  assert.equal(closedState.active, 0, 'close clears active catalog image tasks');
  assert.equal(closedState.queued, 0, 'close clears queued catalog images');
  assert.equal(closedState.tasks, 0, 'close clears catalog task set');
  assert.equal(closedState.observerConnected, false, 'close disconnects catalog observer');
  lateImage.dispatch('load');

  closingCatalog.hooks.state.currentComic = { id: 'reopened-catalog' };
  closingCatalog.hooks.state.currentComicPages = Array.from({ length: 12 }, (_, index) => `reopened-${index}`);
  closingCatalog.hooks.state.currentPageIndex = 0;
  closingCatalog.hooks.state.readingMode = 'single';
  closingCatalog.hooks.state.catalogOpen = true;
  closingCatalog.hooks.renderPages();
  assert.equal(closingCatalog.hooks.state.currentComic.id, 'reopened-catalog');
  assert.equal(closingCatalog.hooks.getCatalogThumbnailLoadState().active, 0,
    'late closed callback cannot occupy reopened generation');
  closingCatalog.hooks.state.readingMode = 'single';
  closingCatalog.hooks.state.catalogOpen = false;
  closingCatalog.hooks.renderPages();
  const switchedState = closingCatalog.hooks.getCatalogThumbnailLoadState();
  assert.equal(switchedState.active, 0, 'leaving catalog clears active image tasks');
  assert.equal(switchedState.queued, 0, 'leaving catalog clears queued images');
  assert.equal(switchedState.tasks, 0, 'leaving catalog clears task set');
  assert.equal(switchedState.observerConnected, false, 'leaving catalog disconnects observer');
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

// PhotoKit 的 photos／photos:... 是虛擬來源；navigate/close 回到相簿根目錄時
// 不得呼叫 filesystem visible scan，也不得把上一次錯誤留在 UI。
{
  const photoNavigation = createHarness();
  const scanCalls = [];
  photoNavigation.context.window.electronAPI.scanVisibleDirectory = (path, sourceId) => {
    scanCalls.push({ path, sourceId });
    return Promise.resolve();
  };
  vm.runInContext('filterAndRenderGrid = () => {}; renderSidebar = () => {}', photoNavigation.context);
  for (const sourceId of ['photos:', 'photos:album-a', 'photos', 'builtin:landscapes']) {
    photoNavigation.hooks.elements.visibleScanStatus.hidden = false;
    photoNavigation.hooks.elements.visibleScanStatus.textContent = '舊的 filesystem 錯誤';
    await photoNavigation.hooks.requestVisibleDirectoryScan('相簿', { sourceId });
    assert.equal(photoNavigation.hooks.elements.visibleScanStatus.textContent, '',
      `PhotoKit source ${sourceId} clears stale visible scan status`);
    assert.equal(photoNavigation.hooks.elements.visibleScanStatus.hidden, true,
      `PhotoKit source ${sourceId} hides visible scan status`);
  }
  assert.deepEqual(scanCalls, [], 'PhotoKit sources never call filesystem visible scan');

  photoNavigation.hooks.navigateLibraryToPath('相簿', 'photos:album-a');
  await Promise.resolve();
  assert.deepEqual(scanCalls, [], 'PhotoKit navigation does not schedule filesystem scan');
  photoNavigation.hooks.state.currentComic = { id: 'photos:album-a' };
  photoNavigation.hooks.state.currentComicPages = [];
  photoNavigation.hooks.state.readingMode = 'single';
  photoNavigation.hooks.state.readerReturnComicFolder = photoNavigation.hooks.createDirectoryLocation('photos:', '');
  await photoNavigation.hooks.closeReader();
  assert.deepEqual(scanCalls, [], 'closing a PhotoKit reader does not scan its virtual folder');

  for (const sourceId of ['local:library', 'smb', 'external:bookmark']) {
    await photoNavigation.hooks.requestVisibleDirectoryScan('漫畫', { sourceId });
  }
  assert.deepEqual(scanCalls, [
    { path: '漫畫', sourceId: 'local:library' },
    { path: '漫畫', sourceId: 'smb' },
    { path: '漫畫', sourceId: 'external:bookmark' },
  ], 'local, SMB and external sources keep visible scan calls');
}

// catalog-thumb 的 pointerup 不得觸發閱讀器中間 tap／左右翻頁；原生 click
// 與 Enter/Space 仍由 thumbnail 自己跳到對應頁面。
{
  const pointerCatalog = createHarness();
  pointerCatalog.hooks.elements.readerOverlay.style.display = 'flex';
  pointerCatalog.hooks.elements.readerOverlay.classList.add('reader-idle');
  pointerCatalog.hooks.state.readingMode = 'single';
  pointerCatalog.hooks.state.catalogOpen = true;
  const thumbTarget = new FakeElement('div');
  thumbTarget.classList.add('catalog-thumb');
  const eventTarget = { closest: selector => selector.includes('.catalog-thumb') ? thumbTarget : null };
  const mousemoveStart = appSource.indexOf("  elements.readerOverlay.addEventListener('mousemove', (e) => {");
  const mousemoveEnd = appSource.indexOf('  let touchStartX = 0;', mousemoveStart);
  assert.ok(mousemoveStart >= 0 && mousemoveEnd > mousemoveStart);
  vm.runInContext(`{ let readerTouchActive = false; ${appSource.slice(mousemoveStart, mousemoveEnd)} }`,
    pointerCatalog.context);
  const hover = pointerCatalog.hooks.elements.readerOverlay.listeners.get('mousemove')[0].handler;
  hover({ buttons: 0, clientY: 760, target: eventTarget });
  assert.equal(pointerCatalog.hooks.elements.readerOverlay.classList.contains('reader-idle'), true,
    'WebKit compatibility mousemove over an edge thumbnail does not reveal covering chrome');
  pointerCatalog.document.elementFromPoint = () => eventTarget;
  const retargeted = { buttons: 0, clientX: 410, clientY: 760, target: { closest: () => null } };
  hover(retargeted);
  assert.equal(pointerCatalog.hooks.elements.readerOverlay.classList.contains('reader-idle'), true,
    'retargeted compatibility mousemove uses the actual thumbnail under the pointer');
  pointerCatalog.hooks.handleReaderPointerClick({ ...retargeted, button: 0 });
  assert.equal(pointerCatalog.hooks.elements.readerOverlay.classList.contains('reader-idle'), true,
    'retargeted pointerup on a thumbnail preserves the native click target');
  delete pointerCatalog.document.elementFromPoint;
  hover({ buttons: 0, clientY: 760, target: { closest: () => null } });
  assert.equal(pointerCatalog.hooks.elements.readerOverlay.classList.contains('reader-idle'), false,
    'mousemove on the empty reader edge still reveals controls');
  pointerCatalog.hooks.elements.readerOverlay.classList.add('reader-idle');
  for (const bar of ['readerTopBar', 'readerBottomBar']) {
    const leaveSection = appSource.match(new RegExp(`elements\\.${bar}\\.addEventListener\\('mouseleave', \\(\\) => \\{[\\s\\S]*?\\n  \\}\\);`));
    assert.ok(leaveSection, `${bar} leave listener exists`);
    vm.runInContext(leaveSection[0], pointerCatalog.context);
    const leave = pointerCatalog.hooks.elements[bar].listeners.get('mouseleave')[0].handler;
    leave();
    assert.equal(pointerCatalog.hooks.elements.readerOverlay.classList.contains('reader-idle'), true,
      `${bar} late leave cannot revive hidden chrome`);
  }
  pointerCatalog.hooks.handleReaderPointerClick({
    button: 0,
    clientX: 410,
    target: eventTarget,
  });
  assert.equal(pointerCatalog.hooks.elements.readerOverlay.classList.contains('reader-idle'), true,
    'catalog pointerup does not toggle reader chrome');

  pointerCatalog.hooks.state.currentComic = { id: 'catalog-pointer' };
  pointerCatalog.hooks.state.currentComicPages = Array.from({ length: 12 }, (_, index) => `p${index}`);
  pointerCatalog.hooks.state.currentPageIndex = 0;
  pointerCatalog.hooks.state.readingMode = 'single';
  pointerCatalog.hooks.state.catalogOpen = true;
  pointerCatalog.hooks.renderPages();
  const grid = pointerCatalog.hooks.elements.pagesContainer.children
    .find(child => child.className === 'reader-catalog-grid');
  const thumb = grid.children[5];
  assert.equal(typeof thumb.onclick, 'function', 'catalog click handler remains installed');
  assert.equal(typeof thumb.onkeydown, 'function', 'catalog keyboard handler remains installed');
  thumb.onclick();
  assert.equal(pointerCatalog.hooks.state.currentPageIndex, 5, 'thumbnail click opens its own page');
  assert.equal(pointerCatalog.hooks.state.readingMode, 'single', 'thumbnail click preserves the underlying reader mode');
  assert.equal(pointerCatalog.hooks.state.catalogOpen, false, 'thumbnail click closes the overview');
  for (const key of ['Enter', ' ']) {
    pointerCatalog.hooks.state.currentPageIndex = 0;
    pointerCatalog.hooks.state.catalogOpen = true;
    pointerCatalog.hooks.renderPages();
    const freshGrid = pointerCatalog.hooks.elements.pagesContainer.children
      .find(child => child.className === 'reader-catalog-grid');
    const freshThumb = freshGrid.children[5];
    freshThumb.onkeydown({ target: freshThumb, key, preventDefault() {}, stopPropagation() {} });
    assert.equal(pointerCatalog.hooks.state.currentPageIndex, 5, 'keyboard activation opens the same page');
    assert.equal(pointerCatalog.hooks.state.catalogOpen, false, `${key} closes the overview`);
    assert.equal(pointerCatalog.hooks.state.readingMode, 'single', `${key} keeps the reader mode`);
  }
}

// 一般漫畫第一次只開詳情，收合後第二次仍開啟原書，而非被抽屜狀態重置選取。
{
  const selection = createHarness({ width: 820 });
  vm.runInContext(`
    syncLibraryPanelsForViewport({ initial: true });
    window.readerOpens = [];
    openReader = comic => window.readerOpens.push(comic.id || comic);
    renderComicInspector = comic => { state.selectedComicId = comic.id; state.selectedComicSourceId = comic.sourceId || ''; };
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
  assert.deepEqual(Array.from(selection.context.window.readerOpens), ['normal-book', 'builtin:landscape-mountains'], '示範卡第一次直接開始試讀');
  vm.runInContext('activateGridComic(previewComic);', selection.context);
  assert.deepEqual(Array.from(selection.context.window.readerOpens), ['normal-book', 'builtin:landscape-mountains', 'builtin:landscape-mountains'], '再次操作示範仍直接開啟');
}

// 首頁與設定共用 chooser single-flight，涵蓋忙碌、取消、成功、失敗及解除鎖定。
{
  const h = createHarness();
  const { elements } = h.hooks;
  let resolvePicker;
  let pickerCalls = 0;
  h.context.navigator.userAgent = 'Macintosh';
  elements.scanDirInput.value = '';
  h.context.window.electronAPI.openFolderDialog = () => {
    pickerCalls += 1;
    return new Promise(resolve => { resolvePicker = resolve; });
  };
  const first = h.hooks.chooseLibrarySource();
  assert.equal(elements.librarySourceBtn.disabled, true);
  assert.equal(elements.libraryStartChoose.disabled, true);
  assert.equal(elements.librarySourceBtn.getAttribute('aria-busy'), 'true');
  assert.equal(elements.libraryStartChoose.getAttribute('aria-busy'), 'true');
  assert.match(elements.scanDirStatus.textContent, /正在開啟/);
  assert.equal(elements.libraryStartStatus.textContent, elements.scanDirStatus.textContent);
  assert.equal(elements.libraryStartStatus.hidden, false);
  await h.hooks.chooseLibrarySource();
  assert.equal(pickerCalls, 1, '同時從首頁與設定觸發只開一個系統選擇器');
  resolvePicker(null);
  await first;
  assert.match(elements.scanDirStatus.textContent, /取消/);
  assert.equal(elements.libraryStartStatus.textContent, elements.scanDirStatus.textContent);
  assert.equal(elements.libraryStartStatus.hidden, false);
  assert.equal(elements.librarySourceBtn.disabled, false);
  assert.equal(elements.libraryStartChoose.disabled, false);
  assert.equal(elements.librarySourceBtn.getAttribute('aria-busy'), null);
  assert.equal(elements.libraryStartChoose.getAttribute('aria-busy'), null);

  const success = createHarness();
  success.context.navigator.userAgent = 'Macintosh';
  success.hooks.elements.scanDirInput.value = '';
  success.context.window.electronAPI.openFolderDialog = async () => '/Users/test/Manga';
  success.context.window.electronAPI.setConfig = async config => ({ scanDir: config.scanDir });
  vm.runInContext(`
    filterAndRenderGrid = () => {};
    renderSidebar = () => {};
    renderContinueStrip = () => {};
    renderInspectorEmpty = () => {};
    startScanStatusPolling = () => {};
    scheduleLibraryRefresh = () => {};
  `, success.context);
  await success.hooks.chooseLibrarySource();
  assert.match(success.hooks.elements.scanDirStatus.textContent, /已選擇/);
  assert.equal(success.hooks.elements.libraryStartStatus.textContent, success.hooks.elements.scanDirStatus.textContent);
  assert.equal(success.hooks.elements.libraryStartStatus.hidden, false);
  assert.equal(success.hooks.elements.librarySourceBtn.disabled, false);
  assert.equal(success.hooks.elements.libraryStartChoose.disabled, false);

  const failed = createHarness();
  failed.context.navigator.userAgent = 'Macintosh';
  failed.hooks.elements.scanDirInput.value = '';
  failed.context.window.electronAPI.openFolderDialog = async () => { throw new Error('permission denied'); };
  await failed.hooks.chooseLibrarySource();
  assert.match(failed.hooks.elements.scanDirStatus.textContent, /無法加入漫畫來源/);
  assert.equal(failed.hooks.elements.libraryStartStatus.textContent, failed.hooks.elements.scanDirStatus.textContent);
  assert.equal(failed.hooks.elements.libraryStartStatus.hidden, false);
  assert.equal(failed.hooks.elements.librarySourceBtn.disabled, false);
  assert.equal(failed.hooks.elements.libraryStartChoose.disabled, false);

  const iosCancelled = createHarness();
  iosCancelled.context.navigator.userAgent = 'iPad';
  iosCancelled.context.window.electronAPI.openExternalFolder = async () => {
    const error = new Error('已取消選擇');
    error.code = 'FOLDER_PICKER_CANCELLED';
    throw error;
  };
  await iosCancelled.hooks.chooseLibrarySource();
  assert.match(iosCancelled.hooks.elements.scanDirStatus.textContent, /取消/);
  assert.doesNotMatch(iosCancelled.hooks.elements.scanDirStatus.textContent, /無效|無法加入/);
  assert.equal(iosCancelled.hooks.elements.libraryStartStatus.textContent, iosCancelled.hooks.elements.scanDirStatus.textContent);
  assert.equal(iosCancelled.hooks.elements.libraryStartStatus.hidden, false);
  assert.equal(iosCancelled.hooks.elements.librarySourceBtn.disabled, false);
  assert.equal(iosCancelled.hooks.elements.libraryStartChoose.disabled, false);
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

// 空書架仍保留第 70 版的閱讀紀錄入口，但將空的繼續閱讀區壓成精簡列。
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  state.comics = [];
  h.hooks.renderContinueStrip();
  assert.equal(elements.continuePanel.hidden, false, '空書架仍保留閱讀紀錄操作列');
  assert.equal(elements.continuePanel.classList.contains('is-empty'), true, '沒有候選時使用精簡列樣式');
  assert.equal(elements.continueTitle.hidden, true, '空狀態隱藏無內容的繼續閱讀標題');
  assert.equal(elements.continuePanel.getAttribute('aria-labelledby'), 'reading-history-entry', '精簡列以閱讀紀錄按鈕作 accessible name');
  assert.notEqual(elements.readingHistoryEntry.hidden, true, '閱讀紀錄入口仍可使用');

  state.comics = [{
    id: 'formal-reading',
    title: '正式閱讀中',
    relativePath: 'formal-reading.cbz',
    pageCount: 4,
    progress: { currentPage: 1, totalPages: 4, updatedAt: '2026-11-09T00:00:00.000Z' },
  }];
  h.hooks.renderContinueStrip();
  assert.equal(elements.continuePanel.classList.contains('is-empty'), false, '正式閱讀候選回來後恢復完整區塊');
  assert.equal(elements.continueTitle.hidden, false, '有候選時恢復繼續閱讀標題');
  assert.equal(elements.continuePanel.getAttribute('aria-labelledby'), 'continue-title', '有候選時恢復區塊標題 accessible name');
  assert.equal(elements.continuePanel.hidden, false);
}

// welcome 只暫時收起工作區；正式來源出現後還原原本版面偏好與書架標題。
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  elements.mainLayout = new FakeElement('div');
  state.sidebarCollapsed = true;
  state.inspectorCollapsed = true;
  elements.mainLayout.classList.add('sidebar-collapsed', 'inspector-collapsed');
  state.comics = h.hooks.createBuiltInDemoComics();
  h.hooks.updateLibraryStartPanel();
  assert.equal(elements.mainLayout.classList.contains('library-welcome'), true, '空正式庫進入精簡 welcome 版面');
  assert.equal(elements.libraryTitle.textContent, '原創風景選集');
  assert.equal(state.sidebarCollapsed, true);
  assert.equal(state.inspectorCollapsed, true);
  assert.equal(elements.mainLayout.classList.contains('sidebar-collapsed'), true);
  assert.equal(elements.mainLayout.classList.contains('inspector-collapsed'), true);

  state.comics = [...state.comics, { id: 'formal-arrived', title: '剛加入的漫畫', relativePath: 'formal-arrived.cbz' }];
  h.hooks.updateLibraryStartPanel();
  assert.equal(elements.mainLayout.classList.contains('library-welcome'), false, '正式來源到達後退出 welcome 版面');
  assert.equal(elements.libraryTitle.textContent, '全部漫畫');
  assert.equal(elements.libraryStartPanel.hidden, true);
  assert.equal(state.sidebarCollapsed, true, '使用者原本的側欄偏好不被 welcome 覆寫');
  assert.equal(state.inspectorCollapsed, true, '使用者原本的詳情偏好不被 welcome 覆寫');
  assert.equal(elements.mainLayout.classList.contains('sidebar-collapsed'), true);
  assert.equal(elements.mainLayout.classList.contains('inspector-collapsed'), true);
}

// 最後一本正式漫畫移除後，active filter/series 必須仍可見，切回全部後恢復示範。
{
  const prepare = () => {
    const h = createHarness();
    h.hooks.elements.mainLayout = new FakeElement('div');
    h.hooks.elements.searchInput.value = '';
    vm.runInContext(`
      syncLibraryUpButton = () => {};
      closeDiscoveryTags = () => {};
      setDiscoveryStatus = () => {};
      syncDiscoveryButton = () => {};
      renderGrid = () => {};
      ensureInspectorSelection = () => {};
    `, h.context);
    return h;
  };

  // 舊邏輯的反證：只有 library-welcome 時不區分預設與非預設篩選，filter 控制會被舊 CSS 一併藏起來。
  const legacy = prepare();
  legacy.hooks.state.comics = legacy.hooks.createBuiltInDemoComics();
  legacy.hooks.state.activeFilter = 'favorite';
  vm.runInContext(`
    updateLibraryStartPanel = () => elements.mainLayout.classList.toggle('library-welcome', true);
    filterAndRenderGrid();
  `, legacy.context);
  assert.equal(legacy.hooks.elements.mainLayout.classList.contains('library-welcome'), true);
  assert.equal(legacy.hooks.elements.mainLayout.classList.contains('library-default-filters'), false,
    '舊版沒有用篩選狀態區分可否收起 filter controls');
  assert.equal(legacy.hooks.state.filteredComics.length, 0, 'favorite 篩選排除示範，舊版因此沒有書可開');

  for (const scope of ['favorite', 'series']) {
    const h = prepare();
    const { state, elements } = h.hooks;
    state.sidebarCollapsed = true;
    state.inspectorCollapsed = true;
    elements.mainLayout.classList.add('sidebar-collapsed', 'inspector-collapsed');
    const demos = h.hooks.createBuiltInDemoComics();
    const formal = {
      id: `last-formal-${scope}`,
      title: '最後一本正式漫畫',
      series: '正式系列',
      relativePath: '最後一本.cbz',
      pageCount: 3,
      progress: { currentPage: 0, totalPages: 3 },
    };
    state.comics = [...demos, formal];
    if (scope === 'favorite') {
      state.activeFilter = 'favorite';
      h.hooks.setFavorites([formal.id]);
    } else {
      state.activeFilter = 'all';
      state.activeSeries = '正式系列';
    }

    h.hooks.filterAndRenderGrid();
    assert.equal(state.filteredComics.some(comic => comic.id === formal.id), true, `${scope}:正式漫畫仍符合目前篩選`);
    state.comics = demos;
    h.hooks.filterAndRenderGrid();
    assert.equal(elements.mainLayout.classList.contains('library-welcome'), true, `${scope}:返回空正式庫的根目錄`);
    assert.equal(elements.mainLayout.classList.contains('library-default-filters'), false, `${scope}:保留可清除篩選的 filter controls`);
    assert.equal(state.filteredComics.length, 0, `${scope}:示範不冒充 favorite 或不符合的系列`);
    assert.equal(state.sidebarCollapsed, true, `${scope}:welcome 不改側欄收合偏好`);
    assert.equal(state.inspectorCollapsed, true, `${scope}:welcome 不改 inspector 收合偏好`);

    state.activeFilter = 'all';
    state.activeSeries = 'all';
    h.hooks.filterAndRenderGrid();
    assert.equal(elements.mainLayout.classList.contains('library-welcome'), true);
    assert.equal(elements.mainLayout.classList.contains('library-default-filters'), true, `${scope}:切回全部後 filter controls 可再次收起`);
    assert.deepEqual(Array.from(state.filteredComics, comic => comic.id), Array.from(demos, comic => comic.id), `${scope}:切回全部後示範選集可閱讀`);
  }

  const emptyFolder = prepare();
  emptyFolder.hooks.state.comics = emptyFolder.hooks.createBuiltInDemoComics();
  emptyFolder.hooks.state.currentPath = 'Parent/Empty';
  emptyFolder.hooks.state.currentSourceId = 'local:test';
  emptyFolder.hooks.state.sidebarCollapsed = true;
  emptyFolder.hooks.elements.mainLayout.classList.add('sidebar-collapsed');
  emptyFolder.hooks.filterAndRenderGrid();
  assert.equal(emptyFolder.hooks.elements.mainLayout.classList.contains('library-welcome'), false,
    '空子資料夾保留原資料夾導覽版面，不顯示根目錄 welcome');
  assert.equal(emptyFolder.hooks.elements.mainLayout.classList.contains('sidebar-collapsed'), true);
  assert.equal(emptyFolder.hooks.state.sidebarCollapsed, true);
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
  catalog.hooks.state.catalogSearchIds = new Set([catalogSearchKey(catalog.hooks, 'formal-a')]);
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
  const functionSource = source.match(/function getCoverUrl\([^)]*\) \{[\s\S]*?\n\}\n\n\/\/ 目錄縮圖/)[0].replace(/\n\n\/\/ 目錄縮圖[\s\S]*$/, '');
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
  duplicate.context.navigator.userAgent = 'iPad';
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
  await duplicate.hooks.chooseLibrarySource();
  const persisted = JSON.parse(duplicate.context.localStorage.getItem('gai:externalBookmarks'));
  assert.deepEqual(persisted, [{ name: '新名稱', bookmark: 'bookmark-same' }], 'same bookmark rename must update the saved name');
  assert.equal(nativeCalls, 1, 'same bookmark rename must submit one updated native snapshot');
  assert.match(duplicate.hooks.elements.libraryStartStatus.textContent, /已選擇/);
  assert.equal(duplicate.hooks.elements.libraryStartChoose.disabled, false, '改名結果應解除首頁按鈕 busy');
  assert.equal(duplicate.hooks.elements.libraryStartChoose.getAttribute('aria-busy'), null);

  const partialRename = createHarness();
  partialRename.context.navigator.userAgent = 'iPad';
  partialRename.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify([
    { name: '舊名稱', bookmark: 'bookmark-same' },
  ]));
  partialRename.context.window.electronAPI.openExternalFolder = async () => ({ name: '新名稱', bookmark: 'bookmark-same' });
  partialRename.context.window.electronAPI.setBookmarks = async () => {
    throw new Error('BOOKMARKS_UPDATED: old folder permission cleanup failed');
  };
  partialRename.context.showLoader = () => { throw new Error('renamed partial success must not start scanning'); };
  partialRename.context.startScanStatusPolling = () => { throw new Error('renamed partial success must not poll scans'); };
  partialRename.context.scheduleLibraryRefresh = () => { throw new Error('renamed partial success must not schedule scanning'); };
  await partialRename.hooks.chooseLibrarySource();
  assert.match(partialRename.hooks.elements.scanDirStatus.textContent, /已更新.*部分失敗/);
  assert.equal(partialRename.hooks.elements.libraryStartStatus.textContent, partialRename.hooks.elements.scanDirStatus.textContent);
  assert.equal(partialRename.hooks.elements.libraryStartStatus.hidden, false);
  assert.equal(partialRename.hooks.elements.libraryStartChoose.disabled, false, '部分成功改名也應解除首頁按鈕 busy');
  assert.equal(partialRename.hooks.elements.libraryStartChoose.getAttribute('aria-busy'), null);
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

// 原生書籤具有權威：瀏覽器為空／過期時仍保留原生來源；只有 backend
// 確認尚未保存過原生設定，才會用傳入快取做一次舊版遷移。
for (const browser of [[], [{ name: '過期來源', bookmark: 'stale' }], [null, { bookmark: 'invalid' }]]) {
  const restore = createHarness();
  const native = [{ name: '原生來源', bookmark: 'native' }];
  restore.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify(browser));
  let restores = 0;
  restore.context.window.electronAPI.restoreBookmarks = async legacy => {
    restores += 1;
    assert.deepEqual(JSON.parse(JSON.stringify(legacy)), browser.filter(item => item && typeof item.bookmark === 'string' && typeof item.name === 'string'));
    return native;
  };
  restore.context.window.electronAPI.setBookmarks = () => { throw new Error('startup must not submit the browser list as an ordinary edit'); };
  await restore.hooks.restoreExternalBookmarks();
  assert.deepEqual(JSON.parse(restore.context.localStorage.getItem('gai:externalBookmarks')), native);
  await restore.hooks.restoreExternalBookmarks();
  assert.equal(restores, 1, 'initialization is shared and idempotent within the current session');
}

// 使用者已明確移除全部來源時，原生保存的 [] 不得被過期快取復活。
{
  const restore = createHarness();
  restore.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify([{ name: '已移除', bookmark: 'stale' }]));
  restore.context.window.electronAPI.restoreBookmarks = async () => [];
  await restore.hooks.restoreExternalBookmarks();
  assert.deepEqual(JSON.parse(restore.context.localStorage.getItem('gai:externalBookmarks')), []);
}

// 快取空間不足時仍使用工作階段的原生 snapshot，新增不會漏掉原本來源。
{
  const restore = createHarness();
  const native = [{ name: '原生來源', bookmark: 'native' }];
  restore.context.window.electronAPI.restoreBookmarks = async () => native;
  restore.context.localStorage.setItem = () => { throw new Error('storage full'); };
  restore.context.window.electronAPI.openExternalFolder = async () => ({ name: '新增來源', bookmark: 'new' });
  let committed;
  restore.context.window.electronAPI.setBookmarks = async data => { committed = JSON.parse(JSON.stringify(data)); };
  restore.context.showLoader = () => {};
  restore.context.startScanStatusPolling = () => {};
  restore.context.scheduleLibraryRefresh = () => {};
  await restore.hooks.addIOSLibrarySource(); // 刻意先於 initApp 的 restore。
  assert.deepEqual(committed, [...native, { name: '新增來源', bookmark: 'new' }]);
  await restore.hooks.restoreExternalBookmarks();
  assert.deepEqual(committed, [...native, { name: '新增來源', bookmark: 'new' }]);
}

// 原生讀取／格式失敗時，不得退回瀏覽器清單覆寫原生；下一個 intent 可重試。
{
  const restore = createHarness();
  let attempts = 0;
  restore.context.window.electronAPI.restoreBookmarks = async () => {
    if (++attempts === 1) throw new Error('saved native bookmarks unreadable');
    return [{ name: '原生來源', bookmark: 'native' }];
  };
  await assert.rejects(restore.hooks.restoreExternalBookmarks(), /unreadable/);
  await restore.hooks.restoreExternalBookmarks();
  assert.deepEqual(JSON.parse(restore.context.localStorage.getItem('gai:externalBookmarks')), [{ name: '原生來源', bookmark: 'native' }]);
}
{
  const restore = createHarness();
  restore.context.localStorage.getItem = () => { throw new Error('storage unavailable'); };
  restore.context.window.electronAPI.restoreBookmarks = async (legacy, readable) => {
    assert.deepEqual(Array.from(legacy), []);
    assert.equal(readable, false, 'a failed storage read must defer legacy migration');
    throw new Error('legacy migration deferred');
  };
  await assert.rejects(vm.runInContext('restoreExternalBookmarks()', restore.context), /migration deferred/);
  restore.context.localStorage.getItem = () => '[]';
  restore.context.window.electronAPI.restoreBookmarks = async (_legacy, readable) => {
    assert.equal(readable, true, 'a successful empty read may migrate an empty list');
    return [];
  };
  await vm.runInContext('restoreExternalBookmarks()', restore.context);
}
console.log('native bookmark authority, startup queue and storage failure tests passed');

// 原生回報可讀但損壞的 JSON 時，前端只進入 blocked；重新加入必須先經過
// 既有選檔器與明確確認，且 repair 不得使用過期的瀏覽器快取。
{
  const corrupt = createHarness();
  const stale = [{ name: '過期來源', bookmark: 'stale' }];
  corrupt.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify(stale));
  corrupt.context.window.electronAPI.restoreBookmarks = async () => {
    throw new Error('BOOKMARKS_CORRUPT: saved list is malformed');
  };
  assert.equal(await corrupt.hooks.restoreExternalBookmarks(), 'BOOKMARKS_CORRUPT');
  let repairCalls = 0;
  let ordinarySetCalls = 0;
  corrupt.context.window.electronAPI.openExternalFolder = async () => ({ name: '新來源', bookmark: 'new-bookmark' });
  corrupt.context.confirm = () => true;
  corrupt.context.window.electronAPI.repairExternalBookmarks = async data => {
    repairCalls += 1;
    assert.deepEqual(JSON.parse(JSON.stringify(data)), [{ name: '新來源', bookmark: 'new-bookmark' }]);
  };
  corrupt.context.window.electronAPI.setBookmarks = async () => { ordinarySetCalls += 1; };
  corrupt.context.showLoader = () => {};
  corrupt.context.startScanStatusPolling = () => {};
  corrupt.context.scheduleLibraryRefresh = () => {};
  await corrupt.hooks.addIOSLibrarySource();
  assert.equal(repairCalls, 1, 'corrupt recovery must call the dedicated repair command once');
  assert.equal(ordinarySetCalls, 0, 'corrupt recovery must not bypass repair with ordinary setBookmarks');
  assert.deepEqual(JSON.parse(corrupt.context.localStorage.getItem('gai:externalBookmarks')), [
    { name: '新來源', bookmark: 'new-bookmark' },
  ], 'only the selected folder becomes the repaired frontend snapshot');
}

// 取消確認或 repair 失敗時，snapshot／瀏覽器快取都不能被前端先行更新。
for (const mode of ['cancel', 'failure']) {
  const recovery = createHarness();
  const stale = [{ name: '過期來源', bookmark: 'stale' }];
  recovery.context.localStorage.setItem('gai:externalBookmarks', JSON.stringify(stale));
  recovery.context.window.electronAPI.restoreBookmarks = async () => {
    throw new Error('BOOKMARKS_CORRUPT: saved list is malformed');
  };
  await recovery.hooks.restoreExternalBookmarks();
  recovery.context.window.electronAPI.openExternalFolder = async () => ({ name: '新來源', bookmark: 'new-bookmark' });
  recovery.context.confirm = () => mode !== 'cancel';
  let repairCalls = 0;
  recovery.context.window.electronAPI.repairExternalBookmarks = async () => {
    repairCalls += 1;
    throw new Error('repair failed before commit');
  };
  recovery.context.showLoader = () => {};
  recovery.context.startScanStatusPolling = () => {};
  recovery.context.scheduleLibraryRefresh = () => {};
  if (mode === 'cancel') {
    await recovery.hooks.addIOSLibrarySource();
  } else {
    await assert.rejects(recovery.hooks.addIOSLibrarySource(), /repair failed/);
  }
  assert.equal(repairCalls, mode === 'cancel' ? 0 : 1, `${mode} must not accidentally invoke repair`);
  assert.deepEqual(JSON.parse(recovery.context.localStorage.getItem('gai:externalBookmarks')), stale,
    `${mode} must retain the existing browser cache`);
}

// repair 若原生已提交清單、但後續權限清理部分失敗，沿用既有部分成功語意。
{
  const partial = createHarness();
  partial.context.window.electronAPI.restoreBookmarks = async () => {
    throw new Error('BOOKMARKS_CORRUPT: saved list is malformed');
  };
  await partial.hooks.restoreExternalBookmarks();
  partial.context.window.electronAPI.openExternalFolder = async () => ({ name: '新來源', bookmark: 'new-bookmark' });
  partial.context.confirm = () => true;
  partial.context.window.electronAPI.repairExternalBookmarks = async () => {
    throw new Error('清單已更新，部分舊來源清理未完成：權限釋放失敗');
  };
  partial.context.showLoader = () => {};
  partial.context.startScanStatusPolling = () => {};
  partial.context.scheduleLibraryRefresh = () => {};
  await partial.hooks.addIOSLibrarySource();
  assert.deepEqual(JSON.parse(partial.context.localStorage.getItem('gai:externalBookmarks')), [
    { name: '新來源', bookmark: 'new-bookmark' },
  ], 'a committed repair with cleanup warnings must retain the new snapshot');
}
console.log('corrupt external bookmark recovery tests passed');

// 同一路徑的不同來源必須各自導覽；root 才能合併展示來源候選，避免在
// 外部 H/HCG 中混入另一個 H/H漫畫/Alpha 的幽靈卡片。
{
  const isolated = createHarness();
  isolated.hooks.state.activeSeries = 'all';
  isolated.hooks.state.activeFilter = 'all';
  isolated.hooks.elements.searchInput.value = '';
  isolated.hooks.state.comics = [
    { id: 'h-alpha', title: 'Alpha H', relativePath: 'H/HCG/Alpha.cbz', sourceId: 'external:h' },
    { id: 'h-manga-alpha', title: 'Alpha H漫畫', relativePath: 'H/H漫畫/Alpha.cbz', sourceId: 'external:h' },
    { id: 'hcg-alpha', title: 'Alpha HCG', relativePath: 'H/HCG/Alpha.cbz', sourceId: 'external:hcg' },
  ];
  isolated.hooks.state.currentPath = 'H/HCG';
  isolated.hooks.state.currentSourceId = 'external:h';
  assert.deepEqual(Array.from(isolated.hooks.getDirectoryItems(), item => item.id), ['h-alpha'], 'selected source isolates same-path shelf items');
  isolated.hooks.state.currentSourceId = 'external:hcg';
  assert.deepEqual(Array.from(isolated.hooks.getDirectoryItems(), item => item.id), ['hcg-alpha'], 'second source keeps the same relative path independent');
  isolated.hooks.state.currentSourceId = '';
  isolated.hooks.state.currentPath = 'H/HCG';
  assert.deepEqual(Array.from(isolated.hooks.getDirectoryItems(), item => item.id), ['h-alpha', 'hcg-alpha'], 'merged root navigation may show both source candidates');
}
console.log('source-aware directory isolation tests passed');

// 新事件帶 visibleSourceId 時，另一來源即使使用同一 visiblePath 也不能
// 看到對方的目錄候選；缺少欄位的舊事件只進 legacy root lane。
{
  const visible = createHarness();
  visible.hooks.elements.searchInput = { value: '' };
  visible.hooks.state.visibleDirectoryGeneration = 7;
  visible.hooks.state.scanStatus = { generation: 7, isScanning: true };
  visible.hooks.state.currentPath = 'shared';
  visible.hooks.state.currentSourceId = 'external:a';
  visible.hooks.applyIncrementalLibraryBatch({
    generation: 7,
    visible: true,
    visiblePath: 'shared',
    visibleSourceId: 'external:b',
    directories: ['shared/only-b'],
    items: [],
  });
  assert.equal(visible.hooks.getDirectoryItems().some(item => item.relativePath === 'shared/only-b'), false,
    'source-specific visible directories never cross into the current source');
  visible.hooks.state.currentSourceId = '';
  assert.equal(visible.hooks.getDirectoryItems().some(item => item.relativePath === 'shared/only-b'), true,
    'merged root can present a source-qualified directory candidate');
}
console.log('visible source payload isolation tests passed');

// 同一來源的舊 catalog 路徑，也不能在當層淺掃後復活成別處的目錄。
{
  const visible = createHarness();
  visible.hooks.elements.searchInput = { value: '' };
  visible.hooks.state.scanStatus = { generation: 9, isScanning: true };
  visible.hooks.state.visibleDirectoryGeneration = 9;
  visible.hooks.state.currentPath = 'H/HCG';
  visible.hooks.state.currentSourceId = 'external:h';
  visible.hooks.state.comics = [
    { id: 'stale', title: 'Old', relativePath: 'H/HCG/Ghost/old.cbz', sourceId: 'external:h' },
    { id: 'real', title: 'New', relativePath: 'H/HCG/Real/new.cbz', sourceId: 'external:h' },
  ];
  assert.equal(visible.hooks.getDirectoryItems().length, 2, 'before a shallow scan the catalog remains available');
  visible.hooks.applyIncrementalLibraryBatch({
    generation: 9, visible: true, visiblePath: 'H/HCG', visibleSourceId: 'external:h',
    directories: ['H/HCG/Real', 'H/H漫畫/Other'], items: [],
  });
  assert.deepEqual(Array.from(visible.hooks.getDirectoryItems(), item => item.title), ['Real'],
    'the physical one-level snapshot removes old and sibling directory cards');
  const nodes = vm.runInContext('collectFolderTreeNodes()', visible.context);
  assert.equal(nodes.has('external:h\u0000H/HCG/Ghost'), false, 'the tree also drops a stale direct child');
  assert.equal(nodes.has('external:h\u0000H/HCG/Real'), true, 'the tree keeps a real direct child');
  visible.hooks.applyIncrementalLibraryBatch({
    generation: 9, visible: true, visiblePath: 'H/HCG', visibleSourceId: 'external:h',
    directories: [], items: [],
  });
  assert.deepEqual(Array.from(visible.hooks.getDirectoryItems()), [],
    'a later empty snapshot replaces instead of merging the previous visit');
}
console.log('authoritative shallow directory snapshot tests passed');

// A→B→A 必須建立 A 的新請求；舊 A promise 不能因為 Map key 相同而被重用。
{
  const rapid = createHarness();
  const calls = [];
  const resolvers = [];
  rapid.context.window.electronAPI.scanVisibleDirectory = (relativePath, sourceId) => {
    calls.push({ relativePath, sourceId });
    return new Promise(resolve => resolvers.push(resolve));
  };
  rapid.hooks.elements.searchInput = { value: '' };
  rapid.hooks.state.visibleDirectoryGeneration = 1;
  rapid.hooks.state.scanStatus = { generation: 1, isScanning: true };
  const cachedA = rapid.hooks.getVisibleDirectoryMapKey('external:a', 'shared');
  rapid.hooks.state.visibleDirectories.set(cachedA, ['shared/verified']);
  rapid.hooks.navigateLibraryToPath('shared', 'external:a');
  rapid.hooks.navigateLibraryToPath('shared', 'external:b');
  rapid.hooks.navigateLibraryToPath('shared', 'external:a');
  assert.deepEqual(Array.from(rapid.hooks.state.visibleDirectories.get(cachedA)), ['shared/verified'],
    'returning to A keeps its verified directory snapshot until the new scan arrives');
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { relativePath: 'shared', sourceId: 'external:a' },
    { relativePath: 'shared', sourceId: 'external:b' },
    { relativePath: 'shared', sourceId: 'external:a' },
  ], 'returning to a source/path starts a fresh visible scan');
  resolvers.forEach(resolve => resolve());
  await Promise.resolve();
}
console.log('rapid source navigation tests passed');

// 原生清單已提交但權限釋放失敗時，移除後的清單仍須保存；真正失敗則保留原清單。
for (const [nativeError, expectedCount] of [
  [null, 0],
  ['清單已更新，舊權限可能未完全釋放；無法釋放外部資料夾權限', 0],
  ['清單已更新，部分舊來源清理未完成：舊來源目錄清理未完成', 0],
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

// 探索入口共用書架篩選；不跨來源、不抽到離線作品，不另外發起掃描。
{
  const discovery = createHarness();
  const { state, elements } = discovery.hooks;
  const book = (id, path, extra = {}) => ({ id, title: id, relativePath: path, sourceId: 'local:A', series: 'Series', ...extra });
  state.comics = [
    book('one', 'Shelf/One'), book('two', 'Shelf/Sub/Two'), book('outside', 'Other/Outside'),
    book('foreign', 'Shelf/Foreign', { sourceId: 'local:B' }),
    book('offline', 'Shelf/Offline', { offline: true }),
    book('folder', 'Shelf/Folder', { isDirectory: true }),
  ];
  state.currentPath = 'Shelf';
  state.currentSourceId = 'local:A';
  elements.searchInput.value = '';
  assert.deepEqual(Array.from(discovery.hooks.getDiscoveryCandidates(), comic => comic.id), ['one', 'two']);
  state.activeSeries = 'Other';
  assert.equal(discovery.hooks.getDiscoveryCandidates().length, 0);
  state.activeSeries = 'all';
  discovery.hooks.setFavorites(['two']);
  state.activeFilter = 'favorite';
  assert.deepEqual(Array.from(discovery.hooks.getDiscoveryCandidates(), comic => comic.id), ['two']);
  state.activeFilter = 'all';
  elements.searchInput.value = 'outside';
  assert.deepEqual(Array.from(discovery.hooks.getDiscoveryCandidates(), comic => comic.id), ['outside'], '搜尋沿用書架的目前來源全庫範圍');
  state.catalogSearchItems.set(catalogSearchKey(discovery.hooks, 'outside', 'local:A', 'Other/Outside'), {
    runtimeId: 'outside', sourceId: 'local:A', relativePath: 'Other/Outside', offline: true,
  });
  assert.equal(discovery.hooks.getDiscoveryCandidates().length, 0, '搜尋結果的離線 metadata 不能被忽略');
  state.catalogSearchItems.clear();
  elements.searchInput.value = '';
  const candidates = discovery.hooks.getDiscoveryCandidates();
  assert.equal(discovery.hooks.pickDiscoveryComic(candidates, 'one', () => 0).id, 'two');
  assert.equal(discovery.hooks.pickDiscoveryComic([candidates[0]], 'one', () => 0).id, 'one');
  assert.equal(discovery.hooks.pickDiscoveryComic([], null, () => 0), null);
  assert.equal(discovery.hooks.pickDiscoveryComic(candidates, null, () => 0.999).id, 'two');
  const round = discovery.hooks.discoverySessionFor([
    book('round-1', 'Shelf/R1'), book('round-2', 'Shelf/R2'), book('round-3', 'Shelf/R3'),
  ]);
  const walked = [];
  for (let index = 0; index < 3; index += 1) {
    const chosen = discovery.hooks.pickNextDiscoveryComic(round, () => 0);
    walked.push(chosen.id);
    round.seen.add(discovery.hooks.discoveryComicKey(chosen));
  }
  assert.equal(new Set(walked).size, 3, '同一輪每本成功作品只會出現一次');
  const boundaryPick = discovery.hooks.pickNextDiscoveryComic(round, () => 0);
  assert.notEqual(boundaryPick.id, walked.at(-1), '新一輪不會緊接上一冊');
  const dynamicSession = discovery.hooks.discoverySessionFor([book('dyn-a', 'Shelf/DA'), book('dyn-b', 'Shelf/DB')]);
  const dynAKey = [...dynamicSession.candidates.keys()][0];
  dynamicSession.seen.add(dynAKey);
  const dynamic = discovery.hooks.discoverySessionFor([book('dyn-b', 'Shelf/DB'), book('dyn-c', 'Shelf/DC')]);
  assert.equal(dynamic, dynamicSession, '同一範圍動態批次更新沿用原 session');
  assert.equal(dynamic.seen.has(dynAKey), false, '已刪作品會從成功集合剔除');
  assert.equal(discovery.hooks.pickNextDiscoveryComic(dynamic, () => 0).id, 'dyn-b', '動態加入的作品可在尚未成功集合優先探索');
  const beforeScopeChange = discovery.hooks.discoverySessionFor([book('scope-book', 'Shelf/Scope')]);
  state.currentPath = 'Other';
  const afterScopeChange = discovery.hooks.discoverySessionFor([book('scope-book', 'Shelf/Scope')]);
  assert.notEqual(afterScopeChange, beforeScopeChange, '資料夾切換建立獨立的有界 session');
  state.currentPath = 'Shelf';
  const sameRuntimeDifferentSource = [book('shared-id', 'Shelf/A', { sourceId: 'local:A' }), book('shared-id', 'Shelf/A', { sourceId: 'local:B' })];
  assert.equal(new Set(sameRuntimeDifferentSource.map(discovery.hooks.discoveryComicKey)).size, 2, '相同 runtime id 依來源／路徑隔離');
  state.filteredComics = [{ isDirectory: true, comicsCount: 2 }];
  discovery.hooks.syncDiscoveryButton();
  assert.equal(elements.libraryDiscoveryBtn.disabled, false, '目前資料夾的子資料夾有已載入作品也可探索');
  vm.runInContext(`
    window.discoveryOpens = [];
    openReader = async comic => {
      const id = comic.id || comic;
      window.discoveryOpens.push(id);
      await new Promise(resolve => { window.finishDiscovery = () => {
        state.currentComic = state.comics.find(comic => comic.id === id);
        resolve();
      }; });
    };
  `, discovery.context);
  const opening = discovery.hooks.openDiscoveryComic(() => 0);
  assert.equal(elements.libraryDiscoveryBtn.disabled, true);
  await discovery.hooks.openDiscoveryComic(() => 0);
  assert.equal(discovery.context.window.discoveryOpens.length, 1, '快速連點只能發起一次開書');
  discovery.context.window.finishDiscovery();
  await opening;
  state.currentComic = null;
  vm.runInContext('openReader = async comic => { const id = comic.id || comic; window.discoveryOpens.push(id); state.currentComic = state.comics.find(item => item.id === id); };', discovery.context);
  await discovery.hooks.openDiscoveryComic(() => 0);
  assert.deepEqual(Array.from(discovery.context.window.discoveryOpens), ['one', 'two'], '成功開書後下一次避開上一本');
  state.currentComic = null;
  vm.runInContext('openReader = async () => { throw new Error("temporary source loss"); };', discovery.context);
  await discovery.hooks.openDiscoveryComic(() => 0);
  assert.equal(elements.libraryDiscoveryBtn.disabled, false, '開書失敗不能永久鎖住探索按鈕');
  assert.match(elements.libraryDiscoveryStatus.textContent, /這本暫時打不開/);
  assert.equal(elements.libraryDiscoveryStatus.hidden, false);
  state.activeSeries = 'missing';
  await discovery.hooks.openDiscoveryComic(() => 0);
  assert.match(elements.libraryDiscoveryStatus.textContent, /目前範圍沒有可讀漫畫/);
  state.filteredComics = [];
  discovery.hooks.syncDiscoveryButton();
  assert.equal(elements.libraryDiscoveryBtn.disabled, true);
}

// Reader「再翻一本」沿用同一個 openReader lifecycle，context 受 source/path 與 readerOperation 綁定。
{
  const episode = createHarness();
  const { state, elements } = episode.hooks;
  const make = (id, path) => ({ id, title: id, relativePath: path, sourceId: 'local:episode', series: 'Series' });
  state.comics = [make('ep-one', 'Shelf/One'), make('ep-two', 'Shelf/Two'), make('ep-three', 'Shelf/Three')];
  state.currentPath = 'Shelf';
  state.currentSourceId = 'local:episode';
  elements.searchInput.value = '';
  episode.context.window.openedEpisode = [];
  vm.runInContext(`openReader = async comic => {
    window.openedEpisode.push(comic.id);
    state.currentComic = comic;
    state.pendingComicId = null;
    state.readerOperation += 1;
  };`, episode.context);
  assert.equal(await episode.hooks.openDiscoveryComic(() => 0), true);
  assert.equal(elements.readerDiscoveryNext.hidden, false, '探索入口開啟成功後顯示 reader 按鈕');
  episode.document.activeElement = elements.readerDiscoveryNext;
  vm.runInContext(`openReader = comic => new Promise(resolve => {
    window.openedEpisode.push(comic.id);
    window.finishEpisodeSwitch = () => {
      state.currentComic = comic; state.pendingComicId = null; state.readerOperation += 1; resolve();
    };
  });`, episode.context);
  const switchingEpisode = episode.hooks.openNextDiscoveryComic();
  assert.equal(elements.readerDiscoveryNext.disabled, true);
  assert.equal(elements.readerDiscoveryNext.getAttribute('aria-busy'), 'true');
  assert.equal(await episode.hooks.openNextDiscoveryComic(), false, '快速連點 reader next 只能開一次');
  episode.context.window.finishEpisodeSwitch();
  assert.equal(await switchingEpisode, true);
  assert.equal(episode.context.window.openedEpisode[0], 'ep-one');
  assert.ok(['ep-two', 'ep-three'].includes(episode.context.window.openedEpisode[1]));
  assert.notEqual(episode.context.window.openedEpisode[1], episode.context.window.openedEpisode[0]);
  assert.equal(elements.readerDiscoveryNext.focusCalls, 1, 'reader 切換後焦點仍落在有效探索控制');
  assert.equal(elements.readerDiscoveryNext.getAttribute('aria-busy'), 'false');
  state.readerOperation += 1;
  episode.hooks.syncDiscoveryReaderButton();
  assert.equal(elements.readerDiscoveryNext.hidden, true, 'reader operation 變更會使 episode context 失效');

  state.currentComic = null;
  state.comics = [make('ep-one', 'Shelf/One')];
  vm.runInContext(`openReader = async comic => {
    state.currentComic = comic; state.pendingComicId = null; state.readerOperation += 1;
  };`, episode.context);
  assert.equal(await episode.hooks.openDiscoveryComic(() => 0), true);
  assert.equal(elements.readerDiscoveryNext.hidden, true, '只有目前這本時不顯示無意義的 reader 下一本');
}

// 單本探索仍保留 episode identity；實際增量批次補入同 scope 候選後會排程恢復 reader action。
{
  const incrementalEpisode = createHarness();
  const { state, elements } = incrementalEpisode.hooks;
  const first = { id: 'incremental-first', title: 'incremental-first', relativePath: 'Shelf/First.cbz', sourceId: 'local:incremental-episode' };
  const second = { id: 'incremental-second', title: 'incremental-second', relativePath: 'Shelf/Second.cbz', sourceId: 'local:incremental-episode' };
  state.comics = [first];
  state.currentPath = 'Shelf';
  state.currentSourceId = 'local:incremental-episode';
  elements.searchInput.value = '';
  state.scanStatus = { generation: 41, isScanning: true };
  const openedIds = [];
  incrementalEpisode.context.window.electronAPI.openComic = async id => {
    const comic = state.comics.find(item => item.id === id);
    openedIds.push(id);
    return {
      id: comic.id, sourceId: comic.sourceId, relativePath: comic.relativePath, title: comic.title,
      type: 'archive', isDir: false, pages: ['page-0.png'], progress: { currentPage: 0 },
      historyToken: `history:${comic.id}`, sequenceFloor: 0, filenames: [],
    };
  };
  incrementalEpisode.context.window.electronAPI.closeComic = async () => {};
  vm.runInContext('applyFitMode = () => {}; renderPages = () => {}; requestVisibleDirectoryScan = () => {}; filterAndRenderGrid = () => {};',
    incrementalEpisode.context);
  assert.equal(await incrementalEpisode.hooks.openDiscoveryComic(() => 0), true);
  assert.equal(elements.readerDiscoveryNext.hidden, true, '單一候選維持隱藏');
  assert.equal(incrementalEpisode.hooks.applyIncrementalLibraryBatch({ generation: 41, items: [second], found: 2 }), true,
    '使用實際 incremental batch 入口追加候選');
  assert.equal(elements.readerDiscoveryNext.hidden, true, '按鈕在 coalesced sync 前維持隱藏');
  incrementalEpisode.clock.tick(0);
  assert.equal(elements.readerDiscoveryNext.hidden, false, '同 scope 新候選抵達後自動恢復按鈕');
  assert.equal(await incrementalEpisode.hooks.openNextDiscoveryComic(), true, '恢復的按鈕可走 reader next 流程');
  assert.deepEqual(openedIds, [first.id, second.id], '實際 openReader 由 incremental 候選開啟第二本');
  state.currentPath = 'Elsewhere';
  incrementalEpisode.hooks.syncDiscoveryReaderButton();
  assert.equal(elements.readerDiscoveryNext.hidden, true, 'scope 改變會隱藏並清除舊 episode context');
}

// The native open_comic payload is authoritative for this identity. Exercise
// the real openReader and closeReader functions, including progress-before-close.
{
  const nativePayload = createHarness();
  const { state, elements } = nativePayload.hooks;
  const comics = [
    { id: 'native-a', title: 'Audit74 Native A', sourceId: 'local:native-contract', relativePath: 'Shelf/A.cbz', series: 'Audit74' },
    { id: 'native-b', title: 'Audit74 Native B', sourceId: 'local:native-contract', relativePath: 'Shelf/B.cbz', series: 'Audit74' },
  ];
  state.comics = comics;
  state.currentPath = 'Shelf';
  state.currentSourceId = 'local:native-contract';
  state.activeSeries = 'Audit74';
  elements.seriesFilterSelect.value = 'Audit74';
  elements.searchInput.value = 'Audit74';
  const order = [];
  const openedPayloads = [];
  nativePayload.context.window.electronAPI.openComic = async id => {
    const comic = comics.find(item => item.id === id);
    openedPayloads.push({ id: comic.id, sourceId: comic.sourceId, relativePath: comic.relativePath });
    order.push(`open:${comic.id}`);
    return {
      id: comic.id,
      sourceId: comic.sourceId,
      relativePath: comic.relativePath,
      title: comic.title,
      type: 'archive',
      isDir: false,
      pages: ['page-0.png'],
      progress: { currentPage: 0 },
      historyToken: `history:${comic.id}`,
      sequenceFloor: 0,
      filenames: [],
    };
  };
  nativePayload.context.window.electronAPI.closeComic = async id => { order.push(`close:${id}`); };
  nativePayload.context.window.electronAPI.saveProgress = async snapshot => {
    order.push(`save:${snapshot.id}`);
  };
  vm.runInContext('applyFitMode = () => {}; renderPages = () => {}; requestVisibleDirectoryScan = () => {}; filterAndRenderGrid = () => {};', nativePayload.context);

  assert.equal(await nativePayload.hooks.openDiscoveryComic(() => 0), true);
  assert.equal(state.currentComic.id, 'native-a');
  assert.equal(state.currentComic.relativePath, 'Shelf/A.cbz', 'actual openReader retains the native relativePath');
  assert.equal(elements.readerDiscoveryNext.hidden, false, 'qualified native payload establishes discovery context');
  assert.deepEqual(openedPayloads[0], {
    id: 'native-a', sourceId: 'local:native-contract', relativePath: 'Shelf/A.cbz',
  });

  state.readerReadyPages.add(0);
  state.readerLastReadyPageIndex = 0;
  assert.equal(await nativePayload.hooks.openNextDiscoveryComic(), true);
  assert.equal(state.currentComic.id, 'native-b');
  assert.ok(order.indexOf('save:native-a') >= 0, 'switching readers flushes the closing comic progress');
  assert.ok(order.indexOf('save:native-a') < order.indexOf('close:native-a'), 'progress save remains before native close');
  assert.ok(order.indexOf('close:native-a') < order.indexOf('open:native-b'), 'next open waits for the existing close lifecycle');
  assert.equal(state.readerReturnLibraryContext.searchQuery, 'Audit74');
  assert.equal(state.readerReturnLibraryContext.currentPath, 'Shelf');
  await nativePayload.hooks.closeReader();
  assert.equal(state.currentPath, 'Shelf', 'closing the exploration episode restores the original folder');
  assert.equal(state.activeSeries, 'Audit74', 'closing restores the original series selection');
  assert.equal(elements.searchInput.value, 'Audit74', 'closing restores the original search');
}

// A missing path on a runtime-ID collision cannot establish identity from ID/source alone.
{
  const malformedPayload = createHarness();
  const { state, elements } = malformedPayload.hooks;
  const collisions = [
    { id: 'shared-native-id', title: 'A', sourceId: 'local:A', relativePath: 'Shelf/A.cbz' },
    { id: 'shared-native-id', title: 'B', sourceId: 'local:B', relativePath: 'Shelf/B.cbz' },
  ];
  state.comics = collisions;
  state.currentPath = 'Shelf';
  elements.searchInput.value = '';
  malformedPayload.context.window.electronAPI.openComic = async () => ({
    id: 'shared-native-id', sourceId: 'local:B', title: 'B', type: 'archive',
    isDir: false, pages: ['page-0.png'], progress: { currentPage: 0 }, filenames: [],
  });
  vm.runInContext('applyFitMode = () => {}; renderPages = () => {};', malformedPayload.context);
  assert.equal(await malformedPayload.hooks.openDiscoveryComic(() => 0), false, 'missing relativePath cannot qualify the chosen source target');
  assert.equal(state.currentComic.sourceId, 'local:B');
  assert.equal(elements.readerDiscoveryNext.hidden, true, 'id collision without path cannot create a reader episode');
  assert.equal(malformedPayload.hooks.discoverySessionFor(collisions).seen.size, 0, 'malformed native identity does not consume a successful seen item');
}

{
  const nativeSource = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const start = nativeSource.indexOf('async fn open_comic(');
  const end = nativeSource.indexOf('#[tauri::command]', start);
  const openComic = nativeSource.slice(start, end);
  assert.match(openComic, /"relativePath":\s*comic_info\.relative_path/, 'native open_comic returns its authoritative relative path');
}

{
  const retry = createHarness();
  const { state, elements } = retry.hooks;
  elements.searchInput.value = '';
  const only = { id: 'retry-book', title: 'retry-book', relativePath: 'Shelf/Retry', sourceId: 'local:retry' };
  state.comics = [only];
  vm.runInContext(`openReader = async comic => {
    if (window.shouldFail) { window.shouldFail = false; state.currentComic = null; return; }
    state.currentComic = comic; state.pendingComicId = null; state.readerOperation += 1;
  }; window.shouldFail = true;`, retry.context);
  assert.equal(await retry.hooks.openDiscoveryComic(() => 0), false);
  assert.equal(await retry.hooks.openDiscoveryComic(() => 0), true, '失敗不消耗成功 seen，單本可再試');
  assert.equal(elements.readerDiscoveryNext.getAttribute('aria-busy'), 'false');
}

{
  const offline = createHarness();
  const { state, elements } = offline.hooks;
  state.comics = [{ id: 'gone', title: 'gone', relativePath: 'gone', sourceId: 'local:A' }];
  elements.searchInput.value = 'gone';
  state.catalogSearchItems.set(catalogSearchKey(offline.hooks, 'gone', 'local:A', 'gone'), {
    runtimeId: 'gone', sourceId: 'local:A', relativePath: 'gone', offline: true,
  });
  state.filteredComics = [{ id: 'gone', offline: false }];
  offline.hooks.syncDiscoveryButton();
  assert.equal(elements.libraryDiscoveryBtn.disabled, true, '按鈕 disabled 與 metadata offline 後的實際候選一致');
}

{
  const welcome = createHarness();
  const { state, elements } = welcome.hooks;
  elements.searchInput.value = '';
  vm.runInContext(`window.welcomeOpened = [];
    openReader = async comic => {
      window.welcomeOpened.push(comic.id);
      state.currentComic = comic;
      state.pendingComicId = null;
      state.readerOperation += 1;
    };`, welcome.context);
  assert.equal(await welcome.hooks.openWelcomeDemoEpisode(), true);
  assert.equal(state.comics.filter(comic => comic.isBuiltInDemo).length, 8);
  assert.match(welcome.context.window.welcomeOpened[0], /mountains$/);
  assert.equal(elements.readerDiscoveryNext.hidden, false, '首用 CTA 進入探索 episode');
  assert.equal(await welcome.hooks.openNextDiscoveryComic(), true);
  assert.notEqual(welcome.context.window.welcomeOpened[0], welcome.context.window.welcomeOpened[1]);
  assert.match(appSource, /if \(builtInDemo\) \{\s*openReader\(comic\);/, 'demo 單卡仍由一般 openReader 入口開啟');
}

{
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const startPanel = html.slice(html.indexOf('id="library-start-panel"'), html.indexOf('class="scan-recovery-panel"'));
  assert.match(startPanel, /自己的漫畫，打開資料夾就能讀。/);
  assert.match(startPanel, /支援本機、外接硬碟與已掛載的 NAS；原始檔案留在原處。/);
  assert.ok(startPanel.indexOf('id="library-start-demo"') < startPanel.indexOf('id="library-start-choose"'), '原創風景試讀是首次入口的第一個操作');
  assert.match(startPanel, /id="library-start-demo" class="library-start-primary"/);
  const dictionary = {};
  vm.runInNewContext(fs.readFileSync(new URL('../public/locales/reader-messages.js', import.meta.url), 'utf8'), {
    window: { GAIL10n: { register: entries => Object.assign(dictionary, entries) } },
  });
  for (const message of ['自己的漫畫，打開資料夾就能讀。', '支援本機、外接硬碟與已掛載的 NAS；原始檔案留在原處。', '先試讀原創風景', '加入漫畫資料夾', '隨手翻一本', '再翻一本', '正在開啟…', '從目前資料夾與篩選結果挑一本，再點會盡量換一本。', '目前範圍沒有可讀漫畫，試著換個資料夾或清除篩選。']) {
    assert.ok(dictionary[message]?.en && dictionary[message]?.ja, `新增入口缺少翻譯：${message}`);
  }
}

{
  const tagEpisode = createHarness();
  const { state, elements } = tagEpisode.hooks;
  const books = ['tag-a', 'tag-b', 'other-tag'].map((id, index) => ({
    id, title: id, sourceId: 'local:tag-episode', relativePath: `Shelf/${id}`,
  }));
  state.comics = books;
  state.currentPath = 'Shelf';
  state.currentSourceId = 'local:tag-episode';
  elements.searchInput.value = '';
  const groupTargets = books.slice(0, 2).map(comic => ({
    runtimeId: comic.id, sourceId: comic.sourceId, relativePath: comic.relativePath,
  }));
  tagEpisode.context.window.electronAPI.getDiscoveryTags = async () => [{
    namespace: 'general', value: 'Adventure', targets: groupTargets, comicIds: ['tag-a', 'tag-b'],
  }];
  elements.libraryTagDiscoveryPanel.hidden = true;
  await tagEpisode.hooks.toggleDiscoveryTags();
  elements.discoveryTagSelect.value = '0';
  vm.runInContext(`openReader = async comic => {
    window.tagEpisodeOpened.push(comic.id);
    state.currentComic = comic; state.pendingComicId = null; state.readerOperation += 1;
  }; window.tagEpisodeOpened = [];`, tagEpisode.context);
  await tagEpisode.hooks.openDiscoveryTag(false, () => 0);
  assert.equal(elements.readerDiscoveryNext.hidden, false, '選定 tag 範圍有其他作品時顯示 reader next');
  assert.equal(await tagEpisode.hooks.openNextDiscoveryComic(), true);
  assert.ok(['tag-a', 'tag-b'].includes(tagEpisode.context.window.tagEpisodeOpened[0]));
  assert.ok(['tag-a', 'tag-b'].includes(tagEpisode.context.window.tagEpisodeOpened[1]));
  assert.ok(tagEpisode.context.window.tagEpisodeOpened.every(id => id !== 'other-tag'), 'tag episode 不可越出選定 TAG 目標集合');
}
console.log('discovery scope, repeat, rapid activation and first-use copy tests passed');

{
  const h = createHarness();
  const { state, elements } = h.hooks;
  state.comics = ['one', 'two'].map(id => ({ id, title: id, relativePath: id, series: 'Series' }));
  elements.searchInput.value = '';
  const groups = [
    { namespace: 'general', value: 'Adventure', comicIds: ['one', 'foreign', 'one'] },
    { namespace: 'general', value: 'Adventure', comicIds: ['two'] },
    { namespace: 'genre', value: 'Comedy', comicIds: ['two'] },
    { namespace: 'general', value: 'Empty', comicIds: ['foreign'] },
  ];
  const normalized = h.hooks.normalizeDiscoveryTagGroups(groups, state.comics);
  assert.equal(normalized.length, 2);
  assert.deepEqual(Array.from(normalized.find(group => group.value === 'Adventure').comicIds), ['one', 'two']);
  const previous = JSON.stringify(['general', 'Adventure']);
  assert.equal(h.hooks.pickDiscoveryTag(normalized, previous, () => 0).value, 'Comedy');
  assert.equal(h.hooks.pickDiscoveryTag([], '', () => 0), null);
  h.context.window.electronAPI.getDiscoveryTags = async ids => {
    assert.deepEqual(Array.from(ids), ['one', 'two']);
    return groups;
  };
  elements.libraryTagDiscoveryPanel.hidden = true;
  await h.hooks.toggleDiscoveryTags();
  assert.equal(elements.libraryTagDiscoveryPanel.hidden, false);
  assert.equal(elements.discoveryTagPick.disabled, false);
  assert.match(elements.discoveryTagSelect.innerHTML, /Adventure/);
  vm.runInContext('openReader = async comic => { const id = comic.id || comic; state.currentComic = state.comics.find(item => item.id === id); };', h.context);
  elements.discoveryTagSelect.value = String(normalized.findIndex(group => group.value === 'Comedy'));
  await h.hooks.openDiscoveryTag(false, () => 0);
  assert.equal(state.currentComic.id, 'two', '自選 TAG 只能抽該 TAG 內作品');
  state.currentComic = null;
  await h.hooks.openDiscoveryTag(true, () => 0);
  assert.equal(state.currentComic.id, 'one', '隨機 TAG 避開上一類型，也避開上一冊');
  state.currentComic = null;
  state.activeSeries = 'missing';
  await h.hooks.openDiscoveryTag(false, () => 0);
  assert.equal(state.currentComic, null, '候選範圍變更後舊 TAG 不能開書');
  assert.equal(elements.libraryTagDiscoveryPanel.hidden, true);
  state.activeSeries = 'all';
  let finish;
  h.context.window.electronAPI.getDiscoveryTags = () => new Promise(resolve => { finish = resolve; });
  const pending = h.hooks.toggleDiscoveryTags();
  h.hooks.closeDiscoveryTags();
  finish(groups);
  await pending;
  assert.equal(elements.libraryTagDiscoveryPanel.hidden, true, '關閉後遲到回覆不能重開面板');
  h.context.window.electronAPI.getDiscoveryTags = async () => [];
  await h.hooks.toggleDiscoveryTags();
  assert.equal(elements.discoveryTagRandom.disabled, true);
  assert.match(elements.discoveryTagStatus.textContent, /還沒有可用標籤/);
  h.hooks.closeDiscoveryTags();
  h.context.window.electronAPI.getDiscoveryTags = async () => { throw new Error('temporary catalog outage'); };
  await h.hooks.toggleDiscoveryTags();
  assert.match(elements.discoveryTagStatus.textContent, /標籤暫時讀不到/);
  assert.equal(elements.discoveryTagPick.disabled, true);
  assert.equal(elements.libraryTagDiscoveryPanel.hidden, false);
}
{
  const h = createHarness();
  const sourceA = { id: 'shared', title: 'A', sourceId: 'external:a', relativePath: 'A/book.cbz' };
  const sourceB = { id: 'shared', title: 'B', sourceId: 'external:b', relativePath: 'B/book.cbz' };
  const groups = h.hooks.normalizeDiscoveryTagGroups([
    {
      namespace: 'general',
      value: 'Only A',
      targets: [{ runtimeId: 'shared', sourceId: 'external:a', relativePath: 'A/book.cbz' }],
      comicIds: ['shared'],
    },
  ], [sourceA, sourceB]);
  assert.equal(groups.length, 1, '來源限定 TAG 應保留有效群組');
  assert.equal(groups[0].targets.length, 1);
  assert.equal(groups[0].targets[0].runtimeId, 'shared');
  assert.equal(groups[0].targets[0].sourceId, 'external:a');
  assert.equal(groups[0].targets[0].relativePath, 'A/book.cbz');
  assert.equal(groups[0].comicIds.length, 1, 'TAG 群組只應保留來源限定候選');
  assert.equal(h.hooks.normalizeDiscoveryTagGroups([
    {
      namespace: 'general',
      value: 'Slash variant',
      targets: [{ runtimeId: 'shared', sourceId: 'external:a', relativePath: 'A//book.cbz' }],
      comicIds: ['shared'],
    },
  ], [sourceA]).length, 0, '來源路徑斜線變體不可被正規化成同一候選');
}
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  elements.searchInput.value = '';
  elements.libraryTagDiscoveryPanel.hidden = true;
  state.comics = Array.from({ length: 1001 }, (_, i) => ({ id: `book-${i}`, title: `Book ${i}`, relativePath: `Book${i}` }));
  const batches = [];
  h.context.window.electronAPI.getDiscoveryTags = async ids => {
    batches.push(ids.length);
    return [{ namespace: 'general', value: '<unsafe & tag>', comicIds: Array.from(ids) }];
  };
  await h.hooks.toggleDiscoveryTags();
  assert.deepEqual(batches, [1000, 1], '超過1000本分批取得標籤，不能只看第一頁');
  assert.match(elements.discoveryTagSelect.innerHTML, /1001/);
  assert.match(elements.discoveryTagSelect.innerHTML, /&lt;unsafe &amp; tag&gt;/);
  assert.doesNotMatch(elements.discoveryTagSelect.innerHTML, /<unsafe/);
}
console.log('tag discovery selection, scope, stale response and empty/failure tests passed');

assert.equal(hooks.getCoverUrl('photos:YWxidW0'), 'gai://cover/photos:YWxidW0', '照片封面ID保留protocol可識別的冒號');
assert.notEqual(
  hooks.getCoverUrl('same-cover-id', 'local:one'),
  hooks.getCoverUrl('same-cover-id', 'smb:two'),
  '同 id 不同來源的 native 封面 URL 必須可區分',
);
assert.match(hooks.getCoverUrl('same-cover-id', 'smb:two'), /\?sourceId=smb%3Atwo$/);

// Inspector metadata must remain usable when optional related-tag suggestions
// fail. The suggestion lookup also has to wait for source-qualified metadata so
// an ambiguous runtime ID cannot block the metadata panel.
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  const metadataTarget = new FakeElement('section');
  elements.comicInspector.querySelector = selector => selector === '#inspector-metadata' ? metadataTarget : null;
  const comic = {
    id: 'runtime-shared',
    title: 'Shared comic',
    sourceId: 'local:root',
    relativePath: 'books/shared.cbz',
  };
  state.comics = [comic];
  state.selectedComicId = comic.id;
  state.selectedComicSourceId = comic.sourceId;
  let relatedId = null;
  h.context.window.electronAPI.getComicMetadata = async (id, sourceId, relativePath) => {
    assert.equal(id, comic.id);
    assert.equal(sourceId, comic.sourceId);
    assert.equal(relativePath, comic.relativePath);
    return {
      comicId: 'canonical-shared',
      sourceId: comic.sourceId,
      title: 'Shared comic',
      series: '',
      language: '',
      readingDirection: '',
      offline: false,
      creators: {},
      tags: [],
      candidates: [],
      lockedFields: [],
      diagnostics: [],
    };
  };
  h.context.window.electronAPI.listRelatedTags = async id => {
    relatedId = id;
    throw new Error('ambiguous runtime id');
  };
  await h.hooks.loadInspectorMetadata(comic);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relatedId, 'canonical-shared', 'related tags must use metadata canonical ID');
  assert.match(metadataTarget.innerHTML, /整理資料/, 'metadata must render when related tags fail');
  assert.match(metadataTarget.innerHTML, /標籤建議暫時無法載入/, 'tag failure must be visible and not presented as no suggestions');
  assert.doesNotMatch(metadataTarget.innerHTML, /metadata-suggestions/, 'failed suggestions must not render fake suggestion controls');
}

// A related-tag request that never resolves must not hold metadata hostage.
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  const metadataTarget = new FakeElement('section');
  elements.comicInspector.querySelector = selector => selector === '#inspector-metadata' ? metadataTarget : null;
  const comic = { id: 'never-tags', sourceId: 'local:root', relativePath: 'never-tags.cbz' };
  state.comics = [comic];
  state.selectedComicId = comic.id;
  state.selectedComicSourceId = comic.sourceId;
  h.context.window.electronAPI.getComicMetadata = async () => ({
    comicId: 'canonical-never-tags', sourceId: comic.sourceId, title: 'Never tags', series: '',
    language: '', readingDirection: '', offline: false, creators: {}, tags: [], candidates: [],
    lockedFields: [], diagnostics: [],
  });
  h.context.window.electronAPI.listRelatedTags = () => new Promise(() => {});
  await h.hooks.loadInspectorMetadata(comic);
  assert.match(metadataTarget.innerHTML, /整理資料/, 'metadata must render before a hanging tag request resolves');
  assert.match(metadataTarget.innerHTML, /正在載入標籤建議/, 'hanging tag request must remain visibly pending');
}

// A metadata failure still uses the metadata error path and must not invoke
// the optional related-tag API at all.
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  const metadataTarget = new FakeElement('section');
  elements.comicInspector.querySelector = selector => selector === '#inspector-metadata' ? metadataTarget : null;
  const comic = { id: 'metadata-failure', sourceId: 'local:root', relativePath: 'failure.cbz' };
  state.comics = [comic];
  state.selectedComicId = comic.id;
  state.selectedComicSourceId = comic.sourceId;
  let relatedCalls = 0;
  h.context.window.electronAPI.getComicMetadata = async () => { throw new Error('metadata unavailable'); };
  h.context.window.electronAPI.listRelatedTags = async () => { relatedCalls += 1; return []; };
  await h.hooks.loadInspectorMetadata(comic);
  assert.equal(relatedCalls, 0, 'related tags must not run after metadata failure');
  assert.match(metadataTarget.innerHTML, /無法驗證漫畫的穩定來源/, 'metadata failure must remain fail-closed');
}

// A bridge without listRelatedTags is an unavailable optional capability, not
// an empty suggestion result; metadata still renders with the warning.
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  const metadataTarget = new FakeElement('section');
  elements.comicInspector.querySelector = selector => selector === '#inspector-metadata' ? metadataTarget : null;
  const comic = { id: 'missing-tags-api', sourceId: 'local:root', relativePath: 'missing-tags.cbz' };
  state.comics = [comic];
  state.selectedComicId = comic.id;
  state.selectedComicSourceId = comic.sourceId;
  h.context.window.electronAPI.getComicMetadata = async () => ({
    comicId: 'canonical-missing-tags', sourceId: comic.sourceId, title: 'No tag API', series: '',
    language: '', readingDirection: '', offline: false, creators: {}, tags: [], candidates: [],
    lockedFields: [], diagnostics: [],
  });
  delete h.context.window.electronAPI.listRelatedTags;
  await h.hooks.loadInspectorMetadata(comic);
  assert.match(metadataTarget.innerHTML, /整理資料/, 'metadata must render without related-tag API');
  assert.match(metadataTarget.innerHTML, /標籤建議暫時無法載入/, 'missing related-tag API must be visible');
}

// A selection change while the optional query is in flight must prevent a
// stale metadata response from committing to the inspector.
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  const metadataTarget = new FakeElement('section');
  elements.comicInspector.querySelector = selector => selector === '#inspector-metadata' ? metadataTarget : null;
  const comic = { id: 'stale-metadata', sourceId: 'local:root', relativePath: 'stale.cbz' };
  state.comics = [comic];
  state.selectedComicId = comic.id;
  state.selectedComicSourceId = comic.sourceId;
  h.context.window.electronAPI.getComicMetadata = async () => ({
    comicId: 'canonical-stale', sourceId: comic.sourceId, title: 'Stale', series: '',
    language: '', readingDirection: '', offline: false, creators: {}, tags: [], candidates: [],
    lockedFields: [], diagnostics: [],
  });
  h.context.window.electronAPI.listRelatedTags = async () => {
    state.selectedComicId = 'another-selection';
    return [];
  };
  await h.hooks.loadInspectorMetadata(comic);
  const initialMarkup = metadataTarget.innerHTML;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(metadataTarget.innerHTML, initialMarkup, 'stale selection must not commit a late tag update');
}

// Re-entering the same source-qualified comic starts a new metadata request.
// A late suggestion response from the prior request must not overwrite the
// newer metadata even though the selected runtime id/source remain unchanged.
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  const metadataTarget = new FakeElement('section');
  elements.comicInspector.querySelector = selector => selector === '#inspector-metadata' ? metadataTarget : null;
  const comic = { id: 'reentered-metadata', sourceId: 'local:root', relativePath: 'reentered.cbz' };
  state.comics = [comic];
  state.selectedComicId = comic.id;
  state.selectedComicSourceId = comic.sourceId;
  const deferred = () => {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
  };
  const firstTags = deferred();
  const secondTags = deferred();
  let metadataCalls = 0;
  let relatedCalls = 0;
  h.context.window.electronAPI.getComicMetadata = async () => {
    metadataCalls += 1;
    const isFirst = metadataCalls === 1;
    return {
      comicId: isFirst ? 'canonical-old' : 'canonical-new',
      sourceId: comic.sourceId,
      title: isFirst ? 'Old metadata' : 'New metadata',
      series: '',
      language: '',
      readingDirection: '',
      offline: false,
      creators: {},
      tags: [],
      candidates: [],
      lockedFields: [],
      diagnostics: [],
    };
  };
  h.context.window.electronAPI.listRelatedTags = id => {
    relatedCalls += 1;
    assert.equal(id, relatedCalls === 1 ? 'canonical-old' : 'canonical-new');
    return relatedCalls === 1 ? firstTags.promise : secondTags.promise;
  };

  await h.hooks.loadInspectorMetadata(comic);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relatedCalls, 1, 'first metadata load must start its related-tag request');
  assert.match(metadataTarget.innerHTML, /Old metadata/);

  await h.hooks.loadInspectorMetadata(comic);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relatedCalls, 2, 're-entering the same comic must start a fresh related-tag request');
  assert.match(metadataTarget.innerHTML, /New metadata/, 'new metadata must replace the first render');

  firstTags.resolve([{
    tag: { namespace: 'general', value: 'old-suggestion' },
    sharedComics: 1,
    reason: 'old response',
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(metadataTarget.innerHTML, /New metadata/, 'late old suggestions must preserve new metadata');
  assert.doesNotMatch(metadataTarget.innerHTML, /old-suggestion/, 'late old suggestions must not overwrite the new render');

  secondTags.resolve([{
    tag: { namespace: 'general', value: 'new-suggestion' },
    sharedComics: 1,
    reason: 'new response',
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(metadataTarget.innerHTML, /New metadata/);
  assert.match(metadataTarget.innerHTML, /new-suggestion/, 'current suggestions may update the current metadata');
}

// A -> B -> A must still invalidate the first A request: selection checks
// alone cannot distinguish the old A response from the re-entered A request.
{
  const h = createHarness();
  const { state, elements } = h.hooks;
  const metadataTarget = new FakeElement('section');
  elements.comicInspector.querySelector = selector => selector === '#inspector-metadata' ? metadataTarget : null;
  const comicA = { id: 'aba-a', sourceId: 'local:root', relativePath: 'aba-a.cbz' };
  const comicB = { id: 'aba-b', sourceId: 'local:root', relativePath: 'aba-b.cbz' };
  state.comics = [comicA, comicB];
  const deferred = () => {
    let resolve;
    const promise = new Promise(nextResolve => { resolve = nextResolve; });
    return { promise, resolve };
  };
  const firstATags = deferred();
  const finalATags = deferred();
  let aMetadataCalls = 0;
  let relatedCalls = 0;
  h.context.window.electronAPI.getComicMetadata = async id => {
    if (id === comicA.id) {
      aMetadataCalls += 1;
      const isFirst = aMetadataCalls === 1;
      return {
        comicId: isFirst ? 'canonical-aba-a-old' : 'canonical-aba-a-new',
        sourceId: comicA.sourceId,
        title: isFirst ? 'ABA A old' : 'ABA A new',
        series: '', language: '', readingDirection: '', offline: false,
        creators: {}, tags: [], candidates: [], lockedFields: [], diagnostics: [],
      };
    }
    return {
      comicId: 'canonical-aba-b',
      sourceId: comicB.sourceId,
      title: 'ABA B',
      series: '', language: '', readingDirection: '', offline: false,
      creators: {}, tags: [], candidates: [], lockedFields: [], diagnostics: [],
    };
  };
  h.context.window.electronAPI.listRelatedTags = id => {
    relatedCalls += 1;
    if (relatedCalls === 1) {
      assert.equal(id, 'canonical-aba-a-old');
      return firstATags.promise;
    }
    if (relatedCalls === 2) {
      assert.equal(id, 'canonical-aba-b');
      return [];
    }
    assert.equal(id, 'canonical-aba-a-new');
    return finalATags.promise;
  };

  state.selectedComicId = comicA.id;
  state.selectedComicSourceId = comicA.sourceId;
  await h.hooks.loadInspectorMetadata(comicA);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relatedCalls, 1);

  state.selectedComicId = comicB.id;
  state.selectedComicSourceId = comicB.sourceId;
  await h.hooks.loadInspectorMetadata(comicB);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relatedCalls, 2);
  assert.match(metadataTarget.innerHTML, /ABA B/);

  state.selectedComicId = comicA.id;
  state.selectedComicSourceId = comicA.sourceId;
  await h.hooks.loadInspectorMetadata(comicA);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relatedCalls, 3);
  assert.match(metadataTarget.innerHTML, /ABA A new/);

  firstATags.resolve([{
    tag: { namespace: 'general', value: 'aba-old-suggestion' },
    sharedComics: 1,
    reason: 'old ABA response',
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(metadataTarget.innerHTML, /ABA A new/);
  assert.doesNotMatch(metadataTarget.innerHTML, /aba-old-suggestion/, 'old A response must stay invalid after A -> B -> A');

  finalATags.resolve([{
    tag: { namespace: 'general', value: 'aba-new-suggestion' },
    sharedComics: 1,
    reason: 'current ABA response',
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(metadataTarget.innerHTML, /aba-new-suggestion/);
}
