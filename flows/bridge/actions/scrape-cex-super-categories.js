/**
 * Scrape the CeX super-category nav menu and return it to the app.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_scrapeCexSuperCategories({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  void executeCexSuperCategoryNavScrape(requestId, appTabId);
  return { ok: true };
}
