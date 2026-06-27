/**
 * Tauri API 橋接層 (Phase 2)
 * 把原本 Electron 的 IPC 呼叫無縫轉換成 Tauri 的 invoke 呼叫。
 * 當偵測到 Tauri 環境時，會自動覆寫 window.electronAPI。
 */

if (window.__TAURI__) {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  console.log("🚀 Tauri 環境偵測成功，初始化橋接層...");

  // 定義與原本 preload.js 一模一樣的介面
  window.electronAPI = {
    isElectron: true, // 騙前端說我們是 Electron，這樣它才會走 native 邏輯
    getLibrary: () => invoke('get_library'),
    getScanStatus: () => invoke('get_scan_status'),
    openComic: (id) => invoke('open_comic', { id }),
    closeComic: () => invoke('close_comic'),
    saveProgress: (data) => invoke('save_progress', { data }),
    getConfig: () => invoke('get_config'),
    setConfig: (data) => invoke('set_config', { data }),
    setSmbConfig: (data) => invoke('set_smb_config', { data }),
    getBookmarks: () => invoke('get_bookmarks'),
    setBookmarks: (data) => invoke('set_bookmarks', { data }),
    openExternalFolder: () => invoke('plugin:ios-folder|pick_folder'),
    openFolderDialog: async () => {
    try {
      const result = await invoke('plugin:dialog|open', { directory: true, multiple: false });
      return result;
    } catch (e) {
      console.error(e);
      return null;
    }
  },
    browseFolders: (dirPath) => invoke('browse_folders', { dirPath }),
    onLibraryChanged: (callback) => {
      return listen('library-changed', (event) => {
        callback(event.payload);
      });
    },
    onScanProgress: (callback) => {
      return listen('scan-progress', (event) => callback(event.payload));
    },
    onRamCacheProgress: (callback) => {
      return listen('ram-cache-progress', (event) => callback(event.payload));
    },
    onSmbDownloadStart: (callback) => {
      return listen('smb-download-start', (event) => callback(event.payload));
    },
    onSmbDownloadEnd: (callback) => {
      return listen('smb-download-end', (event) => callback(event.payload));
    },
    // Favorites 原本是存在 localStorage，這裡我們直接用原本前端的邏輯，或者未來移交後端
    getFavorites: async () => {
      try {
        return JSON.parse(localStorage.getItem('comic-reader:favorites') || '[]');
      } catch(e) {
        return [];
      }
    },
    toggleFavorite: async (id) => {
      const favorites = await window.electronAPI.getFavorites();
      const index = favorites.indexOf(id);
      if (index >= 0) favorites.splice(index, 1);
      else favorites.push(id);
      localStorage.setItem('comic-reader:favorites', JSON.stringify(favorites));
      return favorites;
    },
    showItemInFolder: (path) => invoke('show_item_in_folder', { path }),
    trashPage: (comicId, pageIndex) => invoke('trash_page', { comicId, pageIndex }),
    scanLibrary: () => invoke('scan_library'),
  };
}
