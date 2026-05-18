/**
 * NosPos tab recovery + rate-limit (429) handling + message-with-abort retries.
 * Exports: waitForNosposTabComplete, maybeRecoverNospos429Page, throttleAndRecoverNospos429,
 *          sendParkMessageToTabWithAbort, waitForNosposNewAgreementItemsTabUrl,
 *          waitForNosposTabBuyingAfterPark
 */

async function waitForNosposTabComplete(tabId, maxWaitMs = 45000) {
  const deadline = Date.now() + Math.max(1000, maxWaitMs);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, error: 'The NoSpos tab was closed' };
    if (tab.status === 'complete') return { ok: true, url: tab.url || '' };
    await sleep(120);
  }
  return { ok: false, error: 'NoSpos page did not finish loading in time after reload' };
}

async function maybeRecoverNospos429Page(tabId, context = '') {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, recovered: false, error: 'The NoSpos tab was closed' };
  const url = String(tab.url || '');
  if (!/nospos\.com/i.test(url) || tab.status !== 'complete') {
    return { ok: true, recovered: false, skipped: true };
  }

  const now = Date.now();
  const last = nospos429LastRecoveryAtByTabId.get(tabId) || 0;
  if (now - last < 5000) {
    return { ok: true, recovered: false, skipped: true };
  }

  const probe = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => {
        const h = document.querySelector('h1.text-danger.mb-1');
        const text = String(h?.textContent || '').trim();
        return {
          has429Heading: /too many requests/i.test(text) && /\(#\s*429\)/i.test(text),
          heading: text || null,
          href: window.location.href,
        };
      },
    })
    .catch(() => [{ result: { has429Heading: false, heading: null, href: null } }]);

  const info = probe?.[0]?.result || { has429Heading: false, heading: null, href: null };
  if (!info.has429Heading) return { ok: true, recovered: false };

  nospos429LastRecoveryAtByTabId.set(tabId, Date.now());
  logPark(
    'nospos429Guard',
    'error',
    { tabId, context, heading: info.heading, href: info.href, tickmark: 'x' },
    'NosPos returned Too Many Requests (#429) — waiting 4s then reloading the page'
  );

  // Capture the active tab in the worker tab's window BEFORE reload, so we can
  // restore it if the recovery reload pulls focus to the worker. Worker tabs
  // are created with `active: false`, but in practice 429 reloads sometimes
  // surface the worker tab on top, yanking the user away from the app tab.
  let activeBeforeId = null;
  if (tab.windowId != null) {
    try {
      const [activeBefore] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeBefore && activeBefore.id !== tabId) activeBeforeId = activeBefore.id;
    } catch (_) {}
  }

  await sleep(NOSPOS_429_RELOAD_DELAY_MS);
  await chrome.tabs.reload(tabId).catch(() => {});
  const waitReload = await waitForNosposTabComplete(tabId, 45000);

  // Restore the previously-active tab if the worker stole focus during reload.
  if (activeBeforeId != null && tab.windowId != null) {
    try {
      const [activeAfter] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeAfter && activeAfter.id === tabId) {
        await chrome.tabs.update(activeBeforeId, { active: true }).catch(() => {});
      }
    } catch (_) {}
  }

  logPark(
    'nospos429Guard',
    waitReload.ok ? 'step' : 'error',
    { tabId, context, waitReload },
    waitReload.ok
      ? '429 recovery reload complete'
      : '429 recovery reload did not complete cleanly'
  );
  return { ok: true, recovered: true, waitReload };
}

async function throttleAndRecoverNospos429(tabId, context = '') {
  if (NOSPOS_PARK_GLOBAL_STEP_DELAY_MS > 0) {
    await sleep(NOSPOS_PARK_GLOBAL_STEP_DELAY_MS);
  }
  return maybeRecoverNospos429Page(tabId, context);
}

async function sendParkMessageToTabWithAbort(tabId, message, retries, delayMs) {
  const existingErr = getNosposParkTabClosedError(tabId);
  if (existingErr) {
    throw new Error(existingErr);
  }
  await throttleAndRecoverNospos429(
    tabId,
    `send:${String(message?.phase || message?.type || 'unknown')}`
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onRemoved.removeListener(onRemoved);
      } catch (_) {}
      fn(value);
    };
    const onRemoved = (removedTabId, removeInfo) => {
      if (removedTabId !== tabId) return;
      markNosposParkTabClosed(tabId, removeInfo);
      finish(reject, new Error(NOSPOS_PARK_TAB_CLOSED_ERR));
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    sendMessageToTabWithRetries(tabId, message, retries, delayMs)
      .then((res) => finish(resolve, res))
      .catch((err) => finish(reject, err));
  });
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  markNosposParkTabClosed(tabId, removeInfo || null);
});

async function waitForNosposNewAgreementItemsTabUrl(
  tabId,
  maxWaitMs = NOSPOS_OPEN_AGREEMENT_ITEMS_URL_WAIT_MS
) {
  logPark('waitForNosposNewAgreementItemsTabUrl', 'enter', { tabId, maxWaitMs }, 'Waiting for NoSpos to redirect to agreement items URL');
  const deadline = Date.now() + maxWaitMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      logPark('waitForNosposNewAgreementItemsTabUrl', 'error', { tabId, pollCount }, 'NoSpos tab was closed while waiting for items URL');
      return { ok: false, error: 'The NoSpos tab was closed' };
    }
    const url = tab.url || '';
    if (pollCount % 10 === 0 && tab.status === 'complete') {
      await maybeRecoverNospos429Page(tabId, 'waitForNosposNewAgreementItemsTabUrl');
    }
    const isItems = isNosposAgreementItemsUrl(url);
    if (pollCount % 10 === 0) {
      logPark('waitForNosposNewAgreementItemsTabUrl', 'step', { pollCount, tabStatus: tab.status, url, isItems }, 'Polling for items URL');
    }
    if (tab.status === 'complete' && isItems) {
      logPark('waitForNosposNewAgreementItemsTabUrl', 'exit', { url, pollCount }, 'Items URL reached');
      return { ok: true, url };
    }
    pollCount++;
    await sleep(300);
  }
  const finalTab = await chrome.tabs.get(tabId).catch(() => null);
  logPark('waitForNosposNewAgreementItemsTabUrl', 'error', { tabId, pollCount, finalUrl: finalTab?.url }, 'Timed out waiting for items URL');
  return {
    ok: false,
    error:
      'NoSpos did not reach the agreement items page in time — use the NoSpos tab if it loaded.',
  };
}

/** Park Agreement completion: NosPos navigates the tab to https://nospos.com/buying (authoritative). */
async function waitForNosposTabBuyingAfterPark(tabId, maxWaitMs = NOSPOS_BUYING_AFTER_PARK_WAIT_MS) {
  logPark('waitForNosposTabBuyingAfterPark', 'enter', { tabId, maxWaitMs }, 'Waiting for NoSpos tab to reach buying hub after park');
  const deadline = Date.now() + maxWaitMs;
  let settled = false;
  return new Promise((resolve) => {
    const onTabUpdated = (updatedTabId, _changeInfo, tab) => {
      if (updatedTabId !== tabId || settled) return;
      const url = tab?.url || '';
      if (url && isNosposBuyingHubUrl(url)) {
        logPark('waitForNosposTabBuyingAfterPark', 'result', { url }, 'Buying hub URL detected via onUpdated listener');
        done({ ok: true });
      }
    };

    const detach = () => {
      try {
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
      } catch (_) {}
      try {
        nosposBuyingAfterParkDetachByTabId.delete(tabId);
      } catch (_) {}
    };

    const done = (result) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(result);
    };

    nosposBuyingAfterParkDetachByTabId.set(tabId, detach);
    chrome.tabs.onUpdated.addListener(onTabUpdated);

    (async function poll() {
      const tab0 = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab0) {
        logPark('waitForNosposTabBuyingAfterPark', 'error', { tabId }, 'Tab was closed at poll start');
        done({ ok: false, error: 'The NoSpos tab was closed' });
        return;
      }
      if (isNosposBuyingHubUrl(tab0.url || '')) {
        logPark('waitForNosposTabBuyingAfterPark', 'result', { url: tab0.url }, 'Already on buying hub at poll start');
        done({ ok: true });
        return;
      }
      if (tab0.status === 'complete') {
        await maybeRecoverNospos429Page(tabId, 'waitForNosposTabBuyingAfterPark:init');
      }
      logPark('waitForNosposTabBuyingAfterPark', 'step', { currentUrl: tab0.url }, 'Not yet on buying hub — beginning poll loop');
      let pollCount = 0;
      while (Date.now() < deadline && !settled) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          logPark('waitForNosposTabBuyingAfterPark', 'error', { tabId, pollCount }, 'Tab closed during poll loop');
          done({ ok: false, error: 'The NoSpos tab was closed' });
          return;
        }
        const url = tab.url || '';
        if (pollCount % 15 === 0 && tab.status === 'complete') {
          await maybeRecoverNospos429Page(tabId, 'waitForNosposTabBuyingAfterPark:poll');
        }
        if (isNosposBuyingHubUrl(url)) {
          logPark('waitForNosposTabBuyingAfterPark', 'result', { url, pollCount }, 'Buying hub URL detected via poll loop');
          done({ ok: true });
          return;
        }
        pollCount++;
        await sleep(80);
      }
      if (!settled) {
        logPark('waitForNosposTabBuyingAfterPark', 'error', { tabId }, 'Timed out waiting for buying hub URL');
        done({
          ok: false,
          error:
            'NoSpos did not return to nospos.com/buying after Park — finish or confirm Park in the NoSpos tab, then try again.',
        });
      }
    })();
  });
}

/** Items page Next → wait for reload → Agreement card Actions → Park Agreement → SweetAlert OK. */
