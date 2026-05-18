/**
 * Audit-mode Update: walk a list of existing Web EPOS products and change their price.
 *
 * Payload: { updateList: Array<{ productHref, price, barcode?, title? }>, uploadProgressCartKey? }
 *
 * Sister action to `openWebEposProductCreateForUpload` — that one creates NEW products
 * from `/products/new`; this one EDITS existing products by reusing the canonical
 * products-table opener. Both live in flows/webepos/product-forms.js to keep every
 * Web EPOS product-form automation in one place.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_updateWebEposProductPrices({ requestId, appTabId, payload }) {
  logUpload('updateWebEposProductPrices', 'dispatch', {
    requestId,
    appTabId,
    count: Array.isArray(payload?.updateList) ? payload.updateList.length : 0,
    cartKey: payload?.uploadProgressCartKey || '',
  });
  if (appTabId == null) {
    logUpload('updateWebEposProductPrices', 'error', { reason: 'no-app-tab' });
    return { ok: false, error: 'No app tab' };
  }

  void updateWebEposProductPricesAndRespond(
    requestId,
    appTabId,
    payload.updateList,
    payload.uploadProgressCartKey
  );
  return { ok: true };
}
