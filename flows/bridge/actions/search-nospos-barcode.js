/**
 * Background fetch of NosPos stock search by barcode (no tab switch).
 *
 * Retry/backoff/login-detection lives in `nosposCredentialedHtmlFetch`
 * (bg/nospos-html.js); this action is just URL construction + result parsing.
 *
 * Direct stock-edit hits (when NosPos auto-redirects a single-match search)
 * are detected and parsed via `parseNosposStockEditResult` so the caller sees
 * the same result shape regardless of which page NosPos served.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

async function handleBridgeAction_searchNosposBarcode({ requestId, appTabId, payload }) {
  const barcode = (payload.barcode || '').trim();
  if (!barcode) return { ok: false, error: 'No barcode provided' };

  const searchUrl = `https://nospos.com/stock/search/index?StockSearchAndFilter[query]=${encodeURIComponent(barcode)}&sort=-quantity`;
  const r = await nosposCredentialedHtmlFetch(searchUrl);
  if (r.loginRequired) return { ok: false, loginRequired: true };
  if (!r.ok) return { ok: false, error: r.error };

  try {
    const isDirectStockEditHit = /^https:\/\/[^/]*nospos\.com\/stock\/\d+\/edit\/?(\?.*)?$/i.test(r.finalUrl);
    const results = isDirectStockEditHit
      ? parseNosposStockEditResult(r.html, r.finalUrl)
      : parseNosposSearchResults(r.html);
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e?.message || 'Search failed' };
  }
}
