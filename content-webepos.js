/**
 * Web EPOS products content script.
 *
 * Mirrors the eBay research flow: instead of the background scraping the
 * products table the instant the tab loads, it sends WEBEPOS_WAITING_FOR_DATA to
 * this tab. We then:
 *   1. Show a loading overlay and auto-filter the Web EPOS store selector to the
 *      store the operator is logged into on NosPos (same store-match heuristic
 *      the backend uses) — just like eBay auto-applies its required filters.
 *   2. Drop a "filter then allow" panel so the operator can refine the list and,
 *      when ready, allow the scrape (WEBEPOS_SCRAPE_CONFIRM). "Cancel" sends
 *      WEBEPOS_SCRAPE_CANCEL. After that they can keep using the page freely.
 *
 * The store the operator ends on (the `#storeId` filter) is read by the
 * background's scrape and surfaces as "Displayed products from <store> store" in
 * Cash EPOS.
 */
(function () {
  'use strict';

  var PANEL_ID = 'cg-suite-webepos-panel';
  var OVERLAY_ID = 'cg-suite-webepos-overlay';
  var escapeHtml = CG_DOM_UTILS.escapeHtml;
  var currentRequestId = null;
  // Keeps the store-match flag in sync while the panel is open — Web EPOS
  // populates/auto-selects the store <select> asynchronously (and via React, so
  // no 'change' event fires), so a one-shot check on panel build goes stale.
  var matchPollTimer = null;

  function findStoreSelect() {
    return document.querySelector('#storeId, select[name="storeId"]');
  }

  function findStatusSelect() {
    return document.querySelector('#status, select[name="status"]');
  }

  // The store/status actually APPLIED to the list — i.e. the values as of the
  // last "Filter" click. Web EPOS doesn't apply a <select> change until Filter is
  // pressed, so when a dropdown differs from these the operator changed it but
  // hasn't applied it: the list (and any scrape) is still on the OLD store/status.
  var appliedStoreValue = null;
  var appliedStatusValue = null;

  function markFiltersApplied() {
    var s = findStoreSelect();
    appliedStoreValue = s ? String(s.value) : null;
    var st = findStatusSelect();
    appliedStatusValue = st ? String(st.value) : null;
  }

  /** { dirty, storeDirty, statusDirty } — a dropdown changed but Filter not pressed. */
  function getFiltersDirty() {
    var s = findStoreSelect();
    var st = findStatusSelect();
    var storeDirty = !!(s && appliedStoreValue != null && String(s.value) !== appliedStoreValue);
    var statusDirty = !!(st && appliedStatusValue != null && String(st.value) !== appliedStatusValue);
    return { dirty: storeDirty || statusDirty, storeDirty: storeDirty, statusDirty: statusDirty };
  }

  /**
   * Web EPOS applies the store/status filters only when the "Filter" button is
   * clicked — changing a <select> alone does not re-fetch the list. Click it, and
   * record the now-applied values.
   */
  function clickWebEposFilterButton() {
    var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
    var btn = btns.find(function (b) {
      return /^filter$/i.test(String(b.textContent || '').trim());
    });
    if (btn) {
      try {
        btn.click();
      } catch (_) {}
      markFiltersApplied();
      return true;
    }
    return false;
  }

  // Catch the operator pressing the native Filter button so we know the current
  // dropdowns are now applied (clears the dirty flag).
  document.addEventListener(
    'click',
    function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest('button') : null;
      if (btn && /^filter$/i.test(String(btn.textContent || '').trim())) {
        markFiltersApplied();
      }
    },
    true,
  );

  function readSelectedStoreName() {
    var sel = findStoreSelect();
    if (!sel) return null;
    var opt = sel.selectedOptions && sel.selectedOptions[0];
    var name = opt ? String(opt.textContent || '').trim() : '';
    return name || null;
  }

  /**
   * Canonical form for cross-system shop comparison — mirrors the backend's
   * normalizeCgShopName: lowercase, collapse whitespace, strip a leading/trailing
   * "cg" token. So "CG Warrington" == "Warrington".
   */
  function normShop(name) {
    var s = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.indexOf('cg ') === 0) s = s.slice(3).trim();
    if (s.length > 3 && s.lastIndexOf(' cg') === s.length - 3) s = s.slice(0, -3).trim();
    return s;
  }

  /**
   * Pick the Web EPOS store <option> for the operator's store. Prefers the
   * distinctive `expectedShopMatch` substring (the backend's reliable path);
   * falls back to normalised-name containment against the NosPos navbar label.
   */
  function findMatchingStoreOption(sel, nosposShop, expectedShopMatch) {
    if (!sel) return null;
    var opts = Array.prototype.slice.call(sel.options || []);
    var needle = String(expectedShopMatch || '').toLowerCase().trim();
    if (needle) {
      for (var i = 0; i < opts.length; i++) {
        var txt = String(opts[i].textContent || '').toLowerCase();
        if (txt.indexOf(needle) !== -1) return opts[i];
      }
    }
    var target = normShop(nosposShop);
    if (target) {
      for (var j = 0; j < opts.length; j++) {
        var n = normShop(opts[j].textContent);
        if (!n) continue;
        if (n === target || target.indexOf(n) !== -1 || n.indexOf(target) !== -1) return opts[j];
      }
    }
    return null;
  }

  /**
   * Same heuristic the auto-filter uses, but as a yes/no for the currently
   * selected store: does the Web EPOS store the operator has chosen match the
   * NosPos store they're logged into? Mirrors the backend's shop-match logic
   * (`expectedShopMatch` substring preferred, normalised-name containment
   * fallback). Returns 'match' | 'mismatch' | 'unknown' (unknown = we have no
   * NosPos store to compare against, so we don't flag anything).
   */
  function computeStoreMatchState(nosposShop, expectedShopMatch) {
    if (!nosposShop && !expectedShopMatch) return 'unknown';
    var sel = findStoreSelect();
    if (!sel) return 'unknown';
    var selName = readSelectedStoreName();
    if (!selName) return 'mismatch';
    var opt = findMatchingStoreOption(sel, nosposShop, expectedShopMatch);
    if (!opt) return 'mismatch';
    return String(sel.value) === String(opt.value) ? 'match' : 'mismatch';
  }

  /** Does the NosPos navbar shop match the Cash EPOS store (same heuristic)? */
  function nosposMatchesCash(nosposShop, expectedCgShopName, expectedShopMatch) {
    var label = String(nosposShop || '');
    if (!label) return false;
    var needle = String(expectedShopMatch || '').toLowerCase().trim();
    if (needle) return label.toLowerCase().indexOf(needle) !== -1;
    var a = normShop(label);
    var b = normShop(expectedCgShopName);
    if (!a || !b) return false;
    return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
  }

  /** True only when NosPos positively disagrees with Cash EPOS (else don't flag). */
  function nosposIsMismatch(nosposShop, expectedCgShopName, expectedShopMatch) {
    if (!nosposShop) return false;
    if (!expectedShopMatch && !expectedCgShopName) return false;
    return !nosposMatchesCash(nosposShop, expectedCgShopName, expectedShopMatch);
  }

  /**
   * Event-driven wait — fires as soon as `predicate()` is truthy after a DOM
   * mutation (MutationObserver isn't throttled in background tabs the way timers
   * are). Mirrors the gate used by the background scrape.
   */
  function waitForDomCondition(predicate, timeoutMs) {
    return new Promise(function (resolve) {
      try {
        if (predicate()) return resolve(true);
      } catch (_) {}
      var done = false;
      var obs = new MutationObserver(function () {
        if (done) return;
        try {
          if (predicate()) {
            done = true;
            obs.disconnect();
            clearTimeout(to);
            resolve(true);
          }
        } catch (_) {}
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      var to = setTimeout(function () {
        if (done) return;
        done = true;
        obs.disconnect();
        resolve(false);
      }, Math.max(100, timeoutMs));
    });
  }

  function firstRowBarcode() {
    var tr = document.querySelector('tbody tr');
    if (!tr) return '';
    var cell = tr.querySelector('td');
    return cell ? String(cell.textContent || '').trim().replace(/\s+/g, ' ') : '';
  }

  /**
   * Select `opt` in the store filter and let Web EPOS (React) re-fetch the list.
   * Returns once the table appears to have refreshed (or a short cap elapses).
   * No-op (returns immediately) if it's already the selected option.
   */
  async function applyStoreFilter(sel, opt) {
    if (!sel || !opt) return false;
    if (sel.value === opt.value) return true;
    var before = firstRowBarcode();
    // Use the native value setter so React's controlled <select> actually
    // registers the change. Assigning `sel.value` directly is swallowed by
    // React's value tracker, so the list would never re-fetch for the new store
    // and the first-load scrape would read the WRONG (default first) store.
    try {
      var proto = Object.getPrototypeOf(sel);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(sel, opt.value);
      else sel.value = opt.value;
    } catch (_) {
      sel.value = opt.value;
    }
    try {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {}
    try {
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
    // Web EPOS doesn't re-fetch on select change — you must click the Filter
    // button to apply it. Without this the store dropdown shows the right store
    // but the list (and the scrape) stays on the old one.
    clickWebEposFilterButton();
    // Wait for the product rows to swap (Filter triggers the re-fetch). Cap
    // short so a no-op selection or an already-empty store doesn't hang the UI.
    await waitForDomCondition(function () {
      var bc = firstRowBarcode();
      return bc && bc !== before;
    }, 8000);
    return true;
  }

  function removeOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
  }

  function showOverlay(storeName) {
    removeOverlay();
    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    var shadow = overlay.attachShadow({ mode: 'open' });
    var label = storeName
      ? 'Filtering to ' + escapeHtml(storeName) + '…'
      : 'Preparing the products list…';
    shadow.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.cg-ov{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(15,23,42,0.78);' +
      'font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#fff}' +
      '.cg-ov-inner{display:flex;flex-direction:column;align-items:center;gap:18px}' +
      '.cg-spin{width:46px;height:46px;border-radius:50%;border:4px solid rgba(255,255,255,0.25);' +
      'border-top-color:#facc15;animation:cg-spin 0.8s linear infinite}' +
      '.cg-ov-text{font-size:16px;font-weight:700;letter-spacing:-0.01em}' +
      '@keyframes cg-spin{to{transform:rotate(360deg)}}' +
      '</style>' +
      '<div class="cg-ov"><div class="cg-ov-inner">' +
      '<div class="cg-spin"></div>' +
      '<div class="cg-ov-text">' + label + '</div>' +
      '</div></div>';
    document.body.appendChild(overlay);
  }

  function removePanel() {
    if (matchPollTimer) {
      clearInterval(matchPollTimer);
      matchPollTimer = null;
    }
    var existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  function sendToBackground(type) {
    if (!currentRequestId) return;
    try {
      chrome.runtime.sendMessage({ type: type, requestId: currentRequestId });
    } catch (_) {}
    currentRequestId = null;
  }

  function showPanel(nosposShop, expectedShopMatch, expectedCgShopName) {
    removePanel();

    var storeName = readSelectedStoreName();
    var cashLabel = expectedCgShopName || expectedShopMatch || '';
    var nosposLine = nosposShop
      ? 'You’re logged into NosPos as <strong>' + escapeHtml(nosposShop) + '</strong>.'
      : 'We couldn’t detect your NosPos store — make sure you’re logged in.';

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    var shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      ':host{display:block;margin:0;padding:0;border:0;background:transparent}' +
      '.cg-pos{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;' +
      'pointer-events:none;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
      'font-size:14px;line-height:1.45;color:#fff;-webkit-font-smoothing:antialiased}' +
      '.cg-card{pointer-events:auto;width:268px;min-width:268px;max-width:268px;box-sizing:border-box;' +
      'background:#1e3a8a;padding:18px 20px;border-radius:14px 0 0 14px;box-shadow:-8px 8px 28px rgba(0,0,0,0.42);' +
      'max-height:min(90vh,640px);overflow-y:auto}' +
      'h1.cg-h{margin:0 0 10px;font-size:17px;font-weight:800;line-height:1.25;letter-spacing:-0.02em}' +
      '.cg-note{margin:0 0 12px;font-size:13px;line-height:1.55;opacity:0.95}' +
      '.cg-box{margin:0 0 14px;padding:10px 12px;background:rgba(255,255,255,0.12);border-radius:10px;' +
      'font-size:12.5px;line-height:1.5}' +
      '.cg-box .cg-row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}' +
      '.cg-box .cg-row + .cg-row{margin-top:6px}' +
      '.cg-box .cg-label{opacity:0.8}' +
      '.cg-box .cg-val{font-weight:700;text-align:right;word-break:break-word}' +
      '.cg-flag{margin-left:8px;display:none;align-items:center;gap:4px;color:#fff;background:#dc2626;' +
      'border-radius:9999px;padding:1px 8px;font-size:10px;font-weight:800;text-transform:uppercase;' +
      'letter-spacing:0.04em;vertical-align:middle;box-shadow:0 0 0 2px rgba(220,38,38,0.35)}' +
      '.cg-warn{display:none;margin:0 0 12px;padding:9px 11px;background:rgba(220,38,38,0.2);' +
      'border:1px solid rgba(248,113,113,0.7);border-radius:9px;font-size:12px;line-height:1.45;color:#fee2e2}' +
      '.cg-fwarn{display:none;margin:0 0 12px;padding:9px 11px;background:rgba(245,158,11,0.24);' +
      'border:1px solid rgba(251,191,36,0.85);border-radius:9px;font-size:12px;line-height:1.45;color:#fef3c7}' +
      'button.cg-yes:disabled{opacity:0.5;cursor:not-allowed;box-shadow:none}' +
      '.cg-actions{display:flex;flex-direction:column;gap:8px;margin-top:4px}' +
      'button.cg-yes{width:100%;padding:12px 16px;margin:0;background:#facc15;color:#020617;border:none;' +
      'border-radius:9999px;font:inherit;font-weight:900;font-size:15px;cursor:pointer;text-transform:uppercase;' +
      'letter-spacing:0.06em;box-shadow:0 8px 18px rgba(0,0,0,0.45)}' +
      'button.cg-cancel{width:100%;padding:10px 14px;margin:0;background:transparent;color:#e5e7eb;' +
      'border:1px solid rgba(248,250,252,0.5);border-radius:9999px;font:inherit;font-weight:600;font-size:13px;cursor:pointer}' +
      '</style>' +
      '<div class="cg-pos"><div class="cg-card">' +
      '<h1 class="cg-h">Filter the products you want</h1>' +
      '<p class="cg-note">For consistency, keep Cash EPOS, NosPos and Web EPOS on the same store. We auto-pick the matching Web EPOS store — change it only if you need to.</p>' +
      '<div class="cg-box">' +
      '<div class="cg-row"><span class="cg-label">Cash EPOS store</span>' +
      '<span class="cg-val">' + (cashLabel ? escapeHtml(cashLabel) : '—') + '</span></div>' +
      '<div class="cg-row"><span class="cg-label">NosPos store</span>' +
      '<span class="cg-val"><span>' + (nosposShop ? escapeHtml(nosposShop) : '—') + '</span>' +
      '<span class="cg-flag" id="cg-nospos-flag">● mismatch</span></span></div>' +
      '<div class="cg-row"><span class="cg-label">Web EPOS store</span>' +
      '<span class="cg-val"><span id="cg-webepos-store">' + (storeName ? escapeHtml(storeName) : 'Not selected') + '</span>' +
      '<span class="cg-flag" id="cg-store-flag">● mismatch</span></span></div>' +
      '</div>' +
      '<p class="cg-warn" id="cg-store-warn">Cash EPOS, NosPos and Web EPOS aren’t all on the same store. We auto-pick the matching Web EPOS store — switch it back if you changed it. You can still continue.</p>' +
      '<p class="cg-note" style="margin-bottom:14px;">' + nosposLine + '</p>' +
      '<p class="cg-fwarn" id="cg-filter-warn">You changed the store or status but haven’t pressed ' +
      '<strong>Filter</strong> in Web EPOS — the list is still on the old one. Press Filter to apply, ' +
      'then get the products.</p>' +
      '<div class="cg-actions">' +
      '<button type="button" class="cg-yes" id="cg-webepos-yes">Get these products</button>' +
      '<button type="button" class="cg-cancel" id="cg-webepos-cancel">Cancel</button>' +
      '</div></div></div>';

    document.body.appendChild(panel);
    var sr = panel.shadowRoot;

    // Red "mismatch" marker: flag (but don't block) when the selected Web EPOS
    // store doesn't match the NosPos store, using the same heuristic the backend
    // uses for the NosPos↔Cash EPOS check.
    var flagEl = sr.getElementById('cg-store-flag');
    var nosposFlagEl = sr.getElementById('cg-nospos-flag');
    var warnEl = sr.getElementById('cg-store-warn');
    var filterWarnEl = sr.getElementById('cg-filter-warn');
    var yesBtn = sr.getElementById('cg-webepos-yes');
    function refreshMatchUI() {
      var webMismatch = computeStoreMatchState(nosposShop, expectedShopMatch) === 'mismatch';
      var nosMismatch = nosposIsMismatch(nosposShop, expectedCgShopName, expectedShopMatch);
      if (flagEl) flagEl.style.display = webMismatch ? 'inline-flex' : 'none';
      if (nosposFlagEl) nosposFlagEl.style.display = nosMismatch ? 'inline-flex' : 'none';
      if (warnEl) warnEl.style.display = (webMismatch || nosMismatch) ? 'block' : 'none';
      // Block the scrape while a store/status change hasn't been applied (Filter
      // not pressed) — else we'd record the new store/status against the OLD
      // list's data. The poll keeps this live as the operator edits filters.
      var fdirty = getFiltersDirty().dirty;
      if (filterWarnEl) filterWarnEl.style.display = fdirty ? 'block' : 'none';
      if (yesBtn) yesBtn.disabled = fdirty;
    }
    refreshMatchUI();

    // Keep the "Web EPOS store" line + mismatch flag live as the operator changes
    // the filter, so they can confirm it matches their NosPos store before allowing.
    var storeSel = findStoreSelect();
    if (storeSel) {
      var valEl = sr.getElementById('cg-webepos-store');
      storeSel.addEventListener('change', function () {
        var name = readSelectedStoreName();
        if (valEl) valEl.textContent = name || 'Not selected';
        refreshMatchUI();
      });
    }

    // React updates the store <select> without a 'change' event (and the options
    // can load after this panel is built), so poll to keep the store name + flag
    // current. Cleared by removePanel (confirm / cancel / re-show).
    if (matchPollTimer) clearInterval(matchPollTimer);
    matchPollTimer = setInterval(function () {
      var name = readSelectedStoreName();
      var liveValEl = sr.getElementById('cg-webepos-store');
      if (liveValEl) liveValEl.textContent = name || 'Not selected';
      refreshMatchUI();
    }, 600);

    sr.getElementById('cg-webepos-yes').addEventListener('click', function () {
      // Don't scrape while filters are unapplied (Filter not pressed) — the list
      // would not match the selected store/status.
      if (getFiltersDirty().dirty) return;
      sendToBackground('WEBEPOS_SCRAPE_CONFIRM');
      removePanel();
    });
    sr.getElementById('cg-webepos-cancel').addEventListener('click', function () {
      sendToBackground('WEBEPOS_SCRAPE_CANCEL');
      removePanel();
    });
  }

  async function beginFlow(nosposShop, expectedShopMatch, expectedCgShopName) {
    // The freshly-loaded list reflects the current dropdowns, so they start applied.
    markFiltersApplied();
    var sel = findStoreSelect();
    var opt = findMatchingStoreOption(sel, nosposShop, expectedShopMatch);
    // Only show the loading overlay if we actually need to switch stores.
    if (sel && opt && sel.value !== opt.value) {
      showOverlay(String(opt.textContent || '').trim());
      try {
        await applyStoreFilter(sel, opt);
      } catch (_) {}
      removeOverlay();
    }
    showPanel(nosposShop, expectedShopMatch, expectedCgShopName);
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== 'WEBEPOS_WAITING_FOR_DATA') return false;
    currentRequestId = msg.requestId;
    beginFlow(msg.nosposShop || null, msg.expectedShopMatch || null, msg.expectedCgShopName || null);
    sendResponse({ ok: true });
    return false;
  });

  /** Only the products *list* page hosts the filter/allow panel. */
  function onWebEposProductsPage() {
    try {
      var p = String(location.pathname || '').toLowerCase();
      return /^\/products\/?$/.test(p);
    } catch (_) {
      return false;
    }
  }

  /**
   * Tell the background we're (re)loaded on the Web EPOS products page so it can
   * re-send WEBEPOS_WAITING_FOR_DATA when a scrape is still pending for this tab.
   * This is what makes the filter panel survive a page reload — the same
   * handshake content-listings uses for CeX/eBay (LISTING_PAGE_READY). We stop
   * announcing as soon as the request arrives (currentRequestId set) so the panel
   * never re-runs/flickers; on first open the background pushes it directly and
   * this just no-ops.
   */
  function announceWebEposReady() {
    if (currentRequestId) return;
    if (!onWebEposProductsPage()) return;
    try {
      chrome.runtime.sendMessage({ type: 'WEBEPOS_PAGE_READY' });
    } catch (_) {}
  }

  announceWebEposReady();
  // A couple of short retries cover the open-race (background hasn't stored the
  // pending scrape yet); each is a no-op once WAITING_FOR_DATA has landed.
  setTimeout(announceWebEposReady, 700);
  setTimeout(announceWebEposReady, 1600);
})();
