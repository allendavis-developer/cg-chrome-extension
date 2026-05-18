/**
 * User clicked Cancel in the app — close the linked listing tab and resolve the pending request.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_cancelRequest({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  // User clicked Cancel/Reset in the app while a listing tab was open.
  // Find the pending entry for this app tab, close the listing tab, and
  // send a clean cancelled response so the app's awaiting promise resolves.
  // Skip openNospos entries – we never close the NoSpos tab (user needs it to log in).
  const pending = await getPending();
  for (const [reqId, entry] of Object.entries(pending)) {
    if (
      entry.appTabId === appTabId &&
      entry.type !== 'openNospos' &&
      entry.type !== 'openNosposCustomerIntake' &&
      entry.type !== 'openNosposCustomerIntakeWaiting' &&
      entry.type !== 'openNosposSiteOnly' &&
      entry.type !== 'openNosposSiteForFields' &&
      entry.type !== 'openNosposSiteForCategoryFields' &&
      entry.type !== 'openNosposSiteForCategoryFieldsBulk'
    ) {
      const listingTabId = entry.listingTabId;
      delete pending[reqId];
      await setPending(pending);
      if (listingTabId != null) {
        await chrome.tabs.remove(listingTabId).catch(() => {});
      }
      chrome.tabs.sendMessage(appTabId, {
        type: 'EXTENSION_RESPONSE_TO_PAGE',
        requestId: reqId,
        response: { success: false, cancelled: true }
      }).catch(() => {});
      break;
    }
  }
  return { ok: true };
}
