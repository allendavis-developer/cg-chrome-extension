/**
 * CG Suite Research – content script for nospos.com (repricing flow).
 *
 * Runs on nospos.com and *.nospos.com.
 *
 * Flow:
 * 1. Extension opens nospos.com. If on login page → wait (user will redirect).
 * 2. If on main nospos.com site → send NOSPOS_PAGE_READY. Background navigates to /stock/search.
 * 3. On /stock/search → fill search, submit. User clicks a result → /stock/:id/edit.
 * 4. On /stock/:id/edit → fill retail_price, click Save. Wait for page load.
 * 5. Navigate to /stock/search, fill next barcode, repeat until all items/barcodes done.
 * 6. When done, background focuses app tab.
 */
(function () {
  CG_DOM_UTILS.ensureCgSuiteInter();

  const LOGIN_PATH_PATTERN = /^\/(login|signin|sign-in|auth|log-in|session|sessions|account\/login)(\/|$)/i;
  const LOGIN_SUBDOMAINS = ['login', 'auth', 'signin', 'sso', 'accounts'];
  const STOCK_SEARCH_PAGE = '/stock/search';
  const STOCK_SEARCH_PAGE_PATTERN = /^\/stock\/search(?:\/index)?\/?$/i;
  const STOCK_EDIT_PAGE_PATTERN = /^\/stock\/\d+\/edit\/?$/i;
  const CUSTOMER_SEARCH_PAGE_PATTERN = /^\/customers\/?($|\?)/i;
  const CUSTOMER_CREATE_PAGE_PATTERN = /^\/customers\/create\/?($|\?)/i;
  const CUSTOMER_DETAIL_PAGE_PATTERN = /^\/customer\/\d+\/(?:view|buying)\/?/i;
  const STOCK_CATEGORY_INDEX_PATTERN = /^\/stock\/category\/index\/?$/i;
  const STOCK_CATEGORY_MODIFY_PATTERN = /^\/stock\/category\/modify\/?$/i;
  const FORCED_LOGIN_PATHS = new Set(['/site/standard-login', '/twofactor/authenticate']);

  function isOnLoginPage() {
    try {
      const host = (window.location.hostname || '').toLowerCase().replace(/^www\./, '');
      if (host.startsWith('nospos.com')) {
        const subdomain = window.location.hostname.toLowerCase().replace('.nospos.com', '').replace('www.', '');
        if (LOGIN_SUBDOMAINS.includes(subdomain)) return true;
      }
      const path = (window.location.pathname || '/').toLowerCase();
      return LOGIN_PATH_PATTERN.test(path);
    } catch (e) {
      return false;
    }
  }

  function isOnNosposDomain() {
    try {
      const host = (window.location.hostname || '').toLowerCase();
      return host === 'nospos.com' || host.endsWith('.nospos.com');
    } catch (e) {
      return false;
    }
  }

  function isForcedLoginRedirectPage() {
    try {
      if (!isOnNosposDomain()) return false;
      const path = (window.location.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
      return FORCED_LOGIN_PATHS.has(path);
    } catch (e) {
      return false;
    }
  }

  function isOnStockSearchPage() {
    try {
      const path = (window.location.pathname || '').toLowerCase();
      return STOCK_SEARCH_PAGE_PATTERN.test(path);
    } catch (e) {
      return false;
    }
  }

  function isOnStockEditPage() {
    try {
      const path = (window.location.pathname || '/').toLowerCase();
      return STOCK_EDIT_PAGE_PATTERN.test(path);
    } catch (e) {
      return false;
    }
  }

  function isOnCustomerSearchPage() {
    try {
      return CUSTOMER_SEARCH_PAGE_PATTERN.test(window.location.pathname || '/');
    } catch (e) {
      return false;
    }
  }

  function isOnCustomerCreatePage() {
    try {
      return CUSTOMER_CREATE_PAGE_PATTERN.test(window.location.pathname || '/');
    } catch (e) {
      return false;
    }
  }

  function isOnCustomerDetailPage() {
    try {
      return CUSTOMER_DETAIL_PAGE_PATTERN.test(window.location.pathname || '/');
    } catch (e) {
      return false;
    }
  }

  function isOnStockCategoryIndexPage() {
    try {
      return STOCK_CATEGORY_INDEX_PATTERN.test(window.location.pathname || '/');
    } catch (e) {
      return false;
    }
  }

  function isOnStockCategoryModifyPage() {
    try {
      return STOCK_CATEGORY_MODIFY_PATTERN.test(window.location.pathname || '/');
    } catch (e) {
      return false;
    }
  }

  /**
   * Parse grid rows from /stock/category/index (see Data page scrape → Django nosposcategory).
   */
  function scrapeStockCategoryIndexTable() {
    var table =
      document.querySelector('#w2 table.table-hover') ||
      document.querySelector('.table-responsive table.table-hover') ||
      document.querySelector('table.table.table-hover');
    if (!table) return [];
    var tbody = table.querySelector('tbody');
    if (!tbody) return [];
    var out = [];
    tbody.querySelectorAll('tr[data-key]').forEach(function (tr) {
      var key = tr.getAttribute('data-key');
      var nosposId = parseInt(key, 10);
      if (!nosposId) return;
      var tds = tr.querySelectorAll('td');
      if (tds.length < 5) return;
      var idText = (tds[1].textContent || '').trim();
      var levelText = (tds[2].textContent || '').trim();
      var fullName = (tds[3].textContent || '').replace(/\s+/g, ' ').trim();
      var statusEl = tds[4].querySelector('.label');
      var status = statusEl ? (statusEl.textContent || '').trim() : (tds[4].textContent || '').trim();
      var viewLink = tds[5] && tds[5].querySelector('a[href]');
      var viewHref = viewLink ? String(viewLink.getAttribute('href') || '').trim() : '';
      var level = parseInt(levelText, 10);
      if (isNaN(level)) level = 0;
      out.push({
        nosposId: nosposId,
        idDisplay: idText,
        level: level,
        fullName: fullName,
        status: status,
        viewHref: viewHref,
      });
    });
    return out;
  }

  /**
   * Field rows from /stock/category/modify — `.card-content.fields` rows:
   * CategoryFieldForm[id][checked|editable|sensitive|required] checkboxes + label in first column.
   */
  function scrapeStockCategoryModifyFields() {
    var container = document.querySelector('.card-content.fields');
    if (!container) return [];
    var seen = Object.create(null);
    var out = [];
    var children = container.children;
    for (var i = 0; i < children.length; i++) {
      var row = children[i];
      if (!row.classList || !row.classList.contains('row')) continue;
      var inputs = row.querySelectorAll('input[type="checkbox"][name^="CategoryFieldForm["]');
      if (!inputs.length) continue;
      var fid = null;
      var active = false;
      var editable = false;
      var sensitive = false;
      var required = false;
      for (var k = 0; k < inputs.length; k++) {
        var nm = inputs[k].name || '';
        var m = /CategoryFieldForm\[(\d+)\]\[(checked|editable|sensitive|required)\]/.exec(nm);
        if (!m) continue;
        var idPart = parseInt(m[1], 10);
        if (!idPart) continue;
        if (fid == null) fid = idPart;
        if (fid !== idPart) continue;
        var key = m[2];
        var on = !!inputs[k].checked;
        if (key === 'checked') active = on;
        else if (key === 'editable') editable = on;
        else if (key === 'sensitive') sensitive = on;
        else if (key === 'required') required = on;
      }
      if (!fid || seen[fid]) continue;
      var firstCol = row.querySelector('.col');
      if (!firstCol) continue;
      var group = firstCol.querySelector('[class*="field-categoryfieldform-"][class*="-checked"]');
      if (!group) continue;
      var labelEl = group.querySelector('label');
      if (!labelEl) continue;
      var clone = labelEl.cloneNode(true);
      var junk = clone.querySelectorAll('input, .checkbox-material');
      for (var j = 0; j < junk.length; j++) {
        junk[j].remove();
      }
      var labelText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (!labelText) continue;
      if (/^(Editable|Sensitive|Required)$/i.test(labelText)) continue;
      seen[fid] = true;
      out.push({
        nosposFieldId: fid,
        name: labelText,
        active: active,
        editable: editable,
        sensitive: sensitive,
        required: required,
      });
    }
    return out;
  }

  /**
   * Buyback rate (%) on /stock/category/modify: input[name="rate"][data-prefix="buyback"], else
   * "Buyback Rates" card line `Default: 35%`.
   */
  function scrapeStockCategoryModifyBuybackRate() {
    var input = document.querySelector('input[name="rate"][data-prefix="buyback"]');
    if (input) {
      var v = String(input.value || '').trim();
      if (v !== '') {
        var n = parseFloat(v);
        if (isFinite(n)) return n;
      }
    }
    var headers = document.querySelectorAll('.card-header.card-header-tabs h4.card-title');
    for (var h = 0; h < headers.length; h++) {
      var title = (headers[h].textContent || '').replace(/\s+/g, ' ').trim();
      if (!/buyback\s+rates/i.test(title)) continue;
      var card = headers[h].closest('.card');
      if (!card) continue;
      var p = card.querySelector('p.category');
      if (p) {
        var t = (p.textContent || '').replace(/\s+/g, ' ').trim();
        var m = /Default:\s*([\d.]+)\s*%/i.exec(t);
        if (m) {
          var n2 = parseFloat(m[1]);
          if (isFinite(n2)) return n2;
        }
      }
    }
    var ps = document.querySelectorAll('p.category');
    for (var i = 0; i < ps.length; i++) {
      var t2 = (ps[i].textContent || '').replace(/\s+/g, ' ').trim();
      var m2 = /Default:\s*([\d.]+)\s*%/i.exec(t2);
      if (m2) {
        var n3 = parseFloat(m2[1]);
        if (isFinite(n3)) return n3;
      }
    }
    return null;
  }

  /**
   * Offer rate (%) on /stock/category/modify: input[name="rate"][data-prefix="offer"], else
   * "Offer Rates" card `Default: 50%`. If still empty, 50 (NosPos default).
   */
  function scrapeStockCategoryModifyOfferRate() {
    var input = document.querySelector('input[name="rate"][data-prefix="offer"]');
    if (input) {
      var v = String(input.value || '').trim();
      if (v !== '') {
        var n = parseFloat(v);
        if (isFinite(n)) return n;
      }
    }
    var headers = document.querySelectorAll('.card-header.card-header-tabs h4.card-title');
    for (var h = 0; h < headers.length; h++) {
      var title = (headers[h].textContent || '').replace(/\s+/g, ' ').trim();
      if (!/offer\s+rates/i.test(title)) continue;
      var card = headers[h].closest('.card');
      if (!card) continue;
      var p = card.querySelector('p.category');
      if (p) {
        var t = (p.textContent || '').replace(/\s+/g, ' ').trim();
        var m = /Default:\s*([\d.]+)\s*%/i.exec(t);
        if (m) {
          var n2 = parseFloat(m[1]);
          if (isFinite(n2)) return n2;
        }
      }
    }
    return 50;
  }

  /** Numeric id from /customer/{id}/view or /customer/{id}/buying */
  function extractNosposCustomerIdFromPath() {
    try {
      var path = window.location.pathname || '';
      var m = /^\/customer\/(\d+)\/(?:view|buying)\/?$/i.exec(path);
      if (!m) return null;
      var n = parseInt(m[1], 10);
      return n > 0 ? n : null;
    } catch (e) {
      return null;
    }
  }

  function sendPageReady() {
    if (!isOnNosposDomain()) return;
    if (isOnLoginPage()) return;
    if (isOnCustomerSearchPage()) return;  // has its own flow
    if (isOnCustomerCreatePage()) return;  // has its own flow
    if (isOnCustomerDetailPage()) return;  // has its own flow

    chrome.runtime.sendMessage({ type: 'NOSPOS_PAGE_READY' }).catch(function () {});
  }

  function sendLoginRequired() {
    if (!isForcedLoginRedirectPage()) return;
    chrome.runtime.sendMessage({
      type: 'NOSPOS_LOGIN_REQUIRED',
      url: window.location.href
    }).catch(function () {});
  }

  // ── Save failed notification panel (shown when NoSpos save fails) ───────────

  function showSaveFailedPanel(errorMsg) {
    if (document.getElementById('cg-suite-save-failed-panel')) return;
    var errText = (errorMsg || '').trim();
    var panel = document.createElement('div');
    panel.id = 'cg-suite-save-failed-panel';
    panel.innerHTML =
      '<div style="position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;' +
        'background:#dc2626;color:white;padding:20px 24px;border-radius:12px 0 0 12px;' +
        'box-shadow:-6px 6px 24px rgba(0,0,0,0.35);font-family:Inter,sans-serif;' +
        'min-width:280px;max-width:360px;">' +
        '<p style="margin:0 0 6px 0;font-weight:800;font-size:14px;">Save failed</p>' +
        (errText ? '<p style="margin:0 0 8px 0;font-size:13px;font-weight:600;opacity:0.95;">' + (errText.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' : '') +
        '<p style="margin:0 0 14px 0;font-size:13px;opacity:0.95;line-height:1.45;">' +
          'Your data was sent to the app. Fix the save here on NoSpos, then switch back to the app when you\'re ready.' +
        '</p>' +
        '<button id="cg-suite-save-failed-dismiss" style="width:100%;padding:10px 16px;background:rgba(255,255,255,0.2);' +
          'color:white;border:1px solid rgba(255,255,255,0.5);border-radius:8px;font-weight:600;cursor:pointer;font-size:13px;">Got it</button>' +
      '</div>';
    document.body.appendChild(panel);
    document.getElementById('cg-suite-save-failed-dismiss').addEventListener('click', function () {
      panel.remove();
    });
  }

  function extractNosposErrorText() {
    var el = document.querySelector('.error-summary.alert.alert-danger, .error-summary, .alert.alert-danger');
    if (!el) return '';
    var items = el.querySelectorAll('ul li');
    if (items.length) {
      return Array.from(items).map(function (li) { return (li.textContent || '').trim(); }).filter(Boolean).join('. ');
    }
    return (el.textContent || '').trim();
  }

  // ── Customer Search Panel (shown on /customers) ────────────────────────────

  function showCustomerSearchPanel(requestId) {
    if (document.getElementById('cg-suite-customer-panel')) return;

    var panel = document.createElement('div');
    panel.id = 'cg-suite-customer-panel';
    panel.innerHTML =
      '<div style="position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;' +
        'background:#1e3a8a;color:white;padding:18px 20px;border-radius:14px 0 0 14px;' +
        'box-shadow:-8px 8px 28px rgba(0,0,0,0.42);font-family:Inter,sans-serif;' +
        'width:240px;min-width:210px;max-width:380px;resize:horizontal;overflow:auto;box-sizing:border-box;">' +
        '<p style="margin:0 0 6px 0;font-weight:800;font-size:17px;">Customer Lookup</p>' +
        '<p style="margin:0 0 14px 0;font-size:13px;opacity:0.85;line-height:1.4;">' +
          'Search for the customer below. When you open their profile, we\'ll take it from there.' +
        '</p>' +
        '<button id="cg-suite-customer-cancel" style="width:100%;padding:10px 14px;background:transparent;' +
          'color:#e5e7eb;border:1px solid rgba(248,250,252,0.5);border-radius:9999px;' +
          'font-weight:600;cursor:pointer;font-size:13px;">Cancel</button>' +
      '</div>';
    document.body.appendChild(panel);

    var cancelBtn = document.getElementById('cg-suite-customer-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_DONE', requestId: requestId, cancelled: true }).catch(function () {});
        panel.remove();
      });
    }
  }

  function onCustomerSearchPageLoad() {
    chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_SEARCH_READY' }, function (response) {
      if (response && response.ok && response.requestId) {
        showCustomerSearchPanel(response.requestId);
      }
    });
  }

  // ── Customer Create Panel (shown on /customers/create) ─────────────────────

  function showCustomerCreatePanel(requestId) {
    if (document.getElementById('cg-suite-customer-create-panel')) return;

    var panel = document.createElement('div');
    panel.id = 'cg-suite-customer-create-panel';
    panel.innerHTML =
      '<div style="position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;' +
        'background:#1e3a8a;color:white;padding:18px 20px;border-radius:14px 0 0 14px;' +
        'box-shadow:-8px 8px 28px rgba(0,0,0,0.42);font-family:Inter,sans-serif;' +
        'width:260px;min-width:230px;max-width:380px;resize:horizontal;overflow:auto;box-sizing:border-box;">' +
        '<p style="margin:0 0 6px 0;font-weight:800;font-size:17px;">Create new customer</p>' +
        '<p style="margin:0 0 14px 0;font-size:13px;opacity:0.85;line-height:1.4;">' +
          'Please type in at minimum their name. You can fill in the rest later. When you press Create, NoSpos will save the customer and we\'ll bring you to their profile.' +
        '</p>' +
        '<button id="cg-suite-customer-create-cancel" style="width:100%;padding:10px 14px;background:transparent;' +
          'color:#e5e7eb;border:1px solid rgba(248,250,252,0.5);border-radius:9999px;' +
          'font-weight:600;cursor:pointer;font-size:13px;">Cancel</button>' +
      '</div>';
    document.body.appendChild(panel);

    var cancelBtn = document.getElementById('cg-suite-customer-create-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_DONE', requestId: requestId, cancelled: true }).catch(function () {});
        panel.remove();
      });
    }
  }

  function onCustomerCreatePageLoad() {
    chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_CREATE_READY' }, function (response) {
      if (response && response.ok && response.requestId) {
        showCustomerCreatePanel(response.requestId);
      }
    });
  }

  // ── Customer Detail Modal (shown on /customer/{id}/view) ───────────────────

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Count digit-by-digit mismatches between two phone numbers.
  // Only meaningful when both strings have the same number of digits.
  function phoneDigitMismatches(a, b) {
    var da = (a || '').replace(/\D/g, '');
    var db = (b || '').replace(/\D/g, '');
    if (da.length !== db.length) return Infinity; // different length = clearly different
    var mismatches = 0;
    for (var i = 0; i < da.length; i++) {
      if (da[i] !== db[i]) mismatches++;
    }
    return mismatches;
  }

  function scrapeProfilePicture() {
    var el = document.querySelector('.card-image.profile-picture');
    if (!el) return null;
    var m = (el.style.backgroundImage || '').match(/url\(['"]?([^'")\s]+)['"]?\)/);
    return m ? m[1] : null;
  }

  // NoSpos serves the photo as a session-protected, relative URL
  // (e.g. /protected-file/view?id=8310). The web app is a different origin
  // with no NoSpos session, so it can never load that URL. The browser HAS
  // already loaded that image on this page, so the reliable extraction is to
  // draw a freshly loaded <img> (same-origin → canvas not tainted) and export
  // base64. A credentialed fetch is kept as a fallback.
  function profilePictureToDataUrl(rawUrl) {
    return new Promise(function (resolve) {
      function done(result) { resolve(result || null); }
      try {
        if (!rawUrl) { done(null); return; }
        if (/^data:/i.test(rawUrl)) { done(rawUrl); return; }
        var absUrl = new URL(rawUrl, location.origin).href;

        // ── Method 1: canvas from a freshly loaded Image (uses HTTP cache +
        //    session cookies the same way the visible photo did). ──────────
        function tryCanvas(next) {
          try {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () {
              try {
                if (!img.naturalWidth || !img.naturalHeight) { next(); return; }
                var canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                var url = canvas.toDataURL('image/jpeg', 0.9);
                if (url && url.length > 'data:image/jpeg;base64,'.length + 8) {
                  done(url);
                } else {
                  next();
                }
              } catch (e) { next(); }
            };
            img.onerror = function () { next(); };
            img.src = absUrl;
          } catch (e) { next(); }
        }

        // ── Method 2: credentialed fetch → blob → base64. ─────────────────
        function tryFetch() {
          fetch(absUrl, { credentials: 'include' })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.blob();
            })
            .then(function (blob) {
              if (!blob || blob.size === 0 || blob.size > 3 * 1024 * 1024) {
                done(null);
                return;
              }
              var reader = new FileReader();
              reader.onloadend = function () {
                done(typeof reader.result === 'string' ? reader.result : null);
              };
              reader.onerror = function () { done(null); };
              reader.readAsDataURL(blob);
            })
            .catch(function () { done(null); });
        }

        tryCanvas(function () { tryFetch(); });
      } catch (e) {
        done(null);
      }
    });
  }

  function scrapeCustomerStats() {
    var stats = {};
    var details = document.querySelectorAll('.card-content .detail-view .detail');
    details.forEach(function (row) {
      var key   = ((row.querySelector('strong') || {}).textContent || '').trim();
      var valEl = row.querySelector('span');
      var value = valEl ? valEl.textContent.trim() : '';
      // Tooltip raw text (e.g. "226 of 294 Bought Back") lives on an inner span
      var innerSpan = row.querySelector('span span[data-original-title], span span[title]');
      var raw = innerSpan
        ? (innerSpan.getAttribute('data-original-title') || innerSpan.getAttribute('title') || '')
        : '';
      switch (key) {
        case 'Last Transacted': stats.lastTransacted = value; break;
        case 'Joined':          stats.joined         = value; break;
        case 'Buy Back Rate':   stats.buyBackRate  = value; stats.buyBackRateRaw  = raw; break;
        case 'Renew Rate':      stats.renewRate    = value; stats.renewRateRaw    = raw; break;
        case 'Cancel Rate':     stats.cancelRate   = value; stats.cancelRateRaw   = raw; break;
        case 'Faulty Rate':     stats.faultyRate   = value; stats.faultyRateRaw   = raw; break;
      }
    });

    // Scrape buying and sales transaction counts from nav widget badges
    var navLinks = document.querySelectorAll('#w0 .nav-pills li a, .nav-pills li a');
    navLinks.forEach(function (a) {
      var badge = a.querySelector('.badge');
      if (!badge) return;
      var href = (a.getAttribute('href') || '');
      if (/\/buying\b/.test(href)) stats.buyingCount = (badge.textContent || '').trim();
      if (/\/sales\b/.test(href))  stats.salesCount  = (badge.textContent || '').trim();
    });

    return stats;
  }

  function daysSince(dateStr) {
    if (!dateStr) return null;
    // "6 Mar 2026, 14:59:00" → remove comma so Date can parse it
    var d = new Date(dateStr.replace(',', ''));
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function scrapeCustomerChanges() {
    var rows = document.querySelectorAll('#changes-tab tbody tr');
    var changes = [];
    rows.forEach(function (tr) {
      var cells = tr.querySelectorAll('td');
      if (cells.length < 6) return;
      changes.push({
        id:        (cells[0].textContent || '').trim(),
        field:     (cells[1].textContent || '').trim(),
        oldValue:  (cells[2].textContent || '').trim(),
        newValue:  (cells[3].textContent || '').trim(),
        changedAt: (cells[4].textContent || '').trim(),
        changedBy: (cells[5].textContent || '').trim(),
      });
    });
    return changes;
  }

  // Selectors for the editable fields we diff. Order is irrelevant — keyed by `key`.
  var CUSTOMER_FORM_FIELDS = [
    { key: 'forename',       sel: '#customer-forename',            type: 'text'   },
    { key: 'surname',        sel: '#customer-surname',             type: 'text'   },
    { key: 'postcode',       sel: '#customer-postcode',            type: 'text'   },
    { key: 'address1',       sel: '#customer-address1',            type: 'text'   },
    { key: 'address2',       sel: '#customer-address2',            type: 'text'   },
    { key: 'town',           sel: '#customer-address3',            type: 'text'   },
    { key: 'county',         sel: '#customer-address4',            type: 'text'   },
    { key: 'mobile',         sel: '#customer-mobile',              type: 'text'   },
    { key: 'homePhone',      sel: '#customer-home_phone',          type: 'text'   },
    { key: 'email',          sel: '#customer-email',               type: 'text'   },
    { key: 'dob',            sel: '#customer-dob',                 type: 'text'   },
    { key: 'gender',         sel: '#customer-gender',              type: 'select' },
    { key: 'emailMarketing', sel: '#customer-email_marketing_ok',  type: 'check'  },
    { key: 'smsMarketing',   sel: '#customer-sms_marketing_ok',    type: 'check'  },
    { key: 'mailMarketing',  sel: '#customer-direct_mail_ok',      type: 'check'  },
  ];

  // Read-only "detail view" summary NoSpos renders on every customer sub-page
  // (/view AND /buying). Unlike the editable #customer-* inputs, these blocks
  // are present even on pages that carry no edit form — exactly where a naive
  // .value scrape comes back blank. Keyed by the <strong> label (e.g. "Name").
  function scrapeCustomerDetailView() {
    var map = {};
    document.querySelectorAll('.detail').forEach(function (row) {
      var strong = row.querySelector('strong');
      if (!strong) return;
      var label = (strong.textContent || '').trim();
      if (!label) return;
      var span = row.querySelector('span');
      map[label] = span ? (span.textContent || '').trim() : '';
    });
    return map;
  }

  // True when the editable customer form is actually on this page. The customer
  // panel triggers on both /customer/{id}/view and /customer/{id}/buying; the
  // latter (and a post-save read-only /view) has no edit inputs, so a .value
  // scrape there yields an all-blank form. Callers use this to avoid recording
  // phantom "everything cleared" diffs and storing an empty name.
  function customerEditFormPresent() {
    return !!(document.querySelector('#customer-forename') ||
              document.querySelector('#customer-surname'));
  }

  // Best-effort full name: editable inputs first (captures unsaved edits), then
  // the read-only "Name" detail block (present even when no edit form is). Empty
  // only when NoSpos genuinely has no name on file.
  function resolveCustomerName(scraped) {
    var fromInputs = ((scraped.forename || '') + ' ' + (scraped.surname || '')).trim();
    if (fromInputs) return fromInputs;
    var detail = scrapeCustomerDetailView();
    return (detail['Name'] || detail['Full Name'] || detail['Customer'] || '').trim();
  }

  // The page may still be loading/reloading after a NoSpos save when Done is
  // pressed, so a one-shot scrape can read a half-rendered (nameless) form. Poll
  // until we can read a name — taking however long the page needs — then hand the
  // fresh scrape to cb. Falls back to best-effort data at timeout rather than
  // blocking forever. cb(scraped, resolvedName).
  function waitForCustomerScrape(cb, opts) {
    opts = opts || {};
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 15000;
    var intervalMs = 250;
    var waited = 0;
    (function poll() {
      var scraped = scrapeCustomerForm();
      var name = resolveCustomerName(scraped);
      if (name || waited >= timeoutMs) {
        cb(scraped, name);
        return;
      }
      waited += intervalMs;
      setTimeout(poll, intervalMs);
    })();
  }

  function scrapeCustomerForm() {
    // Live value first (captures unsaved edits), then the server-rendered
    // defaultValue (survives a stray .value clear) so a present-but-empty input
    // can't silently zero out a field.
    function val(sel) {
      var el = document.querySelector(sel);
      if (!el) return '';
      var v = (el.value || '').trim();
      return v || (el.defaultValue || '').trim();
    }
    function isChecked(sel) { var el = document.querySelector(sel); return !!(el && el.checked); }
    var stats = scrapeCustomerStats();
    var out = { profilePicture: scrapeProfilePicture() };
    CUSTOMER_FORM_FIELDS.forEach(function (f) {
      out[f.key] = f.type === 'check' ? isChecked(f.sel) : val(f.sel);
    });
    return Object.assign(out, stats);
  }

  // Read the SERVER-RENDERED values of the editable fields from the HTML
  // attributes (defaultValue/defaultChecked/defaultSelected) rather than the
  // live .value/.checked. This is the snapshot of whatever NoSpos's database
  // currently holds — which means it shifts every time NoSpos saves and
  // re-renders the page. We use it for:
  //   1. The diff baseline on FIRST entry, then persist it via
  //      [[readCustomerOriginal/writeCustomerOriginal]] so the baseline stays
  //      the pre-edit original even after a NoSpos save+reload.
  //   2. Detecting "form is already saved" at Done time (current .value ==
  //      defaultValue means the user's edits are already in NoSpos's DB).
  // Returns only the keys CUSTOMER_FORM_FIELDS covers — the diff doesn't use
  // anything else.
  function scrapeCustomerFormOriginals() {
    function defText(sel) {
      var el = document.querySelector(sel);
      return el ? (el.defaultValue || '').trim() : '';
    }
    function defCheck(sel) {
      var el = document.querySelector(sel);
      return !!(el && el.defaultChecked);
    }
    function defSelect(sel) {
      var el = document.querySelector(sel);
      if (!el) return '';
      var opts = el.options || [];
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].defaultSelected) return (opts[i].value || '').trim();
      }
      // No option carries the `selected` attribute → the browser implicitly
      // selects the first one, so mirror that.
      return opts.length > 0 ? (opts[0].value || '').trim() : '';
    }
    var out = {};
    CUSTOMER_FORM_FIELDS.forEach(function (f) {
      if (f.type === 'check')  out[f.key] = defCheck(f.sel);
      else if (f.type === 'select') out[f.key] = defSelect(f.sel);
      else out[f.key] = defText(f.sel);
    });
    return out;
  }

  // Persisted diff baseline. Captured the FIRST time we land on a customer
  // detail page and held in sessionStorage so that — if the user presses
  // NoSpos's own Save before our Done button, and the page reloads with
  // post-save values rendered in the HTML — we still diff against the
  // pre-edit original when they finally click Done.
  // Keyed by NoSpos customer id so navigating between customers doesn't
  // contaminate the baseline.
  var CG_CUSTOMER_ORIGINAL_KEY = 'cgCustomerOriginal';

  function readCustomerOriginal() {
    try {
      var raw = sessionStorage.getItem(CG_CUSTOMER_ORIGINAL_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) { return null; }
  }

  function writeCustomerOriginal(customerId, originals) {
    try {
      sessionStorage.setItem(
        CG_CUSTOMER_ORIGINAL_KEY,
        JSON.stringify({ customerId: customerId, originals: originals })
      );
    } catch (e) {}
  }

  function clearCustomerOriginal() {
    try { sessionStorage.removeItem(CG_CUSTOMER_ORIGINAL_KEY); } catch (e) {}
  }

  function updateNosposField(selector, value) {
    var el = document.querySelector(selector);
    if (!el || el.value === value) return;
    el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function tryAutoSaveNospos() {
    var btn =
      document.querySelector('button[type="submit"].btn-primary') ||
      document.querySelector('input[type="submit"].btn-primary') ||
      Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .find(function (b) { return /save|update/i.test((b.textContent || b.value || '')); });
    if (btn) btn.click();
  }

  // ── Customer Edit Side Panel (shown on /customer/{id}/view) ────────────────
  //
  // Replaces the old full-screen modal. Non-intrusive side panel: the user
  // edits the NoSpos form natively, then clicks "Done" to have us click Save
  // and capture the field-level diff before returning to the Cash EPOS tab.

  function showCustomerEditPanel(requestId) {
    if (document.getElementById('cg-suite-customer-edit-panel')) return;

    var searchPanel = document.getElementById('cg-suite-customer-panel');
    if (searchPanel) searchPanel.remove();

    // Diff baseline. On FIRST entry we read the server-rendered values from
    // the HTML attributes and persist them. On subsequent entries (same
    // customer, e.g. after the user pressed NoSpos's own Save and the page
    // re-rendered) we reuse the persisted original — otherwise the baseline
    // would shift to post-save values and the diff would always be empty.
    var customerIdForPanel = extractNosposCustomerIdFromPath();
    var persistedOriginal = readCustomerOriginal();
    var snapshot;
    if (
      persistedOriginal &&
      persistedOriginal.customerId === customerIdForPanel &&
      persistedOriginal.originals
    ) {
      snapshot = persistedOriginal.originals;
    } else {
      snapshot = scrapeCustomerFormOriginals();
      writeCustomerOriginal(customerIdForPanel, snapshot);
    }

    var panel = document.createElement('div');
    panel.id = 'cg-suite-customer-edit-panel';
    panel.innerHTML =
      '<div style="position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;' +
        'background:#1e3a8a;color:white;padding:18px 20px;border-radius:14px 0 0 14px;' +
        'box-shadow:-8px 8px 28px rgba(0,0,0,0.42);font-family:Inter,sans-serif;' +
        'width:260px;min-width:230px;max-width:380px;resize:horizontal;overflow:auto;box-sizing:border-box;">' +
        '<p style="margin:0 0 6px 0;font-weight:800;font-size:17px;">Please update user information</p>' +
        '<p style="margin:0 0 14px 0;font-size:13px;opacity:0.85;line-height:1.4;">' +
          'Edit this customer\'s details directly on NoSpos. When you\'re finished, press Done — we\'ll save it and bring you back to Cash EPOS.' +
        '</p>' +
        '<div id="cg-suite-edit-panel-error" style="display:none;margin:0 0 10px 0;padding:8px 10px;background:rgba(248,113,113,0.18);border:1px solid rgba(248,113,113,0.5);border-radius:8px;font-size:12px;line-height:1.4;"></div>' +
        '<button id="cg-suite-edit-panel-done" style="display:block;width:100%;padding:11px 14px;background:#facc15;color:#1e3a8a;' +
          'border:none;border-radius:9999px;font-weight:800;cursor:pointer;font-size:14px;margin-bottom:8px;">Done</button>' +
        '<button id="cg-suite-edit-panel-cancel" style="display:block;width:100%;padding:9px 14px;background:transparent;color:#e5e7eb;' +
          'border:1px solid rgba(248,250,252,0.4);border-radius:9999px;font-weight:600;cursor:pointer;font-size:12px;">Cancel</button>' +
      '</div>';
    document.body.appendChild(panel);

    var doneBtn = document.getElementById('cg-suite-edit-panel-done');
    var cancelBtn = document.getElementById('cg-suite-edit-panel-cancel');
    var errEl = document.getElementById('cg-suite-edit-panel-error');

    function showPanelError(msg) {
      if (!errEl) return;
      if (!msg) { errEl.style.display = 'none'; errEl.textContent = ''; return; }
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }

    function diffSnapshot(before, after) {
      var FIELDS = [
        ['forename', 'Forename'],
        ['surname', 'Surname'],
        ['dob', 'Date of Birth'],
        ['gender', 'Gender'],
        ['mobile', 'Mobile'],
        ['homePhone', 'Home Phone'],
        ['email', 'Email'],
        ['postcode', 'Postcode'],
        ['address1', 'Address 1'],
        ['address2', 'Address 2'],
        ['town', 'Town'],
        ['county', 'County'],
        ['emailMarketing', 'Email Marketing'],
        ['smsMarketing', 'SMS Marketing'],
        ['mailMarketing', 'Mail Marketing'],
      ];
      var out = [];
      FIELDS.forEach(function (f) {
        var key = f[0];
        var label = f[1];
        var a = before ? before[key] : '';
        var b = after ? after[key] : '';
        if (typeof a === 'boolean' || typeof b === 'boolean') {
          if (!!a !== !!b) {
            out.push({ field: label, from: a ? 'on' : 'off', to: b ? 'on' : 'off' });
          }
          return;
        }
        var sa = (a == null ? '' : String(a)).trim();
        var sb = (b == null ? '' : String(b)).trim();
        if (sa !== sb) out.push({ field: label, from: sa, to: sb });
      });
      return out;
    }

    function findSaveButton() {
      return (
        document.querySelector('.card-footer .btn-blue') ||
        document.querySelector('.card-footer button[type="submit"]') ||
        document.querySelector('.card-footer button') ||
        document.querySelector('button[type="submit"].btn-primary') ||
        Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'))
          .find(function (b) { return /save|update/i.test((b.textContent || b.value || '')); })
      );
    }

    function buildCustomerPayload(after, changes) {
      var customer = Object.assign({}, after, {
        nosposCustomerId: extractNosposCustomerIdFromPath(),
        name:    resolveCustomerName(after),
        phone:   after.mobile || after.homePhone,
        address: [after.address1, after.address2, after.town, after.county, after.postcode].filter(Boolean).join(', '),
      });
      return customer;
    }

    function finalizeAndSend(customer, changes, opts) {
      profilePictureToDataUrl(customer.profilePicture).then(function (embedded) {
        customer.profilePicture = embedded || null;
        chrome.runtime.sendMessage({
          type: 'NOSPOS_CUSTOMER_DONE',
          requestId: requestId,
          cancelled: false,
          customer: customer,
          changes: changes || [],
          saveFailed: !!(opts && opts.saveFailed),
        }).catch(function () {});
      });
    }

    doneBtn.addEventListener('click', function () {
      doneBtn.disabled = true;
      doneBtn.style.opacity = '0.7';
      doneBtn.textContent = 'Saving…';
      cancelBtn.disabled = true;
      cancelBtn.style.opacity = '0.5';
      showPanelError('');

      // Wait for the page to actually have data before scraping — it may still be
      // reloading after a save. Take however long it needs (capped), then scrape.
      waitForCustomerScrape(function (after) {
      var formPresent = customerEditFormPresent();
      // If the edit form isn't on this page (we're on /buying, or a read-only
      // /view), the .value scrape is an all-blank form and any diff against the
      // persisted snapshot is a phantom "everything cleared". Don't record those
      // changes — keep only what we can read reliably (name via the .detail
      // block). This is the bug behind the "11 changes, all → empty" reports.
      var changes = formPresent ? diffSnapshot(snapshot, after) : [];
      var customer = buildCustomerPayload(after, changes);

      // Last-resort name: the pre-edit originals snapshot captured when the form
      // was present. resolveCustomerName already tried inputs + the detail block.
      if (!customer.name && snapshot) {
        customer.name = ((snapshot.forename || '') + ' ' + (snapshot.surname || '')).trim();
      }

      // Shortcut: if the live form already matches NoSpos's saved baseline
      // (`.value === defaultValue` for every diff field) the user already
      // pressed NoSpos's own Save before clicking Done. Skip the redundant
      // save round-trip — just send the diff (vs the persisted ORIGINAL)
      // straight back to Cash EPOS.
      var alreadySaved = diffSnapshot(scrapeCustomerFormOriginals(), after).length === 0;
      if (alreadySaved) {
        finalizeAndSend(customer, changes, {});
        clearCustomerOriginal();
        panel.remove();
        return;
      }

      var saveBtn = findSaveButton();
      if (!saveBtn) {
        // No save button → send what we have without saving
        try {
          sessionStorage.setItem('cgCustomerPending', JSON.stringify({ requestId: requestId, customer: customer, changes: changes }));
        } catch (e) {}
        finalizeAndSend(customer, changes, {});
        clearCustomerOriginal();
        panel.remove();
        return;
      }

      // Persist for the post-reload pickup so we still send NOSPOS_CUSTOMER_DONE
      // when NoSpos navigates back to /customer/{id}/view.
      try {
        sessionStorage.setItem('cgCustomerPending', JSON.stringify({ requestId: requestId, customer: customer, changes: changes }));
      } catch (e) {}

      var saveFailedHandled = false;
      var saveTimeout = null;
      var observer = null;

      function handleSaveFailed(errorMsg) {
        if (saveFailedHandled) return;
        saveFailedHandled = true;
        if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
        window.removeEventListener('beforeunload', onBeforeUnload);
        if (observer) { observer.disconnect(); observer = null; }
        var pending = null;
        try {
          var raw = sessionStorage.getItem('cgCustomerPending');
          if (raw) { pending = JSON.parse(raw); sessionStorage.removeItem('cgCustomerPending'); }
        } catch (e) {}
        if (pending && pending.requestId) {
          finalizeAndSend(pending.customer, pending.changes || [], { saveFailed: true });
        }
        clearCustomerOriginal();
        panel.remove();
        showSaveFailedPanel(errorMsg);
      }

      function onBeforeUnload() { if (saveTimeout) clearTimeout(saveTimeout); }

      observer = new MutationObserver(function () {
        if (saveFailedHandled) return;
        var err = extractNosposErrorText();
        if (err) handleSaveFailed(err);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // If NoSpos hasn't reloaded within 4s, treat as save failed.
      saveTimeout = setTimeout(function () { handleSaveFailed(''); }, 4000);
      window.addEventListener('beforeunload', onBeforeUnload);

      saveBtn.click();
      }); // end waitForCustomerScrape callback
    });

    cancelBtn.addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_DONE', requestId: requestId, cancelled: true }).catch(function () {});
      clearCustomerOriginal();
      panel.remove();
    });
  }

  // ── Legacy field builders kept for the customer-search address-lookup popup
  //    in case other flows need them (currently unused after the modal swap).

  var INPUT_BASE = 'width:100%;padding:9px 12px;border:1.5px solid #e5e7eb;border-radius:8px;' +
    'font-size:14px;font-family:Inter,sans-serif;color:#111827;background:#f9fafb;box-sizing:border-box;';

  var LABEL_BASE = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;';

  // Address Line 1 with postcode lookup search button + mini popup
  function address1WithSearch(value) {
    return '<div style="display:flex;flex-direction:column;gap:5px;">' +
      '<label for="cg-field-address1" style="' + LABEL_BASE + 'color:#92400e;">Address Line 1 <span style="color:#f59e0b;">*</span></label>' +
      '<div id="cg-address1-wrap" style="display:flex;gap:8px;align-items:stretch;position:relative;">' +
        '<input type="text" id="cg-field-address1" value="' + esc(value) + '" placeholder="Type address or click search" style="' +
          INPUT_BASE + 'border-color:#fcd34d;background:#fffbeb;flex:1;" />' +
        '<button type="button" id="cg-address-search-btn" title="Find addresses for this postcode" style="' +
          'flex-shrink:0;width:40px;padding:0;border:1.5px solid #1e3a8a;background:#1e3a8a;color:white;' +
          'border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;' +
          'transition:background 0.2s, transform 0.1s;" onmouseover="this.style.background=\'#1e40af\'" onmouseout="this.style.background=\'#1e3a8a\'">' +
          '&#128269;</button>' +
        '<div id="cg-address-popup" style="display:none;position:absolute;top:100%;left:0;right:40px;margin-top:4px;' +
          'max-height:220px;overflow-y:auto;background:white;border:1.5px solid #e5e7eb;border-radius:10px;' +
          'box-shadow:0 10px 40px rgba(0,0,0,0.15);z-index:9999;font-size:13px;">' +
          '<div id="cg-address-popup-list"></div>' +
          '<div id="cg-address-popup-loading" style="display:none;padding:16px;text-align:center;color:#6b7280;">Loading…</div>' +
          '<div id="cg-address-popup-empty" style="display:none;padding:16px;text-align:center;color:#6b7280;">No addresses found. Enter postcode first.</div>' +
          '<div id="cg-address-popup-error" style="display:none;padding:12px;color:#dc2626;font-size:12px;"></div>' +
        '</div>' +
      '</div>' +
      '<div id="cg-field-address1-warn" style="display:none;font-size:12px;color:#b45309;font-weight:600;' +
        'padding:6px 10px;background:#fef3c7;border-radius:6px;border:1px solid #fcd34d;"></div>' +
    '</div>';
  }

  function onCustomerDetailPageLoad() {
    // After a successful NoSpos save the page reloads — pick up the stored
    // pending payload (set by the side panel before it clicked Save) and
    // dispatch NOSPOS_CUSTOMER_DONE with the diff we already computed.
    var pending = null;
    try {
      var raw = sessionStorage.getItem('cgCustomerPending');
      if (raw) {
        pending = JSON.parse(raw);
        sessionStorage.removeItem('cgCustomerPending');
      }
    } catch (e) {}

    if (pending && pending.requestId) {
      var c = pending.customer || {};
      profilePictureToDataUrl(c.profilePicture).then(function (embedded) {
        c.profilePicture = embedded || c.profilePicture || null;
        chrome.runtime.sendMessage({
          type: 'NOSPOS_CUSTOMER_DONE',
          requestId: pending.requestId,
          cancelled: false,
          customer: c,
          changes: pending.changes || []
        }).catch(function () {});
      });
      clearCustomerOriginal();
      return;
    }

    // Normal flow: show the side panel — the background tells us which flow
    // (existing-customer edit vs new-customer post-create) so we pick the
    // right copy and button behavior.
    chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_DETAIL_READY' }, function (response) {
      if (!response || !response.ok || !response.requestId) return;
      if (response.flow === 'newCreate') {
        showNewCustomerPostCreatePanel(response.requestId);
      } else {
        showCustomerEditPanel(response.requestId);
      }
    });
  }

  // ── Post-Create Side Panel (shown on /customer/{id}/view after creation) ──

  function showNewCustomerPostCreatePanel(requestId) {
    if (document.getElementById('cg-suite-new-customer-post-panel')) return;

    var existing = document.getElementById('cg-suite-customer-edit-panel');
    if (existing) existing.remove();

    var panel = document.createElement('div');
    panel.id = 'cg-suite-new-customer-post-panel';
    panel.innerHTML =
      '<div style="position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;' +
        'background:#1e3a8a;color:white;padding:18px 20px;border-radius:14px 0 0 14px;' +
        'box-shadow:-8px 8px 28px rgba(0,0,0,0.42);font-family:Inter,sans-serif;' +
        'width:280px;min-width:240px;max-width:380px;resize:horizontal;overflow:auto;box-sizing:border-box;">' +
        '<p style="margin:0 0 6px 0;font-weight:800;font-size:17px;">Customer created</p>' +
        '<p style="margin:0 0 14px 0;font-size:13px;opacity:0.85;line-height:1.4;">' +
          'You can fill in the rest of their info now on NoSpos, or just press Done and update it later from Cash EPOS.' +
        '</p>' +
        '<button id="cg-suite-new-customer-done" style="display:block;width:100%;padding:11px 14px;background:#facc15;color:#1e3a8a;' +
          'border:none;border-radius:9999px;font-weight:800;cursor:pointer;font-size:14px;margin-bottom:8px;">Done</button>' +
        '<button id="cg-suite-new-customer-cancel" style="display:block;width:100%;padding:9px 14px;background:transparent;color:#e5e7eb;' +
          'border:1px solid rgba(248,250,252,0.4);border-radius:9999px;font-weight:600;cursor:pointer;font-size:12px;">Cancel</button>' +
      '</div>';
    document.body.appendChild(panel);

    var doneBtn = document.getElementById('cg-suite-new-customer-done');
    var cancelBtn = document.getElementById('cg-suite-new-customer-cancel');

    doneBtn.addEventListener('click', function () {
      doneBtn.disabled = true;
      doneBtn.style.opacity = '0.7';
      doneBtn.textContent = 'Returning…';

      // Wait for the freshly-created customer page to have data (it may still be
      // loading after NoSpos redirects post-create), then scrape it.
      waitForCustomerScrape(function (customer, resolvedName) {
        customer.nosposCustomerId = extractNosposCustomerIdFromPath();
        customer.name = resolvedName;
        customer.phone = customer.mobile || customer.homePhone;
        customer.address = [customer.address1, customer.address2, customer.town, customer.county, customer.postcode].filter(Boolean).join(', ');

        profilePictureToDataUrl(customer.profilePicture).then(function (embedded) {
          customer.profilePicture = embedded || null;
          chrome.runtime.sendMessage({
            type: 'NOSPOS_CUSTOMER_DONE',
            requestId: requestId,
            cancelled: false,
            customer: customer,
            changes: [],
            newCustomer: true,
          }).catch(function () {});
          panel.remove();
        });
      });
    });

    cancelBtn.addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_DONE', requestId: requestId, cancelled: true }).catch(function () {});
      panel.remove();
    });
  }

  function fillStockSearchInput(firstBarcode) {
    if (!firstBarcode) return;
    const input = document.getElementById('stocksearchandfilter-query') ||
      document.querySelector('input[name="StockSearchAndFilter[query]"]');
    if (input) {
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = firstBarcode;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Press Enter to submit the search
      const form = input.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        const submitBtn = input.closest('.input-group')?.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.click();
        else {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
      }
    }
  }

  function fillRetailPriceInput(salePrice) {
    if (salePrice === '') return;
    const input = document.getElementById('stock-retail_price') ||
      document.querySelector('input[name="Stock[retail_price]"]');
    if (input) {
      input.value = salePrice;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function onStockSearchPageLoad() {
    chrome.runtime.sendMessage({ type: 'NOSPOS_STOCK_SEARCH_READY' }, function (response) {
      if (response?.ok && response.firstBarcode) {
        fillStockSearchInput(response.firstBarcode);
      }
    });
  }

  function clickSaveButton() {
    const btn = document.querySelector('button.btn.btn-blue[type="submit"]') ||
      Array.from(document.querySelectorAll('button.btn.btn-blue')).find(function (b) {
        return (b.textContent || '').trim().includes('Save');
      });
    if (btn) btn.click();
  }

  function sendStockEditReady(attempt) {
    const stockBarcode = getStockBarcodeFromPage();
    if (!stockBarcode && attempt < 10) {
      setTimeout(function () {
        sendStockEditReady(attempt + 1);
      }, 250);
      return;
    }

    var currentStockName = (function () {
      var el = document.getElementById('stock-name');
      return el ? (el.value || '').trim() : '';
    })();
    var currentExternallyListed = (function () {
      var el = document.querySelector('#stock-externally_listed_at[type="checkbox"]');
      return !!(el && el.checked);
    })();

    chrome.runtime.sendMessage({
      type: 'NOSPOS_STOCK_EDIT_READY',
      oldRetailPrice: getRetailPriceFromPage(),
      currentStockName: currentStockName,
      currentExternallyListed: currentExternallyListed,
      stockBarcode
    }, function (response) {
      if (!response?.ok) return;
      // Set item name unconditionally (mirrors Web EPOS approach)
      if (response.stockName) {
        var nameEl = document.getElementById('stock-name');
        if (nameEl) {
          nameEl.value = response.stockName;
          nameEl.dispatchEvent(new Event('input', { bubbles: true }));
          nameEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      // Tick externally listed for every item
      var extEl = document.querySelector('#stock-externally_listed_at[type="checkbox"]');
      if (extEl && !extEl.checked) {
        extEl.checked = true;
        extEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (response.salePrice !== undefined) fillRetailPriceInput(response.salePrice);
      setTimeout(function () { clickSaveButton(); }, 150);
    });
  }

  function onStockEditPageLoad() {
    sendStockEditReady(0);
  }

  function getRetailPriceFromPage() {
    const input = document.getElementById('stock-retail_price') ||
      document.querySelector('input[name="Stock[retail_price]"]');
    return input ? (input.value || '').trim() : '';
  }

  function getStockBarcodeFromPage() {
    const details = Array.from(document.querySelectorAll('.detail'));
    const match = details.find(function (node) {
      const label = node.querySelector('strong');
      return (label?.textContent || '').trim().toLowerCase() === 'barserial';
    });
    const value = match?.querySelector('span');
    return value ? (value.textContent || '').trim() : '';
  }

  function sendPageLoaded() {
    if (!isOnNosposDomain() || isOnLoginPage()) return;
    const path = (window.location.pathname || '/').toLowerCase();
    const msg = { type: 'NOSPOS_PAGE_LOADED', path };
    if (isOnStockEditPage()) {
      msg.retailPrice = getRetailPriceFromPage();
      msg.stockBarcode = getStockBarcodeFromPage();
    }
    chrome.runtime.sendMessage(msg).catch(function () {});
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'NOSPOS_VERIFY_RETAIL_PRICE') {
      sendPageLoaded();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'SCRAPE_NOSPOS_STOCK_CATEGORY') {
      try {
        if (!isOnStockCategoryIndexPage()) {
          sendResponse({ ok: false, rows: [], error: 'Not on stock category index' });
        } else {
          sendResponse({ ok: true, rows: scrapeStockCategoryIndexTable() });
        }
      } catch (e) {
        sendResponse({
          ok: false,
          rows: [],
          error: e && e.message ? String(e.message) : 'scrape failed',
        });
      }
      return true;
    }
    if (msg.type === 'SCRAPE_NOSPOS_STOCK_CATEGORY_MODIFY') {
      try {
        if (!isOnStockCategoryModifyPage()) {
          sendResponse({
            ok: false,
            rows: [],
            buybackRatePercent: null,
            offerRatePercent: null,
            error: 'Not on stock category modify page',
          });
        } else {
          var rows = scrapeStockCategoryModifyFields();
          var buybackRatePercent = scrapeStockCategoryModifyBuybackRate();
          var offerRatePercent = scrapeStockCategoryModifyOfferRate();
          sendResponse({
            ok: true,
            rows: rows,
            buybackRatePercent: buybackRatePercent,
            offerRatePercent: offerRatePercent,
          });
        }
      } catch (e) {
        sendResponse({
          ok: false,
          rows: [],
          buybackRatePercent: null,
          offerRatePercent: null,
          error: e && e.message ? String(e.message) : 'scrape failed',
        });
      }
      return true;
    }
    return true;
  });

  function onLoad() {
    sendLoginRequired();
    sendPageLoaded();

    function handlePageType() {
      if (isForcedLoginRedirectPage()) {
        return;
      }
      if (isOnStockSearchPage()) {
        onStockSearchPageLoad();
      } else if (isOnStockEditPage()) {
        onStockEditPageLoad();
      } else if (isOnCustomerDetailPage()) {
        onCustomerDetailPageLoad();
      } else if (isOnCustomerCreatePage()) {
        onCustomerCreatePageLoad();
      } else if (isOnCustomerSearchPage()) {
        onCustomerSearchPageLoad();
      } else if (isOnStockCategoryIndexPage()) {
        // Data / category pagination — do not emit NOSPOS_PAGE_READY here.
      } else if (isOnStockCategoryModifyPage()) {
        // Data / category modify scrape — do not emit NOSPOS_PAGE_READY here.
      } else {
        sendPageReady();
      }
    }

    if (document.readyState === 'complete') {
      handlePageType();
    } else {
      window.addEventListener('load', handlePageType, { once: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onLoad);
  } else {
    onLoad();
  }
})();
