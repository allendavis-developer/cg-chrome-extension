/**
 * Top-level chrome.tabs.* event listeners. Registered last so every callback they invoke is defined.
 */

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.url) return;
  if (!/nospos\.com/i.test(tab.url)) return;
  void (async () => {
    try {
      const data = await chrome.storage.session.get(NOSPOS_PARK_UI_STORAGE_KEY);
      const lock = data[NOSPOS_PARK_UI_STORAGE_KEY];
      if (!lock?.active || lock.tabId !== tabId) return;
      if (lock.duplicatePromptRequestId) {
        await sendNosposParkDuplicatePromptToTab(
          tabId,
          lock.duplicatePromptRequestId,
          lock.duplicatePromptAgreementId ?? ''
        );
      } else {
        await sendNosposParkOverlayToTab(tabId, true, lock.message);
      }
    } catch (_) {}
  })();
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  markNosposParkTabClosed(tabId, removeInfo || null);
});

/** After opening `/newagreement/agreement/create?…`, NosPos redirects to `/newagreement/{id}/items?…`. */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  void (async () => {
    try {
      const session = await readWebEposUploadSession();
      if (
        !session ||
        session.workerTabId == null ||
        Number(session.workerTabId) !== Number(tabId)
      ) {
        return;
      }
      const u = (tab.url || tab.pendingUrl || '').trim();
      if (!u || u.startsWith('chrome://')) return;
      let p;
      try {
        p = new URL(u);
      } catch {
        return;
      }
      if (p.hostname.toLowerCase() !== WEB_EPOS_UPLOAD_HOST) return;
      await writeWebEposUploadSession({ lastUrl: u });
    } catch (_) {}
  })();
});

/** Abort active `watchWebEposUploadTab` timers/listeners when the worker tab is removed (global handler). */
chrome.tabs.onRemoved.addListener((tabId) => {
  void handleWebEposWorkerTabRemovedGlobally(tabId);
});

/**
 * Injected into the Web EPOS products tab. Waits for SPA/async table render (polls).
 * Must stay self-contained for MV3 serialization; returns a Promise Chrome will await.
 * @param {number} maxWaitMs
 * @returns {Promise<{ ok: true, headers: string[], rows: object[], pagingText: string|null, pageUrl: string } | { ok: false, error: string }>}
 */
chrome.tabs.onRemoved.addListener(async (removedTabId) => {
  const nosposData = (await chrome.storage.session.get('cgNosposRepricingData')).cgNosposRepricingData;
  const progress = (await chrome.storage.local.get('cgNosposRepricingProgress')).cgNosposRepricingProgress;
  if (nosposData?.nosposTabId === removedTabId) {
    const appTabId = nosposData?.appTabId ?? progress?.appTabId;
    await clearNosposRepricingState(removedTabId);
    const cancelledStatus = {
      cartKey: nosposData?.cartKey ?? progress?.cartKey ?? '',
      running: false,
      done: false,
      cancelled: true,
      step: 'cancelled',
      message: 'NoSpos tab was closed. Repricing cancelled.',
      completedBarcodes: nosposData?.completedBarcodes ?? progress?.completedBarcodes ?? {},
      completedItems: nosposData?.completedItems ?? progress?.completedItems ?? [],
      logs: [...(nosposData?.logs || []), {
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'NoSpos tab was closed. Repricing cancelled.'
      }].slice(-200)
    };
    await setRepricingStatus(cancelledStatus);
    if (appTabId) {
      chrome.tabs.sendMessage(appTabId, {
        type: 'REPRICING_PROGRESS_TO_PAGE',
        payload: cancelledStatus
      }).catch(() => {});
    }
  }

  const pending = await getPending();
  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.listingTabId === removedTabId) {
      delete pending[requestId];
      await setPending(pending);
      chrome.tabs.sendMessage(entry.appTabId, {
        type: 'EXTENSION_RESPONSE_TO_PAGE',
        requestId,
        response: {
          success: false,
          cancelled: true,
          error: 'Tab was closed. You can try again when ready.',
        }
      }).catch(() => {});
      break;
    }
  }

  await unregisterJewelleryScrapWorkerTab(removedTabId);
});
