import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('SKIP: macOS App Store signer fixture requires Darwin');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-macos-signing-fixture-'));
const signer = path.resolve('scripts/release/sign-macos-app-store.sh');
const appIdentity = '3rd Party Mac Developer Application: Yun Yang Chiu (X3UYL4NRRN)';
const installerIdentity = '3rd Party Mac Developer Installer: Yun Yang Chiu (X3UYL4NRRN)';

const writeExecutable = (file, content) => {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
};
const writePlist = (file, content) => fs.writeFileSync(file, content.trimStart());

try {
  const app = path.join(root, 'real', 'source.app');
  const contents = path.join(app, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  writePlist(path.join(contents, 'Info.plist'), `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>gai</string>
<key>CFBundleIdentifier</key><string>com.windsheep.gai</string>
<key>CFBundleShortVersionString</key><string>1.0.3</string>
<key>CFBundleVersion</key><string>63</string>
</dict></plist>`);
  writeExecutable(path.join(macos, 'gai'), 'fixture-main');
  writeExecutable(path.join(macos, 'catalog-import'), 'fixture-helper');
  fs.writeFileSync(path.join(resources, 'icon.icns'), 'fixture-icon');

  const profile = path.join(root, 'profile.plist');
  writePlist(profile, `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Entitlements</key><dict>
<key>com.apple.application-identifier</key><string>X3UYL4NRRN.com.windsheep.gai</string>
<key>com.apple.developer.team-identifier</key><string>X3UYL4NRRN</string>
</dict>
<key>Platform</key><array><string>OSX</string></array>
<key>ExpirationDate</key><date>2099-01-01T00:00:00Z</date>
</dict></plist>`);

  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync('/usr/bin/plutil', path.join(bin, 'plutil'));
  const mockRoot = root.replaceAll('\\', '/');
  writeExecutable(path.join(bin, 'security'), `#!/bin/bash
if [[ "$1" == cms ]]; then cat "$4"; exit 0; fi
if [[ "$1" == find-identity ]]; then
  echo '  1) ABC "3rd Party Mac Developer Application: Yun Yang Chiu (X3UYL4NRRN)"'
  echo '  2) DEF "3rd Party Mac Developer Installer: Yun Yang Chiu (X3UYL4NRRN)"'
  exit 0
fi
exit 1`);
  writeExecutable(path.join(bin, 'file'), '#!/bin/bash\necho "$1: Mach-O universal binary"');
  writeExecutable(path.join(bin, 'lipo'), '#!/bin/bash\nif [[ "$2" == -verify_arch && "$3" == arm64 && "$4" == x86_64 && "$#" == 4 ]]; then exit 0; fi\nif [[ "$1" == -archs && "$#" == 2 ]]; then echo "${GAI_MOCK_ARCHS:-arm64 x86_64}"; exit 0; fi\necho "unsupported lipo argument order" >&2; exit 1');
  writeExecutable(path.join(bin, 'codesign'), `#!/bin/bash
target="\${@: -1}"
if [[ "$1" == --force ]]; then
  if [[ "$GAI_MOCK_SLEEP" == 1 ]]; then
    : > "$GAI_MOCK_READY"
    while [[ ! -f "$GAI_MOCK_RELEASE" ]]; do sleep 0.05; done
  fi
  ent='none'
  for ((i=1; i<=$#; i++)); do
    if [[ "\${!i}" == --entitlements ]]; then
      j=$((i+1)); ent=$(basename "\${!j}")
    fi
  done
  echo "SIGN|$(basename "$target")|$ent" >> "$GAI_MOCK_LOG"
  exit 0
fi
if [[ "$1" == -d ]]; then
  if [[ "$target" == *catalog-import ]]; then
    cat "$GAI_MOCK_ROOT/helper-entitlements.plist"
  else
    cat "$GAI_MOCK_ROOT/app-entitlements.plist"
  fi
  exit 0
fi
if [[ "$1" == -dv ]]; then
  echo "Authority=3rd Party Mac Developer Application: Yun Yang Chiu (X3UYL4NRRN)"
  echo "Identifier=com.windsheep.gai"
  exit 0
fi
if [[ "$1" == --verify ]]; then exit 0; fi
exit 1`);
  writeExecutable(path.join(bin, 'productbuild'), `#!/bin/bash
target="\${@: -1}"
: > "$target"
exit 0`);
  writeExecutable(path.join(bin, 'pkgutil'), `#!/bin/bash
if [[ "$1" == --check-signature ]]; then exit 0; fi
if [[ "$1" == --payload-files ]]; then echo "./紳士藝術研究所 Gentlemen's Art Institute.app/Contents/MacOS/gai"; exit 0; fi
exit 1`);
  writeExecutable(path.join(bin, 'mv'), `#!/bin/bash
if [[ "\${GAI_COMMIT_SIGNAL:-}" == 1 && "$2" == *commit-window.app ]]; then
  /bin/mv "$@"
  kill -TERM "$PPID"
  sleep 0.2
  exit 0
fi
exec /bin/mv "$@"`);

  writePlist(path.join(root, 'helper-entitlements.plist'), `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.inherit</key><true/>
</dict></plist>`);
  writePlist(path.join(root, 'app-entitlements.plist'), `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
</dict></plist>`);

  const sourceBefore = fs.readFileSync(path.join(macos, 'catalog-import'));
  const outputApp = path.join(root, 'out', 'signed.app');
  const outputPkg = path.join(root, 'out', 'signed.pkg');
  const log = path.join(root, 'sign.log');
  const environment = {
    ...process.env,
    // Deliberately omit ripgrep: the signer must run with the macOS baseline PATH.
    PATH: `${bin}:/usr/bin:/bin`,
    GAI_MOCK_ROOT: mockRoot,
    GAI_MOCK_LOG: log,
    GAI_MOCK_ARCHS: 'arm64 x86_64',
  };
  const runWithPaths = (profilePath, outputAppPath, outputPkgPath, sourceAppPath = app, extraEnvironment = {}) => spawnSync('bash', [
    signer,
    '--app', sourceAppPath,
    '--output-app', outputAppPath,
    '--profile', profilePath,
    '--pkg', outputPkgPath,
    '--version', '1.0.3',
    '--build-number', '63',
    '--application-identity', appIdentity,
    '--installer-identity', installerIdentity,
  ], { encoding: 'utf8', env: { ...environment, ...extraEnvironment } });
  const run = (profilePath) => runWithPaths(profilePath, outputApp, outputPkg);

  const invalidProfile = path.join(root, 'invalid.mobileprovision');
  fs.writeFileSync(invalidProfile, 'not a CMS profile');
  const failed = run(invalidProfile);
  const stagingEntries = () => fs.existsSync(path.join(root, 'out'))
    ? fs.readdirSync(path.join(root, 'out')).filter((entry) => entry.startsWith('.gai-macos-sign.'))
    : [];
  const waitForFile = async (file, label) => {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const waitForProcessGroupExit = async (pid) => {
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') return;
        throw error;
      }
      if (Date.now() >= deadline) throw new Error(`process group ${pid} did not exit`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  assert.notEqual(failed.status, 0, 'invalid profile must fail');
  assert.equal(fs.existsSync(outputApp), false, 'failed signing must not publish an App');
  assert.equal(fs.existsSync(outputPkg), false, 'failed signing must not publish a PKG');
  assert.deepEqual(fs.readFileSync(path.join(macos, 'catalog-import')), sourceBefore,
    'failed signing must not mutate the source App');
  assert.deepEqual(stagingEntries(), [],
    'failed signing must clean its task staging directory');

  const nestedOutputApp = path.join(app, 'nested-output.app');
  const nestedOutputPkg = path.join(root, 'out', 'nested-output.pkg');
  const nestedFailure = runWithPaths(profile, nestedOutputApp, nestedOutputPkg);
  assert.notEqual(nestedFailure.status, 0, 'output App inside source App must fail');
  assert.equal(fs.existsSync(nestedOutputApp), false);
  assert.equal(fs.existsSync(nestedOutputPkg), false);
  assert.deepEqual(fs.readFileSync(path.join(macos, 'catalog-import')), sourceBefore,
    'overlap rejection must not mutate the source App');

  const samePath = path.join(root, 'out', 'same-path');
  const samePathFailure = runWithPaths(profile, samePath, samePath);
  assert.notEqual(samePathFailure.status, 0, 'App and PKG output paths must differ');
  assert.equal(fs.existsSync(samePath), false);
  assert.deepEqual(stagingEntries(), [], 'overlap rejection must not leave staging');

  const dotOverlapApp = `${root}/missing-parent/../real/source.app/dot-output.app`;
  const dotOverlapPkg = path.join(root, 'out', 'dot-output.pkg');
  const dotOverlapFailure = runWithPaths(profile, dotOverlapApp, dotOverlapPkg);
  assert.notEqual(dotOverlapFailure.status, 0,
    'normalized output under source App must fail even through missing/../ components');
  assert.equal(fs.existsSync(dotOverlapApp), false);
  assert.equal(fs.existsSync(dotOverlapPkg), false);
  assert.equal(fs.existsSync(path.join(root, 'missing-parent')), false,
    'overlap rejection must happen before creating missing output parents');
  assert.deepEqual(stagingEntries(), [], 'dot overlap rejection must not leave staging');

  const symlinkDotAlias = path.join(root, 'alias');
  fs.symlinkSync(app, symlinkDotAlias, 'dir');
  const symlinkDotApp = `${root}/alias/../source.app/symlink-dot-output.app`;
  const symlinkDotPkg = path.join(root, 'out', 'symlink-dot-output.pkg');
  const symlinkDotFailure = runWithPaths(profile, symlinkDotApp, symlinkDotPkg);
  assert.notEqual(symlinkDotFailure.status, 0,
    'symlink-resolved .. output under source App must fail overlap validation');
  assert.equal(fs.existsSync(symlinkDotApp), false);
  assert.equal(fs.existsSync(symlinkDotPkg), false);
  assert.equal(fs.lstatSync(symlinkDotAlias).isSymbolicLink(), true,
    'symlink overlap rejection must not mutate the alias');
  assert.deepEqual(stagingEntries(), [], 'symlink dot overlap must not leave staging');

  const sourceSymlink = path.join(root, 'source-link.app');
  fs.symlinkSync(app, sourceSymlink, 'dir');
  const symlinkOutputApp = path.join(root, 'out', 'symlink-signed.app');
  const symlinkOutputPkg = path.join(root, 'out', 'symlink-signed.pkg');
  const symlinkSuccess = runWithPaths(profile, symlinkOutputApp, symlinkOutputPkg, sourceSymlink);
  assert.equal(symlinkSuccess.status, 0, symlinkSuccess.stderr || symlinkSuccess.stdout);
  assert.equal(fs.lstatSync(sourceSymlink).isSymbolicLink(), true,
    'source symlink must remain a symlink');
  assert.deepEqual(fs.readFileSync(path.join(macos, 'catalog-import')), sourceBefore,
    'canonicalized symlink source must remain unchanged');
  assert.deepEqual(stagingEntries(), [], 'symlink source signing must clean staging');

  const successful = run(profile);
  assert.equal(successful.status, 0, successful.stderr || successful.stdout);
  assert.equal(fs.existsSync(outputApp), true);
  assert.equal(fs.existsSync(outputPkg), true);
  assert.deepEqual(stagingEntries(), [],
    'successful signing must clean its task staging directory');
  const signingOrder = fs.readFileSync(log, 'utf8').trim().split('\n')
    .filter((line) => line.startsWith('SIGN|'));
  assert.deepEqual(signingOrder.slice(-3), [
    'SIGN|catalog-import|Entitlements-macOS-helper.plist',
    'SIGN|gai|Entitlements-macOS.plist',
    'SIGN|signed.app|Entitlements-macOS.plist',
  ], 'helpers must be signed before the main executable and outer app');
  assert.deepEqual(fs.readFileSync(path.join(macos, 'catalog-import')), sourceBefore,
    'successful signing must still leave the source App unchanged');

  const extraArchApp = path.join(root, 'out', 'extra-arch.app');
  const extraArchPkg = path.join(root, 'out', 'extra-arch.pkg');
  const extraArchFailure = runWithPaths(profile, extraArchApp, extraArchPkg, app,
    { GAI_MOCK_ARCHS: 'arm64 x86_64 armv7' });
  assert.notEqual(extraArchFailure.status, 0, 'extra architecture must fail strict universal validation');
  assert.equal(fs.existsSync(extraArchApp), false);
  assert.equal(fs.existsSync(extraArchPkg), false);
  assert.deepEqual(stagingEntries(), [], 'extra architecture failure must clean staging');

  const commitWindowApp = path.join(root, 'out', 'commit-window.app');
  const commitWindowPkg = path.join(root, 'out', 'commit-window.pkg');
  const commitInterrupted = await new Promise((resolve) => {
    const child = spawn('bash', [
      signer,
      '--app', app,
      '--output-app', commitWindowApp,
      '--profile', profile,
      '--pkg', commitWindowPkg,
      '--version', '1.0.3',
      '--build-number', '63',
      '--application-identity', appIdentity,
      '--installer-identity', installerIdentity,
    ], { env: { ...environment, GAI_COMMIT_SIGNAL: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  assert.ok(commitInterrupted.signal === 'SIGTERM' || commitInterrupted.code === 143,
    'commit-window SIGTERM must stop the signer');
  assert.equal(fs.existsSync(commitWindowApp), false,
    'commit-window interruption must roll back the App');
  assert.equal(fs.existsSync(commitWindowPkg), false,
    'commit-window interruption must not leave a PKG');
  assert.deepEqual(stagingEntries(), [], 'commit-window interruption must clean staging');

  const existingOutput = fs.readFileSync(outputPkg);
  const protectedRun = run(profile);
  assert.notEqual(protectedRun.status, 0, 'existing outputs must not be overwritten');
  assert.deepEqual(fs.readFileSync(outputPkg), existingOutput,
    'existing PKG must remain unchanged after a rejected rerun');

  const signalOutputApp = path.join(root, 'out', 'signal.app');
  const signalOutputPkg = path.join(root, 'out', 'signal.pkg');
  const signalReady = path.join(root, 'signal-ready');
  const signalEnvironment = {
    ...environment,
    GAI_MOCK_SLEEP: '1',
    GAI_MOCK_READY: signalReady,
    GAI_MOCK_RELEASE: path.join(root, 'signal-release'),
  };
  let signalChild;
  try {
    signalChild = spawn('bash', [
      signer,
      '--app', app,
      '--output-app', signalOutputApp,
      '--profile', profile,
      '--pkg', signalOutputPkg,
      '--version', '1.0.3',
      '--build-number', '63',
      '--application-identity', appIdentity,
      '--installer-identity', installerIdentity,
    ], { detached: true, env: signalEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => {
      signalChild.on('close', (code, signal) => resolve({ code, signal }));
    });
    await waitForFile(signalReady, 'codesign signal fixture');
    process.kill(-signalChild.pid, 'SIGTERM');
    const interrupted = await closed;
    assert.ok(interrupted.signal === 'SIGTERM' || interrupted.code === 143,
      'SIGTERM must stop the signer without continuing');
    await waitForProcessGroupExit(signalChild.pid);
    assert.equal(fs.existsSync(signalOutputApp), false, 'interrupted signing must not publish an App');
    assert.equal(fs.existsSync(signalOutputPkg), false, 'interrupted signing must not publish a PKG');
    assert.deepEqual(stagingEntries(), [], 'interrupted signing must clean its staging directory');
  } finally {
    if (signalChild?.pid) {
      try {
        process.kill(-signalChild.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  console.log('PASS: macOS App Store signer fixture protects source/output and signs helpers first');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
