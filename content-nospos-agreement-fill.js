/**
 * NoSpos draft agreement items step: fill first line from CG Suite (extension message).
 */
(function () {
  const NS = '[CG Suite NosPos fill]';
  /** Small safety pause before high-impact Actions menu clicks (park/delete) to avoid server rate limiting. */
  const NOSPOS_ACTION_CLICK_DELAY_MS = 1200;
  /** NosPos paginates the agreement items list at 20 rows per page (mirror of the
   *  background flow's NOSPOS_ITEMS_PER_PAGE). Used to turn a page-local card
   *  index into the global row index the park flow keys items by. */
  const NOSPOS_ITEMS_PER_PAGE = 20;

  function log() {
    const args = Array.prototype.slice.call(arguments);
    args.unshift(NS);
    console.log.apply(console, args);
  }

  function warn() {
    const args = Array.prototype.slice.call(arguments);
    args.unshift(NS);
    console.warn.apply(console, args);
  }

  /**
   * Forward a log entry to the background service worker so it is captured in cgParkLog.
   * Fire-and-forget — never blocks content script execution.
   */
  function logToBackground(fn, phase, data, msg) {
    try {
      let safe = {};
      try {
        safe = JSON.parse(JSON.stringify(data ?? {}, (_k, v) => {
          if (v === undefined) return null;
          if (typeof v === 'function') return '[Function]';
          if (v instanceof Element) return `[Element: ${v.tagName}${v.id ? '#' + v.id : ''}]`;
          return v;
        }));
      } catch (_) {}
      chrome.runtime.sendMessage({ type: 'PARK_LOG_ENTRY', fn, phase, data: safe, msg: msg || '' }).catch(() => {});
    } catch (_) {}
  }

  function normLabel(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Extra strings to score against options (unlocked → Unlocked/Open, etc.).
   */
  function synonymExpandedWants(raw) {
    const base = String(raw || '').trim();
    if (!base) return [];
    const n = normLabel(base);
    const set = new Set([base, n]);
    if (
      /\bunlocked\b|\bunlock\b|sim\s*free|simfree|factory\s*unlocked|open\s*network|network\s*unlocked/.test(n) ||
      n === 'open' ||
      n === 'open line'
    ) {
      set.add('unlocked/open');
      set.add('unlocked');
      set.add('open');
    }
    if (/\bwifi\b|wlan|wi-?fi\s*only/.test(n)) set.add('wifi only');
    if (n === '3' || n === 'three' || /\bthree\b/.test(n)) set.add('three');
    if (n === 'o2' || n === '02') set.add('o2');
    if (/\bee\b|^ee$|everything\s*everywhere|t-?mobile/.test(n)) set.add('ee');
    if (/vodafone|voda\b/.test(n)) set.add('vodafone');
    if (n === 'other' || n === 'misc' || n === 'unknown') set.add('other');
    return Array.from(set);
  }

  function scoreOptionMatch(candRaw, opt) {
    const c = normLabel(candRaw);
    const v = normLabel(opt.value);
    const t = normLabel(opt.textContent);
    if (!opt.value) return -1;
    if (!c) return -1;
    if (c === v) return 1000;
    if (c === t) return 999;
    if (c.length >= 2 && v.length >= 2 && (v.includes(c) || c.includes(v))) {
      return 720 + Math.min(c.length, v.length) * 6;
    }
    if (c.length >= 2 && t.length >= 2 && (t.includes(c) || c.includes(t))) {
      return 680 + Math.min(c.length, t.length) * 5;
    }
    const toks = c.split(/[^a-z0-9]+/).filter((x) => x.length > 0);
    const significant = toks.filter((x) => x.length >= 2 || x === '3' || x === 'o2' || x === 'ee');
    if (!significant.length) return 0;
    const merged = `${v} ${t}`;
    let hits = 0;
    for (let i = 0; i < significant.length; i++) {
      if (merged.includes(significant[i])) hits += 1;
    }
    return Math.floor((hits / significant.length) * 420);
  }

  /**
   * Pick the best non-empty <option> for a desired value (fuzzy; not exact).
   */
  function findBestSelectOption(select, desiredRaw) {
    const raw = String(desiredRaw || '').trim();
    if (!raw || !select || select.tagName !== 'SELECT') return null;
    const variants = synonymExpandedWants(raw);
    const options = Array.from(select.options).filter((o) => o.value !== '');
    let bestOpt = null;
    let bestScore = 0;
    for (let oi = 0; oi < options.length; oi++) {
      const opt = options[oi];
      let optBest = 0;
      for (let vi = 0; vi < variants.length; vi++) {
        optBest = Math.max(optBest, scoreOptionMatch(variants[vi], opt));
      }
      if (optBest > bestScore) {
        bestScore = optBest;
        bestOpt = opt;
      }
    }
    const MIN_SCORE = 180;
    if (!bestOpt || bestScore < MIN_SCORE) return null;
    return { option: bestOpt, score: bestScore };
  }

  function itemsFormRootEl() {
    return (
      document.getElementById('items-form') ||
      document.querySelector('form#items-form') ||
      document.querySelector('form[action*="items"]') ||
      null
    );
  }

  function listCategorySelects() {
    const form = itemsFormRootEl();
    const scope = form || document;
    return Array.from(
      scope.querySelectorAll('select[name*="DraftAgreementItem"][name$="[category]"]'),
    );
  }

  function nthItemCategorySelect(n) {
    const sels = listCategorySelects();
    const idx = Math.max(0, parseInt(String(n), 10) || 0);
    return sels[idx] || null;
  }

  function agreementItemLineCount() {
    return listCategorySelects().length;
  }

  /**
   * NosPos splits an agreement's items across pages (20 per page) once it grows past one
   * page — the screenshot pager («1 2») is a stock Yii2 LinkPager (`ul.pagination`). Each
   * page only renders its own rows, so the flat `listCategorySelects()` count/index is
   * page-local. These helpers let the park flow walk pages so items 21+ are reachable.
   */
  function findAgreementPagerEl() {
    const form = itemsFormRootEl();
    const scope = form || document;
    return scope.querySelector('ul.pagination') || document.querySelector('ul.pagination') || null;
  }

  /**
   * Page number a pager <a> points at: prefer the page query arg, else its visible text.
   * NosPos' agreement items pager uses `items-page=N` (not Yii2's default `page=N`).
   */
  function pageNumberFromPagerLink(a) {
    if (!a) return null;
    const href = a.getAttribute('href') || a.href || '';
    const m = String(href).match(/[?&](?:items-)?page=(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const t = parseInt(String(a.textContent || '').trim(), 10);
    return Number.isFinite(t) && t > 0 ? t : null;
  }

  /** The query param NosPos uses to page the items list (read off a real pager link; default items-page). */
  function agreementPageParamName() {
    const ul = findAgreementPagerEl();
    if (ul) {
      const links = Array.from(ul.querySelectorAll('li a'));
      for (const a of links) {
        const href = a.getAttribute('href') || a.href || '';
        const m = String(href).match(/[?&]((?:items-)?page)=\d+/i);
        if (m) return m[1];
      }
    }
    return 'items-page';
  }

  /**
   * Read pager state for the items page.
   * @returns {{ ok: true, hasPager: boolean, currentPage: number, lastPage: number, count: number }}
   */
  function runReadAgreementPager() {
    const count = agreementItemLineCount();
    const ul = findAgreementPagerEl();
    if (!ul) {
      return { ok: true, hasPager: false, currentPage: 1, lastPage: 1, count };
    }
    let currentPage = 1;
    let lastPage = 1;
    const lis = Array.from(ul.querySelectorAll('li'));
    for (const li of lis) {
      const a = li.querySelector('a');
      const p = pageNumberFromPagerLink(a);
      if (p != null && p > lastPage) lastPage = p;
      if (li.classList && li.classList.contains('active')) {
        const ap = p != null ? p : parseInt(String(li.textContent || '').trim(), 10);
        if (Number.isFinite(ap) && ap > 0) currentPage = ap;
      }
    }
    if (lastPage < currentPage) lastPage = currentPage;
    return { ok: true, hasPager: true, currentPage, lastPage, count };
  }

  /**
   * Navigate the items page to a 1-based page number. Prefers the real pager link's href
   * (keeps NosPos' own query args); falls back to setting `?page=N` on the current URL.
   */
  function runNavigateAgreementToPage(pageNum, force) {
    const want = Math.max(1, parseInt(String(pageNum), 10) || 1);
    const cur = runReadAgreementPager();
    // `force` skips the "already on this page" shortcut. After a post-Add redirect
    // (items-page=<item ordinal>) the in-page pager can momentarily mis-report the
    // active page, so the caller needs a way to demand a real navigation + reload
    // even when we appear to already be there.
    if (!force && cur.currentPage === want) return { ok: true, navigated: false, alreadyThere: true };
    const ul = findAgreementPagerEl();
    if (ul) {
      const links = Array.from(ul.querySelectorAll('li a'));
      for (const a of links) {
        if (pageNumberFromPagerLink(a) === want) {
          const href = a.href || a.getAttribute('href');
          if (href) {
            log('pager → navigating to page', want, href);
            window.location.href = href;
            return { ok: true, navigated: true };
          }
        }
      }
    }
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('action');
      u.searchParams.set(agreementPageParamName(), String(want));
      log('pager → navigating to page (url fallback)', want, u.toString());
      window.location.href = u.toString();
      return { ok: true, navigated: true, viaUrl: true };
    } catch (_) {
      return { ok: false, error: 'Could not navigate to page ' + want };
    }
  }

  function firstItemCategorySelect() {
    const sels = listCategorySelects();
    if (sels.length) return sels[0];
    return (
      document.querySelector('select[name*="DraftAgreementItem"][name$="[category]"]') ||
      document.querySelector('select[name*="[category]"][data-category-select]') ||
      document.querySelector('select[name*="[category]"]')
    );
  }

  function firstItemCardRoot() {
    const sel = firstItemCategorySelect();
    const fromCard = sel?.closest('.card-content') || sel?.closest('.card');
    if (fromCard) return fromCard;
    const form = itemsFormRootEl();
    return form || document.body;
  }

  /**
   * Primary "Add" control (not the dropdown duplicate). Yii2 POST link.
   */
  function findAgreementAddItemLink() {
    const links = Array.from(
      document.querySelectorAll('a[href*="action=add"][data-method="post"]'),
    );
    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      if (a.closest('.dropdown-menu')) continue;
      if (/action=add/i.test(String(a.getAttribute('href') || ''))) return a;
    }
    return null;
  }

  function runClickAddAgreementItem() {
    const a = findAgreementAddItemLink();
    if (!a) return { ok: false, error: 'Add item link not found on this page' };
    log('click Add agreement item', a.getAttribute('href'));
    a.click();
    return { ok: true };
  }

  /** Search order: first line card, whole items form, then document (stock rows sometimes sit outside card). */
  function searchRoots() {
    const roots = [];
    const card = firstItemCardRoot();
    const form = itemsFormRootEl();
    if (card) roots.push(card);
    if (form && form !== card) roots.push(form);
    if (document.body && roots.indexOf(document.body) < 0) roots.push(document.body);
    return roots.length ? roots : [document.body];
  }

  function triggerJq(el) {
    try {
      const $ = window.jQuery || window.$;
      if ($) {
        $(el).trigger('change');
        $(el).trigger('input');
      }
    } catch (_) {}
  }

  function dispatchControlEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    triggerJq(el);
  }

  function readControlValue(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT') return String(el.value || '');
    return String(el.value || '').trim();
  }

  function gatherControlMeta(el) {
    if (!el) {
      return { inputKind: 'text', options: [], step: null, min: null };
    }
    if (el.tagName === 'SELECT') {
      return {
        inputKind: 'select',
        options: Array.from(el.options).map((o) => ({
          value: String(o.value),
          label: String(o.textContent || '').trim() || String(o.value) || '—',
        })),
        step: null,
        min: null,
      };
    }
    const t = String(el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'number') {
      return {
        inputKind: 'number',
        options: [],
        step: el.getAttribute('step') || 'any',
        min: el.getAttribute('min'),
      };
    }
    return { inputKind: 'text', options: [], step: null, min: null };
  }

  function displayForControl(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) {
      return String(el.selectedOptions[0].textContent || '').trim();
    }
    return readControlValue(el);
  }

  function setSelectOrInputValue(el, rawVal, ctx) {
    const emptyMeta = gatherControlMeta(el);
    if (!el) {
      warn('setSelectOrInputValue: no element', ctx || '');
      return {
        ok: false,
        note: null,
        ...emptyMeta,
        currentValue: '',
        displayValue: '',
      };
    }
    const val = String(rawVal ?? '').trim();
    if (!val) {
      warn('setSelectOrInputValue: empty value', ctx || '');
      return {
        ok: false,
        note: null,
        ...gatherControlMeta(el),
        currentValue: readControlValue(el),
        displayValue: displayForControl(el),
      };
    }
    // Parking must always go through: if a field won't accept input (NosPos has
    // it locked / read-only), don't fight it — leave it and tell the operator.
    const isLocked =
      el.disabled === true ||
      el.readOnly === true ||
      String(el.getAttribute && el.getAttribute('aria-disabled')).toLowerCase() === 'true';
    if (isLocked) {
      warn('setSelectOrInputValue: field locked (disabled/read-only)', ctx || '');
      return {
        ok: false,
        note: 'NosPos field is locked (read-only) — left as-is.',
        ...gatherControlMeta(el),
        currentValue: readControlValue(el),
        displayValue: displayForControl(el),
      };
    }
    const tag = el.tagName;
    const before = readControlValue(el);
    let note = null;
    let fuzzyUsed = false;
    if (tag === 'SELECT') {
      let opt = Array.from(el.options).find((o) => String(o.value) === val);
      if (!opt) {
        opt = Array.from(el.options).find(
          (o) => normLabel(o.textContent) === normLabel(val),
        );
      }
      if (!opt) {
        const fuzzy = findBestSelectOption(el, val);
        if (fuzzy) {
          opt = fuzzy.option;
          fuzzyUsed = true;
          note = `Fuzzy match: your “${val}” was mapped to NosPos “${(opt.textContent || '').trim()}”.`;
          log('fuzzy select match', ctx || el.name || el.id, {
            wanted: val,
            picked: opt.value,
            label: (opt.textContent || '').trim(),
            score: fuzzy.score,
          });
        }
      }
      if (!opt) {
        warn('setSelectOrInputValue: no matching option', ctx || '', {
          wanted: val,
          options: Array.from(el.options).map((o) => ({ v: o.value, t: o.textContent })).slice(0, 20),
        });
        return {
          ok: false,
          note: `No matching NosPos option for “${val}” — left as-is.`,
          ...gatherControlMeta(el),
          currentValue: before,
          displayValue: displayForControl(el),
        };
      }
      el.value = opt.value;
      if (
        !fuzzyUsed &&
        String(opt.value) !== val &&
        normLabel(opt.textContent) !== normLabel(val)
      ) {
        note = `Mapped to NosPos option “${(opt.textContent || '').trim()}”.`;
      }
      if (fuzzyUsed === false && (String(opt.value) === val || normLabel(opt.textContent) === normLabel(val))) {
        note = null;
      }
    } else {
      el.value = val;
    }
    dispatchControlEvents(el);
    const after = readControlValue(el);
    let ok =
      after === val ||
      normLabel(after) === normLabel(val) ||
      (tag === 'SELECT' && String(after) === String(el.value) && after !== '');
    if (tag === 'SELECT' && !ok) {
      ok = String(after || '').trim() !== '' && String(el.value) === String(after);
    }
    const meta = gatherControlMeta(el);
    log('set field', ctx || el.name || el.id, { before, after, wanted: val, ok });
    if (!ok) {
      warn('value may not have stuck (custom widget?)', ctx, { after, wanted: val });
      // Surface it to the operator rather than silently dropping it — park
      // continues regardless.
      note = 'NosPos didn’t accept this value — left as-is.';
    }
    return {
      ok,
      note,
      ...meta,
      currentValue: after,
      displayValue: displayForControl(el),
    };
  }

  function setCategorySelect(sel, categoryId) {
    const id = String(categoryId ?? '').trim();
    if (!sel || !id) return { ok: false, error: 'Missing category id' };
    const opt = Array.from(sel.options).find((o) => String(o.value) === id);
    if (!opt) {
      return {
        ok: false,
        error: `Category id ${id} is not in the NoSpos dropdown for this item`,
      };
    }
    log('setting category', id, (opt.textContent || '').trim().slice(0, 80));
    sel.value = id;
    dispatchControlEvents(sel);
    return { ok: true, label: (opt.textContent || '').trim() };
  }

  function findControlByLabel(root, labelText) {
    const want = normLabel(labelText);
    if (!want) return null;
    const groups = root.querySelectorAll('.form-group');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const lab = g.querySelector('label.control-label') || g.querySelector('label');
      if (!lab) continue;
      const t = normLabel(lab.textContent);
      if (t !== want) continue;
      const sel = g.querySelector('select.form-control');
      if (sel) return sel;
      const inp = g.querySelector('input.form-control:not([type="hidden"])');
      if (inp) return inp;
      const ta = g.querySelector('textarea.form-control');
      if (ta) return ta;
    }
    return null;
  }

  function findControlByLabelEverywhere(labelText) {
    const roots = searchRoots();
    const seen = new Set();
    for (let r = 0; r < roots.length; r++) {
      const ctrl = findControlByLabel(roots[r], labelText);
      if (ctrl && !seen.has(ctrl)) {
        seen.add(ctrl);
        log('found control for label', labelText, 'in root', roots[r].id || roots[r].className || r);
        return ctrl;
      }
    }
    warn('no control for label', labelText, 'searched roots', roots.length);
    return null;
  }

  function draftAgreementItemIdFromNameInput(nameInp) {
    const m = nameInp?.name && String(nameInp.name).match(/DraftAgreementItem\[(\d+)\]/);
    return m ? m[1] : null;
  }

  function findFirstNameInput(scope) {
    const s = scope && scope.querySelector ? scope : document;
    return (
      s.querySelector('input[name*="DraftAgreementItem"][name$="[name]"]') ||
      s.querySelector('input[name*="[name]"][data-name-input]') ||
      s.querySelector('input[name*="[name]"]')
    );
  }

  function scopeRootForLineIndex(idx) {
    const n = Math.max(0, parseInt(String(idx), 10) || 0);
    const catSel = nthItemCategorySelect(n);
    if (catSel) {
      const form = itemsFormRootEl();
      const scope = form || document;
      return catSel.closest('.card-content') || catSel.closest('.card') || scope;
    }
    return firstItemCardRoot();
  }

  /**
   * NosPos agreement line: “Item description” (often DraftAgreementItem[id][description]).
   */
  function findFirstItemDescriptionInputInScope(scope) {
    const s = scope && scope.querySelector ? scope : document;
    const byName =
      s.querySelector('textarea[name*="DraftAgreementItem"][name$="[description]"]') ||
      s.querySelector('input[name*="DraftAgreementItem"][name$="[description]"]');
    if (byName) return byName;
    const c = findControlByLabel(s, 'Item description');
    if (c) return c;
    return findControlByLabel(s, 'Description');
  }

  // Merge our CG description block (the marker + any "Label: value" testing
  // fields flagged add-to-description) into whatever is already in the NosPos
  // item description — APPEND, never wipe. The marker identifies our block, so
  // a re-park updates it in place rather than duplicating it, and any text the
  // operator (or NosPos) put there is preserved.
  function mergeCgItemDescription(existing, incoming) {
    const inc = String(incoming || '').trim();
    const ex = String(existing || '');
    if (!inc) return ex.trim();
    const m = inc.match(/\[CG-[^\]]*\]/);
    const marker = m ? m[0] : '';
    if (marker) {
      const idx = ex.indexOf(marker);
      if (idx !== -1) {
        // Replace our prior block (marker → end) with the fresh one; keep
        // anything that came before it.
        const before = ex.slice(0, idx).replace(/\s+$/, '');
        return before ? `${before} ${inc}` : inc;
      }
    }
    const exTrim = ex.trim();
    return exTrim ? `${exTrim} ${inc}` : inc;
  }

  function findItemDescriptionInputForLine(lineIdx) {
    const line = Math.max(0, parseInt(String(lineIdx), 10) || 0);
    const root = scopeRootForLineIndex(line);
    let el = findFirstItemDescriptionInputInScope(root);
    if (el) return el;
    const nameInp = findFirstNameInput(root);
    const itemId = draftAgreementItemIdFromNameInput(nameInp);
    const form = itemsFormRootEl() || document;
    if (itemId) {
      el =
        form.querySelector(`textarea[name="DraftAgreementItem[${itemId}][description]"]`) ||
        form.querySelector(`input[name="DraftAgreementItem[${itemId}][description]"]`);
      if (el) return el;
    }
    return null;
  }

  function findStockControlForLine(root, labelText) {
    const c0 = findControlByLabel(root, labelText);
    if (c0) return c0;
    const want = normLabel(labelText);
    if (!want || !root || !root.querySelectorAll) return null;
    const groups = root.querySelectorAll('.form-group');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const lab = g.querySelector('label.control-label') || g.querySelector('label');
      if (!lab) continue;
      if (normLabel(lab.textContent) !== want) continue;
      const sel = g.querySelector('select.form-control');
      if (sel) return sel;
      const inp = g.querySelector('input.form-control:not([type="hidden"])');
      if (inp) return inp;
      const ta = g.querySelector('textarea.form-control');
      if (ta) return ta;
    }
    return null;
  }

  function buildCategoryFieldRow(ourDisplay, lineIndex) {
    const lineIdx = Math.max(0, parseInt(String(lineIndex ?? '0'), 10) || 0);
    const sel = nthItemCategorySelect(lineIdx) || firstItemCategorySelect();
    const meta = gatherControlMeta(sel);
    return {
      id: 'category',
      field: 'Category',
      ourValue: ourDisplay || '',
      nosposValue: sel ? readControlValue(sel) : '',
      nosposDisplay: sel ? displayForControl(sel) : '',
      note: '',
      required: true,
      inputKind: meta.inputKind || 'select',
      options: meta.options || [],
      step: null,
      min: null,
      patchKind: 'category',
      fieldLabel: '',
    };
  }

  function discoverExtraFields(root, fieldRows) {
    if (!root || !root.querySelectorAll) return;
    const seen = new Set();
    for (let r = 0; r < fieldRows.length; r++) {
      seen.add(normLabel(fieldRows[r].field));
    }
    const groups = root.querySelectorAll('.form-group');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const labEl = g.querySelector('label.control-label') || g.querySelector('label');
      if (!labEl) continue;
      const field = String(labEl.textContent || '').trim();
      if (!field) continue;
      const nk = normLabel(field);
      if (seen.has(nk)) continue;
      const ctrl =
        g.querySelector('select.form-control') ||
        g.querySelector('input.form-control:not([type="hidden"])') ||
        g.querySelector('textarea.form-control');
      if (!ctrl) continue;
      seen.add(nk);
      const meta = gatherControlMeta(ctrl);
      const required =
        g.classList.contains('required') || ctrl.getAttribute('aria-required') === 'true';
      fieldRows.push({
        id: `extra:${nk}`,
        field,
        ourValue: '',
        nosposValue: readControlValue(ctrl),
        nosposDisplay: displayForControl(ctrl),
        note: '',
        required,
        inputKind: meta.inputKind,
        options: meta.options || [],
        step: meta.step,
        min: meta.min,
        patchKind: 'by_label',
        fieldLabel: field,
      });
    }
  }

  function runPatchField(msg) {
    const lineIndex = parseInt(String(msg.lineIndex ?? '0'), 10) || 0;
    const root = scopeRootForLineIndex(lineIndex);
    const patchKind = String(msg.patchKind || '');
    const value = msg.value != null ? String(msg.value) : '';
    const fieldLabel = String(msg.fieldLabel || '').trim();

    if (patchKind === 'category') {
      const sel =
        root.querySelector('select[name*="DraftAgreementItem"][name$="[category]"]') ||
        firstItemCategorySelect();
      if (!sel) return { ok: false, error: 'Category control not found' };
      const r = setCategorySelect(sel, value);
      return r.ok ? { ok: true } : { ok: false, error: r.error || 'Category patch failed' };
    }

    const form = itemsFormRootEl() || document;
    const nameInp =
      findFirstNameInput(root) || findFirstNameInput(form) || findFirstNameInput(document.body);
    const itemId = draftAgreementItemIdFromNameInput(nameInp);

    if (patchKind === 'name') {
      if (!nameInp) return { ok: false, error: 'Name input not found' };
      const r = setSelectOrInputValue(nameInp, value, 'patch:name');
      return { ok: r.ok, error: r.ok ? undefined : 'Could not set name', note: r.note };
    }
    if (patchKind === 'quantity') {
      const q = itemId
        ? form.querySelector(`input[name="DraftAgreementItem[${itemId}][quantity]"]`)
        : null;
      const r = setSelectOrInputValue(q, value, 'patch:qty');
      return { ok: r.ok, error: r.ok ? undefined : 'Could not set quantity', note: r.note };
    }
    if (patchKind === 'retail_price') {
      const el = itemId
        ? form.querySelector(`input[name="DraftAgreementItem[${itemId}][retail_price]"]`)
        : null;
      const r = setSelectOrInputValue(el, value, 'patch:retail');
      return { ok: r.ok, error: r.ok ? undefined : 'Could not set retail price', note: r.note };
    }
    if (patchKind === 'bought_for') {
      const el = itemId
        ? form.querySelector(`input[name="DraftAgreementItem[${itemId}][bought_for]"]`)
        : null;
      const r = setSelectOrInputValue(el, value, 'patch:offer');
      return { ok: r.ok, error: r.ok ? undefined : 'Could not set offer', note: r.note };
    }
    if (patchKind === 'item_description') {
      const lineIdx = Math.max(0, parseInt(String(msg.lineIndex ?? '0'), 10) || 0);
      const ctrl = findItemDescriptionInputForLine(lineIdx);
      if (!ctrl) return { ok: false, error: 'Item description control not found' };
      const r = setSelectOrInputValue(ctrl, value, 'patch:item_description');
      return {
        ok: r.ok,
        error: r.ok ? undefined : 'Could not set item description',
        note: r.note,
      };
    }
    if (patchKind === 'by_label' && fieldLabel) {
      const ctrl = findControlByLabel(root, fieldLabel) || findControlByLabelEverywhere(fieldLabel);
      const r = setSelectOrInputValue(ctrl, value, `patch:${fieldLabel}`);
      return {
        ok: r.ok,
        error: r.ok ? undefined : `Could not set “${fieldLabel}”`,
        note: r.note,
      };
    }
    return { ok: false, error: 'Unknown patch' };
  }

  function listMissingRequiredInRoot(root) {
    const missing = [];
    const groups = root.querySelectorAll('.form-group.required');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const lab = g.querySelector('label.control-label') || g.querySelector('label');
      const label = lab ? lab.textContent.trim() : '?';
      const sel = g.querySelector('select.form-control');
      const inp = g.querySelector('input.form-control:not([type="hidden"])');
      if (sel && sel.querySelector('option[value=""]')) {
        if (!sel.value || sel.value === '') missing.push(label);
      } else if (inp && inp.getAttribute('aria-required') === 'true') {
        if (!String(inp.value || '').trim()) missing.push(label);
      }
    }
    return missing;
  }

  function runProbeRestReady(expectStockFieldLabels, lineIndex) {
    const lineIdx = Math.max(0, parseInt(String(lineIndex ?? '0'), 10) || 0);
    const labels = Array.isArray(expectStockFieldLabels)
      ? expectStockFieldLabels.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const root = scopeRootForLineIndex(lineIdx);
    const catSel = nthItemCategorySelect(lineIdx) || firstItemCategorySelect();
    const nameInp = findFirstNameInput(root) || findFirstNameInput(itemsFormRootEl() || document.body);
    const debug = {
      hasCategorySelect: !!catSel,
      categoryValue: catSel ? String(catSel.value || '') : '',
      hasNameInput: !!nameInp,
      nameName: nameInp ? nameInp.name : '',
      expectLabels: labels,
      foundStock: {},
    };
    if (!catSel || !nameInp) {
      return { ready: false, debug };
    }
    for (let i = 0; i < labels.length; i++) {
      const lab = labels[i];
      const ctrl = findStockControlForLine(root, lab);
      debug.foundStock[lab] = !!ctrl;
      if (!ctrl) {
        return { ready: false, debug };
      }
    }
    log('probe_rest_ready: OK', debug);
    return { ready: true, debug };
  }

  /** NosPos can render a freshly-added row before that row's category <select>
   *  finishes populating its <option> list. A one-shot check then falsely reports
   *  the wanted category as "not in the dropdown" (the option arrives a beat later).
   *  Poll the option list for up to this long before giving up. */
  const CATEGORY_OPTION_WAIT_MS = 4000;

  /** A freshly-added row's category <select> can lag behind the page "load" event,
   *  especially when the NosPos tab is in the BACKGROUND (the operator switched
   *  tabs / desktops): the reload renders slower, so a one-shot lookup misses the
   *  element and the line falsely fails with "Category field not found". Poll for
   *  the select to appear before giving up — same idea as the option wait below. */
  const CATEGORY_SELECT_WAIT_MS = 12000;

  function findCategoryOptionById(sel, id) {
    if (!sel || !id) return null;
    return Array.from(sel.options).find((o) => String(o.value).trim() === id) || null;
  }

  async function runCategoryPhase(categoryId, lineIndex) {
    const lineIdx = Math.max(0, parseInt(String(lineIndex ?? '0'), 10) || 0);
    const id = String(categoryId ?? '').trim();
    log('phase category', id, 'line', lineIdx);
    logToBackground('runCategoryPhase', 'enter', { categoryId: id, lineIndex: lineIdx, url: window.location.href }, `Setting category ${id} on line ${lineIdx}`);
    let sel = nthItemCategorySelect(lineIdx);
    if (!sel) {
      // Wait for the row's <select> to render rather than failing immediately —
      // a backgrounded tab finishes its reload more slowly than a focused one.
      const deadline = Date.now() + CATEGORY_SELECT_WAIT_MS;
      while (!sel && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        sel = nthItemCategorySelect(lineIdx);
      }
    }
    if (!sel) {
      logToBackground('runCategoryPhase', 'error', { lineIndex: lineIdx, totalSelects: listCategorySelects().length, waitedMs: CATEGORY_SELECT_WAIT_MS }, 'Category select not found for line after wait');
      return { ok: false, error: 'Category field not found for line ' + lineIdx };
    }
    // Wait briefly for the option list to populate before deciding the id is absent.
    // This is what fixes the false "Category id N is not in the NoSpos dropdown"
    // errors on rapidly-added lines: the option is there, just not rendered yet.
    let opt = findCategoryOptionById(sel, id);
    if (!opt && id) {
      const deadline = Date.now() + CATEGORY_OPTION_WAIT_MS;
      while (!opt && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        opt = findCategoryOptionById(sel, id);
      }
    }
    if (!opt && id) {
      // Capture what WAS in the dropdown so a genuine absence (wrong row / a category
      // list that really doesn't include this id) can be told apart from a slow-load
      // race that outlasted the wait. Shows up in the park log on the next failure.
      const optionsSample = Array.from(sel.options)
        .slice(0, 60)
        .map((o) => ({ v: String(o.value), t: String(o.textContent || '').trim() }));
      logToBackground('runCategoryPhase', 'error', { lineIndex: lineIdx, wantedCategoryId: id, optionCount: sel.options.length, optionsSample, waitedMs: CATEGORY_OPTION_WAIT_MS }, `Category id ${id} not in dropdown after ${CATEGORY_OPTION_WAIT_MS}ms wait`);
      return { ok: false, error: `Category id ${id} is not in the NoSpos dropdown for this item`, optionCount: sel.options.length };
    }
    logToBackground('runCategoryPhase', 'step', { lineIndex: lineIdx, currentValue: sel.value, wantedCategoryId: id, optionCount: sel.options.length }, 'Category option found — setting value');
    const result = setCategorySelect(sel, id);
    logToBackground('runCategoryPhase', 'exit', { result, lineIndex: lineIdx, categoryId: id }, 'setCategorySelect result');
    return result;
  }

  function runFindLineMarker(marker) {
    const m = String(marker || '').trim();
    if (!m) return { ok: false, error: 'No marker' };
    const riOnly = m.match(/^RI-(\d+)$/i);
    const needle = riOnly ? `-RI-${riOnly[1]}-` : m;
    const sels = listCategorySelects();
    for (let i = 0; i < sels.length; i++) {
      const descInp = findItemDescriptionInputForLine(i);
      const v = descInp ? String(descInp.value || '') : '';
      if (v.includes(needle)) return { ok: true, lineIndex: i };
    }
    return { ok: true, lineIndex: -1 };
  }

  /** Substring that matches CG Suite markers like [CG-RQ-780-RI-1274-L1] without colliding with longer numeric ids. */
  function descriptionNeedleForRequestItemId(requestItemId) {
    const id = String(requestItemId || '').trim();
    if (!id || !/^\d+$/.test(id)) return '';
    return `-RI-${id}-`;
  }

  function cardRootForAgreementLine(lineIdx) {
    const sel = nthItemCategorySelect(lineIdx);
    if (!sel) return null;
    let card = sel.closest('.card');
    if (!card) {
      const cc = sel.closest('.card-content');
      card = cc ? cc.closest('.card') : null;
    }
    return card;
  }

  function openActionsDropdownInCard(card) {
    if (!card) return false;
    const toggle = card.querySelector(
      'a.dropdown-toggle[data-toggle="dropdown"], a.dropdown-toggle[data-bs-toggle="dropdown"], .dropdown-toggle',
    );
    if (toggle) {
      toggle.click();
      return true;
    }
    return false;
  }

  function findPostDeleteLinkInCard(card) {
    if (!card) return null;
    const links = Array.from(card.querySelectorAll('a[href*="delete"]'));
    for (let li = 0; li < links.length; li++) {
      const a = links[li];
      if (String(a.getAttribute('data-method') || '').toLowerCase() !== 'post') continue;
      const href = String(a.getAttribute('href') || '');
      if (!/\/item\/delete/i.test(href) && !/item%2Fdelete/i.test(href)) continue;
      return a;
    }
    return null;
  }

  /**
   * NosPos / Yii often uses SweetAlert after data-confirm — confirm so the POST runs.
   */
  async function confirmDeleteDialogIfPresent(maxMs) {
    const deadline = Date.now() + Math.max(500, maxMs);
    const selectors = [
      '.swal2-confirm',
      'button.swal2-confirm',
      '.swal2-actions button.swal2-confirm',
      '.swal-button--confirm',
      '[data-bb-handler="confirm"]',
      '.bootbox .btn-primary',
      '.modal.in .btn-danger',
      '.modal.show .btn-danger',
    ];
    while (Date.now() < deadline) {
      for (let si = 0; si < selectors.length; si++) {
        const btn = document.querySelector(selectors[si]);
        if (btn && typeof btn.click === 'function') {
          log('confirm delete dialog', selectors[si]);
          btn.click();
          await new Promise((r) => setTimeout(r, 120));
          return { confirmed: true };
        }
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    return { confirmed: false };
  }

  /**
   * Items step: submit the blue "Next" button (advances wizard before sidebar Park Agreement).
   */
  function runClickItemsFormNext() {
    const btn =
      document.querySelector('button[type="submit"][name="action"][value="next"]') ||
      document.querySelector('button.btn.btn-blue[name="action"][value="next"]');
    if (!btn) {
      warn('items next: button not found');
      return { ok: false, error: 'Next button not found on the items page' };
    }
    log('items form — click Next');
    btn.click();
    return { ok: true };
  }

  /**
   * Item name shown on the card a node belongs to (the line's
   * DraftAgreementItem[..][name] input), for mapping a cleared field back to a
   * CG Suite line by name. Empty string when it can't be found.
   */
  function itemNameForNode(node) {
    const card = node && node.closest ? node.closest('.card') : null;
    const scope = card || document;
    const nameInp = scope.querySelector('input[name*="DraftAgreementItem"][name$="[name]"]');
    return nameInp ? String(nameInp.value || '').trim() : '';
  }

  /**
   * Global (cross-page) 0-based row index for the card a node belongs to, or
   * null if it can't be resolved. On a clean park run this matches the flow's
   * sequential stepIndex, so the page can map a cleared field back to the right
   * line (page offset + the card's slot among this page's category selects).
   */
  function globalRowIndexForNode(node) {
    const card = node && node.closest ? node.closest('.card') : null;
    if (!card) return null;
    const catSel = card.querySelector('select[name*="DraftAgreementItem"][name$="[category]"]');
    if (!catSel) return null;
    const pageLocal = listCategorySelects().indexOf(catSel);
    if (pageLocal < 0) return null;
    const pager = runReadAgreementPager();
    const page = pager && pager.currentPage ? pager.currentPage : 1;
    return (page - 1) * NOSPOS_ITEMS_PER_PAGE + pageLocal;
  }

  /**
   * NosPos rejected the items form on Next (e.g. "Invalid IMEI"): find every
   * field it flagged with `.has-error`, record what it was (so CG Suite can tell
   * the operator which item lost which field and why), then CLEAR the offending
   * text so a re-submit can go through. We deliberately drop the bad value
   * rather than block parking. Selects are left alone — clearing one would just
   * re-trigger a "required" error and loop — and so are already-empty fields
   * (clearing them can't lift the error). Returns the per-field reports.
   */
  function runClearErroredAgreementFields() {
    const form = itemsFormRootEl() || document;
    const groups = Array.from(form.querySelectorAll('.form-group.has-error'));
    const cleared = [];
    const errorGroupCount = groups.length;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const input =
        g.querySelector('input.form-control:not([type="hidden"])') ||
        g.querySelector('textarea.form-control');
      if (!input) continue; // select / no editable text control — leave it
      const prev = readControlValue(input);
      if (!prev) continue; // already empty — clearing won't lift the error
      const labEl = g.querySelector('label.control-label') || g.querySelector('label');
      const fieldLabel = labEl ? String(labEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const errEl =
        g.querySelector('.help-block-error') || g.querySelector('.help-block.help-block-error');
      const errorText = errEl
        ? String(errEl.textContent || '').replace(/\s+/g, ' ').trim()
        : 'NoSpos rejected this value';
      const report = {
        fieldLabel: fieldLabel || 'Field',
        errorText: errorText || 'NoSpos rejected this value',
        previousValue: prev,
        itemName: itemNameForNode(g),
        globalRowIndex: globalRowIndexForNode(g),
      };
      input.value = '';
      dispatchControlEvents(input);
      log('cleared errored field', report);
      logToBackground(
        'runClearErroredAgreementFields',
        'step',
        report,
        'Cleared a NoSpos-rejected field so the items form can re-submit'
      );
      cleared.push(report);
    }
    logToBackground(
      'runClearErroredAgreementFields',
      'exit',
      { clearedCount: cleared.length, errorGroupCount },
      'Finished clearing NoSpos-rejected fields'
    );
    return { ok: true, cleared, errorGroupCount };
  }

  /**
   * Agreement summary sidebar (col-lg-3): Actions → Park Agreement → confirm SweetAlert.
   * POST link href like /newagreement/73908/park
   */
  function findSidebarAgreementParkLink() {
    const candidates = Array.from(
      document.querySelectorAll('a[data-method="post"][href*="/newagreement/"]'),
    );
    const matchHref = (a) => {
      const href = String(a.getAttribute('href') || '').split('?')[0];
      return /\/newagreement\/\d+\/park$/i.test(href);
    };
    const pick = (predCard) => {
      for (let i = 0; i < candidates.length; i++) {
        const a = candidates[i];
        if (!matchHref(a)) continue;
        const card = a.closest('.card');
        if (!card || !predCard(card)) continue;
        return a;
      }
      return null;
    };
    const byTitle = pick((card) => {
      const titleEl = card.querySelector('.card-title');
      const t = normLabel(titleEl ? titleEl.textContent : '');
      return t === 'agreement' || (t.includes('agreement') && !t.includes('item'));
    });
    if (byTitle) return byTitle;
    return pick((card) => !!card.querySelector('.card-header.card-header-tabs'));
  }

  async function runSidebarParkAgreement() {
    logToBackground('runSidebarParkAgreement', 'enter', { url: window.location.href }, 'Content script: beginning sidebar park agreement');
    let parkLink = findSidebarAgreementParkLink();
    const card = parkLink ? parkLink.closest('.card') : null;
    logToBackground('runSidebarParkAgreement', 'step', {
      parkLinkFound: !!parkLink,
      parkLinkHref: parkLink ? parkLink.getAttribute('href') : null,
      cardFound: !!card,
    }, 'Initial search for park link and agreement card');
    if (!card) {
      warn('sidebar park: agreement summary card / park link not found');
      logToBackground('runSidebarParkAgreement', 'error', { url: window.location.href }, 'Agreement card / park link not found in DOM');
      return { ok: false, error: 'Park Agreement was not found (Agreement card → Actions)' };
    }
    logToBackground('runSidebarParkAgreement', 'step', {}, 'Opening Actions dropdown in agreement card');
    openActionsDropdownInCard(card);
    await new Promise((r) => setTimeout(r, 280));
    parkLink = findSidebarAgreementParkLink();
    logToBackground('runSidebarParkAgreement', 'step', { parkLinkFound: !!parkLink, parkLinkHref: parkLink?.getAttribute('href') }, 'Park link search after 1st Actions open');
    if (!parkLink) {
      logToBackground('runSidebarParkAgreement', 'step', {}, 'Park link not found — retrying Actions open');
      openActionsDropdownInCard(card);
      await new Promise((r) => setTimeout(r, 280));
      parkLink = findSidebarAgreementParkLink();
      logToBackground('runSidebarParkAgreement', 'step', { parkLinkFound: !!parkLink, parkLinkHref: parkLink?.getAttribute('href') }, 'Park link search after 2nd Actions open');
    }
    if (!parkLink) {
      logToBackground('runSidebarParkAgreement', 'error', {}, 'Park Agreement link still missing after both Actions attempts');
      return { ok: false, error: 'Park Agreement link missing after opening Actions' };
    }
    const parkHref = parkLink.getAttribute('href');
    log('sidebar park — click POST link', parkHref);
    logToBackground(
      'runSidebarParkAgreement',
      'step',
      { delayMs: NOSPOS_ACTION_CLICK_DELAY_MS, parkHref },
      'Rate-limit guard: delaying before Park Agreement click'
    );
    await new Promise((r) => setTimeout(r, NOSPOS_ACTION_CLICK_DELAY_MS));
    logToBackground('runSidebarParkAgreement', 'step', { parkHref }, 'Clicking Park Agreement POST link');
    parkLink.click();
    logToBackground('runSidebarParkAgreement', 'step', {}, 'Park link clicked — waiting for confirmation dialog (up to 45s)');
    // Park dialogs can be slower than delete confirms; allow time for manual/extension OK.
    const conf = await confirmDeleteDialogIfPresent(45000);
    logToBackground('runSidebarParkAgreement', 'result', { confirmed: conf.confirmed }, 'Confirmation dialog result');
    if (!conf.confirmed) {
      logToBackground('runSidebarParkAgreement', 'error', {}, 'OK confirmation dialog did not appear');
      return {
        ok: false,
        error: 'Parking confirmation (OK) did not appear — confirm manually on NoSpos',
      };
    }
    logToBackground('runSidebarParkAgreement', 'exit', { parked: true }, 'Park agreement confirmed via dialog — done');
    return { ok: true, parked: true };
  }

  async function runDeleteLineByRequestItemId(requestItemId) {
    const needle = descriptionNeedleForRequestItemId(requestItemId);
    if (!needle) return { ok: true, skipped: true, reason: 'invalid_request_item_id' };

    const nLines = agreementItemLineCount();
    for (let i = 0; i < nLines; i++) {
      const descInp = findItemDescriptionInputForLine(i);
      const v = descInp ? String(descInp.value || '') : '';
      if (!v.includes(needle)) continue;

      const card = cardRootForAgreementLine(i) || (descInp ? descInp.closest('.card') : null);
      if (!card) {
        warn('delete excluded: no card for line', i, needle);
        return { ok: false, error: 'Could not find item card for this agreement line' };
      }

      openActionsDropdownInCard(card);
      await new Promise((r) => setTimeout(r, 220));

      let deleteLink = findPostDeleteLinkInCard(card);
      if (!deleteLink) {
        openActionsDropdownInCard(card);
        await new Promise((r) => setTimeout(r, 220));
        deleteLink = findPostDeleteLinkInCard(card);
      }
      if (!deleteLink) {
        warn('delete link not found in card', needle, card);
        return { ok: false, error: 'Delete action not found on this item card (Actions menu)' };
      }

      log('delete excluded line — click Delete', requestItemId, deleteLink.getAttribute('href'));
      deleteLink.click();
      const conf = await confirmDeleteDialogIfPresent(8000);
      if (!conf.confirmed) {
        warn('delete confirm not detected — if NosPos uses a native dialog, confirm it manually');
      }
      return { ok: true, deleted: true, lineIndex: i, requestItemId: String(requestItemId) };
    }

    return { ok: true, skipped: true, reason: 'no_matching_row' };
  }

  function runReadLineSnapshot(lineIndex) {
    const lineIdx = Math.max(0, parseInt(String(lineIndex ?? '0'), 10) || 0);
    const sel = nthItemCategorySelect(lineIdx);
    if (!sel) return { ok: false, error: 'Category field not found for line ' + lineIdx };
    const root = scopeRootForLineIndex(lineIdx);
    const nameInp =
      findFirstNameInput(root) || findFirstNameInput(itemsFormRootEl() || document.body);
    const descInp = findItemDescriptionInputForLine(lineIdx);
    return {
      ok: true,
      name: nameInp ? String(nameInp.value || '').trim() : '',
      description: descInp ? String(descInp.value || '').trim() : '',
      categoryId: String(sel.value || '').trim(),
    };
  }

  function runRestPhase(msg) {
    const lineIdx = Math.max(0, parseInt(String(msg.lineIndex ?? '0'), 10) || 0);
    logToBackground('runRestPhase', 'enter', {
      lineIndex: lineIdx, name: msg.name, quantity: msg.quantity,
      retailPrice: msg.retailPrice, boughtFor: msg.boughtFor,
      stockFieldCount: Array.isArray(msg.stockFields) ? msg.stockFields.length : 0,
      itemDescription: msg.itemDescription,
    }, `Filling rest of line ${lineIdx}`);
    log('phase rest start', {
      lineIndex: lineIdx, name: msg.name, quantity: msg.quantity,
      retailPrice: msg.retailPrice, boughtFor: msg.boughtFor,
      stockCount: Array.isArray(msg.stockFields) ? msg.stockFields.length : 0,
    });
    const root = scopeRootForLineIndex(lineIdx);
    const form = itemsFormRootEl();
    const nameInp =
      findFirstNameInput(root) ||
      findFirstNameInput(form || document.body) ||
      document.querySelector('input[name*="DraftAgreementItem"][name$="[name]"]');
    if (!nameInp) {
      warn('rest: name input not found');
      return { ok: false, notReady: true, error: 'Agreement item form not ready yet' };
    }

    const fieldRows = [];
    fieldRows.push(buildCategoryFieldRow(String(msg.categoryOurDisplay || '').trim(), lineIdx));

    const applied = {
      name: false,
      itemDescription: false,
      quantity: false,
      retailPrice: false,
      boughtFor: false,
      stockLabels: [],
    };
    const warnings = [];

    if (msg.name != null && String(msg.name).trim()) {
      const rName = setSelectOrInputValue(nameInp, String(msg.name).trim(), 'name');
      applied.name = rName.ok;
      fieldRows.push({
        id: 'name',
        field: 'Item name',
        ourValue: String(msg.name).trim(),
        nosposValue: rName.currentValue,
        nosposDisplay: rName.displayValue,
        note: rName.note || 'Read-only here; change the line in CG Suite or on the NoSpos tab.',
        required: true,
        inputKind: rName.inputKind,
        options: rName.options || [],
        step: rName.step,
        min: rName.min,
        patchKind: 'none',
        fieldLabel: '',
        displayOnly: true,
      });
    }

    if (msg.itemDescription != null && String(msg.itemDescription).trim()) {
      const descInp = findItemDescriptionInputForLine(lineIdx);
      const incoming = String(msg.itemDescription).trim();
      if (descInp) {
        // Append to / update our block in the existing description — don't wipe.
        const val = mergeCgItemDescription(readControlValue(descInp), incoming);
        const rDesc = setSelectOrInputValue(descInp, val, 'item_description');
        applied.itemDescription = rDesc.ok;
        fieldRows.push({
          id: 'item_description',
          field: 'Item description',
          ourValue: val,
          nosposValue: rDesc.currentValue,
          nosposDisplay: rDesc.displayValue,
          note: rDesc.note || '',
          required: false,
          inputKind: rDesc.inputKind,
          options: rDesc.options || [],
          step: rDesc.step,
          min: rDesc.min,
          patchKind: 'item_description',
          fieldLabel: '',
        });
      } else {
        warnings.push('Item description field not found; CG request marker was not written to NosPos.');
      }
    }

    const itemId = draftAgreementItemIdFromNameInput(nameInp);
    const search = form || document;

    if (itemId) {
      const q = search.querySelector(`input[name="DraftAgreementItem[${itemId}][quantity]"]`);
      if (msg.quantity != null && String(msg.quantity).trim()) {
        const r = setSelectOrInputValue(q, String(msg.quantity).trim(), 'quantity');
        applied.quantity = r.ok;
        fieldRows.push({
          id: 'quantity',
          field: 'Quantity',
          ourValue: String(msg.quantity).trim(),
          nosposValue: r.currentValue,
          nosposDisplay: r.displayValue,
          note: r.note || '',
          required: true,
          inputKind: r.inputKind,
          options: r.options || [],
          step: r.step,
          min: r.min,
          patchKind: 'quantity',
          fieldLabel: '',
        });
      }
      const rp = search.querySelector(`input[name="DraftAgreementItem[${itemId}][retail_price]"]`);
      if (msg.retailPrice != null && String(msg.retailPrice).trim()) {
        const r = setSelectOrInputValue(rp, String(msg.retailPrice).trim(), 'retail_price');
        applied.retailPrice = r.ok;
        fieldRows.push({
          id: 'retail_price',
          field: 'Retail price (£)',
          ourValue: String(msg.retailPrice).trim(),
          nosposValue: r.currentValue,
          nosposDisplay: r.displayValue,
          note: r.note || '',
          required: true,
          inputKind: r.inputKind,
          options: r.options || [],
          step: r.step,
          min: r.min,
          patchKind: 'retail_price',
          fieldLabel: '',
        });
      }
      const bf = search.querySelector(`input[name="DraftAgreementItem[${itemId}][bought_for]"]`);
      if (msg.boughtFor != null && String(msg.boughtFor).trim()) {
        const r = setSelectOrInputValue(bf, String(msg.boughtFor).trim(), 'bought_for');
        applied.boughtFor = r.ok;
        fieldRows.push({
          id: 'bought_for',
          field: 'Offer (£)',
          ourValue: String(msg.boughtFor).trim(),
          nosposValue: r.currentValue,
          nosposDisplay: r.displayValue,
          note: r.note || '',
          required: true,
          inputKind: r.inputKind,
          options: r.options || [],
          step: r.step,
          min: r.min,
          patchKind: 'bought_for',
          fieldLabel: '',
        });
      }
    } else {
      warnings.push('Could not parse DraftAgreementItem id; skipped quantity / retail / offer.');
      warn('could not parse DraftAgreementItem id from', nameInp.name);
    }

    const stockFields = Array.isArray(msg.stockFields) ? msg.stockFields : [];
    for (let s = 0; s < stockFields.length; s++) {
      const row = stockFields[s];
      const label = row && row.label != null ? String(row.label).trim() : '';
      const value = row && row.value != null ? String(row.value).trim() : '';
      if (!label || !value) continue;
      const ctrl = findStockControlForLine(root, label);
      if (!ctrl) {
        warnings.push(`No control found for stock field "${label}"`);
        fieldRows.push({
          id: `stock:${normLabel(label)}`,
          field: label,
          ourValue: value,
          nosposValue: '',
          nosposDisplay: '',
          note: 'NosPos field not found on the agreement — left as-is.',
          required: false,
          inputKind: 'text',
          options: [],
          step: null,
          min: null,
          patchKind: 'by_label',
          fieldLabel: label,
        });
        continue;
      }
      const r = setSelectOrInputValue(ctrl, value, `stock:"${label}"`);
      if (r.ok) applied.stockLabels.push(label);
      else warnings.push(`Could not set "${label}" to "${value}"`);
      const nk = normLabel(label);
      fieldRows.push({
        id: `stock:${nk}`,
        field: label,
        ourValue: value,
        nosposValue: r.currentValue,
        nosposDisplay: r.displayValue,
        note: r.note || '',
        required: true,
        inputKind: r.inputKind,
        options: r.options || [],
        step: r.step,
        min: r.min,
        patchKind: 'by_label',
        fieldLabel: label,
      });
    }

    discoverExtraFields(root, fieldRows);
    if (form && form !== root) discoverExtraFields(form, fieldRows);

    const missingRequired = Array.from(new Set(listMissingRequiredInRoot(root)));

    logToBackground('runRestPhase', 'exit', { lineIndex: lineIdx, applied, warnings, missingRequired, fieldRowsLen: fieldRows.length }, 'Rest phase complete');
    log('phase rest done', { applied, warnings, missingRequired, fieldRowsLen: fieldRows.length });
    return {
      ok: true,
      applied,
      missingRequired,
      warnings,
      notReady: false,
      fieldRows,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'NOSPOS_AGREEMENT_PATCH_FIELD') {
      sendResponse(runPatchField(msg));
      return true;
    }

    if (msg?.type === 'NOSPOS_FILL_FIRST_ITEM_CATEGORY') {
      const categoryId = String(msg.categoryId ?? '').trim();
      if (!categoryId) {
        sendResponse({ ok: false, error: 'Missing category id' });
        return true;
      }
      runCategoryPhase(categoryId, msg.lineIndex)
        .then((r) => sendResponse(r.ok ? r : { ok: false, error: r.error, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }

    if (msg?.type === 'NOSPOS_AGREEMENT_FILL_PHASE') {
      if (msg.phase === 'category') {
        const categoryId = String(msg.categoryId ?? '').trim();
        if (!categoryId) {
          sendResponse({ ok: false, error: 'Missing category id' });
          return true;
        }
        runCategoryPhase(categoryId, msg.lineIndex)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
      }
      if (msg.phase === 'probe_rest_ready') {
        const expect = msg.expectStockFieldLabels || [];
        sendResponse(runProbeRestReady(expect, msg.lineIndex));
        return true;
      }
      if (msg.phase === 'count_lines') {
        sendResponse({ ok: true, count: agreementItemLineCount() });
        return true;
      }
      if (msg.phase === 'read_pager') {
        sendResponse(runReadAgreementPager());
        return true;
      }
      if (msg.phase === 'nav_to_page') {
        sendResponse(runNavigateAgreementToPage(msg.pageNum, msg.force === true));
        return true;
      }
      if (msg.phase === 'click_add') {
        sendResponse(runClickAddAgreementItem());
        return true;
      }
      if (msg.phase === 'find_line_marker') {
        sendResponse(runFindLineMarker(msg.marker));
        return true;
      }
      if (msg.phase === 'read_line_snapshot') {
        sendResponse(runReadLineSnapshot(msg.lineIndex));
        return true;
      }
      if (msg.phase === 'rest') {
        sendResponse(runRestPhase(msg));
        return true;
      }
      if (msg.phase === 'delete_line_by_request_item_id') {
        runDeleteLineByRequestItemId(msg.requestItemId)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
      }
      if (msg.phase === 'click_items_form_next') {
        sendResponse(runClickItemsFormNext());
        return true;
      }
      if (msg.phase === 'clear_errored_fields') {
        sendResponse(runClearErroredAgreementFields());
        return true;
      }
      if (msg.phase === 'sidebar_park_agreement') {
        runSidebarParkAgreement()
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
        return true;
      }
      sendResponse({ ok: false, error: 'Unknown phase' });
      return true;
    }

    return undefined;
  });
})();
