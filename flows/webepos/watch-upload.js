/**
 * Watch a Web EPOS upload worker tab and notify the app of lifecycle events.
 */

function watchWebEposUploadTab(webeposTabId, requestId, entry) {
  let resolved = false;
  let settleTimer = null;
  let timeoutId = null;

  function cleanupWatchListeners() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    chrome.tabs.onUpdated.removeListener(onUpdated);
    webEposUploadWatchAbortByTabId.delete(webeposTabId);
  }

  webEposUploadWatchAbortByTabId.set(webeposTabId, () => {
    if (resolved) return;
    resolved = true;
    cleanupWatchListeners();
  });

  async function fail(err) {
    if (resolved) return;
    resolved = true;
    cleanupWatchListeners();
    await clearPendingRequest(requestId);
    const msg = err || 'Web EPOS did not load.';
    logUpload('watchWebEposUploadTab', 'fail', { webeposTabId, requestId, error: msg }, msg);
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
    try {
      const session = await readWebEposUploadSession();
      if (session && Number(session.workerTabId) === Number(webeposTabId)) {
        await writeWebEposUploadSession({ ...session, workerTabId: null });
        await removeWebEposWorkerByTabId(webeposTabId);
      }
      await clearWebEposUploadSession();
    } catch (_) {}
  }

  async function ok(finalUrl) {
    if (resolved) return;
    resolved = true;
    cleanupWatchListeners();
    await clearPendingRequest(requestId);
    const lastUrl = finalUrl || WEB_EPOS_PRODUCTS_URL;
    logUpload('watchWebEposUploadTab', 'ready', { webeposTabId, requestId, url: lastUrl });
    await writeWebEposUploadSession({
      workerTabId: webeposTabId,
      appTabId: entry.appTabId,
      lastUrl,
    });
    if (entry.appTabId != null) {
      await notifyAppExtensionResponse(entry.appTabId, requestId, { ok: true, url: lastUrl });
    }
  }

  function scheduleSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(async () => {
      settleTimer = null;
      if (resolved) return;
      try {
        const t = await chrome.tabs.get(webeposTabId);
        const c = classifyWebEposUrl(t.url || '');
        logUpload('watchWebEposUploadTab', 'settle', { webeposTabId, url: t.url || '', classify: c === 'login' || c === 'wait' ? c : c?.kind });
        if (c === 'login') {
          await fail('You must be logged into Web EPOS to continue.');
          return;
        }
        if (c !== 'wait' && c.kind === 'ready') await ok(c.url);
      } catch (e) {
        await fail(e?.message || 'Web EPOS check failed.');
      }
    }, 600);
  }

  async function onUpdated(id, info) {
    if (id !== webeposTabId || resolved) return;
    if (info.status !== 'complete') return;
    try {
      const t = await chrome.tabs.get(webeposTabId);
      const c = classifyWebEposUrl(t.url || '');
      logUpload('watchWebEposUploadTab', 'tab-updated', { webeposTabId, url: t.url || '', classify: c === 'login' || c === 'wait' ? c : c?.kind });
      if (c === 'login') {
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        await fail('You must be logged into Web EPOS to continue.');
        return;
      }
      if (c !== 'wait' && c.kind === 'ready') scheduleSettle();
    } catch (e) {
      await fail(e?.message || 'Web EPOS check failed.');
    }
  }

  timeoutId = setTimeout(() => {
    void fail('Timed out waiting for Web EPOS to load.');
  }, 60000);
  chrome.tabs.onUpdated.addListener(onUpdated);
  logUpload('watchWebEposUploadTab', 'watch-installed', { webeposTabId, requestId, timeoutMs: 60000 });
  chrome.tabs
    .get(webeposTabId)
    .then((t) => {
      if (resolved) return;
      if (t.status === 'complete' && t.url) {
        void onUpdated(webeposTabId, { status: 'complete' });
      }
    })
    .catch(() => {});
}

// focusAppTab, waitForTabLoadComplete — imported from bg/tab-utils.js

importScripts('tasks/jewellery-scrap-prices-tab.js');

// ── CeX nav scrape (super-categories) — see cex-scrape/ in repo ──────────────

importScripts('tasks/nospos-stock-category-pagination.js');

/**
 * Shared tail for Data-page imports: clear pending, run `work(tabId)` after NOSPOS_PAGE_READY,
 * then post `{ response }` or `{ error }` to the app tab (same contract as category import).
 */
