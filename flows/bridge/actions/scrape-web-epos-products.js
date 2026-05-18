/**
 * Scrape the Web EPOS products table (all pages).
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_scrapeWebEposProducts({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  void scrapeWebEposProductsAndRespond(requestId, appTabId);
  return { ok: true };
}
