import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const calls = [];
const source = fs.readFileSync(new URL('../public/tauri-api.js', import.meta.url), 'utf8');
const nativeBook = {
  id: 'shared-id', sourceId: 'local:one', title: 'History fixture',
  pages: ['page-1', 'page-2', 'page-3'], historyToken: 'immutable-open-session',
  preloadGeneration: 4,
  progress: { currentPage: 0, totalPages: 3, updatedAt: '2000-01-01T00:00:00Z' },
};
const context = {
  window: { __TAURI__: {
    core: { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'open_comic') return nativeBook;
      if (command === 'update_reader_cache_window') return 99;
      if (command === 'get_reading_history') return { items: [], total: 0 };
      if (command === 'record_reading_history' && args.sourceId === 'local:wrong') {
        throw 'history source mismatch';
      }
      return null;
    } },
    event: { listen() {} },
  } },
  document: { getElementById: () => null },
  console: { log() {}, warn() {} },
};
vm.runInNewContext(source, context);
const api = context.window.electronAPI;
const query = { period: 'year', offset: 40, limit: 40, timeZoneOffsetMinutes: 480 };
assert.deepEqual(await api.getReadingHistory(query), { items: [], total: 0 });
assert.equal(calls.at(-1).command, 'get_reading_history');
assert.equal(calls.at(-1).args.query, query, 'date range and bounded paging reach native unchanged');

const opened = await api.openComic(nativeBook.id, nativeBook.sourceId);
assert.equal(opened.historyToken, nativeBook.historyToken, 'normalization preserves the immutable session');
await api.recordReadingHistory({ id: opened.id, sourceId: opened.sourceId, requestToken: opened.historyToken });
assert.equal(calls.at(-1).command, 'record_reading_history');
assert.equal(calls.at(-1).args.sourceId, 'local:one');
assert.equal(calls.at(-1).args.requestToken, 'immutable-open-session');
await assert.rejects(api.recordReadingHistory({ id: opened.id, sourceId: 'local:wrong', requestToken: opened.historyToken }),
  error => error === 'history source mismatch', 'native rejection is not reported as a saved history event');
console.log('reading-history bridge passed');
