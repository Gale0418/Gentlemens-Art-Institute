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
// sync-ios-localizations also invokes Apple's plutil internally.
if (process.platform === 'darwin') {
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

  const probeXcodegen = env => childProcess.spawnSync('xcodegen', ['--help'], { encoding: 'utf8', env });
  const requireUsableXcodegen = result => {
    if (result.error?.code === 'ENOENT') return false;
    assert.equal(result.error, undefined, `xcodegen could not be started: ${result.error?.message ?? 'unknown error'}`);
    assert.equal(result.status, 0, `xcodegen is present but unusable: ${result.stderr}`);
    return true;
  };
  const brokenXcodegenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-broken-xcodegen-'));
  try {
    fs.writeFileSync(path.join(brokenXcodegenRoot, 'xcodegen'), '#!/bin/sh\nexit 17\n');
    fs.chmodSync(path.join(brokenXcodegenRoot, 'xcodegen'), 0o755);
    const brokenXcodegen = probeXcodegen({ ...process.env, PATH: `${brokenXcodegenRoot}${path.delimiter}${process.env.PATH}` });
    assert.throws(() => requireUsableXcodegen(brokenXcodegen), /xcodegen is present but unusable/, 'a present but broken xcodegen must fail the preflight');
  } finally {
    fs.rmSync(brokenXcodegenRoot, { recursive: true, force: true });
  }
  const xcodegenCheck = probeXcodegen(process.env);
  if (!requireUsableXcodegen(xcodegenCheck)) {
    console.log('SKIP: stage metadata and lifecycle fixtures require xcodegen');
  } else {

  const stageScript = path.join(root, 'scripts/release/stage-ios-build.sh');
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-stage-metadata-'));
  try {
    const appleDir = path.join(stageRoot, 'src-tauri/gen/apple');
    fs.mkdirSync(appleDir, { recursive: true });
    const canonicalInfoPath = path.join(stageRoot, 'canonical-Info.plist');
    fs.copyFileSync(path.join(root, 'src-tauri/gen/apple/app_iOS/Info.plist'), canonicalInfoPath);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleLocalizations', '-json', '["fixture-locale"]', '--', canonicalInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'ITSAppUsesNonExemptEncryption', '-bool', 'true', '--', canonicalInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSCameraUsageDescription', '-string', 'Fixture camera value', '--', canonicalInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSPhotoLibraryUsageDescription', '-string', 'Fixture photo value', '--', canonicalInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSLocalNetworkUsageDescription', '-string', 'Fixture local network value', '--', canonicalInfoPath]);
    const specialCameraUsage = 'Fixture "camera" \\\\path\nsecond line';
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSCameraUsageDescription', '-string', specialCameraUsage, '--', canonicalInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'LSSupportsOpeningDocumentsInPlace', '-bool', 'false', '--', canonicalInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'UIFileSharingEnabled', '-bool', 'false', '--', canonicalInfoPath]);
    const requiredKeys = [
      'CFBundleLocalizations',
      'ITSAppUsesNonExemptEncryption',
      'NSCameraUsageDescription',
      'NSPhotoLibraryUsageDescription',
      'NSLocalNetworkUsageDescription',
      'LSSupportsOpeningDocumentsInPlace',
      'UIFileSharingEnabled',
    ];
    const canonicalInfo = JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', canonicalInfoPath], { encoding: 'utf8' }));
    for (const target of ['app_iOS', 'gai_iOS']) {
      const targetDir = path.join(appleDir, target);
      fs.mkdirSync(targetDir, { recursive: true });
      const infoPath = path.join(targetDir, 'Info.plist');
      fs.copyFileSync(canonicalInfoPath, infoPath);
      childProcess.execFileSync('/usr/bin/plutil', ['-insert', 'UnrelatedStageValue', '-string', `keep-${target}`, '--', infoPath]);
      if (target === 'app_iOS') {
        childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSCameraUsageDescription', '-string', 'Existing camera copy', '--', infoPath]);
        childProcess.execFileSync('/usr/bin/plutil', ['-remove', 'NSPhotoLibraryUsageDescription', '--', infoPath]);
        childProcess.execFileSync('/usr/bin/plutil', ['-remove', 'ITSAppUsesNonExemptEncryption', '--', infoPath]);
      } else {
        childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSPhotoLibraryUsageDescription', '-string', 'Existing photo copy', '--', infoPath]);
        childProcess.execFileSync('/usr/bin/plutil', ['-remove', 'NSCameraUsageDescription', '--', infoPath]);
        childProcess.execFileSync('/usr/bin/plutil', ['-remove', 'ITSAppUsesNonExemptEncryption', '--', infoPath]);
      }
    }
    fs.writeFileSync(path.join(appleDir, 'project.yml'), [
      'name: gai',
      'options:',
      '  bundleIdPrefix: com.windsheep',
      'targets:',
      '  app_iOS:',
      '    type: application',
      '    platform: iOS',
      '    sources:',
      '      - path: app_iOS',
      '    info:',
      '      path: app_iOS/Info.plist',
      '      properties:',
      '        CFBundleVersion: "64"',
      '        UnrelatedProperty: keep-app',
      '  gai_iOS:',
      '    type: application',
      '    platform: iOS',
      '    sources:',
      '      - path: gai_iOS',
      '    info:',
      '      path: gai_iOS/Info.plist',
      '      properties:',
      '        CFBundleVersion: "65"',
      '        UnrelatedProperty: keep-gai',
      '',
    ].join('\n'));

    const runStageMetadataSync = () => childProcess.spawnSync('bash', [stageScript, '--sync-ios-metadata', stageRoot], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CANONICAL_IOS_PLIST_OVERRIDE: canonicalInfoPath },
    });
    const sync = runStageMetadataSync();
    assert.equal(sync.status, 0, `stage metadata sync failed: ${sync.stderr}`);
    const stagedInfo = {};
    for (const target of ['app_iOS', 'gai_iOS']) {
      const infoPath = path.join(appleDir, target, 'Info.plist');
      const info = JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', infoPath], { encoding: 'utf8' }));
      stagedInfo[target] = info;
      for (const key of requiredKeys) assert.ok(Object.hasOwn(info, key), `${target}: missing ${key}`);
      assert.equal(info.ITSAppUsesNonExemptEncryption, canonicalInfo.ITSAppUsesNonExemptEncryption);
      assert.equal(info.NSLocalNetworkUsageDescription, canonicalInfo.NSLocalNetworkUsageDescription);
      assert.equal(info.UnrelatedStageValue, `keep-${target}`);
      if (target === 'app_iOS') assert.equal(info.NSCameraUsageDescription, 'Existing camera copy');
      else assert.equal(info.NSPhotoLibraryUsageDescription, 'Existing photo copy');
    }
    assert.equal(stagedInfo.gai_iOS.NSCameraUsageDescription, specialCameraUsage, 'plist text must preserve quotes, backslashes, and newline');
    const missingCanonical = childProcess.spawnSync('bash', [stageScript, '--sync-ios-metadata', stageRoot], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CANONICAL_IOS_PLIST_OVERRIDE: path.join(stageRoot, 'missing-canonical.plist') },
    });
    assert.equal(missingCanonical.status, 4, 'missing trusted canonical plist must fail clearly');
    assert.match(missingCanonical.stderr, /trusted canonical iOS Info\.plist is missing/);
    const projectYml = path.join(appleDir, 'project.yml');
    const projectAfterSync = fs.readFileSync(projectYml);
    const projectText = projectAfterSync.toString();
    for (const target of ['app_iOS', 'gai_iOS']) {
      for (const key of requiredKeys) {
        const property = `${key}: ${JSON.stringify(stagedInfo[target][key])}`;
        assert.match(projectText, new RegExp(`^        ${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      }
    }
    assert.match(projectText, /UnrelatedProperty: keep-app/);
    assert.match(projectText, /UnrelatedProperty: keep-gai/);
    const generatedProject = path.join(appleDir, 'gai.xcodeproj');
    for (const target of ['app_iOS', 'gai_iOS']) fs.rmSync(path.join(appleDir, target, 'Info.plist'));
    const assertGeneratedOutputs = () => {
      assert.equal(fs.existsSync(path.join(generatedProject, 'project.pbxproj')), true, 'xcodegen must create project.pbxproj');
      for (const target of ['app_iOS', 'gai_iOS']) {
        assert.equal(fs.existsSync(path.join(appleDir, target, 'Info.plist')), true, `${target}: xcodegen must create Info.plist`);
      }
    };
    const noOpXcodegenRoot = path.join(stageRoot, 'no-op-xcodegen-bin');
    fs.mkdirSync(noOpXcodegenRoot, { recursive: true });
    fs.writeFileSync(path.join(noOpXcodegenRoot, 'xcodegen'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(noOpXcodegenRoot, 'xcodegen'), 0o755);
    const noOpGeneration = childProcess.spawnSync('xcodegen', ['generate', '--spec', projectYml, '--project', appleDir, '--quiet'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${noOpXcodegenRoot}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(noOpGeneration.status, 0, 'no-op xcodegen stub must return success for the negative fixture');
    assert.throws(assertGeneratedOutputs, /xcodegen must create project\.pbxproj/, 'no-op xcodegen must fail generated-output validation');
    const regenerated = childProcess.spawnSync('xcodegen', ['generate', '--spec', projectYml, '--project', appleDir, '--quiet'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(regenerated.status, 0, `xcodegen must preserve staged project metadata: ${regenerated.stderr}`);
    assert.doesNotThrow(assertGeneratedOutputs);
    for (const target of ['app_iOS', 'gai_iOS']) {
      const regeneratedInfo = JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path.join(appleDir, target, 'Info.plist')], { encoding: 'utf8' }));
      for (const key of requiredKeys) assert.deepEqual(regeneratedInfo[key], stagedInfo[target][key], `${target}: xcodegen must preserve ${key}`);
      assert.equal(regeneratedInfo.UnrelatedStageValue, `keep-${target}`, `${target}: xcodegen must preserve unrelated plist values`);
    }
    const beforeRepeat = [projectAfterSync, ...['app_iOS', 'gai_iOS'].map(target => fs.readFileSync(path.join(appleDir, target, 'Info.plist')))];
    const repeat = runStageMetadataSync();
    assert.equal(repeat.status, 0, `repeated stage metadata sync failed: ${repeat.stderr}`);
    assert.deepEqual(fs.readFileSync(projectYml), beforeRepeat[0], 'project.yml metadata sync must be idempotent');
    for (const [index, target] of ['app_iOS', 'gai_iOS'].entries()) {
      assert.deepEqual(fs.readFileSync(path.join(appleDir, target, 'Info.plist')), beforeRepeat[index + 1], `${target}: plist sync must be idempotent`);
    }

    const appInfoPath = path.join(appleDir, 'app_iOS', 'Info.plist');
    const projectBeforeTypeConflict = fs.readFileSync(projectYml);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSCameraUsageDescription', '-bool', 'true', '--', appInfoPath]);
    const typeConflict = runStageMetadataSync();
    assert.equal(typeConflict.status, 4, 'a staged plist type conflict must fail closed');
    assert.match(typeConflict.stderr, /has type bool for NSCameraUsageDescription.*canonical has type string/);
    assert.equal(JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', appInfoPath], { encoding: 'utf8' })).NSCameraUsageDescription, true);
    assert.deepEqual(fs.readFileSync(projectYml), projectBeforeTypeConflict, 'type conflict must not rewrite project.yml');

    fs.copyFileSync(canonicalInfoPath, appInfoPath);
    childProcess.execFileSync('/usr/bin/plutil', ['-insert', 'UnrelatedStageValue', '-string', 'keep-app_iOS', '--', appInfoPath]);
    const projectBeforeValueConflict = fs.readFileSync(projectYml, 'utf8');
    const conflictingProject = projectBeforeValueConflict.replace(
      '        NSCameraUsageDescription: "Existing camera copy"',
      '        NSCameraUsageDescription: "YAML camera copy"',
    );
    assert.notEqual(conflictingProject, projectBeforeValueConflict, 'value conflict fixture must change the app_iOS property');
    fs.writeFileSync(projectYml, conflictingProject);
    const valueConflict = runStageMetadataSync();
    assert.equal(valueConflict.status, 4, 'a staged project.yml value conflict must fail closed');
    assert.match(valueConflict.stderr, /target app_iOS property NSCameraUsageDescription conflicts/);
    assert.equal(JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', appInfoPath], { encoding: 'utf8' })).NSCameraUsageDescription, specialCameraUsage);
    assert.deepEqual(fs.readFileSync(projectYml, 'utf8'), conflictingProject, 'value conflict must not rewrite project.yml');

    fs.writeFileSync(projectYml, projectAfterSync);
    fs.copyFileSync(canonicalInfoPath, appInfoPath);
    const gaiInfoPath = path.join(appleDir, 'gai_iOS', 'Info.plist');
    fs.copyFileSync(canonicalInfoPath, gaiInfoPath);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSCameraUsageDescription', '-string', 'Existing camera copy', '--', appInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-remove', 'NSPhotoLibraryUsageDescription', '--', appInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSPhotoLibraryUsageDescription', '-string', 'Existing photo copy', '--', gaiInfoPath]);
    childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSCameraUsageDescription', '-bool', 'true', '--', gaiInfoPath]);
    const transactionBefore = {
      project: fs.readFileSync(projectYml),
      app: fs.readFileSync(appInfoPath),
      gai: fs.readFileSync(gaiInfoPath),
    };
    const secondTargetConflict = runStageMetadataSync();
    assert.equal(secondTargetConflict.status, 4, 'a later target conflict must fail the complete metadata transaction');
    assert.match(secondTargetConflict.stderr, /gai_iOS.*NSCameraUsageDescription|has type bool for NSCameraUsageDescription/);
    assert.deepEqual(fs.readFileSync(projectYml), transactionBefore.project, 'later target failure must roll back project.yml');
    assert.deepEqual(fs.readFileSync(appInfoPath), transactionBefore.app, 'later target failure must roll back earlier target plist changes');
    assert.deepEqual(fs.readFileSync(gaiInfoPath), transactionBefore.gai, 'later target failure must preserve the conflicting target plist');

    const invalidResourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-invalid-resources-'));
    try {
      const invalidAppleDir = path.join(invalidResourcesRoot, 'src-tauri/gen/apple');
      fs.mkdirSync(path.join(invalidAppleDir, 'gai_iOS'), { recursive: true });
      fs.copyFileSync(canonicalInfoPath, path.join(invalidAppleDir, 'gai_iOS/Info.plist'));
      fs.writeFileSync(path.join(invalidAppleDir, 'project.yml'), [
        'name: gai',
        'targets:',
        '  gai_iOS:',
        '    type: application',
        '    sources:',
        '      - path: Externals',
        '      - path: gai_iOS',
        '    info:',
        '      path: gai_iOS/Info.plist',
        '      properties:',
        '        CFBundleVersion: "65"',
        '',
      ].join('\n'));
      const invalidResources = childProcess.spawnSync('bash', [stageScript, '--sync-ios-metadata', invalidResourcesRoot], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CANONICAL_IOS_PLIST_OVERRIDE: canonicalInfoPath },
      });
      assert.equal(invalidResources.status, 4, 'Externals source must fail closed before packaging');
      assert.match(invalidResources.stderr, /must not add Externals.*libapp\.a/);
    } finally {
      fs.rmSync(invalidResourcesRoot, { recursive: true, force: true });
    }

    const linkedArchiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-linked-archive-'));
    try {
      const linkedAppleDir = path.join(linkedArchiveRoot, 'src-tauri/gen/apple');
      const externalsDir = path.join(linkedAppleDir, 'Externals/arm64/release');
      fs.mkdirSync(path.join(linkedAppleDir, 'Sources'), { recursive: true });
      fs.mkdirSync(externalsDir, { recursive: true });
      // XcodeGen only needs a path-shaped archive for project generation; the
      // archive is deliberately present to catch accidental source scanning.
      fs.writeFileSync(path.join(externalsDir, 'libapp.a'), Buffer.from('!<arch>\n'));
      const linkedProjectYml = path.join(linkedAppleDir, 'project.yml');
      fs.writeFileSync(linkedProjectYml, [
        'name: gai',
        'options:',
        '  bundleIdPrefix: com.windsheep',
        'targets:',
        '  gai_iOS:',
        '    type: application',
        '    platform: iOS',
        '    sources:',
        '      - path: Sources',
        '    settings:',
        '      base:',
        '        LIBRARY_SEARCH_PATHS[arch=arm64]: $(PROJECT_DIR)/Externals/arm64/$(CONFIGURATION)',
        '    dependencies:',
        '      - framework: libapp.a',
        '        embed: false',
        '',
      ].join('\n'));
      const generated = childProcess.spawnSync('xcodegen', ['generate', '--spec', linkedProjectYml, '--project', linkedAppleDir, '--quiet'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(generated.status, 0, `XcodeGen linked archive fixture failed: ${generated.stderr}`);
      const linkedPbxproj = fs.readFileSync(path.join(linkedAppleDir, 'gai.xcodeproj/project.pbxproj'), 'utf8');
      assert.doesNotMatch(linkedPbxproj, /libapp\.a in Resources/, 'linked libapp.a must not be emitted in Resources');
      assert.match(linkedPbxproj, /libapp\.a in Frameworks/, 'linked libapp.a must remain in Frameworks');
    } finally {
      fs.rmSync(linkedArchiveRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
  console.log('PASS: stage metadata sync restores app_iOS/gai_iOS plist and project.yml keys idempotently');

  const lifecycleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gai-ios-stage-lifecycle-'));
  const fixtureRoot = path.join(lifecycleRoot, 'fixture');
  const fakeBin = path.join(lifecycleRoot, 'bin');
  fs.mkdirSync(path.join(fixtureRoot, 'src-tauri/gen/apple/gai_iOS'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'public'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'src-tauri/gen/apple/app_iOS/Info.plist'), path.join(fixtureRoot, 'src-tauri/gen/apple/gai_iOS/Info.plist'));
  fs.copyFileSync(path.join(root, 'src-tauri/gen/apple/app_iOS/Info.plist'), path.join(fixtureRoot, 'canonical-Info.plist'));
  fs.writeFileSync(path.join(fixtureRoot, 'src-tauri/Cargo.toml'), '[package]\nname = "gai"\n[lib]\nname = "gai_lib"\n');
  fs.writeFileSync(path.join(fixtureRoot, 'src-tauri/gen/apple/project.yml'), [
    'name: gai',
    'targets:',
    '  gai_iOS:',
    '    type: application',
    '    platform: iOS',
    '    sources:',
    '      - path: gai_iOS',
    '    info:',
    '      path: gai_iOS/Info.plist',
    '      properties:',
    '        CFBundleVersion: "64"',
    '',
  ].join('\n'));
  for (const file of ['package.json', 'package-lock.json', 'rust-toolchain.toml', 'LICENSE']) fs.writeFileSync(path.join(fixtureRoot, file), 'fixture\n');
  fs.writeFileSync(path.join(fixtureRoot, 'public/fixture.txt'), 'fixture\n');
  fs.writeFileSync(path.join(fixtureRoot, 'scripts/fixture.sh'), '#!/bin/sh\n');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'df'), '#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n"\nprintf "/dev/test 10000000 1 9999999 1%% %s\\n" "${@: -1}"\n');
  fs.writeFileSync(path.join(fakeBin, 'rsync'), '#!/bin/bash\nif [[ "${IOS_STAGE_FAKE_RSYNC_MODE:-copy}" == fail ]]; then exit 73; fi\nif [[ -n "${IOS_STAGE_SIGNAL:-}" && ! -e "${IOS_STAGE_SIGNAL_MARKER:?}" ]]; then\n  : > "$IOS_STAGE_SIGNAL_MARKER"\n  kill -"$IOS_STAGE_SIGNAL" "$PPID"\n  exit 0\nfi\nsource="${@: -2:1}"\ndestination="${@: -1}"\nbase="${source##*/}"\n/bin/cp -a "${IOS_STAGE_TEST_FIXTURE:?}/$base" "$destination/"\n');
  fs.writeFileSync(path.join(fakeBin, 'mv'), '#!/bin/bash\ndestination="${@: -1}"\nif [[ "${IOS_STAGE_FAIL_MV:-0}" == 1 && "$destination" == */project.yml ]]; then exit 77; fi\nexec /bin/mv "$@"\n');
  fs.writeFileSync(path.join(fakeBin, 'mktemp'), '#!/bin/bash\nsignal="${IOS_STAGE_MKTEMP_SIGNAL:-${IOS_METADATA_MKTEMP_SIGNAL:-}}"\nif [[ "$signal" != "" ]]; then\n  stage_dir="$(/usr/bin/mktemp -d "${@: -1}")"\n  printf "%s\\n" "$stage_dir"\n  kill -"$signal" "$PPID"\n  exit 0\nfi\nexec /usr/bin/mktemp "$@"\n');
  for (const file of ['df', 'rsync', 'mv', 'mktemp']) fs.chmodSync(path.join(fakeBin, file), 0o755);
  const lifecycleEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    TMPDIR: lifecycleRoot,
    IOS_STAGE_TEST_FIXTURE: fixtureRoot,
    CANONICAL_IOS_PLIST_OVERRIDE: path.join(fixtureRoot, 'canonical-Info.plist'),
  };
  const sentinel = path.join(lifecycleRoot, 'keep-me.txt');
  fs.writeFileSync(sentinel, 'must survive staging failure\n');
  const failedStage = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...lifecycleEnv, IOS_STAGE_FAKE_RSYNC_MODE: 'fail' },
  });
  assert.notEqual(failedStage.status, 0, 'early staging failure must be reported');
  assert.equal(fs.existsSync(sentinel), true, 'early staging cleanup must not remove an existing directory entry');
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-stage.')), [], 'failed staging must clean only its own mktemp directory');

  const signalMarker = path.join(lifecycleRoot, 'signal-sent');
  const interruptedStage = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...lifecycleEnv, IOS_STAGE_SIGNAL: 'TERM', IOS_STAGE_SIGNAL_MARKER: signalMarker },
  });
  assert.notEqual(interruptedStage.status, 0, 'a signal during staging must be non-zero');
  assert.equal(fs.existsSync(signalMarker), true, 'the rsync fixture must deliver the test signal');
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-stage.')), [], 'signal during staging must clean the complete staged directory');
  assert.equal(fs.existsSync(sentinel), true, 'signal cleanup must preserve unrelated directory entries');

  const mktempInterrupted = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...lifecycleEnv, IOS_STAGE_MKTEMP_SIGNAL: 'TERM' },
  });
  assert.notEqual(mktempInterrupted.status, 0, 'a signal after mktemp creation must be non-zero');
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-stage.')), [], 'signal after mktemp creation must clean the stage');
  assert.equal(fs.existsSync(sentinel), true, 'mktemp signal cleanup must preserve unrelated directory entries');

  const closedOutput = childProcess.spawnSync('bash', ['-c', 'exec 1>&-; exec bash "$1"', 'closed-output', path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: lifecycleEnv,
  });
  assert.notEqual(closedOutput.status, 0, 'a failed stage-path output must be non-zero');
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-stage.')), [], 'failed stage-path output must clean the stage');
  assert.equal(fs.existsSync(sentinel), true, 'failed stage-path output must preserve unrelated directory entries');

  const successfulStage = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: lifecycleEnv,
  });
  assert.equal(successfulStage.status, 0, `successful staging fixture failed: ${successfulStage.stderr}`);
  const preservedStage = successfulStage.stdout.trim();
  const realLifecycleRoot = fs.realpathSync(lifecycleRoot);
  assert.match(preservedStage, new RegExp(`^${realLifecycleRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/gai-ios-stage\\.`));
  assert.equal(fs.existsSync(preservedStage), true, 'successful staging must leave the printed stage directory available');
  assert.equal(fs.existsSync(path.join(preservedStage, 'src-tauri/gen/apple/gai_iOS/Info.plist')), true);
  const licenseResource = 'docs/release/THIRD_PARTY_LICENSES.txt';
  assert.deepEqual(fs.readFileSync(path.join(preservedStage, licenseResource)),
    fs.readFileSync(path.join(root, licenseResource)), 'iOS staging must preserve the exact license resource');
  assert.equal(fs.existsSync(sentinel), true, 'successful staging must not affect unrelated directory entries');
  fs.rmSync(preservedStage, { recursive: true, force: true });

  const staleFixture = path.join(lifecycleRoot, 'stale-fixture');
  fs.cpSync(fixtureRoot, staleFixture, { recursive: true });
  const staleApple = path.join(staleFixture, 'src-tauri/gen/apple');
  const staleProject = path.join(staleApple, 'project.yml');
  fs.writeFileSync(staleProject, fs.readFileSync(staleProject, 'utf8')
    .replace('name: gai', 'name: app').replaceAll('gai_iOS', 'app_iOS'));
  fs.renameSync(path.join(staleApple, 'gai_iOS'), path.join(staleApple, 'app_iOS'));
  fs.writeFileSync(path.join(staleApple, 'app_iOS/app_iOS.entitlements'), 'fixture\n');
  fs.mkdirSync(path.join(staleApple, 'app.xcodeproj'));
  fs.mkdirSync(path.join(staleApple, 'Sources/app'), { recursive: true });
  const failingXcodegenBin = path.join(lifecycleRoot, 'failing-xcodegen-bin');
  fs.mkdirSync(failingXcodegenBin);
  fs.writeFileSync(path.join(failingXcodegenBin, 'xcodegen'), '#!/bin/sh\nexit 71\n', { mode: 0o755 });
  const failedMigration = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...lifecycleEnv, PATH: `${failingXcodegenBin}${path.delimiter}${lifecycleEnv.PATH}`, IOS_STAGE_TEST_FIXTURE: staleFixture },
  });
  assert.equal(failedMigration.status, 4, 'XcodeGen migration failure must use the documented staging error code');
  assert.match(failedMigration.stderr, /xcodegen failed to regenerate the migrated Apple project/);
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-stage.')), [], 'migration failure must remove only its owned stage');
  assert.equal(fs.existsSync(sentinel), true, 'migration cleanup must preserve unrelated directory entries');

  childProcess.execFileSync('/usr/bin/plutil', ['-replace', 'NSCameraUsageDescription', '-bool', 'true', '--', path.join(fixtureRoot, 'src-tauri/gen/apple/gai_iOS/Info.plist')]);
  const failedAfterCopy = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: lifecycleEnv,
  });
  assert.equal(failedAfterCopy.status, 4, 'metadata conflict after staging copy must fail');
  assert.match(failedAfterCopy.stderr, /has type bool for NSCameraUsageDescription/);
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-stage.')), [], 'metadata failure must clean the complete staged directory');
  assert.equal(fs.existsSync(sentinel), true, 'metadata failure cleanup must preserve unrelated directory entries');

  fs.copyFileSync(path.join(fixtureRoot, 'canonical-Info.plist'), path.join(fixtureRoot, 'src-tauri/gen/apple/gai_iOS/Info.plist'));
  const failedDuringCommit = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...lifecycleEnv, IOS_STAGE_FAIL_MV: '1' },
  });
  assert.notEqual(failedDuringCommit.status, 0, 'injected metadata commit failure must be non-zero');
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-stage.')), [], 'set -e metadata failure must run outer stage cleanup');
  assert.equal(fs.existsSync(sentinel), true, 'set -e metadata cleanup must preserve unrelated directory entries');

  const directStageRoot = path.join(lifecycleRoot, 'direct-stage');
  fs.mkdirSync(path.join(directStageRoot, 'src-tauri/gen/apple'), { recursive: true });
  fs.cpSync(path.join(fixtureRoot, 'src-tauri/gen/apple'), path.join(directStageRoot, 'src-tauri/gen/apple'), { recursive: true });
  const directProjectPath = path.join(directStageRoot, 'src-tauri/gen/apple/project.yml');
  const directInfoPath = path.join(directStageRoot, 'src-tauri/gen/apple/gai_iOS/Info.plist');
  const directBefore = [fs.readFileSync(directProjectPath), fs.readFileSync(directInfoPath)];
  const interruptedTransaction = childProcess.spawnSync('bash', [path.join(root, 'scripts/release/stage-ios-build.sh'), '--sync-ios-metadata', directStageRoot], {
    cwd: root,
    encoding: 'utf8',
    env: { ...lifecycleEnv, IOS_METADATA_MKTEMP_SIGNAL: 'TERM' },
  });
  assert.notEqual(interruptedTransaction.status, 0, 'a signal during metadata transaction allocation must be non-zero');
  assert.deepEqual(fs.readdirSync(lifecycleRoot).filter(name => name.startsWith('gai-ios-metadata-transaction.')), [], 'metadata allocation signal must clean its backup directory');
  assert.deepEqual(fs.readFileSync(directProjectPath), directBefore[0], 'metadata allocation signal must preserve project.yml');
  assert.deepEqual(fs.readFileSync(directInfoPath), directBefore[1], 'metadata allocation signal must preserve the plist');
  assert.equal(fs.existsSync(sentinel), true, 'metadata allocation signal must preserve unrelated directory entries');
  fs.rmSync(lifecycleRoot, { recursive: true, force: true });
  console.log('PASS: staging failure cleanup and successful stage retention are scoped and deterministic');
  }
}
