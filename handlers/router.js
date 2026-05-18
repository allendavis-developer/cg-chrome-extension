/**
 * Single entry point for chrome.runtime.onMessage — dispatches to the flow handlers.
 * Must load AFTER every handler it names.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[CG Suite bg router] onMessage', { type: message?.type, action: message?.payload?.action, fromTab: sender?.tab?.id });
  if (message.type === CG_JEWELLERY_SCRAP.MSG_SCRAPED) {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return true;
    }
    forwardJewelleryScrapPricesToApp(tabId, message.payload)
      .catch((e) => console.warn('[CG Suite] Jewellery scrap forward to app:', e?.message))
      .finally(async () => {
        await unregisterJewelleryScrapWorkerTab(tabId);
        await chrome.tabs.remove(tabId).catch(() => {});
        sendResponse({ ok: true });
      });
    return true;
  }

  if (message.type === 'BRIDGE_FORWARD') {
    console.log('[CG Suite bg router] dispatching BRIDGE_FORWARD', { action: message?.payload?.action, requestId: message?.requestId });
    handleBridgeForward(message, sender)
      .then((r) => {
        console.log('[CG Suite bg router] BRIDGE_FORWARD resolved', { action: message?.payload?.action, requestId: message?.requestId, result: r });
        sendResponse(r);
      })
      .catch((e) => {
        console.log('[CG Suite bg router] BRIDGE_FORWARD rejected', { action: message?.payload?.action, requestId: message?.requestId, error: e?.message || String(e) });
        sendResponse({
          ok: false,
          error: e?.message || String(e) || 'Extension bridge handler failed',
        });
      });
    return true;
  }

  if (message.type === 'CG_APP_PAGE_UNLOADING') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      void closeWebEposUploadSessionForAppTab(tabId);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'LISTING_PAGE_READY') {
    handleListingPageReady(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'SCRAPED_DATA') {
    handleScrapedData(message)
      .then(r => sendResponse(r))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'NOSPOS_PAGE_READY') {
    handleNosposPageReady(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'NOSPOS_STOCK_SEARCH_READY') {
    handleNosposStockSearchReady(message, sender)
      .then((r) => sendResponse(r || { ok: false }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'NOSPOS_STOCK_EDIT_READY') {
    handleNosposStockEditReady(message, sender)
      .then((r) => sendResponse(r || { ok: false }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'NOSPOS_PAGE_LOADED') {
    handleNosposPageLoaded(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'PARK_LOG_ENTRY') {
    logPark(
      message.fn || 'content-nospos-agreement-fill',
      message.phase || 'step',
      message.data || {},
      message.msg || ''
    );
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'NOSPOS_LOGIN_REQUIRED') {
    handleNosposLoginRequired(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'NOSPOS_CUSTOMER_SEARCH_READY') {
    handleNosposCustomerSearchReady(message, sender)
      .then(r => sendResponse(r || { ok: false }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'NOSPOS_CUSTOMER_DETAIL_READY') {
    handleNosposCustomerDetailReady(message, sender)
      .then(r => sendResponse(r || { ok: false }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'NOSPOS_CUSTOMER_DONE') {
    handleNosposCustomerDone(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'FETCH_ADDRESS_SUGGESTIONS') {
    handleFetchAddressSuggestions(message)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e?.message || 'Failed' }));
    return true;
  }

  if (message.type === 'NOSPOS_PARK_UI_SYNC') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ show: false });
      return true;
    }
    chrome.storage.session
      .get(NOSPOS_PARK_UI_STORAGE_KEY)
      .then((data) => {
        const lock = data[NOSPOS_PARK_UI_STORAGE_KEY];
        const show = !!(lock && lock.active && lock.tabId === tabId);
        const duplicatePrompt =
          show && lock.duplicatePromptRequestId
            ? {
                requestId: lock.duplicatePromptRequestId,
                agreementId: lock.duplicatePromptAgreementId ?? null,
              }
            : null;
        sendResponse({
          show,
          message: lock?.message || NOSPOS_PARK_OVERLAY_DEFAULT_MSG,
          duplicatePrompt,
        });
      })
      .catch(() => sendResponse({ show: false }));
    return true;
  }

  if (message.type === 'NOSPOS_PARK_DUPLICATE_CHOICE') {
    const tabId = sender.tab?.id;
    const requestId = message.requestId;
    const choice = message.choice;
    if (
      tabId != null &&
      requestId &&
      (choice === 'delete' || choice === 'cancel')
    ) {
      resolveNosposDuplicateUserChoice(requestId, tabId, choice);
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
