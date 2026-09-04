import express from 'express';
import path from 'path';
import fs from 'fs';
import open from 'open';
import yauzl from 'yauzl';
import os from 'os';
import { fileURLToPath } from 'url';
import { hasReachedScanDepth } from './scan-depth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const requestedPort = Number(process.env.GAI_PORT || 4000);
const PORT = Number.isSafeInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
  ? requestedPort
  : 4000;

const BASE_DIR = path.resolve(process.env.GAI_BASE_DIR || __dirname);
const PROGRESS_FILE = path.join(BASE_DIR, 'progress.json');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const METADATA_FILE = path.join(BASE_DIR, 'metadata.json');
const COVER_CACHE_DIR = path.join(BASE_DIR, 'cache', 'covers');
const SERVER_CACHE_DIR = path.dirname(COVER_CACHE_DIR);
if (!fs.existsSync(COVER_CACHE_DIR)) {
  fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
}

let currentComicDir = BASE_DIR;
let comicMetadata = {};

// 讀取設定
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (typeof config.scanDir === 'string' && config.scanDir.length > 0 && !config.scanDir.includes('\0')) {
        const configuredPath = path.resolve(config.scanDir.replace(/^~(?=\/|$)/, os.homedir()));
        const canonicalPath = fs.realpathSync(configuredPath);
        if (fs.statSync(canonicalPath).isDirectory()) {
          currentComicDir = canonicalPath;
        }
      }
    } catch (e) {
      console.error('讀取設定失敗，使用預設值。', e);
    }
  }
}
loadConfig();

// 讀取本地中繼資料 (Kavita/Komga 級快取資料庫)
function loadMetadata() {
  if (fs.existsSync(METADATA_FILE)) {
    try {
      comicMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
    } catch (e) {
      console.error('讀取 metadata.json 失敗：', e);
    }
  }
}
loadMetadata();

// 保存本地中繼資料
function saveMetadata() {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(comicMetadata, null, 2), 'utf-8');
  } catch (e) {
    console.error('儲存 metadata.json 失敗：', e);
  }
}

// 瀏覽器 API 僅接受同源請求；server 本身只綁定 loopback，避免被區網直接存取。
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!origin) return next();
  try {
    const originUrl = new URL(origin);
    const requestHost = String(req.get('Host') || '').toLowerCase();
    if (originUrl.protocol !== 'http:' || originUrl.host.toLowerCase() !== requestHost) {
      return res.status(403).json({ error: '僅允許同源請求！' });
    }
  } catch (e) {
    return res.status(403).json({ error: '無效的來源！' });
  }
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 支援的圖片副檔名
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function isImage(filename) {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

function getImageMime(ext) {
  switch (String(ext || '').toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    // SVG is served as inert data so uploaded markup cannot execute as active content.
    case '.svg': return 'application/octet-stream';
    case '.avif': return 'image/avif';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
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
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string'
    && /^(0|[1-9]\d*)$/.test(value)
    && Number.isSafeInteger(Number(value));
}

function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveComicPath(id) {
  if (!isStrictBase64Url(id)) return { status: 400, error: '漫畫識別碼格式不正確！' };
  const relativePath = Buffer.from(id, 'base64url').toString('utf-8');
  if (!relativePath || relativePath.includes('\0')) return { status: 403, error: '無效的路徑存取！' };
  const candidate = path.resolve(currentComicDir, relativePath);
  if (!isPathWithin(path.resolve(currentComicDir), candidate)) {
    return { status: 403, error: '無效的路徑存取！' };
  }
  if (!fs.existsSync(candidate)) return { status: 404, error: '找不到該漫畫檔案或路徑！' };
  try {
    const canonicalLibrary = fs.realpathSync(currentComicDir);
    const canonicalCandidate = fs.realpathSync(candidate);
    if (!isPathWithin(canonicalLibrary, canonicalCandidate)) {
      return { status: 403, error: '漫畫路徑超出書庫範圍！' };
    }
    return { relativePath, fullPath: canonicalCandidate };
  } catch (e) {
    return { status: 403, error: '漫畫路徑無法安全解析！' };
  }
}

// 避開系統隱藏檔案與 macOS 垃圾資料夾
function isSystemFile(filepath) {
  const base = path.basename(filepath);
  return base.startsWith('.') || filepath.includes('__MACOSX');
}

function clearCoverCacheDirectory() {
  try {
    for (const entry of fs.readdirSync(COVER_CACHE_DIR)) {
      fs.rmSync(path.join(COVER_CACHE_DIR, entry), { recursive: true, force: true });
    }
  } catch (e) {
    console.error('清理封面快取失敗：', e);
  }
}

// 取得讀取進度
function getProgressData() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch (e) {
    console.error('讀取進度檔案出錯，初始化為空。', e);
    return {};
  }
}

// 儲存讀取進度
function saveProgressData(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 快取記憶體：儲存漫畫 ID -> 總頁數
const pageCountCache = new Map();
// 壓縮檔 Entries 快取，避免重複載入整個 ZIP 元數據 (業界高階優化)
const archiveEntriesCache = new Map();
// 封面圖片快取 (Buffer)，避免重複解壓同一本書的封面
const coverBufferCache = new Map();
const coverDiskCache = new Map();

// ===================================================================
// 🚀 YauzlHandle 常駐快取 (核心效能大殺器！yauzl 版)
// 效能測試 (537MB ZIP):
//   adm-zip new AdmZip():  10,565 ms  ← 卡到天荒地老！
//   yauzl lazyEntries:        30 ms  ← 快了 350 倍！
// 原理：yauzl 不讀整個 ZIP，只 seek 到 central directory，O(1) 時間！
// ===================================================================
const ZIP_HANDLE_CACHE_MAX = 5;
const zipHandleCache = new Map(); // id -> { zipfile, entriesByName, entryNames, lastAccess }

function getZipHandle(id, fullPath) {
  if (zipHandleCache.has(id)) {
    const handle = zipHandleCache.get(id);
    handle.lastAccess = Date.now();
    return Promise.resolve(handle);
  }
  return new Promise((resolve, reject) => {
    // 淘汰最久未存取的
    if (zipHandleCache.size >= ZIP_HANDLE_CACHE_MAX) {
      let oldest = null, oldestTime = Infinity;
      for (const [cid, h] of zipHandleCache) {
        if (h.lastAccess < oldestTime) { oldestTime = h.lastAccess; oldest = cid; }
      }
      if (oldest) {
        try { zipHandleCache.get(oldest).zipfile.close(); } catch(e) {}
        zipHandleCache.delete(oldest);
      }
    }

    // yauzl lazyEntries: 只 seek central directory，對 537MB ZIP 只需 30ms！
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
        const handle = { zipfile, entriesByName, entryNames, lastAccess: Date.now() };
        zipHandleCache.set(id, handle);
        resolve(handle);
      });
      zipfile.on('error', reject);
    });
  });
}

// 從 ZipHandle 讀取指定頁面並回傳 Buffer
function readPageFromHandle(handle, pageIndex) {
  return new Promise((resolve, reject) => {
    if (pageIndex < 0 || pageIndex >= handle.entryNames.length) {
      return reject(new Error('頁碼超出範圍'));
    }
    const entryName = handle.entryNames[pageIndex];
    const entry = handle.entriesByName.get(entryName);
    if (!entry) return reject(new Error('找不到該頁'));
    if (entry.uncompressedSize > MAX_IMAGE_BYTES) {
      const error = new Error('image exceeds size limit');
      error.code = 'IMAGE_TOO_LARGE';
      return reject(error);
    }

    handle.zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let totalBytes = 0;
      stream.on('data', c => {
        totalBytes += c.length;
        if (totalBytes > MAX_IMAGE_BYTES) {
          const error = new Error('image exceeds size limit');
          error.code = 'IMAGE_TOO_LARGE';
          stream.destroy(error);
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

// ===== ZIP 併發控制信號量 (Semaphore) =====
// 書架封面同時最多只允許 3 個並行，翻頁走 YauzlHandle 快取無需信號量！
const ZIP_CONCURRENCY_LIMIT = 3;
let zipActiveCount = 0;
const zipWaitQueue = [];

function acquireZipSlot() {
  return new Promise((resolve) => {
    if (zipActiveCount < ZIP_CONCURRENCY_LIMIT) {
      zipActiveCount++;
      resolve();
    } else {
      zipWaitQueue.push(resolve);
    }
  });
}

function releaseZipSlot() {
  zipActiveCount--;
  if (zipWaitQueue.length > 0) {
    zipActiveCount++;
    const next = zipWaitQueue.shift();
    next();
  }
}

// 全局緩存漫畫清單，實現 0 毫秒 Instant Load
let cachedComics = [];
let isScanning = false;
let pendingScan = false;
let scanHadError = false;
let scanProgress = { isScanning: false, found: 0, currentPath: '', startedAt: null, completedAt: null };

function getScanProgress() {
  return { ...scanProgress };
}

// 同步/非同步解析並更新漫畫頁數快取
async function updateComicPageCount(id, relativePath, type) {
  // 如果記憶體中已經有大於 0 的頁數，就不需要重複解析
  const cachedVal = pageCountCache.get(id);
  if (cachedVal && cachedVal > 0) {
    return cachedVal;
  }

  try {
    const fullPath = path.join(currentComicDir, relativePath);
    if (!fs.existsSync(fullPath)) return 0;

    let pageCount = 0;
    if (type === 'folder') {
      pageCount = await getFolderImageCount(fullPath);
    } else {
      pageCount = await getArchiveImageCount(fullPath, id);
    }

    if (pageCount > 0) {
      pageCountCache.set(id, pageCount);

      // 寫入本地中繼資料庫
      try {
        const stat = await fs.promises.stat(fullPath);
        comicMetadata[id] = {
          pageCount: pageCount,
          mtime: stat.mtime.getTime()
        };
        saveMetadata(); // 即時寫入 metadata.json
      } catch (e) {
        console.error('寫入中繼資料庫失敗：', e);
      }

      // 更新目前記憶體緩存中已載入的漫畫項目
      const item = cachedComics.find(c => c.id === id);
      if (item) {
        item.pageCount = pageCount;
        if (item.progress.totalPages !== pageCount) {
          item.progress.totalPages = pageCount;
          item.progress.percent = pageCount > 0 ? Math.round((item.progress.currentPage / pageCount) * 100) : 0;
        }
      }
      console.log(`⚡ [隨需解析] 成功計算頁數: ${relativePath} -> 共 ${pageCount} 頁`);
    }
    return pageCount;
  } catch (e) {
    console.error(`解析頁數失敗 [id=${id}]:`, e);
    return 0;
  }
}

// 將單一漫畫非同步推送到緩存，實現「掃多少顯示多少」與「頁數 Lazy 隨需載入」
async function addComicToCache(relativePath, type, file, dirStat, scannedIds, progressData = getProgressData()) {
  const id = Buffer.from(relativePath).toString('base64url');
  scannedIds.add(id);

  // 1. 回復已有的進度與頁數（優先從進度檔、中繼資料快取讀取，完全免打開實體檔案，零 NAS 開銷！）
  const savedProgress = progressData[id] || { currentPage: 0, totalPages: 0, percent: 0, updatedAt: null };
  
  const mtimeMs = dirStat.mtime.getTime();
  let savedPageCount = savedProgress.totalPages || pageCountCache.get(id) || 0;

  // 如果記憶體沒有，但 metadata.json 庫有，且檔案修改時間 mtime 吻合，直接秒載！
  if (savedPageCount === 0 && comicMetadata[id]) {
    const meta = comicMetadata[id];
    if (meta.mtime === mtimeMs && meta.pageCount > 0) {
      savedPageCount = meta.pageCount;
      pageCountCache.set(id, savedPageCount);
    }
  }

  const comicItem = {
    id,
    title: type === 'folder' ? path.basename(file) : path.basename(file, path.extname(file)),
    type,
    relativePath,
    series: path.dirname(relativePath) === '.' ? '未分類' : path.dirname(relativePath),
    updatedAt: dirStat.mtime,
    pageCount: savedPageCount,
    progress: savedProgress
  };

  // 即時更新或插入快取
  const existingIdx = cachedComics.findIndex(c => c.id === id);
  if (existingIdx === -1) {
    cachedComics.push(comicItem);
  } else {
    // 保留已讀進度
    comicItem.progress = cachedComics[existingIdx].progress;
    if (comicItem.pageCount === 0) {
      comicItem.pageCount = cachedComics[existingIdx].pageCount;
    }
    cachedComics[existingIdx] = comicItem;
  }
  scanProgress.found = scannedIds.size;

  // 移除背景順序計算佇列，落實業界標準的極致 Lazy Load 優化！
}

// 遞迴順序掃描資料夾 (避免 Promise.all 同時掃描幾千個資料夾造成 V8 記憶體溢出 OOM！)
async function scanDirectory(dir, rootDir, scannedIds, progressData, depth = 0) {
  if (hasReachedScanDepth(depth)) return;
  scanProgress.currentPath = dir;

  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch (e) {
    console.error(`無法讀取目錄: ${dir}`, e);
    scanHadError = true;
    return;
  }

  let hasImages = false;
  let subdirs = [];
  let archives = [];

  // 並行查詢當前目錄下檔案屬性 (單層並行是安全的，不會引發並行爆炸)
  await Promise.all(
    files.map(async (file) => {
      if (file.startsWith('.') || file === 'node_modules' || file === '.git' || file === 'public' || file.includes('__MACOSX')) {
        return;
      }
      const fullPath = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.isDirectory()) {
          if (path.resolve(fullPath) === path.resolve(SERVER_CACHE_DIR)) return;
          subdirs.push({ file, fullPath });
        } else {
          const ext = path.extname(file).toLowerCase();
          if (IMAGE_EXTENSIONS.includes(ext)) {
            hasImages = true;
          } else if (ext === '.cbz' || ext === '.zip') {
            archives.push({ file, fullPath });
          }
        }
      } catch (e) {
        // 忽略單一檔案讀取錯誤
      }
    })
  );

  // 1. 如果目前資料夾包含圖片，將此資料夾本身辨識為一本漫畫，立刻推送至快取！
  if (hasImages) {
    const relativePath = path.relative(rootDir, dir);
    if (relativePath !== "") {
      try {
        const dirStat = await fs.promises.stat(dir);
        await addComicToCache(relativePath, 'folder', dir, dirStat, scannedIds, progressData);
      } catch (e) {}
    }
  }

  // 2. 將所有的 CBZ/ZIP 識別為漫畫，立刻推送至快取！
  for (const archive of archives) {
    const relativePath = path.relative(rootDir, archive.fullPath);
    try {
      const archiveStat = await fs.promises.stat(archive.fullPath);
      await addComicToCache(relativePath, 'archive', archive.file, archiveStat, scannedIds, progressData);
    } catch (e) {}
  }

  // 3. 遞迴「順序」掃描子資料夾！
  // 順序掃描能保證記憶體佔用為恆定的樹深度 O(depth)，徹底避免幾千個目錄並行所導致的記憶體溢出 (OOM)！
  for (const subdir of subdirs) {
    await scanDirectory(subdir.fullPath, rootDir, scannedIds, progressData, depth + 1);
  }
}

// 取得壓縮檔內圖片數量 (高效版)
async function getArchiveImageCount(archivePath, id) {
  if (id && archiveEntriesCache.has(id)) {
    return archiveEntriesCache.get(id).length;
  }
  const entries = await getArchiveImageEntries(archivePath, id);
  return entries.length;
}

// 取得資料夾內圖片數量 (高效版)
async function getFolderImageCount(folderPath) {
  return getCachedFolderImageFiles(folderPath).length;
}

// 取得壓縮檔內排序後的圖片項目 (保留給分頁 API 使用)
async function getArchiveImageEntries(archivePath, id) {
  if (id && archiveEntriesCache.has(id)) {
    return archiveEntriesCache.get(id);
  }
  try {
    const handle = await getZipHandle(id, archivePath);
    if (id && handle.entryNames.length > 0) {
      archiveEntriesCache.set(id, handle.entryNames);
    }
    return handle.entryNames;
  } catch (e) {
    console.error(`解析壓縮檔失敗: ${archivePath}`, e);
    return [];
  }
}

// 取得資料夾內排序後的圖片路徑 (保留給分頁 API 使用)
const FOLDER_IMAGE_LIST_CACHE_MAX = 80;
const folderImageListCache = new Map();

function pruneFolderImageListCache() {
  if (folderImageListCache.size <= FOLDER_IMAGE_LIST_CACHE_MAX) return;
  const oldest = Array.from(folderImageListCache.entries())
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess)
    .slice(0, folderImageListCache.size - FOLDER_IMAGE_LIST_CACHE_MAX);
  oldest.forEach(([folderPath]) => folderImageListCache.delete(folderPath));
}

function getCachedFolderImageFiles(folderPath) {
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
  } catch (e) {
    console.error(`讀取資料夾失敗: ${folderPath}`, e);
    return [];
  }
}

function getFolderImageFiles(folderPath) {
  return getCachedFolderImageFiles(folderPath);
}

function clearZipHandleCache() {
  for (const handle of zipHandleCache.values()) {
    try {
      handle.zipfile.close();
    } catch (e) {}
  }
  zipHandleCache.clear();
}

function clearLibraryCaches() {
  pageCountCache.clear();
  archiveEntriesCache.clear();
  coverBufferCache.clear();
  coverDiskCache.clear();
  clearZipHandleCache();
  folderImageListCache.clear();
  cachedComics = [];
  scanProgress = { isScanning: false, found: 0, currentPath: currentComicDir, startedAt: null, completedAt: null };
  clearCoverCacheDirectory();
}

function getCachedCoverPath(id) {
  const key = `${id}:0`;
  if (coverDiskCache.has(key)) return coverDiskCache.get(key);

  // Cache files are generated with a normalized extension. Probe exact names
  // instead of scanning the whole cache directory or accepting id prefixes.
  for (const extension of IMAGE_EXTENSIONS) {
    const candidate = path.join(COVER_CACHE_DIR, `${id}_p0${extension}`);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size <= MAX_IMAGE_BYTES) {
        coverDiskCache.set(key, candidate);
        return candidate;
      }
    } catch (e) {
      // A missing or unreadable candidate is simply a cache miss.
    }
  }
  coverDiskCache.set(key, null);
  return null;
}

// 背景掃描任務
async function doBackgroundScan() {
  if (isScanning) {
    pendingScan = true;
    return;
  }
  isScanning = true;
  pendingScan = false;
  scanHadError = false;
  scanProgress = { isScanning: true, found: 0, currentPath: currentComicDir, startedAt: new Date().toISOString(), completedAt: null };
  console.log(`⏳ 開始背景靜默掃描漫畫庫... 當前目錄: ${currentComicDir}`);
  const scannedIds = new Set();
  const progressData = getProgressData();
  try {
    // 開始遞迴掃描，漫畫會即時推入 cachedComics，網頁重整就能隨時看到進度！
    await scanDirectory(currentComicDir, currentComicDir, scannedIds, progressData);

    // 掃描結束後，把在磁碟中已被刪除的漫畫從快取中清除，保持完美同步！
    if (!scanHadError) {
      cachedComics = cachedComics.filter(comic => scannedIds.has(comic.id));
    }

    console.log(`✅ 背景靜默掃描完成！共發現 ${cachedComics.length} 本漫畫。`);
  } catch (e) {
    console.error('背景掃描失敗：', e);
  } finally {
    isScanning = false;
    scanProgress = { ...scanProgress, isScanning: false, found: cachedComics.length, currentPath: currentComicDir, completedAt: new Date().toISOString() };
    if (pendingScan) setTimeout(doBackgroundScan, 100);
  }
}

// 啟動時自動觸發一次背景掃描
doBackgroundScan();

// API: 獲取漫畫書架清單與讀取進度 (0 毫秒極速快取回傳版)
app.get('/api/library', (req, res) => {
  try {
    // 偷偷在背景啟動掃描（如果不在掃描中的話）
    if (!isScanning) {
      doBackgroundScan();
    }
    
    // 回傳前，先按照閱讀時間或修改時間排序，給主人最棒的體驗！
    const sorted = [...cachedComics].sort((a, b) => {
      const timeA = new Date(a.progress.updatedAt || a.updatedAt).getTime();
      const timeB = new Date(b.progress.updatedAt || b.updatedAt).getTime();
      return timeB - timeA;
    });

    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: '掃描漫畫庫失敗：' + e.message });
  }
});

app.get('/api/scan-status', (req, res) => {
  res.json(getScanProgress());
});

// API: 獲取漫畫分頁清單
app.get('/api/comic/:id', async (req, res) => {
  try {
    const comic = resolveComicPath(req.params.id);
    if (comic.status) {
      return res.status(comic.status).json({ error: comic.error });
    }
    const { relativePath, fullPath } = comic;

    const isDir = fs.statSync(fullPath).isDirectory();
    const comicType = isDir ? 'folder' : 'archive';

    let pages = [];
    let title = path.basename(fullPath);

    if (isDir) {
      const images = getFolderImageFiles(fullPath);
      pages = images.map((img, index) => `/api/page?id=${req.params.id}&page=${index}`);
      if (!pageCountCache.get(req.params.id)) {
        await updateComicPageCount(req.params.id, relativePath, 'folder');
      }
    } else {
      title = path.basename(fullPath, path.extname(fullPath));

      // 🚀 預先建立 YauzlHandle 常駐快取（yauzl 對 537MB ZIP 只需 30ms！）
      const handle = await getZipHandle(req.params.id, fullPath);
      pages = handle.entryNames.map((entry, index) => `/api/page?id=${req.params.id}&page=${index}`);

      if (!pageCountCache.get(req.params.id)) {
        pageCountCache.set(req.params.id, pages.length);
      }
    }

    const progressData = getProgressData();
    const progress = progressData[req.params.id] || { currentPage: 0, totalPages: pages.length, percent: 0 };

    res.json({
      id: req.params.id,
      title,
      pages,
      progress
    });
  } catch (e) {
    console.error('解析分頁清單出錯：', e);
    res.status(500).json({ error: '解析分頁清單時出錯：' + e.message });
  }
});

// API: 串流載入特定分頁圖片
// 架構：優先走 YauzlHandle 常駐快取（翻頁超快！），封面二級快取加速回傳
async function serveComicPage(req, res, forcedPage = null) {
  try {
    const { id, page } = req.query;
    if (!id || (forcedPage === null && page === undefined)) {
      return res.status(400).json({ error: '缺少 id 或 page 參數！' });
    }

    // Validate the raw capability token before using it for caches or filesystem paths.
    if (!isStrictBase64Url(id)) {
      return res.status(400).json({ error: '漫畫識別碼格式不正確！' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const relativePath = Buffer.from(id, 'base64url').toString('utf-8');
    const fullPath = path.resolve(currentComicDir, relativePath);
    const rawPage = forcedPage === null ? page : forcedPage;
    const pageIndex = Number(rawPage);

    if (!isStrictPageIndex(rawPage)) {
      return res.status(400).json({ error: '頁碼格式不正確！' });
    }

    const rel = path.relative(currentComicDir, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(403).json({ error: '無效的路徑存取！' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: '找不到指定的漫畫！' });
    }

    let canonicalLibrary;
    let canonicalComic;
    try {
      canonicalLibrary = fs.realpathSync(currentComicDir);
      canonicalComic = fs.realpathSync(fullPath);
    } catch (e) {
      return res.status(403).json({ error: '漫畫路徑無法安全解析！' });
    }
    const canonicalRel = path.relative(canonicalLibrary, canonicalComic);
    if (canonicalRel.startsWith('..') || path.isAbsolute(canonicalRel)) {
      return res.status(403).json({ error: '漫畫路徑超出書庫範圍！' });
    }

    const isDir = fs.statSync(fullPath).isDirectory();

    if (isDir) {
      const images = getFolderImageFiles(fullPath);
      if (pageIndex >= images.length) {
        return res.status(404).json({ error: '頁碼超出範圍！' });
      }
      const imagePath = path.join(fullPath, images[pageIndex]);
      let canonicalImage;
      try {
        canonicalImage = fs.realpathSync(imagePath);
      } catch (e) {
        return res.status(404).json({ error: '找不到指定圖片！' });
      }
      const imageRel = path.relative(canonicalComic, canonicalImage);
      if (imageRel.startsWith('..') || path.isAbsolute(imageRel)) {
        return res.status(403).json({ error: '圖片路徑超出漫畫資料夾範圍！' });
      }
      const imageStat = fs.statSync(canonicalImage);
      if (imageStat.size > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: '圖片超過 64 MiB 上限！' });
      }
      res.setHeader('Content-Type', getImageMime(path.extname(canonicalImage)));
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(canonicalImage);
    }

    if (pageIndex === 0) {
      const coverKey = `${id}:0`;
      if (coverBufferCache.has(coverKey)) {
        const cached = coverBufferCache.get(coverKey);
        res.setHeader('Content-Type', cached.mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.end(cached.buf);
      }

      const cached = getCachedCoverPath(id);
      if (cached) {
        const ext = path.extname(cached).toLowerCase();
        const mime = getImageMime(ext);
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(cached);
      }
    }

    const handle = await getZipHandle(id, fullPath);

    if (pageIndex >= handle.entryNames.length) {
      return res.status(404).json({ error: '頁碼超出範圍！' });
    }

    const buffer = await readPageFromHandle(handle, pageIndex);
    const entryExt = path.extname(handle.entryNames[pageIndex]).toLowerCase();
    const mimeType = getImageMime(entryExt);

    if (pageIndex === 0) {
      const cacheFilePath = path.join(COVER_CACHE_DIR, `${id}_p0${entryExt}`);
      if (coverBufferCache.size < 200) coverBufferCache.set(`${id}:0`, { buf: buffer, mime: mimeType });
      fs.promises.writeFile(cacheFilePath, buffer)
        .then(() => coverDiskCache.set(`${id}:0`, cacheFilePath))
        .catch(() => {});
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(buffer);
  } catch (e) {
    console.error('載入圖片分頁錯誤：', e);
    if (e && e.code === 'IMAGE_TOO_LARGE') {
      return res.status(413).json({ error: '圖片超過 64 MiB 上限！' });
    }
    res.status(500).json({ error: '載入圖片分頁錯誤：' + e.message });
  }
}

app.get('/api/page', async (req, res) => {
  await serveComicPage(req, res);
});

// API: 獲取或讀取封面 (通常為 page 0)
app.get('/api/cover', async (req, res) => {
  await serveComicPage(req, res, 0);
});

// API: 儲存閱讀進度
app.post('/api/progress', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: '進度資料格式不正確' });
    }
    const { id, currentPage, totalPages } = req.body;
    if (!isStrictBase64Url(id) || !isStrictPageIndex(currentPage) || !isStrictPageIndex(totalPages)) {
      return res.status(400).json({ error: '進度參數格式不正確' });
    }
    const comic = resolveComicPath(id);
    if (comic.status) return res.status(comic.status).json({ error: comic.error });

    const current = Number(currentPage);
    const total = Number(totalPages);
    if (total > 0 && current >= total) {
      return res.status(400).json({ error: '目前頁碼超出範圍' });
    }

    const progressData = getProgressData();
    const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;

    progressData[id] = {
      currentPage: current,
      totalPages: total,
      percent,
      updatedAt: new Date().toISOString()
    };

    saveProgressData(progressData);
    res.json({ success: true, progress: progressData[id] });
  } catch (e) {
    res.status(500).json({ error: '儲存進度時出錯：' + e.message });
  }
});

// API: 獲取設定目錄路徑
app.get('/api/config', (req, res) => {
  res.json({ scanDir: currentComicDir });
});

// API: 儲存設定目錄路徑
app.post('/api/config', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: '設定資料格式不正確' });
    }
    const { scanDir } = req.body;
    if (typeof scanDir !== 'string' || scanDir.length === 0 || scanDir.length > 4096 || scanDir.includes('\0')) {
      return res.status(400).json({ error: '缺少路徑參數' });
    }

    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(scanDir.replace(/^~(?=\/|$)/, os.homedir())));
    } catch (e) {
      return res.status(400).json({ error: '指定的資料夾不存在！' });
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '指定的路徑不是資料夾！' });
    }

    currentComicDir = resolved;
    clearLibraryCaches();
    doBackgroundScan(); // 異步觸發新路徑的背景掃描
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ scanDir: currentComicDir }, null, 2), 'utf-8');
    res.json({ success: true, scanDir: currentComicDir });
  } catch (e) {
    res.status(500).json({ error: '保存設定失敗：' + e.message });
  }
});

// API: 本地資料夾瀏覽器
app.get('/api/browse-folders', (req, res) => {
  try {
    let queryPath = req.query.path;
    if (queryPath !== undefined && typeof queryPath !== 'string') {
      return res.status(400).json({ error: '路徑格式不正確！' });
    }
    if (!queryPath) {
      queryPath = currentComicDir;
    }

    const targetPath = path.resolve(queryPath.replace(/^~(?=\/|$)/, os.homedir()));
    
    // 防堵路徑穿越，限制只能在設定的漫畫庫目錄或主目錄下瀏覽 (依據專案需求與安全建議)
    let canonicalTarget;
    let canonicalLibrary;
    let canonicalHome;
    try {
      canonicalTarget = fs.realpathSync(targetPath);
      canonicalLibrary = fs.realpathSync(currentComicDir);
      canonicalHome = fs.realpathSync(os.homedir());
    } catch (e) {
      return res.status(404).json({ error: '找不到路徑！' });
    }
    const relDir = path.relative(canonicalLibrary, canonicalTarget);
    const relHome = path.relative(canonicalHome, canonicalTarget);
    if ((relDir.startsWith('..') || path.isAbsolute(relDir)) && (relHome.startsWith('..') || path.isAbsolute(relHome))) {
       return res.status(403).json({ error: '基於安全考量，只能瀏覽主目錄或漫畫庫目錄！' });
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: '找不到路徑！' });
    }

    const stat = fs.statSync(canonicalTarget);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '此路徑非資料夾！' });
    }

    const items = fs.readdirSync(canonicalTarget);
    const subfolders = [];
    const parentPath = path.dirname(canonicalTarget);
    const isRoot = parentPath === canonicalTarget;

    for (const item of items) {
      if (item.startsWith('.') || item === 'node_modules' || item.includes('__MACOSX')) continue;
      const full = path.join(canonicalTarget, item);
      try {
        if (fs.statSync(full).isDirectory()) {
          subfolders.push({
            name: item,
            path: full
          });
        }
      } catch (err) {
        // 忽略無權限讀取的目錄
      }
    }

    subfolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    res.json({
      currentPath: canonicalTarget,
      parentPath: isRoot ? null : parentPath,
      folders: subfolders
    });
  } catch (e) {
    res.status(500).json({ error: '瀏覽目錄失敗：' + e.message });
  }
});

// 啟動伺服器並自動開啟網頁
app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`✨ 天才少女漫畫伺服器已成功升空！`);
  console.log(`🌐 傳送門在此：${url}`);
  console.log(`📂 正幫主人守護此目錄的漫畫：${currentComicDir}`);
  
  // 在 Electron 模式下不需要自動開啟瀏覽器，因為 Electron 主程序會自行載入視窗
  if (!process.env.ELECTRON_MODE) {
    open(url).catch(err => {
      console.log('無法自動開啟瀏覽器，請主人手動點擊傳送門喔！', err);
    });
  } else {
    console.log('🖥️ 偵測到 Electron 模式，跳過自動開啟瀏覽器！');
  }
});
