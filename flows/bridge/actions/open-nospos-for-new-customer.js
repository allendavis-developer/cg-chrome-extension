/**
 * Open NosPos for the new-customer create flow.
 *
 * The user clicked "New Customer" in Cash EPOS. We open /customers/create
 * directly. When the user fills in (at minimum) the name and saves, NoSpos
 * redirects to /customer/{id}/view — the content script picks up the pending
 * entry and shows the "you can add their info now or later" side panel.
 *
 * Pre-flight: credentialed fetch of `https://nospos.com/customers` to verify
 * the operator is signed in AND on the same shop as Cash EPOS, so mismatched
 * states fail fast without ever opening the create page.
 *
 * NOTE on response delivery: this action is in content-bridge.js's deferred
 * list — the bridge expects the page's promise to be resolved later by an
 * `EXTENSION_RESPONSE_TO_PAGE` from the new tab (after the user completes the
 * flow). When the pre-flight bails, no tab is opened, so we have to deliver
 * the failure response to the app tab ourselves via `chrome.tabs.sendMessage`
 * — otherwise the page promise hangs forever.
 */
async function handleBridgeAction_openNosposForNewCustomer({ requestId, appTabId, payload }) {
  const expectedCgShopName = payload?.expectedCgShopName || '';
  const expectedShopMatch = payload?.expectedShopMatch || '';
  const preflight = await nosposCheckLoginAndShop('https://nospos.com/customers', expectedCgShopName, expectedShopMatch);
  if (!preflight.ok) {
    if (appTabId != null) {
      chrome.tabs.sendMessage(appTabId, {
        type: 'EXTENSION_RESPONSE_TO_PAGE',
        requestId,
        response: preflight,
      }).catch(() => {});
    }
    return preflight;
  }

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
