/**
 * Return the most recent saved repricing result payload.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_getLastRepricingResult({ requestId, appTabId, payload }) {
  return { ok: true, payload: await getLastRepricingResult() };
}
