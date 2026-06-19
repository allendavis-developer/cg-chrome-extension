/**
 * Web EPOS new-product and edit-product form injection/fill/save flows.
 */

function sanitizeWebEposProductCreateSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const allowed = [
    'title',
    'price',
    'costPrice',
    'wasPrice',
    'quantity',
    'condition',
    'grade',
    'barcode',
    'gtin',
    'intro',
    'fulfilmentOption',
    'storeId',
    'categoryLevelUuids',
    'categoryPathLabels',
  ];
  const o = {};
  for (const k of allowed) {
    if (raw[k] == null) continue;
    if (k === 'categoryLevelUuids' || k === 'categoryPathLabels') {
      if (Array.isArray(raw[k])) {
        o[k] = raw[k]
          .map((x) => String(x ?? '').trim())
          .filter(Boolean);
      }
    } else {
      o[k] = raw[k];
    }
  }
  return Object.keys(o).length ? o : null;
}

/** Validates URL after load; throws if still on /login. Caller should close the worker tab when catching. */
async function webEposAssertNewProductPageNotLogin(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const u = (tab.url || '').trim();
  if (!u) {
    throw new Error('Could not read Web EPOS URL.');
  }
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('Invalid Web EPOS URL.');
  }
  if (parsed.hostname.toLowerCase() !== WEB_EPOS_UPLOAD_HOST) {
    throw new Error('Not on Web EPOS.');
  }
  const path = (parsed.pathname || '/').toLowerCase();
  if (WEB_EPOS_LOGIN_PATH.test(path)) {
    throw new Error('You must be logged into Web EPOS to view products.');
  }
  return u;
}

/**
 * Switch the Web EPOS `#storeId` store selector to the store the scraped listings
 * came from, so audits and new-product uploads always act against the right store.
 *
 * Matching: exact option value (the scraped storeId) first, then a normalised name
 * compare ("CG Warrington" == "Warrington") as a fallback.
 *
 * Returns:
 *   { ok: true, selected }          — switched (or already on the right store)
 *   { ok: true, skipped: true }     — no target store given; caller keeps prior behaviour
 *   { ok: false, notFound: true }   — the store isn't in the switcher list (caller must
 *                                     close the tab and tell the user)
 *   { ok: false, error }            — switcher/page problem
 */
async function injectWebEposSelectStoreOrFail(tabId, targetStore) {
  const storeId = targetStore && targetStore.storeId != null ? String(targetStore.storeId).trim() : '';
  const storeName = targetStore && targetStore.storeName != null ? String(targetStore.storeName).trim() : '';
  if (!storeId && !storeName) return { ok: true, skipped: true };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [storeId, storeName],
    func: async (wantId, wantName) => {
      const sel = document.querySelector('#storeId, select[name="storeId"]');
      if (!sel) return { ok: false, noSelect: true };
      const norm = (s) => {
        let t = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (t.indexOf('cg ') === 0) t = t.slice(3).trim();
        if (t.length > 3 && t.lastIndexOf(' cg') === t.length - 3) t = t.slice(0, -3).trim();
        return t;
      };
      const opts = Array.prototype.slice.call(sel.options || []);
      let match = null;
      if (wantId) match = opts.find((o) => String(o.value) === wantId) || null;
      if (!match && wantName) {
        const want = norm(wantName);
        match =
          opts.find((o) => norm(o.textContent) === want) ||
          opts.find((o) => {
            const n = norm(o.textContent);
            return n && (n.indexOf(want) !== -1 || want.indexOf(n) !== -1);
          }) ||
          null;
      }
      if (!match) {
        return { ok: false, notFound: true, options: opts.map((o) => String(o.textContent || '').trim()) };
      }
      if (String(sel.value) === String(match.value)) {
        return { ok: true, selected: String(match.textContent || '').trim(), value: match.value, alreadySelected: true };
      }

      function firstRowBarcode() {
        const tr = document.querySelector('tbody tr');
        if (!tr) return '';
        const cell = tr.querySelector('td');
        return cell ? String(cell.textContent || '').trim().replace(/\s+/g, ' ') : '';
      }
      /**
       * Event-driven wait — MutationObserver fires on the row swap even in a
       * background/unfocused tab, where setTimeout is throttled to ≥1s. This is
       * the whole fix: without waiting for the list to actually reflect the new
       * store, the caller's product-find runs against the OLD store's table and
       * reports "product not found".
       */
      function waitForDomCondition(predicate, timeoutMs) {
        return new Promise((resolve) => {
          try {
            if (predicate()) return resolve(true);
          } catch (_) {}
          let done = false;
          const obs = new MutationObserver(() => {
            if (done) return;
            try {
              if (predicate()) {
                done = true;
                obs.disconnect();
                clearTimeout(to);
                resolve(true);
              }
            } catch (_) {}
          });
          obs.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
          const to = setTimeout(() => {
            if (done) return;
            done = true;
            obs.disconnect();
            resolve(false);
          }, Math.max(100, timeoutMs));
        });
      }

      const before = firstRowBarcode();
      const proto = Object.getPrototypeOf(sel);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(sel, match.value);
      else sel.value = match.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      // Web EPOS does NOT re-fetch on select change — the operator clicks a
      // "Filter" button to apply store/status. Click it for them, else the list
      // stays on the old store and the product is never found.
      (function clickFilterButton() {
        const btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        const btn = btns.find((b) => /^filter$/i.test(String(b.textContent || '').trim()));
        if (btn) {
          try {
            btn.click();
          } catch (_) {}
        }
      })();

      // Wait until the product rows actually swap to the new store before
      // returning (cap generously — a cold store fetch can be slow).
      const swapped = await waitForDomCondition(() => {
        const bc = firstRowBarcode();
        return bc && bc !== before;
      }, 12000);
      return { ok: true, selected: String(match.textContent || '').trim(), value: match.value, swapped };
    },
  });
  const r = results && results[0] ? results[0].result : null;
  if (!r) return { ok: false, error: 'Could not read the Web EPOS store switcher.' };
  if (r.noSelect) return { ok: false, error: 'The Web EPOS store switcher was not found on the page.' };
  if (r.notFound) return { ok: false, notFound: true };
  // Small settle buffer on top of the in-page row-swap wait.
  await sleep(300);
  return { ok: true, selected: r.selected };
}

/**
 * Switch the Web EPOS `#status` filter (onsale/soldout/unavailable/uploading) to
 * the status a product was scraped under, BEFORE walking the list to find it —
 * Web EPOS only lists one status at a time, so a Sold Out item won't appear while
 * the filter is on On Sale. Best-effort: if the page has no status filter or the
 * status is unknown, leave it as-is (the find can still succeed for the default
 * status). `statusRaw` may be a value ("soldout") or a label ("Sold Out").
 */
async function injectWebEposSelectStatusOrSkip(tabId, statusRaw) {
  const want = String(statusRaw == null ? '' : statusRaw).trim();
  if (!want) return { ok: true, skipped: true };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [want],
    func: async (wantRaw) => {
      const sel = document.querySelector('#status, select[name="status"]');
      if (!sel) return { ok: true, noSelect: true };
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const target = norm(wantRaw);
      const opts = Array.prototype.slice.call(sel.options || []);
      const match =
        opts.find((o) => norm(o.value) === target) ||
        opts.find((o) => norm(o.textContent) === target) ||
        null;
      if (!match) return { ok: true, notFound: true };
      if (String(sel.value) === String(match.value)) return { ok: true, alreadySelected: true };

      function firstRowBarcode() {
        const tr = document.querySelector('tbody tr');
        if (!tr) return '';
        const cell = tr.querySelector('td');
        return cell ? String(cell.textContent || '').trim().replace(/\s+/g, ' ') : '';
      }
      function waitForDomCondition(predicate, timeoutMs) {
        return new Promise((resolve) => {
          try {
            if (predicate()) return resolve(true);
          } catch (_) {}
          let done = false;
          const obs = new MutationObserver(() => {
            if (done) return;
            try {
              if (predicate()) {
                done = true;
                obs.disconnect();
                clearTimeout(to);
                resolve(true);
              }
            } catch (_) {}
          });
          obs.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
          const to = setTimeout(() => {
            if (done) return;
            done = true;
            obs.disconnect();
            resolve(false);
          }, Math.max(100, timeoutMs));
        });
      }

      const before = firstRowBarcode();
      const proto = Object.getPrototypeOf(sel);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(sel, match.value);
      else sel.value = match.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      // Web EPOS only re-fetches when the Filter button is clicked — apply it.
      (function clickFilterButton() {
        const btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        const btn = btns.find((b) => /^filter$/i.test(String(b.textContent || '').trim()));
        if (btn) {
          try {
            btn.click();
          } catch (_) {}
        }
      })();

      await waitForDomCondition(() => {
        const bc = firstRowBarcode();
        return bc && bc !== before;
      }, 12000);
      return { ok: true, selected: String(match.textContent || '').trim() };
    },
  });
  const r = results && results[0] ? results[0].result : null;
  if (!r) return { ok: false, error: 'Could not read the Web EPOS status switcher.' };
  await sleep(200);
  // noSelect = the page has no Status filter → status-cycling can't help the caller.
  return { ok: true, noSelect: !!r.noSelect };
}

async function injectWebEposEnsureOnSaleOff(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['bg/webepos-new-product-fill-page.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const fn = window.__CG_WEB_EPOS_ENSURE_ON_SALE_OFF;
      if (typeof fn === 'function') return fn();
    },
  });
}

/**
 * Edit-page save that guarantees On Sale is OFF at the moment of click — wraps the
 * `__CG_WEB_EPOS_FINISH_EDIT_PRODUCT_OFF_SALE` helper. Mirror of
 * {@link injectWebEposEditProductFinishSave} for flows that want the listing closed
 * (e.g. "Close listings for sold items"), not kept live like the audit price-edit flow.
 */
async function injectWebEposEditProductFinishSaveOffSale(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['bg/webepos-new-product-fill-page.js'],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const fn = window.__CG_WEB_EPOS_FINISH_EDIT_PRODUCT_OFF_SALE;
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('Web EPOS off-sale save helper not available'));
      }
      return fn();
    },
  });
  const inj = results && results[0];
  if (inj?.error) {
    throw new Error(inj.error.message || String(inj.error));
  }
}

async function injectWebEposNewProductFill(tabId, spec) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['bg/webepos-new-product-fill-page.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [spec],
    func: (s) => {
      const run = window.__CG_WEB_EPOS_FILL_RUN;
      if (typeof run === 'function') return run(s);
      return undefined;
    },
  });
  await sleep(400);
}

async function injectWebEposNewProductFinishSave(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['bg/webepos-new-product-fill-page.js'],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const fn = window.__CG_WEB_EPOS_FINISH_NEW_PRODUCT;
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('Web EPOS finish helper not available'));
      }
      return fn();
    },
  });
  const inj = results && results[0];
  if (inj?.error) {
    throw new Error(inj.error.message || String(inj.error));
  }
  await sleep(300);
}

/**
 * Upload proceed: open `/products/new` in one minimised tab, fill each item in sequence, turn Off Sale
 * off, click Save Product, wait for redirect, then move to the next row. Progress mirrors repricing
 * (`broadcastRepricingStatus`) when `uploadProgressCartKey` is set.
 */
/** User-facing message when the listings' store isn't selectable in Web EPOS. */
function webEposStoreNotAvailableMessage(targetStore) {
  const name = (targetStore && (targetStore.storeName || targetStore.storeId)) || 'that store';
  return `The "${name}" store isn't available in the Web EPOS store switcher — closing Web EPOS. Check you're signed into Web EPOS on the right store.`;
}

async function openWebEposProductCreateMinimizedAndRespond(requestId, appTabId, createListRaw, uploadProgressCartKey, targetStore) {
  logUpload('uploadCreateRun', 'start', {
    requestId,
    appTabId,
    rawCount: Array.isArray(createListRaw) ? createListRaw.length : 0,
    cartKey: uploadProgressCartKey || '',
  }, 'Upload-new run starting');
  const respondErr = async (msg) => {
    if (!appTabId) return;
    chrome.tabs
      .sendMessage(appTabId, {
        type: 'EXTENSION_RESPONSE_TO_PAGE',
        requestId,
        error: msg,
      })
      .catch(() => {});
    await focusAppTab(appTabId);
  };

  const rawList = Array.isArray(createListRaw) ? createListRaw : [];
  const createList = rawList
    .map(sanitizeWebEposProductCreateSpec)
    .filter(Boolean)
    .slice(0, 20);
  // Force every new product onto the store the scraped listings came from (the
  // store switcher is also re-asserted per item below, which fails-closed if it
  // isn't selectable). Overrides any per-row storeId so we never fall back to
  // pickFirstNonEmptyStore and silently create against the wrong store.
  if (targetStore && targetStore.storeId != null && String(targetStore.storeId).trim()) {
    const sid = String(targetStore.storeId).trim();
    for (const s of createList) s.storeId = sid;
  }
  logUpload('uploadCreateRun', 'list-sanitized', {
    raw: rawList.length,
    sanitized: createList.length,
    titles: createList.map((s) => s.title || '').slice(0, 20),
    barcodes: createList.map((s) => s.barcode || '').slice(0, 20),
  });

  const cartKey = String(uploadProgressCartKey || '').trim();
  let progressData = {
    cartKey,
    done: false,
    repricingData: [],
    completedBarcodes: {},
    completedItems: [],
    logs: [],
    step: 'webEposUpload',
    message: '',
  };

  let webEposWorkerTabId = null;
  /** When set, we opened this window only for Web EPOS upload — remove the whole window so extra tabs (e.g. after save) do not leave a minimised shell. */
  let webEposDedicatedWindowId = null;
  const closeWebEposWorkerTab = async () => {
    const wid = webEposDedicatedWindowId;
    const tid = webEposWorkerTabId;
    webEposDedicatedWindowId = null;
    webEposWorkerTabId = null;
    if (wid != null) {
      await chrome.windows.remove(wid).catch(() => {});
      return;
    }
    if (tid != null) {
      await removeWebEposWorkerByTabId(tid);
    }
  };

  try {
    if (createList.length === 0) {
      logUpload('uploadCreateRun', 'empty-list', null, 'No items to create — opening blank /products/new page only');
      try {
        const opened = await openBackgroundNosposTab(WEB_EPOS_PRODUCT_NEW_URL, appTabId);
        webEposWorkerTabId = opened?.tabId ?? null;
        webEposDedicatedWindowId =
          opened?.dedicatedWindow && opened?.windowId != null ? opened.windowId : null;
        if (webEposWorkerTabId == null) {
          logUpload('uploadCreateRun', 'error', { reason: 'no-worker-tab' }, 'Could not open Web EPOS');
          await respondErr('Could not open Web EPOS.');
          return;
        }
        await waitForTabLoadComplete(webEposWorkerTabId, 90000, 'Web EPOS new product page load timed out');
        const u = await webEposAssertNewProductPageNotLogin(webEposWorkerTabId);
        logUpload('uploadCreateRun', 'empty-list-ready', { url: u });
        await notifyAppExtensionResponse(appTabId, requestId, { ok: true, url: u, tabsFilled: 0 });
        await closeWebEposWorkerTab();
        if (appTabId) await focusAppTab(appTabId);
      } catch (e) {
        logUpload('uploadCreateRun', 'error', { phase: 'empty-list-open', error: e?.message || String(e) });
        await closeWebEposWorkerTab();
        await respondErr(e?.message || 'Failed to open Web EPOS new product page.');
        if (appTabId) await focusAppTab(appTabId);
      }
      return;
    }

    const emitProgress = async (patch) => {
      if (!cartKey || !appTabId) return;
      const { logMessage, ...dataPatch } = patch;
      progressData = { ...progressData, ...dataPatch };
      progressData = appendRepricingLog(
        progressData,
        logMessage != null ? String(logMessage) : String(patch.message || '').trim() || '…'
      );
      await broadcastRepricingStatus(appTabId, progressData, {
        ...dataPatch,
        logs: progressData.logs,
        totalBarcodes: createList.length,
      });
    };

    if (cartKey && appTabId) {
      progressData = appendRepricingLog(
        progressData,
        `Starting Web EPOS upload (${createList.length} item${createList.length === 1 ? '' : 's'}).`
      );
      await broadcastRepricingStatus(appTabId, progressData, {
        running: true,
        done: false,
        message: 'Opening Web EPOS',
        currentBarcode: createList[0]?.barcode || '',
        currentItemTitle: createList[0]?.title || '',
        completedBarcodeCount: 0,
        totalBarcodes: createList.length,
        logs: progressData.logs,
      });
    }

    try {
      const opened = await openBackgroundNosposTab(WEB_EPOS_PRODUCT_NEW_URL, appTabId);
      webEposWorkerTabId = opened?.tabId ?? null;
      webEposDedicatedWindowId =
        opened?.dedicatedWindow && opened?.windowId != null ? opened.windowId : null;
      if (webEposWorkerTabId == null) throw new Error('Could not open Web EPOS.');
      logUpload('uploadCreateRun', 'worker-opened', {
        webEposWorkerTabId,
        webEposDedicatedWindowId,
        url: WEB_EPOS_PRODUCT_NEW_URL,
      });
    } catch (e) {
      logUpload('uploadCreateRun', 'error', { phase: 'open-worker', error: e?.message || String(e) });
      await closeWebEposWorkerTab();
      await respondErr(e?.message || 'Could not open Web EPOS.');
      if (cartKey && appTabId) {
        progressData = appendRepricingLog(progressData, e?.message || 'Could not open Web EPOS.');
        await broadcastRepricingStatus(appTabId, progressData, {
          running: false,
          done: true,
          message: 'Web EPOS upload failed',
          completedBarcodeCount: 0,
          totalBarcodes: createList.length,
          logs: progressData.logs,
        });
      }
      return;
    }

    let lastUrl = WEB_EPOS_PRODUCT_NEW_URL;
    for (let i = 0; i < createList.length; i++) {
      const spec = createList[i];
      const itemCtx = {
        index: i + 1,
        total: createList.length,
        title: spec.title || '',
        barcode: spec.barcode || '',
        price: spec.price ?? null,
        quantity: spec.quantity ?? null,
        condition: spec.condition || '',
        categoryPath: Array.isArray(spec.categoryPathLabels) ? spec.categoryPathLabels : [],
      };
      logUpload('uploadCreateRun', 'item-start', itemCtx, `Begin item ${i + 1}/${createList.length}`);
      try {
        if (i > 0) {
          logUpload('uploadCreateRun', 'item-nav', { ...itemCtx, url: WEB_EPOS_PRODUCT_NEW_URL });
          await chrome.tabs.update(webEposWorkerTabId, { url: WEB_EPOS_PRODUCT_NEW_URL });
          await waitForTabLoadComplete(webEposWorkerTabId, 90000, 'Web EPOS new product page load timed out');
        } else {
          await waitForTabLoadComplete(webEposWorkerTabId, 90000, 'Web EPOS new product page load timed out');
        }
        lastUrl = await webEposAssertNewProductPageNotLogin(webEposWorkerTabId);
        logUpload('uploadCreateRun', 'item-page-ready', { ...itemCtx, url: lastUrl });

        // Switch the store selector to the listings' store first. If it isn't in
        // the list, abort the whole run — the catch below closes Web EPOS and
        // tells the operator.
        const storeSwitch = await injectWebEposSelectStoreOrFail(webEposWorkerTabId, targetStore);
        if (storeSwitch.notFound) {
          throw new Error(webEposStoreNotAvailableMessage(targetStore));
        }
        if (!storeSwitch.ok) {
          throw new Error(storeSwitch.error || 'Could not set the Web EPOS store.');
        }
        logUpload('uploadCreateRun', 'item-store-set', { ...itemCtx, store: storeSwitch.selected || null });

        if (cartKey && appTabId) {
          await emitProgress({
            running: true,
            done: false,
            message: `Ticking off On Sale — product ${i + 1} of ${createList.length}`,
            currentBarcode: spec.barcode || '',
            currentItemTitle: spec.title || '',
            completedBarcodeCount: i,
            logMessage: `Item ${i + 1}/${createList.length}: ensuring On Sale is off (${spec.title || 'Product'}).`,
          });
        }

        logUpload('uploadCreateRun', 'item-on-sale-off-begin', itemCtx);
        await injectWebEposEnsureOnSaleOff(webEposWorkerTabId);
        logUpload('uploadCreateRun', 'item-on-sale-off-done', itemCtx);

        if (cartKey && appTabId) {
          await emitProgress({
            message: `Filling item info — product ${i + 1} of ${createList.length}`,
            logMessage: `Item ${i + 1}/${createList.length}: On Sale ticked off, now filling item info.`,
          });
        }

        logUpload('uploadCreateRun', 'item-fill-begin', itemCtx);
        await injectWebEposNewProductFill(webEposWorkerTabId, spec);
        logUpload('uploadCreateRun', 'item-fill-done', itemCtx);

        if (cartKey && appTabId) {
          await emitProgress({
            message: `Saving product ${i + 1} of ${createList.length}…`,
            logMessage: `Item ${i + 1}/${createList.length}: item info filled, clicking Save Product.`,
          });
        }

        logUpload('uploadCreateRun', 'item-save-begin', itemCtx);
        await injectWebEposNewProductFinishSave(webEposWorkerTabId);
        const tab = await chrome.tabs.get(webEposWorkerTabId);
        lastUrl = (tab.url || '').trim() || lastUrl;
        logUpload('uploadCreateRun', 'item-saved', { ...itemCtx, url: lastUrl }, `Saved item ${i + 1}/${createList.length}`);

        if (cartKey && appTabId) {
          await emitProgress({
            message: `Saved product ${i + 1} of ${createList.length} ✓`,
            completedBarcodeCount: i + 1,
            logMessage: `Item ${i + 1}/${createList.length}: saved successfully (${spec.barcode || 'no barcode'}).`,
          });
        }
      } catch (e) {
        const errMsg = e?.message || 'Failed to open, fill, or save Web EPOS product.';
        logUpload('uploadCreateRun', 'item-error', { ...itemCtx, error: errMsg, stack: e?.stack || '' }, errMsg);
        await closeWebEposWorkerTab();
        await respondErr(errMsg);
        if (cartKey && appTabId) {
          progressData = appendRepricingLog(progressData, `Error on item ${i + 1}: ${errMsg}`);
          await broadcastRepricingStatus(appTabId, progressData, {
            running: false,
            done: true,
            message: 'Web EPOS upload stopped due to an error',
            completedBarcodeCount: i,
            totalBarcodes: createList.length,
            logs: progressData.logs,
          });
        }
        return;
      }
    }

    if (cartKey && appTabId) {
      progressData = appendRepricingLog(progressData, 'Web EPOS upload finished for all items.');
      await broadcastRepricingStatus(appTabId, progressData, {
        running: false,
        done: true,
        message: 'Web EPOS upload complete',
        completedBarcodeCount: createList.length,
        totalBarcodes: createList.length,
        logs: progressData.logs,
      });
    }

    logUpload('uploadCreateRun', 'complete', {
      total: createList.length,
      lastUrl,
    }, `All ${createList.length} item(s) saved`);

    await notifyAppExtensionResponse(appTabId, requestId, {
      ok: true,
      url: lastUrl,
      tabsFilled: createList.length,
    });
    await closeWebEposWorkerTab();
    if (appTabId) {
      await focusAppTab(appTabId);
    }
  } catch (e) {
    logUpload('uploadCreateRun', 'fatal-error', { error: e?.message || String(e), stack: e?.stack || '' });
    await closeWebEposWorkerTab();
    await respondErr(e?.message || 'Failed to open Web EPOS new product page.');
    if (cartKey && appTabId) {
      progressData = appendRepricingLog(progressData, e?.message || 'Unexpected error');
      await broadcastRepricingStatus(appTabId, progressData, {
        running: false,
        done: true,
        message: 'Web EPOS upload failed',
        totalBarcodes: createList.length,
        completedBarcodeCount: 0,
        logs: progressData.logs,
      });
    }
  }
}

/**
 * Audit-mode price edit on existing Web EPOS products.
 *
 * For each item in `updateListRaw`:
 *   1. Reuse `openWebEposProductInTab` (the "quick look" opener defined in scrape.js) —
 *      this is the same canonical path the products-table barcode click and the audit
 *      preview both use, so we get fresh-session /products navigation + pagination walk
 *      + correct link click for free.
 *   2. Inject the shared new-product fill SDK (`bg/webepos-new-product-fill-page.js`).
 *      `__CG_WEB_EPOS_FILL_RUN({ price })` only sets `#price` because other spec fields
 *      are absent — the edit page uses the same `id` attributes as `/products/new`, so
 *      reusing that SDK keeps every Web EPOS form selector in one file.
 *   3. Click Save/Update via `__CG_WEB_EPOS_FINISH_EDIT_PRODUCT` (sibling helper added to
 *      the same SDK file) and wait for the busy state to clear.
 *   4. Close the per-item tab and move on.
 *
 * Progress broadcasting mirrors `openWebEposProductCreateMinimizedAndRespond` so the
 * audit UI picks the updates up on the same `broadcastRepricingStatus` channel.
 */
function sanitizeWebEposPriceUpdateSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const productHref = String(raw.productHref || '').trim();
  const priceNum = Number.parseFloat(String(raw.price ?? '').replace(/[£,\s]/g, ''));
  if (!productHref || !Number.isFinite(priceNum) || priceNum < 0) return null;
  return {
    productHref,
    price: priceNum.toFixed(2),
    barcode: String(raw.barcode || '').trim(),
    title: String(raw.title || '').trim(),
  };
}

async function injectWebEposEditProductFinishSave(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['bg/webepos-new-product-fill-page.js'],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const fn = window.__CG_WEB_EPOS_FINISH_EDIT_PRODUCT;
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('Web EPOS edit finish helper not available'));
      }
      return fn();
    },
  });
  const inj = results && results[0];
  if (inj?.error) {
    throw new Error(inj.error.message || String(inj.error));
  }
}

/**
 * Resolve once the edit-page form has actually mounted (i.e. `#price` is in the DOM).
 * Replaces a blind fixed-duration wait — we proceed the instant the input exists.
 * The 20s cap here is just a safety net for a genuinely broken page load.
 */
async function injectWebEposWaitForEditFormReady(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      if (document.getElementById('price')) return { ok: true };
      return await new Promise((resolve) => {
        const deadline = Date.now() + 20000;
        const obs = new MutationObserver(() => {
          if (document.getElementById('price')) {
            obs.disconnect();
            resolve({ ok: true });
          }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        /** Poll fallback in case a mutation happens before the observer wires up. */
        const iv = setInterval(() => {
          if (document.getElementById('price')) {
            obs.disconnect();
            clearInterval(iv);
            resolve({ ok: true });
          } else if (Date.now() > deadline) {
            obs.disconnect();
            clearInterval(iv);
            resolve({ ok: false, error: 'price input never appeared' });
          }
        }, 50);
      });
    },
  });
  const inj = results && results[0];
  if (inj?.error) {
    throw new Error(inj.error.message || String(inj.error));
  }
  const payload = inj?.result;
  if (payload && payload.ok === false) {
    throw new Error(payload.error || 'Edit form never mounted');
  }
}

/**
 * Resolve once the product JSON has actually hydrated the edit page — signalled by `#price`
 * having a non-empty value. This is the same readiness rule `scrape-web-epos-category-selects`
 * uses to know the page has finished loading. Needed for any mutation that could race against
 * React's initial state hydration (e.g. toggling the On Sale switch): if we flip a control before
 * the product data arrives, React will replay the loaded state and undo our change.
 */
async function injectWebEposWaitForProductLoaded(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      const isLoaded = () => {
        const price = document.getElementById('price');
        if (!price) return false;
        return String(price.value || '').trim().length > 0;
      };
      if (isLoaded()) return { ok: true };
      return await new Promise((resolve) => {
        const deadline = Date.now() + 20000;
        const obs = new MutationObserver(() => {
          if (isLoaded()) {
            obs.disconnect();
            clearInterval(iv);
            resolve({ ok: true });
          }
        });
        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['value'],
        });
        const iv = setInterval(() => {
          if (isLoaded()) {
            obs.disconnect();
            clearInterval(iv);
            resolve({ ok: true });
          } else if (Date.now() > deadline) {
            obs.disconnect();
            clearInterval(iv);
            /** Soft-fail: proceed anyway so a genuinely empty `#price` (e.g. brand-new product,
             * no RRP yet) doesn't stall the whole close-flagged run. Callers re-verify the switch. */
            resolve({ ok: false });
          }
        }, 80);
      });
    },
  });
  const inj = results && results[0];
  if (inj?.error) {
    throw new Error(inj.error.message || String(inj.error));
  }
}

async function updateWebEposProductPricesAndRespond(requestId, appTabId, updateListRaw, uploadProgressCartKey, targetStore) {
  // Reset the upload log only when the audit flow runs without an upstream openWebEposUpload reset
  // (e.g. retry path). When openWebEposUpload was just called, we keep its breadcrumbs and continue.
  if (cgUploadLog.length === 0 || cgUploadLogStartTs == null) {
    resetUploadLog();
  }
  logUpload('auditPriceUpdateRun', 'start', {
    requestId,
    appTabId,
    rawCount: Array.isArray(updateListRaw) ? updateListRaw.length : 0,
    cartKey: uploadProgressCartKey || '',
  }, 'Audit price-update run starting');
  const respondErr = async (msg) => {
    if (!appTabId) return;
    chrome.tabs
      .sendMessage(appTabId, {
        type: 'EXTENSION_RESPONSE_TO_PAGE',
        requestId,
        error: msg,
      })
      .catch(() => {});
    await focusAppTab(appTabId);
  };

  const rawList = Array.isArray(updateListRaw) ? updateListRaw : [];
  const updateList = rawList.map(sanitizeWebEposPriceUpdateSpec).filter(Boolean).slice(0, 50);
  logUpload('auditPriceUpdateRun', 'list-sanitized', {
    raw: rawList.length,
    sanitized: updateList.length,
    titles: updateList.map((s) => s.title || '').slice(0, 50),
    barcodes: updateList.map((s) => s.barcode || '').slice(0, 50),
    prices: updateList.map((s) => s.price ?? null).slice(0, 50),
  });

  if (updateList.length === 0) {
    logUpload('auditPriceUpdateRun', 'empty-list', null, 'Nothing to update');
    await notifyAppExtensionResponse(appTabId, requestId, { ok: true, tabsUpdated: 0 });
    if (appTabId) await focusAppTab(appTabId);
    return;
  }

  const cartKey = String(uploadProgressCartKey || '').trim();
  let progressData = {
    cartKey,
    done: false,
    repricingData: [],
    completedBarcodes: {},
    completedItems: [],
    logs: [],
    step: 'webEposAuditPriceUpdate',
    message: '',
  };

  const emitProgress = async (patch) => {
    if (!cartKey || !appTabId) return;
    const { logMessage, ...dataPatch } = patch;
    progressData = { ...progressData, ...dataPatch };
    progressData = appendRepricingLog(
      progressData,
      logMessage != null ? String(logMessage) : String(patch.message || '').trim() || '…'
    );
    await broadcastRepricingStatus(appTabId, progressData, {
      ...dataPatch,
      logs: progressData.logs,
      totalBarcodes: updateList.length,
    });
  };

  if (cartKey && appTabId) {
    progressData = appendRepricingLog(
      progressData,
      `Starting Web EPOS price update (${updateList.length} item${updateList.length === 1 ? '' : 's'}).`
    );
    await broadcastRepricingStatus(appTabId, progressData, {
      running: true,
      done: false,
      message: 'Opening Web EPOS',
      currentBarcode: updateList[0]?.barcode || '',
      currentItemTitle: updateList[0]?.title || '',
      completedBarcodeCount: 0,
      totalBarcodes: updateList.length,
      logs: progressData.logs,
    });
  }

  for (let i = 0; i < updateList.length; i++) {
    const spec = updateList[i];
    const itemCtx = {
      index: i + 1,
      total: updateList.length,
      title: spec.title || '',
      barcode: spec.barcode || '',
      price: spec.price,
      productHref: spec.productHref,
    };
    logUpload('auditPriceUpdateRun', 'item-start', itemCtx, `Begin item ${i + 1}/${updateList.length}`);
    let workerTabId = null;
    try {
      if (cartKey && appTabId) {
        await emitProgress({
          running: true,
          done: false,
          message: `Opening product ${i + 1} of ${updateList.length}…`,
          currentBarcode: spec.barcode,
          currentItemTitle: spec.title,
          completedBarcodeCount: i,
          logMessage: `Item ${i + 1}/${updateList.length}: opening ${spec.title || spec.barcode || 'product'} on Web EPOS.`,
        });
      }

      logUpload('auditPriceUpdateRun', 'item-open-begin', itemCtx);
      const opened = await openWebEposProductInTab(appTabId, spec.productHref, spec.barcode, targetStore);
      if (opened.storeNotFound) {
        throw new Error(webEposStoreNotAvailableMessage(targetStore));
      }
      if (!opened.ok) {
        throw new Error(opened.error || 'Could not open product on Web EPOS.');
      }
      workerTabId = opened.tabId;
      logUpload('auditPriceUpdateRun', 'item-opened', { ...itemCtx, workerTabId });

      /** Wait for the edit-page form to mount (signal-based, not a fixed delay). */
      await injectWebEposWaitForEditFormReady(workerTabId);
      logUpload('auditPriceUpdateRun', 'item-form-ready', { ...itemCtx, workerTabId });

      if (cartKey && appTabId) {
        await emitProgress({
          message: `Updating price — product ${i + 1} of ${updateList.length}`,
          logMessage: `Item ${i + 1}/${updateList.length}: setting price to £${spec.price}.`,
        });
      }

      /**
       * editOnly: true tells the shared fill runner not to touch anything beyond
       * the fields we supply. In particular: do NOT toggle Off Sale, do NOT set
       * fulfilmentOption/storeId defaults, do NOT re-fill categories. Any of those
       * side effects can cause Web EPOS to auto-assign RRP Source to eBay.
       */
      logUpload('auditPriceUpdateRun', 'item-fill-begin', { ...itemCtx, workerTabId });
      await injectWebEposNewProductFill(workerTabId, { price: spec.price, editOnly: true });
      logUpload('auditPriceUpdateRun', 'item-fill-done', { ...itemCtx, workerTabId });

      if (cartKey && appTabId) {
        await emitProgress({
          message: `Saving product ${i + 1} of ${updateList.length}…`,
          logMessage: `Item ${i + 1}/${updateList.length}: clicking Save/Update.`,
        });
      }

      logUpload('auditPriceUpdateRun', 'item-save-begin', { ...itemCtx, workerTabId });
      await injectWebEposEditProductFinishSave(workerTabId);
      logUpload('auditPriceUpdateRun', 'item-saved', { ...itemCtx, workerTabId }, `Saved item ${i + 1}/${updateList.length}`);

      if (cartKey && appTabId) {
        await emitProgress({
          message: `Updated product ${i + 1} of ${updateList.length} ✓`,
          completedBarcodeCount: i + 1,
          logMessage: `Item ${i + 1}/${updateList.length}: price saved (${spec.barcode || 'no barcode'}).`,
        });
      }
    } catch (e) {
      const errMsg = e?.message || 'Failed to update price on Web EPOS.';
      logUpload('auditPriceUpdateRun', 'item-error', { ...itemCtx, workerTabId, error: errMsg, stack: e?.stack || '' }, errMsg);
      if (workerTabId != null) await chrome.tabs.remove(workerTabId).catch(() => {});
      await respondErr(errMsg);
      if (cartKey && appTabId) {
        progressData = appendRepricingLog(progressData, `Error on item ${i + 1}: ${errMsg}`);
        await broadcastRepricingStatus(appTabId, progressData, {
          running: false,
          done: true,
          message: 'Web EPOS price update stopped due to an error',
          completedBarcodeCount: i,
          totalBarcodes: updateList.length,
          logs: progressData.logs,
        });
      }
      return;
    }

    if (workerTabId != null) {
      logUpload('auditPriceUpdateRun', 'item-tab-close', { ...itemCtx, workerTabId });
      await chrome.tabs.remove(workerTabId).catch(() => {});
    }
  }

  if (cartKey && appTabId) {
    progressData = appendRepricingLog(progressData, 'Web EPOS price update finished for all items.');
    await broadcastRepricingStatus(appTabId, progressData, {
      running: false,
      done: true,
      message: 'Web EPOS price update complete',
      completedBarcodeCount: updateList.length,
      totalBarcodes: updateList.length,
      logs: progressData.logs,
    });
  }

  logUpload('auditPriceUpdateRun', 'complete', {
    total: updateList.length,
  }, `All ${updateList.length} item(s) updated`);

  await notifyAppExtensionResponse(appTabId, requestId, {
    ok: true,
    tabsUpdated: updateList.length,
  });
  if (appTabId) await focusAppTab(appTabId);
}

/**
 * After opening Web EPOS for upload: fail fast if the site lands on /login (not logged in),
 * otherwise resolve the bridge promise so the app can continue. Product-create upload closes the tab when finished.
 */
