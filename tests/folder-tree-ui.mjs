import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const helperSource = [
  'const BUILT_IN_DEMO_SOURCE_ID = "builtin:demo";',
  extractFunction(app, 'getFolderTreeSourceId'),
  extractFunction(app, 'normalizeFolderTreePath'),
  extractFunction(app, 'getFolderTreeNodeKey'),
  extractFunction(app, 'getFolderTreeSourceLabel'),
  extractFunction(app, 'collectFolderTreeNodes'),
  'return collectFolderTreeNodes();',
].join('\n');

const collect = (state) => new Function('state', 'readerText', helperSource)(state, text => text);
const nodes = collect({
  visibleDirectories: new Map([['', ['同名資料夾']]]),
  comics: [
    { id: 'local-book', relativePath: '同名資料夾/local.cbz', sourceId: 'local:library' },
    { id: 'smb-book', relativePath: '同名資料夾/smb.cbz', sourceId: 'smb' },
    { id: 'files-book', relativePath: '📁 外部裝置/Files/同名資料夾/files.cbz', sourceId: 'external:files' },
  ],
});

const sameNameNodes = [...nodes.values()].filter(node => node.path === '同名資料夾');
assert.equal(sameNameNodes.length, 1, 'same paths stay a single navigable row');
assert.deepEqual(sameNameNodes[0]?.sourceIds, new Set(['local:library', 'smb']), 'known source identities remain attached to the path row');
assert.ok(sameNameNodes[0]?.hasSourceCollision, 'same paths expose a source collision instead of silently merging');
assert.ok([...nodes.values()].some(node => node.path === '📁 外部裝置/Files/同名資料夾' && node.sourceIds.has('external:files')), 'Files path keeps its source identity');

const oneKnownSource = collect({
  visibleDirectories: new Map([['', ['單一來源']]]),
  comics: [{ id: 'local-only', relativePath: '單一來源/book.cbz', sourceId: 'local:library' }],
});
assert.equal(oneKnownSource.get('unknown\u0000單一來源')?.hasSourceCollision, false, 'unattributed scan data does not create a false source collision');

const emptyVisibleFolderNodes = collect({
  visibleDirectories: new Map([['', ['尚未載入漫畫']]]),
  comics: [],
});
assert.equal(emptyVisibleFolderNodes.get('unknown\u0000尚未載入漫畫')?.fromVisibleDirectories, true, 'empty visible folders remain scan-capable');

assert.match(html, /class="series-list folder-tree"[^>]*role="tree"/, 'sidebar uses an accessible tree');
assert.match(html, /id="folder-tree-current-path"[^>]*aria-live="polite"/, 'sidebar exposes the current path');
assert.match(app, /if \(hasChildren && expanded\) \{[\s\S]*renderChildren\(group, node\.path/, 'collapsed descendants are not rendered');
assert.match(app, /canScanChildren = node\.fromVisibleDirectories[\s\S]*requestVisibleDirectoryScan\(node\.path, \{ force: false, announce: false \}\)/, 'visible-only folders trigger a shallow scan on first expand');
assert.match(app, /visibleDirectoryScanInFlight\.get\(relativePath\)/, 'repeated folder expands reuse an in-flight scan');
assert.match(app, /state\.visibleDirectories\.forEach\(paths =>/, 'tree uses the existing visible directory cache');
assert.match(app, /requestVisibleDirectoryScan\(state\.currentPath\)/, 'navigation keeps shallow visible directory scans');
assert.match(css, /\.folder-tree-toggle[\s\S]*min-height: 44px/, 'tree disclosure controls meet touch target size');
assert.match(css, /\.folder-tree-enter[\s\S]*min-height: 44px/, 'tree navigation controls meet touch target size');

console.log('PASS: folder tree keeps source identities and renders only expanded descendants');
