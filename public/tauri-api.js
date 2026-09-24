const bridgeText = (source, vars = {}) => window.GAIL10n
  ? window.GAIL10n.t(source, vars)
  : source.replace(/\{(\w+)\}/g, (token, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : token);

// Native plugins return locale-neutral codes. Keep their user-facing copy at
// this bridge boundary so a manually selected WebView language is authoritative
// and raw native English/Chinese never reaches the shared UI.
const nativeErrorMessages = Object.freeze({
  FOLDER_ROOT_VIEW_CONTROLLER_NOT_FOUND: {
    'zh-Hant': '找不到 App 根視圖控制器。',
    en: "Could not find the app's root view controller.",
    ja: 'App のルートビューコントローラーが見つかりません。',
  },
  FOLDER_IOS_VERSION_UNSUPPORTED: {
    'zh-Hant': '需要 iOS 14 或更新版本。',
    en: 'iOS 14 or later is required.',
    ja: 'iOS 14 以降が必要です。',
  },
  FOLDER_SELECTION_EMPTY: {
    'zh-Hant': '沒有選取資料夾。',
    en: 'No folder was selected.',
    ja: 'フォルダーが選択されていません。',
  },
  FOLDER_SECURITY_SCOPE_ACCESS_FAILED: {
    'zh-Hant': '無法存取選取的資料夾。',
    en: 'Could not access the selected folder.',
    ja: '選択したフォルダーにアクセスできません。',
  },
  FOLDER_BOOKMARK_CREATE_FAILED: {
    'zh-Hant': '無法建立外部資料夾授權。',
    en: 'Could not create access for the external folder.',
    ja: '外部フォルダーのアクセス権を作成できません。',
  },
  FOLDER_PICKER_CANCELLED: {
    'zh-Hant': '你已取消資料夾選取。',
    en: 'Folder selection was cancelled.',
    ja: 'フォルダーの選択をキャンセルしました。',
  },
  FOLDER_BOOKMARK_ACCESS_FAILED: {
    'zh-Hant': '外部資料夾授權已失效，請重新加入資料夾。',
    en: 'The external folder access has expired. Add the folder again.',
    ja: '外部フォルダーのアクセス権が無効です。フォルダーをもう一度追加してください。',
  },
  FOLDER_BOOKMARK_INVALID_BASE64: {
    'zh-Hant': '外部資料夾授權資料格式不正確。',
    en: 'The external folder access data is invalid.',
    ja: '外部フォルダーのアクセスデータが正しくありません。',
  },
  FOLDER_BOOKMARK_RESOLVE_FAILED: {
    'zh-Hant': '無法還原外部資料夾授權，請重新加入資料夾。',
    en: 'Could not restore external folder access. Add the folder again.',
    ja: '外部フォルダーのアクセス権を復元できません。フォルダーをもう一度追加してください。',
  },
  FOLDER_ACCESS_START_FAILED: {
    'zh-Hant': '無法開啟外部資料夾。',
    en: 'Could not open the external folder.',
    ja: '外部フォルダーを開けません。',
  },
  AI_KEY_INVALID: {
    'zh-Hant': 'AI API Key 格式不正確。',
    en: 'The AI API key format is invalid.',
    ja: 'AI API Key の形式が正しくありません。',
  },
  AI_KEY_SAVE_FAILED: {
    'zh-Hant': '無法儲存 AI API Key。',
    en: 'Could not save the AI API key.',
    ja: 'AI API Key を保存できません。',
  },
  AI_PROVIDER_INVALID: {
    'zh-Hant': 'AI 供應商不受支援。',
    en: 'The AI provider is not supported.',
    ja: 'AI プロバイダーはサポートされていません。',
  },
  AI_KEY_NOT_FOUND: {
    'zh-Hant': '找不到此供應商的 AI API Key。',
    en: 'No AI API key was found for this provider.',
    ja: 'このプロバイダーの AI API Key が見つかりません。',
  },
  AI_KEY_READ_FAILED: {
    'zh-Hant': '無法讀取 AI API Key。',
    en: 'Could not read the AI API key.',
    ja: 'AI API Key を読み込めません。',
  },
  AI_KEY_DELETE_FAILED: {
    'zh-Hant': '無法刪除 AI API Key。',
    en: 'Could not delete the AI API key.',
    ja: 'AI API Key を削除できません。',
  },
  FOLDER_BOOKMARK_NOT_ACTIVE: {
    'zh-Hant': '外部資料夾授權尚未啟用。',
    en: 'The external folder access is not active.',
    ja: '外部フォルダーのアクセス権が有効になっていません。',
  },
  FOLDER_PATH_OUTSIDE_SELECTED_FOLDER: {
    'zh-Hant': '指定路徑不在選取的資料夾內。',
    en: 'The requested path is outside the selected folder.',
    ja: '指定されたパスは選択したフォルダーの外にあります。',
  },
  FOLDER_FILE_UNAVAILABLE: {
    'zh-Hant': '檔案目前無法使用。',
    en: 'The file is not available.',
    ja: 'ファイルを利用できません。',
  },
  PHOTO_LIBRARY_INVALID_ARGUMENTS: {
    'zh-Hant': '照片圖庫參數不正確。',
    en: 'The photo library arguments are invalid.',
    ja: '写真ライブラリの引数が正しくありません。',
  },
  PHOTO_LIBRARY_AUTHORIZATION_REQUIRED: {
    'zh-Hant': '需要照片圖庫存取權限。',
    en: 'Photo library access is required.',
    ja: '写真ライブラリへのアクセスが必要です。',
  },
  PHOTO_LIBRARY_UNAVAILABLE: {
    'zh-Hant': '照片圖庫目前無法使用。',
    en: 'The photo library is unavailable.',
    ja: '写真ライブラリを利用できません。',
  },
  PHOTO_ALBUM_NOT_LINKED: {
    'zh-Hant': '照片相簿尚未連結。',
    en: 'The photo album is not linked.',
    ja: '写真アルバムがリンクされていません。',
  },
  PHOTO_ALBUM_NOT_ACCESSIBLE: {
    'zh-Hant': '無法存取照片相簿。',
    en: 'The photo album is not accessible.',
    ja: '写真アルバムにアクセスできません。',
  },
  PHOTO_ASSET_NOT_FOUND: {
    'zh-Hant': '找不到照片。',
    en: 'The photo was not found.',
    ja: '写真が見つかりません。',
  },
  PHOTO_ASSET_NOT_IN_ALBUM: {
    'zh-Hant': '照片不在已連結的相簿中。',
    en: 'The photo is not in the linked album.',
    ja: '写真がリンクされたアルバムにありません。',
  },
  PHOTO_IMAGE_UNAVAILABLE: {
    'zh-Hant': '照片目前無法使用。',
    en: 'The photo image is unavailable.',
    ja: '写真画像を利用できません。',
  },
  PHOTO_IN_ICLOUD: {
    'zh-Hant': '照片仍在 iCloud 中，請稍後再試。',
    en: 'The photo is still in iCloud. Try again later.',
    ja: '写真は iCloud にあります。後でもう一度お試しください。',
  },
  PHOTO_IMAGE_TIMEOUT: {
    'zh-Hant': '讀取照片逾時，請稍後再試。',
    en: 'Timed out while loading the photo. Try again later.',
    ja: '写真の読み込みがタイムアウトしました。後でもう一度お試しください。',
  },
  PHOTO_IMAGE_CANCELLED: {
    'zh-Hant': '照片讀取已取消。',
    en: 'Photo loading was cancelled.',
    ja: '写真の読み込みをキャンセルしました。',
  },
  PHOTO_IMAGE_ENCODING_FAILED: {
    'zh-Hant': '無法處理照片影像。',
    en: 'Could not encode the photo image.',
    ja: '写真画像をエンコードできません。',
  },
  PHOTO_LIBRARY_IOS_VERSION_UNSUPPORTED: {
    'zh-Hant': '照片圖庫需要 iOS 15 或更新版本。',
    en: 'Photo library access requires iOS 15 or later.',
    ja: '写真ライブラリには iOS 15 以降が必要です。',
  },
  IOS_FOLDER_DESKTOP_UNSUPPORTED: {
    'zh-Hant': '目前環境不支援外部資料夾與照片圖庫功能。',
    en: 'External folders and photo library features are unavailable here.',
    ja: 'この環境では外部フォルダーと写真ライブラリ機能を利用できません。',
  },
  NATIVE_OPERATION_FAILED: {
    'zh-Hant': '操作失敗，請稍後再試。',
    en: 'The operation failed. Please try again.',
    ja: '操作に失敗しました。後でもう一度お試しください。',
  },
});

function localizedNativeError(error) {
  const raw = typeof error === 'string' ? error : error?.message;
  if (typeof raw !== 'string' || /^PRO_REQUIRED\s*:/i.test(raw)) return error;
  const legacyPhotoCodes = {
    '找不到照片相簿，請重新整理照片圖庫': 'PHOTO_ALBUM_NOT_LINKED',
    '照片相簿識別碼無效': 'PHOTO_LIBRARY_INVALID_ARGUMENTS',
    '照片相簿目前不可用': 'PHOTO_ALBUM_NOT_ACCESSIBLE',
  };
  const code = raw.trim().match(/((?:FOLDER|AI|PHOTO|IOS_FOLDER)_[A-Z0-9_]+)$/)?.[1]
    || legacyPhotoCodes[raw.trim()]
    || (/\p{Script=Han}/u.test(raw) ? 'NATIVE_OPERATION_FAILED' : '');
  const messages = nativeErrorMessages[code];
  if (!messages) return error;
  const locale = window.GAIL10n?.locale;
  const localized = new Error(messages[locale] || messages.en);
  localized.code = code;
  Object.defineProperty(localized, 'nativeMessage', { value: raw });
  return localized;
}

/**
 * Tauri API 橋接層 (Phase 2)
 * 把原本 Electron 的 IPC 呼叫無縫轉換成 Tauri 的 invoke 呼叫。
 * 當偵測到 Tauri 環境時，會自動覆寫 window.electronAPI。
 */

const authoritativeProgressById = new Map();

const VIRTUAL_PHOTO_TITLES = Object.freeze({
  'photos:cGhvdG8tbGlicmFyeQ': '所有照片（照片圖庫）',
  'photos:bGltaXRlZC1saWJyYXJ5': '已選照片（有限存取）',
});

function localizeVirtualPhotoItem(item) {
  if (item?.type !== 'photo-album') return item;
  if (item.title === '相簿目前不可用' || item.title === '相簿目前不可用（有限存取）') {
    return { ...item, title: bridgeText('相簿目前不可用') };
  }
  const title = VIRTUAL_PHOTO_TITLES[item.id];
  return title ? { ...item, title: bridgeText(title) } : item;
}

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
  return localizeVirtualPhotoItem({ ...data, pages, progress });
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
      const localizedError = localizedNativeError(error);
      if (args[0] !== 'explain_page' && String(localizedError).startsWith('PRO_REQUIRED:')) {
        window.GaiCommerce?.handleError(localizedError);
      }
      throw localizedError;
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
    getLibrary: async () => {
      const items = rememberAuthoritativeLibraryProgress(await invoke('get_library'));
      return Array.isArray(items) ? items.map(localizeVirtualPhotoItem) : items;
    },
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
