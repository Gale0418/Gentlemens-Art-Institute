import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the privacy manifest canonical in source control while supporting both
// the normal generated project and APFS staging after its app -> gai rename.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const positional = args.filter(arg => arg !== '--check');
if (positional.length > 1) throw new Error('Expected at most one Apple project directory');

const appleDir = path.resolve(positional[0] || path.join(root, 'src-tauri/gen/apple'));
const projects = fs.readdirSync(appleDir).filter(name => name.endsWith('.xcodeproj'));
if (projects.length !== 1) throw new Error('Expected exactly one Xcode project');

const projectFile = path.join(appleDir, projects[0], 'project.pbxproj');
let project = fs.readFileSync(projectFile, 'utf8');
const newline = project.includes('\r\n') ? '\r\n' : '\n';

const source = path.join(root, 'src-tauri/ios-privacy/PrivacyInfo.xcprivacy');
const sourceText = fs.readFileSync(source, 'utf8');
const requiredManifestParts = [
  '<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>',
  '<string>C617.1</string>',
  '<string>3B52.1</string>',
  '<string>NSPrivacyAccessedAPICategoryUserDefaults</string>',
  '<string>CA92.1</string>',
];
const hasNoTrackingDeclaration = /<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/.test(sourceText);
if (requiredManifestParts.some(part => !sourceText.includes(part)) || !hasNoTrackingDeclaration) {
  throw new Error('Canonical iOS privacy manifest is missing a required declaration');
}
if (sourceText.includes('35F9.1')) {
  throw new Error('Do not declare 35F9.1 without a verified system boot-time API use');
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const section = (begin, end) => {
  const match = project.match(new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`));
  if (!match) throw new Error(`Missing Xcode section: ${begin}`);
  return match[0];
};

const nativeTargetSection = section('/* Begin PBXNativeTarget section */', '/* End PBXNativeTarget section */');
const nativeTargets = [...nativeTargetSection.matchAll(
  /^[ \t]*([A-F0-9]+)[ \t]+\/\* ([^*]+) \*\/ = \{\r?\n([\s\S]*?)(?:\r?\n)[ \t]*\};/gm,
)].map(match => ({ id: match[1], comment: match[2], body: match[3] }));
const appTargets = nativeTargets.filter(target =>
  /isa = PBXNativeTarget;/.test(target.body) &&
  /productType = "com\.apple\.product-type\.application";/.test(target.body),
);
if (appTargets.length !== 1) throw new Error('Expected exactly one application target');
const appTarget = appTargets[0];
const targetName = appTarget.body.match(/\bname = "?([^;"\r\n]+)"?;/)?.[1];
if (!/^(?:app|gai)_iOS$/.test(targetName || '')) {
  throw new Error(`Unsupported application target: ${targetName || '(unnamed)'}`);
}

const targetBuildPhases = appTarget.body.match(/buildPhases = \(([\s\S]*?)\);/)?.[1];
if (!targetBuildPhases) throw new Error(`Missing build phases for ${targetName}`);
const targetPhaseIds = [...targetBuildPhases.matchAll(/^[ \t]*([A-F0-9]+)\s+\/\*/gm)].map(match => match[1]);
const resourcesPhases = [...project.matchAll(
  /^[ \t]*([A-F0-9]+)[ \t]+\/\* ([^*]+) \*\/ = \{\r?\n[ \t]*isa = PBXResourcesBuildPhase;([\s\S]*?)(?:\r?\n)[ \t]*\};/gm,
)].map(match => ({ id: match[1], comment: match[2], body: match[3], full: match[0], index: match.index }));
const targetResources = resourcesPhases.filter(phase => targetPhaseIds.includes(phase.id));
if (targetResources.length !== 1) throw new Error(`Expected exactly one Resources phase for ${targetName}`);
const resourcesPhase = targetResources[0];

const infoMatches = [...project.matchAll(/INFOPLIST_FILE = "?([^;"\r\n]+)"?;/g)];
if (!infoMatches.length) throw new Error('Missing INFOPLIST_FILE');
const infoValues = [...new Set(infoMatches.map(match => match[1]))];
if (infoValues.length !== 1) {
  throw new Error('Ambiguous INFOPLIST_FILE paths: ' + infoValues.join(', '));
}
const infoRelative = infoValues[0];
if (infoRelative.includes('$') || path.isAbsolute(infoRelative) || infoRelative.includes('..')) {
  throw new Error('Unexpected Info.plist path');
}
const infoContainer = path.posix.dirname(infoRelative.replaceAll(path.sep, '/'));
const resourcePath = path.posix.join(infoContainer, 'PrivacyInfo.xcprivacy');
const destination = path.join(appleDir, path.dirname(infoRelative), 'PrivacyInfo.xcprivacy');

// project.yml is the source used by xcodegen to put this file in Resources.
// Validate it as well as the generated PBX project so regeneration cannot hide
// a missing resource declaration.
const projectYml = path.join(appleDir, 'project.yml');
if (fs.existsSync(projectYml)) {
  const yml = fs.readFileSync(projectYml, 'utf8');
  const resourcePattern = new RegExp(`path:\\s*${escapeRegExp(resourcePath)}[\\s\\S]{0,120}buildPhase:\\s*resources`);
  if (!resourcePattern.test(yml)) {
    throw new Error(`project.yml does not declare ${resourcePath} as a Resources file`);
  }
}

const fileReferencesSection = section('/* Begin PBXFileReference section */', '/* End PBXFileReference section */');
const fileReferences = [...fileReferencesSection.matchAll(
  /^[ \t]*([A-F0-9]+)[ \t]+\/\* ([^*]+) \*\/ = \{isa = PBXFileReference; ([^\r\n]*?)\};/gm,
)].map(match => ({ id: match[1], comment: match[2], attributes: match[3] }));
const mainGroupId = project.match(/\bmainGroup = ([A-F0-9]+);/)?.[1];
if (!mainGroupId) throw new Error('Missing mainGroup');
const mainGroupPattern = new RegExp(
  `^[ \\t]*${escapeRegExp(mainGroupId)}(?:[ \\t]+\\/\\* [^*]+ \\*\\/)?[ \\t]*= \\{[\\s\\S]*?(?:\\r?\\n)[ \\t]*\\};`,
  'gm',
);
const mainGroupMatch = project.match(mainGroupPattern);
if (!mainGroupMatch) throw new Error('Missing mainGroup object');

const groupSection = section('/* Begin PBXGroup section */', '/* End PBXGroup section */');
const groups = [...groupSection.matchAll(
  /^[ \t]*([A-F0-9]+)(?:[ \t]+\/\* [^*]+ \*\/)?[ \t]*= \{\r?\n([\s\S]*?)(?:\r?\n)[ \t]*\};/gm,
)].map(match => ({ id: match[1], body: match[2] }))
  .filter(group => /isa = PBXGroup;/.test(group.body));
const groupsById = new Map(groups.map(group => [group.id, group]));
const fileReferencesById = new Map(fileReferences.map(reference => [reference.id, reference]));
const attribute = (attributes, key) => attributes.match(new RegExp(`\\b${key} = "?([^;"\\r\\n]+)"?;`))?.[1];
const groupChildren = group => [...(group.body.match(/children = \(([\s\S]*?)\);/)?.[1] || '').matchAll(/\b[A-F0-9]{24}\b/g)].map(match => match[0]);
const pathsByFileReference = new Map();
const reachableGroups = new Set();
const walkGroup = (groupId, parentPath, ancestors = []) => {
  if (ancestors.includes(groupId)) throw new Error(`Cyclic PBXGroup ancestry at ${groupId}`);
  const group = groupsById.get(groupId);
  if (!group) throw new Error(`Missing PBXGroup object: ${groupId}`);
  reachableGroups.add(groupId);
  const groupPath = attribute(group.body, 'sourceTree') === 'SOURCE_ROOT'
    ? (attribute(group.body, 'path') || '')
    : path.posix.join(parentPath, attribute(group.body, 'path') || '');
  for (const childId of groupChildren(group)) {
    if (groupsById.has(childId)) {
      walkGroup(childId, groupPath, [...ancestors, groupId]);
      continue;
    }
    const reference = fileReferencesById.get(childId);
    if (!reference) continue;
    const sourceTree = attribute(reference.attributes, 'sourceTree');
    const referencePath = attribute(reference.attributes, 'path');
    if (!referencePath) continue;
    const resolved = sourceTree === 'SOURCE_ROOT'
      ? path.posix.normalize(referencePath)
      : path.posix.normalize(path.posix.join(groupPath, referencePath));
    const paths = pathsByFileReference.get(childId) || [];
    paths.push(resolved);
    pathsByFileReference.set(childId, paths);
  }
  return groupPath;
};
walkGroup(mainGroupId, '');
const privacyReferences = fileReferences.filter(reference =>
  (pathsByFileReference.get(reference.id) || []).includes(resourcePath),
);
if (privacyReferences.length > 1) throw new Error(`Duplicate PBXFileReference entries for ${resourcePath}`);
const privacyReference = privacyReferences[0];

const buildFilesSection = section('/* Begin PBXBuildFile section */', '/* End PBXBuildFile section */');
const buildFiles = [...buildFilesSection.matchAll(
  /^[ \t]*([A-F0-9]+)[ \t]+\/\* ([^*]+) \*\/ = \{isa = PBXBuildFile; fileRef = ([A-F0-9]+) \/\* [^*]+ \*\/; \};/gm,
)].map(match => ({ id: match[1], comment: match[2], fileRef: match[3] }));

const usedIds = new Set([...project.matchAll(/\b[A-F0-9]{24}\b/g)].map(match => match[0]));
let generatedId = 0x13;
const allocateId = () => {
  let id;
  do {
    id = `6A110C0000000000000000${generatedId.toString(16).toUpperCase().padStart(2, '0')}`;
    generatedId++;
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
};

const privacyReferenceId = privacyReference?.id || allocateId();
const privacyBuildFiles = buildFiles.filter(buildFile => buildFile.fileRef === privacyReferenceId);
if (privacyBuildFiles.length > 1) throw new Error(`Duplicate PBXBuildFile entries for ${resourcePath}`);
const privacyBuildFileId = privacyBuildFiles[0]?.id || allocateId();
const resourceFileIds = [...resourcesPhase.body.matchAll(/^[ \t]*([A-F0-9]+)\s+\/\*/gm)].map(match => match[1]);
const hasResourceBuildFile = resourceFileIds.includes(privacyBuildFileId);
const hasFileReference = Boolean(privacyReference);
const hasBuildFile = Boolean(privacyBuildFiles[0]);

const mainGroupHasReference = privacyReference ? pathsByFileReference.has(privacyReference.id) : false;

const insertBefore = (text, marker, lines) => {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`Missing Xcode section marker: ${marker}`);
  return `${text.slice(0, index)}${lines.join(newline)}${newline}${text.slice(index)}`;
};

let changed = false;
if (!hasFileReference) {
  project = insertBefore(project, '/* End PBXFileReference section */', [
    `\t\t${privacyReferenceId} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = "${resourcePath}"; sourceTree = SOURCE_ROOT; };`,
  ]);
  changed = true;
}
if (!hasBuildFile) {
  project = insertBefore(project, '/* End PBXBuildFile section */', [
    `\t\t${privacyBuildFileId} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${privacyReferenceId} /* PrivacyInfo.xcprivacy */; };`,
  ]);
  changed = true;
}
if (!mainGroupHasReference) {
  const currentGroup = project.match(mainGroupPattern)?.[0];
  if (!currentGroup) throw new Error('Missing mainGroup object');
  const childrenMatch = currentGroup.match(/children = \(([\s\S]*?)\);/);
  if (!childrenMatch) throw new Error('Missing mainGroup children');
  const childrenBody = childrenMatch[1].replace(/[ \t\r\n]+$/, '');
  const updatedGroup = currentGroup.replace(childrenMatch[0],
    `children = (${childrenBody}${newline}\t\t\t\t${privacyReferenceId} /* PrivacyInfo.xcprivacy */,${newline}\t\t\t);`);
  project = project.replace(currentGroup, updatedGroup);
  changed = true;
}
if (!hasResourceBuildFile) {
  const currentPhase = project.match(new RegExp(
    `^[ \\t]*${escapeRegExp(resourcesPhase.id)}[ \\t]+\\/\\* [^*]+ \\*\\/ = \\{\\r?\\n[ \\t]*isa = PBXResourcesBuildPhase;[\\s\\S]*?(?:\\r?\\n)[ \\t]*\\};`,
    'gm',
  ))?.[0];
  if (!currentPhase) throw new Error('Missing target Resources phase');
  const filesMatch = currentPhase.match(/files = \(([\s\S]*?)\);/);
  if (!filesMatch) throw new Error('Missing target Resources files');
  const updatedPhase = currentPhase.replace(filesMatch[0],
    `files = (${filesMatch[1].replace(/[ \t\r\n]+$/, '')}${newline}\t\t\t\t${privacyBuildFileId} /* PrivacyInfo.xcprivacy in Resources */,${newline}\t\t\t);`);
  project = project.replace(currentPhase, updatedPhase);
  changed = true;
}

if (checkOnly && changed) {
  throw new Error(`PBX project is missing ${resourcePath} in ${targetName} Resources`);
}

if (!checkOnly) {
  if (changed) fs.writeFileSync(projectFile, project);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(Buffer.from(sourceText))) {
  throw new Error(`iOS privacy manifest is not synced: ${destination}`);
}

console.log(`${checkOnly ? 'PASS' : 'Synced'}: ${path.relative(appleDir, destination)} and ${resourcePath} in ${targetName} Resources`);
