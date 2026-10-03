import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/sync-ios-privacy.mjs');
const canonical = fs.readFileSync(path.join(root, 'src-tauri/ios-privacy/PrivacyInfo.xcprivacy'));

const fixtureProject = targetName => {
 const container = targetName;
 const lf = `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tobjects = {
/* Begin PBXBuildFile section */
\t\t100000000000000000000001 /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = 200000000000000000000001 /* Assets.xcassets */; };
/* End PBXBuildFile section */
/* Begin PBXFileReference section */
\t\t200000000000000000000001 /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = SOURCE_ROOT; };
/* End PBXFileReference section */
/* Begin PBXGroup section */
\t\t300000000000000000000001 = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t200000000000000000000001 /* Assets.xcassets */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */
/* Begin PBXNativeTarget section */
\t\t400000000000000000000001 /* ${targetName} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildPhases = (
\t\t\t\t500000000000000000000001 /* Resources */,
\t\t\t);
\t\t\tname = ${targetName};
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */
/* Begin PBXProject section */
\t\t600000000000000000000001 = {
\t\t\tisa = PBXProject;
\t\t\tmainGroup = 300000000000000000000001;
\t\t\ttargets = (
\t\t\t\t400000000000000000000001 /* ${targetName} */,
\t\t\t);
\t\t};
/* End PBXProject section */
/* Begin PBXResourcesBuildPhase section */
\t\t500000000000000000000001 /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tfiles = (
\t\t\t\t100000000000000000000001 /* Assets.xcassets in Resources */,
\t\t\t);
\t\t};
/* End PBXResourcesBuildPhase section */
/* Begin XCBuildConfiguration section */
\t\t700000000000000000000001 = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tINFOPLIST_FILE = ${container}/Info.plist;
\t\t\t};
\t\t};
/* End XCBuildConfiguration section */
\t};
}
`;
  return lf.replaceAll('\n', '\r\n');
};

const run = (appleDir, ...args) => childProcess.spawnSync(process.execPath, [script, ...args, appleDir], {
  cwd: root,
  encoding: 'utf8',
});

for (const targetName of ['app_iOS', 'gai_iOS']) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-privacy-'));
  try {
    const appleDir = path.join(temporaryRoot, 'gen', 'apple');
    const projectDir = path.join(appleDir, `${targetName === 'app_iOS' ? 'app' : 'gai'}.xcodeproj`);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(appleDir, targetName), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'project.pbxproj'), fixtureProject(targetName));
    fs.writeFileSync(path.join(appleDir, 'project.yml'),
      `targets:\n  ${targetName}:\n    sources:\n      - path: ${targetName}/PrivacyInfo.xcprivacy\n        buildPhase: resources\n`.replaceAll('\\n', '\n'));

    const projectFile = path.join(projectDir, 'project.pbxproj');
    const destination = path.join(appleDir, targetName, 'PrivacyInfo.xcprivacy');
    const beforeProject = fs.readFileSync(projectFile);
    const missingCheck = run(appleDir, '--check');
    assert.notEqual(missingCheck.status, 0, `${targetName}: --check must fail before sync`);
    assert.match(missingCheck.stderr, /missing .*Resources/i);
    assert.deepEqual(fs.readFileSync(projectFile), beforeProject, `${targetName}: --check must not write PBX`);
    assert.equal(fs.existsSync(destination), false, `${targetName}: --check must not create manifest`);

    const sync = run(appleDir);
    assert.equal(sync.status, 0, `${targetName}: sync failed: ${sync.stderr}`);
    const syncedProject = fs.readFileSync(projectFile, 'utf8');
    assert.match(syncedProject, new RegExp(`${targetName}/PrivacyInfo\\.xcprivacy`));
    assert.match(syncedProject, /PrivacyInfo\.xcprivacy in Resources/);
    assert.equal(syncedProject.replaceAll('\r\n', '').includes('\n'), false, `${targetName}: CRLF must remain intact`);
    assert.deepEqual(fs.readFileSync(destination), canonical, `${targetName}: manifest must match canonical`);

    const afterSync = fs.readFileSync(projectFile);
    const repeat = run(appleDir);
    assert.equal(repeat.status, 0, `${targetName}: repeated sync failed: ${repeat.stderr}`);
    assert.deepEqual(fs.readFileSync(projectFile), afterSync, `${targetName}: repeated sync must be idempotent`);

    const beforeCheck = fs.readFileSync(projectFile);
    const check = run(appleDir, '--check');
    assert.equal(check.status, 0, `${targetName}: --check failed after sync: ${check.stderr}`);
    assert.deepEqual(fs.readFileSync(projectFile), beforeCheck, `${targetName}: --check must remain read-only`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const existingStageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-privacy-existing-'));
try {
  const appleDir = path.join(existingStageRoot, 'gen', 'apple');
  const projectDir = path.join(appleDir, 'gai.xcodeproj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(appleDir, 'gai_iOS'), { recursive: true });
  const existingReferenceId = '800000000000000000000001';
  const existingBuildId = '900000000000000000000001';
  const iosGroupId = 'A00000000000000000000001';
  let fixture = fixtureProject('gai_iOS').replaceAll('\r\n', '\n');
  fixture = fixture.replace(
    '/* End PBXBuildFile section */',
    '\t\t' + existingBuildId + ' /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ' + existingReferenceId + ' /* PrivacyInfo.xcprivacy */; };\n/* End PBXBuildFile section */',
  );
  fixture = fixture.replace(
    '/* End PBXFileReference section */',
    '\t\t' + existingReferenceId + ' /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n/* End PBXFileReference section */',
  );
  fixture = fixture.replace(
    '/* End PBXGroup section */',
    '\t\t' + iosGroupId + ' /* gai_iOS */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t' + existingReferenceId + ' /* PrivacyInfo.xcprivacy */,\n\t\t\t);\n\t\t\tpath = gai_iOS;\n\t\t\tsourceTree = "<group>";\n\t\t};\n/* End PBXGroup section */',
  );
  fixture = fixture.replace(
    '\t\t\t\t200000000000000000000001 /* Assets.xcassets */,',
    '\t\t\t\t200000000000000000000001 /* Assets.xcassets */,\n\t\t\t\t' + iosGroupId + ' /* gai_iOS */,',
  );
  fixture = fixture.replace(
    '\t\t\t\t100000000000000000000001 /* Assets.xcassets in Resources */,',
    '\t\t\t\t100000000000000000000001 /* Assets.xcassets in Resources */,\n\t\t\t\t' + existingBuildId + ' /* PrivacyInfo.xcprivacy in Resources */,',
  );
  fs.writeFileSync(path.join(projectDir, 'project.pbxproj'), fixture.replaceAll('\n', '\r\n'));
  fs.writeFileSync(path.join(appleDir, 'project.yml'),
    'targets:\n  gai_iOS:\n    sources:\n      - path: gai_iOS/PrivacyInfo.xcprivacy\n        buildPhase: resources\n');
  const projectFile = path.join(projectDir, 'project.pbxproj');
  const beforeProject = fs.readFileSync(projectFile);
  const sync = run(appleDir);
  assert.equal(sync.status, 0, 'gai_iOS existing reference sync failed: ' + sync.stderr);
  assert.deepEqual(fs.readFileSync(projectFile), beforeProject, 'existing group-relative PBX reference must be preserved');
  assert.deepEqual(fs.readFileSync(path.join(appleDir, 'gai_iOS/PrivacyInfo.xcprivacy')), canonical);
  const check = run(appleDir, '--check');
  assert.equal(check.status, 0, 'gai_iOS existing reference --check failed: ' + check.stderr);
} finally {
  fs.rmSync(existingStageRoot, { recursive: true, force: true });
}

const ambiguousStageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-privacy-ambiguous-'));
try {
  const appleDir = path.join(ambiguousStageRoot, 'gen', 'apple');
  const projectDir = path.join(appleDir, 'app.xcodeproj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(appleDir, 'app_iOS'), { recursive: true });
  let fixture = fixtureProject('app_iOS').replaceAll('\r\n', '\n');
  fixture = fixture.replace(
    '/* End XCBuildConfiguration section */',
    [
      '\t\t710000000000000000000001 = {',
      '\t\t\tisa = XCBuildConfiguration;',
      '\t\t\tbuildSettings = {',
      '\t\t\t\tINFOPLIST_FILE = helper/Info.plist;',
      '\t\t\t};',
      '\t\t};',
      '/* End XCBuildConfiguration section */',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(projectDir, 'project.pbxproj'), fixture.replaceAll('\n', '\r\n'));
  fs.writeFileSync(path.join(appleDir, 'project.yml'),
    'targets:\n  app_iOS:\n    sources:\n      - path: app_iOS/PrivacyInfo.xcprivacy\n        buildPhase: resources\n');
  const destination = path.join(appleDir, 'app_iOS/PrivacyInfo.xcprivacy');
  const ambiguous = run(appleDir);
  assert.notEqual(ambiguous.status, 0, 'distinct INFOPLIST_FILE paths must fail closed');
  assert.match(ambiguous.stderr, /Ambiguous INFOPLIST_FILE paths/);
  assert.equal(fs.existsSync(destination), false, 'ambiguous plist paths must not write a manifest');
} finally {
  fs.rmSync(ambiguousStageRoot, { recursive: true, force: true });
}

console.log('PASS: iOS privacy sync fixture covers app_iOS/gai_iOS, missing references, sync, idempotency, --check and CRLF');

// Permission keys must be at the root even when nested dictionaries contain
// keys with the same name. TCC ignores a nested camera description.
for (const nestedCamera of [false, true]) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-root-permissions-'));
  try {
    const appleDir = path.join(temporaryRoot, 'gen', 'apple');
    const targetDir = path.join(appleDir, 'gai_iOS');
    const projectDir = path.join(appleDir, 'gai.xcodeproj');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'project.pbxproj'), fixtureProject('gai_iOS'));
    const infoFile = path.join(targetDir, 'Info.plist');
    fs.writeFileSync(infoFile, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>Nested</key><dict><key>CFBundleLocalizations</key><array><string>nested</string></array>
      ${nestedCamera ? '<key>NSCameraUsageDescription</key><string>nested only</string>' : ''}</dict>
      <key>CFBundleIdentifier</key><string>com.windsheep.gai</string></dict></plist>`);
    const sync = () => childProcess.spawnSync(process.execPath, [path.join(root, 'scripts/sync-ios-localizations.mjs'), appleDir], { cwd: root, encoding: 'utf8' });
    const result = sync();
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', infoFile], { encoding: 'utf8' }));
    assert.ok(info.NSCameraUsageDescription.includes('Take a photo'));
    assert.deepEqual(info.CFBundleLocalizations, ['zh-Hant', 'en', 'ja']);
    assert.deepEqual(info.Nested.CFBundleLocalizations, ['nested']);
    const before = fs.readFileSync(infoFile);
    assert.equal(sync().status, 0);
    assert.deepEqual(fs.readFileSync(infoFile), before, 'root permission sync stays idempotent');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
console.log('PASS: camera permission and locales are root keys despite nested dictionaries');
