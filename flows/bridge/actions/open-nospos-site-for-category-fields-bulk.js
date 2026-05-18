/**
 * Open NosPos for bulk category-field sync.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openNosposSiteForCategoryFieldsBulk({ requestId, appTabId, payload }) {
  const rawIds = Array.isArray(payload.nosposCategoryIds) ? payload.nosposCategoryIds : [];
  const nosposCategoryIds = [];
  const seen = new Set();
  for (const x of rawIds) {
    const n = Math.floor(Number(x));
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    nosposCategoryIds.push(n);
  }
  if (nosposCategoryIds.length === 0) {
    return { ok: false, error: 'nosposCategoryIds must be a non-empty array of positive integers' };
  }
  const url = 'https://nospos.com';
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = {
    appTabId: appTabId || null,
    listingTabId: newTab.id,
    type: 'openNosposSiteForCategoryFieldsBulk',
    nosposCategoryIds,
  };
  await setPending(pending);

  console.log('[CG Suite] openNosposSiteForCategoryFieldsBulk – waiting for nospos.com', {
    requestId,
    listingTabId: newTab.id,
    count: nosposCategoryIds.length,
  });
  return { ok: true };
}
