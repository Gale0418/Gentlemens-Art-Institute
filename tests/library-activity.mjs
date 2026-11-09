import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('../public/activity-progress.css', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `missing function body ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    const active = force === undefined ? !this.values.has(name) : Boolean(force);
    if (active) this.values.add(name);
    else this.values.delete(name);
    return active;
  }
  contains(name) { return this.values.has(name); }
}

function createHarness(scanStatus = null) {
  const indicator = { hidden: true };
  const attributes = new Map();
  const body = {
    classList: new FakeClassList(),
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
  const document = {
    hidden: false,
    visibilityState: 'visible',
    body,
    getElementById(id) { return id === 'library-background-activity' ? indicator : null; },
  };
  const state = { scanStatus };
  const sync = vm.runInNewContext(`${extractFunction(appSource, 'syncLibraryBackgroundActivity')}\nsyncLibraryBackgroundActivity;`, { state, document });
  return { state, document, body, indicator, sync };
}

function assertActivity(harness, active, message) {
  assert.equal(harness.indicator.hidden, !active, `${message}: indicator hidden state`);
  assert.equal(harness.body.classList.contains('library-background-activity-active'), active, `${message}: body class`);
}

// The actual helper treats scan status as read-only and only reveals activity for active work.
{
  const scanStatus = Object.freeze({ isScanning: true, phase: 'catalog', found: 12 });
  const h = createHarness(scanStatus);
  h.sync();
  assertActivity(h, true, 'active catalog scan');
  assert.equal(scanStatus.isScanning, true, 'sync must not mutate the scan object into a completed state');
  assert.equal(h.state.scanStatus, scanStatus, 'sync must not replace the authoritative scan status');
}

for (const [label, scanStatus] of [
  ['error phase', { isScanning: true, phase: 'error' }],
  ['complete phase', { isScanning: true, phase: 'complete' }],
  ['cancelled phase', { isScanning: true, phase: 'cancelled' }],
  ['stopped scan', { isScanning: false, phase: 'idle' }],
  ['poll error', { isScanning: true, phase: 'catalog', pollError: true }],
  ['missing state', null],
]) {
  const h = createHarness(scanStatus);
  h.sync();
  assertActivity(h, false, label);
}

// NAS is an independent active source; finishing one source must preserve another active source.
{
  const h = createHarness(null);
  h.state.smbDownloadActive = true;
  h.sync();
  assertActivity(h, true, 'NAS-only transfer');

  h.state.scanStatus = { isScanning: true, phase: 'discovering' };
  h.sync();
  assertActivity(h, true, 'scan and NAS overlap');

  h.state.smbDownloadActive = false;
  h.sync();
  assertActivity(h, true, 'scan remains after NAS ends');

  h.state.scanStatus = { isScanning: false, phase: 'complete' };
  h.sync();
  assertActivity(h, false, 'all activity ended');
}

// The visibilitychange handler's helper call marks hidden documents and clears the marker on return.
{
  const h = createHarness({ isScanning: true, phase: 'catalog' });
  h.sync();
  assertActivity(h, true, 'visible scan before hide');
  assert.equal(h.body.getAttribute('data-document-hidden'), null, 'visible document has no hidden marker');

  h.document.hidden = true;
  h.document.visibilityState = 'hidden';
  h.sync();
  assertActivity(h, true, 'hidden document retains truthful activity state');
  assert.equal(h.body.getAttribute('data-document-hidden'), 'true', 'hidden document marker is set');

  h.document.hidden = false;
  h.document.visibilityState = 'visible';
  h.sync();
  assert.equal(h.body.getAttribute('data-document-hidden'), null, 'visible document marker is cleared');
}

// CSS keeps reduced-motion feedback static and stops sheen while hidden or offscreen.
assert.match(cssSource, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'reduced motion path exists');
assert.match(cssSource, /body\[data-document-hidden="true"\][\s\S]*?animation:\s*none/, 'hidden documents stop motion');
assert.match(cssSource, /\.main-layout\.sidebar-collapsed[\s\S]*?animation:\s*none/, 'collapsed sidebar stops motion');
assert.match(cssSource, /\.library-background-activity\[hidden\]\s*\{\s*display:\s*none;/, 'hidden indicator is removed from layout');

console.log('Library activity helper behavior checks passed.');
