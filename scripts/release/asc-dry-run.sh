#!/usr/bin/env bash
set -euo pipefail

# Local-only release metadata gate. This script intentionally never invokes
# `asc`, curl, xcrun, or any other network/release mutation command.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
METADATA_FILE="${METADATA_FILE_OVERRIDE:-${ROOT_DIR}/docs/release/gai-app-store-connect-metadata.json}"

if [[ ! -f "${METADATA_FILE}" ]]; then
  printf 'ERROR: missing canonical metadata: %s\n' "${METADATA_FILE}" >&2
  exit 2
fi

ROOT_DIR_ENV="${ROOT_DIR}" METADATA_FILE_ENV="${METADATA_FILE}" node --input-type=module <<'NODE'
import fs from 'node:fs';

const metadataFile = process.env.METADATA_FILE_ENV;
const rootDir = process.env.ROOT_DIR_ENV;
const raw = fs.readFileSync(metadataFile, 'utf8');
let document;
try {
  document = JSON.parse(raw);
} catch (error) {
  console.error(`ERROR: invalid JSON: ${error.message}`);
  process.exit(2);
}
if (!document || typeof document !== 'object' || Array.isArray(document)) {
  console.error('ERROR: canonical metadata root must be an object');
  process.exit(2);
}

const failures = [];
const allowedReleaseStatuses = new Set(['blocked-local-evidence', 'ready-local-evidence']);
const allowedEvidenceStatuses = new Set(['BLOCKED', 'READY']);
const allowedBlockerStatuses = new Set(['BLOCKED', 'VERIFIED']);
const verifiedAtPattern = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z)?$/;
const evidenceRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,}$/;
const placeholderEvidencePattern = /\b(?:TODO|pending|blocked|unconfirmed|unresolved|unknown|missing|unverified|TBD|not[- ]verified|not\s+yet\s+verified)\b/i;
const isValidVerifiedAt = value => {
  const match = typeof value === 'string' ? value.match(verifiedAtPattern) : null;
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const milliseconds = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0').slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second
    && date.getUTCMilliseconds() === milliseconds
    && date.getTime() <= Date.now();
};
const knownBlockerIds = [
  'physical-recording',
  'app-privacy',
  'export-compliance',
  'reviewer-content',
  'storekit-release-build',
  'smb-release-build',
  'ai-release-build',
  'developer-program-agreement'
];
const knownTestFlightIds = [
  'artifact',
  'physical-device',
  'local-import',
  'smb',
  'optional-ai',
  'commerce',
  'privacy-and-store',
  'readiness'
];
const requiredPaths = [
  ['schemaVersion', document.schemaVersion === 1],
  ['remoteReleaseState.platforms', Array.isArray(document.remoteReleaseState?.platforms)],
  ['release.platform', document.release?.platform === 'IOS'],
  ['release.bundleId', document.release?.bundleId === 'com.windsheep.gai'],
  ['reviewInformation.sevenRequiredCategories', Boolean(document.reviewInformation?.sevenRequiredCategories)],
  ['privacyAndCompliance', Boolean(document.privacyAndCompliance)],
  ['testFlightGate', Array.isArray(document.testFlightGate)],
  ['activeEvidence.blockers', Array.isArray(document.activeEvidence?.blockers)],
  ['ascCommandTemplates', Boolean(document.ascCommandTemplates)]
];
for (const [path, valid] of requiredPaths) {
  if (!valid) failures.push(`missing or invalid ${path}`);
}

if (!allowedReleaseStatuses.has(document.status)) {
  failures.push(`invalid release status ${String(document.status)}`);
}
const evidenceStatus = document.activeEvidence?.status;
if (!allowedEvidenceStatuses.has(evidenceStatus)) {
  failures.push(`invalid activeEvidence.status ${String(evidenceStatus)}`);
}
const blockers = document.activeEvidence?.blockers;
const blockerIds = new Set();
if (Array.isArray(blockers)) {
  blockers.forEach((blocker, index) => {
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) {
      failures.push(`activeEvidence.blockers[${index}] must be an object`);
      return;
    }
    if (typeof blocker.id !== 'string' || !knownBlockerIds.includes(blocker.id)) {
      failures.push(`unknown active evidence blocker id at index ${index}`);
    } else if (blockerIds.has(blocker.id)) {
      failures.push(`duplicate active evidence blocker id ${blocker.id}`);
    } else {
      blockerIds.add(blocker.id);
    }
    if (!allowedBlockerStatuses.has(blocker.status)) {
      failures.push(`active evidence blocker ${blocker.id || index} must have status BLOCKED or VERIFIED`);
    }
    if (typeof blocker.evidence !== 'string' || blocker.evidence.trim() === '') {
      failures.push(`active evidence blocker ${blocker.id || index} requires evidence`);
    }
    if (blocker.status === 'VERIFIED') {
      if (!isValidVerifiedAt(blocker.verifiedAt)) {
        failures.push(`verified evidence ${blocker.id || index} requires a valid verifiedAt`);
      }
      if (typeof blocker.evidenceRef !== 'string' || !evidenceRefPattern.test(blocker.evidenceRef)) {
        failures.push(`verified evidence ${blocker.id || index} requires a recognizable evidenceRef`);
      }
      if (placeholderEvidencePattern.test(blocker.evidence || '')
        || placeholderEvidencePattern.test(blocker.evidenceRef || '')) {
        failures.push(`verified evidence ${blocker.id || index} cannot contain placeholder language`);
      }
    }
  });
  for (const id of knownBlockerIds) {
    if (!blockerIds.has(id)) failures.push(`missing active evidence blocker ${id}`);
  }
} else {
  failures.push('activeEvidence.blockers must be an array');
}
const blockedBlockers = Array.isArray(blockers) ? blockers.filter(item => item?.status === 'BLOCKED') : [];
const allBlockersVerified = Array.isArray(blockers)
  && blockers.length === knownBlockerIds.length
  && blockers.every(item => item?.status === 'VERIFIED');
if (blockedBlockers.length > 0) {
  if (document.status !== 'blocked-local-evidence') {
    failures.push('any BLOCKED evidence item requires release status blocked-local-evidence');
  }
  if (evidenceStatus !== 'BLOCKED') {
    failures.push('any BLOCKED evidence item requires activeEvidence.status BLOCKED');
  }
} else if (allBlockersVerified) {
  if (document.status !== 'ready-local-evidence') {
    failures.push('all VERIFIED evidence requires release status ready-local-evidence');
  }
  if (evidenceStatus !== 'READY') {
    failures.push('all VERIFIED evidence requires activeEvidence.status READY');
  }
} else {
  failures.push('active evidence must contain either a complete BLOCKED set or a complete VERIFIED set');
}

const requiredCategories = [
  'physicalRecording',
  'deviceAndOperatingSystem',
  'purposeAndTargetAudience',
  'setupAndAccess',
  'externalServices',
  'regionalDifferences',
  'regulatedOrProtectedContent'
];
const categories = document.reviewInformation?.sevenRequiredCategories ?? {};
for (const category of requiredCategories) {
  if (!categories[category]?.value || !categories[category]?.status) {
    failures.push(`incomplete review category ${category}`);
  }
}

if (document.status === 'ready-local-evidence') {
  const testFlightIds = new Set();
  const testFlightGate = document.testFlightGate ?? [];
  for (const [index, gateItem] of testFlightGate.entries()) {
    if (!gateItem || typeof gateItem !== 'object' || Array.isArray(gateItem)) {
      failures.push(`ready-local-evidence testFlightGate[${index}] must be an object`);
      continue;
    }
    if (typeof gateItem.id !== 'string' || !knownTestFlightIds.includes(gateItem.id)) {
      failures.push(`unknown ready-local-evidence testFlightGate id at index ${index}`);
    } else if (testFlightIds.has(gateItem.id)) {
      failures.push(`duplicate ready-local-evidence testFlightGate id ${gateItem.id}`);
    } else {
      testFlightIds.add(gateItem.id);
    }
    if (gateItem.status !== 'VERIFIED') {
      failures.push(`ready-local-evidence requires testFlightGate[${index}] status VERIFIED`);
      continue;
    }
    if (typeof gateItem.evidence !== 'string' || gateItem.evidence.trim() === '') {
      failures.push(`ready-local-evidence requires testFlightGate[${index}] evidence`);
    } else if (placeholderEvidencePattern.test(gateItem.evidence)) {
      failures.push(`ready-local-evidence testFlightGate[${index}] contains placeholder language`);
    }
  }
  for (const id of knownTestFlightIds) {
    if (!testFlightIds.has(id)) failures.push(`missing ready-local-evidence testFlightGate ${id}`);
  }
  const appPrivacyQuestionnaire = document.privacyAndCompliance?.appPrivacyQuestionnaire;
  if (typeof appPrivacyQuestionnaire !== 'string' || appPrivacyQuestionnaire.trim() === '') {
    failures.push('ready-local-evidence requires privacyAndCompliance.appPrivacyQuestionnaire');
  } else if (placeholderEvidencePattern.test(appPrivacyQuestionnaire)) {
    failures.push('ready-local-evidence App Privacy questionnaire contains placeholder language');
  }
  for (const category of requiredCategories) {
    const categoryData = categories[category];
    if (categoryData?.status !== 'VERIFIED') {
      failures.push(`ready-local-evidence review category ${category} requires status VERIFIED`);
    }
    for (const field of ['value', 'evidence']) {
      if (typeof categoryData?.[field] !== 'string' || categoryData[field].trim() === '') {
        failures.push(`ready-local-evidence review category ${category} requires ${field}`);
      } else if (placeholderEvidencePattern.test(categoryData[field])) {
        failures.push(`ready-local-evidence review category ${category} ${field} contains placeholder language`);
      }
    }
  }
}

const flattened = JSON.stringify(document);
const suspiciousSecretKey = /"(?:apiKey|api_key|password|secret|token)"\s*:\s*"(?!TODO)/i;
if (suspiciousSecretKey.test(flattened)) failures.push('possible secret value found in canonical JSON');
const providerKeyShape = /(?:^|[^A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})(?=$|[^A-Za-z0-9_-])/;
if (providerKeyShape.test(flattened)) failures.push('possible provider key prefix found in canonical JSON');

if (failures.length > 0) {
  console.error('LOCAL DRY-RUN: FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(2);
}

console.log(`canonical metadata: ${metadataFile.replace(`${rootDir}/`, '')}`);
console.log(`release status: ${document.status}`);
const activeBlockers = blockedBlockers;
console.log(`active evidence blockers: ${activeBlockers.length}`);
if (activeBlockers.length > 0) {
  console.error('LOCAL DRY-RUN: BLOCKED (no ASC/network command was executed)');
  console.error('submission status: BLOCKED until active evidence blockers are resolved and owner evidence is reviewed');
  for (const blocker of activeBlockers) {
    console.error(`- ${blocker.id}: ${blocker.evidence || blocker.status}`);
  }
  process.exit(3);
}
console.log('LOCAL DRY-RUN: PASS (no ASC/network command was executed)');
console.log('command templates (display only):');
console.log(`  ${document.ascCommandTemplates.validate}`);
console.log(`  ${document.ascCommandTemplates.stageDryRun}`);
console.log(`  ${document.ascCommandTemplates.reviewDryRun}`);
console.log('guardrail: do not add --confirm from this script');
NODE
