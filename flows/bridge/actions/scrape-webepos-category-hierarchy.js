/**
 * Kick off a Web EPOS category-hierarchy scrape. Opens `/products/new`, walks
 * `#catLevel{N}` depth-first, returns the full tree as a flat node list, then
 * closes the tab. Response is delivered asynchronously via
 * `notifyAppExtensionResponse` so the caller awaits the wall-clock walk time.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_scrapeWebeposCategoryHierarchy({ requestId, appTabId }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };
  void scrapeWebEposCategoryTreeAndRespond(requestId, appTabId);
  return { ok: true };
}
