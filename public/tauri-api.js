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
    closeComic: (comicId) => invoke('close_comic', { comicId }),
    saveProgress: (data) => invoke('save_progress', { data }),
    getConfig: () => invoke('get_config'),
    setConfig: (data) => invoke('set_config', { data }),
    setSmbConfig: (data) => invoke('set_smb_config', { data }),
    getOnlineServicesConfig: () => invoke('get_online_services_config'),
    setOnlineServicesConfig: (data) => invoke('set_online_services_config', { data }),
    getAiSessionStatus: () => invoke('get_ai_session_status'),
    setAiSessionConfig: (data) => invoke('set_ai_session_config', { data }),
    clearAiSessionConfig: () => invoke('clear_ai_session_config'),
    testAiSession: () => invoke('test_ai_session'),
    explainPage: (data) => invoke('explain_page', { data }),
    suggestComicMetadata: (data) => invoke('suggest_comic_metadata', { data }),
    getCatalogExportPath: (filename) => invoke('default_catalog_export_path', { filename }),
    getBookmarks: () => invoke('get_bookmarks'),
    setBookmarks: (data) => invoke('set_bookmarks', { data }),
    openExternalFolder: () => invoke('plugin:ios-folder|pick_folder'),
    openFolderDialog: async (defaultPath) => {
      const selected = await invoke('plugin:dialog|open', {
        options: {
          directory: true,
          multiple: false,
          defaultPath: defaultPath || undefined,
          title: '選擇漫畫資料夾',
          canCreateDirectories: true,
        },
      });
      if (typeof selected === 'string') return selected;
      return selected?.path || null;
    },
    browseFolders: (dirPath) => invoke('browse_folders', { dirPath }),
    onLibraryChanged: (callback) => {
      return listen('library-changed', (event) => {
        callback(event.payload);
      });
    },
    onCatalogChanged: (callback) => listen('catalog-changed', (event) => callback(event.payload)),
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
        return JSON.parse(localStorage.getItem('gai:favorites') || '[]');
      } catch(e) {
        return [];
      }
    },
    toggleFavorite: async (id) => {
      const favorites = await window.electronAPI.getFavorites();
      const index = favorites.indexOf(id);
      if (index >= 0) favorites.splice(index, 1);
      else favorites.push(id);
      localStorage.setItem('gai:favorites', JSON.stringify(favorites));
      return favorites;
    },
    showItemInFolder: (path) => invoke('show_item_in_folder', { path }),
    trashPage: (comicId, pageIndex) => invoke('trash_page', { comicId, pageIndex }),
    scanLibrary: () => invoke('scan_library'),
    searchCatalog: (query) => invoke('search_catalog', { query }),
    getComicMetadata: (id) => invoke('get_comic_metadata', { id }),
    applyBatchMetadata: (request) => invoke('apply_batch_metadata', { request }),
    undoBatchMetadata: (token) => invoke('undo_batch_metadata', { token }),
    upsertFolderTagRule: (rule) => invoke('upsert_folder_tag_rule', { rule }),
    reimportMetadata: (request) => invoke('reimport_metadata', { request }),
    listImportDiagnostics: (limit = 200) => invoke('list_import_diagnostics', { limit }),
    upsertTagAlias: (alias) => invoke('upsert_tag_alias', { alias }),
    listTagAliases: () => invoke('list_tag_aliases'),
    listOrganizerInbox: (limit = 200) => invoke('list_organizer_inbox', { limit }),
    listDuplicateCandidates: (limit = 200) => invoke('list_duplicate_candidates', { limit }),
    listRelatedTags: (id, limit = 8) => invoke('list_related_tags', { id, limit }),
    exportCatalogMetadata: () => invoke('export_catalog_metadata'),
    saveCatalogMetadata: async (defaultPath, payload) => {
      const selected = await invoke('plugin:dialog|save', {
        options: {
          defaultPath,
          filters: [{ name: 'JSON', extensions: ['json'] }],
          canCreateDirectories: true,
        },
      });
      if (!selected) return null;
      const path = typeof selected === 'string' ? selected : selected.path;
      if (!path) throw new Error('未取得匯出檔案路徑');
      return invoke('save_catalog_metadata', { path, payload });
    },
    previewCatalogImport: (payload) => invoke('preview_catalog_import', { payload }),
    applyCatalogImport: (request) => invoke('apply_catalog_import', { request }),
  };
}
