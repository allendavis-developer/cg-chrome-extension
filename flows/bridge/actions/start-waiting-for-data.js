/**
 * Open a competitor tab (eBay / CashConverters / CashGenerator / CeX) and wait for the user to capture data.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_startWaitingForData({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  const competitor = payload.competitor || 'eBay';
  const searchQuery = (payload.searchQuery || '').trim();
  const marketComparisonContext = payload.marketComparisonContext || null;

  let url;
  if (competitor === 'CashConverters') {
    url = searchQuery
      ? `https://www.cashconverters.co.uk/search-results?Sort=default&page=1&query=${encodeURIComponent(searchQuery)}`
      : 'https://www.cashconverters.co.uk/';
  } else if (competitor === 'CashGenerator') {
    url = searchQuery
      ? `https://cashgenerator.co.uk/pages/search-results-page?q=${encodeURIComponent(searchQuery)}`
      : 'https://cashgenerator.co.uk/';
  } else if (competitor === 'CeX') {
    // With a header search term: CeX site search. Without: homepage (unchanged).
    url = searchQuery
      ? `https://uk.webuy.com/search?stext=${encodeURIComponent(searchQuery)}`
      : 'https://uk.webuy.com/';
  } else {
    // Always enforce: Completed items (LH_Complete=1), Sold items (LH_Sold=1), UK Only (LH_PrefLoc=1)
    url = searchQuery
      ? `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}&LH_Complete=1&LH_Sold=1&LH_PrefLoc=1`
      : 'https://www.ebay.co.uk/';
  }

  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = { appTabId, listingTabId: newTab.id, competitor, marketComparisonContext };
  await setPending(pending);

  console.log('[CG Suite] startWaitingForData saved – only this tab can complete the flow; closing it will notify the app', { requestId, competitor, listingTabId: newTab.id, appTabId });
  return { ok: true };
}
