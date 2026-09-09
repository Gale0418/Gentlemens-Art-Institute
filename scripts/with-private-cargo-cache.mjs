import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Cargo TOML does not expand $HOME. Resolve the per-user local cache here,
// keeping external/NAS checkouts away from unsupported filesystem locks.
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/with-private-cargo-cache.mjs <command> [args...]');
const cacheBase = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Caches', 'com.windsheep.gai')
  : path.join(os.homedir(), '.cache', 'gai');
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(cacheBase, 'cargo'));
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const info = fs.lstatSync(target);
if (!info.isDirectory() || info.isSymbolicLink()
  || (process.getuid && info.uid !== process.getuid())) {
  throw new Error('Cargo cache must be a directory owned by the current user, not a symlink');
}
if (process.getuid) {
  // A private leaf alone is insufficient if another user can replace it
  // through a writable parent. Sticky shared roots such as /tmp are safe
  // only after the leaf ownership check above.
  for (let parent = fs.realpathSync(path.dirname(target)); ; parent = path.dirname(parent)) {
    const ancestor = fs.statSync(parent);
    if ((ancestor.uid !== process.getuid() && ancestor.uid !== 0)
      || ((ancestor.mode & 0o022) && !(ancestor.mode & 0o1000))) {
      throw new Error('Cargo cache ancestors must prevent replacement by other users');
    }
    if (parent === path.dirname(parent)) break;
  }
}
fs.chmodSync(target, 0o700);
const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
