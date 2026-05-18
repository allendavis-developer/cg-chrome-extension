/**
 * Bring the parked NosPos tab to the foreground, re-opening it if closed.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_focusOrOpenNosposParkTab({ requestId, appTabId, payload }) {
  return focusOrOpenNosposParkTabImpl({
    tabId: payload.tabId,
    fallbackCreateUrl: payload.fallbackCreateUrl,
    appTabId,
  });
}
