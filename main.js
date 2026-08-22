// Electron 主程序 (main.js) — 純 Electron 架構，無 HTTP 伺服器！
// 所有檔案 I/O 直接在主程序處理，透過 IPC 與 renderer 溝通
import {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net
} from 'electron';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import yauzl from 'yauzl';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ======================================================
// 常數與路徑
// ======================================================
const USER_DATA_DIR  = app.getPath('userData');
const CONFIG_FILE    = path.join(USER_DATA_DIR, 'config.json');
const PROGRESS_FILE  = path.join(USER_DATA_DIR, 'progress.json');
const METADATA_FILE  = path.join(USER_DATA_DIR, 'metadata.json');
const FAVORITES_FILE = path.join(USER_DATA_DIR, 'favorites.json');
const COVER_CACHE_DIR = path.join(USER_DATA_DIR, 'cache', 'covers');

if (!fs.existsSync(COVER_CACHE_DIR)) fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });

// ======================================================
// 收藏夾資料管理
// ======================================================
function getFavorites() {
  try {
    return fs.existsSync(FAVORITES_FILE) ? JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf-8')) : [];
  } catch(e) { return []; }
}

function saveFavorites(favorites) {
  try {
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2), 'utf-8');
  } catch(e) { console.error('saveFavorites error:', e); }
}


const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const configuredScanDepth = Number.parseInt(process.env.COMIC_SCAN_MAX_DEPTH || '', 10);
function isImage(n) { return IMAGE_EXTENSIONS.includes(path.extname(n).toLowerCase()); }
function isSystemFile(n) { return path.basename(n).startsWith('.') || n.includes('__MACOSX'); }
async function readImageFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('image exceeds size limit');
  return fs.promises.readFile(filePath);
}
function hasReachedScanDepth(depth) {
  return Number.isFinite(configuredScanDepth) && configuredScanDepth >= 0 && depth > configuredScanDepth;
}

// ======================================================
// 設定 & 進度
// ======================================================
let currentScanDir = app.getPath('downloads');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (c.scanDir && fs.existsSync(c.scanDir)) currentScanDir = c.scanDir;
    }
  } catch(e) { console.error('loadConfig error:', e); }
}

function saveConfig(dir) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ scanDir: dir }, null, 2), 'utf-8');
  currentScanDir = dir;
}

// ======================================================
// 📺 漫畫庫資料夾變動自動監聽 (姬米妮貼心打造 ✨)
// ======================================================
let dirWatcher = null;
let watchDebounceTimer = null;

function watchScanDir() {
  if (dirWatcher) {
    dirWatcher.close();
    dirWatcher = null;
  }

  if (!fs.existsSync(currentScanDir)) return;

  try {
    console.log(`[Watcher] 開始監聽漫畫庫變動：${currentScanDir}`);
    // macOS 支援 recursive 參數進行子資料夾遞迴監聽
    dirWatcher = fs.watch(currentScanDir, { recursive: true }, (eventType, filename) => {
      // 排除系統暫存檔案 (DS_Store, macOS 產生的壓縮包暫存等, Chrome 暫存, Safari 暫存)
      if (filename) {
        const base = path.basename(filename);
        if (base.startsWith('.') || filename.includes('__MACOSX')) return;
        const ext = path.extname(filename).toLowerCase();
        if (['.crdownload', '.download', '.part', '.tmp'].includes(ext) || base.startsWith('~')) return;
      }
      
      console.log(`[Watcher] 偵測到漫畫庫檔案變更：${eventType} -> ${filename}`);
      
      // 使用 10000ms (10秒) 的防抖 (Debounce) 機制，確保主人複製超大漫畫檔案時有充足的寫入時間
      clearTimeout(watchDebounceTimer);
      watchDebounceTimer = setTimeout(() => {
        console.log('[Watcher] 漫畫庫檔案變更防抖結束，啟動背景掃描任務！');
        doBackgroundScan();
      }, 10000);
    });
  } catch (err) {
    console.error('[Watcher] 啟動漫畫庫目錄監聽器失敗：', err);
  }
}


let comicMetadata = {};
function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) comicMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
  } catch(e) {}
}
function saveMetadata() {
  try { fs.writeFileSync(METADATA_FILE, JSON.stringify(comicMetadata, null, 2), 'utf-8'); } catch(e) {}
}

function getProgress() {
  try {
    return fs.existsSync(PROGRESS_FILE) ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')) : {};
  } catch(e) { return {}; }
}
function saveProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ======================================================
// YauzlHandle 常駐快取 (翻頁核心效能)
// ======================================================
const ZIP_HANDLE_MAX = 5;
const zipHandleCache = new Map(); // id -> { zipfile, entryNames, entriesByName, lastAccess }

function getZipHandle(id, fullPath) {
  const stat = fs.statSync(fullPath);
  if (zipHandleCache.has(id)) {
    const h = zipHandleCache.get(id);
    if (h.mtimeMs === stat.mtimeMs && h.size === stat.size) {
      h.lastAccess = Date.now();
      return Promise.resolve(h);
    } else {
      try { h.zipfile.close(); } catch(e) {}
      zipHandleCache.delete(id);
    }
  }
  return new Promise((resolve, reject) => {
    // 淘汰最舊的
    if (zipHandleCache.size >= ZIP_HANDLE_MAX) {
      let oldest = null, oldestTime = Infinity;
      for (const [cid, h] of zipHandleCache) {
        if (h.lastAccess < oldestTime) { oldestTime = h.lastAccess; oldest = cid; }
      }
      if (oldest) { try { zipHandleCache.get(oldest).zipfile.close(); } catch(e) {} zipHandleCache.delete(oldest); }
    }

    yauzl.open(fullPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) return reject(err);
      const entriesByName = new Map();
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (!entry.fileName.endsWith('/') && isImage(entry.fileName) && !isSystemFile(entry.fileName)) {
          entriesByName.set(entry.fileName, entry);
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => {
        const entryNames = Array.from(entriesByName.keys())
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        const handle = { zipfile, entriesByName, entryNames, lastAccess: Date.now(), mtimeMs: stat.mtimeMs, size: stat.size };
        zipHandleCache.set(id, handle);
        resolve(handle);
      });
      zipfile.on('error', reject);
    });
  });
}

function readPageBuffer(handle, pageIndex) {
  return new Promise((resolve, reject) => {
    if (pageIndex < 0 || pageIndex >= handle.entryNames.length) return reject(new Error('頁碼超出範圍'));
    const entry = handle.entriesByName.get(handle.entryNames[pageIndex]);
    if (!entry) return reject(new Error('找不到頁面'));
    handle.zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let totalBytes = 0;
      stream.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > MAX_IMAGE_BYTES) {
          stream.destroy(new Error('image exceeds size limit'));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

// ======================================================
// 🚀 漫畫極致 RAM 快取 (Active Comic RAM Cache)
// 將正在閱讀的整本漫畫以非同步背景執行讀取並完全「丟進 RAM」，達成 0ms 硬碟延遲的絲滑閱讀體驗！
// ======================================================
// ======================================================
// 🚀 漫畫多層級智慧 RAM 快取池 (Smart RAM Cache Pool)
// 鍵為 comicId，值為 Map(pageIndex -> { buf, ext })
// 將正在閱讀的漫畫、同目錄卷數、未讀完漫畫在背景非同步預先載入，釋放 0ms 無卡頓閱讀體驗！
// ======================================================
const ramCachePool = new Map();
const preloadFailuresPool = new Map(); // id -> Map(pageIndex -> failsCount)
let activeReadingComicId = null; // 當前正在閱讀的漫畫 ID
let preloaderState = {
  queue: [], // list of { id, fullPath, isDir, totalPages }
  isPreloading: false,
};

let totalRamCacheBytes = 0;
const MAX_RAM_CACHE_BYTES = 500 * 1024 * 1024; // 500 MB
function evictRamCache(neededBytes) {
  if (totalRamCacheBytes + neededBytes <= MAX_RAM_CACHE_BYTES) return;
  for (const [cid, cache] of ramCachePool) {
    if (cid !== activeReadingComicId) {
      for (const [page, data] of cache) {
        totalRamCacheBytes -= data.buf.length;
        cache.delete(page);
      }
      ramCachePool.delete(cid);
    }
    if (totalRamCacheBytes + neededBytes <= MAX_RAM_CACHE_BYTES) return;
  }
  if (totalRamCacheBytes + neededBytes > MAX_RAM_CACHE_BYTES) {
    totalRamCacheBytes = 0;
    ramCachePool.clear();
  }
}

async function startSmartPreloader() {
  if (preloaderState.isPreloading) return;
  preloaderState.isPreloading = true;

  while (preloaderState.queue.length > 0 && activeReadingComicId !== null) {
    const item = preloaderState.queue[0]; // 取得目前要預載的項目
    
    // 如果快取池沒有該書的快取，初始化一個
    if (!ramCachePool.has(item.id)) {
      ramCachePool.set(item.id, new Map());
      preloadFailuresPool.set(item.id, new Map());
    }
    const bookCache = ramCachePool.get(item.id);

    console.log(`🚀 背景智慧預載: [漫畫 ${item.id}]，進度: ${bookCache.size}/${item.totalPages} 頁...`);

    let nextPageIndex = -1;
    for (let i = 0; i < item.totalPages; i++) {
      // 確保使用者沒有切換或關閉閱讀器
      if (activeReadingComicId === null) break;
      // 如果 queue 變了（例如切換了當前看書，queue 被重設），就中斷目前這本
      if (preloaderState.queue[0]?.id !== item.id) break;

      const fails = preloadFailuresPool.get(item.id);
      if (!bookCache.has(i) && !(fails && fails.get(i) >= 3)) {
        nextPageIndex = i;
        break;
      }
    }

    if (nextPageIndex === -1 || activeReadingComicId === null || preloaderState.queue[0]?.id !== item.id) {
      // 這本書已經完全載入 RAM 了，或者被切換了，從隊列移除！
      if (nextPageIndex === -1) {
        console.log(`✨ 大成功！漫畫 ${item.id} 已完全載入 RAM！從隊列移除。`);
        if (mainWindow && !mainWindow.isDestroyed() && item.id === activeReadingComicId) {
          mainWindow.webContents.send('ram-cache-progress', { id: item.id, loaded: bookCache.size, total: item.totalPages, finished: true });
        }
        preloaderState.queue.shift();
      } else {
        // 切換漫畫，直接退出或重來
        continue;
      }
      continue;
    }

    // 讀取該頁
    try {
      let buf = null;
      let ext = '';
      if (item.isDir) {
        const images = getFolderImages(item.fullPath);
        if (nextPageIndex < images.length) {
          const imgPath = path.join(item.fullPath, images[nextPageIndex]);
          ext = path.extname(images[nextPageIndex]).toLowerCase();
          buf = await readImageFile(imgPath);
        }
      } else {
        const handle = await getZipHandle(item.id, item.fullPath);
        buf = await readPageBuffer(handle, nextPageIndex);
        ext = path.extname(handle.entryNames[nextPageIndex]).toLowerCase();
      }

      // 再次確認狀態無虞後存入快取
      if (activeReadingComicId !== null && preloaderState.queue[0]?.id === item.id && buf && buf.length <= 50 * 1024 * 1024) {
        evictRamCache(buf.length);
        totalRamCacheBytes += buf.length;
        bookCache.set(nextPageIndex, { buf, ext });
        
        // 如果是當前正在閱讀的書，向前端報告進度！
        if (mainWindow && !mainWindow.isDestroyed() && item.id === activeReadingComicId) {
          mainWindow.webContents.send('ram-cache-progress', { id: item.id, loaded: bookCache.size, total: item.totalPages });
        }
      }

      // 每次讀取完稍微讓出主線程，避免佔用 CPU 導致操作卡頓
      await new Promise(resolve => setTimeout(resolve, 8));
    } catch (e) {
      console.error(`❌ 背景智慧預載 [漫畫 ${item.id}，第 ${nextPageIndex} 頁] 失敗:`, e);
      if (!preloadFailuresPool.has(item.id)) preloadFailuresPool.set(item.id, new Map());
      const fails = preloadFailuresPool.get(item.id);
      fails.set(nextPageIndex, (fails.get(nextPageIndex) || 0) + 1);
    }
  }

  preloaderState.isPreloading = false;
  console.log(`⏹️ 背景智慧預載已停止（隊列已空，或閱讀器已關閉）。`);
}

// ======================================================
// 封面磁碟快取
// ======================================================
const coverMemCache = new Map(); // id:pageIndex -> { buf, mime }

function getCoverCachePath(id, ext) {
  return path.join(COVER_CACHE_DIR, `${id}_p0${ext}`);
}

function findCoverCache(id) {
  try {
    const files = fs.readdirSync(COVER_CACHE_DIR).filter(f => f.startsWith(`${id}_p0`));
    return files.length > 0 ? path.join(COVER_CACHE_DIR, files[0]) : null;
  } catch(e) { return null; }
}

function clearCoverCacheDirectory() {
  try {
    for (const entry of fs.readdirSync(COVER_CACHE_DIR)) {
      fs.rmSync(path.join(COVER_CACHE_DIR, entry), { recursive: true, force: true });
    }
  } catch (e) {
    console.error('clearCoverCacheDirectory error:', e);
  }
}

// ======================================================
// 書架掃描
// ======================================================
let cachedComics = [];
let isScanning = false;
let pendingScan = false;
let scanHadError = false;
let scanProgress = { isScanning: false, found: 0, currentPath: '', startedAt: null, completedAt: null };
let lastScanProgressEmit = 0;

function getScanProgress() {
  return { ...scanProgress };
}

function emitScanProgress(force = false) {
  const now = Date.now();
  if (!force && now - lastScanProgressEmit < 500) return;
  lastScanProgressEmit = now;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scan-progress', getScanProgress());
  }
}

async function scanDirectory(dir, rootDir, scannedIds, progressData, depth = 0) {
  if (hasReachedScanDepth(depth)) return;
  scanProgress.currentPath = dir;
  emitScanProgress();
  let files;
  try { files = await fs.promises.readdir(dir); } catch(e) { scanHadError = true; return; }

  let hasImages = false;
  const subdirs = [], archives = [];

  await Promise.all(files.map(async (file) => {
    if (file.startsWith('.') || file === 'node_modules' || file === '.git' || file === 'public' || file.includes('__MACOSX')) return;
    const fullPath = path.join(dir, file);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isDirectory()) {
        subdirs.push({ file, fullPath });
      } else {
        const ext = path.extname(file).toLowerCase();
        if (IMAGE_EXTENSIONS.includes(ext)) hasImages = true;
        else if (ext === '.cbz' || ext === '.zip') archives.push({ file, fullPath, stat });
      }
    } catch(e) {}
  }));

  if (hasImages && path.relative(rootDir, dir) !== '') {
    try {
      const stat = await fs.promises.stat(dir);
      addComicToCache(path.relative(rootDir, dir), 'folder', dir, stat, scannedIds, progressData);
    } catch(e) {}
  }

  for (const a of archives) {
    const relPath = path.relative(rootDir, a.fullPath);
    addComicToCache(relPath, 'archive', a.fullPath, a.stat, scannedIds, progressData);
  }

  for (const sub of subdirs) {
    await scanDirectory(sub.fullPath, rootDir, scannedIds, progressData, depth + 1);
  }
}

function addComicToCache(relativePath, type, filePath, stat, scannedIds, progressData = getProgress()) {
  const id = Buffer.from(relativePath).toString('base64url');
  scannedIds.add(id);

  const savedProgress = progressData[id] || { currentPage: 0, totalPages: 0, percent: 0, updatedAt: null };
  const mtimeMs = stat.mtime.getTime();

  let pageCount = savedProgress.totalPages || 0;
  if (pageCount === 0 && comicMetadata[id]) {
    const meta = comicMetadata[id];
    if (meta.mtime === mtimeMs && meta.pageCount > 0) {
      pageCount = meta.pageCount;
    }
  }

  const ext = type === 'folder' ? '' : path.extname(filePath).toLowerCase();

  const item = {
    id, type, relativePath,
    ext,
    title: type === 'folder' ? path.basename(filePath) : path.basename(filePath, path.extname(filePath)),
    series: path.dirname(relativePath) === '.' ? '未分類' : path.dirname(relativePath),
    updatedAt: stat.mtime,
    pageCount,
    progress: savedProgress,
  };

  const idx = cachedComics.findIndex(c => c.id === id);
  if (idx === -1) {
    cachedComics.push(item);
  } else {
    item.progress = cachedComics[idx].progress;
    if (item.pageCount === 0) item.pageCount = cachedComics[idx].pageCount;
    cachedComics[idx] = item;
  }
  scanProgress.found = scannedIds.size;
  emitScanProgress();
}

async function doBackgroundScan() {
  if (isScanning) {
    pendingScan = true;
    return;
  }
  isScanning = true;
  pendingScan = false;
  scanHadError = false;
  scanProgress = { isScanning: true, found: 0, currentPath: currentScanDir, startedAt: new Date().toISOString(), completedAt: null };
  emitScanProgress(true);
  console.log('⏳ 掃描漫畫庫:', currentScanDir);
  
  // 記錄掃描前的狀態快照
  const getSnapshotStr = () => JSON.stringify(cachedComics.map(c => ({
    id: c.id,
    mtime: c.updatedAt?.getTime ? c.updatedAt.getTime() : new Date(c.updatedAt).getTime()
  })));
  const beforeSnapshot = getSnapshotStr();

  const scannedIds = new Set();
  const progressData = getProgress();
  try {
    await scanDirectory(currentScanDir, currentScanDir, scannedIds, progressData);
    if (!scanHadError) {
      cachedComics = cachedComics.filter(c => scannedIds.has(c.id));
    }
    console.log(`✅ 掃描完成，共 ${cachedComics.length} 本漫畫`);
  } catch(e) {
    console.error('掃描失敗:', e);
  } finally {
    isScanning = false;
    scanProgress = { ...scanProgress, isScanning: false, found: cachedComics.length, currentPath: currentScanDir, completedAt: new Date().toISOString() };
    emitScanProgress(true);
    
    if (pendingScan) setTimeout(doBackgroundScan, 100);

    // 比對掃描後的狀態快照
    const afterSnapshot = getSnapshotStr();
    if (beforeSnapshot !== afterSnapshot) {
      console.log('⚡ [Scanner] 偵測到漫畫檔案或修改時間真實變更，通知前端刷新！');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library-changed');
      }
    } else {
      console.log('⚡ [Scanner] 漫畫庫實體檔案無實質變更，跳過前端刷新以防閃爍！');
    }
  }
}

// ======================================================
// 資料夾模式的圖片清單
// ======================================================
const FOLDER_IMAGE_LIST_CACHE_MAX = 80;
const folderImageListCache = new Map();

function pruneFolderImageListCache() {
  if (folderImageListCache.size <= FOLDER_IMAGE_LIST_CACHE_MAX) return;
  const oldest = Array.from(folderImageListCache.entries())
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess)
    .slice(0, folderImageListCache.size - FOLDER_IMAGE_LIST_CACHE_MAX);
  oldest.forEach(([folderPath]) => folderImageListCache.delete(folderPath));
}

function getCachedFolderImages(folderPath) {
  try {
    const stat = fs.statSync(folderPath);
    const cached = folderImageListCache.get(folderPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      cached.lastAccess = Date.now();
      return cached.images;
    }

    const images = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && isImage(entry.name) && !isSystemFile(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    folderImageListCache.set(folderPath, { mtimeMs: stat.mtimeMs, images, lastAccess: Date.now() });
    pruneFolderImageListCache();
    return images;
  } catch(e) {
    return [];
  }
}

function getFolderImages(folderPath) {
  return getCachedFolderImages(folderPath);
}

function clearZipHandleCache() {
  for (const handle of zipHandleCache.values()) {
    try {
      handle.zipfile.close();
    } catch (e) {}
  }
  zipHandleCache.clear();
}

function clearReaderCaches() {
  clearZipHandleCache();
  folderImageListCache.clear();
  coverMemCache.clear();
  ramCachePool.clear();
  preloadFailuresPool.clear();
  cachedComics = [];
  activeReadingComicId = null;
  preloaderState.queue = [];
  preloaderState.isPreloading = false;
  scanProgress = { isScanning: false, found: 0, currentPath: currentScanDir, startedAt: null, completedAt: null };
  clearCoverCacheDirectory();
}

// ======================================================
// comic:// 自訂協定 — 圖片直接串流給 renderer
// ======================================================
function getMime(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  // SVG is served as inert data so uploaded markup cannot execute as active content.
  if (ext === '.svg') return 'application/octet-stream';
  return 'image/jpeg';
}

function isStrictBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').toString('base64url') === value;
  } catch (e) {
    return false;
  }
}

function isStrictPageIndex(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
}

function isWithinDirectory(candidate, directory) {
  return candidate === directory || candidate.startsWith(directory + path.sep);
}

function registerComicProtocol() {
  // comic://page/{id}/{pageIndex}        — 取得漫畫特定頁
  // comic://cover/{id}                   — 取得封面 (page 0)
  // comic://folder/{base64path}/{index}  — 資料夾圖片
  protocol.handle('comic', async (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname; // 'page', 'cover', 'folder'
      const parts = url.pathname.split('/').filter(Boolean);

      if (host === 'folder') {
        // comic://folder/{base64folderPath}/{index}
        if (parts.length !== 2 || !isStrictBase64Url(parts[0]) || !isStrictPageIndex(parts[1])) {
          return new Response('invalid folder path', { status: 400 });
        }
        const folderPath = Buffer.from(parts[0], 'base64url').toString('utf-8');
        const index = Number(parts[1]);

        let resolvedFolder;
        let resolvedScanDir;
        try {
          resolvedFolder = fs.realpathSync(folderPath);
          resolvedScanDir = fs.realpathSync(currentScanDir);
        } catch (e) {
          return new Response('invalid folder path', { status: 403 });
        }
        if (!isWithinDirectory(resolvedFolder, resolvedScanDir)) {
          return new Response('forbidden', { status: 403 });
        }
        
        const folderId = parts[0];
        const images = getFolderImages(folderPath);
        if (index < 0 || index >= images.length) return new Response('not found', { status: 404 });

        // 🚀 檢查是否在極致 RAM 快取中
        if (ramCachePool.has(folderId)) {
          const bookCache = ramCachePool.get(folderId);
          if (bookCache.has(index)) {
            const cached = bookCache.get(index);
            return new Response(cached.buf, { headers: { 'Content-Type': getMime(cached.ext), 'Cache-Control': 'public, max-age=86400' } });
          }
        }

        const imgPath = path.join(folderPath, images[index]);
        const ext = path.extname(images[index]).toLowerCase();
        const data = await readImageFile(imgPath);

        // 寫入極致 RAM 快取
        if (activeReadingComicId === folderId) {
          if (!ramCachePool.has(folderId)) ramCachePool.set(folderId, new Map());
          ramCachePool.get(folderId).set(index, { buf: data, ext });
        }

        return new Response(data, { headers: { 'Content-Type': getMime(ext) } });
      }

      if (host === 'page' || host === 'cover') {
        if (!parts[0] || !isStrictBase64Url(parts[0]) || (host === 'cover' && parts.length !== 1) || (host === 'page' && (parts.length !== 2 || !isStrictPageIndex(parts[1])))) {
          return new Response('invalid page path', { status: 400 });
        }
        const id = parts[0];
        const pageIndex = host === 'cover' ? 0 : Number(parts[1]);

        // 🚀 檢查是否在極致 RAM 快取中
        if (ramCachePool.has(id)) {
          const bookCache = ramCachePool.get(id);
          if (bookCache.has(pageIndex)) {
            const cached = bookCache.get(pageIndex);
            return new Response(cached.buf, { headers: { 'Content-Type': getMime(cached.ext), 'Cache-Control': 'public, max-age=86400' } });
          }
        }

        const relativePath = Buffer.from(id, 'base64url').toString('utf-8');
        const fullPath = path.join(currentScanDir, relativePath);

        // 檢查路徑安全
        let resolvedPath, resolvedScanDir;
        try {
          resolvedPath = fs.realpathSync(fullPath);
          resolvedScanDir = fs.realpathSync(currentScanDir);
        } catch(e) { return new Response('invalid path', { status: 403 }); }
        if (!resolvedPath.startsWith(resolvedScanDir + path.sep) && resolvedPath !== resolvedScanDir) {
          return new Response('forbidden', { status: 403 });
        }

        // 檢查是否為資料夾漫畫
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
          const images = getFolderImages(fullPath);
          if (pageIndex >= images.length) return new Response('not found', { status: 404 });
          const imgPath = path.join(fullPath, images[pageIndex]);
          const ext = path.extname(images[pageIndex]).toLowerCase();
          const data = await readImageFile(imgPath);

          // 寫入極致 RAM 快取
          if (activeReadingComicId === id && data.length <= 50 * 1024 * 1024) {
            if (!ramCachePool.has(id)) ramCachePool.set(id, new Map());
            evictRamCache(data.length);
            totalRamCacheBytes += data.length;
            ramCachePool.get(id).set(pageIndex, { buf: data, ext });
          }

          return new Response(data, { headers: { 'Content-Type': getMime(ext), 'Cache-Control': 'public, max-age=86400' } });
        }

        // 封面先查磁碟快取
        if (pageIndex === 0) {
          const memKey = `${id}:0`;
          if (coverMemCache.has(memKey)) {
            const c = coverMemCache.get(memKey);
            return new Response(c.buf, { headers: { 'Content-Type': c.mime, 'Cache-Control': 'public, max-age=86400' } });
          }
          const diskPath = findCoverCache(id);
          if (diskPath) {
            const ext = path.extname(diskPath).toLowerCase();
            const data = await readImageFile(diskPath);
            return new Response(data, { headers: { 'Content-Type': getMime(ext), 'Cache-Control': 'public, max-age=86400' } });
          }
        }

        // YauzlHandle 讀取
        const handle = await getZipHandle(id, fullPath);
        const buf = await readPageBuffer(handle, pageIndex);
        const ext = path.extname(handle.entryNames[pageIndex]).toLowerCase();
        const mime = getMime(ext);

        // 寫入極致 RAM 快取
        if (activeReadingComicId === id && buf.length <= 50 * 1024 * 1024) {
          if (!ramCachePool.has(id)) ramCachePool.set(id, new Map());
          evictRamCache(buf.length);
          totalRamCacheBytes += buf.length;
          ramCachePool.get(id).set(pageIndex, { buf, ext });
        }

        // 封面寫磁碟快取
        if (pageIndex === 0) {
          const memKey = `${id}:0`;
          if (coverMemCache.size < 200) coverMemCache.set(memKey, { buf, mime });
          fs.promises.writeFile(getCoverCachePath(id, ext), buf).catch(() => {});
        }

        return new Response(buf, { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' } });
      }

      return new Response('unknown route', { status: 404 });
    } catch(e) {
      console.error('comic:// protocol error:', e);
      return new Response(e.message, { status: 500 });
    }
  });
}

// ======================================================
// IPC Handlers
// ======================================================
function setupIPC() {
  // 書架
  ipcMain.handle('get-library', async () => {
    if (!isScanning && cachedComics.length === 0) await doBackgroundScan();
    const progressData = getProgress();
    return [...cachedComics]
      .map(c => ({ ...c, progress: progressData[c.id] || c.progress }))
      .sort((a, b) => {
        const ta = new Date(a.progress.updatedAt || a.updatedAt).getTime();
        const tb = new Date(b.progress.updatedAt || b.updatedAt).getTime();
        return tb - ta;
      });
  });

  ipcMain.handle('scan-library', async () => {
    await doBackgroundScan();
    return true;
  });

  ipcMain.handle('get-scan-status', () => getScanProgress());

  // 打開漫畫（取得頁數和 comic:// URL 陣列）
  ipcMain.handle('open-comic', async (_, id) => {
    const relativePath = Buffer.from(id, 'base64url').toString('utf-8');
    const fullPath = path.join(currentScanDir, relativePath);
    
    // BUG-16 修正： Electron 模式不支援 SMB，認得漫畫類型後回傳清楚錯誤
    const matchedComic = cachedComics.find(c => c.id === id);
    if (matchedComic && (matchedComic.type === 'smb-archive' || matchedComic.type?.startsWith('smb-'))) {
      throw new Error('此漫畫儲存於 SMB 云端，目前指點閱讀模式不支援 SMB 直接開啟，請確認連線狀態。');
    }
    
    if (!fs.existsSync(fullPath)) throw new Error('找不到漫畫！');

    const isDir = fs.statSync(fullPath).isDirectory();
    const title = isDir ? path.basename(fullPath) : path.basename(fullPath, path.extname(fullPath));

    let pages = [];
    let filenames = [];
    if (isDir) {
      const imgs = getFolderImages(fullPath);
      filenames = imgs;
      const folderBase64 = Buffer.from(fullPath).toString('base64url');
      pages = imgs.map((_, i) => `comic://folder/${folderBase64}/${i}`);
    } else {
      const handle = await getZipHandle(id, fullPath);
      pages = handle.entryNames.map((_, i) => `comic://page/${id}/${i}`);

      // 更新頁數 metadata
      if (!comicMetadata[id] || comicMetadata[id].pageCount !== pages.length) {
        const stat = await fs.promises.stat(fullPath);
        comicMetadata[id] = { pageCount: pages.length, mtime: stat.mtime.getTime() };
        saveMetadata();
      }
    }

    const progressData = getProgress();
    const progress = progressData[id] || { currentPage: 0, totalPages: pages.length, percent: 0 };

    // 🚀 智慧預載排程管理器
    activeReadingComicId = id;
    preloaderState.queue = []; // 清空預載隊列
    
    // 限制快取池大小，防止記憶體無限增長 (最多保留 3 本最親近的漫畫)
    if (ramCachePool.size >= 3) {
      for (const [cid] of ramCachePool) {
        if (cid !== activeReadingComicId && (!preloaderState.queue.length || cid !== preloaderState.queue[0].id)) {
          ramCachePool.delete(cid);
          preloadFailuresPool.delete(cid);
          if (ramCachePool.size < 3) break;
        }
      }
    }
    
    // 確保當前書在快取池中有初始化
    if (!ramCachePool.has(id)) {
      ramCachePool.set(id, new Map());
    }

    // 1. 首要隊列項目：當前正在閱讀的書
    preloaderState.queue.push({
      id,
      fullPath,
      isDir,
      totalPages: pages.length
    });

    // 2. 第二隊列項目：同目錄底下的其他漫畫（鄰近卷數）
    try {
      const currentComic = cachedComics.find(c => c.id === id);
      if (currentComic) {
        const parentDir = path.dirname(currentComic.relativePath);
        const siblings = cachedComics
          .filter(c => (c.type === 'folder' || c.type === 'archive') && path.dirname(c.relativePath) === parentDir && c.id !== id)
          .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
        
        siblings.forEach(sib => {
          const sibFullPath = path.join(currentScanDir, sib.relativePath);
          preloaderState.queue.push({
            id: sib.id,
            fullPath: sibFullPath,
            isDir: sib.type === 'folder',
            totalPages: sib.pageCount || 0
          });
        });
      }
    } catch(e) {
      console.error('加入同目錄預載失敗:', e);
    }

    // 3. 第三隊列項目：上次看到一半的書
    try {
      const halfRead = Object.keys(progressData)
        .filter(cid => {
          const prog = progressData[cid];
          return prog && prog.currentPage > 0 && prog.percent < 98 && cid !== id;
        })
        .sort((a, b) => new Date(progressData[b].updatedAt || 0) - new Date(progressData[a].updatedAt || 0));

      halfRead.forEach(cid => {
        const comic = cachedComics.find(c => c.id === cid);
        if (comic) {
          const cFullPath = path.join(currentScanDir, comic.relativePath);
          preloaderState.queue.push({
            id: cid,
            fullPath: cFullPath,
            isDir: comic.type === 'folder',
            totalPages: comic.pageCount || 0
          });
        }
      });
    } catch(e) {
      console.error('加入未讀完漫畫預載失敗:', e);
    }

    // 🚀 初始化發送載入進度 %
    if (mainWindow && !mainWindow.isDestroyed()) {
      const loadedCount = ramCachePool.get(id).size;
      mainWindow.webContents.send('ram-cache-progress', { id, loaded: loadedCount, total: pages.length });
    }

    // 啟動背景智慧預載！
    startSmartPreloader().catch(err => {
      console.error('啟動背景智慧預載錯誤:', err);
    });

    return { id, title, pages, filenames, isDir, progress };
  });

  // 🗑️ 關閉閱讀器，釋放 RAM 快取以節省記憶體
  ipcMain.handle('close-comic', () => {
    console.log('⏹️ 閱讀器關閉，清理預載隊列與 RAM 快取以節省資源！(姬米妮節能優化 ✨)');
    activeReadingComicId = null;
    preloaderState.queue = [];
    ramCachePool.clear(); // 徹底釋放 RAM 快取，不看書就不佔用記憶體！
    totalRamCacheBytes = 0;
    preloadFailuresPool.clear();
    return { success: true };
  });

  // 儲存閱讀進度
  ipcMain.handle('save-progress', (_, { id, currentPage, totalPages }) => {
    const data = getProgress();
    data[id] = {
      currentPage,
      totalPages,
      percent: totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0,
      updatedAt: new Date().toISOString()
    };
    saveProgress(data);
    // 同步更新 cache
    const comic = cachedComics.find(c => c.id === id);
    if (comic) comic.progress = data[id];
    return { success: true };
  });

  // 獲取收藏清單
  ipcMain.handle('get-favorites', () => getFavorites());

  // 切換收藏狀態
  ipcMain.handle('toggle-favorite', (_, id) => {
    const favs = getFavorites();
    const idx = favs.indexOf(id);
    if (idx >= 0) {
      favs.splice(idx, 1);
    } else {
      favs.push(id);
    }
    saveFavorites(favs);
    return favs;
  });

  // 讀取設定
  ipcMain.handle('get-config', () => ({ scanDir: currentScanDir }));

  // 儲存設定
  ipcMain.handle('set-config', async (_, { scanDir }) => {
    let resolved;
    try {
      resolved = fs.realpathSync(scanDir);
    } catch (e) {
      throw new Error(`路徑不存在或無法存取：${scanDir}`);
    }
    saveConfig(resolved);
    clearReaderCaches();
    doBackgroundScan();
    watchScanDir(); // 重新監聽新目錄
    return { success: true, scanDir: resolved };
  });

  // 原生資料夾選擇器
  ipcMain.handle('open-folder-dialog', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win || mainWindow, {
      title: '選擇漫畫資料夾',
      properties: ['openDirectory'],
      buttonLabel: '選擇此資料夾'
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 瀏覽資料夾
  ipcMain.handle('browse-folders', async (_, dirPath) => {
    const targetPath = dirPath || currentScanDir;
    let resolved;
    try {
      resolved = fs.realpathSync(targetPath);
    } catch (e) {
      resolved = path.resolve(targetPath); // Fallback for browse-folders if realpath fails
    }
    const parentPath = path.dirname(resolved);
    const isRoot = resolved === parentPath;

    let files;
    try { files = await fs.promises.readdir(resolved); } catch(e) { return { currentPath: resolved, parentPath: null, folders: [] }; }

    const folderStats = await Promise.all(
      files
        .filter(f => !f.startsWith('.') && !f.includes('__MACOSX'))
        .map(async f => {
          try {
            const fp = path.join(resolved, f);
            const stat = await fs.promises.stat(fp);
            return stat.isDirectory() ? { name: f, path: fp } : null;
          } catch(e) { return null; }
        })
    );

    return {
      currentPath: resolved,
      parentPath: isRoot ? null : parentPath,
      folders: folderStats.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
    };
  });

  ipcMain.handle('show-item-in-folder', async (_, itemPath) => {
    try {
      const fullPath = path.isAbsolute(itemPath) ? itemPath : path.join(currentScanDir, itemPath);
      shell.showItemInFolder(fullPath);
      return true;
    } catch (err) {
      console.error('showItemInFolder error:', err);
      return false;
    }
  });

  // 🗑️ 將資料夾漫畫的指定頁面圖片移到系統垃圾桶
  ipcMain.handle('trash-page', async (_, { comicId, pageIndex }) => {
    try {
      const relativePath = Buffer.from(comicId, 'base64url').toString('utf-8');
      const fullPath = path.join(currentScanDir, relativePath);

      // BUG-12 修正：加入路徑越權防護
      let resolvedPath, resolvedScanDir;
      try {
        resolvedPath = fs.realpathSync(fullPath);
        resolvedScanDir = fs.realpathSync(currentScanDir);
      } catch (e) {
        return { success: false, error: 'invalid path or symlink' };
      }
      
      if (!resolvedPath.startsWith(resolvedScanDir + path.sep) && resolvedPath !== resolvedScanDir) {
        return { success: false, error: 'forbidden: path traversal detected' };
      }

      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) {
        return { success: false, error: 'cbz-not-supported' };
      }

      const imgs = getFolderImages(fullPath);
      if (pageIndex < 0 || pageIndex >= imgs.length) {
        return { success: false, error: 'index-out-of-range' };
      }

      const imgPath = path.join(fullPath, imgs[pageIndex]);
      await shell.trashItem(imgPath);

      // 清除資料夾圖片快取，讓下次重新讀取
      folderImageListCache.delete(fullPath);

      return { success: true, filename: imgs[pageIndex] };
    } catch (err) {
      console.error('trash-page error:', err);
      return { success: false, error: err.message };
    }
  });
}

// ======================================================
// 視窗偏好
// ======================================================
const PREFS_FILE = path.join(app.getPath('userData'), 'window-prefs.json');
function loadWindowPrefs() {
  try { if (fs.existsSync(PREFS_FILE)) return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); } catch(e) {}
  return { width: 1280, height: 800 };
}
function saveWindowPrefs(win) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(win.getBounds()), 'utf-8'); } catch(e) {}
}

let mainWindow = null;

// ======================================================
// macOS 選單列
// ======================================================
function setAppMenu() {
  const template = [
    {
      label: '少女漫畫閣',
      submenu: [
        { label: '關於少女漫畫閣', role: 'about' },
        { type: 'separator' },
        { label: '偏好設定…', accelerator: 'Cmd+,', click: () => mainWindow?.webContents.executeJavaScript('openSettingsModal()') },
        { type: 'separator' },
        { label: '結束', role: 'quit' }
      ]
    },
    {
      label: '書架',
      submenu: [
        { label: '重新整理書架', accelerator: 'Cmd+R', click: () => mainWindow?.webContents.executeJavaScript('fetchLibrary()') },
        { label: '選擇漫畫資料夾…', accelerator: 'Cmd+O', click: async () => {
          const result = await dialog.showOpenDialog(mainWindow, { title: '選擇漫畫資料夾', properties: ['openDirectory'] });
          if (!result.canceled && result.filePaths.length > 0) {
            mainWindow?.webContents.executeJavaScript(`saveSettingsPath(${JSON.stringify(result.filePaths[0])})`);
          }
        }}
      ]
    },
    {
      label: '閱讀',
      submenu: [
        { label: '上一頁', click: () => mainWindow?.webContents.executeJavaScript('prevPage()') },
        { label: '下一頁', click: () => mainWindow?.webContents.executeJavaScript('nextPage()') },
        { type: 'separator' },
        { label: '全螢幕', accelerator: 'Cmd+Ctrl+F', role: 'togglefullscreen' }
      ]
    },
    { label: '視窗', role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ======================================================
// 建立主視窗
// ======================================================
function createWindow() {
  const prefs = loadWindowPrefs();
  mainWindow = new BrowserWindow({
    width: prefs.width || 1280,
    height: prefs.height || 800,
    x: prefs.x, y: prefs.y,
    minWidth: 800, minHeight: 600,
    title: '少女漫畫閣',
    backgroundColor: '#0b0f19',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false
  });

  // 直接讀取本地 HTML，不需要 HTTP server！
  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => saveWindowPrefs(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  setAppMenu();
}

// ======================================================
// App 生命週期
// ======================================================
// 在 ready 前就要 handle protocol
protocol.registerSchemesAsPrivileged([
  { scheme: 'comic', privileges: { standard: false, secure: true, supportFetchAPI: true, bypassCSP: true } }
]);

app.whenReady().then(() => {
  loadConfig();
  loadMetadata();
  registerComicProtocol();
  setupIPC();
  createWindow();
  doBackgroundScan();
  watchScanDir();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
