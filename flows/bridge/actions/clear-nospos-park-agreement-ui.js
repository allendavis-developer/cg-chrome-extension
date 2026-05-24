/**
 * Clear the park-overlay lock (stops the overlay across tabs).
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_clearNosposParkAgreementUi({ requestId, appTabId, payload }) {
  await clearNosposParkAgreementUiLock({
    focusApp: payload.focusApp !== false,
    closeTab: payload.closeTab === true,
  });
  return { ok: true };
}
