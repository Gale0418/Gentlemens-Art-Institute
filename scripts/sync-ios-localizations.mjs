import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep canonical permission translations in generated Xcode projects, including APFS staging.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appleDir = path.resolve(process.argv[2] || path.join(root, 'src-tauri/gen/apple'));
const projects = fs.readdirSync(appleDir).filter(name => name.endsWith('.xcodeproj'));
if (projects.length !== 1) throw new Error('Expected exactly one Xcode project');
const projectFile = path.join(appleDir, projects[0], 'project.pbxproj');
let text = fs.readFileSync(projectFile, 'utf8');
const newline = text.includes('\r\n') ? '\r\n' : '\n';
const infoMatch = text.match(/INFOPLIST_FILE = "?([^;"\r\n]+)"?;/);
if (!infoMatch) throw new Error('Missing INFOPLIST_FILE');
const infoRelative = infoMatch[1];
if (infoRelative.includes('$') || path.isAbsolute(infoRelative) || infoRelative.includes('..')) throw new Error('Unexpected Info.plist path');
const container = path.dirname(infoRelative);
const locales = ['zh-Hant', 'en', 'ja'];
for (const locale of locales) {
  const destination = path.join(appleDir, container, `${locale}.lproj`);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(root, 'src-tauri/ios-localizations', `${locale}.lproj/InfoPlist.strings`), path.join(destination, 'InfoPlist.strings'));
}
const infoFile = path.join(appleDir, infoRelative);
let info = fs.readFileSync(infoFile, 'utf8');
const localizedKeys = '<key>CFBundleLocalizations</key>\n\t<array><string>zh-Hant</string><string>en</string><string>ja</string></array>';
if (!info.includes('<key>CFBundleLocalizations</key>')) info = info.replace('<dict>', `<dict>\n\t${localizedKeys}`);
// WebKit's image file picker offers Take Photo; every regenerated target needs this key.
const cameraKey = '<key>NSCameraUsageDescription</key>';
if (!info.includes(cameraKey)) {
  info = info.replace('</dict>', `\t${cameraKey}\n\t<string>Take a photo to import it into your local comic library. Photos are stored on this device.</string>\n</dict>`);
}
fs.writeFileSync(infoFile, info);

const variant = '6A110C000000000000000001';
const build = '6A110C000000000000000002';
const references = locales.map((_, index) => `6A110C00000000000000001${index}`);
const generatedResource = text.includes('/* InfoPlist.strings in Resources */');
if (generatedResource && !locales.every(locale => text.includes(`${locale}.lproj/InfoPlist.strings`))) {
  throw new Error('Regenerate the Xcode project to include every InfoPlist.strings localization');
}
if (!generatedResource && !text.includes(`${variant} /* GAI InfoPlist.strings */`)) {
  const insert = (marker, lines) => {
    if (!text.includes(marker)) throw new Error(`Missing Xcode section: ${marker}`);
    text = text.replace(marker, lines.join(newline) + newline + marker);
  };
  insert('/* End PBXBuildFile section */', [
    `\t\t${build} /* GAI InfoPlist.strings in Resources */ = {isa = PBXBuildFile; fileRef = ${variant} /* GAI InfoPlist.strings */; };`,
  ]);
  insert('/* End PBXFileReference section */', locales.map((locale, index) =>
    `\t\t${references[index]} /* ${locale} */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = "${locale}"; path = "${container}/${locale}.lproj/InfoPlist.strings"; sourceTree = SOURCE_ROOT; };`));
  const variantLines = [
    `\t\t${variant} /* GAI InfoPlist.strings */ = {`,
    '\t\t\tisa = PBXVariantGroup;', '\t\t\tchildren = (',
    ...references.map(id => `\t\t\t\t${id},`),
    '\t\t\t);', '\t\t\tname = InfoPlist.strings;', '\t\t\tsourceTree = "<group>";', '\t\t};',
  ];
  if (text.includes('/* End PBXVariantGroup section */')) insert('/* End PBXVariantGroup section */', variantLines);
  else insert('/* Begin XCBuildConfiguration section */', ['/* Begin PBXVariantGroup section */', ...variantLines, '/* End PBXVariantGroup section */', '']);
  text = text.replace(/(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()/, `$1${newline}\t\t\t\t${build} /* GAI InfoPlist.strings in Resources */,`);
  const mainGroup = text.match(/mainGroup = ([A-F0-9]+)/)?.[1];
  if (!mainGroup) throw new Error('Missing mainGroup');
  const group = new RegExp(`(${mainGroup}[^=]*= \\{\\s*isa = PBXGroup;\\s*children = \\()`);
  if (!group.test(text)) throw new Error('Missing mainGroup children');
  text = text.replace(group, `$1${newline}\t\t\t\t${variant} /* GAI InfoPlist.strings */,`);
}
text = text.replace(/knownRegions = \([\s\S]*?\);/, `knownRegions = (${newline}\t\t\t\tBase,${newline}\t\t\t\t"zh-Hant",${newline}\t\t\t\ten,${newline}\t\t\t\tja,${newline}\t\t\t);`);
fs.writeFileSync(projectFile, text);
console.log(`Synced ${locales.join(', ')} permission strings into ${projects[0]}`);
