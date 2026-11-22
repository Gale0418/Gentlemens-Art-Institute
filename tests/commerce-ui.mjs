import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8');
const commerceSource = fs.readFileSync('public/commerce.js', 'utf8');
const nativeSource = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const smbScannerSource = fs.readFileSync('src-tauri/src/smb_scanner.rs', 'utf8');

assert.match(html, /id="commerce-settings"/, 'settings should expose the G.A.I Pro section');
assert.match(html, /id="commerce-purchase-btn"[^>]*disabled/, 'purchase must start disabled');
assert.match(html, /免費基本版/, 'free range must be visible');
assert.match(html, /閱讀與手動整理全免費/, 'manual organization must be clearly free');
assert.match(html, /v1 Pro · AI 工具一次買斷/, 'Pro purchase must be scoped to AI tools');
assert.match(html, /供應商用量額度/, 'provider usage charges and credits must be separated from Pro');
assert.match(html, /需要自備 OpenAI 或 Google API Key，API 使用費另計。/, 'AI provider billing must be disclosed');
assert.match(html, /🥤 請研究員喝杯快樂水！[\s\S]*不需要 AI？那就直接關掉這個頁面，繼續免費看漫畫吧！[\s\S]*ヾ\(X3ﾉｼヾ\)ﾉｼ/,
  'the purchase dialog should carry the requested full copy');
assert.match(html, /id="commerce-offer-price"/, 'the offer line must use the StoreKit display price');
assert.match(html, /tauri-api\.js"><\/script>\s*<script src="commerce\.js"><\/script>\s*<script src="app\.js">/, 'commerce must load between the bridge and app');
assert.match(css, /\.commerce-modal-overlay\[hidden\]/, 'commerce modal needs a hidden state');
assert.match(css, /min-height:\s*44px/, 'commerce controls need touch-safe sizing');
assert.doesNotMatch(commerceSource, /localStorage\.(getItem|setItem|removeItem)\([^)]*pro/i, 'frontend must not persist a Pro flag');

const protectedHandlers = [];
let enclosingHandler = '';
for (const line of nativeSource.split(/\r?\n/)) {
  const declaration = line.match(/\basync\s+fn\s+(\w+)\s*\(/);
  if (declaration) enclosingHandler = declaration[1];
  if (/^\s*commerce::require_pro\(&app_handle\)\.await\?;/.test(line)) {
    protectedHandlers.push(enclosingHandler);
  }
}
assert.deepEqual(protectedHandlers.sort(), [
  'explain_page', 'restore_ai_session_config', 'set_ai_session_config', 'suggest_comic_metadata', 'test_ai_session',
].sort(), 'native Pro enforcement is limited to AI setup and generation handlers');
assert.doesNotMatch(smbScannerSource, /commerce::require_pro\s*\(|\brequire_pro\s*\(/,
  'direct SMB/NAS access must not have a Pro guard');

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id, classes = []) {
    this.id = id;
    this.className = classes.join(' ');
    this.classList = new FakeClassList();
    classes.forEach(name => this.classList.add(name));
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() { this.ownerDocument.activeElement = this; }
  closest(selector) {
    return selector.split(',').map(value => value.trim()).some((part) => {
      if (part.startsWith('#')) return part === `#${this.id}`;
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      return false;
    }) ? this : null;
  }
  querySelectorAll() { return []; }
  click() {
    for (const handler of this.listeners.get('click') || []) {
      handler({ target: this, currentTarget: this, preventDefault() {}, stopImmediatePropagation() {} });
    }
  }
}

class FakeDocument {
  constructor(api) {
    this.readyState = 'complete';
    this.visibilityState = 'visible';
    this.listeners = new Map();
    this.captureListeners = new Map();
    this.activeElement = null;
    this.body = new FakeElement('body');
    this.body.classList = new FakeClassList();
    this.elements = new Map();
    this.api = api;
    this.add('commerce-status-badge');
    this.add('commerce-status-message');
    this.add('commerce-price');
    this.add('commerce-offer-price');
    this.add('commerce-offer-purchase-suffix');
    this.add('commerce-modal-status');
    this.add('ai-session-status');
    this.add('commerce-pro-description');
    this.add('commerce-pro-close');
    this.add('commerce-more-btn');
    this.add('commerce-pro-modal');
    this.add('commerce-purchase-btn', ['commerce-purchase-btn']);
    this.add('commerce-modal-purchase-btn', ['commerce-purchase-btn']);
    this.add('commerce-restore-btn', ['commerce-restore-btn']);
    this.add('commerce-modal-restore-btn', ['commerce-restore-btn']);
  }
  add(id, classes = []) {
    const element = new FakeElement(id, classes);
    element.ownerDocument = this;
    this.elements.set(id, element);
    return element;
  }
  getElementById(id) { return this.elements.get(id) || null; }
  querySelectorAll(selector) {
    if (selector === '.commerce-purchase-btn') return [this.getElementById('commerce-purchase-btn'), this.getElementById('commerce-modal-purchase-btn')];
    if (selector === '.commerce-restore-btn') return [this.getElementById('commerce-restore-btn'), this.getElementById('commerce-modal-restore-btn')];
    return [];
  }
  addEventListener(type, handler, options = false) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
    if (type === 'click' && (options === true || options?.capture === true)) {
      const captures = this.captureListeners.get(type) || [];
      captures.push(handler);
      this.captureListeners.set(type, captures);
    }
  }
  dispatchCaptureClick(target) {
    const event = { target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; } };
    for (const handler of this.captureListeners.get('click') || []) handler(event);
    return event;
  }
}

function harness(api, l10n = null) {
  const document = new FakeDocument(api);
  const window = { electronAPI: api, GAIL10n: l10n };
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout });
  vm.runInContext(commerceSource, context, { filename: 'public/commerce.js' });
  return { document, window };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

{
  let resolveStatus;
  const { document, window } = harness({
    getCommerce: () => new Promise(resolve => { resolveStatus = resolve; }),
  });
  const modal = document.getElementById('commerce-pro-modal');
  modal.hidden = true;
  assert.equal(window.GaiCommerce.ensure('ai'), false, 'AI waits for native entitlement readback');
  assert.equal(modal.hidden, true, 'unknown entitlement must not show a premature paywall');
  assert.match(document.getElementById('ai-session-status').textContent, /正在確認/);
  resolveStatus({ supported: true, pro: true, status: 'purchased' });
  await settle();
  assert.equal(window.GaiCommerce.ensure('ai'), true, 'confirmed Pro access enables AI entry');
}

{
  const translations = {
    '目前無法完成': 'Unable to complete',
    '交易未完成；現有資料與設定都保留，請稍後再試。': 'Transaction incomplete. Try again later.',
  };
  const { document } = harness({ getCommerce: async () => ({
    supported: true, pro: false, status: 'unavailable', message: '未翻譯的原生錯誤',
  }) }, {
    t: source => translations[source] || source,
    hasTranslation: source => Object.hasOwn(translations, source),
  });
  await settle();
  assert.equal(document.getElementById('commerce-status-message').textContent,
    translations['交易未完成；現有資料與設定都保留，請稍後再試。'],
    'untranslated native details must not leak into English UI');
  assert.equal(document.getElementById('commerce-status-badge').classList.contains('is-error'), true,
    'an unavailable store must look like an error');
  assert.equal(document.getElementById('commerce-modal-status').classList.contains('is-error'), true,
    'the purchase dialog must also show an unavailable store as an error');
}

{
  const { document, window } = harness({});
  await settle();
  const state = window.GaiCommerce.getState();
  assert.equal(state.status, 'preview', 'missing bridge should remain browser preview');
  assert.equal(state.pro, false, 'browser preview must not unlock Pro');
  assert.equal(document.getElementById('commerce-purchase-btn').disabled, true, 'preview purchase stays disabled');
  assert.equal(document.getElementById('commerce-offer-price').textContent, '價格載入中…', 'unknown pricing remains loading and is never fabricated');
}

{
  let resolvePurchase;
  let purchaseCalls = 0;
  const api = {
    getCommerce: async () => ({ supported: true, pro: false, productId: 'com.windsheep.gai.pro.v1', displayPrice: 'NT$490', status: 'available' }),
    purchasePro: () => {
      purchaseCalls += 1;
      return new Promise(resolve => { resolvePurchase = resolve; });
    },
    restorePro: async () => ({ supported: true, pro: false, productId: 'com.windsheep.gai.pro.v1', displayPrice: 'NT$490', status: 'cancelled' }),
  };
  const { document, window } = harness(api);
  await settle();
  assert.equal(document.getElementById('commerce-purchase-btn').disabled, false, 'supported priced product can be purchased');
  assert.equal(document.getElementById('commerce-offer-price').textContent, 'NT$490', 'offer copy uses the native display price');

  document.getElementById('commerce-purchase-btn').click();
  document.getElementById('commerce-modal-purchase-btn').click();
  assert.equal(purchaseCalls, 1, 'busy lock prevents parallel purchase calls');
  assert.equal(window.GaiCommerce.getState().busy, true, 'purchase exposes pending busy state');
  assert.equal(document.getElementById('commerce-purchase-btn').disabled, true, 'purchase is disabled while pending');

  resolvePurchase({ supported: true, pro: true, productId: 'com.windsheep.gai.pro.v1', displayPrice: 'NT$490', status: 'success' });
  await settle();
  await settle();
  assert.equal(window.GaiCommerce.getState().pro, true, 'only native response can unlock Pro');
  assert.equal(document.getElementById('commerce-purchase-btn').disabled, true, 'already purchased Pro cannot be bought again');
}

{
  const api = {
    getCommerce: async () => ({ supported: true, pro: false, productId: 'com.windsheep.gai.pro.v1', displayPrice: 'NT$490', status: 'available' }),
    purchasePro: async () => { throw new Error('user_cancelled'); },
  };
  const { document, window } = harness(api);
  await settle();
  document.getElementById('commerce-purchase-btn').click();
  await settle();
  await settle();
  const state = window.GaiCommerce.getState();
  assert.equal(state.pro, false, 'cancelled purchase must not unlock Pro');
  assert.equal(state.status, 'cancelled', 'cancelled purchase has an explicit state');
  assert.match(state.message, /取消/, 'cancelled purchase explains recovery');
  assert.equal(window.GaiCommerce.handleError(new Error('PRO_REQUIRED: AI 解說與整理工具')), true, 'PRO_REQUIRED is handled by the commerce dialog');
  assert.equal(document.getElementById('commerce-pro-modal').hidden, false, 'handled Pro error opens the dialog');
  window.GaiCommerce.ensure('ai');
  assert.match(document.getElementById('ai-session-status').textContent, /需要 G\.A\.I Pro/, 'denied AI setup explains the entitlement in the AI section');
}

console.log('PASS: commerce settings, preview lock, native purchase authority, cancellation, and busy guard are covered');

{
  const { document } = harness({});
  await settle();
  assert.equal(document.getElementById('commerce-restore-btn').disabled, true, 'preview restore is disabled');
}
{
  const api = {
    getCommerce: async () => ({ supported: true, pro: false, displayPrice: 'TEST $1', status: 'ready' }),
    restorePro: async () => ({ supported: true, pro: false, displayPrice: null, status: 'unavailable', message: '恢復失敗，請稍後再試' }),
  };
  const { document, window } = harness(api);
  await settle();
  document.getElementById('commerce-restore-btn').click();
  await settle();
  await settle();
  assert.equal(window.GaiCommerce.getState().status, 'failed');
  assert.match(document.getElementById('commerce-modal-status').textContent, /恢復失敗/);
}
{
  const { document, window } = harness({getCommerce: async () => ({ supported: true, pro: true, status: 'purchased' })});
  await settle();
  window.GaiCommerce.handleError('PRO_REQUIRED: 已撤銷');
  assert.equal(window.GaiCommerce.getState().pro, false, 'backend denial invalidates stale UI ownership');
  assert.equal(document.getElementById('commerce-pro-modal').hidden, false);
}
console.log('PASS: unavailable restore, preview restore, and revoked UI ownership regressions');

{
  const { document } = harness({});
  await settle();
  const modal = document.getElementById('commerce-pro-modal');
  modal.hidden = false;
  const control = (id, tabIndex, disabled = false) => {
    const element = document.add(id);
    element.tabIndex = tabIndex;
    element.matches = selector => selector === ':disabled' && disabled;
    return element;
  };
  const first = control('enabled-link', 0);
  const last = control('enabled-custom-control', 0);
  const excluded = ['input', 'select', 'textarea', 'button', 'fieldset-child']
    .map(kind => control(`disabled-${kind}`, 0, true));
  const negativeTabIndex = control('programmatic-only', -1);
  modal.querySelectorAll = () => [excluded[0], first, negativeTabIndex, ...excluded.slice(1), last, excluded[0]];
  for (const shiftKey of [false, true]) {
    document.activeElement = shiftKey ? first : last;
    let prevented = false;
    for (const handler of document.listeners.get('keydown') || []) {
      handler({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
    }
    assert.equal(prevented, true);
    assert.equal(document.activeElement, shiftKey ? last : first, 'focus wraps between enabled keyboard-focusable controls');
  }
}
console.log('PASS: Pro dialog focus trap skips disabled controls and negative tabindex');

{
  const { document } = harness({});
  await settle();
  for (const id of ['smb-setup-btn', 'organize-tag', 'organize-duplicates', 'organize-apply']) {
    const event = document.dispatchCaptureClick(document.add(id));
    assert.equal(event.defaultPrevented, false, `${id} remains usable without Pro`);
    assert.equal(event.stopped, false, `${id} continues to its free manual handler`);
  }
  for (const id of ['ai-save-btn', 'ai-restore-btn', 'ai-test-btn', 'btn-ai-explain', 'btn-ai-auto-explain', 'btn-ai-book-explain', 'ai-provider', 'ai-api-key']) {
    const event = document.dispatchCaptureClick(document.add(id));
    assert.equal(event.defaultPrevented, true, `${id} is gated as an AI feature`);
    assert.equal(event.stopped, true, `${id} cannot reach an AI handler before Pro`);
  }
  const metadataAction = document.add('ai-metadata-action', ['inspector-ai-action']);
  assert.equal(document.dispatchCaptureClick(metadataAction).defaultPrevented, true,
    'AI metadata suggestions remain gated');
  const stopAction = document.add('btn-ai-book-stop', ['ai-page-btn']);
  const stopEvent = document.dispatchCaptureClick(stopAction);
  assert.equal(stopEvent.defaultPrevented, false, 'an in-progress whole-book AI run can still be stopped');
  assert.equal(stopEvent.stopped, false, 'the click reaches the whole-book translation stop handler');
}
console.log('PASS: free manual actions bypass UI gating; AI settings, reading, metadata and native entitlement scope are covered');

{
  const available = { supported: true, pro: false, status: 'ready', displayPrice: 'NT$150' };
  let resolveOlderRefresh;
  let resolvePurchase;
  let reads = 0;
  const { window, document } = harness({
    getCommerce: () => ++reads === 2
      ? new Promise(resolve => { resolveOlderRefresh = resolve; })
      : Promise.resolve(available),
    purchasePro: () => new Promise(resolve => { resolvePurchase = resolve; }),
  });
  await settle();
  document.getElementById('commerce-purchase-btn').click();
  const olderRefresh = window.GaiCommerce.refresh();
  resolvePurchase({ ...available, pro: true, status: 'purchased' });
  await settle();
  assert.equal(window.GaiCommerce.getState().pro, true);
  resolveOlderRefresh(available);
  await olderRefresh;
  assert.equal(window.GaiCommerce.getState().pro, true,
    'a status read started during checkout cannot undo a verified purchase');
  await window.GaiCommerce.refresh();
  assert.equal(window.GaiCommerce.getState().pro, false,
    'a new status read after checkout can still detect a revoked entitlement');
}
console.log('PASS: a checkout result supersedes older reads while later reads still update entitlements');
