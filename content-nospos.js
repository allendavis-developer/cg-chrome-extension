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
  const CUSTOMER_SEARCH_PAGE_PATTERN = /^\/customers(?:\/|\?|$)/i;
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

  function scrapeCustomerForm() {
    function val(sel) { var el = document.querySelector(sel); return el ? (el.value || '').trim() : ''; }
    function isChecked(sel) { var el = document.querySelector(sel); return !!(el && el.checked); }
    var stats = scrapeCustomerStats();
    return Object.assign({
      profilePicture: scrapeProfilePicture(),
      forename:       val('#customer-forename'),
      surname:        val('#customer-surname'),
      postcode:       val('#customer-postcode'),
      address1:       val('#customer-address1'),
      address2:       val('#customer-address2'),
      town:           val('#customer-address3'),
      county:         val('#customer-address4'),
      mobile:         val('#customer-mobile'),
      homePhone:      val('#customer-home_phone'),
      email:          val('#customer-email'),
      dob:            val('#customer-dob'),
      gender:         val('#customer-gender'),
      emailMarketing: isChecked('#customer-email_marketing_ok'),
      smsMarketing:   isChecked('#customer-sms_marketing_ok'),
      mailMarketing:  isChecked('#customer-direct_mail_ok'),
    }, stats);
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

  // ── field builders ────────────────────────────────────────────────────────

  var INPUT_BASE = 'width:100%;padding:9px 12px;border:1.5px solid #e5e7eb;border-radius:8px;' +
    'font-size:14px;font-family:Inter,sans-serif;color:#111827;background:#f9fafb;box-sizing:border-box;';

  var LABEL_BASE = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;';

  function field(id, label, value, type) {
    return '<div style="display:flex;flex-direction:column;gap:5px;">' +
      '<label for="' + id + '" style="' + LABEL_BASE + '">' + esc(label) + '</label>' +
      '<input type="' + (type || 'text') + '" id="' + id + '" value="' + esc(value) +
        '" style="' + INPUT_BASE + '" />' +
    '</div>';
  }

  // Empty field with amber "please enter" styling
  function emptyField(id, label, placeholder) {
    return '<div style="display:flex;flex-direction:column;gap:5px;">' +
      '<label for="' + id + '" style="' + LABEL_BASE + 'color:#92400e;">' +
        esc(label) + ' <span style="color:#f59e0b;">*</span></label>' +
      '<input type="text" id="' + id + '" value="" placeholder="' + esc(placeholder || 'Enter value…') + '" style="' +
        INPUT_BASE + 'border-color:#fcd34d;background:#fffbeb;" />' +
      '<div id="' + id + '-warn" style="display:none;font-size:12px;color:#b45309;font-weight:600;' +
        'padding:6px 10px;background:#fef3c7;border-radius:6px;border:1px solid #fcd34d;"></div>' +
    '</div>';
  }

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

  function genderSelect(currentVal) {
    var opts = [['0','Unknown'],['1','Male'],['2','Female'],['3','Other']];
    return '<div style="display:flex;flex-direction:column;gap:5px;">' +
      '<label for="cg-field-gender" style="' + LABEL_BASE + '">Gender</label>' +
      '<select id="cg-field-gender" style="' + INPUT_BASE + '">' +
      opts.map(function(o) {
        return '<option value="' + o[0] + '"' + (o[0] === currentVal ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') +
      '</select></div>';
  }

  function checkbox(id, label, checked) {
    return '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:500;color:#374151;padding:6px 0;">' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') +
        ' style="width:16px;height:16px;accent-color:#1e3a8a;cursor:pointer;" />' +
      esc(label) + '</label>';
  }

  function sectionHeader(label, color) {
    return '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;' +
      'color:' + (color || '#1e3a8a') + ';padding-bottom:8px;border-bottom:2px solid ' +
      (color ? '#fde68a' : '#dbeafe') + ';margin-bottom:14px;">' + esc(label) + '</div>';
  }

  function grid2(a, b) {
    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' + a + (b || '') + '</div>';
  }

  function showCustomerDetailModal(requestId) {
    if (document.getElementById('cg-suite-customer-modal')) return;

    var searchPanel = document.getElementById('cg-suite-customer-panel');
    if (searchPanel) searchPanel.remove();

    var d       = scrapeCustomerForm();
    var changes = scrapeCustomerChanges();

    // If town is empty, store a flag so we can detect a native NosPos save
    // and switch back to the system tab even if the CG modal isn't used.
    if (!d.town) {
      try { sessionStorage.setItem('cgWaitingForTownFix', JSON.stringify({ requestId: requestId })); } catch (e) {}
    }

    var days          = daysSince(d.lastTransacted);
    var recentWarning = days !== null && days >= 0 && days <= 14;

    // ── stat pill helper ────────────────────────────────────────────────────────
    function statPill(label, value, raw, goodHigh) {
      if (!value) return '';
      var pct = parseFloat(value);
      var isGood = goodHigh ? pct >= 50 : pct < 5;
      var bg    = isGood ? '#f0fdf4' : '#fff1f2';
      var color = isGood ? '#166534' : '#9f1239';
      var border= isGood ? '#bbf7d0' : '#fecdd3';
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;' +
        'background:' + bg + ';border:1.5px solid ' + border + ';border-radius:10px;padding:8px 14px;min-width:0;">' +
        '<span style="font-size:18px;font-weight:900;color:' + color + ';">' + esc(value) + '</span>' +
        '<span style="font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.07em;">' + esc(label) + '</span>' +
        (raw ? '<span style="font-size:10px;color:#9ca3af;margin-top:1px;">' + esc(raw) + '</span>' : '') +
        '</div>';
    }

    var hasStats = d.buyBackRate || d.renewRate || d.cancelRate || d.faultyRate;

    var overlay = document.createElement('div');
    overlay.id = 'cg-suite-customer-modal';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,0.7);' +
      'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'display:flex;align-items:center;justify-content:center;pointer-events:auto;padding:24px;';

    overlay.innerHTML =
      '<div id="cg-modal-card" style="background:white;border-radius:20px;width:100%;max-width:700px;' +
        'max-height:92vh;display:flex;flex-direction:column;' +
        'box-shadow:0 32px 80px rgba(0,0,0,0.5);font-family:Inter,sans-serif;overflow:hidden;">' +

        // Header
        '<div style="background:#1e3a8a;padding:20px 28px 0;flex-shrink:0;">' +
          '<div style="display:flex;align-items:center;gap:14px;padding-bottom:16px;">' +
            '<div>' +
              '<p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.6);">CG Suite</p>' +
              '<h2 style="margin:2px 0 0;font-size:18px;font-weight:800;color:white;">' + esc((d.forename + ' ' + d.surname).trim() || 'Customer Profile') + '</h2>' +
            '</div>' +
          '</div>' +
          // Tab bar
          '<div style="display:flex;gap:0;">' +
            '<button id="cg-tab-details" style="padding:9px 20px;background:white;color:#1e3a8a;border:none;' +
              'font-weight:800;font-size:13px;cursor:pointer;border-radius:10px 10px 0 0;font-family:Inter,sans-serif;">' +
              'Details</button>' +
            '<button id="cg-tab-changes" style="padding:9px 20px;background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.7);border:none;' +
              'font-weight:700;font-size:13px;cursor:pointer;border-radius:10px 10px 0 0;font-family:Inter,sans-serif;">' +
              'Changes' + (changes.length ? ' <span style="background:#facc15;color:#1e3a8a;border-radius:20px;padding:1px 7px;font-size:11px;">' + changes.length + '</span>' : '') +
            '</button>' +
          '</div>' +
        '</div>' +

        // ── Details pane ────────────────────────────────────────────────────────
        '<div id="cg-pane-details" style="overflow-y:auto;padding:24px 28px;flex:1;">' +

          // ── Last transacted info bar ────────────────────────────────────────
          (d.lastTransacted
            ? '<div style="background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:10px;' +
              'padding:10px 14px;margin-bottom:18px;font-size:12px;color:#0369a1;font-weight:600;">' +
              'Last transacted: ' + esc(d.lastTransacted) +
              (days !== null ? ' (' + days + ' day' + (days === 1 ? '' : 's') + ' ago)' : '') +
              '</div>'
            : ''
          ) +

          // ── Transaction stats ───────────────────────────────────────────────
          (hasStats
            ? '<div style="margin-bottom:20px;">' +
              sectionHeader('Transaction History') +
              // Transaction counts row
              ((d.buyingCount || d.salesCount)
                ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">' +
                  (d.buyingCount
                    ? '<div style="background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;">' +
                      '<span style="font-size:18px;font-weight:900;color:#0369a1;">B</span>' +
                      '<div><p style="margin:0;font-size:22px;font-weight:900;color:#0c4a6e;line-height:1;">' + esc(d.buyingCount) + '</p>' +
                      '<p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#7dd3fc;">Buying Transactions</p></div>' +
                      '</div>'
                    : '') +
                  (d.salesCount
                    ? '<div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;">' +
                      '<span style="font-size:18px;font-weight:900;color:#166534;">S</span>' +
                      '<div><p style="margin:0;font-size:22px;font-weight:900;color:#14532d;line-height:1;">' + esc(d.salesCount) + '</p>' +
                      '<p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#86efac;">Sales Transactions</p></div>' +
                      '</div>'
                    : '') +
                  '</div>'
                : '') +
              '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">' +
                statPill('Buy Back',  d.buyBackRate, d.buyBackRateRaw, true)  +
                statPill('Renew',     d.renewRate,   d.renewRateRaw,   true)  +
                statPill('Cancel',    d.cancelRate,  d.cancelRateRaw,  true)  +
                statPill('Faulty',    d.faultyRate,  d.faultyRateRaw,  false) +
              '</div></div>'
            : ''
          ) +

          // ── Photo + Verify inputs side by side ──
          '<div style="display:flex;gap:18px;align-items:flex-start;' +
            'background:#fffbeb;border:1.5px solid #fcd34d;border-radius:12px;padding:16px 18px;margin-bottom:20px;">' +

            // Photo
            (d.profilePicture
              ? '<img src="' + esc(d.profilePicture) + '" style="width:160px;flex-shrink:0;' +
                'height:auto;border-radius:10px;display:block;object-fit:contain;" />'
              : '<div style="width:160px;flex-shrink:0;height:200px;background:#dbeafe;border-radius:10px;' +
                'display:flex;align-items:center;justify-content:center;">' +
                '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#93c5fd" stroke-width="1.5">' +
                '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' +
                '</svg></div>'
            ) +

            // Verify inputs
            '<div style="flex:1;min-width:0;">' +
              '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:' + (recentWarning ? '8px' : '12px') + ';">' +
                '<div style="display:flex;align-items:center;gap:6px;min-width:0;">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
                  '<span style="font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.06em;">Enter from your own knowledge</span>' +
                '</div>' +
                '<button id="cg-customer-bypass" type="button" style="padding:8px 14px;background:white;' +
                  'color:#166534;border:1px solid #86efac;border-radius:9999px;font-weight:700;' +
                  'cursor:pointer;font-size:12px;font-family:Inter,sans-serif;white-space:nowrap;">Bypass</button>' +
              '</div>' +
              (recentWarning
                ? '<div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;' +
                  'padding:8px 12px;margin-bottom:12px;font-size:12px;color:#166534;font-weight:600;' +
                  'display:flex;align-items:center;gap:7px;">' +
                  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5">' +
                  '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
                  'Last transaction was ' + days + ' day' + (days === 1 ? '' : 's') + ' ago.' +
                  '</div>'
                : ''
              ) +
              grid2(
                emptyField('cg-field-mobile',   'Mobile Phone',   'Type the number you know'),
                (d.email ? emptyField('cg-field-email',     'Email Address',  'Type the address you know') : '<div></div>')
              ) +
              '<div style="margin-top:10px;">' +
              grid2(
                emptyField('cg-field-postcode',  'Postcode',       'Type the postcode you know'),
                address1WithSearch('')
              ) + '</div>' +
            '</div>' +

          '</div>' +

          // Personal
          sectionHeader('Personal Details') +
          grid2(
            field('cg-field-forename', 'Forename', d.forename),
            field('cg-field-surname',  'Surname',  d.surname)
          ) +
          '<div style="margin-top:12px;">' +
          grid2(
            field('cg-field-dob', 'Date of Birth', d.dob, 'date'),
            genderSelect(d.gender)
          ) + '</div>' +

          // Address (non-sensitive fields)
          '<div style="margin-top:20px;">' + sectionHeader('Additional Address') + '</div>' +
          grid2(
            field('cg-field-address2', 'Address Line 2', d.address2),
            // Town has a required-warn div appended
            '<div style="display:flex;flex-direction:column;gap:5px;">' +
              '<label for="cg-field-town" style="' + LABEL_BASE + 'color:#92400e;">Town <span style="color:#f59e0b;">*</span></label>' +
              '<input type="text" id="cg-field-town" value="' + esc(d.town) + '" placeholder="Required" style="' + INPUT_BASE + 'border-color:' + (d.town ? '#e5e7eb' : '#fcd34d') + ';background:' + (d.town ? '#f9fafb' : '#fffbeb') + ';" />' +
              '<div id="cg-field-town-warn" style="display:none;font-size:12px;color:#b45309;font-weight:600;padding:6px 10px;background:#fef3c7;border-radius:6px;border:1px solid #fcd34d;"></div>' +
            '</div>'
          ) +
          '<div style="margin-top:12px;">' +
          field('cg-field-county', 'County', d.county) +
          '</div>' +

          // Marketing
          '<div style="margin-top:20px;">' + sectionHeader('Marketing Preferences') + '</div>' +
          '<div style="display:flex;gap:20px;flex-wrap:wrap;">' +
            checkbox('cg-field-email-mkt', 'Email Marketing', d.emailMarketing) +
            checkbox('cg-field-sms-mkt',   'SMS Marketing',   d.smsMarketing) +
            checkbox('cg-field-mail-mkt',  'Mail Marketing',  d.mailMarketing) +
          '</div>' +

        '</div>' + // end details pane

        // ── Changes pane ─────────────────────────────────────────────────────
        '<div id="cg-pane-changes" style="display:none;overflow-y:auto;padding:24px 28px;flex:1;">' +
          (changes.length === 0
            ? '<p style="text-align:center;color:#9ca3af;font-size:13px;padding:40px 0;">No changes recorded.</p>'
            : '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
              '<thead><tr style="border-bottom:2px solid #e5e7eb;">' +
                '<th style="text-align:left;padding:6px 8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#6b7280;">Field</th>' +
                '<th style="text-align:left;padding:6px 8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#6b7280;">Old</th>' +
                '<th style="text-align:left;padding:6px 8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#6b7280;">New</th>' +
                '<th style="text-align:left;padding:6px 8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#6b7280;">Changed</th>' +
                '<th style="text-align:left;padding:6px 8px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#6b7280;">By</th>' +
              '</tr></thead>' +
              '<tbody>' +
              changes.map(function (c, i) {
                var bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
                return '<tr style="border-bottom:1px solid #f3f4f6;background:' + bg + ';">' +
                  '<td style="padding:7px 8px;font-weight:700;color:#1e3a8a;">' + esc(c.field) + '</td>' +
                  '<td style="padding:7px 8px;color:#6b7280;font-family:monospace;">' + esc(c.oldValue || '—') + '</td>' +
                  '<td style="padding:7px 8px;color:#111827;font-family:monospace;font-weight:600;">' + esc(c.newValue || '—') + '</td>' +
                  '<td style="padding:7px 8px;color:#6b7280;white-space:nowrap;">' + esc(c.changedAt) + '</td>' +
                  '<td style="padding:7px 8px;color:#374151;font-weight:600;">' + esc(c.changedBy) + '</td>' +
                  '</tr>';
              }).join('') +
              '</tbody></table>'
          ) +
        '</div>' + // end changes pane

        // Footer
        '<div style="padding:16px 28px;border-top:1px solid #f3f4f6;display:flex;gap:12px;' +
          'justify-content:flex-end;align-items:center;background:#fafafa;flex-shrink:0;">' +
          '<button id="cg-customer-cancel" style="padding:10px 20px;background:transparent;' +
            'color:#6b7280;border:1.5px solid #e5e7eb;border-radius:10px;font-weight:600;' +
            'cursor:pointer;font-size:14px;font-family:Inter,sans-serif;">Cancel</button>' +
          '<button id="cg-customer-use" style="padding:10px 28px;background:#facc15;' +
            'color:#1e3a8a;border:none;border-radius:10px;font-weight:800;cursor:pointer;' +
            'font-size:14px;font-family:Inter,sans-serif;box-shadow:0 4px 12px rgba(250,204,21,0.4);">' +
            'OK</button>' +
        '</div>' + // end footer

      '</div>'; // end modal card

    document.body.appendChild(overlay);

    // ── Tab switching ─────────────────────────────────────────────────────────
    var tabDetails   = document.getElementById('cg-tab-details');
    var tabChanges   = document.getElementById('cg-tab-changes');
    var paneDetails  = document.getElementById('cg-pane-details');
    var paneChanges  = document.getElementById('cg-pane-changes');

    function activateTab(tab) {
      var isDetails = tab === 'details';
      tabDetails.style.background  = isDetails ? 'white' : 'rgba(255,255,255,0.15)';
      tabDetails.style.color        = isDetails ? '#1e3a8a' : 'rgba(255,255,255,0.7)';
      tabChanges.style.background  = !isDetails ? 'white' : 'rgba(255,255,255,0.15)';
      tabChanges.style.color        = !isDetails ? '#1e3a8a' : 'rgba(255,255,255,0.7)';
      paneDetails.style.display    = isDetails ? '' : 'none';
      paneChanges.style.display    = !isDetails ? '' : 'none';
    }

    tabDetails.addEventListener('click', function () { activateTab('details'); });
    tabChanges.addEventListener('click', function () { activateTab('changes'); });

    // ── Address lookup (Ideal Postcodes via extension background) ─────────────────
    var popup = document.getElementById('cg-address-popup');
    var popupList = document.getElementById('cg-address-popup-list');
    var popupLoading = document.getElementById('cg-address-popup-loading');
    var popupEmpty = document.getElementById('cg-address-popup-empty');
    var popupError = document.getElementById('cg-address-popup-error');
    var searchBtn = document.getElementById('cg-address-search-btn');
    var address1Input = document.getElementById('cg-field-address1');
    var address1Wrap = document.getElementById('cg-address1-wrap');

    function hideAddressPopup() {
      if (popup) popup.style.display = 'none';
    }

    function showAddressPopup() {
      if (!popup) return;
      popupList.style.display = '';
      popupLoading.style.display = 'none';
      popupEmpty.style.display = 'none';
      popupError.style.display = 'none';
      popup.style.display = 'block';
    }

    function closePopupOnClickOutside(e) {
      if (address1Wrap && popup && !address1Wrap.contains(e.target)) {
        hideAddressPopup();
        document.removeEventListener('click', closePopupOnClickOutside);
      }
    }

    if (searchBtn && popup) {
      searchBtn.addEventListener('click', function () {
        var postcode = (document.getElementById('cg-field-postcode').value || '').trim();
        if (!postcode || postcode.replace(/\s+/g, '').length < 4) {
          popupList.innerHTML = '';
          popupList.style.display = 'none';
          popupLoading.style.display = 'none';
          popupEmpty.style.display = 'block';
          popupEmpty.textContent = 'Enter a postcode first (min 4 chars)';
          popupError.style.display = 'none';
          popup.style.display = 'block';
          setTimeout(function () { document.addEventListener('click', closePopupOnClickOutside); }, 0);
          return;
        }
        popupList.innerHTML = '';
        popupList.style.display = 'none';
        popupLoading.style.display = 'block';
        popupEmpty.style.display = 'none';
        popupError.style.display = 'none';
        popup.style.display = 'block';
        setTimeout(function () { document.addEventListener('click', closePopupOnClickOutside); }, 0);

        chrome.runtime.sendMessage({ type: 'FETCH_ADDRESS_SUGGESTIONS', postcode: postcode }, function (res) {
          popupLoading.style.display = 'none';
          if (!res || !res.ok) {
            popupError.textContent = res && res.error ? res.error : 'Address lookup failed';
            popupError.style.display = 'block';
            popupEmpty.style.display = 'none';
            popupList.style.display = 'none';
            return;
          }
          var addresses = res.addresses || [];
          if (addresses.length === 0) {
            popupEmpty.textContent = 'No addresses found. Check the postcode (e.g. L13 9AE) and that Django is running at http://127.0.0.1:8000';
            popupEmpty.style.display = 'block';
            popupList.style.display = 'none';
            return;
          }
          popupEmpty.style.display = 'none';
          popupList.style.display = 'block';
          popupList.innerHTML = addresses.map(function (addr, i) {
            var display = [addr.line_1, addr.line_2, addr.line_3, addr.post_town, addr.postcode].filter(Boolean).join(', ');
            if (!display) display = 'Address ' + (i + 1);
            return '<div class="cg-address-item" data-index="' + i + '" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid #f3f4f6;' +
              'transition:background 0.15s;" onmouseover="this.style.background=\'#f0f9ff\'" onmouseout="this.style.background=\'transparent\'">' +
              esc(display) + '</div>';
          }).join('');
          popupList.querySelectorAll('.cg-address-item').forEach(function (el) {
            el.addEventListener('click', function () {
              var idx = parseInt(el.getAttribute('data-index'), 10);
              if (isNaN(idx) || idx < 0 || idx >= addresses.length) return;
              var addr = addresses[idx];
              hideAddressPopup();
              document.removeEventListener('click', closePopupOnClickOutside);
              var line1 = addr.line_1 || '';
              var line2 = addr.line_2 || '';
              var line3 = addr.line_3 || '';
              var town = addr.post_town || '';
              var county = addr.county || '';
              var pc = addr.postcode || '';
              var addr2Val = [line2, line3].filter(Boolean).join(', ');
              if (address1Input) { address1Input.value = line1; address1Input.dispatchEvent(new Event('input', { bubbles: true })); }
              var addr2 = document.getElementById('cg-field-address2');
              if (addr2) { addr2.value = addr2Val; addr2.dispatchEvent(new Event('input', { bubbles: true })); }
              var townEl = document.getElementById('cg-field-town');
              if (townEl) { townEl.value = town; townEl.dispatchEvent(new Event('input', { bubbles: true })); townEl.style.borderColor = '#e5e7eb'; townEl.style.background = '#f9fafb'; }
              var countyEl = document.getElementById('cg-field-county');
              if (countyEl) { countyEl.value = county; countyEl.dispatchEvent(new Event('input', { bubbles: true })); }
              var postEl = document.getElementById('cg-field-postcode');
              if (postEl && pc) { postEl.value = pc; postEl.dispatchEvent(new Event('input', { bubbles: true })); }
              showFieldWarn('cg-field-town', '');
            });
          });
        });
      });
    }

    var phoneWarningAcknowledged = false;

    function getFieldVal(id) {
      var el = document.getElementById(id);
      return el ? (el.value || '').trim() : '';
    }

    function showFieldWarn(id, msg) {
      var w = document.getElementById(id + '-warn');
      if (w) { w.textContent = msg; w.style.display = msg ? 'block' : 'none'; }
    }

    var useBtn = document.getElementById('cg-customer-use');

    var hasEmailInNospos = !!(d.email && d.email.trim());

    function validateVerifyFields() {
      var phone = getFieldVal('cg-field-mobile');
      var email = hasEmailInNospos ? getFieldVal('cg-field-email') : '';
      var post = getFieldVal('cg-field-postcode');
      var addr1 = getFieldVal('cg-field-address1');
      var town = getFieldVal('cg-field-town');
      if (!phone) { showFieldWarn('cg-field-mobile', 'Mobile is required.'); document.getElementById('cg-field-mobile').focus(); return false; }
      showFieldWarn('cg-field-mobile', '');
      if (hasEmailInNospos && !email) { showFieldWarn('cg-field-email', 'Email is required.'); document.getElementById('cg-field-email').focus(); return false; }
      if (hasEmailInNospos) showFieldWarn('cg-field-email', '');
      if (!post) { showFieldWarn('cg-field-postcode', 'Postcode is required.'); document.getElementById('cg-field-postcode').focus(); return false; }
      showFieldWarn('cg-field-postcode', '');
      if (!addr1) { showFieldWarn('cg-field-address1', 'Address Line 1 is required.'); document.getElementById('cg-field-address1').focus(); return false; }
      showFieldWarn('cg-field-address1', '');
      if (!town) { showFieldWarn('cg-field-town', 'Town is required.'); document.getElementById('cg-field-town').focus(); return false; }
      showFieldWarn('cg-field-town', '');
      return true;
    }

    function showBypassReasonPrompt(callback) {
      var promptOverlay = document.createElement('div');
      promptOverlay.id = 'cg-bypass-reason-overlay';
      promptOverlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483648;background:rgba(15,23,42,0.65);' +
        'display:flex;align-items:center;justify-content:center;pointer-events:auto;';
      promptOverlay.innerHTML =
        '<div style="background:white;border-radius:16px;padding:28px 32px;width:100%;max-width:400px;' +
          'box-shadow:0 24px 60px rgba(0,0,0,0.55);font-family:Inter,sans-serif;">' +
          '<h3 style="margin:0 0 6px;font-size:17px;font-weight:800;color:#1e3a8a;">Bypass Reason</h3>' +
          '<p style="margin:0 0 16px;font-size:13px;color:#64748b;">Please provide a reason for bypassing customer verification.</p>' +
          '<input id="cg-bypass-reason-input" type="text" placeholder="Enter reason..." ' +
            'style="width:100%;box-sizing:border-box;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:10px;' +
            'font-size:14px;font-family:Inter,sans-serif;outline:none;margin-bottom:18px;" />' +
          '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
            '<button id="cg-bypass-cancel-btn" type="button" ' +
              'style="padding:9px 20px;background:#f1f5f9;color:#475569;border:none;border-radius:9999px;' +
              'font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">Cancel</button>' +
            '<button id="cg-bypass-ok-btn" type="button" ' +
              'style="padding:9px 20px;background:#1e3a8a;color:white;border:none;border-radius:9999px;' +
              'font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">OK</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(promptOverlay);

      var input = document.getElementById('cg-bypass-reason-input');
      var okBtn = document.getElementById('cg-bypass-ok-btn');
      var cancelBtn = document.getElementById('cg-bypass-cancel-btn');

      setTimeout(function () { input.focus(); }, 50);

      function dismiss(reason) {
        promptOverlay.remove();
        callback(reason);
      }

      okBtn.addEventListener('click', function () {
        var val = (input.value || '').trim();
        if (!val) {
          input.style.borderColor = '#ef4444';
          input.focus();
          return;
        }
        dismiss(val);
      });

      cancelBtn.addEventListener('click', function () { dismiss(null); });

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { okBtn.click(); }
        if (e.key === 'Escape') { cancelBtn.click(); }
      });
    }

    function proceedWithCustomerData(bypassReason) {
      if (bypassReason && !recentWarning) {
        showBypassReasonPrompt(function (manualReason) {
          if (manualReason == null) return;
          _doProceedWithCustomerData(manualReason);
        });
        return;
      }
      _doProceedWithCustomerData(bypassReason);
    }

    function _doProceedWithCustomerData(bypassReason) {
      var enteredPhone   = getFieldVal('cg-field-mobile');
      var enteredEmail   = getFieldVal('cg-field-email');
      var enteredPost    = getFieldVal('cg-field-postcode');
      var enteredAddr1   = getFieldVal('cg-field-address1');
      var enteredTown    = getFieldVal('cg-field-town');

      if (bypassReason) {
        enteredPhone = enteredPhone || d.mobile;
        enteredEmail = enteredEmail || d.email;
        enteredPost  = enteredPost  || d.postcode;
        enteredAddr1 = enteredAddr1 || d.address1;
        enteredTown  = enteredTown  || d.town;
      }

      if (!bypassReason && !phoneWarningAcknowledged && enteredPhone && d.mobile && enteredPhone !== d.mobile) {
        var dist = phoneDigitMismatches(enteredPhone, d.mobile);
        if (dist >= 1 && dist <= 2) {
          showFieldWarn('cg-field-mobile',
            'This looks very similar to what\'s on NoSpos (' + d.mobile + '). Are you sure it\'s correct? Press OK again to confirm.');
          phoneWarningAcknowledged = true;
          return;
        }
      }
      showFieldWarn('cg-field-mobile', '');

      // ── Collect all final values from modal ───────────────────────────────
      var finalForename  = getFieldVal('cg-field-forename');
      var finalSurname   = getFieldVal('cg-field-surname');
      var finalDob       = getFieldVal('cg-field-dob');
      var finalGender    = getFieldVal('cg-field-gender');
      var finalAddr2     = getFieldVal('cg-field-address2');
      var finalCounty    = getFieldVal('cg-field-county');
      var finalEmailMkt  = !!(document.getElementById('cg-field-email-mkt') && document.getElementById('cg-field-email-mkt').checked);
      var finalSmsMkt    = !!(document.getElementById('cg-field-sms-mkt')   && document.getElementById('cg-field-sms-mkt').checked);
      var finalMailMkt   = !!(document.getElementById('cg-field-mail-mkt')  && document.getElementById('cg-field-mail-mkt').checked);

      // ── Sync every changed field back to nospos ───────────────────────────
      function updateNosposCheckbox(sel, value) {
        var el = document.querySelector(sel);
        if (!el || el.checked === value) return;
        el.checked = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if (finalForename  !== d.forename)   updateNosposField('#customer-forename',   finalForename);
      if (finalSurname   !== d.surname)    updateNosposField('#customer-surname',     finalSurname);
      if (enteredPhone   && enteredPhone   !== d.mobile)    updateNosposField('#customer-mobile',    enteredPhone);
      if (enteredEmail   && enteredEmail   !== d.email)     updateNosposField('#customer-email',      enteredEmail);
      if (enteredPost    && enteredPost    !== d.postcode)  updateNosposField('#customer-postcode',   enteredPost);
      if (enteredAddr1   && enteredAddr1   !== d.address1)  updateNosposField('#customer-address1',   enteredAddr1);
      if (finalAddr2     !== d.address2)   updateNosposField('#customer-address2',   finalAddr2);
      if (enteredTown    !== d.town)       updateNosposField('#customer-address3',   enteredTown);
      if (finalCounty    !== d.county)     updateNosposField('#customer-address4',   finalCounty);
      if (finalDob       !== d.dob)        updateNosposField('#customer-dob',         finalDob);
      if (finalGender    !== d.gender)     updateNosposField('#customer-gender',      finalGender);
      updateNosposCheckbox('#customer-email_marketing_ok', finalEmailMkt);
      updateNosposCheckbox('#customer-sms_marketing_ok',   finalSmsMkt);
      updateNosposCheckbox('#customer-direct_mail_ok',     finalMailMkt);

      // ── Build changes log (fields the user explicitly updated) ────────────
      var changes = [];
      if (enteredPhone && enteredPhone !== d.mobile)   changes.push({ field: 'Phone',      from: d.mobile,   to: enteredPhone });
      if (enteredEmail && enteredEmail !== d.email)    changes.push({ field: 'Email',      from: d.email,    to: enteredEmail });
      if (enteredPost  && enteredPost  !== d.postcode) changes.push({ field: 'Postcode',   from: d.postcode, to: enteredPost  });
      if (enteredAddr1 && enteredAddr1 !== d.address1) changes.push({ field: 'Address 1',  from: d.address1, to: enteredAddr1 });
      if (enteredTown  !== d.town)                     changes.push({ field: 'Town',        from: d.town,     to: enteredTown  });

      var customer = {
        nosposCustomerId: extractNosposCustomerIdFromPath(),
        forename:       finalForename,
        surname:        finalSurname,
        dob:            finalDob,
        gender:         finalGender,
        mobile:         enteredPhone || d.mobile,
        homePhone:      d.homePhone,
        email:          enteredEmail || d.email,
        address1:       enteredAddr1 || d.address1,
        address2:       finalAddr2,
        town:           enteredTown,
        county:         finalCounty,
        postcode:       enteredPost  || d.postcode,
        emailMarketing: finalEmailMkt,
        smsMarketing:   finalSmsMkt,
        mailMarketing:  finalMailMkt,
        // Transaction history stats
        lastTransacted:    d.lastTransacted,
        joined:            d.joined,
        buyBackRate:       d.buyBackRate,
        buyBackRateRaw:    d.buyBackRateRaw,
        renewRate:         d.renewRate,
        renewRateRaw:      d.renewRateRaw,
        cancelRate:        d.cancelRate,
        cancelRateRaw:     d.cancelRateRaw,
        faultyRate:        d.faultyRate,
        faultyRateRaw:     d.faultyRateRaw,
        buyingCount:       d.buyingCount,
        salesCount:        d.salesCount,
      };
      customer.name    = (customer.forename + ' ' + customer.surname).trim();
      customer.phone   = customer.mobile || customer.homePhone;
      customer.address = [customer.address1, customer.address2, customer.town, customer.county, customer.postcode].filter(Boolean).join(', ');
      if (bypassReason) {
        customer.bypassReason = bypassReason;
        changes.push({ field: 'Bypass', from: '', to: bypassReason });
      }

      // Find the nospos Save button
      var saveBtn = document.querySelector('.card-footer .btn-blue') ||
        document.querySelector('.card-footer button');

      if (!saveBtn) {
        // No save button found — send directly without saving
        chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_DONE', requestId: requestId, cancelled: false, customer: customer, changes: changes }).catch(function () {});
        overlay.remove();
        return;
      }

      // Store data in sessionStorage so we can retrieve it after the page reloads
      try {
        sessionStorage.setItem('cgCustomerPending', JSON.stringify({ requestId: requestId, customer: customer, changes: changes }));
      } catch (e) {}

      // Show saving state
      useBtn.textContent = 'Saving…';
      useBtn.disabled = true;
      useBtn.style.opacity = '0.7';
      var bypassBtnEl = document.getElementById('cg-customer-bypass');
      if (bypassBtnEl) { bypassBtnEl.disabled = true; bypassBtnEl.style.opacity = '0.5'; }

      var saveFailedHandled = false;
      var saveTimeout = null;

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
          chrome.runtime.sendMessage({
            type: 'NOSPOS_CUSTOMER_DONE',
            requestId: pending.requestId,
            cancelled: false,
            customer: pending.customer,
            changes: pending.changes || [],
            saveFailed: true
          }).catch(function () {});
        }
        overlay.remove();
        showSaveFailedPanel(errorMsg);
      }

      function onBeforeUnload() { clearTimeout(saveTimeout); }

      var observer = null;
      observer = new MutationObserver(function () {
        if (saveFailedHandled) return;
        var err = extractNosposErrorText();
        if (err) handleSaveFailed(err);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Fallback: if nospos doesn't reload within 4 s, assume save failed (e.g. network error)
      saveTimeout = setTimeout(function () { handleSaveFailed(''); }, 4000);

      window.addEventListener('beforeunload', onBeforeUnload);

      saveBtn.click();
    }

    document.getElementById('cg-customer-use').addEventListener('click', function () {
      if (!validateVerifyFields()) return;
      proceedWithCustomerData();
    });

    var bypassBtn = document.getElementById('cg-customer-bypass');
    if (bypassBtn) {
      bypassBtn.addEventListener('click', function () {
        proceedWithCustomerData('14 days ago');
      });
    }

    document.getElementById('cg-customer-cancel').addEventListener('click', function () {
      overlay.remove();
      window.location.href = '/customers';
    });
  }

  function onCustomerDetailPageLoad() {
    // After a successful nospos save the page reloads — pick up the stored data
    var pending = null;
    try {
      var raw = sessionStorage.getItem('cgCustomerPending');
      if (raw) {
        pending = JSON.parse(raw);
        sessionStorage.removeItem('cgCustomerPending');
        sessionStorage.removeItem('cgWaitingForTownFix');
      }
    } catch (e) {}

    if (pending && pending.requestId) {
      chrome.runtime.sendMessage({
        type: 'NOSPOS_CUSTOMER_DONE',
        requestId: pending.requestId,
        cancelled: false,
        customer: pending.customer,
        changes: pending.changes || []
      }).catch(function () {});
      return; // don't show the modal again
    }

    // If the user was prompted to fill in the town field and has now saved
    // the NosPos form natively (without going through the CG modal save flow),
    // detect the populated town and switch back to the system tab.
    var townFixPending = null;
    try {
      var rawTownFix = sessionStorage.getItem('cgWaitingForTownFix');
      if (rawTownFix) { townFixPending = JSON.parse(rawTownFix); }
    } catch (e) {}

    if (townFixPending && townFixPending.requestId) {
      var townEl = document.querySelector('#customer-address3');
      var currentTown = townEl ? (townEl.value || '').trim() : '';
      if (currentTown) {
        sessionStorage.removeItem('cgWaitingForTownFix');
        var customer = scrapeCustomerForm();
        customer.nosposCustomerId = extractNosposCustomerIdFromPath();
        customer.name    = (customer.forename + ' ' + customer.surname).trim();
        customer.phone   = customer.mobile || customer.homePhone;
        customer.address = [customer.address1, customer.address2, customer.town, customer.county, customer.postcode].filter(Boolean).join(', ');
        chrome.runtime.sendMessage({
          type: 'NOSPOS_CUSTOMER_DONE',
          requestId: townFixPending.requestId,
          cancelled: false,
          customer: customer,
          changes: [{ field: 'Town', from: '', to: currentTown }]
        }).catch(function () {});
        return;
      }
      // Town still empty — fall through to show the modal again
    }

    // Normal flow: show modal
    chrome.runtime.sendMessage({ type: 'NOSPOS_CUSTOMER_DETAIL_READY' }, function (response) {
      if (response && response.ok && response.requestId) {
        showCustomerDetailModal(response.requestId);
      } else {
        // Background no longer has a pending entry — clear any stale flag
        sessionStorage.removeItem('cgWaitingForTownFix');
      }
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
