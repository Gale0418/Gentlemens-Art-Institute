/* Explicit UI localization. Library content is never translated or observed. */
(() => {
  'use strict';
  const storageKey = 'gai:language';
  const supported = ['zh-Hant', 'en', 'ja'];
  const messages = Object.create(null);
  let preference = 'auto';
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'auto' || supported.includes(saved)) preference = saved;
  } catch (_) { /* Reading still works when settings storage is unavailable. */ }

  function resolveLanguage(value) {
    const code = String(value || '').toLowerCase().replace(/_/g, '-');
    if (code === 'zh' || code.startsWith('zh-')) return 'zh-Hant';
    if (code === 'ja' || code.startsWith('ja-')) return 'ja';
    if (code === 'en' || code.startsWith('en-')) return 'en';
    return null;
  }

  function currentLocale() {
    if (preference !== 'auto') return preference;
    for (const language of navigator.languages || [navigator.language]) {
      const match = resolveLanguage(language);
      if (match) return match;
    }
    return 'en';
  }

  function t(source, variables = {}) {
    const locale = currentLocale();
    const translated = locale === 'zh-Hant' ? source : messages[source]?.[locale];
    return String(translated ?? source).replace(/\{(\w+)\}/g, (token, key) =>
      Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : token);
  }

  function register(entries) {
    for (const [source, translations] of Object.entries(entries)) {
      const entry = messages[source] || (messages[source] = Object.create(null));
      for (const locale of ['en', 'ja']) {
        if (typeof translations[locale] === 'string') entry[locale] = translations[locale];
      }
    }
  }

  function apply(root = document) {
    document.documentElement.lang = currentLocale();
    for (const element of root.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.getAttribute('data-i18n'));
    }
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
  }

  function setPreference(next) {
    if (next !== 'auto' && !supported.includes(next)) return false;
    try { localStorage.setItem(storageKey, next); } catch (_) { return false; }
    preference = next;
    return true;
  }

  window.GAIL10n = { t, register, apply, setPreference,
    get locale() { return currentLocale(); },
    get preference() { return preference; } };

  register({
    '無法儲存語言設定，請確認裝置有可用的儲存空間。': {
      en: 'Could not save the language setting. Check the available storage on your device.',
      ja: '言語設定を保存できませんでした。端末の空き容量を確認してください。',
    },
  });

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const select = document.getElementById('app-language-select');
    if (!select) return;
    select.value = preference;
    select.addEventListener('change', () => {
      if (select.value === preference) return;
      if (!setPreference(select.value)) {
        select.value = preference;
        let status = document.getElementById('app-language-status');
        if (!status) {
          status = document.createElement('p');
          status.id = 'app-language-status';
          status.setAttribute('role', 'status');
          select.parentElement.appendChild(status);
        }
        status.textContent = t('無法儲存語言設定，請確認裝置有可用的儲存空間。');
        return;
      }
      // Recreate dynamic views in the chosen language; persisted books and progress stay intact.
      window.location.reload();
    });
  });
})();
