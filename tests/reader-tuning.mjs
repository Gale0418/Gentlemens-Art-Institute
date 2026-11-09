import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const localeSource = fs.readFileSync(new URL('../public/locales/interface-messages.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing app function ${name}`);
  const end = appSource.indexOf('\n}', start);
  assert.ok(end > start, `missing function end ${name}`);
  return appSource.slice(start, end + 2);
}

const messages = {};
vm.runInNewContext(localeSource, {
  window: { GAIL10n: { register: entries => Object.assign(messages, entries) } },
});
const zh = key => messages[key]?.['zh-Hant'];
for (const key of ['ui.sharpenOff', 'ui.sharpenLow', 'ui.sharpenMedium', 'ui.sharpenHigh']) {
  assert.equal(typeof zh(key), 'string', `locale provides ${key}`);
}

function classList() {
  const values = new Set();
  return {
    values,
    add: (...tokens) => tokens.forEach(token => values.add(token)),
    remove: (...tokens) => tokens.forEach(token => values.delete(token)),
    toggle(token, force) {
      const shouldAdd = force === undefined ? !values.has(token) : Boolean(force);
      if (shouldAdd) values.add(token);
      else values.delete(token);
      return shouldAdd;
    },
  };
}

const output = {
  brightness: { textContent: '' },
  sharpen: { textContent: '' },
  rotation: { textContent: '' },
  aiHint: { hidden: false, textContent: '' },
};
const image = { style: {} };
const overlayClasses = classList();
const icon = { className: '' };
const brightnessButton = { value: null, attrs: {}, classList: classList(), setAttribute(name, value) { this.attrs[name] = value; } };
const sharpenButton = {
  value: null, attrs: {}, style: {}, classList: classList(),
  setAttribute(name, value) { this.attrs[name] = value; },
};
const fitButton = { value: null, title: '', querySelector: selector => selector === 'i' ? icon : null };
const elements = {
  readerOverlay: { style: { display: 'flex' }, classList: overlayClasses },
  btnBrightness: brightnessButton,
  btnSharpen: sharpenButton,
  btnFitMode: fitButton,
  btnAiExplain: { disabled: false, title: '' },
  pagesContainer: { querySelectorAll: selector => selector === 'img' ? [image] : [] },
  progressSlider: null,
  zoomValue: { textContent: '' },
};
const documentNodes = {
  'reader-brightness-value': output.brightness,
  'reader-sharpen-value': output.sharpen,
  'reader-rotation-value': output.rotation,
  'reader-ai-hint': output.aiHint,
};
const storage = new Map();
const writes = [];
const calls = { effect: [], fitRefresh: 0, toast: [], pages: 0, previous: 0, fullscreen: 0, fitShortcut: 0 };
const state = { brightness: 100, sharpenLevel: 0, rotationAngle: 90, fitMode: 'contain', readingMode: 'single', zoomPercentage: 100 };
let panelOpen = false;
const navigation = [];

const context = {
  state,
  elements,
  readerPanels: { isOpen: () => panelOpen },
  document: { getElementById: id => documentNodes[id] || null },
  localStorage: { setItem(key, value) { storage.set(key, String(value)); writes.push([key, String(value)]); } },
  readerText(value) {
    if (Object.hasOwn(messages, value)) return zh(value);
    return value;
  },
  normalizedRotationAngle: () => ((state.rotationAngle % 360) + 360) % 360,
  imageFilterValue: () => `brightness(${state.brightness}%)`,
  applyImageEffects: img => { calls.effect.push({ brightness: state.brightness, target: img }); img.style.filter = `brightness(${state.brightness}%)`; },
  scheduleReaderImageTransformRefresh: () => { calls.fitRefresh++; },
  refreshReaderImageTransforms: () => { calls.fitRefresh++; },
  showReaderToast: message => calls.toast.push(message),
  getActiveLibraryModal: () => null,
  goPreviousByReadingDirection: () => { calls.previous++; },
  goNextByReadingDirection: () => navigation.push('next'),
  jumpToFirstPage: () => navigation.push('first'),
  jumpToLastPage: () => navigation.push('last'),
  nextPage: () => { calls.pages++; },
  toggleFullscreen: () => { calls.fullscreen++; },
  toggleFitMode: () => { calls.fitShortcut++; },
  rotateImage() {},
  cancelWebtoonAnchorFromUserInput() {},
  clearTimeout() {},
  console,
};

const functions = [
  'syncReaderTuningControls', 'setReaderBrightness', 'setReaderSharpenLevel',
  'applySharpenFilter', 'setReaderFitMode', 'applyFitMode', 'cycleBrightness', 'handleKeyDown', 'adjustZoom',
].map(extractFunction).join('\n');
vm.runInNewContext(`${functions}
  globalThis.sync = syncReaderTuningControls;
  globalThis.setBrightness = setReaderBrightness;
  globalThis.setSharpen = setReaderSharpenLevel;
  globalThis.setFit = setReaderFitMode;
  globalThis.cycleBrightness = cycleBrightness;
  globalThis.keydown = handleKeyDown;`, context);

// Real control synchronization updates values, accessible value text, outputs, and locale-backed sharpening labels.
context.sync();
assert.equal(output.brightness.textContent, '100%');
assert.equal(brightnessButton.value, 100);
assert.equal(brightnessButton.attrs['aria-valuetext'], '100%');
assert.equal(output.sharpen.textContent, zh('ui.sharpenOff'));
assert.equal(sharpenButton.value, 0);
assert.equal(sharpenButton.attrs['aria-valuetext'], zh('ui.sharpenOff'));
assert.equal(output.rotation.textContent, '90°');
assert.equal(fitButton.value, 'contain');

// Brightness clamps to 70..115, snaps in five point steps, persists, refreshes images, and syncs exposed controls.
for (const [input, expected] of [[69, 70], [72, 70], [73, 75], [113, 115], [116, 115]]) {
  assert.equal(context.setBrightness(input), true);
  assert.equal(state.brightness, expected);
  assert.equal(storage.get('readerBrightness'), String(expected));
  assert.equal(brightnessButton.value, expected);
  assert.equal(brightnessButton.attrs['aria-valuetext'], `${expected}%`);
  assert.equal(output.brightness.textContent, `${expected}%`);
  assert.equal(calls.effect.at(-1).brightness, expected, 'image effect sees the committed brightness');
  assert.equal(calls.effect.at(-1).target, image);
  assert.equal(image.style.filter, `brightness(${expected}%)`);
}
for (const invalid of ['not-a-number', undefined, Infinity, NaN]) {
  const before = { brightness: state.brightness, writes: writes.length, effects: calls.effect.length };
  assert.equal(context.setBrightness(invalid), false, `rejects ${String(invalid)}`);
  assert.equal(state.brightness, before.brightness);
  assert.equal(writes.length, before.writes, 'invalid brightness does not persist');
  assert.equal(calls.effect.length, before.effects, 'invalid brightness does not refresh images');
}
state.brightness = 70;
context.cycleBrightness();
assert.equal(state.brightness, 115, 'brightness cycle advances from 70 to 115');
assert.equal(storage.get('readerBrightness'), '115');
state.brightness = 115;
context.cycleBrightness();
assert.equal(state.brightness, 100, 'brightness cycle wraps back to 100');

// Sharpening executes the real effect helper and keeps its four-step control/output in sync.
for (let level = 0; level <= 3; level++) {
  assert.equal(context.setSharpen(level), true);
  assert.equal(state.sharpenLevel, level);
  assert.equal(sharpenButton.value, level);
  assert.equal(output.sharpen.textContent, zh(['ui.sharpenOff', 'ui.sharpenLow', 'ui.sharpenMedium', 'ui.sharpenHigh'][level]));
  assert.equal(sharpenButton.attrs['aria-valuetext'], output.sharpen.textContent);
  assert.equal(image.style.imageRendering, ['auto', 'auto', '-webkit-optimize-contrast', 'pixelated'][level]);
  assert.equal(image.style.filter, 'brightness(100%)');
}
for (const invalid of ['bad', undefined, Infinity, NaN]) {
  const before = { level: state.sharpenLevel, writes: writes.length, effects: calls.effect.length, style: image.style.imageRendering };
  assert.equal(context.setSharpen(invalid), false);
  assert.equal(state.sharpenLevel, before.level);
  assert.equal(writes.length, before.writes, 'sharpen helper has no storage write for invalid values');
  assert.equal(calls.effect.length, before.effects, 'sharpen helper does not change brightness effect path');
  assert.equal(image.style.imageRendering, before.style);
}

// Fit mode validates its enum, persists valid modes, updates its class/control, and rejects restricted reader modes.
for (const mode of ['width', 'height', 'contain']) {
  assert.equal(context.setFit(mode), true);
  assert.equal(state.fitMode, mode);
  assert.equal(storage.get('readerFitMode'), mode);
  assert.equal(fitButton.value, mode);
  assert.equal(overlayClasses.values.has(`fit-${mode}`), true);
}
for (const invalid of ['cover', '', null, 1]) {
  const before = { mode: state.fitMode, writes: writes.length, refreshes: calls.fitRefresh };
  assert.equal(context.setFit(invalid), false);
  assert.equal(state.fitMode, before.mode);
  assert.equal(writes.length, before.writes, 'invalid fit mode does not persist');
  assert.equal(calls.fitRefresh, before.refreshes, 'invalid fit mode does not render');
}
for (const restrictedMode of ['webtoon', 'catalog']) {
  state.readingMode = restrictedMode === 'webtoon' ? 'webtoon' : 'single';
  state.catalogOpen = restrictedMode === 'catalog';
  state.fitMode = 'height';
  const before = { writes: writes.length, refreshes: calls.fitRefresh };
  assert.equal(context.setFit('contain'), false);
  assert.equal(state.fitMode, 'height', `${restrictedMode} keeps current fit mode`);
  assert.equal(writes.length, before.writes);
  assert.equal(calls.fitRefresh, before.refreshes);
}
state.readingMode = 'single';
for (const restrictedMode of ['webtoon', 'catalog']) {
  state.readingMode = restrictedMode === 'webtoon' ? 'webtoon' : 'single';
  state.catalogOpen = restrictedMode === 'catalog';
  const before = calls.fitRefresh;
  context.adjustZoom(10);
  assert.equal(state.zoomPercentage, 100, `${restrictedMode} ignores zoom changes`);
  assert.equal(calls.fitRefresh, before);
}
state.readingMode = 'single';
state.catalogOpen = false;
context.adjustZoom(10);
assert.equal(state.zoomPercentage, 110, 'single-page zoom remains available');
assert.equal(elements.zoomValue.textContent, '110%');

function target({ tagName = 'DIV', panel = false, button = false, id = '' } = {}) {
  const panelNode = panel ? {} : null;
  const buttonNode = button ? {} : null;
  return {
    tagName, id, isContentEditable: false,
    closest(selector) {
      if (selector === '[data-reader-panel]') return panelNode;
      if (selector === 'button') return buttonNode;
      return null;
    },
  };
}
function key(key, eventTarget) {
  return { key, target: eventTarget, prevented: false, preventDefault() { this.prevented = true; } };
}

const panelRange = target({ tagName: 'INPUT', panel: true });
const panelSelect = target({ tagName: 'SELECT', panel: true });
const panelButton = target({ tagName: 'BUTTON', panel: true, button: true });
panelOpen = true;
for (const keyboardKey of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' ', 'Spacebar']) {
  context.keydown(key(keyboardKey, target()));
}
assert.equal(calls.pages, 0, 'open panel blocks canvas Space when WebKit leaves focus on the overlay');
assert.equal(calls.previous, 0, 'open panel blocks previous-page navigation despite lost control focus');
assert.deepEqual(navigation, [], 'open panel blocks all reader navigation keys despite lost control focus');
panelOpen = false;
for (const [keyboardKey, eventTarget] of [
  ['ArrowLeft', panelRange], ['ArrowRight', panelRange], ['ArrowUp', panelSelect],
  ['ArrowDown', panelSelect], [' ', panelRange], [' ', panelButton], ['Enter', panelButton],
]) {
  context.keydown(key(keyboardKey, eventTarget));
  assert.equal(calls.pages, 0, `${keyboardKey} inside panel controls does not page`);
  assert.equal(calls.previous, 0);
}
context.keydown(key(' ', target()));
assert.equal(calls.pages, 1, 'canvas Space still advances the page');
const fKey = key('F', panelButton);
context.keydown(fKey);
assert.equal(calls.fullscreen, 1, 'F remains active while a panel button is focused');
assert.equal(fKey.prevented, true);
const mKey = key('M', panelButton);
context.keydown(mKey);
assert.equal(calls.fitShortcut, 1, 'M remains active while a panel button is focused');
assert.equal(mKey.prevented, true);

// A visible keyboard header must not let the idle page-notice branch hide the
// scrubber. Wake both bars before enumerating the normal Tab destinations.
{
  const order = [];
  const classes = classList();
  classes.add('reader-idle', 'reader-page-notice');
  const first = { focus() {} };
  const last = { focus() {} };
  const overlay = { style: { display: 'flex' }, classList: classes, contains: () => true };
  const scope = {
    elements: { readerOverlay: overlay },
    document: { activeElement: first },
    triggerControlsActive() { order.push('wake'); classes.remove('reader-idle', 'reader-page-notice'); },
    getReaderFocusableElements() { order.push('enumerate'); return [first, last]; },
    focusReaderEntry() { throw new Error('normal Tab must keep its native focus order'); },
  };
  vm.runInNewContext(`${extractFunction('trapReaderFocus')}\ntrapReaderFocus({ key: 'Tab', shiftKey: false, preventDefault() { throw new Error('normal Tab should not be cancelled'); } });`, scope);
  assert.deepEqual(order, ['wake', 'enumerate']);
  assert.equal(classes.values.has('reader-idle'), false);
  assert.equal(classes.values.has('reader-page-notice'), false);
}

console.log('PASS: reader tuning controls/effects/persistence and panel keyboard routing');
console.log('LIMIT: GPU rendering and native/iOS control behavior are stubbed and not exercised.');
