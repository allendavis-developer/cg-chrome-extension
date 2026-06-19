/**
 * Navigate the Web EPOS worker tab to a specific product href.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Payload: { productHref, barcode?, focusOnSuccess? = true, storeId?, storeName? }
 *  - focusOnSuccess: when false, the tab is left unfocused and the response includes
 *    `tabId` so the caller can close it later (audit preview). Default is true to
 *    preserve the click-a-barcode behaviour in the products table.
 *  - storeId/storeName: the store the snapshot was scraped from. Web EPOS opens on
 *    the first store, so we pre-filter to this store before finding the product.
 *    Falls back to the store persisted by the last scrape when the payload omits it.
 *  - status: the product's status (On Sale / Sold Out / …). The list only shows one
 *    status at a time, so we switch the status filter to match before finding it.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_navigateWebEposProductInWorker({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  const targetStore = await resolveWebEposTargetStore({
    storeId: payload?.storeId,
    storeName: payload?.storeName,
  });

  return navigateWebEposProductInWorkerForBridge(
    appTabId,
    String(payload.productHref || '').trim(),
    String(payload.barcode || '').trim(),
    {
      focusOnSuccess: payload?.focusOnSuccess !== false,
      targetStore,
      targetStatus: payload?.status || null,
    }
  );
}
