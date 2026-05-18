/**
 * eBay "Customise search results" dialog driver. Auto-enables the columns we
 * need (seller info + item number) so card scraping is deterministic.
 *
 * Each step uses multiple strategies (class name, aria-label, visible text) to
 * survive eBay's frequent class-name churn. All waits go through
 * waitForElement() for consistency.
 *
 * Also hosts the loading overlay shown while we enforce filters or customise
 * settings, since that overlay is only ever used on eBay pages.
 *
 * Exports:
 *   waitForElement, findCustomizeButton, findCustomizeForm, findCustomizeCheckbox,
 *   findCustomizeApplyButton, detectCustomizeFieldsInCards, enforceEbayCustomizeSettings,
 *   showEbayLoadingOverlay, removeEbayLoadingOverlay
 */

/**
 * Waits up to `timeoutMs` for a DOM element matching `selector` to appear.
 * Used by enforceEbayCustomizeSettings to wait for the customize lightbox.
 */
function waitForElement(selector, timeoutMs) {
  return new Promise(function (resolve) {
    var el = document.querySelector(selector);
    if (el) { resolve(el); return; }
    var observer = new MutationObserver(function () {
      var found = document.querySelector(selector);
      if (found) { observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); resolve(null); }, timeoutMs);
  });
}

// ── Customize-dialog helpers ─────────────────────────────────────────────────
//
// Every element is located by multiple strategies in priority order.
// Each attempt is logged so you can see which strategy worked (or why it failed).

/**
 * Finds the eBay "Customise" button using three strategies:
 *   1. Class name  .srp-view-options__customize
 *   2. aria-label  "Customise"
 *   3. Text content inside .fake-menu__items buttons (most resilient to class renames)
 * Returns { el, strategy } or null.
 */
function findCustomizeButton() {
  var log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};

  var el = document.querySelector('.srp-view-options__customize');
  if (el) {
    log('[CG Suite]   findCustomizeButton: strategy 1 matched — .srp-view-options__customize');
    return { el: el, strategy: 'class (.srp-view-options__customize)' };
  }
  log('[CG Suite]   findCustomizeButton: strategy 1 — .srp-view-options__customize not found');

  el = document.querySelector('button[aria-label="Customise"]');
  if (el) {
    log('[CG Suite]   findCustomizeButton: strategy 2 matched — button[aria-label="Customise"]');
    return { el: el, strategy: 'aria-label="Customise"' };
  }
  log('[CG Suite]   findCustomizeButton: strategy 2 — button[aria-label="Customise"] not found');

  var candidates = document.querySelectorAll('.fake-menu__items button, .srp-controls button');
  for (var i = 0; i < candidates.length; i++) {
    if (/customis/i.test((candidates[i].textContent || '').trim())) {
      log('[CG Suite]   findCustomizeButton: strategy 3 matched — text "Customise" in dropdown button');
      return { el: candidates[i], strategy: 'text content "Customise" in dropdown' };
    }
  }
  log('[CG Suite]   findCustomizeButton: strategy 3 — no button with "Customise" text found (' + candidates.length + ' candidates checked)');

  log('[CG Suite]   findCustomizeButton: all strategies exhausted — button not in DOM');
  return null;
}

/**
 * Finds the customize form using three strategies:
 *   1. .s-customize-form  (class name)
 *   2. form[action*="customize"]  (form action URL)
 *   3. Any form containing a "Seller information" label
 * Returns { el, strategy } or null.
 */
function findCustomizeForm() {
  var log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};

  var el = document.querySelector('.s-customize-form');
  if (el) {
    log('[CG Suite]   findCustomizeForm: strategy 1 matched — .s-customize-form');
    return { el: el, strategy: 'class (.s-customize-form)' };
  }
  log('[CG Suite]   findCustomizeForm: strategy 1 — .s-customize-form not found');

  el = document.querySelector('form[action*="customize"]');
  if (el) {
    log('[CG Suite]   findCustomizeForm: strategy 2 matched — form[action*="customize"]');
    return { el: el, strategy: 'form[action*="customize"]' };
  }
  log('[CG Suite]   findCustomizeForm: strategy 2 — form[action*="customize"] not found');

  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i++) {
    if (/seller information/i.test((forms[i].textContent || ''))) {
      log('[CG Suite]   findCustomizeForm: strategy 3 matched — form containing "Seller information" text');
      return { el: forms[i], strategy: 'form containing "Seller information" text' };
    }
  }
  log('[CG Suite]   findCustomizeForm: strategy 3 — no form containing "Seller information" text (' + forms.length + ' forms checked)');

  log('[CG Suite]   findCustomizeForm: all strategies exhausted — form not in DOM');
  return null;
}

/**
 * Finds a checkbox input inside a form using three strategies:
 *   1. input[name="<paramName>"]            (form POST param name)
 *   2. [data-testid*="<paramName>"] input   (eBay data-testid convention)
 *   3. Label with matching text → associated input  (most resilient)
 * Returns { el, strategy } or null.
 */
function findCustomizeCheckbox(form, paramName, labelText) {
  var log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};

  var el = form.querySelector('input[name="' + paramName + '"]');
  if (el) {
    log('[CG Suite]   findCustomizeCheckbox("' + labelText + '"): strategy 1 matched — input[name="' + paramName + '"]');
    return { el: el, strategy: 'input[name="' + paramName + '"]' };
  }
  log('[CG Suite]   findCustomizeCheckbox("' + labelText + '"): strategy 1 — input[name="' + paramName + '"] not found');

  var wrapper = form.querySelector('[data-testid*="' + paramName + '"]');
  var inner = wrapper && wrapper.querySelector('input[type="checkbox"]');
  if (!inner && wrapper && wrapper.tagName === 'INPUT') inner = wrapper;
  if (inner) {
    log('[CG Suite]   findCustomizeCheckbox("' + labelText + '"): strategy 2 matched — data-testid*="' + paramName + '"');
    return { el: inner, strategy: 'data-testid*="' + paramName + '"' };
  }
  log('[CG Suite]   findCustomizeCheckbox("' + labelText + '"): strategy 2 — data-testid*="' + paramName + '" not found');

  var labels = form.querySelectorAll('label');
  for (var i = 0; i < labels.length; i++) {
    if ((labels[i].textContent || '').trim() === labelText) {
      var forId = labels[i].getAttribute('for');
      var input = forId ? form.querySelector('#' + forId) : labels[i].querySelector('input');
      if (input) {
        log('[CG Suite]   findCustomizeCheckbox("' + labelText + '"): strategy 3 matched — label text → #' + (forId || '(nested)'));
        return { el: input, strategy: 'label text "' + labelText + '"' };
      }
    }
  }
  log('[CG Suite]   findCustomizeCheckbox("' + labelText + '"): strategy 3 — label "' + labelText + '" not found (' + labels.length + ' labels checked)');

  log('[CG Suite]   findCustomizeCheckbox("' + labelText + '"): all strategies exhausted — checkbox not found');
  return null;
}

/**
 * Finds the "Apply changes" submit button inside the customize form using three strategies:
 *   1. [data-testid="cust-apply"]   (eBay test id)
 *   2. button.btn--primary           (primary button class)
 *   3. Button whose text is "Apply changes"
 * Returns { el, strategy } or null.
 */
function findCustomizeApplyButton(form) {
  var log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};

  var el = form.querySelector('[data-testid="cust-apply"]');
  if (el) {
    log('[CG Suite]   findCustomizeApplyButton: strategy 1 matched — [data-testid="cust-apply"]');
    return { el: el, strategy: 'data-testid="cust-apply"' };
  }
  log('[CG Suite]   findCustomizeApplyButton: strategy 1 — [data-testid="cust-apply"] not found');

  el = form.querySelector('button.btn--primary');
  if (el) {
    log('[CG Suite]   findCustomizeApplyButton: strategy 2 matched — button.btn--primary');
    return { el: el, strategy: 'button.btn--primary' };
  }
  log('[CG Suite]   findCustomizeApplyButton: strategy 2 — button.btn--primary not found');

  var btns = form.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    if (/apply changes/i.test((btns[i].textContent || '').trim())) {
      log('[CG Suite]   findCustomizeApplyButton: strategy 3 matched — button text "Apply changes"');
      return { el: btns[i], strategy: 'button text "Apply changes"' };
    }
  }
  log('[CG Suite]   findCustomizeApplyButton: strategy 3 — no button with "Apply changes" text (' + btns.length + ' buttons checked)');

  log('[CG Suite]   findCustomizeApplyButton: all strategies exhausted — apply button not found');
  return null;
}

/**
 * Checks whether seller info AND item number are already visible on at least one
 * result card. Both must be present for us to skip the Customise flow.
 *
 * Seller info — three strategies:
 *   1. Standard class selectors (.s-item__seller-info-text / .s-card__seller-info)
 *   2. .s-item__seller-info container with non-empty text
 *   3. "Seller:" text content inside the first 5 cards
 *
 * Item number — three strategies:
 *   1. Standard class selector (.s-item__itemId-num)
 *   2. data-testid containing "itemId" or "item-number"
 *   3. "Item number:" or "#<digits>" text content inside the first 5 cards
 *
 * Returns { sellerFound, itemNumFound, sellerStrategy, itemNumStrategy }
 */
function detectCustomizeFieldsInCards() {
  var log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};
  var cards = document.querySelectorAll('#srp-river-results > ul > li');
  var sampleSize = Math.min(cards.length, 5);

  // ── Seller info ──────────────────────────────────────────────────────────
  // Expected DOM: li.s-card > .su-card-container > ... > .su-card-container__attributes__secondary
  //               > .s-card__attribute-row:first-child  (seller name + feedback spans)
  var sellerFound = false;
  var sellerStrategy = null;

  // Strategy 1: a .s-card__attribute-row inside .su-card-container__attributes__secondary
  // that contains seller feedback ("% positive"). Must include "positive" to distinguish
  // from the item-number row ("Item: <digits>") which can be the only row when only item
  // number is enabled — without this guard sellerFound would fire on item-number text.
  var secSellerRows = document.querySelectorAll('.su-card-container__attributes__secondary .s-card__attribute-row');
  for (var si = 0; si < secSellerRows.length; si++) {
    if (/positive/i.test(secSellerRows[si].textContent || '')) {
      sellerFound = true;
      sellerStrategy = '.su-card-container__attributes__secondary row containing "positive" (actual structure)';
      log('[CG Suite]   detectCustomizeFields — seller info: strategy 1 matched — ' + sellerStrategy);
      break;
    }
  }
  if (!sellerFound) {
    log('[CG Suite]   detectCustomizeFields — seller info: strategy 1 — no secondary-attrs row with "positive" found');
  }

  // Strategy 2: any span anywhere in the card list with seller feedback pattern
  if (!sellerFound) {
    var s2 = document.querySelector('.su-card-container__attributes__secondary span');
    if (s2 && /positive/i.test(s2.textContent || '')) {
      sellerFound = true;
      sellerStrategy = '.su-card-container__attributes__secondary span containing "positive"';
      log('[CG Suite]   detectCustomizeFields — seller info: strategy 2 matched — ' + sellerStrategy);
    } else {
      log('[CG Suite]   detectCustomizeFields — seller info: strategy 2 — no span with "positive" in secondary attrs');
    }
  }

  // Strategy 3: text scan across first N cards
  if (!sellerFound) {
    for (var i = 0; i < sampleSize; i++) {
      if (/positive/i.test((cards[i].textContent || ''))) {
        sellerFound = true;
        sellerStrategy = '"positive" feedback text in card ' + i;
        log('[CG Suite]   detectCustomizeFields — seller info: strategy 3 matched — ' + sellerStrategy);
        break;
      }
    }
    if (!sellerFound) {
      log('[CG Suite]   detectCustomizeFields — seller info: strategy 3 — seller text not found in first ' + sampleSize + ' cards → NOT PRESENT');
    }
  }

  // ── Item number ──────────────────────────────────────────────────────────
  // Expected DOM: .su-card-container__attributes__secondary .s-card__attribute-row:last-child
  //               > span.su-styled-text.secondary.large  text = "Item: 205891516436"
  var itemNumFound = false;
  var itemNumStrategy = null;

  // Strategy 1: span inside secondary attrs whose text starts with "Item: <digits>"
  var secRows = document.querySelectorAll('.su-card-container__attributes__secondary .s-card__attribute-row');
  for (var r = 0; r < secRows.length; r++) {
    if (/^Item:\s*\d{9,}/.test((secRows[r].textContent || '').trim())) {
      itemNumFound = true;
      itemNumStrategy = '.su-card-container__attributes__secondary row with "Item: <id>" (actual structure)';
      log('[CG Suite]   detectCustomizeFields — item number: strategy 1 matched — ' + itemNumStrategy);
      break;
    }
  }
  if (!itemNumFound) {
    log('[CG Suite]   detectCustomizeFields — item number: strategy 1 — "Item: <digits>" row not found in secondary attrs');
  }

  // Strategy 2: data-listingid attribute present on a card (always set by eBay regardless of display prefs)
  if (!itemNumFound) {
    var cardWithId = document.querySelector('li.s-card[data-listingid]');
    if (cardWithId) {
      // data-listingid is always present, but we only count it as "item number displayed" if
      // the secondary attrs "Item: …" text is also absent — so this strategy is not used to
      // skip customise; it's a fallback detection only for logging purposes.
      log('[CG Suite]   detectCustomizeFields — item number: strategy 2 — data-listingid present on card but "Item:" text not displayed → NOT counting as displayed');
    } else {
      log('[CG Suite]   detectCustomizeFields — item number: strategy 2 — li.s-card[data-listingid] not found');
    }
  }

  // Strategy 3: text scan across first N cards
  if (!itemNumFound) {
    for (var j = 0; j < sampleSize; j++) {
      var txt = (cards[j].textContent || '');
      if (/\bItem:\s*\d{9,}/.test(txt)) {
        itemNumFound = true;
        itemNumStrategy = '"Item: <digits>" text in card ' + j;
        log('[CG Suite]   detectCustomizeFields — item number: strategy 3 matched — ' + itemNumStrategy);
        break;
      }
    }
    if (!itemNumFound) {
      log('[CG Suite]   detectCustomizeFields — item number: strategy 3 — "Item: <digits>" not found in first ' + sampleSize + ' cards → NOT PRESENT');
    }
  }

  log('[CG Suite]   detectCustomizeFields — result: sellerFound=' + sellerFound + ', itemNumFound=' + itemNumFound);
  return { sellerFound: sellerFound, itemNumFound: itemNumFound, sellerStrategy: sellerStrategy, itemNumStrategy: itemNumStrategy };
}

/**
 * If eBay cards are present but have no seller info element, automatically opens
 * the eBay Customise dialog, ticks "Seller information" and "Item number", and
 * clicks Apply — which reloads the page with the preferences saved as cookies.
 *
 * Every step is multi-strategy and fully logged.
 * A sessionStorage flag prevents an infinite reload loop.
 *
 * Returns true if a page reload was triggered (caller should abort showing the panel).
 */
async function enforceEbayCustomizeSettings() {
  var log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};

  // `getSiteConfig` lives inside the content-listings.js IIFE so it is NOT visible here.
  // Gate by hostname, which is cheap and reliable for our match patterns.
  if (!/(^|\.)ebay\.co\.uk$/.test(window.location.hostname)) return false;

  // Guard against infinite reload loops: consume the flag FIRST (before any
  // field detection) so it is always used up on the one reload we triggered,
  // whether or not the fields ended up visible on that reload.
  // Flag is absent on every other reload (user manually changing settings, filter
  // redirects, etc.) so we always re-check those.
  try {
    if (sessionStorage.getItem('cgSuiteCustomizeAppliedAt')) {
      log('[CG Suite] enforceEbayCustomizeSettings: this page load was triggered by our own Apply click — skipping once (flag consumed)');
      sessionStorage.removeItem('cgSuiteCustomizeAppliedAt');
      return false;
    }
  } catch (e) {}

  // Only run when there are actual result cards on the page
  var container = document.querySelector('#srp-river-results > ul');
  var cardCount = container ? container.querySelectorAll(':scope > li').length : 0;
  log('[CG Suite] enforceEbayCustomizeSettings: result cards in DOM =', cardCount);
  if (!container || cardCount === 0) {
    log('[CG Suite] enforceEbayCustomizeSettings: no cards — skipping');
    return false;
  }

  // Detect both seller info and item number in cards
  var detection = detectCustomizeFieldsInCards();
  log('[CG Suite] enforceEbayCustomizeSettings: sellerFound =', detection.sellerFound,
    detection.sellerFound ? ('via ' + detection.sellerStrategy) : '(not found)');
  log('[CG Suite] enforceEbayCustomizeSettings: itemNumFound =', detection.itemNumFound,
    detection.itemNumFound ? ('via ' + detection.itemNumStrategy) : '(not found)');

  if (detection.sellerFound && detection.itemNumFound) {
    log('[CG Suite] enforceEbayCustomizeSettings: both seller info and item number present — no action needed');
    return false;
  }

  var missing = [];
  if (!detection.sellerFound) missing.push('seller info');
  if (!detection.itemNumFound) missing.push('item number');
  log('[CG Suite] enforceEbayCustomizeSettings: missing fields —', missing.join(', '), '— will auto-configure');

  // ── Step 1: find and click the Customise button ──────────────────────────
  var btnResult = findCustomizeButton();
  if (!btnResult) {
    log('[CG Suite] enforceEbayCustomizeSettings: ABORT — Customise button not found by any strategy');
    return false;
  }
  log('[CG Suite] enforceEbayCustomizeSettings: clicking Customise button (found via:', btnResult.strategy + ')');
  btnResult.el.click();

  // ── Step 2: wait for the form to appear in DOM ───────────────────────────
  log('[CG Suite] enforceEbayCustomizeSettings: waiting up to 4 s for customize form...');
  var rawForm = await waitForElement('.s-customize-form, form[action*="customize"]', 4000);
  var formResult = rawForm ? findCustomizeForm() : null;

  if (!formResult) {
    log('[CG Suite] enforceEbayCustomizeSettings: ABORT — form did not appear within 4 s');
    return false;
  }
  var form = formResult.el;
  log('[CG Suite] enforceEbayCustomizeSettings: form found (via:', formResult.strategy + ')');

  // ── Step 3: tick "Seller information" ────────────────────────────────────
  var sellerResult = findCustomizeCheckbox(form, '_fcse', 'Seller information');
  if (sellerResult) {
    var wasChecked = sellerResult.el.checked;
    if (!wasChecked) {
      sellerResult.el.checked = true;
      log('[CG Suite]   Seller information checkbox: was unchecked → now checked (via:', sellerResult.strategy + ')');
    } else {
      log('[CG Suite]   Seller information checkbox: already checked (via:', sellerResult.strategy + ')');
    }
  } else {
    log('[CG Suite]   Seller information checkbox: NOT FOUND by any strategy — will continue anyway');
  }

  // ── Step 4: tick "Item number" ────────────────────────────────────────────
  var itemNumResult = findCustomizeCheckbox(form, '_fcie', 'Item number');
  if (itemNumResult) {
    var wasChecked2 = itemNumResult.el.checked;
    if (!wasChecked2) {
      itemNumResult.el.checked = true;
      log('[CG Suite]   Item number checkbox: was unchecked → now checked (via:', itemNumResult.strategy + ')');
    } else {
      log('[CG Suite]   Item number checkbox: already checked (via:', itemNumResult.strategy + ')');
    }
  } else {
    log('[CG Suite]   Item number checkbox: NOT FOUND by any strategy — will continue anyway');
  }

  // ── Step 5: click Apply ───────────────────────────────────────────────────
  var applyResult = findCustomizeApplyButton(form);
  if (!applyResult) {
    log('[CG Suite] enforceEbayCustomizeSettings: ABORT — Apply button not found by any strategy');
    return false;
  }
  log('[CG Suite] enforceEbayCustomizeSettings: clicking Apply (found via:', applyResult.strategy + ') — page will reload with prefs saved as cookie');
  // Stamp the time so the immediately-following reload is recognised as ours
  // and skipped (15 s window). Any reload outside that window is treated as a
  // fresh check so we re-enforce if the user manually removed the fields later.
  try { sessionStorage.setItem('cgSuiteCustomizeAppliedAt', String(Date.now())); } catch (e) {}
  applyResult.el.click();
  return true;
}

var OVERLAY_ID = 'cg-suite-ebay-loading-overlay';

function showEbayLoadingOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;
  var overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('aria-hidden', 'true');
  // Note: `backdrop-filter: blur()` on a full-screen overlay tanks eBay's search
  // page (many nodes, images) — the GPU re-blurs every paint. A solid dim is
  // visually similar and cheap; keep it that way.
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 2147483646',
    'background: rgba(15, 23, 42, 0.92)',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'pointer-events: auto',
    'cursor: wait'
  ].join(';');
  overlay.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:20px;">' +
    '<div class="cg-suite-spinner" style="width:64px;height:64px;border:4px solid rgba(254,249,195,0.4);border-top-color:#facc15;border-radius:50%;animation:cg-suite-spin 0.9s linear infinite;"></div>' +
    '<span style="font-family:Inter,sans-serif;font-size:16px;font-weight:600;color:#f8fafc;">Setting up eBay page…</span>' +
    '</div>';
  var style = document.createElement('style');
  style.id = 'cg-suite-ebay-overlay-style';
  style.textContent = '@keyframes cg-suite-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
  document.body.appendChild(overlay);
}

function removeEbayLoadingOverlay() {
  var overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  var styleEl = document.getElementById('cg-suite-ebay-overlay-style');
  if (styleEl) styleEl.remove();
}
