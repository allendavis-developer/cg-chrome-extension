/**
 * Delete agreement lines the user excluded before parking.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_deleteExcludedNosposAgreementLines({ requestId, appTabId, payload }) {
  return deleteExcludedNosposAgreementLinesImpl(payload);
}
