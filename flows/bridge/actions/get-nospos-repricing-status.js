/**
 * Return the current repricing progress status.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_getNosposRepricingStatus({ requestId, appTabId, payload }) {
  return { ok: true, payload: await getRepricingStatus() };
}
