/**
 * NosPos HTML fetch, parse, and login detection utilities.
 * Globals: NOSPOS_HTML_FETCH_HEADERS, nosposHtmlFetchIndicatesNotLoggedIn,
 *          nosposCredentialedHtmlFetch, decodeNosposHtmlText,
 *          getStockNameFromEditHtml, parseNosposSearchResults,
 *          parseNosposStockEditResult, parseNosposPaginationNextHref,
 *          normalizeNosposStockEditUrl, parseNosposStockEditPageDetails,
 *          parseNosposStockEditPageChangeLog, handleFetchAddressSuggestions,
 *          parseNosposBranchName, normalizeCgShopName, nosposShopMatchesCgShop,
 *          nosposCheckLoginAndShop
 */

var NOSPOS_HTML_FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/**
 * Credentialed background fetch of a NosPos page with the standard retry/backoff
 * policy used everywhere we read NosPos HTML (search results, stock edit pages,
 * pagination walks). Hardened against transient 429 / 5xx so callers don't have
 * to re-implement the same loop.
 *
 *   429 / 5xx / network error → retry up to 3 attempts with exponential backoff
 *     (400ms, 900ms, 1600ms) plus jitter. Honour `Retry-After` when sent.
 *   401 / 403 / login-redirect → stop immediately; `loginRequired: true`.
 *   Other 4xx → stop with `error: "NosPos returned 4xx"`.
 *
 * @param {string} url Absolute NosPos URL to fetch.
 * @returns {Promise<{ ok: true, html: string, finalUrl: string }
 *   | { ok: false, loginRequired: true }
 *   | { ok: false, error: string }>}
 */
var NOSPOS_HTML_FETCH_RETRY_DELAYS_MS = [400, 900, 1600];

function nosposHtmlFetchParseRetryAfter(headerValue) {
  if (!headerValue) return null;
  var raw = String(headerValue).trim();
  if (!raw) return null;
  var asInt = Number.parseInt(raw, 10);
  if (Number.isFinite(asInt) && String(asInt) === raw) {
    return Math.min(Math.max(asInt * 1000, 0), 10000);
  }
  var ts = Date.parse(raw);
  if (Number.isFinite(ts)) {
    return Math.min(Math.max(ts - Date.now(), 0), 10000);
  }
  return null;
}

function nosposHtmlFetchSleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function nosposCredentialedHtmlFetch(url) {
  var lastError = null;
  for (var attempt = 0; attempt <= NOSPOS_HTML_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    var response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        headers: NOSPOS_HTML_FETCH_HEADERS,
      });
    } catch (e) {
      lastError = e?.message || 'Network error';
      if (attempt < NOSPOS_HTML_FETCH_RETRY_DELAYS_MS.length) {
        var base = NOSPOS_HTML_FETCH_RETRY_DELAYS_MS[attempt];
        await nosposHtmlFetchSleep(base + Math.floor(Math.random() * 200));
        continue;
      }
      return { ok: false, error: lastError };
    }

    var finalUrl = response.url || url;
    if (nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl)) {
      return { ok: false, loginRequired: true };
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = 'NosPos returned ' + response.status;
      if (attempt < NOSPOS_HTML_FETCH_RETRY_DELAYS_MS.length) {
        var hinted = nosposHtmlFetchParseRetryAfter(response.headers?.get?.('Retry-After'));
        var baseDelay = NOSPOS_HTML_FETCH_RETRY_DELAYS_MS[attempt];
        var delay = hinted != null ? Math.max(hinted, baseDelay) : baseDelay + Math.floor(Math.random() * 200);
        await nosposHtmlFetchSleep(delay);
        continue;
      }
      return { ok: false, error: lastError };
    }

    if (!response.ok) {
      return { ok: false, error: 'NosPos returned ' + response.status };
    }

    try {
      var html = await response.text();
      return { ok: true, html: html, finalUrl: finalUrl };
    } catch (e) {
      return { ok: false, error: e?.message || 'Read failed' };
    }
  }

  return { ok: false, error: lastError || 'Fetch failed' };
}

function nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl) {
  var url = (finalUrl || response?.url || '').toLowerCase();
  // Auth signals only:
  //   - URL was redirected to a NosPos login/2FA page
  //   - HTTP 401/403
  // Everything else (5xx, 429 throttling, transient network) is NOT a login problem and
  // must propagate as a normal error so callers can retry instead of nagging the user to
  // re-log in. The previous "any non-2xx → loginRequired" rule turned every NosPos
  // throttle into a fake "log in to NosPos first" message after ~10 rapid searches.
  if (
    url.includes('/login') ||
    url.includes('/signin') ||
    url.includes('/site/standard-login') ||
    url.includes('/twofactor')
  ) {
    return true;
  }
  var status = Number(response?.status);
  return status === 401 || status === 403;
}

function decodeNosposHtmlText(value) {
  return (value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function getStockNameFromEditHtml(html) {
  var byId = html.match(/<input[^>]+id="stock-name"[^>]*>/i);
  var byName = html.match(/<input[^>]+name="Stock\[name\]"[^>]*>/i);
  var tag = (byId || byName)?.[0] || '';
  var valueMatch = tag.match(/\bvalue="([^"]*)"/i);
  return decodeNosposHtmlText(valueMatch?.[1] || '');
}

function parseNosposSearchResults(html) {
  var results = [];
  var rowRe = /<tr[^>]+data-key="\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  var rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    var rowHtml = rowMatch[1];
    var cells = [];
    var cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    var cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 5) continue;

    var linkMatch = cells[0].match(/<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/i);
    var href = linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : '';
    var barserial = linkMatch ? linkMatch[2].trim() : '';

    var titleAttr = cells[1].match(/(?:data-original-title|title)="([^"]+)"/i);
    var name = titleAttr
      ? decodeNosposHtmlText(titleAttr[1])
      : cells[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    var costPrice = cells[2].replace(/<[^>]*>/g, '').trim();
    var retailPrice = cells[3].replace(/<[^>]*>/g, '').trim();
    var quantity = cells[4].replace(/<[^>]*>/g, '').trim();

    if (barserial || href) {
      results.push({ barserial: barserial, href: href, name: name, costPrice: costPrice, retailPrice: retailPrice, quantity: quantity });
    }
  }
  return results;
}

/**
 * Pull the `<li class="next">` href out of a NosPos pagination block.
 * NosPos paginators wrap the next-page link in `<li class="next">`; the same
 * `<li>` carries `disabled` once you reach the last page (then the inner
 * element is a `<span>` instead of an `<a>`).
 *
 * @param {string} html Page HTML containing a NosPos pagination `<ul>`.
 * @param {string} [baseUrl] URL the pagination href is relative to (e.g. the page's `finalUrl`).
 * @returns {string|null} Absolute next-page URL, or null when there's no next page.
 */
function parseNosposPaginationNextHref(html, baseUrl) {
  if (!html) return null;
  var nextLiRe = /<li\b[^>]*class="([^"]*\bnext\b[^"]*)"[^>]*>([\s\S]*?)<\/li>/i;
  var m = html.match(nextLiRe);
  if (!m) return null;
  var cls = m[1] || '';
  if (/\bdisabled\b/i.test(cls)) return null;
  var aMatch = (m[2] || '').match(/<a\b[^>]*\bhref="([^"]+)"/i);
  if (!aMatch) return null;
  var href = aMatch[1].replace(/&amp;/g, '&').trim();
  if (!href || href === '#') return null;
  try {
    return new URL(href, baseUrl || 'https://nospos.com').toString();
  } catch (_) {
    return null;
  }
}

/** Ensure `/stock/{id}/edit` URL for credentialed fetch of cost/retail + detail rows. */
function normalizeNosposStockEditUrl(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  if (s.indexOf('//') === -1) {
    s = 'https://nospos.com' + (s.charAt(0) === '/' ? s : '/' + s);
  }
  var path;
  try {
    path = new URL(s).pathname.replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
  var m = path.match(/^\/stock\/(\d+)(\/edit)?$/i);
  if (m) return 'https://nospos.com/stock/' + m[1] + '/edit';
  m = path.match(/^\/stock\/(\d+)/i);
  if (m) return 'https://nospos.com/stock/' + m[1] + '/edit';
  return s;
}

/**
 * Stock edit page "Changes" card: table rows ID, Name, Old Value, New Value, Changed, Changed By.
 * @returns {Array<{ changeEntryId: string, columnName: string, oldValue: string, newValue: string, changedAt: string, changedBy: string }>}
 */
function parseNosposStockEditPageChangeLog(html) {
  var out = [];
  var titleIdx = html.search(/<h4[^>]*class="[^"]*card-title[^"]*"[^>]*>\s*Changes\s*<\/h4>/i);
  if (titleIdx === -1) {
    titleIdx = html.search(/class="[^"]*card-title[^"]*"[^>]*>\s*Changes\s*<\/h4>/i);
  }
  if (titleIdx === -1) {
    titleIdx = html.search(/>\s*Changes\s*<\//i);
  }
  if (titleIdx === -1) return out;
  var slice = html.slice(titleIdx, titleIdx + 250000);
  var tableIdx = slice.indexOf('<table');
  if (tableIdx === -1) return out;
  var fromTable = slice.slice(tableIdx);
  var tbodyMatch = fromTable.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return out;
  var tbody = tbodyMatch[1];
  var trRe = /<tr[^>]*data-key="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  var m;
  while ((m = trRe.exec(tbody)) !== null) {
    var rowHtml = m[2];
    var tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    var cells = [];
    var tm;
    while ((tm = tdRe.exec(rowHtml)) !== null) {
      cells.push(decodeNosposHtmlText(tm[1].replace(/<[^>]*>/g, ' ')));
    }
    if (cells.length < 6) continue;
    out.push({
      changeEntryId: String(cells[0] || '')
        .replace(/^#\s*/, '')
        .trim() || String(m[1]),
      columnName: cells[1] || '',
      oldValue: cells[2] || '',
      newValue: cells[3] || '',
      changedAt: cells[4] || '',
      changedBy: cells[5] || '',
    });
  }
  return out;
}

/** From stock edit HTML: name input, detail rows, cost/retail inputs. */
function parseNosposStockEditPageDetails(html) {
  function detailForLabel(label) {
    var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp(
      '<div[^>]*class="[^"]*\\bdetail\\b[^"]*"[^>]*>\\s*<strong>\\s*' + esc + '\\s*</strong>\\s*<span>([\\s\\S]*?)</span>\\s*</div>',
      'i'
    );
    var m = html.match(re);
    return decodeNosposHtmlText((m ? m[1] : '').replace(/<[^>]*>/g, ' '));
  }
  var boughtBy = detailForLabel('Bought By');
  var createdAt = detailForLabel('Created');
  var costM = html.match(/id="stock-cost_price"[^>]*\bvalue="([^"]*)"/i);
  var retailM = html.match(/id="stock-retail_price"[^>]*\bvalue="([^"]*)"/i);
  var quantityM =
    html.match(/id="stock-quantity"[^>]*\bvalue="([^"]*)"/i) ||
    html.match(/<input[^>]+name="Stock\[quantity\]"[^>]*\bvalue="([^"]*)"/i);
  var costPrice = decodeNosposHtmlText(costM ? costM[1] : '');
  var retailPrice = decodeNosposHtmlText(retailM ? retailM[1] : '');
  var quantity = decodeNosposHtmlText(quantityM ? quantityM[1] : '');
  var name = getStockNameFromEditHtml(html);
  var changeLog = parseNosposStockEditPageChangeLog(html);
  // "Manually Listed" checkbox state. Match the input element by id and look
  // for a `checked` attribute inside its tag — NosPos serves this as a plain
  // <input type="checkbox" id="stock-externally_listed_at" ... checked>.
  var extM = html.match(/<input[^>]+id="stock-externally_listed_at"[^>]*>/i);
  var externallyListed = !!(extM && /\bchecked\b/i.test(extM[0]));
  return {
    name: name || '',
    boughtBy: boughtBy || '',
    createdAt: createdAt || '',
    costPrice: costPrice || '',
    retailPrice: retailPrice || '',
    quantity: quantity || '',
    externallyListed: externallyListed,
    changeLog: changeLog,
  };
}

function parseNosposStockEditResult(html, finalUrl) {
  var barserialMatch = html.match(
    /<div[^>]*class="detail"[^>]*>\s*<strong>\s*Barserial\s*<\/strong>\s*<span>([\s\S]*?)<\/span>\s*<\/div>/i
  );
  var barserial = decodeNosposHtmlText(
    (barserialMatch?.[1] || '').replace(/<[^>]*>/g, ' ')
  );
  if (!barserial) return [];

  var href = '';
  try {
    href = new URL(finalUrl).pathname || '';
  } catch (_) {
    href = '';
  }

  var titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  var stockNameFromInput = getStockNameFromEditHtml(html);
  var name = stockNameFromInput || decodeNosposHtmlText((titleMatch?.[1] || '').replace(/\s*-\s*Nospos\s*$/i, ''));

  return [{
    barserial: barserial,
    href: href,
    name: name,
    costPrice: '',
    retailPrice: '',
    quantity: ''
  }];
}

/**
 * Pull the currently-selected branch name out of any NosPos page's navbar.
 * The branch selector is the disabled anchor whose href targets the
 * `#select-branch-modal` — its inner `<span>` holds e.g. "CG Warrington".
 * Returns '' if the navbar isn't present (e.g. fetched a non-app page).
 */
function parseNosposBranchName(html) {
  if (!html) return '';
  var anchorRe = /<a\b[^>]*href="#select-branch-modal"[^>]*>([\s\S]*?)<\/a>/i;
  var anchor = html.match(anchorRe);
  if (!anchor) return '';
  var spanMatch = anchor[1].match(/<span\b[^>]*>([\s\S]*?)<\/span>/i);
  if (!spanMatch) return '';
  return decodeNosposHtmlText(spanMatch[1].replace(/<[^>]*>/g, ' '));
}

/**
 * Canonical form for comparing a CG shop label across systems. Strips a
 * leading or trailing "cg" token, collapses whitespace, lowercases. So
 * "CG Warrington" == "Warrington" == "warrington cg". Punctuation other
 * than spaces is left alone because real shop names don't carry any.
 */
function normalizeCgShopName(name) {
  var s = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.indexOf('cg ') === 0) s = s.slice(3).trim();
  if (s.length > 3 && s.lastIndexOf(' cg') === s.length - 3) s = s.slice(0, -3).trim();
  return s;
}

function nosposShopMatchesCgShop(nosposShop, cgShop) {
  var a = normalizeCgShopName(nosposShop);
  var b = normalizeCgShopName(cgShop);
  if (!a || !b) return false;
  return a === b;
}

/**
 * One-shot credentialed fetch that combines NosPos's login redirect detection
 * with the navbar branch-name parse. Used as a pre-flight before any flow
 * that opens NosPos (customer intake, new-customer create, park agreement) so
 * the user is bounced with a clear message when they're either signed out or
 * looking at the wrong shop on NosPos.
 *
 * `expectedCgShopName` is the human-readable CG store name (e.g. "CG Toxteth").
 * Pass empty/null to skip the shop comparison (e.g. when the extension is
 * older than the website and the website didn't send one).
 *
 * @param {string} url Absolute NosPos URL to probe.
 * @param {string|null|undefined} expectedCgShopName
 * @returns {Promise<{ ok: true, nosposShop: string }
 *   | { ok: false, loginRequired: true }
 *   | { ok: false, shopMismatch: true, nosposShop: string, expectedCgShop: string }
 *   | { ok: false, error: string }>}
 */
async function nosposCheckLoginAndShop(url, expectedCgShopName) {
  var fetched = await nosposCredentialedHtmlFetch(url);
  if (!fetched.ok) return fetched;
  var nosposShop = parseNosposBranchName(fetched.html);
  var expected = String(expectedCgShopName || '').trim();
  if (expected && nosposShop && !nosposShopMatchesCgShop(nosposShop, expected)) {
    return { ok: false, shopMismatch: true, nosposShop: nosposShop, expectedCgShop: expected };
  }
  return { ok: true, nosposShop: nosposShop };
}

async function handleFetchAddressSuggestions(message) {
  var raw = (message.postcode || '').trim().replace(/\s+/g, ' ').replace(/\u00A0/g, ' ');
  var postcode = raw.toUpperCase();
  if (!postcode || postcode.replace(/\s/g, '').length < 4) {
    return { ok: true, addresses: [] };
  }
  var bases = ['http://127.0.0.1:8000', 'http://localhost:8000'];
  for (var i = 0; i < bases.length; i++) {
    var base = bases[i];
    try {
      var url = base + '/api/address-lookup/' + encodeURIComponent(postcode) + '/';
      var resp = await fetch(url);
      if (!resp.ok) {
        var err = await resp.json().catch(function () { return {}; });
        return { ok: false, error: err.error || 'HTTP ' + resp.status };
      }
      var data = await resp.json();
      var addresses = data.addresses || [];
      return { ok: true, addresses: Array.isArray(addresses) ? addresses : [] };
    } catch (e) {
      if (i < bases.length - 1) continue;
      return { ok: false, error: (e?.message || 'Network error') + '. Is Django running at http://127.0.0.1:8000?' };
    }
  }
  return { ok: false, error: 'Could not reach address lookup service' };
}
