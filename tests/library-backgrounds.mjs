import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const appSource = read('public/app.js');
const htmlSource = read('public/index.html');
const cssSource = read('public/library-ambience.css');
const assetManifest = JSON.parse(read('public/assets/library-backgrounds/manifest.json'));
const pickerStart = htmlSource.indexOf('<div class="theme-picker"');
const pickerHtml = htmlSource.slice(pickerStart, htmlSource.indexOf('</section>', pickerStart));

function extractBlock(source, start, open = source.indexOf('{', start)) {
  assert.ok(open >= 0, 'function body exists');
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('unterminated source block');
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf(') {', start);
  assert.ok(bodyStart >= 0, `missing function body ${name}`);
  return extractBlock(source, start, bodyStart + 2);
}

const storageKeyStart = appSource.indexOf('const THEME_STORAGE_KEY =');
const storageKeyEnd = appSource.indexOf(';', storageKeyStart) + 1;
const themeSetStart = appSource.indexOf('const THEMES =');
const themeSetEnd = appSource.indexOf(';', themeSetStart) + 1;
const themeColorsStart = appSource.indexOf('const THEME_COLORS =');
const themeColorsEnd = appSource.indexOf('\n};', themeColorsStart) + 3;
assert.ok(themeSetStart >= 0 && themeColorsStart >= 0, 'theme definitions exist');

function fakeClassList() {
  const names = new Set();
  return {
    toggle(name, force) { if (force) names.add(name); else names.delete(name); },
    contains(name) { return names.has(name); },
  };
}

const options = ['midnight', 'sakura', 'ink', 'aurora', 'alexandria'].map(theme => ({
  dataset: { themeOption: theme },
  classList: fakeClassList(),
  attrs: {},
  focus() { context.focusedOption = this; },
  setAttribute(name, value) { this.attrs[name] = value; },
}));
const html = { dataset: {} };
const themeColor = { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } };
const storage = new Map();
const context = {
  document: {
    documentElement: html,
    querySelector: selector => selector === 'meta[name="theme-color"]' ? themeColor : null,
  },
  elements: { themePicker: { querySelectorAll: () => options } },
  localStorage: { setItem(key, value) { storage.set(key, value); } },
};
const harnessSource = `${appSource.slice(storageKeyStart, storageKeyEnd)}\n${appSource.slice(themeSetStart, themeSetEnd)}\n${appSource.slice(themeColorsStart, themeColorsEnd)}\n${extractFunction(appSource, 'applyTheme')}\n${extractFunction(appSource, 'handleThemePickerKeydown')}\nglobalThis.applyThemeUnderTest = applyTheme;\nglobalThis.keydownUnderTest = handleThemePickerKeydown;`;
vm.runInNewContext(harnessSource, context);

assert.deepEqual(Array.from(vm.runInNewContext('THEMES', context)), ['midnight', 'sakura', 'ink', 'aurora', 'alexandria']);
assert.match(htmlSource, /data-theme-option="midnight"/);
assert.match(htmlSource, /data-theme-option="sakura"/);
assert.match(htmlSource, /data-theme-option="ink"/);
assert.match(htmlSource, /data-theme-option="aurora"/);
assert.match(htmlSource, /data-theme-option="alexandria"[\s\S]*?data-i18n="亞歷山大"/);
assert.equal((htmlSource.match(/class="theme-option"/g) || []).length, 5, 'all five choices are visible in the picker');
assert.equal((htmlSource.match(/class="theme-preview"/g) || []).length, 5, 'each choice uses a photo preview');
assert.doesNotMatch(pickerHtml, /<small\b/, 'theme picker has no color-band sublabels');
assert.ok(htmlSource.indexOf('href="library-ambience.css"') > htmlSource.indexOf('href="style.css"'), 'photo layout overrides the legacy color-swatch layout');
assert.match(cssSource, /\.theme-preview\s*\{[^}]*display:\s*block;/, 'one photo fills the preview instead of occupying the first legacy grid column');

for (const theme of ['midnight', 'sakura', 'ink', 'aurora']) {
  context.applyThemeUnderTest(theme, { persist: false });
  assert.equal(html.dataset.theme, theme, `existing stored ID ${theme} remains supported`);
  assert.equal(options.find(option => option.dataset.themeOption === theme).attrs['aria-checked'], 'true');
  assert.equal(storage.has('gai:theme'), false, 'loading a stored theme does not rewrite preferences');
}
context.applyThemeUnderTest('alexandria');
assert.equal(html.dataset.theme, 'alexandria');
assert.equal(storage.get('gai:theme'), 'alexandria', 'new theme persists using the existing preference key');
assert.equal(themeColor.content, '#17130e', 'browser theme color follows the new theme');
assert.equal(options.filter(option => option.attrs['aria-checked'] === 'true').length, 1, 'only the active theme is checked');
function pressThemeKey(key, option) {
  const event = {
    key,
    target: { closest: selector => selector === '[data-theme-option]' ? option : null },
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  context.keydownUnderTest(event);
  return event;
}
let keyEvent = pressThemeKey('ArrowRight', options[3]);
assert.equal(context.focusedOption, options[4], 'ArrowRight focuses the next theme');
assert.equal(html.dataset.theme, 'alexandria', 'arrow selection applies and persists');
assert.equal(keyEvent.prevented, true);
assert.equal(keyEvent.stopped, true);
keyEvent = pressThemeKey('ArrowDown', options[4]);
assert.equal(context.focusedOption, options[0], 'arrow navigation wraps to the first theme');
keyEvent = pressThemeKey('End', options[0]);
assert.equal(context.focusedOption, options[4], 'End focuses the final theme');
keyEvent = pressThemeKey('Home', options[4]);
assert.equal(context.focusedOption, options[0], 'Home focuses the first theme');
keyEvent = pressThemeKey('Escape', options[0]);
assert.equal(keyEvent.prevented, false, 'unhandled keys retain their existing behavior');
context.applyThemeUnderTest('unknown-old-value');
assert.equal(html.dataset.theme, 'midnight', 'invalid legacy preference falls back to the established default');
assert.equal(storage.get('gai:theme'), 'midnight');

const themeIds = ['crimson', 'obsidian', 'emerald', 'gilded-throne', 'alexandria'];
const imageKinds = ['mac', 'ipad-landscape', 'ipad-portrait'];
const imageUrls = [...cssSource.matchAll(/url\(["']([^"']+\.jpg)["']\)/g)].map(match => match[1]);
for (const id of themeIds) {
  for (const kind of imageKinds) {
    const file = `./assets/library-backgrounds/${id}-${kind}.jpg`;
    assert.ok(imageUrls.includes(file), `CSS maps ${id} for ${kind}`);
  }
  const preview = `assets/library-backgrounds/${id}-preview.jpg`;
  assert.match(htmlSource, new RegExp(`src="${preview.replaceAll('.', '\\.') }"`), `${id} has a picker thumbnail`);
}

function jpegSize(buffer) {
  assert.equal(buffer[0], 0xff, 'JPEG begins with a marker');
  assert.equal(buffer[1], 0xd8, 'JPEG starts with SOI');
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new Error('JPEG has no supported frame header');
}

for (const id of themeIds) {
  for (const kind of imageKinds) {
    const relativePath = `public/assets/library-backgrounds/${id}-${kind}.jpg`;
    const fullPath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(fullPath), `background asset exists: ${relativePath}`);
    const { width, height } = jpegSize(fs.readFileSync(fullPath));
    const ratio = width / height;
    if (kind !== 'ipad-portrait') assert.ok(width > height, `${relativePath} is landscape`);
    else assert.ok(height > width, `${relativePath} is portrait`);
    if (kind === 'mac') assert.ok(ratio > 3 / 2, `${relativePath} serves wide desktop windows`);
    if (kind === 'ipad-landscape') assert.ok(ratio > 1 && ratio <= 3 / 2, `${relativePath} serves landscape tablet windows`);
    if (kind === 'ipad-portrait') assert.ok(ratio < 1, `${relativePath} serves portrait tablet windows`);
  }
  const previewPath = `public/assets/library-backgrounds/${id}-preview.jpg`;
  assert.ok(fs.existsSync(path.join(repoRoot, previewPath)), `preview asset exists: ${previewPath}`);
  assert.deepEqual(jpegSize(fs.readFileSync(path.join(repoRoot, previewPath))), { width: 320, height: 200 }, `${previewPath} is the picker-sized thumbnail`);
}

assert.equal(assetManifest.backgroundCount, 15);
assert.equal(assetManifest.pickerPreviewCount, 5);
assert.equal(assetManifest.files.length, 20, 'manifest accounts for each background and preview');
for (const entry of assetManifest.files) {
  const fullPath = path.join(repoRoot, 'public/assets/library-backgrounds', entry.file);
  const contents = fs.readFileSync(fullPath);
  assert.equal(entry.bytes, contents.length, `${entry.file} byte count matches the manifest`);
  assert.equal(entry.sha256, createHash('sha256').update(contents).digest('hex'), `${entry.file} checksum matches the manifest`);
  if (entry.device === 'picker-preview') assert.equal(entry.file, `${entry.theme}-preview.jpg`);
  else {
    assert.ok(imageKinds.includes(entry.device), `${entry.file} declares a supported device variant`);
    assert.equal(entry.file, `${entry.theme}-${entry.device}.jpg`);
    assert.deepEqual(jpegSize(contents), { width: entry.width, height: entry.height }, `${entry.file} dimensions match the manifest`);
  }
}

const noAspectRule = cssSource.match(/@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-aspect-ratio:\s*3\s*\/\s*2\)\s*\{([\s\S]*?)\n\}/);
const portraitRule = cssSource.match(/@media\s*\(orientation:\s*portrait\)\s*\{([\s\S]*?)\n\}/);
assert.ok(noAspectRule, 'landscape tablet artwork is selected by viewport aspect ratio');
assert.ok(portraitRule, 'portrait artwork is selected by viewport orientation');
const defaultLandscape = noAspectRule[1].match(/:root,\s*html\[data-theme="midnight"\]\s*\{\s*--library-background-url:\s*url\("([^"]+)"\);/);
const defaultPortrait = portraitRule[1].match(/:root,\s*html\[data-theme="midnight"\]\s*\{\s*--library-background-url:\s*url\("([^"]+)"\);/);
assert.equal(defaultLandscape?.[1], './assets/library-backgrounds/crimson-ipad-landscape.jpg', 'an uninitialized theme uses the landscape fallback image');
assert.equal(defaultPortrait?.[1], './assets/library-backgrounds/crimson-ipad-portrait.jpg', 'an uninitialized theme uses the portrait fallback image');
for (const id of themeIds) {
  assert.ok(noAspectRule[1].includes(`${id}-ipad-landscape.jpg`), `${id} has landscape tablet media mapping`);
  assert.ok(portraitRule[1].includes(`${id}-ipad-portrait.jpg`), `${id} has portrait media mapping`);
}
function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
  const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrastRatio(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
const alexandriaTokens = cssSource.match(/html\[data-theme="alexandria"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
const alexandriaGradient = alexandriaTokens.match(/--accent-grad:\s*linear-gradient\([^;]+\);/)?.[0] || '';
const accentStops = [...alexandriaGradient.matchAll(/#[\da-f]{6}/gi)].map(match => match[0]);
const onAccent = alexandriaTokens.match(/--on-accent:\s*(#[\da-f]{6})/i)?.[1];
assert.ok(accentStops.length >= 3 && onAccent, 'Alexandria defines its accent gradient and foreground token');
assert.ok(Math.min(...accentStops.map(color => contrastRatio(color, onAccent))) >= 4.5, 'every Alexandria accent stop meets 4.5:1 foreground contrast');
assert.match(cssSource, /background-position:\s*center/);
assert.doesNotMatch(cssSource, /background-attachment:\s*fixed|(?:^|\s)animation\s*:/, 'ambience has no fixed or animated background effects');
assert.match(cssSource, /\.app-header\s*\{[^}]*backdrop-filter:\s*none;/, 'the header does not blur the background photograph');
assert.doesNotMatch(cssSource, /ambient-library-grand\.jpg/, 'legacy ambient photo is no longer active');

console.log('✓ library background themes, viewport mappings, and JPEG dimensions');
