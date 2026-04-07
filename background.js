/**
 * CG Suite Research – background service worker (Manifest V3).
 *
 * IMPORTANT: MV3 service workers are killed by Chrome after ~30 s of inactivity.
 * All pending-request state is persisted in chrome.storage.session so it survives
 * those restarts.
 *
 * Storage schema (key "cgPending"):
 *   { [requestId]: { appTabId, listingTabId, competitor, marketComparisonContext } }
 *
 * FLOW FOR "ADD FROM CEX":
 * 1. App sends BRIDGE_FORWARD with action 'startWaitingForData', competitor 'CeX'.
 * 2. We create a new tab (uk.webuy.com/ or search), store pending[requestId] = { appTabId, listingTabId: newTab.id, competitor: 'CeX' }.
 * 3. User navigates to a product-detail page (same tab or different tab). Content script on that page sends LISTING_PAGE_READY.
 * 4. We match the tab to the pending request (by listingTabId, or for CeX by re-associating if user opened product in another tab).
 * 5. We send WAITING_FOR_DATA to that tab so the content script shows "Have you got the data yet?". We retry a few times in case the content script isn't ready yet.
 */

importScripts('jewellery-scrap/constants.js', 'jewellery-scrap/worker-session.js');

// ── eBay filter enforcement ────────────────────────────────────────────────────

/**
 * Ensure the three required eBay filters are present in the URL:
 *   LH_Complete=1  (Completed items)
 *   LH_Sold=1      (Sold items)
 *   LH_PrefLoc=1   (UK Only)
 * Returns the (possibly modified) URL unchanged for non-eBay URLs.
 */
function ensureEbayFilters(url) {
  if (!url || !url.includes('ebay.co.uk')) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('LH_Complete', '1');
    u.searchParams.set('LH_Sold', '1');
    u.searchParams.set('LH_PrefLoc', '1');
    return u.toString();
  } catch (e) {
    return url;
  }
}

// ── Tab group styling (yellow) for extension-opened eBay/CC/CeX tabs ─────────────

/**
 * Put a tab into a yellow tab group so users can distinguish extension-opened
 * tabs (eBay, Cash Converters, CeX) from other tabs.
 */
async function putTabInYellowGroup(tabId) {
  try {
    const groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, {
      color: 'yellow',
      title: 'CG Suite'
    });
  } catch (e) {
    console.warn('[CG Suite] Could not add tab to yellow group:', e?.message);
  }
}

/**
 * Open NosPos (or any URL) in a separate background window — same path as repricing `openNosposAndWait`.
 * Never call putTabInYellowGroup on this tab: grouping can move the tab into the focused window.
 * Order: minimized create → unfocused window + minimize → last resort inactive tab in current window.
 */
async function openBackgroundNosposTab(url, appTabId = null) {
  try {
    const win = await chrome.windows.create({
      url,
      focused: false,
      state: 'minimized',
    });
    if (win?.id != null) {
      await chrome.windows.update(win.id, { focused: false, state: 'minimized' }).catch(() => {});
    }
    const tab = (win?.tabs || [])[0];
    if (tab?.id != null) {
      if (appTabId) {
        await focusAppTab(appTabId);
      }
      return { tabId: tab.id, windowId: win.id || null };
    }
  } catch (e) {
    console.warn('[CG Suite] Could not open minimized NoSpos window:', e?.message);
  }

  try {
    const win = await chrome.windows.create({
      url,
      focused: false,
    });
    if (win?.id != null) {
      await chrome.windows.update(win.id, { focused: false, state: 'minimized' }).catch(() => {});
    }
    const tab = (win?.tabs || [])[0];
    if (tab?.id != null) {
      if (appTabId) {
        await focusAppTab(appTabId);
      }
      return { tabId: tab.id, windowId: win.id || null };
    }
  } catch (e2) {
    console.warn('[CG Suite] Could not open NosPos window (fallback):', e2?.message);
  }

  const fallbackTab = await chrome.tabs.create({ url, active: false });
  await putTabInYellowGroup(fallbackTab.id);
  if (appTabId) {
    await focusAppTab(appTabId);
  }
  return { tabId: fallbackTab.id, windowId: fallbackTab.windowId || null };
}

/**
 * Park agreement: open NosPos in a normal tab (same window as the app when possible), not a minimized window.
 */
async function openNosposParkAgreementTab(url, appTabId = null) {
  let windowId = null;
  if (appTabId) {
    try {
      const t = await chrome.tabs.get(appTabId);
      windowId = t.windowId;
    } catch (_) {}
  }
  if (windowId == null) {
    try {
      const w = await chrome.windows.getLastFocused({ populate: false });
      windowId = w?.id ?? null;
    } catch (_) {}
  }
  const createOpts = { url, active: false };
  if (windowId != null) createOpts.windowId = windowId;
  const newTab = await chrome.tabs.create(createOpts);
  await putTabInYellowGroup(newTab.id);
  if (appTabId) {
    await focusAppTab(appTabId);
  }
  console.log('[CG Suite] NosPos park agreement: opened tab', { tabId: newTab.id, windowId: newTab.windowId });
  return { tabId: newTab.id, windowId: newTab.windowId || null };
}

/**
 * Bring the parked NoSpos tab to the foreground; if it was closed, open fallbackCreateUrl (new agreement).
 */
async function focusOrOpenNosposParkTabImpl({ tabId, fallbackCreateUrl, appTabId = null }) {
  const id = parseInt(String(tabId ?? '').trim(), 10);
  const fallback = String(fallbackCreateUrl || '').trim();
  if (Number.isFinite(id) && id > 0) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.id) {
        await chrome.tabs.update(id, { active: true });
        if (tab.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        return { ok: true, tabId: id, mode: 'focused' };
      }
    } catch (_) {}
  }
  let okUrl = false;
  try {
    const u = new URL(fallback);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    okUrl =
      (host === 'nospos.com' || host.endsWith('.nospos.com')) &&
      u.protocol === 'https:' &&
      /^\/newagreement\//i.test(u.pathname || '');
  } catch (_) {
    okUrl = false;
  }
  if (!okUrl) {
    return {
      ok: false,
      error:
        'NoSpos tab not found. It may have been closed — run Park agreement again or open NoSpos manually.',
    };
  }
  let windowId = null;
  if (appTabId) {
    try {
      const t = await chrome.tabs.get(appTabId);
      windowId = t.windowId;
    } catch (_) {}
  }
  if (windowId == null) {
    try {
      const w = await chrome.windows.getLastFocused({ populate: false });
      windowId = w?.id ?? null;
    } catch (_) {}
  }
  const opts = { url: fallback, active: true };
  if (windowId != null) opts.windowId = windowId;
  const newTab = await chrome.tabs.create(opts);
  await putTabInYellowGroup(newTab.id);
  console.log('[CG Suite] NosPos park: opened fallback agreement tab', { tabId: newTab.id });
  return { ok: true, tabId: newTab.id, mode: 'opened' };
}

// ── Storage helpers ────────────────────────────────────────────────────────────

async function getPending() {
  const data = await chrome.storage.session.get('cgPending');
  return data.cgPending || {};
}

async function setPending(obj) {
  return chrome.storage.session.set({ cgPending: obj });
}

function isNosposSearchPath(path) {
  return /^\/stock\/search(?:\/index)?\/?$/i.test((path || '').trim());
}

function isNosposAgreementItemsUrl(url) {
  try {
    const u = new URL(url || '');
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'nospos.com' && !host.endsWith('.nospos.com')) return false;
    return /\/newagreement\/\d+\/items\/?$/i.test(u.pathname || '');
  } catch (e) {
    return false;
  }
}

/** Any step under /newagreement/{id}/… (items, next wizard step, etc.). */
function isNosposNewAgreementWorkflowUrl(url) {
  try {
    const u = new URL(url || '');
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'nospos.com' && !host.endsWith('.nospos.com')) return false;
    return /\/newagreement\/\d+\//i.test(u.pathname || '');
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Max time to wait for a NosPos full tab reload after Add or category change (user can retry after). */
const NOSPOS_RELOAD_WAIT_MS = 20000;

async function sendMessageToTabWithRetries(tabId, message, retries, delayMs) {
  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await sleep(delayMs);
      }
    }
  }
  throw lastErr || new Error('Could not reach target tab');
}

async function scrapeNosposGridMessage(tabId, messageType) {
  try {
    const response = await sendMessageToTabWithRetries(tabId, { type: messageType }, 12, 400);
    const rows = Array.isArray(response?.rows) ? response.rows : [];
    if (response?.ok === false && rows.length === 0) {
      return { ok: false, rows: [], error: response?.error || 'Scrape returned no rows' };
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, rows: [], error: e?.message || 'Scrape failed' };
  }
}

async function scrapeNosposStockCategoryTab(tabId) {
  return scrapeNosposGridMessage(tabId, 'SCRAPE_NOSPOS_STOCK_CATEGORY');
}

/**
 * Wait for a full navigation cycle (loading → complete) on the agreement items page.
 */
async function waitForAgreementItemsPageReload(tabId, reasonTag, maxWaitMs = NOSPOS_RELOAD_WAIT_MS) {
  await new Promise((resolve) => {
    let sawLoading = false;
    let done = false;
    const listener = (tid, change, tab) => {
      if (tid !== tabId || done) return;
      if (change.status === 'loading') sawLoading = true;
      if (
        sawLoading &&
        change.status === 'complete' &&
        isNosposAgreementItemsUrl(tab?.url || '')
      ) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        console.log('[CG Suite] NosPos agreement fill: reload complete —', reasonTag);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (done) return;
      chrome.tabs.onUpdated.removeListener(listener);
      console.log(
        '[CG Suite] NosPos agreement fill: no reload within',
        maxWaitMs,
        'ms —',
        reasonTag
      );
      resolve();
    }, maxWaitMs);
  });
  await sleep(500);
}

/**
 * After changing category, NosPos often full-reloads the items page. Wait for navigation
 * (loading → complete) and/or until the content script reports the form + stock controls exist.
 */
async function waitForAgreementItemsReadyAfterCategory(
  tabId,
  expectStockFieldLabels = [],
  lineIndex = 0
) {
  const labels = Array.isArray(expectStockFieldLabels)
    ? expectStockFieldLabels.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const start = Date.now();
  const maxTotalMs = 40000;

  await new Promise((resolve) => {
    let sawLoading = false;
    let done = false;
    const listener = (tid, change, tab) => {
      if (tid !== tabId || done) return;
      if (change.status === 'loading') sawLoading = true;
      if (
        sawLoading &&
        change.status === 'complete' &&
        isNosposAgreementItemsUrl(tab?.url || '')
      ) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        console.log(
          '[CG Suite] NosPos agreement fill: tab finished reloading after category change'
        );
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (done) return;
      chrome.tabs.onUpdated.removeListener(listener);
      console.log(
        '[CG Suite] NosPos agreement fill: no reload cycle detected within',
        NOSPOS_RELOAD_WAIT_MS,
        'ms (may be in-place update)'
      );
      resolve();
    }, NOSPOS_RELOAD_WAIT_MS);
  });

  await sleep(400);

  let lastProbe = null;
  while (Date.now() - start < maxTotalMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) {
      return { ok: false, error: 'The NoSpos tab was closed', probe: lastProbe };
    }
    if (!isNosposAgreementItemsUrl(t.url || '')) {
      await sleep(400);
      continue;
    }
    if (t.status !== 'complete') {
      await sleep(350);
      continue;
    }
    try {
      lastProbe = await sendMessageToTabWithRetries(
        tabId,
        {
          type: 'NOSPOS_AGREEMENT_FILL_PHASE',
          phase: 'probe_rest_ready',
          expectStockFieldLabels: labels,
          lineIndex,
        },
        10,
        500
      );
    } catch (e) {
      lastProbe = { ready: false, error: String(e?.message || e) };
      console.log('[CG Suite] NosPos agreement fill: probe send failed', lastProbe.error);
    }
    if (lastProbe?.ready) {
      console.log('[CG Suite] NosPos agreement fill: form probe OK', lastProbe.debug || {});
      await sleep(600);
      return { ok: true, probe: lastProbe };
    }
    if (lastProbe?.debug) {
      console.log('[CG Suite] NosPos agreement fill: probe waiting…', lastProbe.debug);
    }
    await sleep(500);
  }
  return {
    ok: false,
    error: 'Timed out waiting for NosPos form after category change',
    probe: lastProbe,
  };
}

async function countNosposAgreementItemLines(tabId) {
  try {
    const r = await sendMessageToTabWithRetries(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'count_lines' },
      10,
      400
    );
    return typeof r?.count === 'number' ? r.count : 0;
  } catch (_) {
    return 0;
  }
}

/** 0-based line index whose item description contains the marker, or null if not found. */
async function findNosposLineIndexForMarker(tabId, marker) {
  const m = String(marker || '').trim();
  if (!m) return null;
  try {
    const r = await sendMessageToTabWithRetries(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'find_line_marker', marker: m },
      10,
      400
    );
    if (!r?.ok) return null;
    const idx = parseInt(String(r.lineIndex), 10);
    if (!Number.isFinite(idx) || idx < 0) return null;
    return idx;
  } catch (_) {
    return null;
  }
}

function requestItemMarkerTokenFromCgMarker(marker) {
  const m = String(marker || '').trim();
  if (!m) return '';
  const hit = m.match(/-RI-([A-Za-z0-9_-]+)-L\d+\]?$/i) || m.match(/-RI-([A-Za-z0-9_-]+)/i);
  if (!hit || !hit[1]) return '';
  return `RI-${String(hit[1]).trim()}`;
}

/** Match CG marker segment `-RI-{id}-` so `RI-12` does not match `RI-1274` or `RI-12740`. */
function findMarkerSearchNeedleForPark(marker) {
  const m = String(marker || '').trim();
  if (!m) return '';
  const bracket = m.match(/-RI-([A-Za-z0-9_-]+)-/i);
  if (bracket && bracket[1]) return `-RI-${String(bracket[1]).trim()}-`;
  const riTok = requestItemMarkerTokenFromCgMarker(m);
  if (riTok) {
    const id = riTok.match(/^RI-(.+)$/i);
    if (id && id[1]) return `-RI-${String(id[1]).trim()}-`;
  }
  return m;
}

async function findNosposLineIndexForMarkerWithFallback(tabId, marker) {
  const riNeedle = findMarkerSearchNeedleForPark(marker);
  if (riNeedle && riNeedle !== String(marker || '').trim()) {
    const byRi = await findNosposLineIndexForMarker(tabId, riNeedle);
    if (byRi != null && byRi >= 0) {
      console.log('[CG Suite] NosPos park: matched by request-item needle in description', {
        marker,
        riNeedle,
        lineIndex: byRi,
      });
      return byRi;
    }
  }
  const exact = await findNosposLineIndexForMarker(tabId, marker);
  if (exact != null && exact >= 0) {
    console.log('[CG Suite] NosPos park: matched by full marker substring', {
      marker,
      lineIndex: exact,
    });
    return exact;
  }
  console.log('[CG Suite] NosPos park: no row found by description marker', {
    marker,
    riNeedle,
    lineIndex: null,
  });
  return null;
}

async function readNosposAgreementLineSnapshot(tabId, lineIndex) {
  const lineIdx = Math.max(0, parseInt(String(lineIndex ?? '0'), 10) || 0);
  try {
    return await sendMessageToTabWithRetries(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'read_line_snapshot', lineIndex: lineIdx },
      8,
      350
    );
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Remove NosPos draft rows that match skipped CG lines: description contains `-RI-{requestItemId}-`.
 * One delete at a time; waits for items page reload after each (same as Add flow).
 */
async function deleteExcludedNosposAgreementLinesImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab', deleted: [] };
  }
  const raw = Array.isArray(payload.requestItemIds) ? payload.requestItemIds : [];
  const ids = [
    ...new Set(
      raw
        .map((x) => String(x ?? '').trim())
        .filter((x) => x.length > 0 && /^\d+$/.test(x))
    ),
  ];
  if (!ids.length) {
    return { ok: true, deleted: [], skipped: true };
  }
  const tabCheck = await ensureNosposAgreementItemsTab(tabId, 120000);
  if (!tabCheck.ok) {
    return { ...tabCheck, deleted: [] };
  }
  const deleted = [];
  for (let ii = 0; ii < ids.length; ii += 1) {
    const rid = ids[ii];
    try {
      const r = await sendMessageToTabWithRetries(
        tabId,
        {
          type: 'NOSPOS_AGREEMENT_FILL_PHASE',
          phase: 'delete_line_by_request_item_id',
          requestItemId: rid,
        },
        18,
        450
      );
      if (!r || r.ok === false) {
        console.warn('[CG Suite] NosPos park: delete excluded line failed', rid, r?.error);
        continue;
      }
      if (r.skipped) {
        console.log('[CG Suite] NosPos park: delete excluded skipped (no row)', rid, r.reason);
        continue;
      }
      if (r.deleted) {
        deleted.push(String(rid));
        await waitForAgreementItemsPageReload(
          tabId,
          `after delete excluded RI-${rid}`,
          NOSPOS_RELOAD_WAIT_MS
        );
        await sleep(600);
      }
    } catch (e) {
      console.warn('[CG Suite] NosPos park: delete excluded error', rid, e?.message || e);
    }
  }
  return { ok: true, deleted };
}

/**
 * After clicking Items "Next", wait until the tab is off the /items step (wizard advances; often full reload).
 */
async function waitAfterAgreementItemsNextClick(tabId, maxWaitMs = NOSPOS_RELOAD_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return { ok: false, error: 'The NoSpos tab was closed' };
    }
    const url = tab.url || '';
    if (
      tab.status === 'complete' &&
      isNosposNewAgreementWorkflowUrl(url) &&
      !isNosposAgreementItemsUrl(url)
    ) {
      await sleep(500);
      return { ok: true };
    }
    await sleep(250);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (
    tab?.status === 'complete' &&
    isNosposNewAgreementWorkflowUrl(tab.url || '') &&
    !isNosposAgreementItemsUrl(tab.url || '')
  ) {
    await sleep(500);
    return { ok: true };
  }
  return {
    ok: false,
    error:
      'NoSpos did not leave the items step after Next — click Next manually, wait for the page, then Park Agreement.',
  };
}

/** Items page Next → wait for reload → Agreement card Actions → Park Agreement → SweetAlert OK. */
async function clickNosposSidebarParkAgreementImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  const tabCheck = await ensureNosposAgreementItemsTab(tabId, 120000);
  if (!tabCheck.ok) {
    return tabCheck;
  }
  try {
    const rNext = await sendMessageToTabWithRetries(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'click_items_form_next' },
      18,
      450
    );
    if (!rNext || rNext.ok === false) {
      return {
        ok: false,
        error: rNext?.error || 'Could not press Next on the NoSpos items page',
      };
    }
    const waitNav = await waitAfterAgreementItemsNextClick(tabId, NOSPOS_RELOAD_WAIT_MS);
    if (!waitNav.ok) {
      return waitNav;
    }
    const r = await sendMessageToTabWithRetries(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'sidebar_park_agreement' },
      22,
      450
    );
    if (!r || r.ok === false) {
      return {
        ok: false,
        error: r?.error || 'NoSpos did not complete sidebar Park Agreement',
      };
    }
    await sleep(1400);
    return { ok: true, parked: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) || 'Sidebar park failed' };
  }
}

async function clickNosposAgreementAddItem(tabId) {
  return sendMessageToTabWithRetries(
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
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return { ok: false, error: 'The NoSpos tab was closed' };
    }
    // Require both the items URL AND a fully-loaded page — otherwise the DOM
    // may still be mid-render and the content script might not be ready yet.
    if (isNosposAgreementItemsUrl(tab.url || '') && tab.status === 'complete') {
      return { ok: true };
    }
    await sleep(350);
  }
  return {
    ok: false,
    error:
      'Items page did not load in time. Finish opening the agreement in the NoSpos window, then try again.',
  };
}

/**
 * Set category and wait for NosPos reload / form (up to {@link NOSPOS_RELOAD_WAIT_MS} for reload detection).
 */
async function applyNosposAgreementCategoryPhaseImpl(tabId, payload) {
  const lineIndex = Math.max(0, parseInt(String(payload.lineIndex ?? '0'), 10) || 0);
  const categoryId = String(payload.categoryId ?? '').trim();
  let categoryLabel = null;
  const stockLabelsForWait = Array.isArray(payload.stockFields)
    ? payload.stockFields.map((r) => r && r.label).filter(Boolean)
    : [];
  if (!categoryId) {
    return { ok: true, categoryLabel: null, waitForm: { ok: true }, lineIndex };
  }
  try {
    const r1 = await sendMessageToTabWithRetries(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'category', categoryId, lineIndex },
      8,
      500
    );
    if (!r1?.ok) {
      return { ok: false, error: r1?.error || 'Could not set category', lineIndex, ...r1 };
    }
    categoryLabel = r1.label || null;
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
    if (!waitForm.ok) {
      console.warn('[CG Suite] NosPos agreement fill: post-category wait failed', waitForm);
    }
    return { ok: true, categoryLabel, waitForm, lineIndex };
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not set category on NoSpos', lineIndex };
  }
}

/**
 * Fill name, description, qty, prices, stock fields on an agreement line (retries when DOM not ready).
 */
async function applyNosposAgreementRestPhaseImpl(tabId, payload, categoryLabel) {
  const lineIndex = Math.max(0, parseInt(String(payload.lineIndex ?? '0'), 10) || 0);
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
      last = await sendMessageToTabWithRetries(tabId, restPayload, 6, 350);
      if (last?.ok) {
        return {
          ok: true,
          categoryLabel,
          lineIndex,
          ...last,
        };
      }
      if (!last?.notReady) {
        return {
          ok: false,
          categoryLabel,
          lineIndex,
          error: last?.error || 'Could not fill agreement line',
          ...last,
        };
      }
      await sleep(500);
    }
    return {
      ok: false,
      categoryLabel,
      lineIndex,
      error: last?.error || 'Agreement line form did not become ready in time',
      ...last,
    };
  } catch (e) {
    return {
      ok: false,
      categoryLabel,
      lineIndex,
      error: e?.message || 'Could not fill agreement line on NoSpos',
    };
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

  if (stepIndex === 0 || alwaysEnsureTab) {
    const tabCheck = await ensureNosposAgreementItemsTab(tabId, 120000);
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
        console.log('[CG Suite] NosPos park: reusing row with CG marker (skip Add)', {
          marker,
          targetLineIndex,
          stepIndex,
          nosposName: snap.name,
          nosposItemDescription: snap.description,
          nosposCategoryId: snap.categoryId,
        });
        if (expCat && snap.categoryId && expCat !== snap.categoryId) {
          console.warn(
            '[CG Suite] NosPos park: category differs on reused row (fill will overwrite)',
            { expectedCategoryId: expCat, nosposCategoryId: snap.categoryId }
          );
        }
        if (!String(snap.description || '').includes(marker)) {
          console.warn(
            '[CG Suite] NosPos park: marker missing in Nospos item description before fill',
            { marker, description: snap.description }
          );
        }
      }
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

    if (stepIndex === 0 || noAdd) {
      targetLineIndex = fallbackIdx;
      // Only rows found by description marker skip category / "reuse" path. Positional fallback may
      // target an empty or wrong card — keep reusedExistingRow false so the UI runs category + fill.
      if (noAdd && stepIndex > 0) {
        console.log('[CG Suite] NosPos park: noAdd — marker not found, using fallback line index', {
          stepIndex,
          negotiationLineIndex,
          fallbackIdx,
          lineCount: countBefore,
          parkNegotiationLineCount,
          reusedExistingRow,
        });
      }
    } else if (countBefore > fallbackIdx) {
      targetLineIndex = fallbackIdx;
      console.log('[CG Suite] NosPos park: marker not found; using existing row at fallback index (skip Add)', {
        stepIndex,
        negotiationLineIndex,
        fallbackIdx,
        lineCount: countBefore,
        parkNegotiationLineCount,
        marker,
      });
    } else {
      const clickR = await clickNosposAgreementAddItem(tabId);
      if (!clickR?.ok) {
        return { ok: false, error: clickR?.error || 'Could not click Add on NoSpos' };
      }
      didClickAdd = true;
      const waitNew = await waitForNewAgreementLineAfterAdd(tabId, countBefore);
      if (!waitNew.ok) {
        return { ok: false, error: waitNew.error };
      }
      const countAfter = await countNosposAgreementItemLines(tabId);
      targetLineIndex = Math.max(0, countAfter - 1);
    }
  }

  return { ok: true, targetLineIndex, reusedExistingRow, didClickAdd };
}

/**
 * One step of the park flow: optional Add+wait (stepIndex &gt; 0), then fill that line.
 * Lets the app refresh UI between lines.
 */
async function fillNosposAgreementItemStepImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  const stepIndex = Math.max(0, parseInt(String(payload.stepIndex ?? '0'), 10) || 0);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }

  const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
  const resolved = await resolveNosposParkAgreementLineImpl(tabId, stepIndex, item, {
    negotiationLineIndex: payload.negotiationLineIndex,
    parkNegotiationLineCount: payload.parkNegotiationLineCount,
  });
  if (!resolved.ok) return resolved;

  const fillRes = await fillNosposAgreementOneLineImpl(tabId, {
    ...item,
    lineIndex: resolved.targetLineIndex,
  });
  if (!fillRes?.ok) return fillRes;
  return {
    ...fillRes,
    reusedExistingRow: resolved.reusedExistingRow,
    targetLineIndex: resolved.targetLineIndex,
    didClickAdd: resolved.didClickAdd,
  };
}

async function fillNosposAgreementItemsSequentialImpl(payload) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
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
        barcode
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
  const totalBarcodes = countTotalBarcodes(repricingData);
  const completedBarcodeCount = countCompletedBarcodes(completedBarcodes);
  const queue = getActiveQueue(data);
  const next = queue[0] || null;
  const nextItem = next ? repricingData[next.itemIndex] : null;

  return {
    cartKey: data?.cartKey || '',
    running: !data?.done,
    done: !!data?.done,
    step: overrides.step || data?.step || (data?.done ? 'completed' : 'working'),
    message: overrides.message || data?.message || '',
    currentBarcode: overrides.currentBarcode ?? data?.currentBarcode ?? next?.barcode ?? '',
    currentItemId: overrides.currentItemId ?? data?.currentItemId ?? nextItem?.itemId ?? '',
    currentItemTitle: overrides.currentItemTitle ?? data?.currentItemTitle ?? nextItem?.title ?? '',
    totalBarcodes,
    completedBarcodeCount,
    completedBarcodes,
    completedItems,
    logs: data?.logs || [],
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

async function focusAppTab(appTabId) {
  if (!appTabId) return;
  const appTab = await chrome.tabs.get(appTabId).catch(() => null);
  if (!appTab) return;
  await chrome.tabs.update(appTabId, { active: true }).catch(() => {});
  if (appTab.windowId) {
    await chrome.windows.update(appTab.windowId, { focused: true }).catch(() => {});
  }
}

importScripts('tasks/jewellery-scrap-prices-tab.js');

// ── CeX nav scrape (super-categories) — see cex-scrape/ in repo ──────────────

function waitForTabLoadComplete(tabId, timeoutMs, timeoutErrorMessage) {
  const ms = timeoutMs == null ? 90000 : timeoutMs;
  const timeoutMsg = timeoutErrorMessage || 'CeX tab load timed out';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(timeoutMsg));
    }, ms);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    }).catch(() => {});
  });
}

importScripts('tasks/nospos-stock-category-pagination.js');

/**
 * Shared tail for Data-page imports: clear pending, run `work(tabId)` after NOSPOS_PAGE_READY,
 * then post `{ response }` or `{ error }` to the app tab (same contract as category import).
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

// ── NosPos stock search result parser ─────────────────────────────────────────

/**
 * Parse the NosPos /stock/search/index HTML page and extract result rows.
 * Returns an array of { barserial, href, name, costPrice, retailPrice, quantity }.
 */
function decodeNosposHtmlText(value) {
  return (value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function getStockNameFromEditHtml(html) {
  // Try every ordering of attributes on the stock-name input.
  // The input looks like: <input type="text" id="stock-name" class="..." name="Stock[name]" value="xbox series x" ...>
  // We match the whole input tag first, then pull value= out of it.
  const byId = html.match(/<input[^>]+id="stock-name"[^>]*>/i);
  const byName = html.match(/<input[^>]+name="Stock\[name\]"[^>]*>/i);
  const tag = (byId || byName)?.[0] || '';
  const valueMatch = tag.match(/\bvalue="([^"]*)"/i);
  return decodeNosposHtmlText(valueMatch?.[1] || '');
}

function parseNosposSearchResults(html) {
  const results = [];
  // Match <tr data-key="..."> rows
  const rowRe = /<tr[^>]+data-key="\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    // Extract all <td>...</td> cells
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 5) continue;

    // Cell 0: barserial + href
    const linkMatch = cells[0].match(/<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/i);
    const href = linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : '';
    const barserial = linkMatch ? linkMatch[2].trim() : '';

    // Cell 1: item name (prefer title attribute for full text, handles HTML entities)
    const titleAttr = cells[1].match(/(?:data-original-title|title)="([^"]+)"/i);
    const name = titleAttr
      ? decodeNosposHtmlText(titleAttr[1])
      : cells[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // Cells 2-4: prices + quantity (strip all tags)
    const costPrice = cells[2].replace(/<[^>]*>/g, '').trim();
    const retailPrice = cells[3].replace(/<[^>]*>/g, '').trim();
    const quantity = cells[4].replace(/<[^>]*>/g, '').trim();

    if (barserial || href) {
      results.push({ barserial, href, name, costPrice, retailPrice, quantity });
    }
  }
  return results;
}

/**
 * Parse a direct /stock/:id/edit hit when NosPos bypasses the search results page.
 * Returns a single result row if the page contains a Barserial detail.
 */
function parseNosposStockEditResult(html, finalUrl) {
  const barserialMatch = html.match(
    /<div[^>]*class="detail"[^>]*>\s*<strong>\s*Barserial\s*<\/strong>\s*<span>([\s\S]*?)<\/span>\s*<\/div>/i
  );
  const barserial = decodeNosposHtmlText(
    (barserialMatch?.[1] || '').replace(/<[^>]*>/g, ' ')
  );
  if (!barserial) return [];

  let href = '';
  try {
    href = new URL(finalUrl).pathname || '';
  } catch {
    href = '';
  }

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const stockNameFromInput = getStockNameFromEditHtml(html);
  const name = stockNameFromInput || decodeNosposHtmlText((titleMatch?.[1] || '').replace(/\s*-\s*Nospos\s*$/i, ''));

  return [{
    barserial,
    href,
    name,
    costPrice: '',
    retailPrice: '',
    quantity: ''
  }];
}

// ── Address lookup (getAddress.io via Django proxy) ─────────────────────────────

const ADDRESS_API_BASE = 'http://127.0.0.1:8000';

async function handleFetchAddressSuggestions(message) {
  // Normalize postcode: trim, collapse whitespace (including nbsp), uppercase
  const raw = (message.postcode || '').trim().replace(/\s+/g, ' ').replace(/\u00A0/g, ' ');
  const postcode = raw.toUpperCase();
  if (!postcode || postcode.replace(/\s/g, '').length < 4) {
    return { ok: true, addresses: [] };
  }
  const bases = ['http://127.0.0.1:8000', 'http://localhost:8000'];
  for (const base of bases) {
    try {
      const url = `${base}/api/address-lookup/${encodeURIComponent(postcode)}/`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        return { ok: false, error: err.error || `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      const addresses = data.addresses || [];
      return { ok: true, addresses: Array.isArray(addresses) ? addresses : [] };
    } catch (e) {
      if (bases.indexOf(base) < bases.length - 1) continue;
      return { ok: false, error: (e?.message || 'Network error') + '. Is Django running at http://127.0.0.1:8000?' };
    }
  }
  return { ok: false, error: 'Could not reach address lookup service' };
}

// ── Message router ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    handleBridgeForward(message, sender)
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e?.message || String(e) || 'Extension bridge handler failed',
        })
      );
    return true;
  }

  if (message.type === 'CG_APP_PAGE_UNLOADING') {
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

  return false;
});

// ── NosPos session (HTML fetch + redirect detection; shared by stock search & customer profile) ──

const NOSPOS_HTML_FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/**
 * True when a credentialed NosPos HTML response looks unauthenticated (same rules as stock search).
 */
function nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl) {
  const url = (finalUrl || response?.url || '').toLowerCase();
  if (!response?.ok) return true;
  return (
    url.includes('/login') ||
    url.includes('/signin') ||
    url.includes('/site/standard-login') ||
    url.includes('/twofactor')
  );
}

// ── Handlers ───────────────────────────────────────────────────────────────────

async function handleBridgeForward(message, sender) {
  const { requestId, payload } = message;
  const appTabId = sender.tab?.id;

  // User clicked "Add from CeX" (or eBay / Cash Converters). Open the competitor site and store pending so we can later send WAITING_FOR_DATA to the tab when it's on a listing/product page.
  if (payload.action === 'startWaitingForData' && appTabId != null) {
    const competitor = payload.competitor || 'eBay';
    const searchQuery = (payload.searchQuery || '').trim();
    const marketComparisonContext = payload.marketComparisonContext || null;

    let url;
    if (competitor === 'CashConverters') {
      url = searchQuery
        ? `https://www.cashconverters.co.uk/search-results?Sort=default&page=1&query=${encodeURIComponent(searchQuery)}`
        : 'https://www.cashconverters.co.uk/';
    } else if (competitor === 'CeX') {
      // With a header search term: CeX site search. Without: homepage (unchanged).
      url = searchQuery
        ? `https://uk.webuy.com/search?stext=${encodeURIComponent(searchQuery)}`
        : 'https://uk.webuy.com/';
    } else {
      // Always enforce: Completed items (LH_Complete=1), Sold items (LH_Sold=1), UK Only (LH_PrefLoc=1)
      url = searchQuery
        ? `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}&LH_Complete=1&LH_Sold=1&LH_PrefLoc=1`
        : 'https://www.ebay.co.uk/';
    }

    const newTab = await chrome.tabs.create({ url });
    await putTabInYellowGroup(newTab.id);

    const pending = await getPending();
    pending[requestId] = { appTabId, listingTabId: newTab.id, competitor, marketComparisonContext };
    await setPending(pending);

    console.log('[CG Suite] startWaitingForData saved – only this tab can complete the flow; closing it will notify the app', { requestId, competitor, listingTabId: newTab.id, appTabId });
    return { ok: true };
  }

  if (payload.action === 'scrapeCexSuperCategories' && appTabId != null) {
    void executeCexSuperCategoryNavScrape(requestId, appTabId);
    return { ok: true };
  }

  if (payload.action === 'cancelRequest' && appTabId != null) {
    // User clicked Cancel/Reset in the app while a listing tab was open.
    // Find the pending entry for this app tab, close the listing tab, and
    // send a clean cancelled response so the app's awaiting promise resolves.
    // Skip openNospos entries – we never close the NoSpos tab (user needs it to log in).
    const pending = await getPending();
    for (const [reqId, entry] of Object.entries(pending)) {
      if (
        entry.appTabId === appTabId &&
        entry.type !== 'openNospos' &&
        entry.type !== 'openNosposCustomerIntake' &&
        entry.type !== 'openNosposCustomerIntakeWaiting' &&
        entry.type !== 'openNosposSiteOnly' &&
        entry.type !== 'openNosposSiteForFields' &&
        entry.type !== 'openNosposSiteForCategoryFields' &&
        entry.type !== 'openNosposSiteForCategoryFieldsBulk'
      ) {
        const listingTabId = entry.listingTabId;
        delete pending[reqId];
        await setPending(pending);
        if (listingTabId != null) {
          await chrome.tabs.remove(listingTabId).catch(() => {});
        }
        chrome.tabs.sendMessage(appTabId, {
          type: 'EXTENSION_RESPONSE_TO_PAGE',
          requestId: reqId,
          response: { success: false, cancelled: true }
        }).catch(() => {});
        break;
      }
    }
    return { ok: true };
  }

  // Search NosPos stock by barcode in the background (no tab switch).
  // Fetches the stock search results page directly and parses the results table.
  if (payload.action === 'searchNosposBarcode') {
    const barcode = (payload.barcode || '').trim();
    if (!barcode) return { ok: false, error: 'No barcode provided' };
    try {
      const searchUrl = `https://nospos.com/stock/search/index?StockSearchAndFilter[query]=${encodeURIComponent(barcode)}&sort=-quantity`;
      const response = await fetch(searchUrl, {
        credentials: 'include',
        headers: NOSPOS_HTML_FETCH_HEADERS,
      });
      const finalUrl = response.url || '';
      if (nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl)) {
        return { ok: false, loginRequired: true };
      }
      const html = await response.text();
      const isDirectStockEditHit = /^https:\/\/[^/]*nospos\.com\/stock\/\d+\/edit\/?(\?.*)?$/i.test(finalUrl);
      const results = isDirectStockEditHit
        ? parseNosposStockEditResult(html, finalUrl)
        : parseNosposSearchResults(html);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e.message || 'Search failed' };
    }
  }

  async function nosposCancelResponseBody(response) {
    try {
      await response.body?.cancel?.();
    } catch (_) {
      /* ignore */
    }
  }

  async function nosposFetchCustomerBuyingSession(customerId, sessionCheckMs = 12000) {
    const id = parseInt(String(customerId ?? '').trim(), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, error: 'Invalid NosPos customer id' };
    }
    const buyingPageUrl = `https://nospos.com/customer/${id}/buying`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), sessionCheckMs);
      let response;
      try {
        response = await fetch(buyingPageUrl, {
          credentials: 'include',
          headers: NOSPOS_HTML_FETCH_HEADERS,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const finalUrl = response.url || '';
      await nosposCancelResponseBody(response);
      if (nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl)) {
        return { ok: false, loginRequired: true };
      }
      return { ok: true, customerId: id };
    } catch (e) {
      const isAbort = e?.name === 'AbortError';
      return {
        ok: false,
        error: isAbort
          ? 'NoSpos did not respond in time. Check your connection, sign in at nospos.com in Chrome, and try again.'
          : e?.message || 'Could not verify NoSpos session',
      };
    }
  }

  // Park agreement (step 1): session only — same probe as searchNosposBarcode path.
  if (payload.action === 'checkNosposCustomerBuyingSession') {
    return nosposFetchCustomerBuyingSession(payload.nosposCustomerId);
  }

  // Park agreement (step 2): open create URL in background; call after checkNosposCustomerBuyingSession succeeds.
  if (payload.action === 'openNosposNewAgreementCreateBackground') {
    const id = parseInt(String(payload.nosposCustomerId ?? '').trim(), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, error: 'Invalid NosPos customer id' };
    }
    const rawType = String(
      payload.agreementType ?? payload.nosposAgreementType ?? 'DP'
    ).toUpperCase();
    const agreementType = rawType === 'PA' ? 'PA' : 'DP';
    const createUrl = `https://nospos.com/newagreement/agreement/create?type=${agreementType}&customer_id=${id}`;
    try {
      const { tabId } = await openNosposParkAgreementTab(createUrl, appTabId);
      if (tabId == null) return { ok: false, error: 'Could not open NoSpos tab' };
      return { ok: true, tabId };
    } catch (e) {
      return { ok: false, error: e?.message || 'Could not open NoSpos' };
    }
  }

  // Park agreement (step 3): wait for items page, set category, then fill first line (name, qty, prices, stock fields).
  if (payload.action === 'fillNosposAgreementFirstItem') {
    return fillNosposAgreementFirstItemImpl(payload);
  }

  // Park agreement: add each negotiation line sequentially (Add → wait reload → category → fill).
  if (payload.action === 'fillNosposAgreementItems') {
    return fillNosposAgreementItemsSequentialImpl(payload);
  }

  // Park agreement: single line step (UI updates between calls).
  if (payload.action === 'fillNosposAgreementItemStep') {
    return fillNosposAgreementItemStepImpl(payload);
  }

  if (payload.action === 'resolveNosposParkAgreementLine') {
    const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
    const stepIndex = Math.max(0, parseInt(String(payload.stepIndex ?? '0'), 10) || 0);
    const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
    if (!Number.isFinite(tabId) || tabId <= 0) {
      return { ok: false, error: 'Invalid tab' };
    }
    return resolveNosposParkAgreementLineImpl(tabId, stepIndex, item, {
      noAdd: payload.noAdd === true,
      ensureTab: payload.ensureTab === true,
      negotiationLineIndex: payload.negotiationLineIndex,
      parkNegotiationLineCount: payload.parkNegotiationLineCount,
    });
  }

  if (payload.action === 'deleteExcludedNosposAgreementLines') {
    return deleteExcludedNosposAgreementLinesImpl(payload);
  }

  if (payload.action === 'clickNosposSidebarParkAgreement') {
    return clickNosposSidebarParkAgreementImpl(payload);
  }

  if (payload.action === 'focusOrOpenNosposParkTab') {
    return focusOrOpenNosposParkTabImpl({
      tabId: payload.tabId,
      fallbackCreateUrl: payload.fallbackCreateUrl,
      appTabId,
    });
  }

  if (payload.action === 'getNosposTabUrl') {
    const tid = parseInt(String(payload.tabId ?? '').trim(), 10);
    if (!Number.isFinite(tid) || tid <= 0) return { ok: false, error: 'Invalid tabId' };
    try {
      const tab = await chrome.tabs.get(tid);
      return { ok: true, url: tab?.url ?? null };
    } catch (_) {
      return { ok: false, error: 'Tab not found' };
    }
  }

  if (payload.action === 'fillNosposParkAgreementCategory') {
    return fillNosposParkAgreementCategoryImpl(payload);
  }

  if (payload.action === 'fillNosposParkAgreementRest') {
    return fillNosposParkAgreementRestImpl(payload);
  }

  // Park agreement: user edits a field in the progress modal → patch NosPos tab DOM.
  if (payload.action === 'patchNosposAgreementField') {
    const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
    if (!Number.isFinite(tabId) || tabId <= 0) {
      return { ok: false, error: 'Invalid tab' };
    }
    try {
      const r = await sendMessageToTabWithRetries(
        tabId,
        {
          type: 'NOSPOS_AGREEMENT_PATCH_FIELD',
          lineIndex: payload.lineIndex ?? 0,
          patchKind: payload.patchKind,
          fieldLabel: payload.fieldLabel ?? '',
          value: payload.value ?? '',
        },
        10,
        450
      );
      return r && typeof r === 'object' ? r : { ok: false, error: 'No response from NoSpos page' };
    } catch (e) {
      return { ok: false, error: e?.message || 'Could not update NoSpos' };
    }
  }

  // Legacy: category only (same pipeline; rest phase sends empty strings).
  if (payload.action === 'fillNosposAgreementFirstItemCategory') {
    const categoryId = String(payload.categoryId ?? '').trim();
    if (!categoryId) {
      return { ok: false, error: 'No category id' };
    }
    const r = await fillNosposAgreementFirstItemImpl({
      tabId: payload.tabId,
      categoryId,
      name: '',
      quantity: '',
      retailPrice: '',
      boughtFor: '',
      stockFields: [],
    });
    if (r?.ok) {
      return { ok: true, label: r.categoryLabel || r.label };
    }
    return r;
  }

  // Open nospos.com for customer intake – same flow as openNosposAndWait (waits for user to log in)
  // but does not navigate to /stock/search; user stays on nospos.com to look up customer data.
  if (payload.action === 'openNosposForCustomerIntake') {
    const url = 'https://nospos.com';
    const newTab = await chrome.tabs.create({ url });
    await putTabInYellowGroup(newTab.id);

    const pending = await getPending();
    pending[requestId] = { appTabId: appTabId || null, listingTabId: newTab.id, type: 'openNosposCustomerIntake' };
    await setPending(pending);

    console.log('[CG Suite] openNosposForCustomerIntake – waiting for user to land on nospos.com', { requestId, listingTabId: newTab.id });
    return { ok: true };
  }

  // Open nospos.com only: same session / forced-login checks as customer intake; after NOSPOS_PAGE_READY,
  // navigate to /stock/category (no /customers flow).
  if (payload.action === 'openNosposSiteOnly') {
    const url = 'https://nospos.com';
    const newTab = await chrome.tabs.create({ url });
    await putTabInYellowGroup(newTab.id);

    const pending = await getPending();
    pending[requestId] = { appTabId: appTabId || null, listingTabId: newTab.id, type: 'openNosposSiteOnly' };
    await setPending(pending);

    console.log('[CG Suite] openNosposSiteOnly – waiting for user to land on nospos.com', { requestId, listingTabId: newTab.id });
    return { ok: true };
  }

  if (payload.action === 'openNosposSiteForFields') {
    const url = 'https://nospos.com';
    const newTab = await chrome.tabs.create({ url });
    await putTabInYellowGroup(newTab.id);

    const pending = await getPending();
    pending[requestId] = {
      appTabId: appTabId || null,
      listingTabId: newTab.id,
      type: 'openNosposSiteForFields',
    };
    await setPending(pending);

    console.log('[CG Suite] openNosposSiteForFields – waiting for user to land on nospos.com', {
      requestId,
      listingTabId: newTab.id,
    });
    return { ok: true };
  }

  if (payload.action === 'openNosposSiteForCategoryFields') {
    const nosposCategoryId = Math.floor(Number(payload.nosposCategoryId));
    if (!Number.isFinite(nosposCategoryId) || nosposCategoryId <= 0) {
      return { ok: false, error: 'Invalid nosposCategoryId' };
    }
    const url = 'https://nospos.com';
    const newTab = await chrome.tabs.create({ url });
    await putTabInYellowGroup(newTab.id);

    const pending = await getPending();
    pending[requestId] = {
      appTabId: appTabId || null,
      listingTabId: newTab.id,
      type: 'openNosposSiteForCategoryFields',
      nosposCategoryId,
    };
    await setPending(pending);

    console.log('[CG Suite] openNosposSiteForCategoryFields – waiting for user to land on nospos.com', {
      requestId,
      listingTabId: newTab.id,
      nosposCategoryId,
    });
    return { ok: true };
  }

  if (payload.action === 'openNosposSiteForCategoryFieldsBulk') {
    const rawIds = Array.isArray(payload.nosposCategoryIds) ? payload.nosposCategoryIds : [];
    const nosposCategoryIds = [];
    const seen = new Set();
    for (const x of rawIds) {
      const n = Math.floor(Number(x));
      if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      nosposCategoryIds.push(n);
    }
    if (nosposCategoryIds.length === 0) {
      return { ok: false, error: 'nosposCategoryIds must be a non-empty array of positive integers' };
    }
    const url = 'https://nospos.com';
    const newTab = await chrome.tabs.create({ url });
    await putTabInYellowGroup(newTab.id);

    const pending = await getPending();
    pending[requestId] = {
      appTabId: appTabId || null,
      listingTabId: newTab.id,
      type: 'openNosposSiteForCategoryFieldsBulk',
      nosposCategoryIds,
    };
    await setPending(pending);

    console.log('[CG Suite] openNosposSiteForCategoryFieldsBulk – waiting for nospos.com', {
      requestId,
      listingTabId: newTab.id,
      count: nosposCategoryIds.length,
    });
    return { ok: true };
  }

  // Open a URL in a new tab (e.g. nospos.com for repricing flow)
  if (payload.action === 'openUrl') {
    const url = (payload.url || 'https://nospos.com').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { ok: false, error: 'Invalid URL' };
    }
    const newTab = await chrome.tabs.create({ url });
    await putTabInYellowGroup(newTab.id);
    return { ok: true };
  }

  // Negotiation Jewellery workspace (jewellery-scrap/* + tasks/jewellery-scrap-prices-tab.js).
  if (payload.action === CG_JEWELLERY_SCRAP.BRIDGE_OPEN_ACTION) {
    try {
      const result = await openJewelleryScrapPricesTab(appTabId);
      if (result?.tabId != null && appTabId != null) {
        await registerJewelleryScrapWorkerTab(result.tabId, appTabId);
        scheduleJewelleryScrapInject(result.tabId);
      }
    } catch (e) {
      console.warn('[CG Suite] openJewelleryScrapPrices failed:', e?.message);
    }
    return { ok: true };
  }

  // Open nospos.com and wait for the user to land on the main site (after login if needed).
  // Then navigate to /stock/search and fill the first barcode.
  if (payload.action === 'openNosposAndWait' && appTabId != null) {
    const url = 'https://nospos.com';
    await clearNosposRepricingState();
    await chrome.storage.local.remove('cgNosposLastRepricingResult');
    await clearRepricingStatus();
    const { tabId: nosposTabId } = await openBackgroundNosposTab(url, appTabId);

    const repricingData = payload.repricingData || [];
    const completedBarcodes = payload.completedBarcodes || {};
    const completedItems = payload.completedItems || [];
    const cartKey = payload.cartKey || '';

    const data = { repricingData, appTabId, completedBarcodes, completedItems, cartKey, nosposTabId };
    const pending = await getPending();
    pending[requestId] = { appTabId, listingTabId: nosposTabId, type: 'openNospos', repricingData };
    await setPending(pending);

    const stored = await chrome.storage.local.get('cgNosposRepricingProgress');
    const merged = stored.cgNosposRepricingProgress && stored.cgNosposRepricingProgress.cartKey === cartKey
      ? { ...data, completedBarcodes: { ...completedBarcodes, ...stored.cgNosposRepricingProgress.completedBarcodes }, completedItems: [...new Set([...completedItems, ...(stored.cgNosposRepricingProgress.completedItems || [])])] }
      : data;
    const initialData = {
      ...merged,
      queue: buildBarcodeQueue(repricingData, merged.completedBarcodes, merged.completedItems, {}),
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
      verifiedChanges: [],
      logs: [{
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Started repricing.'
      }],
      step: 'starting',
      message: 'Opening hidden NoSpos worker'
    };
    await chrome.storage.session.set({
      cgNosposRepricingData: initialData
    });
    await chrome.storage.local.set({ cgNosposRepricingProgress: { cartKey, completedBarcodes: merged.completedBarcodes, completedItems: merged.completedItems, appTabId } });
    await broadcastRepricingStatus(appTabId, initialData, {
      step: 'starting',
      message: 'Opening hidden NoSpos worker'
    });

    console.log('[CG Suite] openNosposAndWait – waiting for user to land on nospos.com', { requestId, listingTabId: nosposTabId });
    return { ok: true };
  }

  if (payload.action === 'getLastRepricingResult') {
    return { ok: true, payload: await getLastRepricingResult() };
  }

  if (payload.action === 'clearLastRepricingResult') {
    await clearLastRepricingResult();
    return { ok: true };
  }

  if (payload.action === 'getNosposRepricingStatus') {
    return { ok: true, payload: await getRepricingStatus() };
  }

  if (payload.action === 'cancelNosposRepricing') {
    const nosposData = (await chrome.storage.session.get('cgNosposRepricingData')).cgNosposRepricingData;
    const progress = (await chrome.storage.local.get('cgNosposRepricingProgress')).cgNosposRepricingProgress;
    const appTabId = nosposData?.appTabId ?? progress?.appTabId;
    const nosposTabId = nosposData?.nosposTabId;
    const cartKey = nosposData?.cartKey ?? progress?.cartKey ?? payload.cartKey ?? '';

    await clearNosposRepricingState(nosposTabId || 0);
    const cancelledStatus = {
      cartKey,
      running: false,
      done: false,
      cancelled: true,
      step: 'cancelled',
      message: 'Repricing was cancelled.',
      completedBarcodes: nosposData?.completedBarcodes ?? progress?.completedBarcodes ?? {},
      completedItems: nosposData?.completedItems ?? progress?.completedItems ?? [],
      logs: [...(nosposData?.logs || []), {
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Repricing was cancelled by the user.'
      }].slice(-200)
    };
    await setRepricingStatus(cancelledStatus);
    if (appTabId) {
      chrome.tabs.sendMessage(appTabId, {
        type: 'REPRICING_PROGRESS_TO_PAGE',
        payload: cancelledStatus
      }).catch(() => {});
    }
    if (nosposTabId) {
      chrome.tabs.remove(nosposTabId).catch(() => {});
    }
    return { ok: true };
  }

  if (payload.action === 'startRefine' && appTabId != null) {
    const listingPageUrl = payload.listingPageUrl;
    const competitor = payload.competitor === 'CashConverters' ? 'CashConverters' : 'eBay';
    const defaultUrl = competitor === 'CashConverters'
      ? 'https://www.cashconverters.co.uk/'
      : 'https://www.ebay.co.uk/';
    const urlToOpen = ensureEbayFilters(listingPageUrl) || defaultUrl;
    const marketComparisonContext = payload.marketComparisonContext || null;

    const tabs = await chrome.tabs.query({});
    const existingTab = listingPageUrl ? tabs.find(t => t.url === listingPageUrl) : null;

    let listingTabId;
    if (existingTab) {
      listingTabId = existingTab.id;
      await chrome.tabs.update(existingTab.id, { active: true }).catch(() => {});
      if (existingTab.windowId) await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
      await putTabInYellowGroup(existingTab.id);
    } else {
      const newTab = await chrome.tabs.create({ url: urlToOpen });
      await putTabInYellowGroup(newTab.id);
      await chrome.tabs.update(newTab.id, { active: true }).catch(() => {});
      listingTabId = newTab.id;
    }

    const pending = await getPending();
    pending[requestId] = { appTabId, listingTabId, competitor, marketComparisonContext };
    await setPending(pending);

    await sendWaitingForData(listingTabId, requestId, marketComparisonContext, 5, true);

    return { ok: true };
  }

  return { ok: false };
}

/**
 * Send WAITING_FOR_DATA to the content script so it shows "Have you got the data yet?" (or "Are you done?" for refine).
 * Retries a few times with delay in case the content script was injected after we received LISTING_PAGE_READY.
 */
async function sendWaitingForData(tabId, requestId, marketComparisonContext, retriesLeft, isRefine) {
  const payload = {
    type: 'WAITING_FOR_DATA',
    requestId: requestId,
    marketComparisonContext: marketComparisonContext || null,
    isRefine: !!isRefine
  };
  try {
    await chrome.tabs.sendMessage(tabId, payload);
    console.log('[CG Suite] WAITING_FOR_DATA sent to tab', tabId);
    return true;
  } catch (err) {
    if (retriesLeft > 0) {
      console.log('[CG Suite] WAITING_FOR_DATA send failed, retrying in 300ms, retriesLeft=', retriesLeft, err?.message);
      await new Promise(r => setTimeout(r, 300));
      return sendWaitingForData(tabId, requestId, marketComparisonContext, retriesLeft - 1, isRefine);
    }
    console.warn('[CG Suite] WAITING_FOR_DATA send failed after retries', err?.message);
    return false;
  }
}

async function handleListingPageReady(message, sender) {
  const tabId = sender.tab?.id;
  const tabUrl = (sender.tab?.url || '').toLowerCase();

  console.log('[CG Suite] LISTING_PAGE_READY received from tab', tabId, 'url=', tabUrl, 'explicitRequestId=', message?.requestId);

  const pending = await getPending();
  const entries = Object.entries(pending);

  let matchedId = null;
  let matchedEntry = null;

  // 1. If the content script provided an explicit requestId (CeX: from cgReq in URL / sessionStorage),
  //    only accept it if this tab is already the one we opened for that request (no re-association to other tabs).
  const explicitRequestId = message && message.requestId;
  if (explicitRequestId && pending[explicitRequestId] && pending[explicitRequestId].listingTabId === tabId) {
    matchedId = explicitRequestId;
    matchedEntry = pending[explicitRequestId];
    console.log('[CG Suite] LISTING_PAGE_READY matched by explicit requestId (same tab)', { explicitRequestId, tabId });
  }

  // 2. Otherwise match by tab: only the tab we opened (listingTabId) can complete this flow.
  if (!matchedEntry) {
    for (const [rid, entry] of entries) {
      if (entry.listingTabId === tabId) {
        matchedId = rid;
        matchedEntry = entry;
        console.log('[CG Suite] LISTING_PAGE_READY matched by listingTabId', { matchedId, tabId });
        break;
      }
    }
  }

  // Do NOT re-associate to a different tab: user must use the single tab we opened. Other CeX tabs are ignored.

  if (matchedEntry) {
    if (matchedEntry.type === 'cexNavScrape') {
      console.log('[CG Suite] LISTING_PAGE_READY ignored for cexNavScrape flow', { matchedId, tabId });
      return;
    }
    console.log('[CG Suite] LISTING_PAGE_READY matched', { matchedId, tabId, competitor: matchedEntry.competitor });
    await sendWaitingForData(tabId, matchedId, matchedEntry.marketComparisonContext || null, 5);
  } else {
    console.log('[CG Suite] LISTING_PAGE_READY – no matching pending request for tab', tabId, 'pending keys:', Object.keys(pending));
  }
}

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

async function handleNosposCustomerDetailReady(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };

  const pending = await getPending();
  for (const [requestId, entry] of Object.entries(pending)) {
    if (entry.listingTabId === tabId && entry.type === 'openNosposCustomerIntakeWaiting') {
      console.log('[CG Suite] NOSPOS_CUSTOMER_DETAIL_READY – user on customer detail page, returning requestId', { requestId });
      return { ok: true, requestId };
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

function findNextBarcode(repricingData, completedBarcodes, completedItems, skippedBarcodes = {}) {
  for (let i = 0; i < repricingData.length; i++) {
    const item = repricingData[i];
    if (completedItems.includes(item?.itemId)) continue;
    const done = completedBarcodes[item?.itemId] || [];
    const skipped = skippedBarcodes[item?.itemId] || [];
    for (let j = 0; j < (item?.barcodes?.length || 0); j++) {
      if (done.includes(j) || skipped.includes(j)) continue;
      const barcode = (item.barcodes[j] || '').trim();
      if (barcode) return { itemIndex: i, barcodeIndex: j, barcode };
    }
  }
  return null;
}

function applyVerifiedBarcodeCompletion(data) {
  const pendingCompletion = data?.pendingCompletion;
  if (!pendingCompletion?.itemId || pendingCompletion?.barcodeIndex == null) {
    return null;
  }

  const completedBarcodes = { ...(data.completedBarcodes || {}) };
  const completedItems = [...(data.completedItems || [])];
  const itemId = pendingCompletion.itemId;
  const barcodeIndex = pendingCompletion.barcodeIndex;

  if (!completedBarcodes[itemId]) completedBarcodes[itemId] = [];
  if (!completedBarcodes[itemId].includes(barcodeIndex)) {
    completedBarcodes[itemId] = [...completedBarcodes[itemId], barcodeIndex];
  }

  const item = (data.repricingData || []).find((entry) => entry?.itemId === itemId);
  const itemBarcodeCount = item?.barcodes?.length || 0;
  if (itemBarcodeCount > 0 && completedBarcodes[itemId].length >= itemBarcodeCount && !completedItems.includes(itemId)) {
    completedItems.push(itemId);
  }

  const verifiedChanges = [...(data.verifiedChanges || [])];
  if (item) {
    verifiedChanges.push({
      item_identifier: item.itemId != null ? String(item.itemId) : '',
      title: item.title || '',
      quantity: item.quantity || 1,
      barcode: pendingCompletion.barcode || '',
      stock_barcode: pendingCompletion.stockBarcode || '',
      stock_url: pendingCompletion.stockUrl || '',
      old_retail_price: pendingCompletion.oldRetailPrice || null,
      new_retail_price: item.salePrice != null ? String(item.salePrice) : null,
      cex_sell_at_repricing: item.cexSellAtRepricing != null ? String(item.cexSellAtRepricing) : null,
      our_sale_price_at_repricing: item.ourSalePriceAtRepricing != null ? String(item.ourSalePriceAtRepricing) : null,
      raw_data: item.raw_data || {},
      cash_converters_data: item.cash_converters_data || {}
    });
  }

  return { completedBarcodes, completedItems, verifiedChanges };
}

function markBarcodeAsAmbiguous(data, next) {
  if (!data || !next) return data;

  const item = (data.repricingData || [])[next.itemIndex];
  const itemId = item?.itemId;
  if (itemId == null) return data;

  const skippedBarcodes = { ...(data.skippedBarcodes || {}) };
  if (!skippedBarcodes[itemId]) skippedBarcodes[itemId] = [];
  if (!skippedBarcodes[itemId].includes(next.barcodeIndex)) {
    skippedBarcodes[itemId] = [...skippedBarcodes[itemId], next.barcodeIndex];
  }

  const ambiguousBarcodes = [...(data.ambiguousBarcodes || [])];
  const alreadyTracked = ambiguousBarcodes.some(
    (entry) => String(entry?.itemId) === String(itemId) && entry?.barcodeIndex === next.barcodeIndex
  );

  if (!alreadyTracked) {
    ambiguousBarcodes.push({
      itemId,
      itemTitle: item?.title || '',
      barcodeIndex: next.barcodeIndex,
      barcode: next.barcode
    });
  }

  return {
    ...data,
    skippedBarcodes,
    ambiguousBarcodes,
    awaitingStockSelection: false,
    currentBarcode: '',
    verifyRetries: 0
  };
}

function buildRepricingCompletionPayload(data) {
  const verifiedChanges = [...(data?.verifiedChanges || [])];
  const ambiguousBarcodes = [...(data?.ambiguousBarcodes || [])];
  const unverifiedBarcodes = [...(data?.unverifiedBarcodes || [])];

  return {
    cart_key: data?.cartKey || '',
    item_count: [...new Set(verifiedChanges.map((item) => item.item_identifier).filter(Boolean))].length,
    barcode_count: verifiedChanges.length,
    items_data: verifiedChanges,
    ambiguous_barcodes: ambiguousBarcodes,
    unverified_barcodes: unverifiedBarcodes
  };
}

async function finalizeNosposRepricing(data, tabId) {
  const completedData = appendRepricingLog(
    { ...data, done: true, step: 'completed', message: 'Repricing completed.' },
    'Repricing completed.',
    'success'
  );
  const finalPayload = buildRepricingCompletionPayload(data);
  if (finalPayload.barcode_count > 0 || finalPayload.ambiguous_barcodes.length > 0) {
    await setLastRepricingResult(finalPayload);
    await sendRepricingComplete(data?.appTabId, finalPayload);
  }
  await setRepricingStatus(buildRepricingStatusPayload(completedData, {
    step: 'completed',
    message: 'Repricing completed.'
  }));
  await clearNosposRepricingState(tabId);
  await focusAppTab(data?.appTabId);
  if (tabId != null) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  return finalPayload;
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
    `Doing barcode ${next.barcode}.`
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

  // Always set justSaved and wait for page reload + verification before proceeding.
  // Do NOT focus app tab here - wait until after verify + navigate to search, then focus when done.
  const updatedData = appendRepricingLog({
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
      oldRetailPrice: message.oldRetailPrice || '',
      stockBarcode: message.stockBarcode || '',
      stockUrl: sender.tab?.url || ''
    }
  }, `Saving barcode ${next.barcode}.`);
  await chrome.storage.session.set({ cgNosposRepricingData: updatedData });
  await broadcastRepricingStatus(appTabId, updatedData, {
    step: 'saving',
    message: `Saving retail price for ${next.barcode}…`,
    currentBarcode: next.barcode,
    currentItemId: item?.itemId || '',
    currentItemTitle: item?.title || ''
  });

  return { ok: true, salePrice, done: false };
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
        if (tabId) await chrome.tabs.update(tabId, { url: 'https://nospos.com/stock/search' });
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
        const pendingCompletion = data.pendingCompletion || {};
        const unverifiedItem = (data.repricingData || []).find(entry => String(entry?.itemId) === String(pendingCompletion.itemId));
        const unverifiedBarcodes = [...(data.unverifiedBarcodes || [])];
        const alreadyTracked = unverifiedBarcodes.some(
          e => String(e?.itemId) === String(pendingCompletion.itemId) && e?.barcodeIndex === pendingCompletion.barcodeIndex
        );
        if (!alreadyTracked && pendingCompletion.itemId != null) {
          unverifiedBarcodes.push({
            itemId: pendingCompletion.itemId,
            itemTitle: unverifiedItem?.title || '',
            barcodeIndex: pendingCompletion.barcodeIndex,
            barcode: pendingCompletion.barcode || '',
            stockBarcode: pendingCompletion.stockBarcode || stockBarcode || '',
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
          if (tabId) await chrome.tabs.update(tabId, { url: 'https://nospos.com/stock/search' });
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

async function handleScrapedData(message) {
  const { requestId, data } = message;

  const pending = await getPending();
  const entry = pending[requestId];

  if (entry?.appTabId != null) {
    const listingTabId = entry.listingTabId;
    delete pending[requestId];
    await setPending(pending);

    const appTab = await chrome.tabs.get(entry.appTabId).catch(() => null);
    await chrome.tabs.update(entry.appTabId, { active: true }).catch(() => {});
    if (appTab?.windowId) await chrome.windows.update(appTab.windowId, { focused: true }).catch(() => {});

    await chrome.tabs.sendMessage(entry.appTabId, {
      type: 'EXTENSION_RESPONSE_TO_PAGE',
      requestId,
      response: data
    });

    // Close the listing tab (eBay, Cash Converters, or CeX) after data was sent to the app.
    // Never close openNospos tabs – user needs them to log in.
    if (listingTabId != null && entry.type !== 'openNospos') {
      await chrome.tabs.remove(listingTabId).catch(() => {});
    }
    return { ok: true };
  }

  return { ok: false };
}

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
