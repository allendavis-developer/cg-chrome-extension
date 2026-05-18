/**
 * Background scrape of every page of NosPos /stock/search/index filtered to
 * `Manually Listed = Yes` (i.e. NosPos column `externally_listed = 1`).
 *
 * Equivalent to a user opening /stock/search, expanding Filter, picking
 * "Manually Listed = Yes", pressing Apply, then clicking » until disabled —
 * but routed through the same credentialed background fetch path as
 * `searchNosposBarcode` so no tab is opened.
 *
 * Streams a `{ page, rows, hasMore }` payload after every page so the modal
 * can render rows as soon as each page lands instead of waiting for the
 * full walk. Hard cap of 500 pages so a malformed pagination tag can never
 * spin the worker forever.
 *
 * All retry/backoff/login-detection lives in `nosposCredentialedHtmlFetch`,
 * and pagination parsing lives in `parseNosposPaginationNextHref` — both in
 * bg/nospos-html.js.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

const NOSPOS_LISTED_STOCK_START_URL =
  'https://nospos.com/stock/search/index?StockSearchAndFilter%5Bexternally_listed%5D=1';
const NOSPOS_LISTED_STOCK_MAX_PAGES = 500;

async function handleBridgeAction_scrapeNosposListedStockPage({ requestId, appTabId }) {
  const emitProgress = (data) => {
    if (!appTabId) return;
    chrome.tabs
      .sendMessage(appTabId, { type: 'EXTENSION_PROGRESS_TO_PAGE', requestId, payload: data })
      .catch(() => { /* app tab may be gone; not fatal */ });
  };

  let url = NOSPOS_LISTED_STOCK_START_URL;
  let page = 0;

  while (url) {
    page += 1;
    if (page > NOSPOS_LISTED_STOCK_MAX_PAGES) {
      return { ok: false, error: `Aborted after ${NOSPOS_LISTED_STOCK_MAX_PAGES} pages — pagination loop suspected.` };
    }

    const r = await nosposCredentialedHtmlFetch(url);
    if (r.loginRequired) return { ok: false, loginRequired: true };
    if (!r.ok) return { ok: false, error: r.error, pages: page - 1 };

    const rows = parseNosposSearchResults(r.html);
    const nextUrl = parseNosposPaginationNextHref(r.html, r.finalUrl);

    emitProgress({ page, rows, hasMore: !!nextUrl });
    url = nextUrl;
  }

  return { ok: true, pages: page };
}
