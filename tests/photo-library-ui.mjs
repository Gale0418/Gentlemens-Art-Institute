import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8');
const source = fs.readFileSync('public/photo-library.js', 'utf8');
const bridge = fs.readFileSync('public/tauri-api.js', 'utf8');

assert.match(html, /id="photo-library-link-btn"[^>]*hidden/, 'photo album entry starts hidden');
assert.match(html, /id="photo-library-modal"[^>]*role="dialog"[^>]*aria-modal="true"/, 'photo album dialog has modal semantics');
assert.match(html, /允許的照片/, 'limited access explanation names the native permission scope');
assert.match(html, /允許下載 iCloud 照片/, 'iCloud download option is visible');
assert.match(html, /tauri-api\.js"><\/script>\s*<script src="commerce\.js"><\/script>\s*<script src="app\.js"><\/script>\s*<script src="photo-library\.js">/, 'photo library module loads after app core');
assert.doesNotMatch(html, /八組示範|漫畫來源目前離線/, 'removed persistent notices stay absent');

assert.match(source, /function isIOSLibraryDevice\(\)/, 'entry is limited to iOS-class devices');
assert.match(source, /function normalizeAuthorization\(raw\)/, 'native authorization strings are normalized');
assert.match(source, /full: 'authorized'/, 'native full authorization is accepted');
assert.match(source, /authorized: 'authorized'/, 'native authorized authorization is accepted');
assert.match(source, /loadStatus\(false\)/, 'startup status check never requests permission');
assert.match(source, /loadStatus\(true\)/, 'permission request is deferred to the link action');
assert.match(source, /bridge\.setLinkedPhotoAlbums\(nextAlbumIds\)/, 'selected album IDs are saved explicitly');
assert.match(source, /bridge\.setPhotoNetworkAllowed\(nextAllowNetwork\)/, 'network preference is saved explicitly');
assert.match(source, /bridge\.setLinkedPhotoAlbums\(previousAlbumIds\)/, 'album update failure path attempts rollback');
assert.match(source, /refreshed = await loadStatus\(false\)/, 'save failures re-read native state');
assert.match(source, /部分設定未能復原/, 'rollback uncertainty is communicated honestly');
assert.match(source, /input\[data-photo-album-id\], #photo-library-network/, 'busy state disables editable photo controls');

assert.match(source, /gai:photo-library-changed/, 'successful link changes notify the main library');
assert.match(source, /title\.textContent = album\.title/, 'album names use safe text rendering');
assert.doesNotMatch(source, /\.innerHTML\s*[=+]/, 'photo album rendering does not inject HTML');
assert.match(source, /event\.key === 'Escape'/, 'Escape closes the dialog');
assert.match(source, /event\.key !== 'Tab'/, 'dialog handles Tab focus trapping');
assert.match(source, /opener\.focus\(\)/, 'closing restores focus to the triggering button');

assert.match(bridge, /getPhotoLibraryStatus: \(requestAuthorization = false\)/, 'native bridge exposes non-authorizing status by default');
assert.match(bridge, /setLinkedPhotoAlbums:/, 'native bridge exposes linked album persistence');
assert.match(bridge, /setPhotoNetworkAllowed:/, 'native bridge exposes iCloud network preference');
assert.match(css, /\.photo-library-overlay\[hidden\]\s*\{\s*display: none;/, 'dialog has an explicit hidden state');
assert.match(css, /\.photo-library-actions \.modal-action-btn[^}]*min-width: 120px/s, 'dialog actions have usable touch sizing');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(document, tagName, id = '') {
    this.ownerDocument = document;
    this.tagName = tagName.toLowerCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new FakeClassList();
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.type = '';
  }

  append(...nodes) {
    nodes.filter(Boolean).forEach(node => {
      node.parentNode = this;
      this.children.push(node);
    });
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
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
      shiftKey: false,
      preventDefault() { this.defaultPrevented = true; },
      ...detail,
    };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }

  click() { return this.dispatch('click'); }

  focus() { this.ownerDocument.activeElement = this; }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getClientRects() { return this.hidden ? [] : [{}]; }

  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }

  matches(selector) {
    if (selector === 'button') return this.tagName === 'button';
    if (selector === 'input[data-photo-album-id]') return this.tagName === 'input' && this.dataset.photoAlbumId !== undefined;
    if (selector === 'input[data-photo-album-id]:checked') return this.matches('input[data-photo-album-id]') && this.checked;
    if (selector === '#photo-library-network') return this.id === 'photo-library-network';
    if (selector === 'select' || selector === 'textarea') return this.tagName === selector;
    if (selector === '[href]') return this.attributes.has('href');
    if (selector.startsWith('[tabindex]')) return this.attributes.has('tabindex') && this.attributes.get('tabindex') !== '-1';
    return false;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    return this.descendants().filter(node => selectors.some(candidate => node.matches(candidate)));
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.listeners = new Map();
    this.activeElement = null;
    this.body = this.createElement('body', 'body');
  }

  createElement(tagName, id = '') {
    const element = new FakeElement(this, tagName, id);
    if (id) this.elements.set(id, element);
    return element;
  }

  getElementById(id) { return this.elements.get(id) || null; }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
}

function createDocument() {
  const document = new FakeDocument();
  const ids = [
    ['photo-library-link-btn', 'button'], ['photo-library-modal', 'div'],
    ['photo-library-close-btn', 'button'], ['photo-library-cancel-btn', 'button'],
    ['photo-library-save-btn', 'button'], ['photo-library-status', 'p'],
    ['photo-library-feedback', 'p'], ['photo-library-limited-note', 'div'],
    ['photo-library-albums', 'div'], ['photo-library-unavailable', 'section'],
    ['photo-library-unavailable-list', 'div'], ['photo-library-network', 'input'],
  ];
  const elements = Object.fromEntries(ids.map(([id, tag]) => [id, document.createElement(tag, id)]));
  elements['photo-library-network'].type = 'checkbox';
  elements['photo-library-modal'].append(
    elements['photo-library-close-btn'], elements['photo-library-cancel-btn'],
    elements['photo-library-save-btn'], elements['photo-library-status'],
    elements['photo-library-feedback'], elements['photo-library-limited-note'],
    elements['photo-library-albums'], elements['photo-library-unavailable'],
    elements['photo-library-network'],
  );
  elements['photo-library-unavailable'].append(elements['photo-library-unavailable-list']);
  return { document, elements };
}

function boot(api, l10n = null) {
  const { document, elements } = createDocument();
  const events = [];
  const window = {
    electronAPI: api,
    GAIL10n: l10n,
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    Event: class Event { constructor(type) { this.type = type; } },
    setTimeout,
    clearTimeout,
    dispatchEvent(event) { events.push(event.type); },
  };
  const context = vm.createContext({ window, document, navigator: { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 }, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'public/photo-library.js' });
  return { document, elements, events };
}

const flush = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

{
  const api = {
    getPhotoLibraryStatus: async () => ({ supported: true, authorization: 'full',
      albums: [
        { id: 'photo-library', title: '所有照片（照片圖庫）', count: 2 },
        { id: 'personal', title: '私人相簿', count: 1 },
      ], linkedAlbumIds: [], allowNetwork: false }),
    setLinkedPhotoAlbums: async () => ({ success: true }),
    setPhotoNetworkAllowed: async allowed => ({ allowed }),
  };
  const harness = boot(api, { t: source => source === '所有照片（照片圖庫）' ? 'All photos (Photo Library)' : source });
  await flush();
  harness.elements['photo-library-link-btn'].click();
  await flush();
  const rows = harness.elements['photo-library-albums'].children;
  assert.equal(rows[0].children[1].children[0].textContent, 'All photos (Photo Library)');
  assert.equal(rows[1].children[1].children[0].textContent, '私人相簿', 'personal album names remain untouched');
}

{
  const calls = [];
  const api = {
    getPhotoLibraryStatus: async requestAuthorization => {
      calls.push(requestAuthorization);
      return { supported: true, authorization: 'full', albums: [{ id: 'a', title: '<私人相簿>', count: 0 }], linkedAlbumIds: [], allowNetwork: false };
    },
    setLinkedPhotoAlbums: async () => ({ success: true }),
    setPhotoNetworkAllowed: async allowed => ({ allowed }),
  };
  const harness = boot(api);
  await flush();
  assert.deepEqual(calls, [false], 'startup status check does not request authorization');
  assert.equal(harness.elements['photo-library-link-btn'].hidden, false, 'native-supported iOS entry is shown');
  harness.elements['photo-library-link-btn'].click();
  await flush();
  assert.deepEqual(calls, [false, true], 'link action requests authorization');
  assert.equal(harness.elements['photo-library-modal'].hidden, false, 'successful status opens the dialog');
  assert.equal(harness.elements['photo-library-status'].textContent, '選擇想在書庫中閱讀的相簿。');
  assert.equal(harness.elements['photo-library-albums'].children[0].children[1].children[0].textContent, '<私人相簿>', 'full authorization renders the native album title safely');
  assert.equal(harness.elements['photo-library-network'].disabled, false, 'network option is editable when idle');
}

{
  let resolveAlbums;
  const linkedCalls = [];
  const api = {
    getPhotoLibraryStatus: async requestAuthorization => ({ supported: true, authorization: 'authorized', albums: [{ id: 'a', title: '空相簿', count: 0 }], linkedAlbumIds: requestAuthorization ? ['a'] : [], allowNetwork: false }),
    setLinkedPhotoAlbums: ids => { linkedCalls.push(ids); return new Promise(resolve => { resolveAlbums = resolve; }); },
    setPhotoNetworkAllowed: async allowed => ({ allowed }),
  };
  const harness = boot(api);
  await flush();
  harness.elements['photo-library-link-btn'].click();
  await flush();
  const albumCheckbox = harness.elements['photo-library-albums'].querySelectorAll('input[data-photo-album-id]')[0];
  albumCheckbox.checked = false;
  albumCheckbox.dispatch('change');
  harness.elements['photo-library-save-btn'].click();
  assert.equal(linkedCalls.length, 1, 'empty selection is submitted explicitly');
  assert.deepEqual([...linkedCalls[0]], [], 'empty selection is submitted explicitly');
  assert.equal(albumCheckbox.disabled, true, 'busy save locks album checkbox');
  assert.equal(harness.elements['photo-library-network'].disabled, true, 'busy save locks network option');
  resolveAlbums({ success: true });
  await flush();
  assert.equal(harness.elements['photo-library-save-btn'].disabled, false, 'controls unlock after save');
}

{
  const statusCalls = [];
  let firstSave = true;
  const api = {
    getPhotoLibraryStatus: async requestAuthorization => {
      statusCalls.push(requestAuthorization);
      return { supported: true, authorization: 'authorized', albums: [{ id: 'a', title: '原本相簿', count: 1 }], linkedAlbumIds: ['a'], allowNetwork: false };
    },
    setLinkedPhotoAlbums: async ids => {
      if (firstSave && ids.length === 0) { firstSave = false; throw new Error('native write failed'); }
      throw new Error('rollback failed');
    },
    setPhotoNetworkAllowed: async allowed => ({ allowed }),
  };
  const harness = boot(api);
  await flush();
  harness.elements['photo-library-link-btn'].click();
  await flush();
  const albumCheckbox = harness.elements['photo-library-albums'].querySelectorAll('input[data-photo-album-id]')[0];
  albumCheckbox.checked = false;
  albumCheckbox.dispatch('change');
  harness.elements['photo-library-save-btn'].click();
  await flush();
  assert.deepEqual(statusCalls, [false, true, false], 'failed save re-reads native status without requesting permission');
  assert.match(harness.elements['photo-library-feedback'].textContent, /部分設定未能復原/, 'partial rollback is reported honestly');
  assert.equal(harness.events.includes('gai:photo-library-changed'), true, 'failed save still asks the main library to refresh');
}

{
  const harness = boot({
    getPhotoLibraryStatus: async () => ({ supported: true, authorization: 'full', albums: [], linkedAlbumIds: ['private-native-id'], allowNetwork: false }),
    setLinkedPhotoAlbums: async () => ({ success: true }),
    setPhotoNetworkAllowed: async allowed => ({ allowed }),
  });
  await flush();
  harness.elements['photo-library-link-btn'].click();
  await flush();
  const row = harness.elements['photo-library-unavailable-list'].children[0];
  assert.equal(row.children[1].children[0].textContent, '目前無法存取的相簿 1', 'unavailable albums display an ordinal rather than native identifiers');
}

console.log('PASS: photo library behavior covers deferred authorization, full status rendering, empty selection, busy locks, and native-state recovery');
