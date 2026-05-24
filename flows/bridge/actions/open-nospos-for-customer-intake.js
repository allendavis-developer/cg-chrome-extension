/**
 * Open NosPos for a new-customer intake flow.
 *
 * Pre-flight: credentialed fetch of `https://nospos.com/customers` to verify
 * the operator is signed in AND on the same shop as Cash EPOS. Mirrors the
 * Park Agreement pre-flight (see check-nospos-customer-buying-session.js) so
 * mismatched-shop or signed-out states fail fast without ever opening the tab.
 *
 * NOTE on response delivery: this action is in content-bridge.js's deferred
 * list — the bridge expects the page's promise to be resolved later by an
 * `EXTENSION_RESPONSE_TO_PAGE` from the new tab (after the user completes the
 * flow). When the pre-flight bails, no tab is opened, so we have to deliver
 * the failure response to the app tab ourselves via `chrome.tabs.sendMessage`
 * — otherwise the page promise hangs forever.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openNosposForCustomerIntake({ requestId, appTabId, payload }) {
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

  const url = 'https://nospos.com';
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = { appTabId: appTabId || null, listingTabId: newTab.id, type: 'openNosposCustomerIntake' };
  await setPending(pending);

  console.log('[CG Suite] openNosposForCustomerIntake – waiting for user to land on nospos.com', { requestId, listingTabId: newTab.id });
  return { ok: true };
}
