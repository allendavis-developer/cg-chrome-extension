/**
 * Create a new NosPos agreement in a minimized background tab.
 *
 * Includes duplicate-draft recovery helpers (`fetchNosposBuyingAgreementIds`,
 * `deleteNosposBuyingAgreementByIdViaUi`) that are only consumed by this flow —
 * inlined here when `bg.deprecated/bridge-nospos-park-fetch-delete.js` was removed.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

/**
 * Fetch https://nospos.com/buying and extract every agreement ID shown in the table
 * (via data-key attributes on <tr> rows). Returns { ok, ids } where ids is an array
 * of numeric strings. Used before creating a new agreement to detect duplicate drafts.
 */
async function fetchNosposBuyingAgreementIds(fetchTimeoutMs = 15000) {
  const buyingUrl = 'https://nospos.com/buying';
  logPark('fetchNosposBuyingAgreementIds', 'enter', { buyingUrl }, 'Fetching buying hub to collect pre-existing agreement IDs');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    let response;
    try {
      response = await fetch(buyingUrl, {
        credentials: 'include',
        headers: NOSPOS_HTML_FETCH_HEADERS,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const finalUrl = response.url || '';
    if (nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl)) {
      logPark('fetchNosposBuyingAgreementIds', 'error', { finalUrl }, 'Not logged in to NosPos — cannot read buying list');
      return { ok: false, loginRequired: true, ids: [] };
    }
    const html = await response.text();
    const ids = [];
    const re = /<tr[^>]+\bdata-key="(\d+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      ids.push(m[1]);
    }
    logPark('fetchNosposBuyingAgreementIds', 'exit', { count: ids.length, ids }, `Found ${ids.length} pre-existing agreement IDs on buying hub`);
    return { ok: true, ids };
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    logPark('fetchNosposBuyingAgreementIds', 'error', { error: e?.message, isAbort }, 'Failed to fetch buying hub');
    return {
      ok: false,
      error: isAbort ? 'Timed out fetching nospos.com/buying' : (e?.message || 'Could not fetch buying hub'),
      ids: [],
    };
  }
}

/**
 * Duplicate-draft recovery:
 * 1) Navigate to /newagreement/{id}/items for the duplicate.
 * 2) On items page: Actions -> Delete Agreement -> confirm OK.
 * 3) Wait for NosPos to redirect back to nospos.com/buying.
 */
async function deleteNosposBuyingAgreementByIdViaUi(tabId, agreementId) {
  const id = String(agreementId || '').trim();
  if (!id || !/^\d+$/.test(id)) {
    logPark('deleteNosposBuyingAgreementByIdViaUi', 'error', { tabId, agreementId }, 'Invalid agreement id for delete');
    return { ok: false, error: 'Invalid agreement id for delete' };
  }
  logPark('deleteNosposBuyingAgreementByIdViaUi', 'enter', { tabId, agreementId: id }, `Starting delete of duplicate agreement #${id}`);

  const duplicateItemsUrl = `https://nospos.com/newagreement/${id}/items`;
  logPark('deleteNosposBuyingAgreementByIdViaUi', 'step', { duplicateItemsUrl }, 'Navigating to duplicate agreement items page');
  try {
    await chrome.tabs.update(tabId, { url: duplicateItemsUrl });
  } catch (e) {
    logPark('deleteNosposBuyingAgreementByIdViaUi', 'error', { error: e?.message }, 'Could not navigate to duplicate items page');
    return { ok: false, error: e?.message || 'Could not navigate to duplicate agreement items page' };
  }

  logPark('deleteNosposBuyingAgreementByIdViaUi', 'step', { tabId }, 'Waiting for duplicate items page to load');
  const waitItems = await waitForNosposNewAgreementItemsTabUrl(tabId, 35000);
  logPark('deleteNosposBuyingAgreementByIdViaUi', 'step', { waitItems }, waitItems?.ok ? 'Duplicate items page loaded' : 'Duplicate items page failed to load');
  if (!waitItems?.ok) {
    return { ok: false, error: waitItems?.error || 'Duplicate agreement items page did not load in time' };
  }

  logPark('deleteNosposBuyingAgreementByIdViaUi', 'step', { tabId, url: waitItems.url }, 'Injecting delete script: Actions → Delete Agreement → confirm OK');
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (agreementIdInPage, actionDelayMs) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const aid = String(agreementIdInPage || '').trim();
      const deleteSelector = `a[href*="/newagreement/${aid}/delete"]`;

      const cardCandidates = Array.from(document.querySelectorAll('.card'));
      let agreementCard = null;
      for (let i = 0; i < cardCandidates.length; i += 1) {
        const card = cardCandidates[i];
        const titleEl = card.querySelector('.card-title');
        const t = String(titleEl ? titleEl.textContent : '').toLowerCase();
        if (t.includes('agreement') && !t.includes('item')) {
          agreementCard = card;
          break;
        }
      }
      if (!agreementCard) agreementCard = document.querySelector('.card');
      if (!agreementCard) {
        return { ok: false, error: 'Agreement card not found on duplicate items page' };
      }

      const toggle =
        agreementCard.querySelector('a.dropdown-toggle[data-toggle="dropdown"]') ||
        agreementCard.querySelector('a.dropdown-toggle[data-bs-toggle="dropdown"]') ||
        agreementCard.querySelector('.dropdown-toggle');
      if (toggle && typeof toggle.click === 'function') {
        toggle.click();
        await sleep(280);
      }

      let deleteLink = agreementCard.querySelector(deleteSelector) || document.querySelector(deleteSelector);
      if (!deleteLink && toggle && typeof toggle.click === 'function') {
        toggle.click();
        await sleep(280);
        deleteLink = agreementCard.querySelector(deleteSelector) || document.querySelector(deleteSelector);
      }
      if (!deleteLink || typeof deleteLink.click !== 'function') {
        return { ok: false, error: `Delete Agreement link not found for #${aid}` };
      }

      await sleep(Math.max(0, Number(actionDelayMs) || 0));
      deleteLink.click();

      const confirmSelectors = [
        '.swal2-confirm',
        'button.swal2-confirm',
        '.swal2-actions button.swal2-confirm',
        '.swal-button--confirm',
        '[data-bb-handler="confirm"]',
        '.bootbox .btn-primary',
      ];
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        for (let i = 0; i < confirmSelectors.length; i += 1) {
          const btn = document.querySelector(confirmSelectors[i]);
          if (btn && typeof btn.click === 'function') {
            btn.click();
            await sleep(220);
            return { ok: true, deleted: true };
          }
        }
        await sleep(80);
      }
      return { ok: false, error: 'Delete confirmation OK button did not appear' };
    },
    args: [id, NOSPOS_ACTION_POST_DELAY_MS],
  }).catch((e) => [{ result: { ok: false, error: e?.message || 'Delete script threw an error' } }]);

  const result = injected?.[0]?.result;
  logPark('deleteNosposBuyingAgreementByIdViaUi', 'step', { result }, 'Delete inject script result');
  if (result?.ok === false) {
    return result;
  }

  logPark('deleteNosposBuyingAgreementByIdViaUi', 'step', { tabId }, 'Delete confirmed — waiting for nospos.com/buying redirect');
  const waitBuying = await waitForNosposTabBuyingAfterPark(tabId, 30000);
  logPark(
    'deleteNosposBuyingAgreementByIdViaUi',
    waitBuying?.ok ? 'exit' : 'step',
    { waitBuying },
    waitBuying?.ok
      ? `✓ Tab reached nospos.com/buying after deleting agreement #${id}`
      : 'Buying redirect not detected within timeout — proceeding anyway'
  );
  return { ok: true, deleted: true };
}

async function handleBridgeAction_openNosposNewAgreementCreateBackground({ requestId, appTabId, payload }) {
  // ── Clear log for each new park run ──────────────────────────────────────
  cgParkLog = [];
  cgParkLogStartTs = Date.now();
  // ─────────────────────────────────────────────────────────────────────────
  const id = parseInt(String(payload.nosposCustomerId ?? '').trim(), 10);
  if (!Number.isFinite(id) || id <= 0) {
    logPark('handleBridgeForward', 'error', { rawId: payload.nosposCustomerId }, 'Invalid NosPos customer id');
    return { ok: false, error: 'Invalid NosPos customer id' };
  }
  const rawType = String(
    payload.agreementType ?? payload.nosposAgreementType ?? 'DP'
  ).toUpperCase();
  const agreementType = rawType === 'PA' ? 'PA' : 'DP';
  const createUrl = `https://nospos.com/newagreement/agreement/create?type=${agreementType}&customer_id=${id}`;
  logPark('handleBridgeForward', 'enter', { action: 'openNosposNewAgreementCreateBackground', nosposCustomerId: id, agreementType, createUrl }, 'Step 2: opening new agreement tab');
  try {
    // ── STEP 2a: Snapshot the buying hub BEFORE creating the new agreement ──
    const buyingSnapshot = await fetchNosposBuyingAgreementIds();
    const preExistingIds = new Set(buyingSnapshot.ids || []);
    logPark('handleBridgeForward', 'step', {
      buyingSnapshotOk: buyingSnapshot.ok,
      preExistingCount: preExistingIds.size,
      preExistingIds: [...preExistingIds],
    }, 'Pre-existing agreement IDs collected from nospos.com/buying');
    // ───────────────────────────────────────────────────────────────────────

    const { tabId } = await openNosposParkAgreementTab(createUrl, appTabId);
    if (tabId == null) {
      logPark('handleBridgeForward', 'error', {}, 'openNosposParkAgreementTab returned null tabId');
      return { ok: false, error: 'Could not open NoSpos tab' };
    }
    registerNosposParkTab(tabId);
    const urlRes = await waitForNosposNewAgreementItemsTabUrl(
      tabId,
      NOSPOS_OPEN_AGREEMENT_ITEMS_URL_WAIT_MS
    );
    logPark('handleBridgeForward', 'result', { urlRes, tabId }, 'waitForNosposNewAgreementItemsTabUrl result');

    if (urlRes.ok && urlRes.url) {
      // ── STEP 2b: Extract the new agreement ID and check for duplicates ──
      const newAgreementIdMatch = /\/newagreement\/(\d+)\/items/i.exec(urlRes.url || '');
      const newAgreementId = newAgreementIdMatch?.[1] ?? null;
      logPark('handleBridgeForward', 'step', {
        newAgreementId,
        newAgreementItemsUrl: urlRes.url,
      }, 'New agreement ID extracted from items URL');

      if (newAgreementId && preExistingIds.has(newAgreementId)) {
        logPark('handleBridgeForward', 'step', {
          newAgreementId,
          preExistingIds: [...preExistingIds],
        }, `DUPLICATE DRAFT DETECTED — agreement #${newAgreementId} already exists on buying hub. Prompting user.`);

        const dupRequestId = `cg-dup-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        try {
          await chrome.storage.session.set({
            [NOSPOS_PARK_UI_STORAGE_KEY]: {
              active: true,
              tabId,
              appTabId: appTabId ?? null,
              message: NOSPOS_PARK_OVERLAY_DEFAULT_MSG,
              duplicatePromptRequestId: dupRequestId,
              duplicatePromptAgreementId: String(newAgreementId),
            },
          });
        } catch (_) {}
        await focusNosposTabForPark(tabId);
        await sendNosposParkDuplicatePromptToTab(tabId, dupRequestId, newAgreementId);
        await sleep(450);
        await sendNosposParkDuplicatePromptToTab(tabId, dupRequestId, newAgreementId);

        const choice = await waitForNosposDuplicateUserChoice(
          tabId,
          dupRequestId,
          15 * 60 * 1000
        );

        if (choice !== 'delete') {
          const tabAlreadyGone = choice === 'tab_closed';
          logPark(
            'handleBridgeForward',
            'step',
            { newAgreementId, choice },
            tabAlreadyGone
              ? 'NoSpos tab closed during duplicate prompt'
              : 'User declined duplicate delete or prompt timed out — closing NosPos tab'
          );
          if (!tabAlreadyGone) {
            try {
              await sendNosposParkOverlayToTab(tabId, false);
            } catch (_) {}
          }
          try {
            await chrome.storage.session.remove(NOSPOS_PARK_UI_STORAGE_KEY);
          } catch (_) {}
          unregisterNosposParkTab(tabId);
          if (!tabAlreadyGone) {
            try {
              await chrome.tabs.remove(tabId);
            } catch (_) {}
          }
          if (appTabId != null) {
            try {
              await focusAppTab(appTabId);
            } catch (_) {}
          }
          return {
            ok: false,
            duplicateDraftDetected: true,
            userDeclinedDuplicateDelete: choice === 'cancel',
            duplicatePromptTimedOut: choice === 'timeout',
            nosposTabClosedDuringDuplicatePrompt: tabAlreadyGone,
            newAgreementId,
            error: tabAlreadyGone ? NOSPOS_PARK_TAB_CLOSED_ERR : NOSPOS_DUPLICATE_DECLINED_ERROR,
          };
        }

        logPark(
          'handleBridgeForward',
          'step',
          { newAgreementId, tabId },
          'User confirmed delete — switching to wait overlay and deleting duplicate'
        );
        try {
          await chrome.storage.session.set({
            [NOSPOS_PARK_UI_STORAGE_KEY]: {
              active: true,
              tabId,
              appTabId: appTabId ?? null,
              message: 'Deleting duplicate draft — please wait…',
            },
          });
          await sendNosposParkOverlayToTab(tabId, true, 'Deleting duplicate draft — please wait…');
        } catch (_) {}

        // Step A: Navigate to the duplicate's items page, delete it, wait for nospos.com/buying.
        logPark('handleBridgeForward', 'step', { newAgreementId, tabId }, `Step A: deleting duplicate agreement #${newAgreementId}`);
        const autoDelete = await deleteNosposBuyingAgreementByIdViaUi(tabId, newAgreementId);
        logPark('handleBridgeForward', 'step', { autoDelete, newAgreementId }, autoDelete?.ok ? `✓ Duplicate #${newAgreementId} deleted — tab is on nospos.com/buying` : `Auto-delete failed: ${autoDelete?.error}`);
        if (!autoDelete?.ok) {
          try { await clearNosposParkAgreementUiLock({ focusApp: false }); } catch (_) {}
          return {
            ok: false,
            duplicateDraftDetected: true,
            newAgreementId,
            autoDeleteAttempted: true,
            error: autoDelete?.error || `Parking failed — could not auto-delete duplicate agreement #${newAgreementId}.`,
          };
        }

        // Step B: Close the old tab (now on nospos.com/buying) and open a fresh one for the new agreement.
        logPark('handleBridgeForward', 'step', { tabId, createUrl }, 'Step B: deletion done — closing old tab and opening a fresh tab for the new agreement');
        unregisterNosposParkTab(tabId);
        try { await chrome.tabs.remove(tabId); } catch (_) {}

        let newTabId = null;
        try {
          const newTabResult = await openNosposParkAgreementTab(createUrl, appTabId);
          newTabId = newTabResult?.tabId ?? null;
        } catch (e) {
          logPark('handleBridgeForward', 'error', { error: e?.message }, 'Failed to open new tab after duplicate delete');
          return {
            ok: false,
            duplicateDraftDetected: true,
            newAgreementId,
            autoDeleteAttempted: true,
            autoDeleteSuccess: true,
            error: e?.message || 'Could not open a new tab after deleting the duplicate agreement.',
          };
        }
        if (newTabId == null) {
          logPark('handleBridgeForward', 'error', {}, 'openNosposParkAgreementTab returned null tabId for fresh tab');
          return {
            ok: false,
            duplicateDraftDetected: true,
            newAgreementId,
            autoDeleteAttempted: true,
            autoDeleteSuccess: true,
            error: 'Could not open a new tab after deleting the duplicate agreement.',
          };
        }
        registerNosposParkTab(newTabId);
        logPark('handleBridgeForward', 'step', { newTabId, createUrl }, `New tab #${newTabId} opened — activating overlay and waiting for items page`);
        try { await activateNosposParkAgreementUi(newTabId, appTabId); } catch (_) {}

        // Step C: Wait for NosPos to redirect from createUrl to the new agreement items page.
        logPark('handleBridgeForward', 'step', { newTabId }, 'Step C: waiting for items page on new tab');
        const retryUrlRes = await waitForNosposNewAgreementItemsTabUrl(newTabId, NOSPOS_OPEN_AGREEMENT_ITEMS_URL_WAIT_MS);
        logPark('handleBridgeForward', 'result', { retryUrlRes, newTabId }, retryUrlRes?.ok ? `✓ Items page reached on new tab: ${retryUrlRes.url}` : `Items page not reached on new tab: ${retryUrlRes?.error}`);
        if (!retryUrlRes?.ok || !retryUrlRes?.url) {
          return {
            ok: false,
            duplicateDraftDetected: true,
            newAgreementId,
            autoDeleteAttempted: true,
            autoDeleteSuccess: true,
            error: retryUrlRes?.error || 'Deleted duplicate, but new tab did not reach the agreement items page in time.',
          };
        }

        logPark('handleBridgeForward', 'step', {
          retriedFromDuplicate: true,
          deletedAgreementId: newAgreementId,
          newTabId,
          newAgreementItemsUrl: retryUrlRes.url,
        }, `✓ Duplicate deleted, old tab closed, fresh tab on items page — resuming park flow`);
        return {
          ok: true,
          tabId: newTabId,
          agreementItemsUrl: retryUrlRes.url,
          autoDeletedDuplicateAgreementId: newAgreementId,
        };
      }
      logPark('handleBridgeForward', 'step', {
        newAgreementId,
        existsInPreExistingBuyingIds: newAgreementId ? preExistingIds.has(newAgreementId) : null,
        preExistingCount: preExistingIds.size,
      }, 'NEW AGREEMENT CONFIRMED — extracted agreement ID was not present in pre-existing buying IDs');
      // ─────────────────────────────────────────────────────────────────────

      logPark('handleBridgeForward', 'exit', { tabId, agreementItemsUrl: urlRes.url, newAgreementId }, 'Step 2 complete — items URL obtained');
      try {
        await activateNosposParkAgreementUi(tabId, appTabId);
      } catch (_) {}
      return { ok: true, tabId, agreementItemsUrl: urlRes.url };
    }
    logPark('handleBridgeForward', 'exit', { tabId, warning: urlRes.error }, 'Step 2 complete — items URL not confirmed (warning)');
    try {
      await activateNosposParkAgreementUi(tabId, appTabId);
    } catch (_) {}
    return {
      ok: true,
      tabId,
      agreementItemsUrl: null,
      agreementItemsUrlWarning: urlRes.error || null,
    };
  } catch (e) {
    logPark('handleBridgeForward', 'error', { error: e?.message }, 'Exception opening NoSpos tab');
    return { ok: false, error: e?.message || 'Could not open NoSpos' };
  }
}
