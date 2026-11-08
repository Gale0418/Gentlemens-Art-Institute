import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./perf-preview.mjs', import.meta.url), 'utf8');
const bootstrap = source.match(/const FIXTURE_BOOTSTRAP = String\.raw`([\s\S]*?)`;/)?.[1];
assert.ok(bootstrap, 'perf fixture bootstrap is present');

function extractFunction(name) {
  const start = bootstrap.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in the browser bootstrap`);
  const open = bootstrap.indexOf(') {', start) + 2;
  let depth = 0;
  for (let index = open; index < bootstrap.length; index += 1) {
    if (bootstrap[index] === '{') depth += 1;
    if (bootstrap[index] === '}') {
      depth -= 1;
      if (depth === 0) return bootstrap.slice(start, index + 1);
    }
  }
  assert.fail(`${name} has a closing brace`);
}

const acceptancePassed = vm.runInNewContext(`(${extractFunction('acceptancePassed').replace(/^function acceptancePassed/, 'function')})`, {
  percentile(values, ratio) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  },
});
const healthyMetrics = {
  scanTrue: 1,
  scanFalse: 1,
  libraryChanged: 3,
  listenerStats: { libraryChanged: 1, scanProgress: 1 },
  frameSamples: [16, 17, 20],
};
assert.equal(acceptancePassed({ ...healthyMetrics, frameSamples: [] }), false, 'no rAF samples cannot pass');
assert.equal(acceptancePassed(healthyMetrics), true, 'valid frame samples pass when event metrics meet thresholds');
assert.equal(acceptancePassed({ ...healthyMetrics, failureReason: 'rAF timeout' }), false, 'a timed-out run cannot pass even with partial frame samples');
assert.equal(acceptancePassed({ ...healthyMetrics, frameSamples: [16, 101] }), false, 'frame max threshold is preserved');

const finishFunction = extractFunction('finishAcceptance');
let running = true;
let rafId = 42;
let finishTimer = 43;
let acceptanceWatchdog = 44;
let mutationDisconnected = 0;
let longTaskDisconnected = 0;
let stopCount = 0;
let clearedTimers = [];
let cancelledFrames = [];
const runButton = { disabled: true };
const result = { textContent: '' };
const context = {
  running,
  rafId,
  finishTimer,
  acceptanceWatchdog,
  mutationObserver: { disconnect() { mutationDisconnected += 1; } },
  longTaskObserver: { disconnect() { longTaskDisconnected += 1; } },
  runButton,
  result,
  fixture: { stopAcceptance() { stopCount += 1; }, changeMode: 'sparse', getListenerStats: () => ({ libraryChanged: 1, scanProgress: 1 }) },
  eventStats: { scanTrue: 1, scanFalse: 1, libraryChanged: 3 },
  startedStats: { scanTrue: 0, scanFalse: 0, libraryChanged: 0 },
  startedListenerStats: { libraryChanged: 1, scanProgress: 1 },
  frameSamples: [],
  longTasks: [],
  failureReason: '',
  gridChildListMutations: 0,
  gridReplacementNodes: 0,
  FIXTURE_COUNT: 5000,
  acceptancePassed,
  percentile: () => 0,
  document: { querySelector: () => ({ scrollTop: 10 }) },
  clearTimeout(id) { clearedTimers.push(id); },
  cancelAnimationFrame(id) { cancelledFrames.push(id); },
};
vm.runInNewContext(`${finishFunction}; finishAcceptance();`, context);
assert.equal(context.running, false, 'finish releases the running state so the user can retry');
assert.equal(context.rafId, 0);
assert.equal(context.finishTimer, 0);
assert.equal(context.acceptanceWatchdog, 0);
assert.deepEqual(clearedTimers, [43, 44], 'finish clears pending timers');
assert.deepEqual(cancelledFrames, [42], 'finish cancels a pending animation frame');
assert.equal(mutationDisconnected, 1);
assert.equal(longTaskDisconnected, 1);
assert.equal(runButton.disabled, false, 'finish re-enables the retry button');
assert.match(result.textContent, /FAIL/);
assert.match(result.textContent, /p95 N\/A；max N\/A/);
assert.equal(stopCount, 1);
vm.runInNewContext('finishAcceptance();', context);
assert.equal(stopCount, 1, 'repeated finish calls are harmless');

assert.match(bootstrap, /acceptanceWatchdog = setTimeout\([\s\S]*?ACCEPTANCE_TIMEOUT_MS\)/, 'wall-clock watchdog ends a stalled rAF run');
console.log('perf-preview regression checks passed');
