/**
 * Open the Web EPOS upload worker tab (minimized).
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openWebEposUpload({ requestId, appTabId, payload }) {
  resetUploadLog();
  logUpload('openWebEposUpload', 'start', { requestId, appTabId });
  if (appTabId == null) {
    logUpload('openWebEposUpload', 'error', { reason: 'no-app-tab' }, 'No app tab');
    return { ok: false, error: 'No app tab' };
  }

  const { tabId: webeposTabId } = await ensureWebEposUploadWorkerTabOpen(
    WEB_EPOS_PRODUCTS_URL,
    appTabId
  );
  logUpload('openWebEposUpload', 'worker-tab-open', { webeposTabId, url: WEB_EPOS_PRODUCTS_URL });
  const pending = await getPending();
  const entry = { appTabId, listingTabId: webeposTabId, type: 'openWebEposUpload' };
  pending[requestId] = entry;
  await setPending(pending);
  watchWebEposUploadTab(webeposTabId, requestId, entry);
  logUpload('openWebEposUpload', 'watching', { requestId, listingTabId: webeposTabId });
  console.log('[CG Suite] openWebEposUpload – watching tab', { requestId, listingTabId: webeposTabId });
  return { ok: true };
}
