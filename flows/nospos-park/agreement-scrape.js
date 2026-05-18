/**
 * NosPos park-agreement scrape & line lookup primitives: page-reload waits, line count,
 * line-by-marker lookup (with fallback), line snapshot, excluded-line deletion.
 */

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
      lastProbe = await sendParkMessageToTabWithAbort(
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
    const r = await sendParkMessageToTabWithAbort(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'count_lines' },
      10,
      400
    );
    const count = typeof r?.count === 'number' ? r.count : 0;
    logPark('countNosposAgreementItemLines', 'result', { tabId, count }, `Line count: ${count}`);
    return count;
  } catch (_) {
    logPark('countNosposAgreementItemLines', 'error', { tabId }, 'count_lines message failed');
    return 0;
  }
}

/** 0-based line index whose item description contains the marker, or null if not found. */
async function findNosposLineIndexForMarker(tabId, marker) {
  const m = String(marker || '').trim();
  if (!m) return null;
  try {
    const r = await sendParkMessageToTabWithAbort(
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
  logPark('findNosposLineIndexForMarkerWithFallback', 'enter', { tabId, marker }, 'Searching NoSpos rows by description marker');
  const riNeedle = findMarkerSearchNeedleForPark(marker);
  if (riNeedle && riNeedle !== String(marker || '').trim()) {
    const byRi = await findNosposLineIndexForMarker(tabId, riNeedle);
    if (byRi != null && byRi >= 0) {
      logPark('findNosposLineIndexForMarkerWithFallback', 'result', { marker, riNeedle, lineIndex: byRi }, 'Matched by RI needle in description');
      console.log('[CG Suite] NosPos park: matched by request-item needle in description', { marker, riNeedle, lineIndex: byRi });
      return byRi;
    }
  }
  const exact = await findNosposLineIndexForMarker(tabId, marker);
  if (exact != null && exact >= 0) {
    logPark('findNosposLineIndexForMarkerWithFallback', 'result', { marker, lineIndex: exact }, 'Matched by full marker substring');
    console.log('[CG Suite] NosPos park: matched by full marker substring', { marker, lineIndex: exact });
    return exact;
  }
  logPark('findNosposLineIndexForMarkerWithFallback', 'result', { marker, riNeedle, lineIndex: null }, 'No row found by description marker');
  console.log('[CG Suite] NosPos park: no row found by description marker', { marker, riNeedle, lineIndex: null });
  return null;
}

async function readNosposAgreementLineSnapshot(tabId, lineIndex) {
  const lineIdx = Math.max(0, parseInt(String(lineIndex ?? '0'), 10) || 0);
  try {
    return await sendParkMessageToTabWithAbort(
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
  const delDead = await failIfNosposParkTabClosedOrMissing(tabId);
  if (delDead) return { ...delDead, deleted: [] };
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
      const r = await sendParkMessageToTabWithAbort(
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
  logPark('waitAfterAgreementItemsNextClick', 'enter', { tabId, maxWaitMs }, 'Waiting for NoSpos to leave items step after Next click');
  const deadline = Date.now() + maxWaitMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      logPark('waitAfterAgreementItemsNextClick', 'error', { tabId }, 'Tab closed while waiting for Next navigation');
      return { ok: false, error: 'The NoSpos tab was closed' };
    }
    const url = tab.url || '';
    const leftItems = tab.status === 'complete' && isNosposNewAgreementWorkflowUrl(url) && !isNosposAgreementItemsUrl(url);
    if (pollCount % 8 === 0) {
      logPark('waitAfterAgreementItemsNextClick', 'step', { pollCount, tabStatus: tab.status, url, leftItems }, 'Polling for post-Next navigation');
    }
    if (leftItems) {
      await sleep(500);
      logPark('waitAfterAgreementItemsNextClick', 'exit', { url, pollCount }, 'Successfully left items step');
      return { ok: true };
    }
    pollCount++;
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
