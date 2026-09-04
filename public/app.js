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
let lastGridRenderSignature = '';
let lastContinueRenderSignature = '';
let lastInspectorRenderSignature = '';

function scheduleLibraryRefresh(delay = 80) {
  clearTimeout(libraryRefreshTimer);
  libraryRefreshTimer = window.setTimeout(() => {
    libraryRefreshTimer = null;
    fetchLibrary({ background: true });
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
  if (String(comicId) === 'builtin:all-ages-demo-book') return 'assets/demo/moonlit-archive/cover.jpg';
  const encodedId = encodeURIComponent(String(comicId));
  if (eAPI && eAPI.isElectron) {
    return `gai://cover/${encodedId}`;
  }
  return `/api/cover?id=${encodedId}`;
}

const READER_PRELOAD_RADIUS = 10;
const MAX_PRELOADED_IMAGES = READER_PRELOAD_RADIUS * 2;
const READER_CACHE_UPDATE_DELAY_MS = 120;
const WEBTOON_EAGER_IMAGES = 3;
const BUILT_IN_DEMO_SOURCE_ID = 'builtin:all-ages-demo';
const BUILT_IN_DEMO_ID = 'builtin:all-ages-demo-book';
const BUILT_IN_DEMO_COVER_PATH = 'assets/demo/moonlit-archive/cover.jpg';

// 這些圖片是隨 app 打包的原創全年齡示範素材；使用純靜態相對 URL，
// 不經正式 comic protocol，也不會成為 SQLite 的 library authority。
const BUILT_IN_DEMO_PAGES = [
  'assets/demo/moonlit-archive/cover.jpg',
  'assets/demo/moonlit-archive/page-01.jpg',
  'assets/demo/moonlit-archive/page-02.jpg'
];

function isBuiltInDemoComic(comic) {
  return Boolean(comic?.isBuiltInDemo || comic?.sourceId === BUILT_IN_DEMO_SOURCE_ID);
}

function createBuiltInDemoComic() {
  return {
    id: BUILT_IN_DEMO_ID,
    type: 'built-in-demo',
    // 單層相對路徑讓目錄折疊器在書架根目錄直接渲染示範卡。
    relativePath: 'all-ages-demo',
    ext: '.demo',
    title: '小小書房：閱讀器導覽',
    series: '內建示範',
    updatedAt: '2099-01-01T00:00:00.000Z',
    pageCount: BUILT_IN_DEMO_PAGES.length,
    progress: { currentPage: 0, totalPages: BUILT_IN_DEMO_PAGES.length, percent: 0, updatedAt: null },
    sourceId: BUILT_IN_DEMO_SOURCE_ID,
    isBuiltInDemo: true
  };
}

function builtInDemoReaderData(comic) {
  return {
    ...comic,
    pages: [...BUILT_IN_DEMO_PAGES],
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
  scanStatusPollTimer: null,
  renderGeneration: 0,
  sharpenLevel: 0, // 0=關閉, 1=輕度, 2=中度, 3=強度
  cropEdges: localStorage.getItem('readerCropEdges') === 'true',
  brightness: Number(localStorage.getItem('readerBrightness')) || 100,
  aiAutoExplain: false,
  aiExplainCache: new Map(),
  aiExplainInFlight: false,
  aiExplainPendingPage: null,
  aiExplainTimer: null,
  loaderRefCount: 0, // 非阻塞狀態列是否正在顯示（0/1）
  loaderHideTimer: null,
  readerClosePromise: Promise.resolve(),
  readerOperation: 0,
  pendingComicId: null,
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
};

const THEME_STORAGE_KEY = 'gai:theme';
const THEMES = new Set(['midnight', 'sakura', 'ink', 'aurora']);
const LIBRARY_CARD_SIZE_STORAGE_KEY = 'gai:libraryCardSize';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'gai:sidebarCollapsed';
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
  comicGrid: document.getElementById('comic-grid'),
  emptyState: document.getElementById('empty-state'),
  searchInput: document.getElementById('search-input'),
  clearSearchBtn: document.getElementById('clear-search-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  libraryPathLabel: document.getElementById('library-path-label'),
  continueStrip: document.getElementById('continue-strip'),
  comicInspector: document.getElementById('comic-inspector'),
  libraryDemoNotice: document.getElementById('library-demo-notice'),
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
  btnModeDouble: document.getElementById('btn-mode-double'),
  btnModeDoubleRtl: document.getElementById('btn-mode-double-rtl'),
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
  librarySourceAlert: document.getElementById('library-source-alert'),
  librarySourceAlertMessage: document.getElementById('library-source-alert-message'),
  librarySourceSettingsBtn: document.getElementById('library-source-settings-btn'),
  
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
  applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true', { persist: false });
  initApp();
  bindEvents();
});

function applySidebarCollapsed(collapsed, { persist = true } = {}) {
  const isCollapsed = Boolean(collapsed);
  elements.mainLayout?.classList.toggle('sidebar-collapsed', isCollapsed);
  if (elements.librarySidebar) {
    const supportsNativeInert = 'inert' in elements.librarySidebar;
    if (supportsNativeInert) elements.librarySidebar.inert = isCollapsed;
    // iOS 14 的 WKWebView 尚無原生 inert；hidden fallback 同時移除焦點與可見內容。
    elements.librarySidebar.hidden = !supportsNativeInert && isCollapsed;
    elements.librarySidebar.setAttribute('aria-hidden', String(isCollapsed));
  }
  if (elements.sidebarCollapseBtn) {
    elements.sidebarCollapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
    const label = isCollapsed ? '展開漫畫系列側欄' : '收合漫畫系列側欄';
    elements.sidebarCollapseBtn.setAttribute('aria-label', label);
    elements.sidebarCollapseBtn.title = label;
    const icon = elements.sidebarCollapseBtn.querySelector('i');
    if (icon) icon.className = `fa-solid fa-chevron-${isCollapsed ? 'right' : 'left'}`;
  }
  if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
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
  if (size <= 130) return '緊湊';
  if (size >= 210) return '特大';
  if (size >= 180) return '放大';
  return '標準';
}

function applyLibraryCardSize(value, { persist = true } = {}) {
  const size = normalizeLibraryCardSize(value);
  document.documentElement.style.setProperty('--library-card-min-width', `${size}px`);
  if (elements.libraryCardSize) {
    elements.libraryCardSize.value = String(size);
    elements.libraryCardSize.setAttribute('aria-valuetext', `${libraryCardSizeLabel(size)}，${size} 像素`);
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
    if (tip) tip.innerHTML = '小提示：點一下查看詳情，再點同一本開始閱讀；也可以用上方「匯入圖片」加入內容。✨';
    const emptyTip = document.querySelector('#empty-state p');
    if (emptyTip) emptyTip.innerHTML = '請點擊上方的「匯入圖片」按鈕，或透過檔案 App 匯入漫畫！✨';
  }

  // 開始第一波撈取
  showLoader('天才少女正在為主人召喚漫畫中...', { progress: null, detail: '請稍候...' });
  if (eAPI && eAPI.getFavorites) {
    try { state.favorites = await eAPI.getFavorites(); } catch(e) {}
  }
  const savedScanDir = localStorage.getItem('gai:scanDir');
  if (savedScanDir) {
    try {
      await eAPI.setConfig({ scanDir: savedScanDir });
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
        alert('部分外部資料夾權限無法恢復，請在設定中重新加入：\n' + error);
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
    stateWasUpdated: /狀態已更新|設定已更新|BOOKMARKS_UPDATED|PARTIAL_SUCCESS/i.test(message)
  };
}

function isIOSLibraryDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function addIOSLibrarySource() {
  if (!window.electronAPI?.openExternalFolder) {
    throw new Error('本環境不支援 iOS 外部資料夾授權');
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
      alert('這個資料夾已經加入了。');
      return;
    }

    bookmarks.push({ bookmark: result.bookmark, name: result.name });
    desiredBookmarks = bookmarks;
    await window.electronAPI.setBookmarks(bookmarks);
    localStorage.setItem('gai:externalBookmarks', JSON.stringify(bookmarks));
    renderExternalBookmarks();
    if (elements.scanDirStatus) elements.scanDirStatus.textContent = `已加入：${result.name}，正在重新掃描。`;
    showLoader('正在掃描新加入的漫畫來源...', { progress: null, detail: '找到的漫畫會立即出現在書架' });
    startScanStatusPolling();
    scheduleLibraryRefresh(0);
  } catch (error) {
    console.error('加入 iOS 外部資料夾失敗：', error);
    const { message, stateWasUpdated } = classifyBookmarkUpdateError(error);
    if (stateWasUpdated && desiredBookmarks) {
      localStorage.setItem('gai:externalBookmarks', JSON.stringify(desiredBookmarks));
      renderExternalBookmarks();
      if (elements.scanDirStatus) {
        elements.scanDirStatus.textContent = `外部資料夾已更新，但舊資料夾權限釋放部分失敗：${message}`;
      }
      showLoader('正在掃描新加入的漫畫來源...', { progress: null, detail: '找到的漫畫會立即出現在書架' });
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
    if (elements.scanDirStatus) elements.scanDirStatus.textContent = '已取消選擇，漫畫來源沒有變更。';
    return;
  }

  elements.scanDirInput.value = selectedPath;
  if (elements.scanDirStatus) elements.scanDirStatus.textContent = `已選擇：${selectedPath}`;
  await saveSettingsPath(selectedPath);
}

async function chooseLibrarySource() {
  if (!elements.librarySourceBtn) return;
  elements.librarySourceBtn.disabled = true;
  elements.librarySourceBtn.setAttribute('aria-busy', 'true');
  if (elements.scanDirStatus) elements.scanDirStatus.textContent = '正在開啟系統檔案選擇器…';

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
      elements.scanDirStatus.textContent = `無法加入漫畫來源：${error?.message || error}`;
    }
  } finally {
    elements.librarySourceBtn.disabled = false;
    elements.librarySourceBtn.removeAttribute('aria-busy');
  }
}

function bindEvents() {
  elements.sidebarCollapseBtn?.addEventListener('click', () => {
    applySidebarCollapsed(!elements.mainLayout?.classList.contains('sidebar-collapsed'));
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
    showLoader('正在重新掃描資料夾，主人請稍候喔...', { progress: null, detail: '正在更新漫畫庫...' });
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
      
      showLoader(`正在從相簿匯入 ${files.length} 張圖片...`, { progress: 0, detail: '請勿關閉 App' });
      
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const arrayBuffer = await file.arrayBuffer();
          // 生成一個帶有時間戳的檔名，避免重複
          const filename = `${Date.now()}_${i}_${file.name || 'image.jpg'}`;
          await eAPI.saveImportedPhoto(filename, Array.from(new Uint8Array(arrayBuffer)));
          
          showLoader(`正在從相簿匯入 ${files.length} 張圖片...`, { progress: ((i + 1) / files.length) * 100, detail: `正在匯入: ${file.name}` });
        }
        
        // 匯入完成後重新掃描
        showLoader('圖片匯入完成！正在整理書架...', { progress: null, detail: '馬上就好囉...' });
        if (eAPI.scanLibrary) {
          try { await eAPI.scanLibrary(); } catch(err) { console.error(err); }
        }
        await fetchLibrary();
      } catch (err) {
        alert('匯入失敗：' + err);
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
  elements.btnModeDouble.addEventListener('click', () => setReadingMode('double'));
  elements.btnModeDoubleRtl.addEventListener('click', () => setReadingMode('double-rtl'));
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
    const y = e.clientY;
    const h = window.innerHeight;
    if (y < h * 0.12 || y > h * 0.88) {
      triggerControlsActive();
    }
  });

  let touchStartX = 0;
  let touchStartY = 0;
  let readerTouchMoved = false;
  elements.readerViewport.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
    readerTouchMoved = false;
  }, { passive: true });
  elements.readerViewport.addEventListener('touchmove', (e) => {
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;
    if (Math.hypot(dx, dy) > 12) readerTouchMoved = true;
  }, { passive: true });
  elements.readerViewport.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      if (dx < 0) goNextByReadingDirection(); // 左滑下一頁
      else goPreviousByReadingDirection(); // 右滑上一頁
    }
    window.setTimeout(() => { readerTouchMoved = false; }, 0);
  }, { passive: true });

  elements.readerViewport.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch' && readerTouchMoved) return;
    handleReaderPointerClick(event);
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
  elements.librarySourceSettingsBtn?.addEventListener('click', openSettingsForRecovery);
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
      elements.scanDirStatus.textContent = '請先輸入或選擇漫畫資料夾。';
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
        elements.scanDirStatus.textContent = '可選擇「檔案」中的本機、iCloud 或已連線 NAS 資料夾。';
      }
    }

    // 監聽漫畫庫目錄檔案異動並自動重新整理
    if (window.electronAPI.onLibraryChanged) {
      window.electronAPI.onLibraryChanged(() => {
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
        showLoader('正在從 NAS 雲端下載漫畫...', { progress: null, detail: '網路傳輸中，請保持連線...' });
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
  if (!pathValue) return '本機書庫';
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
    state.filteredComics.filter(comic => !comic.isDirectory).forEach(comic => state.organizeSelection.add(comic.id));
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
    elements.tagLibraryList.innerHTML = '<p class="metadata-warning">標籤庫需要最新版 Tauri 後端。</p>';
    return;
  }
  elements.tagLibraryList.setAttribute('aria-busy', 'true');
  elements.tagLibraryList.innerHTML = '<p class="metadata-loading">正在整理標籤庫…</p>';
  try {
    const result = await eAPI.listTagInventory({ query: elements.tagLibrarySearch?.value.trim() || '', offset: 0, limit: 200 });
    state.tagInventoryItems = result.items || [];
    renderTagLibrary(result.total || 0);
  } catch (error) {
    elements.tagLibraryList.innerHTML = `<p class="metadata-warning">標籤庫載入失敗：${escapeHtml(error?.message || String(error))}</p>`;
  } finally {
    elements.tagLibraryList.setAttribute('aria-busy', 'false');
  }
}

function renderTagLibrary(total = state.tagInventoryItems.length) {
  if (!elements.tagLibraryList) return;
  if (!state.tagInventoryItems.length) {
    elements.tagLibraryList.innerHTML = '<p class="metadata-loading">沒有符合的標籤。可在「批次編輯」輸入自訂標籤後建立。</p>';
    if (elements.tagLibraryEditor) elements.tagLibraryEditor.hidden = true;
    return;
  }
  elements.tagLibraryList.innerHTML = state.tagInventoryItems.map(tag => `
    <button type="button" class="tag-library-item" role="option" aria-selected="${tag.id === state.selectedTagId}" data-tag-id="${tag.id}" data-tag-color="${tagColorKey(tag)}" data-disabled="${tag.disabled}">
      <strong>${tag.pinned ? '<i class="fa-solid fa-thumbtack" aria-label="已置頂"></i> ' : ''}${escapeHtml(tag.displayValue)}</strong>
      <span class="tag-count">${tag.workCount}</span>
      <small>${escapeHtml(tag.namespace)} · 使用 ${tag.usageCount} 次${tag.disabled ? ' · 已停用' : ''}</small>
      <small>作品</small>
    </button>`).join('');
  elements.tagLibraryList.querySelectorAll('[data-tag-id]').forEach(button => {
    button.addEventListener('click', () => selectTag(Number(button.dataset.tagId)));
  });
  if (total > state.tagInventoryItems.length) {
    elements.tagLibraryList.insertAdjacentHTML('beforeend', `<p class="metadata-loading">顯示前 ${state.tagInventoryItems.length}／${total} 個；用搜尋縮小範圍。</p>`);
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
  elements.tagEditorCount.textContent = `${tag.workCount} 部作品使用`;
  elements.tagEditorDisplay.value = tag.displayValue;
  elements.tagEditorColor.value = tag.colorKey || '';
  elements.tagEditorPinned.checked = Boolean(tag.pinned);
  elements.tagEditorDisable.textContent = tag.disabled ? '恢復標籤' : '停用標籤';
  elements.tagEditorUndo.disabled = !state.lastTagUndoToken;
  elements.tagEditorTarget.innerHTML = '<option value="">選擇目標標籤</option>' + state.tagInventoryItems
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
    updateOrganizerUi(`已更新 ${tag.namespace}:${displayValue || tag.displayValue} 的名稱與外觀。`);
    await refreshTagLibrary();
    const comic = state.comics.find(item => item.id === state.selectedComicId);
    if (comic) loadInspectorMetadata(comic);
  } catch (error) {
    updateOrganizerUi(`標籤更新失敗：${error?.message || error}`);
  }
}

async function mergeSelectedTag() {
  const source = state.tagInventoryItems.find(item => item.id === state.selectedTagId);
  const targetId = Number(elements.tagEditorTarget?.value || 0);
  if (!source || !targetId) return updateOrganizerUi('請先選擇合併目標。');
  const target = state.tagInventoryItems.find(item => item.id === targetId);
  if (!window.confirm(`合併預覽\n\n${source.namespace}:${source.displayValue}（${source.workCount} 部作品）\n→ ${target?.namespace || source.namespace}:${target?.displayValue || '目標標籤'}\n\n原始來源資料不會刪除，完成後可撤銷。`)) return;
  try {
    const result = await eAPI.mergeTags(source.id, targetId);
    state.lastTagUndoToken = result.undoToken;
    state.selectedTagId = targetId;
    updateOrganizerUi(`已合併標籤，${result.affectedWorks} 部作品會顯示目標標籤；原始來源證據仍保留。`);
    await refreshTagLibrary();
  } catch (error) {
    updateOrganizerUi(`標籤合併失敗：${error?.message || error}`);
  }
}

async function toggleSelectedTagDisabled() {
  const tag = state.tagInventoryItems.find(item => item.id === state.selectedTagId);
  if (!tag) return;
  try {
    const result = await eAPI.setTagDisabled(tag.id, !tag.disabled);
    state.lastTagUndoToken = result.undoToken;
    updateOrganizerUi(`${tag.disabled ? '已恢復' : '已停用'} ${tag.namespace}:${tag.displayValue}；可撤銷本次操作。`);
    await refreshTagLibrary();
  } catch (error) {
    updateOrganizerUi(`標籤狀態更新失敗：${error?.message || error}`);
  }
}

async function undoLastTagOperation() {
  if (!state.lastTagUndoToken) return;
  try {
    await eAPI.undoTagOperation(state.lastTagUndoToken);
    state.lastTagUndoToken = null;
    updateOrganizerUi('已撤銷上次標籤庫操作。');
    await refreshTagLibrary();
  } catch (error) {
    updateOrganizerUi(`標籤撤銷失敗：${error?.message || error}`);
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
  if (elements.organizeCount) elements.organizeCount.textContent = `已選 ${count} 本`;
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
    updateOrganizerUi('請至少輸入一個欄位或標籤。');
    return;
  }
  setOrganizerBusy(true, `正在更新 ${comicIds.length} 本漫畫…`);
  try {
    const result = await eAPI.applyBatchMetadata(request);
    state.lastUndoToken = result.undoToken;
    if (series) state.comics.filter(comic => state.organizeSelection.has(comic.id)).forEach(comic => { comic.series = series; });
    updateOrganizerUi(`已更新 ${result.updated} 本；可撤銷本次操作。`);
    refreshTagLibrary();
    await refreshCatalogSearch(elements.searchInput.value.trim());
    if (state.selectedComicId) {
      const comic = state.comics.find(item => item.id === state.selectedComicId);
      if (comic) renderComicInspector(comic, { keepSelection: true });
    }

  } catch (error) {
    updateOrganizerUi(`更新失敗：${error?.message || error}`);
  } finally {
    setOrganizerBusy(false);
  }
}

async function applyFolderTagRule() {
  const tag = parseOrganizerTag();
  if (!tag) return updateOrganizerUi('請先輸入要繼承的標籤。');
  const sample = state.comics.find(comic => state.organizeSelection.has(comic.id)) || state.filteredComics.find(comic => !comic.isDirectory);
  if (!sample) return updateOrganizerUi('目前資料夾沒有可建立規則的漫畫。');
  setOrganizerBusy(true, '正在建立資料夾繼承規則…');
  try {
    await eAPI.upsertFolderTagRule({ id: null, sourceId: sample.sourceId || 'local', folderPath: state.currentPath, tag, enabled: true });
    updateOrganizerUi(`已讓「${state.currentPath || '書庫根目錄'}」繼承 ${tag.namespace}:${tag.value}。`);
  } catch (error) {
    updateOrganizerUi(`規則建立失敗：${error?.message || error}`);
  } finally {
    setOrganizerBusy(false);
  }
}

async function reimportSelectedMetadata() {
  const comicIds = [...state.organizeSelection];
  if (!comicIds.length) return;
  setOrganizerBusy(true, '正在重新讀取 metadata…');
  try {
    const result = await eAPI.reimportMetadata({ comicIds });
    updateOrganizerUi(`已重新匯入 ${result.imported} 本，產生 ${result.diagnostics} 則診斷。`);
    const comic = state.comics.find(item => item.id === state.selectedComicId);
    if (comic) renderComicInspector(comic, { keepSelection: true });
  } catch (error) {
    updateOrganizerUi(`重新匯入失敗：${error?.message || error}`);
  } finally {
    setOrganizerBusy(false);
  }
}

async function undoOrganizerBatch() {
  if (!state.lastUndoToken) return;
  setOrganizerBusy(true, '正在撤銷上次批次操作…');
  try {
    const count = await eAPI.undoBatchMetadata(state.lastUndoToken);
    state.lastUndoToken = null;
    updateOrganizerUi(`已還原 ${count} 本漫畫。`);
    const comic = state.comics.find(item => item.id === state.selectedComicId);
    if (comic) renderComicInspector(comic, { keepSelection: true });
  } catch (error) {
    updateOrganizerUi(`撤銷失敗：${error?.message || error}`);
  } finally {
    setOrganizerBusy(false);
  }
}

async function saveOrganizerAlias() {
  const alias = elements.organizeAlias?.value.trim();
  const canonicalValue = elements.organizeCanonical?.value.trim();
  if (!alias || !canonicalValue) return updateOrganizerUi('別名與標準標籤都要填。');
  if (!eAPI?.upsertTagAlias) return updateOrganizerUi('標籤別名需要在 Tauri App 中使用。');
  try {
    await eAPI.upsertTagAlias({ namespace: 'general', alias, canonicalValue });
    elements.organizeAlias.value = '';
    elements.organizeCanonical.value = '';
    updateOrganizerUi(`搜尋別名「${alias}」現在會對應 general:${canonicalValue}，原始 tag 未改寫。`);
  } catch (error) {
    updateOrganizerUi(`別名儲存失敗：${error?.message || error}`);
  }
}

async function showOrganizerInbox() {
  if (!eAPI?.listOrganizerInbox || !elements.organizeInsightResults) return;
  elements.organizeInsightResults.textContent = '正在讀取低信心項目…';
  try {
    const items = await eAPI.listOrganizerInbox(100);
    elements.organizeInsightResults.innerHTML = items.length ? items.map(item => `
      <article><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.parserId || 'unknown')} · 信心 ${item.confidence ?? '—'}</span><small>${escapeHtml(item.reason)} · ${escapeHtml(item.sourcePath)}</small></article>`).join('') : '<p>目前沒有低信心項目。</p>';
  } catch (error) {
    elements.organizeInsightResults.textContent = `Inbox 載入失敗：${error?.message || error}`;
  }
}

async function showDuplicateCandidates() {
  if (!eAPI?.listDuplicateCandidates || !elements.organizeInsightResults) return;
  elements.organizeInsightResults.textContent = '正在比對重複候選…';
  try {
    const items = await eAPI.listDuplicateCandidates(100);
    elements.organizeInsightResults.innerHTML = items.length ? items.map(item => `
      <article><strong>${item.comicIds.length} 本候選</strong><span>指紋 ${escapeHtml(item.fingerprint.slice(0, 12))}…</span><small>${item.locations.map(escapeHtml).join('、')}</small></article>`).join('') : '<p>目前沒有重複候選；系統不會自動合併或刪檔。</p>';
  } catch (error) {
    elements.organizeInsightResults.textContent = `重複候選載入失敗：${error?.message || error}`;
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
let coverObserver = null;
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

function renderLibrarySourceStatus(config = {}) {
  if (!elements.librarySourceAlert) return;
  const hasOnlineLibrary = state.comics.some(comic => !isBuiltInDemoComic(comic) && !isComicOffline(comic));
  const unavailable = config.available === false && !hasOnlineLibrary;
  elements.librarySourceAlert.hidden = !unavailable;
  if (unavailable && elements.librarySourceAlertMessage) {
    const path = config.scanDir || '原本的漫畫目錄';
    elements.librarySourceAlertMessage.textContent = `${path} 目前無法存取；收藏、標籤與閱讀進度都已安全保留。`;
  }
}

function renderBuiltInDemoStatus() {
  if (!elements.libraryDemoNotice) return;
  elements.libraryDemoNotice.hidden = !state.comics.some(isBuiltInDemoComic);
}

function showLibrarySourceRecovery(message) {
  if (!elements.librarySourceAlert) {
    alert(`漫畫來源無法存取：${message}`);
    return;
  }
  elements.librarySourceAlert.hidden = false;
  if (elements.librarySourceAlertMessage) elements.librarySourceAlertMessage.textContent = message;
  elements.librarySourceAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
  elements.librarySourceSettingsBtn?.focus({ preventScroll: true });
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
    showLoader('正在背景整理漫畫庫...', { progress: null, detail: '仍可繼續使用目前畫面' });
    startScanStatusPolling();
  }
  let libraryConfig = null;
  try {
    if (!silentRefresh) setLoaderProgress(null, '正在讀取漫畫庫索引...');
    state.comics = await eAPI.getLibrary();
    if (eAPI && eAPI.getConfig) {
      try {
        libraryConfig = await eAPI.getConfig();
      } catch (error) {
        console.warn('無法讀取漫畫庫設定：', error);
      }
    }

    // 示範卡只存在於前端衍生狀態：沒有掃描目錄且正式來源為空時才顯示。
    // 絕不送入 Tauri catalog、收藏 API 或閱讀進度 API。
    // iOS 首次啟動會把空的 Documents 目錄當作暫時預設值；只有前端曾明確
    // 保存過掃描路徑，才把它視為使用者正式書庫，避免擋住首次示範。
    const hasConfiguredSource = Boolean(libraryConfig?.scanDir)
      && Boolean(localStorage.getItem('gai:scanDir'));
    if (state.comics.length === 0 && !hasConfiguredSource) {
      state.comics = [createBuiltInDemoComic()];
    }
    if (!silentRefresh) setLoaderProgress(70, `已載入 ${state.comics.filter(comic => !isBuiltInDemoComic(comic)).length} 本正式漫畫`);
    if (eAPI && eAPI.getFavorites) {
      try { state.favorites = await eAPI.getFavorites(); } catch(e) {}
    }
    if (eAPI && eAPI.getConfig && elements.libraryPathLabel) {
      try {
        const config = libraryConfig || await eAPI.getConfig();
        elements.libraryPathLabel.textContent = shortPathLabel(config.scanDir);
        elements.libraryPathLabel.title = config.scanDir;
        renderLibrarySourceStatus(config);
      } catch(e) {}
    }
    renderBuiltInDemoStatus();
    filterAndRenderGrid({ skipUnchanged: silentRefresh, background: silentRefresh });
    renderSidebar();
    renderContinueStrip();
    updateStats();
    if (eAPI?.getScanStatus) {
      try {
        latestScanStatus = await eAPI.getScanStatus();
        // App 啟動時 Rust 的背景工作可能比第一輪 UI 讀取晚一拍；
        // 空書架時短暫等候掃描狀態就緒，避免把「尚未開始」誤當成「已完成」。
        for (let attempt = 0; !latestScanStatus?.isScanning && state.comics.length === 0 && attempt < 6; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          latestScanStatus = await eAPI.getScanStatus();
        }
        scanStillRunning = Boolean(latestScanStatus?.isScanning);
      } catch(e) {}
    }
    if (scanStillRunning && !silentRefresh) {
      updateLoaderScanProgress(latestScanStatus);
    } else if (!silentRefresh) {
      setLoaderProgress(100, '書架整理完成');
    }
  } catch (e) {
    failed = true;
    console.error('無法獲取書架清單：', e);
    if (!silentRefresh) {
      showLoader('漫畫庫讀取失敗', {
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
    const s = c.series || '未分類';
    seriesMap.set(s, (seriesMap.get(s) || 0) + 1);
  });

  const seriesNames = Array.from(seriesMap.keys())
    .filter(seriesName => seriesName !== '.')
    .sort();

  if (elements.seriesFilterSelect) {
    const options = [new Option(`全部系列（${state.comics.length}）`, 'all')];
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
      ['all', '全部系列', state.comics.length],
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
      configureInteractiveItem(item, `顯示系列：${label}`, () => selectSeries(seriesName));
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
        <span>開始閱讀後，最近進度會出現在這裡。</span>
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
          <small>${progress.hasProgress ? `${progress.percent}% · 第 ${progress.currentPage + 1} 頁` : '已收藏'}</small>
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
      <h3>選一本漫畫</h3>
      <p>封面、進度、標籤與快捷操作會顯示在這裡。</p>
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
}

function renderComicInspector(comic, options = {}) {
  if (!elements.comicInspector || !comic) return;
  if (!options.keepSelection) state.selectedComicId = comic.id;
  const renderSignature = inspectorRenderSignature(comic);
  if (options.skipUnchanged && renderSignature === lastInspectorRenderSignature) return;
  lastInspectorRenderSignature = renderSignature;

  const isDirectory = Boolean(comic.isDirectory);
  const builtInDemo = isBuiltInDemoComic(comic);
  const sourceOffline = isComicOffline(comic);
  const progress = getProgressInfo(comic);
  const format = builtInDemo ? '內建示範 · 全年齡' : isDirectory ? '目錄' : (String(comic.type || '').includes('archive') ? 'CBZ/ZIP' : '圖片資料夾');
  const favorite = !isDirectory && !builtInDemo && state.favorites.includes(comic.id);
  const coverId = comic.coverComicId || comic.id;

  elements.comicInspector.innerHTML = `
    ${builtInDemo ? `
      <div class="inspector-cover builtin-demo-cover">
        <img src="${BUILT_IN_DEMO_COVER_PATH}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}">
        <div class="inspector-shine"></div>
      </div>
    ` : `
      <div class="inspector-cover">
        <img src="${escapeHtml(getCoverUrl(coverId))}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}" onerror="this.style.display='none';">
        <div class="inspector-shine"></div>
      </div>
    `}
    <div class="inspector-body">
      ${builtInDemo ? '' : `<button class="organize-toggle inspector-organize-action ${state.organizeMode ? 'active' : ''}" type="button" data-inspector-action="organize" aria-pressed="${state.organizeMode}" title="批次整理 TAG 與書籍資料">
        <i class="fa-solid fa-tags" aria-hidden="true"></i>
        TAG 整理
      </button>`}
      <span class="section-kicker">${format}</span>
      <h3 title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</h3>
      <div class="inspector-tags">
        <span>${escapeHtml(comic.series || '未分類')}</span>
        <span>${progress.totalPages || comic.comicsCount || '---'} 頁</span>
        <span>${builtInDemo ? '不寫入收藏' : sourceOffline ? '來源離線' : progress.isFinished ? '已看完' : progress.hasProgress ? '閱讀中' : '未讀'}</span>
      </div>
      <div class="inspector-progress">
        <div>
          <strong>${progress.percent}%</strong>
          <small>${progress.hasProgress ? `第 ${progress.currentPage + 1} 頁` : '尚未開始'}</small>
        </div>
        <span><span style="width: ${progress.percent}%"></span></span>
      </div>
      <div class="inspector-actions">
        <button class="inspector-primary" data-inspector-action="open">
          <i class="fa-solid ${sourceOffline || isDirectory ? 'fa-folder-open' : 'fa-book-open-reader'}"></i>
          ${builtInDemo ? '開啟全年齡示範' : sourceOffline ? '檢查漫畫目錄' : isDirectory ? '打開目錄' : '開始閱讀'}
        </button>
        ${isDirectory || builtInDemo ? '' : `
          <button class="inspector-icon ${favorite ? 'active' : ''}" data-inspector-action="favorite" title="${favorite ? '取消收藏' : '加入收藏'}" aria-label="${favorite ? '取消收藏' : '加入收藏'}">
            <i class="${favorite ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
          </button>
        `}
      </div>
      ${isDirectory || builtInDemo ? '' : `
        <button class="inspector-file-toggle" type="button" data-inspector-action="files" aria-expanded="false">
          <i class="fa-solid fa-folder-tree" aria-hidden="true"></i>
          <span><strong>檔案管理</strong><small>開啟位置、改名、移動或可復原移除</small></span>
        </button>
        <section class="inspector-file-panel" aria-label="漫畫檔案管理" hidden>
          <div class="inspector-file-buttons">
            <button type="button" data-file-action="reveal"><i class="fa-solid fa-folder-open"></i> 開啟位置</button>
            <button type="button" data-file-action="rename"><i class="fa-solid fa-pen"></i> 改名</button>
            <button type="button" data-file-action="move"><i class="fa-solid fa-folder-tree"></i> 移動</button>
            <button type="button" data-file-action="trash" class="danger"><i class="fa-solid fa-box-archive"></i> 移到隔離區</button>
            <button type="button" data-file-action="undo" disabled><i class="fa-solid fa-rotate-left"></i> 撤銷上次操作</button>
          </div>
          <p class="inspector-file-status" role="status" aria-live="polite">正在檢查來源能力…</p>
        </section>
      `}
      ${isDirectory || builtInDemo ? '' : `
        <button class="inspector-ai-action" type="button" data-inspector-action="ai-suggest" aria-expanded="false">
          <i class="fa-solid fa-tags" aria-hidden="true"></i>
          <span><strong>AI 建議摘要與標籤</strong><small>讀取封面／第一頁，只產生待確認建議</small></span>
        </button>
        <div class="inspector-ai-results" role="status" aria-live="polite" hidden></div>
      `}
      ${isDirectory || builtInDemo ? '' : `<section class="metadata-section" id="inspector-metadata"><p class="metadata-loading">正在讀取 SQLite metadata…</p></section>`}
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
  if (!isDirectory && !builtInDemo) loadInspectorMetadata(comic);
}

async function prepareInspectorFilePanel(comic, panel) {
  const status = panel.querySelector('.inspector-file-status');
  const buttons = Object.fromEntries([...panel.querySelectorAll('[data-file-action]')].map(button => [button.dataset.fileAction, button]));
  const setBusy = busy => Object.values(buttons).forEach(button => { if (button.dataset.fileAction !== 'undo') button.disabled = busy; });
  if (!eAPI?.getFileCapability) {
    status.textContent = '檔案管理需要最新版 Tauri App；網頁預覽不會修改檔案。';
    setBusy(true);
    if (buttons.undo) buttons.undo.disabled = true;
    return;
  }
  try {
    const capability = await eAPI.getFileCapability(comic.id);
    buttons.reveal.disabled = !capability.canReveal;
    buttons.rename.disabled = !capability.canRename;
    buttons.move.disabled = !capability.canMove;
    buttons.trash.disabled = !capability.canTrash;
    buttons.undo.disabled = !state.lastFileUndoToken;
    panel.dataset.expectedFingerprint = capability.expectedFingerprint || '';
    status.textContent = capability.reason || `${capability.sourceKind === 'smb' ? 'NAS' : '本機'}來源可安全修改；移除會先進隔離區。`;
    for (const [action, button] of Object.entries(buttons)) {
      button.onclick = () => runInspectorFileAction(comic, panel, action);
    }
  } catch (error) {
    setBusy(true);
    if (buttons.undo) buttons.undo.disabled = true;
    status.textContent = `無法檢查檔案能力：${error?.message || error}`;
  }
}

async function runInspectorFileAction(comic, panel, action) {
  const status = panel.querySelector('.inspector-file-status');
  const buttons = [...panel.querySelectorAll('[data-file-action]')];
  try {
    if (action === 'reveal') {
      await eAPI.showItemInFolder(comic.id);
      status.textContent = '已在檔案管理器顯示漫畫位置。';
      return;
    }
    if (action === 'undo') {
      if (!state.lastFileUndoToken) return;
      buttons.forEach(button => { button.disabled = true; });
      await eAPI.undoComicFileOperation(state.lastFileUndoToken);
      state.lastFileUndoToken = null;
      status.textContent = '已還原上次檔案操作。';
      await fetchLibrary();
      return;
    }
    let destinationRelativePath = null;
    if (action === 'rename') {
      const currentName = String(comic.relativePath || comic.title).split('/').pop();
      destinationRelativePath = window.prompt('輸入新檔名（保留 .cbz／.zip 副檔名）：', currentName);
      if (!destinationRelativePath) return;
    } else if (action === 'move') {
      destinationRelativePath = window.prompt('輸入漫畫書庫內的目的相對路徑（包含檔名）：', comic.relativePath || '');
      if (!destinationRelativePath || destinationRelativePath === comic.relativePath) return;
    } else if (action === 'trash') {
      if (!window.confirm(`要將「${comic.title}」移到可復原隔離區嗎？\n不會直接永久刪除。`)) return;
    }
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = action === 'trash' ? '正在移到隔離區…' : '正在安全更新檔案位置…';
    const result = await eAPI.mutateComicFile({
      comicId: comic.id,
      action,
      destinationRelativePath,
      expectedFingerprint: panel.dataset.expectedFingerprint || null,
    });
    state.lastFileUndoToken = result.undoToken;
    status.textContent = `${action === 'trash' ? '已移到隔離區' : action === 'rename' ? '已改名' : '已移動'}；可在此撤銷。`;
    await fetchLibrary();
  } catch (error) {
    status.textContent = `檔案操作失敗：${error?.message || error}`;
  }
}

function formatReadingDirection(direction) {
  const labels = {
    ltr: '由左至右',
    rtl: '由右至左',
    vertical: '條漫直向',
  };
  const normalized = String(direction || '').trim().toLowerCase();
  return labels[normalized] || (normalized ? direction : '—');
}

async function loadInspectorMetadata(comic) {
  const target = elements.comicInspector?.querySelector('#inspector-metadata');
  if (!target || !eAPI?.getComicMetadata) {
    if (target) target.innerHTML = '<p class="metadata-loading">重新掃描後即可建立整理資料。</p>';
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
    const lock = field => (metadata.lockedFields || []).includes(field) ? ' <span class="metadata-lock" title="使用者覆寫">鎖定</span>' : '';
    const rows = [
      ['標題', metadata.title, 'title'],
      ['系列', metadata.series || '—', 'series'],
      ['作者', creators.join('、') || '—', 'creators'],
      ['語言', metadata.language || '—', 'language'],
      ['閱讀方向', formatReadingDirection(metadata.readingDirection), 'reading_direction'],
      ['來源', sourceNames.join('、') || '檔名推測', 'sources'],
      ['狀態', metadata.offline ? 'NAS／來源離線，資料已保留' : '來源在線', 'offline'],
    ];
    currentTarget.innerHTML = `
      <h4>整理資料</h4>
      <div class="metadata-tag-chips" aria-label="作品標籤">
        ${tags.length ? tags.map(tag => {
          const normalized = String(tag.value).normalize('NFKC').toLocaleLowerCase();
          const inventory = state.tagInventoryItems.find(item => item.namespace === tag.namespace && item.normalizedValue === normalized);
          return `<span class="metadata-tag-chip" data-tag-color="${tagColorKey(inventory || tag)}">${escapeHtml(tag.namespace)}:${escapeHtml(tag.value)}</span>`;
        }).join('') : '<span class="metadata-loading">尚無標籤</span>'}
      </div>
      <dl>${rows.map(([label, value, field]) => `<div class="metadata-row"><dt>${label}</dt><dd>${escapeHtml(String(value))}${lock(field)}</dd></div>`).join('')}</dl>
      ${(suggestions || []).length ? `
        <section class="metadata-suggestions" aria-labelledby="metadata-suggestions-title">
          <h5 id="metadata-suggestions-title">相關標籤建議</h5>
          <p>依收藏中的共同標籤提出；只有按下後才會套用。</p>
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
    if (currentTarget) currentTarget.innerHTML = `<p class="metadata-warning">metadata 尚未建立：${escapeHtml(error?.message || String(error))}</p>`;
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
      if (state.catalogSearchIds) return state.catalogSearchIds.has(comic.id);
      const matchTitle = comic.title.toLowerCase().includes(query);
      const matchPath = comic.relativePath.toLowerCase().includes(query);
      return matchTitle || matchPath;
    }).map(c => {
      const metadata = state.catalogSearchItems.get(c.id);
      return { ...c, title: metadata?.title || c.title, series: metadata?.series || c.series, metadataTags: metadata?.tags || [], offline: metadata?.offline || false, isDirectory: false };
    });
  }

  // 3. 一般目錄導航模式：對漫畫相對路徑相對當前層進行折疊與過濾
  baseFiltered.forEach(comic => {
    const rel = comic.relativePath;
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
  const directories = Array.from(itemsMap.values()).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  const files = filesList.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));

  return [...directories, ...files];
}

// 核心過濾與渲染漫畫書架
function filterAndRenderGrid(options = {}) {
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
    homeBtn.innerHTML = `<i class="fa-solid fa-house" style="font-size: 12px; color: var(--accent);"></i> 首頁`;
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
    elements.catalogLoadMore.textContent = `顯示更多漫畫（${visibleComics.length} / ${totalAvailable}）`;
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
  elements.comicGrid.classList.toggle('background-refresh', background);
  elements.comicGrid.innerHTML = '';

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
          <img class="comic-cover builtin-demo-cover-image" src="${BUILT_IN_DEMO_COVER_PATH}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}">
          <span class="comic-format-tag builtin-demo-format-tag"><i class="fa-solid fa-shield-heart" aria-hidden="true"></i> 內建示範</span>
        </div>
        <div class="comic-info">
          <div class="comic-title" title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</div>
          <div class="comic-meta">
            <span><i class="fa-solid fa-child-reaching" aria-hidden="true"></i> 全年齡</span>
            <span>${comic.pageCount} 頁</span>
          </div>
        </div>
      `;
      card.onclick = () => openReader(comic.id);
      configureInteractiveItem(card, `開啟內建全年齡示範：${comic.title}`, card.onclick);
      card.setAttribute('aria-pressed', 'false');
    } else if (comic.isDirectory) {
      // ==========================================
      // 📁 【虛擬資料夾卡片】 YACReader 級層級折疊！
      // ==========================================
      card.innerHTML = `
        <div class="comic-cover-wrapper">
          <img class="comic-cover lazy-cover"
               data-src="${escapeHtml(getCoverUrl(comic.coverComicId))}"
               loading="lazy"
               decoding="async"
               fetchpriority="low"
               alt="${escapeHtml(comic.title)}"
               onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
          <div class="comic-cover-placeholder" style="background: var(--bg-hover);">
            <div class="placeholder-icon" style="font-size: 40px;">📁</div>
            <div class="placeholder-text" style="margin-top: 10px;">${escapeHtml(comic.title)}</div>
          </div>
          <span class="comic-format-tag" style="background: var(--accent); color: white;"><i class="fa-solid fa-folder"></i> 目錄</span>
        </div>
        <div class="comic-info">
          <div class="comic-title" title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</div>
          <div class="comic-meta">
            <span style="color: var(--accent); font-weight: 500;"><i class="fa-solid fa-book-open"></i> ${comic.comicsCount} 本漫畫</span>
            <span>點擊點入</span>
          </div>
        </div>
      `;

      card.onclick = () => {
        state.currentPath = comic.relativePath;
        filterAndRenderGrid();
      };
      configureInteractiveItem(card, `開啟資料夾：${comic.title}`, card.onclick);
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
        badgeHtml = `<span class="comic-progress-badge finished"><i class="fa-solid fa-circle-check"></i> 已看完</span>`;
      } else if (hasProgress) {
        badgeHtml = `<span class="comic-progress-badge"><i class="fa-solid fa-hourglass-half"></i> ${percent}%</span>`;
      }

      // 是否已被收藏
      const isFavorite = state.favorites.includes(comic.id);

      card.innerHTML = `
        <div class="comic-cover-wrapper">
          ${state.organizeMode ? `<span class="organize-check" aria-hidden="true"><i class="fa-solid fa-check"></i></span>` : ''}
          <img class="comic-cover lazy-cover"
               data-src="${escapeHtml(getCoverUrl(comic.id))}"
               loading="lazy"
               decoding="async"
               fetchpriority="low"
               alt="${escapeHtml(comic.title)}"
               onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
          <div class="comic-cover-placeholder">
            <div class="placeholder-icon">📖</div>
            <div class="placeholder-text">${escapeHtml(comic.title)}</div>
          </div>
          
          <!-- 💖 收藏愛心按鈕 -->
          ${state.organizeMode ? '' : `<button class="favorite-toggle-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? '取消收藏' : '加入收藏'}">
            <i class="${isFavorite ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
          </button>`}

          <span class="comic-format-tag ${String(comic.type || '').includes('archive') ? 'tag-archive' : 'tag-folder'}" data-ext="${escapeHtml(comic.ext || 'folder')}">${sourceOffline ? '<i class="fa-solid fa-plug-circle-xmark"></i> 來源離線' : String(comic.type || '').includes('archive') ? escapeHtml((comic.ext || '.cbz').replace('.','').toUpperCase()) : '📁 目錄'}</span>
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
            <span>共 ${comic.pageCount > 0 ? comic.pageCount : '---'} 頁</span>
            <span>${hasProgress ? `第 ${comic.progress.currentPage + 1} 頁` : '未讀'}</span>
          </div>
        </div>
      `;

      card.onclick = () => activateGridComic(comic);
      configureInteractiveItem(card, state.organizeMode ? `選取漫畫：${comic.title}` : `選取漫畫：${comic.title}；再次操作即可開始閱讀`, card.onclick);
      card.setAttribute('aria-pressed', String(state.organizeMode ? state.organizeSelection.has(comic.id) : state.selectedComicId === comic.id));
      card.oncontextmenu = (e) => showGridContextMenu(e, comic);

      // 綁定收藏點擊事件
      const favBtn = card.querySelector('.favorite-toggle-btn');
      if (favBtn) {
        favBtn.setAttribute('aria-label', isFavorite ? '取消收藏' : '加入收藏');
        favBtn.setAttribute('aria-pressed', String(isFavorite));
        favBtn.onclick = async (e) => {
          e.stopPropagation(); // 阻止開啟閱讀器
          if (eAPI && eAPI.toggleFavorite) {
            try {
              state.favorites = await eAPI.toggleFavorite(comic.id);
              const isFav = state.favorites.includes(comic.id);
              
              // 姬米妮的流暢 UI 動態過渡 ✨
              favBtn.classList.toggle('active', isFav);
              favBtn.title = isFav ? '取消收藏' : '加入收藏';
              favBtn.setAttribute('aria-label', isFav ? '取消收藏' : '加入收藏');
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
    
    elements.comicGrid.appendChild(card);
  });

  // IntersectionObserver 懶載入封面 — 只有卡片進入視窗才發封面請求
  // 一次最多約 20 張並行，從根源防止 549 個 AdmZip 同時炸掉記憶體！
  coverObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          tuneImageForLowPriority(img);
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
        observer.unobserve(img);
      }
    });
  }, { rootMargin: '200px' }); // 提前 200px 預載，滾動更絲滑

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
  if (isComicOffline(shelfComic)) {
    showLibrarySourceRecovery('這本漫畫仍保留在書架，但原本的磁碟位置目前無法存取。請重新掛載 NAS，或選擇新的漫畫目錄。');
    return;
  }
  await state.readerClosePromise;
  if (state.currentComic) {
    await closeReader();
  }
  const operation = ++state.readerOperation;
  state.pendingComicId = comicId;
  showLoader('主人請稍候，天才少女正在載入漫畫分頁...', { progress: null, detail: '正在準備頁面清單...' });
  try {
    const data = isBuiltInDemoComic(shelfComic)
      ? builtInDemoReaderData(shelfComic)
      : await eAPI.openComic(comicId);
    if (operation !== state.readerOperation) return;

    if (!data.pages || data.pages.length === 0) {
      throw new Error('這本漫畫沒有可讀取的圖片頁面');
    }

    state.currentComic = data;
    state.pendingComicId = null;
    state.selectedComicId = comicId;
    state.currentComicPages = data.pages;
    state.currentComicIsDir = data.isDir || false;
    state.currentComicFilenames = data.filenames || [];
    state.aiExplainCache.clear();
    state.aiExplainPendingPage = null;
    
    state.currentPageIndex = (data.progress && data.progress.currentPage) ? data.progress.currentPage : 0;
    state.readerCacheWindowPage = state.currentPageIndex;
    state.readerCacheReadyPage = null;
    
    const lowerTitle = data.title.toLowerCase();
    if (lowerTitle.includes('webtoon') || lowerTitle.includes('條漫') || lowerTitle.includes('manga_scroll')) {
      state.readingMode = 'webtoon';
    } else {
      state.readingMode = 'single';
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
      alert('讀取漫畫資料失敗：' + message);
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
  const closingComic = state.currentComic;
  const closingId = closingComic ? closingComic.id : state.pendingComicId;
  state.currentComic = null;
  state.currentComicPages = [];
  state.pendingComicId = null;
  setAutoPageExplanation(false);
  clearTimeout(state.aiExplainTimer);
  state.aiExplainTimer = null;
  state.aiExplainPendingPage = null;
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
  fetchLibrary();
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
function renderPages() {
  if (!state.currentComic) return;

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
    elements.readerModeIndicator.textContent = '單頁模式';
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
    elements.pageCounter.textContent = `第 ${state.currentPageIndex + 1} / ${totalPages} 頁`;
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;
    
    // 非同步預載前後頁
    preloadNextPages();

  } else if (state.readingMode === 'double' || state.readingMode === 'double-rtl') {
    elements.readerOverlay.classList.add('mode-double');
    elements.readerModeIndicator.textContent = state.readingMode === 'double-rtl' ? '雙頁模式 (日)' : '雙頁模式';
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
      
      elements.pageCounter.textContent = `第 1 / ${totalPages} 頁 (封面)`;
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
      elements.pageCounter.textContent = `第 ${page1Index + 1}-${endRange} / ${totalPages} 頁`;
    }

    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;
    
    preloadNextPages();

  } else if (state.readingMode === 'webtoon') {
    elements.readerOverlay.classList.add('mode-webtoon');
    elements.readerModeIndicator.textContent = '條漫直捲';
    elements.prevZone.style.width = '0';
    elements.nextZone.style.width = '0';

    // 條漫模式一次載入所有圖片，使用瀏覽器原生 lazy loading 與極佳的後端傳輸
    state.currentComicPages.forEach((src, idx) => {
      const img = document.createElement('img');
      img.dataset.src = src; // 儲存真實路徑
      img.decoding = 'async';
      img.fetchPriority = idx < WEBTOON_EAGER_IMAGES ? 'auto' : 'low';
      if (idx < WEBTOON_EAGER_IMAGES) img.src = src; // 前幾張立刻載入，其餘滾動載入
      img.loading = 'lazy';
      img.className = 'webtoon-img';
      img.dataset.index = idx;
      applyImageEffects(img);
      elements.pagesContainer.appendChild(img);
    });

    // 監聽滾動事件，用來即時更新進度條與 Lazy Load 觸發
    elements.readerViewport.onscroll = handleWebtoonScroll;
    
    // 初始化進度
    elements.pageCounter.textContent = `第 1 / ${totalPages} 頁`;
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = 1;
    
    // 如果進度不是 0，則捲動到該頁面位置
    if (state.currentPageIndex > 0) {
      setTimeout(() => {
        if (state.renderGeneration !== renderGeneration) return;
        const targetImg = elements.pagesContainer.querySelector(`img[data-index="${state.currentPageIndex}"]`);
        if (targetImg) {
          targetImg.scrollIntoView({ behavior: 'auto' });
          // 手動觸發載入
          loadWebtoonImagesAround(state.currentPageIndex);
        }
      }, 200);
    } else {
      loadWebtoonImagesAround(0);
    }
  } else if (state.readingMode === 'catalog') {
    // 目錄縮圖模式
    elements.readerOverlay.classList.add('mode-catalog');
    elements.readerModeIndicator.textContent = '目錄模式';
    elements.prevZone.style.width = '0';
    elements.nextZone.style.width = '0';
    elements.readerViewport.onscroll = null;

    renderCatalogGrid();

    elements.pageCounter.textContent = `共 ${totalPages} 頁`;
    elements.progressSlider.max = totalPages;
    elements.progressSlider.value = state.currentPageIndex + 1;
  }

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
  const isDir = state.currentComicIsDir;

  // 每次目錄重繪都先移除上一個 grid，避免切書或刪頁後舊縮圖疊在新內容上。
  elements.pagesContainer.replaceChildren();

  const grid = document.createElement('div');
  grid.className = 'reader-catalog-grid';

  state.currentComicPages.forEach((src, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'catalog-thumb';
    if (idx === state.currentPageIndex) thumb.classList.add('current');
    thumb.dataset.index = idx;
    configureInteractiveItem(thumb, `跳到第 ${idx + 1} 頁`, () => {
      state.currentPageIndex = idx;
      const backMode = state.prevReadingMode || 'single';
      setReadingMode(backMode);
    });

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = src;
    img.alt = `第 ${idx + 1} 頁`;

    const label = document.createElement('div');
    label.className = 'catalog-thumb-label';
    label.textContent = `${idx + 1}`;

    // 🗑️ 刪除按鈕（只在資料夾漫畫顯示）
    let deleteBtn = null;
    if (isDir) {
      deleteBtn = document.createElement('button');
      deleteBtn.className = 'catalog-delete-btn';
      deleteBtn.title = '移到垃圾桶';
      deleteBtn.setAttribute('aria-label', `將第 ${idx + 1} 頁移到垃圾桶`);
      deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        const confirmed = confirm(`確定要將第 ${idx + 1} 頁（${state.currentComicFilenames[idx] || ''}）移到系統垃圾桶嗎？\n此操作可從垃圾桶還原。`);
        if (!confirmed) return;

        deleteBtn.disabled = true;
        deleteBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        try {
          const result = await eAPI.trashPage(state.currentComic.id, idx);
          if (result && result.success) {
            // 從 state 移除該頁
            state.currentComicPages.splice(idx, 1);
            state.currentComicFilenames.splice(idx, 1);
            if (idx < state.currentPageIndex) state.currentPageIndex -= 1;
            if (state.currentPageIndex >= state.currentComicPages.length) {
              state.currentPageIndex = Math.max(0, state.currentComicPages.length - 1);
            }
            showReaderToast(`🗑️ 第 ${idx + 1} 頁已移到垃圾桶`);
            // 重新渲染 catalog
            renderCatalogGrid();
          } else if (result && result.error === 'cbz-not-supported') {
            showReaderToast('⚠️ CBZ 格式不支援刪除單頁');
          } else {
            showReaderToast(`❌ 刪除失敗：${result ? result.error : '未知錯誤'}`);
            deleteBtn.disabled = false;
            deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
          }
        } catch(err) {
          showReaderToast('❌ 刪除時發生錯誤');
          deleteBtn.disabled = false;
          deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        }
      };
    }

    // 點擊縮圖 → 跳頁並切回閱讀模式
    thumb.onclick = () => {
      state.currentPageIndex = idx;
      const backMode = state.prevReadingMode || 'single';
      setReadingMode(backMode);
    };

    thumb.appendChild(img);
    thumb.appendChild(label);
    if (deleteBtn) thumb.appendChild(deleteBtn);
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

// 姬米妮貼心功能：尋找資料夾內的下一本漫畫並開啟
function openNextComicInFolder() {
  const current = state.comics.find(c => c.id === state.selectedComicId || (state.currentComic && c.id === state.currentComic.id));
  if (!current) return;
  
  const parentPath = getParentPath(current.relativePath);
  
  // 找出同一層目錄下所有可閱讀的實體漫畫，並做自然排序
  const siblings = state.comics
    .filter(c => !c.isDirectory && getParentPath(c.relativePath) === parentPath)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  
  const currentIndex = siblings.findIndex(c => c.id === current.id);
  if (currentIndex >= 0 && currentIndex < siblings.length - 1) {
    const nextComic = siblings[currentIndex + 1];
    showReaderToast(`🔄 即將為您開啟下一本：${nextComic.title}`);
    setTimeout(() => {
      openReader(nextComic.id);
    }, 800);
  } else {
    showReaderToast('🎉 已經是該目錄下的最後一本囉！');
  }
}

// 姬米妮貼心功能：尋找資料夾內的上一本漫畫並開啟
function openPrevComicInFolder() {
  const current = state.comics.find(c => c.id === state.selectedComicId || (state.currentComic && c.id === state.currentComic.id));
  if (!current) return;
  
  const parentPath = getParentPath(current.relativePath);
  
  // 找出同一層目錄下所有可閱讀的實體漫畫，並做自然排序
  const siblings = state.comics
    .filter(c => !c.isDirectory && getParentPath(c.relativePath) === parentPath)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  
  const currentIndex = siblings.findIndex(c => c.id === current.id);
  if (currentIndex > 0) {
    const prevComic = siblings[currentIndex - 1];
    showReaderToast(`🔄 即將為您開啟上一本：${prevComic.title}`);
    setTimeout(() => {
      openReader(prevComic.id);
    }, 800);
  } else {
    showReaderToast('🎉 已經是該目錄下的第一本囉！');
  }
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
    const targetImg = elements.pagesContainer.querySelector(`img[data-index="${pageIndex}"]`);
    if (targetImg) {
      targetImg.scrollIntoView({ behavior: 'smooth' });
      loadWebtoonImagesAround(pageIndex);
    }
    // 更新進度
    elements.pageCounter.textContent = `第 ${pageIndex + 1} / ${totalPages} 頁`;
    saveReadingProgress();
  } else {
    // 雙頁模式下，如果點選的是偶數頁，自動調整為奇數頁（對齊排版）
    if ((state.readingMode === 'double' || state.readingMode === 'double-rtl') && pageIndex > 0 && pageIndex % 2 === 0) {
      state.currentPageIndex = pageIndex - 1;
    } else {
      state.currentPageIndex = pageIndex;
    }
    renderPages();
  }
}

function jumpToFirstPage() {
  if (!state.currentComicPages.length) return;
  jumpToPage(0);
  showReaderToast('已跳到首頁');
}

function jumpToLastPage() {
  if (!state.currentComicPages.length) return;
  jumpToPage(state.currentComicPages.length - 1);
  showReaderToast('已跳到尾頁');
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
  if (state.readingMode === 'webtoon') return;
  if (state.readerContextMenuOpen) {
    hideReaderContextMenu();
    return;
  }

  const w = window.innerWidth;
  const x = e.clientX;

  if (x < w * 0.3) {
    goPreviousByReadingDirection();
  } else if (x > w * 0.7) {
    goNextByReadingDirection();
  } else {
    // 中間區域呼叫或隱藏 UI
    if (elements.readerOverlay.classList.contains('reader-idle')) {
      triggerControlsActive();
    } else {
      elements.readerOverlay.classList.add('reader-idle');
    }
  }
}

function handleReaderAuxClick(e) {
  if (elements.readerOverlay.style.display === 'none') return;
  if (e.target.closest?.('button, input, select, textarea')) return;
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();

  if (e.button === 3) {
    goPreviousByReadingDirection();
    showReaderToast('滑鼠側鍵：上一頁');
  } else {
    goNextByReadingDirection();
    showReaderToast('滑鼠側鍵：下一頁');
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
    case 'double-rtl':
    case 'webtoon':
      setReadingMode(action);
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

// 條漫模式滾動載入與進度計算
function handleWebtoonScroll() {
  if (state.webtoonScrollFrame) return;
  state.webtoonScrollFrame = requestAnimationFrame(() => {
    state.webtoonScrollFrame = null;
    updateWebtoonScrollState();
  });
}

function updateWebtoonScrollState() {
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
    elements.pageCounter.textContent = `第 ${state.currentPageIndex + 1} / ${state.currentComicPages.length} 頁`;
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
  state.readingMode = mode;
  
  // 更新按鈕 active 樣式
  elements.btnModeSingle.classList.toggle('active', mode === 'single');
  elements.btnModeDouble.classList.toggle('active', mode === 'double');
  elements.btnModeDoubleRtl.classList.toggle('active', mode === 'double-rtl');
  elements.btnModeWebtoon.classList.toggle('active', mode === 'webtoon');
  elements.btnModeCatalog.classList.toggle('active', mode === 'catalog');
  [
    [elements.btnModeSingle, 'single'],
    [elements.btnModeDouble, 'double'],
    [elements.btnModeDoubleRtl, 'double-rtl'],
    [elements.btnModeWebtoon, 'webtoon'],
    [elements.btnModeCatalog, 'catalog']
  ].forEach(([button, value]) => button.setAttribute('aria-pressed', String(mode === value)));

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
  elements.btnModeDouble.classList.toggle('active', mode === 'double');
  elements.btnModeDoubleRtl.classList.toggle('active', mode === 'double-rtl');
  elements.btnModeWebtoon.classList.toggle('active', mode === 'webtoon');
  elements.btnModeCatalog.classList.toggle('active', mode === 'catalog');
  [
    [elements.btnModeSingle, 'single'],
    [elements.btnModeDouble, 'double'],
    [elements.btnModeDoubleRtl, 'double-rtl'],
    [elements.btnModeWebtoon, 'webtoon'],
    [elements.btnModeCatalog, 'catalog']
  ].forEach(([button, value]) => button.setAttribute('aria-pressed', String(mode === value)));
  elements.zoomValue.textContent = `${state.zoomPercentage}%`;
  elements.readerOverlay.classList.toggle('reader-crop-edges', state.cropEdges);
  elements.btnCrop.classList.toggle('active', state.cropEdges);
  elements.btnCrop.setAttribute('aria-pressed', String(state.cropEdges));
  elements.btnBrightness.classList.toggle('active', state.brightness !== 100);
  elements.btnBrightness.setAttribute('aria-label', `目前亮度 ${state.brightness}%，按下切換`);

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
  if (state.fitMode === 'contain') toastMsg = '📺 螢幕適應：自適應螢幕 (保持比例)';
  else if (state.fitMode === 'width') toastMsg = '📺 螢幕適應：寬度適應 ↔️';
  else if (state.fitMode === 'height') toastMsg = '📺 螢幕適應：高度適應 ↕️';
  
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
    elements.btnFitMode.title = '螢幕適應：自適應螢幕 (M 鍵)';
  } else if (state.fitMode === 'width') {
    icon.className = 'fa-solid fa-arrows-left-right';
    elements.btnFitMode.title = '螢幕適應：寬度適應 (M 鍵)';
  } else if (state.fitMode === 'height') {
    icon.className = 'fa-solid fa-arrows-up-down';
    elements.btnFitMode.title = '螢幕適應：高度適應 (M 鍵)';
  }
  scheduleReaderImageTransformRefresh();
}

// 🔄 旋轉漫畫圖片 (degrees: 90 或 -90)
function rotateImage(degrees) {
  if (state.readingMode === 'webtoon') {
    showReaderToast('💡 條漫模式不支援旋轉喔，主人！');
    return;
  }
  
  state.rotationAngle = (state.rotationAngle + degrees) % 360;
  const normalizedAngle = normalizedRotationAngle();
  syncReaderRotationUi();
  refreshReaderImageTransforms();
  
  showReaderToast(`🔄 畫面已旋轉 ${normalizedAngle}°`);
}

// ✨ 銳利化模式切換（循環：關閉 → 輕度 → 中度 → 強度 → 關閉）
function toggleSharpen() {
  state.sharpenLevel = (state.sharpenLevel + 1) % 4;
  applySharpenFilter();

  const labels = ['關閉', '✨ 輕度銳利', '✨✨ 中度銳利', '✨✨✨ 強度銳利'];
  showReaderToast(`🔍 銳利化：${labels[state.sharpenLevel]}`);
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
  showReaderToast(state.cropEdges ? '⌗ 已非破壞式裁切頁面外緣 2%' : '⌗ 已顯示完整頁面');
}

function cycleBrightness() {
  const levels = [100, 85, 70, 115];
  const current = levels.indexOf(state.brightness);
  state.brightness = levels[(current + 1) % levels.length];
  localStorage.setItem('readerBrightness', String(state.brightness));
  elements.btnBrightness.classList.toggle('active', state.brightness !== 100);
  elements.btnBrightness.setAttribute('aria-label', `目前亮度 ${state.brightness}%，按下切換`);
  elements.pagesContainer.querySelectorAll('img').forEach(applyImageEffects);
  showReaderToast(`☀️ 亮度：${state.brightness}%`);
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
  elements.loaderText.textContent = text || '召喚中...';
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
    elements.loaderProgressLabel.textContent = detail || (isNumber ? `${Math.round(progress)}%` : '正在處理中...');
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
  if (!status || elements.loaderMask.style.display === 'none') return;
  if (!status.isScanning) {
    stopScanStatusPolling();
    setLoaderProgress(100, '書架整理完成');
    state.loaderHideTimer = window.setTimeout(hideLoader, 250);
    return;
  }
  const found = Number(status.found || 0);
  showLoaderProgress(null, `正在掃描漫畫庫，已發現 ${found} 本`);
}

function startScanStatusPolling() {
  if (!eAPI?.getScanStatus) return;
  stopScanStatusPolling();
  let attempts = 0;
  let consecutiveFailures = 0;
  state.scanStatusPollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const status = await eAPI.getScanStatus();
      consecutiveFailures = 0;
      updateLoaderScanProgress(status);
    } catch(e) {
      consecutiveFailures += 1;
    }
    // 約 42 分鐘的總上限，或連續六次狀態查詢失敗後停止等待；
    // 掃描本身仍在後端繼續，不讓狀態列永久卡住。
    if (attempts >= 3600 || consecutiveFailures >= 6) {
      stopScanStatusPolling();
      state.loaderHideTimer = window.setTimeout(hideLoader, 250);
    }
  }, 700);
}

function stopScanStatusPolling() {
  clearInterval(state.scanStatusPollTimer);
  state.scanStatusPollTimer = null;
}

// 滑鼠滾輪翻頁處理
function handleWheelScroll(e) {
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
      if (path) updateOrganizerUi(`metadata 已匯出至 ${path}`);
      return;
    }
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) {
    updateOrganizerUi(`metadata 匯出失敗：${error?.message || error}`);
  }
}

async function previewCatalogMetadataFile(event) {
  const file = event.target.files?.[0];
  if (!file || !eAPI?.previewCatalogImport || !elements.catalogImportPreview) return;
  try {
    const payload = await file.text();
    const preview = await eAPI.previewCatalogImport(payload);
    elements.catalogImportPreview.innerHTML = `
      <strong>可配對 ${preview.matched} 本；未配對 ${preview.unmatched.length} 本；衝突 ${preview.conflicts.length} 項。</strong>
      <p>「安全匯入」保留本機手動值；「採用匯入衝突值」會明確覆寫列出的衝突，兩者都可撤銷。</p>
      <div class="catalog-exchange-actions">
        <button type="button" class="modal-action-btn" data-import-strategy="safe">安全匯入</button>
        ${preview.conflicts.length ? '<button type="button" class="modal-action-btn catalog-import-risk" data-import-strategy="incoming">採用匯入衝突值</button>' : ''}
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
          elements.catalogImportPreview.textContent = `已更新 ${result.updated} 本，保留 ${result.skippedConflicts} 個本機衝突；可在整理列撤銷。`;
          await fetchLibrary();
        } catch (error) {
          button.disabled = false;
          elements.catalogImportPreview.textContent = `匯入失敗：${error?.message || String(error)}`;
        }
      });
    });
  } catch (error) {
    elements.catalogImportPreview.textContent = `無法預覽交換檔：${error?.message || String(error)}`;
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
    container.innerHTML = '<div style="font-size: 0.9em; color: var(--text-muted);"><i class="fa-solid fa-info-circle"></i> 目前沒有已加入的外部資料夾</div>';
    return;
  }
  
  container.innerHTML = '<div style="font-size: 0.9em; color: var(--text-muted); margin-bottom: 5px;"><i class="fa-solid fa-link"></i> 已連結的外部資料夾：</div>';
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
    delBtn.title = `移除外部資料夾：${b.name}`;
    delBtn.setAttribute('aria-label', `移除外部資料夾：${b.name}`);
    delBtn.style.background = 'var(--accent-red)';
    delBtn.style.color = 'white';
    delBtn.style.border = 'none';
    delBtn.style.padding = '5px 10px';
    delBtn.style.borderRadius = '4px';
    delBtn.style.cursor = 'pointer';
    delBtn.onclick = async () => {
      if (confirm(`確定要移除外部資料夾 [${b.name}] 嗎？`)) {
        const nextBookmarks = bookmarks.filter((_, bookmarkIndex) => bookmarkIndex !== idx);
        try {
          if (window.electronAPI && window.electronAPI.setBookmarks) {
            await window.electronAPI.setBookmarks(nextBookmarks);
          }
          localStorage.setItem('gai:externalBookmarks', JSON.stringify(nextBookmarks));
        } catch (error) {
          console.error('移除外部資料夾失敗：', error);
          alert('移除失敗，原本的資料夾權限已保留：\n' + error);
          return;
        }
        renderExternalBookmarks();
        alert('移除成功，將為您重新掃描...');
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
    showReaderToast('❌ IP 與共用資料夾名稱不可為空！');
    return;
  }
  
  elements.smbConnectBtn.disabled = true;
  elements.smbConnectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 連線中...';
  
  const config = { host, share, username, password };
  const safeConfig = { host, share, username };
  // 呼叫後端套用設定
  try {
    if (!eAPI?.setSmbConfig) {
      throw new Error('此環境不支援 SMB 設定');
    }
    await eAPI.setSmbConfig(config);
    localStorage.setItem('gai:smb', JSON.stringify(safeConfig));
    showReaderToast('✅ SMB 設定已儲存！請重新整理書架。');
    closeSmbModal();
  } catch (err) {
    showReaderToast('❌ SMB 設定失敗：' + err);
  } finally {
    elements.smbConnectBtn.disabled = false;
    elements.smbConnectBtn.innerHTML = '<i class="fa-solid fa-plug"></i> 測試並儲存';
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
    showReaderToast('✅ 已清除 SMB 連線');
    closeSmbModal();
  } catch (err) {
    console.error('清除 SMB 設定失敗：', err);
    showReaderToast('❌ SMB 清除失敗：' + (err?.message || err));
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
      div.innerHTML = '<span style="font-size: 13px; color: var(--text-dark);">此目錄下無其他子資料夾</span>';
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
        <button class="folder-select-action-btn" title="選擇此資料夾">選擇</button>
      `;

      // 點擊資料夾名稱進入該資料夾
      const folderLink = item.querySelector('.folder-item-left');
      folderLink.onclick = () => {
        fetchBrowserFolders(folder.path);
      };
      configureInteractiveItem(folderLink, `開啟資料夾：${folder.name}`, () => {
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
    elements.aiSessionStatus.textContent = '尚未設定艦載 AI。Key 只保留到 App 關閉。';
    return;
  }
  const label = status.provider === 'google' ? 'Google Gemma 4' : 'OpenAI Luna';
  elements.aiSessionStatus.textContent = `已啟用 ${label} · ${status.model}（工作階段限定）`;
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
    showReaderToast('請先手動輸入 API Key');
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
    showReaderToast('艦載 AI 已啟用；Key 只存在本次工作階段');
  } catch (error) {
    showReaderToast('艦載 AI 設定失敗：' + (error?.message || error));
  } finally {
    elements.aiSaveBtn.disabled = false;
  }
}

async function testAiSession() {
  if (!eAPI?.testAiSession) return;
  elements.aiTestBtn.disabled = true;
  elements.aiSessionStatus.textContent = '正在用合成文字測試，不會送出漫畫內容…';
  try {
    const response = await eAPI.testAiSession();
    elements.aiSessionStatus.textContent = response || '艦載 AI 連線成功。';
  } catch (error) {
    elements.aiSessionStatus.textContent = '測試失敗：' + (error?.message || error);
  } finally {
    elements.aiTestBtn.disabled = false;
  }
}

async function clearAiSession() {
  if (!eAPI?.clearAiSessionConfig) return;
  await eAPI.clearAiSessionConfig();
  if (elements.aiApiKey) elements.aiApiKey.value = '';
  renderAiSessionStatus(null);
  showReaderToast('已清除本次工作階段的 API Key');
}

function blobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('無法讀取目前頁面'));
    reader.readAsDataURL(blob);
  });
}

async function pageDataUrl(source) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`頁面讀取失敗（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (blob.size > 20 * 1024 * 1024) throw new Error('目前頁面超過 20 MiB 上限');
  return blobAsDataUrl(blob);
}

async function currentPageDataUrl() {
  if (isBuiltInDemoComic(state.currentComic)) throw new Error('內建示範沒有可送出的漫畫圖像');
  if (!state.currentComicPages.length) throw new Error('請先開啟一頁漫畫');
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
  }
}

function toggleAutoPageExplanation() {
  if (isBuiltInDemoComic(state.currentComic)) {
    showReaderToast('內建全年齡示範不會送出頁面內容給 AI。');
    return;
  }
  const enabled = !state.aiAutoExplain;
  setAutoPageExplanation(enabled);
  if (!enabled) {
    setAiPagePanelVisible(false);
    showReaderToast('已停止全書隨讀');
    return;
  }
  setAiPagePanelVisible(true);
  elements.aiPageResult.textContent = '全書隨讀已開啟：只分析實際翻到的頁面，同頁不重複計費。';
  syncReaderRotationUi();
  scheduleAutoPageExplanation();
}

function scheduleAutoPageExplanation() {
  if (!state.aiAutoExplain || !state.currentComicPages.length) return;
  clearTimeout(state.aiExplainTimer);
  state.aiExplainTimer = setTimeout(() => requestPageExplanation(state.currentPageIndex, true), 420);
}

async function requestPageExplanation(pageIndex, automatic = false) {
  if (isBuiltInDemoComic(state.currentComic)) {
    if (!automatic) showReaderToast('內建全年齡示範不會送出頁面內容給 AI。');
    return;
  }
  if (!eAPI?.explainPage || !state.currentComic?.id || !state.currentComicPages[pageIndex]) {
    if (!automatic) showReaderToast('請先開啟一頁漫畫');
    return;
  }

  const comicId = state.currentComic.id;
  const cacheKey = `${comicId}:${pageIndex}`;
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
    state.aiExplainPendingPage = pageIndex;
    return;
  }

  state.aiExplainInFlight = true;
  state.aiExplainPendingPage = null;
  setAiPagePanelVisible(true);
  elements.aiPageResult.textContent = `艦載 AI 正在閱讀第 ${pageIndex + 1} 頁…`;
  elements.btnAiExplain.disabled = true;
  syncReaderRotationUi();
  try {
    const dataUrl = await pageDataUrl(state.currentComicPages[pageIndex]);
    const explanation = await eAPI.explainPage({ dataUrl });
    state.aiExplainCache.set(cacheKey, explanation);
    if (state.currentComic?.id === comicId && state.currentPageIndex === pageIndex) {
      elements.aiPageResult.textContent = explanation;
    }
  } catch (error) {
    if (state.currentComic?.id === comicId && state.currentPageIndex === pageIndex) {
      const message = error?.message || String(error);
      if (/HTTP 429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
        setAutoPageExplanation(false);
        elements.aiPageResult.textContent = '免費額度或請求頻率暫時用完，已停止全書隨讀。稍後再試，或到設定切換 Luna。已完成的頁面仍保留在本次快取。';
      } else {
        elements.aiPageResult.textContent = '艦載 AI 無法說明：' + message;
      }
    }
  } finally {
    state.aiExplainInFlight = false;
    elements.btnAiExplain.disabled = false;
    const pendingPage = state.aiExplainPendingPage;
    state.aiExplainPendingPage = null;
    if (state.aiAutoExplain && Number.isInteger(pendingPage) && pendingPage !== pageIndex) {
      scheduleAutoPageExplanation();
    }
  }
}

async function comicPreviewDataUrl(comicId) {
  if (!eAPI?.openComic) throw new Error('目前環境無法讀取漫畫頁面');
  const comic = await eAPI.openComic(comicId);
  if (!comic?.pages?.length) throw new Error('這本漫畫沒有可供分析的封面或第一頁');
  return pageDataUrl(comic.pages[0]);
}

async function explainCurrentPage() {
  await requestPageExplanation(state.currentPageIndex, false);
}

function renderAiMetadataCandidates(candidates, comicId, resultContainer = elements.aiPageResult) {
  if (!candidates?.length) {
    resultContainer.textContent = '艦載 AI 沒有提出可確認的候選。';
    return;
  }
  resultContainer.innerHTML = `
    <strong>可審核候選</strong><small class="ai-candidate-note">尚未套用；請逐筆確認。</small>
    <div class="ai-candidate-list">
      ${candidates.map((candidate, index) => {
        const value = candidate.field === 'tags'
          ? (candidate.value || []).map(tag => `${tag.namespace}:${tag.value}`).join('、')
          : String(candidate.value || '');
        return `<div class="ai-candidate" data-candidate-index="${index}">
          <div><span class="ai-candidate-field">${escapeHtml(candidate.field === 'tags' ? '標籤' : '摘要')}</span> ${escapeHtml(value)} <small>${Math.round(Number(candidate.confidence || 0) * 100)}%</small></div>
          <button type="button" class="metadata-suggestion ai-candidate-apply">套用</button>
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
        button.textContent = '已套用';
        button.title = '已寫入使用者覆寫';
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
    resultContainer.textContent = '請在桌面 App 中使用艦載 AI 整理建議。';
    return;
  }
  if (isComicOffline(comic)) {
    resultContainer.textContent = '漫畫來源目前離線，重新掛載後才能讀取封面。';
    return;
  }
  resultContainer.textContent = '艦載 AI 正在讀取封面／第一頁，提出可審核的摘要與標籤…';
  button.disabled = true;
  try {
    const dataUrl = await comicPreviewDataUrl(comic.id);
    const candidates = await eAPI.suggestComicMetadata({ comicId: comic.id, dataUrl });
    renderAiMetadataCandidates(candidates, comic.id, resultContainer);
  } catch (error) {
    resultContainer.textContent = '艦載 AI 建議失敗：' + (error?.message || error);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

// 保存並套用新漫畫目錄
async function saveSettingsPath(pathStr) {
  const normalizedPath = String(pathStr || '').trim().replace(/\/+$/, '') || '/';
  if (normalizedPath === '/' || normalizedPath === '/Volumes') {
    const message = '為避免掃描整台電腦，請選擇磁碟內實際存放漫畫的子資料夾。';
    if (elements.scanDirStatus) elements.scanDirStatus.textContent = message;
    return;
  }
  showLoader('正在套用新目錄並重新載入漫畫庫...', { progress: null, detail: '正在切換書庫位置...' });
  try {
    await eAPI.setConfig({ scanDir: normalizedPath });
    localStorage.setItem('gai:scanDir', normalizedPath);

    // 馬上清空目前的書架，避免使用者看到舊的漫畫
    state.comics = [];
    resetLibraryNavigationState();
    filterAndRenderGrid();
    renderBuiltInDemoStatus();
    renderSidebar();
    renderContinueStrip();
    updateStats();
    
    closeSettingsModal();
    startScanStatusPolling();
    scheduleLibraryRefresh(0);
  } catch (e) {
    console.error('套用漫畫目錄失敗：', e);
    if (elements.scanDirStatus) {
      elements.scanDirStatus.textContent = '無法套用漫畫目錄：' + (e?.message || e);
    }
    hideLoader();
  }
}

// ==========================================================================
// 🖱️ 主畫面漫畫卡片右鍵選單 (Context Menu)
// ==========================================================================

function showGridContextMenu(e, comic) {
  e.preventDefault();
  
  // 移除舊的右鍵選單
  let oldMenu = document.getElementById('grid-context-menu');
  if (oldMenu) {
    oldMenu.remove();
  }
  
  // 建立新選單
  const menu = document.createElement('div');
  menu.id = 'grid-context-menu';
  menu.innerHTML = `
    <div class="menu-header">${escapeHtml(comic.title)}</div>
    <div class="menu-divider"></div>
    <button class="menu-item" data-action="open-folder">
      <i class="fa-solid fa-folder-open"></i> 在 Finder 中顯示
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
  menu.querySelector('[data-action="open-folder"]').onclick = () => {
    if (eAPI && eAPI.showItemInFolder) {
      eAPI.showItemInFolder(comic.id);
    } else {
      alert('網頁版不支援開啟本地資料夾喔！');
    }
    menu.remove();
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
