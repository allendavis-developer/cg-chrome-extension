/**
 * Navigate the Web EPOS worker tab to a specific product href.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Payload: { productHref, barcode?, focusOnSuccess? = true }
 *  - focusOnSuccess: when false, the tab is left unfocused and the response includes
 *    `tabId` so the caller can close it later (audit preview). Default is true to
 *    preserve the click-a-barcode behaviour in the products table.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_navigateWebEposProductInWorker({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  return navigateWebEposProductInWorkerForBridge(
    appTabId,
    String(payload.productHref || '').trim(),
    String(payload.barcode || '').trim(),
    { focusOnSuccess: payload?.focusOnSuccess !== false }
  );
}
