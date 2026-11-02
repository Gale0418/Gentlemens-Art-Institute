import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const bridge = fs.readFileSync('public/tauri-api.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const readerMessages = fs.readFileSync('public/locales/reader-messages.js', 'utf8');
const toolchain = fs.readFileSync('rust-toolchain.toml', 'utf8');
const cargoManifest = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
const packageDocument = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const releaseMetadata = JSON.parse(fs.readFileSync('docs/release/gai-app-store-connect-metadata.json', 'utf8'));

assert.match(toolchain, /channel = "1\.98\.1"/, 'release toolchain must pin Rust 1.98.1');
assert.match(cargoManifest, /rust-version = "1\.98\.1"/, 'Cargo MSRV must match Rust 1.98.1');
assert.match(packageDocument.scripts?.['test:rust'] || '', /cargo test[\s\S]*--locked --lib/, 'local Rust tests must honor Cargo.lock');
assert.match(packageDocument.scripts?.quality || '', /check:rustfmt/, 'local quality gate must include rustfmt');
assert.match(packageDocument.scripts?.quality || '', /test:rust/, 'local quality gate must include Rust tests');
assert.match(packageDocument.scripts?.quality || '', /check:clippy/, 'local quality gate must include clippy');
assert.match(
  bridge,
  /disclosure\.id = 'ai-third-party-disclosure-wrap'/,
  'runtime disclosure should be provider-neutral'
);
assert.match(
  bridge,
  /選定的頁面影像（AI 掃描最多六頁）與提示文字才會傳送至 \{provider\}/,
  'disclosure must identify what data leaves the device and the selected provider'
);
assert.match(
  bridge,
  /checkbox\.checked = false;[\s\S]{0,120}renderDisclosure\(\)/,
  'switching AI provider must revoke the previous consent'
);
assert.match(
  bridge,
  /if \(!data\?\.googleContentDisclosure\)[\s\S]{0,260}Promise\.reject/,
  'Tauri bridge must reject AI configuration without explicit consent'
);
assert.match(
  bridge,
  /return invoke\('set_ai_session_config', \{\s*data: \{[\s\S]*rememberKey: Boolean\(data\.rememberKey\)/,
  'consented configuration must still use the validated native command'
);
assert.match(
  bridge,
  /restoreAiSessionConfig: \(data\)[\s\S]*return invoke\('restore_ai_session_config', \{ data \}\)/,
  'saved keys must restore through the explicit native command'
);
assert.match(bridge, /revokeAiSessionConfig: \(\) => invoke\('revoke_ai_session_config'\)/, 'provider changes must have a native session-only revoke command');
assert.match(
  html,
  /id="ai-google-disclosure" type="checkbox"/,
  'legacy checkbox id must remain wired to the existing frontend save handler'
);
assert.match(html, /id="ai-remember-key" type="checkbox"/, 'settings must expose an opt-in Keychain checkbox');
assert.match(
  html,
  /只保存一個供應商；儲存另一家會取代既有 Key/,
  'Keychain checkbox must explain that saving another provider replaces the existing key'
);
assert.match(html, /使用本機 Keychain 記住這個 Key/, 'remembered-key copy must be platform-neutral');
assert.match(html, /重新啟動後請再選擇使用已儲存金鑰/, 'settings must explain that restart requires choosing the saved key again');
assert.match(html, /設定中清除已記住的 Key/, 'settings must explain where a remembered key can be cleared');
assert.doesNotMatch(`${app}\n${html}\n${readerMessages}`, /iOS Keychain/, 'AI UI copy must not be iOS-only');
assert.match(readerMessages, /device Keychain/, 'English locale must describe the cross-platform Keychain');
assert.match(readerMessages, /デバイス Keychain/, 'Japanese locale must describe the cross-platform Keychain');
assert.match(html, /id="ai-restore-btn"[^>]*hidden/, 'saved key restore must require an explicit button action');
assert.match(app, /getElementById\('ai-google-disclosure-wrap'\)\s*\|\|\s*document\.getElementById\('ai-third-party-disclosure-wrap'\)/, 'frontend must keep the disclosure reference after the bridge renames its runtime id');
assert.match(app, /state\.aiSessionSwitchPending = true[\s\S]*await eAPI\.revokeAiSessionConfig\(\)/, 'provider changes must block AI actions before awaiting native revoke');
assert.match(app, /state\.aiSessionSwitchGeneration[\s\S]*generation !== state\.aiSessionSwitchGeneration/, 'rapid provider changes must ignore stale revoke completions');
assert.match(app, /aiProvider\?\.addEventListener\('change', handleAiProviderChange\)/, 'provider changes must use the revocation-aware handler');
assert.match(app, /function beginAiSessionMutation\(kind/, 'AI settings mutations must share one lifecycle guard');
assert.match(app, /aiSaveBtn\.disabled = Boolean\(state\.aiSessionMutationPending\)/, 'save action must be disabled during native mutations');
assert.match(app, /aiClearBtn\.disabled = Boolean\(state\.aiSessionMutationPending\)/, 'clear action must be disabled during native mutations');
assert.match(app, /state\.aiSessionStatus = previousStatus[\s\S]*state\.aiSessionRevocationFailed = true/, 'clear failures must preserve the configured snapshot and block stale use');
assert.match(app, /const mutationGeneration = state\.aiSessionMutationGeneration[\s\S]*testAiSession/, 'AI test requests must capture the mutation generation');
assert.match(app, /mutationGeneration !== state\.aiSessionMutationGeneration[\s\S]*state\.aiExplainCache\.set/, 'stale page explanations must not write the cache');
assert.match(app, /mutationGeneration !== state\.aiSessionMutationGeneration[\s\S]*renderAiMetadataCandidates/, 'stale metadata suggestions must not update the UI');
assert.match(app, /configured: false[\s\S]*state\.aiSessionRevocationFailed = true[\s\S]*setAutoPageExplanation\(false\)/, 'save failures must fail closed and stop automatic AI use');
assert.equal(releaseMetadata.release?.rustToolchain, '1.98.1');
assert.match(
  releaseMetadata.reviewInformation?.sevenRequiredCategories?.externalServices?.value || '',
  /requires explicit in-app consent/,
  'canonical App Review metadata must document explicit third-party AI consent'
);
assert.match(
  releaseMetadata.testFlightGate?.find(item => item.id === 'optional-ai')?.check || '',
  /explicit consent for OpenAI and Google/,
  'TestFlight gate must verify consent for both AI providers'
);

console.log('PASS: Rust 1.98.1, local release gate, and third-party AI consent guards are enforced');

// Cover the current translated span and older direct-text markup.
for (const hasSpan of [false, true]) {
  const checkbox = { nodeType: 1, checked: true };
  const span = { nodeType: 1, tagName: 'SPAN', textContent: '舊 Google 說明', removeAttribute(name) { this.removed = name; } };
  const disclosure = {
    querySelector() { return this.childNodes.find(node => node.tagName === 'SPAN') || null; },
    childNodes: [{ nodeType: 3, textContent: '\n' }, checkbox, { nodeType: 3, textContent: '舊 Google 說明' }],
    append(node) { this.childNodes.push(node); },
  };
  if (hasSpan) disclosure.childNodes.push(span);
  let change;
  const provider = { value: 'openai', addEventListener(type, handler) { if (type === 'change') change = handler; } };
  const nodes = { 'ai-google-disclosure-wrap': disclosure, 'ai-google-disclosure': checkbox, 'ai-provider': provider };
  const document = { getElementById: id => nodes[id], createElement: () => ({ nodeType: 1, tagName: 'SPAN', textContent: '', removeAttribute() {} }) };
  const start = bridge.indexOf('function installThirdPartyAiConsentGuard()');
  const end = bridge.indexOf('\ninstallThirdPartyAiConsentGuard();', start);
  vm.runInNewContext(bridge.slice(0, bridge.indexOf('/**')) + bridge.slice(start, end) + '\ninstallThirdPartyAiConsentGuard();', { document, window: {} });
  const label = () => disclosure.childNodes.filter(node => node !== checkbox).map(node => node.textContent).join('');
  assert.match(label(), /OpenAI/);
  assert.equal(disclosure.childNodes.filter(node => node.tagName === 'SPAN').length, 1);
  if (hasSpan) assert.equal(span.removed, 'data-i18n');
  assert.doesNotMatch(label(), /Google/, 'OpenAI must not retain stale Google consent text');
  provider.value = 'google';
  change();
  assert.equal(checkbox.checked, false, 'provider change must revoke prior consent');
  assert.match(label(), /Google/);
  assert.doesNotMatch(label(), /OpenAI/);
}
console.log('PASS: provider consent replaces all legacy label text and resets permission');

// A fast second provider switch must supersede the first native revoke while
// the synchronous pending flag blocks AI actions immediately.
function extractFunction(source, name) {
  let start = source.indexOf(`async function ${name}`);
  if (start < 0) start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `app.js should define ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unable to extract ${name}`);
}

const comicSourceId = vm.runInNewContext(`(${extractFunction(app, 'getComicSourceId')})`);

const revokeResolvers = [];
const mockContext = {
  state: {
    aiSessionSwitchGeneration: 0,
    aiSessionSwitchPending: false,
    aiSessionRevocationFailed: false,
    aiSessionStatus: { configured: true, remembered: true, rememberedProvider: 'openai' },
    aiAutoExplain: true,
    aiSessionMutationPending: false,
    aiSessionMutationKind: null,
    aiSessionMutationGeneration: 0,
    aiProviderCommitted: 'openai',
  },
  elements: {
    aiSessionStatus: { textContent: '', setAttribute() {} },
    aiProvider: { value: 'google' },
  },
  eAPI: {
    revokeAiSessionConfig: () => new Promise(resolve => revokeResolvers.push(resolve)),
  },
  setAutoPageExplanation: () => { mockContext.state.aiAutoExplain = false; },
  setAiPagePanelVisible: () => {},
  updateAiProviderDisclosure: () => {},
  setAiSessionActionAvailability: () => {},
  renderAiSessionStatus: () => {},
  refreshAiSessionStatus: async () => {},
  beginAiSessionMutation(kind, options = {}) {
    const canReplace = options.replaceProviderSwitch && mockContext.state.aiSessionMutationKind === 'provider-switch';
    if (mockContext.state.aiSessionMutationPending && !canReplace) return null;
    const generation = ++mockContext.state.aiSessionMutationGeneration;
    mockContext.state.aiSessionMutationPending = true;
    mockContext.state.aiSessionMutationKind = kind;
    return generation;
  },
  finishAiSessionMutation(generation) {
    if (generation !== mockContext.state.aiSessionMutationGeneration) return false;
    mockContext.state.aiSessionMutationPending = false;
    mockContext.state.aiSessionMutationKind = null;
    return true;
  },
  isCurrentAiSessionMutation(generation) {
    return generation === mockContext.state.aiSessionMutationGeneration;
  },
  readerText: message => message,
  showReaderToast: () => {},
};
const handleProviderChange = vm.runInNewContext(`(${extractFunction(app, 'handleAiProviderChange')})`, mockContext);
const firstSwitch = handleProviderChange();
assert.equal(mockContext.state.aiSessionSwitchPending, true, 'provider change must synchronously block AI actions');
const secondSwitch = handleProviderChange();
assert.equal(mockContext.state.aiSessionSwitchGeneration, 2, 'rapid switches must advance the revoke generation');
revokeResolvers[1]();
await secondSwitch;
assert.equal(mockContext.state.aiSessionSwitchPending, false, 'latest revoke clears pending state');
revokeResolvers[0]();
await firstSwitch;
assert.equal(mockContext.state.aiSessionSwitchPending, false, 'stale revoke completion must not re-open the old state');
assert.equal(mockContext.state.aiSessionMutationPending, false, 'stale revoke completion must not clear latest mutation guard');
console.log('PASS: provider revoke blocks immediate AI actions and ignores stale rapid-switch completions');

const aiSetupFailureMessage = vm.runInNewContext(`(${extractFunction(app, 'aiSetupFailureMessage')})`, {
  readerText: message => message,
});
assert.match(aiSetupFailureMessage('PRO_REQUIRED: denied'), /G\.A\.I Pro/);
assert.match(aiSetupFailureMessage('Keychain unavailable'), /Keychain/);

function createAiMutationContext({ status, eAPI }) {
  const elements = {
    aiSessionStatus: { textContent: '', setAttribute() {} },
    aiProvider: { value: 'openai' },
    aiApiKey: { value: 'secret-key' },
    aiGoogleDisclosure: { checked: true },
    aiRememberKey: { checked: true },
    aiSaveBtn: { disabled: false, setAttribute() {} },
    aiRestoreBtn: { disabled: false, hidden: false, setAttribute() {} },
    aiClearBtn: { disabled: false, setAttribute() {} },
    metadataButton: { disabled: false, setAttribute() {} },
  };
  const context = {
    state: {
      aiSessionStatus: status,
      aiSessionSwitchPending: false,
      aiSessionRevocationFailed: false,
      aiSessionMutationPending: false,
      aiSessionMutationKind: null,
      aiSessionMutationGeneration: 0,
      aiSessionSwitchGeneration: 0,
      aiProviderCommitted: 'openai',
    },
    elements,
    eAPI,
    beginAiSessionMutation(kind, options = {}) {
      const replace = options.replaceProviderSwitch && context.state.aiSessionMutationKind === 'provider-switch';
      if (context.state.aiSessionMutationPending && !replace) return null;
      const generation = ++context.state.aiSessionMutationGeneration;
      context.state.aiSessionMutationPending = true;
      context.state.aiSessionMutationKind = kind;
      context.setAiSessionActionAvailability();
      return generation;
    },
    finishAiSessionMutation(generation) {
      if (generation !== context.state.aiSessionMutationGeneration) return false;
      context.state.aiSessionMutationPending = false;
      context.state.aiSessionMutationKind = null;
      context.setAiSessionActionAvailability();
      return true;
    },
    isCurrentAiSessionMutation(generation) {
      return generation === context.state.aiSessionMutationGeneration;
    },
    setAiSessionActionAvailability() {
      const busy = context.state.aiSessionMutationPending;
      elements.aiSaveBtn.disabled = busy;
      elements.aiRestoreBtn.disabled = busy;
      elements.aiClearBtn.disabled = busy;
      elements.metadataButton.disabled = Boolean(
        busy || context.state.aiSessionRevocationFailed
      );
    },
    renderAiSessionStatus(nextStatus) { context.state.aiSessionStatus = nextStatus; },
    readerText: message => message,
    aiSetupFailureMessage,
    showReaderToast: message => { context.lastToast = message; },
    setAutoPageExplanation() {},
    setAiPagePanelVisible() {},
    updateAiProviderDisclosure() {},
    refreshAiSessionStatus: async () => {},
  };
  return context;
}

// Provider revoke pending 時，save/restore/clear 都不可插入第二個 native mutation。
{
  let revokeResolve;
  let saves = 0;
  let restores = 0;
  let clears = 0;
  const context = createAiMutationContext({
    status: { configured: true, provider: 'openai' },
    eAPI: {
      revokeAiSessionConfig: () => new Promise(resolve => { revokeResolve = resolve; }),
      setAiSessionConfig: async () => { saves += 1; },
      restoreAiSessionConfig: async () => { restores += 1; },
      clearAiSessionConfig: async () => { clears += 1; },
    },
  });
  const provider = vm.runInNewContext(`(${extractFunction(app, 'handleAiProviderChange')})`, context);
  const save = vm.runInNewContext(`(${extractFunction(app, 'saveAiSession')})`, context);
  const restore = vm.runInNewContext(`(${extractFunction(app, 'restoreAiSession')})`, context);
  const clear = vm.runInNewContext(`(${extractFunction(app, 'clearAiSession')})`, context);
  context.elements.aiProvider.value = 'google';
  const switching = provider();
  await Promise.all([save(), restore(), clear()]);
  assert.equal(saves + restores + clears, 0, 'provider switch guard blocks save/restore/clear races');
  revokeResolve();
  await switching;
  assert.equal(context.state.aiSessionMutationPending, false, 'provider switch releases shared mutation guard');
}
console.log('PASS: provider switch serializes save, restore, and clear mutations');

// clear 失敗時 native 可能已先撤銷 RAM session；前端保留原 configured snapshot，
// 同時阻斷 AI 操作，直到重新啟用，避免 UI 假裝已安全可用。
{
  let rejectClear;
  const context = createAiMutationContext({
    status: { configured: true, provider: 'openai', model: 'Luna' },
    eAPI: {
      clearAiSessionConfig: () => new Promise((resolve, reject) => { rejectClear = reject; }),
    },
  });
  const clear = vm.runInNewContext(`(${extractFunction(app, 'clearAiSession')})`, context);
  const clearing = clear();
  assert.equal(context.state.aiSessionMutationPending, true, 'clear marks shared mutation busy synchronously');
  assert.equal(context.elements.aiClearBtn.disabled, true, 'clear disables configuration actions while native call is pending');
  rejectClear(new Error('native clear failed after RAM revoke'));
  await clearing;
  assert.equal(context.state.aiSessionStatus.configured, true, 'clear failure preserves previous configured snapshot');
  assert.equal(context.state.aiSessionRevocationFailed, true, 'clear failure blocks potentially revoked RAM session');
  assert.equal(context.state.aiSessionMutationPending, false, 'clear failure releases shared mutation guard');
  assert.equal(context.elements.aiClearBtn.disabled, false, 'clear button can be retried after failure');
}
console.log('PASS: clear failure preserves configured UI and blocks stale session use');

// set_ai_session_config 失敗時 native 可能已撤銷舊 RAM session；前端必須
// 立即清除 configured 狀態並 fail closed，同時保留輸入讓使用者可重試。
{
  let rejectSave;
  const context = createAiMutationContext({
    status: { configured: true, provider: 'openai', model: 'Luna', remembered: true, rememberedProvider: 'openai' },
    eAPI: {
      setAiSessionConfig: () => new Promise((resolve, reject) => { rejectSave = reject; }),
    },
  });
  const save = vm.runInNewContext(`(${extractFunction(app, 'saveAiSession')})`, context);
  const saving = save();
  assert.equal(context.state.aiSessionMutationPending, true, 'save marks shared mutation busy synchronously');
  rejectSave(new Error('Keychain write failed after RAM revoke'));
  await saving;
  assert.equal(context.state.aiSessionStatus.configured, false, 'save failure clears stale configured status');
  assert.equal(context.state.aiSessionRevocationFailed, true, 'save failure blocks old native session use');
  assert.equal(context.elements.aiApiKey.value, 'secret-key', 'save failure keeps key input available for recovery');
  assert.equal(context.elements.metadataButton.disabled, true, 'save failure keeps metadata action blocked');
  assert.equal(context.state.aiSessionMutationPending, false, 'save failure releases shared mutation guard');
}
console.log('PASS: save failure fails closed while keeping a recoverable retry path');

// 成功的 save／restore 完成後，先前因 stale request 暫時停用的 Inspector
// 建議按鈕可以再次使用；clear 後仍可點按，並導向 AI 設定。
{
  const saveContext = createAiMutationContext({
    status: { configured: false },
    eAPI: {
      setAiSessionConfig: async () => ({ configured: true, provider: 'openai', model: 'Luna' }),
    },
  });
  const save = vm.runInNewContext(`(${extractFunction(app, 'saveAiSession')})`, saveContext);
  saveContext.elements.metadataButton.disabled = true;
  await save();
  assert.equal(saveContext.elements.metadataButton.disabled, false, 'successful save re-enables metadata suggestion');

  const restoreContext = createAiMutationContext({
    status: { configured: false, remembered: true, rememberedProvider: 'openai' },
    eAPI: {
      restoreAiSessionConfig: async () => ({ configured: true, provider: 'openai', model: 'Luna' }),
    },
  });
  const restore = vm.runInNewContext(`(${extractFunction(app, 'restoreAiSession')})`, restoreContext);
  restoreContext.elements.metadataButton.disabled = true;
  await restore();
  assert.equal(restoreContext.elements.metadataButton.disabled, false, 'successful restore re-enables metadata suggestion');

  const unknownKeychainContext = createAiMutationContext({
    status: { configured: false, remembered: false, rememberedLookupFailed: true },
    eAPI: {
      restoreAiSessionConfig: async ({ provider }) => ({ configured: true, provider, model: 'Luna' }),
    },
  });
  const restoreAfterLookupFailure = vm.runInNewContext(`(${extractFunction(app, 'restoreAiSession')})`, unknownKeychainContext);
  await restoreAfterLookupFailure();
  assert.equal(unknownKeychainContext.state.aiSessionStatus.configured, true, 'unknown Keychain status allows a consented restore retry');

  const clearContext = createAiMutationContext({
    status: { configured: true, provider: 'openai', model: 'Luna' },
    eAPI: { clearAiSessionConfig: async () => {} },
  });
  const clear = vm.runInNewContext(`(${extractFunction(app, 'clearAiSession')})`, clearContext);
  await clear();
  assert.equal(clearContext.elements.metadataButton.disabled, false, 'successful clear keeps metadata setup entry reachable');
}
console.log('PASS: metadata suggestion stays reachable after clear and blocks only mutations');

{
  let opened = 0;
  let scrolled = 0;
  let focused = 0;
  const setupContext = {
    elements: {
      aiProvider: { closest: () => ({ scrollIntoView: () => { scrolled += 1; } }) },
      aiRestoreBtn: { hidden: true },
      aiApiKey: { focus: () => { focused += 1; } },
    },
    openSettingsModal: async () => { opened += 1; },
    console,
  };
  const openAiSettings = vm.runInNewContext(`(${extractFunction(app, 'openAiSettings')})`, setupContext);
  openAiSettings();
  assert.equal(opened, 1, 'AI setup opens Settings');
  assert.equal(scrolled, 1, 'AI setup reveals its section');
  assert.equal(focused, 1, 'AI setup focuses the key field');

  const readerContext = {
    state: { aiSessionStatus: { configured: false }, aiSessionSwitchPending: false, aiSessionMutationPending: false, aiSessionRevocationFailed: false },
    openAiSettings: () => { opened += 1; },
    showReaderToast() {},
  };
  vm.runInNewContext(`(${extractFunction(app, 'toggleAutoPageExplanation')})`, readerContext)();
  vm.runInNewContext(`(${extractFunction(app, 'requestPageExplanation')})`, readerContext)(0, false);
  assert.equal(opened, 3, 'both reader AI buttons lead to setup while disabled');

  const inspectorResults = { hidden: true, textContent: '' };
  vm.runInNewContext(`(${extractFunction(app, 'suggestInspectorMetadata')})`, {
    ...readerContext, readerText: text => text,
  })({ id: 'test' }, {}, inspectorResults);
  assert.equal(opened, 4, 'book AI scan leads to setup while disabled');
  assert.equal(inspectorResults.hidden, false, 'book AI scan keeps a visible explanation');
}
console.log('PASS: inactive AI controls open Settings at the AI section');

// 初始 status 查詢若晚於新的 mutation 回覆，不得把舊 configured 狀態寫回畫面。
{
  let resolveStatus;
  const context = createAiMutationContext({
    status: { configured: false },
    eAPI: { getAiSessionStatus: () => new Promise(resolve => { resolveStatus = resolve; }) },
  });
  const refresh = vm.runInNewContext(`(${extractFunction(app, 'refreshAiSessionStatus')})`, context);
  const pendingRefresh = refresh();
  context.state.aiSessionMutationGeneration = 1;
  resolveStatus({ configured: true, provider: 'openai' });
  await pendingRefresh;
  assert.equal(context.state.aiSessionStatus.configured, false, 'stale status refresh cannot resurrect configured AI');
}
console.log('PASS: stale AI status refresh cannot overwrite a newer mutation');

// 已開始的 test/explain/metadata 請求若遇到新的 settings mutation，回覆不得
// 寫入狀態、頁面快取或候選 UI；同時由 mutation 的 finally 清掉 pending 狀態。
{
  let resolveTest;
  const testContext = {
    state: {
      aiSessionSwitchPending: false,
      aiSessionMutationPending: false,
      aiSessionRevocationFailed: false,
      aiSessionStatus: { configured: true },
      aiSessionMutationGeneration: 0,
    },
    elements: {
      aiTestBtn: { disabled: false },
      aiSessionStatus: { textContent: '' },
    },
    eAPI: { testAiSession: () => new Promise(resolve => { resolveTest = resolve; }) },
    readerText: message => message,
    setAiSessionActionAvailability() {},
  };
  const test = vm.runInNewContext(`(${extractFunction(app, 'testAiSession')})`, testContext);
  const testing = test();
  assert.match(testContext.elements.aiSessionStatus.textContent, /正在用合成文字測試/);
  testContext.state.aiSessionMutationGeneration = 1;
  resolveTest('stale test response');
  await testing;
  assert.doesNotMatch(testContext.elements.aiSessionStatus.textContent, /stale test response/);
  assert.equal(testContext.elements.aiTestBtn.disabled, true, 'stale test completion cannot re-enable an action blocked by mutation');
}

{
  let resolveExplanation;
  const explanationContext = {
    state: {
      aiSessionSwitchPending: false,
      aiSessionMutationPending: false,
      aiSessionRevocationFailed: false,
      aiSessionStatus: { configured: true },
      aiSessionSwitchGeneration: 0,
      aiSessionMutationGeneration: 0,
      currentComic: { id: 'comic-1' },
      currentComicPages: ['page-1'],
      currentPageIndex: 0,
      aiExplainCache: new Map(),
      aiExplainInFlight: false,
      aiExplainActiveRequest: null,
      aiExplainPendingPage: null,
      aiExplainPendingRequest: null,
      aiAutoExplain: false,
    },
    elements: {
      aiPageResult: { textContent: '' },
      btnAiExplain: { disabled: false },
    },
    eAPI: { explainPage: () => new Promise(resolve => { resolveExplanation = resolve; }) },
    isBuiltInDemoComic: () => false,
    getComicSourceId: comicSourceId,
    getAiExplainLocale: () => 'zh-Hant',
    aiExplainCacheKey: (comicId, pageIndex, locale) => [comicId, pageIndex, locale].join(':'),
    pageDataUrl: async () => 'data:image/png;base64,page',
    setAiPagePanelVisible() {},
    syncReaderRotationUi() {},
    setAiSessionActionAvailability() {},
    readerText: message => message,
    showReaderToast() {},
    setAutoPageExplanation() {},
  };
  const explain = vm.runInNewContext(`(${extractFunction(app, 'requestPageExplanation')})`, explanationContext);
  const explaining = explain(0, false);
  await new Promise(resolve => setImmediate(resolve));
  explanationContext.state.aiSessionMutationGeneration = 1;
  resolveExplanation('stale explanation');
  await explaining;
  assert.equal(explanationContext.state.aiExplainCache.size, 0, 'stale explanation cannot enter page cache');
  assert.doesNotMatch(explanationContext.elements.aiPageResult.textContent, /stale explanation/);
  assert.equal(explanationContext.state.aiExplainInFlight, false, 'stale explanation clears in-flight state');
}

{
  let resolveMetadata;
  let metadataPayload;
  let renderedCandidates = 0;
  const resultContainer = { hidden: true, textContent: '' };
  const metadataContext = {
    state: {
      comics: [{ id: 'comic-1', sourceId: 'local:test' }],
      selectedComicId: 'comic-1',
      selectedComicSourceId: 'local:test',
      aiSessionSwitchPending: false,
      aiSessionMutationPending: false,
      aiSessionRevocationFailed: false,
      aiSessionStatus: { configured: true },
      aiSessionSwitchGeneration: 0,
      aiSessionMutationGeneration: 0,
    },
    eAPI: {
      getComicMetadata: async () => ({ comicId: 'catalog-comic-1', sourceId: 'local:test' }),
      suggestComicMetadata: (payload) => {
        metadataPayload = payload;
        return new Promise(resolve => { resolveMetadata = resolve; });
      },
    },
    sampleComicForAiMetadata: async () => ({ dataUrls: ['data:image/png;base64,cover'], indexes: [0] }),
    isComicSourceAmbiguous: () => false,
    isSelectedComic: () => true,
    resolveInspectorMetadataTarget: (comic, metadata) => ({ comicId: metadata.comicId, sourceId: metadata.sourceId }),
    comicMetadataMutationBlockedMessage: () => 'blocked',
    getComicSourceId: comicSourceId,
    getAiExplainLocale: () => 'zh-Hant',
    isComicOffline: () => false,
    renderAiMetadataCandidates() { renderedCandidates += 1; },
    readerText: message => message,
  };
  const suggest = vm.runInNewContext(`(${extractFunction(app, 'suggestInspectorMetadata')})`, metadataContext);
  const button = { disabled: false, isConnected: true, setAttribute() {} };
  const suggesting = suggest({ id: 'comic-1', sourceId: 'local:test' }, button, resultContainer);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(metadataPayload.dataUrls), ['data:image/png;base64,cover']);
  assert.equal(metadataPayload.targetLocale, 'zh-Hant');
  assert.equal(metadataPayload.comicId, 'catalog-comic-1', 'AI suggestion must use verified stable catalog comic id');
  metadataContext.state.aiSessionMutationGeneration = 1;
  metadataContext.state.aiSessionMutationPending = true;
  resolveMetadata([{ field: 'summary', value: 'stale metadata' }]);
  await suggesting;
  assert.equal(renderedCandidates, 0, 'stale metadata cannot render candidate UI');
  assert.doesNotMatch(resultContainer.textContent, /stale metadata/);
  assert.equal(button.disabled, true, 'stale metadata completion cannot re-enable a mutation-blocked action');
}

{
  let finishSampling;
  let providerCalls = 0;
  const resultContainer = { hidden: true, textContent: '' };
  const button = { disabled: false, isConnected: true, setAttribute() {} };
  const context = {
    state: {
      comics: [{ id: 'comic-1', sourceId: 'local:test' }],
      selectedComicId: 'comic-1',
      selectedComicSourceId: 'local:test',
      aiSessionSwitchPending: false,
      aiSessionMutationPending: false,
      aiSessionRevocationFailed: false,
      aiSessionStatus: { configured: true },
      aiSessionSwitchGeneration: 0,
      aiSessionMutationGeneration: 0,
    },
    eAPI: {
      getComicMetadata: async () => ({ comicId: 'catalog-comic-1', sourceId: 'local:test' }),
      suggestComicMetadata: async () => { providerCalls += 1; return []; },
    },
    sampleComicForAiMetadata: () => new Promise(resolve => { finishSampling = resolve; }),
    isComicSourceAmbiguous: () => false,
    isSelectedComic: () => true,
    resolveInspectorMetadataTarget: (comic, metadata) => ({ comicId: metadata.comicId, sourceId: metadata.sourceId }),
    comicMetadataMutationBlockedMessage: () => 'blocked',
    getComicSourceId: comicSourceId,
    getAiExplainLocale: () => 'zh-Hant',
    isComicOffline: () => false,
    readerText: message => message,
  };
  const suggest = vm.runInNewContext(`(${extractFunction(app, 'suggestInspectorMetadata')})`, context);
  const pending = suggest({ id: 'comic-1', sourceId: 'local:test' }, button, resultContainer);
  await new Promise(resolve => setImmediate(resolve));
  button.isConnected = false;
  finishSampling({ dataUrls: ['data:image/png;base64,cover'], indexes: [0] });
  await pending;
  assert.equal(providerCalls, 0, 'leaving the inspector before sampling completes must not spend an AI request');
}

// Metadata APIs and AI metadata writes are still id-only in the native API.
// Refuse ambiguous ids before calling them, and re-check after async reads.
{
  const sourceHelpers = [
    extractFunction(app, 'getComicSourceId'),
    extractFunction(app, 'isComicSourceAmbiguous'),
    extractFunction(app, 'comicSourceCollisionMessage'),
    extractFunction(app, 'comicMetadataMutationBlockedMessage'),
    extractFunction(app, 'resolveInspectorMetadataTarget'),
    extractFunction(app, 'getOrganizerSourceTarget'),
    extractFunction(app, 'comicMatchesIdentity'),
    extractFunction(app, 'isSelectedComic'),
    extractFunction(app, 'loadInspectorMetadata'),
  ].join('\n');
  const first = { id: 'metadata-collision', sourceId: 'local:A', relativePath: 'a/book.cbz', title: 'A' };
  const second = { id: 'metadata-collision', sourceId: 'smb:B', title: 'B' };
  let metadataSuggestionClick;
  const metadataSuggestionButton = {
    dataset: { suggestNamespace: 'genre', suggestValue: 'safe' },
    addEventListener(type, handler) { if (type === 'click') metadataSuggestionClick = handler; },
    closest: () => target,
  };
  const target = { innerHTML: '', querySelectorAll: () => [metadataSuggestionButton] };
  let metadataApplyPayload;
  const context = {
    // loadInspectorMetadata is extracted into an isolated VM below, so
    // provide the production-scoped generation dependency explicitly.
    inspectorMetadataRequestGeneration: 0,
    state: { comics: [first, second], selectedComicId: first.id, selectedComicSourceId: first.sourceId, tagInventoryItems: [] },
    elements: { comicInspector: { querySelector: selector => selector === '#inspector-metadata' ? target : null } },
    eAPI: {
      getComicMetadata: async () => { throw new Error('must fail closed'); },
      listRelatedTags: async () => { throw new Error('must fail closed'); },
      applyBatchMetadata: async payload => { metadataApplyPayload = payload; return { updated: 1, undoToken: 'undo' }; },
    },
    readerText: message => message,
    escapeHtml: value => String(value),
    tagColorKey: () => '',
    formatReadingDirection: value => value || '—',
  };
  // The isolated function needs the real source collision helper and its
  // identity dependency, so execute the complete helper set in one context.
  vm.runInNewContext(`${sourceHelpers}\nglobalThis.load = loadInspectorMetadata;`, context);
  await context.load(first);
  assert.match(target.innerHTML, /metadata 與 AI 整理已暫停/);

  let metadataCalls = 0;
  context.state.comics = [first];
  context.eAPI.getComicMetadata = async () => { metadataCalls += 1; return {
    comicId: 'stable-metadata-A', sourceId: 'local:A',
    title: 'A', creators: {}, tags: [], candidates: [], lockedFields: [], diagnostics: [],
  }; };
  context.eAPI.listRelatedTags = async () => { metadataCalls += 1; return [{
    tag: { namespace: 'genre', value: 'safe' }, sharedComics: 1, reason: 'test',
  }]; };
  target.innerHTML = '';
  await context.load(first);
  assert.equal(metadataCalls, 2, '非歧義 Inspector metadata 仍呼叫既有 id-only API');
  await metadataSuggestionClick();
  assert.equal(metadataApplyPayload.comicIds[0], first.id);
  assert.equal(metadataApplyPayload.targets[0].sourceId, first.sourceId);
  assert.equal(metadataApplyPayload.targets[0].relativePath, first.relativePath,
    'Inspector suggestion must be validated against the exact source location in the database');

  let resolveMetadata;
  let relatedCalls = 0;
  context.eAPI.getComicMetadata = () => new Promise(resolve => { resolveMetadata = resolve; });
  context.eAPI.listRelatedTags = async () => { relatedCalls += 1; return []; };
  context.state.comics = [first];
  target.innerHTML = '';
  const pending = context.load(first);
  await new Promise(resolve => setImmediate(resolve));
  context.state.comics = [second];
  resolveMetadata({ comicId: 'stable-metadata-A', sourceId: 'local:A', title: 'stale A', creators: {}, tags: [], candidates: [], lockedFields: [], diagnostics: [] });
  await pending;
  assert.equal(relatedCalls, 0, 'source collision must block related-tag lookup after metadata resolves');
  assert.equal(target.innerHTML, '', 'async collision must not render stale metadata or overwrite the current inspector');
}

{
  const helperSource = [
    extractFunction(app, 'getComicSourceId'),
    extractFunction(app, 'isComicSourceAmbiguous'),
    extractFunction(app, 'comicSourceCollisionMessage'),
    extractFunction(app, 'comicMetadataMutationBlockedMessage'),
    extractFunction(app, 'resolveInspectorMetadataTarget'),
    extractFunction(app, 'getOrganizerSourceTarget'),
    extractFunction(app, 'comicMatchesIdentity'),
    extractFunction(app, 'isSelectedComic'),
    extractFunction(app, 'renderAiMetadataCandidates'),
  ].join('\n');
  const first = { id: 'ai-candidate-collision', sourceId: 'local:A', relativePath: 'a/book.cbz' };
  const second = { id: 'ai-candidate-collision', sourceId: 'smb:B' };
  const result = { innerHTML: '', textContent: '' };
  const applyButton = {
    disabled: false,
    title: '',
    closest: () => ({ dataset: { candidateIndex: '0' } }),
    addEventListener(type, handler) { if (type === 'click') this.click = handler; },
  };
  result.querySelectorAll = () => [applyButton];
  let applyCalls = 0;
  let applyPayload;
  const context = {
    state: { comics: [first, second], selectedComicId: first.id, selectedComicSourceId: first.sourceId },
    elements: {},
    eAPI: { applyBatchMetadata: async payload => { applyCalls += 1; applyPayload = payload; } },
    readerText: message => message,
    escapeHtml: value => String(value),
  };
  vm.runInNewContext(`${helperSource}\nglobalThis.render = renderAiMetadataCandidates;`, context);
  context.render([{ field: 'summary', value: 'wrong source', confidence: 0.9 }], first, result, { comicId: 'stable-A', sourceId: 'local:A' });
  await applyButton.click();
  assert.equal(applyCalls, 0, 'ambiguous AI candidate must not call id-only apply');
  assert.match(result.textContent, /metadata 與 AI 整理已暫停/);

  context.state.comics = [first];
  result.innerHTML = '';
  result.textContent = '';
  context.render([{ field: 'summary', value: 'safe', confidence: 0.9 }], first, result, { comicId: 'stable-A', sourceId: 'local:A' });
  await applyButton.click();
  assert.equal(applyCalls, 1, 'unique AI candidate may use the verified stable apply id');
  assert.equal(applyPayload.comicIds.length, 1);
  assert.equal(applyPayload.comicIds[0], first.id);
  assert.equal(applyPayload.targets[0].sourceId, first.sourceId);
  assert.equal(applyPayload.targets[0].relativePath, first.relativePath,
    'AI apply must be validated against the exact source location in the database');

  // A disappearing source must not let the remaining same-runtime-id book
  // inherit the old candidate's stable target.
  context.state.comics = [second];
  await applyButton.click();
  assert.equal(applyCalls, 1, 'source removal must fail closed instead of applying to the replacement');
}

// Sampling uses the normalized source_id field, and a collision introduced
// while sampling finishes must stop the id-only suggest request.
{
  const first = { id: 'ai-sample-collision', source_id: 'local:A' };
  const second = { id: 'ai-sample-collision', sourceId: 'smb:B' };
  let finishSampling;
  let sampleArgs;
  let suggestCalls = 0;
  const result = { hidden: true, textContent: '' };
  const button = { disabled: false, isConnected: true, setAttribute() {} };
  const context = {
    state: {
      comics: [first],
      aiSessionStatus: { configured: true },
      aiSessionSwitchPending: false,
      aiSessionMutationPending: false,
      aiSessionRevocationFailed: false,
      aiSessionSwitchGeneration: 0,
      aiSessionMutationGeneration: 0,
    },
    eAPI: {
      getComicMetadata: async () => ({ comicId: 'stable-sample-A', sourceId: 'local:A' }),
      suggestComicMetadata: async () => { suggestCalls += 1; return []; },
    },
    sampleComicForAiMetadata: (id, sourceId) => {
      sampleArgs = [id, sourceId];
      return new Promise(resolve => { finishSampling = resolve; });
    },
    getAiExplainLocale: () => 'zh-Hant',
    isComicOffline: () => false,
    isSelectedComic: () => true,
    getComicSourceId: comicSourceId,
    readerText: message => message,
    isComicSourceAmbiguous: comic => context.state.comics.filter(item => item.id === comic.id)
      .map(item => item.sourceId || item.source_id || 'legacy').filter((value, index, all) => all.indexOf(value) === index).length > 1,
    comicSourceCollisionMessage: () => 'collision',
    comicMetadataMutationBlockedMessage: () => 'blocked',
    resolveInspectorMetadataTarget: (comic, metadata) => {
      if (!metadata?.comicId || !metadata.sourceId || context.state.comics.length !== 1) return null;
      return { comicId: metadata.comicId, sourceId: metadata.sourceId };
    },
  };
  const suggest = vm.runInNewContext(`(${extractFunction(app, 'suggestInspectorMetadata')})`, context);
  const pending = suggest(first, button, result);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sampleArgs, [first.id, 'local:A'], 'AI sampling must pass normalized source_id');
  context.state.comics = [first, second];
  finishSampling({ dataUrls: ['data:image/png;base64,cover'], indexes: [0] });
  await pending;
  assert.equal(suggestCalls, 0, 'async source collision must block id-only AI suggestion');
  assert.equal(result.textContent, 'collision');
}
console.log('PASS: stale test, explanation, and metadata responses cannot write UI or cache');

{
  const sampleIndices = vm.runInNewContext(`(${extractFunction(app, 'metadataSamplePageIndices')})`);
  assert.deepEqual(Array.from(sampleIndices(1)), [0], 'one-page books have one distinct sample');
  assert.deepEqual(Array.from(sampleIndices(3)), [0, 1, 2], 'short books de-duplicate overlapping positions');
  assert.deepEqual(Array.from(sampleIndices(10)), [0, 1, 2, 3, 4, 5], 'sample the opening and three middle positions');
  assert.deepEqual(Array.from(sampleIndices(100)), [0, 1, 2, 39, 49, 59]);
}
