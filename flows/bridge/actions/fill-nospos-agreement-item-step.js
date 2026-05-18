/**
 * Fill one step of a NosPos agreement line (for retry / diagnostics).
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_fillNosposAgreementItemStep({ requestId, appTabId, payload }) {
  return fillNosposAgreementItemStepImpl(payload);
}
