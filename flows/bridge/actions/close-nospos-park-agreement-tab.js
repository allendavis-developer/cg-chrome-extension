/**
 * Close the NosPos park-agreement tab (after successful park / cancel).
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_closeNosposParkAgreementTab({ requestId, appTabId, payload }) {
  const tid = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tid) || tid <= 0) return { ok: false, error: 'Invalid tabId' };
  unregisterNosposParkTab(tid);
  const detach = nosposBuyingAfterParkDetachByTabId.get(tid);
  if (typeof detach === 'function') {
    try {
      detach();
    } catch (_) {}
  }
  try {
    await chrome.tabs.remove(tid);
  } catch (_) {
    /* already closed */
  }
  return { ok: true };
}
