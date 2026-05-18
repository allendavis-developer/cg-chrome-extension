/**
 * Open (or focus) the listing tab in refine mode and prompt the user to confirm.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_startRefine({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  const listingPageUrl = payload.listingPageUrl;
  let competitor = 'eBay';
  if (payload.competitor === 'CashConverters') competitor = 'CashConverters';
  else if (payload.competitor === 'CashGenerator') competitor = 'CashGenerator';
  const defaultUrl =
    competitor === 'CashConverters'
      ? 'https://www.cashconverters.co.uk/'
      : competitor === 'CashGenerator'
        ? 'https://cashgenerator.co.uk/'
        : 'https://www.ebay.co.uk/';
  const urlToOpen = ensureEbayFilters(listingPageUrl) || defaultUrl;
  const marketComparisonContext = payload.marketComparisonContext || null;

  const tabs = await chrome.tabs.query({});
  const existingTab = listingPageUrl ? tabs.find(t => t.url === listingPageUrl) : null;

  let listingTabId;
  if (existingTab) {
    listingTabId = existingTab.id;
    await chrome.tabs.update(existingTab.id, { active: true }).catch(() => {});
    if (existingTab.windowId) await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
    await putTabInYellowGroup(existingTab.id);
  } else {
    const newTab = await chrome.tabs.create({ url: urlToOpen });
    await putTabInYellowGroup(newTab.id);
    await chrome.tabs.update(newTab.id, { active: true }).catch(() => {});
    listingTabId = newTab.id;
  }

  const pending = await getPending();
  pending[requestId] = { appTabId, listingTabId, competitor, marketComparisonContext };
  await setPending(pending);

  await sendWaitingForData(listingTabId, requestId, marketComparisonContext, 5, true);

  return { ok: true };
}
