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
    let pollTimer = null;
    let graceTimer = null;
    const finish = (why) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (pollTimer) clearInterval(pollTimer);
      if (graceTimer) clearTimeout(graceTimer);
      console.log('[CG Suite] NosPos agreement fill: reload wait done —', reasonTag, '—', why);
      resolve();
    };
    const listener = (tid, change, tab) => {
      if (tid !== tabId || done) return;
      if (change.status === 'loading') sawLoading = true;
      if (
        sawLoading &&
        change.status === 'complete' &&
        isNosposAgreementItemsUrl(tab?.url || '')
      ) {
        finish('reload complete (event)');
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Early bail: if no navigation has STARTED within the grace window, NosPos updated in
    // place — there's nothing to wait for, so don't sit on the full cap.
    graceTimer = setTimeout(() => {
      if (!done && !sawLoading) finish('no reload started (in-place update)');
    }, NOSPOS_NO_RELOAD_GRACE_MS);
    // Safety poll on the LIVE tab state. The 'complete' event can be missed, or arrive with a
    // URL the matcher rejects (e.g. a redirect hop), which would otherwise pin sawLoading=true
    // and leave us sitting on the full cap even though the page has already settled. Polling the
    // real tab status ends the wait the instant the reload is genuinely done.
    pollTimer = setInterval(() => {
      if (done) return;
      chrome.tabs
        .get(tabId)
        .then((t) => {
          if (done || !t) return;
          if (t.status === 'loading') sawLoading = true;
          if (sawLoading && t.status === 'complete' && isNosposAgreementItemsUrl(t.url || '')) {
            finish('reload complete (poll)');
          }
        })
        .catch(() => {});
    }, 150);
    // Hard cap for a genuine but slow reload.
    setTimeout(() => finish('max wait reached'), maxWaitMs);
  });
  await sleep(150);
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

  // Wait for the reload the category change may trigger — early-bails fast when NosPos updated
  // in place (no reload), so we don't sit on the full cap.
  await waitForAgreementItemsPageReload(tabId, 'after category', NOSPOS_RELOAD_WAIT_MS);
  // Give the just-rendered form a beat, then fill. The rest phase retries on its own if the
  // DOM isn't quite ready, so we don't need a long probe loop here.
  await sleep(NOSPOS_POST_CATEGORY_FILL_DELAY_MS);

  const start = Date.now();
  const maxTotalMs = 8000; // safety probe window only; usually ready on the first probe
  let lastProbe = null;
  while (Date.now() - start < maxTotalMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) {
      return { ok: false, error: 'The NoSpos tab was closed', probe: lastProbe };
    }
    if (!isNosposAgreementItemsUrl(t.url || '') || t.status !== 'complete') {
      await sleep(300);
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
    }
    if (lastProbe?.ready) {
      return { ok: true, probe: lastProbe };
    }
    await sleep(400);
  }
  // Probe never confirmed ready — don't fail here; the rest phase retries and will surface a
  // real error if the form truly isn't there. Returning ok keeps the flow moving.
  return { ok: true, probe: lastProbe, probeTimedOut: true };
}

/**
 * Read NosPos items-page pager state (Yii2 LinkPager). NosPos paginates an agreement's
 * items at 20 per page; each page only renders its own rows, so {@link countNosposAgreementItemLines}
 * is page-local. `{ hasPager, currentPage, lastPage, count }`.
 */
async function readNosposAgreementPager(tabId) {
  try {
    const r = await sendParkMessageToTabWithAbort(
      tabId,
      { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'read_pager' },
      8,
      350
    );
    if (r && r.ok) {
      return {
        ok: true,
        hasPager: r.hasPager === true,
        currentPage: Math.max(1, parseInt(String(r.currentPage ?? '1'), 10) || 1),
        lastPage: Math.max(1, parseInt(String(r.lastPage ?? '1'), 10) || 1),
        count: Math.max(0, parseInt(String(r.count ?? '0'), 10) || 0),
      };
    }
  } catch (_) {
    /* fall through */
  }
  return { ok: false, hasPager: false, currentPage: 1, lastPage: 1, count: 0 };
}

/** Wait until the items page is fully loaded again (used after a pager navigation). */
async function waitForAgreementItemsPageSettled(tabId, maxWaitMs = NOSPOS_RELOAD_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return { ok: false, error: 'The NoSpos tab was closed' };
    if (isNosposAgreementItemsUrl(t.url || '') && t.status === 'complete') {
      await sleep(400);
      return { ok: true };
    }
    await sleep(300);
  }
  return { ok: true, timedOut: true };
}

/** Navigate the items page to a 1-based page number and wait for it to settle. */
async function navigateNosposAgreementToPage(tabId, pageNum) {
  const r = await sendParkMessageToTabWithAbort(
    tabId,
    { type: 'NOSPOS_AGREEMENT_FILL_PHASE', phase: 'nav_to_page', pageNum },
    8,
    350
  );
  if (!r?.ok) {
    return { ok: false, error: r?.error || 'Could not navigate NoSpos items pager' };
  }
  if (r.navigated) {
    await waitForAgreementItemsPageReload(tabId, `pager → page ${pageNum}`, NOSPOS_RELOAD_WAIT_MS);
    const settled = await waitForAgreementItemsPageSettled(tabId);
    if (!settled.ok) return settled;
  }
  return { ok: true };
}

/**
 * Move to the last items page and return its page-local row count. Used after a category
 * reload to re-find the row just added (always the newest → last row on the last page).
 * No-op on single-page agreements. `{ ok, lastPage, count }`.
 */
async function gotoLastNosposAgreementPage(tabId) {
  const info = await readNosposAgreementPager(tabId);
  if (info.ok && info.hasPager && info.lastPage > info.currentPage) {
    const nav = await navigateNosposAgreementToPage(tabId, info.lastPage);
    if (!nav.ok) return { ok: false, error: nav.error };
  }
  const after = await readNosposAgreementPager(tabId);
  const count = await countNosposAgreementItemLines(tabId);
  return { ok: true, lastPage: after.ok ? after.lastPage : (info.lastPage || 1), count };
}

/** The page that holds the 0-based global row `idx` (1-based), and its index within that page. */
function nosposPageForGlobalRow(idx) {
  const g = Math.max(0, parseInt(String(idx), 10) || 0);
  return {
    page: Math.floor(g / NOSPOS_ITEMS_PER_PAGE) + 1,
    indexInPage: g % NOSPOS_ITEMS_PER_PAGE,
  };
}

/**
 * Position the tab on the page that holds 0-based GLOBAL row `g` (page = floor(g/20)+1) and
 * report the page-local slot for it. NosPos renders only the current page's 20 rows, so every
 * fill/count/find is page-local — this is how the park flow keeps items 21+ (page 2+) reachable
 * without losing sight of page 1. Leaves the tab on the target page when that page exists.
 * `{ ok, page, indexInPage, lastPage, count, pageExists }`.
 */
async function ensureNosposOnPageForGlobalRow(tabId, g) {
  const { page, indexInPage } = nosposPageForGlobalRow(g);
  const pager = await readNosposAgreementPager(tabId);
  const lastPage = pager.ok ? pager.lastPage : 1;
  const pageExists = page <= lastPage;
  if (pageExists) {
    const nav = await navigateNosposAgreementToPage(tabId, page);
    if (!nav.ok) return { ok: false, error: nav.error, page, indexInPage };
  }
  const count = await countNosposAgreementItemLines(tabId);
  return { ok: true, page, indexInPage, lastPage, count, pageExists };
}

/**
 * Find a CG line marker across ALL agreement pages. A single-page scan (runFindLineMarker only
 * sees the rendered page) misses rows once the agreement spills onto page 2+, which is what
 * makes re-runs/retries add duplicates or fill the wrong row. Walks every page (current page
 * first to avoid a needless nav), and LEAVES the tab on the page where the marker was found so
 * the returned page-local index is valid for the current view. `{ page, indexInPage } | null`.
 */
async function findNosposLineAcrossPages(tabId, marker) {
  const m = String(marker || '').trim();
  if (!m) return null;
  const pager = await readNosposAgreementPager(tabId);
  const lastPage = pager.ok ? pager.lastPage : 1;
  const startPage = pager.ok ? pager.currentPage : 1;
  const order = [startPage];
  for (let p = 1; p <= lastPage; p += 1) {
    if (p !== startPage) order.push(p);
  }
  for (const p of order) {
    const nav = await navigateNosposAgreementToPage(tabId, p);
    if (!nav.ok) continue;
    const idx = await findNosposLineIndexForMarkerWithFallback(tabId, m);
    if (idx != null && idx >= 0) {
      logPark('findNosposLineAcrossPages', 'result', { marker: m, page: p, indexInPage: idx }, `Marker found on page ${p}, slot ${idx}`);
      return { page: p, indexInPage: idx };
    }
  }
  logPark('findNosposLineAcrossPages', 'result', { marker: m, lastPage }, 'Marker not found on any page');
  return null;
}

/**
 * Add a new agreement row and return the page-local index to fill, leaving the tab on the page
 * that holds it.
 *
 * We do NOT force page 1 or compute the page from the URL. After Add, NosPos redirects to a
 * noisy URL (e.g. `?items-page=25#agreement-item-...` — that number is the item id/ordinal, NOT
 * a real page) and keeps the view on the page that now holds the new row. The new row is always
 * the LAST row on the LAST page, so we reach the real last page via {@link gotoLastNosposAgreementPage}
 * (which CLICKS the pager's own DOM links and thus corrects the bad URL) and target its last row.
 *
 * `globalTargetIndex` (0-based sequential add order) is used only to sanity-check the row landed
 * roughly where expected before filling.
 *
 * @returns {{ ok: true, targetLineIndex: number, page: number } | { ok: false, error: string }}
 */
async function addNosposAgreementItemAndResolveRow(tabId, globalTargetIndex) {
  const { page: expectedPage, indexInPage: expectedIndexInPage } =
    nosposPageForGlobalRow(globalTargetIndex);

  // Re-click Add ONLY when we have PROOF no row was created (a detected 429, or a recovery reload
  // that confirms the count didn't change). Re-clicking on a merely slow render would duplicate.
  for (let attempt = 0; attempt < NOSPOS_ADD_MAX_ATTEMPTS; attempt += 1) {
    const clickR = await clickNosposAgreementAddItem(tabId);
    if (!clickR?.ok) {
      return { ok: false, error: clickR?.error || 'Could not click Add on NoSpos' };
    }
    await waitForAgreementItemsPageReload(tabId, 'after Add', NOSPOS_ADD_ROW_WAIT_MS);

    let rateLimited = false;
    // Wait generously for the row: once NosPos is throttling, a *successful* Add's reload can
    // run well past a normal one. Failing early here (and telling the operator to Retry) was the
    // worse outcome — the row was usually just slow, not missing.
    const deadline = Date.now() + NOSPOS_ADD_ROW_WAIT_MS;
    while (Date.now() < deadline) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) return { ok: false, error: 'The NoSpos tab was closed' };
      if (t.status !== 'complete') { await sleep(300); continue; }
      // 429 "Too Many Requests"? recover (pause + reload) and re-Add — the row never got created.
      // Force the probe (bypass the cache): this long wait is exactly when a 429 can surface.
      const rec = await maybeRecoverNospos429Page(tabId, 'addNosposAgreementItemAndResolveRow', true);
      if (rec?.recovered) { rateLimited = true; break; }
      if (!isNosposAgreementItemsUrl(t.url || '')) { await sleep(300); continue; }

      // The new row belongs on a deterministic page+slot (page = floor(g/20)+1, slot = g%20).
      // Navigate straight there via the pager rather than trusting the noisy post-Add URL
      // (e.g. `items-page=25#agreement-item-…`, where 25 is an item ordinal, not a page) or a
      // "last page" guess. navigateNosposAgreementToPage clicks the real pager link (or falls
      // back to ?items-page=N), so it lands on the actual page even from the noisy URL.
      const navp = await navigateNosposAgreementToPage(tabId, expectedPage);
      if (navp.ok) {
        const count = await countNosposAgreementItemLines(tabId);
        if (count >= expectedIndexInPage + 1) {
          // Clean Add — let the adaptive pacing decay back toward zero.
          if (attempt === 0 && nosposAddCooldownMs > 0) {
            nosposAddCooldownMs = Math.max(0, nosposAddCooldownMs - NOSPOS_ADD_COOLDOWN_STEP_MS);
          }
          logPark(
            'addNosposAgreementItemAndResolveRow',
            'exit',
            { globalTargetIndex, expectedPage, expectedIndexInPage, count, attempt, adaptiveCooldownMs: nosposAddCooldownMs },
            'New row resolved after Add (deterministic page + slot)'
          );
          return { ok: true, targetLineIndex: expectedIndexInPage, page: expectedPage };
        }
      }
      await sleep(500);
    }

    if (rateLimited) {
      // A 429 was hit (POST rejected, no row created) — pause, then retry the Add.
      logPark('addNosposAgreementItemAndResolveRow', 'step', { attempt }, 'Rate-limited on Add (429) — recovered, re-adding');
      await sleep(NOSPOS_RATELIMIT_RETRY_BACKOFF_MIN_MS);
      continue;
    }

    // No 429 page, but the row never rendered within the cap. Reload (a GET — no duplicate risk)
    // and re-check: the Add POST may have landed while the render stalled, or it may have been
    // dropped by NosPos's throttle.
    const recovered = await recoverAddedRowViaReload(tabId, expectedPage, expectedIndexInPage);
    if (recovered.ok) return recovered;

    if (recovered.droppedConfirmed && attempt < NOSPOS_ADD_MAX_ATTEMPTS - 1) {
      // PROVEN dropped (count unchanged after reload) → safe to re-Add. Grow the adaptive pacing
      // so the rest of the run stops tripping the throttle, cool down to let it reset, then retry.
      nosposAddCooldownMs = Math.min(
        NOSPOS_ADD_COOLDOWN_MAX_MS,
        nosposAddCooldownMs + NOSPOS_ADD_COOLDOWN_STEP_MS
      );
      logPark(
        'addNosposAgreementItemAndResolveRow',
        'step',
        { attempt, cooldownMs: NOSPOS_ADD_DROP_COOLDOWN_MS, nextAdaptiveCooldownMs: nosposAddCooldownMs },
        'Add was dropped (NosPos throttling) — cooling down, then retrying the Add'
      );
      await sleep(NOSPOS_ADD_DROP_COOLDOWN_MS);
      continue;
    }
    break;
  }

  return {
    ok: false,
    error:
      'NoSpos did not show a new item row after Add (it may be rate-limiting). Wait a moment and use Retry on that line, or check the NoSpos tab.',
  };
}

/**
 * Re-fetch the items page as a fresh GET (NOT chrome.tabs.reload). The items page is rendered from
 * the Add POST, so a plain reload makes Chrome show the "Confirm Form Resubmission" interstitial —
 * which wedges automation and, if the operator clicks Continue, RE-SENDS the Add (duplicate row).
 * Navigating to the path with the POST query/hash stripped forces a brand-new GET navigation entry,
 * so there's nothing to resubmit. Returns { ok } and leaves the tab loading the items page.
 */
async function refetchNosposItemsViaGet(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return { ok: false, error: 'The NoSpos tab was closed' };
  let target = null;
  try {
    const u = new URL(t.url || '');
    target = u.origin + u.pathname; // drop ?query and #hash → forces a GET, not a POST resubmit
  } catch (_) {}
  if (target && target !== (t.url || '')) {
    await chrome.tabs.update(tabId, { url: target }).catch(() => {});
  } else {
    // URL already had no query/hash (or was unparseable) — a normal reload is a GET here.
    await chrome.tabs.reload(tabId).catch(() => {});
  }
  return { ok: true };
}

/**
 * Add-timeout safety net. When the new row didn't render within the wait cap and no 429 page was
 * seen, the Add POST may still have succeeded server-side (throttled/stalled render). Under NosPos'
 * throttle (which bites around items ~10-12) the row can persist/render noticeably AFTER our first
 * reload, so a single re-check used to falsely declare it "dropped" — and the operator could plainly
 * see the row sitting on the tab. We now RE-FETCH (fresh GET) and recount up to
 * NOSPOS_ADD_ROW_RECOVERY_RECHECKS times, with growing backoff, before giving up. Every re-fetch is
 * a GET (path only, query/hash stripped), so it never resubmits the Add — the rechecks themselves
 * can't create a duplicate, which is what makes patient retrying safe here. Returns the same shape
 * as the Add resolver.
 */
async function recoverAddedRowViaReload(tabId, expectedPage, expectedIndexInPage) {
  logPark('recoverAddedRowViaReload', 'enter', { tabId, expectedPage, expectedIndexInPage, maxRechecks: NOSPOS_ADD_ROW_RECOVERY_RECHECKS }, 'Add row not seen in time — re-fetching (GET) and re-checking patiently before failing');
  let lastCount = -1;
  for (let recheck = 0; recheck < NOSPOS_ADD_ROW_RECOVERY_RECHECKS; recheck += 1) {
    // Growing backoff: each pass gives NosPos' throttle more time to settle and persist/render the
    // row before we look again (1.5s, 3s, 4.5s, …). The first pass keeps the original short pause.
    await sleep(NOSPOS_RATELIMIT_RETRY_BACKOFF_MIN_MS * (recheck + 1));
    const reget = await refetchNosposItemsViaGet(tabId);
    if (!reget.ok) return { ok: false, error: reget.error };
    const done = await waitForNosposTabComplete(tabId, NOSPOS_ADD_ROW_WAIT_MS);
    if (!done.ok) return { ok: false, error: done.error };
    // A 429 may have surfaced on the reload — recover it (forced probe) before counting.
    const rec = await maybeRecoverNospos429Page(tabId, 'recoverAddedRowViaReload', true);
    if (rec?.recovered) {
      const done2 = await waitForNosposTabComplete(tabId, NOSPOS_ADD_ROW_WAIT_MS);
      if (!done2.ok) return { ok: false, error: done2.error };
    }
    const navp = await navigateNosposAgreementToPage(tabId, expectedPage);
    if (!navp.ok) return { ok: false, error: navp.error };
    const count = await countNosposAgreementItemLines(tabId);
    lastCount = count;
    if (count >= expectedIndexInPage + 1) {
      logPark('recoverAddedRowViaReload', 'exit', { expectedPage, expectedIndexInPage, count, recheck }, `Row present after re-read #${recheck + 1} — Add had succeeded, render/persist had stalled`);
      return { ok: true, targetLineIndex: expectedIndexInPage, page: expectedPage };
    }
    logPark('recoverAddedRowViaReload', 'step', { expectedPage, expectedIndexInPage, count, recheck }, `Row still absent after re-read #${recheck + 1} — will retry`);
  }
  // After every patient re-read the pre-Add row set is still intact (count never reached the new
  // slot), so the Add was genuinely dropped — re-adding cannot duplicate. (A count BELOW the
  // expected slot would be an unexpected state, so don't treat that as safe-to-retry.)
  const droppedConfirmed = lastCount === expectedIndexInPage;
  logPark('recoverAddedRowViaReload', 'result', { expectedPage, expectedIndexInPage, count: lastCount, droppedConfirmed, rechecks: NOSPOS_ADD_ROW_RECOVERY_RECHECKS }, 'Row still absent after all re-reads — Add did not create it');
  return { ok: false, droppedConfirmed, count: lastCount, error: 'row not present after recovery reloads' };
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
