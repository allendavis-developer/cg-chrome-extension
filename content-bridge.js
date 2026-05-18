/**
 * CG Suite Research – content script that runs ONLY on the app origin (localhost / 127.0.0.1).
 *
 * Jewellery scrap: background sends JEWELLERY_SCRAP_PRICES_TO_CONTENT → post JEWELLERY_SCRAP_PRICES (see jewelleryScrapBridge.js).
 *
 * Bridges the app page and the extension background:
 * - App posts EXTENSION_MESSAGE (e.g. startWaitingForData for "Add from CeX") → we send BRIDGE_FORWARD to background.
 * - Background eventually sends EXTENSION_RESPONSE_TO_PAGE to this tab (when user clicks "Yes" on the listing page or closes the tab) → we post EXTENSION_RESPONSE to the page so extensionBridge.js can resolve the promise.
 *
 * For startWaitingForData we do NOT post a response immediately; the app waits until the listing-page tab sends scraped data (or error). So the app's getDataFromListingPage() promise only resolves when the user confirms on CeX/eBay/CC or the tab is closed.
 */
(function () {
  /** Set `true` only when debugging page ↔ extension message flow (very noisy otherwise). */
  const CG_SUITE_CONTENT_BRIDGE_DEBUG = true;
  console.log('[CG Suite content-bridge] module loaded', { url: location.href });

  const JEWELLERY_SCRAP_TO_PAGE = 'JEWELLERY_SCRAP_PRICES_TO_CONTENT';
  const JEWELLERY_SCRAP_WINDOW = 'JEWELLERY_SCRAP_PRICES';

  const bridgeLog = (...args) => {
    if (CG_SUITE_CONTENT_BRIDGE_DEBUG && typeof console !== 'undefined') {
      console.log('[CG Suite content-bridge]', ...args);
    }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTENSION_PROGRESS_TO_PAGE') {
      window.postMessage(
        {
          type: 'EXTENSION_PROGRESS',
          requestId: msg.requestId,
          payload: msg.payload,
        },
        '*'
      );
      sendResponse({ ok: true });
    }
    if (msg.type === 'EXTENSION_RESPONSE_TO_PAGE') {
      bridgeLog('EXTENSION_RESPONSE_TO_PAGE received, requestId=', msg.requestId);
      window.postMessage({
        type: 'EXTENSION_RESPONSE',
        requestId: msg.requestId,
        response: msg.response,
        error: msg.error
      }, '*');
      sendResponse({ ok: true });
    }
    if (msg.type === 'REPRICING_PROGRESS_TO_PAGE') {
      window.postMessage({ type: 'REPRICING_PROGRESS', payload: msg.payload }, '*');
      sendResponse({ ok: true });
    }
    if (msg.type === 'REPRICING_COMPLETE_TO_PAGE') {
      window.postMessage({ type: 'REPRICING_COMPLETE', payload: msg.payload }, '*');
      sendResponse({ ok: true });
    }
    if (msg.type === JEWELLERY_SCRAP_TO_PAGE) {
      window.postMessage({ type: JEWELLERY_SCRAP_WINDOW, payload: msg.payload }, '*');
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'WEB_EPOS_UPLOAD_WORKER_TO_PAGE') {
      window.postMessage(
        { type: 'WEB_EPOS_UPLOAD_WORKER_CLOSED', lastUrl: msg.lastUrl || '' },
        '*'
      );
      sendResponse({ ok: true });
      return true;
    }
    return true;
  });

  window.addEventListener(
    'pagehide',
    function (ev) {
      if (ev.persisted) return;
      chrome.runtime.sendMessage({ type: 'CG_APP_PAGE_UNLOADING' }).catch(function () {});
    },
    { capture: true }
  );

  window.addEventListener('message', function (event) {
    if (event.source !== window || event.data?.type !== 'EXTENSION_MESSAGE') return;
    const { requestId, message } = event.data;
    console.log('[CG Suite content-bridge] EXTENSION_MESSAGE received', { action: message?.action, requestId });
    try {
      chrome.runtime.sendMessage({
        type: 'BRIDGE_FORWARD',
        requestId,
        payload: message
      }, (bridgeResponse) => {
        const lastErr = chrome.runtime.lastError;
        console.log('[CG Suite content-bridge] BRIDGE_FORWARD callback', { action: message?.action, requestId, hasResponse: bridgeResponse !== undefined, lastError: lastErr ? lastErr.message : null });
        // For these actions we don't resolve here; the target page will send data/ready later and background will send EXTENSION_RESPONSE_TO_PAGE to this tab.
        if (message.action === 'startWaitingForData' || message.action === 'startRefine' || message.action === 'openNosposAndWait' || message.action === 'openWebEposUpload' || message.action === 'reopenWebEposUpload' || message.action === 'scrapeWebEposProducts' || message.action === 'openWebEposProductCreateForUpload' || message.action === 'updateWebEposProductPrices' || message.action === 'openNosposForCustomerIntake' || message.action === 'openNosposSiteOnly' || message.action === 'openNosposSiteForFields' || message.action === 'openNosposSiteForCategoryFields' || message.action === 'openNosposSiteForCategoryFieldsBulk' || message.action === 'scrapeCexSuperCategories' || message.action === 'scrapeWebeposCategoryHierarchy') {
          bridgeLog('deferred action – not posting response; waiting for target page', message.action);
          return;
        }
        window.postMessage({
          type: 'EXTENSION_RESPONSE',
          requestId,
          response: bridgeResponse,
          error: lastErr ? lastErr.message : null
        }, '*');
      });
    } catch (err) {
      console.log('[CG Suite content-bridge] chrome.runtime.sendMessage threw', err?.message || err);
      window.postMessage({
        type: 'EXTENSION_RESPONSE',
        requestId,
        response: null,
        error: String(err?.message || err)
      }, '*');
    }
  });
})();
