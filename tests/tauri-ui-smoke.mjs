import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (path) => fs.readFileSync(path, 'utf8');
const exists = (path) => fs.existsSync(path);
const mustContain = (source, needle, label) => {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
};

const app = read('public/app.js');
const html = read('public/index.html');
const css = read('public/style.css');
const bridge = read('public/tauri-api.js');
const tauri = read('src-tauri/src/lib.rs');
const protocol = read('src-tauri/src/protocol.rs');
const scanner = read('src-tauri/src/scanner.rs');
const catalog = read('src-tauri/src/catalog.rs');
const cache = read('src-tauri/src/cache.rs');
const cachePolicy = read('src-tauri/src/cache_policy.rs');
const fileOps = read('src-tauri/src/file_ops.rs');
const tauriConfig = read('src-tauri/tauri.conf.json');
const cargoManifest = read('src-tauri/Cargo.toml');
const appleProject = read('src-tauri/gen/apple/project.yml');
const patchedWry = read('src-tauri/vendor/wry/src/wkwebview/mod.rs');
const iosFolderPlugin = read('src-tauri/tauri-plugin-ios-folder/ios/Sources/ExamplePlugin.swift');
const capabilities = read('src-tauri/capabilities/default.json');
const pkg = JSON.parse(read('package.json'));

// The supported runtime is Tauri only. Old Electron/Express entry points and
// their packaging icon must not silently return to the repository.
for (const legacyPath of [
  'main.js',
  'preload.js',
  'server.js',
  'scan-depth.js',
  'LEGACY.md',
  'assets/icon.png',
  'tests/ui-smoke.mjs',
  'tests/cache-hardening.cjs',
  'tests/scan-depth-behavior.mjs',
]) {
  assert.equal(exists(legacyPath), false, `legacy runtime artifact must stay removed: ${legacyPath}`);
}
assert.equal(pkg.main, undefined, 'package.json must not expose an Electron main entry');
assert.equal(pkg.scripts?.start, undefined, 'Express start script must stay removed');
assert.equal(pkg.scripts?.electron, undefined, 'Electron launch script must stay removed');
assert.equal(pkg.scripts?.['build:electron'], undefined, 'Electron build script must stay removed');
assert.equal(pkg.dependencies, undefined, 'Node runtime dependencies are not needed by the Tauri app');
assert.deepEqual(Object.keys(pkg.devDependencies || {}), ['@tauri-apps/cli']);

for (const asset of ['cover.jpg', 'page-01.jpg', 'page-02.jpg']) {
  const path = `public/assets/demo/moonlit-archive/${asset}`;
  const stat = fs.statSync(path, { throwIfNoEntry: false });
  assert.ok(stat?.isFile() && stat.size > 0, `built-in demo asset should exist: ${path}`);
}

// Product UI and accessibility invariants.
for (const id of [
  'continue-strip', 'organize-bar', 'tag-library-list', 'catalog-load-more',
  'organize-inbox', 'organize-duplicates', 'btn-ai-explain', 'btn-ai-auto-explain',
  'ai-api-key', 'scan-dir-status', 'library-source-btn', 'library-source-alert',
  'library-source-settings-btn', 'comic-inspector', 'reader-context-menu',
  'theme-picker', 'library-card-size', 'series-filter-list', 'sidebar-collapse-btn',
  'series-filter-select', 'loader-progress', 'catalog-import-input',
]) {
  mustContain(html, `id="${id}"`, `UI control ${id}`);
}
mustContain(html, 'viewport-fit=cover', 'iPad safe-area viewport');
mustContain(html, 'role="dialog" aria-modal="true" aria-labelledby="reader-comic-title"', 'reader dialog semantics');
mustContain(html, 'role="dialog" aria-modal="true" aria-labelledby="settings-title"', 'settings dialog semantics');
assert.equal((html.match(/id="progress-slider"/g) || []).length, 1, 'progress slider id must be unique');
assert.doesNotMatch(html, /class="nav-arrow"/, 'reader arrows must not cover comic pages');
assert.doesNotMatch(html, /data-filter-shortcut=/, 'duplicate smart collection controls must stay removed');

// Shared frontend remains the Tauri UI, with the historical electronAPI name
// acting only as an internal compatibility facade installed by tauri-api.js.
mustContain(bridge, 'window.electronAPI = {', 'Tauri compatibility facade');
mustContain(bridge, "invoke('open_comic'", 'native reader bridge');
mustContain(bridge, "invoke('update_reader_cache_window'", 'native cache-window bridge');
mustContain(bridge, "invoke('save_progress'", 'native progress bridge');
mustContain(bridge, "invoke('plugin:dialog|open'", 'native folder picker');
mustContain(bridge, "invoke('mutate_comic_file'", 'native file mutation bridge');
mustContain(bridge, "invoke('scan_library'", 'native scan command');
mustContain(app, 'function scheduleLibraryRefresh', 'coalesced library refresh');
mustContain(app, 'fetchLibrary({ background: true })', 'background library refresh');
mustContain(app, 'skipUnchanged && renderSignature === lastGridRenderSignature', 'unchanged shelf avoids DOM rebuild');
mustContain(app, 'renderSignature === lastContinueRenderSignature', 'continue strip avoids DOM rebuild');
mustContain(app, 'function scheduleReaderCacheWindowUpdate', 'reader cache scheduling');
mustContain(app, 'function prunePreloadedImages', 'bounded reader preload');
mustContain(app, 'function showLoaderProgress', 'background loader progress');
mustContain(app, 'function setOrganizeMode', 'catalog organizer');
mustContain(app, 'function refreshCatalogSearch', 'SQLite catalog search UI');
mustContain(app, 'function previewCatalogMetadataFile', 'catalog exchange preview');
mustContain(app, "'assets/demo/moonlit-archive/cover.jpg'", 'built-in demo cover');
assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*api[-_ ]?key/i, 'AI keys must never enter localStorage');

// Formal native authority and security boundaries.
mustContain(tauriConfig, 'com.windsheep.gai', 'Tauri bundle identifier');
mustContain(appleProject, 'com.windsheep.gai', 'Apple bundle identifier');
mustContain(cargoManifest, 'wry = { path = "vendor/wry" }', 'required local Wry patch');
mustContain(capabilities, 'dialog:allow-open', 'native dialog permission');
mustContain(capabilities, 'ios-folder:allow-pick-folder', 'iOS folder permission');
mustContain(tauri, 'search_catalog', 'catalog search command');
mustContain(tauri, 'apply_batch_metadata', 'catalog batch command');
mustContain(tauri, 'mutate_comic_file', 'catalog-identity file mutation command');
mustContain(tauri, 'undo_comic_file_operation', 'recoverable file operation command');
mustContain(tauri, 'get_online_services_config', 'offline-by-default services contract');
mustContain(tauri, 'suggest_comic_metadata', 'AI metadata candidate command');
mustContain(scanner, 'publish_partial_library', 'progressive scan publication');
mustContain(scanner, 'merge_discovered_comics', 'scan refresh keeps previous shelf visible');
mustContain(catalog, "source_id LIKE 'local:%'", 'local source retirement');
mustContain(catalog, 'reading_progress', 'SQLite reading progress authority');
mustContain(protocol, 'MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024', 'page byte safety cap');
mustContain(protocol, 'MUTABLE_IMAGE_CACHE_CONTROL: &str = "no-store"', 'mutable folder-page cache policy');
mustContain(protocol, 'fn route_shape_is_valid', 'strict gai route shape');
mustContain(cache, 'MAX_PRELOAD_PAGE_BYTES: usize = 64 * 1024 * 1024', 'preload page cap');
mustContain(cachePolicy, 'nearest_first_indices', 'nearest-first cache selection');
mustContain(fileOps, 'ErrorKind::NotFound', 'typed SMB missing-path handling');
mustContain(fileOps, 'fail_smb_journal', 'SMB mutation journal failures');
mustContain(iosFolderPlugin, 'startDownloadingUbiquitousItem', 'iCloud materialization');
mustContain(iosFolderPlugin, 'stopAccessingSecurityScopedResource()', 'security-scope cleanup');

assert.match(
  patchedWry,
  /#\[cfg\(target_os = "ios"\)\][\s\S]{0,420}(?:WKWebView \(iOS system framework\)|operating_system_version)/,
  'iOS startup must avoid the unavailable WebKit bundle query'
);
assert.match(pkg.scripts?.quality || '', /npm test/);
assert.match(pkg.scripts?.quality || '', /check:rustfmt/);
assert.match(pkg.scripts?.quality || '', /test:rust/);
assert.match(pkg.scripts?.quality || '', /check:clippy/);

console.log('PASS: Tauri-only UI, native authority, and packaging smoke checks are enforced');
