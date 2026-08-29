// preload.js — 安全橋接 main <-> renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // 書架
  getLibrary: () => ipcRenderer.invoke('get-library'),
  getScanStatus: () => ipcRenderer.invoke('get-scan-status'),
  scanLibrary: () => ipcRenderer.invoke('scan-library'),

  // 打開與關閉漫畫（回傳 { id, title, pages: ['gai://page/...'], progress }）
  openComic: (id) => ipcRenderer.invoke('open-comic', id),
  closeComic: () => ipcRenderer.invoke('close-comic'),

  // 儲存閱讀進度
  saveProgress: (data) => ipcRenderer.invoke('save-progress', data),

  // 設定
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (data) => ipcRenderer.invoke('set-config', data),

  // 原生資料夾選擇器（回傳選擇的路徑字串，或 null）
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),

  // 瀏覽資料夾
  browseFolders: (dirPath) => ipcRenderer.invoke('browse-folders', dirPath),

  // 監聽漫畫庫變動並通知前端
  onLibraryChanged: (callback) => ipcRenderer.on('library-changed', (_event, ...args) => callback(...args)),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_event, ...args) => callback(...args)),

  // 收藏夾功能
  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  toggleFavorite: (id) => ipcRenderer.invoke('toggle-favorite', id),

  // 開啟系統資料夾
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),

  // 🗑️ 將資料夾漫畫指定頁面移到垃圾桶
  trashPage: (comicId, pageIndex) => ipcRenderer.invoke('trash-page', { comicId, pageIndex }),

  // 監聽記憶體極致快取進度
  onRamCacheProgress: (callback) => ipcRenderer.on('ram-cache-progress', (_event, ...args) => callback(...args)),
});
