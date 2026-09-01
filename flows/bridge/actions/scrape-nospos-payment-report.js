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

/**
 * A backstop, not a budget.
 *
 * This used to be 200 — 20,000 payments — and a busy branch asked for two
 * months blew straight through it, ending the walk with "pagination loop
 * suspected" and losing the whole capture. The window an operator asks for is
 * their business; a page count is not evidence of a loop.
 *
 * A real loop is detected properly below, so this only exists to stop an
 * unbounded walk if that detection is ever wrong.
 */
const NOSPOS_PAYMENT_REPORT_MAX_PAGES = 5000;

/**
 * How many consecutive pages may come back holding nothing we have not already
 * read before we call it a loop.
 *
 * One such page is ordinary: the report is live, so a payment taken mid-walk can
 * shift rows across a page boundary and a page can legitimately repeat its
 * predecessor entirely. Three in a row is not ordinary — it means the pagination
 * is handing back the same page whatever we ask for.
 *
 * Only the first pass uses this. A repair pass expects familiar rows by
 * definition — see `walkOnce`.
 */
const NOSPOS_PAYMENT_REPORT_MAX_STALE_PAGES = 3;

/**
 * How many extra passes over the report we will make to close a shortfall.
 *
 * A pass is cheap next to the walk it repairs, and two of them is plenty: each
 * one re-reads the whole report against the SAME seen-set, so a row the first
 * pass stepped over is picked up by the second whatever position it has moved
 * to. If two more passes still cannot make the count, the gap is not a shuffle
 * and no number of retries will close it — say so instead of pretending.
 */
const NOSPOS_PAYMENT_REPORT_MAX_REPAIR_PASSES = 2;

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
  // A DETERMINISTIC order, and the single most important parameter here.
  //
  // Left to its default the report comes back ordered by time, which is not a
  // key: payments taken in the same second have no defined order between them,
  // and NosPos is free to return them differently on every request. Page 4 is
  // then not "rows 301-400 of one list" but "rows 301-400 of whatever list it
  // built this time", and a row that moved from the top of page 4 to the bottom
  // of page 3 between the two fetches is never seen by either — silently, with
  // nothing on screen to say a row went missing.
  //
  // That is not hypothetical. The 27 Jul - 27 Aug stage came back 1701 rows
  // with payment ids 263109, 263110 and 264075 simply absent from the middle of
  // an otherwise unbroken run, and the capture order showed whole page-fuls of
  // 21, 24 and 25 Aug arriving after 26 Aug had already been read. The three
  // lost rows were £558 of sales and £60 of refunds, and they were the whole of
  // that stage's disagreement with NosPos's own trading report.
  //
  // Sorting by id fixes it at the source: ids are unique and never change, so
  // the list is stable, and a payment taken mid-walk is appended after
  // everything we have already read rather than shoved into the middle of it.
  // `verifyCount` below is the backstop for if NosPos ever ignores this.
  params.set('sort', 'id');
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
 * How many rows the report says it holds, from the grid's own summary line.
 *
 * Yii2 renders `Showing <b>1-100</b> of <b>1,704</b> items.` above every
 * paginated grid, and that number is the report's own count of what matched the
 * filter. It is the only independent check we have that a walk read everything:
 * counting the pages proves nothing, and neither does finishing without an
 * error, because a skipped row raises neither.
 *
 * Returns 0 when the line cannot be read — an unreadable summary must not be
 * mistaken for a report holding nothing.
 */
function parseNosposGridTotal(html) {
  if (!html) return 0;
  const block = String(html).match(/<div\b[^>]*\bclass="[^"]*\bsummary\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!block) return 0;
  const text = nosposPaymentCellText(block[1]);
  // "Showing 1-100 of 1,704 items" — the count is the number after "of".
  const match = text.match(/\bof\b\s*([\d,]+)/i);
  if (!match) return 0;
  const total = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(total) && total > 0 ? total : 0;
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
  // What the report itself says it holds, read off the grid's summary line on
  // every page. Kept as the highest number seen: the report is live, so a
  // payment taken mid-walk raises it, and the walk has to reach the new figure
  // rather than the one page 1 happened to quote.
  let reportedTotal = 0;
  let pages = 0;
  // Set when the walk ended early - an abort, a fetch failure, a pagination
  // loop. Carries the exact response to hand back, so one bail-out path serves
  // the first pass and every repair pass after it.
  let bail = null;

  /**
   * One pass over every page of the report, adding only rows not already read.
   *
   * A repair pass differs in one way: it expects most of what it sees to be
   * familiar, so the "nothing new on this page" loop detector is off. Leaving it
   * on would abort the repair after three pages every single time, since the
   * rows it is walking past are exactly the ones the first pass already banked.
   */
  const walkOnce = async ({ repair = false } = {}) => {
    let hasMore = true;
    let page = 0;
    let stalePages = 0;
    while (hasMore) {
      // Checked before each page rather than after the walk: a report that runs
      // to two hundred pages must stop within one fetch of being told to.
      if (nosposAbort.isAborted(appTabId)) {
        bail = { ok: false, aborted: true, error: `Stopped — ${nosposAbort.reasonFor(appTabId) || 'the page that started this went away'}.`, rows, tabId };
        return;
      }
      page += 1;
      pages += 1;
      const url = nosposPaymentReportUrl(page, fromDate, toDate);
      if (page > NOSPOS_PAYMENT_REPORT_MAX_PAGES) {
        bail = {
          ok: false,
          error: `Aborted after ${NOSPOS_PAYMENT_REPORT_MAX_PAGES} pages — far past any real report.`,
          rows,
          tabId,
        };
        return;
      }

      const r = await nosposCredentialedHtmlFetch(url);
      if (r.loginRequired) { bail = { ok: false, loginRequired: true, tabId }; return; }
      if (!r.ok) { bail = { ok: false, error: r.error, rows, pages: pages - 1, tabId }; return; }

      reportedTotal = Math.max(reportedTotal, parseNosposGridTotal(r.html));
      const pageRows = parseNosposPaymentReportRows(r.html);
      // The report is live: a payment taken mid-walk shifts every later row,
      // which would otherwise re-read the same payment on the next page. Key
      // off the row id.
      const fresh = pageRows.filter((row) => row.key && !seen.has(row.key));
      fresh.forEach((row) => seen.add(row.key));
      rows.push(...fresh);

      // What a pagination loop actually looks like: pages keep arriving, and not
      // one row on them is new. Counting pages could not tell that apart from a
      // genuinely long report, which is why a big window used to be refused.
      if (!repair && pageRows.length > 0 && fresh.length === 0) {
        stalePages += 1;
        if (stalePages >= NOSPOS_PAYMENT_REPORT_MAX_STALE_PAGES) {
          bail = {
            ok: false,
            error: `Stopped at page ${page} — the report kept returning rows already read, so its pagination is looping.`,
            rows,
            pages,
            tabId,
          };
          return;
        }
      } else {
        stalePages = 0;
      }

      // Only used as a yes/no — the URL itself is ours (see nosposPaymentReportUrl).
      // A page that came back with no rows also ends the walk, so a filter that
      // matches nothing can't spin on a stale "next" link.
      hasMore = Boolean(parseNosposPaginationNextHref(r.html, r.finalUrl)) && pageRows.length > 0;
      // A repair pass exists only to close a shortfall. Once the count is made
      // there is nothing left to find, so it stops rather than reading out the
      // rest of the report for the sake of it.
      if (repair && reportedTotal && rows.length >= reportedTotal) hasMore = false;
      emitProgress({ page: pages, rows: fresh, total: rows.length, hasMore });
    }
  };

  await walkOnce();
  if (bail) return bail;

  // ── Did we actually read the whole report? ──────────────────────────────
  //
  // Finishing without an error does not answer that, and neither does the page
  // count: a row skipped because the report reordered itself between two fetches
  // raises nothing anywhere. The grid's own summary is the only independent
  // count there is, so it is compared, and a shortfall is walked again against
  // the same seen-set until it closes.
  //
  // Missing rows are not a cosmetic problem. Three of them — £558 of sales and
  // £60 of refunds — were the entire disagreement between the 27 Jul - 27 Aug
  // stage and NosPos's trading report for the same window, and nothing in the
  // capture said a word about it.
  let repairs = 0;
  while (reportedTotal && rows.length < reportedTotal
         && repairs < NOSPOS_PAYMENT_REPORT_MAX_REPAIR_PASSES) {
    repairs += 1;
    console.warn('[CG Suite] payment report short, re-reading', {
      have: rows.length, expected: reportedTotal, pass: repairs,
    });
    // eslint-disable-next-line no-await-in-loop
    await walkOnce({ repair: true });
    if (bail) return bail;
  }

  // Still short. The capture is NOT ok — a window missing payments produces a
  // trading report that disagrees with NosPos for a reason no one can see from
  // the figures, and half a window silently accepted is worse than a window
  // that says it failed. The rows we did get travel with the failure so the
  // caller can still show them.
  if (reportedTotal && rows.length < reportedTotal) {
    return {
      ok: false,
      error: `Read ${rows.length} of the ${reportedTotal} payments NosPos lists for `
        + `${fromDate} to ${toDate} — ${reportedTotal - rows.length} row(s) could not be `
        + 'reached after ' + repairs + ' further pass(es). Try the capture again.',
      rows,
      pages,
      expected: reportedTotal,
      missing: reportedTotal - rows.length,
      tabId,
      fromDate,
      toDate,
    };
  }

  console.log('[CG Suite] payment report scraped', {
    pages, rows: rows.length, expected: reportedTotal, repairs, fromDate, toDate,
  });
  // `expected` travels even on success so the migration screen can say what it
  // checked against, and 0 honestly means "the report did not tell us".
  return { ok: true, rows, pages, expected: reportedTotal, repairs, tabId, fromDate, toDate };
}
