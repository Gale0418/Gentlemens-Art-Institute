function readerText(sourceZh, vars = {}) {
  if (window.GAIL10n) return window.GAIL10n.t(sourceZh, vars);
  return sourceZh.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
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
  clearAiSessionConfig: null,
  testAiSession: null,
  explainPage: null,
  suggestComicMetadata: null,
};

const eAPI = window.electronAPI || httpAPI;
let libraryRefreshTimer = null;
let activeLibraryFetch = null;
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
    && state.scanStatus?.completedAt) {
    // A completed scan may still have a queued progress event behind it.
    return true;
  }

  const positions = new Map(state.comics.map((comic, index) => [comic.id, index]));
  payload.items
    .filter(comic => comic && comic.id && !isBuiltInDemoComic(comic))
    .forEach(comic => {
      const index = positions.get(comic.id);
      if (index === undefined) {
        positions.set(comic.id, state.comics.length);
        state.comics.push(comic);
      } else {
        state.comics[index] = comic;
      }
    });
  state.scanStatus = {
    ...(state.scanStatus || {}),
    generation,
    isScanning: true,
    found: Math.max(Number(state.scanStatus?.found) || 0, Number(payload.found) || 0),
  };
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
  state.activeSeries = 'all';
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
  if (elements.searchInput) elements.searchInput.value = '';
  if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = 'none';
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

const READER_PRELOAD_RADIUS = 10;
const MAX_PRELOADED_IMAGES = READER_PRELOAD_RADIUS * 2;
const READER_CACHE_UPDATE_DELAY_MS = 120;
const WEBTOON_EAGER_IMAGES = 3;
const BUILT_IN_DEMO_SOURCE_ID = 'builtin:landscapes';
const BUILT_IN_DEMO_ID_PREFIX = 'builtin:landscape-';

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
  fitMode: localStorage.getItem('readerFitMode') || 'contain', // 'contain', 'width', 'height'
  rotationAngle: 0, // 0, 90, 180, 270
  favorites: [],
  activeSeries: 'all',
  activeFilter: 'all',
  currentPath: '', // 目錄樹當前路徑 (姬米妮貼心追加 ✨)
  selectedComicId: null,
  preloadedImages: new Map(), // 用來保存已預載的 Image 物件
  readerCacheWindowTimer: null,
  readerCacheWindowPage: null,
  readerCacheReadyPage: null,
  readerIdleTimer: null,
  readerContextMenuOpen: false,
  webtoonScrollFrame: null,
  webtoonAnchor: null,
  scanStatusPollTimer: null,
  scanStatusPollWallclockTimer: null,
  scanStatus: null,
  libraryRefreshPending: false,
  renderGeneration: 0,
  sharpenLevel: 0, // 0=關閉, 1=輕度, 2=中度, 3=強度
  cropEdges: localStorage.getItem('readerCropEdges') === 'true',
  brightness: Number(localStorage.getItem('readerBrightness')) || 100,
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
  readerBoundaryDialog: null,
  dialogReturnFocus: null,
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
  libraryUpBtn: document.getElementById('library-up-btn'),
  libraryWorkspace: document.querySelector('.library-workspace'),
  comicGrid: document.getElementById('comic-grid'),
  contentArea: document.querySelector('.content-area'),
  emptyState: document.getElementById('empty-state'),
  searchInput: document.getElementById('search-input'),
  clearSearchBtn: document.getElementById('clear-search-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  libraryPathLabel: document.getElementById('library-path-label'),
  continueStrip: document.getElementById('continue-strip'),
  comicInspector: document.getElementById('comic-inspector'),
  organizeBar: document.getElementById('organize-bar'),
  organizeCount: document.getElementById('organize-count'),
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
  aiGoogleDisclosureWrap: document.getElementById('ai-google-disclosure-wrap'),
  aiGoogleDisclosure: document.getElementById('ai-google-disclosure'),
  aiSaveBtn: document.getElementById('ai-save-btn'),
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
  applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'midnight', { persist: false });
  applyLibraryCardSize(localStorage.getItem(LIBRARY_CARD_SIZE_STORAGE_KEY), { persist: false });
  syncLibraryPanelsForViewport({ initial: true });
  initApp();
  bindEvents();
});

function isNarrowLibraryViewport() {
  const width = Number(window.innerWidth) || document.documentElement.clientWidth || 1024;
  return width <= 900;
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

function applySidebarCollapsed(collapsed, { persist = true, exclusive = true } = {}) {
  const isCollapsed = Boolean(collapsed);
  const isNarrow = state.libraryPanelsNarrow || isNarrowLibraryViewport();
  state.sidebarCollapsed = isCollapsed;
  elements.mainLayout?.classList.toggle('sidebar-collapsed', isCollapsed);
  if (isCollapsed) moveFocusBeforeLibraryPanelClose(elements.librarySidebar, elements.sidebarCollapseBtn);
  setLibraryPanelAvailability(elements.librarySidebar, !isCollapsed);
  if (elements.sidebarCollapseBtn) {
    elements.sidebarCollapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
    const label = readerText(isCollapsed ? '展開漫畫系列側欄' : '收合漫畫系列側欄');
    elements.sidebarCollapseBtn.setAttribute('aria-label', label);
    elements.sidebarCollapseBtn.title = label;
    const icon = elements.sidebarCollapseBtn.querySelector('i');
    if (icon) icon.className = `fa-solid fa-chevron-${isCollapsed ? 'right' : 'left'}`;
  }
  if (isNarrow && !isCollapsed && exclusive) {
    applyInspectorCollapsed(true, { persist: false, exclusive: false });
  }
  if (persist && !isNarrow) localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
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
}

function syncLibraryPanelsForViewport({ initial = false } = {}) {
  const nextIsNarrow = isNarrowLibraryViewport();
  const previousIsNarrow = state.libraryPanelsNarrow;
  state.libraryPanelsNarrow = nextIsNarrow;
  elements.mainLayout?.classList.toggle('library-panels-narrow', nextIsNarrow);

  if (!initial && previousIsNarrow === nextIsNarrow) return;

  if (nextIsNarrow) {
    // 窄屏每次初始或由寬轉窄都從雙側關閉開始，避免抽屜遮住使用中的書架。
    applySidebarCollapsed(true, { persist: false, exclusive: false });
    applyInspectorCollapsed(true, { persist: false, exclusive: false });
    return;
  }

  // 回到寬畫面時恢復各自最後一次的桌面偏好，不觸發書架重繪或封面載入。
  applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true', { persist: false, exclusive: false });
  applyInspectorCollapsed(localStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY) === 'true', { persist: false, exclusive: false });
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

  // 如果是 iOS，顯示相簿匯入按鈕
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) {
    // if (elements.settingsBtn) elements.settingsBtn.style.display = 'none';
    const importBtn = document.getElementById('import-photo-btn');
    if (importBtn) importBtn.style.display = 'inline-block';

    const tip = document.querySelector('.sidebar-footer p');
    if (tip) tip.innerHTML = readerText('小提示：點一下查看詳情，再點同一本開始閱讀；也可以用上方「匯入圖片」加入內容。✨');
    const emptyTip = document.querySelector('#empty-state p');
    if (emptyTip) emptyTip.innerHTML = readerText('請點擊上方的「匯入圖片」按鈕，或透過檔案 App 匯入漫畫！✨');
  }

  // 開始第一波撈取
  showLoader(readerText('正在載入漫畫…'), { progress: null, detail: readerText('請稍候...') });
  if (eAPI && eAPI.getFavorites) {
    try { state.favorites = await eAPI.getFavorites(); } catch(e) {}
  }
  const savedScanDir = localStorage.getItem('gai:scanDir');
  if (savedScanDir) {
    try {
      const restored = await eAPI.setConfig({ scanDir: savedScanDir });
      if (restored?.scanDir) localStorage.setItem('gai:scanDir', restored.scanDir);
    } catch(e) {
      localStorage.removeItem('gai:scanDir');
      console.warn('已清除無效的舊漫畫目錄設定：', e);
    }
  }

  // 載入外部書籤
  if (eAPI.setBookmarks) {
    let savedBookmarks = [];
    try {
      savedBookmarks = JSON.parse(localStorage.getItem('gai:externalBookmarks') || '[]');
    } catch (e) {}
    if (savedBookmarks.length > 0) {
      try {
        await eAPI.setBookmarks(savedBookmarks);
      } catch (error) {
        console.error('恢復外部資料夾失敗：', error);
        alert(readerText('部分外部資料夾權限無法恢復，請在設定中重新加入：\n{error}', { error }));
      }
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

function isIOSLibraryDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function addIOSLibrarySource() {
  if (!window.electronAPI?.openExternalFolder) {
    throw new Error(readerText('本環境不支援 iOS 外部資料夾授權'));
  }

  let desiredBookmarks = null;
  try {
    const result = await window.electronAPI.openExternalFolder();
    if (!result?.bookmark) return;

    let bookmarks = [];
    try {
      bookmarks = JSON.parse(localStorage.getItem('gai:externalBookmarks') || '[]');
    } catch (error) {
      console.warn('外部資料夾清單格式無效，將重新建立：', error);
    }

    if (bookmarks.some(bookmark => bookmark.name === result.name && bookmark.bookmark === result.bookmark)) {
      alert(readerText('這個資料夾已經加入了。'));
      return;
    }

    bookmarks.push({ bookmark: result.bookmark, name: result.name });
    desiredBookmarks = bookmarks;
    await window.electronAPI.setBookmarks(bookmarks);
    localStorage.setItem('gai:externalBookmarks', JSON.stringify(bookmarks));
    renderExternalBookmarks();
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
    if (isIOSLibraryDevice()) {
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
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => {
      importInput.click();
    });

    importInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      showLoader(readerText('正在從相簿匯入 {count} 張圖片...', { count: files.length }), { progress: 0, detail: readerText('請勿關閉 App') });

      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const arrayBuffer = await file.arrayBuffer();
          // 生成一個帶有時間戳的檔名，避免重複
          const filename = `${Date.now()}_${i}_${file.name || 'image.jpg'}`;
          await eAPI.saveImportedPhoto(filename, Array.from(new Uint8Array(arrayBuffer)));

          showLoader(readerText('正在從相簿匯入 {count} 張圖片...', { count: files.length }), { progress: ((i + 1) / files.length) * 100, detail: readerText('正在匯入: {name}', { name: file.name }) });
        }

        // 匯入完成後重新掃描
        showLoader(readerText('圖片匯入完成！正在整理書架...'), { progress: null, detail: readerText('馬上就好囉...') });
        if (eAPI.scanLibrary) {
          try { await eAPI.scanLibrary(); } catch(err) { console.error(err); }
        }
        await fetchLibrary();
      } catch (err) {
        alert(readerText('匯入失敗：{error}', { error: err }));
        console.error(err);
      }

      hideLoader();
      importInput.value = ''; // 清空選擇
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

  // 閱讀器滑鼠活動觸發顯示控制列，邊緣 12% 才觸發，靜止後自動隱藏
  elements.readerOverlay.addEventListener('mousemove', (e) => {
    // 觸控相容滑鼠事件與按住拖曳不能繞過下方的 tap/swipe 判定。
    if (e.buttons || readerTouchActive || e.sourceCapabilities?.firesTouchEvents) return;
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
  const cancelWebtoonAnchorFromUserInput = () => {
    if (state.readingMode === 'webtoon') cancelWebtoonAnchor();
  };
  const deferReaderTouchReset = () => {
    clearTimeout(readerTouchResetTimer);
    readerTouchResetTimer = window.setTimeout(resetReaderTouchSession, 350);
  };
  elements.readerViewport.addEventListener('touchstart', (e) => {
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
    if (!readerTouchCancelled && !readerTouchMulti && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
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
    triggerControlsActive();
  });

  elements.readerBottomBar.addEventListener('mouseenter', () => {
    clearTimeout(state.readerIdleTimer);
  });
  elements.readerBottomBar.addEventListener('mouseleave', () => {
    triggerControlsActive();
  });

  // 滑鼠滾輪翻頁
  elements.readerViewport.addEventListener('wheel', handleWheelScroll, { passive: false });

  // 設定按鈕與視窗事件
  elements.settingsBtn.addEventListener('click', openSettingsModal);
  elements.closeSettingsBtn.addEventListener('click', closeSettingsModal);
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
  elements.aiProvider?.addEventListener('change', updateAiProviderDisclosure);
  elements.aiSaveBtn?.addEventListener('click', saveAiSession);
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
  window.addEventListener('resize', scheduleReaderImageTransformRefresh);
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
    const isIOSDevice = isIOSLibraryDevice();
    if (elements.fallbackFolderBrowser) elements.fallbackFolderBrowser.style.display = 'none';
    if (isIOSDevice) {
      if (elements.scanPathRow) elements.scanPathRow.hidden = true;
      if (elements.librarySourceLabel) elements.librarySourceLabel.removeAttribute('for');
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
  const fitScale = readerImageFitScale(img);
  const zoomScale = state.zoomPercentage / 100;
  const scale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale * zoomScale : zoomScale;
  img.style.transform = `scale(${scale}) rotate(${state.rotationAngle}deg)`;
}

function refreshReaderImageTransforms() {
  elements.pagesContainer.querySelectorAll('img').forEach(applyReaderImageTransform);
}

function scheduleReaderImageTransformRefresh() {
  cancelAnimationFrame(readerTransformFrame);
  readerTransformFrame = requestAnimationFrame(refreshReaderImageTransforms);
}

function replaceReaderImages(images) {
  elements.pagesContainer.innerHTML = '';
  images.filter(Boolean).forEach(img => elements.pagesContainer.appendChild(img));
  scheduleReaderImageTransformRefresh();
  scheduleAutoPageExplanation();
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
  state.currentPath = ""; // 切換狀態過濾時回到根目錄

  document.querySelectorAll('.filter-btn').forEach(btn => {
    const selected = btn.dataset.filter === state.activeFilter;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });
  filterAndRenderGrid();
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
  elements.tagEditorCount.textContent = `${tag.workCount} ${readerText('作品')}使用`;
  elements.tagEditorDisplay.value = tag.displayValue;
  elements.tagEditorColor.value = tag.colorKey || '';
  elements.tagEditorPinned.checked = Boolean(tag.pinned);
  elements.tagEditorDisable.textContent = tag.disabled ? readerText('恢復標籤') : readerText('停用標籤');
  elements.tagEditorUndo.disabled = !state.lastTagUndoToken;
  elements.tagEditorTarget.innerHTML = `<option value="">${readerText('選擇目標標籤')}</option>` + state.tagInventoryItems
    .filter(item => item.id !== tagId && !item.disabled)
    .map(item => `<option value="${item.id}">${escapeHtml(item.namespace)}:${escapeHtml(item.displayValue)} · ${item.workCount} 部</option>`).join('');
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
    await eAPI.upsertFolderTagRule({ id: null, sourceId: sample.sourceId || 'local', folderPath: state.currentPath, tag, enabled: true });
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
      <article><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.parserId || 'unknown')} · 信心 ${item.confidence ?? '—'}</span><small>${escapeHtml(item.reason)} · ${escapeHtml(item.sourcePath)}</small></article>`).join('') : `<p>${readerText('目前沒有低信心項目。')}</p>`;
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
      <article><strong>${item.comicIds.length} 本候選</strong><span>指紋 ${escapeHtml(item.fingerprint.slice(0, 12))}…</span><small>${item.locations.map(escapeHtml).join('、')}</small></article>`).join('') : `<p>${readerText('目前沒有重複候選；系統不會自動合併或刪檔。')}</p>`;
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
  }
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
      try { nextFavorites = await eAPI.getFavorites(); } catch(e) {}
    }
    if (eAPI?.getScanStatus) {
      try {
        latestScanStatus = await eAPI.getScanStatus();
        // App 啟動時 Rust 的背景工作可能比第一輪 UI 讀取晚一拍；
        // 空書架時短暫等候掃描狀態就緒，避免把「尚未開始」誤當成「已完成」。
        const formalComicCount = nextComics.filter(comic => !isBuiltInDemoComic(comic)).length;
        for (let attempt = 0; !latestScanStatus?.isScanning && formalComicCount === 0 && attempt < 6; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          latestScanStatus = await eAPI.getScanStatus();
        }
        scanStillRunning = Boolean(latestScanStatus?.isScanning);
        state.scanStatus = latestScanStatus;
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
    state.comics = nextComics;
    state.favorites = nextFavorites;
    filterAndRenderGrid({ skipUnchanged: silentRefresh, background: silentRefresh });
    renderSidebar();
    renderContinueStrip();
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
      state.favorites = [];
      filterAndRenderGrid();
      renderSidebar();
      renderContinueStrip();
      updateStats();
    }
    if (!silentRefresh) {
      showLoader(readerText('漫畫庫讀取失敗'), {
        progress: null,
        detail: e?.message || String(e)
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
      }
      if (state.scanStatus?.isScanning !== false) updateLoaderScanProgress(state.scanStatus);
      stopScanStatusPolling();
      state.loaderHideTimer = window.setTimeout(hideLoader, 6000);
    } else if (state.scanStatus?.pollError || state.scanStatus?.phase === 'error') {
      updateLoaderScanProgress(state.scanStatus);
      stopScanStatusPolling();
      state.loaderHideTimer = window.setTimeout(hideLoader, 6000);
    } else {
      stopScanStatusPolling();
      hideLoader();
    }
  }
}

// 渲染側邊欄分類清單
function renderSidebar() {
  const seriesMap = new Map();
  state.comics.forEach(c => {
    const s = c.series || readerText('未分類');
    seriesMap.set(s, (seriesMap.get(s) || 0) + 1);
  });

  const seriesNames = Array.from(seriesMap.keys())
    .filter(seriesName => seriesName !== '.')
    .sort();

  if (elements.seriesFilterSelect) {
    const options = [new Option(readerText('全部系列（{count}）', { count: state.comics.length }), 'all')];
    seriesNames.forEach(seriesName => {
      options.push(new Option(`${seriesName}（${seriesMap.get(seriesName)}）`, seriesName));
    });
    elements.seriesFilterSelect.replaceChildren(...options);
    elements.seriesFilterSelect.value = state.activeSeries;
    if (!elements.seriesFilterSelect.value) {
      state.activeSeries = 'all';
      state.currentPath = '';
    }
    elements.seriesFilterSelect.value = state.activeSeries;
  }

  if (elements.seriesFilterList) {
    const existingItems = new Map(
      [...elements.seriesFilterList.querySelectorAll('li[data-series]')]
        .map(item => [item.dataset.series, item])
    );
    const entries = [
      ['all', readerText('全部系列'), state.comics.length],
      ...seriesNames.map(seriesName => [seriesName, seriesName, seriesMap.get(seriesName)])
    ];
    const desiredItems = entries.map(([seriesName, label, count]) => {
      let item = existingItems.get(seriesName);
      if (!item) {
        item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'series-name';
        const badge = document.createElement('span');
        badge.className = 'badge';
        item.append(name, badge);
      }
      item.onclick = () => selectSeries(seriesName);
      configureInteractiveItem(item, readerText('顯示系列：{label}', { label }), () => selectSeries(seriesName));
      item.dataset.series = seriesName;
      item.classList.toggle('active', state.activeSeries === seriesName);
      if (state.activeSeries === seriesName) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
      const name = item.querySelector('.series-name');
      const badge = item.querySelector('.badge');
      name.textContent = label;
      badge.textContent = String(count);
      existingItems.delete(seriesName);
      return item;
    });
    existingItems.forEach(item => item.remove());
    desiredItems.forEach((item, index) => {
      const current = elements.seriesFilterList.children[index];
      if (current !== item) elements.seriesFilterList.insertBefore(item, current || null);
    });
  }
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
  state.currentPath = '';
  filterAndRenderGrid();
}

// 統計資訊更新
function updateStats() {
  const formalComics = state.comics.filter(comic => !isBuiltInDemoComic(comic));
  const total = formalComics.length;
  let reading = 0;
  let completed = 0;

  formalComics.forEach(c => {
    const prog = c.progress;
    if (prog && prog.currentPage > 0) {
      if (prog.percent >= 98 || prog.currentPage >= prog.totalPages - 1) {
        completed++;
      } else {
        reading++;
      }
    }
  });

  elements.statsTotal.textContent = total;
  elements.statsReading.textContent = reading;
  elements.statsCompleted.textContent = completed;
}

function getProgressInfo(comic) {
  const progress = comic?.progress || {};
  const currentPage = Number(progress.currentPage || 0);
  const totalPages = Number(progress.totalPages || comic?.pageCount || 0);
  const suppliedPercent = Number(progress.percent);
  const rawPercent = Number.isFinite(suppliedPercent)
    ? suppliedPercent
    : totalPages > 0 ? (currentPage / totalPages) * 100 : 0;
  const percent = Math.round(Math.min(100, Math.max(0, rawPercent)));
  return {
    currentPage,
    totalPages,
    percent,
    hasProgress: currentPage > 0,
    isFinished: currentPage > 0 && (percent >= 98 || currentPage >= totalPages - 1)
  };
}

function renderContinueStrip() {
  if (!elements.continueStrip) return;

  const readable = state.comics.filter(comic => comic && !comic.isDirectory && !isBuiltInDemoComic(comic));
  const candidates = readable
    .filter(comic => getProgressInfo(comic).hasProgress || state.favorites.includes(comic.id))
    .sort((a, b) => {
      const ta = new Date(a.progress?.updatedAt || a.updatedAt).getTime();
      const tb = new Date(b.progress?.updatedAt || b.updatedAt).getTime();
      return tb - ta;
    })
    .slice(0, 5);

  const renderSignature = candidates.map(comic => {
    const progress = getProgressInfo(comic);
    return [
      comic.id,
      comic.title,
      progress.currentPage,
      progress.totalPages,
      state.favorites.includes(comic.id) ? 'favorite' : ''
    ].join(':');
  }).join('|') || 'empty';
  if (renderSignature === lastContinueRenderSignature) return;
  lastContinueRenderSignature = renderSignature;

  if (candidates.length === 0) {
    elements.continueStrip.innerHTML = `
      <div class="continue-empty">
        <i class="fa-solid fa-wand-magic-sparkles"></i>
        <span>${readerText('開始閱讀後，最近進度會出現在這裡。')}</span>
      </div>
    `;
    return;
  }

  elements.continueStrip.innerHTML = candidates.map(comic => {
    const progress = getProgressInfo(comic);
    const favorite = state.favorites.includes(comic.id);
    return `
      <button class="continue-card" data-comic-id="${comic.id}">
        <img src="${escapeHtml(getCoverUrl(comic.id))}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}" onerror="this.style.display='none';">
        <span class="continue-body">
          <strong>${escapeHtml(comic.title)}</strong>
          <small>${progress.hasProgress ? readerText('第 {page} 頁', { page: progress.currentPage + 1 }) : readerText('已收藏')}</small>
          <span class="continue-progress"><span style="width: ${progress.percent || (favorite ? 12 : 0)}%"></span></span>
        </span>
        <i class="fa-solid ${favorite ? 'fa-heart' : 'fa-play'}"></i>
      </button>
    `;
  }).join('');

  elements.continueStrip.querySelectorAll('.continue-card').forEach(card => {
    card.addEventListener('click', () => openReader(card.dataset.comicId));
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
    state.favorites.includes(comic.id) ? 'favorite' : '',
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
  if (isBuiltInDemoComic(comic)) {
    openReader(comic.id);
    return;
  }
  if (state.organizeMode && !comic.isDirectory) {
    toggleOrganizerSelection(comic.id);
    return;
  }

  if (state.selectedComicId === comic.id) {
    if (comic.isDirectory) {
      state.currentPath = comic.relativePath;
      filterAndRenderGrid();
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
  const format = photoAlbum ? readerText('照片相簿') : builtInDemo ? readerText('風景選集') : isDirectory ? readerText('目錄') : (String(comic.type || '').includes('archive') ? 'CBZ/ZIP' : readerText('圖片資料夾'));
  const favorite = !isDirectory && !builtInDemo && state.favorites.includes(comic.id);
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
        <span>${progress.totalPages || comic.comicsCount || '---'} ${readerText('頁')}</span>
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
        <button class="inspector-primary" data-inspector-action="open">
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
          <span><strong>${readerText('AI 建議摘要與標籤')}</strong><small>${readerText('讀取封面／第一頁，只產生待確認建議')}</small></span>
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
        state.currentPath = comic.relativePath;
        filterAndRenderGrid();
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
      state.favorites = await eAPI.toggleFavorite(comic.id);
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
    status.textContent = capability.reason || `${capability.sourceKind === 'smb' ? 'NAS' : readerText('本機')}來源可安全修改；${readerText('移除會先進隔離區。')}`;
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
  if (leftDemo !== rightDemo) return leftDemo ? -1 : 1;
  if (leftDemo && rightDemo) {
    return (Number(left.demoOrder) || 0) - (Number(right.demoOrder) || 0);
  }
  return comicTitleCollator.compare(String(left.title || ''), String(right.title || ''));
}

// 計算目前目錄樹路徑下的項目 (由姬米妮為主人傾力打造的 YACReader 級目錄折疊算法 ✨)
function getDirectoryItems() {
  const curPath = state.currentPath;
  const itemsMap = new Map(); // 子目錄折疊
  const filesList = []; // 直屬此目錄的漫畫

  // 1. 先進行基礎的系列與狀態過濾
  const baseFiltered = state.comics.filter(comic => {
    if (isBuiltInDemoComic(comic) && state.activeFilter === 'favorite') return false;
    // 側邊欄系列過濾
    if (state.activeSeries !== 'all') {
      if (comic.series !== state.activeSeries) return false;
    }

    // 狀態過濾 (全部/閱讀中/未讀/已讀完)
    const prog = comic.progress;
    const isStarted = prog && prog.currentPage > 0;
    const isFinished = isStarted && (prog.percent >= 98 || prog.currentPage >= prog.totalPages - 1);

    if (state.activeFilter === 'reading') {
      return isStarted && !isFinished;
    } else if (state.activeFilter === 'unread') {
      return !isStarted;
    } else if (state.activeFilter === 'finished') {
      return isFinished;
    } else if (state.activeFilter === 'favorite') {
      return state.favorites.includes(comic.id);
    }

    return true;
  });

  // 2. 如果使用者正在使用關鍵字搜尋，則退化為「扁平全庫搜尋」，體驗最佳！
  const query = elements.searchInput.value.toLowerCase().trim();
  if (query) {
    return baseFiltered.filter(comic => {
      // SQLite 搜尋結果只代表正式資料庫內容；內建示範沒有 catalog row，
      // 但仍應以本地標題／系列／slug 判斷，不能因 catalogSearchIds 存在就消失。
      const matchTitle = String(comic.title || '').toLowerCase().includes(query);
      const matchPath = String(comic.relativePath || '').toLowerCase().includes(query);
      const matchSeries = String(comic.series || '').toLowerCase().includes(query);
      const metadata = state.catalogSearchItems.get(comic.id);
      const matchMetadata = metadata
        ? JSON.stringify(metadata).toLowerCase().includes(query)
        : false;
      if (isBuiltInDemoComic(comic)) return matchTitle || matchPath || matchSeries;
      if (state.catalogSearchIds) {
        return state.catalogSearchIds.has(comic.id) && (matchTitle || matchPath || matchSeries || matchMetadata);
      }
      return matchTitle || matchPath || matchSeries || matchMetadata;
    }).map(c => {
      const metadata = state.catalogSearchItems.get(c.id);
      return { ...c, title: metadata?.title || c.title, series: metadata?.series || c.series, metadataTags: metadata?.tags || [], offline: metadata?.offline || false, isDirectory: false };
    }).sort(compareShelfItems);
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

        if (!itemsMap.has(folderName)) {
          itemsMap.set(folderName, {
            id: 'folder-' + btoa(unescape(encodeURIComponent(folderPath))), // btoa 安全編碼作為 ID
            title: folderName,
            type: 'folder',
            relativePath: folderPath,
            isDirectory: true,
            coverComicId: comic.id, // 用該目錄下第一本書的封面！
            comicsCount: 1
          });
        } else {
          itemsMap.get(folderName).comicsCount++;
        }
      }
    }
  });

  // 本地化自然排序 ( numeric: true )，這對漫畫卷數 (Vol.2, Vol.10) 排序極度友善！
  const directories = Array.from(itemsMap.values()).sort((a, b) => comicTitleCollator.compare(a.title, b.title));
  const files = filesList.sort(compareShelfItems);

  // 根目錄固定把 8 組示範放在最上方；進入任何實體子目錄後，它們沒有
  // 該層級的 relativePath，因此不會被折疊成子目錄或混入子目錄內容。
  if (curPath === '') {
    return [
      ...files.filter(isBuiltInDemoComic),
      ...directories,
      ...files.filter(comic => !isBuiltInDemoComic(comic)),
    ];
  }

  return [...directories, ...files];
}

// 核心過濾與渲染漫畫書架
function filterAndRenderGrid(options = {}) {
  syncLibraryUpButton();
  // 1. 取得目前路徑下的項目
  state.filteredComics = getDirectoryItems();

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
      state.currentPath = "";
      filterAndRenderGrid();
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
          state.currentPath = targetPath;
          filterAndRenderGrid();
        };
      }
      elements.folderBreadcrumbs.appendChild(pathBtn);
    });
  }

  renderGrid(options);
  ensureInspectorSelection({ skipUnchanged: Boolean(options.skipUnchanged) });
}

// 繪製漫畫卡片網格
function renderGrid({ skipUnchanged = false, background = false } = {}) {
  if (state.filteredComics.length === 0) {
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

  const visibleComics = state.filteredComics.slice(0, state.renderLimit);
  if (elements.catalogLoadMore) {
    const totalAvailable = state.catalogSearchIds ? Math.max(state.filteredComics.length, state.catalogSearchTotal) : state.filteredComics.length;
    elements.catalogLoadMore.hidden = visibleComics.length >= state.filteredComics.length && state.filteredComics.length >= totalAvailable;
    elements.catalogLoadMore.textContent = readerText('顯示更多漫畫（{shown} / {total}）', { shown: visibleComics.length, total: totalAvailable });
  }

  const renderSignature = [
    state.currentPath,
    state.activeSeries,
    state.activeFilter,
    state.organizeMode ? 'organize' : 'browse',
    visibleComics.map(comic => comic.isDirectory
      ? `dir:${comic.id}:${comic.coverComicId || ''}:${comic.comicsCount || 0}`
      : [
          comic.id,
          comic.title,
          comic.series,
          comic.type,
          comic.pageCount,
          comic.progress?.currentPage || 0,
          comic.progress?.totalPages || 0,
          isComicOffline(comic) ? 'offline' : 'online',
          state.favorites.includes(comic.id) ? 'favorite' : ''
        ].join(':')
    ).join('|')
  ].join('::');

  if (skipUnchanged && renderSignature === lastGridRenderSignature) return;
  lastGridRenderSignature = renderSignature;
  coverObserver?.disconnect();
  coverObserver = null;
  resetCoverLoadQueue();
  elements.comicGrid.classList.toggle('background-refresh', background);
  const gridFragment = document.createDocumentFragment();

  visibleComics.forEach(comic => {
    const sourceOffline = isComicOffline(comic);
    const card = document.createElement(state.organizeMode && !comic.isDirectory ? 'button' : 'div');
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
            <span>${comic.pageCount} ${readerText('頁')}</span>
          </div>
        </div>
      `;
      card.onclick = () => openReader(comic.id);
      configureInteractiveItem(card, readerText('開啟風景選集：{title}', { title: comic.title }), card.onclick);
      card.setAttribute('aria-pressed', 'false');
    } else if (comic.isDirectory) {
      // ==========================================
      // 📁 【虛擬資料夾卡片】 YACReader 級層級折疊！
      // ==========================================
      card.innerHTML = `
        <div class="comic-cover-wrapper cover-pending">
          <img class="comic-cover lazy-cover"
               data-cover-id="${escapeHtml(comic.coverComicId || '')}"
               data-src="${escapeHtml(getCoverUrl(comic.coverComicId))}"
               loading="lazy"
               decoding="async"
               fetchpriority="low"
               alt="${escapeHtml(comic.title)}">
          <div class="comic-cover-placeholder" style="background: var(--bg-hover);">
            <div class="placeholder-icon" style="font-size: 40px;">📁</div>
            <div class="placeholder-text" style="margin-top: 10px;">${escapeHtml(comic.title)}</div>
          </div>
            <span class="comic-format-tag" style="background: var(--accent); color: white;"><i class="fa-solid fa-folder"></i> ${readerText('目錄')}</span>
        </div>
        <div class="comic-info">
          <div class="comic-title" title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</div>
          <div class="comic-meta">
            <span style="color: var(--accent); font-weight: 500;"><i class="fa-solid fa-book-open"></i> ${comic.comicsCount} ${readerText('本漫畫')}</span>
            <span>${readerText('點擊點入')}</span>
          </div>
        </div>
      `;

      card.onclick = () => {
        state.currentPath = comic.relativePath;
        filterAndRenderGrid();
      };
      configureInteractiveItem(card, readerText('開啟資料夾：{title}', { title: comic.title }), card.onclick);
      card.oncontextmenu = (e) => showGridContextMenu(e, comic);
    } else {
      // ==========================================
      // 📖 【標準漫畫卡片】
      // ==========================================
      // 進度條樣式計算
      const hasProgress = comic.progress && comic.progress.currentPage > 0;
      const percent = getProgressInfo(comic).percent;
      const isFinished = hasProgress && (percent >= 98 || comic.progress.currentPage >= comic.progress.totalPages - 1);

      // 進度徽章內容
      let badgeHtml = '';
      if (isFinished) {
        badgeHtml = `<span class="comic-progress-badge finished"><i class="fa-solid fa-circle-check"></i> ${readerText('已看完')}</span>`;
      } else if (hasProgress) {
        badgeHtml = `<span class="comic-progress-badge"><i class="fa-solid fa-hourglass-half"></i> ${percent}%</span>`;
      }

      // 是否已被收藏
      const isFavorite = state.favorites.includes(comic.id);

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

          <span class="comic-format-tag ${String(comic.type || '').includes('archive') ? 'tag-archive' : 'tag-folder'}" data-ext="${escapeHtml(comic.ext || 'folder')}">${sourceOffline ? `<i class="fa-solid fa-plug-circle-xmark"></i> ${readerText('來源離線')}` : String(comic.type || '').includes('archive') ? escapeHtml((comic.ext || '.cbz').replace('.','').toUpperCase()) : isPhotoAlbum(comic) ? readerText('相簿') : `📁 ${readerText('目錄')}`}</span>
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
            <span>${readerText('共 {total} 頁', { total: comic.pageCount > 0 ? comic.pageCount : '---' })}</span>
            <span>${hasProgress ? readerText('第 {page} 頁', { page: comic.progress.currentPage + 1 }) : readerText('未讀')}</span>
          </div>
        </div>
      `;

      card.onclick = () => activateGridComic(comic);
      configureInteractiveItem(card, state.organizeMode ? readerText('選取漫畫：{title}', { title: comic.title }) : readerText('選取漫畫：{title}；再次操作即可開始閱讀', { title: comic.title }), card.onclick);
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
              state.favorites = await eAPI.toggleFavorite(comic.id);
              const isFav = state.favorites.includes(comic.id);

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
}

// ==========================================================================
// 📖 核心漫畫閱讀器功能
// ==========================================================================

// 開啟閱讀器
async function openReader(comicId) {
  const shelfComic = state.comics.find(comic => comic.id === comicId);
  const previousReadingMode = state.readingMode;
  if (isComicOffline(shelfComic)) {
    showLibrarySourceRecovery(readerText('這本漫畫仍保留在書架，但原本的磁碟位置目前無法存取。請重新掛載 NAS，或選擇新的漫畫目錄。'));
    return;
  }
  await state.readerClosePromise;
  if (state.currentComic) {
    await closeReader();
  }
  const operation = ++state.readerOperation;
  state.pendingComicId = comicId;
  showLoader(readerText('正在載入漫畫頁面…'), { progress: null, detail: readerText('正在準備頁面清單...') });
  try {
    const data = isBuiltInDemoComic(shelfComic)
      ? builtInDemoReaderData(shelfComic)
      : await eAPI.openComic(comicId);
    if (operation !== state.readerOperation) return;

    if (!data.pages || data.pages.length === 0) {
      throw new Error(readerText('這本漫畫沒有可讀取的圖片頁面'));
    }

    state.currentComic = data;
    state.pendingComicId = null;
    state.selectedComicId = comicId;
    state.currentComicPages = data.pages;
    state.currentComicIsDir = data.isDir || false;
    state.currentComicFilenames = data.filenames || [];
    state.aiExplainCache.clear();
    state.aiExplainPendingPage = null;
    state.aiExplainPendingRequest = null;

    state.currentPageIndex = (data.progress && data.progress.currentPage) ? data.progress.currentPage : 0;
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
    elements.readerOverlay.classList.remove('reader-idle');
    document.body.style.overflow = 'hidden';
    hideReaderContextMenu();

    renderPages();
    triggerControlsActive();
  } catch (e) {
    if (operation !== state.readerOperation) return;
    console.error('開啟閱讀器出錯：', e);
    // BUG-09 修正：失敗時清除 currentComic 避免殘留舊狀態
    state.currentComic = null;
    state.currentComicPages = [];
    state.pendingComicId = null;
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

// 關閉閱讀器
async function closeReader() {
  ++state.readerOperation;
  state.renderGeneration += 1;
  cancelWebtoonAnchor();
  state.readerBoundaryDialog?.finish(false);
  state.readerBoundaryDialog = null;
  const closingComic = state.currentComic;
  const closingId = closingComic ? closingComic.id : state.pendingComicId;
  state.currentComic = null;
  state.currentComicPages = [];
  state.pendingComicId = null;
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
  elements.readerOverlay.classList.remove('reader-idle');
  document.body.style.overflow = 'auto';
  if (state.webtoonScrollFrame) {
    cancelAnimationFrame(state.webtoonScrollFrame);
    state.webtoonScrollFrame = null;
  }

  if (closingId && !isBuiltInDemoComic(closingComic) && window.electronAPI && window.electronAPI.closeComic) {
    state.readerClosePromise = state.readerClosePromise
      .catch(() => {})
      .then(() => window.electronAPI.closeComic(closingId));
    try {
      await state.readerClosePromise;
    } catch (err) {
      console.error('關閉漫畫清理失敗:', err);
    }
  }

  if (elements.btnAiExplain) elements.btnAiExplain.hidden = false;
  if (elements.btnAiAutoExplain) elements.btnAiAutoExplain.hidden = false;

  // 重新整理書架（更新最近閱讀與進度條）
  scheduleLibraryRefresh();
}

function releasePreloadedImages() {
  clearTimeout(state.readerCacheWindowTimer);
  state.readerCacheWindowTimer = null;
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

  cancelWebtoonAnchor();
  if (state.webtoonScrollFrame) {
    cancelAnimationFrame(state.webtoonScrollFrame);
    state.webtoonScrollFrame = null;
  }
  const renderGeneration = ++state.renderGeneration;

  const totalPages = state.currentComicPages.length;

  // 移除所有模式 class
  elements.readerOverlay.classList.remove('mode-single', 'mode-double', 'mode-webtoon', 'mode-catalog');

  // BUG-10 修正：每次重新渲染前先清除 onscroll，避免切換模式後 webtoon 事件殘留
  elements.readerViewport.onscroll = null;

  // 重設滾動位置，防止切頁時停留在中段
  elements.readerViewport.scrollTop = 0;

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
    tempImg.decode().then(() => {
      // 確保在非同步解碼期間，使用者沒有突然切換模式或快速翻到別的頁面
      if (state.renderGeneration !== renderGeneration) return;
      if (state.readingMode !== 'single') return;
      if (state.currentComicPages[state.currentPageIndex] !== targetSrc) return;

      // 只有在「百分之百準備好顯示」的這一微秒，才清空 DOM 並瞬間塞入新圖片，絕對零閃爍！
      replaceReaderImages([tempImg]);

      // 隱藏解碼中動畫
      showPageLoadingSpinner(false);
    }).catch(() => {
      // 降級處理（例如圖片損壞等特殊情況）
      if (state.renderGeneration !== renderGeneration) return;
      if (state.readingMode !== 'single') return;
      if (state.currentComicPages[state.currentPageIndex] !== targetSrc) return;
      replaceReaderImages([tempImg]);
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

      tempImg.decode().then(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== 0) return;

        replaceReaderImages([tempImg]);
        showPageLoadingSpinner(false);
      }).catch(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== 0) return;
        replaceReaderImages([tempImg]);
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

      // 用 Promise.all 背景同時等待並解碼雙頁，保證兩張圖同步在背景完全就緒！
      const decodePromises = [img1.decode()];
      if (img2) decodePromises.push(img2.decode());

      Promise.all(decodePromises).then(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== page1Index) return;

        replaceReaderImages(isRtl && img2 ? [img2, img1] : [img1, img2]);
        showPageLoadingSpinner(false);
      }).catch(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== page1Index) return;

        replaceReaderImages(isRtl && img2 ? [img2, img1] : [img1, img2]);
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

    // 條漫模式一次載入所有圖片，使用瀏覽器原生 lazy loading 與極佳的後端傳輸
    const webtoonFragment = document.createDocumentFragment();
    if (findAdjacentComicInFolder('prev')) {
      webtoonFragment.appendChild(createWebtoonNavigationButton('prev'));
    }
    state.currentComicPages.forEach((src, idx) => {
      const img = document.createElement('img');
      img.dataset.src = src; // 儲存真實路徑
      img.decoding = 'async';
      img.fetchPriority = idx < WEBTOON_EAGER_IMAGES ? 'auto' : 'low';
      if (idx < WEBTOON_EAGER_IMAGES) img.src = src; // 前幾張立刻載入，其餘滾動載入
      img.loading = 'lazy';
      img.className = 'webtoon-img';
      img.dataset.index = idx;
      img.alt = readerText('第 {page} 頁', { page: idx + 1 });
      // 未載入頁面也要先佔住固定比例的空間，避免跳到遠頁時前方 lazy
      // 圖片逐張解碼把目標頁往下推。`auto` 會在圖片載入後改用原始比例。
      img.style.aspectRatio = 'auto 2 / 3';
      const preserveAnchorAfterLayout = () => {
        if (state.renderGeneration !== renderGeneration) return;
        preserveWebtoonAnchorPosition();
      };
      img.addEventListener('load', preserveAnchorAfterLayout);
      img.addEventListener('error', preserveAnchorAfterLayout);
      applyImageEffects(img);
      webtoonFragment.appendChild(img);
    });
    if (findAdjacentComicInFolder('next')) {
      webtoonFragment.appendChild(createWebtoonNavigationButton('next'));
    }
    // 模式切換可能重複進入此 branch；一次替換避免舊 webtoon 頁面累積。
    elements.pagesContainer.replaceChildren(webtoonFragment);

    // 監聽滾動事件，用來即時更新進度條與 Lazy Load 觸發
    elements.readerViewport.onscroll = handleWebtoonScroll;

    // 初始化進度
    elements.pageCounter.textContent = readerText('第 {page} / {total} 頁', {
      page: state.currentPageIndex + 1,
      total: totalPages,
    });
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;

    // placeholder 已在同步建 DOM 時提供穩定高度，因此立即建立錨點；
    // 延後到 200ms 會留下 scroll event 改寫 currentPageIndex 的空窗。
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
    elements.readerViewport.onscroll = null;

    renderCatalogGrid();

    elements.pageCounter.textContent = readerText('共 {total} 頁', { total: totalPages });
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;
  }

  syncDoubleModeControls();
  scheduleReaderCacheWindowUpdate();

  // 儲存進度到伺服器
  saveReadingProgress();
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

function renderCatalogGrid() {
  const totalPages = state.currentComicPages.length;

  // 每次目錄重繪都先移除上一個 grid，避免切書或刪頁後舊縮圖疊在新內容上。
  elements.pagesContainer.replaceChildren();

  const grid = document.createElement('div');
  grid.className = 'reader-catalog-grid';

  state.currentComicPages.forEach((src, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'catalog-thumb';
    if (idx === state.currentPageIndex) thumb.classList.add('current');
    thumb.dataset.index = idx;
    configureInteractiveItem(thumb, readerText('跳到第 {page} 頁', { page: idx + 1 }), () => {
      state.currentPageIndex = idx;
      const backMode = state.prevReadingMode || 'single';
      setReadingMode(backMode);
    });

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = src;
    img.alt = readerText('第 {page} 頁', { page: idx + 1 });

    const label = document.createElement('div');
    label.className = 'catalog-thumb-label';
    label.textContent = `${idx + 1}`;

    // 點擊縮圖 → 跳頁並切回閱讀模式
    thumb.onclick = () => {
      state.currentPageIndex = idx;
      const backMode = state.prevReadingMode || 'single';
      setReadingMode(backMode);
    };

    thumb.appendChild(img);
    thumb.appendChild(label);
    grid.appendChild(thumb);
  });

  elements.pagesContainer.appendChild(grid);

  // 滾動到當前頁
  const currentThumb = grid.querySelector('.catalog-thumb.current');
  if (currentThumb) {
    setTimeout(() => currentThumb.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  }
}

// 輔助函式：取得檔案或目錄的父層目錄路徑
function getParentPath(relPath) {
  if (!relPath) return '';
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.substring(0, idx);
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
  state.currentPath = getParentPath(state.currentPath);
  state.selectedComicId = null;
  lastInspectorRenderSignature = '';
  filterAndRenderGrid();
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

function getReaderNavigationCurrent() {
  const currentId = state.currentComic?.id || state.pendingComicId;
  if (!currentId) return null;
  const shelfComic = state.comics.find(comic => comic.id === currentId);
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
  const siblings = state.comics
    .filter(comic => !comic.isDirectory
      && comic.id
      && getComicSourceKey(comic) === sourceKey
      && getParentPath(comic.relativePath) === parentPath)
    .sort((a, b) => comicTitleCollator.compare(String(a.title || ''), String(b.title || '')));
  const currentIndex = siblings.findIndex(comic => comic.id === reader.currentId);
  const targetIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
  return currentIndex >= 0 && targetIndex >= 0 && targetIndex < siblings.length
    ? siblings[targetIndex]
    : null;
}

function scheduleAdjacentComicOpen(comic, direction) {
  if (!comic) return false;
  const operation = state.readerOperation;
  const currentId = state.currentComic?.id;
  showReaderToast(readerText('🔄 即將為您開啟{direction}：{title}', { direction: readerText(direction === 'next' ? '下一本' : '上一本'), title: comic.title }));
  setTimeout(() => {
    if (operation !== state.readerOperation || !state.currentComic || state.currentComic.id !== currentId) return;
    openReader(comic.id);
  }, 800);
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

function showReaderNavigationConfirm(target, direction) {
  if (state.readerBoundaryDialog) return Promise.resolve(false);
  const overlay = document.createElement('div');
  overlay.id = 'reader-navigation-confirm';
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', readerText(direction === 'next' ? '確認開啟下一本漫畫' : '確認開啟上一本漫畫'));
  overlay.style.zIndex = '10050';
  overlay.style.display = 'flex';
  overlay.tabIndex = -1;

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.maxWidth = 'min(420px, calc(100vw - 32px))';
  content.style.padding = '24px';
  content.style.paddingBottom = 'calc(24px + env(safe-area-inset-bottom, 0px))';
  const title = document.createElement('h3');
  title.textContent = readerText(direction === 'next' ? '要開啟下一本漫畫嗎？' : '要開啟上一本漫畫嗎？');
  const message = document.createElement('p');
  message.textContent = target?.title ? readerText('將開啟「{title}」。', { title: target.title }) : readerText('將開啟相鄰漫畫。');
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.justifyContent = 'flex-end';
  actions.style.gap = '8px';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'modal-action-btn';
  cancel.textContent = readerText('取消');
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'modal-action-btn primary';
  confirm.textContent = readerText('開啟');
  actions.append(cancel, confirm);
  content.append(title, message, actions);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  return new Promise(resolve => {
    let settled = false;
    const returnFocus = document.activeElement;
    const finish = value => {
      if (settled) return;
      settled = true;
      overlay.remove();
      if (state.readerBoundaryDialog?.finish === finish) state.readerBoundaryDialog = null;
      returnFocus?.focus?.({ preventScroll: true });
      resolve(value);
    };
    state.readerBoundaryDialog = { finish };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', event => {
      if (event.target === overlay) finish(false);
    });
    overlay.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Tab') {
        event.preventDefault();
        if (document.activeElement === cancel) confirm.focus();
        else cancel.focus();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    cancel.focus();
  });
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

  const operation = state.readerOperation;
  const currentId = state.currentComic?.id;
  showReaderNavigationConfirm(target, direction).then(confirmed => {
    if (!confirmed || operation !== state.readerOperation || state.currentComic?.id !== currentId || state.readingMode !== 'webtoon') return;
    const currentTarget = findAdjacentComicInFolder(direction);
    if (!currentTarget || currentTarget.id !== target.id) return;
    scheduleAdjacentComicOpen(target, direction);
  });
  return true;
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
    saveReadingProgress();
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

function handleReaderPointerClick(e) {
  if (elements.readerOverlay.style.display === 'none' || e.button !== 0) return;
  if (e.target.closest?.('button, input, select, textarea, a, #ai-page-panel')) return;

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
  state.readerCacheWindowPage = pageIndex;
  state.readerCacheReadyPage = null;
  state.readerCacheWindowTimer = setTimeout(async () => {
    state.readerCacheWindowTimer = null;
    if (!state.currentComic || state.currentComic.id !== comicId) return;
    try {
      const generation = await eAPI.updateReaderCacheWindow(comicId, pageIndex);
      if (state.currentComic?.id === comicId && Number.isSafeInteger(generation)) {
        state.currentComic.preloadGeneration = generation;
      }
    } catch (error) {
      if (state.currentComic?.id === comicId && state.readerCacheWindowPage === pageIndex) {
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
  const targetImg = getWebtoonImage(index);
  if (!targetImg) return false;

  cancelWebtoonAnchor();
  const anchor = { index, generation: renderGeneration, lastTargetTop: null, resizeObserver: null };
  state.webtoonAnchor = anchor;
  state.currentPageIndex = index;
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
  const imgs = elements.pagesContainer.querySelectorAll('.webtoon-img');
  const viewportTop = elements.readerViewport.scrollTop;
  const viewportHeight = elements.readerViewport.clientHeight;
  const viewportCenter = viewportTop + viewportHeight / 2;

  let activeIndex = 0;

  imgs.forEach(img => {
    const top = img.offsetTop;
    const height = img.clientHeight;

    // 如果視窗中心線在這張圖片範圍內，這張圖片就是目前主要閱讀的頁面
    if (viewportCenter >= top && viewportCenter <= top + height) {
      activeIndex = parseInt(img.dataset.index, 10);
    }
  });

  if (activeIndex !== state.currentPageIndex) {
    state.currentPageIndex = activeIndex;
    elements.pageCounter.textContent = readerText('第 {page} / {total} 頁', { page: state.currentPageIndex + 1, total: state.currentComicPages.length });
    elements.progressSlider.value = state.currentPageIndex + 1;

    // 即時懶加載附近的圖片
    loadWebtoonImagesAround(activeIndex);

    // 儲存進度 (防抖動)
    clearTimeout(state.progressSaveTimer);
    state.progressSaveTimer = setTimeout(saveReadingProgress, 500);
  }
}

// 條漫模式載入附近頁面的實體圖片
function loadWebtoonImagesAround(index) {
  const total = state.currentComicPages.length;
  const range = 3; // 載入前後 3 頁

  for (let i = Math.max(0, index - range); i <= Math.min(total - 1, index + range); i++) {
    const img = elements.pagesContainer.querySelector(`img[data-index="${i}"]`);
    if (img && !img.getAttribute('src')) {
      tuneImageForLowPriority(img);
      img.src = img.dataset.src;
    }
  }
}

// 儲存進度至主程序
async function saveReadingProgress() {
  if (!state.currentComic || isBuiltInDemoComic(state.currentComic)) return;
  try {
    await eAPI.saveProgress({
      id: state.currentComic.id,
      currentPage: state.currentPageIndex,
      totalPages: state.currentComicPages.length
    });
  } catch (e) {
    console.error('保存進度失敗：', e);
  }
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
  // Confirmation owns keyboard input until it resolves. Its own keydown
  // handler stops bubbling; this guard also covers programmatic focus drift.
  if (state.readerBoundaryDialog) {
    e.preventDefault();
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

  // 條漫模式下不支援螢幕適應與旋轉
  if (mode === 'webtoon') {
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
  if (state.readingMode === 'webtoon') return;

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

  const labels = ['關閉', '✨ 輕度銳利', '✨✨ 中度銳利', '✨✨✨ 強度銳利'];
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
  if (!status.pollError && !status.error) {
    state.scanStatus.pollError = false;
  }
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

// ==========================================================================
// ⚙️ 漫畫庫目錄路徑設定邏輯
// ==========================================================================

// 打開設定視窗
async function openSettingsModal() {
  state.dialogReturnFocus = document.activeElement;
  elements.settingsModal.style.display = 'flex';
  elements.closeSettingsBtn.focus();
  renderExternalBookmarks();

  try {
    const config = await eAPI.getConfig();
    elements.scanDirInput.value = config.scanDir;
    await fetchBrowserFolders(config.scanDir);
  } catch (e) {
    console.error('載入漫畫庫設定失敗：', e);
  }
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

  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('gai:externalBookmarks') || '[]');
  } catch (e) {}
  if (bookmarks.length === 0) {
    container.innerHTML = `<div style="font-size: 0.9em; color: var(--text-muted);"><i class="fa-solid fa-info-circle"></i> ${readerText('目前沒有已加入的外部資料夾')}</div>`;
    return;
  }

  container.innerHTML = `<div style="font-size: 0.9em; color: var(--text-muted); margin-bottom: 5px;"><i class="fa-solid fa-link"></i> ${readerText('已連結的外部資料夾：')}</div>`;
  bookmarks.forEach((b, idx) => {
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
    delBtn.style.background = 'var(--accent-red)';
    delBtn.style.color = 'white';
    delBtn.style.border = 'none';
    delBtn.style.padding = '5px 10px';
    delBtn.style.borderRadius = '4px';
    delBtn.style.cursor = 'pointer';
    delBtn.onclick = async () => {
      if (confirm(readerText('確定要移除外部資料夾 [{name}] 嗎？', { name: b.name }))) {
        const nextBookmarks = bookmarks.filter((_, bookmarkIndex) => bookmarkIndex !== idx);
        try {
          if (window.electronAPI && window.electronAPI.setBookmarks) {
            await window.electronAPI.setBookmarks(nextBookmarks);
          }
          localStorage.setItem('gai:externalBookmarks', JSON.stringify(nextBookmarks));
        } catch (error) {
          const { message, stateWasUpdated } = classifyBookmarkUpdateError(error);
          if (!stateWasUpdated) {
            console.error('移除外部資料夾失敗：', error);
            alert(readerText('移除失敗，來源清單沒有變更：\n{message}', { message }));
            return;
          }
          // 原生清單已提交；仍保存新清單，避免下次啟動重新加入已移除的來源。
          localStorage.setItem('gai:externalBookmarks', JSON.stringify(nextBookmarks));
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
  state.dialogReturnFocus?.focus?.();
}

function openSmbModal() {
  closeSettingsModal();
  // 載入當前設定
  let smbConfig = {};
  try {
    smbConfig = JSON.parse(localStorage.getItem('gai:smb') || '{}');
  } catch (e) {}
  elements.smbHost.value = smbConfig.host || '';
  elements.smbShare.value = smbConfig.share || '';
  elements.smbUser.value = smbConfig.username || '';
  elements.smbPass.value = smbConfig.password || '';
  elements.smbModal.style.display = 'flex';
  state.dialogReturnFocus = document.activeElement;
  elements.closeSmbBtn.focus();
}

function closeSmbModal() {
  elements.smbModal.style.display = 'none';
  state.dialogReturnFocus?.focus?.();
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
  }
}

function updateAiProviderDisclosure() {
  if (!elements.aiGoogleDisclosureWrap) return;
  elements.aiGoogleDisclosureWrap.hidden = elements.aiProvider?.value !== 'google';
}

function renderAiSessionStatus(status) {
  if (!elements.aiSessionStatus) return;
  if (!status?.configured) {
    elements.aiSessionStatus.textContent = readerText('尚未設定艦載 AI。Key 只保留到 App 關閉。');
    return;
  }
  const label = status.provider === 'google' ? 'Google Gemma 4' : 'OpenAI Luna';
  elements.aiSessionStatus.textContent = readerText('已啟用 {label} · {model}（工作階段限定）', { label, model: status.model });
}

async function refreshAiSessionStatus() {
  if (!eAPI?.getAiSessionStatus) return;
  try {
    renderAiSessionStatus(await eAPI.getAiSessionStatus());
  } catch (error) {
    console.error('讀取艦載 AI 狀態失敗', error);
  }
}

async function saveAiSession() {
  if (!eAPI?.setAiSessionConfig) return;
  const apiKey = elements.aiApiKey?.value.trim() || '';
  if (!apiKey) {
    showReaderToast(readerText('請先手動輸入 API Key'));
    return;
  }
  elements.aiSaveBtn.disabled = true;
  try {
    const status = await eAPI.setAiSessionConfig({
      provider: elements.aiProvider.value,
      apiKey,
      googleContentDisclosure: Boolean(elements.aiGoogleDisclosure?.checked)
    });
    elements.aiApiKey.value = '';
    renderAiSessionStatus(status);
    showReaderToast(readerText('艦載 AI 已啟用；Key 只存在本次工作階段'));
  } catch (error) {
    showReaderToast(readerText('艦載 AI 設定失敗：{error}', { error: error?.message || error }));
  } finally {
    elements.aiSaveBtn.disabled = false;
  }
}

async function testAiSession() {
  if (!eAPI?.testAiSession) return;
  elements.aiTestBtn.disabled = true;
  elements.aiSessionStatus.textContent = readerText('正在用合成文字測試，不會送出漫畫內容…');
  try {
    const response = await eAPI.testAiSession();
    elements.aiSessionStatus.textContent = response || readerText('艦載 AI 連線成功。');
  } catch (error) {
    elements.aiSessionStatus.textContent = readerText('測試失敗：{error}', { error: error?.message || error });
  } finally {
    elements.aiTestBtn.disabled = false;
  }
}

async function clearAiSession() {
  if (!eAPI?.clearAiSessionConfig) return;
  await eAPI.clearAiSessionConfig();
  if (elements.aiApiKey) elements.aiApiKey.value = '';
  renderAiSessionStatus(null);
  showReaderToast(readerText('已清除本次工作階段的 API Key'));
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
  return ['zh-Hant', 'en', 'ja'].includes(locale) ? locale : 'zh-Hant';
}

function aiExplainCacheKey(comicId, pageIndex, locale = getAiExplainLocale()) {
  return `${comicId}:${pageIndex}:${locale}`;
}

function localizeAiExplainError(error) {
  const message = error?.message || String(error);
  if (/請先到設定輸入艦載 AI API Key|API key.*設定|API key.*config|not configured/i.test(message)) {
    return readerText('請先到設定輸入艦載 AI API Key');
  }
  if (/尚未同意第三方 AI 資料分享|consent.*third-party|third-party.*consent/i.test(message)) {
    return readerText('尚未同意第三方 AI 資料分享');
  }
  if (/AI.*不可用|AI.*unavailable|service.*unavailable/i.test(message)) {
    return readerText('艦載 AI 目前不可用，請稍後再試。');
  }
  return message;
}

async function requestPageExplanation(pageIndex, automatic = false) {
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
  state.aiExplainPendingPage = null;
  state.aiExplainPendingRequest = null;
  setAiPagePanelVisible(true);
  elements.aiPageResult.textContent = readerText('艦載 AI 正在閱讀第 {page} 頁…', { page: pageIndex + 1 });
  elements.btnAiExplain.disabled = true;
  syncReaderRotationUi();
  try {
    const dataUrl = await pageDataUrl(state.currentComicPages[pageIndex]);
    const explanation = await eAPI.explainPage({ dataUrl, targetLocale: locale });
    state.aiExplainCache.set(cacheKey, explanation);
    if (state.currentComic?.id === comicId
      && state.currentPageIndex === pageIndex
      && getAiExplainLocale() === locale) {
      elements.aiPageResult.textContent = explanation;
    }
  } catch (error) {
    if (state.currentComic?.id === comicId
      && state.currentPageIndex === pageIndex
      && getAiExplainLocale() === locale) {
      const message = localizeAiExplainError(error);
      if (/^PRO_REQUIRED:/i.test(message)) {
        setAutoPageExplanation(false);
        elements.aiPageResult.textContent = readerText('Pro 權益目前不可用，已停止全書隨讀；已完成的解說仍保留。');
        if (!automatic) window.GaiCommerce?.handleError(error);
      } else if (/HTTP 429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
        setAutoPageExplanation(false);
        elements.aiPageResult.textContent = readerText('免費額度或請求頻率暫時用完，已停止全書隨讀。稍後再試，或到設定切換 Luna。已完成的頁面仍保留在本次快取。');
      } else {
        elements.aiPageResult.textContent = readerText('艦載 AI 無法說明：{error}', { error: message });
      }
    }
  } finally {
    state.aiExplainInFlight = false;
    state.aiExplainActiveRequest = null;
    elements.btnAiExplain.disabled = false;
    const pendingRequest = state.aiExplainPendingRequest;
    state.aiExplainPendingPage = null;
    state.aiExplainPendingRequest = null;
    if (pendingRequest
      && pendingRequest.comicId === state.currentComic?.id
      && pendingRequest.pageIndex === state.currentPageIndex
      && (!pendingRequest.automatic || state.aiAutoExplain)) {
      // Retry a same-page request when its locale changed while the previous
      // request was in flight; this is deliberately explicit for manual mode.
      void requestPageExplanation(pendingRequest.pageIndex, pendingRequest.automatic);
    }
  }
}

async function comicPreviewDataUrl(comicId) {
  if (!eAPI?.openComic) throw new Error(readerText('目前環境無法讀取漫畫頁面'));
  const comic = await eAPI.openComic(comicId);
  if (!comic?.pages?.length) throw new Error(readerText('這本漫畫沒有可供分析的封面或第一頁'));
  return pageDataUrl(comic.pages[0]);
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
  resultContainer.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  if (!eAPI?.suggestComicMetadata || !comic?.id) {
    resultContainer.textContent = readerText('請在桌面 App 中使用艦載 AI 整理建議。');
    return;
  }
  if (isComicOffline(comic)) {
    resultContainer.textContent = readerText('漫畫來源目前離線，重新掛載後才能讀取封面。');
    return;
  }
  resultContainer.textContent = readerText('艦載 AI 正在讀取封面／第一頁，提出可審核的摘要與標籤…');
  button.disabled = true;
  try {
    const dataUrl = await comicPreviewDataUrl(comic.id);
    const candidates = await eAPI.suggestComicMetadata({ comicId: comic.id, dataUrl });
    renderAiMetadataCandidates(candidates, comic.id, resultContainer);
  } catch (error) {
    resultContainer.textContent = readerText('艦載 AI 建議失敗：{error}', { error: error?.message || error });
  } finally {
    if (button.isConnected) button.disabled = false;
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
    resetLibraryNavigationState();
    filterAndRenderGrid();
    renderSidebar();
    renderContinueStrip();
    updateStats();

    closeSettingsModal();
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
    if (!capability?.canReveal) revealButton.title = capability?.reason || readerText('這個來源沒有可開啟的檔案位置');
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
    canShowFileLocation,
    createBuiltInDemoComics,
    builtInDemoReaderData,
    getCoverUrl,
    getDirectoryItems,
    isBuiltInDemoComic,
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
    renderPages,
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
    findAdjacentComicInFolder,
    requestWebtoonAdjacentComic,
    jumpToPage,
    anchorWebtoonPage,
    cancelWebtoonAnchor,
    handleReaderPointerClick,
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
