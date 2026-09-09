import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (path) => fs.readFileSync(path, 'utf8');
const state = read('src-tauri/src/state.rs');
const scanner = read('src-tauri/src/scanner.rs');
const smbScanner = read('src-tauri/src/smb_scanner.rs');
const fileOps = read('src-tauri/src/file_ops.rs');
const cache = read('src-tauri/src/cache.rs');
const cachePolicy = read('src-tauri/src/cache_policy.rs');
const protocol = read('src-tauri/src/protocol.rs');
const utils = read('src-tauri/src/utils.rs');
const swift = read('src-tauri/tauri-plugin-ios-folder/ios/Sources/ExamplePlugin.swift');
const tauriApi = read('public/tauri-api.js');
const pkg = JSON.parse(read('package.json'));

assert.match(state, /#\[cfg\(target_os = "ios"\)\][\s\S]{0,500}fn process_available_memory_bytes\(\)[\s\S]{0,500}os_proc_available_memory/);
assert.match(state, /#\[cfg\(target_os = "macos"\)\][\s\S]{0,260}fn process_available_memory_bytes\(\)[\s\S]{0,260}None/);
assert.match(state, /candidates\.sort_unstable_by/, 'memory-pressure eviction must sort once rather than rescan after every removal');
assert.match(state, /is_active[\s\S]{0,500}left\.0\s*\.cmp\(&right\.0\)/, 'inactive books must be evicted before the active reader');

assert.match(smbScanner, /SMB_CONNECT_TIMEOUT[\s\S]*Duration::from_secs\(10\)/);
assert.match(smbScanner, /SMB_IO_TIMEOUT[\s\S]*Duration::from_secs\(30\)/);
assert.match(smbScanner, /MAX_SMB_SCAN_DEPTH/);
assert.match(smbScanner, /format!\("\.\/\{relative_path\}"\)/);
assert.match(smbScanner, /!name\.contains\('\\\\'\)/);

assert.match(fileOps, /error\.kind\(\) == smb2::ErrorKind::NotFound/);
assert.match(fileOps, /NAS 檔案自動還原也失敗/);
assert.match(fileOps, /trimmed\.contains\('\\\\'\)/);
assert.match(fileOps, /fail_smb_journal/);

assert.match(cache, /MAX_PRELOAD_PAGE_BYTES: usize = 64 \* 1024 \* 1024/);
assert.match(cache, /page_limit = remaining\.min\(MAX_PRELOAD_PAGE_BYTES\)/);
assert.match(cachePolicy, /fn nearest_first_indices/);
assert.match(cachePolicy, /indices: nearest_first/);
assert.doesNotMatch(
  cachePolicy,
  /indices:\s*\(0\.\.page_sizes\.len\(\)\)\.collect\(\)/,
  'whole-book preload must not revert to page-zero-first ordering'
);

assert.match(protocol, /let index: usize = match parts\[2\]\.parse\(\)/);
assert.doesNotMatch(protocol, /parts\[2\]\.parse\(\)\.unwrap_or\(0\)/);
assert.match(protocol, /comic_info\.source_id == "smb"/);
assert.match(protocol, /crate::utils::safe_archive_entry_name/);
assert.match(protocol, /fn route_shape_is_valid/);
assert.match(protocol, /MUTABLE_IMAGE_CACHE_CONTROL: &str = "no-store"/);
assert.doesNotMatch(protocol, /Cache-Control", "public, max-age=86400"/);
assert.match(utils, /file_type\.is_symlink\(\)/);
assert.match(utils, /part\.starts_with\('\.'\)/, 'hidden ZIP components must stay out of the reader page index');
assert.match(utils, /entry_names\.dedup\(\)/, 'duplicate ZIP entry names must not create duplicate logical pages');
assert.match(utils, /file_name\.starts_with\('\.'\)/, 'hidden filesystem images must match scanner policy');

assert.match(scanner, /has_smb_source/);
assert.match(scanner, /offline_smb_snapshot/);
assert.match(scanner, /let id = smb_runtime_id\(&relative_path\)/, 'offline SMB migration must rebuild current source-scoped IDs');
assert.doesNotMatch(scanner, /runtime_id\.unwrap_or_else/, 'offline SMB must not trust legacy unscoped runtime IDs');
assert.match(scanner, /!active.contains\(source\)/, 'external cleanup must retain sources still being scanned');
assert.match(scanner, /file_type\.is_symlink\(\)/);

assert.match(swift, /activePickers\.removeValue\(forKey: picker\)/);
assert.match(swift, /stopAccessingSecurityScopedResource\(\)/);
assert.match(swift, /resolvingSymlinksInPath\(\)/);
assert.match(swift, /self\?\.memoryPressureSource\?\.data/);
assert.match(
  swift,
  /let resolution:[\s\S]{0,500}accessQueue\.sync[\s\S]{0,900}startAccessingSecurityScopedResource\(\)[\s\S]{0,300}activeAccesses\[bookmark\] = url/,
  'security-scope existence check, acquisition and registration must be serialized atomically'
);

const documentStub = { getElementById: () => null, createTextNode: (text) => ({ textContent: text }) };
const sandbox = { window: { __TAURI__: null }, document: documentStub, console };
vm.createContext(sandbox);
vm.runInContext(tauriApi, sandbox, { filename: 'public/tauri-api.js' });

const normalized = sandbox.normalizeReaderData({ pages: ['a', 'b', 'c'], progress: { currentPage: 999, totalPages: 999, percent: 1 } });
assert.equal(normalized.progress.currentPage, 2);
assert.equal(normalized.progress.totalPages, 3);
assert.equal(normalized.progress.percent, 100);
const progress = sandbox.normalizeProgressPayload({ id: 'comic', currentPage: 9, totalPages: 3 });
assert.deepEqual(JSON.parse(JSON.stringify(progress)), { id: 'comic', currentPage: 2, totalPages: 3 });
assert.throws(() => sandbox.normalizeProgressPayload({ id: '', currentPage: 0, totalPages: 1 }));
assert.throws(() => sandbox.normalizeProgressPayload({ id: 'comic', currentPage: Number.NaN, totalPages: 1 }));

sandbox.rememberAuthoritativeLibraryProgress([
  { id: 'smb-book', progress: { currentPage: 86, totalPages: 120, percent: 72.5, updatedAt: '2026-09-04T00:00:00Z' } },
]);
const authoritativeReader = sandbox.normalizeReaderData(sandbox.readerDataWithAuthoritativeProgress('smb-book', {
  id: 'smb-book',
  pages: Array.from({ length: 120 }, (_, index) => `p${index}`),
  progress: { currentPage: 0, totalPages: 0, percent: 0 },
}));
assert.equal(authoritativeReader.progress.currentPage, 86, 'reader must honor SQLite-overlay progress returned by getLibrary');
assert.equal(authoritativeReader.progress.totalPages, 120);
sandbox.rememberSavedProgress({ id: 'smb-book', currentPage: 119, totalPages: 120 });
const staleRefresh = sandbox.rememberAuthoritativeLibraryProgress([
  { id: 'smb-book', progress: { currentPage: 2, totalPages: 120, percent: 2.5, updatedAt: '2000-01-01T00:00:00Z' } },
]);
assert.equal(staleRefresh[0].progress.currentPage, 119, 'an older background refresh must not rewind a successful save');
assert.equal(staleRefresh[0].progress.percent, 100);

sandbox.rememberAuthoritativeLibraryProgress([
  { id: 'resume-book', progress: { currentPage: 7, totalPages: 10, percent: 80, updatedAt: '2026-09-04T01:00:00Z' } },
]);
const invokeCalls = [];
const fakeInvoke = async (command, args) => {
  invokeCalls.push({ command, args });
  if (command === 'open_comic') {
    return {
      id: 'resume-book',
      pages: Array.from({ length: 10 }, (_, index) => `page-${index}`),
      progress: { currentPage: 0, totalPages: 0, percent: 0 },
      preloadGeneration: 1,
    };
  }
  if (command === 'update_reader_cache_window') return 9;
  throw new Error(`unexpected command: ${command}`);
};
const resumed = await sandbox.openComicWithAuthoritativeProgress(fakeInvoke, 'resume-book');
assert.equal(resumed.progress.currentPage, 7);
assert.equal(resumed.preloadGeneration, 9);
assert.deepEqual(
  JSON.parse(JSON.stringify(invokeCalls)),
  [
    { command: 'open_comic', args: { id: 'resume-book' } },
    { command: 'update_reader_cache_window', args: { comicId: 'resume-book', pageIndex: 7 } },
  ],
  'stale native preload must be realigned exactly once to the authoritative resume page'
);

const noRealignCalls = [];
await sandbox.openComicWithAuthoritativeProgress(async (command, args) => {
  noRealignCalls.push({ command, args });
  return {
    id: 'already-aligned',
    pages: ['a', 'b'],
    progress: { currentPage: 0, totalPages: 2, percent: 0 },
  };
}, 'already-aligned');
assert.equal(noRealignCalls.length, 1, 'already aligned readers must not restart preload work');

const smb = sandbox.normalizeSmbConfig({ host: '  nas.local ', share: ' Comics ', username: ' test-user ', password: 'secret' });
assert.deepEqual(JSON.parse(JSON.stringify(smb)), { host: 'nas.local', share: 'Comics', username: 'test-user', password: 'secret' });
assert.equal(sandbox.normalizeSmbConfig(null), null);
assert.throws(() => sandbox.normalizeSmbConfig({ host: '', share: 'Comics' }));
assert.throws(() => sandbox.normalizeSmbConfig({ host: 'nas.local', share: '../Comics' }));
assert.throws(() => sandbox.normalizeSmbConfig({ host: 'nas/local', share: 'Comics' }));

assert.match(pkg.scripts?.quality || '', /npm test/);
assert.match(pkg.scripts?.quality || '', /check:rustfmt/);
assert.match(pkg.scripts?.quality || '', /test:rust/);
assert.match(pkg.scripts?.quality || '', /check:clippy/);
assert.equal(fs.existsSync('.github/workflows'), false, 'GitHub Actions must stay absent while the user has no CI quota');
console.log('PASS: release hardening invariants are locked');

// The cache wrapper must preserve command results without trusting symlinks
// or a parent directory that another account could use to swap artifacts.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-cache-check-'));
  try {
    const cache = path.join(root, 'cache');
    const run = (target, code) => spawnSync(process.execPath,
      ['scripts/with-private-cargo-cache.mjs', process.execPath, '-e', code],
      { encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: target } });
    const result = run(cache, 'console.log(process.env.CARGO_TARGET_DIR); process.exit(7)');
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout.trim(), cache);
    if (process.getuid) assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
    const link = path.join(root, 'link');
    fs.symlinkSync(cache, link, 'dir');
    assert.notEqual(run(link, 'process.exit(0)').status, 0, 'a cache symlink must never execute the command');
    if (process.getuid) {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      assert.notEqual(run(path.join(shared, 'cache'), 'process.exit(0)').status, 0, 'non-sticky writable ancestors permit artifact replacement');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log('PASS: private Cargo cache ownership, permissions, symlink/ancestor rejection and exit status');

// Execute only the documented path guard, never its deletion/build examples.
if (process.platform !== 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-build-guard-'));
  try {
    const guide = fs.readFileSync('BUILD_GUIDE.md', 'utf8');
    const guard = guide.match(/```bash\n(fail_validation\(\)[\s\S]*?\nvalidate_build_paths)\n```/)?.[1];
    assert.ok(guard, 'build guide must retain an executable path guard');
    const run = (work, extract) => spawnSync('bash', ['-c', guard], {
      encoding: 'utf8',
      env: { ...process.env, GAI_PROJECT_DIR: process.cwd(), GAI_DEVICE_ID: 'fixture',
        GAI_IOS_WORK_DIR: work, GAI_IPA_EXTRACT_DIR: extract },
    });
    const work = path.join(root, 'work');
    const extract = path.join(root, 'extract');
    assert.equal(run(work, extract).status, 0, 'separate task directories remain valid');
    for (const shared of ['/tmp', '/var/tmp', os.tmpdir()].filter(p => fs.existsSync(p))) {
      for (const alias of [shared, fs.realpathSync(shared)]) {
        assert.equal(run(alias, extract).status, 2, `work must reject shared root ${alias}`);
        assert.equal(run(work, alias).status, 2, `extract must reject shared root ${alias}`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log('PASS: documented build guard rejects shared temporary roots and their canonical aliases');
