/**
 * Apply the non-category fields of a single park-agreement line.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_fillNosposParkAgreementRest({ requestId, appTabId, payload }) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (Number.isFinite(tabId) && tabId > 0) {
    const closed = await failIfNosposParkTabClosedOrMissing(tabId);
    if (closed) return closed;
  }
  return fillNosposParkAgreementRestImpl(payload);
}
