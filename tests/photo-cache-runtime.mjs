import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('SKIP: native photo-cache fixture requires macOS Swift/CryptoKit');
  process.exit(0);
}
const source = fs.readFileSync(new URL('../src-tauri/tauri-plugin-ios-folder/ios/Sources/PhotoLibraryPlugin.swift', import.meta.url), 'utf8');
const start = source.indexOf('private final class PhotoLibraryCache {');
const end = source.indexOf('private final class PhotoImageRequestCoordinator {', start);
assert.ok(start >= 0 && end > start);
let cache = source.slice(start, end);
// Redirect only the platform cache-directory lookup into a disposable fixture.
// The queue, membership, generation, file writes and cleanup execute unchanged.
const directoryLookup = /guard let caches = fileManager\.urls\(for: \.cachesDirectory, in: \.userDomainMask\)\.first else \{\s*return nil\s*\}/;
assert.match(cache, directoryLookup);
cache = cache.replace(directoryLookup, 'let caches = fixtureCacheBase');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-photo-cache-test-'));
try {
  const fixture = path.join(temporary, 'cache.swift');
  const binary = path.join(temporary, 'cache-test');
  fs.writeFileSync(fixture, `import Foundation
import CryptoKit
let fixtureCacheBase = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
${cache}
private let cache = PhotoLibraryCache.shared
let jpeg = Data([1, 2, 3])
let original = cache.currentGeneration()
precondition(cache.storeJPEG(jpeg, for: "small", assetID: "A", expectedGeneration: original) != nil)
precondition(cache.storeJPEG(jpeg, for: "large", assetID: "A", expectedGeneration: original) != nil)
precondition(cache.storeJPEG(jpeg, for: "small", assetID: "B", expectedGeneration: original) != nil)
cache.removeAssetsNotIn(["A"])
precondition(cache.cachedImage(for: "small", assetID: "A") != nil)
precondition(cache.cachedImage(for: "large", assetID: "A") != nil)
precondition(cache.cachedImage(for: "small", assetID: "B") == nil)
let pruned = cache.currentGeneration()
precondition(pruned != original)
precondition(cache.storeJPEG(jpeg, for: "late", assetID: "B", expectedGeneration: original) == nil)
cache.removeAssetsNotIn(["A"])
precondition(cache.currentGeneration() == pruned)
cache.removeAll()
precondition(cache.cachedImage(for: "small", assetID: "A") == nil)
precondition(cache.currentGeneration() != pruned)
precondition(cache.storeJPEG(jpeg, for: "late", assetID: "A", expectedGeneration: pruned) == nil)
print("PASS: native cache preserves visible variants, removes revoked assets, and rejects stale writes")
`);
  const compilation = spawnSync('swiftc', [fixture, '-o', binary], { encoding: 'utf8', timeout: 90000 });
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
  const execution = spawnSync(binary, [temporary], { encoding: 'utf8', timeout: 30000 });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  process.stdout.write(execution.stdout);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
