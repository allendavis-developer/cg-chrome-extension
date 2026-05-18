/**
 * Open an arbitrary URL in a new tab (used for user-requested external links).
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openUrl({ requestId, appTabId, payload }) {
  const url = (payload.url || 'https://nospos.com').trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { ok: false, error: 'Invalid URL' };
  }
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);
  return { ok: true };
}
