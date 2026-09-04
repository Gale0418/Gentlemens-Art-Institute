// preload.js — 安全橋接 main <-> renderer
const { contextBridge, ipcRenderer } = require('electron');

function isStrictBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lastValue = alphabet.indexOf(value[value.length - 1]);
  return (remainder !== 2 || (lastValue & 0x0f) === 0)
    && (remainder !== 3 || (lastValue & 0x03) === 0);
}

function validateProgressPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('invalid progress payload');
  }
  const { id, currentPage, totalPages } = payload;
  if (!isStrictBase64Url(id)) throw new TypeError('invalid progress id');
  if (!Number.isSafeInteger(currentPage) || currentPage < 0) throw new TypeError('invalid current page');
  if (!Number.isSafeInteger(totalPages) || totalPages < 0 || (totalPages > 0 && currentPage >= totalPages)) {
    throw new TypeError('invalid total pages');
  }
  return { id, currentPage, totalPages };
}

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
  saveProgress: (data) => ipcRenderer.invoke('save-progress', validateProgressPayload(data)),

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
