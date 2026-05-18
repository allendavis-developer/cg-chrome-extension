/**
 * Clear the stored last repricing result.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_clearLastRepricingResult({ requestId, appTabId, payload }) {
  await clearLastRepricingResult();
  return { ok: true };
}
