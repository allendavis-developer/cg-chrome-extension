/**
 * Fill the first line of a new NosPos agreement.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_fillNosposAgreementFirstItem({ requestId, appTabId, payload }) {
  return fillNosposAgreementFirstItemImpl(payload);
}
