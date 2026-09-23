const bridgeText = (source, vars = {}) => window.GAIL10n
  ? window.GAIL10n.t(source, vars)
  : source.replace(/\{(\w+)\}/g, (token, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : token);

/**
 * Tauri API 橋接層 (Phase 2)
 * 把原本 Electron 的 IPC 呼叫無縫轉換成 Tauri 的 invoke 呼叫。
 * 當偵測到 Tauri 環境時，會自動覆寫 window.electronAPI。
 */

const authoritativeProgressById = new Map();

function progressPercent(currentPage, totalPages) {
  return totalPages > 0 && currentPage > 0
    ? Math.round(((Math.min(currentPage, totalPages - 1) + 1) / totalPages) * 10000) / 100
    : 0;
}

function normalizeReaderData(data) {
  if (!data || typeof data !== 'object') return data;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const progress = data.progress && typeof data.progress === 'object' ? { ...data.progress } : {};
  const maxIndex = Math.max(0, pages.length - 1);
  const rawPage = Number(progress.currentPage);
  const currentPage = Number.isFinite(rawPage)
    ? Math.min(maxIndex, Math.max(0, Math.trunc(rawPage)))
    : 0;
  progress.currentPage = currentPage;
  progress.totalPages = pages.length;
  progress.percent = progressPercent(currentPage, pages.length);
  return { ...data, pages, progress };
}

function normalizeProgressPayload(data) {
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !data.id) {
    throw new Error(bridgeText("閱讀進度資料格式不正確。"));
  }
  const rawTotal = Number(data.totalPages);
  const rawPage = Number(data.currentPage);
  if (!Number.isFinite(rawTotal) || !Number.isFinite(rawPage)) {
    throw new Error(bridgeText("閱讀進度頁碼必須是有限數字。"));
  }
  const totalPages = Math.max(0, Math.trunc(rawTotal));
  const maxIndex = Math.max(0, totalPages - 1);
  const currentPage = totalPages > 0
    ? Math.min(maxIndex, Math.max(0, Math.trunc(rawPage)))
    : 0;
  return { id: data.id, currentPage, totalPages };
}

function progressTimestamp(progress) {
  const timestamp = Date.parse(progress?.updatedAt || progress?.updated_at || '');
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function rememberAuthoritativeLibraryProgress(items) {
  if (!Array.isArray(items)) return items;
  const present = new Set();
  const mergedItems = items.map((item) => {
    if (!item || typeof item.id !== 'string') return item;
    present.add(item.id);
    const incoming = item.progress && typeof item.progress === 'object'
      ? { ...item.progress }
      : null;
    const remembered = authoritativeProgressById.get(item.id);
    const chosen = remembered && (!incoming || progressTimestamp(remembered) > progressTimestamp(incoming))
      ? remembered
      : incoming;
    if (chosen) authoritativeProgressById.set(item.id, { ...chosen });
    return chosen && chosen !== incoming
      ? { ...item, progress: { ...chosen } }
      : item;
  });

  for (const id of authoritativeProgressById.keys()) {
    if (!present.has(id)) authoritativeProgressById.delete(id);
  }
  return mergedItems;
}

function readerDataWithAuthoritativeProgress(id, data) {
  if (!data || typeof data !== 'object') return data;
  const authoritative = authoritativeProgressById.get(id);
  if (!authoritative) return data;
  return {
    ...data,
    progress: {
      ...(data.progress && typeof data.progress === 'object' ? data.progress : {}),
      ...authoritative,
    },
  };
}

function rememberSavedProgress(data) {
  const normalized = normalizeProgressPayload(data);
  authoritativeProgressById.set(normalized.id, {
    currentPage: normalized.currentPage,
    totalPages: normalized.totalPages,
    percent: progressPercent(normalized.currentPage, normalized.totalPages),
    updatedAt: new Date().toISOString(),
  });
  return normalized;
}

async function openComicWithAuthoritativeProgress(invoke, id) {
  const nativeData = await invoke('open_comic', { id });
  const nativeNormalized = normalizeReaderData(nativeData);
  const normalized = normalizeReaderData(readerDataWithAuthoritativeProgress(id, nativeData));
  const nativePage = nativeNormalized?.progress?.currentPage;
  const resumePage = normalized?.progress?.currentPage;

  if (
    normalized?.pages?.length > 0
    && Number.isSafeInteger(nativePage)
    && Number.isSafeInteger(resumePage)
    && resumePage !== nativePage
  ) {
    try {
      const generation = await invoke('update_reader_cache_window', {
        comicId: id,
        pageIndex: resumePage,
      });
      if (Number.isSafeInteger(generation)) normalized.preloadGeneration = generation;
    } catch (error) {
      // Reader opening must still succeed when an optional background cache
      // adjustment fails; on-demand page serving remains authoritative.
      console.warn('[reader cache realign]', error);
    }
  }
  return normalized;
}

function normalizeSmbConfig(data) {
  if (data == null) return null;
  if (typeof data !== 'object') throw new Error(bridgeText("NAS 設定格式不正確。"));

  const host = String(data.host ?? '').trim();
  const share = String(data.share ?? '').trim();
  const username = data.username == null ? '' : String(data.username).trim();
  const password = data.password == null ? '' : String(data.password);

  if (!host || host.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(host)) {
    throw new Error(bridgeText("NAS 主機名稱／IP 格式不正確。"));
  }
  if (!share || share.length > 255 || share === '.' || share === '..' || /[\/\\\u0000-\u001f\u007f]/.test(share)) {
    throw new Error(bridgeText("NAS Share 名稱格式不正確。"));
  }
  if (username.length > 256 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error(bridgeText("NAS 使用者名稱格式不正確。"));
  }
  if (password.length > 1024 || /[\u0000\u000a\u000d]/.test(password)) {
    throw new Error(bridgeText("NAS 密碼格式不正確。"));
  }

  return {
    host,
    share,
    username: username || null,
    password: password || null,
  };
}

// Compatibility guard: the existing checkbox keeps its historical id so the
// large frontend core does not need a risky rewrite, but its runtime meaning is
// now provider-neutral. Both OpenAI and Google require explicit consent before
// any AI session can be enabled, and switching provider revokes prior consent.
function installThirdPartyAiConsentGuard() {
  const disclosure = document.getElementById('ai-google-disclosure-wrap');
  const checkbox = document.getElementById('ai-google-disclosure');
  const provider = document.getElementById('ai-provider');
  if (!disclosure || !checkbox || !provider) return;

  disclosure.id = 'ai-third-party-disclosure-wrap';
  const renderDisclosure = () => {
    const providerName = provider.value === 'google' ? 'Google' : 'OpenAI';
    const message = bridgeText(" 我了解：只有在我主動使用 AI 功能時，目前頁面影像與提示文字才會傳送至 {provider}；我明確同意本次工作階段的第三方 AI 資料分享。", { provider: providerName });
    const policyNote = provider.value === 'google' ? bridgeText(" 若使用 Google 免費層，提交內容可能用於改善產品；請確認自己的雲端 BYOK 方案。") : '';
    const textNodes = Array.from(disclosure.childNodes).filter(node => node.nodeType === 3);
    for (const node of textNodes) node.textContent = '';
    let copy = disclosure.querySelector('span');
    if (!copy) {
      copy = document.createElement('span');
      disclosure.append(copy);
    }
    copy.removeAttribute('data-i18n');
    copy.textContent = message + policyNote;
    disclosure.hidden = false;
  };

  renderDisclosure();
  provider.addEventListener('change', () => {
    checkbox.checked = false;
    renderDisclosure();
  });
}

installThirdPartyAiConsentGuard();

if (window.__TAURI__) {
  const nativeInvoke = window.__TAURI__.core.invoke;
  const invoke = async (...args) => {
    try {
      return await nativeInvoke(...args);
    } catch (error) {
      if (args[0] !== 'explain_page' && String(error).startsWith('PRO_REQUIRED:')) {
        window.GaiCommerce?.handleError(error);
      }
      throw error;
    }
  };
  const { listen } = window.__TAURI__.event;

  console.log("🚀 Tauri 環境偵測成功，初始化橋接層...");

  window.electronAPI = {
    isElectron: true,
    getCommerce: () => invoke('get_commerce'),
    getPhotoLibraryStatus: (requestAuthorization = false) => invoke('get_photo_library_status', { requestAuthorization }),
    setLinkedPhotoAlbums: (albumIds) => invoke('set_linked_photo_albums', { albumIds }),
    setPhotoNetworkAllowed: (allowed) => invoke('set_photo_network_allowed', { allowed }),
    purchasePro: () => invoke('purchase_pro'),
    restorePro: () => invoke('restore_pro'),
    getLibrary: async () => rememberAuthoritativeLibraryProgress(await invoke('get_library')),
    getScanStatus: () => invoke('get_scan_status'),
    openComic: (id) => openComicWithAuthoritativeProgress(invoke, id),
    updateReaderCacheWindow: (comicId, pageIndex) => invoke('update_reader_cache_window', { comicId, pageIndex }),
    closeComic: (comicId) => invoke('close_comic', { comicId }),
    saveProgress: async (data) => {
      const normalized = normalizeProgressPayload(data);
      const result = await invoke('save_progress', { data: normalized });
      rememberSavedProgress(normalized);
      return result;
    },
    getConfig: () => invoke('get_config'),
    setConfig: (data) => invoke('set_config', { data }),
    setSmbConfig: (data) => invoke('set_smb_config', { data: normalizeSmbConfig(data) }),
    getOnlineServicesConfig: () => invoke('get_online_services_config'),
    setOnlineServicesConfig: (data) => invoke('set_online_services_config', { data }),
    getAiSessionStatus: () => invoke('get_ai_session_status'),
    setAiSessionConfig: (data) => {
      const providerName = data?.provider === 'google' ? 'Google' : 'OpenAI';
      if (!data?.googleContentDisclosure) {
        return Promise.reject(new Error(bridgeText("啟用 {provider} 前，請先明確同意將目前頁面影像與提示文字傳送至該第三方 AI 供應商。", { provider: providerName })));
      }
      return invoke('set_ai_session_config', {
        data: {
          ...data,
          rememberKey: Boolean(data.rememberKey),
        },
      });
    },
    restoreAiSessionConfig: (data) => {
      const providerName = data?.provider === 'google' ? 'Google' : 'OpenAI';
      if (!data?.googleContentDisclosure) {
        return Promise.reject(new Error(bridgeText("使用已儲存 {provider} Key 前，請先明確同意將目前頁面影像與提示文字傳送至該第三方 AI 供應商。", { provider: providerName })));
      }
      return invoke('restore_ai_session_config', { data });
    },
    revokeAiSessionConfig: () => invoke('revoke_ai_session_config'),
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
          title: bridgeText("選擇漫畫資料夾"),
          canCreateDirectories: true,
        },
      });
      if (typeof selected === 'string') return selected;
      return selected?.path || null;
    },
    browseFolders: (dirPath) => invoke('browse_folders', { dirPath }),
    onLibraryChanged: (callback) => listen('library-changed', (event) => callback(event.payload)),
    onCatalogChanged: (callback) => listen('catalog-changed', (event) => callback(event.payload)),
    onScanProgress: (callback) => listen('scan-progress', (event) => callback(event.payload)),
    onRamCacheProgress: (callback) => listen('ram-cache-progress', (event) => callback(event.payload)),
    onSmbDownloadStart: (callback) => listen('smb-download-start', (event) => callback(event.payload)),
    onSmbDownloadEnd: (callback) => listen('smb-download-end', (event) => callback(event.payload)),
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
    showItemInFolder: (comicId) => invoke('show_item_in_folder', { comicId }),
    getFileCapability: (comicId) => invoke('get_file_capability', { comicId }),
    mutateComicFile: (request) => invoke('mutate_comic_file', { request }),
    undoComicFileOperation: (token) => invoke('undo_comic_file_operation', { token }),
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
    listTagInventory: (query) => invoke('list_tag_inventory', { query }),
    updateTagState: (update) => invoke('update_tag_state', { update }),
    renameTag: (tagId, displayValue) => invoke('rename_tag', { tagId, displayValue }),
    mergeTags: (sourceTagId, targetTagId) => invoke('merge_tags', { sourceTagId, targetTagId }),
    setTagDisabled: (tagId, disabled) => invoke('set_tag_disabled', { tagId, disabled }),
    undoTagOperation: (token) => invoke('undo_tag_operation', { token }),
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
      if (!path) throw new Error(bridgeText("未取得匯出檔案路徑"));
      return invoke('save_catalog_metadata', { path, payload });
    },
    previewCatalogImport: (payload) => invoke('preview_catalog_import', { payload }),
    applyCatalogImport: (request) => invoke('apply_catalog_import', { request }),
  };
}
