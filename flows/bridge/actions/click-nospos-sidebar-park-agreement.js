/**
 * Click NosPos's sidebar "Park Agreement" button.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_clickNosposSidebarParkAgreement({ requestId, appTabId, payload }) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (Number.isFinite(tabId) && tabId > 0) {
    const closed = await failIfNosposParkTabClosedOrMissing(tabId);
    if (closed) return closed;
  }
  return clickNosposSidebarParkAgreementImpl(payload);
}
