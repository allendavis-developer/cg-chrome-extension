/**
 * Return the current URL of a given NosPos tab.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_getNosposTabUrl({ requestId, appTabId, payload }) {
  const tid = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tid) || tid <= 0) return { ok: false, error: 'Invalid tabId' };
  try {
    const tab = await chrome.tabs.get(tid);
    return { ok: true, url: tab?.url ?? null };
  } catch (_) {
    return { ok: false, error: 'Tab not found' };
  }
}
