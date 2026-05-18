/**
 * Open NosPos in a dedicated background window (minimized) or in a park-agreement tab.
 * Exports: openBackgroundNosposTab, openNosposParkAgreementTab
 */

async function openBackgroundNosposTab(url, appTabId = null) {
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
      if (appTabId) {
        await focusAppTab(appTabId);
      }
      return { tabId: tab.id, windowId: win.id || null, dedicatedWindow: true };
    }
  } catch (e) {
    console.warn('[CG Suite] Could not open minimized NoSpos window:', e?.message);
  }

  try {
    const win = await chrome.windows.create({
      url,
      focused: false,
    });
    if (win?.id != null) {
      await chrome.windows.update(win.id, { focused: false, state: 'minimized' }).catch(() => {});
    }
    const tab = (win?.tabs || [])[0];
    if (tab?.id != null) {
      if (appTabId) {
        await focusAppTab(appTabId);
      }
      return { tabId: tab.id, windowId: win.id || null, dedicatedWindow: true };
    }
  } catch (e2) {
    console.warn('[CG Suite] Could not open NosPos window (fallback):', e2?.message);
  }

  const fallbackTab = await chrome.tabs.create({ url, active: false });
  await putTabInYellowGroup(fallbackTab.id);
  if (appTabId) {
    await focusAppTab(appTabId);
  }
  return {
    tabId: fallbackTab.id,
    windowId: fallbackTab.windowId || null,
    dedicatedWindow: false,
  };
}

/**
 * Park agreement: open NosPos in a normal tab (same window as the app when possible), not a minimized window.
 */
async function openNosposParkAgreementTab(url, appTabId = null) {
  logPark('openNosposParkAgreementTab', 'enter', { url, appTabId }, 'Opening NoSpos park agreement tab');
  let windowId = null;
  if (appTabId) {
    try {
      const t = await chrome.tabs.get(appTabId);
      windowId = t.windowId;
      logPark('openNosposParkAgreementTab', 'step', { appTabId, resolvedWindowId: windowId }, 'Resolved window from app tab');
    } catch (_) {
      logPark('openNosposParkAgreementTab', 'step', { appTabId }, 'Could not get app tab window — will use last focused');
    }
  }
  if (windowId == null) {
    try {
      const w = await chrome.windows.getLastFocused({ populate: false });
      windowId = w?.id ?? null;
      logPark('openNosposParkAgreementTab', 'step', { windowId }, 'Using last focused window');
    } catch (_) {
      logPark('openNosposParkAgreementTab', 'step', {}, 'Could not get last focused window — tab will open in default window');
    }
  }
  const createOpts = { url, active: false };
  if (windowId != null) createOpts.windowId = windowId;
  logPark('openNosposParkAgreementTab', 'call', { createOpts }, 'Calling chrome.tabs.create');
  const newTab = await chrome.tabs.create(createOpts);
  await putTabInYellowGroup(newTab.id);
  if (appTabId) {
    await focusAppTab(appTabId);
  }
  const result = { tabId: newTab.id, windowId: newTab.windowId || null };
  logPark('openNosposParkAgreementTab', 'exit', result, 'Tab created successfully');
  console.log('[CG Suite] NosPos park agreement: opened tab', result);
  return result;
}
