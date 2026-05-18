/**
 * Full-page input-blocking overlay during CG Suite Park Agreement.
 * A very transparent dark-blue backdrop covers the whole page (blocks all clicks/input)
 * while keeping everything visible. A floating status badge sits at the top-centre.
 */
(function () {
  if (window.__cgNosposParkOverlayHooked) return;
  window.__cgNosposParkOverlayHooked = true;

  var OVERLAY_ID = 'cg-suite-nospos-park-overlay';
  var STYLE_ID = 'cg-suite-nospos-park-overlay-style';
  var DEFAULT_MSG =
    'CG Suite is updating this agreement — please wait. Do not use this tab until finished.';

  function showParkLoadingOverlay(message) {
    var text = (message && String(message).trim()) || DEFAULT_MSG;
    var existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      if (existing.getAttribute('data-cg-overlay-kind') === 'duplicate') {
        existing.remove();
        existing = null;
      } else {
        var span = existing.querySelector('.cg-suite-nospos-park-msg');
        if (span) span.textContent = text;
        return;
      }
    }

    // Full-page backdrop — blocks all pointer events so the user cannot click anything,
    // but opacity is very low so page content remains clearly readable.
    var root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('data-cg-overlay-kind', 'loading');
    root.setAttribute('aria-busy', 'true');
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 2147483646',
      'pointer-events: all',
      'box-sizing: border-box',
      'background: rgba(8, 18, 56, 0.13)',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: flex-start',
      'padding-top: 18px',
      'cursor: not-allowed',
    ].join(';');

    // Floating badge — sits inside the backdrop, centred at the top.
    root.innerHTML =
      '<div style="pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:14px 20px;border-radius:14px;background:rgba(10,20,50,0.92);border:1px solid rgba(250,204,21,0.4);box-shadow:0 10px 36px rgba(0,0,0,0.4);max-width:min(440px,calc(100vw - 28px));cursor:default;">' +
      '<div class="cg-suite-nospos-park-spinner" style="width:36px;height:36px;border:3px solid rgba(254,249,195,0.3);border-top-color:#facc15;border-radius:50%;animation:cg-suite-nospos-park-spin 0.85s linear infinite;flex-shrink:0;"></div>' +
      '<span class="cg-suite-nospos-park-msg" style="font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:600;color:#f1f5f9;line-height:1.5;letter-spacing:0.01em;"></span>' +
      '</div>';

    var msgEl = root.querySelector('.cg-suite-nospos-park-msg');
    if (msgEl) msgEl.textContent = text;

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '@keyframes cg-suite-nospos-park-spin { to { transform: rotate(360deg); } }';
    document.documentElement.appendChild(style);
    (document.body || document.documentElement).appendChild(root);
  }

  function removeParkLoadingOverlay() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
    var styleEl = document.getElementById(STYLE_ID);
    if (styleEl) styleEl.remove();
  }

  function showDuplicatePromptOverlay(requestId, _agreementId) {
    var rid = requestId && String(requestId).trim();
    if (!rid) return;
    removeParkLoadingOverlay();

    var root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('data-cg-overlay-kind', 'duplicate');
    root.setAttribute('aria-busy', 'true');
    root.setAttribute('aria-live', 'assertive');
    root.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 2147483646',
      'pointer-events: all',
      'box-sizing: border-box',
      'background: rgba(8, 18, 56, 0.18)',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: flex-start',
      'padding-top: 18px',
      'cursor: not-allowed',
    ].join(';');

    root.innerHTML =
      '<div style="pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:18px 22px;border-radius:14px;background:rgba(10,20,50,0.94);border:1px solid rgba(250,204,21,0.45);box-shadow:0 10px 36px rgba(0,0,0,0.45);max-width:min(520px,calc(100vw - 28px));cursor:default;">' +
      '<span style="font-family:Inter,system-ui,sans-serif;font-size:14px;font-weight:800;color:#facc15;letter-spacing:0.02em;">Draft agreement already on this customer</span>' +
      '<span class="cg-suite-nospos-park-msg" style="font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:600;color:#f1f5f9;line-height:1.55;">NoSpos didn\'t create a new agreement because a draft agreement already exists for this customer. Should we delete it?</span>' +
      '<div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:6px;">' +
      '<button type="button" class="cg-suite-nospos-dup-delete" style="font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:700;padding:10px 20px;border-radius:10px;border:1px solid rgba(248,113,113,0.6);background:rgba(127,29,29,0.85);color:#fecaca;cursor:pointer;">Delete draft</button>' +
      '<button type="button" class="cg-suite-nospos-dup-no" style="font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:700;padding:10px 20px;border-radius:10px;border:1px solid rgba(148,163,184,0.5);background:rgba(30,41,59,0.9);color:#e2e8f0;cursor:pointer;">Cancel</button>' +
      '</div></div>';

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '@keyframes cg-suite-nospos-park-spin { to { transform: rotate(360deg); } }';
    document.documentElement.appendChild(style);
    (document.body || document.documentElement).appendChild(root);

    function sendChoice(choice) {
      try {
        chrome.runtime.sendMessage({
          type: 'NOSPOS_PARK_DUPLICATE_CHOICE',
          requestId: rid,
          choice: choice,
        });
      } catch (_) {}
    }
    var delBtn = root.querySelector('.cg-suite-nospos-dup-delete');
    var noBtn = root.querySelector('.cg-suite-nospos-dup-no');
    if (delBtn) delBtn.addEventListener('click', function () { sendChoice('delete'); });
    if (noBtn) noBtn.addEventListener('click', function () { sendChoice('cancel'); });
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === 'NOSPOS_PARK_OVERLAY') {
      if (msg.show) showParkLoadingOverlay(msg.message);
      else removeParkLoadingOverlay();
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'NOSPOS_PARK_OVERLAY_DUPLICATE_PROMPT') {
      showDuplicatePromptOverlay(msg.requestId, msg.agreementId);
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  function syncParkOverlayFromBackground() {
    try {
      chrome.runtime.sendMessage({ type: 'NOSPOS_PARK_UI_SYNC' }, function (r) {
        if (chrome.runtime.lastError) return;
        if (r && r.show) {
          if (r.duplicatePrompt && r.duplicatePrompt.requestId) {
            showDuplicatePromptOverlay(
              r.duplicatePrompt.requestId,
              r.duplicatePrompt.agreementId
            );
          } else {
            showParkLoadingOverlay(r.message);
          }
        } else removeParkLoadingOverlay();
      });
    } catch (_) {}
  }

  function runSync() {
    if (document.body) syncParkOverlayFromBackground();
    else document.addEventListener('DOMContentLoaded', syncParkOverlayFromBackground, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runSync, { once: true });
  } else {
    runSync();
  }

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) syncParkOverlayFromBackground();
  });
})();
