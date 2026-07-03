/**
 * Open external scrap-price reference page as an INACTIVE tab in the app's window
 * (visible-but-unfocused), not a separate minimized window.
 *
 * Why not a minimized window: chrome.windows.create({ state: 'minimized' }) works
 * in real Chrome (a throwaway background window that scrapes out of sight), but it
 * BREAKS the Cash EPOS desktop shell, which has only ONE window. There,
 * chrome.windows.create just opens a tab and returns the app's OWN window, so the
 * follow-up chrome.windows.update(..., { state: 'minimized' }) minimizes the whole
 * Cash EPOS app — and with the app minimized the worker tab never runs, so nothing
 * scrapes. An inactive tab in the app's window behaves correctly in both Chrome and
 * the desktop shell (mirrors openWebEposWorkerTab / openNosposParkAgreementTab).
 *
 * Uses CG_JEWELLERY_SCRAP + putTabInYellowGroup + focusAppTab from background.js
 * (and disableTabAutoDiscard from sdk/nospos-tab-open.js when present).
 */
async function openJewelleryScrapPricesTab(appTabId) {
  const url = CG_JEWELLERY_SCRAP.SCRAP_PRICES_URL;

  // Prefer the app's own window so the worker tab rides alongside Cash EPOS
  // rather than spawning a separate (in the desktop shell, non-existent) window.
  let windowId = null;
  if (appTabId) {
    try {
      const t = await chrome.tabs.get(appTabId);
      windowId = t.windowId;
    } catch (_) {}
  }
  if (windowId == null) {
    try {
      const w = await chrome.windows.getLastFocused({ populate: false });
      windowId = w?.id ?? null;
    } catch (_) {}
  }

  const createOpts = { url, active: false };
  if (windowId != null) createOpts.windowId = windowId;
  const tab = await chrome.tabs.create(createOpts);

  // typeof guard: disableTabAutoDiscard lives in sdk/nospos-tab-open.js; referencing
  // it via typeof is safe even if that script isn't in scope.
  if (typeof disableTabAutoDiscard === 'function') await disableTabAutoDiscard(tab.id);
  await putTabInYellowGroup(tab.id);
  // Keep the operator on Cash EPOS — don't yank focus to the worker tab.
  if (appTabId) await focusAppTab(appTabId);

  return { ok: true, tabId: tab.id };
}
