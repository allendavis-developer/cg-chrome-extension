/**
 * End the Web EPOS upload session and close its worker tab.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_closeWebEposUploadSession({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  await closeWebEposUploadSessionForAppTab(appTabId);
  return { ok: true };
}
