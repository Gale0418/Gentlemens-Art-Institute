#!/usr/bin/env bash
set -euo pipefail

# Local-only release metadata gate. This script intentionally never invokes
# `asc`, curl, xcrun, or any other network/release mutation command.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
METADATA_FILE="${ROOT_DIR}/docs/release/gai-app-store-connect-metadata.json"

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

const failures = [];
const requiredPaths = [
  ['schemaVersion', document.schemaVersion === 1],
  ['release.platform', document.release?.platform === 'IOS'],
  ['release.bundleId', document.release?.bundleId === 'com.windsheep.gai'],
  ['reviewInformation.sevenRequiredCategories', Boolean(document.reviewInformation?.sevenRequiredCategories)],
  ['privacyAndCompliance', Boolean(document.privacyAndCompliance)],
  ['testFlightGate', Array.isArray(document.testFlightGate)],
  ['ascCommandTemplates', Boolean(document.ascCommandTemplates)]
];
for (const [path, valid] of requiredPaths) {
  if (!valid) failures.push(`missing or invalid ${path}`);
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

const flattened = JSON.stringify(document);
const todoCount = (flattened.match(/\bTODO\b/gi) ?? []).length;
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
console.log(`unresolved TODO markers: ${todoCount}`);
if (todoCount > 0) {
  console.error('LOCAL DRY-RUN: BLOCKED (no ASC/network command was executed)');
  console.error('submission status: BLOCKED until every TODO is resolved and owner evidence is reviewed');
  process.exit(3);
}
console.log('LOCAL DRY-RUN: PASS (no ASC/network command was executed)');
console.log('command templates (display only):');
console.log(`  ${document.ascCommandTemplates.validate}`);
console.log(`  ${document.ascCommandTemplates.stageDryRun}`);
console.log(`  ${document.ascCommandTemplates.reviewDryRun}`);
console.log('guardrail: do not add --confirm from this script');
NODE
