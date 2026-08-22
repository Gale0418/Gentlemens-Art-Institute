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

const httpFavoritesKey = 'comic-reader:favorites';

// Electron IPC API；瀏覽器模式會退回 server.js 的 HTTP API
const httpAPI = {
  isElectron: false,
  getLibrary: () => requestJson('/api/library'),
  getScanStatus: () => requestJson('/api/scan-status'),
  openComic: (id) => requestJson(`/api/comic/${encodeURIComponent(id)}`),
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
};

const eAPI = window.electronAPI || httpAPI;

function getCoverUrl(comicId) {
  if (!comicId) return '';
  const encodedId = encodeURIComponent(String(comicId));
  if (eAPI && eAPI.isElectron) {
    return `comic://cover/${encodedId}`;
  }
  return `/api/cover?id=${encodedId}`;
}

const MAX_PRELOADED_IMAGES = 10;
const WEBTOON_EAGER_IMAGES = 3;

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
  readerIdleTimer: null,
  readerContextMenuOpen: false,
  webtoonScrollFrame: null,
  scanStatusPollTimer: null,
  renderGeneration: 0,
  sharpenLevel: 0, // 0=關閉, 1=輕度, 2=中度, 3=強度
  loaderRefCount: 0, // 🔧 BUG-FIX：引用計數，防止多個 showLoader 互相覆蓋導致無法 hideLoader
  readerClosePromise: Promise.resolve(),
  readerOperation: 0,
  pendingComicId: null,
  dialogReturnFocus: null,
};

const THEME_STORAGE_KEY = 'comic-reader:theme';
const THEMES = new Set(['midnight', 'sakura', 'ink', 'aurora']);
const THEME_COLORS = {
  midnight: '#140508',
  sakura: '#050506',
  ink: '#03140d',
  aurora: '#161004'
};

// 元素選取器
const elements = {
  comicGrid: document.getElementById('comic-grid'),
  emptyState: document.getElementById('empty-state'),
  searchInput: document.getElementById('search-input'),
  clearSearchBtn: document.getElementById('clear-search-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  libraryPathLabel: document.getElementById('library-path-label'),
  continueStrip: document.getElementById('continue-strip'),
  comicInspector: document.getElementById('comic-inspector'),
  seriesFilterList: document.getElementById('series-filter-list'),
  totalCountBadge: document.getElementById('total-count-badge'),
  
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
  btnFullscreen: document.getElementById('btn-fullscreen'),
  readerBackBtn: document.getElementById('reader-back-btn'),
  readerContextMenu: document.getElementById('reader-context-menu'),
  
  // 姬米妮貼心快取與載入狀態面板元素
  statusRam: document.getElementById('status-ram'),
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
  savePathBtn: document.getElementById('save-path-btn'),
  nativeBrowseBtn: document.getElementById('native-browse-btn'),
  folderBreadcrumbs: document.getElementById('folder-breadcrumbs'),
  browserCurrentPath: document.getElementById('browser-current-path'),
  browserUpBtn: document.getElementById('browser-up-btn'),
  browserFoldersList: document.getElementById('browser-folders-list'),
  themePicker: document.getElementById('theme-picker'),
  
  // SMB 設定元素
  smbSetupBtn: document.getElementById('smb-setup-btn'),
  nativeExternalBtn: document.getElementById('native-external-btn'),
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
  initApp();
  bindEvents();
});

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
    if (tip) tip.innerHTML = '小提示：妳可以使用上方的「匯入圖片」按鈕，將相簿裡的照片存入書庫中喔！✨';
    const emptyTip = document.querySelector('#empty-state p');
    if (emptyTip) emptyTip.innerHTML = '請點擊上方的「匯入圖片」按鈕，或透過檔案 App 匯入漫畫！✨';
  }

  // 開始第一波撈取
  showLoader('天才少女正在為主人召喚漫畫中...', { progress: null, detail: '請稍候...' });
  if (eAPI && eAPI.getFavorites) {
    try { state.favorites = await eAPI.getFavorites(); } catch(e) {}
  }
  const savedScanDir = localStorage.getItem('comic-reader:scanDir');
  if (savedScanDir) {
    try { await eAPI.setConfig({ scanDir: savedScanDir }); } catch(e) {}
  }
  
  // 載入外部書籤
  if (eAPI.setBookmarks) {
    let savedBookmarks = [];
    try {
      savedBookmarks = JSON.parse(localStorage.getItem('comic-reader:externalBookmarks') || '[]');
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
  hideLoader();
}

// 綁定所有點擊與輸入事件
function classifyBookmarkUpdateError(error) {
  const message = error && error.message ? error.message : String(error);
  return {
    message,
    stateWasUpdated: /狀態已更新|設定已更新|BOOKMARKS_UPDATED|PARTIAL_SUCCESS/i.test(message)
  };
}

function bindEvents() {
  // 搜尋功能
  elements.searchInput.addEventListener('input', handleSearch);
  elements.clearSearchBtn.addEventListener('click', () => {
    elements.searchInput.value = '';
    elements.clearSearchBtn.style.display = 'none';
    filterAndRenderGrid();
  });

  // 重新整理
  elements.refreshBtn.addEventListener('click', async () => {
    showLoader('正在重新掃描資料夾，主人請稍候喔...', { progress: null, detail: '正在更新漫畫庫...' });
    if (eAPI.scanLibrary) {
      try { await eAPI.scanLibrary(); } catch(e) { console.error(e); }
    }
    await fetchLibrary();
    hideLoader();
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

  document.querySelectorAll('.smart-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      applyLibraryFilter(e.currentTarget.dataset.filterShortcut);
    });
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
  bindKeyboardActivation(elements.prevZone, goPreviousByReadingDirection);
  bindKeyboardActivation(elements.nextZone, goNextByReadingDirection);

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
  elements.readerViewport.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });
  elements.readerViewport.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      if (dx < 0) goNextByReadingDirection(); // 左滑下一頁
      else goPreviousByReadingDirection(); // 右滑上一頁
    }
  }, { passive: true });

  elements.readerViewport.addEventListener('pointerup', handleReaderPointerClick);
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
  
  if (elements.smbSetupBtn) elements.smbSetupBtn.addEventListener('click', openSmbModal);
  const smbHeaderBtn = document.getElementById('smb-setup-btn-header');
  if (smbHeaderBtn) smbHeaderBtn.addEventListener('click', openSmbModal);
  
  if (elements.closeSmbBtn) elements.closeSmbBtn.addEventListener('click', closeSmbModal);
  if (elements.smbConnectBtn) elements.smbConnectBtn.addEventListener('click', saveSmbConfig);
  if (elements.smbClearBtn) elements.smbClearBtn.addEventListener('click', clearSmbConfig);
  elements.savePathBtn.addEventListener('click', () => {
    const newPath = elements.scanDirInput.value.trim();
    if (newPath) saveSettingsPath(newPath);
  });
  elements.browserUpBtn.addEventListener('click', () => {
    if (state.browserParentPath) {
      fetchBrowserFolders(state.browserParentPath);
    }
  });

  // Electron 特有邏輯 (純 Electron 模式 — 無 HTTP server)
  if (window.electronAPI && window.electronAPI.isElectron) {
    // 顯示原生瀏覽按鈕
    if (elements.nativeBrowseBtn) elements.nativeBrowseBtn.style.display = 'block';

    // 綁定原生瀏覽按鈕事件（回傳路徑後直接套用）
    if (elements.nativeBrowseBtn) {
      elements.nativeBrowseBtn.addEventListener('click', async () => {
        try {
          const selectedPath = await window.electronAPI.openFolderDialog();
          if (selectedPath) {
            elements.scanDirInput.value = selectedPath;
            saveSettingsPath(selectedPath);
          }
        } catch (e) {
          console.error('開啟原生資料夾選擇器失敗：', e);
        }
      });
    }

    // 綁定原生外部資料夾按鈕 (iOS)
    if (elements.nativeExternalBtn) {
      elements.nativeExternalBtn.addEventListener('click', async () => {
        if (!window.electronAPI.openExternalFolder) {
          alert('本環境不支援加入外部資料夾');
          return;
        }
        let desiredBookmarks = null;
        try {
          const result = await window.electronAPI.openExternalFolder();
          if (result && result.bookmark) {
            let bookmarks = [];
            try {
              bookmarks = JSON.parse(localStorage.getItem('comic-reader:externalBookmarks') || '[]');
            } catch (e) {}
            // 如果已經有同一個資料夾就不重複加
            if (!bookmarks.some(b => b.name === result.name && b.bookmark === result.bookmark)) {
              bookmarks.push({ bookmark: result.bookmark, name: result.name });
              desiredBookmarks = bookmarks;
              await window.electronAPI.setBookmarks(bookmarks);
              localStorage.setItem('comic-reader:externalBookmarks', JSON.stringify(bookmarks));
              renderExternalBookmarks();
              alert('成功加入外部資料夾：' + result.name + '\n即將為您重新掃描...');
              elements.refreshBtn.click();
            } else {
              alert('這個資料夾已經加過囉！');
            }
          }
        } catch(e) {
          console.error(e);
          const { message, stateWasUpdated } = classifyBookmarkUpdateError(e);
          if (stateWasUpdated && desiredBookmarks) {
            localStorage.setItem('comic-reader:externalBookmarks', JSON.stringify(desiredBookmarks));
            renderExternalBookmarks();
            alert('外部資料夾已更新，但舊資料夾權限釋放部分失敗：' + message + '\n目前設定已套用，掃描會在背景繼續。');
            elements.refreshBtn.click();
          } else {
            alert('加入失敗：' + message);
          }
        }
      });
    }

    // 監聽漫畫庫目錄檔案異動並自動重新整理
    if (window.electronAPI.onLibraryChanged) {
      window.electronAPI.onLibraryChanged(() => {
        if (state.currentComic) {
          console.log('[Watcher] 偵測到漫畫庫檔案異動，但因為主人正在看書，所以貼心地不打擾主人看書喔！');
          return;
        }
        console.log('[Watcher] 偵測到漫畫庫檔案異動，正在幫主人自動重新整理書架...');
        fetchLibrary();
      });
    }

    if (window.electronAPI.onScanProgress) {
      window.electronAPI.onScanProgress((status) => {
        updateLoaderScanProgress(status);
      });
    }

    if (window.electronAPI.onRamCacheProgress) {
      window.electronAPI.onRamCacheProgress((data) => {
        if (state.currentComic && data.id === state.currentComic.id && data.generation === state.currentComic.preloadGeneration) {
          updateRamCacheProgress(data.loaded, data.total, data.finished, data.error);
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

  // 自動套用當前銳利化設定
  if (state.sharpenLevel > 0) {
    const filterMap = { 1: 'url(#sharpen-subtle)', 2: 'url(#sharpen-standard)', 3: 'url(#sharpen-strong)' };
    const renderingMap = { 1: 'auto', 2: '-webkit-optimize-contrast', 3: 'pixelated' };
    img.style.filter = filterMap[state.sharpenLevel] || 'none';
    img.style.imageRendering = renderingMap[state.sharpenLevel] || 'auto';
  }
  return img;
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
  document.querySelectorAll('.smart-item').forEach(btn => {
    const selected = btn.dataset.filterShortcut === state.activeFilter;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });

  filterAndRenderGrid();
}

// ==========================================================================
// 📚 書架核心 API 串接與渲染
// ==========================================================================

// 獲取漫畫清單
async function fetchLibrary() {
  startScanStatusPolling();
  try {
    setLoaderProgress(null, '正在讀取漫畫庫索引...');
    state.comics = await eAPI.getLibrary();
    setLoaderProgress(70, `已載入 ${state.comics.length} 本漫畫`);
    if (eAPI && eAPI.getFavorites) {
      try { state.favorites = await eAPI.getFavorites(); } catch(e) {}
    }
    if (eAPI && eAPI.getConfig && elements.libraryPathLabel) {
      try {
        const config = await eAPI.getConfig();
        elements.libraryPathLabel.textContent = shortPathLabel(config.scanDir);
        elements.libraryPathLabel.title = config.scanDir;
      } catch(e) {}
    }
    filterAndRenderGrid();
    renderSidebar();
    renderContinueStrip();
    updateStats();
    ensureInspectorSelection();
    setLoaderProgress(100, '書架整理完成');
  } catch (e) {
    console.error('無法獲取書架清單：', e);
    hideLoader(); // 🔧 BUG-FIX：fetchLibrary 失敗時也要確保 Loader 被隱藏
    alert('讀取漫畫庫失敗：' + (e?.message || String(e)));
  } finally {
    stopScanStatusPolling();
  }
}

// 渲染側邊欄分類清單
function renderSidebar() {
  const seriesMap = new Map();
  state.comics.forEach(c => {
    const s = c.series || '未分類';
    seriesMap.set(s, (seriesMap.get(s) || 0) + 1);
  });

  elements.totalCountBadge.textContent = state.comics.length;
  
  // 清除舊清單（保留「全部漫畫」）
  const allLi = elements.seriesFilterList.firstElementChild;
  elements.seriesFilterList.innerHTML = '';
  elements.seriesFilterList.appendChild(allLi);

  // 重新綁定「全部漫畫」點擊事件
  allLi.onclick = () => {
    selectSeries('all', allLi);
  };
  configureInteractiveItem(allLi, '顯示全部漫畫系列', () => selectSeries('all', allLi));

  // 排序並渲染其他系列
  Array.from(seriesMap.keys()).sort().forEach(seriesName => {
    if (seriesName === '未分類' || seriesName === '.') return;
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="series-name">${escapeHtml(seriesName)}</span>
      <span class="badge">${seriesMap.get(seriesName)}</span>
    `;
    li.onclick = () => selectSeries(seriesName, li);
    configureInteractiveItem(li, `顯示系列：${seriesName}`, () => selectSeries(seriesName, li));
    if (state.activeSeries === seriesName) li.classList.add('active');
    elements.seriesFilterList.appendChild(li);
  });

  // 如果有未分類，最後放入
  if (seriesMap.has('未分類')) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="series-name">未分類</span>
      <span class="badge">${seriesMap.get('未分類')}</span>
    `;
    li.onclick = () => selectSeries('未分類', li);
    configureInteractiveItem(li, '顯示未分類漫畫', () => selectSeries('未分類', li));
    if (state.activeSeries === '未分類') li.classList.add('active');
    elements.seriesFilterList.appendChild(li);
  }
}

// 切換側邊欄系列
function selectSeries(seriesName, element) {
  document.querySelectorAll('#series-filter-list li').forEach(li => {
    li.classList.remove('active');
    li.setAttribute('aria-pressed', 'false');
  });
  element.classList.add('active');
  element.setAttribute('aria-pressed', 'true');
  state.activeSeries = seriesName;
  // 直接進入該資料夾內，免去主人的二次點擊 (姬米妮貼心優化 ✨)
  state.currentPath = (seriesName === 'all' || seriesName === '未分類') ? "" : seriesName;
  filterAndRenderGrid();
}

// 統計資訊更新
function updateStats() {
  const total = state.comics.length;
  let reading = 0;
  let completed = 0;

  state.comics.forEach(c => {
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
  const percent = totalPages > 0 ? Math.min(100, Math.max(0, Number(progress.percent || Math.round((currentPage / totalPages) * 100)))) : 0;
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

  const readable = state.comics.filter(comic => comic && !comic.isDirectory);
  const candidates = readable
    .filter(comic => getProgressInfo(comic).hasProgress || state.favorites.includes(comic.id))
    .sort((a, b) => {
      const ta = new Date(a.progress?.updatedAt || a.updatedAt).getTime();
      const tb = new Date(b.progress?.updatedAt || b.updatedAt).getTime();
      return tb - ta;
    })
    .slice(0, 5);

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
    card.addEventListener('mouseenter', () => {
      const comic = state.comics.find(c => c.id === card.dataset.comicId);
      if (comic) renderComicInspector(comic);
    });
    card.addEventListener('click', () => openReader(card.dataset.comicId));
  });
}

function ensureInspectorSelection() {
  if (!elements.comicInspector) return;

  const selected = state.comics.find(c => c.id === state.selectedComicId);
  if (selected) {
    renderComicInspector(selected, { keepSelection: true });
    return;
  }

  const firstReadable = state.comics.find(c => c && !c.isDirectory);
  if (firstReadable) renderComicInspector(firstReadable);
}

function renderComicInspector(comic, options = {}) {
  if (!elements.comicInspector || !comic) return;
  if (!options.keepSelection) state.selectedComicId = comic.id;

  const isDirectory = Boolean(comic.isDirectory);
  const progress = getProgressInfo(comic);
  const format = isDirectory ? '目錄' : (String(comic.type || '').includes('archive') ? 'CBZ/ZIP' : '圖片資料夾');
  const favorite = !isDirectory && state.favorites.includes(comic.id);
  const coverId = comic.coverComicId || comic.id;

  elements.comicInspector.innerHTML = `
    <div class="inspector-cover">
      <img src="${escapeHtml(getCoverUrl(coverId))}" loading="lazy" decoding="async" fetchpriority="low" alt="${escapeHtml(comic.title)}" onerror="this.style.display='none';">
      <div class="inspector-shine"></div>
    </div>
    <div class="inspector-body">
      <span class="section-kicker">${format}</span>
      <h3 title="${escapeHtml(comic.title)}">${escapeHtml(comic.title)}</h3>
      <div class="inspector-tags">
        <span>${escapeHtml(comic.series || '未分類')}</span>
        <span>${progress.totalPages || comic.comicsCount || '---'} 頁</span>
        <span>${progress.isFinished ? '已看完' : progress.hasProgress ? '閱讀中' : '未讀'}</span>
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
          <i class="fa-solid ${isDirectory ? 'fa-folder-open' : 'fa-book-open-reader'}"></i>
          ${isDirectory ? '打開目錄' : '開始閱讀'}
        </button>
        ${isDirectory ? '' : `
          <button class="inspector-icon ${favorite ? 'active' : ''}" data-inspector-action="favorite" title="${favorite ? '取消收藏' : '加入收藏'}">
            <i class="${favorite ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
          </button>
        `}
      </div>
      <div class="inspector-feature-grid">
        <span><i class="fa-solid fa-bookmark"></i> 書籤</span>
        <span><i class="fa-solid fa-crop-simple"></i> 裁切白邊</span>
        <span><i class="fa-solid fa-sun"></i> 亮度</span>
        <span><i class="fa-solid fa-cloud-arrow-up"></i> 同步</span>
      </div>
    </div>
  `;

  const openBtn = elements.comicInspector.querySelector('[data-inspector-action="open"]');
  if (openBtn) {
    openBtn.onclick = () => {
      if (isDirectory) {
        state.currentPath = comic.relativePath;
        filterAndRenderGrid();
      } else {
        openReader(comic.id);
      }
    };
  }

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
}

// 搜尋過濾
function handleSearch(e) {
  const query = e.target.value.trim();
  elements.clearSearchBtn.style.display = query ? 'block' : 'none';
  filterAndRenderGrid();
}

// 計算目前目錄樹路徑下的項目 (由姬米妮為主人傾力打造的 YACReader 級目錄折疊算法 ✨)
function getDirectoryItems() {
  const curPath = state.currentPath;
  const itemsMap = new Map(); // 子目錄折疊
  const filesList = []; // 直屬此目錄的漫畫

  // 1. 先進行基礎的系列與狀態過濾
  const baseFiltered = state.comics.filter(comic => {
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
      const matchTitle = comic.title.toLowerCase().includes(query);
      const matchPath = comic.relativePath.toLowerCase().includes(query);
      return matchTitle || matchPath;
    }).map(c => ({ ...c, isDirectory: false }));
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
function filterAndRenderGrid() {
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

  renderGrid();
}

// 繪製漫畫卡片網格
function renderGrid() {
  elements.comicGrid.innerHTML = '';
  
  if (state.filteredComics.length === 0) {
    elements.emptyState.style.display = 'flex';
    return;
  }
  
  elements.emptyState.style.display = 'none';

  state.filteredComics.forEach(comic => {
    const card = document.createElement('div');
    card.className = 'comic-card' + (comic.isDirectory ? ' folder-card' : '');
    if (state.selectedComicId === comic.id) card.classList.add('selected');
    
    if (comic.isDirectory) {
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
      card.onmouseenter = () => renderComicInspector(comic);
      card.oncontextmenu = (e) => showGridContextMenu(e, comic);
    } else {
      // ==========================================
      // 📖 【標準漫畫卡片】
      // ==========================================
      // 進度條樣式計算
      const hasProgress = comic.progress && comic.progress.currentPage > 0;
      const percent = hasProgress ? comic.progress.percent : 0;
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
          <button class="favorite-toggle-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? '取消收藏' : '加入收藏'}">
            <i class="${isFavorite ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
          </button>

          <span class="comic-format-tag ${String(comic.type || '').includes('archive') ? 'tag-archive' : 'tag-folder'}" data-ext="${escapeHtml(comic.ext || 'folder')}">${String(comic.type || '').includes('archive') ? escapeHtml((comic.ext || '.cbz').replace('.','').toUpperCase()) : '📁 目錄'}</span>
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

      card.onclick = () => openReader(comic.id);
      configureInteractiveItem(card, `閱讀漫畫：${comic.title}`, card.onclick);
      card.onmouseenter = () => renderComicInspector(comic);
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
              if (state.activeFilter === 'favorite') {
                filterAndRenderGrid();
              }
              renderComicInspector(comic, { keepSelection: true });
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
  const coverObserver = new IntersectionObserver((entries, observer) => {
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
}

// ==========================================================================
// 📖 核心漫畫閱讀器功能
// ==========================================================================

// 開啟閱讀器
async function openReader(comicId) {
  await state.readerClosePromise;
  if (state.currentComic) {
    await closeReader();
  }
  const operation = ++state.readerOperation;
  state.pendingComicId = comicId;
  showLoader('主人請稍候，天才少女正在載入漫畫分頁...', { progress: null, detail: '正在準備頁面清單...' });
  try {
    const data = await eAPI.openComic(comicId);
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
    
    state.currentPageIndex = (data.progress && data.progress.currentPage) ? data.progress.currentPage : 0;
    
    const lowerTitle = data.title.toLowerCase();
    if (lowerTitle.includes('webtoon') || lowerTitle.includes('條漫') || lowerTitle.includes('manga_scroll')) {
      state.readingMode = 'webtoon';
    } else {
      state.readingMode = 'single';
    }
    
    if (state.zoomPercentage === undefined) state.zoomPercentage = 100;
    if (state.rotationAngle === undefined) state.rotationAngle = 0;
    releasePreloadedImages();

    if (elements.statusRam) {
      elements.statusRam.style.display = window.electronAPI && window.electronAPI.isElectron ? 'inline-flex' : 'none';
      elements.statusRam.innerHTML = '<i class="fa-solid fa-memory"></i> RAM 快取準備中...';
      elements.statusRam.style.color = '';
    }

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
    alert('讀取漫畫資料失敗：' + message);
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
  const closingId = state.currentComic ? state.currentComic.id : state.pendingComicId;
  state.currentComic = null;
  state.currentComicPages = [];
  state.pendingComicId = null;

  if (elements.statusRam) elements.statusRam.style.display = 'none';
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
  
  if (closingId && window.electronAPI && window.electronAPI.closeComic) {
    state.readerClosePromise = state.readerClosePromise
      .catch(() => {})
      .then(() => window.electronAPI.closeComic(closingId));
    try {
      await state.readerClosePromise;
    } catch (err) {
      console.error('關閉漫畫清理失敗:', err);
    }
  }

  // 重新整理書架（更新最近閱讀與進度條）
  fetchLibrary();
}

function releasePreloadedImages() {
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
    const tempImg = createReaderImage(targetSrc, 'high');

    // 🚀 顯示頁面載入/解碼中旋轉動畫
    showPageLoadingSpinner(true);

    // 🚀 極致雙緩衝：在背景將圖片完整載入並由 GPU 完成解碼，這段期間舊圖片原封不動留在畫面上！
    tempImg.decode().then(() => {
      // 確保在非同步解碼期間，使用者沒有突然切換模式或快速翻到別的頁面
      if (state.renderGeneration !== renderGeneration) return;
      if (state.readingMode !== 'single') return;
      if (state.currentComicPages[state.currentPageIndex] !== targetSrc) return;

      // 只有在「百分之百準備好顯示」的這一微秒，才清空 DOM 並瞬間塞入新圖片，絕對零閃爍！
      elements.pagesContainer.innerHTML = '';
      elements.pagesContainer.appendChild(tempImg);
      
      // 隱藏解碼中動畫
      showPageLoadingSpinner(false);
    }).catch(() => {
      // 降級處理（例如圖片損壞等特殊情況）
      if (state.renderGeneration !== renderGeneration) return;
      if (state.readingMode !== 'single') return;
      if (state.currentComicPages[state.currentPageIndex] !== targetSrc) return;
      elements.pagesContainer.innerHTML = '';
      elements.pagesContainer.appendChild(tempImg);
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
      const tempImg = createReaderImage(targetSrc, 'high');

      showPageLoadingSpinner(true);

      tempImg.decode().then(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== 0) return;

        elements.pagesContainer.innerHTML = '';
        elements.pagesContainer.appendChild(tempImg);
        showPageLoadingSpinner(false);
      }).catch(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== 0) return;
        elements.pagesContainer.innerHTML = '';
        elements.pagesContainer.appendChild(tempImg);
        showPageLoadingSpinner(false);
      });
      
      elements.pageCounter.textContent = `第 1 / ${totalPages} 頁 (封面)`;
    } else {
      // 雙頁情況：顯示 currentPageIndex 和 currentPageIndex + 1
      const page1Index = state.currentPageIndex;
      const page2Index = state.currentPageIndex + 1 < totalPages ? state.currentPageIndex + 1 : null;

      const src1 = state.currentComicPages[page1Index];
      const src2 = page2Index !== null ? state.currentComicPages[page2Index] : null;

      const img1 = createReaderImage(src1, 'high');
      let img2 = null;
      if (page2Index !== null) {
        img2 = createReaderImage(src2, 'high');
      }

      showPageLoadingSpinner(true);

      // 用 Promise.all 背景同時等待並解碼雙頁，保證兩張圖同步在背景完全就緒！
      const decodePromises = [img1.decode()];
      if (img2) decodePromises.push(img2.decode());

      Promise.all(decodePromises).then(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== page1Index) return;

        elements.pagesContainer.innerHTML = '';
        if (isRtl && img2) {
          elements.pagesContainer.appendChild(img2);
          elements.pagesContainer.appendChild(img1);
        } else {
          elements.pagesContainer.appendChild(img1);
          if (img2) elements.pagesContainer.appendChild(img2);
        }
        showPageLoadingSpinner(false);
      }).catch(() => {
        if (state.renderGeneration !== renderGeneration) return;
        if (state.readingMode !== 'double' && state.readingMode !== 'double-rtl') return;
        if (state.currentPageIndex !== page1Index) return;

        elements.pagesContainer.innerHTML = '';
        if (isRtl && img2) {
          elements.pagesContainer.appendChild(img2);
          elements.pagesContainer.appendChild(img1);
        } else {
          elements.pagesContainer.appendChild(img1);
          if (img2) elements.pagesContainer.appendChild(img2);
        }
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
      showReaderToast('裁切白邊會在下一階段補上');
      break;
    case 'brightness':
      showReaderToast('亮度調整會在下一階段補上');
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

// 非同步預載前後頁，確保翻頁零延遲
function preloadNextPages() {
  const pages = state.currentComicPages;
  const current = state.currentPageIndex;
  const total = pages.length;
  
  // 我們預載後面 3 頁與前面 1 頁
  const indicesToPreload = [current + 1, current + 2, current + 3, current - 1];
  
  if (state.readingMode === 'double' || state.readingMode === 'double-rtl') {
    // 雙頁模式預載後面 2 組雙頁 (4頁)
    indicesToPreload.push(current + 4);
  }

  indicesToPreload.forEach(idx => {
    if (idx >= 0 && idx < total && !state.preloadedImages.has(idx)) {
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.src = pages[idx];
      state.preloadedImages.set(idx, img);
    }
  });

  prunePreloadedImages(indicesToPreload);
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
  if (!state.currentComic) return;
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
  const imgs = elements.pagesContainer.querySelectorAll('img');
  imgs.forEach(img => {
    img.style.transform = `scale(${state.zoomPercentage / 100}) rotate(${state.rotationAngle}deg)`;
  });
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
}

// 🔄 旋轉漫畫圖片 (degrees: 90 或 -90)
function rotateImage(degrees) {
  if (state.readingMode === 'webtoon') {
    showReaderToast('💡 條漫模式不支援旋轉喔，主人！');
    return;
  }
  
  state.rotationAngle = (state.rotationAngle + degrees) % 360;
  let normalizedAngle = state.rotationAngle;
  if (normalizedAngle < 0) normalizedAngle += 360;
  const isSideways = normalizedAngle === 90 || normalizedAngle === 270;
  
  // 重新套用當前頁面圖片的旋轉與縮放
  const imgs = elements.pagesContainer.querySelectorAll('img');
  imgs.forEach(img => {
    if (state.fitMode === 'contain' && isSideways) {
      // 在 contain 模式且旋轉 90/270 時，需要反算 viewport 比例來修正 Layout 盒子的溢出
      const containerW = elements.pagesContainer.clientWidth;
      const containerH = elements.pagesContainer.clientHeight;
      const scaleToFit = Math.min(containerW / containerH, containerH / containerW);
      img.style.transform = `scale(${scaleToFit * (state.zoomPercentage / 100)}) rotate(${state.rotationAngle}deg)`;
    } else {
      img.style.transform = `scale(${state.zoomPercentage / 100}) rotate(${state.rotationAngle}deg)`;
    }
  });
  
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
  const filterMap = {
    0: 'none',
    1: 'url(#sharpen-subtle)',
    2: 'url(#sharpen-standard)',
    3: 'url(#sharpen-strong)',
  };
  const renderingMap = {
    0: 'auto',
    1: 'auto',
    2: '-webkit-optimize-contrast',
    3: 'pixelated',
  };

  const svgFilter = filterMap[state.sharpenLevel];
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
    img.style.filter = svgFilter;
    img.style.imageRendering = imageRendering;
  });
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
  state.loaderRefCount++;
  elements.loaderText.textContent = text || '召喚中...';
  elements.loaderMask.style.display = 'flex';
  if (Object.prototype.hasOwnProperty.call(options, 'progress')) {
    showLoaderProgress(options.progress, options.detail || '');
  } else {
    hideLoaderProgress();
  }
}

function hideLoader() {
  state.loaderRefCount = Math.max(0, state.loaderRefCount - 1);
  if (state.loaderRefCount === 0) {
    elements.loaderMask.style.display = 'none';
    hideLoaderProgress();
  }
}

// 🔧 BUG-FIX：緊急強制隱藏 Loader（不管 refCount 多少），供 timeout 等情境使用
function forceHideLoader() {
  state.loaderRefCount = 0;
  elements.loaderMask.style.display = 'none';
  hideLoaderProgress();
}

// 🚀 姬米妮貼心設計：更新記憶體快取進度條，載入完成後自動隱藏保持介面清爽！
function updateRamCacheProgress(loaded, total, finished = false, error = null) {
  if (!elements.statusRam) return;

  if (error) {
    console.error('[RAM preload]', error);
    elements.statusRam.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> RAM 預載略過，將改為逐頁讀取';
    elements.statusRam.style.color = 'var(--accent-red)';
    return;
  }
  
  if (finished || loaded >= total) {
    elements.statusRam.innerHTML = '<i class="fa-solid fa-memory" style="color: var(--accent);"></i> ⚡ RAM 已全載入';
    elements.statusRam.style.color = 'var(--accent)';
    
    // 貼心隱藏：滿載顯示 2 秒讓主人安心，隨後優雅隱藏，還給主人 100% 乾淨的閱讀畫面！
    setTimeout(() => {
      if (state.currentComic && (state.readingMode === 'single' || state.readingMode === 'double' || state.readingMode === 'double-rtl')) {
        elements.statusRam.style.display = 'none';
      }
    }, 2000);
  } else {
    const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
    elements.statusRam.style.display = 'inline-flex'; // 確保載入時顯示
    elements.statusRam.innerHTML = `<i class="fa-solid fa-memory"></i> RAM 載入中: ${loaded}/${total} 頁 (${percent}%)`;
    elements.statusRam.style.color = '';
  }
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
  if (status.isScanning) {
    const found = Number(status.found || 0);
    showLoaderProgress(null, `正在掃描漫畫庫，已發現 ${found} 本`);
  }
}

function startScanStatusPolling() {
  if (!eAPI?.getScanStatus) return;
  stopScanStatusPolling();
  state.scanStatusPollTimer = setInterval(async () => {
    try {
      updateLoaderScanProgress(await eAPI.getScanStatus());
    } catch(e) {}
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
    bookmarks = JSON.parse(localStorage.getItem('comic-reader:externalBookmarks') || '[]');
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
          localStorage.setItem('comic-reader:externalBookmarks', JSON.stringify(nextBookmarks));
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
    smbConfig = JSON.parse(localStorage.getItem('comic-reader:smb') || '{}');
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
    localStorage.setItem('comic-reader:smb', JSON.stringify(safeConfig));
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
    localStorage.removeItem('comic-reader:smb');
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
      item.querySelector('.folder-item-left').onclick = () => {
        fetchBrowserFolders(folder.path);
      };

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

// 保存並套用新漫畫目錄
async function saveSettingsPath(pathStr) {
  showLoader('正在套用新目錄並重新載入漫畫庫...', { progress: null, detail: '正在切換書庫位置...' });
  try {
    localStorage.setItem('comic-reader:scanDir', pathStr);
    
    // 馬上清空目前的書架，避免使用者看到舊的漫畫
    state.comics = [];
    state.activeSeries = 'all';
    filterAndRenderGrid();
    renderSidebar();
    renderContinueStrip();
    updateStats();
    
    // 背景執行，不阻擋 UI
    eAPI.setConfig({ scanDir: pathStr }).catch(e => {
      console.error('設定失敗', e);
      alert('套用設定時發生錯誤：' + e);
      fetchLibrary();
    });
    
    closeSettingsModal();
    // 注意：這裡不呼叫 fetchLibrary() 也不 hideLoader()！
    // 因為 setConfig 已經叫後端去掃描了，後端掃完會自己廣播 library-changed，
    // 屆時自動觸發的 fetchLibrary() 才會拿到最新資料，並在最後正確 hideLoader()。
    
    // Fallback: 避免收不到事件永遠卡死
    setTimeout(() => {
      if (elements.loaderMask && elements.loaderMask.style.display !== 'none') {
        fetchLibrary();
      }
    }, 5000);
  } catch (e) {
    alert('套用設定時發生錯誤：' + e.message);
    fetchLibrary();
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
      eAPI.showItemInFolder(comic.relativePath);
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
