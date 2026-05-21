/**
 * Open NosPos for the new-customer create flow.
 *
 * The user clicked "New Customer" in Cash EPOS. We open /customers/create
 * directly. When the user fills in (at minimum) the name and saves, NoSpos
 * redirects to /customer/{id}/view — the content script picks up the pending
 * entry and shows the "you can add their info now or later" side panel.
 */
async function handleBridgeAction_openNosposForNewCustomer({ requestId, appTabId, payload }) {
  const url = 'https://nospos.com/customers/create';
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = {
    appTabId: appTabId || null,
    listingTabId: newTab.id,
    type: 'openNosposNewCustomerCreate',
  };
  await setPending(pending);

  console.log('[CG Suite] openNosposForNewCustomer – waiting for user to create customer', { requestId, listingTabId: newTab.id });
  return { ok: true };
}
