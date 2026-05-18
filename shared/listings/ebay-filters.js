/**
 * eBay-specific helpers: required-filter enforcement, sort default, and a
 * session-storage-based log replay that runs on the reload triggered by
 * enforceEbayFilters().
 *
 * Loaded at top level (no IIFE) so the runtime in content-listings.js can call
 * these functions directly — content scripts on the same page share one
 * isolated world, so top-level declarations here are visible there.
 *
 * Exports (as globals in the isolated world):
 *   getEbayKeywordMatchCountFromHeading, EBAY_REQUIRED_FILTERS, EBAY_REQUIRED_SORT,
 *   getEbaySearchKey, hasAppliedEbaySortDefaultForSearch, markAppliedEbaySortDefaultForSearch,
 *   getFilterLinkHref, getEbaySortLink, hasRequiredEbaySort, hasRequiredEbayFilters,
 *   enforceEbayFilters
 */

function getEbayKeywordMatchCountFromHeading() {
  var h1 = document.querySelector('h1.srp-controls__count-heading');
  if (!h1) return null;
  var text = (h1.textContent || '').replace(/\s+/g, ' ').trim();
  var m = text.match(/^([\d,]+)\s+results?\s+for\b/i);
  if (!m) return null;
  var n = parseInt(String(m[1]).replace(/,/g, ''), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// —— eBay required filter + sort enforcement ——
//
// Each filter entry:
//   urlParam / urlValue  – the CURRENT known URL query param (fast check + fallback)
//   activeSelector       – DOM element whose .checked state confirms the filter IS active
//   linkSelector         – the <a> (or input inside <a>) that eBay itself uses to apply this filter;
//                          its href always uses eBay's current correct params (param-name agnostic)
//   isRadio              – true for single-select (radio) filters like "UK Only"
//
// Sort spec:
//   urlParam / urlValue  – the CURRENT known URL sort param (_sop=15)
//   displayText          – the VISIBLE label in the sort dropdown (used to find the link by text,
//                          which is more stable than the param value itself)
//   containerSelector    – narrows the search for the sort option links
const EBAY_REQUIRED_FILTERS = [
  {
    urlParam:       'LH_Complete',
    urlValue:       '1',
    linkSelector:   'li[name="LH_Complete"] a.x-refine__multi-select-link',
    activeSelector: 'li[name="LH_Complete"] input[type="checkbox"]',
  },
  {
    urlParam:       'LH_Sold',
    urlValue:       '1',
    linkSelector:   '[data-param-key="LH_Sold"] a.x-refine__multi-select-link, li[name="LH_Sold"] a.x-refine__multi-select-link',
    activeSelector: '[data-param-key="LH_Sold"] input[type="checkbox"], li[name="LH_Sold"] input[type="checkbox"]',
  },
  {
    urlParam:       'LH_PrefLoc',
    urlValue:       '1',
    linkSelector:   'li[name="LH_PrefLoc"] input[type="radio"][data-value="UK Only"]',
    activeSelector: 'li[name="LH_PrefLoc"] input[type="radio"][data-value="UK Only"]',
    isRadio:        true,
  },
];

const EBAY_REQUIRED_SORT = {
  urlParam:          '_sop',
  urlValue:          '15',
  displayText:       'Lowest price + P&P',
  containerSelector: '.fake-menu__items',
};

// Apply eBay sort as default once per search term.
// If the user changes sort, keep their choice for that search.
// When search term changes (new Enter search), apply default again.
const EBAY_SORT_DEFAULT_APPLIED_SEARCH_KEY = 'cgSuiteEbaySortDefaultAppliedSearchKey';

function getEbaySearchKey(url) {
  try {
    const u = new URL(url || window.location.href);
    const kw = (u.searchParams.get('_nkw') || '').trim().toLowerCase();
    return kw;
  } catch (e) {
    return '';
  }
}

function hasAppliedEbaySortDefaultForSearch(searchKey) {
  try {
    return sessionStorage.getItem(EBAY_SORT_DEFAULT_APPLIED_SEARCH_KEY) === searchKey;
  } catch (e) {
    return false;
  }
}

function markAppliedEbaySortDefaultForSearch(searchKey) {
  try {
    sessionStorage.setItem(EBAY_SORT_DEFAULT_APPLIED_SEARCH_KEY, searchKey);
  } catch (e) {}
}

/**
 * Returns the href of the eBay-provided link for a given filter spec.
 * For radio filters the link wraps the input; for checkboxes the <a> IS the link.
 * Using eBay's own href means we pick up correct params even if names change.
 */
function getFilterLinkHref(filterSpec) {
  try {
    const el = document.querySelector(filterSpec.linkSelector);
    if (!el) return null;
    if (filterSpec.isRadio) {
      const link = el.closest('a') || el.closest('li').querySelector('a');
      return link ? link.href : null;
    }
    return el.href || null;
  } catch (e) {
    return null;
  }
}

/**
 * Finds the sort option <a> element whose visible text matches EBAY_REQUIRED_SORT.displayText.
 * The dropdown items are in the DOM even when the pill is collapsed, so querySelectorAll works.
 *
 * Tries two strategies in order:
 *   1. Primary:  .fake-menu__items a.fake-menu-button__item  (standard sort dropdown)
 *   2. Fallback: .srp-sort a, .srp-controls__sort a          (alternative sort containers)
 *
 * Returns { link, strategy } or null when the sort control is absent from this page entirely.
 * Callers must skip sort enforcement when null is returned — no point setting _sop on a page
 * that has no sort control.
 */
function getEbaySortLink() {
  const log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};
  const label = EBAY_REQUIRED_SORT.displayText;

  // Strategy 1: standard fake-menu dropdown (items present in DOM even when pill is collapsed)
  try {
    const containers = document.querySelectorAll(EBAY_REQUIRED_SORT.containerSelector);
    if (containers.length === 0) {
      log('[CG Suite]   getEbaySortLink: strategy 1 – no "' + EBAY_REQUIRED_SORT.containerSelector + '" containers in DOM');
    } else {
      for (var c = 0; c < containers.length; c++) {
        const links = containers[c].querySelectorAll('a.fake-menu-button__item');
        for (var i = 0; i < links.length; i++) {
          if ((links[i].textContent || '').trim() === label) {
            log('[CG Suite]   getEbaySortLink: strategy 1 matched – found "' + label + '" in .fake-menu__items');
            return { link: links[i], strategy: 'primary (.fake-menu__items)' };
          }
        }
      }
      log('[CG Suite]   getEbaySortLink: strategy 1 – containers found but label "' + label + '" not matched');
    }
  } catch (e) {
    log('[CG Suite]   getEbaySortLink: strategy 1 error', e);
  }

  // Strategy 2: alternative sort containers
  try {
    const altLinks = document.querySelectorAll('.srp-sort a, .srp-controls__sort a');
    for (var j = 0; j < altLinks.length; j++) {
      if ((altLinks[j].textContent || '').trim() === label) {
        log('[CG Suite]   getEbaySortLink: strategy 2 matched – found "' + label + '" in .srp-sort/.srp-controls__sort');
        return { link: altLinks[j], strategy: 'fallback (.srp-sort / .srp-controls__sort)' };
      }
    }
    log('[CG Suite]   getEbaySortLink: strategy 2 – label "' + label + '" not found in .srp-sort/.srp-controls__sort (' + altLinks.length + ' links checked)');
  } catch (e) {
    log('[CG Suite]   getEbaySortLink: strategy 2 error', e);
  }

  log('[CG Suite]   getEbaySortLink: sort control absent from this page — sort enforcement will be skipped');
  return null;
}

/**
 * Dual-mode sort detection:
 * 1. URL param _sop=15 (fast path)
 * 2. DOM: is the "Lowest price + P&P" option marked aria-current="page"?
 */
function hasRequiredEbaySort(url) {
  const log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};
  log('[CG Suite] hasRequiredEbaySort: checking url =', url || window.location.href);

  try {
    const u = new URL(url || window.location.href);
    const actual = u.searchParams.get(EBAY_REQUIRED_SORT.urlParam);
    const pass = actual === EBAY_REQUIRED_SORT.urlValue;
    log('[CG Suite]   URL param check  |', EBAY_REQUIRED_SORT.urlParam, '=', actual,
      '→', pass ? '✓ pass' : '✗ fail (expected ' + EBAY_REQUIRED_SORT.urlValue + ')');
    if (pass) {
      log('[CG Suite] hasRequiredEbaySort: passed via URL param → sort present');
      return true;
    }
  } catch (e) {
    log('[CG Suite] hasRequiredEbaySort: URL parse error, falling through to DOM check', e);
  }

  log('[CG Suite] hasRequiredEbaySort: URL param check incomplete, trying DOM sort dropdown...');
  const result = getEbaySortLink();
  if (!result) {
    log('[CG Suite] hasRequiredEbaySort: sort control absent from this page — treating sort as satisfied (nothing to enforce)');
    return true;
  }
  const active = result.link.getAttribute('aria-current') === 'page';
  log('[CG Suite]   DOM sort check    | label "' + EBAY_REQUIRED_SORT.displayText + '"',
    '| via: ' + result.strategy,
    '| aria-current="page":', active,
    '→', active ? '✓ active' : '✗ present but not selected'
  );
  log('[CG Suite] hasRequiredEbaySort: DOM result →', active ? 'sort active' : 'sort not set');
  return active;
}

/**
 * Dual-mode detection:
 * 1. URL params (fast path – works before the DOM is fully rendered)
 * 2. DOM sidebar state (fallback – param-name agnostic, checks the actual checkbox/radio state)
 * Returns true only when ALL three filters are confirmed active by either method.
 */
function hasRequiredEbayFilters(url) {
  const log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};
  log('[CG Suite] hasRequiredEbayFilters: checking url =', url || window.location.href);

  // — Pass 1: URL params —
  try {
    const u = new URL(url || window.location.href);
    const urlResults = EBAY_REQUIRED_FILTERS.map(function (f) {
      const actual = u.searchParams.get(f.urlParam);
      const pass = actual === f.urlValue;
      log('[CG Suite]   URL param check  |', f.urlParam, '=', actual, '→', pass ? '✓ pass' : '✗ fail (expected ' + f.urlValue + ')');
      return pass;
    });
    if (urlResults.every(Boolean)) {
      log('[CG Suite] hasRequiredEbayFilters: ALL passed via URL params → filters present');
      return true;
    }
    log('[CG Suite] hasRequiredEbayFilters: URL param check incomplete, trying DOM sidebar...');
  } catch (e) {
    log('[CG Suite] hasRequiredEbayFilters: URL parse error, falling through to DOM check', e);
  }

  // — Pass 2: DOM sidebar state —
  const domResults = EBAY_REQUIRED_FILTERS.map(function (f) {
    const el = document.querySelector(f.activeSelector);
    const found = !!el;
    const active = found && (el.checked || el.hasAttribute('checked'));
    log('[CG Suite]   DOM sidebar check |', f.urlParam,
      '| element found:', found,
      '| .checked:', found ? el.checked : 'n/a',
      '| [checked] attr:', found ? el.hasAttribute('checked') : 'n/a',
      '→', active ? '✓ active' : '✗ not active'
    );
    return active;
  });

  const allDomPass = domResults.every(Boolean);
  log('[CG Suite] hasRequiredEbayFilters: DOM sidebar result →', allDomPass ? 'ALL active' : 'one or more missing');
  return allDomPass;
}

/**
 * If required filters are missing, build a redirect URL and navigate to it.
 * Strategy (per filter):
 *   1. Skip if already present in the current URL.
 *   2. Pull the correct href from eBay's own sidebar link and merge its non-navigation
 *      params into our target URL (param-name agnostic).
 *   3. Fall back to the known hardcoded param if the sidebar isn't rendered yet.
 * The tab keeps its ID so the background re-sends WAITING_FOR_DATA after reload.
 */
function enforceEbayFilters() {
  const log = typeof console !== 'undefined' ? console.log.bind(console) : function () {};
  // `getSiteConfig` lives inside the content-listings.js IIFE so it is NOT visible here.
  // Gate by hostname, which is cheap and reliable for our match patterns.
  if (!/(^|\.)ebay\.co\.uk$/.test(window.location.hostname)) return false;
  const filtersOk = hasRequiredEbayFilters(window.location.href);
  const currentSearchKey = getEbaySearchKey(window.location.href);
  const shouldEnforceSortDefault = !hasAppliedEbaySortDefaultForSearch(currentSearchKey);
  const sortOk = shouldEnforceSortDefault ? hasRequiredEbaySort(window.location.href) : true;
  const pageSizeOk = (function () {
    try { return new URL(window.location.href).searchParams.get('_ipg') === '120'; } catch (e) { return false; }
  })();
  if (filtersOk && sortOk && pageSizeOk) return false;
  log(
    '[CG Suite] enforceEbayFilters: requirements missing (filters ok:',
    filtersOk,
    '/ sort ok:',
    sortOk,
    '/ page size ok:',
    pageSizeOk,
    '/ enforce sort default:',
    shouldEnforceSortDefault,
    ') — building redirect URL'
  );
  try {
    const NAV_PARAMS = ['_nkw', '_sacat', '_pgn', '_from', 'rt'];
    const target = new URL(window.location.href);
    const trail = ['[CG Suite] ── Pre-redirect filter enforcement log ──────────────────'];
    trail.push('[CG Suite]   source URL: ' + window.location.href);

    EBAY_REQUIRED_FILTERS.forEach(function (f) {
      if (target.searchParams.get(f.urlParam) === f.urlValue) {
        const msg = '[CG Suite]   filter ' + f.urlParam + ' → already in URL, skipped';
        log(msg); trail.push(msg);
        return;
      }
      const domHref = getFilterLinkHref(f);
      if (domHref) {
        const msg1 = '[CG Suite]   filter ' + f.urlParam + ' → DOM path: found eBay sidebar link = ' + domHref;
        log(msg1); trail.push(msg1);
        try {
          const added = [];
          new URL(domHref).searchParams.forEach(function (val, key) {
            if (!NAV_PARAMS.includes(key)) {
              target.searchParams.set(key, val);
              added.push(key + '=' + val);
            }
          });
          const msg2 = '[CG Suite]   filter ' + f.urlParam + ' → params merged from DOM link: ' + added.join(', ');
          log(msg2); trail.push(msg2);
          return;
        } catch (e) {
          const msg2 = '[CG Suite]   filter ' + f.urlParam + ' → DOM href parse error, falling back to hardcoded (' + e + ')';
          log(msg2); trail.push(msg2);
        }
      } else {
        const msg = '[CG Suite]   filter ' + f.urlParam + ' → FALLBACK path: sidebar link not found in DOM' +
          ' (selector: "' + f.linkSelector + '"), using hardcoded param ' + f.urlParam + '=' + f.urlValue;
        log(msg); trail.push(msg);
      }
      target.searchParams.set(f.urlParam, f.urlValue);
    });

    // —— Sort enforcement (default only; do not re-apply after first pass) ——
    if (!shouldEnforceSortDefault) {
      const msg = '[CG Suite]   sort default previously applied for this tab/session — skipping sort enforcement';
      log(msg); trail.push(msg);
    } else if (target.searchParams.get(EBAY_REQUIRED_SORT.urlParam) === EBAY_REQUIRED_SORT.urlValue) {
      const msg = '[CG Suite]   sort ' + EBAY_REQUIRED_SORT.urlParam + ' → already in URL, skipped';
      log(msg); trail.push(msg);
    } else {
      const sortResult = getEbaySortLink();
      if (sortResult) {
        const msg1 = '[CG Suite]   sort ' + EBAY_REQUIRED_SORT.urlParam +
          ' → DOM path (' + sortResult.strategy + '): href = ' + sortResult.link.href;
        log(msg1); trail.push(msg1);
        try {
          const sortLinkUrl = new URL(sortResult.link.href);
          const sortParam = sortLinkUrl.searchParams.get(EBAY_REQUIRED_SORT.urlParam);
          if (sortParam) {
            target.searchParams.set(EBAY_REQUIRED_SORT.urlParam, sortParam);
            const msg2 = '[CG Suite]   sort ' + EBAY_REQUIRED_SORT.urlParam +
              ' → param extracted from DOM link: ' + EBAY_REQUIRED_SORT.urlParam + '=' + sortParam;
            log(msg2); trail.push(msg2);
          } else {
            throw new Error('sort param not found in link href');
          }
        } catch (e) {
          const msg2 = '[CG Suite]   sort ' + EBAY_REQUIRED_SORT.urlParam +
            ' → DOM href parse error, falling back to hardcoded (' + e + ')';
          log(msg2); trail.push(msg2);
          target.searchParams.set(EBAY_REQUIRED_SORT.urlParam, EBAY_REQUIRED_SORT.urlValue);
        }
      } else {
        const msg = '[CG Suite]   sort ' + EBAY_REQUIRED_SORT.urlParam +
          ' → sort control absent from this page — skipping sort enforcement';
        log(msg); trail.push(msg);
      }
    }

    // —— Items per page: enforce 120 ——
    if (target.searchParams.get('_ipg') === '120') {
      const msg = '[CG Suite]   _ipg → already 120, skipped';
      log(msg); trail.push(msg);
    } else {
      const msg = '[CG Suite]   _ipg → setting to 120 (was: ' + (target.searchParams.get('_ipg') || 'not set') + ')';
      log(msg); trail.push(msg);
      target.searchParams.set('_ipg', '120');
    }

    const finalMsg = '[CG Suite] enforceEbayFilters: redirecting to → ' + target.toString();
    log(finalMsg); trail.push(finalMsg);
    trail.push('[CG Suite] ── end of pre-redirect log (replayed on reloaded page) ──────');

    try { sessionStorage.setItem('cgSuiteFilterTrail', JSON.stringify(trail)); } catch (e) {}
    if (shouldEnforceSortDefault) markAppliedEbaySortDefaultForSearch(currentSearchKey);

    window.location.replace(target.toString());
    return true;
  } catch (e) {
    log('[CG Suite] enforceEbayFilters: unexpected error', e);
    return false;
  }
}


// Replay the pre-redirect log trail on the page that loads after an enforced redirect.
(function replayFilterTrail() {
  try {
    const raw = sessionStorage.getItem('cgSuiteFilterTrail');
    if (!raw) return;
    sessionStorage.removeItem('cgSuiteFilterTrail');
    const lines = JSON.parse(raw);
    if (!Array.isArray(lines) || !lines.length) return;
    console.groupCollapsed('[CG Suite] 🔁 Filter enforcement log from previous page load (before redirect)');
    lines.forEach(function (line) { console.log(line); });
    console.groupEnd();
  } catch (e) {}
})();
