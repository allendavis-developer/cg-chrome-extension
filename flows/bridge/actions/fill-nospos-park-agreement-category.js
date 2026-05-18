/**
 * Apply the category phase of a single park-agreement line.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_fillNosposParkAgreementCategory({ requestId, appTabId, payload }) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (Number.isFinite(tabId) && tabId > 0) {
    const closed = await failIfNosposParkTabClosedOrMissing(tabId);
    if (closed) return closed;
  }
  return fillNosposParkAgreementCategoryImpl(payload);
}
