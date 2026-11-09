import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class FakeEvent {
  constructor(type, values = {}) {
    Object.assign(this, { type, bubbles: true, cancelable: true, defaultPrevented: false }, values);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; }
}

class FakeElement {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = attrs.tabindex == null ? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1) : Number(attrs.tabindex);
    this.id = attrs.id || '';
    this.focusCount = 0;
  }
  append(...nodes) {
    const assignDocument = node => { node.ownerDocument = this.ownerDocument; for (const child of node.children) assignDocument(child); };
    for (const node of nodes) { node.parentElement = this; assignDocument(node); this.children.push(node); }
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  addEventListener(type, fn, options = false) {
    const entries = this.listeners.get(type) || [];
    entries.push({ fn, capture: options === true || options?.capture === true });
    this.listeners.set(type, entries);
  }
  removeEventListener(type, fn, options = false) {
    const capture = options === true || options?.capture === true;
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.fn !== fn || entry.capture !== capture));
  }
  invoke(event, capture) {
    event.currentTarget = this;
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      if (entry.capture !== capture) continue;
      entry.fn(event);
      if (event.immediateStopped) break;
    }
  }
  dispatchEvent(event) {
    const target = event.target || this;
    event.target = target;
    const path = [];
    for (let node = target; node; node = node.parentElement) path.push(node);
    for (const node of [...path].reverse()) { node.invoke(event, true); if (event.stopped) break; }
    if (!event.stopped) for (const node of path) { node.invoke(event, false); if (event.stopped) break; }
    return !event.defaultPrevented;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = node => {
      if (selector.startsWith('[data-reader-panel-toggle=')) return node.getAttribute('data-reader-panel-toggle') === selector.match(/"([^"]+)"/)[1];
      if (selector.startsWith('[data-reader-panel=')) return node.getAttribute('data-reader-panel') === selector.match(/"([^"]+)"/)[1];
      if (selector === '[data-reader-panel-close]') return node.getAttribute('data-reader-panel-close') !== null;
      if (selector === 'button, input, select, textarea, a[href], [tabindex]') return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName) || node.tagName === 'A' && node.getAttribute('href') !== null || node.getAttribute('tabindex') !== null;
      return false;
    };
    const result = [];
    const visit = node => { for (const child of node.children) { if (matches(child)) result.push(child); visit(child); } };
    visit(this);
    return result;
  }
  focus() { this.focusCount++; this.ownerDocument.activeElement = this; }
}

class FakeDocument extends FakeElement {
  constructor() { super('#document'); this.ownerDocument = this; this.activeElement = null; }
}

const doc = new FakeDocument();
const root = new FakeElement('section');
root.ownerDocument = doc;
doc.append(root);
const toolbar = new FakeElement('header', { id: 'reader-top-bar' });
const canvas = new FakeElement('main');
root.append(toolbar, canvas);
const controls = {};
for (const name of ['display', 'modes', 'ai']) {
  const trigger = new FakeElement('button', { 'data-reader-panel-toggle': name, 'aria-controls': `${name}-panel`, id: `${name}-toggle` });
  const panel = new FakeElement('section', { 'data-reader-panel': name, id: `${name}-panel`, role: 'dialog', 'aria-labelledby': `${name}-label` });
  const first = new FakeElement('button', { tabindex: '0' });
  const second = new FakeElement('input', { tabindex: '0', type: 'range' });
  const disabled = new FakeElement('button', { tabindex: '0' }); disabled.disabled = true;
  const negative = new FakeElement('button', { tabindex: '-1' });
  const selfHiding = new FakeElement('button', { tabindex: '0' });
  selfHiding.addEventListener('click', () => { selfHiding.hidden = true; });
  const closer = new FakeElement('button', { 'data-reader-panel-close': '' });
  panel.append(first, second, disabled, negative, selfHiding, closer);
  toolbar.append(trigger, panel);
  controls[name] = { trigger, panel, first, second, disabled, selfHiding, closer };
}
let canvasClicks = 0;
let nextClicks = 0;
const canvasGestures = { touchstart: 0, touchend: 0, pointerdown: 0, pointerup: 0 };
canvas.addEventListener('click', () => { canvasClicks++; });
for (const type of Object.keys(canvasGestures)) canvas.addEventListener(type, () => { canvasGestures[type]++; });
const next = new FakeElement('button');
toolbar.append(next);
next.addEventListener('click', () => { nextClicks++; });

const script = fs.readFileSync(new URL('../public/reader-panels.js', import.meta.url), 'utf8');
const browserWindow = {};
vm.runInNewContext(script, { window: browserWindow });
const changes = [];
const panels = browserWindow.GAIReaderPanels.create({ root, onChange: name => changes.push(name) });

assert.equal(panels.toggle('display'), true);
assert.equal(panels.isOpen(), true);
assert.equal(controls.display.panel.hidden, false);
assert.equal(controls.display.trigger.getAttribute('aria-expanded'), 'true');
assert.equal(controls.display.first.focusCount, 1, 'opening focuses the first usable control');
assert.equal(controls.disabled, undefined);
  const rangeDown = new FakeEvent('pointerdown', { pointerId: 30, pointerType: 'mouse', clientX: 0, clientY: 0 });
  controls.display.second.dispatchEvent(rangeDown);
  assert.equal(doc.activeElement, controls.display.second, 'pointerdown gives a range input explicit focus');
  assert.equal(rangeDown.defaultPrevented, false, 'focusing a range input does not cancel its native pointer interaction');
  const rangeDrag = new FakeEvent('pointermove', { pointerId: 30, pointerType: 'mouse', clientX: 40, clientY: 0 });
  controls.display.second.dispatchEvent(rangeDrag);
  const rangeUp = new FakeEvent('pointerup', { pointerId: 30, pointerType: 'mouse', clientX: 40, clientY: 0 });
  controls.display.second.dispatchEvent(rangeUp);
  assert.equal(rangeDrag.defaultPrevented, false);
  assert.equal(rangeUp.defaultPrevented, false, 'range drag remains available to the native control');
  controls.display.disabled.dispatchEvent(new FakeEvent('click'));
  assert.equal(controls.display.disabled.focusCount, 0, 'disabled controls never receive programmatic focus');
  controls.display.selfHiding.dispatchEvent(new FakeEvent('click'));
  assert.equal(controls.display.selfHiding.hidden, true);
  assert.equal(controls.display.selfHiding.focusCount, 0, 'a control hidden by its click handler is not refocused');
assert.equal(panels.toggle('modes'), true, 'opening a second panel replaces the first');
assert.equal(controls.display.panel.hidden, true);
assert.equal(controls.modes.trigger.getAttribute('aria-expanded'), 'true');
assert.deepEqual(changes, ['display', 'modes'], 'switching reports only the resulting open panel');

let escaped = 0;
const readerEscapeHandler = () => { escaped++; };
doc.addEventListener('keydown', readerEscapeHandler, true);
const escape = new FakeEvent('keydown', { key: 'Escape' });
doc.dispatchEvent(escape);
assert.equal(panels.isOpen(), false);
assert.equal(escape.defaultPrevented, true);
assert.equal(escaped, 0, 'Escape is consumed before reader-level close handlers');
assert.equal(controls.modes.trigger.focusCount, 1, 'Escape restores focus to the opening trigger');
doc.removeEventListener('keydown', readerEscapeHandler, true);

panels.toggle('ai');
controls.ai.closer.focus();
const tabForward = new FakeEvent('keydown', { key: 'Tab' });
doc.dispatchEvent(tabForward);
assert.equal(tabForward.defaultPrevented, true);
assert.equal(doc.activeElement, controls.ai.first, 'Tab wraps from the last usable control');
const tabBackward = new FakeEvent('keydown', { key: 'Tab', shiftKey: true });
controls.ai.first.focus();
doc.dispatchEvent(tabBackward);
assert.equal(tabBackward.defaultPrevented, true);
assert.equal(doc.activeElement, controls.ai.closer, 'Shift+Tab wraps to the last usable control');
let readerTabTrapCalls = 0;
root.addEventListener('keydown', () => { readerTabTrapCalls++; });
controls.ai.second.focus();
const tabWithinPanel = new FakeEvent('keydown', { key: 'Tab' });
controls.ai.second.dispatchEvent(tabWithinPanel);
assert.equal(tabWithinPanel.defaultPrevented, false, 'non-boundary Tab keeps browser focus movement');
assert.equal(tabWithinPanel.stopped, true, 'panel Tab does not reach reader-level focus trap');
assert.equal(readerTabTrapCalls, 0);

controls.modes.trigger.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 10, pointerType: 'mouse', clientX: 0, clientY: 0 }));
controls.modes.trigger.dispatchEvent(new FakeEvent('click'));
assert.equal(panels.isOpen(), true, 'clicking another toggle switches to its panel');
assert.equal(controls.modes.panel.hidden, false);
controls.modes.trigger.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 10, pointerType: 'mouse', clientX: 0, clientY: 0 }));
controls.modes.trigger.dispatchEvent(new FakeEvent('click'));
assert.equal(panels.isOpen(), false, 'clicking the open toggle closes it instead of reopening after outside dismissal');
panels.toggle('ai');
controls.ai.closer.dispatchEvent(new FakeEvent('click'));
assert.equal(panels.isOpen(), false, 'contract close control closes the active panel');

// Toolbar actions dismiss the panel, then still receive their original click.
panels.toggle('display');
toolbar.dispatchEvent(new FakeEvent('pointerdown', { target: next, pointerId: 11, pointerType: 'mouse', clientX: 0, clientY: 0 }));
assert.equal(panels.isOpen(), false);
next.dispatchEvent(new FakeEvent('click'));
assert.equal(nextClicks, 1, 'outside toolbar action remains available after dismissal');

// Canvas tap is swallowed at pointer-up/click so it cannot page-turn or tap-toggle.
panels.toggle('modes');
doc.dispatchEvent(new FakeEvent('pointerdown', { target: canvas, pointerId: 12, pointerType: 'touch', clientX: 10, clientY: 20 }));
assert.equal(panels.isOpen(), false);
const tapUp = new FakeEvent('pointerup', { target: canvas, pointerId: 12, clientX: 10, clientY: 20 });
doc.dispatchEvent(tapUp);
assert.equal(tapUp.defaultPrevented, true);
const tapClick = new FakeEvent('click', { target: canvas });
doc.dispatchEvent(tapClick);
assert.equal(canvasClicks, 0, 'canvas tap does not reach page-turn/tap handlers');

// A real drag clears the pending click suppression and preserves canvas gesture delivery.
panels.toggle('ai');
doc.dispatchEvent(new FakeEvent('pointerdown', { target: canvas, pointerId: 13, pointerType: 'touch', clientX: 0, clientY: 0 }));
doc.dispatchEvent(new FakeEvent('pointermove', { target: canvas, pointerId: 13, clientX: 40, clientY: 0 }));
const dragUp = new FakeEvent('pointerup', { target: canvas, pointerId: 13, clientX: 40, clientY: 0 });
doc.dispatchEvent(dragUp);
assert.equal(dragUp.defaultPrevented, false, 'swipe/pan pointer-up remains available');
canvas.dispatchEvent(new FakeEvent('click'));
assert.equal(canvasClicks, 1, 'a drag is not mistaken for a canvas tap');

// Touchstart is intercepted before the reader's viewport listener; its pointer/touch end and compat mouse sequence stay suppressed.
panels.toggle('display');
const touchStart = new FakeEvent('touchstart', { target: canvas, changedTouches: [{ identifier: 21 }] });
doc.dispatchEvent(touchStart);
assert.equal(panels.isOpen(), false);
assert.equal(canvasGestures.touchstart, 0, 'reader never starts a page gesture for the outside touch');
doc.dispatchEvent(new FakeEvent('pointerdown', { target: canvas, pointerId: 21, pointerType: 'touch' }));
const dismissedPointerUp = new FakeEvent('pointerup', { target: canvas, pointerId: 21, pointerType: 'touch' });
doc.dispatchEvent(dismissedPointerUp);
assert.equal(dismissedPointerUp.stopped, true, 'dismissed touch pointerup is blocked');
const touchEnd = new FakeEvent('touchend', { target: canvas, changedTouches: [{ identifier: 21 }] });
doc.dispatchEvent(touchEnd);
assert.equal(touchEnd.stopped, true, 'dismissed touchend cannot trigger the reader swipe handler');
assert.equal(canvasGestures.touchend, 0);
const compatibilityDown = new FakeEvent('mousedown', { target: canvas });
doc.dispatchEvent(compatibilityDown);
assert.equal(compatibilityDown.defaultPrevented, true, 'touch compatibility mousedown is suppressed');
const compatibilityClick = new FakeEvent('click', { target: canvas });
doc.dispatchEvent(compatibilityClick);
assert.equal(compatibilityClick.defaultPrevented, true, 'touch compatibility click is suppressed');
assert.equal(canvasClicks, 1);

// Cancel clears pending suppression, and a later unrelated canvas click remains usable.
panels.toggle('modes');
doc.dispatchEvent(new FakeEvent('touchstart', { target: canvas }));
doc.dispatchEvent(new FakeEvent('pointercancel', { target: canvas, pointerId: 22, pointerType: 'touch' }));
const postCancelClick = new FakeEvent('click', { target: canvas });
doc.dispatchEvent(postCancelClick);
assert.equal(postCancelClick.defaultPrevented, false, 'cancel does not leave a stale click suppression flag');
assert.equal(canvasClicks, 2);

// A genuine next pointerdown clears leftover compatibility state if no synthetic click followed the touch.
panels.toggle('ai');
doc.dispatchEvent(new FakeEvent('touchstart', { target: canvas }));
doc.dispatchEvent(new FakeEvent('touchend', { target: canvas }));
doc.dispatchEvent(new FakeEvent('pointerdown', { target: canvas, pointerId: 23, pointerType: 'mouse' }));
const nextRealClick = new FakeEvent('click', { target: canvas });
doc.dispatchEvent(nextRealClick);
assert.equal(nextRealClick.defaultPrevented, false, 'next genuine pointerdown clears residual suppression');
assert.equal(canvasClicks, 3);

// Closing and teardown remove listeners; late events do not restore hidden focus.
panels.toggle('display');
panels.close({ restoreFocus: false });
assert.equal(controls.display.trigger.focusCount, 0);
panels.toggle('modes');
const modeFocusBeforeDestroy = controls.modes.trigger.focusCount;
panels.destroy();
assert.equal(panels.isOpen(), false);
assert.equal([...doc.listeners.values()].reduce((sum, rows) => sum + rows.length, 0), 0, 'destroy removes document listeners');
for (const { trigger, panel, closer } of Object.values(controls)) {
  assert.equal([...trigger.listeners.values()].reduce((sum, rows) => sum + rows.length, 0), 0, 'destroy removes trigger listeners');
  assert.equal([...closer.listeners.values()].reduce((sum, rows) => sum + rows.length, 0), 0, 'destroy removes close listeners');
  assert.equal([...panel.listeners.values()].reduce((sum, rows) => sum + rows.length, 0), 0);
}
doc.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
assert.equal(controls.modes.trigger.focusCount, modeFocusBeforeDestroy, 'late Escape after destroy cannot focus the reader');

console.log('PASS: reader panel exclusivity, ARIA/focus, Escape/Tab, outside tap vs toolbar action/drag, and cleanup');
