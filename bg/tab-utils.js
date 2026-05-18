/**
 * Tab/window management utilities.
 * Globals: sleep, focusAppTab, waitForTabLoadComplete, sendMessageToTabWithRetries,
 *          putTabInYellowGroup, ensureEbayFilters
 */

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function focusAppTab(appTabId) {
  if (!appTabId) return;
  var appTab = await chrome.tabs.get(appTabId).catch(function () { return null; });
  if (!appTab) return;
  await chrome.tabs.update(appTabId, { active: true }).catch(function () {});
  if (appTab.windowId) {
    await chrome.windows.update(appTab.windowId, { focused: true }).catch(function () {});
  }
}

function waitForTabLoadComplete(tabId, timeoutMs, timeoutErrorMessage) {
  var ms = timeoutMs == null ? 90000 : timeoutMs;
  var timeoutMsg = timeoutErrorMessage || 'Tab load timed out';
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(timeoutMsg));
    }, ms);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(function (tab) {
      if (tab && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    }).catch(function () {});
  });
}

async function sendMessageToTabWithRetries(tabId, message, retries, delayMs) {
  for (var i = 0; i <= retries; i++) {
    try {
      var result = await chrome.tabs.sendMessage(tabId, message);
      if (result) return result;
    } catch (e) {
      if (i < retries) await sleep(delayMs || 500);
    }
  }
  return null;
}

async function putTabInYellowGroup(tabId) {
  try {
    var groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, { color: 'yellow', title: 'CG Suite' });
  } catch (e) {
    console.warn('[CG Suite] Could not add tab to yellow group:', e?.message);
  }
}

function ensureEbayFilters(url) {
  if (!url || !url.includes('ebay.co.uk')) return url;
  try {
    var u = new URL(url);
    u.searchParams.set('LH_Complete', '1');
    u.searchParams.set('LH_Sold', '1');
    u.searchParams.set('LH_PrefLoc', '1');
    return u.toString();
  } catch (e) {
    return url;
  }
}
