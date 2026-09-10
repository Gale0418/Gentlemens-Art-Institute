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
assert.equal(context.elements.aiPageResult.textContent, '艦載 AI 正在閱讀第 1 頁…');

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
