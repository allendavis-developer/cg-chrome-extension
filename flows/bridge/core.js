/**
 * Bridge-core helpers shared by handleBridgeForward + message handlers: running
 * NosPos data imports after login, notifying the app, clearing pending requests,
 * CeX super-category nav scrape, repricing completion notifier.
 */

async function runNosposDataImportAfterLogin({ tabId, requestId, entry, failureMessageDefault, work }) {
  const pending = await getPending();
  delete pending[requestId];
  await setPending(pending);
  try {
    const response = await work(tabId);
    if (entry.appTabId != null) {
      chrome.tabs
        .sendMessage(entry.appTabId, {
          type: 'EXTENSION_RESPONSE_TO_PAGE',
          requestId,
          response,
        })
        .catch(() => {});
      await focusAppTab(entry.appTabId);
    }
  } catch (e) {
    const msg = e?.message || failureMessageDefault || 'NoSpos import failed.';
    console.error('[CG Suite] runNosposDataImportAfterLogin', { requestId, error: msg });
    if (entry.appTabId != null) {
      chrome.tabs
        .sendMessage(entry.appTabId, {
          type: 'EXTENSION_RESPONSE_TO_PAGE',
          requestId,
          error: msg,
        })
        .catch(() => {});
      await focusAppTab(entry.appTabId);
    }
  } finally {
    if (tabId != null) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

async function notifyAppExtensionResponse(appTabId, requestId, response) {
  if (!appTabId) return;
  await focusAppTab(appTabId);
  await chrome.tabs.sendMessage(appTabId, {
    type: 'EXTENSION_RESPONSE_TO_PAGE',
    requestId,
    response,
  }).catch(() => {});
}

async function clearPendingRequest(requestId) {
  const pending = await getPending();
  if (pending[requestId]) {
    delete pending[requestId];
    await setPending(pending);
  }
}

/**
 * Opens uk.webuy.com, reads ul.nav-menu super-category links via cex-scrape content script,
 * posts results to the app tab. Deferred promise (content-bridge does not resolve early).
 */
async function executeCexSuperCategoryNavScrape(requestId, appTabId) {
  const CEX_HOME = 'https://uk.webuy.com/';
  let scrapeTabId = null;
  try {
    const tab = await chrome.tabs.create({ url: CEX_HOME, active: true });
    scrapeTabId = tab.id;
    await putTabInYellowGroup(scrapeTabId);

    const pending = await getPending();
    pending[requestId] = {
      appTabId,
      listingTabId: scrapeTabId,
      type: 'cexNavScrape',
    };
    await setPending(pending);

    await waitForTabLoadComplete(scrapeTabId, 90000);

    const maxAttempts = 32;
    let lastCode = 'NOT_TRIED';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 400));
      }
      try {
        const resp = await chrome.tabs.sendMessage(scrapeTabId, {
          type: 'CEX_SCRAPE_SUPER_CATEGORIES',
        });
        if (resp && resp.ok && Array.isArray(resp.categories) && resp.categories.length > 0) {
          await clearPendingRequest(requestId);
          await notifyAppExtensionResponse(appTabId, requestId, {
            success: true,
            categories: resp.categories,
            scrapedAt: resp.scrapedAt,
            sourceTabUrl: resp.sourceUrl,
            warnings: resp.warnings,
          });
          return;
        }
        lastCode = (resp && resp.code) || 'EMPTY_OR_NOT_READY';
      } catch (e) {
        lastCode = (e && e.message) || 'SEND_MESSAGE_FAILED';
      }
    }

    await clearPendingRequest(requestId);
    await notifyAppExtensionResponse(appTabId, requestId, {
      success: false,
      error:
        'Could not read CeX super-categories after ' +
        maxAttempts +
        ' attempts (' +
        lastCode +
        '). The site may still be loading or the header layout changed.',
    });
  } catch (e) {
    await clearPendingRequest(requestId);
    await notifyAppExtensionResponse(appTabId, requestId, {
      success: false,
      error: (e && e.message) || 'CeX scrape failed',
    });
  }
}

async function sendRepricingComplete(appTabId, payload) {
  if (!appTabId) return;
  await chrome.tabs.sendMessage(appTabId, {
    type: 'REPRICING_COMPLETE_TO_PAGE',
    payload
  }).catch(() => {});
}

// NosPos HTML parsers, address lookup — imported from bg/nospos-html.js

// ── Message router ─────────────────────────────────────────────────────────────
