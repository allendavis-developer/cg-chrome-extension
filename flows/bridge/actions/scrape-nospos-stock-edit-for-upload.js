/**
 * Fetch a NosPos stock/edit page in the background and return parsed fields for the upload flow.
 *
 * Retry/backoff/login-detection lives in `nosposCredentialedHtmlFetch`
 * (bg/nospos-html.js); this action is just URL normalisation + result parsing.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

async function handleBridgeAction_scrapeNosposStockEditForUpload({ requestId, appTabId, payload }) {
  const stockUrl = String(payload.stockUrl || '').trim();
  if (!stockUrl) return { ok: false, error: 'No stock URL' };
  const editUrl = normalizeNosposStockEditUrl(stockUrl);
  if (!editUrl) return { ok: false, error: 'Invalid stock URL' };

  const r = await nosposCredentialedHtmlFetch(editUrl);
  if (r.loginRequired) return { ok: false, loginRequired: true };
  if (!r.ok) return { ok: false, error: r.error };

  try {
    return { ok: true, details: parseNosposStockEditPageDetails(r.html) };
  } catch (e) {
    return { ok: false, error: e?.message || 'Scrape failed' };
  }
}
