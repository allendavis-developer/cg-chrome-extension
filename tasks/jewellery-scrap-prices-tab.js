/**
 * Open external scrap-price reference page in a minimized window (or inactive tab fallback).
 * Uses CG_JEWELLERY_SCRAP + putTabInYellowGroup + focusAppTab from background.js.
 */
async function openJewelleryScrapPricesTab(appTabId) {
  const url = CG_JEWELLERY_SCRAP.SCRAP_PRICES_URL;
  try {
    const win = await chrome.windows.create({
      url,
      focused: false,
      state: 'minimized',
    });
    if (win?.id != null) {
      await chrome.windows.update(win.id, { focused: false, state: 'minimized' }).catch(() => {});
    }
    const tab = (win?.tabs || [])[0];
    if (tab?.id != null) {
      if (appTabId) await focusAppTab(appTabId);
      return { ok: true, tabId: tab.id };
    }
  } catch (e) {
    console.warn('[CG Suite] Jewellery: minimized window failed:', e?.message);
  }

  const fallbackTab = await chrome.tabs.create({ url, active: false });
  await putTabInYellowGroup(fallbackTab.id);
  if (appTabId) await focusAppTab(appTabId);
  return { ok: true, tabId: fallbackTab.id };
}
