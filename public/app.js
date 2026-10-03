function readerText(sourceZh, vars = {}) {
  if (window.GAIL10n) return window.GAIL10n.t(sourceZh, vars);
  return sourceZh.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
}

function formatPageCount(count) {
  if (Number(count) === 1) return readerText('1 頁');
  return `${count}${window.GAIL10n?.locale === 'ja' ? '' : ' '}${readerText('頁')}`;
}

const FILE_CAPABILITY_REASONS = new Set([
  '漫畫來源目前離線',
  '缺少可驗證的檔案版本，已停用檔案操作',
  'NAS 操作會先驗證位置版本；刪除會移到同一共用資料夾的 .gai-quarantine，可撤銷',
  '此 Files／外部來源尚未提供可靠的可復原檔案操作',
  'NAS 漫畫路徑不安全，已停用檔案操作',
  'NAS 目前無法驗證漫畫位置版本，已停用檔案操作',
  'NAS 漫畫不存在或無法取得位置版本，已停用檔案操作',
]);

function localizeFileCapabilityReason(reason) {
  if (!reason) return '';
  if (/^PRO_REQUIRED(?:\s*:|$)/i.test(reason)) return readerText('這項功能需要 G.A.I Pro。');
  return readerText(FILE_CAPABILITY_REASONS.has(reason) ? reason : '檔案操作目前不可用。');
}

/**
 * 前端核心邏輯 (app.js)
 * 擁有流暢的翻頁機制、非同步雙頁載入、自動預載快取、快捷鍵綁定
 */

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch(e) {}
    throw new Error(message);
  }

  return response.json();
}

const httpFavoritesKey = 'gai:favorites';

// Electron IPC API；瀏覽器模式會退回 server.js 的 HTTP API
const httpAPI = {
  isElectron: false,
  getLibrary: () => requestJson('/api/library'),
  getScanStatus: () => requestJson('/api/scan-status'),
  openComic: (id) => requestJson(`/api/comic/${encodeURIComponent(id)}`),
  updateReaderCacheWindow: null,
  saveProgress: (data) => requestJson('/api/progress', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  getConfig: () => requestJson('/api/config'),
  setConfig: (data) => requestJson('/api/config', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  openFolderDialog: async () => null,
  browseFolders: (dirPath) => requestJson(`/api/browse-folders?path=${encodeURIComponent(dirPath || '')}`),
  onLibraryChanged: () => {},
  onCatalogChanged: () => {},
  getFavorites: async () => {
    try {
      try {
        return JSON.parse(localStorage.getItem(httpFavoritesKey) || '[]');
      } catch (e) {
        return [];
      }
    } catch(e) {
      return [];
    }
  },
  toggleFavorite: async (id) => {
    const favorites = await httpAPI.getFavorites();
    const index = favorites.indexOf(id);
    if (index >= 0) favorites.splice(index, 1);
    else favorites.push(id);
    localStorage.setItem(httpFavoritesKey, JSON.stringify(favorites));
    return favorites;
  },
  showItemInFolder: async () => null,
  trashPage: async (comicId, pageIndex) => ({ success: false, error: 'not-supported-in-web' }),
  searchCatalog: null,
  getComicMetadata: null,
  applyBatchMetadata: null,
  undoBatchMetadata: null,
  upsertFolderTagRule: null,
  reimportMetadata: null,
  upsertTagAlias: null,
  exportCatalogMetadata: null,
  getCatalogExportPath: null,
  saveCatalogMetadata: null,
  listRelatedTags: null,
  listTagInventory: null,
  updateTagState: null,
  renameTag: null,
  mergeTags: null,
  setTagDisabled: null,
  undoTagOperation: null,
  getAiSessionStatus: null,
  setAiSessionConfig: null,
  restoreAiSessionConfig: null,
  revokeAiSessionConfig: null,
  clearAiSessionConfig: null,
  testAiSession: null,
  explainPage: null,
  suggestComicMetadata: null,
};

const eAPI = window.electronAPI || httpAPI;
const MAX_PRIORITY_LIBRARY_IDS = 4096;
let libraryRefreshTimer = null;
let activeLibraryFetch = null;
let incrementalItemsDuringFetch = new Map();
let libraryFetchQueued = false;
let scanPollGeneration = 0;
// A native status call can outlive the interval that created it. Keep the
// single unresolved call across stop/start so repeated rescans cannot create
// an unbounded pile of pending promises.
let scanStatusPendingRequest = null;
const SCAN_STATUS_POLL_INTERVAL_MS = 700;
const SCAN_STATUS_REQUEST_TIMEOUT_MS = 5000;
const SCAN_STATUS_POLL_WALLCLOCK_MS = 42 * 60 * 1000;
let lastGridRenderSignature = '';
let lastContinueRenderSignature = '';
let lastInspectorRenderSignature = '';
let libraryRefreshRunner = null;
let incrementalLibraryRenderFrame = null;
let visibleDirectoryScanRequestId = 0;
let visibleDirectoryScanInFlight = new Map();
let visibleDirectoryNavigationEpoch = 0;
let adjacentComicSwitchToken = 0;
let lastPriorityLibraryScanKey = '';
// Native command 排程不保證呼叫者的完成順序；把每筆進度快照排成單一
// promise chain，避免快速翻頁時較舊頁碼晚於新頁碼落庫。
let readingProgressSaveQueue = Promise.resolve();
const READING_PROGRESS_FAILURES_KEY = 'gai:readingProgressFailures';
const READING_PROGRESS_AUTO_RETRY_DELAYS_MS = [250, 750];
let readingProgressFailuresLoaded = false;
let readingProgressFailures = new Map();
let readingProgressFailuresStorageReliable = true;
let latestQueuedReadingProgressById = new Map();
let readingProgressRetryPromise = null;
// Rust 會在 WebView reload 後保留本次 app runtime 已提交的序號；將
// 最後發出的序號留在 tab session，讓立即 reload 也不會退回較舊值。
const READING_PROGRESS_SEQUENCE_KEY = 'gai:readingProgressSequence';
function initialReadingProgressSaveSequence() {
  const wallClock = Date.now() * 1000;
  try {
    const previous = Number(sessionStorage.getItem(READING_PROGRESS_SEQUENCE_KEY));
    return Number.isSafeInteger(previous) ? Math.max(wallClock, previous) : wallClock;
  } catch (error) {
    return wallClock;
  }
}
let readingProgressSaveSequence = initialReadingProgressSaveSequence();
function nextReadingProgressSaveSequence() {
  readingProgressSaveSequence = Math.max(readingProgressSaveSequence + 1, Date.now() * 1000);
  try {
    sessionStorage.setItem(READING_PROGRESS_SEQUENCE_KEY, String(readingProgressSaveSequence));
  } catch (error) {
    // Native queue remains ordered even if tab storage is unavailable.
  }
  return readingProgressSaveSequence;
}

function nextReadingProgressSaveSequenceAfter(previousSequence) {
  const allocated = nextReadingProgressSaveSequence();
  if (allocated > previousSequence) return allocated;
  readingProgressSaveSequence = previousSequence + 1;
  try {
    sessionStorage.setItem(READING_PROGRESS_SEQUENCE_KEY, String(readingProgressSaveSequence));
  } catch (error) {
    // Native queue remains ordered even if tab storage is unavailable.
  }
  return readingProgressSaveSequence;
}

function normalizeReadingProgressSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id) return null;
  const totalPages = Number(snapshot.totalPages);
  const currentPage = Number(snapshot.currentPage);
  const sequence = Number(snapshot.sequence);
  if (!Number.isSafeInteger(totalPages) || totalPages < 0
    || !Number.isSafeInteger(currentPage) || currentPage < 0
    || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  return {
    id: snapshot.id,
    currentPage: Math.min(currentPage, Math.max(0, totalPages - 1)),
    totalPages,
    sequence,
  };
}

function readingProgressIntentSequence(snapshot) {
  // A manual retry gets a fresh native sequence, but remains ordered as the
  // original user intent for queue/journal conflict checks.
  const intentSequence = Number(snapshot?.intentSequence);
  if (Number.isSafeInteger(intentSequence) && intentSequence >= 0) return intentSequence;
  return Number(snapshot?.sequence);
}

function readReadingProgressFailures() {
  if (readingProgressFailuresLoaded) return readingProgressFailures;
  readingProgressFailuresLoaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(READING_PROGRESS_FAILURES_KEY) || '[]');
    const entries = Array.isArray(raw) ? raw : Object.values(raw || {});
    entries.forEach(entry => {
      const normalized = normalizeReadingProgressSnapshot(entry);
      if (!normalized) return;
      const previous = readingProgressFailures.get(normalized.id);
      if (!previous || normalized.sequence >= previous.sequence) {
        readingProgressFailures.set(normalized.id, normalized);
      }
    });
  } catch (error) {
    // Storage is optional; the in-memory journal still keeps this session recoverable.
  }
  return readingProgressFailures;
}

function writeReadingProgressFailures() {
  const entries = Array.from(readReadingProgressFailures().values())
    .sort((a, b) => b.sequence - a.sequence);
  readingProgressFailures = new Map(entries.map(entry => [entry.id, entry]));
  try {
    localStorage.setItem(READING_PROGRESS_FAILURES_KEY, JSON.stringify(entries));
    readingProgressFailuresStorageReliable = true;
  } catch (error) {
    readingProgressFailuresStorageReliable = false;
    // Keep every memory entry and the visible session-only recovery action.
  }
}

function renderReadingProgressRecovery() {
  const failures = Array.from(readReadingProgressFailures().values());
  if (typeof document === 'undefined') return;
  let panel = document.getElementById('reading-progress-recovery');
  if (!panel && failures.length && document.createElement) {
    panel = document.createElement('div');
    panel.id = 'reading-progress-recovery';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.style.cssText = 'display:flex;align-items:center;gap:10px;margin:12px 0;padding:10px 14px;border:1px solid rgba(255,180,80,.45);border-radius:10px;';
    const message = document.createElement('span');
    message.className = 'reading-progress-recovery-message';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'reader-image-error';
    retry.addEventListener('click', () => retryFailedReadingProgressSnapshots());
    panel.append(message, retry);
    const anchor = elements.libraryWorkspace || elements.contentArea;
    if (anchor?.prepend) anchor.prepend(panel);
  }
  if (!panel) return;
  panel.hidden = failures.length === 0;
  panel.style.display = failures.length ? 'flex' : 'none';
  const message = panel.querySelector?.('.reading-progress-recovery-message');
  const retry = panel.querySelector?.('button');
  if (message) {
    const pendingText = readerText('有 {count} 本漫畫的閱讀進度尚未保存。', { count: failures.length });
    const storageText = readingProgressFailuresStorageReliable
      ? ''
      : ` ${readerText('此 App session 可重試，尚未可靠備份。')}`;
    message.textContent = pendingText + storageText;
  }
  if (retry) {
    retry.disabled = false;
    retry.textContent = readerText('重試保存閱讀進度');
  }
}

function rememberFailedReadingProgressSnapshot(snapshot) {
  const normalized = normalizeReadingProgressSnapshot(snapshot);
  if (!normalized) return;
  const failures = readReadingProgressFailures();
  const previous = failures.get(normalized.id);
  if (!previous || normalized.sequence >= previous.sequence) failures.set(normalized.id, normalized);
  writeReadingProgressFailures();
  renderReadingProgressRecovery();
}

function clearReadingProgressFailure(snapshot, intentSequence = readingProgressIntentSequence(snapshot)) {
  const normalized = normalizeReadingProgressSnapshot(snapshot);
  if (!normalized) return;
  const failures = readReadingProgressFailures();
  const current = failures.get(normalized.id);
  const latestQueued = latestQueuedReadingProgressById.get(normalized.id);
  if (latestQueued && readingProgressIntentSequence(latestQueued) > intentSequence) return;
  if (current && current.sequence <= normalized.sequence) {
    failures.delete(normalized.id);
    writeReadingProgressFailures();
    renderReadingProgressRecovery();
  }
}

function waitForReadingProgressRetry(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function persistReadingProgressSnapshot(snapshot, intentSequence = readingProgressIntentSequence(snapshot)) {
  for (let attempt = 0; attempt <= READING_PROGRESS_AUTO_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      // Legacy APIs may return undefined or false; rejection remains the failure signal.
      await eAPI.saveProgress(snapshot);
      clearReadingProgressFailure(snapshot, intentSequence);
      const latestQueued = latestQueuedReadingProgressById.get(snapshot.id);
      if (latestQueued
        && readingProgressIntentSequence(latestQueued) === intentSequence
        && latestQueued.sequence === snapshot.sequence) {
        latestQueuedReadingProgressById.delete(snapshot.id);
      }
      return true;
    } catch (error) {
      if (attempt >= READING_PROGRESS_AUTO_RETRY_DELAYS_MS.length) {
        const latestQueued = latestQueuedReadingProgressById.get(snapshot.id);
        if (!latestQueued || readingProgressIntentSequence(latestQueued) <= intentSequence) {
          rememberFailedReadingProgressSnapshot(snapshot);
        }
        console.error('保存進度失敗：', error);
        return false;
      }
      await waitForReadingProgressRetry(READING_PROGRESS_AUTO_RETRY_DELAYS_MS[attempt]);
    }
  }
  return false;
}

function retryFailedReadingProgressSnapshots() {
  if (readingProgressRetryPromise) return readingProgressRetryPromise;
  const retryOperation = (async () => {
    const pending = Array.from(readReadingProgressFailures().values())
      .sort((a, b) => a.sequence - b.sequence)
      .flatMap(snapshot => {
        const latestQueued = latestQueuedReadingProgressById.get(snapshot.id);
        if (latestQueued && readingProgressIntentSequence(latestQueued) > snapshot.sequence) return [];
        const sequence = nextReadingProgressSaveSequenceAfter(snapshot.sequence);
        return [{ ...snapshot, sequence, intentSequence: snapshot.sequence }];
      });
    if (!pending.length) {
      renderReadingProgressRecovery();
      return readReadingProgressFailures().size === 0;
    }
    for (const snapshot of pending) await enqueueReadingProgressSnapshot(snapshot);
    renderReadingProgressRecovery();
    return readReadingProgressFailures().size === 0;
  })();
  const retryPromise = retryOperation.finally(() => {
    if (readingProgressRetryPromise === retryPromise) readingProgressRetryPromise = null;
  });
  readingProgressRetryPromise = retryPromise;
  return readingProgressRetryPromise;
}
// 外部資料夾清單是全量寫入；所有 UI intent 必須在同一條 queue 內重讀
// localStorage，避免兩個舊 snapshot 互相覆蓋。
let externalBookmarkMutationQueue = Promise.resolve();

function isLibraryRefreshBlocked() {
  return Boolean(
    state.scanStatus?.isScanning
    || coverScrollActive
    || state.currentComic
    || state.pendingComicId
  );
}

function isIncrementalLibraryRenderBlocked() {
  return Boolean(coverScrollActive || state.currentComic || state.pendingComicId);
}

function queueIncrementalLibraryRender() {
  if (incrementalLibraryRenderFrame !== null) return;
  const render = () => {
    incrementalLibraryRenderFrame = null;
    if (isIncrementalLibraryRenderBlocked()) return;
    // A scan batch already contains the native snapshot needed by the cards.
    // Render once per coalesced batch instead of starting a full library fetch
    // for every discovered book; the final scan event still reconciles all data.
    filterAndRenderGrid({ skipUnchanged: true, background: true });
    renderSidebar();
    renderContinueStrip();
    restoreLibraryRefreshFocus();
    updateStats();
  };
  if (typeof requestAnimationFrame === 'function') {
    incrementalLibraryRenderFrame = requestAnimationFrame(render);
  } else {
    incrementalLibraryRenderFrame = window.setTimeout(render, 0);
  }
}

function applyIncrementalLibraryBatch(payload) {
  if (!payload || !Array.isArray(payload.items)) return false;
  const visibleBatch = payload.visible === true;
  const generation = Number(payload.generation);
  if (!Number.isSafeInteger(generation) || generation <= 0) return false;
  const currentGeneration = Number(state.scanStatus?.generation);
  if (Number.isSafeInteger(currentGeneration)
    && currentGeneration > 0
    && generation < currentGeneration) {
    // A cancelled source can finish emitting an already queued batch. Its
    // generation must never leak books into the newly selected source.
    return true;
  }
  if (Number.isSafeInteger(currentGeneration)
    && currentGeneration === generation
    && state.scanStatus?.isScanning === false
    && state.scanStatus?.completedAt
    && !visibleBatch) {
    // A completed scan may still have a queued progress event behind it.
    return true;
  }

  const positions = new Map(state.comics.map((comic, index) => [comic.id, index]));
  const batchItems = payload.items.filter(comic => comic && comic.id && !isBuiltInDemoComic(comic));
  const validItems = eAPI?.overlayLibraryProgress?.(batchItems) || batchItems;
  if (activeLibraryFetch) {
    let received = incrementalItemsDuringFetch.get(generation);
    if (!received) {
      received = new Map();
      incrementalItemsDuringFetch.set(generation, received);
    }
    validItems.forEach(comic => received.set(comic.id, comic));
  }
  validItems.forEach(comic => {
    const index = positions.get(comic.id);
    if (index === undefined) {
      positions.set(comic.id, state.comics.length);
      state.comics.push(comic);
    } else {
      state.comics[index] = comic;
    }
  });
  if (state.visibleDirectoryGeneration !== generation) {
    state.visibleDirectories.clear();
    state.visibleDirectoryScanCompleted.clear();
    visibleDirectoryScanInFlight.clear();
    state.visibleDirectoryGeneration = generation;
  }
  if (visibleBatch && typeof payload.visiblePath === 'string' && Array.isArray(payload.directories)) {
    const visibleSourceId = normalizeDirectorySourceId(payload.visibleSourceId);
    const visiblePath = normalizeDirectoryPath(payload.visiblePath);
    const visibleKey = getVisibleDirectoryMapKey(visibleSourceId, visiblePath);
    // This is a complete one-level filesystem snapshot. Never union it with
    // an earlier visit, and never accept a sibling from a delayed event.
    const next = payload.directories.filter(path =>
      typeof path === 'string' && getParentPath(normalizeDirectoryPath(path)) === visiblePath);
    state.visibleDirectories.set(visibleKey, [...new Set(next.map(normalizeDirectoryPath))]);
  }
  invalidateComicNavigationCache();
  if (!visibleBatch) {
    state.scanStatus = {
      ...(state.scanStatus || {}),
      generation,
      isScanning: true,
      found: Math.max(Number(state.scanStatus?.found) || 0, Number(payload.found) || 0),
    };
  }
  state.libraryRefreshPending = true;
  queueIncrementalLibraryRender();
  return true;
}

function requestDeferredLibraryRefresh() {
  state.libraryRefreshPending = true;
  if (!isLibraryRefreshBlocked()) scheduleLibraryRefresh(0);
}

function runScheduledLibraryRefresh() {
  if (isLibraryRefreshBlocked()) {
    state.libraryRefreshPending = true;
    return;
  }
  state.libraryRefreshPending = false;
  (libraryRefreshRunner || (() => fetchLibrary({ background: true })))();
}

function scheduleLibraryRefresh(delay = 80) {
  clearTimeout(libraryRefreshTimer);
  libraryRefreshTimer = window.setTimeout(() => {
    libraryRefreshTimer = null;
    // 排程與實際執行之間可能開始掃描、捲動或開啟閱讀器，必須在 timer
    // 觸發時再檢查一次；被擋住時等 gate 解除，不用高頻重排程忙迴圈。
    runScheduledLibraryRefresh();
  }, delay);
}

function resetLibraryNavigationState() {
  state.currentPath = '';
  state.currentSourceId = '';
  state.currentDirectory = { sourceId: '', relativePath: '' };
  state.expandedFolderPaths = new Set(['root']);
  state.visibleDirectories.clear();
  state.visibleDirectoryScanCompleted.clear();
  visibleDirectoryScanInFlight = new Map();
  visibleDirectoryNavigationEpoch += 1;
  visibleDirectoryScanRequestId += 1;
  requestVisibleDirectoryScan('');
  state.activeSeries = 'all';
  state.activeFilter = 'all';
  state.selectedComicId = null;
  state.organizeSelection.clear();
  state.catalogSearchRequest += 1;
  state.catalogSearchIds = null;
  state.catalogSearchItems.clear();
  state.catalogSearchTotal = 0;
  state.renderLimit = 200;
  lastGridRenderSignature = '';
  lastContinueRenderSignature = '';
  lastInspectorRenderSignature = '';
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = null;
  if (elements.searchInput) elements.searchInput.value = '';
  if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = 'none';
  document.querySelectorAll('.filter-btn').forEach(button => {
    const selected = button.dataset.filter === 'all';
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  renderCatalogFacets([]);
}

function getCoverUrl(comicId) {
  if (!comicId) return '';
  // Keep this helper self-contained because it is also exercised in a small
  // isolated VM by the browser routing test.
  const rawId = String(comicId);
  const demoMatch = rawId.match(/^builtin:landscape-([a-z0-9-]+)$/);
  if (demoMatch) return `assets/demo/landscapes/${demoMatch[1]}/page-01.png`;
  const encodedId = /^photos:[A-Za-z0-9_-]+$/.test(rawId) ? rawId : encodeURIComponent(rawId);
  const runtimeApi = typeof eAPI !== 'undefined' ? eAPI : null;
  if (runtimeApi && runtimeApi.isElectron) {
    return `gai://cover/${encodedId}`;
  }
  return `/api/cover?id=${encodedId}`;
}

// 目錄縮圖只要求 native page/folder route 的 512px PhotoKit 版本；
// 閱讀器仍使用原始 URL，fixture、HTTP 與內建 demo 也維持原樣。
function catalogThumbnailURL(source) {
  const raw = String(source ?? '');
  if (!/^gai:\/\/(?:page|folder)(?:\/|$)/i.test(raw)) return source;
  const hashIndex = raw.indexOf('#');
  const beforeHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : raw.slice(hashIndex);
  if (/[?&]thumbnail=[^&#]*/i.test(beforeHash)) {
    return `${beforeHash.replace(/([?&]thumbnail=)[^&#]*/i, (_, prefix) => `${prefix}1`)}${hash}`;
  }
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}thumbnail=1${hash}`;
}

const READER_PRELOAD_RADIUS = 10;
const MAX_PRELOADED_IMAGES = READER_PRELOAD_RADIUS * 2;
const MAX_IMPORTED_PHOTO_BYTES = 64 * 1024 * 1024;
const READER_CACHE_UPDATE_DELAY_MS = 120;
const WEBTOON_EAGER_IMAGES = 3;
const WEBTOON_RENDER_BEFORE = 12;
const WEBTOON_RENDER_AFTER = 28;
// 目錄只保留捲動視窗附近的縮圖 DOM；頁面本身仍以 spacer 代表完整高度，
// 因此 5,000 頁不會被切成只能按鈕翻的 160 頁視窗。
const CATALOG_RENDER_PAGE_SIZE = 160;
const CATALOG_THUMB_HEIGHT = 180;
const CATALOG_GRID_GAP = 14;
const CATALOG_VIRTUAL_OVERSCAN_ROWS = 3;
const CATALOG_CONTROLS_OFFSET_FALLBACK = 60;
const CATALOG_WINDOW_SHIFT_RATIO = 0.5;
const CATALOG_WINDOW_PAGE_COUNT = CATALOG_RENDER_PAGE_SIZE - 2;
const CATALOG_IMAGE_CONCURRENCY = 8;
const BUILT_IN_DEMO_SOURCE_ID = 'builtin:landscapes';
const BUILT_IN_DEMO_ID_PREFIX = 'builtin:landscape-';

// 閱讀器相鄰漫畫會在每次 window render 查兩次；依書庫世代快取分組與排序，
// 避免長書庫每次滾動都重複 filter + Intl.Collator.sort。
let comicNavigationCache = {
  comics: null,
  revision: -1,
  groups: new Map(),
  byId: new Map(),
};
let catalogImageObserver = null;
let catalogImageQueue = [];
const catalogImageTasks = new Set();
let catalogImageActive = 0;
let catalogImageGeneration = 0;
// 批次換窗時先停止 pump，避免取消舊 active task 的同步 callback
// 把仍掛在 DOM 上、但即將移除的舊 queue 項目重新啟動。
let catalogImagePumpSuspended = false;
let catalogVirtualRenderFrame = null;

const BUILT_IN_DEMO_GROUPS = Object.freeze([
  { slug: 'mountains', title: '層疊群山', pageCount: 2 },
  { slug: 'rivers', title: '蜿蜒河谷', pageCount: 1 },
  { slug: 'coasts', title: '潮汐海岸', pageCount: 2 },
  { slug: 'forests', title: '森林光影', pageCount: 1 },
  { slug: 'lakes', title: '靜謐湖泊', pageCount: 2 },
  { slug: 'deserts', title: '沙丘遠行', pageCount: 1 },
  { slug: 'snow', title: '雪原極光', pageCount: 1 },
  { slug: 'cosmos', title: '宇宙星空', pageCount: 3 },
]);

// 這些圖片是隨 app 打包的 AI 生成風景素材；使用純靜態相對 URL，
// 不經正式 comic protocol，也不會成為 SQLite 的 library authority。
function isBuiltInDemoComic(comic) {
  return Boolean(comic?.isBuiltInDemo || comic?.sourceId === BUILT_IN_DEMO_SOURCE_ID);
}

// 實體圖片資料夾本身是一部可閱讀的漫畫；只有前端折疊出的虛擬資料夾
// 才是純導航項目。分開辨識，避免根目錄的散圖被誤標成「目錄」。
function isReadableImageFolder(comic) {
  return Boolean(comic && !comic.isDirectory && (
    comic.type === 'folder' || comic.type === 'external-folder'
  ));
}

// 圖片漫畫的子目錄尚未掃完時不能推定它是葉節點；確認淺掃完成後，
// 才隱藏會把人帶進空書架的重複導航入口。
function getLeafReadableImageFolderPaths(requireScanComplete = true) {
  const readablePaths = new Set();
  const pathsWithChildren = new Set();
  const markParents = (path, sourceId = '') => {
    let parent = getParentPath(path);
    while (parent) {
      pathsWithChildren.add(getDirectoryLocationKey(sourceId, parent));
      parent = getParentPath(parent);
    }
  };
  state.comics.forEach(comic => {
    const path = typeof comic?.relativePath === 'string' ? comic.relativePath : '';
    if (!path) return;
    const sourceId = getFolderTreeSourceId(comic);
    if (isReadableImageFolder(comic)) readablePaths.add(getDirectoryLocationKey(sourceId, path));
    markParents(path, sourceId);
  });
  state.visibleDirectories.forEach((paths, key) => {
    if (!Array.isArray(paths)) return;
    let sourceId = '';
    const separator = typeof key === 'string' ? key.indexOf('\u0000') : -1;
    if (separator >= 0) {
      sourceId = key.slice(0, separator);
      if (sourceId === 'legacy') sourceId = '';
    }
    paths.forEach(path => markParents(path, sourceId));
  });
  return new Set([...readablePaths].filter(key => {
    const separator = key.indexOf('\u0000');
    const sourceId = separator >= 0 ? key.slice(0, separator) : '';
    const path = separator >= 0 ? key.slice(separator + 1) : key;
    const legacyScan = state.visibleDirectoryScanCompleted?.has(path);
    return !pathsWithChildren.has(key)
      && (!requireScanComplete
        || state.visibleDirectoryScanCompleted?.has(key)
        || state.visibleDirectoryScanCompleted?.has(getDirectoryLocationKey(sourceId, path))
        || legacyScan);
  }));
}

function isLooseImage(comic) {
  return Boolean(comic && !comic.isDirectory && (
    comic.type === 'image' || comic.type === 'external-image'
  ));
}

function builtInDemoPageUrls(comic) {
  const slug = String(comic?.demoSlug || comic?.id || '').replace(/^builtin:landscape-/, '');
  const pageCount = Math.max(1, Number(comic?.pageCount) || 1);
  return Array.from({ length: pageCount }, (_, index) => (
    `assets/demo/landscapes/${slug}/page-${String(index + 1).padStart(2, '0')}.png`
  ));
}

function createBuiltInDemoComic(group, demoOrder) {
  const pageCount = Math.max(1, Number(group.pageCount) || 1);
  return {
    id: `${BUILT_IN_DEMO_ID_PREFIX}${group.slug}`,
    type: 'built-in-demo',
    // 單層相對路徑讓目錄折疊器只在書架根目錄渲染示範卡。
    relativePath: group.slug,
    ext: '.demo',
    title: group.title,
    series: '風景選集',
    updatedAt: null,
    pageCount,
    demoSlug: group.slug,
    demoOrder,
    progress: { currentPage: 0, totalPages: pageCount, percent: 0, updatedAt: null },
    sourceId: BUILT_IN_DEMO_SOURCE_ID,
    isBuiltInDemo: true
  };
}

function createBuiltInDemoComics() {
  return BUILT_IN_DEMO_GROUPS.map((group, index) => createBuiltInDemoComic(group, index));
}

function builtInDemoReaderData(comic) {
  return {
    ...comic,
    pages: builtInDemoPageUrls(comic),
    isDir: false,
    filenames: []
  };
}

// 全域狀態管理
let state = {
  comics: [],
  filteredComics: [],
  currentComic: null,
  currentComicPages: [],
  currentPageIndex: 0,
  readingMode: 'single', // 'single', 'double', 'double-rtl', 'webtoon'
  // 雙頁配對相位：1 代表既有封面後的 2-3、4-5…；0 代表單頁錯開後的 3-4、5-6…。
  doublePairOffset: 1,
  zoomPercentage: 100,
  fitMode: readStoredSetting('readerFitMode') || 'contain', // 'contain', 'width', 'height'
  rotationAngle: 0, // 0, 90, 180, 270
  favorites: [],
  favoriteIds: new Set(),
  activeSeries: 'all',
  activeFilter: 'all',
  currentPath: '', // 目錄樹當前路徑 (姬米妮貼心追加 ✨)
  currentSourceId: '', // 目錄樹目前來源；空值代表 root 的合併檢視
  currentDirectory: { sourceId: '', relativePath: '' },
  expandedFolderPaths: new Set(['root']),
  selectedComicId: null,
  preloadedImages: new Map(), // 用來保存已預載的 Image 物件
  readerCacheWindowTimer: null,
  readerCacheWindowPage: null,
  readerCacheReadyPage: null,
  readerCacheWindowToken: 0,
  // 只有實際完成解碼／載入的頁面才能寫入閱讀進度；失敗頁面可明確重試。
  readerReadyPages: new Set(),
  readerFailedPages: new Set(),
  readerLastReadyPageIndex: null,
  readerReadyComicId: null,
  readerLoadTrackingActive: false,
  readerIdleTimer: null,
  readerDiscoveryHintSeen: readStoredSetting('gai:readerDiscoveryHintSeen') === 'true',
  readerContextMenuOpen: false,
  webtoonScrollFrame: null,
  webtoonAnchor: null,
  webtoonWindowStart: 0,
  webtoonWindowEnd: 0,
  webtoonPageHeights: [],
  webtoonMetricsViewportWidth: 0,
  webtoonMeasuredPageHeights: new Map(),
  // 條漫頁高只可在同一本漫畫內沿用；換到同頁數的另一部作品時也要失效。
  webtoonMetricsComicId: null,
  webtoonPagePrefixHeights: [],
  webtoonPendingPageHeights: new Map(),
  webtoonHeightUpdateFrame: null,
  webtoonNavigationOffset: 0,
  catalogWindowStart: 0,
  catalogWindowEnd: 0,
  catalogColumns: 0,
  catalogRowHeight: CATALOG_THUMB_HEIGHT + CATALOG_GRID_GAP,
  catalogControlOffset: CATALOG_CONTROLS_OFFSET_FALLBACK,
  comicsRevision: 0,
  readerReturnFocus: null,
  readerReturnComicFolder: null,
  readerReturnLibraryContext: null,
  libraryRefreshFocusSnapshot: null,
  scanStatusPollTimer: null,
  scanStatusPollWallclockTimer: null,
  scanStatus: null,
  visibleDirectoryGeneration: 0,
  visibleDirectories: new Map(),
  visibleDirectoryScanCompleted: new Set(),
  libraryRefreshPending: false,
  renderGeneration: 0,
  sharpenLevel: 0, // 0=關閉, 1=輕度, 2=中度, 3=強度
  cropEdges: readStoredSetting('readerCropEdges') === 'true',
  brightness: Number(readStoredSetting('readerBrightness')) || 100,
  aiAutoExplain: false,
  aiExplainCache: new Map(),
  aiExplainInFlight: false,
  aiExplainActiveRequest: null,
  aiExplainPendingPage: null,
  aiExplainPendingRequest: null,
  aiExplainTimer: null,
  loaderRefCount: 0, // 非阻塞狀態列是否正在顯示（0/1）
  loaderHideTimer: null,
  readerClosePromise: Promise.resolve(),
  readerOperation: 0,
  pendingComicId: null,
  dialogReturnFocus: null,
  libraryModal: null,
  libraryModalBackgroundSnapshot: null,
  aiSessionStatus: null,
  aiSessionSwitchPending: false,
  aiSessionRevocationFailed: false,
  aiSessionSwitchGeneration: 0,
  aiSessionMutationPending: false,
  aiSessionMutationKind: null,
  aiSessionMutationGeneration: 0,
  aiProviderCommitted: null,
  organizeMode: false,
  organizeSelection: new Set(),
  lastUndoToken: null,
  lastTagUndoToken: null,
  tagInventoryItems: [],
  selectedTagId: null,
  organizerPanel: 'tags',
  lastFileUndoToken: null,
  catalogSearchIds: null,
  catalogSearchItems: new Map(),
  catalogSearchTotal: 0,
  catalogSearchRequest: 0,
  renderLimit: 200,
  libraryPanelsNarrow: false,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
};

function setFavorites(favorites) {
  state.favorites = Array.isArray(favorites) ? favorites : [];
  state.favoriteIds = new Set(state.favorites);
  requestPriorityLibraryScan(state.scanStatus, state.favorites);
  return state.favorites;
}

function isFavoriteId(comicId) {
  return state.favoriteIds.has(comicId);
}

// 全庫掃描時，讓 native scanner 優先補齊收藏與最近閱讀項目。這是獨立的
// fire-and-forget 提示，不等待磁碟工作，也不會取消或重啟目前的掃描。
function requestPriorityLibraryScan(status = state.scanStatus, favorites = state.favorites) {
  if (!eAPI?.isElectron || typeof eAPI.scanPriorityLibrary !== 'function' || !status?.isScanning) {
    return false;
  }
  const generation = Number(status.generation);
  if (!Number.isSafeInteger(generation) || generation <= 0) return false;

  const seen = new Set();
  const favoriteIds = [];
  for (const id of Array.isArray(favorites) ? favorites : []) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    favoriteIds.push(id);
    if (favoriteIds.length >= MAX_PRIORITY_LIBRARY_IDS) break;
  }
  const key = JSON.stringify([generation, favoriteIds]);
  if (key === lastPriorityLibraryScanKey) return false;
  lastPriorityLibraryScanKey = key;

  Promise.resolve()
    .then(() => eAPI.scanPriorityLibrary(favoriteIds))
    .catch(error => {
      if (lastPriorityLibraryScanKey === key) lastPriorityLibraryScanKey = '';
      console.warn('[優先掃描] 無法提交收藏清單：', error);
    });
  return true;
}

const THEME_STORAGE_KEY = 'gai:theme';
const THEMES = new Set(['midnight', 'sakura', 'ink', 'aurora']);
const LIBRARY_CARD_SIZE_STORAGE_KEY = 'gai:libraryCardSize';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'gai:sidebarCollapsed';
const INSPECTOR_COLLAPSED_STORAGE_KEY = 'gai:inspectorCollapsed';
const LIBRARY_CARD_SIZE_DEFAULT = 150;
const LIBRARY_CARD_SIZE_MIN = 120;
const LIBRARY_CARD_SIZE_MAX = 240;
const THEME_COLORS = {
  midnight: '#140508',
  sakura: '#050506',
  ink: '#03140d',
  aurora: '#161004'
};

// 元素選取器
const elements = {
  mainLayout: document.querySelector('.main-layout'),
  librarySidebar: document.getElementById('library-sidebar'),
  sidebarCollapseBtn: document.getElementById('sidebar-collapse-btn'),
  inspectorCollapseBtn: document.getElementById('inspector-collapse-btn'),
  libraryPanelScrim: document.getElementById('library-panel-scrim'),
  libraryUpBtn: document.getElementById('library-up-btn'),
  visibleScanStatus: document.getElementById('visible-scan-status'),
  libraryWorkspace: document.querySelector('.library-workspace'),
  comicGrid: document.getElementById('comic-grid'),
  contentArea: document.querySelector('.content-area'),
  emptyState: document.getElementById('empty-state'),
  searchInput: document.getElementById('search-input'),
  clearSearchBtn: document.getElementById('clear-search-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  libraryPathLabel: document.getElementById('library-path-label'),
  libraryStartPanel: document.getElementById('library-start-panel'),
  libraryStartChoose: document.getElementById('library-start-choose'),
  libraryStartDemo: document.getElementById('library-start-demo'),
  libraryDiscoveryBtn: document.getElementById('library-discovery-btn'),
  libraryDiscoveryStatus: document.getElementById('library-discovery-status'),
  libraryTagDiscoveryBtn: document.getElementById('library-tag-discovery-btn'),
  libraryTagDiscoveryPanel: document.getElementById('library-tag-discovery-panel'),
  discoveryTagSelect: document.getElementById('library-discovery-tag'),
  discoveryTagPick: document.getElementById('library-discovery-tag-pick'),
  discoveryTagRandom: document.getElementById('library-discovery-tag-random'),
  discoveryTagSetup: document.getElementById('library-discovery-tag-setup'),
  discoveryTagStatus: document.getElementById('library-discovery-tag-status'),
  scanRecoveryPanel: document.getElementById('scan-recovery-panel'),
  scanRecoveryMessage: document.getElementById('scan-recovery-message'),
  scanRetryBtn: document.getElementById('scan-retry-btn'),
  scanSourceBtn: document.getElementById('scan-source-btn'),
  continuePanel: document.getElementById('continue-panel'),
  continueStrip: document.getElementById('continue-strip'),
  comicInspector: document.getElementById('comic-inspector'),
  organizeBar: document.getElementById('organize-bar'),
  organizeCount: document.getElementById('organize-count'),
  organizeImpactSummary: document.getElementById('organize-impact-summary'),
  organizeSelectVisible: document.getElementById('organize-select-visible'),
  organizeClear: document.getElementById('organize-clear'),
  organizeTag: document.getElementById('organize-tag'),
  organizeAuthor: document.getElementById('organize-author'),
  organizeSeries: document.getElementById('organize-series'),
  organizeLanguage: document.getElementById('organize-language'),
  organizeDirection: document.getElementById('organize-direction'),
  organizeApply: document.getElementById('organize-apply'),
  organizeExcludeTag: document.getElementById('organize-exclude-tag'),
  organizeFolderRule: document.getElementById('organize-folder-rule'),
  organizeReimport: document.getElementById('organize-reimport'),
  organizeUndo: document.getElementById('organize-undo'),
  organizeStatus: document.getElementById('organize-status'),
  organizeInbox: document.getElementById('organize-inbox'),
  organizeDuplicates: document.getElementById('organize-duplicates'),
  organizeAlias: document.getElementById('organize-alias'),
  organizeCanonical: document.getElementById('organize-canonical'),
  organizeSaveAlias: document.getElementById('organize-save-alias'),
  organizeInsightResults: document.getElementById('organize-insight-results'),
  organizeTabs: [...document.querySelectorAll('[data-organize-panel]')],
  organizePanels: [...document.querySelectorAll('[data-organize-panel-content]')],
  tagLibrarySearch: document.getElementById('tag-library-search'),
  tagLibraryRefresh: document.getElementById('tag-library-refresh'),
  tagLibraryList: document.getElementById('tag-library-list'),
  tagLibraryEditor: document.getElementById('tag-library-editor'),
  tagEditorName: document.getElementById('tag-editor-name'),
  tagEditorCount: document.getElementById('tag-editor-count'),
  tagEditorDisplay: document.getElementById('tag-editor-display'),
  tagEditorTarget: document.getElementById('tag-editor-target'),
  tagEditorColor: document.getElementById('tag-editor-color'),
  tagEditorPinned: document.getElementById('tag-editor-pinned'),
  tagEditorMerge: document.getElementById('tag-editor-merge'),
  tagEditorDisable: document.getElementById('tag-editor-disable'),
  tagEditorUndo: document.getElementById('tag-editor-undo'),
  catalogFacets: document.getElementById('catalog-facets'),
  catalogLoadMore: document.getElementById('catalog-load-more'),
  seriesFilterList: document.getElementById('series-filter-list'),
  folderTreeCurrentPath: document.getElementById('folder-tree-current-path'),
  folderTreeCurrentPathValue: document.querySelector('.folder-tree-current-path-value'),
  totalCountBadge: document.getElementById('total-count-badge'),
  seriesFilterSelect: document.getElementById('series-filter-select'),

  // 統計元素
  statsTotal: document.getElementById('stats-total'),
  statsReading: document.getElementById('stats-reading'),
  statsCompleted: document.getElementById('stats-completed'),

  // 閱讀器相關元素
  readerOverlay: document.getElementById('reader-overlay'),
  readerTopBar: document.getElementById('reader-top-bar'),
  readerBottomBar: document.getElementById('reader-bottom-bar'),
  readerComicTitle: document.getElementById('reader-comic-title'),
  readerModeIndicator: document.getElementById('reader-mode-indicator'),
  readerViewport: document.getElementById('reader-viewport'),
  pagesContainer: document.getElementById('pages-container'),
  readerStatusPanel: document.getElementById('reader-status-panel'),
  pageCounter: document.getElementById('page-counter'),
  progressSlider: document.getElementById('progress-slider'),
  prevZone: document.getElementById('prev-zone'),
  nextZone: document.getElementById('next-zone'),

  // 模式與控制按鈕
  btnModeSingle: document.getElementById('btn-mode-single'),
  doubleModeControls: document.getElementById('double-mode-controls'),
  btnModeDouble: document.getElementById('btn-mode-double'),
  btnDoubleDirection: document.getElementById('btn-double-direction'),
  btnDoubleShift: document.getElementById('btn-double-shift'),
  btnModeWebtoon: document.getElementById('btn-mode-webtoon'),
  btnModeCatalog: document.getElementById('btn-mode-catalog'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  zoomValue: document.getElementById('zoom-value'),
  btnFitMode: document.getElementById('btn-fit-mode'),
  btnRotateLeft: document.getElementById('btn-rotate-left'),
  btnRotateRight: document.getElementById('btn-rotate-right'),
  btnSharpen: document.getElementById('btn-sharpen'),
  btnCrop: document.getElementById('btn-crop'),
  btnBrightness: document.getElementById('btn-brightness'),
  btnAiExplain: document.getElementById('btn-ai-explain'),
  btnAiAutoExplain: document.getElementById('btn-ai-auto-explain'),
  aiPagePanel: document.getElementById('ai-page-panel'),
  aiPageResult: document.getElementById('ai-page-result'),
  aiPageClose: document.getElementById('ai-page-close'),
  btnFullscreen: document.getElementById('btn-fullscreen'),
  readerBackBtn: document.getElementById('reader-back-btn'),
  readerContextMenu: document.getElementById('reader-context-menu'),
  readerDiscoveryHint: document.getElementById('reader-discovery-hint'),

  // 目前頁面解碼狀態
  statusLoading: document.getElementById('status-loading'),

  // 載入遮罩
  loaderMask: document.getElementById('loader-mask'),
  loaderText: document.getElementById('loader-text'),
  loaderProgress: document.getElementById('loader-progress'),
  loaderProgressBar: document.getElementById('loader-progress-bar'),
  loaderProgressLabel: document.getElementById('loader-progress-label'),

  // 設定相關元素
  settingsBtn: document.getElementById('settings-btn'),
  settingsModal: document.getElementById('settings-modal'),
  closeSettingsBtn: document.getElementById('close-settings-btn'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  scanDirInput: document.getElementById('scan-dir-input'),
  scanDirStatus: document.getElementById('scan-dir-status'),
  scanPathRow: document.getElementById('scan-path-row'),
  librarySourceLabel: document.getElementById('library-source-label'),
  librarySourceBtn: document.getElementById('library-source-btn'),
  savePathBtn: document.getElementById('save-path-btn'),
  fallbackFolderBrowser: document.getElementById('fallback-folder-browser'),
  folderBreadcrumbs: document.getElementById('folder-breadcrumbs'),
  browserCurrentPath: document.getElementById('browser-current-path'),
  browserUpBtn: document.getElementById('browser-up-btn'),
  browserFoldersList: document.getElementById('browser-folders-list'),
  themePicker: document.getElementById('theme-picker'),
  libraryCardSize: document.getElementById('library-card-size'),
  libraryCardSizeValue: document.getElementById('library-card-size-value'),
  catalogExportBtn: document.getElementById('catalog-export-btn'),
  catalogImportInput: document.getElementById('catalog-import-input'),
  catalogImportPreview: document.getElementById('catalog-import-preview'),
  aiProvider: document.getElementById('ai-provider'),
  aiApiKey: document.getElementById('ai-api-key'),
  aiRememberKey: document.getElementById('ai-remember-key'),
  aiGoogleDisclosureWrap: document.getElementById('ai-google-disclosure-wrap') || document.getElementById('ai-third-party-disclosure-wrap'),
  aiGoogleDisclosure: document.getElementById('ai-google-disclosure'),
  aiSaveBtn: document.getElementById('ai-save-btn'),
  aiRestoreBtn: document.getElementById('ai-restore-btn'),
  aiTestBtn: document.getElementById('ai-test-btn'),
  aiClearBtn: document.getElementById('ai-clear-btn'),
  aiSessionStatus: document.getElementById('ai-session-status'),

  // SMB 設定元素
  smbSetupBtn: document.getElementById('smb-setup-btn'),
  smbModal: document.getElementById('smb-modal'),
  closeSmbBtn: document.getElementById('close-smb-btn'),
  smbHost: document.getElementById('smb-host'),
  smbShare: document.getElementById('smb-share'),
  smbUser: document.getElementById('smb-user'),
  smbPass: document.getElementById('smb-pass'),
  smbClearBtn: document.getElementById('smb-clear-btn'),
  smbConnectBtn: document.getElementById('smb-connect-btn'),
};

// ==========================================================================
// 🛠️ 初始化與事件綁定
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(readStoredSetting(THEME_STORAGE_KEY) || 'midnight', { persist: false });
  applyLibraryCardSize(readStoredSetting(LIBRARY_CARD_SIZE_STORAGE_KEY), { persist: false });
  syncLibraryPanelsForViewport({ initial: true });
  renderReadingProgressRecovery();
  initApp().catch(error => {
    console.error('漫畫庫初始化失敗：', error);
    hideLoader();
    setScanRecoveryVisible(true, readerText('漫畫庫暫時無法載入，請按「重試掃描」。'));
  });
  bindEvents();
});

function readStoredSetting(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function isNarrowLibraryViewport() {
  const width = Number(window.innerWidth) || document.documentElement.clientWidth || 1024;
  return width <= 1100;
}

function setLibraryPanelAvailability(panel, isOpen) {
  if (!panel) return;
  const supportsNativeInert = 'inert' in panel;
  if (supportsNativeInert) panel.inert = !isOpen;
  // iOS 14 的 WKWebView 尚無原生 inert；hidden fallback 同時移除焦點與可見內容。
  panel.hidden = !supportsNativeInert && !isOpen;
  panel.setAttribute('aria-hidden', String(!isOpen));
}

function moveFocusBeforeLibraryPanelClose(panel, fallback) {
  if (panel?.contains(document.activeElement)) {
    fallback?.focus({ preventScroll: true });
  }
}

function syncLibraryPanelScrim() {
  const scrim = elements.libraryPanelScrim;
  if (!scrim) return;
  const visible = state.libraryPanelsNarrow && (!state.sidebarCollapsed || !state.inspectorCollapsed);
  scrim.hidden = !visible;
  // The narrow drawer is non-modal. The visual layer does not accept taps,
  // so it must not become an invisible keyboard stop either.
  scrim.setAttribute('aria-hidden', 'true');
  scrim.tabIndex = -1;
}

function closeLibraryPanelScrim() {
  if (!state.libraryPanelsNarrow) return;
  if (!state.sidebarCollapsed) {
    applySidebarCollapsed(true, { persist: false });
    elements.sidebarCollapseBtn?.focus({ preventScroll: true });
  } else if (!state.inspectorCollapsed) {
    applyInspectorCollapsed(true, { persist: false });
    elements.inspectorCollapseBtn?.focus({ preventScroll: true });
  }
}

function handleLibraryPanelKeyDown(event) {
  if (event.key !== 'Escape' || elements.readerOverlay?.style.display !== 'none') return;
  const scrim = elements.libraryPanelScrim;
  if (!scrim || scrim.hidden) return;
  event.preventDefault();
  closeLibraryPanelScrim();
}

function applySidebarCollapsed(collapsed, { persist = true, exclusive = true } = {}) {
  const isCollapsed = Boolean(collapsed);
  const isNarrow = state.libraryPanelsNarrow || isNarrowLibraryViewport();
  state.sidebarCollapsed = isCollapsed;
  elements.mainLayout?.classList.toggle('sidebar-collapsed', isCollapsed);
  if (isCollapsed) moveFocusBeforeLibraryPanelClose(elements.librarySidebar, elements.sidebarCollapseBtn);
  setLibraryPanelAvailability(elements.librarySidebar, !isCollapsed);
  if (elements.sidebarCollapseBtn) {
    elements.sidebarCollapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
    const label = readerText(isCollapsed ? '展開漫畫資料夾側欄' : '收合漫畫資料夾側欄');
    elements.sidebarCollapseBtn.setAttribute('aria-label', label);
    elements.sidebarCollapseBtn.title = label;
    const icon = elements.sidebarCollapseBtn.querySelector('i');
    if (icon) icon.className = `fa-solid fa-chevron-${isCollapsed ? 'right' : 'left'}`;
  }
  if (isNarrow && !isCollapsed && exclusive) {
    applyInspectorCollapsed(true, { persist: false, exclusive: false });
  }
  if (persist && !isNarrow) localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
  syncLibraryPanelScrim();
}

function applyInspectorCollapsed(collapsed, { persist = true, exclusive = true } = {}) {
  const isCollapsed = Boolean(collapsed);
  const isNarrow = state.libraryPanelsNarrow || isNarrowLibraryViewport();
  state.inspectorCollapsed = isCollapsed;
  elements.mainLayout?.classList.toggle('inspector-collapsed', isCollapsed);
  elements.libraryWorkspace?.classList.toggle('inspector-collapsed', isCollapsed);
  if (isCollapsed) moveFocusBeforeLibraryPanelClose(elements.comicInspector, elements.inspectorCollapseBtn);
  setLibraryPanelAvailability(elements.comicInspector, !isCollapsed);
  if (elements.inspectorCollapseBtn) {
    elements.inspectorCollapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
    const label = readerText(isCollapsed ? '展開漫畫詳情側欄' : '收合漫畫詳情側欄');
    elements.inspectorCollapseBtn.setAttribute('aria-label', label);
    elements.inspectorCollapseBtn.title = label;
    const icon = elements.inspectorCollapseBtn.querySelector('i');
    if (icon) icon.className = `fa-solid fa-chevron-${isCollapsed ? 'left' : 'right'}`;
  }
  if (isNarrow && !isCollapsed && exclusive) {
    applySidebarCollapsed(true, { persist: false, exclusive: false });
  }
  if (persist && !isNarrow) localStorage.setItem(INSPECTOR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
  syncLibraryPanelScrim();
}

function syncLibraryPanelsForViewport({ initial = false } = {}) {
  const nextIsNarrow = isNarrowLibraryViewport();
  const previousIsNarrow = state.libraryPanelsNarrow;
  state.libraryPanelsNarrow = nextIsNarrow;
  elements.mainLayout?.classList.toggle('library-panels-narrow', nextIsNarrow);

  if (!initial && previousIsNarrow === nextIsNarrow) {
    syncLibraryPanelScrim();
    return;
  }

  if (nextIsNarrow) {
    // 窄屏每次初始或由寬轉窄都從雙側關閉開始，避免抽屜遮住使用中的書架。
    applySidebarCollapsed(true, { persist: false, exclusive: false });
    applyInspectorCollapsed(true, { persist: false, exclusive: false });
    syncLibraryPanelScrim();
    return;
  }

  // 回到寬畫面時恢復各自最後一次的桌面偏好，不觸發書架重繪或封面載入。
  applySidebarCollapsed(readStoredSetting(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true', { persist: false, exclusive: false });
  applyInspectorCollapsed(readStoredSetting(INSPECTOR_COLLAPSED_STORAGE_KEY) === 'true', { persist: false, exclusive: false });
  syncLibraryPanelScrim();
}

function scheduleLibraryPanelSync() {
  if (state.libraryPanelSyncFrame) return;
  const run = () => {
    state.libraryPanelSyncFrame = null;
    syncLibraryPanelsForViewport();
  };
  state.libraryPanelSyncFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 0);
}

function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = THEMES.has(theme) ? theme : 'midnight';
  document.documentElement.dataset.theme = nextTheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[nextTheme]);

  elements.themePicker?.querySelectorAll('[data-theme-option]').forEach(button => {
    const selected = button.dataset.themeOption === nextTheme;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-checked', String(selected));
  });

  if (persist) localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
}

function normalizeLibraryCardSize(value) {
  if (value === null || value === undefined || value === '') return LIBRARY_CARD_SIZE_DEFAULT;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return LIBRARY_CARD_SIZE_DEFAULT;
  const steppedValue = Math.round(numericValue / 10) * 10;
  return Math.min(LIBRARY_CARD_SIZE_MAX, Math.max(LIBRARY_CARD_SIZE_MIN, steppedValue));
}

function libraryCardSizeLabel(size) {
  if (size <= 130) return readerText('緊湊');
  if (size >= 210) return readerText('特大');
  if (size >= 180) return readerText('放大');
  return readerText('標準');
}

function applyLibraryCardSize(value, { persist = true } = {}) {
  const size = normalizeLibraryCardSize(value);
  document.documentElement.style.setProperty('--library-card-min-width', `${size}px`);
  if (elements.libraryCardSize) {
    elements.libraryCardSize.value = String(size);
    elements.libraryCardSize.setAttribute('aria-valuetext', `${libraryCardSizeLabel(size)}，${size} px`);
  }
  if (elements.libraryCardSizeValue) {
    elements.libraryCardSizeValue.value = `${libraryCardSizeLabel(size)} · ${size} px`;
    elements.libraryCardSizeValue.textContent = elements.libraryCardSizeValue.value;
  }
  if (persist) localStorage.setItem(LIBRARY_CARD_SIZE_STORAGE_KEY, String(size));
}

// 初始化載入
async function initApp() {
  document.getElementById('zoom-value').textContent = '100%';
  sanitizeSmbConfig();

  // 僅在具備原生照片儲存能力的 iOS 環境顯示匯入入口
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && typeof eAPI.saveImportedPhoto === 'function') {
    // if (elements.settingsBtn) elements.settingsBtn.style.display = 'none';
    const importBtn = document.getElementById('import-photo-btn');
    if (importBtn) importBtn.style.display = 'inline-block';

    const tip = document.querySelector('.sidebar-footer p');
    if (tip) tip.innerHTML = readerText('小提示：點一下卡片查看詳情，再按「開始閱讀」；再次點同一卡片也能閱讀；也可以用上方「匯入圖片」加入內容。✨');
    const emptyTip = document.getElementById('empty-library-hint');
    if (emptyTip) emptyTip.innerHTML = readerText('請點擊上方的「匯入圖片」按鈕，或透過檔案 App 匯入漫畫！✨');
  }

  // 開始第一波撈取
  showLoader(readerText('正在載入漫畫…'), { progress: null, detail: readerText('請稍候...') });
  if (eAPI && eAPI.getFavorites) {
    try { setFavorites(await eAPI.getFavorites()); } catch(e) {}
  }
  const savedScanDir = readStoredSetting('gai:scanDir');
  if (savedScanDir) {
    try {
      const restored = await eAPI.setConfig({ scanDir: savedScanDir });
      if (restored?.scanDir) {
        try { localStorage.setItem('gai:scanDir', restored.scanDir); } catch (_) { /* Native config remains authoritative. */ }
      }
    } catch(e) {
      try { localStorage.removeItem('gai:scanDir'); } catch (_) { /* Continue with native settings. */ }
      console.warn('已清除無效的舊漫畫目錄設定：', e);
    }
  }

  // 載入外部書籤；和新增／刪除共用 queue，避免初始化 restore 覆蓋
  // 使用者在另一個 UI 事件中剛提交的最新清單。
  if (eAPI.setBookmarks) {
    try {
      await restoreExternalBookmarks();
    } catch (error) {
      console.error('恢復外部資料夾失敗：', error);
      alert(readerText('部分外部資料夾權限無法恢復，請在設定中重新加入：\n{error}', { error }));
    }
  }
  await fetchLibrary();
}

// 綁定所有點擊與輸入事件
function classifyBookmarkUpdateError(error) {
  const message = error && error.message ? error.message : String(error);
  return {
    message,
    stateWasUpdated: /清單已更新|狀態已更新|設定已更新|BOOKMARKS_UPDATED|PARTIAL_SUCCESS/i.test(message)
  };
}

function readExternalBookmarks() {
  try {
    const bookmarks = JSON.parse(localStorage.getItem('gai:externalBookmarks') || '[]');
    return Array.isArray(bookmarks) ? bookmarks : [];
  } catch (error) {
    console.warn('外部資料夾清單格式無效，將重新建立：', error);
    return [];
  }
}

function sanitizeSmbConfig() {
  let rawConfig = null;
  try {
    rawConfig = localStorage.getItem('gai:smb');
  } catch (error) {
    try {
      localStorage.removeItem('gai:smb');
    } catch (removeError) {
      // Storage is unavailable; retry sanitization on the next App startup.
    }
    return {};
  }
  if (!rawConfig) return {};

  let stored = {};
  try {
    const parsed = JSON.parse(rawConfig);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch (error) {
    // Invalid legacy data is replaced with an empty safe config below.
  }
  const safeConfig = {
    host: typeof stored.host === 'string' ? stored.host : '',
    share: typeof stored.share === 'string' ? stored.share : '',
    username: typeof stored.username === 'string' ? stored.username : '',
  };
  try {
    localStorage.setItem('gai:smb', JSON.stringify(safeConfig));
  } catch (error) {
    try {
      localStorage.removeItem('gai:smb');
    } catch (removeError) {
      // Best effort: a storage backend may reject both writes and removal.
    }
    return {};
  }
  return safeConfig;
}

function enqueueExternalBookmarkMutation(operation) {
  const queued = externalBookmarkMutationQueue.then(operation, operation);
  // 保留目前操作的 rejection 給呼叫端，但讓後續 UI intent 繼續排程。
  externalBookmarkMutationQueue = queued.catch(() => {});
  return queued;
}

async function restoreExternalBookmarks() {
  if (!eAPI?.setBookmarks) return;
  await enqueueExternalBookmarkMutation(async () => {
    // 空清單也是有效的全量提交，用來清除 native process 內殘留的來源。
    await eAPI.setBookmarks(readExternalBookmarks());
  });
}

function isIOSLibraryDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function addIOSLibrarySource() {
  if (!window.electronAPI?.openExternalFolder) {
    throw new Error(readerText('本環境不支援 iOS 外部資料夾授權'));
  }

  let desiredBookmarks = null;
  let duplicateBookmark = false;
  let renamedBookmark = false;
  try {
    const result = await window.electronAPI.openExternalFolder();
    if (!result?.bookmark) return;

    await enqueueExternalBookmarkMutation(async () => {
      const bookmarks = readExternalBookmarks();
      const existingIndex = bookmarks.findIndex(bookmark => bookmark.bookmark === result.bookmark);
      if (existingIndex >= 0) {
        if (bookmarks[existingIndex].name === result.name) {
          duplicateBookmark = true;
          alert(readerText('這個資料夾已經加入了。'));
          return;
        }
        const renamedBookmarks = bookmarks.map((bookmark, index) => (
          index === existingIndex ? { ...bookmark, name: result.name } : bookmark
        ));
        desiredBookmarks = renamedBookmarks;
        renamedBookmark = true;
        await window.electronAPI.setBookmarks(renamedBookmarks);
        localStorage.setItem('gai:externalBookmarks', JSON.stringify(renamedBookmarks));
        return;
      }

      const nextBookmarks = [...bookmarks, { bookmark: result.bookmark, name: result.name }];
      desiredBookmarks = nextBookmarks;
      await window.electronAPI.setBookmarks(nextBookmarks);
      localStorage.setItem('gai:externalBookmarks', JSON.stringify(nextBookmarks));
    });
    if (duplicateBookmark) return;
    renderExternalBookmarks();
    if (renamedBookmark) return;
    if (elements.scanDirStatus) elements.scanDirStatus.textContent = readerText('已加入：{name}，正在重新掃描。', { name: result.name });
    showLoader(readerText('正在掃描新加入的漫畫來源...'), { progress: null, detail: readerText('掃描完成後會更新書架，期間仍可操作目前畫面') });
    startScanStatusPolling();
    scheduleLibraryRefresh(0);
  } catch (error) {
    console.error('加入 iOS 外部資料夾失敗：', error);
    const { message, stateWasUpdated } = classifyBookmarkUpdateError(error);
    if (stateWasUpdated && desiredBookmarks) {
      localStorage.setItem('gai:externalBookmarks', JSON.stringify(desiredBookmarks));
      renderExternalBookmarks();
      if (renamedBookmark) return;
      if (elements.scanDirStatus) {
        elements.scanDirStatus.textContent = readerText('外部資料夾已更新，但舊資料夾權限釋放部分失敗：{message}', { message });
      }
      showLoader(readerText('正在掃描新加入的漫畫來源...'), { progress: null, detail: readerText('掃描完成後會更新書架，期間仍可操作目前畫面') });
      startScanStatusPolling();
      scheduleLibraryRefresh(0);
      return;
    }
    throw new Error(message);
  }
}

async function chooseNativeLibrarySource() {
  const selectedPath = await window.electronAPI.openFolderDialog(elements.scanDirInput.value.trim());
  if (!selectedPath) {
    if (elements.scanDirStatus) elements.scanDirStatus.textContent = readerText('已取消選擇，漫畫來源沒有變更。');
    return;
  }

  elements.scanDirInput.value = selectedPath;
  if (elements.scanDirStatus) elements.scanDirStatus.textContent = readerText('已選擇：{path}', { path: selectedPath });
  await saveSettingsPath(selectedPath);
}

async function chooseLibrarySource() {
  if (!elements.librarySourceBtn) return;
  elements.librarySourceBtn.disabled = true;
  elements.librarySourceBtn.setAttribute('aria-busy', 'true');
  if (elements.scanDirStatus) elements.scanDirStatus.textContent = readerText('正在開啟系統檔案選擇器…');

  try {
    if (isIOSLibraryDevice() && typeof window.electronAPI?.openExternalFolder === 'function') {
      await addIOSLibrarySource();
    } else if (window.electronAPI?.isElectron && window.electronAPI.openFolderDialog) {
      await chooseNativeLibrarySource();
    } else if (elements.fallbackFolderBrowser) {
      elements.fallbackFolderBrowser.style.display = 'flex';
      await fetchBrowserFolders(elements.scanDirInput.value.trim());
    }
  } catch (error) {
    console.error('加入漫畫來源失敗：', error);
    if (elements.scanDirStatus) {
      elements.scanDirStatus.textContent = readerText('無法加入漫畫來源：{error}', { error: error?.message || error });
    }
  } finally {
    elements.librarySourceBtn.disabled = false;
    elements.librarySourceBtn.removeAttribute('aria-busy');
  }
}

function bindEvents() {
  window.addEventListener('gai:photo-library-changed', requestDeferredLibraryRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isIOSLibraryDevice()) {
      requestDeferredLibraryRefresh();
    }
  });
  elements.contentArea?.addEventListener('scroll', noteCatalogScroll, { passive: true });
  elements.sidebarCollapseBtn?.addEventListener('click', () => {
    applySidebarCollapsed(!state.sidebarCollapsed);
  });
  elements.inspectorCollapseBtn?.addEventListener('click', () => {
    applyInspectorCollapsed(!state.inspectorCollapsed);
  });
  elements.libraryUpBtn?.addEventListener('click', navigateLibraryUp);
  window.addEventListener('resize', scheduleLibraryPanelSync, { passive: true });
  syncLibraryUpButton();
  elements.libraryPanelScrim?.addEventListener('click', closeLibraryPanelScrim);

  elements.libraryStartChoose?.addEventListener('click', chooseLibrarySource);
  elements.libraryDiscoveryBtn?.addEventListener('click', () => openDiscoveryComic());
  elements.libraryTagDiscoveryBtn?.addEventListener('click', toggleDiscoveryTags);
  elements.discoveryTagPick?.addEventListener('click', () => openDiscoveryTag(false));
  elements.discoveryTagRandom?.addEventListener('click', () => openDiscoveryTag(true));
  elements.discoveryTagSetup?.addEventListener('click', () => {
    closeDiscoveryTags();
    setOrganizeMode(true);
    switchOrganizerPanel('batch');
    elements.organizeBar?.scrollIntoView({ block: 'nearest' });
    elements.organizeTag?.focus();
    updateOrganizerUi(readerText('先選取漫畫，再輸入標籤；例如 general:冒險，套用後就能依 TAG 探索。'));
  });
  elements.libraryStartDemo?.addEventListener('click', () => {
    const firstDemo = createBuiltInDemoComics()[0];
    if (!state.comics.some(comic => comic.id === firstDemo.id)) {
      state.comics = [...state.comics, firstDemo];
    }
    openReader(firstDemo.id);
  });
  elements.scanRetryBtn?.addEventListener('click', retryLibraryScan);
  elements.scanSourceBtn?.addEventListener('click', () => {
    openSettingsForRecovery().catch(error => console.warn('無法開啟來源設定：', error));
  });

  // 搜尋功能
  elements.searchInput.addEventListener('input', handleSearch);
  elements.clearSearchBtn.addEventListener('click', () => {
    elements.searchInput.value = '';
    elements.clearSearchBtn.style.display = 'none';
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = null;
    state.catalogSearchRequest++;
    state.catalogSearchIds = null;
    state.catalogSearchItems.clear();
    state.catalogSearchTotal = 0;
    renderCatalogFacets({});
    state.renderLimit = 200;
    filterAndRenderGrid();
  });

  bindOrganizerEvents();
  if (window.electronAPI?.onCatalogChanged) {
    window.electronAPI.onCatalogChanged(() => {
      if (!state.currentComic) scheduleLibraryRefresh();
    });
  }
  refreshAiSessionStatus();

  // 重新整理
  elements.refreshBtn.addEventListener('click', async () => {
    showLoader(readerText('正在重新掃描資料夾…'), { progress: null, detail: readerText('正在更新漫畫庫...') });
    if (eAPI.scanLibrary) {
      try { await eAPI.scanLibrary(); } catch(e) { console.error(e); }
      startScanStatusPolling();
      scheduleLibraryRefresh(0);
    } else {
      await fetchLibrary();
      hideLoader();
    }
  });

  // 相簿匯入
  const importBtn = document.getElementById('import-photo-btn');
  const importInput = document.getElementById('photo-import-input');
  let importBusy = false;
  let pendingPhotoImports = [];
  let retryPhotoImportBtn = null;
  if (importBtn && importInput) {
    const preparePhotoImportEntries = (selectedFiles, batchId = Date.now()) => {
      const prepared = Array.from(selectedFiles || []).map((entry, index) => {
        const file = entry?.file || entry;
        const filename = entry?.filename || `${batchId}_${index}_${file?.name || 'image.jpg'}`;
        return { file, filename };
      });
      prepared.forEach(({ file, filename }) => {
        const size = Number(file?.size);
        const filenameBytes = typeof TextEncoder === 'function'
          ? new TextEncoder().encode(filename).byteLength
          : encodeURIComponent(filename).replace(/%[0-9A-F]{2}/gi, 'x').length;
        if (!Number.isFinite(size) || size <= 0 || size > MAX_IMPORTED_PHOTO_BYTES) {
          throw new Error(readerText('匯入圖片必須介於 1 byte 與 64 MiB。'));
        }
        if (filenameBytes > 200) throw new Error(readerText('匯入檔名過長。'));
      });
      return prepared;
    };

    const updatePhotoImportRetry = () => {
      if (!pendingPhotoImports.length) {
        retryPhotoImportBtn?.remove();
        retryPhotoImportBtn = null;
        return;
      }
      if (!retryPhotoImportBtn) {
        retryPhotoImportBtn = document.createElement('button');
        retryPhotoImportBtn.type = 'button';
        retryPhotoImportBtn.className = 'modal-action-btn photo-import-retry-btn';
        retryPhotoImportBtn.addEventListener('click', () => {
          if (importBusy || !pendingPhotoImports.length) return;
          return processPhotoImport(pendingPhotoImports, { retry: true });
        });
        importBtn.parentElement?.appendChild(retryPhotoImportBtn);
      }
      retryPhotoImportBtn.textContent = readerText('重試未匯入的 {count} 張', { count: pendingPhotoImports.length });
      retryPhotoImportBtn.setAttribute('aria-label', retryPhotoImportBtn.textContent);
      retryPhotoImportBtn.hidden = false;
    };

    const processPhotoImport = async (selectedFiles, { retry = false } = {}) => {
      if (importBusy) return;
      const entries = Array.from(selectedFiles || []);
      if (!entries.length) return;
      let prepared;
      try {
        // Validate the complete selection and stable native filename before any
        // ArrayBuffer allocation or partial write.
        prepared = preparePhotoImportEntries(entries);
      } catch (error) {
        alert(readerText('匯入失敗：{error}', { error: error?.message || error }));
        console.error(error);
        return;
      }

      importBusy = true;
      importBtn.disabled = true;
      retryPhotoImportBtn?.setAttribute('disabled', 'true');
      importBtn.setAttribute('aria-busy', 'true');
      let committed = 0;
      let failed = 0;
      let scanError = null;
      let refreshError = null;
      const notCommitted = [];
      showLoader(readerText(retry ? '正在重試匯入 {count} 張圖片…' : '正在從相簿匯入 {count} 張圖片...', { count: prepared.length }), { progress: 0, detail: readerText('請勿關閉 App') });

      const finishImport = async () => {
        pendingPhotoImports = notCommitted;
        // 每筆檔案都會嘗試到結束；「未處理」只計算因流程中止而未嘗試的項目，
        // native 失敗另列為 failed，並由 pendingPhotoImports 提供手動重試。
        const pending = Math.max(0, prepared.length - committed - failed);
        showLoader(readerText('圖片匯入完成！正在整理書架...'), { progress: null, detail: readerText('馬上就好囉...') });
        if (typeof eAPI.scanLibrary === 'function') {
          try {
            await eAPI.scanLibrary();
          } catch (error) {
            scanError = error;
            console.error('匯入後掃描失敗：', error);
          }
        }
        try {
          await fetchLibrary();
        } catch (error) {
          refreshError = error;
          console.error('匯入後刷新書架失敗：', error);
        }
        if (scanError || refreshError) {
          setScanRecoveryVisible(true, readerText('漫畫來源暫時無法完成掃描，現有書架仍可使用。'));
        }
        updatePhotoImportRetry();
        const summary = readerText('匯入結果：成功 {success} 張，失敗 {failed} 張，未處理 {pending} 張。', {
          success: committed,
          failed,
          pending,
        });
        if (failed || scanError || refreshError) {
          alert(`${summary}\n${readerText('已成功寫入的圖片會保留；請按「重試未匯入的圖片」再次處理失敗項。')}`);
        } else {
          showReaderToast(summary);
        }
      };

      try {
        for (let index = 0; index < prepared.length; index += 1) {
          const { file, filename } = prepared[index];
          try {
            const arrayBuffer = await file.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);
            if (data.byteLength === 0 || data.byteLength > MAX_IMPORTED_PHOTO_BYTES) {
              throw new Error(readerText('匯入圖片必須介於 1 byte 與 64 MiB。'));
            }
            await eAPI.saveImportedPhoto(filename, data);
            committed += 1;
          } catch (error) {
            failed += 1;
            notCommitted.push({ file, filename, error });
            console.error('匯入單張圖片失敗：', error);
          }
          showLoader(readerText(retry ? '正在重試匯入 {count} 張圖片…' : '正在從相簿匯入 {count} 張圖片...', { count: prepared.length }), { progress: ((index + 1) / prepared.length) * 100, detail: readerText('正在匯入: {name}', { name: file.name }) });
        }
        await finishImport();
      } catch (error) {
        pendingPhotoImports = [];
        updatePhotoImportRetry();
        alert(readerText('匯入失敗：{error}', { error: error?.message || error }));
        console.error(error);
      } finally {
        hideLoader();
        importInput.value = '';
        importBusy = false;
        importBtn.disabled = false;
        retryPhotoImportBtn?.removeAttribute('disabled');
        importBtn.removeAttribute('aria-busy');
        updatePhotoImportRetry();
      }
    };

    importBtn.addEventListener('click', () => {
      if (importBusy) return;
      importInput.click();
    });

    importInput.addEventListener('change', (e) => {
      if (importBusy) return;
      const files = Array.from(e.target.files || []);
      if (!files || files.length === 0) return;
      try {
        const prepared = preparePhotoImportEntries(files);
        // The size/name preflight above happens before processPhotoImport starts
        // any ArrayBuffer allocation.
        return processPhotoImport(prepared);
      } catch (error) {
        alert(readerText('匯入失敗：{error}', { error: error?.message || error }));
        console.error(error);
        importInput.value = '';
        return Promise.resolve();
      }
    });
  }

  // 書架過濾器 (全部/閱讀中/未讀/已讀完)
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      applyLibraryFilter(e.currentTarget.dataset.filter);
    });
  });

  elements.seriesFilterSelect?.addEventListener('change', event => {
    selectSeries(event.currentTarget.value);
  });

  // 閱讀器頂部返回
  elements.readerBackBtn.addEventListener('click', closeReader);

  // 閱讀器翻頁按鈕
  elements.prevZone.addEventListener('click', (e) => {
    e.stopPropagation();
    goPreviousByReadingDirection();
  });
  elements.nextZone.addEventListener('click', (e) => {
    e.stopPropagation();
    goNextByReadingDirection();
  });
  // 閱讀模式切換
  elements.btnModeSingle.addEventListener('click', () => setReadingMode('single'));
  elements.btnModeDouble.addEventListener('click', () => {
    if (!isDoubleReadingMode()) setReadingMode('double');
  });
  elements.btnDoubleDirection?.addEventListener('click', toggleDoubleDirection);
  elements.btnDoubleShift?.addEventListener('click', advanceDoubleBySinglePage);
  elements.btnModeWebtoon.addEventListener('click', () => setReadingMode('webtoon'));
  elements.btnModeCatalog.addEventListener('click', () => setReadingMode('catalog'));

  // 縮放控制
  elements.btnZoomIn.addEventListener('click', () => adjustZoom(10));
  elements.btnZoomOut.addEventListener('click', () => adjustZoom(-10));

  // 螢幕適應模式切換
  elements.btnFitMode.addEventListener('click', toggleFitMode);

  // 旋轉控制
  elements.btnRotateLeft.addEventListener('click', () => rotateImage(-90));
  elements.btnRotateRight.addEventListener('click', () => rotateImage(90));

  // 🪄 銀利化切換
  elements.btnSharpen.addEventListener('click', toggleSharpen);
  elements.btnCrop.addEventListener('click', toggleCropEdges);
  elements.btnBrightness.addEventListener('click', cycleBrightness);

  // 全螢幕切換
  elements.btnFullscreen.addEventListener('click', toggleFullscreen);

  // 進度拉條滑動
  elements.progressSlider.addEventListener('input', (e) => {
    const targetPage = parseInt(e.target.value, 10) - 1;
    jumpToPage(targetPage);
  });

  // 監聽鍵盤快捷鍵
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keydown', handleLibraryPanelKeyDown);
  document.addEventListener('keydown', handleLibraryModalKeyDown);
  document.addEventListener('focusin', guardReaderFocus);
  document.addEventListener('focusin', guardLibraryModalFocus);
  elements.readerOverlay.addEventListener('keydown', trapReaderFocus);

  // 閱讀器滑鼠活動觸發顯示控制列，邊緣 12% 才觸發，靜止後自動隱藏
  elements.readerOverlay.addEventListener('mousemove', (e) => {
    // 觸控相容滑鼠事件與按住拖曳不能繞過下方的 tap/swipe 判定。
    if (e.buttons || readerTouchActive || e.sourceCapabilities?.firesTouchEvents) return;
    // WebKit 也可能先送出沒有 sourceCapabilities 的相容 mousemove。
    // 縮圖上方不能浮出工具列，否則後續 click 會改落到工具列。
    if (isCatalogThumbnailInteraction(e)) return;
    const y = e.clientY;
    const h = window.innerHeight;
    if (y < h * 0.12 || y > h * 0.88) {
      triggerControlsActive();
    }
  });

  let touchStartX = 0;
  let touchStartY = 0;
  let readerTouchMoved = false;
  let readerTouchActive = false;
  let readerTouchMulti = false;
  let readerTouchCancelled = false;
  let readerTouchClickHandled = false;
  let readerTouchResetTimer = null;
  let readerPointerActive = false;
  let readerPointerMoved = false;
  let readerPointerCancelled = false;
  let readerPointerStartX = 0;
  let readerPointerStartY = 0;

  const resetReaderTouchSession = () => {
    readerTouchActive = false;
    readerTouchMoved = false;
    readerTouchMulti = false;
    readerTouchCancelled = false;
    readerTouchClickHandled = false;
    readerTouchResetTimer = null;
  };
  const deferReaderTouchReset = () => {
    clearTimeout(readerTouchResetTimer);
    readerTouchResetTimer = window.setTimeout(resetReaderTouchSession, 350);
  };
  elements.readerViewport.addEventListener('touchstart', (e) => {
    dismissReaderDiscoveryHint();
    cancelWebtoonAnchorFromUserInput();
    clearTimeout(readerTouchResetTimer);
    const touch = e.changedTouches[0];
    readerTouchActive = true;
    readerTouchClickHandled = false;
    readerTouchMulti = e.touches?.length > 1 || e.changedTouches?.length !== 1;
    readerTouchCancelled = false;
    touchStartX = touch?.screenX ?? touch?.clientX ?? 0;
    touchStartY = touch?.screenY ?? touch?.clientY ?? 0;
    readerTouchMoved = false;
  }, { passive: true });
  elements.readerViewport.addEventListener('touchmove', (e) => {
    cancelWebtoonAnchorFromUserInput();
    if (!readerTouchActive) return;
    if (e.touches?.length > 1 || e.changedTouches?.length !== 1) {
      readerTouchMulti = true;
      readerTouchMoved = true;
      return;
    }
    const touch = e.changedTouches[0];
    const dx = (touch?.screenX ?? touch?.clientX ?? 0) - touchStartX;
    const dy = (touch?.screenY ?? touch?.clientY ?? 0) - touchStartY;
    if (Math.hypot(dx, dy) > 12) readerTouchMoved = true;
  }, { passive: true });
  elements.readerViewport.addEventListener('touchend', (e) => {
    if (!readerTouchActive) return;
    const touch = e.changedTouches[0];
    if (!touch || e.changedTouches?.length !== 1) readerTouchMulti = true;
    const dx = (touch?.screenX ?? touch?.clientX ?? 0) - touchStartX;
    const dy = (touch?.screenY ?? touch?.clientY ?? 0) - touchStartY;
    const horizontalPanAvailable = state.readingMode === 'single' && readerViewportCanScroll('x');
    if (!readerTouchCancelled && !readerTouchMulti && !horizontalPanAvailable && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      if (dx < 0) goNextByReadingDirection(); // 左滑下一頁
      else goPreviousByReadingDirection(); // 右滑上一頁
    }
    deferReaderTouchReset();
  }, { passive: true });
  elements.readerViewport.addEventListener('touchcancel', () => {
    if (!readerTouchActive) return;
    readerTouchCancelled = true;
    readerTouchMoved = true;
    deferReaderTouchReset();
  }, { passive: true });

  elements.readerViewport.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') dismissReaderDiscoveryHint();
    cancelWebtoonAnchorFromUserInput();
    if (event.pointerType === 'touch') return;
    readerPointerActive = true;
    readerPointerMoved = false;
    readerPointerCancelled = false;
    readerPointerStartX = event.clientX;
    readerPointerStartY = event.clientY;
  });
  elements.readerViewport.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || !readerPointerActive) return;
    cancelWebtoonAnchorFromUserInput();
    if (Math.hypot(event.clientX - readerPointerStartX, event.clientY - readerPointerStartY) > 12) {
      readerPointerMoved = true;
    }
  });

  elements.readerViewport.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') {
      const endX = event.screenX ?? event.clientX;
      const endY = event.screenY ?? event.clientY;
      if (Math.hypot(endX - touchStartX, endY - touchStartY) > 12) readerTouchMoved = true;
      if (readerTouchClickHandled || readerTouchMoved || readerTouchMulti || readerTouchCancelled) return;
      if (!readerTouchActive) return;
      readerTouchClickHandled = true;
    } else {
      if (!readerPointerActive) return;
      const moved = readerPointerMoved || readerPointerCancelled
        || Math.hypot(event.clientX - readerPointerStartX, event.clientY - readerPointerStartY) > 12;
      readerPointerActive = false;
      readerPointerMoved = false;
      readerPointerCancelled = false;
      if (moved) return;
    }
    handleReaderPointerClick(event);
    if (event.pointerType === 'touch') deferReaderTouchReset();
  });
  elements.readerViewport.addEventListener('pointercancel', event => {
    if (event.pointerType === 'touch') {
      readerTouchCancelled = true;
      readerTouchMoved = true;
      deferReaderTouchReset();
    } else {
      readerPointerCancelled = true;
      readerPointerActive = false;
    }
  });
  elements.readerOverlay.addEventListener('contextmenu', handleReaderContextMenu);
  elements.readerOverlay.addEventListener('auxclick', handleReaderAuxClick);
  document.addEventListener('click', (e) => {
    if (state.readerContextMenuOpen && !e.target.closest('#reader-context-menu')) {
      hideReaderContextMenu();
    }
  });

  elements.readerContextMenu?.querySelectorAll('button[data-reader-action]').forEach(btn => {
    btn.addEventListener('click', () => handleReaderContextAction(btn.dataset.readerAction));
  });

  elements.readerTopBar.addEventListener('mouseenter', () => {
    clearTimeout(state.readerIdleTimer);
  });
  elements.readerTopBar.addEventListener('mouseleave', () => {
    if (!elements.readerOverlay.classList.contains('reader-idle')) triggerControlsActive();
  });

  elements.readerBottomBar.addEventListener('mouseenter', () => {
    clearTimeout(state.readerIdleTimer);
  });
  elements.readerBottomBar.addEventListener('mouseleave', () => {
    if (!elements.readerOverlay.classList.contains('reader-idle')) triggerControlsActive();
  });

  // 滑鼠滾輪翻頁
  elements.readerViewport.addEventListener('wheel', handleWheelScroll, { passive: false });

  // 設定按鈕與視窗事件
  elements.settingsBtn.addEventListener('click', openSettingsModal);
  elements.closeSettingsBtn.addEventListener('click', closeSettingsModal);
  elements.saveSettingsBtn?.addEventListener('click', closeSettingsModal);
  elements.themePicker?.addEventListener('click', event => {
    const option = event.target.closest('[data-theme-option]');
    if (option) applyTheme(option.dataset.themeOption);
  });
  elements.libraryCardSize?.addEventListener('input', event => {
    applyLibraryCardSize(event.currentTarget.value);
  });
  elements.catalogExportBtn?.addEventListener('click', exportCatalogMetadataFile);
  elements.catalogImportInput?.addEventListener('change', previewCatalogMetadataFile);
  document.querySelector('.catalog-import-label')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements.catalogImportInput?.click();
    }
  });
  elements.aiProvider?.addEventListener('change', handleAiProviderChange);
  elements.aiGoogleDisclosure?.addEventListener('change', () => renderAiSessionStatus(state.aiSessionStatus));
  elements.aiSaveBtn?.addEventListener('click', saveAiSession);
  elements.aiRestoreBtn?.addEventListener('click', restoreAiSession);
  elements.aiTestBtn?.addEventListener('click', testAiSession);
  elements.aiClearBtn?.addEventListener('click', clearAiSession);
  elements.btnAiExplain?.addEventListener('click', explainCurrentPage);
  elements.btnAiAutoExplain?.addEventListener('click', toggleAutoPageExplanation);
  ['pointerdown', 'pointerup', 'click'].forEach(eventName => {
    elements.aiPagePanel?.addEventListener(eventName, event => event.stopPropagation());
  });
  elements.aiPageClose?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setAutoPageExplanation(false);
    setAiPagePanelVisible(false);
    elements.btnAiExplain?.focus({ preventScroll: true });
  });
  window.addEventListener('resize', handleReaderResize);
  document.addEventListener('fullscreenchange', scheduleReaderImageTransformRefresh);
  updateAiProviderDisclosure();

  if (elements.smbSetupBtn) elements.smbSetupBtn.addEventListener('click', openSmbModal);
  if (elements.librarySourceBtn) elements.librarySourceBtn.addEventListener('click', chooseLibrarySource);

  if (elements.closeSmbBtn) elements.closeSmbBtn.addEventListener('click', closeSmbModal);
  if (elements.smbConnectBtn) elements.smbConnectBtn.addEventListener('click', saveSmbConfig);
  if (elements.smbClearBtn) elements.smbClearBtn.addEventListener('click', clearSmbConfig);
  elements.savePathBtn.addEventListener('click', () => {
    const newPath = elements.scanDirInput.value.trim();
    if (newPath) {
      saveSettingsPath(newPath);
    } else if (elements.scanDirStatus) {
      elements.scanDirStatus.textContent = readerText('請先輸入或選擇漫畫資料夾。');
    }
  });
  elements.browserUpBtn.addEventListener('click', () => {
    if (state.browserParentPath) {
      fetchBrowserFolders(state.browserParentPath);
    }
  });

  // Electron 特有邏輯 (純 Electron 模式 — 無 HTTP server)
  if (window.electronAPI && window.electronAPI.isElectron) {
    if (elements.fallbackFolderBrowser) elements.fallbackFolderBrowser.style.display = 'none';
    if (configureSettingsSourceControls()) {
      if (elements.scanDirStatus) {
        elements.scanDirStatus.textContent = readerText('可選擇「檔案」中的本機、iCloud 或已連線 NAS 資料夾。');
      }
    }

    // 監聽漫畫庫目錄檔案異動並自動重新整理
    if (window.electronAPI.onLibraryChanged) {
      window.electronAPI.onLibraryChanged((payload) => {
        if (applyIncrementalLibraryBatch(payload)) return;
        if (state.currentComic) {
          console.log('[Watcher] 偵測到漫畫庫檔案異動，但因為主人正在看書，所以貼心地不打擾主人看書喔！');
          return;
        }
        console.log('[Watcher] 偵測到漫畫庫檔案異動，正在幫主人自動重新整理書架...');
        scheduleLibraryRefresh();
      });
    }

    if (window.electronAPI.onScanProgress) {
      window.electronAPI.onScanProgress((status) => {
        updateLoaderScanProgress(status);
      });
    }

    if (window.electronAPI.onRamCacheProgress) {
      window.electronAPI.onRamCacheProgress((data) => {
        const matchesCurrentPage = !Number.isSafeInteger(data.pageIndex)
          || data.pageIndex === state.currentPageIndex;
        if (state.currentComic && data.id === state.currentComic.id && matchesCurrentPage
          && data.generation >= state.currentComic.preloadGeneration) {
          state.currentComic.preloadGeneration = data.generation;
          if (data.error) console.warn('[RAM preload] 已改用逐頁讀取：', data.error);
          if (data.finished && !data.error) {
            state.readerCacheReadyPage = state.currentPageIndex;
            preloadNextPages();
          }
        }
      });
    }

    if (window.electronAPI.onSmbDownloadStart) {
      window.electronAPI.onSmbDownloadStart((data) => {
        showLoader(readerText('正在從 NAS 雲端下載漫畫...'), { progress: null, detail: readerText('網路傳輸中，請保持連線...') });
        // 🔧 BUG-FIX：30 秒安全鈵，如果 SMB 事件沒有回來，強制解除 Loader
        state._smbLoaderTimer = setTimeout(() => {
          console.warn('[SMB] 等待逾時（30 秒），強制關閉 Loader');
          forceHideLoader();
        }, 30000);
      });
    }

    if (window.electronAPI.onSmbDownloadEnd) {
      window.electronAPI.onSmbDownloadEnd((data) => {
        clearTimeout(state._smbLoaderTimer);
        state._smbLoaderTimer = null;
        hideLoader();
      });
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function tuneImageForLowPriority(img) {
  img.decoding = 'async';
  img.fetchPriority = 'low';
  return img;
}

function createReaderImage(src, priority = 'auto') {
  const img = document.createElement('img');
  img.decoding = 'async';
  img.fetchPriority = priority;
  img.src = src;
  img.style.transform = `scale(${state.zoomPercentage / 100}) rotate(${state.rotationAngle}deg)`;

  applyImageEffects(img);
  return img;
}

function takePreloadedReaderImage(pageIndex, priority = 'high') {
  const img = state.preloadedImages.get(pageIndex)
    || createReaderImage(state.currentComicPages[pageIndex], priority);
  state.preloadedImages.delete(pageIndex);
  img.decoding = 'async';
  img.fetchPriority = priority;
  applyImageEffects(img);
  applyReaderImageTransform(img);
  return img;
}

let readerTransformFrame = 0;

function normalizedRotationAngle() {
  return ((state.rotationAngle % 360) + 360) % 360;
}

function readerImageFitScale(img) {
  const angle = normalizedRotationAngle();
  if ((angle !== 90 && angle !== 270) || !img.naturalWidth || !img.naturalHeight) return 1;

  const containerStyle = getComputedStyle(elements.pagesContainer);
  const viewportStyle = getComputedStyle(elements.readerViewport);
  const viewportHorizontalPadding = parseFloat(viewportStyle.paddingLeft) + parseFloat(viewportStyle.paddingRight);
  const viewportVerticalPadding = parseFloat(viewportStyle.paddingTop) + parseFloat(viewportStyle.paddingBottom);
  const horizontalPadding = parseFloat(containerStyle.paddingLeft) + parseFloat(containerStyle.paddingRight);
  const verticalPadding = parseFloat(containerStyle.paddingTop) + parseFloat(containerStyle.paddingBottom);
  const visibleImages = Math.max(1, elements.pagesContainer.querySelectorAll('img').length);
  const pageSlots = state.readingMode === 'double' || state.readingMode === 'double-rtl' ? visibleImages : 1;
  const availableWidth = Math.max(1, (elements.readerViewport.clientWidth - viewportHorizontalPadding - horizontalPadding) / pageSlots);
  const availableHeight = Math.max(1, elements.readerViewport.clientHeight - viewportVerticalPadding - verticalPadding);
  const boxWidth = img.offsetWidth;
  const boxHeight = img.offsetHeight;
  if (!boxWidth || !boxHeight) return 1;

  const imageStyle = getComputedStyle(img);
  let contentWidth = boxWidth;
  let contentHeight = boxHeight;
  if (imageStyle.objectFit === 'contain') {
    const objectScale = Math.min(boxWidth / img.naturalWidth, boxHeight / img.naturalHeight);
    contentWidth = img.naturalWidth * objectScale;
    contentHeight = img.naturalHeight * objectScale;
  }

  const rotatedWidth = contentHeight;
  const rotatedHeight = contentWidth;
  if (state.fitMode === 'width') return availableWidth / rotatedWidth;
  if (state.fitMode === 'height') return availableHeight / rotatedHeight;
  return Math.min(availableWidth / rotatedWidth, availableHeight / rotatedHeight);
}

function applyReaderImageTransform(img) {
  if (!img || img.classList.contains('webtoon-img')) return;
  const zoomScale = state.zoomPercentage / 100;
  const layoutAwareSinglePage = state.readingMode === 'single';
  // 單頁直接放大承載容器，讓尺寸真正進入 scroll geometry；其他模式
  // 維持 transform，避免改變既有雙頁排版。
  const singlePageZoom = layoutAwareSinglePage ? `${state.zoomPercentage}%` : '100%';
  if (typeof elements.pagesContainer.style.setProperty === 'function') {
    elements.pagesContainer.style.setProperty('--single-page-zoom', singlePageZoom);
  } else {
    elements.pagesContainer.style['--single-page-zoom'] = singlePageZoom;
  }
  img.style.zoom = '';
  const fitScale = readerImageFitScale(img);
  const scale = Number.isFinite(fitScale) && fitScale > 0
    ? fitScale * (layoutAwareSinglePage ? 1 : zoomScale)
    : (layoutAwareSinglePage ? 1 : zoomScale);
  img.style.transform = `scale(${scale}) rotate(${state.rotationAngle}deg)`;
}

function refreshReaderImageTransforms() {
  elements.pagesContainer.querySelectorAll('img').forEach(applyReaderImageTransform);
  refreshWebtoonPageMetricsForResize();
  elements.readerOverlay.classList.toggle('single-page-pannable', readerViewportCanScroll());
}

function scheduleReaderImageTransformRefresh() {
  cancelAnimationFrame(readerTransformFrame);
  readerTransformFrame = requestAnimationFrame(refreshReaderImageTransforms);
  if (state.readingMode !== 'catalog') scheduleCatalogVirtualRender();
}

function replaceReaderImages(images) {
  elements.pagesContainer.innerHTML = '';
  images.filter(Boolean).forEach(img => elements.pagesContainer.appendChild(img));
  scheduleReaderImageTransformRefresh();
  scheduleAutoPageExplanation();
}

function readerImageIsReady(img) {
  return Boolean(img && img.complete && Number(img.naturalWidth) > 0);
}

async function decodeReaderImage(img) {
  await img.decode();
  if (!readerImageIsReady(img)) throw new Error('image decode did not produce a usable image');
  return img;
}

function clearReaderImageError() {
  elements.readerStatusPanel?.querySelectorAll?.('.reader-image-error').forEach(item => item.remove());
}

function showReaderImageError(pageIndexes) {
  clearReaderImageError();
  const host = elements.readerStatusPanel || elements.readerOverlay;
  if (!host) return;
  const indexes = [...new Set(pageIndexes)].filter(Number.isInteger);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reader-image-error';
  button.textContent = readerText('第 {pages} 頁載入失敗，請重試。', {
    pages: indexes.map(index => index + 1).join('、'),
  });
  button.setAttribute('aria-live', 'assertive');
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = readerText('正在重試…');
    retryReaderPages(indexes);
  });
  host.appendChild(button);
}

function markReaderPageReady(index, img, renderGeneration = state.renderGeneration) {
  if (renderGeneration !== state.renderGeneration || !state.currentComic || !readerImageIsReady(img)) return false;
  state.readerReadyComicId = state.currentComic.id;
  state.readerReadyPages.add(index);
  state.readerFailedPages.delete(index);
  if (state.currentPageIndex === index) {
    state.readerLastReadyPageIndex = index;
    saveReadingProgress();
  }
  return true;
}

function markReaderPageFailed(index, renderGeneration = state.renderGeneration) {
  if (renderGeneration !== state.renderGeneration || !state.currentComic) return false;
  state.readerFailedPages.add(index);
  state.readerReadyPages.delete(index);
  return true;
}

function retryReaderPages(pageIndexes) {
  const indexes = [...new Set(pageIndexes)].filter(Number.isInteger);
  indexes.forEach(index => state.readerFailedPages.delete(index));
  clearReaderImageError();
  // 重新繪製會重建目前模式的圖片；條漫 prefix 高度仍由既有 metrics
  // 保留，retry 不會插入影響前綴幾何的錯誤節點。
  renderPages();
}

function readerViewportCanScroll(axis) {
  const viewport = elements.readerViewport;
  if (!viewport || state.readingMode !== 'single') return false;
  if (axis === 'x') return Number(viewport.scrollWidth || 0) > Number(viewport.clientWidth || 0) + 1;
  if (axis === 'y') return Number(viewport.scrollHeight || 0) > Number(viewport.clientHeight || 0) + 1;
  return readerViewportCanScroll('x') || readerViewportCanScroll('y');
}

function imageFilterValue() {
  const sharpen = { 1: 'url(#sharpen-subtle)', 2: 'url(#sharpen-standard)', 3: 'url(#sharpen-strong)' }[state.sharpenLevel];
  return [sharpen, `brightness(${state.brightness}%)`].filter(Boolean).join(' ');
}

function applyImageEffects(img) {
  const renderingMap = { 1: 'auto', 2: '-webkit-optimize-contrast', 3: 'pixelated' };
  img.style.filter = imageFilterValue();
  img.style.imageRendering = renderingMap[state.sharpenLevel] || 'auto';
}

function shortPathLabel(pathValue) {
  if (!pathValue) return readerText('本機書庫');
  const normalized = String(pathValue).replaceAll('\\', '/');
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function applyLibraryFilter(filter) {
  state.activeFilter = filter || 'all';
  navigateLibraryToPath('', ''); // 切換狀態過濾時回到合併根目錄

  document.querySelectorAll('.filter-btn').forEach(btn => {
    const selected = btn.dataset.filter === state.activeFilter;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
}

// ==========================================================================
// 📚 書架核心 API 串接與渲染
// ==========================================================================

function bindOrganizerEvents() {
  elements.organizeTabs.forEach(tab => tab.addEventListener('click', () => switchOrganizerPanel(tab.dataset.organizePanel)));
  elements.tagLibraryRefresh?.addEventListener('click', refreshTagLibrary);
  let tagSearchTimer = null;
  elements.tagLibrarySearch?.addEventListener('input', () => {
    clearTimeout(tagSearchTimer);
    tagSearchTimer = setTimeout(refreshTagLibrary, 180);
  });
  elements.tagLibraryEditor?.addEventListener('submit', saveSelectedTag);
  elements.tagEditorMerge?.addEventListener('click', mergeSelectedTag);
  elements.tagEditorDisable?.addEventListener('click', toggleSelectedTagDisabled);
  elements.tagEditorUndo?.addEventListener('click', undoLastTagOperation);
  elements.organizeSelectVisible?.addEventListener('click', () => {
    state.filteredComics.filter(comic => !comic.isDirectory && !isPhotoAlbum(comic)).forEach(comic => state.organizeSelection.add(comic.id));
    updateOrganizerUi();
    renderGrid();
  });
  elements.organizeClear?.addEventListener('click', () => {
    state.organizeSelection.clear();
    updateOrganizerUi();
    renderGrid();
  });
  elements.organizeApply?.addEventListener('click', () => applyOrganizerBatch('include'));
  elements.organizeExcludeTag?.addEventListener('click', () => applyOrganizerBatch('exclude'));
  elements.organizeFolderRule?.addEventListener('click', applyFolderTagRule);
  elements.organizeReimport?.addEventListener('click', reimportSelectedMetadata);
  elements.organizeUndo?.addEventListener('click', undoOrganizerBatch);
  elements.organizeInbox?.addEventListener('click', showOrganizerInbox);
  elements.organizeDuplicates?.addEventListener('click', showDuplicateCandidates);
  elements.organizeSaveAlias?.addEventListener('click', saveOrganizerAlias);
  [elements.organizeTag, elements.organizeAuthor, elements.organizeSeries, elements.organizeLanguage, elements.organizeDirection]
    .filter(Boolean)
    .forEach(field => {
      field.addEventListener('input', () => updateOrganizerUi());
      field.addEventListener('change', () => updateOrganizerUi());
    });
  elements.catalogLoadMore?.addEventListener('click', () => {
    state.renderLimit += 200;
    const query = elements.searchInput.value.trim();
    if (query && state.catalogSearchIds && state.catalogSearchItems.size < state.catalogSearchTotal) refreshCatalogSearch(query, { append: true });
    else renderGrid();
  });
}

const TAG_NAMESPACE_COLORS = {
  artist: 'rose', group: 'amber', series: 'violet', parody: 'violet', type: 'blue',
  category: 'blue', language: 'cyan', character: 'fuchsia', female: 'fuchsia', male: 'blue',
  mixed: 'amber', other: 'slate', general: 'slate'
};

function tagColorKey(tag) {
  if (tag?.colorKey) return tag.colorKey;
  return TAG_NAMESPACE_COLORS[String(tag?.namespace || 'general').toLowerCase()] || 'slate';
}

function switchOrganizerPanel(panel) {
  state.organizerPanel = panel || 'tags';
  elements.organizeTabs.forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.organizePanel === state.organizerPanel)));
  elements.organizePanels.forEach(content => { content.hidden = content.dataset.organizePanelContent !== state.organizerPanel; });
  if (state.organizerPanel === 'tags') refreshTagLibrary();
}

async function refreshTagLibrary() {
  if (!state.organizeMode || !elements.tagLibraryList) return;
  if (!eAPI?.listTagInventory) {
    elements.tagLibraryList.innerHTML = `<p class="metadata-warning">${readerText('標籤庫需要最新版 Tauri 後端。')}</p>`;
    return;
  }
  elements.tagLibraryList.setAttribute('aria-busy', 'true');
  elements.tagLibraryList.innerHTML = `<p class="metadata-loading">${readerText('正在整理標籤庫…')}</p>`;
  try {
    const result = await eAPI.listTagInventory({ query: elements.tagLibrarySearch?.value.trim() || '', offset: 0, limit: 200 });
    state.tagInventoryItems = result.items || [];
    renderTagLibrary(result.total || 0);
  } catch (error) {
    elements.tagLibraryList.innerHTML = `<p class="metadata-warning">${readerText('標籤庫載入失敗：{error}', { error: escapeHtml(error?.message || String(error)) })}</p>`;
  } finally {
    elements.tagLibraryList.setAttribute('aria-busy', 'false');
  }
}

function renderTagLibrary(total = state.tagInventoryItems.length) {
  if (!elements.tagLibraryList) return;
  if (!state.tagInventoryItems.length) {
    elements.tagLibraryList.innerHTML = `<p class="metadata-loading">${readerText('沒有符合的標籤。可在「批次編輯」輸入自訂標籤後建立。')}</p>`;
    if (elements.tagLibraryEditor) elements.tagLibraryEditor.hidden = true;
    return;
  }
  elements.tagLibraryList.innerHTML = state.tagInventoryItems.map(tag => `
    <button type="button" class="tag-library-item" role="option" aria-selected="${tag.id === state.selectedTagId}" data-tag-id="${tag.id}" data-tag-color="${tagColorKey(tag)}" data-disabled="${tag.disabled}">
      <strong>${tag.pinned ? `<i class="fa-solid fa-thumbtack" aria-label="${readerText('已置頂')}"></i> ` : ''}${escapeHtml(tag.displayValue)}</strong>
      <span class="tag-count">${tag.workCount}</span>
      <small>${escapeHtml(tag.namespace)} · ${readerText('使用 {count} 次', { count: tag.usageCount })}${tag.disabled ? ` · ${readerText('已停用')}` : ''}</small>
      <small>${readerText('作品')}</small>
    </button>`).join('');
  elements.tagLibraryList.querySelectorAll('[data-tag-id]').forEach(button => {
    button.addEventListener('click', () => selectTag(Number(button.dataset.tagId)));
  });
  if (total > state.tagInventoryItems.length) {
    elements.tagLibraryList.insertAdjacentHTML('beforeend', `<p class="metadata-loading">${readerText('顯示前 {shown}／{total} 個；用搜尋縮小範圍。', { shown: state.tagInventoryItems.length, total })}</p>`);
  }
  if (state.selectedTagId && state.tagInventoryItems.some(tag => tag.id === state.selectedTagId)) selectTag(state.selectedTagId, false);
}

function selectTag(tagId, rerender = true) {
  const tag = state.tagInventoryItems.find(item => item.id === tagId);
  if (!tag || !elements.tagLibraryEditor) return;
  state.selectedTagId = tagId;
  if (rerender) {
    elements.tagLibraryList?.querySelectorAll('[data-tag-id]').forEach(button => button.setAttribute('aria-selected', String(Number(button.dataset.tagId) === tagId)));
  }
  elements.tagLibraryEditor.hidden = false;
  elements.tagEditorName.textContent = `${tag.namespace}:${tag.displayValue}`;
  elements.tagEditorCount.textContent = readerText('{count} 作品使用', { count: tag.workCount });
  elements.tagEditorDisplay.value = tag.displayValue;
  elements.tagEditorColor.value = tag.colorKey || '';
  elements.tagEditorPinned.checked = Boolean(tag.pinned);
  elements.tagEditorDisable.textContent = tag.disabled ? readerText('恢復標籤') : readerText('停用標籤');
  elements.tagEditorUndo.disabled = !state.lastTagUndoToken;
  elements.tagEditorTarget.innerHTML = `<option value="">${readerText('選擇目標標籤')}</option>` + state.tagInventoryItems
    .filter(item => item.id !== tagId && !item.disabled)
    .map(item => `<option value="${item.id}">${escapeHtml(item.namespace)}:${escapeHtml(item.displayValue)} · ${readerText('{count} 部', { count: item.workCount })}</option>`).join('');
}

async function saveSelectedTag(event) {
  event.preventDefault();
  const tag = state.tagInventoryItems.find(item => item.id === state.selectedTagId);
  if (!tag) return;
  try {
    const displayValue = elements.tagEditorDisplay.value.trim();
    if (displayValue && displayValue !== tag.displayValue) {
      const result = await eAPI.renameTag(tag.id, displayValue);
      state.lastTagUndoToken = result.undoToken;
    }
    await eAPI.updateTagState({ tagId: tag.id, pinned: elements.tagEditorPinned.checked, colorKey: elements.tagEditorColor.value || null });
    updateOrganizerUi(readerText('已更新 {tag} 的名稱與外觀。', { tag: `${tag.namespace}:${displayValue || tag.displayValue}` }));
    await refreshTagLibrary();
    const comic = state.comics.find(item => item.id === state.selectedComicId);
    if (comic) loadInspectorMetadata(comic);
  } catch (error) {
    updateOrganizerUi(readerText('標籤更新失敗：{error}', { error: error?.message || error }));
  }
}

async function mergeSelectedTag() {
  const source = state.tagInventoryItems.find(item => item.id === state.selectedTagId);
  const targetId = Number(elements.tagEditorTarget?.value || 0);
  if (!source || !targetId) return updateOrganizerUi(readerText('請先選擇合併目標。'));
  const target = state.tagInventoryItems.find(item => item.id === targetId);
  if (!window.confirm(readerText('合併預覽\n\n{source}（{count} 部作品）\n→ {target}\n\n原始來源資料不會刪除，完成後可撤銷。', {
    source: `${source.namespace}:${source.displayValue}`,
    count: source.workCount,
    target: `${target?.namespace || source.namespace}:${target?.displayValue || readerText('目標標籤')}`,
  }))) return;
  try {
    const result = await eAPI.mergeTags(source.id, targetId);
    state.lastTagUndoToken = result.undoToken;
    state.selectedTagId = targetId;
    updateOrganizerUi(readerText('已合併標籤，{count} 部作品會顯示目標標籤；原始來源證據仍保留。', { count: result.affectedWorks }));
    await refreshTagLibrary();
  } catch (error) {
    updateOrganizerUi(readerText('標籤合併失敗：{error}', { error: error?.message || error }));
  }
}

async function toggleSelectedTagDisabled() {
  const tag = state.tagInventoryItems.find(item => item.id === state.selectedTagId);
  if (!tag) return;
  try {
    const result = await eAPI.setTagDisabled(tag.id, !tag.disabled);
    state.lastTagUndoToken = result.undoToken;
    updateOrganizerUi(readerText('{state} {tag}；可撤銷本次操作。', { state: readerText(tag.disabled ? '已恢復' : '已停用'), tag: `${tag.namespace}:${tag.displayValue}` }));
    await refreshTagLibrary();
  } catch (error) {
    updateOrganizerUi(readerText('標籤狀態更新失敗：{error}', { error: error?.message || error }));
  }
}

async function undoLastTagOperation() {
  if (!state.lastTagUndoToken) return;
  try {
    await eAPI.undoTagOperation(state.lastTagUndoToken);
    state.lastTagUndoToken = null;
    updateOrganizerUi(readerText('已撤銷上次標籤庫操作。'));
    await refreshTagLibrary();
  } catch (error) {
    updateOrganizerUi(readerText('標籤撤銷失敗：{error}', { error: error?.message || error }));
  }
}

function setOrganizeMode(enabled) {
  state.organizeMode = Boolean(enabled);
  if (!state.organizeMode) state.organizeSelection.clear();
  document.querySelectorAll('[data-inspector-action="organize"]').forEach(button => {
    button.classList.toggle('active', state.organizeMode);
    button.setAttribute('aria-pressed', String(state.organizeMode));
  });
  if (elements.organizeBar) elements.organizeBar.hidden = !state.organizeMode;
  document.body.classList.toggle('organize-mode', state.organizeMode);
  updateOrganizerUi();
  renderGrid();
  if (state.organizeMode) {
    switchOrganizerPanel(state.organizerPanel || 'tags');
    refreshTagLibrary();
  }
}

function toggleOrganizerSelection(comicId) {
  if (isPhotoAlbum({ id: comicId })) return;
  if (state.organizeSelection.has(comicId)) state.organizeSelection.delete(comicId);
  else state.organizeSelection.add(comicId);
  updateOrganizerUi();
  const card = [...elements.comicGrid.children].find(item => item.dataset.comicId === comicId);
  if (card) {
    const selected = state.organizeSelection.has(comicId);
    card.classList.toggle('organize-selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  }
  const comic = state.comics.find(item => item.id === comicId);
  if (comic) renderComicInspector(comic, { keepSelection: true });
}

function updateOrganizerUi(message = '') {
  const count = state.organizeSelection.size;
  if (elements.organizeCount) elements.organizeCount.textContent = readerText('已選 {count} 本', { count });
  if (elements.organizeImpactSummary) {
    const selectedTitles = [...state.organizeSelection].slice(0, 2)
      .map(id => state.comics.find(comic => comic.id === id)?.title)
      .filter(Boolean);
    const selection = selectedTitles.length
      ? readerText('已選 {count} 本（{titles}{more}）', {
          count,
          titles: selectedTitles.join('、'),
          more: count > selectedTitles.length ? readerText('等') : '',
        })
      : readerText('已選 {count} 本', { count });
    const changes = [];
    if (parseOrganizerTag()) changes.push(readerText('標籤'));
    if (elements.organizeAuthor?.value.trim()) changes.push(readerText('作者'));
    if (elements.organizeSeries?.value.trim()) changes.push(readerText('系列'));
    if (elements.organizeLanguage?.value.trim()) changes.push(readerText('語言'));
    if (elements.organizeDirection?.value) changes.push(readerText('閱讀方向'));
    elements.organizeImpactSummary.textContent = count === 0
      ? readerText('先選取漫畫，再確認要修改的欄位。')
      : changes.length === 0
        ? readerText('{selection}；尚未指定要變更的欄位。', { selection })
        : readerText('{selection}；將變更：{fields}。', { selection, fields: changes.join('、') });
  }
  if (elements.organizeStatus && message) elements.organizeStatus.textContent = message;
  for (const button of [elements.organizeApply, elements.organizeExcludeTag, elements.organizeReimport]) {
    if (button) button.disabled = count === 0;
  }
  if (elements.organizeUndo) elements.organizeUndo.disabled = !state.lastUndoToken;
}

function parseOrganizerTag() {
  const raw = elements.organizeTag?.value.trim();
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator > 0) return { namespace: raw.slice(0, separator).trim().toLowerCase(), value: raw.slice(separator + 1).trim() };
  return { namespace: 'general', value: raw };
}

async function applyOrganizerBatch(tagAction) {
  const comicIds = [...state.organizeSelection];
  if (!comicIds.length) return;
  const fields = {};
  const author = elements.organizeAuthor?.value.trim();
  const series = elements.organizeSeries?.value.trim();
  const language = elements.organizeLanguage?.value.trim();
  const direction = elements.organizeDirection?.value;
  if (author) fields.creators = JSON.stringify({ artist: author.split(/[,;、]/).map(item => item.trim()).filter(Boolean) });
  if (series) fields.series = series;
  if (language) fields.language = language;
  if (direction) fields.reading_direction = direction;
  const tag = parseOrganizerTag();
  const request = { comicIds, fields, addTags: tag && tagAction === 'include' ? [tag] : [], excludeTags: tag && tagAction === 'exclude' ? [tag] : [] };
  if (!Object.keys(fields).length && !tag) {
    updateOrganizerUi(readerText('請至少輸入一個欄位或標籤。'));
    return;
  }
  setOrganizerBusy(true, readerText('正在更新 {count} 本漫畫…', { count: comicIds.length }));
  try {
    const result = await eAPI.applyBatchMetadata(request);
    state.lastUndoToken = result.undoToken;
    if (series) state.comics.filter(comic => state.organizeSelection.has(comic.id)).forEach(comic => { comic.series = series; });
    invalidateComicNavigationCache();
    updateOrganizerUi(readerText('已更新 {count} 本；可撤銷本次操作。', { count: result.updated }));
    refreshTagLibrary();
    await refreshCatalogSearch(elements.searchInput.value.trim());
    if (state.selectedComicId) {
      const comic = state.comics.find(item => item.id === state.selectedComicId);
      if (comic) renderComicInspector(comic, { keepSelection: true });
    }

  } catch (error) {
    updateOrganizerUi(readerText('更新失敗：{error}', { error: error?.message || error }));
  } finally {
    setOrganizerBusy(false);
  }
}

async function applyFolderTagRule() {
  const tag = parseOrganizerTag();
  if (!tag) return updateOrganizerUi(readerText('請先輸入要繼承的標籤。'));
  const sample = state.comics.find(comic => state.organizeSelection.has(comic.id)) || state.filteredComics.find(comic => !comic.isDirectory);
  if (!sample) return updateOrganizerUi(readerText('目前資料夾沒有可建立規則的漫畫。'));
  setOrganizerBusy(true, readerText('正在建立資料夾繼承規則…'));
  try {
    await eAPI.upsertFolderTagRule({ id: null, sourceId: state.currentSourceId || sample.sourceId || 'local', folderPath: state.currentPath, tag, enabled: true });
    updateOrganizerUi(readerText('已讓「{path}」繼承 {tag}。', { path: state.currentPath || readerText('書庫根目錄'), tag: `${tag.namespace}:${tag.value}` }));
  } catch (error) {
    updateOrganizerUi(readerText('規則建立失敗：{error}', { error: error?.message || error }));
  } finally {
    setOrganizerBusy(false);
  }
}

async function reimportSelectedMetadata() {
  const comicIds = [...state.organizeSelection];
  if (!comicIds.length) return;
  setOrganizerBusy(true, readerText('正在重新讀取 metadata…'));
  try {
    const result = await eAPI.reimportMetadata({ comicIds });
    updateOrganizerUi(readerText('已重新匯入 {count} 本，產生 {diagnostics} 則診斷。', { count: result.imported, diagnostics: result.diagnostics }));
    const comic = state.comics.find(item => item.id === state.selectedComicId);
    if (comic) renderComicInspector(comic, { keepSelection: true });
  } catch (error) {
    updateOrganizerUi(readerText('重新匯入失敗：{error}', { error: error?.message || error }));
  } finally {
    setOrganizerBusy(false);
  }
}

async function undoOrganizerBatch() {
  if (!state.lastUndoToken) return;
  setOrganizerBusy(true, readerText('正在撤銷上次批次操作…'));
  try {
    const count = await eAPI.undoBatchMetadata(state.lastUndoToken);
    state.lastUndoToken = null;
    updateOrganizerUi(readerText('已還原 {count} 本漫畫。', { count }));
    const comic = state.comics.find(item => item.id === state.selectedComicId);
    if (comic) renderComicInspector(comic, { keepSelection: true });
  } catch (error) {
    updateOrganizerUi(readerText('撤銷失敗：{error}', { error: error?.message || error }));
  } finally {
    setOrganizerBusy(false);
  }
}

async function saveOrganizerAlias() {
  const alias = elements.organizeAlias?.value.trim();
  const canonicalValue = elements.organizeCanonical?.value.trim();
  if (!alias || !canonicalValue) return updateOrganizerUi(readerText('別名與標準標籤都要填。'));
  if (!eAPI?.upsertTagAlias) return updateOrganizerUi(readerText('標籤別名需要在 Tauri App 中使用。'));
  try {
    await eAPI.upsertTagAlias({ namespace: 'general', alias, canonicalValue });
    elements.organizeAlias.value = '';
    elements.organizeCanonical.value = '';
    updateOrganizerUi(readerText('搜尋別名「{alias}」現在會對應 general:{canonical}，原始 tag 未改寫。', { alias, canonical: canonicalValue }));
  } catch (error) {
    updateOrganizerUi(readerText('別名儲存失敗：{error}', { error: error?.message || error }));
  }
}

async function showOrganizerInbox() {
  if (!eAPI?.listOrganizerInbox || !elements.organizeInsightResults) return;
  elements.organizeInsightResults.textContent = readerText('正在讀取低信心項目…');
  try {
    const items = await eAPI.listOrganizerInbox(100);
    elements.organizeInsightResults.innerHTML = items.length ? items.map(item => `
      <article><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.parserId || 'unknown')} · ${readerText('信心 {value}', { value: item.confidence ?? '—' })}</span><small>${escapeHtml(item.reason)} · ${escapeHtml(item.sourcePath)}</small></article>`).join('') : `<p>${readerText('目前沒有低信心項目。')}</p>`;
  } catch (error) {
    elements.organizeInsightResults.textContent = readerText('Inbox 載入失敗：{error}', { error: error?.message || error });
  }
}

async function showDuplicateCandidates() {
  if (!eAPI?.listDuplicateCandidates || !elements.organizeInsightResults) return;
  elements.organizeInsightResults.textContent = readerText('正在比對重複候選…');
  try {
    const items = await eAPI.listDuplicateCandidates(100);
    elements.organizeInsightResults.innerHTML = items.length ? items.map(item => `
      <article><strong>${readerText('{count} 本候選', { count: item.comicIds.length })}</strong><span>${readerText('指紋 {value}', { value: escapeHtml(item.fingerprint.slice(0, 12)) })}…</span><small>${item.locations.map(escapeHtml).join('、')}</small></article>`).join('') : `<p>${readerText('目前沒有重複候選；系統不會自動合併或刪檔。')}</p>`;
  } catch (error) {
    elements.organizeInsightResults.textContent = readerText('重複候選載入失敗：{error}', { error: error?.message || error });
  }
}

function setOrganizerBusy(busy, message = '') {
  elements.organizeBar?.setAttribute('aria-busy', String(busy));
  elements.organizeBar?.querySelectorAll('button, input, select').forEach(control => {
    if (control === elements.organizeUndo && !busy) control.disabled = !state.lastUndoToken;
    else if (control === elements.tagEditorUndo && !busy) control.disabled = !state.lastTagUndoToken;
    else control.disabled = busy;
  });
  if (message && elements.organizeStatus) elements.organizeStatus.textContent = message;
  if (!busy) updateOrganizerUi();
}

let catalogSearchTimer = null;
// 重用自然排序器，避免每次比較都重新建立 locale/options 處理成本。
const comicTitleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let coverObserver = null;
const COVER_LOAD_CONCURRENCY = 2;
const COVER_LOAD_START_DELAY = 80;
const COVER_LOAD_IDLE_AFTER_SCROLL = 180;
const COVER_FAILURE_TTL_MS = 30_000;
const COVER_FAILURE_CACHE_LIMIT = 2048;
let coverLoadQueue = [];
let coverLoadActive = 0;
let coverLoadTimer = null;
let coverScrollIdleTimer = null;
let coverScrollActive = false;
let coverLoadGeneration = 0;
const coverLoadTasks = new Set();
const coverVisibleImages = new Set();
const failedCoverIds = new Map();

function resetCoverLoadQueue() {
  coverLoadGeneration += 1;
  const queuedImages = coverLoadQueue.slice();
  coverLoadQueue = [];
  coverVisibleImages.clear();
  if (coverLoadTimer !== null) {
    clearTimeout(coverLoadTimer);
    coverLoadTimer = null;
  }
  for (const task of coverLoadTasks) {
    task.cancelled = true;
    task.img.removeEventListener('load', task.onLoad);
    task.img.removeEventListener('error', task.onError);
    task.img.src = '';
    if (task.src && !task.img.dataset.src) task.img.dataset.src = task.src;
    delete task.img.dataset.coverQueued;
    task.img.dataset.coverState = 'idle';
    task.img.closest('.comic-cover-wrapper')?.classList.add('cover-pending');
  }
  queuedImages.forEach(img => {
    delete img.dataset.coverQueued;
    img.dataset.coverState = 'idle';
    img.closest('.comic-cover-wrapper')?.classList.add('cover-pending');
  });
  coverLoadTasks.clear();
  // 舊 task 的 callback 可能仍在事件佇列中，但不再擁有新世代的名額。
  coverLoadActive = 0;
}

function noteCatalogScroll() {
  coverScrollActive = true;
  if (coverLoadTimer !== null) {
    clearTimeout(coverLoadTimer);
    coverLoadTimer = null;
  }
  if (coverScrollIdleTimer !== null) clearTimeout(coverScrollIdleTimer);
  coverScrollIdleTimer = window.setTimeout(() => {
    coverScrollIdleTimer = null;
    coverScrollActive = false;
    drainCoverLoadQueue();
    if (state.libraryRefreshPending) requestDeferredLibraryRefresh();
  }, COVER_LOAD_IDLE_AFTER_SCROLL);
}

function hasFailedCover(coverId) {
  if (!coverId) return false;
  const expiresAt = failedCoverIds.get(coverId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    failedCoverIds.delete(coverId);
    return false;
  }
  return true;
}

function markCoverUnavailable(img) {
  if (!img) return;
  const coverId = img.dataset.coverId;
  if (coverId) {
    failedCoverIds.delete(coverId);
    if (failedCoverIds.size >= COVER_FAILURE_CACHE_LIMIT) {
      failedCoverIds.delete(failedCoverIds.keys().next().value);
    }
    failedCoverIds.set(coverId, Date.now() + COVER_FAILURE_TTL_MS);
  }
  img.dataset.coverState = 'failed';
  delete img.dataset.coverQueued;
  delete img.dataset.src;
  img.style.display = 'none';
  const wrapper = img.closest('.comic-cover-wrapper');
  wrapper?.classList.remove('cover-pending');
  wrapper?.classList.add('cover-error');
  img.nextElementSibling?.style.setProperty('display', 'flex');
  img.closest('.comic-card')?.classList.add('cover-error');
}

function drainCoverLoadQueue() {
  coverLoadTimer = null;
  if (coverScrollActive) return;
  while (coverLoadActive < COVER_LOAD_CONCURRENCY && coverLoadQueue.length > 0) {
    const visibleIndex = coverLoadQueue.findIndex(img => coverVisibleImages.has(img));
    if (visibleIndex < 0) return;
    const [img] = coverLoadQueue.splice(visibleIndex, 1);
    coverVisibleImages.delete(img);
    coverObserver?.unobserve(img);
    if (!img?.isConnected || !img.dataset.src) continue;
    if (hasFailedCover(img.dataset.coverId)) {
      markCoverUnavailable(img);
      continue;
    }

    const wrapper = img.closest('.comic-cover-wrapper');
    wrapper?.classList.remove('cover-pending');
    const src = img.dataset.src;
    delete img.dataset.src;
    delete img.dataset.coverQueued;
    img.dataset.coverState = 'loading';
    coverLoadActive += 1;

    const task = {
      img,
      src,
      generation: coverLoadGeneration,
      cancelled: false,
      onLoad: null,
      onError: null,
    };
    const finish = (failed = false) => {
      if (task.cancelled || !coverLoadTasks.has(task)) return;
      coverLoadTasks.delete(task);
      img.removeEventListener('load', task.onLoad);
      img.removeEventListener('error', task.onError);
      if (task.generation !== coverLoadGeneration) return;
      if (failed) markCoverUnavailable(img);
      else img.dataset.coverState = 'loaded';
      coverLoadActive = Math.max(0, coverLoadActive - 1);
      scheduleCoverLoadDrain(0);
    };
    task.onLoad = () => {
      wrapper?.classList.add('cover-loaded');
      finish();
    };
    task.onError = () => finish(true);
    coverLoadTasks.add(task);
    img.addEventListener('load', task.onLoad, { once: true });
    img.addEventListener('error', task.onError, { once: true });
    tuneImageForLowPriority(img);
    img.src = src;
  }
}

function scheduleCoverLoadDrain(delay = COVER_LOAD_START_DELAY) {
  if (coverScrollActive) return;
  if (coverLoadTimer !== null) return;
  coverLoadTimer = window.setTimeout(drainCoverLoadQueue, delay);
}

function enqueueCoverLoad(img) {
  if (!img?.dataset.src || img.dataset.coverState === 'queued' || img.dataset.coverState === 'loading') return;
  if (hasFailedCover(img.dataset.coverId)) {
    markCoverUnavailable(img);
    return;
  }
  img.dataset.coverState = 'queued';
  img.dataset.coverQueued = 'true';
  coverLoadQueue.push(img);
  scheduleCoverLoadDrain();
}

function cancelQueuedCoverLoad(img) {
  if (!img || img.dataset.coverState !== 'queued') return;
  coverLoadQueue = coverLoadQueue.filter(item => item !== img);
  coverVisibleImages.delete(img);
  delete img.dataset.coverQueued;
  img.dataset.coverState = 'idle';
}

async function refreshCatalogSearch(query, { append = false } = {}) {
  if (!query || !eAPI?.searchCatalog) {
    state.catalogSearchIds = null;
    state.catalogSearchItems.clear();
    state.catalogSearchTotal = 0;
    renderCatalogFacets({});
    filterAndRenderGrid();
    return;
  }
  const requestId = ++state.catalogSearchRequest;
  try {
    const result = await eAPI.searchCatalog({ query, offset: append ? state.catalogSearchItems.size : 0, limit: 200 });
    if (requestId !== state.catalogSearchRequest) return;
    const nextItems = append ? new Map(state.catalogSearchItems) : new Map();
    result.items.filter(item => item.runtimeId).forEach(item => nextItems.set(item.runtimeId, item));
    state.catalogSearchItems = nextItems;
    state.catalogSearchIds = new Set(state.catalogSearchItems.keys());
    state.catalogSearchTotal = result.total || state.catalogSearchItems.size;
    renderCatalogFacets(result.facets || {});
    filterAndRenderGrid();
  } catch (error) {
    console.warn('SQLite 目錄搜尋暫不可用，退回檔名搜尋：', error);
    if (requestId !== state.catalogSearchRequest) return;
    state.catalogSearchIds = null;
    state.catalogSearchItems.clear();
    state.catalogSearchTotal = 0;
    renderCatalogFacets({});
    filterAndRenderGrid();
  }
}

function renderCatalogFacets(facets) {
  if (!elements.catalogFacets) return;
  const entries = Object.entries(facets).flatMap(([namespace, values]) => Object.entries(values).map(([value, count]) => ({ namespace, value, count }))).sort((a, b) => b.count - a.count).slice(0, 18);
  elements.catalogFacets.hidden = entries.length === 0;
  elements.catalogFacets.innerHTML = entries.map(item => `<button type="button" class="catalog-facet" data-query="${escapeHtml(item.namespace)}:${escapeHtml(item.value)}">${escapeHtml(item.namespace)}:${escapeHtml(item.value)} · ${item.count}</button>`).join('');
  elements.catalogFacets.querySelectorAll('.catalog-facet').forEach(button => button.addEventListener('click', () => {
    const addition = button.dataset.query;
    elements.searchInput.value = `${elements.searchInput.value.trim()} ${addition}`.trim();
    handleSearch({ target: elements.searchInput });
  }));
}

function isComicOffline(comic) {
  return Boolean(comic && (comic.offline || comic.type === 'offline'));
}

function updateLibraryStartPanel() {
  if (!elements.libraryStartPanel) return;
  const hasFormalComic = state.comics.some(comic => comic && !isBuiltInDemoComic(comic));
  elements.libraryStartPanel.hidden = hasFormalComic;
}

function setScanRecoveryVisible(visible, message = '') {
  if (!elements.scanRecoveryPanel) return;
  elements.scanRecoveryPanel.hidden = !visible;
  if (visible && elements.scanRecoveryMessage) {
    elements.scanRecoveryMessage.textContent = message || readerText('漫畫來源暫時無法完成掃描，現有書架仍可使用。');
  }
}

function updateScanRecovery(status) {
  if (!status) return;
  const phase = String(status.phase || '').toLowerCase();
  const terminalError = phase === 'error'
    || (status.isScanning === false && Boolean(status.error))
    || (status.isScanning === false && Boolean(status.pollError));
  if (terminalError) {
    setScanRecoveryVisible(true, readerText('漫畫來源暫時無法完成掃描，現有書架仍可使用。'));
  } else if (phase === 'complete' || status.isScanning === true) {
    setScanRecoveryVisible(false);
  }
}

function showReaderDiscoveryHint() {
  const hint = elements.readerDiscoveryHint;
  if (!hint || state.readerDiscoveryHintSeen) return;
  const coarsePointer = typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: none), (pointer: coarse)').matches;
  const touchCapable = Number(navigator.maxTouchPoints || 0) > 0;
  if (!coarsePointer && !touchCapable) return;
  hint.hidden = false;
  state.readerDiscoveryHintSeen = true;
  try { localStorage.setItem('gai:readerDiscoveryHintSeen', 'true'); } catch (error) {}
  window.setTimeout(() => {
    if (hint.isConnected) hint.hidden = true;
  }, 3600);
}

function dismissReaderDiscoveryHint() {
  if (elements.readerDiscoveryHint) elements.readerDiscoveryHint.hidden = true;
}

function showLibrarySourceRecovery(message) {
  if (window.confirm(`${message}

${readerText('要前往設定重新選擇漫畫目錄嗎？')}`)) {
    openSettingsForRecovery().catch(error => console.warn('無法開啟來源設定：', error));
  }
}

async function openSettingsForRecovery() {
  await openSettingsModal();
  elements.scanDirInput?.focus();
  elements.scanDirInput?.select();
}

async function retryLibraryScan() {
  if (elements.scanRetryBtn) elements.scanRetryBtn.disabled = true;
  setScanRecoveryVisible(true, readerText('正在重新掃描漫畫來源…'));
  try {
    if (typeof eAPI.scanLibrary === 'function') {
      await eAPI.scanLibrary();
      startScanStatusPolling();
      await fetchLibrary();
    } else {
      await fetchLibrary();
    }
  } catch (error) {
    console.warn('重新掃描漫畫來源失敗：', error);
    setScanRecoveryVisible(true, readerText('漫畫來源暫時無法完成掃描，現有書架仍可使用。'));
  } finally {
    if (elements.scanRetryBtn) elements.scanRetryBtn.disabled = false;
  }
}

// 獲取漫畫清單
async function fetchLibrary(options = {}) {
  if (activeLibraryFetch) {
    libraryFetchQueued = true;
    return activeLibraryFetch;
  }

  activeLibraryFetch = performLibraryFetch(options);
  try {
    return await activeLibraryFetch;
  } finally {
    activeLibraryFetch = null;
    incrementalItemsDuringFetch.clear();
    if (libraryFetchQueued) {
      libraryFetchQueued = false;
      scheduleLibraryRefresh(0);
    }
  }
}

async function performLibraryFetch({ background = false } = {}) {
  let failed = false;
  let scanStillRunning = false;
  let latestScanStatus = null;
  // Favorites 與掃描狀態不依賴完整 library snapshot；先並行讀取，讓
  // native scanner 能在大型書庫快照完成前收到優先查找提示。
  const initialFavoritesPromise = eAPI?.getFavorites
    ? Promise.resolve().then(() => eAPI.getFavorites())
    : Promise.resolve(null);
  const initialScanStatusPromise = eAPI?.getScanStatus
    ? Promise.resolve().then(() => eAPI.getScanStatus())
    : Promise.resolve(null);
  Promise.allSettled([initialFavoritesPromise, initialScanStatusPromise]).then(([favoritesResult, statusResult]) => {
    if (statusResult.status !== 'fulfilled' || !statusResult.value) return;
    const favorites = favoritesResult.status === 'fulfilled' && Array.isArray(favoritesResult.value)
      ? favoritesResult.value
      : state.favorites;
    requestPriorityLibraryScan(statusResult.value, favorites);
  });
  const silentRefresh = background && elements.comicGrid.childElementCount > 0;
  if (!silentRefresh) {
        showLoader(readerText('正在背景整理漫畫庫...'), { progress: null, detail: readerText('仍可繼續使用目前畫面') });
    startScanStatusPolling();
  }
  let libraryConfig = null;
  try {
    if (!silentRefresh) setLoaderProgress(null, readerText('正在讀取漫畫庫索引...'));
    let nextComics = await eAPI.getLibrary();
    // 內建示範永遠是前端衍生資料；即使 native snapshot 意外帶回同名項目，
    // 也先剔除再重建，避免污染正式書庫或讓示範卡重複。
    nextComics = (Array.isArray(nextComics) ? nextComics : []).filter(comic => !isBuiltInDemoComic(comic));
    nextComics = [...nextComics, ...createBuiltInDemoComics()];
    if (eAPI && eAPI.getConfig) {
      try {
        libraryConfig = await eAPI.getConfig();
      } catch (error) {
        console.warn('無法讀取漫畫庫設定：', error);
      }
    }

    if (!silentRefresh) setLoaderProgress(70, readerText('已載入 {count} 本正式漫畫', { count: nextComics.filter(comic => !isBuiltInDemoComic(comic)).length }));
    let nextFavorites = state.favorites;
    if (eAPI && eAPI.getFavorites) {
      try {
        const loadedFavorites = await initialFavoritesPromise;
        if (Array.isArray(loadedFavorites)) nextFavorites = loadedFavorites;
      } catch(e) {}
    }
    if (eAPI?.getScanStatus) {
      try {
        latestScanStatus = await initialScanStatusPromise;
        // App 啟動時 Rust 的背景工作可能比第一輪 UI 讀取晚一拍；
        // 空書架時短暫等候掃描狀態就緒，避免把「尚未開始」誤當成「已完成」。
        const formalComicCount = nextComics.filter(comic => !isBuiltInDemoComic(comic)).length;
        for (let attempt = 0; !latestScanStatus?.isScanning && formalComicCount === 0 && attempt < 6; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          latestScanStatus = await eAPI.getScanStatus();
        }
        const activeStatus = state.scanStatus;
        if (Number(activeStatus?.generation) > Number(latestScanStatus?.generation)
          || (Number(activeStatus?.generation) === Number(latestScanStatus?.generation)
            && activeStatus?.isScanning && !latestScanStatus?.isScanning)) {
          latestScanStatus = activeStatus;
        }
        scanStillRunning = Boolean(latestScanStatus?.isScanning);
        state.scanStatus = latestScanStatus;
        updateScanRecovery(state.scanStatus);
        requestPriorityLibraryScan(state.scanStatus, nextFavorites);
        if (scanStillRunning) {
          state.libraryRefreshPending = true;
          if (!state.scanStatusPollTimer) startScanStatusPolling();
        }
      } catch(e) {
        // 暫時讀不到狀態時保留已知的 isScanning；完全未知時也不能假裝
        // 已完成，否則慢啟動的 native scanner 會被 UI 誤報成成功。
        if (!silentRefresh) {
          const knownScanning = state.scanStatus?.isScanning;
          state.scanStatus = {
            ...(state.scanStatus || {}),
            isScanning: typeof knownScanning === 'boolean' ? knownScanning : true,
            pollError: true,
          };
        }
      }
    }
    if (silentRefresh && isLibraryRefreshBlocked()) {
      // 背景請求可以完成，但捲動／閱讀器／掃描期間禁止提交新資料與 DOM。
      // 丟棄這次 snapshot，gate 解除後只排一次最新 refresh，避免舊結果覆蓋畫面。
      state.libraryRefreshPending = true;
      return;
    }
    if (eAPI && eAPI.getConfig && elements.libraryPathLabel) {
      try {
        const config = libraryConfig || await eAPI.getConfig();
        elements.libraryPathLabel.textContent = config.isLocalLibrary ? readerText('本機書庫') : shortPathLabel(config.scanDir);
        elements.libraryPathLabel.title = config.isLocalLibrary ? readerText('匯入圖片與檔案的儲存位置') : config.scanDir;
      } catch(e) {}
    }
    if (silentRefresh && isLibraryRefreshBlocked()) {
      state.libraryRefreshPending = true;
      return;
    }
    // A priority batch can arrive while getLibrary() still holds an older
    // snapshot. Carry those items into the commit for this scan generation.
    const currentGeneration = Number(state.scanStatus?.generation);
    const snapshotGeneration = Number(latestScanStatus?.generation);
    const mergeGeneration = Number.isSafeInteger(snapshotGeneration) && snapshotGeneration > 0
      ? Math.max(currentGeneration || 0, snapshotGeneration)
      : currentGeneration;
    const received = incrementalItemsDuringFetch.get(mergeGeneration);
    if (received) {
      const positions = new Map(nextComics.map((comic, index) => [comic.id, index]));
      received.forEach((comic, id) => {
        const index = positions.get(id);
        if (index === undefined) nextComics.push(comic);
        else nextComics[index] = comic;
      });
    }
    nextComics = eAPI?.overlayLibraryProgress?.(nextComics) || nextComics;
    state.comics = nextComics;
    invalidateComicNavigationCache();
    setFavorites(nextFavorites);
    filterAndRenderGrid({ skipUnchanged: silentRefresh, background: silentRefresh });
    renderSidebar();
    renderContinueStrip();
    restoreLibraryRefreshFocus();
    updateStats();
    if (scanStillRunning && !silentRefresh) {
      updateLoaderScanProgress(latestScanStatus);
    } else if (!silentRefresh && !state.scanStatus?.pollError && state.scanStatus?.phase !== 'error') {
      setLoaderProgress(100, readerText('書架整理完成'));
    } else if (!silentRefresh) {
      updateLoaderScanProgress(state.scanStatus);
    }
  } catch (e) {
    failed = true;
    console.error('無法獲取書架清單：', e);
    // 首次載入若正式來源暫時不可用，仍提供前端衍生的 8 組風景示範；
    // 已有正式漫畫時保留現況，避免例外分支把使用者書架清空或覆蓋。
    if (!state.comics.some(comic => !isBuiltInDemoComic(comic))) {
      state.comics = createBuiltInDemoComics();
      invalidateComicNavigationCache();
      setFavorites([]);
      filterAndRenderGrid();
      renderSidebar();
      renderContinueStrip();
      restoreLibraryRefreshFocus();
      updateStats();
    }
    if (!silentRefresh) {
      setScanRecoveryVisible(true, readerText('漫畫來源暫時無法完成掃描，現有書架仍可使用。'));
      showLoader(readerText('漫畫庫讀取失敗'), {
        progress: null,
        detail: readerText('漫畫來源暫時無法完成掃描，現有書架仍可使用。')
      });
    }
  } finally {
    if (silentRefresh) {
      // 背景同步保留目前畫面與任何前景 loader。
    } else if (scanStillRunning && !failed) {
      updateLoaderScanProgress(latestScanStatus);
    } else if (failed) {
      if (state.scanStatus?.isScanning !== false) {
        state.scanStatus = {
          ...(state.scanStatus || {}),
          isScanning: true,
          pollError: true,
        };
        if (!state.scanStatusPollTimer) startScanStatusPolling();
      } else {
        stopScanStatusPolling();
      }
      if (state.scanStatus?.isScanning !== false) updateLoaderScanProgress(state.scanStatus);
      state.loaderHideTimer = window.setTimeout(hideLoader, 6000);
    } else if (state.scanStatus?.pollError || state.scanStatus?.phase === 'error') {
      updateLoaderScanProgress(state.scanStatus);
      if (state.scanStatus?.isScanning !== false) {
        if (!state.scanStatusPollTimer) startScanStatusPolling();
      } else {
        stopScanStatusPolling();
      }
      state.loaderHideTimer = window.setTimeout(hideLoader, 6000);
    } else {
      stopScanStatusPolling();
      hideLoader();
    }
  }
}

function getFolderTreeSourceId(comic) {
  const sourceId = comic?.sourceId ?? comic?.source_id;
  return sourceId != null && String(sourceId).trim() ? String(sourceId) : '';
}

function normalizeDirectorySourceId(sourceId) {
  return sourceId == null ? '' : String(sourceId).trim();
}

function isPhotoKitSourceId(sourceId) {
  const normalized = normalizeDirectorySourceId(sourceId);
  return normalized === 'photos' || normalized.startsWith('photos:');
}

function isVirtualDirectorySourceId(sourceId) {
  const normalized = normalizeDirectorySourceId(sourceId);
  return isPhotoKitSourceId(normalized) || normalized === BUILT_IN_DEMO_SOURCE_ID;
}

function normalizeDirectoryPath(path) {
  if (typeof path !== 'string') return '';
  return path.replace(/^\/+|\/+$/g, '');
}

function createDirectoryLocation(sourceId = '', relativePath = '') {
  return {
    sourceId: normalizeDirectorySourceId(sourceId),
    relativePath: normalizeDirectoryPath(relativePath),
  };
}

function normalizeDirectoryLocation(locationOrPath, sourceId = '') {
  if (locationOrPath && typeof locationOrPath === 'object') {
    return createDirectoryLocation(
      locationOrPath.sourceId ?? locationOrPath.source_id,
      locationOrPath.relativePath ?? locationOrPath.path,
    );
  }
  return createDirectoryLocation(sourceId, locationOrPath);
}

function getDirectoryLocationKey(sourceId, relativePath) {
  const location = createDirectoryLocation(sourceId, relativePath);
  return `${location.sourceId || 'legacy'}\u0000${location.relativePath}`;
}

function getCurrentDirectoryLocation() {
  return createDirectoryLocation(state.currentSourceId, state.currentPath);
}

function setCurrentDirectoryLocation(locationOrPath, sourceId = '') {
  const location = normalizeDirectoryLocation(locationOrPath, sourceId);
  state.currentSourceId = location.sourceId;
  state.currentPath = location.relativePath;
  state.currentDirectory = location;
  return location;
}

function getVisibleDirectoryMapKey(sourceId, relativePath) {
  return getDirectoryLocationKey(sourceId, relativePath);
}

function getVisibleDirectoryPaths(sourceId, relativePath) {
  const location = createDirectoryLocation(sourceId, relativePath);
  const exactKey = getVisibleDirectoryMapKey(location.sourceId, location.relativePath);
  const exact = state.visibleDirectories.get(exactKey);
  if (Array.isArray(exact)) return exact;

  // Old native payloads had no visibleSourceId. Keep them in the legacy lane;
  // they are safe to show only in the source-merged root view, never inside a
  // selected source where they could resurrect a neighbouring folder.
  if (!location.sourceId) {
    const legacy = state.visibleDirectories.get(location.relativePath)
      || state.visibleDirectories.get(getVisibleDirectoryMapKey('', location.relativePath));
    return Array.isArray(legacy) ? legacy : [];
  }
  return [];
}

function getVisibleDirectoryEntries(sourceId, relativePath) {
  const location = createDirectoryLocation(sourceId, relativePath);
  if (location.sourceId) {
    return getVisibleDirectoryPaths(location.sourceId, location.relativePath)
      .map(path => ({ path, sourceId: location.sourceId }));
  }
  const entries = [];
  const seen = new Set();
  const add = (path, entrySourceId = '') => {
    if (typeof path !== 'string' || !path) return;
    const key = `${entrySourceId}\u0000${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ path, sourceId: entrySourceId });
  };
  // Keep direct Map(path, ...) support for old tests and old in-memory state.
  getVisibleDirectoryPaths('', location.relativePath).forEach(path => add(path, ''));
  state.visibleDirectories.forEach((paths, key) => {
    if (!Array.isArray(paths) || typeof key !== 'string') return;
    const separator = key.indexOf('\u0000');
    if (separator < 0) return;
    const entrySourceId = key.slice(0, separator);
    const parentPath = key.slice(separator + 1);
    if (entrySourceId === 'legacy' || parentPath !== location.relativePath) return;
    paths.forEach(path => add(path, entrySourceId));
  });
  return entries;
}

function normalizeFolderTreePath(path) {
  return normalizeDirectoryPath(path);
}

function getFolderTreeNodeKey(sourceId, path) {
  const normalizedPath = normalizeFolderTreePath(path);
  if (!normalizedPath) return 'root';
  return `${sourceId || 'unknown'}\u0000${normalizedPath}`;
}

function getFolderTreeSourceLabel(sourceId) {
  if (!sourceId) return '';
  if (sourceId === 'smb') return readerText('SMB');
  if (sourceId.startsWith('external:') || sourceId === BUILT_IN_DEMO_SOURCE_ID) return readerText('Files');
  if (sourceId.startsWith('local:') || sourceId === 'local') return readerText('本機');
  return sourceId;
}

function collectFolderTreeNodes() {
  const nodes = new Map();
  const visibleDirectoryPaths = new Set();
  const isMergedVirtualRoot = path => path === '📁 外部裝置';
  const nodeKeyFor = (sourceId, path) => (
    isMergedVirtualRoot(path) ? getFolderTreeNodeKey('', path) : getFolderTreeNodeKey(sourceId, path)
  );
  const rememberVisibleDirectoryPath = (rawPath, sourceId = '') => {
    const path = normalizeFolderTreePath(rawPath);
    if (!path) return;
    let parentPath = '';
    path.split('/').filter(Boolean).forEach(part => {
      parentPath = parentPath ? `${parentPath}/${part}` : part;
      visibleDirectoryPaths.add(nodeKeyFor(sourceId, parentPath));
    });
  };
  const addPath = (rawPath, sourceId = '') => {
    const path = normalizeFolderTreePath(rawPath);
    if (!path) return;
    const parts = path.split('/').filter(Boolean);
    let parentPath = '';
    for (const part of parts) {
      const nextPath = parentPath ? `${parentPath}/${part}` : part;
      const key = nodeKeyFor(sourceId, nextPath);
      const parentKey = nodeKeyFor(sourceId, parentPath);
      if (!nodes.has(key)) {
        nodes.set(key, {
          key,
          name: part,
          path: nextPath,
          parentPath,
          parentKey,
          sourceId: isMergedVirtualRoot(nextPath) ? '' : sourceId,
          sourceIds: new Set(),
          hasUnknownSource: false,
          sourceLabel: '',
          comicsCount: 0,
          fromVisibleDirectories: false,
        });
      }
      const node = nodes.get(key);
      if (sourceId) node.sourceIds.add(sourceId);
      else node.hasUnknownSource = true;
      parentPath = nextPath;
    }
  };

  const leafImageFolders = getLeafReadableImageFolderPaths();
  const isLeafImageFolder = (sourceId, path) => {
    const key = getDirectoryLocationKey(sourceId, path);
    if (leafImageFolders.has(key)) return true;
    if (sourceId) return false;
    return [...leafImageFolders].some(item => item.endsWith(`\u0000${path}`));
  };
  state.visibleDirectories.forEach((paths, mapKey) => {
    if (!Array.isArray(paths)) return;
    let sourceId = '';
    const separator = typeof mapKey === 'string' ? mapKey.indexOf('\u0000') : -1;
    if (separator >= 0) {
      sourceId = mapKey.slice(0, separator);
      if (sourceId === 'legacy') sourceId = '';
    }
    paths.forEach(path => {
      if (isLeafImageFolder(sourceId, path)) return;
      rememberVisibleDirectoryPath(path, sourceId);
      addPath(path, sourceId);
    });
  });

  state.comics.forEach(comic => {
    if (!comic || typeof comic.relativePath !== 'string') return;
    const relativePath = normalizeFolderTreePath(comic.relativePath);
    const parts = relativePath.split('/').filter(Boolean);
    const sourceId = getFolderTreeSourceId(comic);
    let parentPath = '';
    // A comic path ends at a shelf item. Only its parent segments are folders.
    parts.slice(0, -1).forEach(part => {
      const folderPath = parentPath ? `${parentPath}/${part}` : part;
      const key = nodeKeyFor(sourceId, folderPath);
      const node = nodes.get(key) || {
        key,
        name: part,
        path: folderPath,
        parentPath,
        parentKey: nodeKeyFor(sourceId, parentPath),
        sourceId: isMergedVirtualRoot(folderPath) ? '' : sourceId,
        sourceIds: new Set(),
        hasUnknownSource: false,
        sourceLabel: '',
        comicsCount: 0,
        fromVisibleDirectories: false,
      };
      if (sourceId) node.sourceIds.add(sourceId);
      else node.hasUnknownSource = true;
      node.comicsCount += 1;
      nodes.set(key, node);
      parentPath = folderPath;
    });
  });

  // A finished shallow scan also owns the tree's direct children. Old catalog
  // paths may remain available for search, but cannot be shown as live folders.
  nodes.forEach((node, key) => {
    if (!node.sourceId || !node.parentPath) return;
    const children = state.visibleDirectories.get(
      getVisibleDirectoryMapKey(node.sourceId, node.parentPath));
    if (Array.isArray(children) && !children.includes(node.path)) nodes.delete(key);
  });

  nodes.forEach(node => {
    node.fromVisibleDirectories = visibleDirectoryPaths.has(node.key);
    const labels = [...node.sourceIds].map(getFolderTreeSourceLabel);
    if (!labels.length && node.hasUnknownSource) labels.push(readerText('來源未提供'));
    node.sourceLabel = labels.join('、');
    node.hasSourceCollision = node.sourceIds.size > 1;
    if (!node.sourceId && node.sourceIds.size === 1) node.sourceId = [...node.sourceIds][0];
  });
  return nodes;
}

function renderFolderTree(nodes, formalComicCount) {
  const tree = elements.seriesFilterList;
  if (!tree) return;
  const root = tree.firstElementChild;
  if (!root) return;
  const focusedControl = tree.contains(document.activeElement) ? document.activeElement : null;
  const focusedNode = focusedControl?.closest('li[data-folder-path]');
  const focusedPath = focusedNode?.dataset.folderPath;
  const focusedSource = focusedNode?.dataset.folderSource || '';
  const focusedSelector = focusedControl?.classList.contains('folder-tree-toggle')
    ? '.folder-tree-toggle'
    : focusedControl?.classList.contains('folder-tree-label') ? '.folder-tree-label'
      : focusedControl?.classList.contains('folder-tree-enter') ? '.folder-tree-enter' : null;
  const rootExpanded = state.expandedFolderPaths.has('root');
  const rootChildren = root.querySelector('.folder-tree-children');
  const childrenByParent = new Map();
  nodes.forEach(node => {
    const children = childrenByParent.get(node.parentKey) || [];
    children.push(node);
    childrenByParent.set(node.parentKey, children);
  });
  childrenByParent.forEach(children => children.sort((left, right) => {
    const byName = comicTitleCollator.compare(left.name, right.name);
    return byName || comicTitleCollator.compare(left.sourceLabel, right.sourceLabel);
  }));

  const renderChildren = (container, parentKey, level) => {
    container.replaceChildren();
    const children = childrenByParent.get(parentKey) || [];
    if (!children.length) return;
    const fragment = document.createDocumentFragment();
    children.forEach(node => {
      const child = document.createElement('li');
      child.className = 'folder-tree-node';
      child.setAttribute('role', 'treeitem');
      child.setAttribute('aria-level', String(level));
      child.dataset.folderPath = node.path;
      child.dataset.folderSource = node.sourceId || '';
      const hasChildren = (childrenByParent.get(node.key) || []).length > 0;
      const scanKey = getDirectoryLocationKey(node.sourceId, node.path);
      const canScanChildren = node.fromVisibleDirectories
        && !state.visibleDirectoryScanCompleted.has(scanKey)
        && !(node.sourceId === '' && state.visibleDirectoryScanCompleted.has(node.path));
      const canExpand = hasChildren || canScanChildren;
      const expanded = state.expandedFolderPaths.has(node.key);
      child.setAttribute('aria-expanded', String(hasChildren && expanded));
      child.classList.toggle('active', state.currentPath === node.path
        && state.currentSourceId === (node.sourceId || ''));

      const row = document.createElement('div');
      row.className = 'folder-tree-row';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'folder-tree-toggle';
      toggle.disabled = !canExpand;
      toggle.setAttribute('aria-expanded', String(canExpand && expanded));
      toggle.setAttribute('aria-label', readerText(expanded ? '收合資料夾：{name}' : '展開資料夾：{name}', { name: node.name }));
      toggle.innerHTML = `<i class="fa-solid ${canExpand && expanded ? 'fa-chevron-down' : 'fa-chevron-right'}" aria-hidden="true"></i>`;
      const toggleFolder = () => {
        if (!canExpand) {
          navigateLibraryToPath(node.path, node.sourceId || '');
          return;
        }
        if (expanded) state.expandedFolderPaths.delete(node.key);
        else state.expandedFolderPaths.add(node.key);
        if (!hasChildren && canScanChildren) {
          requestVisibleDirectoryScan(node.path, { sourceId: node.sourceId || '', force: false, announce: false });
        }
        renderSidebar();
        [...tree.querySelectorAll('.folder-tree-node')]
          .find(item => item.dataset.folderPath === node.path)
          ?.querySelector('.folder-tree-label')
          ?.focus({ preventScroll: true });
      };
      toggle.addEventListener('click', event => {
        event.stopPropagation();
        toggleFolder();
      });

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'folder-tree-label';
      label.setAttribute('aria-label', readerText(canExpand
        ? expanded ? '收合資料夾：{name}' : '展開資料夾：{name}'
        : '開啟資料夾：{title}', { name: node.name, title: node.name }));
      if (canExpand) label.setAttribute('aria-expanded', String(expanded));
      label.innerHTML = `<i class="fa-solid ${expanded ? 'fa-folder-open' : 'fa-folder'}" aria-hidden="true"></i>`;
      const name = document.createElement('span');
      name.className = 'folder-tree-name';
      name.textContent = node.name;
      label.appendChild(name);
      if (node.hasSourceCollision) {
        const source = document.createElement('span');
        source.className = 'folder-tree-source';
        source.textContent = node.sourceLabel || readerText('來源未提供');
        label.appendChild(source);
      }
      if (node.comicsCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(node.comicsCount);
        label.appendChild(badge);
      }
      label.addEventListener('click', toggleFolder);

      const enter = document.createElement('button');
      enter.type = 'button';
      enter.className = 'folder-tree-enter';
      enter.setAttribute('aria-label', readerText('開啟資料夾：{title}', { title: node.name }));
      enter.setAttribute('title', readerText('開啟資料夾：{title}', { title: node.name }));
      enter.setAttribute('aria-current', state.currentPath === node.path
        && state.currentSourceId === (node.sourceId || '') ? 'true' : 'false');
      enter.innerHTML = '<i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
      enter.addEventListener('click', () => navigateLibraryToPath(node.path, node.sourceId || ''));
      row.append(toggle, label, enter);
      child.appendChild(row);
      if (hasChildren && expanded) {
        const group = document.createElement('ul');
        group.className = 'folder-tree-children';
        group.setAttribute('role', 'group');
        renderChildren(group, node.key, level + 1);
        child.appendChild(group);
      }
      fragment.appendChild(child);
    });
    container.appendChild(fragment);
  };

  root.classList.toggle('active', state.currentPath === '' && !state.currentSourceId);
  root.setAttribute('aria-expanded', String(rootExpanded));
  const rootToggle = root.querySelector('.folder-tree-toggle');
  const rootLabel = root.querySelector('.folder-tree-label');
  const rootEnter = root.querySelector('.folder-tree-enter');
  const rootBadge = root.querySelector('#total-count-badge');
  if (rootToggle) {
    rootToggle.setAttribute('aria-expanded', String(rootExpanded));
    rootToggle.setAttribute('aria-label', readerText(rootExpanded ? '收合書庫根目錄' : '展開書庫根目錄'));
    rootToggle.innerHTML = `<i class="fa-solid ${rootExpanded ? 'fa-chevron-down' : 'fa-chevron-right'}" aria-hidden="true"></i>`;
    rootToggle.onclick = () => {
      if (rootExpanded) state.expandedFolderPaths.delete('root');
      else state.expandedFolderPaths.add('root');
      renderSidebar();
    };
  }
  if (rootLabel) {
    rootLabel.setAttribute('aria-expanded', String(rootExpanded));
    rootLabel.setAttribute('aria-label', readerText(rootExpanded ? '收合書庫根目錄' : '展開書庫根目錄'));
    rootLabel.onclick = () => rootToggle?.click();
  }
  if (rootEnter) {
    rootEnter.setAttribute('aria-label', readerText('開啟資料夾：{title}', { title: readerText('書庫根目錄') }));
    rootEnter.setAttribute('aria-current', state.currentPath === '' && !state.currentSourceId ? 'true' : 'false');
    rootEnter.onclick = () => navigateLibraryToPath('', '');
  }
  if (rootBadge) rootBadge.textContent = String(formalComicCount);
  rootChildren?.replaceChildren();
  if (rootExpanded) renderChildren(rootChildren, getFolderTreeNodeKey('', ''), 2);
  if (focusedPath !== undefined && focusedSelector) {
    const matchingNode = [...tree.querySelectorAll('li[data-folder-path]')]
      .find(item => item.dataset.folderPath === focusedPath
        && (item.dataset.folderSource || '') === focusedSource);
    (matchingNode?.querySelector(focusedSelector) || rootEnter)?.focus({ preventScroll: true });
  }
}

// 渲染側邊欄資料夾樹；metadata 系列篩選仍由主內容的 select 保留。
function renderSidebar() {
  const formalComics = state.comics.filter(c => !isBuiltInDemoComic(c));
  const seriesMap = new Map();
  formalComics.forEach(c => {
    const series = c.series || readerText('未分類');
    seriesMap.set(series, (seriesMap.get(series) || 0) + 1);
  });
  const seriesNames = Array.from(seriesMap.keys())
    .filter(seriesName => seriesName !== '.')
    .sort();

  if (elements.seriesFilterSelect) {
    const options = [new Option(readerText('全部系列（{count}）', { count: formalComics.length }), 'all')];
    seriesNames.forEach(seriesName => options.push(new Option(`${seriesName}（${seriesMap.get(seriesName)}）`, seriesName)));
    elements.seriesFilterSelect.replaceChildren(...options);
    elements.seriesFilterSelect.value = state.activeSeries;
    if (!elements.seriesFilterSelect.value) {
      state.activeSeries = 'all';
      setCurrentDirectoryLocation('', '');
    }
  }

  if (elements.folderTreeCurrentPathValue) {
    const sourceLabel = getFolderTreeSourceLabel(state.currentSourceId);
    const currentLabel = state.currentPath || readerText('書庫根目錄');
    const display = sourceLabel ? `${sourceLabel} · ${currentLabel}` : currentLabel;
    elements.folderTreeCurrentPathValue.textContent = display;
    elements.folderTreeCurrentPathValue.title = display;
  }
  renderFolderTree(collectFolderTreeNodes(), formalComics.length);
}

// 切換系列
function selectSeries(seriesName) {
  state.activeSeries = seriesName;
  if (elements.seriesFilterSelect) elements.seriesFilterSelect.value = seriesName;
  elements.seriesFilterList?.querySelectorAll('li').forEach(item => {
    const selected = item.dataset.series === seriesName;
    item.classList.toggle('active', selected);
    if (selected) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  });
  // 系列是 metadata 篩選，不保證與實體資料夾同名；切換時回到書庫根層。
  navigateLibraryToPath('', '');
}

// 統計資訊更新
function updateStats() {
  const formalComics = state.comics.filter(comic => !isBuiltInDemoComic(comic));
  const total = formalComics.length;
  let reading = 0;
  let completed = 0;

  formalComics.forEach(c => {
    const progress = getProgressInfo(c);
    if (progress.hasProgress) {
      if (progress.isFinished) completed++;
      else reading++;
    }
  });

  elements.statsTotal.textContent = total;
  elements.statsReading.textContent = reading;
  elements.statsCompleted.textContent = completed;
  updateLibraryStartPanel();
}

function getProgressInfo(comic) {
  const progress = comic?.progress || {};
  const currentPage = Number(progress.currentPage || 0);
  const totalPages = Number(progress.totalPages || comic?.pageCount || 0);
  // currentPage is zero-based. A one-page comic therefore remains at 0 even
  // after it has been opened; updatedAt is the existing persisted last-read
  // marker written by save_progress and lets us classify that case without a
  // new cross-layer completion field.
  const suppliedPercent = Number(progress.percent);
  const hasLastRead = typeof progress.updatedAt === 'string' && progress.updatedAt.trim() !== '';
  const singlePageFinished = totalPages === 1 && (hasLastRead || suppliedPercent >= 100);
  const rawPercent = Number.isFinite(suppliedPercent)
    ? suppliedPercent
    : totalPages > 0 ? (currentPage / totalPages) * 100 : 0;
  const percent = singlePageFinished ? 100 : Math.round(Math.min(100, Math.max(0, rawPercent)));
  const hasProgress = currentPage > 0 || singlePageFinished;
  return {
    currentPage,
    totalPages,
    percent,
    hasProgress,
    isFinished: hasProgress && (singlePageFinished || percent >= 98 || currentPage >= totalPages - 1)
  };
}

function renderContinueStrip() {
  if (!elements.continueStrip) return;

  const readable = state.comics.filter(comic => comic && !comic.isDirectory && !isBuiltInDemoComic(comic));
  const candidates = readable
    .filter(comic => getProgressInfo(comic).hasProgress || isFavoriteId(comic.id))
    .sort((a, b) => {
      const ta = new Date(a.progress?.updatedAt || a.updatedAt).getTime();
      const tb = new Date(b.progress?.updatedAt || b.updatedAt).getTime();
      return tb - ta;
    })
    .slice(0, 5);

  const titleCounts = new Map();
  candidates.forEach(comic => titleCounts.set(comic.title, (titleCounts.get(comic.title) || 0) + 1));
  const contexts = new Map(candidates.map(comic => {
    const path = typeof comic.relativePath === 'string' ? comic.relativePath : '';
    const sourceId = getFolderTreeSourceId(comic);
    const sourceLabel = /^(?:local(?::|$)|external:|smb$)/.test(sourceId)
      ? getFolderTreeSourceLabel(sourceId) : '';
    const context = titleCounts.get(comic.title) > 1
      ? [sourceLabel, path].filter(Boolean).join(' · ') : '';
    return [comic.id, context];
  }));

  const renderSignature = candidates.map(comic => {
    const progress = getProgressInfo(comic);
    const favorite = isFavoriteId(comic.id);
    const displayPercent = progress.percent;
    return [
      comic.id,
      comic.title,
      contexts.get(comic.id),
      progress.currentPage,
      progress.totalPages,
      progress.percent,
      progress.hasProgress ? 'started' : 'unread',
      progress.isFinished ? 'finished' : '',
      displayPercent,
      comic.progress?.updatedAt || comic.updatedAt || '',
      favorite ? 'favorite' : ''
    ].join(':');
  }).join('|') || 'empty';
  if (renderSignature === lastContinueRenderSignature) return;
  lastContinueRenderSignature = renderSignature;

  if (candidates.length === 0) {
    if (elements.continuePanel) elements.continuePanel.hidden = true;
    elements.continueStrip.replaceChildren();
    return;
  }

  if (elements.continuePanel) elements.continuePanel.hidden = false;

  elements.continueStrip.innerHTML = candidates.map(comic => {
    const progress = getProgressInfo(comic);
    const favorite = isFavoriteId(comic.id);
    const displayPercent = progress.percent;
    return `
      <button class="continue-card" data-comic-id="${escapeHtml(comic.id)}" title="${escapeHtml([comic.title, contexts.get(comic.id)].filter(Boolean).join(' · '))}">
        <img src="${escapeHtml(getCoverUrl(comic.id))}" loading="lazy" decoding="async" fetchpriority="low" alt="" onerror="this.style.display='none';">
        <span class="continue-body">
          <strong>${escapeHtml(comic.title)}</strong>
          ${contexts.get(comic.id) ? `<small class="continue-context">${escapeHtml(contexts.get(comic.id))}</small>` : ''}
          <small>${progress.hasProgress ? readerText('第 {page} 頁', { page: progress.currentPage + 1 }) : readerText('已收藏')}</small>
          <span class="continue-progress"><span style="width: ${displayPercent}%"></span></span>
        </span>
        <i class="fa-solid ${favorite ? 'fa-heart' : 'fa-play'}"></i>
      </button>
    `;
  }).join('');

  elements.continueStrip.querySelectorAll('.continue-card').forEach(card => {
    card.addEventListener('click', () => openReader(card.dataset.comicId, { returnToComicFolder: true }));
  });
}

function inspectorRenderSignature(comic) {
  if (!comic) return '';
  const progress = getProgressInfo(comic);
  return [
    comic.id,
    comic.title,
    comic.series || '',
    comic.type || '',
    comic.pageCount || comic.comicsCount || 0,
    progress.currentPage,
    progress.totalPages,
    progress.percent,
    isComicOffline(comic) ? 'offline' : 'online',
    isFavoriteId(comic.id) ? 'favorite' : '',
    state.organizeMode ? 'organize' : 'browse',
  ].join(':');
}

function renderInspectorEmpty() {
  if (!elements.comicInspector) return;
  lastInspectorRenderSignature = '';
  elements.comicInspector.innerHTML = `
    <div class="inspector-empty">
      <span class="inspector-mark"><i class="fa-solid fa-book-open" aria-hidden="true"></i></span>
      <h3>${readerText('選一本漫畫')}</h3>
      <p>${readerText('封面、進度、標籤與快捷操作會顯示在這裡。')}</p>
    </div>`;
}

function ensureInspectorSelection({ skipUnchanged = false } = {}) {
  if (!elements.comicInspector) return;

  const selected = state.filteredComics.find(c => c.id === state.selectedComicId);
  if (selected) {
    renderComicInspector(selected, { keepSelection: true, skipUnchanged });
    return;
  }

  state.selectedComicId = null;
  if (state.libraryPanelsNarrow) applyInspectorCollapsed(true, { persist: false });
  renderInspectorEmpty();
}

function syncGridSelectionState() {
  elements.comicGrid?.querySelectorAll('.comic-card[data-comic-id]').forEach(card => {
    const selected = card.dataset.comicId === state.selectedComicId;
    card.classList.toggle('selected', selected);
    if (!state.organizeMode) card.setAttribute('aria-pressed', String(selected));
  });
}

function activateGridComic(comic) {
  if (!comic) return;
  if (state.organizeMode && !comic.isDirectory && !isBuiltInDemoComic(comic)) {
    toggleOrganizerSelection(comic.id);
    return;
  }

  if (state.selectedComicId === comic.id) {
    if (comic.isDirectory) {
      navigateLibraryToPath(comic.relativePath, comic.sourceId || '');
    } else {
      openReader(comic.id);
    }
    return;
  }

  renderComicInspector(comic);
  syncGridSelectionState();
  if (state.libraryPanelsNarrow) applyInspectorCollapsed(false, { persist: false });
}

function renderComicInspector(comic, options = {}) {
  if (!elements.comicInspector || !comic) return;
  if (!options.keepSelection) state.selectedComicId = comic.id;
  const renderSignature = inspectorRenderSignature(comic);
  if (options.skipUnchanged && renderSignature === lastInspectorRenderSignature) return;
  lastInspectorRenderSignature = renderSignature;

  const isDirectory = Boolean(comic.isDirectory);
  const builtInDemo = isBuiltInDemoComic(comic);
  const photoAlbum = isPhotoAlbum(comic);
  const sourceOffline = isComicOffline(comic);
  const progress = getProgressInfo(comic);
  const format = photoAlbum
    ? readerText('照片相簿')
    : builtInDemo
      ? readerText('風景選集')
      : isDirectory
        ? readerText('目錄')
        : isLooseImage(comic)
          ? readerText('圖片檔案')
          : (String(comic.type || '').includes('archive')
            ? ({ '.7z': '7z', '.cb7': 'CB7/7z', '.rar': 'RAR', '.cbr': 'CBR/RAR' }[String(comic.ext || '').toLowerCase()] || 'CBZ/ZIP')
            : readerText('圖片資料夾'));
  const favorite = !isDirectory && !builtInDemo && isFavoriteId(comic.id);
  const coverId = comic.coverComicId || comic.id;

  elements.comicInspector.innerHTML = `
    ${builtInDemo ? `
      <div class="inspector-cover builtin-demo-cover">
        <img src="${escapeHtml(getCoverUrl(comic.id))}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}">
        <div class="inspector-shine"></div>
      </div>
    ` : `
      <div class="inspector-cover">
        <img src="${escapeHtml(getCoverUrl(coverId))}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}" onerror="this.style.display='none';">
        <div class="inspector-shine"></div>
      </div>
    `}
    <div class="inspector-body">
      ${builtInDemo || photoAlbum ? '' : `<button class="organize-toggle inspector-organize-action ${state.organizeMode ? 'active' : ''}" type="button" data-inspector-action="organize" aria-pressed="${state.organizeMode}" title="${readerText('批次整理 TAG 與書籍資料')}">
        <i class="fa-solid fa-tags" aria-hidden="true"></i>
        ${readerText('批次整理 TAG 與書籍資料')}
      </button>`}
      <span class="section-kicker">${format}</span>
      <h3 title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</h3>
      <div class="inspector-tags">
        <span>${escapeHtml(comic.series || readerText('未分類'))}</span>
        <span>${formatPageCount(progress.totalPages || comic.comicsCount || '---')}</span>
        <span>${builtInDemo ? readerText('不寫入收藏') : sourceOffline ? readerText('來源離線') : progress.isFinished ? readerText('已看完') : progress.hasProgress ? readerText('閱讀中') : readerText('未讀')}</span>
      </div>
      <div class="inspector-progress">
        <div>
          <strong>${progress.percent}%</strong>
          <small>${progress.hasProgress ? readerText('第 {page} 頁', { page: progress.currentPage + 1 }) : readerText('尚未開始')}</small>
        </div>
        <span><span style="width: ${progress.percent}%"></span></span>
      </div>
      <div class="inspector-actions">
        <button class="inspector-primary" data-inspector-action="open" data-comic-id="${escapeHtml(comic.id)}">
          <i class="fa-solid ${sourceOffline || isDirectory ? 'fa-folder-open' : 'fa-book-open-reader'}"></i>
          ${builtInDemo ? readerText('開啟風景選集') : sourceOffline ? readerText('檢查漫畫目錄') : isDirectory ? readerText('打開目錄') : readerText('開始閱讀')}
        </button>
        ${isDirectory || builtInDemo ? '' : `
          <button class="inspector-icon ${favorite ? 'active' : ''}" data-inspector-action="favorite" title="${readerText(favorite ? '取消收藏' : '加入收藏')}" aria-label="${readerText(favorite ? '取消收藏' : '加入收藏')}">
            <i class="${favorite ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
          </button>
        `}
      </div>
      ${isDirectory || builtInDemo || photoAlbum ? '' : `
        <button class="inspector-file-toggle" type="button" data-inspector-action="files" aria-expanded="false">
          <i class="fa-solid fa-folder-tree" aria-hidden="true"></i>
          <span><strong>${readerText('檔案管理')}</strong><small>${readerText('開啟位置、改名、移動或可復原移除')}</small></span>
        </button>
        <section class="inspector-file-panel" aria-label="${readerText('漫畫檔案管理')}" hidden>
          <div class="inspector-file-buttons">
            <button type="button" data-file-action="reveal" ${canShowFileLocation(comic) ? '' : 'hidden'}><i class="fa-solid fa-folder-open"></i> ${readerText('開啟位置')}</button>
            <button type="button" data-file-action="rename"><i class="fa-solid fa-pen"></i> ${readerText('改名')}</button>
            <button type="button" data-file-action="move"><i class="fa-solid fa-folder-tree"></i> ${readerText('移動')}</button>
            <button type="button" data-file-action="trash" class="danger"><i class="fa-solid fa-box-archive"></i> ${readerText('移到隔離區')}</button>
            <button type="button" data-file-action="undo" disabled><i class="fa-solid fa-rotate-left"></i> ${readerText('撤銷上次操作')}</button>
          </div>
          <p class="inspector-file-status" role="status" aria-live="polite">${readerText('正在檢查來源能力…')}</p>
        </section>
      `}
      ${isDirectory || builtInDemo || photoAlbum ? '' : `
        <button class="inspector-ai-action" type="button" data-inspector-action="ai-suggest" aria-expanded="false">
          <i class="fa-solid fa-tags" aria-hidden="true"></i>
          <span><strong>${readerText('AI 掃描')}</strong><small>${readerText('取樣開頭三頁與 40%、50%、60% 位置；建議需人工確認')}</small></span>
        </button>
        <div class="inspector-ai-results" role="status" aria-live="polite" hidden></div>
      `}
      ${isDirectory || builtInDemo || photoAlbum ? '' : `<section class="metadata-section" id="inspector-metadata"><p class="metadata-loading">${readerText('正在讀取 SQLite metadata…')}</p></section>`}
    </div>
  `;

  const openBtn = elements.comicInspector.querySelector('[data-inspector-action="open"]');
  if (openBtn) {
    openBtn.onclick = () => {
      if (builtInDemo) {
        openReader(comic.id);
      } else if (sourceOffline) {
        openSettingsForRecovery();
      } else if (isDirectory) {
        navigateLibraryToPath(comic.relativePath, comic.sourceId || '');
      } else {
        openReader(comic.id);
      }
    };
  }

  const organizeBtn = elements.comicInspector.querySelector('[data-inspector-action="organize"]');
  if (organizeBtn) organizeBtn.onclick = () => setOrganizeMode(!state.organizeMode);

  const favoriteBtn = elements.comicInspector.querySelector('[data-inspector-action="favorite"]');
  if (favoriteBtn) {
    favoriteBtn.onclick = async () => {
      if (!eAPI?.toggleFavorite) return;
      setFavorites(await eAPI.toggleFavorite(comic.id));
      renderComicInspector(comic, { keepSelection: true });
      renderContinueStrip();
      if (state.activeFilter === 'favorite') filterAndRenderGrid();
    };
  }
  const aiSuggestBtn = elements.comicInspector.querySelector('[data-inspector-action="ai-suggest"]');
  const aiResults = elements.comicInspector.querySelector('.inspector-ai-results');
  if (aiSuggestBtn && aiResults) {
    aiSuggestBtn.onclick = () => suggestInspectorMetadata(comic, aiSuggestBtn, aiResults);
  }
  const fileToggle = elements.comicInspector.querySelector('[data-inspector-action="files"]');
  const filePanel = elements.comicInspector.querySelector('.inspector-file-panel');
  if (fileToggle && filePanel) {
    fileToggle.onclick = () => {
      const open = filePanel.hidden;
      filePanel.hidden = !open;
      fileToggle.setAttribute('aria-expanded', String(open));
      if (open) {
        prepareInspectorFilePanel(comic, filePanel);
        requestAnimationFrame(() => filePanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      }
    };
  }
  if (!isDirectory && !builtInDemo && !photoAlbum) loadInspectorMetadata(comic);
}

async function prepareInspectorFilePanel(comic, panel) {
  const status = panel.querySelector('.inspector-file-status');
  const buttons = Object.fromEntries([...panel.querySelectorAll('[data-file-action]')].map(button => [button.dataset.fileAction, button]));
  const setBusy = busy => Object.values(buttons).forEach(button => { if (button.dataset.fileAction !== 'undo') button.disabled = busy; });
  if (!eAPI?.getFileCapability) {
    status.textContent = readerText('檔案管理需要最新版 Tauri App；網頁預覽不會修改檔案。');
    setBusy(true);
    if (buttons.undo) buttons.undo.disabled = true;
    return;
  }
  try {
    const capability = await eAPI.getFileCapability(comic.id);
    buttons.reveal.hidden = !canShowFileLocation(comic);
    buttons.reveal.disabled = !capability.canReveal;
    buttons.rename.disabled = !capability.canRename;
    buttons.move.disabled = !capability.canMove;
    buttons.trash.disabled = !capability.canTrash;
    buttons.undo.disabled = !state.lastFileUndoToken;
    panel.dataset.expectedFingerprint = capability.expectedFingerprint || '';
    status.textContent = localizeFileCapabilityReason(capability.reason) || readerText('{source}來源可安全修改；移除會先進隔離區。', {
      source: capability.sourceKind === 'smb' ? 'NAS' : readerText('本機'),
    });
    for (const [action, button] of Object.entries(buttons)) {
      button.onclick = () => runInspectorFileAction(comic, panel, action);
    }
  } catch (error) {
    setBusy(true);
    if (buttons.undo) buttons.undo.disabled = true;
    status.textContent = readerText('無法檢查檔案能力：{error}', { error: error?.message || error });
  }
}

async function runInspectorFileAction(comic, panel, action) {
  const status = panel.querySelector('.inspector-file-status');
  const buttons = [...panel.querySelectorAll('[data-file-action]')];
  try {
    if (action === 'reveal') {
      await eAPI.showItemInFolder(comic.id);
      status.textContent = readerText('已在檔案管理器顯示漫畫位置。');
      return;
    }
    if (action === 'undo') {
      if (!state.lastFileUndoToken) return;
      buttons.forEach(button => { button.disabled = true; });
      await eAPI.undoComicFileOperation(state.lastFileUndoToken);
      state.lastFileUndoToken = null;
      status.textContent = readerText('已還原上次檔案操作。');
      await fetchLibrary();
      return;
    }
    let destinationRelativePath = null;
    if (action === 'rename') {
      const currentName = String(comic.relativePath || comic.title).split('/').pop();
      destinationRelativePath = window.prompt(readerText('輸入新檔名（保留 .cbz／.zip 副檔名）：'), currentName);
      if (!destinationRelativePath) return;
    } else if (action === 'move') {
      destinationRelativePath = window.prompt(readerText('輸入漫畫書庫內的目的相對路徑（包含檔名）：'), comic.relativePath || '');
      if (!destinationRelativePath || destinationRelativePath === comic.relativePath) return;
    } else if (action === 'trash') {
      if (!window.confirm(readerText('要將「{title}」移到可復原隔離區嗎？\n不會直接永久刪除。', { title: comic.title }))) return;
    }
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = action === 'trash' ? readerText('正在移到隔離區…') : readerText('正在安全更新檔案位置…');
    const result = await eAPI.mutateComicFile({
      comicId: comic.id,
      action,
      destinationRelativePath,
      expectedFingerprint: panel.dataset.expectedFingerprint || null,
    });
    state.lastFileUndoToken = result.undoToken;
    status.textContent = `${readerText(action === 'trash' ? '已移到隔離區' : action === 'rename' ? '已改名' : '已移動')}；${readerText('可在此撤銷。')}`;
    await fetchLibrary();
  } catch (error) {
    status.textContent = readerText('檔案操作失敗：{error}', { error: error?.message || error });
  }
}

function formatReadingDirection(direction) {
  const labels = {
    ltr: readerText('由左至右'),
    rtl: readerText('由右至左'),
    vertical: readerText('條漫直向'),
  };
  const normalized = String(direction || '').trim().toLowerCase();
  return labels[normalized] || (normalized ? direction : '—');
}

async function loadInspectorMetadata(comic) {
  const target = elements.comicInspector?.querySelector('#inspector-metadata');
  if (!target || !eAPI?.getComicMetadata) {
    if (target) target.innerHTML = `<p class="metadata-loading">${readerText('重新掃描後即可建立整理資料。')}</p>`;
    return;
  }
  const requestedId = comic.id;
  try {
    const [metadata, suggestions] = await Promise.all([
      eAPI.getComicMetadata(requestedId),
      eAPI.listRelatedTags ? eAPI.listRelatedTags(requestedId, 8) : Promise.resolve([]),
    ]);
    if (state.selectedComicId !== requestedId) return;
    const currentTarget = elements.comicInspector?.querySelector('#inspector-metadata');
    if (!currentTarget) return;
    const creators = Object.entries(metadata.creators || {}).flatMap(([role, names]) => names.map(name => `${role}:${name}`));
    const tags = metadata.tags || [];
    const sourceNames = [...new Set((metadata.candidates || []).map(candidate => candidate.parserId))];
    const lock = field => (metadata.lockedFields || []).includes(field) ? ` <span class="metadata-lock" title="${readerText('使用者覆寫')}">${readerText('鎖定')}</span>` : '';
    const rows = [
      [readerText('標題'), metadata.title, 'title'],
      [readerText('系列'), metadata.series || '—', 'series'],
      [readerText('作者'), creators.join('、') || '—', 'creators'],
      [readerText('語言'), metadata.language || '—', 'language'],
      [readerText('閱讀方向'), formatReadingDirection(metadata.readingDirection), 'reading_direction'],
      [readerText('來源'), sourceNames.join('、') || readerText('檔名推測'), 'sources'],
      [readerText('狀態'), metadata.offline ? readerText('NAS／來源離線，資料已保留') : readerText('來源在線'), 'offline'],
    ];
    currentTarget.innerHTML = `
      <h4>${readerText('整理資料')}</h4>
      <div class="metadata-tag-chips" aria-label="${readerText('作品標籤')}">
        ${tags.length ? tags.map(tag => {
          const normalized = String(tag.value).normalize('NFKC').toLocaleLowerCase();
          const inventory = state.tagInventoryItems.find(item => item.namespace === tag.namespace && item.normalizedValue === normalized);
          return `<span class="metadata-tag-chip" data-tag-color="${tagColorKey(inventory || tag)}">${escapeHtml(tag.namespace)}:${escapeHtml(tag.value)}</span>`;
        }).join('') : `<span class="metadata-loading">${readerText('尚無標籤')}</span>`}
      </div>
      <dl>${rows.map(([label, value, field]) => `<div class="metadata-row"><dt>${label}</dt><dd>${escapeHtml(String(value))}${lock(field)}</dd></div>`).join('')}</dl>
      ${(suggestions || []).length ? `
        <section class="metadata-suggestions" aria-labelledby="metadata-suggestions-title">
          <h5 id="metadata-suggestions-title">${readerText('相關標籤建議')}</h5>
          <p>${readerText('依收藏中的共同標籤提出；只有按下後才會套用。')}</p>
          <div class="metadata-suggestion-list">
            ${suggestions.map(item => `<button type="button" class="metadata-suggestion" data-suggest-namespace="${escapeHtml(item.tag.namespace)}" data-suggest-value="${escapeHtml(item.tag.value)}" title="${escapeHtml(item.reason)}">＋ ${escapeHtml(item.tag.namespace)}:${escapeHtml(item.tag.value)} <small>${item.sharedComics}</small></button>`).join('')}
          </div>
        </section>` : ''}
      ${(metadata.diagnostics || []).slice(0, 3).map(item => `<p class="metadata-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(item.message)}</p>`).join('')}
    `;
    currentTarget.querySelectorAll('.metadata-suggestion').forEach(button => {
      button.addEventListener('click', async () => {
        if (!eAPI?.applyBatchMetadata) return;
        button.disabled = true;
        try {
          await eAPI.applyBatchMetadata({
            comicIds: [requestedId],
            fields: {},
            addTags: [{ namespace: button.dataset.suggestNamespace, value: button.dataset.suggestValue }],
            excludeTags: [],
          });
          await loadInspectorMetadata(comic);
        } catch (error) {
          button.disabled = false;
          button.title = error?.message || String(error);
        }
      });
    });
  } catch (error) {
    if (state.selectedComicId !== requestedId) return;
    const currentTarget = elements.comicInspector?.querySelector('#inspector-metadata');
    if (currentTarget) currentTarget.innerHTML = `<p class="metadata-warning">${readerText('metadata 尚未建立：{error}', { error: escapeHtml(error?.message || String(error)) })}</p>`;
  }
}

// 搜尋過濾
function handleSearch(e) {
  const query = e.target.value.trim();
  elements.clearSearchBtn.style.display = query ? 'block' : 'none';
  state.renderLimit = 200;
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(() => refreshCatalogSearch(query), 180);
  filterAndRenderGrid();
}

function compareShelfItems(left, right) {
  const leftDemo = isBuiltInDemoComic(left);
  const rightDemo = isBuiltInDemoComic(right);
  if (leftDemo !== rightDemo) return leftDemo ? 1 : -1;
  if (leftDemo && rightDemo) {
    return (Number(left.demoOrder) || 0) - (Number(right.demoOrder) || 0);
  }
  return comicTitleCollator.compare(String(left.title || ''), String(right.title || ''));
}

function getLibraryFilteredComics() {
  const curSourceId = normalizeDirectorySourceId(state.currentSourceId);
  const hasFormalComic = state.comics.some(comic => comic && !isBuiltInDemoComic(comic));
  return state.comics.filter(comic => {
    if (hasFormalComic && isBuiltInDemoComic(comic)) return false;
    if (curSourceId && getComicSourceKey(comic) !== curSourceId) return false;
    if (isBuiltInDemoComic(comic) && state.activeFilter === 'favorite') return false;
    // 側邊欄系列過濾
    if (state.activeSeries !== 'all') {
      if (comic.series !== state.activeSeries) return false;
    }

    // 狀態過濾 (全部/閱讀中/未讀/已讀完)
    const progress = getProgressInfo(comic);
    const isStarted = progress.hasProgress;
    const isFinished = progress.isFinished;

    if (state.activeFilter === 'reading') {
      return isStarted && !isFinished;
    } else if (state.activeFilter === 'unread') {
      return !isStarted;
    } else if (state.activeFilter === 'finished') {
      return isFinished;
    } else if (state.activeFilter === 'favorite') {
      return isFavoriteId(comic.id);
    }

    return true;
  });
}

function comicMatchesLibrarySearch(comic, query) {
  const matches = [comic.title, comic.relativePath, comic.series]
    .some(value => String(value || '').toLowerCase().includes(query));
  if (isBuiltInDemoComic(comic)) return matches;
  const metadata = state.catalogSearchItems.get(comic.id);
  const matchMetadata = metadata ? JSON.stringify(metadata).toLowerCase().includes(query) : false;
  return (!state.catalogSearchIds || state.catalogSearchIds.has(comic.id)) && (matches || matchMetadata);
}

function getDiscoveryCandidates() {
  const query = elements.searchInput.value.toLowerCase().trim();
  const path = normalizeDirectoryPath(state.currentPath);
  return getLibraryFilteredComics().filter(comic => {
    if (!comic.id || comic.isDirectory || isComicOffline(comic)) return false;
    if (query) return !state.catalogSearchItems.get(comic.id)?.offline && comicMatchesLibrarySearch(comic, query);
    const relativePath = normalizeDirectoryPath(comic.relativePath);
    return !path || relativePath === path || relativePath.startsWith(path + '/');
  });
}

function pickDiscoveryComic(candidates, previousId, random = Math.random) {
  if (!candidates.length) return null;
  const different = candidates.filter(comic => comic.id !== previousId);
  const choices = different.length ? different : candidates;
  return choices[Math.floor(random() * choices.length)];
}

let discoveryOpening = false;
let lastDiscoveryComicId = null;
let discoveryTagGroups = [];
let discoveryTagScope = '';
let discoveryTagRequest = 0;
let discoveryTagsLoading = false;
let lastDiscoveryTagKey = '';

function discoveryScopeKey(candidates = getDiscoveryCandidates()) {
  return JSON.stringify(candidates.map(comic => comic.id).sort());
}

function closeDiscoveryTags() {
  discoveryTagRequest++;
  discoveryTagsLoading = false;
  if (elements.libraryTagDiscoveryPanel) elements.libraryTagDiscoveryPanel.hidden = true;
  elements.libraryTagDiscoveryBtn?.setAttribute('aria-expanded', 'false');
}

function syncDiscoveryTagButtons() {
  const disabled = discoveryOpening || discoveryTagsLoading || !discoveryTagGroups.length;
  for (const element of [elements.discoveryTagSelect, elements.discoveryTagPick, elements.discoveryTagRandom]) {
    if (element) element.disabled = disabled;
  }
}

function normalizeDiscoveryTagGroups(groups, candidates) {
  const allowed = new Set(candidates.map(comic => comic.id));
  const merged = new Map();
  for (const group of groups) {
    if (!group || typeof group.namespace !== 'string' || typeof group.value !== 'string') continue;
    const key = JSON.stringify([group.namespace, group.value]);
    if (!merged.has(key)) merged.set(key, { namespace: group.namespace, value: group.value, comicIds: new Set() });
    for (const id of group.comicIds || []) if (allowed.has(id)) merged.get(key).comicIds.add(id);
  }
  return [...merged.values()].filter(group => group.comicIds.size)
    .map(group => ({ ...group, comicIds: [...group.comicIds] }))
    .sort((a, b) => comicTitleCollator.compare(`${a.namespace}:${a.value}`, `${b.namespace}:${b.value}`));
}

async function toggleDiscoveryTags() {
  if (!elements.libraryTagDiscoveryPanel || discoveryOpening) return;
  if (!elements.libraryTagDiscoveryPanel.hidden) { closeDiscoveryTags(); return; }
  elements.libraryTagDiscoveryPanel.hidden = false;
  elements.libraryTagDiscoveryBtn?.setAttribute('aria-expanded', 'true');
  const request = ++discoveryTagRequest;
  const candidates = getDiscoveryCandidates().filter(comic => !isBuiltInDemoComic(comic));
  discoveryTagScope = discoveryScopeKey();
  discoveryTagGroups = [];
  discoveryTagsLoading = true;
  syncDiscoveryTagButtons();
  elements.discoveryTagStatus.textContent = readerText('正在找目前範圍的標籤…');
  try {
    if (!eAPI?.getDiscoveryTags) throw new Error('Discovery tags require the current native backend');
    const groups = [];
    // Bound each IPC payload; the native worker reads indexed tags without
    // touching comic files or hydrating a full metadata object per book.
    for (let offset = 0; offset < candidates.length; offset += 1000) {
      if (request !== discoveryTagRequest) return;
      groups.push(...await eAPI.getDiscoveryTags(candidates.slice(offset, offset + 1000).map(comic => comic.id)));
    }
    if (request !== discoveryTagRequest || discoveryTagScope !== discoveryScopeKey()) return;
    discoveryTagGroups = normalizeDiscoveryTagGroups(groups, candidates);
    elements.discoveryTagSelect.innerHTML = discoveryTagGroups.map((group, index) => (
      `<option value="${index}">${escapeHtml(group.namespace)}:${escapeHtml(group.value)} · ${group.comicIds.length}</option>`
    )).join('');
    elements.discoveryTagStatus.textContent = readerText(discoveryTagGroups.length
      ? '選一個 TAG 抽一本，或讓運氣替你選類型。'
      : '目前範圍還沒有可用標籤。開啟標籤工具，先幫漫畫加一個吧！');
  } catch (error) {
    if (request !== discoveryTagRequest) return;
    console.warn('探索標籤暫不可用：', error);
    elements.discoveryTagStatus.textContent = readerText('標籤暫時讀不到，請稍後重試；仍可使用隨手翻一本。');
  } finally {
    if (request === discoveryTagRequest) {
      discoveryTagsLoading = false;
      syncDiscoveryTagButtons();
    }
  }
}

function pickDiscoveryTag(groups, previousKey, random = Math.random) {
  const other = groups.filter(group => JSON.stringify([group.namespace, group.value]) !== previousKey);
  const pool = other.length ? other : groups;
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}

async function openDiscoveryTag(randomTag, random = Math.random) {
  if (discoveryOpening || discoveryTagsLoading || elements.libraryTagDiscoveryPanel?.hidden) return;
  if (discoveryTagScope !== discoveryScopeKey()) { closeDiscoveryTags(); return; }
  const group = randomTag ? pickDiscoveryTag(discoveryTagGroups, lastDiscoveryTagKey, random)
    : discoveryTagGroups[Number(elements.discoveryTagSelect.value)];
  if (!group) return;
  const ids = new Set(group.comicIds);
  const candidates = getDiscoveryCandidates().filter(comic => ids.has(comic.id));
  elements.discoveryTagStatus.textContent = readerText('本次抽到：{tag}', { tag: `${group.namespace}:${group.value}` });
  if (await openDiscoveryComic(random, candidates)) lastDiscoveryTagKey = JSON.stringify([group.namespace, group.value]);
}

function syncDiscoveryButton() {
  if (!elements.libraryDiscoveryBtn) return;
  elements.libraryDiscoveryBtn.disabled = discoveryOpening || !state.filteredComics.some(comic => (
    !isComicOffline(comic) && (!comic.isDirectory || comic.comicsCount > 0)
  ));
  syncDiscoveryTagButtons();
}

function setDiscoveryStatus(message = '') {
  if (!elements.libraryDiscoveryStatus) return;
  elements.libraryDiscoveryStatus.textContent = message;
  elements.libraryDiscoveryStatus.hidden = !message;
}

async function openDiscoveryComic(random = Math.random, candidates = getDiscoveryCandidates()) {
  if (discoveryOpening || state.currentComic || state.pendingComicId) return false;
  setDiscoveryStatus();
  const chosen = pickDiscoveryComic(candidates, lastDiscoveryComicId, random);
  if (!chosen) {
    setDiscoveryStatus(readerText('目前範圍沒有可讀漫畫，試著換個資料夾或清除篩選。'));
    return false;
  }
  discoveryOpening = true;
  syncDiscoveryButton();
  try {
    await openReader(chosen.id);
    if (state.currentComic?.id === chosen.id) lastDiscoveryComicId = chosen.id;
    else setDiscoveryStatus(readerText('這本暫時打不開，請換一本或檢查來源。'));
    return state.currentComic?.id === chosen.id;
  } catch (error) {
    console.warn('隨機試讀無法開啟：', error);
    setDiscoveryStatus(readerText('這本暫時打不開，請換一本或檢查來源。'));
    return false;
  } finally {
    discoveryOpening = false;
    syncDiscoveryButton();
  }
}

// 一般導航仍只顯示目前目錄這一層；隨機試讀可選取其下已載入的作品。
function getDirectoryItems() {
  const curPath = state.currentPath;
  const curSourceId = normalizeDirectorySourceId(state.currentSourceId);
  const itemsMap = new Map();
  const filesList = [];
  const baseFiltered = getLibraryFilteredComics();

  // 2. 如果使用者正在使用關鍵字搜尋，則退化為「扁平全庫搜尋」，體驗最佳！
  const query = elements.searchInput.value.toLowerCase().trim();
  if (query) {
    return baseFiltered.filter(comic => comicMatchesLibrarySearch(comic, query)).map(c => {
      const metadata = state.catalogSearchItems.get(c.id);
      return { ...c, title: metadata?.title || c.title, series: metadata?.series || c.series, metadataTags: metadata?.tags || [], offline: metadata?.offline || false, isDirectory: false };
    }).sort(compareShelfItems);
  }

  if (state.activeSeries === 'all' && state.activeFilter === 'all'
    && state.visibleDirectoryGeneration === Number(state.scanStatus?.generation)) {
    const leafImageFolders = getLeafReadableImageFolderPaths(false);
    const isLeafImageFolder = (sourceId, path) => {
      const key = getDirectoryLocationKey(sourceId, path);
      if (leafImageFolders.has(key)) return true;
      if (sourceId) return false;
      return [...leafImageFolders].some(item => item.endsWith(`\u0000${path}`));
    };
    for (const entry of getVisibleDirectoryEntries(curSourceId, curPath)) {
      const folderPath = normalizeDirectoryPath(entry.path);
      const folderSourceId = normalizeDirectorySourceId(entry.sourceId || curSourceId);
      if (isLeafImageFolder(folderSourceId, folderPath)) continue;
      const folderName = folderPath.split('/').pop();
      if (!folderName) continue;
      const existing = itemsMap.get(folderPath) || {
        id: 'folder-' + btoa(unescape(encodeURIComponent(`${folderSourceId}\u0000${folderPath}`))),
        title: folderName,
        type: 'folder',
        relativePath: folderPath,
        sourceId: folderSourceId,
        isDirectory: true,
        coverComicId: null,
        comicsCount: 0,
        sourceIds: new Set(),
      };
      if (folderSourceId) existing.sourceIds.add(folderSourceId);
      else existing.hasUnknownSource = true;
      itemsMap.set(folderPath, existing);
    }
  }

  // 3. 一般目錄導航模式：對漫畫相對路徑相對當前層進行折疊與過濾
  baseFiltered.forEach(comic => {
    const rel = typeof comic.relativePath === 'string' ? comic.relativePath : '';
    let isUnder = false;
    let subPart = "";

    if (curPath === "") {
      isUnder = true;
      subPart = rel;
    } else if (rel.startsWith(curPath + "/")) {
      isUnder = true;
      subPart = rel.substring(curPath.length + 1);
    }

    if (isUnder && subPart !== "") {
      const parts = subPart.split('/');
      if (parts.length === 1) {
        // 直屬此資料夾的漫畫項目
        filesList.push({
          ...comic,
          isDirectory: false
        });
      } else {
        // 更深層的資料夾，折疊成虛擬資料夾
        const folderName = parts[0];
        const folderPath = curPath === "" ? folderName : curPath + "/" + folderName;

        const folderKey = folderPath;
        if (!itemsMap.has(folderKey)) {
          itemsMap.set(folderKey, {
            id: 'folder-' + btoa(unescape(encodeURIComponent(`${curSourceId || getComicSourceKey(comic)}\u0000${folderPath}`))), // btoa 安全編碼作為 ID
            title: folderName,
            type: 'folder',
            relativePath: folderPath,
            sourceId: curSourceId || getComicSourceKey(comic),
            isDirectory: true,
            coverComicId: comic.id, // 用該目錄下第一本書的封面！
            comicsCount: 1,
            sourceIds: new Set(getComicSourceKey(comic) ? [getComicSourceKey(comic)] : []),
          });
        } else {
          const folder = itemsMap.get(folderKey);
          if (!folder.coverComicId) folder.coverComicId = comic.id;
          folder.comicsCount++;
          const sourceId = getComicSourceKey(comic);
          if (sourceId) folder.sourceIds.add(sourceId);
        }
      }
    }
  });

  // Once this exact source/path has a filesystem snapshot, catalog rows from
  // an older scan cannot resurrect folders that no longer exist there.
  if (curSourceId) {
    const visibleChildren = state.visibleDirectories.get(getVisibleDirectoryMapKey(curSourceId, curPath));
    if (Array.isArray(visibleChildren)) {
      const allowed = new Set(visibleChildren);
      for (const [path] of itemsMap) {
        if (!allowed.has(path)) itemsMap.delete(path);
      }
    }
  }

  itemsMap.forEach(folder => {
    const sourceIds = [...(folder.sourceIds || [])];
    if (sourceIds.length === 1) folder.sourceId = sourceIds[0];
    else if (sourceIds.length > 1) folder.sourceId = '';
    folder.sourceIds = sourceIds;
  });

  // 本地化自然排序 ( numeric: true )，這對漫畫卷數 (Vol.2, Vol.10) 排序極度友善！
  const directories = Array.from(itemsMap.values()).sort((a, b) => comicTitleCollator.compare(a.title, b.title));
  const files = filesList.sort(compareShelfItems);

  // 正式書庫一旦有內容就收起示範；空書庫才在根目錄提供試讀。
  // 進入實體子目錄後，示範也不會混入其中。
  if (curPath === '') {
    return [
      ...directories,
      ...files.filter(comic => !isBuiltInDemoComic(comic)),
      ...files.filter(isBuiltInDemoComic),
    ];
  }

  return [...directories, ...files];
}

// 核心過濾與渲染漫畫書架
function filterAndRenderGrid(options = {}) {
  syncLibraryUpButton();
  // 1. 取得目前路徑下的項目
  state.filteredComics = getDirectoryItems();
  if (elements.libraryTagDiscoveryPanel && !elements.libraryTagDiscoveryPanel.hidden
    && discoveryTagScope !== discoveryScopeKey()) closeDiscoveryTags();
  setDiscoveryStatus();
  syncDiscoveryButton();

  // 2. 渲染麵包屑路徑導航列 (由青梅竹馬姬米妮為主人貼心打造 ✨)
  if (state.currentPath === "") {
    elements.folderBreadcrumbs.style.display = 'none';
  } else {
    elements.folderBreadcrumbs.style.display = 'flex';
    elements.folderBreadcrumbs.innerHTML = '';

    // 「首頁」麵包屑
    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'breadcrumb-button';
    homeBtn.innerHTML = `<i class="fa-solid fa-house" style="font-size: 12px; color: var(--accent);"></i> ${readerText('首頁')}`;
    homeBtn.style.cursor = 'pointer';
    homeBtn.style.fontWeight = '600';
    homeBtn.style.color = 'var(--text-light)';
    homeBtn.onclick = () => {
      navigateLibraryToPath('', '');
    };
    elements.folderBreadcrumbs.appendChild(homeBtn);

    // 每一層子目錄路徑
    const parts = state.currentPath.split('/');
    let accumPath = "";
    parts.forEach((part, index) => {
      accumPath = accumPath === "" ? part : accumPath + "/" + part;

      const separator = document.createElement('span');
      separator.innerHTML = `<i class="fa-solid fa-chevron-right" style="font-size: 9px; color: var(--text-dark);"></i>`;
      separator.style.margin = '0 4px';
      elements.folderBreadcrumbs.appendChild(separator);

      const pathBtn = document.createElement(index === parts.length - 1 ? 'span' : 'button');
      pathBtn.textContent = part;

      if (index === parts.length - 1) {
        pathBtn.style.fontWeight = '600';
        pathBtn.style.color = 'var(--accent)';
      } else {
        pathBtn.type = 'button';
        pathBtn.className = 'breadcrumb-button';
        pathBtn.style.color = 'var(--text-light)';
        const targetPath = accumPath; // 閉包保留
        pathBtn.onclick = () => {
          navigateLibraryToPath(targetPath, state.currentSourceId);
        };
      }
      elements.folderBreadcrumbs.appendChild(pathBtn);
    });
  }

  renderGrid(options);
  ensureInspectorSelection({ skipUnchanged: Boolean(options.skipUnchanged) });
}

function getShelfCardRenderKey(comic) {
  if (comic.isDirectory) {
    return [
      'dir',
      comic.id,
      comic.title,
      comic.relativePath,
      comic.sourceId,
      (comic.sourceIds || []).join(','),
      comic.coverComicId || '',
      comic.comicsCount || 0,
      isComicOffline(comic) ? 'offline' : 'online'
    ].join(':');
  }
  const progress = getProgressInfo(comic);
  return [
    comic.id,
    comic.title,
    comic.relativePath,
    comic.sourceId,
    comic.series,
    comic.type,
    comic.ext,
    comic.pageCount,
    progress.currentPage,
    progress.totalPages,
    progress.percent,
    progress.hasProgress ? 'started' : 'unread',
    progress.isFinished ? 'finished' : '',
    isComicOffline(comic) ? 'offline' : 'online',
    isFavoriteId(comic.id) ? 'favorite' : ''
  ].join(':');
}

function getShelfCardTagName(comic) {
  return (state.organizeMode && !comic.isDirectory ? 'BUTTON' : 'DIV');
}

function updateShelfCardState(card, comic) {
  if (!card) return;
  card.classList.toggle('source-offline', isComicOffline(comic));
  card.classList.toggle('selected', state.selectedComicId === comic.id);
  card.classList.toggle('organize-selectable', state.organizeMode && !comic.isDirectory);
  card.classList.toggle('organize-selected', state.organizeMode && state.organizeSelection.has(comic.id));
  if (isBuiltInDemoComic(comic)) {
    card.setAttribute('aria-pressed', 'false');
  } else if (!comic.isDirectory) {
    card.setAttribute('aria-pressed', String(state.organizeMode
      ? state.organizeSelection.has(comic.id)
      : state.selectedComicId === comic.id));
  }
}

function captureShelfFocus() {
  const active = document.activeElement;
  if (!active || !elements.comicGrid?.contains(active)) return null;
  const card = active.closest?.('.comic-card[data-comic-id]');
  if (!card?.dataset?.comicId) return null;
  return {
    comicId: card.dataset.comicId,
    favorite: active.classList?.contains('favorite-toggle-btn') || false,
  };
}

function captureLibraryFocus(target = document.activeElement) {
  if (!target) return null;
  const continueCard = target.closest?.('.continue-card[data-comic-id]');
  if (continueCard?.dataset?.comicId) {
    return { area: 'continue', comicId: continueCard.dataset.comicId };
  }
  const inspectorOpen = target.closest?.('[data-inspector-action="open"][data-comic-id]');
  if (inspectorOpen?.dataset?.comicId) {
    return { area: 'inspector', comicId: inspectorOpen.dataset.comicId };
  }
  return null;
}

function captureLibraryViewContext() {
  return {
    currentPath: state.currentPath,
    currentSourceId: state.currentSourceId || '',
    currentDirectory: getCurrentDirectoryLocation(),
    activeSeries: state.activeSeries,
    activeFilter: state.activeFilter,
    searchQuery: elements.searchInput?.value || '',
    selectedComicId: state.selectedComicId,
    scrollTop: Number.isFinite(elements.contentArea?.scrollTop) ? elements.contentArea.scrollTop : null,
    catalogSearchIds: state.catalogSearchIds ? new Set(state.catalogSearchIds) : null,
    catalogSearchItems: new Map(state.catalogSearchItems),
    catalogSearchTotal: state.catalogSearchTotal,
  };
}

function syncLibraryFilterControls() {
  if (elements.seriesFilterSelect) elements.seriesFilterSelect.value = state.activeSeries;
  elements.seriesFilterList?.querySelectorAll('li').forEach(item => {
    const selected = item.dataset.series === state.activeSeries;
    item.classList.toggle('active', selected);
    if (selected) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('.filter-btn').forEach(btn => {
    const selected = btn.dataset.filter === state.activeFilter;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
}

function restoreLibraryViewContext(context) {
  if (!context) return false;
  setCurrentDirectoryLocation(
    context.currentDirectory || {
      sourceId: context.currentSourceId || '',
      relativePath: typeof context.currentPath === 'string' ? context.currentPath : '',
    },
  );
  state.activeSeries = context.activeSeries || 'all';
  state.activeFilter = context.activeFilter || 'all';
  state.selectedComicId = context.selectedComicId || null;
  if (elements.searchInput) elements.searchInput.value = context.searchQuery || '';
  if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = context.searchQuery ? 'block' : 'none';
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = null;
  state.catalogSearchRequest += 1;
  state.catalogSearchIds = context.catalogSearchIds ? new Set(context.catalogSearchIds) : null;
  state.catalogSearchItems = new Map(context.catalogSearchItems || []);
  state.catalogSearchTotal = Number(context.catalogSearchTotal) || 0;
  syncLibraryFilterControls();
  visibleDirectoryNavigationEpoch += 1;
  requestVisibleDirectoryScan(state.currentPath, { sourceId: state.currentSourceId });
  filterAndRenderGrid();
  if (Number.isFinite(context.scrollTop) && elements.contentArea) {
    elements.contentArea.scrollTop = context.scrollTop;
  }
  return true;
}

function findLibraryFocusTarget(root, snapshot) {
  if (!root || !snapshot) return null;
  const visit = node => {
    if (!node) return null;
    if (node.dataset?.comicId === snapshot.comicId
      && ((snapshot.area === 'continue' && node.classList?.contains('continue-card'))
        || (snapshot.area === 'inspector' && node.dataset?.inspectorAction === 'open'))) {
      return node;
    }
    for (const child of node.children || []) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  return visit(root);
}

function restoreLibraryRefreshFocus() {
  const snapshot = state.libraryRefreshFocusSnapshot;
  if (!snapshot) return false;
  state.libraryRefreshFocusSnapshot = null;
  const root = snapshot.area === 'continue' ? elements.continueStrip : elements.comicInspector;
  const target = findLibraryFocusTarget(root, snapshot);
  if (!target || target.isConnected === false) return false;
  target.focus?.({ preventScroll: true });
  return true;
}

function restoreShelfFocus(snapshot) {
  if (!snapshot) return;
  const card = [...(elements.comicGrid?.children || [])]
    .find(item => item.dataset?.comicId === snapshot.comicId);
  const target = snapshot.favorite ? card?.querySelector('.favorite-toggle-btn') : card;
  target?.focus?.({ preventScroll: true });
}

// 繪製漫畫卡片網格
function renderGrid({ skipUnchanged = false, background = false } = {}) {
  if (state.filteredComics.length === 0) {
    const folderScanKey = getDirectoryLocationKey(state.currentSourceId, state.currentPath);
    const emptyFolder = Boolean(state.currentPath
      && !elements.searchInput?.value.trim()
      && state.activeFilter === 'all'
      && state.activeSeries === 'all'
      && state.visibleDirectoryScanCompleted.has(folderScanKey));
    const contextEmpty = Boolean(elements.searchInput?.value.trim()
      || state.activeFilter !== 'all'
      || state.activeSeries !== 'all'
      || state.currentPath);
    elements.emptyState.classList.toggle('is-filtered', contextEmpty);
    const title = elements.emptyState.querySelector('h3');
    const icon = elements.emptyState.querySelector('.empty-icon');
    if (title) {
      const label = emptyFolder ? '這層沒有可閱讀的圖片或支援的壓縮檔'
        : contextEmpty ? '這裡沒有符合的漫畫' : '書架尚無漫畫';
      title.dataset.i18n = label;
      title.textContent = readerText(label);
    }
    if (icon) icon.textContent = contextEmpty ? '🔎' : '📂';
    const libraryHint = document.getElementById('empty-library-hint');
    const filterHint = document.getElementById('empty-filter-hint');
    if (libraryHint) libraryHint.hidden = contextEmpty;
    if (filterHint) {
      const hint = emptyFolder
        ? '支援 ZIP／CBZ、7z／CB7、RAR／CBR；加密或損壞的檔案可能無法讀取。'
        : '試著清除搜尋、切換篩選，或回上一層資料夾。';
      filterHint.dataset.i18n = hint;
      filterHint.textContent = readerText(hint);
      filterHint.hidden = !contextEmpty;
    }
    lastGridRenderSignature = 'empty';
    coverObserver?.disconnect();
    coverObserver = null;
    resetCoverLoadQueue();
    elements.comicGrid.innerHTML = '';
    elements.emptyState.style.display = 'flex';
    if (elements.catalogLoadMore) elements.catalogLoadMore.hidden = true;
    return;
  }

  elements.emptyState.style.display = 'none';
  elements.emptyState.classList.remove('is-filtered');

  const visibleComics = state.filteredComics.slice(0, state.renderLimit);
  if (elements.catalogLoadMore) {
    const totalAvailable = state.catalogSearchIds ? Math.max(state.filteredComics.length, state.catalogSearchTotal) : state.filteredComics.length;
    elements.catalogLoadMore.hidden = visibleComics.length >= state.filteredComics.length && state.filteredComics.length >= totalAvailable;
    elements.catalogLoadMore.textContent = readerText('顯示更多漫畫（{shown} / {total}）', { shown: visibleComics.length, total: totalAvailable });
  }

  const renderSignature = [
    state.currentSourceId || '',
    state.currentPath,
    state.activeSeries,
    state.activeFilter,
    state.organizeMode ? 'organize' : 'browse',
    visibleComics.map(getShelfCardRenderKey).join('|')
  ].join('::');

  if (skipUnchanged && renderSignature === lastGridRenderSignature) return;
  lastGridRenderSignature = renderSignature;

  const existingCards = new Map(
    [...elements.comicGrid.children]
      .filter(card => card?.dataset?.comicId)
      .map(card => [card.dataset.comicId, card])
  );
  const focusSnapshot = captureShelfFocus();
  const scrollTop = Number.isFinite(elements.contentArea?.scrollTop) ? elements.contentArea.scrollTop : null;

  // 掃描進度、篩選器與背景刷新很常只改變卡片順序或選取狀態。沿用既有節點
  // 可以保留焦點、圖片 observer 與瀏覽器的圖片解碼快取，也避免 200 張卡片
  // 每次都觸發 replaceChildren 的長工作。
  const canReuseAll = visibleComics.length === existingCards.size
    && visibleComics.every(comic => {
      const card = existingCards.get(comic.id);
      return card
        && card.dataset.renderKey === getShelfCardRenderKey(comic)
        && card.tagName === getShelfCardTagName(comic);
    });
  if (canReuseAll) {
    const needsReorder = visibleComics.some((comic, index) => (
      existingCards.get(comic.id) !== elements.comicGrid.children[index]
    ));
    visibleComics.forEach(comic => {
      const card = existingCards.get(comic.id);
      updateShelfCardState(card, comic);
      // 只有順序真的變更時才移動節點；同順序刷新保持完全靜止。
      if (needsReorder) elements.comicGrid.appendChild(card);
    });
    elements.comicGrid.classList.toggle('background-refresh', background);
    restoreShelfFocus(focusSnapshot);
    if (scrollTop !== null) elements.contentArea.scrollTop = scrollTop;
    if (background) requestAnimationFrame(() => elements.comicGrid.classList.remove('background-refresh'));
    return;
  }

  coverObserver?.disconnect();
  coverObserver = null;
  resetCoverLoadQueue();
  elements.comicGrid.classList.toggle('background-refresh', background);
  const gridFragment = document.createDocumentFragment();

  visibleComics.forEach(comic => {
    const renderKey = getShelfCardRenderKey(comic);
    const expectedTagName = getShelfCardTagName(comic);
    const reusableCard = existingCards.get(comic.id);
    if (reusableCard
      && reusableCard.dataset.renderKey === renderKey
      && reusableCard.tagName === expectedTagName) {
      updateShelfCardState(reusableCard, comic);
      gridFragment.appendChild(reusableCard);
      return;
    }

    const sourceOffline = isComicOffline(comic);
    const card = document.createElement(expectedTagName.toLowerCase());
    if (card instanceof HTMLButtonElement) card.type = 'button';
    card.className = 'comic-card' + (comic.isDirectory ? ' folder-card' : '');
    if (sourceOffline) card.classList.add('source-offline');
    card.dataset.comicId = comic.id;
    if (state.selectedComicId === comic.id) card.classList.add('selected');
    if (state.organizeMode && !comic.isDirectory) card.classList.add('organize-selectable');
    if (state.organizeSelection.has(comic.id)) card.classList.add('organize-selected');

    if (isBuiltInDemoComic(comic)) {
      card.innerHTML = `
        <div class="comic-cover-wrapper builtin-demo-cover-wrapper">
          <img class="comic-cover builtin-demo-cover-image" src="${escapeHtml(getCoverUrl(comic.id))}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}">
          <span class="comic-format-tag builtin-demo-format-tag"><i class="fa-solid fa-shield-heart" aria-hidden="true"></i> ${readerText('內建選集')}</span>
        </div>
        <div class="comic-info">
          <div class="comic-title" title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</div>
          <div class="comic-meta">
            <span><i class="fa-solid fa-mountain-sun" aria-hidden="true"></i> ${readerText('風景插畫')}</span>
            <span>${formatPageCount(comic.pageCount)}</span>
          </div>
        </div>
      `;
      card.onclick = () => activateGridComic(comic);
      configureInteractiveItem(card, readerText('查看風景選集：{title}', { title: comic.title }), card.onclick);
      card.setAttribute('aria-pressed', 'false');
    } else if (comic.isDirectory) {
      // ==========================================
      // 📁 【虛擬資料夾卡片】 YACReader 級層級折疊！
      // ==========================================
      card.innerHTML = `
        <div class="comic-cover-wrapper cover-pending">
          ${comic.coverComicId ? `<img class="comic-cover lazy-cover"
               data-cover-id="${escapeHtml(comic.coverComicId || '')}"
               data-src="${escapeHtml(getCoverUrl(comic.coverComicId))}"
               loading="lazy"
               decoding="async"
               fetchpriority="low"
               alt="${escapeHtml(comic.title)}">` : ''}
          <div class="comic-cover-placeholder" style="background: var(--bg-hover);">
            <div class="placeholder-icon" style="font-size: 40px;">📁</div>
            <div class="placeholder-text" style="margin-top: 10px;">${escapeHtml(comic.title)}</div>
          </div>
            <span class="comic-format-tag" style="background: var(--accent); color: white;"><i class="fa-solid fa-folder"></i> ${readerText('目錄')}</span>
        </div>
        <div class="comic-info">
          <div class="comic-title" title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</div>
          <div class="comic-meta">
            ${comic.comicsCount ? `<span style="color: var(--accent); font-weight: 500;"><i class="fa-solid fa-book-open"></i> ${comic.comicsCount} ${readerText('本漫畫')}</span>` : ''}
            <span>${readerText('點擊點入')}</span>
          </div>
        </div>
      `;

      card.onclick = () => {
        navigateLibraryToPath(comic.relativePath, comic.sourceId || '');
      };
      configureInteractiveItem(card, readerText('開啟資料夾：{title}', { title: comic.title }), card.onclick);
      card.oncontextmenu = (e) => showGridContextMenu(e, comic);
    } else {
      // ==========================================
      // 📖 【標準漫畫卡片】
      // ==========================================
      // 進度條樣式計算
      const progress = getProgressInfo(comic);
      const hasProgress = progress.hasProgress;
      const percent = progress.percent;
      const isFinished = progress.isFinished;

      // 進度徽章內容
      let badgeHtml = '';
      if (isFinished) {
        badgeHtml = `<span class="comic-progress-badge finished"><i class="fa-solid fa-circle-check"></i> ${readerText('已看完')}</span>`;
      } else if (hasProgress) {
        badgeHtml = `<span class="comic-progress-badge"><i class="fa-solid fa-hourglass-half"></i> ${percent}%</span>`;
      }

      // 是否已被收藏
      const isFavorite = isFavoriteId(comic.id);

      card.innerHTML = `
        <div class="comic-cover-wrapper cover-pending">
          ${state.organizeMode ? `<span class="organize-check" aria-hidden="true"><i class="fa-solid fa-check"></i></span>` : ''}
          <img class="comic-cover lazy-cover"
               data-cover-id="${escapeHtml(comic.id)}"
               data-src="${escapeHtml(getCoverUrl(comic.id))}"
               loading="lazy"
               decoding="async"
               fetchpriority="low"
               alt="${escapeHtml(comic.title)}">
          <div class="comic-cover-placeholder">
            <div class="placeholder-icon">📖</div>
            <div class="placeholder-text">${escapeHtml(comic.title)}</div>
          </div>

          <!-- 💖 收藏愛心按鈕 -->
          ${state.organizeMode ? '' : `<button class="favorite-toggle-btn ${isFavorite ? 'active' : ''}" title="${readerText(isFavorite ? '取消收藏' : '加入收藏')}">
            <i class="${isFavorite ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
          </button>`}

          <span class="comic-format-tag ${String(comic.type || '').includes('archive') ? 'tag-archive' : 'tag-folder'}" data-ext="${escapeHtml(comic.ext || 'folder')}">${sourceOffline ? `<i class="fa-solid fa-plug-circle-xmark"></i> ${readerText('來源離線')}` : String(comic.type || '').includes('archive') ? escapeHtml((comic.ext || '.cbz').replace('.','').toUpperCase()) : isPhotoAlbum(comic) ? readerText('相簿') : isLooseImage(comic) ? `<i class="fa-solid fa-image"></i> ${escapeHtml((comic.ext || '.img').replace('.','').toUpperCase())}` : isReadableImageFolder(comic) ? `<i class="fa-solid fa-images"></i> ${readerText('圖片資料夾')}` : `📁 ${readerText('目錄')}`}</span>
          ${badgeHtml}
          ${hasProgress ? `
            <div class="comic-progress-overlay">
              <div class="comic-progress-bar" style="width: ${percent}%"></div>
            </div>
          ` : ''}
        </div>
        <div class="comic-info">
          <div class="comic-title" title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</div>
          <div class="comic-meta">
            <span>${isLooseImage(comic)
              ? readerText('1 張圖片')
              : isReadableImageFolder(comic) && comic.pageCount > 0
              ? readerText('共 {total} 張圖片', { total: comic.pageCount })
              : readerText('共 {total} 頁', { total: comic.pageCount > 0 ? comic.pageCount : '---' })}</span>
            <span>${hasProgress ? readerText('第 {page} 頁', { page: progress.currentPage + 1 }) : readerText('未讀')}</span>
          </div>
        </div>
      `;

      card.onclick = () => activateGridComic(comic);
      configureInteractiveItem(card, state.organizeMode
        ? readerText('選取漫畫：{title}', { title: comic.title })
        : isLooseImage(comic)
          ? readerText('選取圖片：{title}；再次操作即可開啟', { title: comic.title })
          : isReadableImageFolder(comic)
          ? readerText('選取圖片資料夾：{title}；再次操作即可開始閱讀', { title: comic.title })
          : readerText('選取漫畫：{title}；再次操作即可開始閱讀', { title: comic.title }), card.onclick);
      card.setAttribute('aria-pressed', String(state.organizeMode ? state.organizeSelection.has(comic.id) : state.selectedComicId === comic.id));
      card.oncontextmenu = (e) => showGridContextMenu(e, comic);

      // 綁定收藏點擊事件
      const favBtn = card.querySelector('.favorite-toggle-btn');
      if (favBtn) {
        favBtn.setAttribute('aria-label', readerText(isFavorite ? '取消收藏' : '加入收藏'));
        favBtn.setAttribute('aria-pressed', String(isFavorite));
        favBtn.onclick = async (e) => {
          e.stopPropagation(); // 阻止開啟閱讀器
          if (eAPI && eAPI.toggleFavorite) {
            try {
              setFavorites(await eAPI.toggleFavorite(comic.id));
              const isFav = isFavoriteId(comic.id);

              // 姬米妮的流暢 UI 動態過渡 ✨
              favBtn.classList.toggle('active', isFav);
              favBtn.title = readerText(isFav ? '取消收藏' : '加入收藏');
              favBtn.setAttribute('aria-label', readerText(isFav ? '取消收藏' : '加入收藏'));
              favBtn.setAttribute('aria-pressed', String(isFav));
              favBtn.querySelector('i').className = isFav ? 'fa-solid fa-heart' : 'fa-regular fa-heart';

              // 如果當前在「已收藏」篩選器下，點擊取消收藏應將卡片在書架上剔除
              if (state.activeFilter === 'favorite') filterAndRenderGrid();
              if (state.filteredComics.some(item => item.id === comic.id)) {
                renderComicInspector(comic, { keepSelection: true });
              }
              renderContinueStrip();
            } catch (err) {
              console.error('切換收藏失敗：', err);
            }
          }
        };
      }
    }

    card.dataset.renderKey = renderKey;
    gridFragment.appendChild(card);
  });
  elements.comicGrid.replaceChildren(gridFragment);

  // IntersectionObserver 懶載入封面；請求另外限流，讓空框先完成繪製，
  // 避免大量 ZIP 封面同時解壓時拖慢書架滑動。
  coverObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      const img = entry.target;
      if (entry.isIntersecting) {
        coverVisibleImages.add(img);
        if (hasFailedCover(img.dataset.coverId)) {
          coverVisibleImages.delete(img);
          observer.unobserve(img);
          markCoverUnavailable(img);
          return;
        }
        if (img.dataset.src) enqueueCoverLoad(img);
      } else {
        coverVisibleImages.delete(img);
        cancelQueuedCoverLoad(img);
      }
    });
  }, { rootMargin: '80px' }); // 保留少量預載，避免一次觸發整排封面

  document.querySelectorAll('.lazy-cover').forEach(img => {
    coverObserver.observe(img);
  });
  if (background) {
    requestAnimationFrame(() => elements.comicGrid.classList.remove('background-refresh'));
  }
  restoreShelfFocus(focusSnapshot);
  if (scrollTop !== null) elements.contentArea.scrollTop = scrollTop;
}

// ==========================================================================
// 📖 核心漫畫閱讀器功能
// ==========================================================================

// 開啟閱讀器
async function openReader(comicId, { returnToComicFolder = false } = {}) {
  const shelfComic = state.comics.find(comic => comic.id === comicId);
  const previousReadingMode = state.readingMode;
  if (isComicOffline(shelfComic)) {
    showLibrarySourceRecovery(readerText('這本漫畫仍保留在書架，但原本的磁碟位置目前無法存取。請重新掛載 NAS，或選擇新的漫畫目錄。'));
    return;
  }
  if (!state.readerReturnFocus && !elements.readerOverlay.contains(document.activeElement)) {
    state.readerReturnFocus = document.activeElement;
  }
  // 一般書架入口恢復原視圖；Continue 是跨目錄入口，返回漫畫所在資料夾。
  // 相鄰換本時沿用第一次進入閱讀器時的返回策略。
  if (!state.currentComic && !returnToComicFolder && !state.readerReturnLibraryContext) {
    state.readerReturnLibraryContext = captureLibraryViewContext();
  }
  await state.readerClosePromise;
  const savedReturnFocus = state.readerReturnFocus;
  const keepComicFolderReturn = returnToComicFolder || (state.currentComic && state.readerReturnComicFolder !== null);
  if (state.currentComic) {
    await closeReader({ switchingComic: true });
    if (savedReturnFocus && !state.readerReturnFocus) state.readerReturnFocus = savedReturnFocus;
  }
  state.readerReturnComicFolder = keepComicFolderReturn && typeof shelfComic?.relativePath === 'string'
    ? createDirectoryLocation(getComicSourceKey(shelfComic), getParentPath(shelfComic.relativePath))
    : null;
  const operation = ++state.readerOperation;
  state.pendingComicId = comicId;
  showLoader(readerText('正在載入漫畫頁面…'), { progress: null, detail: readerText('正在準備頁面清單...') });
  try {
    let data = isBuiltInDemoComic(shelfComic)
      ? builtInDemoReaderData(shelfComic)
      : await eAPI.openComic(comicId);
    if (operation !== state.readerOperation) return;

    if (!data.pages || data.pages.length === 0) {
      throw new Error(readerText('這本漫畫沒有可讀取的圖片頁面'));
    }

    const failedProgress = readReadingProgressFailures().get(comicId);
    if (failedProgress && failedProgress.id === data.id) {
      // A journaled local save is newer intent, but remains visibly pending until native accepts it.
      data = {
        ...data,
        progress: {
          ...(data.progress || {}),
          currentPage: Math.min(failedProgress.currentPage, Math.max(0, data.pages.length - 1)),
          totalPages: data.pages.length,
        },
      };
    }
    state.currentComic = data;
    state.pendingComicId = null;
    state.selectedComicId = comicId;
    state.currentComicPages = data.pages;
    state.readerReadyPages = new Set();
    state.readerFailedPages = new Set();
    state.readerLastReadyPageIndex = null;
    state.readerReadyComicId = data.id;
    state.readerLoadTrackingActive = true;
    state.currentComicIsDir = data.isDir || false;
    state.currentComicFilenames = data.filenames || [];
    state.aiExplainCache.clear();
    state.aiExplainPendingPage = null;
    state.aiExplainPendingRequest = null;

    const savedPage = Number(data.progress?.currentPage);
    state.currentPageIndex = Number.isFinite(savedPage)
      ? Math.max(0, Math.min(data.pages.length - 1, Math.trunc(savedPage)))
      : 0;
    state.doublePairOffset = state.currentPageIndex > 0 ? state.currentPageIndex % 2 : 1;
    state.readerCacheWindowPage = state.currentPageIndex;
    state.readerCacheReadyPage = null;

    const lowerTitle = data.title.toLowerCase();
    const detectedReadingMode = lowerTitle.includes('webtoon') || lowerTitle.includes('條漫') || lowerTitle.includes('manga_scroll')
      ? 'webtoon'
      : 'single';
    if (previousReadingMode === 'webtoon' || detectedReadingMode === 'webtoon') {
      state.readingMode = 'webtoon';
    } else {
      state.readingMode = detectedReadingMode;
    }

    if (state.zoomPercentage === undefined) state.zoomPercentage = 100;
    if (state.rotationAngle === undefined) state.rotationAngle = 0;
    releasePreloadedImages();

    const demoReader = isBuiltInDemoComic(data);
    if (elements.btnAiExplain) elements.btnAiExplain.hidden = demoReader;
    if (elements.btnAiAutoExplain) elements.btnAiAutoExplain.hidden = demoReader;
    if (demoReader) setAutoPageExplanation(false);

    elements.readerComicTitle.textContent = data.title;
    updateReaderUiControls();
    applyFitMode();

    elements.readerOverlay.style.display = 'flex';
    elements.readerOverlay.setAttribute('aria-hidden', 'false');
    elements.readerOverlay.classList.remove('reader-idle');
    showReaderDiscoveryHint();
    document.body.style.overflow = 'hidden';
    hideReaderContextMenu();

    renderPages();
    triggerControlsActive();
    focusReaderEntry();
  } catch (e) {
    if (operation !== state.readerOperation) return;
    console.error('開啟閱讀器出錯：', e);
    // BUG-09 修正：失敗時清除 currentComic 避免殘留舊狀態
    state.currentComic = null;
    state.currentComicPages = [];
    state.pendingComicId = null;
    state.readerReturnComicFolder = null;
    state.readerReturnLibraryContext = null;
    elements.readerOverlay.setAttribute('aria-hidden', 'true');
    restoreReaderFocus();
    const message = typeof e === 'string' ? e : (e && e.message) || String(e);
    if (/來源目前離線|找不到.*漫畫|掃描目錄無效/.test(message)) {
      showLibrarySourceRecovery(message);
    } else {
      alert(readerText('讀取漫畫資料失敗：{error}', { error: message }));
    }
  } finally {
    clearTimeout(state._smbLoaderTimer);
    state._smbLoaderTimer = null;
    if (operation === state.readerOperation) hideLoader();
  }
}

function createReadingProgressSnapshot(comic = state.currentComic, pageIndex = state.currentPageIndex, totalPages = state.currentComicPages.length) {
  if (!comic || isBuiltInDemoComic(comic)) return null;
  const requestedPage = Number.isSafeInteger(pageIndex) ? pageIndex : Math.trunc(Number(pageIndex) || 0);
  const tracksReadyPages = state.readerLoadTrackingActive === true;
  let readyPage = requestedPage;
  if (tracksReadyPages) {
    if (state.readerReadyComicId !== comic.id) return null;
    readyPage = state.readerReadyPages.has(requestedPage)
      ? requestedPage
      : state.readerLastReadyPageIndex;
    if (!Number.isSafeInteger(readyPage) || readyPage < 0 || readyPage >= totalPages
      || !state.readerReadyPages.has(readyPage)) return null;
  }
  if (!Number.isSafeInteger(readyPage) || readyPage < 0 || readyPage >= totalPages) return null;
  return {
    id: comic.id,
    currentPage: readyPage,
    totalPages,
    sequence: nextReadingProgressSaveSequence(),
  };
}

function enqueueReadingProgressSnapshot(snapshot) {
  if (!snapshot) return readingProgressSaveQueue;
  const normalized = normalizeReadingProgressSnapshot(snapshot);
  if (!normalized) return readingProgressSaveQueue;
  const intentSequence = readingProgressIntentSequence(snapshot);
  const latestQueued = latestQueuedReadingProgressById.get(normalized.id);
  if (latestQueued
    && (readingProgressIntentSequence(latestQueued) > intentSequence
      || (readingProgressIntentSequence(latestQueued) === intentSequence
        && latestQueued.sequence >= normalized.sequence))) return readingProgressSaveQueue;
  latestQueuedReadingProgressById.set(normalized.id, { ...normalized, intentSequence });
  readingProgressSaveQueue = readingProgressSaveQueue
    .catch(() => {})
    .then(() => {
      const latestAtExecution = latestQueuedReadingProgressById.get(normalized.id);
      if (intentSequence < normalized.sequence && latestAtExecution
        && (readingProgressIntentSequence(latestAtExecution) > intentSequence
          || (readingProgressIntentSequence(latestAtExecution) === intentSequence
            && latestAtExecution.sequence > normalized.sequence))) return true;
      return persistReadingProgressSnapshot(normalized, intentSequence);
    });
  return readingProgressSaveQueue;
}

// 關閉閱讀器
async function closeReader({ switchingComic = false } = {}) {
  const closingComic = state.currentComic;
  // scroll RAF 可能尚未執行；先同步套用最後一次條漫位置，再建立不可變快照。
  if (closingComic && state.readingMode === 'webtoon' && state.webtoonScrollFrame) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.webtoonScrollFrame);
    state.webtoonScrollFrame = null;
    updateWebtoonScrollState();
  }
  clearTimeout(state.progressSaveTimer);
  state.progressSaveTimer = null;
  const closingProgress = createReadingProgressSnapshot(closingComic);
  const progressQueueToFlush = enqueueReadingProgressSnapshot(closingProgress);

  ++state.readerOperation;
  state.renderGeneration += 1;
  cancelCatalogResize();
  cancelCatalogVirtualRender();
  resetCatalogThumbnailLoader();
  cancelWebtoonAnchor();
  const closingId = closingComic ? closingComic.id : state.pendingComicId;
  const returnComicFolder = state.readerReturnComicFolder;
  const returnLibraryContext = state.readerReturnLibraryContext;
  if (!switchingComic) state.readerReturnComicFolder = null;
  if (!switchingComic) state.readerReturnLibraryContext = null;
  const libraryFocusSnapshot = captureLibraryFocus(state.readerReturnFocus);
  state.currentComic = null;
  state.currentComicPages = [];
  state.pendingComicId = null;
  state.readerReadyPages.clear();
  state.readerFailedPages.clear();
  state.readerLastReadyPageIndex = null;
  state.readerReadyComicId = null;
  state.readerLoadTrackingActive = false;
  state.webtoonMeasuredPageHeights.clear();
  state.webtoonMetricsComicId = null;
  setAutoPageExplanation(false);
  clearTimeout(state.aiExplainTimer);
  state.aiExplainTimer = null;
  state.aiExplainPendingPage = null;
  state.aiExplainPendingRequest = null;
  setAiPagePanelVisible(false);

  if (elements.statusLoading) elements.statusLoading.style.display = 'none';
  releasePreloadedImages();
  elements.pagesContainer.replaceChildren();

  hideReaderContextMenu();
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  elements.readerOverlay.style.display = 'none';
  elements.readerOverlay.setAttribute('aria-hidden', 'true');
  elements.readerOverlay.classList.remove('reader-idle');
  dismissReaderDiscoveryHint();
  document.body.style.overflow = 'auto';
  if (state.webtoonScrollFrame) {
    cancelAnimationFrame(state.webtoonScrollFrame);
    state.webtoonScrollFrame = null;
  }

  if (closingId && !isBuiltInDemoComic(closingComic) && window.electronAPI && window.electronAPI.closeComic) {
    state.readerClosePromise = state.readerClosePromise
      .catch(() => {})
      .then(() => progressQueueToFlush)
      .then(() => window.electronAPI.closeComic(closingId));
    try {
      await state.readerClosePromise;
    } catch (err) {
      console.error('關閉漫畫清理失敗:', err);
    }
  } else {
    await progressQueueToFlush;
  }

  if (elements.btnAiExplain) elements.btnAiExplain.hidden = false;
  if (elements.btnAiAutoExplain) elements.btnAiAutoExplain.hidden = false;
  restoreReaderFocus();
  state.libraryRefreshFocusSnapshot = libraryFocusSnapshot;

  if (!switchingComic && returnLibraryContext) {
    restoreLibraryViewContext(returnLibraryContext);
  } else if (!switchingComic && returnComicFolder !== null) {
    // Continue 是跨目錄入口；返回時顯示這本漫畫所在的書架，而非根目錄。
    state.activeSeries = 'all';
    state.activeFilter = 'all';
    if (elements.seriesFilterSelect) elements.seriesFilterSelect.value = 'all';
    elements.seriesFilterList?.querySelectorAll('li').forEach(item => {
      item.classList.toggle('active', item.dataset.series === 'all');
      if (item.dataset.series === 'all') item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
    document.querySelectorAll('.filter-btn').forEach(btn => {
      const selected = btn.dataset.filter === 'all';
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
    if (elements.searchInput?.value) {
      elements.searchInput.value = '';
      if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = 'none';
      clearTimeout(catalogSearchTimer);
      catalogSearchTimer = null;
      state.catalogSearchRequest += 1;
      state.catalogSearchIds = null;
      state.catalogSearchItems.clear();
      state.catalogSearchTotal = 0;
      renderCatalogFacets({});
    }
    state.selectedComicId = closingId;
    navigateLibraryToPath(normalizeDirectoryLocation(returnComicFolder));
  }

  // 重新整理書架（更新最近閱讀與進度條）
  scheduleLibraryRefresh();
}

function releasePreloadedImages() {
  clearTimeout(state.readerCacheWindowTimer);
  state.readerCacheWindowTimer = null;
  state.readerCacheWindowToken += 1;
  state.readerCacheWindowPage = null;
  state.readerCacheReadyPage = null;
  for (const img of state.preloadedImages.values()) {
    img.removeAttribute('src');
  }
  state.preloadedImages.clear();
}

// 根據模式繪製圖片（極致雙緩衝與背景解碼，徹底根除 Chromium 的點位更換閃爍）
function createWebtoonNavigationButton(direction) {
  const button = document.createElement('button');
  const source = direction === 'next' ? '下一本' : '上一本';
  button.type = 'button';
  button.className = `webtoon-nav-button webtoon-nav-${direction === 'next' ? 'next' : 'prev'}`;
  button.textContent = readerText(source);
  button.setAttribute('aria-label', readerText(source));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    requestWebtoonAdjacentComic(direction);
  });
  return button;
}

function getReaderFocusableElements() {
  const selectors = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  return [...(elements.readerOverlay?.querySelectorAll?.(selectors) || [])]
    .filter(isReaderElementActuallyFocusable);
}

function isReaderElementActuallyFocusable(element) {
  if (!element || element.hidden || element.disabled || element.getAttribute?.('aria-hidden') === 'true') return false;
  let current = element;
  while (current) {
    if (current.nodeType && current.nodeType !== 1) break;
    if (current.hidden || current.disabled || current.getAttribute?.('aria-hidden') === 'true') return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none' || style.opacity === '0') return false;
    }
    current = current.parentElement || current.parentNode;
  }
  const rect = element.getBoundingClientRect?.();
  if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
    const viewportWidth = Number(window.innerWidth) || 0;
    const viewportHeight = Number(window.innerHeight) || 0;
    if (rect.width <= 0 || rect.height <= 0
      || (viewportWidth > 0 && (rect.right <= 0 || rect.left >= viewportWidth))
      || (viewportHeight > 0 && (rect.bottom <= 0 || rect.top >= viewportHeight))) return false;
  }
  return true;
}

function focusReaderEntry() {
  const entry = elements.readerBackBtn;
  if (entry && isReaderElementActuallyFocusable(entry)) {
    entry.focus?.({ preventScroll: true });
    return true;
  }
  // 若頂部 chrome 仍因 viewport／CSS 狀態不可見，讓 overlay 本身成為
  // 可程式聚焦的鍵盤入口，避免 Tab 被困在不可見的返回鍵上。
  elements.readerOverlay?.focus?.({ preventScroll: true });
  return false;
}

function trapReaderFocus(event) {
  if (elements.readerOverlay.style.display === 'none' || event.key !== 'Tab') return;
  const focusables = getReaderFocusableElements();
  if (!focusables.length) {
    event.preventDefault();
    // idle 狀態會把上下 chrome 移出 viewport；先喚醒，再把焦點交給可見入口。
    triggerControlsActive();
    focusReaderEntry();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!elements.readerOverlay.contains(document.activeElement)) {
    event.preventDefault();
    focusReaderEntry();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function guardReaderFocus(event) {
  if (elements.readerOverlay.style.display === 'none') return;
  if (elements.readerOverlay.contains(event.target)) return;
  const modal = event.target?.closest?.('[aria-modal="true"]');
  if (modal && !modal.hidden && modal.getAttribute?.('aria-hidden') !== 'true') {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(modal) : null;
    if (!style || (style.display !== 'none' && style.visibility !== 'hidden')) return;
  }
  focusReaderEntry();
}

function restoreReaderFocus() {
  const returnFocus = state.readerReturnFocus;
  state.readerReturnFocus = null;
  if (returnFocus && returnFocus.isConnected !== false) {
    returnFocus.focus?.({ preventScroll: true });
  }
}

function webtoonEstimatedPageHeight() {
  const viewportWidth = Number(elements.readerViewport?.clientWidth) || 800;
  return Math.max(160, viewportWidth * 1.5);
}

function rebuildWebtoonPagePrefixHeights() {
  const heights = state.webtoonPageHeights;
  const prefix = new Array(heights.length + 1);
  prefix[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    prefix[index + 1] = prefix[index] + heights[index];
  }
  state.webtoonPagePrefixHeights = prefix;
}

function resetWebtoonPageMetrics(totalPages) {
  const estimate = webtoonEstimatedPageHeight();
  state.webtoonMetricsViewportWidth = Number(elements.readerViewport?.clientWidth) || 800;
  const comicId = state.currentComic?.id || null;
  const previousMeasured = state.webtoonMetricsComicId === comicId
    ? state.webtoonMeasuredPageHeights
    : new Map();
  const nextMeasured = new Map();
  state.webtoonPageHeights = Array.from({ length: totalPages }, (_, index) => {
    const measured = previousMeasured.get(index);
    if (Number.isFinite(measured) && measured > 0) {
      nextMeasured.set(index, measured);
      return measured;
    }
    return estimate;
  });
  state.webtoonMetricsComicId = comicId;
  state.webtoonMeasuredPageHeights = nextMeasured;
  state.webtoonPendingPageHeights.clear();
  rebuildWebtoonPagePrefixHeights();
}

function syncWebtoonWindowSpacers() {
  const top = elements.pagesContainer.querySelector('[data-webtoon-spacer="top"]');
  const bottom = elements.pagesContainer.querySelector('[data-webtoon-spacer="bottom"]');
  if (top) top.style.height = `${webtoonPageOffset(state.webtoonWindowStart)}px`;
  if (bottom) bottom.style.height = `${Math.max(0,
    webtoonPageOffset(state.webtoonPageHeights.length) - webtoonPageOffset(state.webtoonWindowEnd))}px`;
}

function refreshWebtoonPageMetricsForResize() {
  if (state.readingMode !== 'webtoon' || !state.webtoonPageHeights.length) return;
  const nextWidth = Number(elements.readerViewport?.clientWidth) || 0;
  const previousWidth = state.webtoonMetricsViewportWidth;
  if (!nextWidth || !previousWidth || Math.abs(nextWidth - previousWidth) < 1) return;

  // 先以舊幾何記住視窗所在頁及頁內比例，再將已量測與預估高度一起
  // 縮放。這讓遠處的 spacer 在旋轉當下就準確，不必等圖片重新載入。
  cancelWebtoonPageHeightFlush();
  const viewport = elements.readerViewport;
  const anchorOffset = getWebtoonAnchorViewportOffset();
  const contentTop = Math.max(0, viewport.scrollTop - state.webtoonNavigationOffset - anchorOffset);
  const visiblePage = webtoonPageIndexAtOffset(contentTop);
  const previousPageHeight = state.webtoonPageHeights[visiblePage] || 1;
  const pageFraction = Math.max(0, Math.min(1,
    (contentTop - webtoonPageOffset(visiblePage)) / previousPageHeight));
  const scale = nextWidth / previousWidth;
  state.webtoonPageHeights = state.webtoonPageHeights.map(height => height * scale);
  state.webtoonMeasuredPageHeights.forEach((height, index) => {
    state.webtoonMeasuredPageHeights.set(index, height * scale);
  });
  state.webtoonMetricsViewportWidth = nextWidth;
  rebuildWebtoonPagePrefixHeights();
  // 重量測可能立即 flush；先清掉旋轉前的 anchor 座標，避免以舊 top
  // 做一次補償，最後定位時又補償一次。
  if (isActiveWebtoonAnchor()) state.webtoonAnchor.lastTargetTop = null;
  elements.pagesContainer.querySelectorAll('img.webtoon-img[data-index]').forEach(image => {
    const index = Number(image.dataset.index);
    if (image.dataset.webtoonPlaceholder === 'true') {
      image.style.height = `${state.webtoonPageHeights[index]}px`;
    } else if (image.complete && image.naturalWidth > 0) {
      updateWebtoonPageHeight(index, image);
    }
  });
  // 已掛載的圖片由實際 clientHeight 修正；未掛載頁仍採寬度比例估值。
  if (state.webtoonPendingPageHeights.size) {
    if (state.webtoonHeightUpdateFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.webtoonHeightUpdateFrame);
      clearTimeout(state.webtoonHeightUpdateFrame);
      state.webtoonHeightUpdateFrame = null;
    }
    flushWebtoonPageHeightUpdates();
  }
  syncWebtoonWindowSpacers();
  if (isActiveWebtoonAnchor()) {
    const anchorTop = getWebtoonImageOffsetTop(getWebtoonImage(state.webtoonAnchor.index));
    if (Number.isFinite(anchorTop)) viewport.scrollTop = Math.max(0, anchorTop - getWebtoonAnchorViewportOffset());
    state.webtoonAnchor.lastTargetTop = null;
    preserveWebtoonAnchorPosition();
  } else {
    viewport.scrollTop = state.webtoonNavigationOffset
      + anchorOffset
      + webtoonPageOffset(visiblePage)
      + state.webtoonPageHeights[visiblePage] * pageFraction;
  }
}

function cancelWebtoonPageHeightFlush() {
  if (state.webtoonHeightUpdateFrame !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.webtoonHeightUpdateFrame);
    clearTimeout(state.webtoonHeightUpdateFrame);
    state.webtoonHeightUpdateFrame = null;
  }
  state.webtoonPendingPageHeights.clear();
}

function webtoonPageOffset(index) {
  const prefix = state.webtoonPagePrefixHeights;
  if (!prefix.length) return 0;
  const safeIndex = Math.max(0, Math.min(prefix.length - 1, Number(index) || 0));
  return prefix[safeIndex] || 0;
}

function webtoonPageIndexAtOffset(offset) {
  const prefix = state.webtoonPagePrefixHeights;
  if (prefix.length < 2) return 0;
  const target = Math.max(0, Number(offset) || 0);
  let low = 0;
  let high = prefix.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (prefix[middle] > target) high = middle - 1;
    else low = middle;
  }
  return Math.min(state.currentComicPages.length - 1, Math.max(0, low));
}

function flushWebtoonPageHeightUpdates() {
  state.webtoonHeightUpdateFrame = null;
  if (state.readingMode !== 'webtoon' || !state.webtoonPendingPageHeights.size) {
    state.webtoonPendingPageHeights.clear();
    return;
  }

  const pending = state.webtoonPendingPageHeights;
  const scrollTop = elements.readerViewport.scrollTop;
  const anchorOffset = getWebtoonAnchorViewportOffset();
  let scrollCompensation = 0;
  pending.forEach((nextHeight, index) => {
    const previousHeight = state.webtoonPageHeights[index];
    const pageTop = state.webtoonNavigationOffset + anchorOffset + webtoonPageOffset(index);
    if (!isActiveWebtoonAnchor() && pageTop < scrollTop) scrollCompensation += nextHeight - previousHeight;
    state.webtoonPageHeights[index] = nextHeight;
  });
  pending.clear();
  rebuildWebtoonPagePrefixHeights();
  syncWebtoonWindowSpacers();
  if (!isActiveWebtoonAnchor() && Math.abs(scrollCompensation) >= 1) {
    elements.readerViewport.scrollTop += scrollCompensation;
  }
  if (isActiveWebtoonAnchor()) preserveWebtoonAnchorPosition();
}

function scheduleWebtoonPageHeightFlush() {
  if (state.webtoonHeightUpdateFrame !== null) return;
  const callback = flushWebtoonPageHeightUpdates;
  state.webtoonHeightUpdateFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : window.setTimeout(callback, 0);
}

function updateWebtoonPageHeight(index, image, { measured = true } = {}) {
  if (state.readingMode !== 'webtoon' || !image || !Number.isFinite(image.clientHeight)) return;
  const nextHeight = Number(image.clientHeight);
  if (nextHeight <= 0 || index < 0 || index >= state.webtoonPageHeights.length) return;
  if (measured) state.webtoonMeasuredPageHeights.set(index, nextHeight);
  const previousHeight = state.webtoonPendingPageHeights.get(index) ?? state.webtoonPageHeights[index];
  if (Math.abs(nextHeight - previousHeight) < 1) return;
  state.webtoonPendingPageHeights.set(index, nextHeight);
  scheduleWebtoonPageHeightFlush();
}

function getWebtoonWindowBounds(totalPages, currentIndex = state.currentPageIndex) {
  const safeCurrent = Math.max(0, Math.min(totalPages - 1, Number(currentIndex) || 0));
  const start = Math.max(0, safeCurrent - WEBTOON_RENDER_BEFORE);
  const end = Math.min(totalPages, Math.max(start + 1, safeCurrent + WEBTOON_RENDER_AFTER + 1));
  return { start, end };
}

function createWebtoonPageImage(src, index, currentIndex, renderGeneration) {
  const img = document.createElement('img');
  img.dataset.src = src;
  img.decoding = 'async';
  const eager = Math.abs(index - currentIndex) < WEBTOON_EAGER_IMAGES;
  img.fetchPriority = eager ? 'high' : 'low';
  img.loading = eager ? 'eager' : 'lazy';
  img.className = 'webtoon-img';
  img.dataset.index = index;
  img.alt = readerText('第 {page} 頁', { page: index + 1 });
  img.style.aspectRatio = 'auto 2 / 3';
  // 未載入的圖片也要與 prefix height 使用同一高度；否則 WKWebView 會把
  // 無 src 的 img 縮成 alt 文字高度，捲動位置與實際可見頁面完全錯開。
  img.style.height = `${state.webtoonPageHeights[index]}px`;
  img.dataset.webtoonPlaceholder = 'true';
  const updateMetrics = (measured = true) => {
    if (state.renderGeneration !== renderGeneration) return;
    if (measured && img.dataset.webtoonPlaceholder === 'true') {
      img.style.height = '';
      img.style.aspectRatio = 'auto 2 / 3';
      delete img.dataset.webtoonPlaceholder;
    }
    updateWebtoonPageHeight(index, img, { measured });
  };
  img.addEventListener('load', () => {
    updateMetrics(true);
    if (readerImageIsReady(img)) {
      markReaderPageReady(index, img, renderGeneration);
      if (!state.readerFailedPages.size) clearReaderImageError();
    }
  });
  img.addEventListener('error', () => {
    updateMetrics(false);
    markReaderPageFailed(index, renderGeneration);
    showReaderImageError([...state.readerFailedPages]);
  });
  applyImageEffects(img);
  if (eager) img.src = src;
  return img;
}

function renderWebtoonWindow(currentIndex = state.currentPageIndex, renderGeneration = state.renderGeneration) {
  const totalPages = state.currentComicPages.length;
  if (!totalPages) return;
  if (state.webtoonPageHeights.length !== totalPages) resetWebtoonPageMetrics(totalPages);

  const { start, end } = getWebtoonWindowBounds(totalPages, currentIndex);
  const hasPreviousComic = Boolean(findAdjacentComicInFolder('prev'));
  const hasNextComic = Boolean(findAdjacentComicInFolder('next'));
  const fragment = document.createDocumentFragment();
  state.webtoonNavigationOffset = hasPreviousComic ? 56 : 0;
  if (hasPreviousComic) fragment.appendChild(createWebtoonNavigationButton('prev'));

  const topSpacer = document.createElement('div');
  topSpacer.className = 'webtoon-window-spacer';
  topSpacer.dataset.webtoonSpacer = 'top';
  topSpacer.style.height = `${webtoonPageOffset(start)}px`;
  topSpacer.setAttribute('aria-hidden', 'true');
  fragment.appendChild(topSpacer);

  for (let index = start; index < end; index += 1) {
    fragment.appendChild(createWebtoonPageImage(state.currentComicPages[index], index, currentIndex, renderGeneration));
  }

  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'webtoon-window-spacer';
  bottomSpacer.dataset.webtoonSpacer = 'bottom';
  bottomSpacer.style.height = `${Math.max(0, webtoonPageOffset(totalPages) - webtoonPageOffset(end))}px`;
  bottomSpacer.setAttribute('aria-hidden', 'true');
  fragment.appendChild(bottomSpacer);
  if (hasNextComic) fragment.appendChild(createWebtoonNavigationButton('next'));

  state.webtoonWindowStart = start;
  state.webtoonWindowEnd = end;
  elements.pagesContainer.replaceChildren(fragment);
}

function isDoubleReadingMode(mode = state.readingMode) {
  return mode === 'double' || mode === 'double-rtl';
}

// 以目前雙頁相位把任意頁面對齊到配對起點；封面永遠保留單頁。
function doublePageStartForIndex(pageIndex) {
  if (pageIndex <= 0) return 0;
  const offset = state.doublePairOffset === 0 ? 0 : 1;
  const remainder = ((pageIndex - offset) % 2 + 2) % 2;
  return Math.max(1, pageIndex - remainder);
}

function syncDoubleModeControls() {
  const isDouble = isDoubleReadingMode();
  const isRtl = state.readingMode === 'double-rtl';
  const totalPages = state.currentComicPages.length;
  const shiftAvailable = isDouble && state.currentPageIndex + 1 < totalPages;

  if (elements.doubleModeControls) elements.doubleModeControls.hidden = !isDouble;
  if (elements.btnDoubleDirection) {
    elements.btnDoubleDirection.hidden = false;
    elements.btnDoubleDirection.disabled = !isDouble;
    elements.btnDoubleDirection.setAttribute('aria-pressed', String(isRtl));
    const label = readerText(isRtl ? '切換為左至右雙頁' : '切換為右至左雙頁');
    elements.btnDoubleDirection.setAttribute('aria-label', label);
    elements.btnDoubleDirection.title = label;
  }
  if (elements.btnDoubleShift) {
    elements.btnDoubleShift.hidden = false;
    elements.btnDoubleShift.disabled = !shiftAvailable;
    const label = readerText('雙頁往後移一頁');
    elements.btnDoubleShift.setAttribute('aria-label', label);
    elements.btnDoubleShift.title = label;
  }

  const menu = elements.readerContextMenu;
  const menuDirection = menu?.querySelector('[data-reader-action="double-direction"]');
  const menuShift = menu?.querySelector('[data-reader-action="double-shift"]');
  if (menuDirection) {
    menuDirection.disabled = !isDouble;
    menuDirection.setAttribute('aria-pressed', String(isRtl));
    menuDirection.setAttribute('aria-label', readerText('切換雙頁方向'));
  }
  if (menuShift) {
    menuShift.disabled = !shiftAvailable;
    menuShift.setAttribute('aria-disabled', String(!shiftAvailable));
  }
}

// 僅切換左右閱讀方向；頁面位置與配對相位都維持不變。
function toggleDoubleDirection() {
  if (!isDoubleReadingMode()) return false;
  state.readingMode = state.readingMode === 'double-rtl' ? 'double' : 'double-rtl';
  updateReaderUiControls();
  renderPages();
  return true;
}

// 將目前配對往後移一頁；下一次一般翻頁仍以兩頁為單位。
function advanceDoubleBySinglePage() {
  if (!isDoubleReadingMode()) return false;
  const totalPages = state.currentComicPages.length;
  const nextIndex = state.currentPageIndex + 1;
  if (nextIndex >= totalPages) {
    syncDoubleModeControls();
    return false;
  }
  state.currentPageIndex = nextIndex;
  // 封面移到下一頁後仍沿用既有 2-3、4-5…配對；其餘情況記住錯開相位。
  state.doublePairOffset = state.currentPageIndex === 1 ? 1 : state.currentPageIndex % 2;
  renderPages();
  return true;
}

function renderPages() {
  if (!state.currentComic) return;

  if (state.readingMode !== 'catalog') {
    cancelCatalogResize();
    cancelCatalogVirtualRender();
    if (catalogImageObserver || catalogImageQueue.length || catalogImageTasks.size || catalogImageActive) {
      resetCatalogThumbnailLoader();
    }
  }
  clearReaderImageError();
  state.readerFailedPages.clear();
  cancelWebtoonAnchor();
  if (state.webtoonScrollFrame) {
    cancelAnimationFrame(state.webtoonScrollFrame);
    state.webtoonScrollFrame = null;
  }
  cancelWebtoonPageHeightFlush();
  const renderGeneration = ++state.renderGeneration;

  const totalPages = state.currentComicPages.length;

  // 移除所有模式 class
  elements.readerOverlay.classList.remove('mode-single', 'mode-double', 'mode-webtoon', 'mode-catalog');
  elements.readerOverlay.classList.remove('single-page-pannable');

  // BUG-10 修正：每次重新渲染前先清除 onscroll，避免切換模式後 webtoon 事件殘留
  elements.readerViewport.onscroll = null;

  // 重設滾動位置，防止切頁時停留在中段
  elements.readerViewport.scrollTop = 0;
  elements.readerViewport.scrollLeft = 0;

  if (state.readingMode === 'single') {
    elements.readerOverlay.classList.add('mode-single');
    elements.readerModeIndicator.textContent = readerText('單頁模式');
    elements.prevZone.style.width = '15%';
    elements.nextZone.style.width = '15%';

    const targetSrc = state.currentComicPages[state.currentPageIndex];
    const tempImg = takePreloadedReaderImage(state.currentPageIndex);

    // 🚀 顯示頁面載入/解碼中旋轉動畫
    showPageLoadingSpinner(true);

    // 🚀 極致雙緩衝：在背景將圖片完整載入並由 GPU 完成解碼，這段期間舊圖片原封不動留在畫面上！
    Promise.resolve().then(() => decodeReaderImage(tempImg)).then(() => {
      // 確保在非同步解碼期間，使用者沒有突然切換模式或快速翻到別的頁面
      if (state.renderGeneration !== renderGeneration) return;
      if (state.readingMode !== 'single') return;
      if (state.currentComicPages[state.currentPageIndex] !== targetSrc) return;
      // 只有在「百分之百準備好顯示」的這一微秒，才清空 DOM 並瞬間塞入新圖片，絕對零閃爍！
      replaceReaderImages([tempImg]);
      markReaderPageReady(state.currentPageIndex, tempImg, renderGeneration);

      // 隱藏解碼中動畫
      showPageLoadingSpinner(false);
    }).catch(() => {
      // 降級處理（例如圖片損壞等特殊情況）
      if (state.renderGeneration !== renderGeneration) return;
      if (state.readingMode !== 'single') return;
      if (state.currentComicPages[state.currentPageIndex] !== targetSrc) return;
      markReaderPageFailed(state.currentPageIndex, renderGeneration);
      replaceReaderImages([]);
      showReaderImageError([state.currentPageIndex]);
      showPageLoadingSpinner(false);
    });

    // 更新進度拉條與數字
    elements.pageCounter.textContent = readerText('第 {page} / {total} 頁', { page: state.currentPageIndex + 1, total: totalPages });
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;

    // 非同步預載前後頁
    preloadNextPages();

  } else if (state.readingMode === 'double' || state.readingMode === 'double-rtl') {
    elements.readerOverlay.classList.add('mode-double');
    elements.readerModeIndicator.textContent = readerText(state.readingMode === 'double-rtl' ? '雙頁模式 (右至左)' : '雙頁模式');
    elements.prevZone.style.width = '15%';
    elements.nextZone.style.width = '15%';

    const isRtl = state.readingMode === 'double-rtl';

    // 雙頁邏輯：
    // 如果是第一頁 (Cover)，通常為單頁顯示，後續兩兩一組
    if (state.currentPageIndex === 0) {
      const targetSrc = state.currentComicPages[0];
      const tempImg = takePreloadedReaderImage(0);

      showPageLoadingSpinner(true);

      Promise.resolve().then(() => decodeReaderImage(tempImg)).then(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== 0) return;
        replaceReaderImages([tempImg]);
        markReaderPageReady(0, tempImg, renderGeneration);
        showPageLoadingSpinner(false);
      }).catch(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== 0) return;
        markReaderPageFailed(0, renderGeneration);
        replaceReaderImages([]);
        showReaderImageError([0]);
        showPageLoadingSpinner(false);
      });

      elements.pageCounter.textContent = readerText('第 1 / {total} 頁 (封面)', { total: totalPages });
    } else {
      // 雙頁情況：顯示 currentPageIndex 和 currentPageIndex + 1
      const page1Index = state.currentPageIndex;
      const page2Index = state.currentPageIndex + 1 < totalPages ? state.currentPageIndex + 1 : null;

      const src1 = state.currentComicPages[page1Index];
      const src2 = page2Index !== null ? state.currentComicPages[page2Index] : null;

      const img1 = takePreloadedReaderImage(page1Index);
      let img2 = null;
      if (page2Index !== null) {
        img2 = takePreloadedReaderImage(page2Index);
      }

      showPageLoadingSpinner(true);

      // 分別等待兩頁；一頁損壞時仍保留另一張成功圖片。
      const decodeEntries = [{ index: page1Index, img: img1 }];
      if (img2) decodeEntries.push({ index: page2Index, img: img2 });

      Promise.allSettled(decodeEntries.map(entry => Promise.resolve().then(() => decodeReaderImage(entry.img))))
        .then(results => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== page1Index) return;

        const readyEntries = decodeEntries.filter((entry, index) => results[index].status === 'fulfilled'
          && readerImageIsReady(entry.img));
        const failedEntries = decodeEntries.filter((entry, index) => !readyEntries.includes(entry)
          || results[index].status !== 'fulfilled');
        readyEntries.forEach(entry => markReaderPageReady(entry.index, entry.img, renderGeneration));
        failedEntries.forEach(entry => markReaderPageFailed(entry.index, renderGeneration));
        const orderedImages = isRtl
          ? [...readyEntries].reverse().map(entry => entry.img)
          : readyEntries.map(entry => entry.img);
        replaceReaderImages(orderedImages);
        if (failedEntries.length) showReaderImageError(failedEntries.map(entry => entry.index));
        showPageLoadingSpinner(false);
      });

      const endRange = page2Index !== null ? page2Index + 1 : page1Index + 1;
      elements.pageCounter.textContent = readerText('第 {start}-{end} / {total} 頁', { start: page1Index + 1, end: endRange, total: totalPages });
    }

    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;

    preloadNextPages();

  } else if (state.readingMode === 'webtoon') {
    const initialWebtoonPageIndex = state.currentPageIndex;
    elements.readerOverlay.classList.add('mode-webtoon');
    elements.readerModeIndicator.textContent = readerText('條漫直捲');
    elements.prevZone.style.width = '0';
    elements.nextZone.style.width = '0';

    // 只保留目前頁面附近的圖片；上下 spacer 代表未掛載頁面的高度。
    // 這讓長條漫不再把整本圖片與事件一次放進 WKWebView DOM。
    resetWebtoonPageMetrics(totalPages);
    renderWebtoonWindow(initialWebtoonPageIndex, renderGeneration);

    // 監聽滾動事件，用來更新頁碼與附近視窗；頁碼查找使用 prefix heights 二分搜尋。
    elements.readerViewport.onscroll = handleWebtoonScroll;

    // 初始化進度
    elements.pageCounter.textContent = readerText('第 {page} / {total} 頁', {
      page: state.currentPageIndex + 1,
      total: totalPages,
    });
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;

    // placeholder 已在同步建 DOM 時提供穩定高度，因此立即建立錨點。
    if (initialWebtoonPageIndex > 0) {
      anchorWebtoonPage(initialWebtoonPageIndex, { behavior: 'auto', renderGeneration });
    } else {
      loadWebtoonImagesAround(0);
    }
  } else if (state.readingMode === 'catalog') {
    // 目錄縮圖模式
    elements.readerOverlay.classList.add('mode-catalog');
    elements.readerModeIndicator.textContent = readerText('目錄模式');
    elements.prevZone.style.width = '0';
    elements.nextZone.style.width = '0';
    elements.readerViewport.onscroll = handleCatalogScroll;

    renderCatalogGrid();

    elements.pageCounter.textContent = readerText('共 {total} 頁', { total: totalPages });
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;
  }

  syncDoubleModeControls();
  scheduleReaderCacheWindowUpdate();

  // 進度只由已解碼頁面的完成 callback 或條漫防抖動流程儲存。
}

// 翻到下一頁
function nextPage() {
  const totalPages = state.currentComicPages.length;
  let endReached = false;

  if (state.readingMode === 'single') {
    if (state.currentPageIndex < totalPages - 1) {
      state.currentPageIndex++;
      renderPages();
    } else {
      endReached = true;
    }
  } else if (state.readingMode === 'double' || state.readingMode === 'double-rtl') {
    if (state.currentPageIndex === 0) {
      if (totalPages > 1) {
        state.currentPageIndex = 1;
        state.doublePairOffset = 1;
        renderPages();
      } else {
        endReached = true;
      }
    } else if (state.currentPageIndex + 2 < totalPages) {
      // 後續每次跳 2 頁
      state.currentPageIndex += 2;
      renderPages();
    } else {
      endReached = true;
    }
  }

  if (endReached) {
    openNextComicInFolder();
  }
}

// ==========================================================================
// 📋 目錄縮圖網格 (Catalog Grid)
// ==========================================================================

function captureCatalogFocus() {
  const active = document.activeElement;
  if (!active || !elements.pagesContainer.contains?.(active)) return null;
  if (active.dataset?.catalogWindowControl) {
    return { type: 'window-control', direction: active.dataset.catalogWindowControl };
  }
  if (catalogHasClass(active, 'catalog-thumb') && active.dataset?.index != null) {
    return { type: 'thumbnail', index: String(active.dataset.index) };
  }
  return null;
}

function catalogHasClass(element, className) {
  return Boolean(element?.classList?.contains?.(className)
    || String(element?.className || '').split(/\s+/).includes(className));
}

function restoreCatalogFocus(descriptor) {
  if (!descriptor) return;
  const children = [...(elements.pagesContainer.children || [])];
  let target = null;
  if (descriptor.type === 'window-control') {
    const controls = children.find(child => catalogHasClass(child, 'reader-catalog-window-controls'));
    target = [...(controls?.children || [])].find(child => child.dataset?.catalogWindowControl === descriptor.direction);
  } else if (descriptor.type === 'thumbnail') {
    const grid = children.find(child => catalogHasClass(child, 'reader-catalog-grid'));
    target = [...(grid?.children || [])].find(child => String(child.dataset?.index) === descriptor.index);
  }
  target?.focus?.({ preventScroll: true });
}

function resetCatalogThumbnailLoader() {
  catalogImageGeneration += 1;
  catalogImageObserver?.disconnect?.();
  catalogImageObserver = null;
  catalogImageQueue = [];
  catalogImageTasks.forEach(task => task.cancel?.());
  catalogImageTasks.clear();
  // 舊世代圖片仍可能在 native 解碼中；立即釋放槽位，讓新視窗能開始載入。
  // 舊 callback 會以 task 狀態驗證，不能再扣到新世代的計數。
  catalogImageActive = 0;
}

function cancelCatalogThumbnailLoad(img) {
  if (!img) return;
  catalogImageObserver?.unobserve?.(img);
  catalogImageQueue = catalogImageQueue.filter(task => {
    if (task?.img !== img) return true;
    delete img.dataset.catalogLoadQueued;
    return false;
  });
  [...catalogImageTasks]
    .filter(task => task?.img === img)
    .forEach(task => task.cancel?.());
}

function cancelCatalogVirtualRender() {
  if (catalogVirtualRenderFrame === null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(catalogVirtualRenderFrame);
  clearTimeout(catalogVirtualRenderFrame);
  catalogVirtualRenderFrame = null;
  catalogVirtualRenderOwner = null;
}

function catalogGridMetrics() {
  const viewportWidth = Number(elements.readerViewport?.clientWidth)
    || Number(window.innerWidth)
    || 800;
  const usableWidth = Math.max(130, viewportWidth - 40);
  const columns = Math.max(1, Math.floor(
    (usableWidth + CATALOG_GRID_GAP) / (130 + CATALOG_GRID_GAP),
  ));
  const viewportHeight = Number(elements.readerViewport?.clientHeight)
    || Number(window.innerHeight)
    || 800;
  return {
    columns,
    rowHeight: CATALOG_THUMB_HEIGHT + CATALOG_GRID_GAP,
    visibleRows: Math.max(1, Math.ceil(viewportHeight / (CATALOG_THUMB_HEIGHT + CATALOG_GRID_GAP))),
  };
}

function catalogGridOffset() {
  const controls = elements.pagesContainer?.querySelector?.('.reader-catalog-window-controls');
  const offset = Number(controls?.offsetHeight);
  return Number.isFinite(offset) && offset > 0
    ? offset + CATALOG_GRID_GAP
    : (Number(state.catalogControlOffset) || CATALOG_CONTROLS_OFFSET_FALLBACK);
}

function catalogScrollTopForPage(index, metrics = catalogGridMetrics()) {
  const viewportHeight = Number(elements.readerViewport?.clientHeight)
    || Number(window.innerHeight)
    || 800;
  const rowTop = Math.floor(Math.max(0, Number(index) || 0) / metrics.columns) * metrics.rowHeight;
  return Math.max(0, catalogGridOffset() + rowTop - Math.max(0, viewportHeight - metrics.rowHeight) / 2);
}

function getCatalogVirtualBounds(totalPages, {
  preserveWindow = false,
  fromScroll = false,
  scrollTop = null,
} = {}) {
  const metrics = catalogGridMetrics();
  const totalRows = Math.ceil(totalPages / metrics.columns);
  const renderCapacity = Math.max(metrics.columns,
    Math.floor(CATALOG_RENDER_PAGE_SIZE / metrics.columns) * metrics.columns);
  const maxStart = Math.max(0, totalPages - renderCapacity);
  let windowStart;
  let windowEnd;

  if (fromScroll) {
    const contentTop = Math.max(0, (Number(scrollTop) || 0) - catalogGridOffset());
    const firstVisibleRow = Math.min(totalRows, Math.floor(contentTop / metrics.rowHeight));
    const firstVisibleIndex = Math.min(totalPages, firstVisibleRow * metrics.columns);
    const visibleEnd = Math.min(
      totalPages,
      (firstVisibleRow + metrics.visibleRows + CATALOG_VIRTUAL_OVERSCAN_ROWS) * metrics.columns,
    );
    const edge = Math.max(metrics.columns, CATALOG_VIRTUAL_OVERSCAN_ROWS * metrics.columns);
    const currentStart = Number.isSafeInteger(state.catalogWindowStart)
      ? state.catalogWindowStart : 0;
    const currentEnd = Number.isSafeInteger(state.catalogWindowEnd)
      ? state.catalogWindowEnd : 0;
    const hasWindow = currentEnd > currentStart && state.catalogColumns === metrics.columns;
    const shift = Math.max(metrics.columns,
      Math.floor((CATALOG_WINDOW_PAGE_COUNT * CATALOG_WINDOW_SHIFT_RATIO) / metrics.columns)
        * metrics.columns);
    let requestedStart = currentStart;
    if (!hasWindow || firstVisibleIndex < currentStart - edge || visibleEnd > currentEnd + edge) {
      // A large fling should land on the correct batch immediately; ordinary
      // scrolling below uses the smaller half-window shift to preserve overlap.
      requestedStart = firstVisibleIndex - Math.floor(CATALOG_WINDOW_PAGE_COUNT / 2);
    } else if (visibleEnd >= currentEnd - edge) {
      requestedStart = currentStart + shift;
    } else if (firstVisibleIndex <= currentStart + edge) {
      requestedStart = currentStart - shift;
    }
    windowStart = Math.max(0, Math.min(maxStart, requestedStart));
    windowEnd = Math.min(totalPages, windowStart + CATALOG_WINDOW_PAGE_COUNT);
  } else {
    const requestedStart = Number.isSafeInteger(state.catalogWindowStart) ? state.catalogWindowStart : 0;
    const currentPage = Math.max(0, Math.min(totalPages - 1, state.currentPageIndex));
    const requestedRenderStart = Math.max(0,
      Math.floor(requestedStart / metrics.columns) * metrics.columns);
    const requestedRenderEnd = Math.min(totalPages, requestedRenderStart + renderCapacity);
    const currentOutsideRequestedRender = currentPage < requestedRenderStart
      || currentPage >= requestedRenderEnd;
    const requested = preserveWindow
      ? requestedStart
      : (currentOutsideRequestedRender
        ? currentPage - Math.floor(CATALOG_RENDER_PAGE_SIZE / 2)
        : requestedStart);
    windowStart = Math.max(0, Math.min(maxStart, requested));
    windowEnd = Math.min(totalPages, windowStart + CATALOG_WINDOW_PAGE_COUNT);
  }

  // Spacer 高度以完整 row 計算；DOM 只掛載最多 160 個、列對齊的頁面。
  let renderStart = Math.max(0, Math.floor(windowStart / metrics.columns) * metrics.columns);
  let renderEnd = Math.min(totalPages, renderStart + renderCapacity);
  // 尾批從完整容量的頁面起點開始，必要時讓 CSS grid 從該列的中間欄位起排，
  // 這樣既保留整本幾何，也能在 <=160 個縮圖內包含最後一頁。
  if (totalPages > renderCapacity && windowStart >= maxStart) {
    renderStart = maxStart;
    renderEnd = totalPages;
  }
  windowEnd = Math.min(totalPages, Math.max(windowStart + 1, renderEnd));
  return {
    ...metrics,
    renderCapacity,
    maxStart,
    totalRows,
    windowStart,
    windowEnd,
    renderStart,
    renderEnd,
  };
}

function scheduleCatalogVirtualRender() {
  if (state.readingMode !== 'catalog' || catalogVirtualRenderFrame !== null || catalogResizeFrame !== null) return;
  catalogVirtualRenderOwner = catalogRenderOwner();
  const callback = () => {
    catalogVirtualRenderFrame = null;
    const owner = catalogVirtualRenderOwner;
    catalogVirtualRenderOwner = null;
    if (isCatalogRenderOwnerCurrent(owner)) renderCatalogGrid({ fromScroll: true });
  };
  catalogVirtualRenderFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : window.setTimeout(callback, 0);
}

function handleCatalogScroll() {
  scheduleCatalogVirtualRender();
}

let catalogResizeFrame = null;
let catalogResizeGeometry = null;
let catalogVirtualRenderOwner = null;

function catalogRenderOwner() {
  return {
    readerOperation: state.readerOperation,
    comicId: state.currentComic?.id || null,
    renderGeneration: state.renderGeneration,
    mode: state.readingMode,
  };
}

function isCatalogRenderOwnerCurrent(owner) {
  return Boolean(owner
    && owner.readerOperation === state.readerOperation
    && owner.comicId === (state.currentComic?.id || null)
    && owner.renderGeneration === state.renderGeneration
    && owner.mode === state.readingMode
    && owner.mode === 'catalog');
}

function cancelCatalogResize() {
  if (catalogResizeFrame !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(catalogResizeFrame);
    clearTimeout(catalogResizeFrame);
  }
  catalogResizeFrame = null;
  catalogResizeGeometry = null;
}

function scheduleCatalogResize() {
  if (catalogResizeFrame !== null) return;
  cancelCatalogVirtualRender();
  const oldColumns = state.catalogColumns || catalogGridMetrics().columns;
  const oldRowHeight = state.catalogRowHeight || (CATALOG_THUMB_HEIGHT + CATALOG_GRID_GAP);
  const oldControlOffset = Number(state.catalogControlOffset) || catalogGridOffset();
  catalogResizeGeometry = {
    oldColumns,
    oldRowHeight,
    oldControlOffset,
    oldScrollTop: Number(elements.readerViewport?.scrollTop) || 0,
    owner: catalogRenderOwner(),
  };
  const resize = () => {
    catalogResizeFrame = null;
    const geometry = catalogResizeGeometry;
    catalogResizeGeometry = null;
    if (!geometry || !isCatalogRenderOwnerCurrent(geometry.owner)) return;
    const nextMetrics = catalogGridMetrics();
    if (geometry.oldColumns === nextMetrics.columns
      && geometry.oldRowHeight === nextMetrics.rowHeight) return;

    // 以最新 viewport top 推回舊列的 logical page；不要拿 currentPageIndex
    // 當 anchor，因為它代表閱讀模式的跳頁位置，不代表目錄目前視窗。
    const contentTop = Math.max(0, geometry.oldScrollTop - geometry.oldControlOffset);
    const oldRow = Math.floor(contentTop / geometry.oldRowHeight);
    const anchorIndex = oldRow * geometry.oldColumns;
    const rowOffset = contentTop - oldRow * geometry.oldRowHeight;
    const newControlOffset = catalogGridOffset();
    const newRow = Math.floor(anchorIndex / nextMetrics.columns) * nextMetrics.rowHeight;
    const nextScrollTop = Math.max(0, newControlOffset + newRow + rowOffset);
    renderCatalogGrid({ fromScroll: true, scrollTopOverride: nextScrollTop });
    elements.readerViewport.scrollTop = nextScrollTop;
  };
  catalogResizeFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(resize)
    : window.setTimeout(resize, 0);
}

function handleReaderResize() {
  if (state.readingMode === 'catalog') {
    scheduleCatalogResize();
    return;
  }
  scheduleReaderImageTransformRefresh();
}

function pumpCatalogThumbnailLoads() {
  if (catalogImagePumpSuspended) return;
  while (catalogImageActive < CATALOG_IMAGE_CONCURRENCY && catalogImageQueue.length) {
    const task = catalogImageQueue.shift();
    if (!task?.img?.isConnected || task.generation !== catalogImageGeneration || !task.img.dataset.src) {
      if (task?.img) delete task.img.dataset.catalogLoadQueued;
      continue;
    }
    const img = task.img;
    const source = img.dataset.src;
    delete img.dataset.src;
    const taskGeneration = task.generation;
    const activeTask = { img, generation: taskGeneration, cancel: null };
    catalogImageTasks.add(activeTask);
    catalogImageActive += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      img.removeEventListener?.('load', finish);
      img.removeEventListener?.('error', finish);
      delete img.dataset.catalogLoadQueued;
      catalogImageTasks.delete(activeTask);
      if (taskGeneration !== catalogImageGeneration) return;
      catalogImageActive = Math.max(0, catalogImageActive - 1);
      pumpCatalogThumbnailLoads();
    };
    activeTask.cancel = () => {
      if (finished) return;
      finished = true;
      img.removeEventListener?.('load', finish);
      img.removeEventListener?.('error', finish);
      img.removeAttribute?.('src');
      delete img.dataset.catalogLoadQueued;
      catalogImageTasks.delete(activeTask);
      if (taskGeneration === catalogImageGeneration) {
        catalogImageActive = Math.max(0, catalogImageActive - 1);
        pumpCatalogThumbnailLoads();
      }
    };
    img.addEventListener('load', finish, { once: true });
    img.addEventListener('error', finish, { once: true });
    img.src = source;
  }
}

function enqueueCatalogThumbnailLoad(img, generation = catalogImageGeneration) {
  if (!img?.isConnected || !img?.dataset?.src || img.dataset.catalogLoadQueued) return;
  img.dataset.catalogLoadQueued = 'true';
  catalogImageQueue.push({ img, generation });
  pumpCatalogThumbnailLoads();
}

function startCatalogThumbnailLoads(grid, { reset = true } = {}) {
  if (reset) resetCatalogThumbnailLoader();
  const images = [...(grid.querySelectorAll?.('img[data-src]') || [])];
  const generation = catalogImageGeneration;
  if (typeof IntersectionObserver === 'function') {
    if (!catalogImageObserver) {
      catalogImageObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          catalogImageObserver?.unobserve?.(entry.target);
          enqueueCatalogThumbnailLoad(entry.target, catalogImageGeneration);
        });
      }, { root: elements.readerViewport, rootMargin: '360px' });
    }
    images.forEach(img => catalogImageObserver.observe(img));
  } else {
    // 舊 WKWebView 沒有 IntersectionObserver 時仍限制同時解碼數，避免 160 張一起壓垮主執行緒。
    images.forEach(img => enqueueCatalogThumbnailLoad(img, generation));
  }
}

function updateCatalogWindowControls(controls, bounds, totalPages) {
  if (!controls) return;
  const [previous, status, next] = [...(controls.children || [])];
  const capacity = bounds.renderCapacity || CATALOG_RENDER_PAGE_SIZE;
  if (previous) {
    previous.dataset.catalogWindowStart = String(bounds.windowStart);
    previous.dataset.catalogRenderStart = String(bounds.renderStart);
    previous.dataset.catalogRenderEnd = String(bounds.renderEnd);
    previous.dataset.catalogCapacity = String(capacity);
    previous.disabled = bounds.renderStart === 0;
    previous.textContent = readerText('顯示前 {count} 頁', { count: capacity });
  }
  if (status) {
    status.textContent = readerText('顯示第 {start}–{end} / {total} 頁', {
      start: bounds.renderStart + 1,
      end: bounds.renderEnd,
      total: totalPages,
    });
  }
  if (next) {
    next.dataset.catalogWindowStart = String(bounds.windowStart);
    next.dataset.catalogWindowEnd = String(bounds.windowEnd);
    next.dataset.catalogMaxStart = String(bounds.maxStart);
    next.dataset.catalogRenderStart = String(bounds.renderStart);
    next.dataset.catalogRenderEnd = String(bounds.renderEnd);
    next.dataset.catalogCapacity = String(capacity);
    next.disabled = bounds.renderEnd >= totalPages;
    next.textContent = readerText('顯示後 {count} 頁', { count: capacity });
  }
}

function createCatalogThumbnail(source, index) {
  const thumb = document.createElement('div');
  thumb.className = 'catalog-thumb';
  thumb.dataset.index = String(index);
  configureInteractiveItem(thumb, readerText('跳到第 {page} 頁', { page: index + 1 }), () => {
    state.currentPageIndex = index;
    const backMode = state.prevReadingMode || 'single';
    setReadingMode(backMode);
  });
  const img = document.createElement('img');
  // 目錄本身已由 IntersectionObserver／queue 控制何時 assign src；再掛原生
  // loading=lazy 會在 WKWebView 形成第二層延遲，快速跳到尾窗時可能遲遲不解碼。
  img.loading = 'eager';
  img.decoding = 'async';
  img.draggable = false;
  img.alt = readerText('第 {page} 頁', { page: index + 1 });
  const label = document.createElement('div');
  label.className = 'catalog-thumb-label';
  label.textContent = `${index + 1}`;
  // 點擊縮圖 → 跳頁並切回閱讀模式
  thumb.onclick = () => {
    state.currentPageIndex = index;
    const backMode = state.prevReadingMode || 'single';
    setReadingMode(backMode);
  };
  thumb.appendChild(img);
  thumb.appendChild(label);
  updateCatalogThumbnailNode(thumb, source, index);
  return thumb;
}

function updateCatalogThumbnailNode(thumb, source, index) {
  if (!thumb) return;
  const thumbnailSource = catalogThumbnailURL(source);
  thumb.dataset.index = String(index);
  thumb.classList?.toggle?.('current', index === state.currentPageIndex);
  const img = [...(thumb.children || [])].find(child => child?.tagName === 'IMG');
  if (!img) return;
  img.alt = readerText('第 {page} 頁', { page: index + 1 });
  if (img.dataset.catalogSource === thumbnailSource) return;
  cancelCatalogThumbnailLoad(img);
  img.dataset.catalogSource = thumbnailSource;
  img.dataset.src = thumbnailSource;
  img.removeAttribute?.('src');
}

function patchCatalogThumbnailWindow(grid, renderStart, renderEnd) {
  const retained = new Map();
  const leaving = [];
  [...(grid.children || [])].forEach(thumb => {
    if (!catalogHasClass(thumb, 'catalog-thumb')) return;
    const index = Number(thumb.dataset?.index);
    if (!Number.isInteger(index) || index < renderStart || index >= renderEnd) {
      const img = [...(thumb.children || [])].find(child => child?.tagName === 'IMG');
      leaving.push({ thumb, img });
      return;
    }
    retained.set(index, thumb);
  });

  // 先把整批舊節點 detach，再取消 task。cancel() 會同步嘗試補 queue，
  // 因此逐項移除會讓尚未 detach 的舊 queue 先搶走新窗的解碼槽位。
  leaving.forEach(({ thumb }) => grid.removeChild?.(thumb));
  const wasPumpSuspended = catalogImagePumpSuspended;
  catalogImagePumpSuspended = true;
  try {
    leaving.forEach(({ img }) => cancelCatalogThumbnailLoad(img));
  } finally {
    catalogImagePumpSuspended = wasPumpSuspended;
  }
  // 舊 active 全部離窗時，保留區的 queued task 可能沒有新的 IO entry；
  // 解除批次抑制後主動補泵，避免 active=0、queue>0 永久停住。
  pumpCatalogThumbnailLoads();

  for (let index = renderStart; index < renderEnd; index += 1) {
    let thumb = retained.get(index);
    if (!thumb) {
      thumb = createCatalogThumbnail(state.currentComicPages[index], index);
      const anchor = [...(grid.children || [])]
        .find(child => catalogHasClass(child, 'catalog-thumb')
          && Number(child.dataset?.index) > index);
      if (anchor) grid.insertBefore?.(thumb, anchor);
      else grid.appendChild(thumb);
    } else {
      updateCatalogThumbnailNode(thumb, state.currentComicPages[index], index);
    }
  }
}

function updateCatalogGridLayout(grid, bounds) {
  if (!grid) return;
  grid.style.setProperty?.('--catalog-columns', String(bounds.columns));
  const startColumn = bounds.renderStart % bounds.columns;
  if (startColumn) {
    grid.dataset.catalogStartColumn = String(startColumn + 1);
    grid.style.setProperty?.('--catalog-start-column', String(startColumn + 1));
  } else {
    delete grid.dataset.catalogStartColumn;
    grid.style.removeProperty?.('--catalog-start-column');
  }
}

function renderCatalogGrid({ preserveWindow = false, fromScroll = false, scrollTopOverride = null } = {}) {
  const totalPages = state.currentComicPages.length;
  const focusDescriptor = captureCatalogFocus();

  if (!totalPages) {
    cancelCatalogVirtualRender();
    resetCatalogThumbnailLoader();
    elements.pagesContainer.replaceChildren();
    state.catalogWindowStart = 0;
    state.catalogWindowEnd = 0;
    return;
  }

  const bounds = getCatalogVirtualBounds(totalPages, {
    preserveWindow,
    fromScroll,
    scrollTop: scrollTopOverride ?? elements.readerViewport?.scrollTop,
  });
  const existingGrid = elements.pagesContainer.querySelector?.('.reader-catalog-grid');
  if (fromScroll && existingGrid && state.catalogColumns === bounds.columns) {
    if (state.catalogWindowStart === bounds.windowStart && state.catalogWindowEnd === bounds.windowEnd) return;
    const controls = elements.pagesContainer.querySelector?.('.reader-catalog-window-controls');
    const topSpacer = elements.pagesContainer.querySelector?.('[data-catalog-spacer="top"]');
    const bottomSpacer = elements.pagesContainer.querySelector?.('[data-catalog-spacer="bottom"]');
    state.catalogWindowStart = bounds.windowStart;
    state.catalogWindowEnd = bounds.windowEnd;
    state.catalogRowHeight = bounds.rowHeight;
    updateCatalogWindowControls(controls, bounds, totalPages);
    if (topSpacer) topSpacer.style.height = `${Math.floor(bounds.renderStart / bounds.columns) * bounds.rowHeight}px`;
    if (bottomSpacer) {
      bottomSpacer.style.height = `${Math.max(0,
        bounds.totalRows - Math.ceil(bounds.renderEnd / bounds.columns)) * bounds.rowHeight}px`;
    }
    updateCatalogGridLayout(existingGrid, bounds);
    patchCatalogThumbnailWindow(existingGrid, bounds.renderStart, bounds.renderEnd);
    startCatalogThumbnailLoads(existingGrid, { reset: false });
    restoreCatalogFocus(focusDescriptor);
    return;
  }

  // 每次目錄重繪都先移除上一個 grid，避免切書或刪頁後舊縮圖疊在新內容上。
  elements.pagesContainer.replaceChildren();

  const {
    columns,
    rowHeight,
    totalRows,
    windowStart,
    windowEnd,
    renderStart,
    renderEnd,
  } = bounds;
  state.catalogWindowStart = windowStart;
  state.catalogWindowEnd = windowEnd;
  state.catalogColumns = columns;
  state.catalogRowHeight = rowHeight;

  const controls = document.createElement('div');
  controls.className = 'reader-catalog-window-controls';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'catalog-window-btn';
  previous.dataset.catalogWindowControl = 'previous';
  previous.textContent = readerText('顯示前 {count} 頁', { count: bounds.renderCapacity });
  previous.disabled = renderStart === 0;
  previous.addEventListener('click', () => {
    const currentBounds = getCatalogVirtualBounds(state.currentComicPages.length, { preserveWindow: true });
    const alignedEnd = Math.ceil(currentBounds.renderStart / currentBounds.columns) * currentBounds.columns;
    const target = Math.max(0, Math.min(currentBounds.maxStart,
      alignedEnd - currentBounds.renderCapacity));
    state.catalogWindowStart = target;
    elements.readerViewport.scrollTop = catalogScrollTopForPage(target);
    renderCatalogGrid({ preserveWindow: true, scrollTopOverride: elements.readerViewport.scrollTop });
  });
  const status = document.createElement('span');
  status.textContent = readerText('顯示第 {start}–{end} / {total} 頁', {
    start: renderStart + 1,
    end: renderEnd,
    total: totalPages,
  });
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'catalog-window-btn';
  next.dataset.catalogWindowControl = 'next';
  next.textContent = readerText('顯示後 {count} 頁', { count: bounds.renderCapacity });
  next.disabled = renderEnd >= totalPages;
  next.addEventListener('click', () => {
    const currentBounds = getCatalogVirtualBounds(state.currentComicPages.length, { preserveWindow: true });
    const target = Math.min(currentBounds.maxStart, currentBounds.renderEnd);
    state.catalogWindowStart = target;
    elements.readerViewport.scrollTop = catalogScrollTopForPage(target);
    renderCatalogGrid({ preserveWindow: true, scrollTopOverride: elements.readerViewport.scrollTop });
  });
  controls.appendChild(previous);
  controls.appendChild(status);
  controls.appendChild(next);
  updateCatalogWindowControls(controls, bounds, totalPages);
  elements.pagesContainer.appendChild(controls);
  state.catalogControlOffset = catalogGridOffset();

  const grid = document.createElement('div');
  grid.className = 'reader-catalog-grid';
  updateCatalogGridLayout(grid, bounds);

  const topSpacer = document.createElement('div');
  topSpacer.className = 'catalog-virtual-spacer';
  topSpacer.dataset.catalogSpacer = 'top';
  topSpacer.style.height = `${Math.floor(renderStart / columns) * rowHeight}px`;
  topSpacer.setAttribute('aria-hidden', 'true');

  state.currentComicPages.slice(renderStart, renderEnd).forEach((src, offset) => {
    const idx = renderStart + offset;
    const thumb = createCatalogThumbnail(src, idx);
    grid.appendChild(thumb);
  });

  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'catalog-virtual-spacer';
  bottomSpacer.dataset.catalogSpacer = 'bottom';
  bottomSpacer.style.height = `${Math.max(0, totalRows - Math.ceil(renderEnd / columns)) * rowHeight}px`;
  bottomSpacer.setAttribute('aria-hidden', 'true');

  elements.pagesContainer.appendChild(topSpacer);
  elements.pagesContainer.appendChild(grid);
  elements.pagesContainer.appendChild(bottomSpacer);
  startCatalogThumbnailLoads(grid);
  restoreCatalogFocus(focusDescriptor);

  // 只有首次進入目錄時定位目前頁；捲動重繪不可反覆改寫使用者位置。
  const currentThumb = grid.querySelector('.catalog-thumb.current');
  if (currentThumb && !preserveWindow && !fromScroll) {
    // 數千頁的 spacer 不適合平滑跨越；延遲動畫也可能在 resize 重繪後
    // 回寫舊位置。初次進入直接定位，之後的捲動／resize 由虛擬視窗接手。
    elements.readerViewport.scrollTop = catalogScrollTopForPage(state.currentPageIndex);
  }
}

// 輔助函式：取得檔案或目錄的父層目錄路徑
function getParentPath(relPath) {
  if (!relPath) return '';
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.substring(0, idx);
}

// 進入虛擬資料夾時，請 native 優先補掃目前目錄。掃描結果仍透過既有
// library-changed 事件回到書架，這裡刻意不等待 Promise，避免導航被磁碟 I/O 卡住。
function requestVisibleDirectoryScan(relativePath, {
  sourceId = state.currentSourceId,
  force = true,
  announce = true,
} = {}) {
  const location = normalizeDirectoryLocation(relativePath, sourceId);
  const locationKey = getDirectoryLocationKey(location.sourceId, location.relativePath);
  const status = elements.visibleScanStatus;
  const showStatus = message => {
    if (!status) return;
    status.hidden = !message;
    status.textContent = message;
  };
  // PhotoKit albums are virtual sources, not filesystem directories. Their
  // refresh is driven by get_library/photo-library-changed; sending this
  // location to the filesystem scanner produces a false source-mismatch UI.
  if (isVirtualDirectorySourceId(location.sourceId)) {
    showStatus('');
    return Promise.resolve(false);
  }
  const scanVisibleDirectory = eAPI?.scanVisibleDirectory;
  if (typeof scanVisibleDirectory !== 'function') {
    showStatus('');
    return Promise.resolve(false);
  }

  const existingRequest = visibleDirectoryScanInFlight.get(locationKey);
  if (existingRequest && existingRequest.epoch === visibleDirectoryNavigationEpoch) {
    return existingRequest.promise;
  }
  if (!force && (state.visibleDirectoryScanCompleted.has(locationKey)
    || (!location.sourceId && state.visibleDirectoryScanCompleted.has(location.relativePath)))) {
    return Promise.resolve(false);
  }

  const requestId = ++visibleDirectoryScanRequestId;
  const generation = state.visibleDirectoryGeneration;
  const requestEpoch = visibleDirectoryNavigationEpoch;
  const scanTarget = location.relativePath !== '📁 外部裝置';
  // Keep the last verified snapshot visible while this refresh runs. Clearing
  // it here briefly lets stale catalog-only folders reappear on A→B→A.
  state.visibleDirectoryScanCompleted.delete(locationKey);
  if (!location.sourceId) state.visibleDirectoryScanCompleted.delete(location.relativePath);
  showStatus(scanTarget && announce ? readerText('正在更新目前資料夾…') : '');
  const request = Promise.resolve()
    .then(() => scanVisibleDirectory(location.relativePath, location.sourceId || undefined))
    .then(() => {
      if (state.visibleDirectoryGeneration === generation) {
        state.visibleDirectoryScanCompleted.add(locationKey);
        if (state.currentPath === location.relativePath
          && state.currentSourceId === location.sourceId) {
          filterAndRenderGrid({ skipUnchanged: true, background: true });
          renderSidebar();
        }
      }
      if (!announce || !scanTarget || requestId !== visibleDirectoryScanRequestId
        || state.currentPath !== location.relativePath
        || state.currentSourceId !== location.sourceId) return;
      showStatus(readerText('目前資料夾已更新'));
      window.setTimeout(() => {
        if (requestId === visibleDirectoryScanRequestId
          && state.currentPath === location.relativePath
          && state.currentSourceId === location.sourceId) showStatus('');
      }, 2500);
    })
    .catch(error => {
      // 快速切換資料夾時，舊請求的錯誤不應覆蓋目前資料夾的狀態。
      if (!announce || requestId !== visibleDirectoryScanRequestId
        || state.currentPath !== location.relativePath
        || state.currentSourceId !== location.sourceId) return;
      showStatus(readerText('目前資料夾更新失敗：{error}', { error: error?.message || error }));
      console.warn('無法優先掃描目前資料夾：', error);
      return false;
    })
    .finally(() => {
      if (visibleDirectoryScanInFlight.get(locationKey)?.promise === request) {
        visibleDirectoryScanInFlight.delete(locationKey);
      }
    });
  visibleDirectoryScanInFlight.set(locationKey, { promise: request, epoch: requestEpoch });
  return request;
}

function navigateLibraryToPath(relativePath, sourceId = '') {
  const location = normalizeDirectoryLocation(relativePath, sourceId);
  if (location.relativePath === '📁 外部裝置') location.sourceId = '';
  if (elements.searchInput?.value) {
    elements.searchInput.value = '';
    if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = 'none';
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = null;
    state.catalogSearchRequest += 1;
    state.catalogSearchIds = null;
    state.catalogSearchItems.clear();
    state.catalogSearchTotal = 0;
    renderCatalogFacets({});
  }
  state.activeSeries = 'all';
  setCurrentDirectoryLocation(location);
  state.expandedFolderPaths.add('root');
  const pathParts = state.currentPath.split('/').filter(Boolean);
  let expandedPath = '';
  pathParts.forEach(part => {
    expandedPath = expandedPath ? `${expandedPath}/${part}` : part;
    const expandedKey = expandedPath === '📁 外部裝置'
      ? getFolderTreeNodeKey('', expandedPath)
      : getFolderTreeNodeKey(state.currentSourceId, expandedPath);
    state.expandedFolderPaths.add(expandedKey);
  });
  // 根目錄或另一個資料夾也會使先前的掃描請求失去 UI 關聯。
  visibleDirectoryScanRequestId += 1;
  visibleDirectoryNavigationEpoch += 1;
  requestVisibleDirectoryScan(state.currentPath, { sourceId: state.currentSourceId });
  filterAndRenderGrid();
  renderSidebar();
}

function syncLibraryUpButton() {
  if (!elements.libraryUpBtn) return;
  const canNavigateUp = Boolean(state.currentPath);
  elements.libraryUpBtn.disabled = !canNavigateUp;
  elements.libraryUpBtn.setAttribute('aria-disabled', String(!canNavigateUp));
}

function navigateLibraryUp() {
  if (!state.currentPath) {
    syncLibraryUpButton();
    return false;
  }
  state.selectedComicId = null;
  lastInspectorRenderSignature = '';
  navigateLibraryToPath(getParentPath(state.currentPath), state.currentSourceId);
  return true;
}

function getComicSourceKey(comic) {
  const sourceId = comic?.sourceId ?? comic?.source_id;
  if (sourceId != null && String(sourceId).trim()) return String(sourceId);
  if (isBuiltInDemoComic(comic)) return BUILT_IN_DEMO_SOURCE_ID;
  if (isPhotoAlbum(comic)) return 'photos:';
  // A missing source identity must never accidentally merge two roots.
  return comic?.id ? `comic:${comic.id}` : '';
}

function invalidateComicNavigationCache() {
  state.comicsRevision += 1;
  comicNavigationCache = {
    comics: null,
    revision: -1,
    groups: new Map(),
    byId: new Map(),
  };
}

function getComicNavigationCache() {
  if (comicNavigationCache.comics === state.comics
    && comicNavigationCache.revision === state.comicsRevision) {
    return comicNavigationCache;
  }

  const groups = new Map();
  const byId = new Map();
  state.comics.forEach(comic => {
    if (!comic?.id) return;
    byId.set(comic.id, comic);
    if (comic.isDirectory) return;
    const key = JSON.stringify([getComicSourceKey(comic), getParentPath(comic.relativePath)]);
    const group = groups.get(key) || [];
    group.push(comic);
    groups.set(key, group);
  });
  groups.forEach(group => group.sort((a, b) => comicTitleCollator.compare(String(a.title || ''), String(b.title || ''))));
  comicNavigationCache = { comics: state.comics, revision: state.comicsRevision, groups, byId };
  return comicNavigationCache;
}

function getReaderNavigationCurrent() {
  const currentId = state.currentComic?.id || state.pendingComicId;
  if (!currentId) return null;
  const shelfComic = getComicNavigationCache().byId.get(currentId);
  return {
    current: state.currentComic || shelfComic,
    shelfComic,
    currentId,
  };
}

function findAdjacentComicInFolder(direction) {
  const reader = getReaderNavigationCurrent();
  if (!reader?.current) return null;
  const anchor = reader.shelfComic || reader.current;
  const relativePath = reader.current.relativePath ?? anchor.relativePath;
  const parentPath = getParentPath(relativePath);
  const sourceKey = getComicSourceKey(anchor);
  const siblings = getComicNavigationCache().groups.get(JSON.stringify([sourceKey, parentPath])) || [];
  const currentIndex = siblings.findIndex(comic => comic.id === reader.currentId);
  const targetIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
  return currentIndex >= 0 && targetIndex >= 0 && targetIndex < siblings.length
    ? siblings[targetIndex]
    : null;
}

function scheduleAdjacentComicOpen(comic, direction, delayMs = 800, expectedMode = null) {
  if (!comic) return false;
  const switchToken = ++adjacentComicSwitchToken;
  const operation = state.readerOperation;
  const currentId = state.currentComic?.id;
  if (delayMs > 0) {
    showReaderToast(readerText('🔄 即將為您開啟{direction}：{title}', { direction: readerText(direction === 'next' ? '下一本' : '上一本'), title: comic.title }));
  }
  setTimeout(() => {
    if (switchToken !== adjacentComicSwitchToken) return;
    if (operation !== state.readerOperation || !state.currentComic || state.currentComic.id !== currentId) return;
    if (expectedMode && (state.readingMode !== expectedMode
      || findAdjacentComicInFolder(direction)?.id !== comic.id)) return;
    openReader(comic.id);
  }, delayMs);
  return true;
}

function openAdjacentComicInFolder(direction) {
  const target = findAdjacentComicInFolder(direction);
  if (target) {
    scheduleAdjacentComicOpen(target, direction);
    return;
  }
  showReaderToast(readerText(direction === 'next'
    ? '🎉 已經是該目錄下的最後一本囉！'
    : '🎉 已經是該目錄下的第一本囉！'));
}

// 姬米妮貼心功能：尋找資料夾內的下一本漫畫並開啟
function openNextComicInFolder() {
  openAdjacentComicInFolder('next');
}

// 姬米妮貼心功能：尋找資料夾內的上一本漫畫並開啟
function openPrevComicInFolder() {
  openAdjacentComicInFolder('prev');
}

function requestWebtoonAdjacentComic(direction) {
  if (state.readingMode !== 'webtoon') return false;
  const target = findAdjacentComicInFolder(direction);
  if (!target) {
    showReaderToast(readerText(direction === 'next'
      ? '🎉 已經是該目錄下的最後一本囉！'
      : '🎉 已經是該目錄下的第一本囉！'));
    return false;
  }

  return scheduleAdjacentComicOpen(target, direction, 0, 'webtoon');
}

// 翻到上一頁
function prevPage() {
  let startReached = false;
  if (state.readingMode === 'single') {
    if (state.currentPageIndex > 0) {
      state.currentPageIndex--;
      renderPages();
    } else {
      startReached = true;
    }
  } else if (state.readingMode === 'double' || state.readingMode === 'double-rtl') {
    if (state.currentPageIndex === 1) {
      // 第一頁跳回封面 (0)
      state.currentPageIndex = 0;
      renderPages();
    } else if (state.currentPageIndex === 2 && state.doublePairOffset === 0) {
      // The shifted 2–3 pair still has the normal 1–2 pair before the cover.
      state.currentPageIndex = 1;
      state.doublePairOffset = 1;
      renderPages();
    } else if (state.currentPageIndex > 1) {
      // 其餘每次退 2 頁
      state.currentPageIndex -= 2;
      renderPages();
    } else {
      startReached = true;
    }
  }

  if (startReached) {
    openPrevComicInFolder();
  }
}

// 跳到特定頁面
function jumpToPage(pageIndex) {
  const totalPages = state.currentComicPages.length;
  if (pageIndex < 0 || pageIndex >= totalPages) return;

  if (state.readingMode === 'webtoon') {
    state.currentPageIndex = pageIndex;
    anchorWebtoonPage(pageIndex, { behavior: 'smooth', renderGeneration: state.renderGeneration });
    // 更新進度
    elements.pageCounter.textContent = readerText('第 {page} / {total} 頁', { page: pageIndex + 1, total: totalPages });
    elements.progressSlider.value = pageIndex + 1;
    if (state.readerReadyPages.has(pageIndex)) saveReadingProgress();
  } else {
    // 雙頁模式依目前配對相位對齊；錯開後可合法落在偶數索引。
    if (isDoubleReadingMode()) {
      state.currentPageIndex = doublePageStartForIndex(pageIndex);
    } else {
      state.currentPageIndex = pageIndex;
    }
    renderPages();
  }
}

function jumpToFirstPage() {
  if (!state.currentComicPages.length) return;
  if (isDoubleReadingMode()) state.doublePairOffset = 1;
  jumpToPage(0);
  showReaderToast(readerText('已跳到首頁'));
}

function jumpToLastPage() {
  if (!state.currentComicPages.length) return;
  jumpToPage(state.currentComicPages.length - 1);
  showReaderToast(readerText('已跳到尾頁'));
}

function goPreviousByReadingDirection() {
  if (state.readingMode === 'double-rtl') {
    nextPage();
  } else {
    prevPage();
  }
}

function goNextByReadingDirection() {
  if (state.readingMode === 'double-rtl') {
    prevPage();
  } else {
    nextPage();
  }
}

function isCatalogThumbnailInteraction(event) {
  if (event.target?.closest?.('.catalog-thumb')) return true;
  // WK 相容事件可能以 viewport 為 target；用實際點位確認縮圖，
  // 保留目錄空白處原有的工具列操作。
  if (state.readingMode !== 'catalog'
    || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
  return Boolean(document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('.catalog-thumb'));
}

function handleReaderPointerClick(e) {
  if (elements.readerOverlay.style.display === 'none' || e.button !== 0) return;
  if (isCatalogThumbnailInteraction(e)) return;
  // 目錄縮圖是 role=button 的 div；其 pointerup 之後仍要交給原生 click，
  // 不能被閱讀器的中間 tap 或左右翻頁 chrome 先吃掉。
  if (e.target.closest?.('button, input, select, textarea, a, #ai-page-panel, .catalog-thumb')) return;

  // 如果是觸控裝置且是滑動(Swipe)，已經由 touchend 處理，pointerup 可以避免重複觸發
  // pointerup 也會被觸發，所以我們根據滑動距離來排除
  // 但我們簡化處理：將螢幕分為左 30%、中 40%、右 30%
  if (state.readerContextMenuOpen) {
    hideReaderContextMenu();
    return;
  }

  const w = window.innerWidth;
  const x = e.clientX;

  // 漫條輕點任何閱讀區域都能切換工具列；滑動已由上游手勢守衛排除。
  if (state.readingMode === 'webtoon' || (x >= w * 0.3 && x <= w * 0.7)) {
    if (elements.readerOverlay.classList.contains('reader-idle')) {
      triggerControlsActive();
    } else {
      elements.readerOverlay.classList.add('reader-idle');
    }
  } else if (x < w * 0.3) {
    goPreviousByReadingDirection();
  } else {
    goNextByReadingDirection();
  }
}

function handleReaderAuxClick(e) {
  if (elements.readerOverlay.style.display === 'none') return;
  if (e.target.closest?.('button, input, select, textarea')) return;
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();

  if (e.button === 3) {
    goPreviousByReadingDirection();
    showReaderToast(readerText('滑鼠側鍵：上一頁'));
  } else {
    goNextByReadingDirection();
    showReaderToast(readerText('滑鼠側鍵：下一頁'));
  }
}

function handleReaderContextMenu(e) {
  if (elements.readerOverlay.style.display === 'none' || !elements.readerContextMenu) return;
  e.preventDefault();
  triggerControlsActive();

  const menu = elements.readerContextMenu;
  menu.style.display = 'flex';
  state.readerContextMenuOpen = true;

  const rect = menu.getBoundingClientRect();
  const padding = 12;
  const left = Math.min(e.clientX, window.innerWidth - rect.width - padding);
  const top = Math.min(e.clientY, window.innerHeight - rect.height - padding);
  menu.style.left = `${Math.max(padding, left)}px`;
  menu.style.top = `${Math.max(padding, top)}px`;
}

function hideReaderContextMenu() {
  if (!elements.readerContextMenu) return;
  elements.readerContextMenu.style.display = 'none';
  state.readerContextMenuOpen = false;
}

function handleReaderContextAction(action) {
  hideReaderContextMenu();
  triggerControlsActive();

  switch (action) {
    case 'single':
    case 'double':
    case 'webtoon':
      if (action !== 'double' || !isDoubleReadingMode()) setReadingMode(action);
      break;
    case 'double-direction':
      toggleDoubleDirection();
      break;
    case 'double-shift':
      advanceDoubleBySinglePage();
      break;
    case 'first':
      jumpToFirstPage();
      break;
    case 'last':
      jumpToLastPage();
      break;
    case 'fit':
      toggleFitMode();
      break;
    case 'crop':
      toggleCropEdges();
      break;
    case 'brightness':
      cycleBrightness();
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
    case 'close':
      closeReader();
      break;
  }
}

// ==========================================================================
// ⚡ 快取與預載機制 (Performance Optimization)
// ==========================================================================

// 後端依實際頁面容量保留壓縮資料；前端只解碼目前頁附近，避免 GPU/像素記憶體膨脹。
function preloadNextPages() {
  const pages = state.currentComicPages;
  const current = state.currentPageIndex;
  const total = pages.length;

  const preloadRadius = state.readerCacheReadyPage === current ? READER_PRELOAD_RADIUS : 2;
  const indicesToPreload = [];
  for (let distance = 1; distance <= preloadRadius; distance++) {
    indicesToPreload.push(current + distance, current - distance);
  }

  indicesToPreload.forEach(idx => {
    if (idx >= 0 && idx < total && !state.preloadedImages.has(idx)) {
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.src = pages[idx];
      state.preloadedImages.set(idx, img);
      if (Math.abs(idx - current) <= 2) img.decode().catch(() => {});
      img.onerror = () => {
        if (state.preloadedImages.get(idx) !== img) return;
        img.removeAttribute('src');
        state.preloadedImages.delete(idx);
      };
    }
  });

  prunePreloadedImages(indicesToPreload);
}

function scheduleReaderCacheWindowUpdate() {
  clearTimeout(state.readerCacheWindowTimer);
  if (!state.currentComic || isBuiltInDemoComic(state.currentComic) || typeof eAPI.updateReaderCacheWindow !== 'function') return;

  const comicId = state.currentComic.id;
  const pageIndex = state.currentPageIndex;
  if (state.readerCacheWindowPage === pageIndex) return;
  const readerOperation = state.readerOperation;
  const renderGeneration = state.renderGeneration;
  const requestToken = ++state.readerCacheWindowToken;
  state.readerCacheWindowPage = pageIndex;
  state.readerCacheReadyPage = null;
  state.readerCacheWindowTimer = setTimeout(async () => {
    state.readerCacheWindowTimer = null;
    const isCurrentRequest = () => state.readerOperation === readerOperation
      && state.renderGeneration === renderGeneration
      && state.readerCacheWindowToken === requestToken
      && state.currentComic?.id === comicId
      && state.currentPageIndex === pageIndex
      && state.readerCacheWindowPage === pageIndex;
    if (!isCurrentRequest()) return;
    try {
      const generation = await eAPI.updateReaderCacheWindow(comicId, pageIndex);
      if (isCurrentRequest() && Number.isSafeInteger(generation)) {
        state.currentComic.preloadGeneration = generation;
      }
    } catch (error) {
      if (isCurrentRequest()) {
        state.readerCacheWindowPage = null;
      }
      console.warn('[RAM cache window]', error);
    }
  }, READER_CACHE_UPDATE_DELAY_MS);
}

function prunePreloadedImages(indicesToPreload = []) {
  const keep = new Set(indicesToPreload.filter(idx => idx >= 0 && idx < state.currentComicPages.length));
  keep.add(state.currentPageIndex);

  for (const [idx, img] of state.preloadedImages) {
    if (!keep.has(idx)) {
      img.removeAttribute('src');
      state.preloadedImages.delete(idx);
    }
  }

  if (state.preloadedImages.size <= MAX_PRELOADED_IMAGES) return;

  const byDistance = Array.from(state.preloadedImages.keys())
    .sort((a, b) => Math.abs(b - state.currentPageIndex) - Math.abs(a - state.currentPageIndex));

  while (state.preloadedImages.size > MAX_PRELOADED_IMAGES && byDistance.length) {
    const idx = byDistance.shift();
    if (idx === state.currentPageIndex) continue;
    const img = state.preloadedImages.get(idx);
    if (img) img.removeAttribute('src');
    state.preloadedImages.delete(idx);
  }
}

// 條漫模式的程式化跳頁錨點。目標頁上方的圖片載入或尺寸改變時，只補償
// 這次跳頁建立的差值；使用者一旦開始操作，便立即交還滾動控制權。
function cancelWebtoonAnchor() {
  const anchor = state.webtoonAnchor;
  if (anchor?.resizeObserver) anchor.resizeObserver.disconnect();
  state.webtoonAnchor = null;
}

function cancelWebtoonAnchorFromUserInput() {
  if (state.readingMode === 'webtoon') cancelWebtoonAnchor();
}

function isActiveWebtoonAnchor(anchor = state.webtoonAnchor) {
  return Boolean(anchor
    && anchor.generation === state.renderGeneration
    && state.readingMode === 'webtoon'
    && state.currentComic
    && anchor.index >= 0
    && anchor.index < state.currentComicPages.length);
}

function getWebtoonImage(index) {
  return elements.pagesContainer.querySelector(`img[data-index="${index}"]`);
}

function getWebtoonImageOffsetTop(img) {
  if (!img) return null;
  const rect = img.getBoundingClientRect?.();
  const viewportRect = elements.readerViewport.getBoundingClientRect?.();
  if (Number.isFinite(rect?.top) && Number.isFinite(viewportRect?.top)) {
    return rect.top - viewportRect.top + elements.readerViewport.scrollTop;
  }
  return Number.isFinite(img.offsetTop) ? img.offsetTop : null;
}

function getWebtoonAnchorViewportOffset() {
  const computed = typeof getComputedStyle === 'function'
    ? getComputedStyle(elements.readerViewport)
    : null;
  const configured = parseFloat(computed?.scrollPaddingTop);
  return Number.isFinite(configured) ? configured : 64;
}

function preserveWebtoonAnchorPosition() {
  const anchor = state.webtoonAnchor;
  if (!isActiveWebtoonAnchor(anchor)) return;

  const targetImg = getWebtoonImage(anchor.index);
  const targetTop = getWebtoonImageOffsetTop(targetImg);
  if (!Number.isFinite(targetTop)) return;

  if (Number.isFinite(anchor.lastTargetTop)) {
    const delta = targetTop - anchor.lastTargetTop;
    if (delta) elements.readerViewport.scrollTop += delta;
  } else {
    anchor.targetViewportOffset = targetTop - elements.readerViewport.scrollTop;
  }
  anchor.lastTargetTop = targetTop;
}

function observeWebtoonAnchorLayout(anchor) {
  const ResizeObserverCtor = window.ResizeObserver || globalThis.ResizeObserver;
  if (typeof ResizeObserverCtor !== 'function') return;
  anchor.resizeObserver = new ResizeObserverCtor(() => {
    if (isActiveWebtoonAnchor(anchor)) preserveWebtoonAnchorPosition();
  });
  anchor.resizeObserver.observe(elements.pagesContainer);
}

function anchorWebtoonPage(index, { behavior = 'auto', renderGeneration = state.renderGeneration } = {}) {
  if (state.readingMode !== 'webtoon' || renderGeneration !== state.renderGeneration) return false;
  if (index < state.webtoonWindowStart || index >= state.webtoonWindowEnd) {
    const scrollTop = elements.readerViewport.scrollTop;
    renderWebtoonWindow(index, renderGeneration);
    elements.readerViewport.scrollTop = scrollTop;
  }
  const targetImg = getWebtoonImage(index);
  if (!targetImg) return false;

  cancelWebtoonAnchor();
  const anchor = { index, generation: renderGeneration, lastTargetTop: null, resizeObserver: null };
  state.webtoonAnchor = anchor;
  state.currentPageIndex = index;
  scheduleAutoPageExplanation();
  elements.pageCounter.textContent = readerText('第 {page} / {total} 頁', {
    page: index + 1,
    total: state.currentComicPages.length,
  });
  elements.progressSlider.value = index + 1;
  loadWebtoonImagesAround(index);
  targetImg.scrollIntoView({ behavior, block: 'start' });
  // scrollIntoView 在不同 WKWebView 版本對 nested overflow + scroll-padding
  // 的處理不一致，直接補一次容器 scrollTop 才能保證目標頁落在工具列下方。
  const targetTop = getWebtoonImageOffsetTop(targetImg);
  if (Number.isFinite(targetTop)) {
    const targetOffset = getWebtoonAnchorViewportOffset();
    elements.readerViewport.scrollTop = Math.max(0, targetTop - targetOffset);
  }
  preserveWebtoonAnchorPosition();
  observeWebtoonAnchorLayout(anchor);
  // 某些 WKWebView 會在 scrollIntoView 後才派發 scroll；先記住目標頁，
  // 避免那個程式化事件把 currentPageIndex 改回第一頁。
  handleWebtoonScroll();
  return true;
}

// 條漫模式滾動載入與進度計算
function handleWebtoonScroll() {
  if (state.webtoonScrollFrame) return;
  state.webtoonScrollFrame = requestAnimationFrame(() => {
    state.webtoonScrollFrame = null;
    updateWebtoonScrollState();
  });
}

function updateWebtoonScrollState() {
  if (state.readingMode !== 'webtoon' || !state.currentComic) return;
  if (isActiveWebtoonAnchor()) {
    preserveWebtoonAnchorPosition();
    return;
  }
  const viewportTop = elements.readerViewport.scrollTop;
  const viewportHeight = elements.readerViewport.clientHeight;
  const viewportCenter = viewportTop + viewportHeight / 2;
  const pageContentOffset = state.webtoonNavigationOffset + getWebtoonAnchorViewportOffset();
  const activeIndex = webtoonPageIndexAtOffset(viewportCenter - pageContentOffset);

  const nextWindow = getWebtoonWindowBounds(state.currentComicPages.length, activeIndex);
  const outsideWindow = activeIndex < state.webtoonWindowStart || activeIndex >= state.webtoonWindowEnd;
  const nearWindowEdge = activeIndex < state.webtoonWindowStart + 6
    || activeIndex >= state.webtoonWindowEnd - 6;
  if ((outsideWindow || nearWindowEdge)
    && (nextWindow.start !== state.webtoonWindowStart || nextWindow.end !== state.webtoonWindowEnd)) {
    const previousScrollTop = viewportTop;
    renderWebtoonWindow(activeIndex);
    elements.readerViewport.scrollTop = previousScrollTop;
    loadWebtoonImagesAround(activeIndex);
  }

  if (activeIndex !== state.currentPageIndex) {
    state.currentPageIndex = activeIndex;
    elements.pageCounter.textContent = readerText('第 {page} / {total} 頁', { page: state.currentPageIndex + 1, total: state.currentComicPages.length });
    elements.progressSlider.value = state.currentPageIndex + 1;
    // 條漫不會經過 replaceReaderImages；頁面隨捲動變更時要重新排程
    // 隨讀翻譯，否則只會翻譯開啟功能當下的那一頁。
    scheduleAutoPageExplanation();

    // 即時懶加載附近的圖片
    loadWebtoonImagesAround(activeIndex);

    // 僅在目前頁已實際載入時儲存；未載入頁由 load callback 補存。
    clearTimeout(state.progressSaveTimer);
    state.progressSaveTimer = state.readerReadyPages.has(activeIndex)
      ? setTimeout(saveReadingProgress, 500)
      : null;
  }
}

// 條漫模式載入附近頁面的實體圖片
function loadWebtoonImagesAround(index) {
  const total = state.currentComicPages.length;
  const range = 3; // 載入前後 3 頁

  const start = Math.max(state.webtoonWindowStart, index - range);
  const end = Math.min(state.webtoonWindowEnd - 1, index + range, total - 1);
  for (let i = start; i <= end; i += 1) {
    const img = getWebtoonImage(i);
    if (img && !img.getAttribute('src')) {
      tuneImageForLowPriority(img);
      img.src = img.dataset.src;
    }
  }
}

// 儲存進度至主程序
async function saveReadingProgress() {
  await enqueueReadingProgressSnapshot(createReadingProgressSnapshot());
}

// ==========================================================================
// 🎛️ 輔助控制 (Zoom、全螢幕、UI 狀態)
// ==========================================================================

// 切換閱讀模式
function setReadingMode(mode) {
  // 如果要退出 catalog，記住上一個模式
  if (mode === 'catalog') {
    state.prevReadingMode = state.readingMode !== 'catalog' ? state.readingMode : (state.prevReadingMode || 'single');
  }
  const wasDouble = isDoubleReadingMode();
  state.readingMode = mode;
  if (isDoubleReadingMode(mode) && !wasDouble) {
    state.doublePairOffset = state.currentPageIndex === 0 ? 1 : state.currentPageIndex % 2;
  }

  // 更新按鈕 active 樣式
  elements.btnModeSingle.classList.toggle('active', mode === 'single');
  elements.btnModeDouble.classList.toggle('active', isDoubleReadingMode(mode));
  elements.btnModeWebtoon.classList.toggle('active', mode === 'webtoon');
  elements.btnModeCatalog.classList.toggle('active', mode === 'catalog');
  [
    [elements.btnModeSingle, 'single'],
    [elements.btnModeDouble, 'double'],
    [elements.btnModeWebtoon, 'webtoon'],
    [elements.btnModeCatalog, 'catalog']
  ].forEach(([button, value]) => button.setAttribute('aria-pressed', String(value === 'double' ? isDoubleReadingMode(mode) : mode === value)));

  // 控制 Zoom 面板的隱藏與顯示
  const disableZoom = mode === 'webtoon' || mode === 'catalog';
  elements.zoomValue.parentElement.style.opacity = disableZoom ? '0.3' : '1';
  elements.zoomValue.parentElement.style.pointerEvents = disableZoom ? 'none' : 'auto';
  updateReaderUiControls();

  // 重繪
  renderPages();
}

// 調整縮放
function adjustZoom(amount) {
  if (state.readingMode === 'webtoon') return;

  state.zoomPercentage = Math.max(50, Math.min(250, state.zoomPercentage + amount));
  elements.zoomValue.textContent = `${state.zoomPercentage}%`;

  // 套用縮放
  refreshReaderImageTransforms();
}

// 啟用/停用全螢幕
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    elements.readerOverlay.requestFullscreen().then(() => {
      elements.btnFullscreen.innerHTML = '<i class="fa-solid fa-compress"></i>';
    }).catch(err => {
      console.error('全螢幕啟用失敗', err);
    });
  } else {
    document.exitFullscreen().then(() => {
      elements.btnFullscreen.innerHTML = '<i class="fa-solid fa-expand"></i>';
    });
  }
}

// 鍵盤快捷鍵處理
function handleKeyDown(e) {
  // 只有當閱讀器打開時，才觸發閱讀器快捷鍵
  if (elements.readerOverlay.style.display === 'none') return;
  // 設定視窗與文字輸入擁有鍵盤事件；不能在輸入 Key 時翻頁或旋轉。
  if (typeof getActiveLibraryModal === 'function' && getActiveLibraryModal()) return;
  const target = e.target;
  if (target !== elements.progressSlider && (
    target?.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(target?.tagName || '').toUpperCase())
  )) return;
  // 進度 range 的方向／跳格鍵交給原生控制與 input handler，避免 document
  // 快捷鍵再翻一次頁；Escape、F 等 reader shortcut 仍要能正常作用。
  if (e.target && (e.target === elements.progressSlider || e.target?.id === 'progress-slider')
    && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) return;
  if ((state.readingMode === 'webtoon' || state.readingMode === 'catalog')
    && ['ArrowUp', 'ArrowDown', ' ', 'Spacebar'].includes(e.key)) {
    cancelWebtoonAnchorFromUserInput();
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
      goPreviousByReadingDirection();
      break;
    case 'ArrowRight':
      goNextByReadingDirection();
      break;
    case 'ArrowUp':
      e.preventDefault();
      jumpToFirstPage();
      break;
    case 'ArrowDown':
      e.preventDefault();
      jumpToLastPage();
      break;
    case 'Spacebar':
    case ' ':
      e.preventDefault();
      nextPage();
      break;
    case 'f':
    case 'F':
      e.preventDefault();
      toggleFullscreen();
      break;
    case 'm':
    case 'M':
      e.preventDefault();
      toggleFitMode();
      break;
    case 'l':
    case 'L':
      e.preventDefault();
      rotateImage(-90);
      break;
    case 'r':
    case 'R':
      e.preventDefault();
      rotateImage(90);
      break;
    case 's':
    case 'S':
      e.preventDefault();
      toggleSharpen();
      break;
    case 'c':
    case 'C':
      e.preventDefault();
      toggleCropEdges();
      break;
    case 'b':
    case 'B':
      e.preventDefault();
      cycleBrightness();
      break;
    case 'Escape':
      e.preventDefault();
      if (state.readerContextMenuOpen) {
        hideReaderContextMenu();
        triggerControlsActive();
        break;
      }
      closeReader();
      break;
  }
}

// 更新浮動按鈕控制面板樣式
function updateReaderUiControls() {
  const mode = state.readingMode;
  elements.btnModeSingle.classList.toggle('active', mode === 'single');
  elements.btnModeDouble.classList.toggle('active', isDoubleReadingMode(mode));
  elements.btnModeWebtoon.classList.toggle('active', mode === 'webtoon');
  elements.btnModeCatalog.classList.toggle('active', mode === 'catalog');
  [
    [elements.btnModeSingle, 'single'],
    [elements.btnModeDouble, 'double'],
    [elements.btnModeWebtoon, 'webtoon'],
    [elements.btnModeCatalog, 'catalog']
  ].forEach(([button, value]) => button.setAttribute('aria-pressed', String(value === 'double' ? isDoubleReadingMode(mode) : mode === value)));
  syncDoubleModeControls();
  elements.zoomValue.textContent = `${state.zoomPercentage}%`;
  elements.readerOverlay.classList.toggle('reader-crop-edges', state.cropEdges);
  elements.btnCrop.classList.toggle('active', state.cropEdges);
  elements.btnCrop.setAttribute('aria-pressed', String(state.cropEdges));
  elements.btnBrightness.classList.toggle('active', state.brightness !== 100);
  elements.btnBrightness.setAttribute('aria-label', readerText('目前亮度 {brightness}%，按下切換', { brightness: state.brightness }));

  // 條漫與目錄模式都沒有可套用 fit/rotate 的單頁圖片，控制項必須真的停用。
  const imageTransformDisabled = mode === 'webtoon' || mode === 'catalog';
  const imageTransformControls = [elements.btnFitMode, elements.btnRotateLeft, elements.btnRotateRight];
  imageTransformControls.forEach(button => {
    if (!button) return;
    button.disabled = imageTransformDisabled;
    button.setAttribute('aria-disabled', String(imageTransformDisabled));
  });
  if (imageTransformDisabled) {
    elements.btnFitMode.style.opacity = '0.3';
    elements.btnFitMode.style.pointerEvents = 'none';
    elements.btnRotateLeft.style.opacity = '0.3';
    elements.btnRotateLeft.style.pointerEvents = 'none';
    elements.btnRotateRight.style.opacity = '0.3';
    elements.btnRotateRight.style.pointerEvents = 'none';
  } else {
    elements.btnFitMode.style.opacity = '1';
    elements.btnFitMode.style.pointerEvents = 'auto';
    elements.btnRotateLeft.style.opacity = '1';
    elements.btnRotateLeft.style.pointerEvents = 'auto';
    elements.btnRotateRight.style.opacity = '1';
    elements.btnRotateRight.style.pointerEvents = 'auto';
  }
}

// 📺 切換螢幕適應模式 (適應螢幕 -> 寬度適應 -> 高度適應)
function toggleFitMode() {
  if (state.readingMode === 'webtoon' || state.readingMode === 'catalog') return;

  const modes = ['contain', 'width', 'height'];
  let currentIndex = modes.indexOf(state.fitMode);
  let nextIndex = (currentIndex + 1) % modes.length;
  state.fitMode = modes[nextIndex];

  // 儲存設定
  localStorage.setItem('readerFitMode', state.fitMode);

  // 套用樣式
  applyFitMode();

  // 顯示氣泡提示
  let toastMsg = '';
  if (state.fitMode === 'contain') toastMsg = readerText('📺 螢幕適應：自適應螢幕 (保持比例)');
  else if (state.fitMode === 'width') toastMsg = readerText('📺 螢幕適應：寬度適應 ↔️');
  else if (state.fitMode === 'height') toastMsg = readerText('📺 螢幕適應：高度適應 ↕️');

  showReaderToast(toastMsg);
}

// 📺 套用螢幕適應樣式
function applyFitMode() {
  // 移除所有適應 class
  elements.readerOverlay.classList.remove('fit-contain', 'fit-width', 'fit-height');

  // 套用當前適應 class
  elements.readerOverlay.classList.add(`fit-${state.fitMode}`);

  // 更新按鈕圖標與 title 說明
  const icon = elements.btnFitMode.querySelector('i');
  if (state.fitMode === 'contain') {
    icon.className = 'fa-solid fa-compress';
    elements.btnFitMode.title = readerText('螢幕適應：自適應螢幕 (M 鍵)');
  } else if (state.fitMode === 'width') {
    icon.className = 'fa-solid fa-arrows-left-right';
    elements.btnFitMode.title = readerText('螢幕適應：寬度適應 (M 鍵)');
  } else if (state.fitMode === 'height') {
    icon.className = 'fa-solid fa-arrows-up-down';
    elements.btnFitMode.title = readerText('螢幕適應：高度適應 (M 鍵)');
  }
  scheduleReaderImageTransformRefresh();
}

// 🔄 旋轉漫畫圖片 (degrees: 90 或 -90)
function rotateImage(degrees) {
  if (state.readingMode === 'webtoon') {
    showReaderToast(readerText('條漫模式不支援旋轉。'));
    return;
  }
  if (state.readingMode === 'catalog') {
    showReaderToast(readerText('目錄模式不支援旋轉。'));
    return;
  }

  state.rotationAngle = (state.rotationAngle + degrees) % 360;
  const normalizedAngle = normalizedRotationAngle();
  syncReaderRotationUi();
  refreshReaderImageTransforms();

  showReaderToast(readerText('🔄 畫面已旋轉 {angle}°', { angle: normalizedAngle }));
}

// ✨ 銳利化模式切換（循環：關閉 → 輕度 → 中度 → 強度 → 關閉）
function toggleSharpen() {
  state.sharpenLevel = (state.sharpenLevel + 1) % 4;
  applySharpenFilter();

  const labels = ['關閉', '✨ 輕度銳利', '✨✨ 中度銳利', '✨✨✨ 強度銳利']
    .map(label => readerText(label));
  showReaderToast(readerText('🔍 銳利化：{label}', { label: labels[state.sharpenLevel] }));
}

// 套用銳利化濾鏡到當前所有閱讀器圖片
function applySharpenFilter() {
  const renderingMap = {
    0: 'auto',
    1: 'auto',
    2: '-webkit-optimize-contrast',
    3: 'pixelated',
  };

  const imageRendering = renderingMap[state.sharpenLevel];
  const isActive = state.sharpenLevel > 0;

  // 更新按鈕視覺狀態
  elements.btnSharpen.classList.toggle('active', isActive);
  if (isActive) {
    elements.btnSharpen.style.color = 'var(--accent)';
    elements.btnSharpen.style.textShadow = '0 0 8px var(--accent)';
  } else {
    elements.btnSharpen.style.color = '';
    elements.btnSharpen.style.textShadow = '';
  }

  // 套用到所有目前可見的閱讀器圖片
  const imgs = elements.pagesContainer.querySelectorAll('img');
  imgs.forEach(img => {
    img.style.filter = imageFilterValue();
    img.style.imageRendering = imageRendering;
  });
}

function toggleCropEdges() {
  state.cropEdges = !state.cropEdges;
  localStorage.setItem('readerCropEdges', String(state.cropEdges));
  elements.readerOverlay.classList.toggle('reader-crop-edges', state.cropEdges);
  elements.btnCrop.classList.toggle('active', state.cropEdges);
  elements.btnCrop.setAttribute('aria-pressed', String(state.cropEdges));
  showReaderToast(readerText(state.cropEdges ? '⌗ 已非破壞式裁切頁面外緣 2%' : '⌗ 已顯示完整頁面'));
}

function cycleBrightness() {
  const levels = [100, 85, 70, 115];
  const current = levels.indexOf(state.brightness);
  state.brightness = levels[(current + 1) % levels.length];
  localStorage.setItem('readerBrightness', String(state.brightness));
  elements.btnBrightness.classList.toggle('active', state.brightness !== 100);
  elements.btnBrightness.setAttribute('aria-label', readerText('目前亮度 {brightness}%，按下切換', { brightness: state.brightness }));
  elements.pagesContainer.querySelectorAll('img').forEach(applyImageEffects);
  showReaderToast(readerText('☀️ 亮度：{brightness}%', { brightness: state.brightness }));
}

// 💬 顯示精緻的微提示 (Toast)
function showReaderToast(message) {
  let toast = document.getElementById('reader-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'reader-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');
    toast.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.9);
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #fff;
      padding: 12px 24px;
      border-radius: 30px;
      font-size: 13.5px;
      font-weight: 600;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      z-index: 9999;
      pointer-events: none;
    `;
    elements.readerOverlay.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.display = 'block';

  // 強制重繪
  toast.offsetHeight;

  toast.style.opacity = '1';
  toast.style.transform = 'translate(-50%, -50%) scale(1)';

  if (toast.timeoutId) {
    clearTimeout(toast.timeoutId);
  }

  toast.timeoutId = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translate(-50%, -50%) scale(0.9)';
    setTimeout(() => {
      if (toast.style.opacity === '0') {
        toast.style.display = 'none';
      }
    }, 200);
  }, 1200);
}

// 滑鼠移動時顯示控制欄，靜止 3 秒自動隱藏
function triggerControlsActive() {
  elements.readerOverlay.classList.remove('reader-idle');
  elements.readerTopBar.classList.add('active');
  elements.readerBottomBar.classList.add('active');

  clearTimeout(state.readerIdleTimer);
  state.readerIdleTimer = setTimeout(() => {
    if (elements.readerOverlay.style.display === 'flex' && !state.readerContextMenuOpen) {
      elements.readerOverlay.classList.add('reader-idle');
      elements.readerTopBar.classList.remove('active');
      elements.readerBottomBar.classList.remove('active');
    }
  }, 2200);
}

// ==========================================================================
// 💡 全局 UI 控制 (Loader)
// ==========================================================================

function showLoader(text, options = {}) {
  clearTimeout(state.loaderHideTimer);
  state.loaderHideTimer = null;
  state.loaderRefCount = 1;
  elements.loaderText.textContent = text || readerText('載入中…');
  elements.loaderMask.style.display = 'flex';
  if (Object.prototype.hasOwnProperty.call(options, 'progress')) {
    showLoaderProgress(options.progress, options.detail || '');
  } else {
    hideLoaderProgress();
  }
}

function hideLoader() {
  clearTimeout(state.loaderHideTimer);
  state.loaderHideTimer = null;
  state.loaderRefCount = 0;
  elements.loaderMask.style.display = 'none';
  hideLoaderProgress();
}

// 🔧 BUG-FIX：緊急強制隱藏 Loader（不管 refCount 多少），供 timeout 等情境使用
function forceHideLoader() {
  state.loaderRefCount = 0;
  elements.loaderMask.style.display = 'none';
  hideLoaderProgress();
}

// 🚀 姬米妮貼心設計：顯示/隱藏背景圖片解碼狀態小菊花
function showPageLoadingSpinner(show) {
  if (!elements.statusLoading) return;
  elements.statusLoading.style.display = show ? 'inline-flex' : 'none';
}

function showLoaderProgress(progress = null, detail = '') {
  if (!elements.loaderProgress || !elements.loaderProgressBar) return;
  elements.loaderProgress.style.display = 'block';
  setLoaderProgress(progress, detail);
}

function setLoaderProgress(progress = null, detail = '') {
  if (!elements.loaderProgress || !elements.loaderProgressBar) return;
  const isNumber = Number.isFinite(progress);
  elements.loaderProgress.style.display = 'block';
  elements.loaderProgress.classList.toggle('indeterminate', !isNumber);
  elements.loaderProgressBar.style.width = isNumber ? `${Math.max(0, Math.min(100, progress))}%` : '42%';
  if (elements.loaderProgressLabel) {
    elements.loaderProgressLabel.textContent = detail || (isNumber ? `${Math.round(progress)}%` : readerText('正在處理中...'));
  }
}

function hideLoaderProgress() {
  if (!elements.loaderProgress || !elements.loaderProgressBar) return;
  elements.loaderProgress.style.display = 'none';
  elements.loaderProgress.classList.remove('indeterminate');
  elements.loaderProgressBar.style.width = '0%';
  if (elements.loaderProgressLabel) elements.loaderProgressLabel.textContent = '';
}

function updateLoaderScanProgress(status) {
  if (!status) return;
  const nextGeneration = Number(status.generation);
  const currentGeneration = Number(state.scanStatus?.generation);
  if (Number.isSafeInteger(nextGeneration)
    && nextGeneration > 0
    && Number.isSafeInteger(currentGeneration)
    && currentGeneration > nextGeneration) {
    return;
  }
  if (Number.isSafeInteger(nextGeneration)
    && nextGeneration > 0
    && currentGeneration === nextGeneration
    && state.scanStatus?.isScanning === false
    && state.scanStatus?.completedAt
    && status.isScanning) {
    return;
  }
  state.scanStatus = { ...(state.scanStatus || {}), ...status };
  updateScanRecovery(status);
  updateLibraryStartPanel();
  if (!status.pollError && !status.error) {
    state.scanStatus.pollError = false;
  }
  requestPriorityLibraryScan(state.scanStatus, state.favorites);
  // Old API responses omit phase. Use only fields present in this response for
  // the decision, so a previously observed catalog phase cannot mask an old
  // style `{ isScanning: false }` completion.
  const hasPhase = Object.prototype.hasOwnProperty.call(status, 'phase');
  const phase = hasPhase ? String(status.phase || '').toLowerCase() : '';
  // A source may report a recoverable error while the overall scan is still
  // running. Only terminal phase=error (or an old-style stopped response with
  // an error) should end the progress UI.
  const isError = phase === 'error' || (status.isScanning === false && Boolean(status.error));
  const isComplete = phase === 'complete' || (!phase && status.isScanning === false);
  if (status.isScanning || phase === 'discovering' || phase === 'catalog') {
    clearTimeout(state.loaderHideTimer);
    state.loaderHideTimer = null;
  }
  if (isError) {
    stopScanStatusPolling();
    if (elements.loaderMask.style.display === 'none') return;
    // Backend errors can contain source paths; keep private paths out of UI.
    showLoaderProgress(null, readerText('書架整理失敗，請稍後再試。'));
    // An error must remain visible long enough to read, then close without
    // ever passing through the success/completed state.
    state.loaderHideTimer = window.setTimeout(hideLoader, 3500);
    return;
  }
  if (status.isScanning || phase === 'discovering' || phase === 'catalog') {
    state.libraryRefreshPending = true;
  }
  if (isComplete || (!phase && status.isScanning === false)) {
    stopScanStatusPolling();
    if (state.libraryRefreshPending) {
      state.libraryRefreshPending = false;
      scheduleLibraryRefresh(0);
    }
    if (elements.loaderMask.style.display === 'none') return;
    const completeText = status.detailDeferred
      ? readerText('書架已更新；詳細資料可按需重新匯入')
      : readerText('書架整理完成');
    setLoaderProgress(100, completeText);
    // Keep the result readable long enough for a person to notice the final
    // state, especially when detailDeferred explains why metadata is partial.
    state.loaderHideTimer = window.setTimeout(hideLoader, 1200);
    return;
  }
  if (elements.loaderMask.style.display === 'none') return;
  if (status.pollError) {
    showLoaderProgress(null, readerText('暫時無法取得掃描狀態；仍在等待結果…'));
    return;
  }
  if (phase === 'catalog') {
    const processed = Math.max(0, Number(status.processed) || 0);
    const total = Math.max(0, Number(status.total) || 0);
    const detail = readerText('正在整理書架 {processed} / {total} 本', { processed, total });
    const percentage = total > 0 ? Math.min(100, (processed / total) * 100) : null;
    showLoaderProgress(percentage, detail);
    return;
  }
  const found = Number(status.found || 0);
  showLoaderProgress(null, readerText('正在掃描漫畫庫，已發現 {count} 本', { count: found }));
}

function startScanStatusPolling() {
  if (!eAPI?.getScanStatus) return;
  stopScanStatusPolling();
  failedCoverIds.clear();
  state.scanStatus = { ...(state.scanStatus || {}), isScanning: true };
  const generation = ++scanPollGeneration;
  let attempts = 0;
  let consecutiveFailures = 0;
  let pollInFlight = false;
  let timerId = null;
  let request = null;
  const markTemporaryFailure = () => {
    if (generation !== scanPollGeneration || state.scanStatusPollTimer !== timerId) return;
    state.scanStatus = {
      ...(state.scanStatus || {}),
      // A timeout or transient error says nothing about the scanner itself.
      // Keep the last real value instead of turning an unknown state into done.
      isScanning: state.scanStatus?.isScanning !== false,
      pollError: true,
    };
    if (elements.loaderMask.style.display !== 'none') {
      showLoaderProgress(null, readerText('暫時無法取得掃描狀態；仍在等待結果…'));
    }
  };
  const stopAfterWallclock = () => {
    if (generation !== scanPollGeneration || state.scanStatusPollTimer !== timerId) return;
    // Stop scheduling after the independent wallclock cap, while leaving the
    // real scanner state intact. A later event or late response may still
    // reconcile the status through updateLoaderScanProgress().
    markTemporaryFailure();
    clearInterval(timerId);
    clearTimeout(state.scanStatusPollWallclockTimer);
    state.scanStatusPollWallclockTimer = null;
    state.scanStatusPollTimer = null;
    scanPollGeneration += 1;
  };
  timerId = setInterval(() => {
    if (generation !== scanPollGeneration || state.scanStatusPollTimer !== timerId || pollInFlight) return;
    pollInFlight = true;
    attempts += 1;
    const existingRequest = scanStatusPendingRequest;
    if (existingRequest && !existingRequest.settled) {
      // Reattach this poll generation to the one unresolved native request;
      // never issue another call merely because the old interval was stopped.
      if (existingRequest.timedOut) {
        markTemporaryFailure();
      }
      existingRequest.promise
        .then(status => {
          const statusGeneration = Number(status?.generation);
          const currentStatusGeneration = Number(state.scanStatus?.generation);
          const lateGenerationIsSafe = Number.isSafeInteger(statusGeneration)
            && statusGeneration > 0
            && (!Number.isSafeInteger(currentStatusGeneration) || statusGeneration >= currentStatusGeneration);
          if (generation === scanPollGeneration
            && state.scanStatusPollTimer === timerId
            && lateGenerationIsSafe) {
            updateLoaderScanProgress(status);
          }
        })
        .catch(() => markTemporaryFailure())
        .finally(() => {
          if (generation === scanPollGeneration && state.scanStatusPollTimer === timerId) {
            pollInFlight = false;
          }
        });
      return;
    }
    const requestGeneration = generation;
    const requestTimerId = timerId;
    const requestState = { timedOut: false, settled: false, timeoutId: null };
    request = requestState;
    requestState.timeoutId = setTimeout(() => {
      if (requestState.settled) return;
      requestState.timedOut = true;
      markTemporaryFailure();
      // Keep pollInFlight true until the native Promise settles. This leaves
      // at most one unresolved native call and prevents a 700ms call storm.
    }, SCAN_STATUS_REQUEST_TIMEOUT_MS);
    let nativePromise;
    try {
      // Invoke synchronously at the timer edge so a slow native call is
      // counted immediately; Promise resolution is still handled below.
      nativePromise = eAPI.getScanStatus();
    } catch (error) {
      nativePromise = Promise.reject(error);
    }
    requestState.promise = Promise.resolve(nativePromise);
    scanStatusPendingRequest = requestState;
    requestState.promise
      .then(status => {
        // A wallclock stop invalidates the poll loop, but a late response from
        // this request can still be useful when it carries a non-stale scan
        // generation (for example, a native call that woke after suspension).
        const canApply = requestGeneration === scanPollGeneration
          && state.scanStatusPollTimer === requestTimerId;
        const statusGeneration = Number(status?.generation);
        const currentStatusGeneration = Number(state.scanStatus?.generation);
        const lateGenerationIsSafe = Number.isSafeInteger(statusGeneration)
          && statusGeneration > 0
          && (!Number.isSafeInteger(currentStatusGeneration) || statusGeneration >= currentStatusGeneration);
        const lateAfterWallclock = !canApply
          && lateGenerationIsSafe
          && (status?.phase === 'complete' || status?.phase === 'error' || status?.isScanning === false);
        if (canApply || lateAfterWallclock) updateLoaderScanProgress(status);
        consecutiveFailures = 0;
      })
      .catch(() => {
        consecutiveFailures += 1;
        markTemporaryFailure();
      })
      .finally(() => {
        requestState.settled = true;
        clearTimeout(requestState.timeoutId);
        if (scanStatusPendingRequest === requestState) scanStatusPendingRequest = null;
        if (request === requestState) request = null;
        // Even if the request was late, do not let it permanently gate future
        // polling for the same generation. Stopped generations stay stopped.
        if (requestGeneration === scanPollGeneration && state.scanStatusPollTimer === requestTimerId) {
          pollInFlight = false;
        }
      });
    // The old attempts cap remains a cheap guard for completed requests;
    // wallclockTimer is the independent cap for a permanently pending call.
    if (attempts >= 3600 || consecutiveFailures >= 6) stopAfterWallclock();
  }, SCAN_STATUS_POLL_INTERVAL_MS);
  state.scanStatusPollTimer = timerId;
  state.scanStatusPollWallclockTimer = setTimeout(stopAfterWallclock, SCAN_STATUS_POLL_WALLCLOCK_MS);
}

function stopScanStatusPolling() {
  clearInterval(state.scanStatusPollTimer);
  clearTimeout(state.scanStatusPollWallclockTimer);
  state.scanStatusPollTimer = null;
  state.scanStatusPollWallclockTimer = null;
  scanPollGeneration += 1;
}

// 滑鼠滾輪翻頁處理
function handleWheelScroll(e) {
  if (state.readingMode === 'webtoon') cancelWebtoonAnchor();
  // 如果是條漫模式或目錄模式，允許原生滾動，不作攔截
  if (state.readingMode === 'webtoon' || state.readingMode === 'catalog') return;
  // 放大單頁時 viewport 需要保留原生 wheel 平移；只有頁面沒有溢位時
  // 才把滾輪視為翻頁手勢。
  if (state.readingMode === 'single' && readerViewportCanScroll()) return;

  e.preventDefault();

  const now = Date.now();
  // 600ms 的翻頁冷卻時間，防止滑動太快
  if (state.lastWheelTime && (now - state.lastWheelTime < 600)) {
    return;
  }

  // deltaY 大於 30 才觸發，避免極微小抖動誤觸
  if (Math.abs(e.deltaY) > 30) {
    state.lastWheelTime = now;
    if (e.deltaY > 0) {
      // 滾輪往下滾 -> 下一頁
      nextPage();
    } else {
      // 滾輪往上滾 -> 上一頁
      prevPage();
    }
  }
}

function isLibraryModalVisible(modal) {
  if (!modal || modal.hidden || modal.getAttribute?.('aria-hidden') === 'true') return false;
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(modal) : null;
  return modal.style?.display !== 'none' && (!style || (style.display !== 'none' && style.visibility !== 'hidden'));
}

function getLibraryModalFocusables(modal) {
  const selectors = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  return [...(modal?.querySelectorAll?.(selectors) || [])].filter(isLibraryModalElementFocusable);
}

function isLibraryModalElementFocusable(element) {
  if (!element || element.hidden || element.disabled || element.getAttribute?.('aria-hidden') === 'true') return false;
  let current = element;
  while (current) {
    if (current.nodeType && current.nodeType !== 1) break;
    if (current.hidden || current.disabled || current.getAttribute?.('aria-hidden') === 'true') return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    current = current.parentElement || current.parentNode;
  }
  return true;
}

function getActiveLibraryModal() {
  const candidates = [elements.smbModal, elements.settingsModal];
  return candidates.find(isLibraryModalVisible) || null;
}

function openLibraryModal(modal) {
  if (!modal) return;
  state.libraryModal = modal;
  modal.tabIndex = -1;
  modal.setAttribute('aria-hidden', 'false');
  if (!state.libraryModalBackgroundSnapshot) {
    state.libraryModalBackgroundSnapshot = [...(document.body?.children || [])]
      // Commerce opens above Settings when a Pro feature is tapped. Keep its
      // dialog interactive while the rest of the library stays inert.
      .filter(child => child !== modal && child.id !== 'commerce-pro-modal')
      .map(element => ({
        element,
        inert: Boolean(element.inert),
        ariaHidden: element.getAttribute?.('aria-hidden'),
      }));
  }
  state.libraryModalBackgroundSnapshot.forEach(({ element }) => {
    element.inert = true;
    element.setAttribute?.('aria-hidden', 'true');
  });
}

function closeLibraryModal(modal) {
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'true');
  if (state.libraryModal === modal) state.libraryModal = null;
  if (!getActiveLibraryModal()) {
    state.libraryModalBackgroundSnapshot?.forEach(({ element, inert, ariaHidden }) => {
      element.inert = inert;
      if (ariaHidden === null || ariaHidden === undefined) element.removeAttribute?.('aria-hidden');
      else element.setAttribute?.('aria-hidden', ariaHidden);
    });
    state.libraryModalBackgroundSnapshot = null;
    const returnFocus = state.dialogReturnFocus;
    state.dialogReturnFocus = null;
    returnFocus?.focus?.({ preventScroll: true });
  }
}

function focusLibraryModalEntry(modal, preferred) {
  const focusables = getLibraryModalFocusables(modal);
  (preferred && focusables.includes(preferred) ? preferred : focusables[0] || modal)?.focus?.({ preventScroll: true });
}

function handleLibraryModalKeyDown(event) {
  const proModal = document.getElementById('commerce-pro-modal');
  if (proModal && !proModal.hidden) return;
  const modal = getActiveLibraryModal();
  if (!modal) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (modal === elements.smbModal) closeSmbModal();
    else closeSettingsModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = getLibraryModalFocusables(modal);
  if (!focusables.length) {
    event.preventDefault();
    focusLibraryModalEntry(modal);
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!modal.contains(document.activeElement)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function guardLibraryModalFocus(event) {
  const proModal = document.getElementById('commerce-pro-modal');
  if (proModal && !proModal.hidden) return;
  const modal = getActiveLibraryModal();
  if (!modal || modal.contains(event.target)) return;
  focusLibraryModalEntry(modal);
}

// ==========================================================================
// ⚙️ 漫畫庫目錄路徑設定邏輯
// ==========================================================================

// 打開設定視窗
function configureSettingsSourceControls() {
  const isIOS = isIOSLibraryDevice() && typeof window.electronAPI?.openExternalFolder === 'function';
  if (elements.scanPathRow) elements.scanPathRow.hidden = isIOS;
  if (elements.saveSettingsBtn) elements.saveSettingsBtn.hidden = !isIOS;
  if (isIOS) elements.librarySourceLabel?.removeAttribute('for');
  return isIOS;
}

async function openSettingsModal() {
  state.dialogReturnFocus = document.activeElement;
  openLibraryModal(elements.settingsModal);
  elements.settingsModal.style.display = 'flex';
  focusLibraryModalEntry(elements.settingsModal, elements.closeSettingsBtn);
  renderExternalBookmarks();
  void refreshAiSessionStatus();
  void window.GaiCommerce?.refresh?.();

  // iOS 用 bookmark 加入來源；外觀即時保存，完成按鈕只關閉設定。
  // 不讀取或套用桌面路徑，也不等待正在背景掃描的外部書庫。
  if (configureSettingsSourceControls()) return;

  try {
    const config = await eAPI.getConfig();
    elements.scanDirInput.value = config.scanDir;
    await fetchBrowserFolders(config.scanDir);
  } catch (e) {
    console.error('載入漫畫庫設定失敗：', e);
  }
}

function openAiSettings() {
  // openSettingsModal 在第一個 await 前就會顯示視窗；直接把焦點帶到 AI 設定。
  void openSettingsModal().catch(error => console.warn('無法開啟 AI 設定：', error));
  elements.aiProvider?.closest('.ai-settings')?.scrollIntoView({ block: 'start' });
  const target = elements.aiRestoreBtn && !elements.aiRestoreBtn.hidden && !elements.aiRestoreBtn.disabled
    ? elements.aiRestoreBtn : elements.aiApiKey;
  target?.focus?.({ preventScroll: true });
}

async function exportCatalogMetadataFile() {
  if (!eAPI?.exportCatalogMetadata) return;
  try {
    const payload = await eAPI.exportCatalogMetadata();
    const filename = `gai-metadata-${new Date().toISOString().slice(0, 10)}.json`;
    if (eAPI.saveCatalogMetadata) {
      const defaultPath = eAPI.getCatalogExportPath ? await eAPI.getCatalogExportPath(filename) : filename;
      const path = await eAPI.saveCatalogMetadata(defaultPath, payload);
      if (path) updateOrganizerUi(readerText('metadata 已匯出至 {path}', { path }));
      return;
    }
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) {
    updateOrganizerUi(readerText('metadata 匯出失敗：{error}', { error: error?.message || error }));
  }
}

async function previewCatalogMetadataFile(event) {
  const file = event.target.files?.[0];
  if (!file || !eAPI?.previewCatalogImport || !elements.catalogImportPreview) return;
  try {
    const payload = await file.text();
    const preview = await eAPI.previewCatalogImport(payload);
    elements.catalogImportPreview.innerHTML = `
      <strong>${readerText('可配對 {matched} 本；未配對 {unmatched} 本；衝突 {conflicts} 項。', { matched: preview.matched, unmatched: preview.unmatched.length, conflicts: preview.conflicts.length })}</strong>
      <p>${readerText('「安全匯入」保留本機手動值；「採用匯入衝突值」會明確覆寫列出的衝突，兩者都可撤銷。')}</p>
      <div class="catalog-exchange-actions">
        <button type="button" class="modal-action-btn" data-import-strategy="safe">${readerText('安全匯入')}</button>
        ${preview.conflicts.length ? `<button type="button" class="modal-action-btn catalog-import-risk" data-import-strategy="incoming">${readerText('採用匯入衝突值')}</button>` : ''}
      </div>`;
    elements.catalogImportPreview.querySelectorAll('[data-import-strategy]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        const resolutions = button.dataset.importStrategy === 'incoming'
          ? Object.fromEntries(preview.conflicts.map(conflict => [conflict.key, 'useIncoming']))
          : {};
        try {
          const result = await eAPI.applyCatalogImport({ payload, resolutions });
          state.lastUndoToken = result.undoToken;
          elements.catalogImportPreview.textContent = readerText('已更新 {updated} 本，保留 {conflicts} 個本機衝突；可在整理列撤銷。', { updated: result.updated, conflicts: result.skippedConflicts });
          await fetchLibrary();
        } catch (error) {
          button.disabled = false;
          elements.catalogImportPreview.textContent = readerText('匯入失敗：{error}', { error: error?.message || String(error) });
        }
      });
    });
  } catch (error) {
    elements.catalogImportPreview.textContent = readerText('無法預覽交換檔：{error}', { error: error?.message || String(error) });
  } finally {
    event.target.value = '';
  }
}

function bindKeyboardActivation(element, action) {
  if (!element) return;
  element.addEventListener('keydown', event => {
    if (event.target !== element || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  });
}

function configureInteractiveItem(element, label, action) {
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', label);
  element.onkeydown = event => {
    if (event.target !== element || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };
}

function renderExternalBookmarks() {
  const container = document.getElementById('external-bookmarks-list');
  if (!container) return;

  const bookmarks = readExternalBookmarks();
  if (bookmarks.length === 0) {
    container.innerHTML = `<div style="font-size: 0.9em; color: var(--text-muted);"><i class="fa-solid fa-info-circle"></i> ${readerText('目前沒有已加入的外部資料夾')}</div>`;
    return;
  }

  container.innerHTML = `<div style="font-size: 0.9em; color: var(--text-muted); margin-bottom: 5px;"><i class="fa-solid fa-link"></i> ${readerText('已連結的外部資料夾：')}</div>`;
  bookmarks.forEach((b) => {
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.style.background = 'var(--bg-card)';
    item.style.padding = '8px 12px';
    item.style.borderRadius = '6px';
    item.style.border = '1px solid var(--border)';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `📁 ${b.name}`;
    nameSpan.style.color = 'var(--text-light)';

    const delBtn = document.createElement('button');
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.title = readerText('移除外部資料夾：{name}', { name: b.name });
    delBtn.setAttribute('aria-label', readerText('移除外部資料夾：{name}', { name: b.name }));
    delBtn.className = 'external-bookmark-remove';
    delBtn.type = 'button';
    delBtn.style.background = 'var(--accent-red)';
    delBtn.style.color = 'white';
    delBtn.style.border = 'none';
    delBtn.style.padding = '5px 10px';
    delBtn.style.borderRadius = '4px';
    delBtn.style.cursor = 'pointer';
    const bookmarkIdentity = b.bookmark;
    delBtn.onclick = async () => {
      if (confirm(readerText('確定要移除外部資料夾 [{name}] 嗎？', { name: b.name }))) {
        let desiredBookmarks = null;
        try {
          await enqueueExternalBookmarkMutation(async () => {
            const latestBookmarks = readExternalBookmarks();
            const nextBookmarks = latestBookmarks.filter(bookmark => bookmark.bookmark !== bookmarkIdentity);
            desiredBookmarks = nextBookmarks;
            if (nextBookmarks.length === latestBookmarks.length) return;
            if (window.electronAPI && window.electronAPI.setBookmarks) {
              await window.electronAPI.setBookmarks(nextBookmarks);
            }
            localStorage.setItem('gai:externalBookmarks', JSON.stringify(nextBookmarks));
          });
        } catch (error) {
          const { message, stateWasUpdated } = classifyBookmarkUpdateError(error);
          if (!stateWasUpdated) {
            console.error('移除外部資料夾失敗：', error);
            alert(readerText('移除失敗，來源清單沒有變更：\n{message}', { message }));
            return;
          }
          // 原生清單已提交；仍保存新清單，避免下次啟動重新加入已移除的來源。
          if (desiredBookmarks) localStorage.setItem('gai:externalBookmarks', JSON.stringify(desiredBookmarks));
          if (elements.scanDirStatus) elements.scanDirStatus.textContent = readerText('來源已移除；舊存取權限將在 App 結束後釋放。');
        }
        renderExternalBookmarks();
        alert(readerText('移除成功，將為您重新掃描...'));
        elements.refreshBtn.click();
      }
    };

    item.appendChild(nameSpan);
    item.appendChild(delBtn);
    container.appendChild(item);
  });
}

// 關閉設定視窗
function closeSettingsModal() {
  elements.settingsModal.style.display = 'none';
  closeLibraryModal(elements.settingsModal);
}

function openSmbModal() {
  closeSettingsModal();
  const smbConfig = sanitizeSmbConfig();
  elements.smbHost.value = smbConfig.host || '';
  elements.smbShare.value = smbConfig.share || '';
  elements.smbUser.value = smbConfig.username || '';
  elements.smbPass.value = '';
  openLibraryModal(elements.smbModal);
  elements.smbModal.style.display = 'flex';
  state.dialogReturnFocus = document.activeElement;
  focusLibraryModalEntry(elements.smbModal, elements.closeSmbBtn);
}

function closeSmbModal() {
  elements.smbModal.style.display = 'none';
  closeLibraryModal(elements.smbModal);
}

async function saveSmbConfig() {
  const host = elements.smbHost.value.trim();
  const share = elements.smbShare.value.trim();
  const username = elements.smbUser.value.trim();
  const password = elements.smbPass.value;

  if (!host || !share) {
    showReaderToast(readerText('❌ IP 與共用資料夾名稱不可為空！'));
    return;
  }

  elements.smbConnectBtn.disabled = true;
  elements.smbConnectBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${readerText('正在連線...')}`;

  const config = { host, share, username, password };
  const safeConfig = { host, share, username };
  // 呼叫後端套用設定
  try {
    if (!eAPI?.setSmbConfig) {
      throw new Error(readerText('此環境不支援 SMB 設定'));
    }
    await eAPI.setSmbConfig(config);
    localStorage.setItem('gai:smb', JSON.stringify(safeConfig));
    showReaderToast(readerText('✅ SMB 設定已儲存！請重新整理書架。'));
    closeSmbModal();
  } catch (err) {
    showReaderToast(readerText('❌ SMB 設定失敗：{error}', { error: err }));
  } finally {
    elements.smbConnectBtn.disabled = false;
    elements.smbConnectBtn.innerHTML = `<i class="fa-solid fa-plug"></i> ${readerText('測試並儲存')}`;
  }
}

async function clearSmbConfig() {
  try {
    if (eAPI?.setSmbConfig) {
      await eAPI.setSmbConfig(null);
    }
    localStorage.removeItem('gai:smb');
    elements.smbHost.value = '';
    elements.smbShare.value = '';
    elements.smbUser.value = '';
    elements.smbPass.value = '';
    showReaderToast(readerText('✅ 已清除 SMB 連線'));
    closeSmbModal();
  } catch (err) {
    console.error('清除 SMB 設定失敗：', err);
    showReaderToast(readerText('❌ SMB 清除失敗：{error}', { error: err?.message || err }));
  }
}

// 瀏覽路徑按鈕點擊事件獲取並渲染資料夾清單
async function fetchBrowserFolders(dirPath) {
  try {
    const data = await eAPI.browseFolders(dirPath);

    state.browserCurrentPath = data.currentPath;
    state.browserParentPath = data.parentPath;

    elements.browserCurrentPath.textContent = data.currentPath;
    elements.browserUpBtn.style.display = data.parentPath ? 'flex' : 'none';

    elements.browserFoldersList.innerHTML = '';

    if (data.folders.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.style.padding = '20px';
      div.innerHTML = `<span style="font-size: 13px; color: var(--text-dark);">${readerText('此目錄下無其他子資料夾')}</span>`;
      elements.browserFoldersList.appendChild(div);
      return;
    }

    data.folders.forEach(folder => {
      const item = document.createElement('div');
      item.className = 'folder-browser-item';
      item.innerHTML = `
        <div class="folder-item-left">
          <i class="fa-solid fa-folder"></i>
          <span>${escapeHtml(folder.name)}</span>
        </div>
        <button class="folder-select-action-btn" title="${readerText('選擇此資料夾')}">${readerText('選擇此資料夾')}</button>
      `;

      // 點擊資料夾名稱進入該資料夾
      const folderLink = item.querySelector('.folder-item-left');
      folderLink.onclick = () => {
        fetchBrowserFolders(folder.path);
      };
      configureInteractiveItem(folderLink, readerText('開啟資料夾：{name}', { name: folder.name }), () => {
        fetchBrowserFolders(folder.path);
      });

      // 點擊「選擇」將路徑填入輸入框並自動填寫
      item.querySelector('.folder-select-action-btn').onclick = (e) => {
        e.stopPropagation();
        elements.scanDirInput.value = folder.path;
      };

      elements.browserFoldersList.appendChild(item);
    });
  } catch (e) {
    console.error('讀取目錄失敗：', e);
    elements.browserFoldersList.textContent = readerText('無法讀取資料夾，請返回上一層或稍後重試。');
  }
}

function beginAiSessionMutation(kind, options = {}) {
  const canReplaceProviderSwitch = options.replaceProviderSwitch
    && state.aiSessionMutationKind === 'provider-switch';
  if (state.aiSessionMutationPending && !canReplaceProviderSwitch) return null;
  const generation = ++state.aiSessionMutationGeneration;
  state.aiSessionMutationPending = true;
  state.aiSessionMutationKind = kind;
  // Any queued explanation belongs to the previous native session.  Clear it
  // immediately; an active request will also be rejected by its generation
  // check when it settles.
  state.aiExplainPendingPage = null;
  state.aiExplainPendingRequest = null;
  setAiSessionActionAvailability();
  return generation;
}

function finishAiSessionMutation(generation) {
  if (generation !== state.aiSessionMutationGeneration) return false;
  state.aiSessionMutationPending = false;
  state.aiSessionMutationKind = null;
  setAiSessionActionAvailability();
  return true;
}

function isCurrentAiSessionMutation(generation) {
  return generation === state.aiSessionMutationGeneration;
}

function setAiSessionActionAvailability() {
  const mutationBlocked = state.aiSessionSwitchPending
    || state.aiSessionMutationPending
    || state.aiSessionRevocationFailed;
  const configured = Boolean(state.aiSessionStatus?.configured);
  [elements.btnAiExplain, elements.btnAiAutoExplain].forEach(button => {
    if (!button) return;
    button.disabled = mutationBlocked;
    button.setAttribute('aria-disabled', String(mutationBlocked));
    const hint = readerText('請先到設定輸入 API Key 並啟用艦載 AI。');
    const defaultTitle = button === elements.btnAiAutoExplain
      ? readerText('開啟全書隨讀翻譯；只分析實際翻到的頁面')
      : readerText('請艦載 AI 說明目前頁面');
    button.title = mutationBlocked ? hint : (configured ? defaultTitle : `${defaultTitle} · ${hint}`);
    button.dataset.aiDisabledHint = configured ? '' : hint;
  });
  if (elements.aiTestBtn) {
    // Keep setup guidance reachable on touch devices, where a disabled
    // button's title is never shown.
    const testBlocked = mutationBlocked;
    elements.aiTestBtn.disabled = testBlocked;
    elements.aiTestBtn.setAttribute('aria-disabled', String(testBlocked));
    elements.aiTestBtn.title = testBlocked
      ? readerText('艦載 AI 設定正在變更，請稍候。')
      : readerText('用合成文字測試艦載 AI');
  }
  if (elements.aiSaveBtn) {
    elements.aiSaveBtn.disabled = Boolean(state.aiSessionMutationPending);
    elements.aiSaveBtn.setAttribute('aria-disabled', String(Boolean(state.aiSessionMutationPending)));
  }
  if (elements.aiClearBtn) {
    elements.aiClearBtn.disabled = Boolean(state.aiSessionMutationPending);
    elements.aiClearBtn.setAttribute('aria-disabled', String(Boolean(state.aiSessionMutationPending)));
  }
  if (elements.aiSessionStatus) {
    elements.aiSessionStatus.setAttribute('aria-busy', String(Boolean(state.aiSessionMutationPending)));
  }
  const metadataButton = elements.comicInspector?.querySelector('[data-inspector-action="ai-suggest"]');
  if (metadataButton) {
    metadataButton.disabled = Boolean(mutationBlocked);
    metadataButton.setAttribute('aria-disabled', String(Boolean(mutationBlocked)));
    metadataButton.title = configured ? '' : readerText('請先到設定輸入 API Key 並啟用艦載 AI。');
  }
}

async function handleAiProviderChange() {
  const committedProvider = state.aiProviderCommitted
    || state.aiSessionStatus?.provider
    || state.aiSessionStatus?.rememberedProvider
    || 'openai';
  const mutationGeneration = beginAiSessionMutation('provider-switch', { replaceProviderSwitch: true });
  if (mutationGeneration === null) {
    if (elements.aiProvider) elements.aiProvider.value = committedProvider;
    showReaderToast(readerText('目前正在變更艦載 AI 設定，請稍後再切換供應商。'));
    return;
  }
  const generation = ++state.aiSessionSwitchGeneration;
  state.aiSessionSwitchPending = true;
  state.aiSessionRevocationFailed = false;
  setAutoPageExplanation(false);
  setAiPagePanelVisible(false);
  updateAiProviderDisclosure();
  if (elements.aiSessionStatus) elements.aiSessionStatus.textContent = readerText('正在撤銷上一家供應商的艦載 AI 工作階段…');

  if (!eAPI?.revokeAiSessionConfig) {
    if (generation !== state.aiSessionSwitchGeneration || !isCurrentAiSessionMutation(mutationGeneration)) return;
    state.aiSessionSwitchPending = false;
    state.aiSessionRevocationFailed = true;
    if (elements.aiSessionStatus) elements.aiSessionStatus.textContent = readerText('切換供應商失敗：目前版本無法撤銷舊的艦載 AI 工作階段。');
    setAiSessionActionAvailability();
    finishAiSessionMutation(mutationGeneration);
    showReaderToast(readerText('切換供應商失敗，已暫停 AI 操作；請先更新 App。'));
    return;
  }

  try {
    await eAPI.revokeAiSessionConfig();
    if (generation !== state.aiSessionSwitchGeneration || !isCurrentAiSessionMutation(mutationGeneration)) return;
    state.aiSessionSwitchPending = false;
    state.aiSessionRevocationFailed = false;
    state.aiProviderCommitted = elements.aiProvider?.value || committedProvider;
    state.aiSessionStatus = null;
    renderAiSessionStatus({ configured: false, remembered: false, rememberedProvider: null });
    await refreshAiSessionStatus();
    finishAiSessionMutation(mutationGeneration);
  } catch (error) {
    if (generation !== state.aiSessionSwitchGeneration || !isCurrentAiSessionMutation(mutationGeneration)) return;
    state.aiSessionSwitchPending = false;
    state.aiSessionRevocationFailed = true;
    if (elements.aiSessionStatus) elements.aiSessionStatus.textContent = readerText('切換供應商失敗：{error} AI 操作已暫停。', { error: error?.message || error });
    setAiSessionActionAvailability();
    finishAiSessionMutation(mutationGeneration);
    showReaderToast(readerText('切換供應商失敗，已暫停 AI 操作。'));
  }
}

function updateAiProviderDisclosure() {
  if (!elements.aiGoogleDisclosureWrap) return;
  // 後端欄位沿用 googleContentDisclosure，但同意內容涵蓋所有雲端供應商。
  // 切換供應商時必須重新確認，避免把上一家供應商的同意誤套用過來。
  elements.aiGoogleDisclosureWrap.hidden = false;
  if (elements.aiGoogleDisclosure) elements.aiGoogleDisclosure.checked = false;
  if (elements.aiRememberKey) elements.aiRememberKey.checked = false;
  renderAiSessionStatus(state.aiSessionStatus);
}

function renderAiSessionStatus(status) {
  if (!elements.aiSessionStatus) return;
  state.aiSessionStatus = status || null;
  if (status?.provider) state.aiProviderCommitted = status.provider;
  else if (status?.rememberedProvider) state.aiProviderCommitted = status.rememberedProvider;
  setAiSessionActionAvailability();
  const selectedProvider = elements.aiProvider?.value || '';
  const rememberedProvider = status?.rememberedProvider || null;
  const remembered = Boolean(status?.remembered);
  const keychainLookupFailed = Boolean(status?.rememberedLookupFailed);
  const configured = Boolean(status?.configured);
  const providerLabel = provider => provider === 'google' ? 'Google Gemma 4' : 'OpenAI Luna';

  if (elements.aiRestoreBtn) {
    const providerMatches = Boolean(rememberedProvider) && rememberedProvider === selectedProvider;
    elements.aiRestoreBtn.hidden = !((remembered || keychainLookupFailed) && !configured);
    elements.aiRestoreBtn.disabled = Boolean(state.aiSessionMutationPending)
      || !(!configured && (providerMatches || keychainLookupFailed) && elements.aiGoogleDisclosure?.checked);
    elements.aiRestoreBtn.setAttribute('aria-disabled', String(Boolean(elements.aiRestoreBtn.disabled)));
  }

  if (keychainLookupFailed) {
    elements.aiSessionStatus.textContent = configured
      ? readerText('已啟用 {label} · {model}；暫時無法查詢本機 Keychain，已儲存 Key 狀態未知。', { label: providerLabel(status.provider), model: status.model })
      : readerText('暫時無法查詢本機 Keychain，已儲存 Key 狀態未知。請解鎖裝置後重開設定，或選擇供應商並重試還原。');
    return;
  }

  if (remembered && !configured) {
    if (!rememberedProvider) {
      elements.aiSessionStatus.textContent = readerText('本機 Keychain 有已儲存 Key，但目前版本無法確認所屬供應商；請先更新 App。');
    } else if (rememberedProvider !== selectedProvider) {
      elements.aiSessionStatus.textContent = readerText('本機 Keychain 已記住 {label} Key；請切換回 {provider}，再勾選本次同意後使用。', {
        label: providerLabel(rememberedProvider),
        provider: providerLabel(rememberedProvider),
      });
    } else {
      elements.aiSessionStatus.textContent = readerText('本機 Keychain 已記住 {label} Key；請勾選本次同意後按「使用已儲存金鑰」。', {
        label: providerLabel(rememberedProvider || selectedProvider),
      });
    }
    return;
  }

  if (!configured) {
    elements.aiSessionStatus.textContent = readerText('尚未設定艦載 AI。Key 預設只保留本次工作階段。');
    return;
  }

  const label = providerLabel(status.provider);
  const storage = remembered && rememberedProvider === status.provider
    ? readerText('；Key 已由本機 Keychain 記住')
    : readerText('；Key 只保留本次工作階段');
  elements.aiSessionStatus.textContent = readerText('已啟用 {label} · {model}{storage}', { label, model: status.model, storage });
}

async function refreshAiSessionStatus() {
  if (!eAPI?.getAiSessionStatus) return;
  const mutationGeneration = state.aiSessionMutationGeneration;
  try {
    const status = await eAPI.getAiSessionStatus();
    if (mutationGeneration !== state.aiSessionMutationGeneration) return null;
    renderAiSessionStatus(status);
    return status;
  } catch (error) {
    console.error('讀取艦載 AI 狀態失敗', error);
    return null;
  }
}

function aiSetupFailureMessage(error) {
  const detail = String(error?.nativeMessage || error?.message || error || '');
  if (/^PRO_REQUIRED\s*:/i.test(detail)) return readerText('艦載 AI 需要 G.A.I Pro；請先確認或恢復購買。');
  if (/consent|資料分享同意|資料傳送同意/i.test(detail)) return readerText('請勾選本次第三方 AI 資料分享同意。');
  if (/keychain|鑰匙圈|金鑰鏈/i.test(detail)) return readerText('無法使用本機 Keychain；請確認裝置已解鎖後再試。');
  if (/api.?key|金鑰/i.test(detail)) return readerText('請檢查 API Key 是否正確，再試一次。');
  return readerText('艦載 AI 啟用失敗；請檢查 Pro 權益、Key 與網路後再試。');
}

function aiActivationGuidance() {
  if (state.aiSessionStatus?.remembered) {
    return readerText('請勾選本次資料分享同意，再按「使用已儲存金鑰」啟用艦載 AI。');
  }
  return readerText('請先輸入 API Key 並啟用艦載 AI，再進行連線測試。');
}

async function saveAiSession() {
  if (!eAPI?.setAiSessionConfig) return;
  if (state.aiSessionMutationPending) return;
  const apiKey = elements.aiApiKey?.value.trim() || '';
  if (!apiKey) {
    if (elements.aiSessionStatus) elements.aiSessionStatus.textContent = aiActivationGuidance();
    return;
  }
  const mutationGeneration = beginAiSessionMutation('save');
  if (mutationGeneration === null) return;
  try {
    const provider = elements.aiProvider.value;
    const status = await eAPI.setAiSessionConfig({
      provider,
      apiKey,
      googleContentDisclosure: Boolean(elements.aiGoogleDisclosure?.checked),
      rememberKey: Boolean(elements.aiRememberKey?.checked),
    });
    if (!isCurrentAiSessionMutation(mutationGeneration)) return;
    elements.aiApiKey.value = '';
    state.aiSessionSwitchPending = false;
    state.aiSessionRevocationFailed = false;
    state.aiProviderCommitted = provider;
    renderAiSessionStatus(status);
    showReaderToast(readerText(status?.remembered ? '艦載 AI 已啟用；Key 已由本機 Keychain 記住' : '艦載 AI 已啟用；Key 只存在本次工作階段'));
  } catch (error) {
    if (isCurrentAiSessionMutation(mutationGeneration)) {
      // Native may revoke the old RAM session before reporting a Keychain
      // failure.  Fail closed instead of leaving the UI claiming that the old
      // session is still usable; keep the typed key so the user can retry.
      const previousStatus = state.aiSessionStatus || {};
      const failedStatus = {
        ...previousStatus,
        configured: false,
        provider: previousStatus.provider || elements.aiProvider?.value || null,
      };
      state.aiSessionSwitchPending = false;
      state.aiSessionRevocationFailed = true;
      state.aiSessionStatus = failedStatus;
      setAutoPageExplanation(false);
      setAiPagePanelVisible(false);
      renderAiSessionStatus(failedStatus);
      if (elements.aiSessionStatus) elements.aiSessionStatus.textContent = aiSetupFailureMessage(error);
    }
  } finally {
    finishAiSessionMutation(mutationGeneration);
  }
}

async function restoreAiSession() {
  if (!eAPI?.restoreAiSessionConfig) return;
  if (state.aiSessionMutationPending) return;
  const status = state.aiSessionStatus;
  const provider = elements.aiProvider?.value;
  if ((!status?.remembered && !status?.rememberedLookupFailed) || status.configured) return;
  if (!status.rememberedProvider && !status.rememberedLookupFailed) {
    showReaderToast(readerText('目前版本無法確認已儲存 Key 所屬供應商，請先更新 App。'));
    return;
  }
  if (status.rememberedProvider && status.rememberedProvider !== provider) {
    showReaderToast(readerText('請先切換回已儲存 Key 所屬的供應商：{provider}', { provider: status.rememberedProvider === 'google' ? 'Google' : 'OpenAI' }));
    return;
  }
  if (!elements.aiGoogleDisclosure?.checked) {
    showReaderToast(readerText('使用已儲存金鑰前，請先勾選本次第三方 AI 資料分享同意。'));
    return;
  }
  const mutationGeneration = beginAiSessionMutation('restore');
  if (mutationGeneration === null) return;
  try {
    const nextStatus = await eAPI.restoreAiSessionConfig({
      provider,
      googleContentDisclosure: true,
    });
    if (!isCurrentAiSessionMutation(mutationGeneration)) return;
    state.aiSessionSwitchPending = false;
    state.aiSessionRevocationFailed = false;
    state.aiProviderCommitted = provider;
    renderAiSessionStatus(nextStatus);
    showReaderToast(readerText('已從本機 Keychain 還原艦載 AI；本次同意只適用於目前工作階段。'));
  } catch (error) {
    if (isCurrentAiSessionMutation(mutationGeneration)) {
      if (elements.aiSessionStatus) elements.aiSessionStatus.textContent = aiSetupFailureMessage(error);
      showReaderToast(readerText('還原艦載 AI 失敗，請確認設定後再試。'));
    }
  } finally {
    finishAiSessionMutation(mutationGeneration);
  }
}

async function testAiSession() {
  if (!eAPI?.testAiSession) return;
  if (state.aiSessionSwitchPending || state.aiSessionMutationPending || state.aiSessionRevocationFailed) return;
  if (!state.aiSessionStatus?.configured) {
    if (elements.aiSessionStatus) elements.aiSessionStatus.textContent = aiActivationGuidance();
    return;
  }
  const mutationGeneration = state.aiSessionMutationGeneration;
  elements.aiTestBtn.disabled = true;
  elements.aiSessionStatus.textContent = readerText('正在用合成文字測試，不會送出漫畫內容…');
  try {
    await eAPI.testAiSession();
    if (mutationGeneration !== state.aiSessionMutationGeneration) return;
    elements.aiSessionStatus.textContent = readerText('艦載 AI 連線成功。');
  } catch (error) {
    if (mutationGeneration !== state.aiSessionMutationGeneration) return;
    elements.aiSessionStatus.textContent = readerText('測試失敗：{error}', { error: error?.message || error });
  } finally {
    if (mutationGeneration === state.aiSessionMutationGeneration) {
      elements.aiTestBtn.disabled = false;
      setAiSessionActionAvailability();
    }
  }
}

async function clearAiSession() {
  if (!eAPI?.clearAiSessionConfig) return;
  if (state.aiSessionMutationPending) return;
  const previousStatus = state.aiSessionStatus ? { ...state.aiSessionStatus } : null;
  const mutationGeneration = beginAiSessionMutation('clear');
  if (mutationGeneration === null) return;
  try {
    await eAPI.clearAiSessionConfig();
    if (!isCurrentAiSessionMutation(mutationGeneration)) return;
    if (elements.aiApiKey) elements.aiApiKey.value = '';
    if (elements.aiRememberKey) elements.aiRememberKey.checked = false;
    if (elements.aiGoogleDisclosure) elements.aiGoogleDisclosure.checked = false;
    state.aiSessionSwitchPending = false;
    state.aiSessionRevocationFailed = false;
    state.aiProviderCommitted = elements.aiProvider?.value || state.aiProviderCommitted;
    renderAiSessionStatus(null);
    showReaderToast(readerText('已清除工作階段 API Key 與本機 Keychain 記錄'));
  } catch (error) {
    if (isCurrentAiSessionMutation(mutationGeneration)) {
      // native clear 可能已撤銷 RAM session 才回報失敗；保留舊 configured
      // snapshot，並阻斷後續 AI 請求，直到使用者重新啟用或切換供應商。
      state.aiSessionStatus = previousStatus;
      state.aiSessionRevocationFailed = true;
      renderAiSessionStatus(previousStatus);
      showReaderToast(readerText('清除艦載 AI 失敗：{error}', { error: error?.message || error }));
    }
  } finally {
    finishAiSessionMutation(mutationGeneration);
  }
}

function blobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(readerText('無法讀取目前頁面')));
    reader.readAsDataURL(blob);
  });
}

async function pageDataUrl(source) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(readerText('頁面讀取失敗（HTTP {status}）', { status: response.status }));
  const blob = await response.blob();
  if (blob.size > 20 * 1024 * 1024) throw new Error(readerText('目前頁面超過 20 MiB 上限'));
  return blobAsDataUrl(blob);
}

async function currentPageDataUrl() {
  if (isBuiltInDemoComic(state.currentComic)) throw new Error(readerText('內建示範沒有可送出的漫畫圖像'));
  if (!state.currentComicPages.length) throw new Error(readerText('請先開啟一頁漫畫'));
  return pageDataUrl(state.currentComicPages[state.currentPageIndex]);
}

function syncReaderRotationUi() {
  const angle = normalizedRotationAngle();
  elements.readerOverlay.style.setProperty('--reader-rotation', `${angle}deg`);
  elements.readerOverlay.dataset.readerRotation = String(angle);
  elements.aiPagePanel.dataset.readerRotation = String(angle);
  elements.aiPagePanel.classList.toggle('reader-rotated', angle !== 0);
}

function setAiPagePanelVisible(visible) {
  elements.aiPagePanel.hidden = !visible;
  elements.readerOverlay.classList.toggle('ai-panel-open', visible);
  scheduleReaderImageTransformRefresh();
}

function setAutoPageExplanation(enabled) {
  state.aiAutoExplain = Boolean(enabled);
  elements.btnAiAutoExplain?.setAttribute('aria-pressed', String(state.aiAutoExplain));
  elements.btnAiAutoExplain?.classList.toggle('active', state.aiAutoExplain);
  if (!state.aiAutoExplain) {
    clearTimeout(state.aiExplainTimer);
    state.aiExplainTimer = null;
    state.aiExplainPendingPage = null;
    if (state.aiExplainPendingRequest?.automatic) state.aiExplainPendingRequest = null;
  }
}

function toggleAutoPageExplanation() {
  if (state.aiSessionSwitchPending || state.aiSessionMutationPending || state.aiSessionRevocationFailed) {
    showReaderToast(readerText('艦載 AI 工作階段正在切換，請稍後再試。'));
    return;
  }
  if (!state.aiSessionStatus?.configured) {
    openAiSettings();
    return;
  }
  if (isBuiltInDemoComic(state.currentComic)) {
    showReaderToast(readerText('風景選集不會送出頁面內容給 AI。'));
    return;
  }
  const enabled = !state.aiAutoExplain;
  setAutoPageExplanation(enabled);
  if (!enabled) {
    setAiPagePanelVisible(false);
    showReaderToast(readerText('已停止全書隨讀'));
    return;
  }
  setAiPagePanelVisible(true);
  elements.aiPageResult.textContent = readerText('全書隨讀已開啟：只分析實際翻到的頁面，同頁不重複計費。');
  syncReaderRotationUi();
  scheduleAutoPageExplanation();
}

function scheduleAutoPageExplanation() {
  if (!state.aiAutoExplain || !state.currentComicPages.length) return;
  clearTimeout(state.aiExplainTimer);
  state.aiExplainTimer = setTimeout(() => requestPageExplanation(state.currentPageIndex, true), 420);
}

function getAiExplainLocale() {
  const locale = window.GAIL10n?.locale;
  return ['zh-Hant', 'en', 'ja'].includes(locale) ? locale : 'en';
}

function aiExplainCacheKey(comicId, pageIndex, locale = getAiExplainLocale()) {
  return `${comicId}:${pageIndex}:${locale}`;
}

function localizeAiExplainError(error) {
  const message = error?.nativeMessage || error?.message || String(error);
  if (/請先到設定輸入艦載 AI API Key|API key.*設定|API key.*config|not configured/i.test(message)) {
    return readerText('請先到設定輸入艦載 AI API Key');
  }
  if (/尚未同意第三方 AI 資料分享|consent.*third-party|third-party.*consent/i.test(message)) {
    return readerText('尚未同意第三方 AI 資料分享');
  }
  if (/AI.*不可用|AI.*unavailable|service.*unavailable/i.test(message)) {
    return readerText('艦載 AI 目前不可用，請稍後再試。');
  }
  return error?.message || String(error);
}

async function requestPageExplanation(pageIndex, automatic = false) {
  if (state.aiSessionSwitchPending || state.aiSessionMutationPending || state.aiSessionRevocationFailed) {
    if (!automatic) showReaderToast(readerText('艦載 AI 工作階段正在切換，請稍後再試。'));
    return;
  }
  if (!state.aiSessionStatus?.configured) {
    if (!automatic) openAiSettings();
    return;
  }
  if (isBuiltInDemoComic(state.currentComic)) {
    if (!automatic) showReaderToast(readerText('風景選集不會送出頁面內容給 AI。'));
    return;
  }
  if (!eAPI?.explainPage || !state.currentComic?.id || !state.currentComicPages[pageIndex]) {
    if (!automatic) showReaderToast(readerText('請先開啟一頁漫畫'));
    return;
  }

  const comicId = state.currentComic.id;
  const locale = getAiExplainLocale();
  const cacheKey = aiExplainCacheKey(comicId, pageIndex, locale);
  const cached = state.aiExplainCache.get(cacheKey);
  if (cached) {
    if (state.currentComic?.id === comicId && state.currentPageIndex === pageIndex) {
      setAiPagePanelVisible(true);
      elements.aiPageResult.textContent = cached;
      syncReaderRotationUi();
    }
    return;
  }

  if (state.aiExplainInFlight) {
    const active = state.aiExplainActiveRequest;
    if (active?.comicId !== comicId || active.pageIndex !== pageIndex || active.locale !== locale) {
      state.aiExplainPendingRequest = { comicId, pageIndex, locale, automatic };
      state.aiExplainPendingPage = pageIndex;
    }
    return;
  }

  state.aiExplainInFlight = true;
  state.aiExplainActiveRequest = { comicId, pageIndex, locale, automatic };
  const sessionGeneration = state.aiSessionSwitchGeneration;
  const mutationGeneration = state.aiSessionMutationGeneration;
  state.aiExplainPendingPage = null;
  state.aiExplainPendingRequest = null;
  setAiPagePanelVisible(true);
  elements.aiPageResult.textContent = readerText('艦載 AI 正在閱讀第 {page} 頁…', { page: pageIndex + 1 });
  elements.btnAiExplain.disabled = true;
  syncReaderRotationUi();
  try {
    const dataUrl = await pageDataUrl(state.currentComicPages[pageIndex]);
    if (sessionGeneration !== state.aiSessionSwitchGeneration
      || mutationGeneration !== state.aiSessionMutationGeneration) return;
    const explanation = await eAPI.explainPage({ dataUrl, targetLocale: locale });
    if (sessionGeneration !== state.aiSessionSwitchGeneration
      || mutationGeneration !== state.aiSessionMutationGeneration) return;
    state.aiExplainCache.set(cacheKey, explanation);
    if (state.currentComic?.id === comicId
      && state.currentPageIndex === pageIndex
      && getAiExplainLocale() === locale) {
      elements.aiPageResult.textContent = explanation;
    }
  } catch (error) {
    if (sessionGeneration !== state.aiSessionSwitchGeneration
      || mutationGeneration !== state.aiSessionMutationGeneration) return;
    if (state.currentComic?.id === comicId
      && state.currentPageIndex === pageIndex
      && getAiExplainLocale() === locale) {
      const rawMessage = error?.nativeMessage || error?.message || String(error);
      const message = localizeAiExplainError(error);
      if (/^PRO_REQUIRED:/i.test(rawMessage)) {
        setAutoPageExplanation(false);
        elements.aiPageResult.textContent = readerText('Pro 權益目前不可用，已停止全書隨讀；已完成的解說仍保留。');
        if (!automatic) window.GaiCommerce?.handleError(error);
      } else if (/HTTP 429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(rawMessage)) {
        setAutoPageExplanation(false);
        elements.aiPageResult.textContent = readerText('免費額度或請求頻率暫時用完，已停止全書隨讀。稍後再試，或到設定切換 Luna。已完成的頁面仍保留在本次快取。');
      } else {
        elements.aiPageResult.textContent = readerText('艦載 AI 無法說明：{error}', { error: message });
      }
    }
  } finally {
    state.aiExplainInFlight = false;
    state.aiExplainActiveRequest = null;
    setAiSessionActionAvailability();
    const pendingRequest = state.aiExplainPendingRequest;
    state.aiExplainPendingPage = null;
    state.aiExplainPendingRequest = null;
    if (sessionGeneration === state.aiSessionSwitchGeneration
      && mutationGeneration === state.aiSessionMutationGeneration
      && pendingRequest
      && pendingRequest.comicId === state.currentComic?.id
      && pendingRequest.pageIndex === state.currentPageIndex
      && (!pendingRequest.automatic || state.aiAutoExplain)) {
      // Retry a same-page request when its locale changed while the previous
      // request was in flight; this is deliberately explicit for manual mode.
      void requestPageExplanation(pendingRequest.pageIndex, pendingRequest.automatic);
    }
  }
}

function metadataSamplePageIndices(pageCount) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return [];
  const candidates = [0, 1, 2, ...[0.4, 0.5, 0.6].map(ratio => Math.ceil(pageCount * ratio) - 1)];
  return [...new Set(candidates.filter(index => index >= 0 && index < pageCount))];
}

async function metadataSampleDataUrl(source) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(readerText('頁面讀取失敗（HTTP {status}）', { status: response.status }));
  const sourceBlob = await response.blob();
  if (sourceBlob.size > 20 * 1024 * 1024) throw new Error(readerText('目前頁面超過 20 MiB 上限'));

  let image;
  let objectUrl;
  try {
    if (typeof createImageBitmap === 'function') {
      try {
        image = await createImageBitmap(sourceBlob);
      } catch {
        // Some WebKit builds expose createImageBitmap but cannot decode this format.
      }
    }
    if (!image) {
      objectUrl = URL.createObjectURL(sourceBlob);
      image = new Image();
      image.src = objectUrl;
      await image.decode();
    }
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    if (!width || !height) throw new Error(readerText('無法讀取目前頁面'));
    const scale = Math.min(1, 2000 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(readerText('無法讀取目前頁面'));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.84, 0.72, 0.6]) {
      const sample = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (sample && sample.size <= 1.5 * 1024 * 1024) return blobAsDataUrl(sample);
    }
    throw new Error(readerText('取樣圖片仍過大，請使用較小的圖片再試。'));
  } finally {
    image?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function sampleComicForAiMetadata(comicId, onProgress = () => {}) {
  if (!eAPI?.openComic) throw new Error(readerText('目前環境無法讀取漫畫頁面'));
  const comic = await eAPI.openComic(comicId);
  const pages = comic?.pages || [];
  const indexes = metadataSamplePageIndices(pages.length);
  if (!indexes.length) throw new Error(readerText('這本漫畫沒有可供分析的封面或第一頁'));
  const dataUrls = [];
  for (const index of indexes) {
    onProgress(indexes, dataUrls.length);
    dataUrls.push(await metadataSampleDataUrl(pages[index]));
  }
  return { dataUrls, indexes };
}

async function explainCurrentPage() {
  await requestPageExplanation(state.currentPageIndex, false);
}

function renderAiMetadataCandidates(candidates, comicId, resultContainer = elements.aiPageResult) {
  if (!candidates?.length) {
    resultContainer.textContent = readerText('艦載 AI 沒有提出可確認的候選。');
    return;
  }
  resultContainer.innerHTML = `
    <strong>${readerText('可審核候選')}</strong><small class="ai-candidate-note">${readerText('尚未套用；請逐筆確認。')}</small>
    <div class="ai-candidate-list">
      ${candidates.map((candidate, index) => {
        const value = candidate.field === 'tags'
          ? (candidate.value || []).map(tag => `${tag.namespace}:${tag.value}`).join('、')
          : String(candidate.value || '');
        return `<div class="ai-candidate" data-candidate-index="${index}">
          <div><span class="ai-candidate-field">${escapeHtml(readerText(candidate.field === 'tags' ? '標籤' : '摘要'))}</span> ${escapeHtml(value)} <small>${Math.round(Number(candidate.confidence || 0) * 100)}%</small></div>
          <button type="button" class="metadata-suggestion ai-candidate-apply">${readerText('套用')}</button>
        </div>`;
      }).join('')}
    </div>`;
  resultContainer.querySelectorAll('.ai-candidate-apply').forEach(button => {
    button.addEventListener('click', async () => {
      const item = candidates[Number(button.closest('.ai-candidate')?.dataset.candidateIndex)];
      if (!item || !eAPI?.applyBatchMetadata) return;
      button.disabled = true;
      try {
        const request = item.field === 'tags'
          ? { comicIds: [comicId], fields: {}, addTags: item.value, excludeTags: [] }
          : { comicIds: [comicId], fields: { summary: String(item.value) }, addTags: [], excludeTags: [] };
        await eAPI.applyBatchMetadata(request);
        button.textContent = readerText('已套用');
        button.title = readerText('已寫入使用者覆寫');
      } catch (error) {
        button.disabled = false;
        button.title = error?.message || String(error);
      }
    });
  });
}

async function suggestInspectorMetadata(comic, button, resultContainer) {
  if (!state.aiSessionStatus?.configured && !state.aiSessionSwitchPending && !state.aiSessionMutationPending) {
    resultContainer.hidden = false;
    resultContainer.textContent = readerText('請先在設定中啟用艦載 AI，並同意本次頁面傳送。');
    openAiSettings();
    return;
  }
  if (state.aiSessionSwitchPending || state.aiSessionMutationPending || state.aiSessionRevocationFailed) {
    resultContainer.hidden = false;
    resultContainer.textContent = readerText('艦載 AI 工作階段正在切換，請稍後再試。');
    return;
  }
  resultContainer.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  if (!eAPI?.suggestComicMetadata || !comic?.id) {
    resultContainer.textContent = readerText('目前環境無法使用艦載 AI 整理建議。');
    return;
  }
  if (isComicOffline(comic)) {
    resultContainer.textContent = readerText('漫畫來源目前離線，重新掛載後才能讀取封面。');
    return;
  }
  resultContainer.textContent = readerText('艦載 AI 正在準備取樣頁面…');
  const sessionGeneration = state.aiSessionSwitchGeneration;
  const mutationGeneration = state.aiSessionMutationGeneration;
  button.disabled = true;
  try {
    const { dataUrls, indexes } = await sampleComicForAiMetadata(comic.id, (pages, ready) => {
      if (!button.isConnected
        || sessionGeneration !== state.aiSessionSwitchGeneration
        || mutationGeneration !== state.aiSessionMutationGeneration) throw new Error('AI session changed');
      resultContainer.textContent = readerText('正在準備第 {page} 頁（{ready}/{total}）…', {
        page: pages[ready] + 1,
        ready,
        total: pages.length,
      });
    });
    if (!button.isConnected
      || sessionGeneration !== state.aiSessionSwitchGeneration
      || mutationGeneration !== state.aiSessionMutationGeneration) return;
    resultContainer.textContent = readerText('正在分析第 {pages} 頁，產生待確認的摘要與標籤…', {
      pages: indexes.map(index => index + 1).join(', '),
    });
    const candidates = await eAPI.suggestComicMetadata({
      comicId: comic.id,
      dataUrls,
      targetLocale: getAiExplainLocale(),
    });
    if (!button.isConnected
      || sessionGeneration !== state.aiSessionSwitchGeneration
      || mutationGeneration !== state.aiSessionMutationGeneration) return;
    renderAiMetadataCandidates(candidates, comic.id, resultContainer);
  } catch (error) {
    if (!button.isConnected
      || sessionGeneration !== state.aiSessionSwitchGeneration
      || mutationGeneration !== state.aiSessionMutationGeneration) return;
    const message = String(error?.message || error);
    resultContainer.textContent = /database (?:table )?is locked/.test(message)
      ? readerText('漫畫庫正在寫入資料，AI 建議暫時存不進去。等掃描完成後再試一次喔。')
      : readerText('艦載 AI 建議失敗：{error}', { error: message });
  } finally {
    if (button.isConnected) {
      const blocked = state.aiSessionSwitchPending
        || state.aiSessionMutationPending
        || state.aiSessionRevocationFailed
        || !state.aiSessionStatus?.configured;
      button.disabled = Boolean(blocked);
      button.setAttribute('aria-disabled', String(Boolean(blocked)));
    }
  }
}

// 保存並套用新漫畫目錄
async function saveSettingsPath(pathStr) {
  const normalizedPath = String(pathStr || '').trim().replace(/\/+$/, '') || '/';
  if (normalizedPath === '/' || normalizedPath === '/Volumes') {
    const message = readerText('為避免掃描整台電腦，請選擇磁碟內實際存放漫畫的子資料夾。');
    if (elements.scanDirStatus) elements.scanDirStatus.textContent = message;
    return;
  }
  showLoader(readerText('正在套用新目錄並重新載入漫畫庫...'), { progress: null, detail: readerText('正在切換書庫位置...') });
  try {
    const applied = await eAPI.setConfig({ scanDir: normalizedPath });
    localStorage.setItem('gai:scanDir', applied?.scanDir || normalizedPath);

    // 馬上清空目前的書架，避免使用者看到舊的漫畫
    state.comics = [];
    invalidateComicNavigationCache();
    resetLibraryNavigationState();
    filterAndRenderGrid();
    renderSidebar();
    renderContinueStrip();
    renderInspectorEmpty();
    updateStats();

    closeSettingsModal();
    hideLoader();
    elements.comicGrid?.scrollIntoView({ block: 'start' });
    elements.comicGrid?.focus({ preventScroll: true });
    startScanStatusPolling();
    scheduleLibraryRefresh(0);
  } catch (e) {
    console.error('套用漫畫目錄失敗：', e);
    if (elements.scanDirStatus) {
      elements.scanDirStatus.textContent = readerText('無法套用漫畫目錄：{error}', { error: e?.message || e });
    }
    hideLoader();
  }
}

// ==========================================================================
// 🖱️ 主畫面漫畫卡片右鍵選單 (Context Menu)
// ==========================================================================

function isPhotoAlbum(comic) {
  return String(comic?.id || '').startsWith('photos:');
}

function canShowFileLocation(comic) {
  return Boolean(window.electronAPI?.showItemInFolder)
    && !isIOSLibraryDevice()
    && /Mac|Win/.test(navigator.platform || navigator.userAgent)
    && !isBuiltInDemoComic(comic)
    && !String(comic.sourceId || '').startsWith('photos:')
    && !String(comic.id || '').startsWith('photos:');
}

function showGridContextMenu(e, comic) {
  e.preventDefault();

  // 移除舊的右鍵選單
  let oldMenu = document.getElementById('grid-context-menu');
  if (oldMenu) {
    oldMenu.remove();
  }

  if (!canShowFileLocation(comic)) return;

  // 建立新選單
  const menu = document.createElement('div');
  menu.id = 'grid-context-menu';
  menu.innerHTML = `
    <div class="menu-header">${escapeHtml(comic.title)}</div>
    <div class="menu-divider"></div>
    <button class="menu-item" data-action="open-folder">
      <i class="fa-solid fa-folder-open"></i> ${readerText(/Mac/.test(navigator.platform || navigator.userAgent) ? '在 Finder 中顯示' : '在檔案總管中顯示')}
    </button>
  `;

  document.body.appendChild(menu);

  // 計算選單顯示位置
  let x = e.clientX;
  let y = e.clientY;
  const menuRect = menu.getBoundingClientRect();
  if (x + menuRect.width > window.innerWidth) x -= menuRect.width;
  if (y + menuRect.height > window.innerHeight) y -= menuRect.height;

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.add('active');

  // 綁定事件
  const revealButton = menu.querySelector('[data-action="open-folder"]');
  revealButton.disabled = true;
  Promise.resolve(eAPI.getFileCapability?.(comic.id)).then(capability => {
    if (!menu.isConnected) return;
    revealButton.disabled = !capability?.canReveal;
    if (!capability?.canReveal) revealButton.title = localizeFileCapabilityReason(capability?.reason) || readerText('這個來源沒有可開啟的檔案位置');
  }).catch(() => {
    revealButton.title = readerText('目前無法確認檔案位置');
  });
  revealButton.onclick = async () => {
    revealButton.disabled = true;
    try {
      await eAPI.showItemInFolder(comic.id);
    } catch (error) {
      alert(readerText('無法開啟檔案位置：{error}', { error: error?.message || error }));
    } finally {
      menu.remove();
    }
  };

  // 點擊其他地方自動關閉
  const closeMenu = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('contextmenu', closeMenu);
    }
  };

  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', closeMenu);
  }, 10);
}

// 只在 node vm 行為測試主動提供容器時暴露內部 hook，正式頁面不增加全域 API。
if (typeof window !== 'undefined' && window.__GIA_TEST_HOOKS__) {
  Object.assign(window.__GIA_TEST_HOOKS__, {
    state,
    elements,
    updateLibraryStartPanel,
    updateScanRecovery,
    setScanRecoveryVisible,
    retryLibraryScan,
    updateOrganizerUi,
    activateGridComic,
    renderContinueStrip,
    showReaderDiscoveryHint,
    dismissReaderDiscoveryHint,
    syncLibraryPanelScrim,
    closeLibraryPanelScrim,
    canShowFileLocation,
    createBuiltInDemoComics,
    builtInDemoReaderData,
    getCoverUrl,
    catalogThumbnailURL,
    getDirectoryItems,
    getLibraryFilteredComics,
    getDiscoveryCandidates,
    normalizeDiscoveryTagGroups,
    pickDiscoveryTag,
    toggleDiscoveryTags,
    closeDiscoveryTags,
    openDiscoveryTag,
    pickDiscoveryComic,
    openDiscoveryComic,
    syncDiscoveryButton,
    getDirectoryLocationKey,
    getVisibleDirectoryMapKey,
    getVisibleDirectoryEntries,
    createDirectoryLocation,
    normalizeDirectoryLocation,
    navigateLibraryToPath,
    navigateLibraryUp,
    requestVisibleDirectoryScan,
    setFavorites,
    isFavoriteId,
    addIOSLibrarySource,
    renderExternalBookmarks,
    restoreExternalBookmarks,
    isBuiltInDemoComic,
    isLooseImage,
    resetCoverLoadQueue,
    enqueueCoverLoad,
    drainCoverLoadQueue,
    noteCatalogScroll,
    markCoverUnavailable,
    hasFailedCover,
    scheduleLibraryRefresh,
    runScheduledLibraryRefresh,
    performLibraryFetch,
    applyIncrementalLibraryBatch,
    queueIncrementalLibraryRender,
    setLibraryRefreshRunner(runner) { libraryRefreshRunner = runner; },
    setCoverObserver(observer) { coverObserver = observer; },
    setCoverVisibility(img, visible) {
      if (visible) coverVisibleImages.add(img);
      else cancelQueuedCoverLoad(img);
    },
    startScanStatusPolling,
    stopScanStatusPolling,
    updateLoaderScanProgress,
    requestPriorityLibraryScan,
    renderGrid,
    getShelfCardRenderKey,
    renderPages,
    createReadingProgressSnapshot,
    enqueueReadingProgressSnapshot,
    retryReaderPages,
    markReaderPageReady,
    markReaderPageFailed,
    readerImageIsReady,
    decodeReaderImage,
    saveReadingProgress,
    toggleDoubleDirection,
    advanceDoubleBySinglePage,
    doublePageStartForIndex,
    nextPage,
    prevPage,
    setReadingMode,
    openReader,
    openNextComicInFolder,
    openPrevComicInFolder,
    getComicSourceKey,
    getComicNavigationCache,
    invalidateComicNavigationCache,
    findAdjacentComicInFolder,
    requestWebtoonAdjacentComic,
    jumpToPage,
    anchorWebtoonPage,
    cancelWebtoonAnchor,
    renderCatalogGrid,
    getCatalogVirtualBounds,
    handleReaderResize,
    handleCatalogScroll,
    updateReaderUiControls,
    captureCatalogFocus,
    restoreCatalogFocus,
    captureLibraryFocus,
    restoreLibraryRefreshFocus,
    getCatalogThumbnailLoadState() {
      return {
        generation: catalogImageGeneration,
        active: catalogImageActive,
        queued: catalogImageQueue.length,
        tasks: catalogImageTasks.size,
        observerConnected: Boolean(catalogImageObserver),
      };
    },
    handleKeyDown,
    trapReaderFocus,
    handleReaderPointerClick,
    readerViewportCanScroll,
    bindEvents,
    closeReader,
    getCoverQueueState() {
      return {
        active: coverLoadActive,
        queued: coverLoadQueue.slice(),
        tasks: coverLoadTasks.size,
        generation: coverLoadGeneration,
        visible: coverVisibleImages.size,
        failed: new Map(failedCoverIds),
      };
    },
  });
}
