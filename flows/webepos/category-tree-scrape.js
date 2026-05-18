/**
 * Orchestrator for the Web EPOS category-tree scrape.
 *
 * Current behaviour: single-path deep probe. The walker descends into the
 * FIRST option at every level and logs every sibling along the way, so we can
 * verify the React-driven cascade works end-to-end before layering on a full
 * combinatorial tree walk.
 *
 *   1. Open `/products/new` in a new unfocused tab in the app's window.
 *   2. Wait for load + login guard.
 *   3. Inject `bg/webepos-category-tree-walk-page.js`.
 *   4. Call START (synchronous — returns immediately; walk runs on window).
 *   5. Poll READ every ~750ms until `done` is true, then pull result + log.
 *   6. Close the tab and post the result to the app tab.
 *
 * Start+poll rather than `executeScript({ func: async … })` because the MV3
 * service-worker boundary does not reliably await the returned Promise when
 * injected into `world: 'MAIN'`. Plain-object reads are fine.
 */

const WEB_EPOS_CATEGORY_WALK_POLL_MS = 1000;
const WEB_EPOS_CATEGORY_WALK_MAX_MS = 30 * 60 * 1000;      // 30 min overall cap — full combinatorial walk
const WEB_EPOS_CATEGORY_WALK_NO_PROGRESS_MS = 60 * 1000;   // abort if no new nodes for 60s straight

async function scrapeWebEposCategoryTreeAndRespond(requestId, appTabId) {
  const LOG_PREFIX = '[CG Suite Category Walk][ext]';
  const orchestratorLog = [];
  const log = (...parts) => {
    const stamp = new Date().toISOString().slice(11, 23);
    const msg = parts
      .map((p) => {
        if (p == null) return String(p);
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch (_) { return String(p); }
      })
      .join(' ');
    orchestratorLog.push(`[${stamp}][ext] ${msg}`);
    try { console.log(LOG_PREFIX, msg); } catch (_) { /* ignore */ }
  };

  // Errors travel as a normal `{ ok: false, error, log }` response so the
  // diagnostic log survives (the bridge's raw-error envelope drops extra fields).
  const respondErr = async (msg, walkerLog) => {
    const fullLog = [...orchestratorLog, ...(Array.isArray(walkerLog) ? walkerLog : [])];
    await notifyAppExtensionResponse(appTabId, requestId, {
      ok: false,
      error: msg,
      log: fullLog,
    });
  };

  log('scrape requested · appTabId', appTabId);

  let appTab;
  try {
    appTab = await chrome.tabs.get(appTabId);
  } catch (e) {
    log('chrome.tabs.get(appTabId) failed:', e?.message || String(e));
    await respondErr('Could not read the CG Suite tab.');
    return;
  }
  const windowId = appTab.windowId;

  let navTabId = null;
  try {
    const created = await chrome.tabs.create({
      windowId,
      url: WEB_EPOS_PRODUCT_NEW_URL,
      active: false,
    });
    navTabId = created.id;
    log('opened scrape tab', navTabId, 'at', WEB_EPOS_PRODUCT_NEW_URL);

    await waitForTabLoadComplete(navTabId, 90000, 'Web EPOS new-product page load timed out');
    log('tab load complete');

    await webEposAssertNewProductPageNotLogin(navTabId);
    log('login guard passed');

    // React needs a moment to fetch + populate catLevel1 after load.
    await sleep(600);

    const injectFiles = await chrome.scripting.executeScript({
      target: { tabId: navTabId },
      world: 'MAIN',
      files: ['bg/webepos-category-tree-walk-page.js'],
    });
    log('injected walker file · result count', injectFiles?.length ?? 0);

    // START is synchronous — it returns immediately while the walk runs async.
    const startRes = await chrome.scripting.executeScript({
      target: { tabId: navTabId },
      world: 'MAIN',
      func: () => {
        const start = window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_START;
        if (typeof start !== 'function') return { started: false, reason: 'START not on window' };
        return start();
      },
    });
    const started = startRes && startRes[0] ? startRes[0].result : null;
    log('walker START returned:', started);
    if (!started || started.started !== true) {
      await respondErr(
        started?.reason ? `Walker did not start: ${started.reason}` : 'Walker did not start.'
      );
      if (navTabId != null) await chrome.tabs.remove(navTabId).catch(() => {});
      return;
    }

    // Poll until done. Bounded by overall + no-progress timeouts so we don't
    // silently burn the full cap if the walker stalls at some branch.
    const startedAt = Date.now();
    let lastNodeCount = 0;
    let lastProgressAt = startedAt;
    let emittedBatchCount = 0;
    let finalSnapshot = null;

    const emitBatchToApp = (batch) => {
      chrome.tabs
        .sendMessage(appTabId, {
          type: 'EXTENSION_PROGRESS_TO_PAGE',
          requestId,
          payload: {
            kind: 'topLevelComplete',
            index: batch.index,
            total: batch.total,
            topLevel: batch.topLevel,
            nodes: batch.nodes,
          },
        })
        .catch(() => { /* app tab may be gone; not fatal */ });
    };

    while (Date.now() - startedAt < WEB_EPOS_CATEGORY_WALK_MAX_MS) {
      await sleep(WEB_EPOS_CATEGORY_WALK_POLL_MS);

      try {
        await chrome.tabs.get(navTabId);
      } catch (_) {
        log('scrape tab was closed by the user mid-walk');
        await respondErr('Scrape tab was closed before the walk finished.');
        return;
      }

      let snapshot = null;
      try {
        const readRes = await chrome.scripting.executeScript({
          target: { tabId: navTabId },
          world: 'MAIN',
          func: () => {
            const read = window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_READ;
            return typeof read === 'function' ? read() : null;
          },
        });
        snapshot = readRes && readRes[0] ? readRes[0].result : null;
      } catch (e) {
        log('READ poll threw:', e?.message || String(e));
      }

      if (!snapshot) continue;

      // Stream any newly-completed top-level subtrees to the app tab.
      const batches = Array.isArray(snapshot.pendingBatches) ? snapshot.pendingBatches : [];
      if (batches.length > emittedBatchCount) {
        for (let i = emittedBatchCount; i < batches.length; i += 1) {
          const batch = batches[i];
          log(
            'emitting progress batch', batch.index + '/' + batch.total,
            '· top-level:', batch.topLevel?.name,
            '· nodes:', Array.isArray(batch.nodes) ? batch.nodes.length : 0
          );
          emitBatchToApp(batch);
        }
        emittedBatchCount = batches.length;
      }

      if (snapshot.nodesCaptured !== lastNodeCount) {
        log('progress · captured', snapshot.nodesCaptured, 'nodes · at path:', snapshot.progressPath || '(root)');
        lastNodeCount = snapshot.nodesCaptured;
        lastProgressAt = Date.now();
      }

      if (snapshot.done) {
        finalSnapshot = snapshot;
        break;
      }

      if (Date.now() - lastProgressAt > WEB_EPOS_CATEGORY_WALK_NO_PROGRESS_MS) {
        log('walker stalled — no new nodes for', WEB_EPOS_CATEGORY_WALK_NO_PROGRESS_MS, 'ms');
        finalSnapshot = snapshot;
        break;
      }
    }

    if (!finalSnapshot) {
      log('walker did not complete within', WEB_EPOS_CATEGORY_WALK_MAX_MS, 'ms — pulling final snapshot');
      try {
        const readRes = await chrome.scripting.executeScript({
          target: { tabId: navTabId },
          world: 'MAIN',
          func: () => {
            const read = window.__CG_WEB_EPOS_CATEGORY_TREE_WALK_READ;
            return typeof read === 'function' ? read() : null;
          },
        });
        finalSnapshot = readRes && readRes[0] ? readRes[0].result : null;
      } catch (_) { /* ignore */ }
    }

    const walkerLog = Array.isArray(finalSnapshot?.log) ? finalSnapshot.log : [];
    const result = finalSnapshot?.result || null;

    if (navTabId != null) {
      await chrome.tabs.remove(navTabId).catch(() => {});
      navTabId = null;
      log('scrape tab closed');
    }

    if (!finalSnapshot?.done) {
      await respondErr('Walker timed out or stalled before finishing.', walkerLog);
      return;
    }
    if (!result || result.ok !== true) {
      await respondErr(result?.error || 'Walk did not return results.', walkerLog);
      return;
    }

    log('walker finished · captured', Array.isArray(result.nodes) ? result.nodes.length : 0, 'nodes');
    await notifyAppExtensionResponse(appTabId, requestId, {
      ok: true,
      nodes: Array.isArray(result.nodes) ? result.nodes : [],
      log: [...orchestratorLog, ...walkerLog],
    });
  } catch (e) {
    log('orchestrator threw:', e?.message || String(e));
    if (navTabId != null) await chrome.tabs.remove(navTabId).catch(() => {});
    await respondErr((e && e.message) ? String(e.message) : 'Category tree scrape failed.');
  }
}
