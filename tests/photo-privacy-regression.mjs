import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/photo_library.rs'), 'utf8');
const swift = fs.readFileSync(
  path.join(root, 'src-tauri/tauri-plugin-ios-folder/ios/Sources/PhotoLibraryPlugin.swift'),
  'utf8'
);

assert.match(rust, /fn progress_for_snapshot\(/);
assert.match(rust, /updated_at: progress\.updated_at\.clone\(\)/);
assert.match(rust, /unread_single_page_does_not_become_finished/);
assert.match(swift, /func removeAssetsNotIn\(_ assetIDs: Set<String>\)/);
assert.match(swift, /expectedGeneration: UInt64\?/);
assert.match(swift, /currentGeneration\(\) == request\.cacheGeneration/);

const cacheHitStart = swift.indexOf('if let cached = PhotoLibraryCache.shared.cachedImage');
const cacheHitEnd = swift.indexOf('PhotoImageRequestCoordinator.shared.enqueue', cacheHitStart);
assert.ok(cacheHitStart >= 0 && cacheHitEnd > cacheHitStart, 'cache-hit branch exists');
const cacheHit = swift.slice(cacheHitStart, cacheHitEnd);
assert.ok(
  cacheHit.indexOf('currentAssetIfReadable') < cacheHit.indexOf('resolve(cached)'),
  'cache hit revalidates current authorization and membership before resolving'
);
assert.match(swift, /PhotoLibraryCache\.shared\.removeAssetsNotIn\(currentAssetIDs\)/);
assert.match(swift, /PhotoLibraryCache\.shared\.removeAll\(\)/);

console.log('PASS: photo progress reconciliation, membership cleanup, cache generation, and cache-hit revalidation');
