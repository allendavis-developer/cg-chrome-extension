/**
 * CG Suite Research – content script for eBay, Cash Converters, and CeX.
 *
 * Runs on ebay.co.uk, cashconverters.co.uk, cashgenerator.co.uk (Shopify Snize), and uk.webuy.com (CeX).
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
  CG_DOM_UTILS.ensureCgSuiteInter();

  /**
   * eBay SRP: "6 results for rode m1" in h1.srp-controls__count-heading — strict keyword matches.
   * Listings after that index are broader / fewer-keywords matches.
   */
  function searchTermFromUrlParams(paramNames) {
    try {
      const u = new URL(window.location.href);
      for (var pi = 0; pi < paramNames.length; pi++) {
        var raw = u.searchParams.get(paramNames[pi]);
        if (raw == null || String(raw).trim() === '') continue;
        try {
          return decodeURIComponent(String(raw).replace(/\+/g, ' ')).trim();
        } catch (e1) {
          return String(raw).replace(/\+/g, ' ').trim();
        }
      }
    } catch (e2) {
      /* ignore */
    }
    return '';
  }

  // —— Site configs: one place for URL detection, search term, and card scraping ——
  const SITE_CONFIGS = {
    ebay: {
      competitor: 'eBay',
      isListingsPage(url) {
        return url.includes('ebay.co.uk') && !!document.querySelector('#srp-river-results > ul');
      },
      getSearchTerm() {
        const fromInput = (document.querySelector('#gh-ac')?.value?.trim() || '');
        if (fromInput) return fromInput;
        return searchTermFromUrlParams(['_nkw', 'nkw', '_query', 'query', 'q']);
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
        const fromInput = (q?.value?.trim() || '');
        if (fromInput) return fromInput;
        return searchTermFromUrlParams(['query', 'q', 'search', 'keywords']);
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
    },
    cashgenerator: {
      competitor: 'CashGenerator',
      isListingsPage(url) {
        const u = (url || window.location.href || '').toLowerCase();
        return u.includes('cashgenerator.co.uk') && u.includes('/pages/search-results-page');
      },
      getSearchTerm() {
        const fromUrl = searchTermFromUrlParams(['q']);
        if (fromUrl) return fromUrl;
        const input = document.querySelector(
          'input[name="q"], input[type="search"][name="q"], .snize-search input[type="text"], input.snize-ac-input'
        );
        return (input && String(input.value || '').trim()) || '';
      },
      getListContainer() {
        return document.body;
      },
      scrapeCards(container) {
        const doc = container || document;
        const results = [];
        const cards = doc.querySelectorAll('li.snize-product');
        const origin = window.location.origin || '';
        cards.forEach(function (li) {
          const titleEl = li.querySelector('.snize-title');
          const priceEl = li.querySelector('span.snize-price.money') || li.querySelector('.snize-price');
          const linkEl = li.querySelector('a.snize-view-link');
          const imgEls = li.querySelectorAll('img.snize-item-image');
          const imgEl = imgEls.length ? imgEls[0] : null;
          const attrEl = li.querySelector('.snize-attribute');
          let shop = attrEl ? String(attrEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
          if (!shop) shop = null;
          if (!titleEl || !priceEl) return;
          const title = String(titleEl.textContent || '').replace(/\s+/g, ' ').trim();
          if (!title) return;
          const priceRaw = String(priceEl.textContent || '').trim();
          const price = priceRaw.replace(/[^0-9.]/g, '').trim() || '0';
          let itemUrl = window.location.href;
          if (linkEl) {
            const href = linkEl.getAttribute('href') || '';
            if (href) itemUrl = href.startsWith('http') ? href : origin + href;
          }
          let image = null;
          if (imgEl && imgEl.src) image = imgEl.src;
          const pid = li.getAttribute('data-original-product-id') || '';
          results.push({
            title: title.slice(0, 200),
            price: price,
            url: itemUrl,
            image: image,
            sold: null,
            shop: shop,
            itemId: pid || null,
          });
        });
        return results;
      }
    }
  };

  function getSiteConfig() {
    const host = window.location.hostname || '';
    if (host.includes('ebay')) return SITE_CONFIGS.ebay;
    if (host.includes('cashgenerator')) return SITE_CONFIGS.cashgenerator;
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

  var escapeHtml = CG_DOM_UTILS.escapeHtml;

  function buildContextHtml(ctx, compact) {
    if (!ctx) return '';

    const hasPrices = ctx.cexSalePrice != null || ctx.ourSalePrice != null || ctx.ebaySalePrice != null || ctx.cashConvertersSalePrice != null;
    const hasItemDetails = !!(ctx.itemTitle || ctx.itemCondition);
    const hasSearchTerms = !!(ctx.ebaySearchTerm || ctx.cashConvertersSearchTerm);
    const hasCexSpecs = ctx.cexSpecs && typeof ctx.cexSpecs === 'object' && Object.keys(ctx.cexSpecs).length > 0;
    const hasItemSpecs = ctx.itemSpecs && typeof ctx.itemSpecs === 'object' && Object.keys(ctx.itemSpecs).length > 0;

    if (!hasPrices && !hasItemDetails && !hasSearchTerms && !hasCexSpecs && !hasItemSpecs) return '';

    var baseFont = compact ? '12px' : '14px';
    var baseLine = compact ? '1.55' : '1.7';
    var titleFont = compact ? '13px' : '15px';
    var bodyFont = compact ? '12px' : '13px';
    var labelFont = compact ? '11px' : '12px';
    var valueFont = compact ? '12px' : '13px';
    var searchValueFont = compact ? '12px' : '14px';
    var priceFont = compact ? '12px' : '13px';

    var html =
      '<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.25);font-size:' + baseFont + ';line-height:' + baseLine + ';">';

    // ── Item identity (title + condition) ──
    if (hasItemDetails) {
      if (ctx.itemTitle) {
        html +=
          '<div style="font-size:' + titleFont + ';font-weight:700;margin-bottom:6px;line-height:1.35;word-break:break-word;">' +
          escapeHtml(ctx.itemTitle) +
          '</div>';
      }
      if (ctx.itemCondition) {
        html +=
          '<div style="font-size:' + bodyFont + ';opacity:0.9;margin-bottom:6px;">Condition: <strong>' +
          escapeHtml(ctx.itemCondition) +
          '</strong></div>';
      }
    }

    // ── Dropdown item attributes (label plain, value as badge) ────────────────
    if (hasItemSpecs) {
      var itemSpecEntries = Object.entries(ctx.itemSpecs).slice(0, 10);
      html +=
        '<div style="margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.12);border-radius:10px;">';
      html +=
        '<div style="font-size:' + labelFont + ';font-weight:700;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">Product Details</div>';
      html += '<div style="display:flex;flex-direction:column;gap:6px;">';
      itemSpecEntries.forEach(function (entry) {
        html += '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;">';
        html += '<span style="font-size:' + bodyFont + ';opacity:0.85;">' + escapeHtml(entry[0]) + '</span>';
        html +=
          '<span style="background:rgba(255,255,255,0.2);border-radius:6px;padding:4px 10px;font-size:' + valueFont + ';font-weight:700;word-break:break-word;text-align:right;max-width:100%;">' +
          escapeHtml(entry[1]) +
          '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── CeX product specs (label plain, value as badge) ───────────────────────
    if (hasCexSpecs) {
      var specEntries = Object.entries(ctx.cexSpecs).slice(0, 10);
      html +=
        '<div style="margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.12);border-radius:10px;">';
      html +=
        '<div style="font-size:' + labelFont + ';font-weight:700;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">Product Details</div>';
      html += '<div style="display:flex;flex-direction:column;gap:6px;">';
      specEntries.forEach(function (entry) {
        html += '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;">';
        html += '<span style="font-size:' + bodyFont + ';opacity:0.85;">' + escapeHtml(entry[0]) + '</span>';
        html +=
          '<span style="background:rgba(255,255,255,0.2);border-radius:6px;padding:4px 10px;font-size:' + valueFont + ';font-weight:700;word-break:break-word;text-align:right;max-width:100%;">' +
          escapeHtml(entry[1]) +
          '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Search terms ──────────────────────────────────────────────────────────
    if (hasSearchTerms) {
      html +=
        '<div style="margin-bottom:10px;padding:10px 12px;background:rgba(250,204,21,0.18);border:1px solid rgba(250,204,21,0.45);border-radius:8px;">';
      html +=
        '<div style="font-size:' + labelFont + ';font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#facc15;margin-bottom:6px;">Reference Search Terms</div>';
      if (ctx.ebaySearchTerm) {
        html += '<div style="margin-bottom:4px;"><span style="font-size:' + labelFont + ';opacity:0.75;">eBay: </span>';
        html +=
          '<span style="font-weight:700;font-size:' + searchValueFont + ';word-break:break-word;">' + escapeHtml(ctx.ebaySearchTerm) + '</span></div>';
      }
      if (ctx.cashConvertersSearchTerm) {
        html += '<div><span style="font-size:' + labelFont + ';opacity:0.75;">Cash Converters: </span>';
        html +=
          '<span style="font-weight:700;font-size:' + searchValueFont + ';word-break:break-word;">' +
          escapeHtml(ctx.cashConvertersSearchTerm) +
          '</span></div>';
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
      html += '<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:' + priceFont + ';opacity:0.95;">';
      priceRows.forEach(function (row) {
        html += '<div style="opacity:0.8;">' + escapeHtml(row[0]) + '</div>';
        html += '<div style="font-weight:700;">' + escapeHtml(row[1]) + '</div>';
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
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

    var siteConfig = getSiteConfig();
    var isEbay = siteConfig === SITE_CONFIGS.ebay;
    var isCex = siteConfig === SITE_CONFIGS.cex;
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
    const contextHtml = buildContextHtml(marketComparisonContext || null, isCex);
    const hasContext = !!contextHtml;

    const contextSectionHtml = hasContext
      ? `
        <div class="cg-ctx-wrap">
          <button type="button" class="cg-toggle" id="cg-suite-research-toggle-context">▶ Show details</button>
          <div class="cg-ctx" id="cg-suite-research-context" hidden>${contextHtml}</div>
        </div>
      `
      : '<div class="cg-ctx-spacer" aria-hidden="true"></div>';

    // Shadow root: same panel dimensions on eBay / Cash Converters / CeX; host CSS cannot resize it (CeX was the problem).
    const panel = document.createElement('div');
    panel.id = 'cg-suite-research-panel';
    const shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      ':host{display:block;margin:0;padding:0;border:0;background:transparent}' +
      '.cg-pos{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;' +
      'pointer-events:none;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;' +
      'font-size:14px;line-height:1.45;color:#fff;-webkit-font-smoothing:antialiased}' +
      '.cg-card{pointer-events:auto;width:240px;min-width:240px;max-width:240px;min-height:188px;box-sizing:border-box;' +
      'background:#1e3a8a;padding:18px 20px;border-radius:14px 0 0 14px;box-shadow:-8px 8px 28px rgba(0,0,0,0.42);' +
      'overflow-x:hidden;overflow-y:auto;max-height:min(85vh,520px)}' +
      '.cg-card--open{max-height:min(90vh,640px)}' +
      'h1.cg-h{margin:0 0 12px;font-size:17px;font-weight:800;line-height:1.25;letter-spacing:-0.02em}' +
      '.cg-actions{display:flex;flex-direction:column;gap:8px;margin-top:4px}' +
      'button.cg-yes{width:100%;padding:12px 16px;margin:0;background:#facc15;color:#020617;border:none;' +
      'border-radius:9999px;font:inherit;font-weight:900;font-size:15px;cursor:pointer;text-transform:uppercase;' +
      'letter-spacing:0.06em;box-shadow:0 8px 18px rgba(0,0,0,0.45)}' +
      'button.cg-cancel{width:100%;padding:10px 14px;margin:0;background:transparent;color:#e5e7eb;' +
      'border:1px solid rgba(248,250,252,0.5);border-radius:9999px;font:inherit;font-weight:600;font-size:13px;cursor:pointer}' +
      '.cg-ctx-wrap{margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.25)}' +
      '.cg-ctx-spacer{height:43px;margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.25);box-sizing:border-box}' +
      'button.cg-toggle{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;margin:0;' +
      'border-radius:9999px;border:1px solid rgba(248,250,252,0.5);background:rgba(15,23,42,0.4);' +
      'color:#e5e7eb;font:inherit;font-weight:600;font-size:12px;cursor:pointer;text-transform:uppercase;letter-spacing:0.08em}' +
      '.cg-ctx{margin-top:10px;font-size:14px;line-height:1.7}' +
      '.cg-ctx[hidden]{display:none!important}' +
      '.cg-card.cg-card--cex{width:188px;min-width:188px;max-width:188px}' +
      '.cg-card.cg-card--cex h1.cg-h{font-size:15px}' +
      '.cg-card.cg-card--cex button.cg-yes{font-size:13px}' +
      '.cg-card.cg-card--cex button.cg-cancel{font-size:12px}' +
      '.cg-card.cg-card--cex button.cg-toggle{font-size:11px}' +
      '.cg-card.cg-card--cex .cg-ctx{font-size:12px;line-height:1.55}' +
      '</style>' +
      '<div class="cg-pos">' +
      '<div class="cg-card' + (isCex ? ' cg-card--cex' : '') + '" id="cg-suite-research-card">' +
      '<h1 class="cg-h">' +
      escapeHtml(heading) +
      '</h1>' +
      contextSectionHtml +
      '<div class="cg-actions">' +
      '<button type="button" class="cg-yes" id="cg-suite-research-yes">' +
      escapeHtml(buttonLabel) +
      '</button>' +
      '<button type="button" class="cg-cancel" id="cg-suite-research-cancel">Cancel research</button>' +
      '</div></div></div>';

    document.body.appendChild(panel);
    const sr = panel.shadowRoot;

    // Expand/collapse extra context when present
    if (hasContext) {
      const toggleBtn = sr.getElementById('cg-suite-research-toggle-context');
      const contextEl = sr.getElementById('cg-suite-research-context');
      const cardEl = sr.getElementById('cg-suite-research-card');
      if (toggleBtn && contextEl) {
        let isOpen = false;
        const updateToggleLabel = () => {
          toggleBtn.textContent = isOpen ? '▼ Hide details' : '▶ Show details';
        };
        updateToggleLabel();
        toggleBtn.addEventListener('click', function () {
          isOpen = !isOpen;
          contextEl.hidden = !isOpen;
          if (cardEl) cardEl.classList.toggle('cg-card--open', isOpen);
          updateToggleLabel();
        });
      }
    }

    sr.getElementById('cg-suite-research-yes').addEventListener('click', function () {
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

    const cancelBtn = sr.getElementById('cg-suite-research-cancel');
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
