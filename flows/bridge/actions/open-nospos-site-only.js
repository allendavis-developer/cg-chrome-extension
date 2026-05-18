/**
 * Open NosPos without any follow-up action (user asks for raw access).
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openNosposSiteOnly({ requestId, appTabId, payload }) {
  const url = 'https://nospos.com';
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = { appTabId: appTabId || null, listingTabId: newTab.id, type: 'openNosposSiteOnly' };
  await setPending(pending);

  console.log('[CG Suite] openNosposSiteOnly – waiting for user to land on nospos.com', { requestId, listingTabId: newTab.id });
  return { ok: true };
}
