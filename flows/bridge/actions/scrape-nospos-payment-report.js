/**
 * Open NosPos's payment management report in a BACKGROUND tab and scrape every
 * page of it.
 *
 * Two separate jobs, deliberately done two different ways:
 *
 *   1. **The tab** is opened inactive, in the app's own window, and focus is
 *      handed straight back to Cash EPOS (same treatment as the jewellery-scrap
 *      and Web EPOS worker tabs). The operator asked to *have* the NosPos page,
 *      not to be *sent* to it — so it sits there for them to switch to when they
 *      want, and never steals the screen mid-migration.
 *   2. **The data** comes from the same credentialed background fetch walk the
 *      listed-stock scrape uses, not from driving that tab. Clicking » and
 *      waiting for renders is slower, and it fights the operator for the tab if
 *      they do switch to it. Fetching also gets retry/backoff and login
 *      detection for free from `nosposCredentialedHtmlFetch`.
 *
 * `per-page=100` cuts a day's payments from ~dozens of pages to a handful.
 * Rows stream page-by-page through EXTENSION_PROGRESS_TO_PAGE so the migration
 * table fills as the walk runs.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

const NOSPOS_PAYMENT_REPORT_URL = 'https://nospos.com/reports/management/payment';
const NOSPOS_PAYMENT_REPORT_MAX_PAGES = 200;

/**
 * The report URL for one page, with the date filter applied.
 *
 * Built from our own parameters every time rather than followed from the page's
 * "next" link. NosPos's pagination links carry only `page=` — drop back to them
 * and both `per-page=100` AND the date filter fall off on page 2, which would
 * quietly scrape the entire report while looking like it respected the dates.
 * The page's next link is still read, but only to answer "is there another
 * page", never to decide which URL that page is.
 *
 * The empty type/method/till/createdBy parameters mirror what the NosPos filter
 * form itself submits.
 */
function nosposPaymentReportUrl(page, fromDate, toDate) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('per-page', '100');
  params.set('PaymentSearch[fromDate]', fromDate || '');
  params.set('PaymentSearch[toDate]', toDate || '');
  params.set('PaymentSearch[type]', '');
  params.set('PaymentSearch[method]', '');
  params.set('PaymentSearch[till]', '');
  params.set('PaymentSearch[tillStatus]', '');
  params.set('PaymentSearch[createdBy]', '');
  return `${NOSPOS_PAYMENT_REPORT_URL}?${params.toString()}`;
}

/** Tag soup → plain text: strip tags, decode the entities NosPos actually emits. */
function nosposPaymentCellText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&pound;/gi, '£')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&hellip;/gi, '\u2026')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The row's "View …" target (`/newsales/cart/49067/view`, `/agreement/view?id=…`,
 * `/customer/4838/store-credit`). The first `<a href>` in the row's action cell
 * that isn't the dropdown toggle (`href="#"`).
 */
function nosposPaymentRelatedHref(rowHtml) {
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let match;
  while ((match = re.exec(rowHtml)) !== null) {
    const href = match[1].replace(/&amp;/g, '&').trim();
    if (!href || href === '#') continue;
    if (/\/management\/till\/modify/i.test(href)) continue; // that's the Till cell
    // A manual payment has no record behind it, so the only href left in its
    // action cell is the receipt. Returning that would make the crawl treat a
    // PDF as the transaction the money belongs to.
    if (/\/protected-file\/view/i.test(href)) continue;
    return href.startsWith('http') ? href : `https://nospos.com${href}`;
  }
  return '';
}

/**
 * The till a payment happened at, as an id rather than a name.
 *
 * The Till cell is a LINK — `<a href="/management/till/modify?id=4">BUYING01</a>`
 * — and only the text was being kept. Names are per branch and get edited; the
 * id is the stable handle, and without it every payment would have to be
 * matched back to a drawer by string comparison.
 */
function nosposPaymentTillId(cellHtml) {
  const match = String(cellHtml || '').match(/\/management\/till\/modify\?id=(\d+)/i);
  return match ? match[1] : '';
}

/**
 * The receipt attached to a manual payment, if one has been uploaded.
 *
 * NosPos shows a live file icon linking `/protected-file/view?id=N` where a
 * receipt exists and a disabled one where it does not, which is exactly the
 * distinction that matters: petty cash without a receipt is an unexplained hole
 * in a drawer. Kept as its own field rather than left to be mistaken for the
 * row's related record — `nosposPaymentRelatedHref` would otherwise return this
 * file link for a Petty row, since such rows have no agreement or cart to point
 * at and the file is the only href left standing.
 */
function nosposPaymentReceiptFileId(rowHtml) {
  const match = String(rowHtml || '').match(/\/protected-file\/view\?id=(\d+)/i);
  return match ? match[1] : '';
}

/**
 * Parse one page of the payment report.
 *
 * MV3 service workers have no DOMParser, so this is regex over the markup —
 * the same approach as `parseNosposSearchResults`. Rows are identified by
 * `data-key`, which the grid puts on every real row and on nothing else, so
 * header/summary/pagination markup can't be mistaken for data.
 */
function parseNosposPaymentReportRows(html) {
  const rows = [];
  if (!html) return rows;
  const rowRe = /<tr\b[^>]*\bdata-key="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const key = rowMatch[1];
    const rowHtml = rowMatch[2] || '';
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 8) continue;
    rows.push({
      key,
      id: nosposPaymentCellText(cells[0]),
      related: nosposPaymentCellText(cells[1]),
      type: nosposPaymentCellText(cells[2]),
      method: nosposPaymentCellText(cells[3]),
      amount: nosposPaymentCellText(cells[4]),
      till: nosposPaymentCellText(cells[5]),
      // Additive fields — an older Cash EPOS build simply ignores them.
      nospos_till_id: nosposPaymentTillId(cells[5]),
      created: nosposPaymentCellText(cells[6]),
      created_by: nosposPaymentCellText(cells[7]),
      related_href: nosposPaymentRelatedHref(cells[8] || ''),
      receipt_file_id: nosposPaymentReceiptFileId(cells[8] || ''),
    });
  }
  return rows;
}

/** Inactive tab in the app's window, focus handed back — never a focus steal. */
async function openNosposPaymentReportTab(appTabId, url) {
  let windowId = null;
  if (appTabId) {
    try {
      const t = await chrome.tabs.get(appTabId);
      windowId = t.windowId;
    } catch (_) {}
  }
  if (windowId == null) {
    try {
      const w = await chrome.windows.getLastFocused({ populate: false });
      windowId = w?.id ?? null;
    } catch (_) {}
  }
  const createOpts = { url, active: false };
  if (windowId != null) createOpts.windowId = windowId;
  const tab = await chrome.tabs.create(createOpts);
  if (typeof disableTabAutoDiscard === 'function') await disableTabAutoDiscard(tab.id);
  await putTabInYellowGroup(tab.id);
  if (appTabId) await focusAppTab(appTabId);
  return tab.id;
}

async function handleBridgeAction_scrapeNosposPaymentReport({ requestId, appTabId, pageInstanceId, payload }) {
  const emitProgress = (data) => {
    if (!appTabId) return;
    chrome.tabs
      .sendMessage(appTabId, { type: 'EXTENSION_PROGRESS_TO_PAGE', requestId, payload: data })
      .catch(() => { /* app tab may be gone; not fatal */ });
  };

  const fromDate = String(payload?.fromDate || '').trim();
  const toDate = String(payload?.toDate || '').trim();

  let tabId = null;
  // The tab is a convenience, not the data path: if it can't be opened (popup
  // limits, a closing window) the scrape still runs rather than failing the
  // whole migration over a tab nobody has looked at yet. It shows the same
  // filtered view the scrape reads, so the two can be compared by eye.
  if (payload?.openTab !== false) {
    try {
      tabId = await openNosposPaymentReportTab(appTabId, nosposPaymentReportUrl(1, fromDate, toDate));
    } catch (err) {
      console.warn('[CG Suite] payment report: could not open background tab', err);
    }
  }

  nosposAbort.begin(appTabId, pageInstanceId);

  const rows = [];
  const seen = new Set();
  let hasMore = true;
  let page = 0;

  while (hasMore) {
    // Checked before each page rather than after the walk: a report that runs
    // to two hundred pages must stop within one fetch of being told to.
    if (nosposAbort.isAborted(appTabId)) {
      return { ok: false, aborted: true, error: `Stopped — ${nosposAbort.reasonFor(appTabId) || 'the page that started this went away'}.`, rows, tabId };
    }
    page += 1;
    const url = nosposPaymentReportUrl(page, fromDate, toDate);
    if (page > NOSPOS_PAYMENT_REPORT_MAX_PAGES) {
      return {
        ok: false,
        error: `Aborted after ${NOSPOS_PAYMENT_REPORT_MAX_PAGES} pages — pagination loop suspected.`,
        rows,
        tabId,
      };
    }

    const r = await nosposCredentialedHtmlFetch(url);
    if (r.loginRequired) return { ok: false, loginRequired: true, tabId };
    if (!r.ok) return { ok: false, error: r.error, rows, pages: page - 1, tabId };

    const pageRows = parseNosposPaymentReportRows(r.html);
    // The report is ordered newest-first and live: a payment taken mid-walk
    // shifts every later row one page down, which would otherwise re-read the
    // same payment on the next page. Key off the row id.
    const fresh = pageRows.filter((row) => row.key && !seen.has(row.key));
    fresh.forEach((row) => seen.add(row.key));
    rows.push(...fresh);

    // Only used as a yes/no — the URL itself is ours (see nosposPaymentReportUrl).
    // A page that came back with no rows also ends the walk, so a filter that
    // matches nothing can't spin on a stale "next" link.
    hasMore = Boolean(parseNosposPaginationNextHref(r.html, r.finalUrl)) && pageRows.length > 0;
    emitProgress({ page, rows: fresh, total: rows.length, hasMore });
  }

  console.log('[CG Suite] payment report scraped', { pages: page, rows: rows.length, fromDate, toDate });
  return { ok: true, rows, pages: page, tabId, fromDate, toDate };
}
