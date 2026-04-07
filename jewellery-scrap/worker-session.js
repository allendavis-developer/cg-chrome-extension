/**
 * Jewellery scrap worker tab — session map, forward payload to app tab, inject scraper.
 * Loaded after jewellery-scrap/constants.js.
 */

async function jewelleryScrapReadMap() {
  const data = await chrome.storage.session.get(CG_JEWELLERY_SCRAP.STORAGE_KEY);
  return { ...(data[CG_JEWELLERY_SCRAP.STORAGE_KEY] || {}) };
}

async function jewelleryScrapWriteMap(map) {
  await chrome.storage.session.set({ [CG_JEWELLERY_SCRAP.STORAGE_KEY]: map });
}

async function registerJewelleryScrapWorkerTab(workerTabId, appTabId) {
  if (workerTabId == null || appTabId == null) return;
  const map = await jewelleryScrapReadMap();
  map[workerTabId] = appTabId;
  await jewelleryScrapWriteMap(map);
}

async function unregisterJewelleryScrapWorkerTab(workerTabId) {
  const map = await jewelleryScrapReadMap();
  if (!(workerTabId in map)) return;
  delete map[workerTabId];
  await jewelleryScrapWriteMap(map);
}

async function forwardJewelleryScrapPricesToApp(workerTabId, payload) {
  const map = await jewelleryScrapReadMap();
  const appTabId = map[workerTabId];
  if (appTabId == null) return;
  await chrome.tabs.sendMessage(appTabId, {
    type: CG_JEWELLERY_SCRAP.MSG_TO_PAGE,
    payload,
  }).catch(() => {});
}

function scrapInjectUrlAllowed(url) {
  return (
    typeof url === 'string' &&
    url.includes(CG_JEWELLERY_SCRAP.INJECT_URL_HOST)
  );
}

function scheduleJewelleryScrapInject(workerTabId) {
  if (workerTabId == null) return;

  let injected = false;
  let cleanedUp = false;
  let timeoutId = null;

  function cleanupListeners() {
    if (cleanedUp) return;
    cleanedUp = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    if (timeoutId != null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function onRemoved(removedTabId) {
    if (removedTabId !== workerTabId) return;
    cleanupListeners();
  }

  async function tryInject(tab) {
    if (injected) return;
    if (!scrapInjectUrlAllowed(tab?.url || '')) return;
    injected = true;
    cleanupListeners();
    try {
      await chrome.scripting.executeScript({
        target: { tabId: workerTabId },
        files: [CG_JEWELLERY_SCRAP.SCRAPER_SCRIPT_FILE],
      });
    } catch (e) {
      console.warn('[CG Suite] Jewellery scrap inject failed:', e?.message);
    }
  }

  function onUpdated(tabId, info, tab) {
    if (tabId !== workerTabId || info.status !== 'complete') return;
    if (tab?.url) {
      void tryInject(tab);
    } else {
      chrome.tabs.get(tabId).then((t) => void tryInject(t)).catch(() => {});
    }
  }

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);

  timeoutId = setTimeout(
    cleanupListeners,
    CG_JEWELLERY_SCRAP.SCRAPER_INJECT_LISTENER_TIMEOUT_MS
  );

  chrome.tabs.get(workerTabId).then((t) => {
    if (t?.status === 'complete') void tryInject(t);
  }).catch(() => {});
}
