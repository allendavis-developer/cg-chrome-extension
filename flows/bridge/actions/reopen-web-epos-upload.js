/**
 * Re-focus an existing Web EPOS upload tab or open a new one.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_reopenWebEposUpload({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  const url = normalizeWebEposUploadUrl(payload.url);
  await clearWebEposUploadSession();
  const { tabId: webeposTabId } = await ensureWebEposUploadWorkerTabOpen(url, appTabId);
  const pending = await getPending();
  const entry = { appTabId, listingTabId: webeposTabId, type: 'openWebEposUpload' };
  pending[requestId] = entry;
  await setPending(pending);
  watchWebEposUploadTab(webeposTabId, requestId, entry);
  console.log('[CG Suite] reopenWebEposUpload – watching tab', { requestId, listingTabId: webeposTabId, url });
  return { ok: true };
}
