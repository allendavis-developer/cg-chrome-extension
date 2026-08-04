/**
 * Fetch a NosPos stock/edit page in the background and return parsed fields for the upload flow.
 *
 * Retry/backoff/login-detection lives in `nosposCredentialedHtmlFetch`
 * (bg/nospos-html.js); this action is just URL normalisation + result parsing.
 *
 * Failures come back with `retryable: true` when they're transport problems
 * (throttle / 5xx / network). Callers must not read a failed response as
 * "quantity 0" or "not externally listed" — the NosPos ↔ Web EPOS sync used to
 * do exactly that and would then propose writes based on a page it never read.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

async function handleBridgeAction_scrapeNosposStockEditForUpload({ requestId, appTabId, payload }) {
  const stockUrl = String(payload.stockUrl || '').trim();
  if (!stockUrl) return { ok: false, error: 'No stock URL' };
  const editUrl = normalizeNosposStockEditUrl(stockUrl);
  if (!editUrl) return { ok: false, error: 'Invalid stock URL' };

  const r = await nosposCredentialedHtmlFetch(editUrl);
  if (r.loginRequired) {
    logUpload('scrapeNosposStockEditForUpload', 'login-required', { editUrl }, 'NosPos redirected to login');
    return { ok: false, loginRequired: true };
  }
  if (!r.ok) {
    logUpload('scrapeNosposStockEditForUpload', 'fetch-failed', { editUrl, error: r.error }, r.error || 'fetch failed');
    return { ok: false, error: r.error, retryable: true };
  }

  try {
    const details = parseNosposStockEditPageDetails(r.html);
    logUpload(
      'scrapeNosposStockEditForUpload',
      'ok',
      {
        editUrl,
        quantity: details.quantity,
        externallyListed: details.externallyListed,
        name: details.name,
      },
      'read stock edit'
    );
    return { ok: true, details };
  } catch (e) {
    logUpload('scrapeNosposStockEditForUpload', 'parse-failed', { editUrl, error: e?.message }, 'parse threw');
    return { ok: false, error: e?.message || 'Scrape failed', retryable: true };
  }
}
