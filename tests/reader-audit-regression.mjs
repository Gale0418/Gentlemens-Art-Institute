import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appPath = new URL('../public/app.js', import.meta.url);
const source = fs.readFileSync(appPath, 'utf8');

function sectionBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

const progressFn = source.match(/function getProgressInfo\(comic\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(progressFn, 'getProgressInfo is present');
const progressContext = {};
vm.runInNewContext(`${progressFn}\nglobalThis.getProgressInfo = getProgressInfo;`, progressContext);

const onePageRead = progressContext.getProgressInfo({ pageCount: 1, progress: { currentPage: 0, totalPages: 1, percent: 0, updatedAt: '2026-10-02T00:00:00Z' } });
assert.equal(JSON.stringify(onePageRead), JSON.stringify({ currentPage: 0, totalPages: 1, percent: 100, hasProgress: true, isFinished: true }), 'opened one-page comic is finished using persisted updatedAt');
const onePageUnread = progressContext.getProgressInfo({ pageCount: 1, progress: { currentPage: 0, totalPages: 1, percent: 0, updatedAt: null } });
assert.equal(JSON.stringify(onePageUnread), JSON.stringify({ currentPage: 0, totalPages: 1, percent: 0, hasProgress: false, isFinished: false }), 'unopened one-page comic remains unread');
assert.equal(
  progressContext.getProgressInfo({ pageCount: 1, progress: { currentPage: 0, totalPages: 1, percent: 100, updatedAt: null } }).isFinished,
  true,
  'normalized one-page percent also proves completion'
);
assert.equal(
  progressContext.getProgressInfo({ pageCount: 3, progress: { currentPage: 0, totalPages: 3, updatedAt: '2026-10-02T00:00:00Z' } }).hasProgress,
  false,
  'multi-page zero-based page zero is still unread'
);
assert.equal(
  progressContext.getProgressInfo({ pageCount: 3, progress: { currentPage: 2, totalPages: 3, percent: 67 } }).isFinished,
  true,
  'last zero-based page is finished'
);

const cardKeyFn = sectionBetween('function getShelfCardRenderKey(comic) {', 'function getShelfCardTagName');
const cardContext = { isComicOffline: () => false, isFavoriteId: () => false };
vm.runInNewContext(`${progressFn}\n${cardKeyFn}\nglobalThis.getShelfCardRenderKey = getShelfCardRenderKey;`, cardContext);
assert.notEqual(
  cardContext.getShelfCardRenderKey({ id: 'one', title: 'One', pageCount: 1, progress: { currentPage: 0, totalPages: 1, percent: 0, updatedAt: null } }),
  cardContext.getShelfCardRenderKey({ id: 'one', title: 'One', pageCount: 1, progress: { currentPage: 0, totalPages: 1, percent: 100, updatedAt: '2026-10-02T00:00:00Z' } }),
  'one-page card render key changes after reading'
);

const importSection = sectionBetween('  // 相簿匯入', "  // 書架過濾器");
const sizeCheck = importSection.indexOf('file?.size');
const arrayBufferRead = importSection.indexOf('file.arrayBuffer()');
assert.ok(sizeCheck >= 0 && sizeCheck < arrayBufferRead, 'file size is checked before arrayBuffer allocation');
assert.match(importSection, /file\?\.size[\s\S]*MAX_IMPORTED_PHOTO_BYTES/);
assert.match(importSection, /saveImportedPhoto\(filename, data\)/);
assert.doesNotMatch(importSection, /Array\.from\(new Uint8Array/);
assert.match(importSection, /let importBusy = false/);
assert.match(importSection, /setScanRecoveryVisible\(true/);

const wheelSection = sectionBetween('function handleWheelScroll(e) {', 'function isLibraryModalVisible');
assert.ok(wheelSection.indexOf('readerViewportCanScroll()') < wheelSection.indexOf('e.preventDefault()'), 'zoomed single-page wheel keeps native scrolling');

console.log('PASS: single-page progress, import guards/Uint8Array/recovery, and zoom wheel regression checks');

// Exercise the raw IPC boundary with the real bridge method, including UTF-8
// filenames. The mock records the body identity to catch accidental copying.
const bridgeSource = fs.readFileSync(new URL('../public/tauri-api.js', import.meta.url), 'utf8');
const method = bridgeSource.slice(bridgeSource.indexOf('    saveImportedPhoto:'), bridgeSource.indexOf('    openExternalFolder:', bridgeSource.indexOf('    saveImportedPhoto:')));
const invocations = [];
const bridgeContext = {
  Uint8Array, TextEncoder, btoa,
  bridgeText: text => text,
  invoke: (...args) => { invocations.push(args); return Promise.resolve(); },
};
vm.runInNewContext(`globalThis.api = ({${method}});`, bridgeContext);
const bytes = new Uint8Array([1, 2, 3]);
await bridgeContext.api.saveImportedPhoto('照片.png', bytes);
assert.equal(invocations[0][0], 'import_photo_bytes');
assert.equal(invocations[0][1], bytes, 'IPC retains the typed buffer without Array.from or JSON');
assert.equal(Buffer.from(invocations[0][2].headers['x-gai-filename'], 'base64').toString('utf8'), '照片.png');
await assert.rejects(bridgeContext.api.saveImportedPhoto('photo.png', []));
await assert.rejects(bridgeContext.api.saveImportedPhoto('photo.png', new Uint8Array()));
await assert.rejects(bridgeContext.api.saveImportedPhoto('x'.repeat(201), bytes));
assert.equal(invocations.length, 1, 'invalid input does not call native IPC');

// Run the actual import event handler against minimal DOM controls.
function importHarness(api) {
  const callbacks = {};
  const button = { disabled: false, addEventListener: (event, fn) => { callbacks[`button:${event}`] = fn; }, setAttribute() {}, removeAttribute() {}, click() {} };
  const input = { value: 'selected', addEventListener: (event, fn) => { callbacks[event] = fn; }, click() {} };
  const errors = [], recovery = [];
  let hidden = 0, fetched = 0;
  const context = {
    document: { getElementById: id => id === 'import-photo-btn' ? button : input },
    eAPI: api, MAX_IMPORTED_PHOTO_BYTES: 64 * 1024 * 1024, Uint8Array,
    readerText: text => text, showLoader() {}, hideLoader() { hidden++; },
    fetchLibrary: async () => { fetched++; },
    setScanRecoveryVisible: (...args) => recovery.push(args),
    alert: error => errors.push(error), console: { error() {} },
  };
  vm.runInNewContext(importSection, context);
  return { callbacks, button, input, errors, recovery, get hidden() { return hidden; }, get fetched() { return fetched; } };
}
let allocated = false;
const invalidImport = importHarness({ saveImportedPhoto: async () => { throw new Error('must not write'); } });
await invalidImport.callbacks.change({ target: { files: [{ size: 64 * 1024 * 1024 + 1, arrayBuffer() { allocated = true; } }] } });
assert.equal(allocated, false, 'oversized file rejected before allocation');
assert.equal(invalidImport.errors.length, 1);
assert.equal(invalidImport.button.disabled, false);
assert.equal(invalidImport.input.value, '');

let finishWrite, writes = 0;
const validImport = importHarness({
  saveImportedPhoto: async (name, data) => { writes++; assert.ok(data instanceof Uint8Array); await new Promise(resolve => { finishWrite = resolve; }); },
  scanLibrary: async () => { throw new Error('source unavailable'); },
});
const photo = { size: 3, name: 'photo.png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
const inFlight = validImport.callbacks.change({ target: { files: [photo] } });
await Promise.resolve();
await Promise.resolve();
await validImport.callbacks.change({ target: { files: [photo] } });
assert.equal(writes, 1, 'busy import does not start a second write');
finishWrite();
await inFlight;
assert.equal(validImport.recovery.length, 1, 'failed rescan offers recovery without undoing saved photos');
assert.equal(validImport.fetched, 1, 'failed rescan still refreshes the current shelf snapshot');
assert.equal(validImport.hidden, 1);
assert.equal(validImport.button.disabled, false);
assert.equal(validImport.input.value, '', 'import input is reset by the actual finally cleanup');

const wheelFn = source.match(/function handleWheelScroll\(e\) \{[\s\S]*?\n\}/)[0];
let turns = 0, prevented = 0;
const wheelContext = { state: { readingMode: 'single' }, readerViewportCanScroll: () => true, nextPage: () => { turns++; }, prevPage: () => { turns++; }, cancelWebtoonAnchor() {} };
vm.runInNewContext(`${wheelFn}\nglobalThis.wheel = handleWheelScroll;`, wheelContext);
wheelContext.wheel({ deltaY: 50, preventDefault() { prevented++; } });
assert.equal(prevented, 0);
assert.equal(turns, 0);
wheelContext.readerViewportCanScroll = () => false;
wheelContext.wheel({ deltaY: 50, preventDefault() { prevented++; } });
assert.equal(prevented, 1);
assert.equal(turns, 1);
console.log('PASS: raw IPC buffer identity/Unicode names, import lifecycle/failure recovery, and wheel behavior');

const config = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const connectSources = config.app.security.csp.split(';').find(part => part.trim().startsWith('connect-src '));
assert.match(connectSources, /(?:^|\s)ipc:(?:\s|$)/);
assert.match(connectSources, /(?:^|\s)http:\/\/ipc\.localhost(?:\s|$)/);
console.log('PASS: CSP permits Tauri binary IPC transport');

// iPad settings must finish independently of the desktop scan-path editor.
const settingsFunctions = ['isIOSLibraryDevice', 'configureSettingsSourceControls', 'openSettingsModal', 'closeSettingsModal', 'chooseLibrarySource']
  .map(name => {
    const fn = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(fn, `${name} is present`);
    return fn;
  }).join('\n');
const modalFocusableFn = source.match(/function isLibraryModalElementFocusable\(element\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(modalFocusableFn);
const documentAncestor = { nodeType: 9 };
const htmlAncestor = { nodeType: 1, parentElement: null, parentNode: documentAncestor };
const modalAncestor = { nodeType: 1, parentElement: htmlAncestor, parentNode: htmlAncestor };
const modalButton = { nodeType: 1, parentElement: modalAncestor, parentNode: modalAncestor };
const styleNodes = [];
const modalFocusContext = { getComputedStyle: node => {
  assert.equal(node.nodeType, 1, 'getComputedStyle only accepts Element nodes, never Document');
  styleNodes.push(node);
  return { display: 'block', visibility: 'visible' };
} };
vm.runInNewContext(`${modalFocusableFn}\nglobalThis.focusable = isLibraryModalElementFocusable;`, modalFocusContext);
assert.equal(modalFocusContext.focusable(modalButton), true);
assert.deepEqual(styleNodes, [modalButton, modalAncestor, htmlAncestor]);
modalAncestor.hidden = true;
assert.equal(modalFocusContext.focusable(modalButton), false, 'hidden modal ancestors remain excluded');
modalAncestor.hidden = false;
const settingsClickBinding = source.match(/elements\.saveSettingsBtn\?\.addEventListener\('click', closeSettingsModal\);/)?.[0];
assert.ok(settingsClickBinding, 'settings completion runs the production close handler');
function settingsHarness(navigator, nativeBookmarks = true) {
  const callbacks = {}, calls = [];
  const savedBookmarks = [{ bookmark: 'existing', name: 'Library' }];
  const originalBookmarks = JSON.parse(JSON.stringify(savedBookmarks));
  const elements = {
    settingsModal: { style: { display: 'none' } }, closeSettingsBtn: {},
    saveSettingsBtn: { hidden: true, addEventListener: (event, fn) => { callbacks[event] = fn; } },
    scanPathRow: { hidden: false }, scanDirInput: { value: '' },
    librarySourceBtn: { disabled: false, setAttribute() {}, removeAttribute() {} },
    fallbackFolderBrowser: { style: { display: 'none' } }, scanDirStatus: { textContent: '' },
    librarySourceLabel: { removeAttribute: key => calls.push(`remove:${key}`) },
  };
  const context = {
    navigator, elements, state: { comics: ['kept'], bookmarks: savedBookmarks },
    document: { activeElement: 'opener' },
    window: nativeBookmarks ? { electronAPI: { openExternalFolder: () => {} } } : {},
    eAPI: { getConfig: async () => { calls.push('getConfig'); return { scanDir: '/Volumes/Comics' }; } },
    openLibraryModal: () => calls.push('open'), closeLibraryModal: () => calls.push('close'),
    focusLibraryModalEntry: () => {}, renderExternalBookmarks: () => {}, refreshAiSessionStatus: () => {},
    fetchBrowserFolders: async () => calls.push('browse'), console,
    addIOSLibrarySource: async () => calls.push('bookmarks'), chooseNativeLibrarySource: async () => calls.push('nativeFolder'),
    readerText: text => text,
  };
  vm.runInNewContext(`${settingsFunctions}\n${settingsClickBinding}\nglobalThis.open = openSettingsModal;\nglobalThis.chooseSource = chooseLibrarySource;`, context);
  return { context, callbacks, elements, calls, savedBookmarks, originalBookmarks };
}
for (const navigator of [
  { userAgent: 'iPad', platform: 'iPad', maxTouchPoints: 5 },
  { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 },
]) {
  const h = settingsHarness(navigator);
  await h.context.open();
  assert.equal(h.elements.scanPathRow.hidden, true, 'iPad hides desktop absolute-path editing');
  assert.equal(h.elements.saveSettingsBtn.hidden, false, 'iPad exposes a completion action in the fixed header');
  assert.deepEqual(h.calls, ['open', 'remove:for'], 'iPad settings must not wait for filesystem config/browse');
  h.callbacks.click();
  assert.equal(h.elements.settingsModal.style.display, 'none', 'one completion click returns to the shelf');
  assert.equal(h.calls.filter(call => call === 'close').length, 1);
  assert.equal(h.context.state.bookmarks, h.savedBookmarks, 'completion preserves existing external sources');
  assert.deepEqual(h.context.state.bookmarks, h.originalBookmarks, 'completion preserves bookmark contents without in-place removals');
  assert.deepEqual(h.context.state.comics, ['kept'], 'completion preserves the current shelf and background scan');
  await h.context.chooseSource();
  assert.equal(h.calls.at(-1), 'bookmarks', 'native iPad source selection still uses the bookmark API');
  assert.equal(h.elements.librarySourceBtn.disabled, false);
}
const desktopSettings = settingsHarness({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 });
await desktopSettings.context.open();
assert.equal(desktopSettings.elements.scanPathRow.hidden, false);
assert.equal(desktopSettings.elements.saveSettingsBtn.hidden, true);
assert.equal(desktopSettings.elements.scanDirInput.value, '/Volumes/Comics');
assert.deepEqual(desktopSettings.calls, ['open', 'getConfig', 'browse'], 'desktop directory editor behavior is retained');
const browserIpadSettings = settingsHarness({ userAgent: 'iPad', platform: 'iPad', maxTouchPoints: 5 }, false);
await browserIpadSettings.context.open();
assert.equal(browserIpadSettings.elements.scanPathRow.hidden, false, 'iPad browser without the bookmark API retains HTTP path editing');
assert.equal(browserIpadSettings.elements.saveSettingsBtn.hidden, true);
assert.equal(browserIpadSettings.elements.scanDirInput.value, '/Volumes/Comics');
assert.deepEqual(browserIpadSettings.calls, ['open', 'getConfig', 'browse']);
await browserIpadSettings.context.chooseSource();
assert.equal(browserIpadSettings.elements.fallbackFolderBrowser.style.display, 'flex', 'iPad browser source selection opens its supported folder browser');
assert.deepEqual(browserIpadSettings.calls, ['open', 'getConfig', 'browse', 'browse']);
assert.equal(browserIpadSettings.elements.librarySourceBtn.disabled, false);
const settingsCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
assert.match(settingsCss, /#scan-path-row\[hidden\],\s*#save-settings-btn\[hidden\]\s*\{\s*display: none;/,
  'author flex styles must not override hidden settings controls');
const settingsHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const settingsHeaderHtml = settingsHtml.match(/<div class="modal-header">([\s\S]*?)<div class="modal-body">/)?.[1];
assert.ok(settingsHeaderHtml, 'settings header exists');
const settingsActionsHtml = settingsHeaderHtml.match(/<div class="settings-header-actions">([\s\S]*?)<\/div>/)?.[1];
assert.ok(settingsActionsHtml, 'settings action container is nested in the fixed header');
assert.match(settingsActionsHtml, /<button\b[^>]*\bid="save-settings-btn"[^>]*>[^<]*<\/button>/,
  'completion is a button inside the header actions, not a nearby sibling or scrolling-body element');
console.log('PASS: iPad completion returns to shelf without path validation or scan mutation; desktop path controls retained');

const sourcePosition = settingsHtml.indexOf('class="input-group library-source-settings"');
assert.ok(sourcePosition > settingsHtml.indexOf('class="language-settings"'));
assert.ok(sourcePosition < settingsHtml.indexOf('class="theme-settings"'), 'source setup precedes optional appearance choices');
assert.ok(sourcePosition < settingsHtml.indexOf('id="commerce-settings"'), 'adding books does not require scrolling past the sales section');
for (const selector of ['.external-bookmark-remove', '.library-source-advanced summary']) {
  const rule = settingsCss.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))?.[1];
  assert.ok(rule, `${selector} has its own touch sizing rule`);
  assert.match(rule, /min-height:\s*44px;/, `${selector} preserves at least 44px height`);
  if (selector === '.external-bookmark-remove') assert.match(rule, /min-width:\s*44px;/);
}
console.log('PASS: source setup precedes Pro, and source controls retain named touch sizing');
