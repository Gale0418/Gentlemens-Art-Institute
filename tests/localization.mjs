import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const runtime = fs.readFileSync('public/i18n.js', 'utf8');
function boot({ saved = null, languages = ['en-US'], writeFails = false } = {}) {
  const elements = [];
  let ready;
  let changed;
  let reloads = 0;
  const storage = new Map(saved == null ? [] : [['gai:language', saved]]);
  const select = { value: '', addEventListener: (_, fn) => { changed = fn; },
    parentElement: { appendChild: element => elements.push(element) } };
  const document = {
    documentElement: { lang: '' },
    addEventListener: (_, fn) => { ready = fn; },
    querySelectorAll: selector => elements.filter(element => element.attributes?.[selector.slice(1, -1)] !== undefined),
    getElementById: id => id === 'app-language-select' ? select : elements.find(element => element.id === id),
    createElement: () => ({ setAttribute() {}, textContent: '' }),
  };
  const context = { window: { location: { reload: () => { reloads++; } } }, document,
    navigator: { languages }, localStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => { if (writeFails) throw new Error('quota'); storage.set(key, value); },
    } };
  vm.runInNewContext(runtime, context);
  return { api: context.window.GAIL10n, context, document, elements, select, storage,
    ready: () => ready(), change: () => changed(), reloads: () => reloads };
}

assert.equal(boot({ languages: ['ja-JP'] }).api.locale, 'ja');
assert.equal(boot({ languages: ['zh-TW'] }).api.locale, 'zh-Hant');
assert.equal(boot({ languages: ['zh-CN'] }).api.locale, 'zh-Hant');
assert.equal(boot({ languages: ['fr-FR', 'ja-JP'] }).api.locale, 'ja');
assert.equal(boot({ languages: ['fr-FR'] }).api.locale, 'en');
assert.equal(boot({ saved: 'ja', languages: ['en-US'] }).api.locale, 'ja');
assert.equal(boot({ saved: 'invalid', languages: ['en-US'] }).api.locale, 'en');

const h = boot();
h.api.register({ '你好 {name}': { en: 'Hello {name}', ja: 'こんにちは {name}' } });
assert.equal(h.api.t('你好 {name}', { name: '<私人書名>{other}' }), 'Hello <私人書名>{other}');
assert.equal(h.api.t('未翻譯 {name}', { name: '原文' }), '未翻譯 原文');
assert.equal(h.api.t('{toString}'), '{toString}', 'inherited properties cannot become interpolation values');
const label = { textContent: '你好', attributes: { 'data-i18n': '你好 {name}' }, getAttribute(key) { return this.attributes[key]; } };
const privateTitle = { textContent: '你好 {name}', attributes: {}, getAttribute(key) { return this.attributes[key]; } };
h.elements.push(label, privateTitle);
h.ready();
assert.equal(label.textContent, 'Hello {name}');
assert.equal(privateTitle.textContent, '你好 {name}', 'unmarked library content is never translated');
assert.equal(h.document.documentElement.lang, 'en');
h.select.value = 'ja'; h.change();
assert.equal(h.storage.get('gai:language'), 'ja');
assert.equal(h.reloads(), 1);
assert.equal(boot({ saved: h.storage.get('gai:language') }).api.locale, 'ja', 'language survives relaunch');
assert.equal(h.api.setPreference('unsupported'), false);
const denied = boot({ writeFails: true }); denied.ready(); denied.select.value = 'ja'; denied.change();
assert.equal(denied.reloads(), 0, 'failed persistence does not reload and lose the requested setting silently');
assert.equal(denied.select.value, 'auto');
assert.ok(denied.elements.some(element => element.id === 'app-language-status' && element.textContent));

const dictionaries = {};
for (const file of ['static-messages.js', 'reader-messages.js', 'feature-messages.js']) {
  const source = fs.readFileSync(`public/locales/${file}`, 'utf8');
  vm.runInNewContext(source, { window: { GAIL10n: { register(entries) {
    for (const [key, translations] of Object.entries(entries)) {
      for (const locale of ['en', 'ja']) {
        assert.equal(typeof translations[locale], 'string', `${file}: missing ${locale}: ${key}`);
        assert.ok(translations[locale].trim(), `${file}: empty ${locale}: ${key}`);
        const slots = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
        assert.deepEqual(slots(translations[locale]), slots(key), `${file}: ${locale} placeholders: ${key}`);
      }
      if (dictionaries[key]) assert.deepEqual(JSON.stringify(translations), JSON.stringify(dictionaries[key]), `Conflicting translations: ${key}`);
      dictionaries[key] = translations;
    }
  } } } });
}
const html = fs.readFileSync('public/index.html', 'utf8');
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
for (const match of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]*)"/g)) {
  assert.ok(dictionaries[decode(match[1])], `Untranslated static UI: ${decode(match[1])}`);
}
for (const file of ['app.js', 'commerce.js', 'photo-library.js', 'tauri-api.js']) {
  const source = fs.readFileSync(`public/${file}`, 'utf8');
  // This grammar accepts only a single quoted literal, never executable arguments.
  for (const match of source.matchAll(/(?:readerText|featureText|bridgeText)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)) {
    const key = vm.runInNewContext(match[1]);
    assert.ok(dictionaries[key], `${file}: untranslated dynamic UI: ${key}`);
  }
}
assert.ok(html.indexOf('src="i18n.js"') < html.indexOf('src="tauri-api.js"'), 'localization loads before native bridge');
console.log(`PASS: locale selection, persistence, private-content boundaries, safe interpolation and ${Object.keys(dictionaries).length} translation keys`);

{
  const store = JSON.parse(fs.readFileSync('docs/release/store-localizations.json', 'utf8'));
  for (const locale of ['zh-Hant', 'en-US', 'ja']) {
    const entry = store.locales[locale];
    assert.ok(entry, `store listing must include ${locale}`);
    for (const field of ['appName', 'subtitle', 'promotionalText', 'description', 'keywords']) {
      assert.equal(typeof entry[field], 'string', `${locale} ${field}`);
      assert.ok(entry[field].trim(), `${locale} ${field} must not be empty`);
    }
  }
  const canonical = JSON.parse(fs.readFileSync('docs/release/gai-app-store-connect-metadata.json', 'utf8'));
  assert.equal(store.locales['zh-Hant'].description, canonical.storeListing.description, 'Traditional Chinese store copies must stay consistent');
}
console.log('PASS: all three store locales are complete and Traditional Chinese matches canonical copy');
