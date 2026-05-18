/**
 * NosPos repricing session storage: pending-entry cleanup, last-result/status storage,
 * barcode queue helpers, log append + broadcast, request-fail cleanup.
 * Also hosts scrapeNosposStockCategoryModifyTab for stock-category page scraping.
 */

async function scrapeNosposStockCategoryModifyTab(tabId) {
  try {
    const response = await sendMessageToTabWithRetries(
      tabId,
      { type: 'SCRAPE_NOSPOS_STOCK_CATEGORY_MODIFY' },
      12,
      400
    );
    const rows = Array.isArray(response?.rows) ? response.rows : [];
    let buybackRatePercent = null;
    if (response?.buybackRatePercent != null && response.buybackRatePercent !== '') {
      const n = Number(response.buybackRatePercent);
      buybackRatePercent = Number.isFinite(n) ? n : null;
    }
    let offerRatePercent = null;
    if (response?.offerRatePercent != null && response.offerRatePercent !== '') {
      const n = Number(response.offerRatePercent);
      offerRatePercent = Number.isFinite(n) ? n : null;
    }
    const hasData = rows.length > 0 || buybackRatePercent != null || offerRatePercent != null;
    if (response?.ok === false && !hasData) {
      return {
        ok: false,
        rows: [],
        buybackRatePercent: null,
        offerRatePercent: null,
        error: response?.error || 'Scrape returned no data',
      };
    }
    return {
      ok: true,
      rows,
      buybackRatePercent,
      offerRatePercent,
      error: response?.error || null,
    };
  } catch (e) {
    return {
      ok: false,
      rows: [],
      buybackRatePercent: null,
      offerRatePercent: null,
      error: e?.message || 'Scrape failed',
    };
  }
}

async function clearNosposPendingEntries(tabId) {
  const pending = await getPending();
  let changed = false;
  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.type === 'openNospos' && (tabId == null || entry.listingTabId === tabId)) {
      delete pending[requestId];
      changed = true;
    }
  }
  if (changed) {
    await setPending(pending);
  }
}

async function clearNosposRepricingState(tabId) {
  await chrome.storage.session.remove('cgNosposRepricingData');
  await chrome.storage.local.remove('cgNosposRepricingProgress');
  await clearNosposPendingEntries(tabId);
}

async function setLastRepricingResult(payload) {
  await chrome.storage.local.set({ cgNosposLastRepricingResult: payload || null });
}

async function getLastRepricingResult() {
  const stored = await chrome.storage.local.get('cgNosposLastRepricingResult');
  return stored.cgNosposLastRepricingResult || null;
}

async function clearLastRepricingResult() {
  await chrome.storage.local.remove('cgNosposLastRepricingResult');
}

async function getRepricingStatus() {
  const stored = await chrome.storage.local.get('cgNosposRepricingStatus');
  return stored.cgNosposRepricingStatus || null;
}

async function setRepricingStatus(status) {
  await chrome.storage.local.set({ cgNosposRepricingStatus: status || null });
}

async function clearRepricingStatus() {
  await chrome.storage.local.remove('cgNosposRepricingStatus');
}

function countTotalBarcodes(repricingData) {
  return (repricingData || []).reduce((sum, item) => sum + ((item?.barcodes?.length) || 0), 0);
}

function countCompletedBarcodes(completedBarcodes) {
  return Object.values(completedBarcodes || {}).reduce((sum, indices) => sum + ((indices || []).length), 0);
}

function getStockEditUrl(stockUrl) {
  if (!stockUrl) return null;
  if (/\/stock\/\d+\/edit\/?$/.test(stockUrl)) return stockUrl.replace(/\/?$/, '');
  if (/\/stock\/\d+\/?$/.test(stockUrl)) return stockUrl.replace(/\/?$/, '') + '/edit';
  return null;
}

function buildBarcodeQueue(repricingData, completedBarcodes, completedItems, skippedBarcodes = {}) {
  const queue = [];
  for (let i = 0; i < (repricingData || []).length; i++) {
    const item = repricingData[i];
    if (completedItems?.includes(item?.itemId)) continue;
    const done = completedBarcodes?.[item?.itemId] || [];
    const skipped = skippedBarcodes?.[item?.itemId] || [];
    for (let j = 0; j < (item?.barcodes?.length || 0); j++) {
      if (done.includes(j) || skipped.includes(j)) continue;
      const barcode = (item?.barcodes?.[j] || '').trim();
      if (!barcode) continue;
      queue.push({
        itemIndex: i,
        barcodeIndex: j,
        itemId: item?.itemId,
        itemTitle: item?.title || '',
        barcode,
        stockUrl: item?.stockUrls?.[j] || ''
      });
    }
  }
  return queue;
}

function getActiveQueue(data) {
  const queue = Array.isArray(data?.queue) ? data.queue : [];
  if (queue.length > 0) return queue;
  return buildBarcodeQueue(data?.repricingData || [], data?.completedBarcodes || {}, data?.completedItems || [], data?.skippedBarcodes || {});
}

function removeQueueHead(queue, expected) {
  const currentQueue = Array.isArray(queue) ? [...queue] : [];
  if (currentQueue.length === 0) return currentQueue;
  if (!expected) return currentQueue.slice(1);
  const head = currentQueue[0];
  if (
    head?.itemId === expected?.itemId &&
    head?.barcodeIndex === expected?.barcodeIndex &&
    head?.barcode === expected?.barcode
  ) {
    return currentQueue.slice(1);
  }
  return currentQueue.filter((entry) => !(
    entry?.itemId === expected?.itemId &&
    entry?.barcodeIndex === expected?.barcodeIndex &&
    entry?.barcode === expected?.barcode
  ));
}

function appendRepricingLog(data, message, level = 'info') {
  const logs = [...(data?.logs || []), {
    timestamp: new Date().toISOString(),
    level,
    message: String(message || '').trim()
  }].slice(-200);
  return { ...(data || {}), logs };
}

function itemTitleForLog(item) {
  return item?.title || 'Unknown Item';
}

function formatBarcodeArrayForLog(item) {
  const values = (item?.barcodes || []).map((barcode) => String(barcode || '').trim()).filter(Boolean);
  return `[${values.map((barcode) => `"${barcode}"`).join(', ')}]`;
}

function addItemContextLog(data, item, prefix = 'Next item is') {
  if (!item?.itemId) return data;
  if (data?.lastLoggedItemId === item.itemId) return data;
  const label = data?.lastLoggedItemId ? 'Next item is' : 'First item is';
  return appendRepricingLog(
    { ...(data || {}), lastLoggedItemId: item.itemId },
    `${label} ${itemTitleForLog(item)} - updating barcodes ${formatBarcodeArrayForLog(item)}.`
  );
}

function buildRepricingStatusPayload(data, overrides = {}) {
  const repricingData = data?.repricingData || [];
  const completedBarcodes = data?.completedBarcodes || {};
  const completedItems = data?.completedItems || [];
  const totalBarcodes =
    overrides.totalBarcodes != null ? Number(overrides.totalBarcodes) : countTotalBarcodes(repricingData);
  const completedBarcodeCount =
    overrides.completedBarcodeCount != null
      ? Number(overrides.completedBarcodeCount)
      : data?.completedBarcodeCount != null
        ? Number(data.completedBarcodeCount)
        : countCompletedBarcodes(completedBarcodes);
  const queue = getActiveQueue(data);
  const next = queue[0] || null;
  const nextItem = next ? repricingData[next.itemIndex] : null;

  return {
    cartKey: data?.cartKey || '',
    running: overrides.running != null ? !!overrides.running : !data?.done,
    done: overrides.done != null ? !!overrides.done : !!data?.done,
    step: overrides.step || data?.step || (data?.done ? 'completed' : 'working'),
    message: overrides.message || data?.message || '',
    currentBarcode: overrides.currentBarcode ?? data?.currentBarcode ?? next?.barcode ?? '',
    currentItemId: overrides.currentItemId ?? data?.currentItemId ?? nextItem?.itemId ?? '',
    currentItemTitle: overrides.currentItemTitle ?? data?.currentItemTitle ?? nextItem?.title ?? '',
    totalBarcodes,
    completedBarcodeCount,
    completedBarcodes,
    completedItems,
    logs: overrides.logs != null ? overrides.logs : data?.logs || [],
  };
}

async function broadcastRepricingStatus(appTabId, data, overrides = {}) {
  const payload = buildRepricingStatusPayload(data, overrides);
  await setRepricingStatus(payload);
  if (appTabId) {
    await chrome.tabs.sendMessage(appTabId, {
      type: 'REPRICING_PROGRESS_TO_PAGE',
      payload
    }).catch(() => {});
  }
  return payload;
}

async function failNosposRequestAndCloseTab(requestId, entry, message) {
  const pending = await getPending();
  if (pending[requestId]) {
    delete pending[requestId];
    await setPending(pending);
  }

  if (entry?.type === 'openNospos') {
    const status = await getRepricingStatus();
    if (status?.cartKey) {
      await setRepricingStatus({
        ...status,
        running: false,
        done: false,
        step: 'error',
        message: message || 'You must be logged into NoSpos to continue.',
        logs: [...(status.logs || []), {
          timestamp: new Date().toISOString(),
          level: 'error',
          message: message || 'You must be logged into NoSpos to continue.'
        }].slice(-200)
      });
    }
    await clearNosposRepricingState(entry.listingTabId);
  }

  if (entry?.appTabId != null) {
    chrome.tabs.sendMessage(entry.appTabId, {
      type: 'EXTENSION_RESPONSE_TO_PAGE',
      requestId,
      error: message || 'You must be logged into NoSpos to continue.'
    }).catch(() => {});
    await focusAppTab(entry.appTabId);
  }

  if (entry?.listingTabId != null) {
    await chrome.tabs.remove(entry.listingTabId).catch(() => {});
  }
}
