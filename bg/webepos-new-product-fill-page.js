/**
 * Injected into Web EPOS `/products/new` (MAIN world). Exposes
 * `window.__CG_WEB_EPOS_FILL_RUN(spec)` for the service worker to call via a second executeScript.
 *
 * spec:
 * - title, price, costPrice, quantity, condition, barcode (longer CG suffix allowed), grade? (default B after refurbished)
 * - fulfilmentOption?, storeId? (optional; defaults applied in run())
 * - categoryLevelUuids?: string[] — Web EPOS option values per catLevel1..n
 * - categoryPathLabels?: string[] — match option text per level (skips "All Categories")
 */
(function () {
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function normText(t) {
    return String(t || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/&amp;/g, '&');
  }

  function setNativeValue(el, value) {
    if (!el) return;
    var v = value == null ? '' : String(value);
    var proto = el.constructor && el.constructor.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, v);
    } else {
      el.value = v;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setSelectById(id, value) {
    var el = document.getElementById(id);
    if (!el || !value) return;
    setNativeValue(el, value);
  }

  function pickFirstNonEmptyStore() {
    var el = document.getElementById('storeId');
    if (!el) return;
    var opts = Array.prototype.slice.call(el.options || []).filter(function (o) {
      return o.value;
    });
    if (opts.length) setNativeValue(el, opts[0].value);
  }

  async function fillCategoryUuids(uuids) {
    var level = 1;
    for (var i = 0; i < uuids.length; i++) {
      var uuid = String(uuids[i] || '').trim();
      if (!uuid) break;
      await sleep(200);
      setSelectById('catLevel' + level, uuid);
      await sleep(450);
      level++;
    }
  }

  /**
   * Locate the react-switch for “On Sale” only (avoid the first unrelated switch on the page).
   * Web EPOS uses <div class="switch">…<div class="react-switch-handle" role="checkbox">…
   */
  function findOnSaleSwitchRoot() {
    var groups = document.querySelectorAll('.form-group');
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var labels = g.querySelectorAll('label');
      var hit = false;
      for (var li = 0; li < labels.length; li++) {
        var lt = normText(labels[li].textContent || '');
        if (lt === 'on sale' || lt === 'onsale') {
          hit = true;
          break;
        }
      }
      if (!hit && g.querySelector('label[for="onSale"]')) hit = true;
      if (!hit) continue;
      var sw = g.querySelector('.switch');
      if (sw) return sw;
    }
    return null;
  }

  function reactSwitchHandleIsOn(root) {
    var handle = root.querySelector('.react-switch-handle[role="checkbox"]');
    if (!handle) return false;
    return String(handle.getAttribute('aria-checked') || '').toLowerCase() === 'true';
  }

  /**
   * Turn “On Sale” off. Do not trust a hidden #onSale checkbox alone — it can disagree with the visible React switch.
   */
  async function ensureOnSaleOff() {
    await sleep(150);
    for (var attempt = 0; attempt < 8; attempt++) {
      var root = findOnSaleSwitchRoot();
      if (!root) {
        await sleep(200);
        continue;
      }
      if (!reactSwitchHandleIsOn(root)) {
        return;
      }
      var handle = root.querySelector('.react-switch-handle[role="checkbox"]');
      var bg = root.querySelector('.react-switch-bg');
      if (handle) {
        handle.focus();
        handle.click();
      } else if (bg) {
        bg.click();
      }
      await sleep(500);
      if (!reactSwitchHandleIsOn(root)) {
        return;
      }
      if (bg && handle) {
        bg.click();
        await sleep(500);
        if (!reactSwitchHandleIsOn(root)) {
          return;
        }
      }
    }
  }

  /**
   * Mirror of `ensureOnSaleOff` — used in audit price-edit saves where the product is
   * already live and On Sale must NEVER flip to off as a side effect of our form fill.
   * Web EPOS has been observed resetting the switch after a price change, so we defensively
   * re-toggle it on right before clicking Save/Update.
   */
  async function ensureOnSaleOn() {
    await sleep(150);
    for (var attempt = 0; attempt < 8; attempt++) {
      var root = findOnSaleSwitchRoot();
      if (!root) {
        await sleep(200);
        continue;
      }
      if (reactSwitchHandleIsOn(root)) {
        return;
      }
      var handle = root.querySelector('.react-switch-handle[role="checkbox"]');
      var bg = root.querySelector('.react-switch-bg');
      if (handle) {
        handle.focus();
        handle.click();
      } else if (bg) {
        bg.click();
      }
      await sleep(500);
      if (reactSwitchHandleIsOn(root)) {
        return;
      }
      if (bg && handle) {
        bg.click();
        await sleep(500);
        if (reactSwitchHandleIsOn(root)) {
          return;
        }
      }
    }
  }

  /**
   * Force the "RRP Source" dropdown back to its empty/default option if Web EPOS has
   * auto-selected a value (e.g. eBay) as a side effect of editing price/wasPrice.
   * Search order: common ids/names, then `.form-group` whose label reads "RRP Source".
   */
  function clearRrpSourceField() {
    function clearSelect(sel) {
      if (!sel || sel.tagName !== 'SELECT') return false;
      var opts = Array.prototype.slice.call(sel.options || []);
      var emptyOpt =
        opts.find(function (o) {
          return o.value === '' || o.value == null;
        }) ||
        opts.find(function (o) {
          var t = normText(o.textContent || '');
          return t === '' || t === 'none' || t === 'select' || t === '-' || t === '--';
        });
      setNativeValue(sel, emptyOpt ? emptyOpt.value : '');
      return true;
    }
    var byId =
      document.getElementById('rrpSource') ||
      document.getElementById('rrp_source') ||
      document.querySelector('select[name="rrpSource"]') ||
      document.querySelector('select[name="rrp_source"]') ||
      document.querySelector('select[name*="rrpSource" i]') ||
      document.querySelector('select[name*="rrp-source" i]');
    if (byId && clearSelect(byId)) return true;
    var groups = document.querySelectorAll('.form-group');
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var labels = g.querySelectorAll('label');
      var matched = false;
      for (var li = 0; li < labels.length; li++) {
        var t = normText(labels[li].textContent || '');
        if (t.indexOf('rrp') !== -1 && t.indexOf('source') !== -1) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      var sel = g.querySelector('select');
      if (sel && clearSelect(sel)) return true;
    }
    return false;
  }

  async function fillCategoryLabels(labels) {
    var cleaned = (labels || [])
      .map(function (s) {
        return String(s || '').trim();
      })
      .filter(function (s) {
        return s && !/^all categories$/i.test(s);
      });
    var level = 1;
    for (var i = 0; i < cleaned.length; i++) {
      var want = normText(cleaned[i]);
      if (!want) continue;
      var deadline = Date.now() + 12000;
      var placed = false;
      while (Date.now() < deadline) {
        var sel = document.getElementById('catLevel' + level);
        if (!sel) {
          placed = true;
          break;
        }
        var opts = Array.prototype.slice.call(sel.options || []).filter(function (o) {
          return o.value;
        });
        if (opts.length === 0) {
          await sleep(120);
          continue;
        }
        var hit =
          opts.find(function (o) {
            return normText(o.textContent) === want;
          }) ||
          opts.find(function (o) {
            var nt = normText(o.textContent);
            return nt.indexOf(want) !== -1 || want.indexOf(nt) !== -1;
          });
        if (hit) {
          setNativeValue(sel, hit.value);
          await sleep(450);
          level++;
          placed = true;
          break;
        }
        break;
      }
      if (!placed) break;
    }
  }

  async function run(spec) {
    if (!spec || typeof spec !== 'object') return;
    await sleep(350);
    /**
     * Edit mode (audit): only touch fields explicitly present on spec.
     * Skip On Sale toggling, fulfilmentOption/storeId defaults, and category fills
     * — any of those change page state that the audit flow must not disturb
     * (e.g. causing Web EPOS to auto-assign RRP Source or flip Off Sale).
     */
    var editOnly = spec.editOnly === true;
    if (!editOnly) await ensureOnSaleOff();

    if (spec.title != null) setNativeValue(document.getElementById('title'), String(spec.title).slice(0, 150));
    if (spec.quantity != null) setNativeValue(document.getElementById('quantity'), String(spec.quantity));
    if (spec.price != null) setNativeValue(document.getElementById('price'), String(spec.price));
    if (spec.costPrice != null) setNativeValue(document.getElementById('costPrice'), String(spec.costPrice));
    if (spec.wasPrice != null) setNativeValue(document.getElementById('wasPrice'), String(spec.wasPrice));

    if (spec.barcode != null) setNativeValue(document.getElementById('barcode'), String(spec.barcode).slice(0, 80));
    if (spec.gtin != null) setNativeValue(document.getElementById('gtin'), String(spec.gtin).slice(0, 150));

    if (spec.intro != null) {
      var ta = document.querySelector('textarea[name="intro"]');
      if (ta) setNativeValue(ta, String(spec.intro).slice(0, 10000));
    }

    if (spec.condition) {
      setSelectById('condition', String(spec.condition));
      if (String(spec.condition).toLowerCase() === 'refurbished') {
        var gradeVal = spec.grade != null && String(spec.grade).trim() ? String(spec.grade).trim() : 'B';
        var gDeadline = Date.now() + 10000;
        while (Date.now() < gDeadline) {
          var gEl = document.getElementById('grade');
          if (gEl && gEl.options && gEl.options.length > 1) {
            setSelectById('grade', gradeVal);
            break;
          }
          await sleep(120);
        }
      }
    }

    if (!editOnly) {
      var fulfil = spec.fulfilmentOption || 'anyfulfilment';
      setSelectById('fulfilmentOption', fulfil);

      if (spec.storeId) {
        setSelectById('storeId', String(spec.storeId));
      } else {
        pickFirstNonEmptyStore();
      }

      if (Array.isArray(spec.categoryLevelUuids) && spec.categoryLevelUuids.length) {
        await fillCategoryUuids(spec.categoryLevelUuids);
      } else if (Array.isArray(spec.categoryPathLabels) && spec.categoryPathLabels.length) {
        await fillCategoryLabels(spec.categoryPathLabels);
      }

      await ensureOnSaleOff();
    }

    /**
     * Final pass: Web EPOS auto-selects "eBay" for RRP Source when price/wasPrice change.
     * Clear it last so any React-driven defaults set during the fill don't linger at save.
     */
    clearRrpSourceField();
  }

  /**
   * Turn Off Sale off, click Save Product, wait until we leave `/products/new` (success redirect).
   */
  async function finishNewProductAfterFill() {
    await sleep(250);
    await ensureOnSaleOff();
    clearRrpSourceField();
    var btn = Array.prototype.slice
      .call(document.querySelectorAll('button.btn'))
      .find(function (b) {
        return /save\s*product/i.test(String(b.textContent || '').replace(/\s+/g, ' ').trim());
      });
    if (!btn) {
      throw new Error('Save Product button not found');
    }
    var startPath = location.pathname || '';
    btn.click();
    var deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(500);
      var p = location.pathname || '';
      if (p !== startPath && !/\/products\/new\/?$/i.test(p)) {
        return;
      }
    }
    throw new Error('Timed out waiting for Web EPOS to finish saving the product');
  }

  /**
   * Edit-page save: mirrors `finishNewProductAfterFill` — click the save button, then
   * watch for the URL path to leave the current edit page (Web EPOS redirects back to
   * `/products` on a successful save). We accept either "Save Product" or "Update
   * Product" button text so a future Web EPOS copy change doesn't silently break this.
   *
   * Assumes the caller has already set `#price` (or other form fields) via
   * __CG_WEB_EPOS_FILL_RUN. See `run()` above for the shared field setter.
   *
   * Audit invariant: this runs on live products, so On Sale must stay on. We force it
   * back on right before save — Web EPOS was observed flipping it to off as a side
   * effect of the price change otherwise.
   */
  async function finishEditProductAfterChange() {
    clearRrpSourceField();
    await ensureOnSaleOn();
    var btn = Array.prototype.slice
      .call(document.querySelectorAll('button.btn'))
      .find(function (b) {
        var t = String(b.textContent || '').replace(/\s+/g, ' ').trim();
        return /^(save|update)(\s+product)?$/i.test(t);
      });
    if (!btn) {
      throw new Error('Save/Update button not found on Web EPOS edit page');
    }
    var startPath = location.pathname || '';
    btn.click();
    var deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(500);
      var p = location.pathname || '';
      if (p !== startPath) {
        return;
      }
    }
    throw new Error('Timed out waiting for Web EPOS to finish saving the edit');
  }

  /**
   * Edit-page save that keeps On Sale OFF — mirror of {@link finishEditProductAfterChange}
   * but with `ensureOnSaleOff` instead of `ensureOnSaleOn`, and reusing the same dirty-form
   * trick the new-product save pipeline relies on.
   *
   * Why this exists as a separate helper:
   *   - `finishEditProductAfterChange` (audit price-edit flow) calls `ensureOnSaleOn` right
   *     before click so a live product never accidentally goes off sale. If a flow that
   *     wants On Sale OFF calls it, the switch is flipped back ON the moment we save —
   *     that's the "toggles off then immediately back on" bug.
   *   - `finishNewProductAfterFill` calls `ensureOnSaleOff` right before click, which is
   *     exactly the guarantee we need. But it only runs after `run(spec)` has touched the
   *     form fields — React then treats the form as user-modified and stops re-syncing On
   *     Sale from the loaded product JSON. On the edit page we haven't filled anything, so
   *     we replicate the dirty-form signal by re-assigning `#price` to its own value
   *     (native setter + input/change events — same mechanism `setNativeValue` uses).
   *
   * Sequence: dirty the form, ensure on-sale off (repeat immediately before click so no
   * replay lands between toggle and save), clear RRP Source, click Save/Update, wait for
   * Web EPOS to redirect away from the edit URL.
   */
  async function finishEditProductOffSale() {
    await sleep(250);

    // Dirty-form signal: poke #price so React marks the form as user-modified and stops
    // resyncing On Sale from the hydrated product state. Pure no-op for the user — the
    // native value setter + input/change events fire, but the visible value is unchanged.
    var priceEl = document.getElementById('price');
    if (priceEl) {
      setNativeValue(priceEl, String(priceEl.value || ''));
    }

    await ensureOnSaleOff();
    clearRrpSourceField();
    await ensureOnSaleOff();

    var btn = Array.prototype.slice
      .call(document.querySelectorAll('button.btn'))
      .find(function (b) {
        var t = String(b.textContent || '').replace(/\s+/g, ' ').trim();
        return /^(save|update)(\s+product)?$/i.test(t);
      });
    if (!btn) {
      throw new Error('Save/Update button not found on Web EPOS edit page');
    }

    // Final guard: one more ensureOnSaleOff the instant before the click, so nothing can
    // land between the check and the submit. ensureOnSaleOff is idempotent (no-ops when the
    // switch already reads off), so the redundant calls are essentially free.
    await ensureOnSaleOff();

    var startPath = location.pathname || '';
    btn.click();
    var deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(500);
      var p = location.pathname || '';
      if (p !== startPath) {
        return;
      }
    }
    throw new Error('Timed out waiting for Web EPOS to finish saving the edit');
  }

  window.__CG_WEB_EPOS_FILL_RUN = run;
  window.__CG_WEB_EPOS_FINISH_NEW_PRODUCT = finishNewProductAfterFill;
  window.__CG_WEB_EPOS_FINISH_EDIT_PRODUCT = finishEditProductAfterChange;
  window.__CG_WEB_EPOS_FINISH_EDIT_PRODUCT_OFF_SALE = finishEditProductOffSale;
  window.__CG_WEB_EPOS_ENSURE_ON_SALE_OFF = ensureOnSaleOff;
})();
