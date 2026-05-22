/**
 * Re-focus an existing Web EPOS upload tab or open a new one.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Pre-flight: same NosPos shop / login probe as `openWebEposUpload` — a reopen
 * still drives the same upload workflow that scrapes NosPos stock pages, so
 * the operator must still be on the matching NosPos shop. On failure we post
 * the response to the app tab ourselves (action is in the deferred list).
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_reopenWebEposUpload({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  const expectedCgShopName = payload?.expectedCgShopName || '';
  const preflight = await nosposCheckLoginAndShop('https://nospos.com/customers', expectedCgShopName);
  if (!preflight.ok) {
    chrome.tabs.sendMessage(appTabId, {
      type: 'EXTENSION_RESPONSE_TO_PAGE',
      requestId,
      response: preflight,
    }).catch(() => {});
    return preflight;
  }

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
