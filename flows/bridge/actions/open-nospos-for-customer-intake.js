/**
 * Open NosPos for a new-customer intake flow.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openNosposForCustomerIntake({ requestId, appTabId, payload }) {
  const url = 'https://nospos.com';
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = { appTabId: appTabId || null, listingTabId: newTab.id, type: 'openNosposCustomerIntake' };
  await setPending(pending);

  console.log('[CG Suite] openNosposForCustomerIntake – waiting for user to land on nospos.com', { requestId, listingTabId: newTab.id });
  return { ok: true };
}
