/**
 * Background fetch of NosPos stock search by barcode (no tab switch).
 *
 * Retry/backoff/login-detection lives in `nosposCredentialedHtmlFetch`
 * (bg/nospos-html.js); this action is just URL construction + result parsing.
 *
 * Direct stock-edit hits (when NosPos auto-redirects a single-match search)
 * are detected and parsed via `parseNosposStockEditResult` so the caller sees
 * the same result shape regardless of which page NosPos served. The URL shape
 * is only a hint — a redirect to `/stock/{id}` (no `/edit`), or with a
 * fragment/extra query NosPos appends, used to fall through to the search-table
 * parser and come back with **zero rows**, which callers then reported as
 * "not on NosPos" for an item that plainly exists. So when the table parse
 * finds nothing we always retry the page as a stock-edit page before giving up.
 *
 * Every call is written to the upload diagnostic log (`logUpload`) so the
 * uploader's downloadable log explains *why* a barcode was skipped instead of
 * leaving the operator to guess.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

async function handleBridgeAction_searchNosposBarcode({ requestId, appTabId, payload }) {
  const barcode = (payload.barcode || '').trim();
  if (!barcode) return { ok: false, error: 'No barcode provided' };

  const searchUrl = `https://nospos.com/stock/search/index?StockSearchAndFilter[query]=${encodeURIComponent(barcode)}&sort=-quantity`;
  const startedAt = Date.now();
  const r = await nosposCredentialedHtmlFetch(searchUrl);
  if (r.loginRequired) {
    logUpload('searchNosposBarcode', 'login-required', { barcode }, 'NosPos redirected to login');
    return { ok: false, loginRequired: true };
  }
  if (!r.ok) {
    logUpload('searchNosposBarcode', 'fetch-failed', { barcode, error: r.error }, r.error || 'fetch failed');
    // `retryable` tells the caller this is a transport problem (throttle, 5xx,
    // network blip) — NOT evidence the barcode is missing from NosPos.
    return { ok: false, error: r.error, retryable: true };
  }

  try {
    const isDirectStockEditHit = /nospos\.com\/stock\/\d+(\/edit)?\/?([?#].*)?$/i.test(r.finalUrl);
    let results = isDirectStockEditHit
      ? parseNosposStockEditResult(r.html, r.finalUrl)
      : parseNosposSearchResults(r.html);
    let parsedAs = isDirectStockEditHit ? 'stock-edit' : 'search-table';

    // Nothing from the first parser — try the other one before concluding the
    // barcode isn't on NosPos. Covers redirect shapes the URL test misses and
    // search-table markup changes that break the row regex.
    if (results.length === 0) {
      const fallback = isDirectStockEditHit
        ? parseNosposSearchResults(r.html)
        : parseNosposStockEditResult(r.html, r.finalUrl);
      if (fallback.length > 0) {
        results = fallback;
        parsedAs = isDirectStockEditHit ? 'search-table (fallback)' : 'stock-edit (fallback)';
      }
    }

    logUpload(
      'searchNosposBarcode',
      results.length > 0 ? 'ok' : 'no-results',
      {
        barcode,
        finalUrl: r.finalUrl,
        parsedAs,
        resultCount: results.length,
        barserials: results.slice(0, 5).map(function (x) { return x.barserial; }),
        ms: Date.now() - startedAt,
      },
      results.length + ' result(s)'
    );
    return { ok: true, results, finalUrl: r.finalUrl, parsedAs };
  } catch (e) {
    logUpload('searchNosposBarcode', 'parse-failed', { barcode, error: e?.message }, 'parse threw');
    return { ok: false, error: e?.message || 'Search failed', retryable: true };
  }
}
