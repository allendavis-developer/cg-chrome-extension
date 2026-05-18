/**
 * Open NosPos and wait for it to be ready so we can sync fields.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openNosposSiteForFields({ requestId, appTabId, payload }) {
  const url = 'https://nospos.com';
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = {
    appTabId: appTabId || null,
    listingTabId: newTab.id,
    type: 'openNosposSiteForFields',
  };
  await setPending(pending);

  console.log('[CG Suite] openNosposSiteForFields – waiting for user to land on nospos.com', {
    requestId,
    listingTabId: newTab.id,
  });
  return { ok: true };
}
