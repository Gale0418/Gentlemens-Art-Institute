import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf(`async function ${name}`);
  if (start < 0) start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `app.js should define ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unable to extract ${name}`);
}

class FakeSummary {
  constructor() { this.focusCalls = []; }
  focus(options) { this.focusCalls.push(options); }
}

class FakeMetadataTarget {
  constructor() {
    this.isConnected = true;
    this.innerHTML = '';
    this._inspectorRelatedRequested = false;
    this._requestInspectorRelatedTags = null;
  }
  querySelectorAll() { return []; }
}

class FakeManagement {
  constructor(target, { open = false, connected = true } = {}) {
    this.open = open;
    this.isConnected = connected;
    this.listeners = new Map();
    this.summary = new FakeSummary();
    this.target = target;
    this.candidateMarkup = '<button class="ai-candidate-apply">candidate retained</button>';
    this.childFocus = null;
  }
  querySelector(selector) {
    if (selector === 'summary') return this.summary;
    if (selector === '#inspector-metadata') return this.target;
    return null;
  }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  contains(node) { return node === this.summary || node === this.childFocus; }
  dispatch(type) { for (const callback of this.listeners.get(type) || []) callback(); }
}

function bindDisclosureHarness({ open = false, connected = true, selectedComic = null } = {}) {
  const comic = { id: 'book-a', sourceId: 'local:a' };
  let selected = selectedComic || comic;
  const target = new FakeMetadataTarget();
  const management = new FakeManagement(target, { open, connected });
  const state = { inspectorManagementExpanded: false };
  let relatedRequests = 0;
  target._requestInspectorRelatedTags = () => { relatedRequests += 1; };
  const context = {
    elements: {
      comicInspector: {
        querySelector: selector => selector === '[data-inspector-management]' ? management : null,
      },
    },
    state,
    document: { activeElement: null },
    isSelectedComic: candidate => candidate.id === selected.id && candidate.sourceId === selected.sourceId,
  };
  const bind = vm.runInNewContext(
    `${extractFunction(appSource, 'requestInspectorRelatedMetadata')}\n${extractFunction(appSource, 'bindInspectorManagementDisclosure')}\nbindInspectorManagementDisclosure`,
    context,
  );
  bind(comic);
  return {
    comic,
    target,
    management,
    state,
    get relatedRequests() { return relatedRequests; },
    select: value => { selected = value; },
  };
}

{
  const h = bindDisclosureHarness();
  assert.equal(h.relatedRequests, 0, 'closed management disclosure must not request related tags');
  assert.equal(h.state.inspectorManagementExpanded, false);

  h.management.open = true;
  h.management.dispatch('toggle');
  assert.equal(h.relatedRequests, 1, 'first open requests related tags once');
  assert.equal(h.state.inspectorManagementExpanded, true);

  h.management.open = false;
  h.management.dispatch('toggle');
  assert.equal(h.state.inspectorManagementExpanded, false);
  h.management.open = true;
  h.management.dispatch('toggle');
  assert.equal(h.relatedRequests, 1, 'close/reopen on the same DOM must not repeat related tags');
  assert.match(h.management.candidateMarkup, /candidate retained/, 'close/reopen must preserve candidate DOM content');
}

{
  const h = bindDisclosureHarness({ open: true });
  assert.equal(h.relatedRequests, 1, 'pre-open management requests related tags during initial sync');
  h.management.dispatch('toggle');
  assert.equal(h.relatedRequests, 1, 'initial sync plus queued toggle must not double request');
}

{
  const comic = { id: 'book-focus', sourceId: 'local:focus' };
  const target = new FakeMetadataTarget();
  const management = new FakeManagement(target, { open: true });
  const document = { activeElement: null };
  const context = {
    elements: { comicInspector: { querySelector: () => management } },
    state: { inspectorManagementExpanded: true },
    document,
    isSelectedComic: () => true,
  };
  const bind = vm.runInNewContext(
    `${extractFunction(appSource, 'requestInspectorRelatedMetadata')}\n${extractFunction(appSource, 'bindInspectorManagementDisclosure')}\nbindInspectorManagementDisclosure`,
    context,
  );
  bind(comic);
  management.childFocus = {};
  document.activeElement = management.childFocus;
  management.open = false;
  management.dispatch('toggle');
  assert.equal(management.summary.focusCalls.length, 1, 'closing with focus in content must return it to summary');
  assert.equal(management.summary.focusCalls[0].preventScroll, true);
}

{
  const detached = bindDisclosureHarness({ connected: false });
  detached.state.inspectorManagementExpanded = 'sentinel';
  detached.management.open = true;
  detached.management.dispatch('toggle');
  assert.equal(detached.relatedRequests, 0, 'detached details must not request related tags');
  assert.equal(detached.state.inspectorManagementExpanded, 'sentinel', 'detached details must not mutate current state');
}

{
  const h = bindDisclosureHarness();
  h.state.inspectorManagementExpanded = 'sentinel';
  h.select({ id: h.comic.id, sourceId: 'smb:other-root' });
  h.management.open = true;
  h.management.dispatch('toggle');
  assert.equal(h.relatedRequests, 0, 'source-qualified selection change must reject stale details toggle');
  assert.equal(h.state.inspectorManagementExpanded, 'sentinel', 'stale details toggle must not mutate the new book state');
}

function makeMetadataFixture({ metadataDeferred = false } = {}) {
  const comic = { id: 'metadata-book', sourceId: 'local:library', relativePath: 'books/metadata-book.cbz' };
  const managementTarget = new FakeMetadataTarget();
  const readonlyTags = { innerHTML: '' };
  const management = new FakeManagement(managementTarget);
  const elements = {
    comicInspector: {
      querySelector: selector => {
        if (selector === '#inspector-metadata') return managementTarget;
        if (selector === '[data-inspector-readonly-tags]') return readonlyTags;
        if (selector === '[data-inspector-management]') return management;
        return null;
      },
    },
  };
  const state = { tagInventoryItems: [] };
  let metadataCalls = 0;
  let relatedCalls = 0;
  let finishMetadata;
  const metadataResult = {
    comicId: 'canonical-metadata-book',
    sourceId: comic.sourceId,
    title: 'Metadata book',
    series: '',
    language: '',
    readingDirection: '',
    offline: false,
    creators: {},
    tags: [{ namespace: 'genre', value: 'Mystery' }],
    candidates: [],
    lockedFields: [],
    diagnostics: [],
  };
  const eAPI = {
    getComicMetadata: async (id, sourceId, relativePath) => {
      metadataCalls += 1;
      assert.deepEqual([id, sourceId, relativePath], [comic.id, comic.sourceId, comic.relativePath]);
      if (!metadataDeferred) return metadataResult;
      return new Promise(resolve => { finishMetadata = () => resolve(metadataResult); });
    },
    listRelatedTags: async id => {
      relatedCalls += 1;
      assert.equal(id, 'canonical-metadata-book');
      return [];
    },
  };
  const context = {
    elements,
    state,
    eAPI,
    inspectorMetadataRequestGeneration: 0,
    getComicSourceId: candidate => candidate.sourceId,
    isComicSourceAmbiguous: () => false,
    isSelectedComic: candidate => candidate.id === comic.id && candidate.sourceId === comic.sourceId,
    resolveInspectorMetadataTarget: (candidate, metadata) => candidate === comic && metadata.sourceId === comic.sourceId
      ? { comicId: metadata.comicId, sourceId: metadata.sourceId }
      : null,
    tagColorKey: () => 'genre',
    escapeHtml: value => String(value),
    readerText: value => value,
    formatReadingDirection: value => value || '—',
  };
  const load = vm.runInNewContext(`(${extractFunction(appSource, 'loadInspectorMetadata')})`, context);
  const requestRelated = vm.runInNewContext(`(${extractFunction(appSource, 'requestInspectorRelatedMetadata')})`, context);
  return {
    comic,
    management,
    managementTarget,
    readonlyTags,
    get metadataCalls() { return metadataCalls; },
    get relatedCalls() { return relatedCalls; },
    finishMetadata: () => finishMetadata?.(),
    load,
    requestRelated,
  };
}

{
  const h = makeMetadataFixture();
  await h.load(h.comic, true);
  assert.equal(h.metadataCalls, 1, 'normal-layer tag snapshot must call getComicMetadata once');
  assert.match(h.readonlyTags.innerHTML, /genre:Mystery/, 'normal-layer read-only tags must use the metadata snapshot');
  assert.equal(h.relatedCalls, 0, 'closed management must defer related tag suggestions');
  assert.equal(h.managementTarget._inspectorRelatedRequested, false);

  assert.equal(h.requestRelated(h.comic, h.management), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.relatedCalls, 1, 'first management open must request related tags');
  assert.equal(h.metadataCalls, 1, 'opening management must reuse the existing metadata snapshot');
  assert.match(h.managementTarget.innerHTML, /整理資料/);
}

{
  const h = makeMetadataFixture({ metadataDeferred: true });
  const snapshotPromise = h.load(h.comic, true);
  assert.equal(h.metadataCalls, 1);
  assert.equal(h.relatedCalls, 0);
  h.requestRelated(h.comic, h.management);
  assert.equal(h.relatedCalls, 0, 'opening before snapshot resolution must wait for the same snapshot');
  h.finishMetadata();
  await snapshotPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.relatedCalls, 1, 'pending snapshot must start related tags once after management was requested');
  assert.equal(h.metadataCalls, 1, 'pending-open path must not issue a second metadata request');
}

console.log('inspector management disclosure and shared metadata snapshot behavior passed');
