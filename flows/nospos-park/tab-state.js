/**
 * Track whether a NosPos park tab is still alive, and wait for the user's duplicate-detection choice.
 */

function applyNosposParkTabClosedMark(tabId, removeInfo = null) {
  nosposActiveParkTabIds.delete(tabId);
  const err = NOSPOS_PARK_TAB_CLOSED_ERR;
  if (!nosposParkClosedAbortByTabId.has(tabId)) {
    nosposParkClosedAbortByTabId.set(tabId, err);
    logPark(
      'nosposParkTabLifecycle',
      'error',
      {
        tabId,
        removeInfo: removeInfo || null,
        tickmark: 'x',
      },
      `✗ ${err}`
    );
  }
}

/**
 * When the service worker restarts, in-memory `nosposActiveParkTabIds` is empty but
 * `chrome.storage.session` may still hold the park UI lock for this tab — still treat
 * closure as a park failure so the app gets a consistent error.
 */
function markNosposParkTabClosed(tabId, removeInfo = null) {
  if (nosposActiveParkTabIds.has(tabId)) {
    applyNosposParkTabClosedMark(tabId, removeInfo);
    return;
  }
  void chrome.storage.session.get(NOSPOS_PARK_UI_STORAGE_KEY).then((data) => {
    const lock = data[NOSPOS_PARK_UI_STORAGE_KEY];
    if (lock?.active && lock.tabId === tabId) {
      applyNosposParkTabClosedMark(tabId, removeInfo);
    }
  });
}

function registerNosposParkTab(tabId) {
  nosposActiveParkTabIds.clear();
  nosposActiveParkTabIds.add(tabId);
  nosposParkClosedAbortByTabId.delete(tabId);
}

function unregisterNosposParkTab(tabId) {
  nosposActiveParkTabIds.delete(tabId);
  nosposParkClosedAbortByTabId.delete(tabId);
}

function getNosposParkTabClosedError(tabId) {
  return nosposParkClosedAbortByTabId.get(tabId) || null;
}

function failIfNosposParkTabClosed(tabId) {
  const err = getNosposParkTabClosedError(tabId);
  if (!err) return null;
  return { ok: false, tabClosed: true, error: err };
}

/**
 * Like {@link failIfNosposParkTabClosed} but also detects a missing tab when `tabs.onRemoved`
 * was missed (e.g. MV3 worker asleep). Call at the start of park bridge handlers.
 */
async function failIfNosposParkTabClosedOrMissing(tabId) {
  const err = getNosposParkTabClosedError(tabId);
  if (err) return { ok: false, tabClosed: true, error: err };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    applyNosposParkTabClosedMark(tabId, null);
    return { ok: false, tabClosed: true, error: NOSPOS_PARK_TAB_CLOSED_ERR };
  }
  return null;
}

const pendingNosposDuplicateChoices = new Map();

function resolveNosposDuplicateUserChoice(requestId, tabId, choice) {
  const entry = pendingNosposDuplicateChoices.get(requestId);
  if (!entry || entry.tabId !== tabId) return false;
  entry.finish(choice);
  return true;
}

function waitForNosposDuplicateUserChoice(tabId, requestId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let onRemoved = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (onRemoved) {
        try {
          chrome.tabs.onRemoved.removeListener(onRemoved);
        } catch (_) {}
        onRemoved = null;
      }
      if (pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      pendingNosposDuplicateChoices.delete(requestId);
      resolve(value);
    };
    onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      markNosposParkTabClosed(tabId, null);
      finish('tab_closed');
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    pollTimer = setInterval(() => {
      if (getNosposParkTabClosedError(tabId)) finish('tab_closed');
    }, 350);
    pendingNosposDuplicateChoices.set(requestId, { tabId, finish });
    setTimeout(() => finish('timeout'), timeoutMs);
  });
}
