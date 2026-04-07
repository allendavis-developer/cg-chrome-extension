/**
 * CG Suite Research – content script for eBay, Cash Converters, and CeX.
 *
 * Runs on ebay.co.uk, cashconverters.co.uk, and uk.webuy.com (CeX).
 * Injects a side panel: "Have you got the data yet?" [Yes].
 * On Yes, scrapes the page using site-specific config and sends data to the app.
 *
 * FLOW FOR "ADD FROM CEX":
 * 1. User clicks "Add from CeX" in the app → app sends startWaitingForData(competitor: 'CeX') to extension.
 * 2. Background opens a new tab (uk.webuy.com/ or search). Saves pending request with that tab's ID.
 * 3. User navigates to a product-detail page (same tab or new tab). CeX is a SPA so URL may change without full reload.
 * 4. This content script must: (a) detect we're on a product-detail page, (b) send LISTING_PAGE_READY to background.
 * 5. Background matches the tab to the pending CeX request and sends WAITING_FOR_DATA back to this tab.
 * 6. We receive WAITING_FOR_DATA, set currentRequestId, and show the "Have you got the data yet?" panel.
 * 7. User clicks Yes → we scrape and send SCRAPED_DATA to background → app receives the data.
 *
 * WHY "HAVE YOU GOT THE DATA?" MIGHT NOT SHOW:
 * - CeX is a SPA: navigation to product-detail may not trigger a full page load, so we rely on setInterval + history listeners.
 * - LISTING_PAGE_READY must be sent; then background must send WAITING_FOR_DATA to this tab. If the tab ID doesn't match
 *   (e.g. user opened product in a different tab), background has a fallback to re-associate the pending request.
 * - If the content script sends LISTING_PAGE_READY before the background has stored the pending request, the message is ignored.
 */
(function () {
  let currentRequestId = null;

  /** Load Inter to match the CG Suite web app (panel UI only; monospace unchanged). */
  function ensureCgSuiteInter() {
    if (document.getElementById('cg-suite-font-inter')) return;
    var link = document.createElement('link');
    link.id = 'cg-suite-font-inter';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap';
    (document.head || document.documentElement).appendChild(link);
  }
  ensureCgSuiteInter();

  /**
   * eBay SRP: "6 results for rode m1" in h1.srp-controls__count-heading — strict keyword matches.
   * Listings after that index are broader / fewer-keywords matches.
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

  // —— Site configs: one place for URL detection, search term, and card scraping ——
  const SITE_CONFIGS = {
    ebay: {
      competitor: 'eBay',
      isListingsPage(url) {
        return url.includes('ebay.co.uk') && !!document.querySelector('#srp-river-results > ul');
      },
      getSearchTerm() {
        return (document.querySelector('#gh-ac')?.value?.trim() || '');
      },
      getListContainer() {
        return document.querySelector('#srp-river-results > ul');
      },
      scrapeCards(container) {
        if (!container) return [];
        const results = [];
        const cards = container.querySelectorAll(':scope > li');
        cards.forEach(function (li) {
          const titleEl = li.querySelector('.s-card__title .su-styled-text.primary.default') ||
            li.querySelector('.s-card__title .su-styled-text, .s-card__title span');
          const priceEl = li.querySelector('.s-card__price');
          const linkEl = li.querySelector('a.s-card__link[href*="/itm/"]');
          const imgEl = li.querySelector('img.s-card__image');
          if (!titleEl || !priceEl) return;
          const title = (titleEl.textContent || '').trim();
          if (!title) return;
          const priceRaw = (priceEl.textContent || '').trim();
          const price = priceRaw.replace(/[^0-9.]/g, '').trim() || '0';
          let sold = null;
          const captionEl = li.querySelector('.s-card__caption');
          if (captionEl) {
            const captionText = (captionEl.textContent || '').trim();
            if (captionText && /sold/i.test(captionText)) sold = captionText;
          }
          if (!sold) {
            const primaryAttrs = li.querySelector('.su-card-container__attributes__primary');
            if (primaryAttrs) {
              const rows = primaryAttrs.querySelectorAll('.s-card__attribute-row');
              for (let r = 0; r < rows.length; r++) {
                const t = (rows[r].textContent || '').trim();
                if (/^\d+\s*sold$/i.test(t) || t.toLowerCase().includes(' sold')) {
                  sold = t;
                  break;
                }
              }
            }
          }
          // Item ID: prefer data-listingid attribute on the card, fall back to /itm/ URL segment
          let itemId = li.getAttribute('data-listingid') || null;
          const itemUrl = linkEl ? linkEl.href : window.location.href;
          if (!itemId) {
            const itemIdMatch = itemUrl.match(/\/itm\/(?:[^/?]+\/)?(\d{9,})/);
            if (itemIdMatch) itemId = itemIdMatch[1];
          }

          // Seller info: visible when "Seller information" is enabled in eBay customise settings.
          // Secondary attributes block contains seller row (name + feedback) then item-number row.
          let sellerInfo = null;
          const secondaryAttrs = li.querySelector('.su-card-container__attributes__secondary');
          if (secondaryAttrs) {
            const firstRow = secondaryAttrs.querySelector('.s-card__attribute-row');
            if (firstRow) {
              const spans = firstRow.querySelectorAll('span');
              // Collect all non-empty span texts; join as "name 99% positive (6.1K)"
              const parts = Array.from(spans)
                .map(s => (s.textContent || '').trim())
                .filter(Boolean);
              if (parts.length) sellerInfo = parts.join(' ');
            }
          }

          results.push({
            title: title.slice(0, 200),
            price: price,
            url: itemUrl,
            image: imgEl ? imgEl.src : null,
            sold: sold,
            itemId: itemId,
            sellerInfo: sellerInfo || null,
          });
        });
        return results;
      }
    },
    cex: {
      competitor: 'CeX',
      isListingsPage(url) {
        const u = (url || window.location.href || '').toLowerCase();
        if (!u || !u.includes('webuy.com')) return false;
        // URL: product-detail with id param (e.g. .../product-detail?id=045496420055&categoryName=... or /product-detail/?id=...)
        if (/product-detail[\/?]/.test(u) && /[?&]id=/.test(u)) return true;
        // DOM fallback: user may have landed via SPA/navigation where URL format differs or updates late
        return !!(document.querySelector('.product-detail, [class*="product-detail"]') || document.querySelector('span.sell-price'));
      },
      getSearchTerm() {
        const titleEl = document.querySelector('.product-detail h1, h1.heading-s-semibold, h1');
        return (titleEl && (titleEl.textContent || '').trim()) || '';
      },
      getListContainer() {
        return document.body;
      },
      scrapeCards(container) {
        const doc = container || document;
        const results = [];

        const titleEl = doc.querySelector('.product-detail h1, h1.heading-s-semibold, h1');
        const title = (titleEl && (titleEl.textContent || '').trim()) || 'CeX Product';

        // Primary selector observed in live CeX product pages:
        // <span class="product-category grey-700-color mb-xs">Android Phones</span>
        const categoryEl = doc.querySelector('span.product-category.grey-700-color.mb-xs')
          || doc.querySelector('.product-category');
        let category = (categoryEl && (categoryEl.textContent || '').trim()) || '';
        if (!category) {
          const m = window.location.href.match(/categoryName=([^&]+)/);
          if (m) category = (m[1] || '').replace(/-/g, ' ');
        }

        // Prices from: <span class="sell-price">£135.00</span> and nuxtlink with two <span class="body-s-medium"> (voucher, cash)
        const sellPriceEl = doc.querySelector('span.sell-price');
        const sellPriceRaw = (sellPriceEl && (sellPriceEl.textContent || '').trim()) || '0';
        const sellPrice = parseFloat(sellPriceRaw.replace(/[^0-9.]/g, '')) || 0;

        let tradeInVoucher = 0;
        let tradeInCash = 0;
        const priceWrap = sellPriceEl && sellPriceEl.parentElement;
        if (priceWrap) {
          const priceSpans = priceWrap.querySelectorAll('span.body-s-medium');
          if (priceSpans.length >= 2) {
            tradeInVoucher = parseFloat((priceSpans[0].textContent || '').replace(/[^0-9.]/g, '')) || 0;
            tradeInCash = parseFloat((priceSpans[1].textContent || '').replace(/[^0-9.]/g, '')) || 0;
          }
        }
        if (tradeInVoucher === 0 && tradeInCash === 0) {
          const sellToCexText = doc.querySelector('.sell-to-cex-text');
          if (sellToCexText) {
            const m = (sellToCexText.textContent || '').match(/Get\s+£([\d.]+)\s+cash\s+or\s+a\s+£([\d.]+)\s+voucher/);
            if (m) {
              tradeInCash = parseFloat(m[1]) || 0;
              tradeInVoucher = parseFloat(m[2]) || 0;
            }
          }
        }

        // Product image: prefer .ximagezoom-image or product_images URL (exclude uk_badge)
        const imgEl = doc.querySelector('.ximagezoom-image') ||
          doc.querySelector('img[src*="product_images"]') ||
          (function () {
            const imgs = doc.querySelectorAll('img[src*="webuy"]');
            for (let i = 0; i < imgs.length; i++) {
              if (!imgs[i].src.includes('uk_badge')) return imgs[i];
            }
            return null;
          })();
        const image = (imgEl && imgEl.src) || null;
        const pageUrl = window.location.href;
        const sku = (pageUrl.match(/id=([^&]+)/) || [])[1] || null;

        // Specifications from ul.specifications-2-cols: <li><div><span class="font-semibold">Label:</span> <span class="text-sm">Value</span></div></li>
        const specs = {};
        let modelName = '';
        const specUl = doc.querySelector('ul.specifications-2-cols');
        if (specUl) {
          specUl.querySelectorAll('li').forEach(function (li) {
            const labelSpan = li.querySelector('span.font-semibold');
            const valueSpan = li.querySelector('span.text-sm');
            if (labelSpan && valueSpan) {
              const label = (labelSpan.textContent || '').replace(/:$/, '').trim();
              const value = (valueSpan.textContent || '').trim();
              if (label && value) {
                specs[label] = value;
                if (label === 'Model Name') modelName = value;
              }
            }
          });
        }

        // Out-of-stock detection: use targeted DOM queries rather than innerText
        // (innerText is unreliable on Vue/Nuxt SPAs where the DOM may not flush visible text).
        //
        // CeX marks out-of-stock items with:
        //   <div class="... feedback-error-500-color"><i class="xicon-close ..."></i><span>Out Of Stock</span></div>
        // There is also a "Get notified when this item is back in stock" block when OOS.
        let stockStatus = null;
        let isOutOfStock = false;
        try {
          // 1. Any .feedback-error-500-color element whose text contains "out of stock"
          var errorEls = doc.querySelectorAll('.feedback-error-500-color');
          for (var ei = 0; ei < errorEls.length; ei++) {
            var elText = (errorEls[ei].textContent || '').trim();
            if (/out of stock/i.test(elText)) {
              isOutOfStock = true;
              stockStatus = 'Out Of Stock';
              break;
            }
          }
          // 2. xicon-close icon whose parent mentions "out of stock"
          if (!isOutOfStock) {
            var closeIcons = doc.querySelectorAll('.xicon-close');
            for (var ci = 0; ci < closeIcons.length; ci++) {
              var parentText = ((closeIcons[ci].parentElement || {}).textContent || '').trim();
              if (/out of stock/i.test(parentText)) {
                isOutOfStock = true;
                stockStatus = 'Out Of Stock';
                break;
              }
            }
          }
          // 3. "notify me when back in stock" helper text
          if (!isOutOfStock) {
            var notifyEls = doc.querySelectorAll('[class*="notify"]');
            for (var ni = 0; ni < notifyEls.length; ni++) {
              if (/back in stock/i.test((notifyEls[ni].textContent || ''))) {
                isOutOfStock = true;
                stockStatus = 'Out Of Stock';
                break;
              }
            }
          }
          // 4. Broad textContent fallback (textContent works on hidden/invisible SPA nodes too)
          if (!isOutOfStock) {
            var fullText = (doc.body && doc.body.textContent) ? doc.body.textContent : '';
            if (/out of stock/i.test(fullText)) {
              isOutOfStock = true;
              stockStatus = 'Out Of Stock';
            }
          }
          if (typeof console !== 'undefined') {
            console.log('[CG Suite CeX] out-of-stock detection:', { isOutOfStock, stockStatus });
          }
        } catch (e) {
          // best-effort; ignore errors
        }

        const scraped = {
          title: title.slice(0, 200),
          price: sellPrice,
          url: pageUrl,
          image: image,
          id: sku,
          sellPrice: sellPrice,
          tradeInVoucher: tradeInVoucher,
          tradeInCash: tradeInCash,
          category: category,
          specifications: specs,
          modelName: modelName || title,
          stockStatus: stockStatus,
          isOutOfStock: isOutOfStock
        };
        if (typeof console !== 'undefined') {
          console.log('[CG Suite CeX] scrapeCards result:', JSON.stringify(scraped));
        }
        results.push(scraped);
        return results;
      }
    },
    cashconverters: {
      competitor: 'CashConverters',
      isListingsPage(url) {
        return url.includes('cashconverters.co.uk') && (/\/buy\//.test(url) || /\/search\//.test(url) || /\/c\//.test(url) || /search-results/.test(url) || /\/shop\//.test(url));
      },
      getSearchTerm() {
        const q = document.querySelector('input[name="query"], input[type="search"], [data-testid="search-input"]');
        return (q?.value?.trim() || '');
      },
      getListContainer() {
        return document.body;
      },
      scrapeCards(container) {
        const doc = container || document;
        const results = [];
        const cards = doc.querySelectorAll('.product-item-wrapper');
        const baseUrl = window.location.origin || (window.location.protocol + '//' + window.location.host);
        cards.forEach(function (el) {
          const titleEl = el.querySelector('.product-item__title__description');
          const shopEl = el.querySelector('.product-item__title__location');
          const priceEl = el.querySelector('.product-item__price');
          const linkEl = el.querySelector('a.product-item__title, .product-item__image a[href]');
          const imgEl = el.querySelector('.product-item__image img');
          if (!titleEl || !priceEl) return;
          const title = (titleEl.textContent || '').trim();
          if (!title) return;
          const shop = (shopEl && (shopEl.textContent || '').trim()) || null;
          const priceRaw = (priceEl.textContent || '').trim();
          const price = priceRaw.replace(/[^0-9.]/g, '').trim() || '0';
          let url = window.location.href;
          if (linkEl && linkEl.href) {
            try {
              url = linkEl.getAttribute('href').startsWith('/') ? (baseUrl + linkEl.getAttribute('href')) : linkEl.href;
            } catch (e) {}
          }
          let image = null;
          if (imgEl && imgEl.src) {
            try {
              image = imgEl.getAttribute('src') && imgEl.getAttribute('src').startsWith('/') ? (baseUrl + imgEl.getAttribute('src')) : imgEl.src;
            } catch (e) {}
          }
          results.push({
            title: title.slice(0, 200),
            price: price,
            url: url,
            image: image,
            sold: null,
            shop: shop
          });
        });
        return results;
      }
    }
  };

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
    if (getSiteConfig() !== SITE_CONFIGS.ebay) return false;
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

  function getSiteConfig() {
    const host = window.location.hostname || '';
    if (host.includes('ebay')) return SITE_CONFIGS.ebay;
    if (host.includes('cashconverters')) return SITE_CONFIGS.cashconverters;
    if (host.includes('webuy.com')) return SITE_CONFIGS.cex;
    return null;
  }

  // CeX: persist the requestId (from cgReq URL param) in sessionStorage so that
  // product-detail pages opened via SPA navigation or new tabs can still know
  // which pending request they belong to.
  function getCexRequestId() {
    try {
      if (!window.sessionStorage) return null;
      return window.sessionStorage.getItem('cgSuiteReqId') || null;
    } catch (e) {
      return null;
    }
  }

  function setCexRequestIdFromUrl() {
    try {
      const url = window.location.href || '';
      if (!/webuy\.com/i.test(url)) return;
      const m = url.match(/[?&]cgReq=([^&]+)/);
      if (m && m[1]) {
        if (window.sessionStorage) {
          window.sessionStorage.setItem('cgSuiteReqId', decodeURIComponent(m[1]));
        }
      }
    } catch (e) {
      // best-effort only
    }
  }

  // —— Message from background: we're the tab that was chosen for this pending request ——
  // Return false when ignoring so other content scripts (e.g. cex-scrape/content-cex-nav-scrape.js) can respond.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'WAITING_FOR_DATA') return false;
    if (typeof console !== 'undefined') {
      console.log('[CG Suite content-listings] WAITING_FOR_DATA received, requestId=', msg.requestId, 'url=', window.location.href);
    }
    currentRequestId = msg.requestId;
    showPanel(!!msg.isRefine, msg.marketComparisonContext || null);
    sendResponse({ ok: true });
    return false;
  });

  function isListingsPage() {
    const config = getSiteConfig();
    const url = window.location.href || '';
    return config ? config.isListingsPage(url) : false;
  }

  /**
   * Tell the background we're on a listing/product-detail page so it can send us WAITING_FOR_DATA
   * (which triggers the "Have you got the data yet?" panel).
   * Called on load and on CeX every 1.5s (SPA) and when URL changes (history listeners).
   */
  function maybeNotifyReady() {
    if (!isListingsPage()) return;
    const config = getSiteConfig();
    // For CeX, try to attach an explicit requestId (from cgReq/sessionStorage) so the background
    // can match this tab to the correct pending request even if there are multiple CeX flows.
    if (config === SITE_CONFIGS.cex) {
      setCexRequestIdFromUrl();
    }
    const requestId = config === SITE_CONFIGS.cex ? getCexRequestId() : null;
    if (typeof console !== 'undefined') {
      console.log('[CG Suite content-listings] maybeNotifyReady: sending LISTING_PAGE_READY, url=', window.location.href, 'requestId=', requestId);
    }
    const msg = { type: 'LISTING_PAGE_READY' };
    if (requestId) {
      msg.requestId = requestId;
    }
    chrome.runtime.sendMessage(msg).catch(function (err) {
      if (typeof console !== 'undefined') console.warn('[CG Suite content-listings] LISTING_PAGE_READY send failed', err);
    });
  }

  function removePanelIfNotListingsPage() {
    if (!document.getElementById('cg-suite-research-panel')) return;
    if (!isListingsPage()) {
      const panel = document.getElementById('cg-suite-research-panel');
      if (panel) panel.remove();
    }
  }

  function formatPrice(val) {
    if (val == null || val === '' || (typeof val === 'number' && isNaN(val))) return '—';
    const n = typeof val === 'string' ? parseFloat(val.replace(/[^0-9.]/g, '')) : Number(val);
    if (isNaN(n)) return '—';
    return '£' + n.toFixed(2);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildContextHtml(ctx) {
    if (!ctx) return '';

    const hasPrices = ctx.cexSalePrice != null || ctx.ourSalePrice != null || ctx.ebaySalePrice != null || ctx.cashConvertersSalePrice != null;
    const hasItemDetails = !!(ctx.itemTitle || ctx.itemCondition);
    const hasSearchTerms = !!(ctx.ebaySearchTerm || ctx.cashConvertersSearchTerm);
    const hasCexSpecs = ctx.cexSpecs && typeof ctx.cexSpecs === 'object' && Object.keys(ctx.cexSpecs).length > 0;
    const hasItemSpecs = ctx.itemSpecs && typeof ctx.itemSpecs === 'object' && Object.keys(ctx.itemSpecs).length > 0;

    if (!hasPrices && !hasItemDetails && !hasSearchTerms && !hasCexSpecs && !hasItemSpecs) return '';

    var html = '<div style="margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.25); font-size: 14px; line-height: 1.7;">';

    // ── Item identity (title + condition) ──
    if (hasItemDetails) {
      if (ctx.itemTitle) {
        html += '<div style="font-size: 18px; font-weight: 700; margin-bottom: 6px;">' + escapeHtml(ctx.itemTitle) + '</div>';
      }
      if (ctx.itemCondition) {
        html += '<div style="font-size:13px; opacity:0.9; margin-bottom:6px;">Condition: <strong>' + escapeHtml(ctx.itemCondition) + '</strong></div>';
      }
    }

    // ── Dropdown item attributes (label plain, value as badge) ────────────────
    if (hasItemSpecs) {
      var itemSpecEntries = Object.entries(ctx.itemSpecs).slice(0, 10);
      html += '<div style="margin-bottom:10px; padding:10px; background:rgba(255,255,255,0.12); border-radius:10px;">';
      html += '<div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; opacity:0.8; margin-bottom:8px;">Product Details</div>';
      html += '<div style="display:flex; flex-direction:column; gap:6px;">';
      itemSpecEntries.forEach(function (entry) {
        html += '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">';
        html += '<span style="font-size:14px; opacity:0.85; white-space:nowrap;">' + escapeHtml(entry[0]) + '</span>';
        html += '<span style="background:rgba(255,255,255,0.2); border-radius:6px; padding:4px 10px; font-size:14px; font-weight:700; white-space:normal;">' + escapeHtml(entry[1]) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── CeX product specs (label plain, value as badge) ───────────────────────
    if (hasCexSpecs) {
      var specEntries = Object.entries(ctx.cexSpecs).slice(0, 10);
      html += '<div style="margin-bottom:10px; padding:10px; background:rgba(255,255,255,0.12); border-radius:10px;">';
      html += '<div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; opacity:0.8; margin-bottom:8px;">Product Details</div>';
      html += '<div style="display:flex; flex-direction:column; gap:6px;">';
      specEntries.forEach(function (entry) {
        html += '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">';
        html += '<span style="font-size:14px; opacity:0.85; white-space:nowrap;">' + escapeHtml(entry[0]) + '</span>';
        html += '<span style="background:rgba(255,255,255,0.2); border-radius:6px; padding:4px 10px; font-size:14px; font-weight:700; white-space:normal;">' + escapeHtml(entry[1]) + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Search terms ──────────────────────────────────────────────────────────
    if (hasSearchTerms) {
      html += '<div style="margin-bottom:10px; padding:10px 12px; background:rgba(250,204,21,0.18); border:1px solid rgba(250,204,21,0.45); border-radius:8px;">';
      html += '<div style="font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#facc15; margin-bottom:6px;">Reference Search Terms</div>';
      if (ctx.ebaySearchTerm) {
        html += '<div style="margin-bottom:4px;"><span style="font-size:12px; opacity:0.75;">eBay: </span>';
        html += '<span style="font-weight:700; font-size:14px;">' + escapeHtml(ctx.ebaySearchTerm) + '</span></div>';
      }
      if (ctx.cashConvertersSearchTerm) {
        html += '<div><span style="font-size:12px; opacity:0.75;">Cash Converters: </span>';
        html += '<span style="font-weight:700; font-size:14px;">' + escapeHtml(ctx.cashConvertersSearchTerm) + '</span></div>';
      }
      html += '</div>';
    }

    // ── Price comparisons ─────────────────────────────────────────────────────
    var priceRows = [];
    if (ctx.cexSalePrice != null) priceRows.push(['CeX sell', formatPrice(ctx.cexSalePrice)]);
    if (ctx.ourSalePrice != null) priceRows.push(['Our price', formatPrice(ctx.ourSalePrice)]);
    if (ctx.ebaySalePrice != null) priceRows.push(['eBay median', formatPrice(ctx.ebaySalePrice)]);
    if (ctx.cashConvertersSalePrice != null) priceRows.push(['Cash Conv.', formatPrice(ctx.cashConvertersSalePrice)]);

    if (priceRows.length > 0) {
      html += '<div style="display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font-size:13px; opacity:0.95;">';
      priceRows.forEach(function (row) {
        html += '<div style="opacity:0.8;">' + escapeHtml(row[0]) + '</div>';
        html += '<div style="font-weight:700;">' + escapeHtml(row[1]) + '</div>';
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

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

    if (getSiteConfig() !== SITE_CONFIGS.ebay) return false;

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
    overlay.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 2147483646',
      'background: rgba(15, 23, 42, 0.75)',
      'backdrop-filter: blur(8px)',
      '-webkit-backdrop-filter: blur(8px)',
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

  async function showPanel(isRefine, marketComparisonContext) {
    if (document.getElementById('cg-suite-research-panel')) {
      if (typeof console !== 'undefined') console.log('[CG Suite content-listings] showPanel: panel already exists, skip');
      return;
    }
    if (!isListingsPage()) {
      if (typeof console !== 'undefined') console.log('[CG Suite content-listings] showPanel: not a listing page, url=', window.location.href);
      return;
    }

    var isEbay = getSiteConfig() === SITE_CONFIGS.ebay;
    if (isEbay) showEbayLoadingOverlay();

    // For eBay: auto-navigate to add the required filters. The tab keeps its ID so the
    // background will re-send WAITING_FOR_DATA once the page reloads with correct filters.
    if (isEbay && enforceEbayFilters()) {
      if (typeof console !== 'undefined') console.log('[CG Suite content-listings] showPanel: redirecting to enforce eBay filters');
      return;
    }

    // For eBay: if seller info is missing from cards, auto-submit the Customise form to
    // enable it (and item number). Page reloads with preferences saved as cookies.
    if (await enforceEbayCustomizeSettings()) {
      if (typeof console !== 'undefined') console.log('[CG Suite content-listings] showPanel: reloading to apply eBay customize settings');
      return;
    }

    if (isEbay) removeEbayLoadingOverlay();

    if (typeof console !== 'undefined') {
      console.log('[CG Suite content-listings] showPanel: injecting "Have you got the data yet?" panel');
    }

    const heading = isRefine ? 'Are you done?' : 'Have you got the data yet?';
    const buttonLabel = isRefine ? 'Yes, bring me back' : 'Yes';
    const contextHtml = buildContextHtml(marketComparisonContext || null);
    const hasContext = !!contextHtml;

    const contextSectionHtml = hasContext
      ? `
        <div id="cg-suite-research-context-wrapper" style="margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.25);">
          <button id="cg-suite-research-toggle-context" style="
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            border-radius: 9999px;
            border: 1px solid rgba(248,250,252,0.5);
            background: rgba(15,23,42,0.4);
            color: #e5e7eb;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            text-transform: uppercase;
            letter-spacing: 0.08em;
          ">
            ▶ Show details
          </button>
          <div id="cg-suite-research-context" style="margin-top: 10px; display: none; font-size: 14px; line-height: 1.7;">
            ${contextHtml}
          </div>
        </div>
      `
      : '';

    const panel = document.createElement('div');
    panel.id = 'cg-suite-research-panel';
    panel.innerHTML = `
      <div style="
        position: fixed; top: 50%; right: 0; transform: translateY(-50%);
        z-index: 2147483647; background: #1e3a8a; color: white;
        padding: 28px 32px; border-radius: 18px 0 0 18px; box-shadow: -8px 8px 32px rgba(0,0,0,0.45);
        font-family: Inter, sans-serif; min-width: 380px; max-width: 460px;
      ">
        <p style="margin: 0 0 16px 0; font-weight: 800; font-size: 20px;">${heading}</p>
        ${contextSectionHtml}
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px;">
          <button id="cg-suite-research-yes" style="
            width: 100%; padding: 16px 24px; background: #facc15; color: #020617;
            border: none; border-radius: 9999px; font-weight: 900; cursor: pointer; font-size: 18px;
            box-shadow: 0 12px 28px rgba(0,0,0,0.5); text-transform: uppercase; letter-spacing: 0.08em;
          ">${buttonLabel}</button>
          <button id="cg-suite-research-cancel" style="
            width: 100%; padding: 12px 20px; background: transparent; color: #e5e7eb;
            border: 1px solid rgba(248,250,252,0.5); border-radius: 9999px;
            font-weight: 600; cursor: pointer; font-size: 15px;
          ">Cancel research</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Expand/collapse extra context when present
    if (hasContext) {
      const toggleBtn = document.getElementById('cg-suite-research-toggle-context');
      const contextEl = document.getElementById('cg-suite-research-context');
      if (toggleBtn && contextEl) {
        let isOpen = false;
        const updateToggleLabel = () => {
          toggleBtn.textContent = (isOpen ? '▼ Hide details' : '▶ Show details');
        };
        updateToggleLabel();
        toggleBtn.addEventListener('click', function () {
          isOpen = !isOpen;
          contextEl.style.display = isOpen ? 'block' : 'none';
          updateToggleLabel();
        });
      }
    }

    document.getElementById('cg-suite-research-yes').addEventListener('click', function () {
      if (!isListingsPage()) {
        panel.remove();
        return;
      }
      // Last resort: if somehow the user is on eBay without the required filters, redirect now.
      if (getSiteConfig() === SITE_CONFIGS.ebay && !hasRequiredEbayFilters(window.location.href)) {
        enforceEbayFilters();
        panel.remove();
        return;
      }
      const data = scrapeListings();
      if (currentRequestId) {
        chrome.runtime.sendMessage({
          type: 'SCRAPED_DATA',
          requestId: currentRequestId,
          data: data
        });
        currentRequestId = null;
      }
      panel.remove();
    });

    const cancelBtn = document.getElementById('cg-suite-research-cancel');
    cancelBtn && cancelBtn.addEventListener('click', function () {
      if (currentRequestId) {
        chrome.runtime.sendMessage({
          type: 'SCRAPED_DATA',
          requestId: currentRequestId,
          data: { success: false, cancelled: true, error: 'User cancelled research' }
        });
        currentRequestId = null;
      }
      panel.remove();
    });
  }

  function scrapeListings() {
    const config = getSiteConfig();
    const competitor = config ? config.competitor : 'eBay';
    const searchTerm = config ? config.getSearchTerm() : '';
    const container = config ? config.getListContainer() : null;
    let results = config ? config.scrapeCards(container) : [];
    const out = {
      success: true,
      results: results,
      competitor: competitor,
      searchTerm: searchTerm,
      listingPageUrl: window.location.href
    };
    if (config === SITE_CONFIGS.ebay) {
      var strictN = getEbayKeywordMatchCountFromHeading();
      out.ebayKeywordMatchCount = strictN;
      results = results.map(function (row, idx) {
        var rel = strictN == null ? 'yes' : idx < strictN ? 'yes' : 'no';
        var copy = {};
        for (var k in row) {
          if (Object.prototype.hasOwnProperty.call(row, k)) copy[k] = row[k];
        }
        copy.isRelevant = rel;
        return copy;
      });
      out.results = results;
    }
    if (typeof console !== 'undefined') {
      console.log('[CG Suite] scrapeListings returning:', JSON.stringify(out, null, 2));
    }
    return out;
  }

  // —— Initial run: notify background if we're already on a listing page (e.g. full page load to product-detail) ——
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof console !== 'undefined') console.log('[CG Suite content-listings] DOMContentLoaded, maybeNotifyReady');
      setCexRequestIdFromUrl();
      maybeNotifyReady();
    });
  } else {
    setCexRequestIdFromUrl();
    maybeNotifyReady();
  }

  // —— CeX SPA: URL can change without full reload. Listen for history changes so we notify as soon as we're on product-detail. ——
  var lastNotifiedUrl = '';
  function onUrlMaybeChanged() {
    var url = window.location.href || '';
    if (url === lastNotifiedUrl) return;
    if (getSiteConfig() !== SITE_CONFIGS.cex) return;
    setCexRequestIdFromUrl();
    if (isListingsPage()) {
      lastNotifiedUrl = url;
      if (typeof console !== 'undefined') console.log('[CG Suite content-listings] CeX URL changed to listing page, notifying', url);
      maybeNotifyReady();
    }
  }
  window.addEventListener('popstate', onUrlMaybeChanged);
  // CeX (Nuxt/Vue) often uses history.pushState/replaceState for in-page navigation
  var origPush = history.pushState;
  var origReplace = history.replaceState;
  if (typeof origPush === 'function') {
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(onUrlMaybeChanged, 0);
    };
  }
  if (typeof origReplace === 'function') {
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(onUrlMaybeChanged, 0);
    };
  }

  // Poll: on CeX, keep notifying when we're on a listing page (in case history listeners missed it). Remove panel when user navigates away.
  setInterval(function () {
    if (getSiteConfig() === SITE_CONFIGS.cex) {
      if (isListingsPage()) lastNotifiedUrl = window.location.href || '';
      maybeNotifyReady();
    }
    removePanelIfNotListingsPage();
  }, 1500);
})();
