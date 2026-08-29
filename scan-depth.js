export function parseScanDepth(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();
  if (value === 'unlimited') return Infinity;
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : 3;
}

export const configuredScanDepth = parseScanDepth(process.env.GAI_SCAN_MAX_DEPTH);

export function hasReachedScanDepth(depth, maximumDepth = configuredScanDepth) {
  return Number.isFinite(maximumDepth) && depth > maximumDepth;
}
