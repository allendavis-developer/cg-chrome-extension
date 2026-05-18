/**
 * Park-agreement orchestration: click Park/AddItem, ensure items tab, wait ready for park,
 * apply category phase, apply rest phase, fill first/subsequent line, sequential item loop.
 */

async function clickNosposSidebarParkAgreementImpl(payload) {
  logPark('clickNosposSidebarParkAgreementImpl', 'enter', { tabId: payload.tabId }, 'Starting sidebar park agreement sequence');
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    logPark('clickNosposSidebarParkAgreementImpl', 'error', { rawTabId: payload.tabId }, 'Invalid tabId');
    return { ok: false, error: 'Invalid tab' };
  }
  const tabCheck = await waitForNosposAgreementTabReadyForPark(tabId, 120000);
  logPark('clickNosposSidebarParkAgreementImpl', 'result', { tabCheck }, 'Tab readiness check result');
  if (!tabCheck.ok) {
    return tabCheck;
  }
  try {
    if (tabCheck.onItemsStep) {
      logPark('clickNosposSidebarParkAgreementImpl', 'step', { tabId }, 'Tab is on items step — clicking Next');
      const rNext = await sendParkMessageToTabWithAbort(
        tabId,
        { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'click_items_form_next' },
        18,
        450
      );
      logPark('clickNosposSidebarParkAgreementImpl', 'result', { rNext }, 'click_items_form_next response');
      if (!rNext || rNext.ok === false) {
        logPark('clickNosposSidebarParkAgreementImpl', 'error', { rNext }, 'Failed to click Next on items page');
        return {
          ok: false,
          error: rNext?.error || 'Could not press Next on the NoSpos items page',
        };
      }
      const waitNav = await waitAfterAgreementItemsNextClick(tabId, NOSPOS_RELOAD_WAIT_MS);
      logPark('clickNosposSidebarParkAgreementImpl', 'result', { waitNav }, 'Wait-after-Next navigation result');
      if (!waitNav.ok) {
        return waitNav;
      }
    } else {
      logPark('clickNosposSidebarParkAgreementImpl', 'step', { tabId }, 'Tab is past items step — skipping Next, waiting 500ms');
      await sleep(500);
    }
    logPark('clickNosposSidebarParkAgreementImpl', 'step', { tabId }, 'Sending sidebar_park_agreement phase to content script (racing with buying hub detection)');
    const buyingReachedPromise = waitForNosposTabBuyingAfterPark(
      tabId,
      NOSPOS_BUYING_AFTER_PARK_WAIT_MS
    );
    const parkSidebarPromise = sendParkMessageToTabWithAbort(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'sidebar_park_agreement' },
      22,
      450
    )
      .then((result) => {
        logPark('clickNosposSidebarParkAgreementImpl', 'result', { result }, 'sidebar_park_agreement content-script response');
        return { ok: true, result };
      })
      .catch((e) => {
        logPark('clickNosposSidebarParkAgreementImpl', 'error', { error: e?.message }, 'sidebar_park_agreement sendMessage threw');
        return { ok: false, error: e?.message || String(e) };
      });

    const first = await Promise.race([
      buyingReachedPromise.then((result) => ({ kind: 'buying', ...result })),
      parkSidebarPromise.then((result) => ({ kind: 'park', ...result })),
    ]);
    logPark('clickNosposSidebarParkAgreementImpl', 'step', { firstKind: first.kind, firstOk: first.ok }, 'Race winner resolved');

    if (first.kind === 'buying' && first.ok) {
      logPark('clickNosposSidebarParkAgreementImpl', 'exit', { parked: true, via: 'buying-hub-race' }, 'Park confirmed — buying hub reached first in race');
      return { ok: true, parked: true };
    }

    const r = first.kind === 'park' ? first : await parkSidebarPromise;
    const buyingReached = first.kind === 'buying' ? first : await buyingReachedPromise;
    logPark('clickNosposSidebarParkAgreementImpl', 'step', { parkResult: r, buyingReached }, 'Both race legs settled');

    if (buyingReached.ok) {
      logPark('clickNosposSidebarParkAgreementImpl', 'exit', { parked: true, via: 'buying-hub-poll' }, 'Park confirmed — buying hub reached after sidebar');
      return { ok: true, parked: true };
    }
    if (!r.ok || r.result?.ok === false) {
      const err = r.error || r.result?.error || buyingReached.error || 'NoSpos did not complete sidebar Park Agreement';
      logPark('clickNosposSidebarParkAgreementImpl', 'error', { parkResult: r, buyingReached, err }, 'Park sidebar failed');
      return { ok: false, error: err };
    }
    logPark('clickNosposSidebarParkAgreementImpl', 'error', { buyingReached }, 'Park sidebar sent but buying hub not reached');
    return {
      ok: false,
      error: buyingReached.error || 'NoSpos did not return to Buying after Park.',
    };
  } catch (e) {
    logPark('clickNosposSidebarParkAgreementImpl', 'error', { error: e?.message }, 'Unexpected exception in sidebar park');
    return { ok: false, error: e?.message || String(e) || 'Sidebar park failed' };
  }
}

async function clickNosposAgreementAddItem(tabId) {
  if (NOSPOS_ADD_ITEM_CLICK_DELAY_MS > 0) {
    logPark(
      'clickNosposAgreementAddItem',
      'step',
      { tabId, delayMs: NOSPOS_ADD_ITEM_CLICK_DELAY_MS },
      'Rate-limit guard: delaying before Add click'
    );
    await sleep(NOSPOS_ADD_ITEM_CLICK_DELAY_MS);
  }
  return sendParkMessageToTabWithAbort(
    tabId,
    { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'click_add' },
    10,
    400
  );
}

/** After clicking Add: wait for reload, then confirm line count increased (fallback if reload is soft). */
async function waitForNewAgreementLineAfterAdd(tabId, countBefore) {
  await waitForAgreementItemsPageReload(tabId, 'after Add', NOSPOS_RELOAD_WAIT_MS);
  await sleep(600);
  const want = countBefore + 1;
  const start = Date.now();
  const lineWaitMs = NOSPOS_RELOAD_WAIT_MS;
  while (Date.now() - start < lineWaitMs) {
    // Only count lines once the page is fully loaded — counting during a mid-render
    // state can return a stale count and cause the rest phase to target the wrong row.
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) {
      return { ok: false, error: 'The NoSpos tab was closed' };
    }
    if (!isNosposAgreementItemsUrl(t.url || '') || t.status !== 'complete') {
      await sleep(350);
      continue;
    }
    const n = await countNosposAgreementItemLines(tabId);
    if (n >= want) return { ok: true, count: n };
    await sleep(500);
  }
  return {
    ok: false,
    error:
      'NoSpos did not show a new item row after Add within the wait window (reload or new row timed out). Use Retry on that line or check the NoSpos tab.',
  };
}

async function ensureNosposAgreementItemsTab(tabId, deadlineMs = 90000) {
  logPark('ensureNosposAgreementItemsTab', 'enter', { tabId, deadlineMs }, 'Ensuring items page is loaded');
  const deadline = Date.now() + deadlineMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      logPark('ensureNosposAgreementItemsTab', 'error', { tabId }, 'Tab closed while waiting for items page');
      return { ok: false, error: 'The NoSpos tab was closed' };
    }
    const isItems = isNosposAgreementItemsUrl(tab.url || '');
    if (pollCount % 10 === 0 && tab.status === 'complete') {
      await maybeRecoverNospos429Page(tabId, 'ensureNosposAgreementItemsTab');
    }
    if (pollCount % 10 === 0) {
      logPark('ensureNosposAgreementItemsTab', 'step', { pollCount, tabStatus: tab.status, url: tab.url, isItems }, 'Polling for items page ready');
    }
    if (isItems && tab.status === 'complete') {
      logPark('ensureNosposAgreementItemsTab', 'exit', { url: tab.url, pollCount }, 'Items page is loaded and ready');
      return { ok: true };
    }
    pollCount++;
    await sleep(350);
  }
  logPark('ensureNosposAgreementItemsTab', 'error', { tabId }, 'Timed out waiting for items page');
  return {
    ok: false,
    error:
      'Items page did not load in time. Finish opening the agreement in the NoSpos window, then try again.',
  };
}

/**
 * Before Park Agreement: tab must be on a NosPos new-agreement step with the sidebar.
 * With a single line, NosPos sometimes advances past /items before we run — waiting only for
 * /items would spin until timeout while the user finishes Park in the UI (CG Suite stuck on the line).
 */
async function waitForNosposAgreementTabReadyForPark(tabId, deadlineMs = 120000) {
  logPark('waitForNosposAgreementTabReadyForPark', 'enter', { tabId, deadlineMs }, 'Waiting for NoSpos agreement tab to be ready for Park');
  const deadline = Date.now() + deadlineMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      logPark('waitForNosposAgreementTabReadyForPark', 'error', { tabId }, 'Tab closed while waiting for park readiness');
      return { ok: false, error: 'The NoSpos tab was closed' };
    }
    const url = tab.url || '';
    if (pollCount % 10 === 0 && tab.status === 'complete') {
      await maybeRecoverNospos429Page(tabId, 'waitForNosposAgreementTabReadyForPark');
    }
    const isWorkflow = isNosposNewAgreementWorkflowUrl(url);
    const isItems = isNosposAgreementItemsUrl(url);
    if (pollCount % 10 === 0) {
      logPark('waitForNosposAgreementTabReadyForPark', 'step', { pollCount, tabStatus: tab.status, url, isWorkflow, isItems }, 'Polling tab readiness');
    }
    if (tab.status !== 'complete') { pollCount++; await sleep(350); continue; }
    if (!isWorkflow) { pollCount++; await sleep(350); continue; }
    if (isItems) {
      logPark('waitForNosposAgreementTabReadyForPark', 'exit', { url, onItemsStep: true, pollCount }, 'Tab is on items step — ready for park');
      return { ok: true, onItemsStep: true };
    }
    logPark('waitForNosposAgreementTabReadyForPark', 'exit', { url, onItemsStep: false, pollCount }, 'Tab is past items step — ready for park');
    return { ok: true, onItemsStep: false };
  }
  logPark('waitForNosposAgreementTabReadyForPark', 'error', { tabId }, 'Timed out waiting for agreement tab park readiness');
  return {
    ok: false,
    error:
      'Agreement page did not load in time. Finish opening the agreement in the NoSpos window, then try again.',
  };
}

/**
 * Set category and wait for NosPos reload / form (up to {@link NOSPOS_RELOAD_WAIT_MS} for reload detection).
 */
async function applyNosposAgreementCategoryPhaseImpl(tabId, payload) {
  const lineIndex = Math.max(0, parseInt(String(payload.lineIndex ?? '0'), 10) || 0);
  const categoryId = String(payload.categoryId ?? '').trim();
  logPark('applyNosposAgreementCategoryPhaseImpl', 'enter', { tabId, lineIndex, categoryId, name: payload.name, marker: payload.cgParkLineMarker }, 'Setting category on NoSpos agreement line');
  let categoryLabel = null;
  const stockLabelsForWait = Array.isArray(payload.stockFields)
    ? payload.stockFields.map((r) => r && r.label).filter(Boolean)
    : [];
  if (!categoryId) {
    logPark('applyNosposAgreementCategoryPhaseImpl', 'decision', { lineIndex }, 'No categoryId — skipping category phase');
    return { ok: true, categoryLabel: null, waitForm: { ok: true }, lineIndex };
  }
  try {
    if (NOSPOS_SET_CATEGORY_DELAY_MS > 0) {
      logPark(
        'applyNosposAgreementCategoryPhaseImpl',
        'step',
        { tabId, lineIndex, delayMs: NOSPOS_SET_CATEGORY_DELAY_MS },
        'Rate-limit guard: delaying before category set'
      );
      await sleep(NOSPOS_SET_CATEGORY_DELAY_MS);
    }
    logPark('applyNosposAgreementCategoryPhaseImpl', 'call', { tabId, lineIndex, categoryId }, 'Sending category phase to content script');
    const r1 = await sendParkMessageToTabWithAbort(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'category', categoryId, lineIndex },
      8,
      500
    );
    logPark('applyNosposAgreementCategoryPhaseImpl', 'result', { r1 }, 'Category phase response from content script');
    if (!r1?.ok) {
      logPark('applyNosposAgreementCategoryPhaseImpl', 'error', { r1, lineIndex, categoryId }, 'Content script could not set category');
      return { ok: false, error: r1?.error || 'Could not set category', lineIndex, ...r1 };
    }
    categoryLabel = r1.label || null;
    logPark('applyNosposAgreementCategoryPhaseImpl', 'step', { lineIndex, categoryLabel, stockLabelsForWait }, 'Category set — waiting for page/form reload');
    console.log('[CG Suite] NosPos agreement fill: category set, waiting for page/form…', {
      lineIndex,
      categoryLabel,
      expectStockLabels: stockLabelsForWait,
    });
    const waitForm = await waitForAgreementItemsReadyAfterCategory(
      tabId,
      stockLabelsForWait,
      lineIndex
    );
    logPark('applyNosposAgreementCategoryPhaseImpl', 'result', { waitForm, lineIndex, categoryLabel }, 'Post-category form-ready wait result');
    if (!waitForm.ok) {
      console.warn('[CG Suite] NosPos agreement fill: post-category wait failed', waitForm);
    }
    return { ok: true, categoryLabel, waitForm, lineIndex };
  } catch (e) {
    logPark('applyNosposAgreementCategoryPhaseImpl', 'error', { error: e?.message, lineIndex, categoryId }, 'Exception in category phase');
    return { ok: false, error: e?.message || 'Could not set category on NoSpos', lineIndex };
  }
}

/**
 * Fill name, description, qty, prices, stock fields on an agreement line (retries when DOM not ready).
 */
async function applyNosposAgreementRestPhaseImpl(tabId, payload, categoryLabel) {
  const lineIndex = Math.max(0, parseInt(String(payload.lineIndex ?? '0'), 10) || 0);
  logPark('applyNosposAgreementRestPhaseImpl', 'enter', {
    tabId, lineIndex, categoryLabel,
    name: payload.name, quantity: payload.quantity,
    retailPrice: payload.retailPrice, boughtFor: payload.boughtFor,
    stockFieldCount: Array.isArray(payload.stockFields) ? payload.stockFields.length : 0,
    itemDescription: payload.itemDescription,
  }, 'Filling rest of agreement line fields');
  const restPayload = {
    type: 'NOSPOS_AGREEMENT_FILL_PHASE',
    phase: 'rest',
    lineIndex,
    name: payload.name ?? '',
    itemDescription: payload.itemDescription ?? '',
    quantity: payload.quantity ?? '',
    retailPrice: payload.retailPrice ?? '',
    boughtFor: payload.boughtFor ?? '',
    stockFields: Array.isArray(payload.stockFields) ? payload.stockFields : [],
    categoryOurDisplay: String(payload.categoryOurDisplay ?? '').trim(),
  };

  let last = null;
  try {
    for (let i = 0; i < 28; i += 1) {
      last = await sendParkMessageToTabWithAbort(tabId, restPayload, 6, 350);
      if (last?.ok) {
        logPark('applyNosposAgreementRestPhaseImpl', 'exit', { lineIndex, attempt: i, applied: last?.applied, warnings: last?.warnings, missingRequired: last?.missingRequired }, 'Rest phase succeeded');
        return { ok: true, categoryLabel, lineIndex, ...last };
      }
      if (!last?.notReady) {
        logPark('applyNosposAgreementRestPhaseImpl', 'error', { lineIndex, attempt: i, last }, 'Rest phase failed (not a notReady error)');
        return { ok: false, categoryLabel, lineIndex, error: last?.error || 'Could not fill agreement line', ...last };
      }
      logPark('applyNosposAgreementRestPhaseImpl', 'step', { lineIndex, attempt: i, notReady: true }, `Form not ready yet — retry ${i + 1}/28`);
      await sleep(500);
    }
    logPark('applyNosposAgreementRestPhaseImpl', 'error', { lineIndex, attempts: 28 }, 'Rest phase exhausted all retries — form never became ready');
    return { ok: false, categoryLabel, lineIndex, error: last?.error || 'Agreement line form did not become ready in time', ...last };
  } catch (e) {
    logPark('applyNosposAgreementRestPhaseImpl', 'error', { error: e?.message, lineIndex }, 'Exception in rest phase');
    return { ok: false, categoryLabel, lineIndex, error: e?.message || 'Could not fill agreement line on NoSpos' };
  }
}

/**
 * Fill one agreement line by index (0-based). Caller must ensure tab is already on the items page.
 */
async function fillNosposAgreementOneLineImpl(tabId, payload) {
  const cat = await applyNosposAgreementCategoryPhaseImpl(tabId, payload);
  if (!cat.ok) {
    return {
      ok: false,
      error: cat.error,
      lineIndex: cat.lineIndex ?? payload.lineIndex,
    };
  }
  let restPayload = { ...payload };
  const marker = String(payload.cgParkLineMarker || '').trim();
  if (marker) {
    const found = await findNosposLineIndexForMarkerWithFallback(tabId, marker);
    if (found != null && found >= 0) {
      restPayload = { ...restPayload, lineIndex: found };
      console.log('[CG Suite] NosPos park: re-resolved line index after category', {
        marker,
        lineIndex: found,
      });
    }
  }
  return applyNosposAgreementRestPhaseImpl(tabId, restPayload, cat.categoryLabel);
}

async function fillNosposParkAgreementCategoryImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
  const lineIndex = Math.max(
    0,
    parseInt(String(payload.lineIndex ?? item.lineIndex ?? '0'), 10) || 0
  );
  const merged = { ...item, lineIndex };
  const result = await applyNosposAgreementCategoryPhaseImpl(tabId, merged);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      lineIndex: result.lineIndex ?? lineIndex,
    };
  }
  let restLineIndex = lineIndex;
  const marker = String(item.cgParkLineMarker || '').trim();
  if (marker) {
    const found = await findNosposLineIndexForMarkerWithFallback(tabId, marker);
    if (found != null && found >= 0) {
      restLineIndex = found;
      console.log('[CG Suite] NosPos park: rest line index after category (split step)', {
        marker,
        restLineIndex,
      });
    } else {
      // Brand-new row: description/marker not written yet, so the marker scan
      // comes up empty. After the category-triggered reload the row order may
      // have shifted, so use the current last-row count rather than the
      // pre-reload lineIndex.
      const count = await countNosposAgreementItemLines(tabId);
      if (count > 0) {
        const lastIdx = count - 1;
        if (lastIdx !== lineIndex) {
          console.log('[CG Suite] NosPos park: marker not found after category reload — using last row index', {
            lineIndex,
            lastIdx,
          });
        }
        restLineIndex = lastIdx;
      }
    }
  }
  return {
    ok: true,
    categoryLabel: result.categoryLabel,
    waitForm: result.waitForm,
    lineIndex: result.lineIndex ?? lineIndex,
    restLineIndex,
  };
}

async function fillNosposParkAgreementRestImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
  const lineIndex = Math.max(
    0,
    parseInt(String(payload.lineIndex ?? item.lineIndex ?? '0'), 10) || 0
  );
  const categoryLabel =
    payload.categoryLabel !== undefined && payload.categoryLabel !== ''
      ? payload.categoryLabel
      : null;
  return applyNosposAgreementRestPhaseImpl(
    tabId,
    { ...item, lineIndex },
    categoryLabel
  );
}

/**
 * Wait for agreement items URL, optionally set category, then fill name/qty/prices/stock (with retries after category DOM refresh).
 */
async function fillNosposAgreementFirstItemImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  const firstDead = await failIfNosposParkTabClosedOrMissing(tabId);
  if (firstDead) return firstDead;
  const tabCheck = await ensureNosposAgreementItemsTab(tabId, 90000);
  if (!tabCheck.ok) return tabCheck;
  return fillNosposAgreementOneLineImpl(tabId, {
    ...payload,
    lineIndex: payload.lineIndex ?? 0,
  });
}

/**
 * stepIndex = index among *included* lines only. negotiationLineIndex = index in parkNegotiationLines.
 * After a full park, NosPos row i ↔ line i even if some lines are later "excluded" in CG (rows remain).
 * When row count matches negotiation count, prefer negotiationLineIndex; else stepIndex (compressed layout).
 */
function pickParkFallbackLineIndex(stepIndex, negotiationLineIndex, countBefore, parkNegotiationLineCount) {
  const n = Math.max(0, parseInt(String(countBefore ?? '0'), 10) || 0);
  const step = Math.max(0, parseInt(String(stepIndex ?? '0'), 10) || 0);
  const plc = Math.max(0, parseInt(String(parkNegotiationLineCount ?? '0'), 10) || 0);
  let nl = null;
  if (negotiationLineIndex != null && negotiationLineIndex !== '') {
    const parsed = parseInt(String(negotiationLineIndex), 10);
    if (Number.isFinite(parsed) && parsed >= 0) nl = parsed;
  }
  if (plc > 0 && nl != null && n >= plc && n > nl) {
    return nl;
  }
  return step;
}

/**
 * Find row by description marker, or use row 0, or click Add and wait for new row.
 */
async function resolveNosposParkAgreementLineImpl(tabId, stepIndex, item, opts = {}) {
  const noAdd = opts.noAdd === true;
  const alwaysEnsureTab = opts.ensureTab === true;
  const marker = String(item.cgParkLineMarker || '').trim();
  const parkNegotiationLineCount = opts.parkNegotiationLineCount;
  const negotiationLineIndex = opts.negotiationLineIndex;
  logPark('resolveNosposParkAgreementLineImpl', 'enter', {
    tabId, stepIndex, noAdd, alwaysEnsureTab, marker,
    parkNegotiationLineCount, negotiationLineIndex,
    itemName: item.name, itemCategoryId: item.categoryId,
  }, `Resolving NoSpos line for step ${stepIndex}`);

  if (stepIndex === 0 || alwaysEnsureTab) {
    logPark('resolveNosposParkAgreementLineImpl', 'step', { stepIndex, alwaysEnsureTab }, 'Ensuring items tab is loaded');
    const tabCheck = await ensureNosposAgreementItemsTab(tabId, 120000);
    logPark('resolveNosposParkAgreementLineImpl', 'result', { tabCheck }, 'ensureNosposAgreementItemsTab result');
    if (!tabCheck.ok) return { ...tabCheck, targetLineIndex: undefined };
  }

  let targetLineIndex = null;
  let reusedExistingRow = false;
  let didClickAdd = false;

  if (marker) {
    const found = await findNosposLineIndexForMarkerWithFallback(tabId, marker);
    if (found != null && found >= 0) {
      targetLineIndex = found;
      reusedExistingRow = true;
      const expCat = String(item.categoryId || '').trim();
      const snap = await readNosposAgreementLineSnapshot(tabId, targetLineIndex);
      if (snap?.ok) {
        logPark('resolveNosposParkAgreementLineImpl', 'decision', {
          marker, targetLineIndex, stepIndex,
          nosposName: snap.name, nosposDescription: snap.description, nosposCategoryId: snap.categoryId,
          expectedCategoryId: expCat, categoryMismatch: expCat && snap.categoryId && expCat !== snap.categoryId,
          markerMissing: !String(snap.description || '').includes(marker),
        }, 'Reusing existing NoSpos row matched by marker (skipping Add)');
        console.log('[CG Suite] NosPos park: reusing row with CG marker (skip Add)', {
          marker, targetLineIndex, stepIndex,
          nosposName: snap.name, nosposItemDescription: snap.description, nosposCategoryId: snap.categoryId,
        });
        if (expCat && snap.categoryId && expCat !== snap.categoryId) {
          console.warn('[CG Suite] NosPos park: category differs on reused row (fill will overwrite)', { expectedCategoryId: expCat, nosposCategoryId: snap.categoryId });
        }
        if (!String(snap.description || '').includes(marker)) {
          console.warn('[CG Suite] NosPos park: marker missing in Nospos item description before fill', { marker, description: snap.description });
        }
      }
    } else {
      logPark('resolveNosposParkAgreementLineImpl', 'decision', { marker }, 'Marker not found in any NoSpos row');
    }
  }

  if (targetLineIndex == null) {
    const countBefore = await countNosposAgreementItemLines(tabId);
    const fallbackIdx = pickParkFallbackLineIndex(
      stepIndex,
      negotiationLineIndex,
      countBefore,
      parkNegotiationLineCount
    );
    logPark('resolveNosposParkAgreementLineImpl', 'step', { countBefore, fallbackIdx, stepIndex, noAdd, negotiationLineIndex, parkNegotiationLineCount }, 'Marker not found — deciding between fallback index or Add');

    if (stepIndex === 0 || noAdd) {
      targetLineIndex = fallbackIdx;
      logPark('resolveNosposParkAgreementLineImpl', 'decision', { targetLineIndex, reason: stepIndex === 0 ? 'first-step' : 'noAdd' }, 'Using fallback line index (no Add click)');
      if (noAdd && stepIndex > 0) {
        console.log('[CG Suite] NosPos park: noAdd — marker not found, using fallback line index', {
          stepIndex, negotiationLineIndex, fallbackIdx, lineCount: countBefore, parkNegotiationLineCount, reusedExistingRow,
        });
      }
    } else if (countBefore > fallbackIdx) {
      targetLineIndex = fallbackIdx;
      logPark('resolveNosposParkAgreementLineImpl', 'decision', { targetLineIndex, countBefore, fallbackIdx }, 'Existing row available at fallback index — skipping Add');
      console.log('[CG Suite] NosPos park: marker not found; using existing row at fallback index (skip Add)', {
        stepIndex, negotiationLineIndex, fallbackIdx, lineCount: countBefore, parkNegotiationLineCount, marker,
      });
    } else {
      logPark('resolveNosposParkAgreementLineImpl', 'step', { countBefore, fallbackIdx }, 'No existing row at fallback index — clicking Add');
      const clickR = await clickNosposAgreementAddItem(tabId);
      logPark('resolveNosposParkAgreementLineImpl', 'result', { clickR }, 'clickNosposAgreementAddItem result');
      if (!clickR?.ok) {
        logPark('resolveNosposParkAgreementLineImpl', 'error', { clickR }, 'Failed to click Add');
        return { ok: false, error: clickR?.error || 'Could not click Add on NoSpos' };
      }
      didClickAdd = true;
      const waitNew = await waitForNewAgreementLineAfterAdd(tabId, countBefore);
      logPark('resolveNosposParkAgreementLineImpl', 'result', { waitNew }, 'waitForNewAgreementLineAfterAdd result');
      if (!waitNew.ok) {
        return { ok: false, error: waitNew.error };
      }
      const countAfter = await countNosposAgreementItemLines(tabId);
      targetLineIndex = Math.max(0, countAfter - 1);
      logPark('resolveNosposParkAgreementLineImpl', 'step', { countAfter, targetLineIndex }, 'Add succeeded — targeting last row');
    }
  }

  logPark('resolveNosposParkAgreementLineImpl', 'exit', { targetLineIndex, reusedExistingRow, didClickAdd }, 'Line resolved');
  return { ok: true, targetLineIndex, reusedExistingRow, didClickAdd };
}

/**
 * One step of the park flow: optional Add+wait (stepIndex &gt; 0), then fill that line.
 * Lets the app refresh UI between lines.
 */
async function fillNosposAgreementItemStepImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  const stepIndex = Math.max(0, parseInt(String(payload.stepIndex ?? '0'), 10) || 0);
  logPark('fillNosposAgreementItemStepImpl', 'enter', { tabId, stepIndex, negotiationLineIndex: payload.negotiationLineIndex, itemName: payload.item?.name }, `Step ${stepIndex} — resolving then filling`);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    logPark('fillNosposAgreementItemStepImpl', 'error', { tabId }, 'Invalid tabId');
    return { ok: false, error: 'Invalid tab' };
  }
  const stepDead = await failIfNosposParkTabClosedOrMissing(tabId);
  if (stepDead) return stepDead;

  const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
  const resolved = await resolveNosposParkAgreementLineImpl(tabId, stepIndex, item, {
    negotiationLineIndex: payload.negotiationLineIndex,
    parkNegotiationLineCount: payload.parkNegotiationLineCount,
  });
  logPark('fillNosposAgreementItemStepImpl', 'result', { resolved }, 'Line resolution result');
  if (!resolved.ok) return resolved;

  const fillRes = await fillNosposAgreementOneLineImpl(tabId, {
    ...item,
    lineIndex: resolved.targetLineIndex,
  });
  logPark('fillNosposAgreementItemStepImpl', 'result', { fillOk: fillRes?.ok, lineIndex: resolved.targetLineIndex, warnings: fillRes?.warnings }, 'fillNosposAgreementOneLineImpl result');
  if (!fillRes?.ok) return fillRes;
  const out = {
    ...fillRes,
    reusedExistingRow: resolved.reusedExistingRow,
    targetLineIndex: resolved.targetLineIndex,
    didClickAdd: resolved.didClickAdd,
  };
  logPark('fillNosposAgreementItemStepImpl', 'exit', { targetLineIndex: out.targetLineIndex, reusedExistingRow: out.reusedExistingRow, didClickAdd: out.didClickAdd }, `Step ${stepIndex} complete`);
  return out;
}

async function fillNosposAgreementItemsSequentialImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  const seqDead = await failIfNosposParkTabClosedOrMissing(tabId);
  if (seqDead) return seqDead;
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    return { ok: false, error: 'No items to add' };
  }

  const tabCheck = await ensureNosposAgreementItemsTab(tabId, 120000);
  if (!tabCheck.ok) return tabCheck;

  const perItem = [];
  for (let i = 0; i < items.length; i += 1) {
    const marker = String(items[i].cgParkLineMarker || '').trim();
    let targetLineIndex = null;
    if (marker) {
      const found = await findNosposLineIndexForMarkerWithFallback(tabId, marker);
      if (found != null && found >= 0) {
        targetLineIndex = found;
        const snap = await readNosposAgreementLineSnapshot(tabId, targetLineIndex);
        if (snap?.ok) {
          console.log('[CG Suite] NosPos sequential: reusing row with CG marker (skip Add)', {
            itemIndex: i,
            marker,
            targetLineIndex,
            nosposName: snap.name,
            nosposItemDescription: snap.description,
            nosposCategoryId: snap.categoryId,
          });
        }
      }
    }
    if (targetLineIndex == null) {
      if (i > 0) {
        const countBefore = await countNosposAgreementItemLines(tabId);
        const clickR = await clickNosposAgreementAddItem(tabId);
        if (!clickR?.ok) {
          return {
            ok: false,
            error: clickR?.error || 'Could not click Add on NoSpos',
            perItem,
            filledUpToIndex: i - 1,
          };
        }
        const waitNew = await waitForNewAgreementLineAfterAdd(tabId, countBefore);
        if (!waitNew.ok) {
          return {
            ok: false,
            error: waitNew.error,
            perItem,
            filledUpToIndex: i - 1,
          };
        }
        const countAfter = await countNosposAgreementItemLines(tabId);
        targetLineIndex = Math.max(0, countAfter - 1);
      } else {
        targetLineIndex = 0;
      }
    }
    const one = await fillNosposAgreementOneLineImpl(tabId, {
      ...items[i],
      lineIndex: targetLineIndex,
    });
    if (!one?.ok) {
      return {
        ok: false,
        error: one?.error || `Could not fill agreement line ${i + 1}`,
        perItem,
        filledUpToIndex: i - 1,
        ...one,
      };
    }
    perItem.push(one);
  }

  const last = perItem[perItem.length - 1];
  return {
    ok: true,
    perItem,
    categoryLabel: last?.categoryLabel,
    fieldRows: last?.fieldRows,
    applied: last?.applied,
    missingRequired: last?.missingRequired,
    warnings: last?.warnings,
  };
}
