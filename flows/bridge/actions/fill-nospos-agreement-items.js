/**
 * Fill every included line of a new NosPos agreement (sequential).
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_fillNosposAgreementItems({ requestId, appTabId, payload }) {
  return fillNosposAgreementItemsSequentialImpl(payload);
}
