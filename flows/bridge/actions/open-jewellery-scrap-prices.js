/**
 * Open the jewellery-scrap worker tab.
 *
 * The action string for this handler comes from CG_JEWELLERY_SCRAP.BRIDGE_OPEN_ACTION
 * ('openJewelleryScrapPrices') — the registry uses the constant as a computed key.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openJewelleryScrapPrices({ requestId, appTabId, payload }) {
  try {
    const result = await openJewelleryScrapPricesTab(appTabId);
    if (result?.tabId != null && appTabId != null) {
      await registerJewelleryScrapWorkerTab(result.tabId, appTabId);
      scheduleJewelleryScrapInject(result.tabId);
    }
  } catch (e) {
    console.warn('[CG Suite] openJewelleryScrapPrices failed:', e?.message);
  }
  return { ok: true };
}
