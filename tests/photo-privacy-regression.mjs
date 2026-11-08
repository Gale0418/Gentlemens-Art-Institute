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

const assetLookupStart = swift.indexOf('private func asset(_ assetID: String, inAlbum albumID: String, status: PHAuthorizationStatus) -> PHAsset? {');
const assetLookupEnd = swift.indexOf('\n  private func currentAssetIfReadable', assetLookupStart);
assert.ok(assetLookupStart >= 0 && assetLookupEnd > assetLookupStart, 'asset membership lookup exists');
const assetLookup = swift.slice(assetLookupStart, assetLookupEnd);
assert.match(assetLookup, /guard let asset = PHAsset\.fetchAssets\(withLocalIdentifiers: \[assetID\], options: nil\)\.firstObject,\s*asset\.mediaType == \.image else/, 'missing and non-image assets fail closed');
assert.match(assetLookup, /status == \.limited && albumID == "limited-library"/, 'limited authorization only accepts the limited-library pseudo-album');
assert.match(assetLookup, /status == \.authorized && albumID == "photo-library"/, 'full authorization retains the photo-library pseudo-album');
assert.match(assetLookup, /PHAssetCollection\.fetchAssetCollectionsContaining\(asset, with: \.album, options: nil\)/, 'user album membership uses Photos reverse lookup');
assert.match(assetLookup, /collections\.object\(at: index\)\.localIdentifier == albumID/, 'membership must match the requested collection identifier');
assert.doesNotMatch(assetLookup, /PHAsset\.fetchAssets\(in: collection/, 'membership lookup does not scan every asset in the requested album');

const albumDescriptorsStart = swift.indexOf('private func albumDescriptors() -> [PhotoAlbumReference] {');
const albumDescriptorsEnd = swift.indexOf('\n  private func photoLibraryDescriptor', albumDescriptorsStart);
assert.ok(albumDescriptorsStart >= 0 && albumDescriptorsEnd > albumDescriptorsStart, 'album listing source exists');
const albumDescriptors = swift.slice(albumDescriptorsStart, albumDescriptorsEnd);
assert.match(albumDescriptors, /PHAssetCollection\.fetchAssetCollections\(with: \.album, subtype: \.any, options: nil\)/, 'selectable collection IDs are fetched from the regular album type');
assert.doesNotMatch(albumDescriptors, /\.smartAlbum/, 'selectable albums do not include smart albums that use a distinct collection type');

console.log('PASS: photo progress reconciliation, membership cleanup, cache generation, and cache-hit revalidation');
