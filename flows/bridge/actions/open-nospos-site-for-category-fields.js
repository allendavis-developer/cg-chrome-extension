/**
 * Open NosPos for a single-category field sync.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openNosposSiteForCategoryFields({ requestId, appTabId, payload }) {
  const nosposCategoryId = Math.floor(Number(payload.nosposCategoryId));
  if (!Number.isFinite(nosposCategoryId) || nosposCategoryId <= 0) {
    return { ok: false, error: 'Invalid nosposCategoryId' };
  }
  const url = 'https://nospos.com';
  const newTab = await chrome.tabs.create({ url });
  await putTabInYellowGroup(newTab.id);

  const pending = await getPending();
  pending[requestId] = {
    appTabId: appTabId || null,
    listingTabId: newTab.id,
    type: 'openNosposSiteForCategoryFields',
    nosposCategoryId,
  };
  await setPending(pending);

  console.log('[CG Suite] openNosposSiteForCategoryFields – waiting for user to land on nospos.com', {
    requestId,
    listingTabId: newTab.id,
    nosposCategoryId,
  });
  return { ok: true };
}
