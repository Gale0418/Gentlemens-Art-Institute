(() => {
  'use strict';

  const PANEL_NAMES = ['display', 'modes', 'ai'];
  const FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex]';
  const TAP_MOVE_TOLERANCE = 12;

  function create({ root, onChange = () => {} } = {}) {
    if (!root || !root.ownerDocument) throw new TypeError('root with ownerDocument is required');

    const doc = root.ownerDocument;
    const triggers = new Map();
    const panels = new Map();
    const cleanup = [];
    let current = null;
    let destroyed = false;
    let pointer = null;
    let suppressCompatibilityMouse = false;
    let suppressNextOutsideClick = false;
    let dismissTouchSequence = false;

    for (const name of PANEL_NAMES) {
      const trigger = root.querySelector(`[data-reader-panel-toggle="${name}"]`);
      const panel = root.querySelector(`[data-reader-panel="${name}"]`);
      if (!trigger || !panel) continue;
      triggers.set(name, trigger);
      panels.set(name, panel);
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', panel.id || trigger.getAttribute('aria-controls') || '');
    }

    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      cleanup.push(() => target.removeEventListener(type, handler, options));
    };

    const isAvailable = element => {
      if (!element || element.isConnected === false || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
      if (element.tabIndex < 0) return false;
      for (let node = element; node && node !== root.parentElement; node = node.parentElement) {
        if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
        if (node === root) break;
      }
      return true;
    };

    const focusables = panel => Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isAvailable);

    const focusControlAt = (panel, target) => {
      if (!panel || !target || !panel.contains(target)) return;
      const control = focusables(panel).find(item => item === target || item.contains(target));
      if (control && doc.activeElement !== control && isAvailable(control)) control.focus();
    };

    const toolbar = (() => {
      const nodes = [...triggers.values(), ...panels.values()];
      if (!nodes.length) return null;
      let candidate = nodes[0];
      while (candidate && !nodes.every(node => candidate.contains(node))) candidate = candidate.parentElement;
      return candidate && root.contains(candidate) ? candidate : null;
    })();

    const close = ({ restoreFocus = true } = {}) => {
      if (!current) return false;
      const name = current;
      const trigger = triggers.get(name);
      const panel = panels.get(name);
      current = null;
      if (panel) panel.hidden = true;
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      onChange(null);
      if (restoreFocus && !destroyed && isAvailable(trigger)) trigger.focus();
      return true;
    };

    const toggle = name => {
      if (destroyed || !panels.has(name)) return false;
      if (current === name) return close();
      if (current) {
        panels.get(current).hidden = true;
        triggers.get(current)?.setAttribute('aria-expanded', 'false');
      }
      current = name;
      for (const [panelName, panel] of panels) {
        const open = panelName === name;
        panel.hidden = !open;
        triggers.get(panelName)?.setAttribute('aria-expanded', String(open));
      }
      onChange(name);
      const first = focusables(panels.get(name))[0];
      first?.focus();
      return true;
    };

    for (const [name, trigger] of triggers) {
      listen(trigger, 'click', event => {
        event.preventDefault();
        toggle(name);
      });
    }
    for (const panel of panels.values()) {
      for (const button of panel.querySelectorAll('[data-reader-panel-close]')) {
        listen(button, 'click', event => {
          event.preventDefault();
          close();
        });
      }
    }

    listen(doc, 'keydown', event => {
      if (!current || destroyed) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      event.stopPropagation();
      const items = focusables(panels.get(current));
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const active = doc.activeElement;
      const index = items.indexOf(active);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && (index === -1 || index === items.length - 1)) {
        event.preventDefault();
        items[0].focus();
      }
    }, true);

    listen(doc, 'touchstart', event => {
      if (!current || destroyed || !event.target || panels.get(current)?.contains(event.target)) return;
      if ([...triggers.values()].some(trigger => trigger.contains(event.target))) return;
      if (toolbar?.contains(event.target)) {
        close({ restoreFocus: false });
        return;
      }
      dismissTouchSequence = true;
      suppressNextOutsideClick = true;
      pointer = null;
      close({ restoreFocus: false });
      event.stopImmediatePropagation();
    }, true);

    listen(doc, 'pointerdown', event => {
      if (dismissTouchSequence && event.pointerType === 'touch') {
        event.stopImmediatePropagation();
        return;
      }
      if (suppressCompatibilityMouse && event.pointerType === 'mouse' && event.sourceCapabilities?.firesTouchEvents) {
        event.stopImmediatePropagation();
        return;
      }
      pointer = null;
      suppressNextOutsideClick = false;
      suppressCompatibilityMouse = false;
      if (!current || destroyed || !event.target || panels.get(current)?.contains(event.target)) return;
      if ([...triggers.values()].some(trigger => trigger.contains(event.target))) return;
      const inToolbar = toolbar?.contains(event.target) ?? false;
      if (!inToolbar) {
        suppressNextOutsideClick = true;
        pointer = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          target: event.target,
          moved: false,
          touch: event.pointerType === 'touch',
        };
      }
      close({ restoreFocus: false });
    }, true);

    // Some WebKit controls (notably range inputs) do not receive focus from a mouse click.
    // Focus them explicitly without cancelling pointer defaults, so native dragging remains intact.
    listen(doc, 'pointerdown', event => {
      if (!current || destroyed) return;
      focusControlAt(panels.get(current), event.target);
    }, true);

    listen(doc, 'pointermove', event => {
      if (!pointer || (pointer.id != null && event.pointerId !== pointer.id)) return;
      if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > TAP_MOVE_TOLERANCE) {
        pointer.moved = true;
      }
    }, true);

    listen(doc, 'pointerup', event => {
      if (dismissTouchSequence && event.pointerType === 'touch') {
        event.stopImmediatePropagation();
        return;
      }
      if (!pointer || (pointer.id != null && event.pointerId !== pointer.id)) return;
      if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > TAP_MOVE_TOLERANCE) {
        pointer.moved = true;
      }
      if (!pointer.moved) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressCompatibilityMouse = pointer.touch;
      } else {
        suppressNextOutsideClick = false;
      }
      pointer = null;
    }, true);

    listen(doc, 'pointercancel', event => {
      if (dismissTouchSequence && event.pointerType === 'touch') event.stopImmediatePropagation();
      pointer = null;
      dismissTouchSequence = false;
      suppressNextOutsideClick = false;
      suppressCompatibilityMouse = false;
    }, true);
    listen(doc, 'touchend', event => {
      if (!dismissTouchSequence) return;
      event.stopImmediatePropagation();
      dismissTouchSequence = false;
      suppressCompatibilityMouse = true;
    }, true);
    listen(doc, 'touchcancel', event => {
      if (dismissTouchSequence) event.stopImmediatePropagation();
      dismissTouchSequence = false;
      pointer = null;
      suppressNextOutsideClick = false;
      suppressCompatibilityMouse = false;
    }, true);
    listen(doc, 'mousedown', event => {
      if (suppressCompatibilityMouse) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    listen(doc, 'click', event => {
      if (!suppressNextOutsideClick || destroyed || !event.target || toolbar?.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pointer = null;
      suppressNextOutsideClick = false;
      suppressCompatibilityMouse = false;
    }, true);
    listen(doc, 'click', event => {
      if (!current || destroyed) return;
      focusControlAt(panels.get(current), event.target);
    });

    return {
      toggle,
      close,
      isOpen: () => current !== null,
      destroy() {
        if (destroyed) return;
        close({ restoreFocus: false });
        destroyed = true;
        pointer = null;
        dismissTouchSequence = false;
        suppressNextOutsideClick = false;
        suppressCompatibilityMouse = false;
        for (const remove of cleanup.splice(0)) remove();
      },
    };
  }

  window.GAIReaderPanels = { create };
})();
