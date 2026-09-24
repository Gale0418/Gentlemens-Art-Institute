/*
 * G.A.I Pro UI
 *
 * The native bridge is the authority for entitlement and transactions. This
 * file only presents that state and stops paid entry points while free
 * reading and data safety paths remain available.
 */
(() => {
  'use strict';

  const featureText = (source, vars = {}) => window.GAIL10n
    ? window.GAIL10n.t(source, vars)
    : source.replace(/\{(\w+)\}/g, (token, key) => Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : token);

  const FEATURE_LABELS = {
    'direct-nas': featureText("直接 SMB／NAS 連線"),
    batch: featureText("批次標籤與進階整理"),
    duplicates: featureText("重複候選"),
    ai: featureText("AI 解說與整理工具"),
  };

  const PREVIEW_STATE = {
    supported: false,
    pro: false,
    productId: '',
    displayPrice: null,
    status: 'preview',
    message: featureText("瀏覽器預覽不支援交易；Pro 功能不會在預覽中解鎖。"),
  };

  const state = {
    snapshot: { ...PREVIEW_STATE },
    ready: false,
    busy: false,
    refreshPromise: null,
    returnFocus: null,
    pendingFeature: '',
  };

  const byId = (id) => document.getElementById(id);

  function normalizeCommerce(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const supported = value.supported === true;
    const pro = value.pro === true;
    const displayPrice = value.displayPrice == null || value.displayPrice === ''
      ? null
      : String(value.displayPrice);
    const status = String(value.status || (pro ? 'active' : supported ? 'available' : 'preview'));
    return {
      supported,
      pro,
      productId: value.productId == null ? '' : String(value.productId),
      displayPrice,
      status,
      // Native messages are only displayed when every supported UI locale has a translation.
      message: value.message == null ? '' : !window.GAIL10n
        ? String(value.message)
        : window.GAIL10n.hasTranslation(String(value.message))
          ? featureText(String(value.message)) : '',
    };
  }

  function commerceApi() {
    return window.electronAPI || {};
  }

  function statusLabel(snapshot) {
    if (snapshot.pro) return featureText("Pro 已啟用");
    if (snapshot.status === 'pending') return featureText("處理中…");
    if (snapshot.status === 'cancelled') return featureText("已取消");
    if (snapshot.status === 'failed' || snapshot.status === 'unavailable') return featureText("目前無法完成");
    if (snapshot.status === 'preview') return featureText("瀏覽器預覽");
    if (!snapshot.supported) return featureText("App 內購買不可用");
    return snapshot.displayPrice ? featureText("可購買") : featureText("價格準備中");
  }

  function transactionMessage(snapshot) {
    if (snapshot.pro) return featureText("G.A.I Pro 權益已由 App 確認，進階功能現在可以使用。");
    if (snapshot.status === 'pending') return snapshot.message || featureText("正在向 App 確認交易，請稍候…");
    if (snapshot.status === 'cancelled') return snapshot.message || featureText("你已取消這次操作，現有資料與設定都保留。");
    if (snapshot.status === 'failed' || snapshot.status === 'unavailable') return snapshot.message || featureText("交易未完成；現有資料與設定都保留，請稍後再試。");
    if (snapshot.status === 'preview') return snapshot.message || PREVIEW_STATE.message;
    if (!snapshot.supported) return snapshot.message || featureText("目前環境不能進行 App 內購買；瀏覽器預覽不會解鎖 Pro。");
    return snapshot.message || featureText("一次買斷 v1 Pro 後即可使用進階功能。");
  }

  function canPurchase() {
    const snapshot = state.snapshot;
    return snapshot.supported === true && snapshot.pro !== true
      && Boolean(snapshot.displayPrice) && !state.busy;
  }

  function renderCommerce() {
    const snapshot = state.snapshot;
    const badge = byId('commerce-status-badge');
    const message = byId('commerce-status-message');
    const price = byId('commerce-price');
    const modalStatus = byId('commerce-modal-status');
    const purchaseButtons = document.querySelectorAll('.commerce-purchase-btn');
    const restoreButtons = document.querySelectorAll('.commerce-restore-btn');

    if (badge) {
      badge.textContent = statusLabel(snapshot);
      badge.classList.toggle('is-pro', snapshot.pro);
      badge.classList.toggle('is-error', snapshot.status === 'failed' || snapshot.status === 'unavailable');
    }
    if (message) message.textContent = transactionMessage(snapshot);
    if (price) {
      price.textContent = snapshot.pro
        ? featureText("已包含 v1 Pro 權益")
        : snapshot.displayPrice
          ? featureText("目前價格：{price}", { price: snapshot.displayPrice })
          : snapshot.supported
            ? featureText("價格尚未提供，暫時不能購買。")
            : featureText("價格只會在支援 App 內購買的環境顯示。");
    }

    purchaseButtons.forEach((button) => {
      button.disabled = !canPurchase();
      button.setAttribute('aria-busy', String(state.busy));
      button.textContent = state.busy
        ? featureText("正在處理…")
        : snapshot.pro
          ? featureText("Pro 已啟用")
          : snapshot.displayPrice
            ? featureText("一次買斷 Pro · {price}", { price: snapshot.displayPrice })
            : featureText("一次買斷 Pro");
    });
    restoreButtons.forEach((button) => {
      button.disabled = state.busy || !snapshot.supported;
      button.setAttribute('aria-busy', String(state.busy));
    });
    if (modalStatus) {
      modalStatus.textContent = transactionMessage(snapshot);
      modalStatus.classList.toggle('is-error', snapshot.status === 'failed' || snapshot.status === 'unavailable' || snapshot.status === 'cancelled');
      modalStatus.classList.toggle('is-success', snapshot.pro);
    }
  }

  async function readCommerceState() {
    const api = commerceApi();
    if (typeof api.getCommerce !== 'function') return { ...PREVIEW_STATE };
    return normalizeCommerce(await api.getCommerce());
  }

  async function refreshCommerce() {
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = readCommerceState()
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.ready = true;
        renderCommerce();
        return snapshot;
      })
      .catch((error) => {
        state.snapshot = {
          supported: false,
          pro: false,
          productId: '',
          displayPrice: null,
          status: 'failed',
          message: featureText("無法讀取 Pro 權益狀態，請稍後再試。"),
        };
        state.ready = true;
        renderCommerce();
        return state.snapshot;
      })
      .finally(() => {
        state.refreshPromise = null;
      });
    return state.refreshPromise;
  }

  function featureLabel(feature) {
    return FEATURE_LABELS[feature] || featureText("這項進階功能");
  }

  function openProDialog(feature = '') {
    const modal = byId('commerce-pro-modal');
    if (!modal || state.snapshot.pro) return;
    state.pendingFeature = feature;
    state.returnFocus = document.activeElement;
    const description = byId('commerce-pro-description');
    if (description) {
      description.textContent = feature
        ? featureText("{feature}屬於 G.A.I Pro；基本閱讀與資料安全功能仍可繼續使用。", { feature: featureLabel(feature) })
        : featureText("基本閱讀免費；Pro 以一次買斷解鎖需要付費的進階工具。");
    }
    modal.hidden = false;
    document.body.classList.add('commerce-modal-open');
    renderCommerce();
    byId('commerce-pro-close')?.focus({ preventScroll: true });
  }

  function closeProDialog() {
    const modal = byId('commerce-pro-modal');
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('commerce-modal-open');
    state.returnFocus?.focus?.({ preventScroll: true });
    state.returnFocus = null;
    state.pendingFeature = '';
  }

  function errorMessage(error) {
    return error?.message == null ? String(error || '') : String(error.message);
  }

  function handleError(error) {
    const message = errorMessage(error);
    if (!/^PRO_REQUIRED\s*:/i.test(message)) return false;
    state.snapshot = { ...state.snapshot, pro: false };
    openProDialog();
    const modalStatus = byId('commerce-modal-status');
    if (modalStatus) {
      modalStatus.textContent = featureText("這項功能需要 G.A.I Pro。");
      modalStatus.classList.add('is-error');
    }
    return true;
  }

  function normalizeTransactionStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value.includes('cancel')) return 'cancelled';
    if (value === 'unavailable' || value.includes('fail') || value.includes('error') || value.includes('reject')) return 'failed';
    if (value.includes('pending') || value.includes('wait')) return 'pending';
    return value || 'failed';
  }

  async function transact(method, label) {
    if (state.busy) return false;
    const api = commerceApi();
    if (typeof api[method] !== 'function') {
      state.snapshot = { ...state.snapshot, status: 'failed', message: featureText("此環境不支援 App 內購買。") };
      renderCommerce();
      return false;
    }
    if (method === 'purchasePro' && !canPurchase()) return false;

    state.busy = true;
    state.snapshot = { ...state.snapshot, status: 'pending', message: featureText("{label}正在處理，請稍候…", { label }) };
    renderCommerce();
    try {
      const result = normalizeCommerce(await api[method]());
      const transactionStatus = normalizeTransactionStatus(result.status);
      const verified = result.pro === true;
      state.snapshot = verified
        ? { ...result, status: 'active', message: featureText("G.A.I Pro 權益已由 App 確認。") }
        : {
          ...result,
          status: transactionStatus,
          message: transactionStatus === 'cancelled'
            ? featureText("你已取消這次操作，現有資料與設定都保留。")
            : transactionStatus === 'failed'
              ? result.message || featureText("交易失敗，現有資料與設定都保留。")
              : result.message || featureText("交易結果尚未確認；請稍後查看或使用恢復購買。"),
        };
      renderCommerce();
      // The native response remains authoritative. Re-read it after a result
      // so a transaction receipt that updates asynchronously can be observed.
      if (!verified && typeof api.getCommerce === 'function') {
        const transactionSnapshot = { ...state.snapshot };
        const refreshed = await refreshCommerce();
        if (!refreshed.pro && ['cancelled', 'failed', 'pending'].includes(transactionStatus)) {
          state.snapshot = {
            ...refreshed,
            status: transactionStatus,
            message: transactionSnapshot.message,
          };
          renderCommerce();
        }
      }
      return verified;
    } catch (error) {
      if (!handleError(error)) {
        state.snapshot = {
          ...state.snapshot,
          status: /cancel/i.test(errorMessage(error)) ? 'cancelled' : 'failed',
          message: /cancel/i.test(errorMessage(error))
            ? featureText("你已取消這次操作，現有資料與設定都保留。")
            : featureText("操作失敗，請稍後再試。"),
        };
      } else {
        state.snapshot = { ...state.snapshot, status: 'failed', message: featureText("這項功能需要 G.A.I Pro；現有資料與設定都保留。") };
      }
      renderCommerce();
      return false;
    } finally {
      state.busy = false;
      renderCommerce();
    }
  }

  function ensure(feature) {
    if (state.ready && state.snapshot.pro) return true;
    openProDialog(feature);
    return false;
  }

  function paidFeatureForTarget(target) {
    if (!target || typeof target.closest !== 'function') return '';
    if (target.closest('#smb-setup-btn')) return 'direct-nas';
    if (target.closest('#organize-duplicates')) return 'duplicates';
    if (target.closest('#organize-inbox, #organize-apply, #organize-exclude-tag, #organize-folder-rule, #organize-reimport, #organize-tag, #organize-author, #organize-series, #organize-language, #organize-direction')) return 'batch';
    if (target.closest('#btn-ai-explain, #btn-ai-auto-explain, #ai-save-btn, #ai-test-btn, .inspector-ai-action, .ai-page-btn')) return 'ai';
    return '';
  }

  function installFocusTrap() {
    document.addEventListener('keydown', (event) => {
      const modal = byId('commerce-pro-modal');
      if (!modal || modal.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeProDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]')]
        .filter(element => !element.matches(':disabled') && element.tabIndex >= 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function bindCommerceUi() {
    byId('commerce-pro-close')?.addEventListener('click', closeProDialog);
    byId('commerce-more-btn')?.addEventListener('click', () => openProDialog());
    document.querySelectorAll('.commerce-purchase-btn').forEach((button) => {
      button.addEventListener('click', () => { void transact('purchasePro', featureText("購買")); });
    });
    document.querySelectorAll('.commerce-restore-btn').forEach((button) => {
      button.addEventListener('click', () => { void transact('restorePro', featureText("恢復購買")); });
    });
    byId('commerce-pro-modal')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeProDialog();
    });
    document.addEventListener('click', (event) => {
      const feature = paidFeatureForTarget(event.target);
      if (!feature || ensure(feature)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    installFocusTrap();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshCommerce();
    });
    void refreshCommerce();
  }

  window.GaiCommerce = {
    ensure,
    handleError,
    refresh: refreshCommerce,
    getState: () => ({ ...state.snapshot, busy: state.busy, ready: state.ready }),
    open: openProDialog,
    close: closeProDialog,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindCommerceUi, { once: true });
  else bindCommerceUi();
})();
