import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasReachedScanDepth, parseScanDepth } from '../scan-depth.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-depth-'));
let current = root;
for (let level = 1; level <= 7; level += 1) {
  current = path.join(current, `level-${level}`);
  fs.mkdirSync(current);
}
fs.writeFileSync(path.join(current, 'page.jpg'), 'fixture');

assert.equal(parseScanDepth(undefined), 3);
assert.equal(parseScanDepth('not-a-number'), 3);
assert.equal(parseScanDepth('-1'), 3);
assert.equal(parseScanDepth(Number.NaN), 3);
assert.equal(parseScanDepth('NaN'), 3);
assert.equal(parseScanDepth('999999999999999999999999'), 3);
assert.equal(parseScanDepth('0'), 0);
assert.equal(parseScanDepth('UNLIMITED'), Infinity);

function countVisited(maximumDepth) {
  let visited = 0;
  function walk(directory, depth) {
    if (hasReachedScanDepth(depth, maximumDepth)) return;
    visited += 1;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name), depth + 1);
    }
  }
  walk(root, 0);
  return visited;
}

assert.equal(countVisited(parseScanDepth(undefined)), 4);
assert.equal(countVisited(parseScanDepth('unlimited')), 8);

fs.rmSync(root, { recursive: true, force: true });
console.log('PASS: comic production depth policy bounds a seven-level temp tree');
