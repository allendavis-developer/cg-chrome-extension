/**
 * Return the persisted park-agreement log entries for debugging.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_getParkAgreementLog({ requestId, appTabId, payload }) {
  return { ok: true, entries: cgParkLog.slice(), startTs: cgParkLogStartTs };
}
