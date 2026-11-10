import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

function extractFunction(name) {
  const asyncStart = app.indexOf(`async function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : app.indexOf(`function ${name}`);
  assert.ok(start >= 0, `app.js should define ${name}`);
  const bodyStart = app.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`unable to extract ${name}`);
}

const functions = [
  'getComicSourceId',
  'getAiExplainLocale',
  'aiExplainCacheKey',
  'localizeAiExplainError',
  'requestPageExplanation',
].map(extractFunction).join('\n');

const calls = [];
const pending = [];
const context = {
  window: { GAIL10n: { locale: 'zh-Hant', t: source => source } },
  state: {
    currentComic: { id: 'comic-1' },
    currentComicPages: ['page-1'],
    currentPageIndex: 0,
    aiExplainCache: new Map(),
    aiExplainInFlight: false,
    aiExplainActiveRequest: null,
    aiExplainPendingPage: null,
    aiExplainPendingRequest: null,
    aiAutoExplain: false,
    aiSessionStatus: { configured: true },
    aiSessionSwitchPending: false,
    aiSessionRevocationFailed: false,
    aiSessionSwitchGeneration: 0,
  },
  elements: {
    aiPageResult: { textContent: '' },
    btnAiExplain: { disabled: false },
  },
  eAPI: {
    explainPage: payload => new Promise(resolve => {
      calls.push(payload);
      pending.push(resolve);
    }),
  },
  isBuiltInDemoComic: () => false,
  pageDataUrl: async () => 'data:image/png;base64,AA==',
  setAiPagePanelVisible: () => {},
  syncReaderRotationUi: () => {},
  readerText: (source, vars = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`)),
  setAutoPageExplanation: () => {},
  setAiSessionActionAvailability: () => {},
  showReaderToast: () => {},
};
context.readerText = (source, vars = {}) => context.window.GAIL10n.t(source)
  .replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
vm.runInNewContext(functions, context);

const firstRequest = context.requestPageExplanation(0, false);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(calls.map(call => call.targetLocale), ['zh-Hant']);

context.window.GAIL10n.locale = 'en';
context.elements.aiPageResult.textContent = 'existing English result';
await context.requestPageExplanation(0, false);
pending.shift()('繁中舊結果');
await firstRequest;
await Promise.resolve();
assert.deepEqual(calls.map(call => call.targetLocale), ['zh-Hant', 'en']);
assert.equal(context.elements.aiPageResult.textContent, '正在翻譯第 1 頁⋯');

pending.shift()('English result');
await new Promise(resolve => setImmediate(resolve));
assert.equal(context.elements.aiPageResult.textContent, 'English result');
assert.equal(context.state.aiExplainCache.get('comic-1:0:zh-Hant'), '繁中舊結果');
assert.equal(context.state.aiExplainCache.get('comic-1:0:en'), 'English result');

context.window.GAIL10n.locale = 'ja';
const thirdRequest = context.requestPageExplanation(0, false);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(calls.map(call => call.targetLocale), ['zh-Hant', 'en', 'ja']);
pending.shift()('日本語結果');
await thirdRequest;
assert.equal(context.state.aiExplainCache.get('comic-1:0:ja'), '日本語結果');

// The same runtime id from two roots must not share an in-flight explanation
// or let source A's late response paint source B's reader.
{
  const sourcePending = [];
  const sourceContext = {
    window: { GAIL10n: { locale: 'zh-Hant', t: source => source } },
    state: {
      currentComic: { id: 'same-runtime-id', sourceId: 'local:A' },
      currentComicPages: ['page-a'],
      currentPageIndex: 0,
      aiExplainCache: new Map(),
      aiExplainInFlight: false,
      aiExplainActiveRequest: null,
      aiExplainPendingPage: null,
      aiExplainPendingRequest: null,
      aiAutoExplain: false,
      aiSessionStatus: { configured: true },
      aiSessionSwitchPending: false,
      aiSessionMutationPending: false,
      aiSessionRevocationFailed: false,
      aiSessionSwitchGeneration: 0,
      aiSessionMutationGeneration: 0,
    },
    elements: { aiPageResult: { textContent: '' }, btnAiExplain: { disabled: false } },
    eAPI: { explainPage: () => new Promise(resolve => sourcePending.push(resolve)) },
    isBuiltInDemoComic: () => false,
    pageDataUrl: async () => 'data:image/png;base64,AA==',
    setAiPagePanelVisible() {},
    syncReaderRotationUi() {},
    setAiSessionActionAvailability() {},
    readerText: source => source,
    setAutoPageExplanation() {},
    showReaderToast() {},
  };
  vm.runInNewContext(functions, sourceContext);
  const requestA = sourceContext.requestPageExplanation(0, false);
  await new Promise(resolve => setImmediate(resolve));
  sourceContext.state.currentComic = { id: 'same-runtime-id', sourceId: 'smb:B' };
  sourceContext.state.currentComicPages = ['page-b'];
  const requestB = sourceContext.requestPageExplanation(0, false);
  sourcePending.shift()('source A result');
  await requestA;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sourceContext.state.aiExplainCache.get('local:A\u0000same-runtime-id:0:zh-Hant'), 'source A result');
  assert.equal(sourceContext.elements.aiPageResult.textContent, '正在翻譯第 {page} 頁⋯',
    'source A late response cannot paint source B');
  sourcePending.shift()('source B result');
  await requestB;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sourceContext.state.aiExplainCache.get('smb:B\u0000same-runtime-id:0:zh-Hant'), 'source B result');
}

assert.match(
  app,
  /if \(activeIndex !== state\.currentPageIndex\) \{[\s\S]{0,500}scheduleAutoPageExplanation\(\);/,
  'webtoon page changes must schedule automatic explanation'
);
assert.match(
  css,
  /\.ai-page-panel\s*\{[^}]*pointer-events:\s*none/,
  'AI panel must not intercept page navigation except its controls'
);
assert.match(css, /\.ai-page-panel-header button\s*\{[^}]*pointer-events:\s*auto/);

context.window.GAIL10n.t = source => ({
  '請先到設定輸入艦載 AI API Key': 'Enter the API key in Settings first',
  '尚未同意第三方 AI 資料分享': 'Third-party AI consent is required',
  '艦載 AI 目前不可用，請稍後再試。': 'Cloud AI is currently unavailable. Try again later.',
}[source] || source);
assert.equal(context.localizeAiExplainError(new Error('請先到設定輸入艦載 AI API Key')), 'Enter the API key in Settings first');
assert.equal(context.localizeAiExplainError(new Error('尚未同意第三方 AI 資料分享')), 'Third-party AI consent is required');
assert.equal(context.localizeAiExplainError(new Error('Gemma service unavailable')), 'Cloud AI is currently unavailable. Try again later.');

console.log('PASS: AI explanation locale payloads, per-locale cache, and late-response protection');

// A provider cutoff must leave the page retryable, rather than caching a partial answer.
context.window.GAIL10n.locale = 'zh-Hant';
const existingTranslate = context.window.GAIL10n.t;
context.window.GAIL10n.t = source => source === 'ui.readerAiIncomplete'
  ? '本頁翻譯未完成，請重試。' : existingTranslate(source);
context.state.currentComic = { id: 'cutoff-page' };
context.state.currentComicPages = ['page-1'];
context.state.currentPageIndex = 0;
context.state.aiExplainCache.clear();
context.eAPI.explainPage = async () => { throw new Error('AI_OUTPUT_INCOMPLETE: max_output_tokens'); };
await context.requestPageExplanation(0, false);
assert.equal(context.elements.aiPageResult.textContent, '本頁翻譯未完成，請重試。');
assert.equal(context.state.aiExplainCache.size, 0);
assert.equal(context.state.aiExplainInFlight, false);

const denseTranslation = 'A complete translated sentence. '.repeat(200);
context.eAPI.explainPage = async () => denseTranslation;
await context.requestPageExplanation(0, false);
assert.equal(context.elements.aiPageResult.textContent, denseTranslation);
assert.equal(context.state.aiExplainCache.get('cutoff-page:0:zh-Hant'), denseTranslation);
console.log('PASS: incomplete translations stay retryable and dense completed translations are preserved');

// Page changes must never leave another page's translation beside the new image.
{
  const timers = new Map();
  let timerId = 0;
  const pageContext = {
    window: { GAIL10n: { locale: 'zh-Hant' } },
    state: {
      currentComic: { id: 'panel-pages', sourceId: 'local:test' },
      currentComicPages: ['page-1', 'page-2'], currentPageIndex: 0,
      aiExplainCache: new Map(), aiExplainDisplayedKey: '',
      aiAutoExplain: false, aiSessionStatus: { configured: true },
    },
    elements: {
      aiPagePanel: { hidden: true }, aiPageResult: { textContent: '' },
      readerOverlay: { classList: { toggle() {} } },
    },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    scheduleReaderImageTransformRefresh() {},
    isBuiltInDemoComic: () => false,
    readerText: (source, vars = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`)),
    requestPageExplanation() {},
  };
  vm.runInNewContext([
    'getComicSourceId', 'getAiExplainLocale', 'aiExplainCacheKey',
    'setAiPagePanelVisible', 'scheduleAutoPageExplanation',
  ].map(extractFunction).join('\n'), pageContext);
  pageContext.setAiPagePanelVisible(true);
  pageContext.elements.aiPageResult.textContent = 'Page one translation';
  pageContext.scheduleAutoPageExplanation();
  assert.equal(pageContext.elements.aiPagePanel.hidden, false, 'same-page repaint keeps a manual result');
  pageContext.state.currentPageIndex = 1;
  pageContext.scheduleAutoPageExplanation();
  assert.equal(pageContext.elements.aiPagePanel.hidden, true, 'new page hides the old manual translation');

  pageContext.state.aiAutoExplain = true;
  pageContext.scheduleAutoPageExplanation();
  assert.equal(pageContext.elements.aiPagePanel.hidden, false);
  assert.equal(pageContext.elements.aiPageResult.textContent, '正在翻譯第 2 頁⋯');
  assert.equal(timers.size, 1);
  const key = pageContext.aiExplainCacheKey('panel-pages', 1, 'zh-Hant', 'local:test');
  pageContext.state.aiExplainCache.set(key, 'Page two translation');
  pageContext.scheduleAutoPageExplanation();
  assert.equal(pageContext.elements.aiPageResult.textContent, 'Page two translation');
  assert.equal(timers.size, 0, 'cached current page cancels the debounce timer');
  pageContext.state.currentComic = null;
  pageContext.scheduleAutoPageExplanation();
  assert.equal(pageContext.elements.aiPagePanel.hidden, true);
}
console.log('PASS: translations follow page changes without hiding same-page manual results');

// A page that stopped being the active view while its image is loading must
// not be sent to the provider. readerOperation also distinguishes reopening
// the same comic/source/page after an A→B→A switch.
{
  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }

  function makeDeferredRequestContext() {
    const image = deferred();
    const calls = [];
    const requestContext = {
      window: { GAIL10n: { locale: 'zh-Hant', t: source => source } },
      state: {
        currentComic: { id: 'comic-A', sourceId: 'local:A' },
        currentComicPages: ['page-A', 'page-B'], currentPageIndex: 0,
        readerOperation: 10,
        aiExplainCache: new Map(), aiExplainInFlight: false,
        aiExplainActiveRequest: null, aiExplainPendingPage: null,
        aiExplainPendingRequest: null, aiAutoExplain: true,
        aiSessionStatus: { configured: true }, aiSessionSwitchPending: false,
        aiSessionMutationPending: false, aiSessionRevocationFailed: false,
        aiSessionSwitchGeneration: 0, aiSessionMutationGeneration: 0,
      },
      elements: { aiPageResult: { textContent: '' }, btnAiExplain: { disabled: false } },
      eAPI: { explainPage: async payload => { calls.push(payload); return 'translated'; } },
      isBuiltInDemoComic: () => false,
      pageDataUrl: () => image.promise,
      setAiPagePanelVisible() {}, syncReaderRotationUi() {},
      setAiSessionActionAvailability() {}, readerText: source => source,
      setAutoPageExplanation() {}, showReaderToast() {},
    };
    vm.runInNewContext(functions, requestContext);
    return { requestContext, image, calls };
  }

  async function assertCancelledAfterImageLoad(changeView) {
    const fixture = makeDeferredRequestContext();
    const request = fixture.requestContext.requestPageExplanation(0, true);
    changeView(fixture.requestContext);
    fixture.image.resolve('data:image/png;base64,AA==');
    await request;
    assert.equal(fixture.calls.length, 0, 'stale page image must not reach explainPage');
    assert.equal(fixture.requestContext.state.aiExplainInFlight, false);
  }

  await assertCancelledAfterImageLoad(context => {
    context.state.currentPageIndex = 1;
  });
  await assertCancelledAfterImageLoad(context => {
    context.state.currentComic = null;
    context.state.currentComicPages = [];
    context.state.readerOperation += 1;
  });
  await assertCancelledAfterImageLoad(context => {
    // Close A and reopen the same identity; value checks alone would match.
    context.state.readerOperation += 2;
    context.state.currentComic = { id: 'comic-A', sourceId: 'local:A' };
    context.state.currentComicPages = ['page-A', 'page-B'];
    context.state.currentPageIndex = 0;
  });
  await assertCancelledAfterImageLoad(context => {
    context.window.GAIL10n.locale = 'en';
  });
  await assertCancelledAfterImageLoad(context => {
    context.state.aiSessionSwitchGeneration += 1;
  });

  const success = makeDeferredRequestContext();
  const successfulRequest = success.requestContext.requestPageExplanation(0, true);
  success.image.resolve('data:image/png;base64,AA==');
  await successfulRequest;
  assert.equal(success.calls.length, 1, 'the still-current page is sent');
  assert.equal(success.calls[0].targetLocale, 'zh-Hant');
  assert.equal(success.requestContext.state.aiExplainCache.get('local:A\u0000comic-A:0:zh-Hant'), 'translated');
}
console.log('PASS: deferred page fetches are invalidated after view, locale, session, or open-operation changes');

// Once invoked, provider work is not cancelled; its response is discarded if
// the reader was closed/reopened in the meantime, even for the same identity.
{
  function deferredApiContext() {
    const responses = [];
    const calls = [];
    const resultContext = {
      window: { GAIL10n: { locale: 'zh-Hant', t: source => source } },
      state: {
        currentComic: { id: 'comic-A', sourceId: 'local:A' },
        currentComicPages: ['page-A'], currentPageIndex: 0, readerOperation: 20,
        aiExplainCache: new Map(), aiExplainInFlight: false,
        aiExplainActiveRequest: null, aiExplainPendingPage: null,
        aiExplainPendingRequest: null, aiAutoExplain: false,
        aiSessionStatus: { configured: true }, aiSessionSwitchPending: false,
        aiSessionMutationPending: false, aiSessionRevocationFailed: false,
        aiSessionSwitchGeneration: 0, aiSessionMutationGeneration: 0,
      },
      elements: { aiPageResult: { textContent: '' }, btnAiExplain: { disabled: false } },
      eAPI: {
        explainPage: payload => {
          calls.push(payload);
          let resolve;
          let reject;
          const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
          responses.push({ resolve, reject });
          return promise;
        },
      },
      isBuiltInDemoComic: () => false,
      pageDataUrl: async () => 'data:image/png;base64,AA==',
      setAiPagePanelVisible() {}, syncReaderRotationUi() {},
      setAiSessionActionAvailability() {}, readerText: source => source,
      setAutoPageExplanation() {}, showReaderToast() {},
      localizeAiExplainError: error => error.message,
    };
    vm.runInNewContext(functions, resultContext);
    return { resultContext, calls, responses };
  }

  async function startInvokedRequest(fixture) {
    const request = fixture.resultContext.requestPageExplanation(0, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.calls.length, 1, 'request reaches eAPI before the reader is reopened');
    return { request };
  }

  for (const outcome of ['resolve', 'reject']) {
    const fixture = deferredApiContext();
    const { request } = await startInvokedRequest(fixture);
    fixture.resultContext.state.readerOperation += 2;
    fixture.resultContext.state.currentComic = { id: 'comic-A', sourceId: 'local:A' };
    fixture.resultContext.state.currentComicPages = ['page-A'];
    fixture.resultContext.state.currentPageIndex = 0;
    fixture.resultContext.state.aiExplainCache.clear();
    fixture.resultContext.elements.aiPageResult.textContent = 'new reader content';
    if (outcome === 'resolve') fixture.responses[0].resolve('stale translation');
    else fixture.responses[0].reject(new Error('stale provider error'));
    await request;
    assert.equal(fixture.resultContext.state.aiExplainCache.size, 0, `${outcome} from old reader is not cached`);
    assert.equal(fixture.resultContext.elements.aiPageResult.textContent, 'new reader content', `${outcome} from old reader is not painted`);
  }

  const current = deferredApiContext();
  const { request: currentRequest } = await startInvokedRequest(current);
  current.responses[0].resolve('current translation');
  await currentRequest;
  assert.equal(current.resultContext.state.aiExplainCache.get('local:A\u0000comic-A:0:zh-Hant'), 'current translation');
  assert.equal(current.resultContext.elements.aiPageResult.textContent, 'current translation');

  const reopened = deferredApiContext();
  const { request: oldRequest } = await startInvokedRequest(reopened);
  await reopened.resultContext.requestPageExplanation(0, false);
  assert.equal(reopened.calls.length, 1, 'same-view duplicate remains deduplicated');
  reopened.resultContext.state.readerOperation += 1;
  reopened.resultContext.state.currentComic = { id: 'comic-A', sourceId: 'local:A' };
  reopened.resultContext.state.currentComicPages = ['page-A'];
  reopened.resultContext.state.currentPageIndex = 0;
  await reopened.resultContext.requestPageExplanation(0, false);
  assert.equal(reopened.resultContext.state.aiExplainPendingRequest.readerOperation, 21);
  reopened.responses[0].resolve('old view result');
  await oldRequest;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened.calls.length, 2, 'same identity in a new reader operation is queued and started');
  assert.equal(reopened.resultContext.state.aiExplainActiveRequest.readerOperation, 21);
  reopened.responses[1].resolve('reopened view result');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened.resultContext.state.aiExplainCache.get('local:A\u0000comic-A:0:zh-Hant'), 'reopened view result');
  assert.equal(reopened.resultContext.elements.aiPageResult.textContent, 'reopened view result');

  const latestView = deferredApiContext();
  const { request: firstViewRequest } = await startInvokedRequest(latestView);
  latestView.resultContext.state.readerOperation += 1;
  latestView.resultContext.window.GAIL10n.locale = 'en';
  await latestView.resultContext.requestPageExplanation(0, false);
  latestView.resultContext.state.readerOperation += 1;
  latestView.resultContext.window.GAIL10n.locale = 'ja';
  await latestView.resultContext.requestPageExplanation(0, false);
  assert.equal(latestView.resultContext.state.aiExplainPendingRequest.readerOperation, 22);
  latestView.responses[0].resolve('first view result');
  await firstViewRequest;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(latestView.calls.map(call => call.targetLocale), ['zh-Hant', 'ja'],
    'a pending request from an older reader operation is replaced, not replayed');
  latestView.responses[1].resolve('third view result');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(latestView.resultContext.state.aiExplainCache.get('local:A\u0000comic-A:0:ja'), 'third view result');
  assert.equal(latestView.resultContext.elements.aiPageResult.textContent, 'third view result');
}
console.log('PASS: reader-operation queueing discards stale responses and resumes only the latest same-identity view');
