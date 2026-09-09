import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const bridge = fs.readFileSync('public/tauri-api.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
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
  /目前頁面影像與提示文字才會傳送至 \{provider\}/,
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
  /return invoke\('set_ai_session_config', \{ data \}\)/,
  'consented configuration must still use the validated native command'
);
assert.match(
  html,
  /id="ai-google-disclosure" type="checkbox"/,
  'legacy checkbox id must remain wired to the existing frontend save handler'
);
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
