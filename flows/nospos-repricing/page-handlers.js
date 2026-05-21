/**
 * NosPos page-ready / login-required / stock-search / stock-edit / page-loaded message handlers.
 * Also customer-search / customer-detail / customer-done handlers.
 */

async function handleNosposPageReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  const pending = await getPending();
  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.listingTabId !== tabId) continue;
    if (entry.type === 'openNospos') {
      // Navigate to stock search; keep pending so content script can get repricingData and fill first barcode
      await chrome.tabs.update(tabId, { url: 'https://nospos.com/stock/search' });
      const stored = await chrome.storage.session.get('cgNosposRepricingData');
      const nextData = appendRepricingLog(stored.cgNosposRepricingData, 'Logged into NoSpos. Opening stock search…');
      await chrome.storage.session.set({ cgNosposRepricingData: nextData });
      await broadcastRepricingStatus(entry.appTabId, nextData, {
        step: 'search',
        message: 'Logged into NoSpos. Opening stock search…'
      });
      console.log('[CG Suite] NOSPOS_PAGE_READY – navigating to /stock/search', { requestId });
      return;
    }
    if (entry.type === 'openNosposCustomerIntake') {
      // First time landing on nospos after opening the tab — user is now logged in.
      // Navigate to /customers and mark as waiting.
      pending[requestId] = { ...entry, type: 'openNosposCustomerIntakeWaiting' };
      await setPending(pending);
      await chrome.tabs.update(tabId, { url: 'https://nospos.com/customers' });
      console.log('[CG Suite] NOSPOS_PAGE_READY – customer intake: navigating to /customers', { requestId });
      return;
    }
    if (entry.type === 'openNosposCustomerIntakeWaiting') {
      // The user logged in and was bounced back to the home page (or some other nospos page)
      // instead of /customers. Re-navigate them there.
      await chrome.tabs.update(tabId, { url: 'https://nospos.com/customers' });
      console.log('[CG Suite] NOSPOS_PAGE_READY – re-navigating to /customers after post-login redirect', { requestId });
      return;
    }
    if (entry.type === 'openNosposNewCustomerCreate' || entry.type === 'openNosposNewCustomerCreateWaiting') {
      // Customer-create flow. If the post-login bounce dropped us off the create
      // page, re-navigate. Flip to Waiting so we don't loop on re-entry.
      pending[requestId] = { ...entry, type: 'openNosposNewCustomerCreateWaiting' };
      await setPending(pending);
      await chrome.tabs.update(tabId, { url: 'https://nospos.com/customers/create' });
      console.log('[CG Suite] NOSPOS_PAGE_READY – new-customer create: navigating to /customers/create', { requestId });
      return;
    }
    if (entry.type === 'openNosposSiteOnly') {
      await runNosposDataImportAfterLogin({
        tabId,
        requestId,
        entry,
        failureMessageDefault: 'NoSpos category pages did not finish loading.',
        work: async (tid) => {
          const pagesEnd = NOSPOS_STOCK_CATEGORY_PAGINATION.endPage;
          const scrapedByNosposId = new Map();
          await runNosposStockCategoryPageLoop(tid, {
            loadTimeoutMs: 90000,
            onPage: (page, url) => {
              console.log('[CG Suite] openNosposSiteOnly category page', { requestId, page, url });
            },
            afterPageLoad: async () => {
              const pack = await scrapeNosposStockCategoryTab(tid);
              if (!pack.ok) {
                console.warn('[CG Suite] openNosposSiteOnly scrape', pack.error);
              }
              for (const row of pack.rows || []) {
                if (row && row.nosposId != null) scrapedByNosposId.set(row.nosposId, row);
              }
            },
          });
          const categories = Array.from(scrapedByNosposId.values());
          console.log('[CG Suite] NOSPOS_PAGE_READY – openNosposSiteOnly: done', {
            requestId,
            rows: categories.length,
          });
          return {
            ok: true,
            pagesVisited: pagesEnd - NOSPOS_STOCK_CATEGORY_PAGINATION.startPage + 1,
            lastUrl: buildNosposStockCategoryIndexUrl(pagesEnd),
            categories,
          };
        },
      });
      return;
    }
    if (entry.type === 'openNosposSiteForFields') {
      await runNosposDataImportAfterLogin({
        tabId,
        requestId,
        entry,
        failureMessageDefault: 'NoSpos category modify page did not finish loading.',
        work: async (tid) => {
          const targetUrl = buildNosposStockCategoryModifyUrl(1);
          await chrome.tabs.update(tid, { url: targetUrl });
          await waitForTabLoadComplete(
            tid,
            90000,
            'NoSpos category modify page did not finish loading in time.'
          );
          const pack = await scrapeNosposStockCategoryModifyTab(tid);
          if (!pack.ok) {
            console.warn('[CG Suite] openNosposSiteForFields scrape', pack.error);
          }
          const byFieldId = new Map();
          for (const row of pack.rows || []) {
            if (row && row.nosposFieldId != null) byFieldId.set(row.nosposFieldId, row);
          }
          const fields = Array.from(byFieldId.values());
          const buybackRatePercent =
            pack.buybackRatePercent != null && Number.isFinite(Number(pack.buybackRatePercent))
              ? Number(pack.buybackRatePercent)
              : null;
          const offerRatePercent =
            pack.offerRatePercent != null && Number.isFinite(Number(pack.offerRatePercent))
              ? Number(pack.offerRatePercent)
              : null;
          console.log('[CG Suite] NOSPOS_PAGE_READY – openNosposSiteForFields: done', {
            requestId,
            rows: fields.length,
            buybackRatePercent,
            offerRatePercent,
          });
          return {
            ok: true,
            pagesVisited: 1,
            lastUrl: targetUrl,
            fields,
            buybackRatePercent,
            offerRatePercent,
          };
        },
      });
      return;
    }
    if (entry.type === 'openNosposSiteForCategoryFields') {
      await runNosposDataImportAfterLogin({
        tabId,
        requestId,
        entry,
        failureMessageDefault: 'NoSpos category modify page did not finish loading.',
        work: async (tid) => {
          const targetUrl = buildNosposStockCategoryModifyUrl(entry.nosposCategoryId);
          await chrome.tabs.update(tid, { url: targetUrl });
          await waitForTabLoadComplete(
            tid,
            90000,
            'NoSpos category modify page did not finish loading in time.'
          );
          const pack = await scrapeNosposStockCategoryModifyTab(tid);
          if (!pack.ok) {
            console.warn('[CG Suite] openNosposSiteForCategoryFields scrape', pack.error);
          }
          const byFieldId = new Map();
          for (const row of pack.rows || []) {
            if (row && row.nosposFieldId != null) byFieldId.set(row.nosposFieldId, row);
          }
          const fields = Array.from(byFieldId.values());
          const buybackRatePercent =
            pack.buybackRatePercent != null && Number.isFinite(Number(pack.buybackRatePercent))
              ? Number(pack.buybackRatePercent)
              : null;
          const offerRatePercent =
            pack.offerRatePercent != null && Number.isFinite(Number(pack.offerRatePercent))
              ? Number(pack.offerRatePercent)
              : null;
          console.log('[CG Suite] NOSPOS_PAGE_READY – openNosposSiteForCategoryFields: done', {
            requestId,
            categoryNosposId: entry.nosposCategoryId,
            rows: fields.length,
            buybackRatePercent,
            offerRatePercent,
          });
          return {
            ok: true,
            pagesVisited: 1,
            lastUrl: targetUrl,
            categoryNosposId: entry.nosposCategoryId,
            fields,
            buybackRatePercent,
            offerRatePercent,
          };
        },
      });
      return;
    }
    if (entry.type === 'openNosposSiteForCategoryFieldsBulk') {
      await runNosposDataImportAfterLogin({
        tabId,
        requestId,
        entry,
        failureMessageDefault: 'NoSpos category modify bulk scrape failed.',
        work: async (tid) => {
          const ids = entry.nosposCategoryIds || [];
          const results = [];
          for (let i = 0; i < ids.length; i += 1) {
            const categoryNosposId = ids[i];
            const targetUrl = buildNosposStockCategoryModifyUrl(categoryNosposId);
            await chrome.tabs.update(tid, { url: targetUrl });
            await waitForTabLoadComplete(
              tid,
              90000,
              `NoSpos category modify page did not finish loading (id=${categoryNosposId}).`
            );
            const pack = await scrapeNosposStockCategoryModifyTab(tid);
            if (!pack.ok) {
              console.warn('[CG Suite] openNosposSiteForCategoryFieldsBulk scrape', categoryNosposId, pack.error);
            }
            const byFieldId = new Map();
            for (const row of pack.rows || []) {
              if (row && row.nosposFieldId != null) byFieldId.set(row.nosposFieldId, row);
            }
            const fields = Array.from(byFieldId.values());
            const buybackRatePercent =
              pack.buybackRatePercent != null && Number.isFinite(Number(pack.buybackRatePercent))
                ? Number(pack.buybackRatePercent)
                : null;
            const offerRatePercent =
              pack.offerRatePercent != null && Number.isFinite(Number(pack.offerRatePercent))
                ? Number(pack.offerRatePercent)
                : null;
            if (entry.appTabId != null) {
              chrome.tabs
                .sendMessage(entry.appTabId, {
                  type: 'EXTENSION_PROGRESS_TO_PAGE',
                  requestId,
                  payload: {
                    kind: 'nosposCategoryFields',
                    index: i + 1,
                    total: ids.length,
                    categoryNosposId,
                    fields,
                    buybackRatePercent,
                    offerRatePercent,
                    scrapeOk: pack.ok === true,
                    scrapeError: pack.error || null,
                  },
                })
                .catch(() => {});
            }
            results.push({
              categoryNosposId,
              fields,
              buybackRatePercent,
              offerRatePercent,
              ok: pack.ok === true,
              error: pack.error || null,
            });
          }
          console.log('[CG Suite] NOSPOS_PAGE_READY – openNosposSiteForCategoryFieldsBulk: done', {
            requestId,
            categories: results.length,
          });
          return {
            ok: true,
            bulk: true,
            results,
            total: ids.length,
          };
        },
      });
      return;
    }
  }
  console.log('[CG Suite] NOSPOS_PAGE_READY – no matching pending request for tab', tabId);
}

async function handleNosposLoginRequired(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  const loginUrl = message?.url || '';
  const errorMessage = 'You must be logged into NoSpos to continue.';

  const pending = await getPending();

  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.listingTabId !== tabId) continue;
    if (
      entry.type !== 'openNospos' &&
      entry.type !== 'openNosposCustomerIntake' &&
      entry.type !== 'openNosposCustomerIntakeWaiting' &&
      entry.type !== 'openNosposCustomerIntakeSaveFailed' &&
      entry.type !== 'openNosposNewCustomerCreate' &&
      entry.type !== 'openNosposNewCustomerCreateWaiting' &&
      entry.type !== 'openNosposSiteOnly' &&
      entry.type !== 'openNosposSiteForFields' &&
      entry.type !== 'openNosposSiteForCategoryFields' &&
      entry.type !== 'openNosposSiteForCategoryFieldsBulk'
    ) {
      continue;
    }

    await failNosposRequestAndCloseTab(requestId, entry, errorMessage);
    console.log('[CG Suite] NOSPOS_LOGIN_REQUIRED – closed tab and failed request', { requestId, tabId, loginUrl, type: entry.type });
    return;
  }

  console.log('[CG Suite] NOSPOS_LOGIN_REQUIRED – no matching pending request for tab', tabId, loginUrl);
}

async function handleNosposCustomerSearchReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };

  const pending = await getPending();
  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.listingTabId === tabId && entry.type === 'openNosposCustomerIntakeWaiting') {
      console.log('[CG Suite] NOSPOS_CUSTOMER_SEARCH_READY – returning requestId to content script', { requestId });
      return { ok: true, requestId };
    }
  }
  return { ok: false };
}

async function handleNosposCustomerCreateReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };

  const pending = await getPending();
  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.listingTabId !== tabId) continue;
    if (entry.type === 'openNosposNewCustomerCreate' || entry.type === 'openNosposNewCustomerCreateWaiting') {
      // First time we see /customers/create, lock in the waiting state so the
      // post-login NOSPOS_PAGE_READY handler doesn't kick us off.
      if (entry.type !== 'openNosposNewCustomerCreateWaiting') {
        pending[requestId] = { ...entry, type: 'openNosposNewCustomerCreateWaiting' };
        await setPending(pending);
      }
      console.log('[CG Suite] NOSPOS_CUSTOMER_CREATE_READY – returning requestId', { requestId });
      return { ok: true, requestId };
    }
  }
  return { ok: false };
}

async function handleNosposCustomerDetailReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };

  const pending = await getPending();
  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.listingTabId !== tabId) continue;
    if (entry.type === 'openNosposCustomerIntakeWaiting') {
      console.log('[CG Suite] NOSPOS_CUSTOMER_DETAIL_READY – edit flow, returning requestId', { requestId });
      return { ok: true, requestId, flow: 'edit' };
    }
    if (entry.type === 'openNosposNewCustomerCreate' || entry.type === 'openNosposNewCustomerCreateWaiting') {
      // The user submitted the create form and NoSpos redirected to the new
      // customer's /view page. Show the post-create confirmation panel.
      console.log('[CG Suite] NOSPOS_CUSTOMER_DETAIL_READY – post-create, returning requestId', { requestId });
      return { ok: true, requestId, flow: 'newCreate' };
    }
  }
  return { ok: false };
}

async function handleNosposCustomerDone(message, sender) {
  const { requestId, cancelled } = message;
  if (!requestId) return;

  const pending = await getPending();
  const entry = pending[requestId];
  if (!entry) return;

  if (message.saveFailed) {
    // Keep the entry so the user can fix the save on NosPos and we can still
    // switch them back. Change the type so NOSPOS_CUSTOMER_DETAIL_READY won't
    // try to show the modal again while waiting for the fix.
    pending[requestId] = { ...entry, type: 'openNosposCustomerIntakeSaveFailed' };
    await setPending(pending);
  } else {
    delete pending[requestId];
    await setPending(pending);
  }

  if (entry.appTabId) {
    // If the entry was already in the saveFailed state, the app's promise listener
    // was removed when we sent the first saveFailed response, so skip the redundant
    // send. Just call focusAppTab to switch back to the system tab.
    const isPostSaveFailedFix = entry.type === 'openNosposCustomerIntakeSaveFailed';
    if (!isPostSaveFailedFix) {
      chrome.tabs.sendMessage(entry.appTabId, {
        type: 'EXTENSION_RESPONSE_TO_PAGE',
        requestId,
        response: cancelled
          ? { ok: false, cancelled: true }
          : { ok: true, customer: message.customer || null, changes: message.changes || [], saveFailed: !!message.saveFailed }
      }).catch(() => {});
    }
    if (!message.saveFailed) {
      await focusAppTab(entry.appTabId);
    }
  }
  // Close the NoSpos tab when flow completed successfully (keep it open if save failed so user can fix)
  if (entry.listingTabId != null && !message.saveFailed) {
    await chrome.tabs.remove(entry.listingTabId).catch(() => {});
  }
  console.log('[CG Suite] NOSPOS_CUSTOMER_DONE – resolved app promise, focused app tab, closed nospos tab', { requestId, cancelled });
}
async function handleNosposStockSearchReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };

  let data = (await chrome.storage.session.get('cgNosposRepricingData')).cgNosposRepricingData;

  if (!data) {
    const pending = await getPending();
    for (const [requestId, entry] of Object.entries(pending)) {
      if (entry.type === 'openNospos' && entry.listingTabId === tabId) {
        const repricingData = entry.repricingData || [];
        delete pending[requestId];
        await setPending(pending);
        const stored = await chrome.storage.local.get('cgNosposRepricingProgress');
        const prog = stored.cgNosposRepricingProgress || {};
        data = {
          repricingData,
          appTabId: entry.appTabId,
          completedBarcodes: prog.completedBarcodes || {},
          completedItems: prog.completedItems || [],
          cartKey: prog.cartKey || '',
          nosposTabId: tabId,
          queue: buildBarcodeQueue(repricingData, prog.completedBarcodes || {}, prog.completedItems || [], {}),
          awaitingStockSelection: false,
          currentBarcode: '',
          currentItemId: '',
          currentItemIndex: null,
          currentBarcodeIndex: null,
          skippedBarcodes: {},
          ambiguousBarcodes: [],
          unverifiedBarcodes: [],
          justSaved: false,
          verifyRetries: 0,
          done: false,
          pendingCompletion: null,
          verifiedChanges: []
        };
        await chrome.storage.session.set({ cgNosposRepricingData: data });
        chrome.tabs.sendMessage(entry.appTabId, {
          type: 'EXTENSION_RESPONSE_TO_PAGE',
          requestId,
          response: { success: true, ready: true }
        }).catch(() => {});
        break;
      }
    }
  }

  if (!data) return { ok: false };

  const {
    repricingData = [],
    completedBarcodes = {},
    completedItems = [],
    awaitingStockSelection,
    currentBarcode
  } = data;
  const queue = getActiveQueue(data);
  const next = queue[0] || null;

  if (!next) {
    const finalizingData = appendRepricingLog(data, 'All barcodes processed. Finalizing repricing…');
    await chrome.storage.session.set({ cgNosposRepricingData: finalizingData });
    await broadcastRepricingStatus(finalizingData.appTabId, finalizingData, {
      step: 'finalizing',
      message: 'All barcodes processed. Finalizing repricing…'
    });
    await finalizeNosposRepricing(finalizingData, tabId);
    return { ok: false };
  }

  if (awaitingStockSelection && currentBarcode === next.barcode) {
    const ambiguousData = markBarcodeAsAmbiguous(data, next);
    const nextQueue = queue.slice(1);
    const nextAfterSkip = nextQueue[0] || null;

    if (!nextAfterSkip) {
      await finalizeNosposRepricing({ ...ambiguousData, queue: nextQueue }, tabId);
      return { ok: false };
    }

    const updatedData = appendRepricingLog(
      {
        ...ambiguousData,
        queue: nextQueue,
        nosposTabId: tabId,
        awaitingStockSelection: true,
        currentBarcode: nextAfterSkip.barcode,
        currentItemId: nextAfterSkip.itemId || '',
        currentItemIndex: nextAfterSkip.itemIndex,
        currentBarcodeIndex: nextAfterSkip.barcodeIndex,
        verifyRetries: 0
      },
      `No single stock row could be selected for ${next.barcode}. Marking it as ambiguous and moving to ${nextAfterSkip.barcode}.`,
      'warning'
    );
    await chrome.storage.session.set({ cgNosposRepricingData: updatedData });
    await broadcastRepricingStatus(updatedData.appTabId, updatedData, {
      step: 'search',
      message: `Skipped ambiguous barcode ${next.barcode}`
    });

    return { ok: true, firstBarcode: nextAfterSkip.barcode, skippedPreviousBarcode: true };
  }

  const itemWithContext = repricingData[next.itemIndex];
  const dataWithItemHeader = addItemContextLog(data, itemWithContext);

  const editUrl = getStockEditUrl(next.stockUrl);
  if (editUrl) {
    const updatedData = appendRepricingLog(
      {
        ...dataWithItemHeader,
        queue,
        nosposTabId: tabId,
        awaitingStockSelection: false,
        currentBarcode: next.barcode,
        currentItemId: next.itemId || '',
        currentItemIndex: next.itemIndex,
        currentBarcodeIndex: next.barcodeIndex,
        verifyRetries: 0
      },
      `Navigating directly to stock edit for "${next.itemTitle || repricingData[next.itemIndex]?.title || 'unknown'}" [${next.barcode}]`
    );
    await chrome.storage.session.set({ cgNosposRepricingData: updatedData });
    await broadcastRepricingStatus(updatedData.appTabId, updatedData, {
      step: 'search',
      message: `Opening stock edit for ${next.barcode}`,
      currentBarcode: next.barcode,
      currentItemId: next.itemId || '',
      currentItemTitle: next.itemTitle || repricingData[next.itemIndex]?.title || ''
    });
    await chrome.tabs.update(tabId, { url: editUrl });
    return { ok: false };
  }

  const updatedData = appendRepricingLog(
    {
      ...dataWithItemHeader,
      queue,
      nosposTabId: tabId,
      awaitingStockSelection: true,
      currentBarcode: next.barcode,
      currentItemId: next.itemId || '',
      currentItemIndex: next.itemIndex,
      currentBarcodeIndex: next.barcodeIndex,
      verifyRetries: 0
    },
    `Searching NosPos for barcode ${next.barcode} — "${next.itemTitle || repricingData[next.itemIndex]?.title || 'unknown'}"`
  );
  await chrome.storage.session.set({ cgNosposRepricingData: updatedData });
  await broadcastRepricingStatus(updatedData.appTabId, updatedData, {
    step: 'search',
    message: `Searching barcode ${next.barcode}`,
    currentBarcode: next.barcode,
    currentItemId: next.itemId || '',
    currentItemTitle: next.itemTitle || repricingData[next.itemIndex]?.title || ''
  });

  return { ok: true, firstBarcode: next.barcode };
}

async function handleNosposStockEditReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };

  const stored = await chrome.storage.session.get('cgNosposRepricingData');
  const data = stored.cgNosposRepricingData;
  if (!data) return { ok: false };
  if (data.justSaved) return { ok: false, waitingForVerification: true };

  const { repricingData = [], appTabId, completedBarcodes = {}, completedItems = [], cartKey, nosposTabId } = data;
  const queue = getActiveQueue(data);
  const next = queue[0] || null;
  if (!next) return { ok: false };

  const item = repricingData[next.itemIndex];
  const raw = item?.salePrice;
  const salePrice = raw != null && typeof raw === 'number' && !Number.isNaN(raw)
    ? raw.toFixed(2)
    : (raw != null ? String(raw) : '');

  const newStockName = (item?.title || '').trim();
  const currentStockName = (message.currentStockName || '').trim();
  const currentExternallyListed = !!message.currentExternallyListed;
  const oldPrice = (message.oldRetailPrice || '').trim();

  const stateBase = {
    ...data,
    repricingData,
    appTabId,
    completedBarcodes,
    completedItems,
    cartKey,
    nosposTabId: nosposTabId || tabId,
    queue,
    awaitingStockSelection: false,
    currentBarcode: '',
    currentItemId: '',
    currentItemIndex: null,
    currentBarcodeIndex: null,
    justSaved: true,
    lastSalePrice: salePrice,
    verifyRetries: 0,
    done: false,
    pendingCompletion: {
      itemId: item?.itemId,
      barcodeIndex: next.barcodeIndex,
      barcode: next.barcode,
      oldRetailPrice: oldPrice,
      stockBarcode: message.stockBarcode || '',
      stockName: currentStockName || newStockName || '',
      stockUrl: sender.tab?.url || ''
    }
  };

  let d = appendRepricingLog(stateBase, `Saving "${item?.title || next.barcode}" [${next.barcode}]`);

  if (newStockName) {
    const nameMsg = !currentStockName
      ? `Name: setting to "${newStockName}"`
      : currentStockName === newStockName
      ? `Name: "${newStockName}" (already correct)`
      : `Name: "${currentStockName}" → "${newStockName}"`;
    d = appendRepricingLog(d, nameMsg);
  }

  d = appendRepricingLog(d, currentExternallyListed
    ? 'Externally Listed: already ticked'
    : 'Externally Listed: ticking');

  if (salePrice !== '') {
    d = appendRepricingLog(d, oldPrice
      ? `RRP: £${oldPrice} → £${salePrice}`
      : `RRP: setting to £${salePrice}`);
  } else if (oldPrice) {
    d = appendRepricingLog(d, `RRP: £${oldPrice} (no change)`);
  }

  const updatedData = d;
  await chrome.storage.session.set({ cgNosposRepricingData: updatedData });
  await broadcastRepricingStatus(appTabId, updatedData, {
    step: 'saving',
    message: `Saving "${item?.title || next.barcode}"…`,
    currentBarcode: next.barcode,
    currentItemId: item?.itemId || '',
    currentItemTitle: item?.title || ''
  });

  return { ok: true, salePrice, stockName: newStockName, externallyListed: true, done: false };
}

function normalizePriceForCompare(val) {
  if (val == null || val === '') return '';
  const s = String(val).replace(/[£,\s]/g, '').trim();
  const n = parseFloat(s);
  return Number.isNaN(n) ? s : n.toFixed(2);
}

async function handleNosposPageLoaded(message, sender) {
  const tabId = sender.tab?.id;
  const path = (message.path || '').toLowerCase();
  const retailPrice = (message.retailPrice || '').trim();
  const stockBarcode = (message.stockBarcode || '').trim();

  const stored = await chrome.storage.session.get('cgNosposRepricingData');
  const data = stored.cgNosposRepricingData;
  if (!data) return;

  const isSearchPage = isNosposSearchPath(path);
  const isEditPage = /^\/stock\/\d+\/edit\/?$/.test(path);

  if (isEditPage && data.justSaved) {
    const lastSalePrice = data.lastSalePrice || '';
    const expected = normalizePriceForCompare(lastSalePrice);
    const actual = normalizePriceForCompare(retailPrice);
    const verified = expected !== '' && actual !== '' && expected === actual;

    if (verified) {
      const verifiedData = {
        ...data,
        pendingCompletion: data.pendingCompletion
          ? {
              ...data.pendingCompletion,
              stockBarcode: stockBarcode || data.pendingCompletion.stockBarcode || ''
            }
          : data.pendingCompletion
      };
      const updatedProgress = applyVerifiedBarcodeCompletion(verifiedData);
      if (!updatedProgress) return;
      const { completedBarcodes, completedItems, verifiedChanges } = updatedProgress;
      const nextQueue = removeQueueHead(data.queue, data.pendingCompletion);
      const payload = { cartKey: data.cartKey, completedBarcodes, completedItems };
      const verifiedState = appendRepricingLog(
        {
          ...verifiedData,
          completedBarcodes,
          completedItems,
          verifiedChanges,
          queue: nextQueue
        },
        `Barcode ${data.pendingCompletion?.barcode || stockBarcode || 'barcode'} saved.`,
        'success'
      );
      await broadcastRepricingStatus(data.appTabId, verifiedState, {
        ...payload,
        step: 'verified',
        message: `Verified ${data.pendingCompletion?.barcode || stockBarcode || 'barcode'}.`
      });
      await chrome.storage.local.set({
        cgNosposRepricingProgress: {
          cartKey: data.cartKey,
          completedBarcodes,
          completedItems,
          appTabId: data.appTabId
        }
      });
      const done = nextQueue.length === 0;

      if (done) {
        await finalizeNosposRepricing(
          {
            ...verifiedState,
            completedBarcodes,
            completedItems,
            verifiedChanges,
            queue: nextQueue,
            pendingCompletion: null
          },
          tabId
        );
      } else {
        await chrome.storage.session.set({
          cgNosposRepricingData: {
            ...verifiedState,
            completedBarcodes,
            completedItems,
            verifiedChanges,
            queue: nextQueue,
            justSaved: false,
            verifyRetries: 0,
            pendingCompletion: null,
            done
          }
        });
        if (tabId) {
          const nextEditUrl = getStockEditUrl(nextQueue[0]?.stockUrl);
          await chrome.tabs.update(tabId, { url: nextEditUrl || 'https://nospos.com/stock/search' });
        }
      }
    } else {
      const retries = (data.verifyRetries || 0) + 1;
      if (retries < 5) {
        const retryState = {
          ...data,
          verifyRetries: retries
        };
        await chrome.storage.session.set({ cgNosposRepricingData: retryState });
        await broadcastRepricingStatus(data.appTabId, retryState, {
          step: 'verifying',
          message: `Checking that NoSpos saved the new retail price for ${data.pendingCompletion?.barcode || stockBarcode || 'barcode'}…`
        });
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'NOSPOS_VERIFY_RETAIL_PRICE' }).catch(() => {});
        }, 800);
      } else {
        // Max retries exceeded — skip this barcode, record it as unverified, and move to the next one.
        // The NosPos record being edited is the single source of truth for the modal: its live name,
        // its barserial, and its edit URL all describe the same row. Avoid mixing in the upload-row
        // title or the intake-selected barserial — either can drift from what's on the NosPos page.
        const pendingCompletion = data.pendingCompletion || {};
        const unverifiedItem = (data.repricingData || []).find(entry => String(entry?.itemId) === String(pendingCompletion.itemId));
        const unverifiedBarcodes = [...(data.unverifiedBarcodes || [])];
        const alreadyTracked = unverifiedBarcodes.some(
          e => String(e?.itemId) === String(pendingCompletion.itemId) && e?.barcodeIndex === pendingCompletion.barcodeIndex
        );
        if (!alreadyTracked && pendingCompletion.itemId != null) {
          const nosposBarcode = pendingCompletion.stockBarcode || stockBarcode || pendingCompletion.barcode || '';
          const nosposName = pendingCompletion.stockName || unverifiedItem?.title || '';
          unverifiedBarcodes.push({
            itemId: pendingCompletion.itemId,
            itemTitle: nosposName,
            barcodeIndex: pendingCompletion.barcodeIndex,
            stockBarcode: nosposBarcode,
            stockUrl: pendingCompletion.stockUrl || ''
          });
        }

        const nextQueue = removeQueueHead(getActiveQueue(data), pendingCompletion);
        const skippedData = appendRepricingLog(
          {
            ...data,
            unverifiedBarcodes,
            queue: nextQueue,
            justSaved: false,
            verifyRetries: 0,
            pendingCompletion: null
          },
          `Could not verify saved price for "${pendingCompletion.barcode || stockBarcode || 'barcode'}" after ${retries} attempts — skipping and moving on.`,
          'warning'
        );

        if (nextQueue.length === 0) {
          await finalizeNosposRepricing(skippedData, tabId);
        } else {
          await chrome.storage.session.set({ cgNosposRepricingData: skippedData });
          await broadcastRepricingStatus(data.appTabId, skippedData, {
            step: 'search',
            message: `Verification failed for "${pendingCompletion.barcode || 'barcode'}". Moving to next item…`
          });
          if (tabId) {
            const nextEditUrl = getStockEditUrl(nextQueue[0]?.stockUrl);
            await chrome.tabs.update(tabId, { url: nextEditUrl || 'https://nospos.com/stock/search' });
          }
        }
      }
    }
    return;
  }

  if (isSearchPage && data.justSaved) {
    const searchResetState = appendRepricingLog(
      { ...data, justSaved: false, verifyRetries: 0 },
      'Returned to the stock search page. Preparing the next barcode…'
    );
    await chrome.storage.session.set({
      cgNosposRepricingData: searchResetState
    });
    await broadcastRepricingStatus(data.appTabId, searchResetState, {
      step: 'search',
      message: 'Returned to stock search. Preparing the next barcode…'
    });
    return;
  }

  if (!isSearchPage && !isEditPage && tabId) {
    const rerouteState = appendRepricingLog(
      { ...data, justSaved: false, verifyRetries: 0 },
      'NoSpos moved away from the expected page. Redirecting back to stock search…',
      'warning'
    );
    await chrome.storage.session.set({
      cgNosposRepricingData: rerouteState
    });
    await broadcastRepricingStatus(data.appTabId, rerouteState, {
      step: 'search',
      message: 'Redirecting the background worker back to stock search…'
    });
    await chrome.tabs.update(tabId, { url: 'https://nospos.com/stock/search' });
  }
}
