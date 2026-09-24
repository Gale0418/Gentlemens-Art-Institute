/**
 * iOS Photos 相簿持續來源設定。
 *
 * 這個模組只相信 native bridge 的回傳值；瀏覽器預覽與非 iOS 裝置不會
 * 顯示相簿入口，也不會在啟動時要求 Photos 權限。
 */
(function installPhotoLibraryLink() {
  'use strict';

  const featureText = (source, vars = {}) => window.GAIL10n
    ? window.GAIL10n.t(source, vars)
    : source.replace(/\{(\w+)\}/g, (token, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : token);

  const elements = {
    button: document.getElementById('photo-library-link-btn'),
    modal: document.getElementById('photo-library-modal'),
    close: document.getElementById('photo-library-close-btn'),
    cancel: document.getElementById('photo-library-cancel-btn'),
    save: document.getElementById('photo-library-save-btn'),
    status: document.getElementById('photo-library-status'),
    feedback: document.getElementById('photo-library-feedback'),
    limitedNote: document.getElementById('photo-library-limited-note'),
    albums: document.getElementById('photo-library-albums'),
    unavailable: document.getElementById('photo-library-unavailable'),
    unavailableList: document.getElementById('photo-library-unavailable-list'),
    network: document.getElementById('photo-library-network'),
  };

  const state = {
    supported: false,
    authorization: 'notDetermined',
    albums: [],
    linkedAlbumIds: [],
    allowNetwork: false,
    draftAlbumIds: new Set(),
    draftAllowNetwork: false,
    opener: null,
    busy: false,
    modalOpen: false,
  };

  function normalizeAuthorization(raw) {
    const value = String(raw ?? '').replace(/^PHAuthorizationStatus\./, '').replace(/^\./, '');
    return ({ full: 'authorized', authorized: 'authorized', limited: 'limited',
      denied: 'denied', restricted: 'restricted', notDetermined: 'notDetermined' })[value] || 'notDetermined';
  }

  function isIOSLibraryDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function getBridge() {
    const bridge = window.electronAPI;
    if (!bridge || typeof bridge.getPhotoLibraryStatus !== 'function') return null;
    if (typeof bridge.setLinkedPhotoAlbums !== 'function') return null;
    if (typeof bridge.setPhotoNetworkAllowed !== 'function') return null;
    return bridge;
  }

  function normalizeStatus(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const albums = Array.isArray(value.albums)
      ? value.albums
        .filter(album => album && album.id !== undefined && album.id !== null)
        .map(album => ({
          id: String(album.id),
          title: album.id === 'photo-library' ? featureText('所有照片（照片圖庫）')
            : album.id === 'limited-library' ? featureText('已選照片（有限存取）')
              : String(album.title || featureText("未命名相簿")),
          count: Number.isFinite(Number(album.count)) ? Math.max(0, Math.trunc(Number(album.count))) : 0,
        }))
      : [];
    const linkedAlbumIds = Array.isArray(value.linkedAlbumIds)
      ? [...new Set(value.linkedAlbumIds.filter(id => id !== undefined && id !== null).map(String))]
      : [];
    const authorization = normalizeAuthorization(value.authorization);
    return {
      supported: value.supported === true,
      authorization,
      albums,
      linkedAlbumIds,
      allowNetwork: value.allowNetwork === true,
    };
  }

  function setMessage(element, message, stateName = '') {
    if (!element) return;
    element.textContent = message || '';
    if (stateName) element.dataset.state = stateName;
    else delete element.dataset.state;
  }

  function setBusy(busy) {
    state.busy = busy;
    if (elements.button) {
      elements.button.disabled = busy;
      elements.button.setAttribute('aria-busy', String(busy));
    }
    if (elements.close) elements.close.disabled = busy;
    if (elements.cancel) elements.cancel.disabled = busy;
    elements.modal?.querySelectorAll('input[data-photo-album-id], #photo-library-network')
      .forEach(input => { input.disabled = busy; });
    if (elements.save) {
      elements.save.disabled = busy;
      elements.save.textContent = busy ? featureText("儲存中…") : featureText("儲存連結");
    }
  }

  function renderEmpty(container, message) {
    const empty = document.createElement('p');
    empty.className = 'photo-library-empty';
    empty.textContent = message;
    container.appendChild(empty);
  }

  function makeAlbumOption(album, checked, unavailable = false) {
    const label = document.createElement('label');
    label.className = 'photo-library-album-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.dataset.photoAlbumId = album.id;
    checkbox.setAttribute('aria-label', unavailable ? featureText("解除相簿連結：{title}", { title: album.title }) : featureText("連結相簿：{title}", { title: album.title }));
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.draftAlbumIds.add(album.id);
      else state.draftAlbumIds.delete(album.id);
    });

    const copy = document.createElement('span');
    copy.className = 'photo-library-album-copy';
    const title = document.createElement('strong');
    title.textContent = album.title;
    copy.appendChild(title);

    const detail = document.createElement('small');
    detail.textContent = unavailable
      ? featureText("目前無法存取；取消勾選即可解除連結")
      : featureText("{count} 張照片", { count: album.count });
    copy.appendChild(detail);
    label.append(checkbox, copy);
    return label;
  }

  function renderAlbums() {
    if (!elements.albums || !elements.unavailableList) return;
    elements.albums.replaceChildren();
    elements.unavailableList.replaceChildren();

    if (state.albums.length === 0) {
      renderEmpty(elements.albums, featureText("目前沒有可連結的相簿。空相簿會保留在清單中，方便未來新增照片。"));
    } else {
      state.albums.forEach(album => {
        elements.albums.appendChild(makeAlbumOption(album, state.draftAlbumIds.has(album.id)));
      });
    }

    const visibleIds = new Set(state.albums.map(album => album.id));
    const unavailableIds = state.linkedAlbumIds.filter(id => !visibleIds.has(id));
    if (unavailableIds.length === 0) {
      elements.unavailable.hidden = true;
    } else {
      elements.unavailable.hidden = false;
      unavailableIds.forEach((id, index) => {
        elements.unavailableList.appendChild(makeAlbumOption({ id, title: featureText("目前無法存取的相簿 {index}", { index: index + 1 }), count: 0 }, state.draftAlbumIds.has(id), true));
      });
    }

    if (elements.network) elements.network.checked = state.draftAllowNetwork;
    if (elements.limitedNote) elements.limitedNote.hidden = state.authorization !== 'limited';
  }

  function renderStatusMessage() {
    if (state.authorization === 'denied') {
      setMessage(elements.status, featureText("系統未允許存取照片；請到設定中的照片權限調整後再試。"), 'error');
      return;
    }
    if (state.authorization === 'restricted') {
      setMessage(elements.status, featureText("這台裝置目前限制了照片存取，無法連結相簿。"), 'error');
      return;
    }
    if (state.authorization === 'notDetermined') {
      setMessage(elements.status, featureText("尚未取得照片權限；可在系統提示中選擇允許範圍。"), 'error');
      return;
    }
    setMessage(elements.status, featureText("選擇想在書庫中閱讀的相簿。"));
  }

  function focusableElements() {
    if (!elements.modal) return [];
    return [...elements.modal.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.disabled && !element.hidden && element.getClientRects().length > 0);
  }

  function focusInitialControl() {
    const focusables = focusableElements();
    (focusables[0] || elements.close)?.focus();
  }

  function openModal() {
    if (!elements.modal) return;
    state.modalOpen = true;
    elements.modal.hidden = false;
    document.body.classList.add('photo-library-modal-open');
    focusInitialControl();
  }

  function closeModal() {
    if (!elements.modal || state.busy) return;
    state.modalOpen = false;
    elements.modal.hidden = true;
    document.body.classList.remove('photo-library-modal-open');
    setMessage(elements.feedback);
    const opener = state.opener;
    state.opener = null;
    if (opener && typeof opener.focus === 'function') opener.focus();
  }

  function handleModalKeydown(event) {
    if (!state.modalOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = focusableElements();
    if (focusables.length === 0) {
      event.preventDefault();
      elements.close?.focus();
      return;
    }
    const currentIndex = focusables.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1)
      : (currentIndex === focusables.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusables[nextIndex].focus();
  }

  function emitLibraryChanged() {
    if (typeof window.CustomEvent === 'function') {
      window.dispatchEvent(new window.CustomEvent('gai:photo-library-changed'));
    } else if (typeof window.Event === 'function') {
      window.dispatchEvent(new window.Event('gai:photo-library-changed'));
    }
  }

  function sameIds(left, right) {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every(id => rightSet.has(id));
  }

  async function loadStatus(requestAuthorization) {
    const bridge = getBridge();
    if (!bridge) throw new Error(featureText("此環境不支援相簿連結。"));
    return normalizeStatus(await bridge.getPhotoLibraryStatus(Boolean(requestAuthorization)));
  }

  async function openLibraryModal() {
    if (state.busy || !getBridge()) return;
    state.opener = document.activeElement;
    setBusy(true);
    setMessage(elements.status, featureText("正在讀取系統相簿…"));
    try {
      const next = await loadStatus(true);
      if (!next.supported) {
        elements.button.hidden = true;
        return;
      }
      Object.assign(state, next, {
        draftAlbumIds: new Set(next.linkedAlbumIds),
        draftAllowNetwork: next.allowNetwork,
      });
      renderAlbums();
      renderStatusMessage();
      setMessage(elements.feedback);
      setBusy(false);
      openModal();
    } catch (error) {
      Object.assign(state, {
        supported: false,
        authorization: 'notDetermined',
        albums: [],
        linkedAlbumIds: [],
        allowNetwork: false,
        draftAlbumIds: new Set(),
        draftAllowNetwork: false,
      });
      renderAlbums();
      setMessage(elements.status, featureText("讀取相簿失敗：{error}", { error: error?.message || error }), 'error');
      setBusy(false);
      openModal();
    } finally {
      if (!state.modalOpen) setBusy(false);
    }
  }

  function selectedAlbumIds() {
    if (!elements.modal) return [];
    return [...elements.modal.querySelectorAll('input[data-photo-album-id]:checked')]
      .map(input => String(input.dataset.photoAlbumId));
  }

  async function saveLibraryLinks() {
    if (state.busy) return;
    const bridge = getBridge();
    if (!bridge) {
      setMessage(elements.feedback, featureText("此環境不支援相簿連結。"), 'error');
      return;
    }

    const nextAlbumIds = selectedAlbumIds();
    const nextAllowNetwork = Boolean(elements.network?.checked);
    const albumsChanged = !sameIds(nextAlbumIds, state.linkedAlbumIds);
    const networkChanged = nextAllowNetwork !== state.allowNetwork;
    if (!albumsChanged && !networkChanged) {
      setMessage(elements.feedback, featureText("沒有需要儲存的變更。"));
      return;
    }

    const previousAlbumIds = [...state.linkedAlbumIds];
    const previousAllowNetwork = state.allowNetwork;
    let albumsAttempted = false;
    let networkAttempted = false;
    setBusy(true);
    setMessage(elements.feedback, featureText("正在儲存相簿連結…"));

    try {
      if (albumsChanged) {
        albumsAttempted = true;
        const result = await bridge.setLinkedPhotoAlbums(nextAlbumIds);
        if (!result || result.success !== true) throw new Error(featureText("相簿連結沒有成功更新。"));
      }
      if (networkChanged) {
        networkAttempted = true;
        const result = await bridge.setPhotoNetworkAllowed(nextAllowNetwork);
        if (!result || result.allowed !== nextAllowNetwork) throw new Error(featureText("iCloud 下載設定沒有成功更新。"));
      }

      state.linkedAlbumIds = nextAlbumIds;
      state.allowNetwork = nextAllowNetwork;
      state.draftAlbumIds = new Set(nextAlbumIds);
      state.draftAllowNetwork = nextAllowNetwork;
      renderAlbums();
      setMessage(elements.feedback, featureText("相簿連結已儲存。"), 'success');
      emitLibraryChanged();
      window.setTimeout(closeModal, 450);
    } catch (error) {
      const rollbackErrors = [];
      if (networkAttempted) {
        try {
          const rollback = await bridge.setPhotoNetworkAllowed(previousAllowNetwork);
          if (!rollback || rollback.allowed !== previousAllowNetwork) rollbackErrors.push(featureText("iCloud 設定"));
        } catch (_) {
          rollbackErrors.push(featureText("iCloud 設定"));
        }
      }
      if (albumsAttempted) {
        try {
          const rollback = await bridge.setLinkedPhotoAlbums(previousAlbumIds);
          if (!rollback || rollback.success !== true) rollbackErrors.push(featureText("相簿連結"));
        } catch (_) {
          rollbackErrors.push(featureText("相簿連結"));
        }
      }
      let refreshed = null;
      try {
        refreshed = await loadStatus(false);
      } catch (_) {
        rollbackErrors.push(featureText("目前設定"));
      }
      if (refreshed?.supported) {
        if (!sameIds(refreshed.linkedAlbumIds, previousAlbumIds)
          || refreshed.allowNetwork !== previousAllowNetwork) {
          rollbackErrors.push(featureText("目前設定"));
        }
        Object.assign(state, refreshed, {
          draftAlbumIds: new Set(refreshed.linkedAlbumIds),
          draftAllowNetwork: refreshed.allowNetwork,
        });
      } else {
        state.draftAlbumIds = new Set(previousAlbumIds);
        state.draftAllowNetwork = previousAllowNetwork;
      }
      renderAlbums();
      const message = rollbackErrors.length
        ? featureText("儲存失敗，部分設定未能復原（{settings}）。請重新開啟確認。", { settings: rollbackErrors.join(', ') })
        : featureText("儲存失敗，設定已復原。");
      setMessage(elements.feedback, message, 'error');
      emitLibraryChanged();
    } finally {
      setBusy(false);
    }
  }

  async function initialize() {
    if (!elements.button || !isIOSLibraryDevice() || !getBridge()) return;
    try {
      const preview = await loadStatus(false);
      if (!preview.supported) return;
      Object.assign(state, preview);
      elements.button.hidden = false;
    } catch (_) {
      // 沒有 native preview 時保持隱藏，避免把瀏覽器能力誤呈現成相簿功能。
      elements.button.hidden = true;
    }
  }

  if (!elements.button || !elements.modal) return;

  elements.button.addEventListener('click', openLibraryModal);
  elements.close?.addEventListener('click', closeModal);
  elements.cancel?.addEventListener('click', closeModal);
  elements.save?.addEventListener('click', saveLibraryLinks);
  elements.modal.addEventListener('click', event => {
    if (event.target === elements.modal) closeModal();
  });
  document.addEventListener('keydown', handleModalKeydown);
  initialize();
})();
