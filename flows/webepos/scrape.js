/**
 * Web EPOS product-scraping flow: in-page table scrape with waits, navigate-for-bridge,
 * and scrape-and-respond orchestration.
 */

async function scrapeWebEposProductsTableInPageWithWait(maxWaitMs) {
  const ms = Math.min(Math.max(Number(maxWaitMs) || 25000, 5000), 180000);
  const sleep = (t) => new Promise((r) => setTimeout(r, t));
  const host = typeof location !== 'undefined' ? location.hostname : '';
  const globalDeadline = Date.now() + ms;
  const MAX_PAGES = 200;

  /**
   * Event-driven wait: fires as soon as `predicate()` returns truthy after a DOM mutation.
   * Uses MutationObserver because `setTimeout`/`setInterval`/`requestAnimationFrame` are all
   * heavily throttled in minimized/background windows (clamp to ≥1s), while MO callbacks are
   * not — that's why focusing the window makes results arrive immediately.
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

  function rowLooksLikeProduct(tr) {
    const cells = tr.querySelectorAll('td');
    if (cells.length < 5) return false;
    const t = String(cells[0].textContent || '').trim();
    if (t.length < 4) return false;
    return true;
  }

  function scoreProductRows(table) {
    let n = 0;
    if (!table) return 0;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      if (rowLooksLikeProduct(tr)) n += 1;
    });
    return n;
  }

  /** Prefer the table with the most valid product rows (avoids grabbing a small/static table before the real grid). */
  function findProductsTable() {
    const seen = new Set();
    const list = [];
    const selectors = [
      '.col-sm-12 table',
      'div.col-sm-12 table',
      'table.table',
      'main table',
      '[class*="product"] table',
      'article table',
      '#root table',
      'body table',
    ];
    for (let i = 0; i < selectors.length; i += 1) {
      document.querySelectorAll(selectors[i]).forEach((t) => {
        if (t && !seen.has(t)) {
          seen.add(t);
          list.push(t);
        }
      });
    }
    if (list.length === 0) {
      document.querySelectorAll('table').forEach((t) => {
        if (!seen.has(t)) {
          seen.add(t);
          list.push(t);
        }
      });
    }
    let best = null;
    let bestScore = 0;
    for (let k = 0; k < list.length; k += 1) {
      const t = list[k];
      const s = scoreProductRows(t);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    return bestScore > 0 ? best : null;
  }

  function isUsableNextButton(b) {
    if (!b) return false;
    if (b.disabled) return false;
    if (b.classList.contains('disabled')) return false;
    if (String(b.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
    return true;
  }

  /**
   * Must not use container.querySelector('.paging') — that returns the *first* pager in the tree,
   * often a header/stub with no working Next, so we never click and only scrape page 1.
   */
  function findPagingNearTable(table) {
    const all = Array.from(document.querySelectorAll('.paging'));
    if (all.length === 0) return null;
    const hasUsableNext = (root) =>
      Array.from(root.querySelectorAll('button.next')).some(isUsableNextButton);

    if (!table) {
      for (let i = 0; i < all.length; i += 1) {
        if (hasUsableNext(all[i])) return all[i];
      }
      return all[0];
    }

    for (let i = 0; i < all.length; i += 1) {
      const p = all[i];
      const pos = table.compareDocumentPosition(p);
      if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue;
      if (!hasUsableNext(p)) continue;
      return p;
    }

    let n = table.nextElementSibling;
    for (let i = 0; i < 8 && n; i += 1) {
      if (n.matches && n.matches('.paging') && hasUsableNext(n)) return n;
      const inner = n.querySelector ? n.querySelector(':scope .paging') : null;
      if (inner && hasUsableNext(inner)) return inner;
      n = n.nextElementSibling;
    }

    for (let i = 0; i < all.length; i += 1) {
      if (hasUsableNext(all[i])) return all[i];
    }
    return all[0];
  }

  function extractFromTable(table) {
    const thead = table.querySelector('thead tr');
    const headers = thead
      ? Array.from(thead.querySelectorAll('th')).map((th) =>
          String(th.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
        )
      : [];
    const rows = [];
    table.querySelectorAll('tbody tr').forEach((tr) => {
      if (!rowLooksLikeProduct(tr)) return;
      const cells = tr.querySelectorAll('td');
      const bcLink = cells[0].querySelector('a');
      const lastCell = cells[cells.length - 1];
      const extLink =
        lastCell && lastCell.querySelector ? lastCell.querySelector('a[href^="http"]') : null;
      let productHref = bcLink ? bcLink.getAttribute('href') : null;
      if (productHref && productHref.startsWith('/') && host) {
        productHref = `https://${host}${productHref}`;
      }
      rows.push({
        barcode: (bcLink ? bcLink.textContent : cells[0].textContent || '')
          .trim()
          .replace(/\s+/g, ' '),
        productHref,
        productName: String(cells[1].textContent || '')
          .trim()
          .replace(/\s+/g, ' '),
        price: String(cells[2].textContent || '').trim(),
        quantity: String(cells[3].textContent || '').trim(),
        status: String(cells[4].textContent || '')
          .trim()
          .replace(/\s+/g, ' '),
        retailUrl: extLink && extLink.href ? extLink.href : null,
      });
    });
    const pagingRoot = findPagingNearTable(table);
    const pagingEl = pagingRoot ? pagingRoot.querySelector('p') : null;
    return {
      ok: true,
      headers,
      rows,
      pagingText: pagingEl
        ? String(pagingEl.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
        : null,
      pageUrl: typeof location !== 'undefined' ? location.href : '',
    };
  }

  function readPagingMeta(pagingRoot) {
    const root = pagingRoot || findPagingNearTable(findProductsTable());
    const el = root ? root.querySelector('p') : document.querySelector('.paging p');
    const raw = el
      ? String(el.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
      : '';
    const m = raw.match(/\bpage\s+(\d+)\s+of\s+(\d+)\b/i);
    let current = m ? Number(m[1]) : null;
    let total = m ? Number(m[2]) : null;
    if (root && (total == null || Number.isNaN(total))) {
      const tsp = root.querySelector('.total-page-count');
      const tm = tsp && String(tsp.textContent || '').match(/(\d+)/);
      if (tm) total = Number(tm[1]);
    }
    if (current != null && Number.isNaN(current)) current = null;
    if (total != null && Number.isNaN(total)) total = null;
    return { raw, current, total };
  }

  function pickNextFromPagingRoot(root) {
    if (!root) return null;
    const buttons = Array.from(root.querySelectorAll('button.next')).filter(isUsableNextButton);
    if (buttons.length === 0) return null;
    const single = buttons.find((b) => String(b.textContent || '').trim() === '»');
    return single || buttons[0];
  }

  function findNextPageButton(pagingRoot) {
    const direct = pickNextFromPagingRoot(pagingRoot);
    if (direct) return direct;
    const pagings = document.querySelectorAll('.paging');
    for (let i = 0; i < pagings.length; i += 1) {
      const b = pickNextFromPagingRoot(pagings[i]);
      if (b) return b;
    }
    return null;
  }

  function triggerClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {}
    try {
      el.focus();
    } catch (_) {}
    try {
      if (typeof el.click === 'function') el.click();
    } catch (_) {}
    try {
      el.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      );
    } catch (_) {}
  }

  function tableBarcodeSignature(table) {
    const parts = [];
    if (!table) return '';
    table.querySelectorAll('tbody tr').forEach((tr) => {
      if (!rowLooksLikeProduct(tr)) return;
      const cells = tr.querySelectorAll('td');
      const bc = String(cells[0].textContent || '')
        .trim()
        .replace(/\s+/g, ' ');
      if (bc) parts.push(bc);
    });
    const joined = parts.join('|');
    return joined.length > 4000 ? joined.slice(0, 4000) : joined;
  }

  function tryJumpToPageNum(targetPage, pagingRoot) {
    const root = pagingRoot || document.querySelector('.paging');
    const jump = root
      ? root.querySelector('.jump-to-page')
      : document.querySelector('.paging .jump-to-page') || document.querySelector('.jump-to-page');
    if (!jump) return false;
    const inp = jump.querySelector('input[type="number"]');
    const go =
      jump.querySelector('button.go-to-page-button') ||
      (root && root.querySelector('button.go-to-page-button')) ||
      document.querySelector('.paging button.go-to-page-button');
    if (!inp || !go) return false;
    try {
      inp.focus();
    } catch (_) {}
    inp.value = String(targetPage);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    triggerClick(go);
    return true;
  }

  let table = null;
  await waitForDomCondition(() => {
    table = findProductsTable();
    return table && scoreProductRows(table) > 0;
  }, globalDeadline - Date.now());
  if (!table || scoreProductRows(table) === 0) {
    return { ok: false, error: 'Products table not found on this page.' };
  }

  const allRows = [];
  let headers = [];
  const pagePagingTexts = [];
  for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx += 1) {
    table = findProductsTable();
    if (!table || scoreProductRows(table) === 0) {
      if (pageIdx === 0) {
        return { ok: false, error: 'Products table not found on this page.' };
      }
      break;
    }

    const extracted = extractFromTable(table);
    if (!extracted.ok) return extracted;
    if (pageIdx === 0) headers = extracted.headers;
    allRows.push(...extracted.rows);
    if (extracted.pagingText) pagePagingTexts.push(extracted.pagingText);

    const pagingRoot = findPagingNearTable(table);
    const metaAfter = readPagingMeta(pagingRoot);
    if (
      metaAfter.current != null &&
      metaAfter.total != null &&
      metaAfter.current >= metaAfter.total
    ) {
      break;
    }

    const nextBtn = findNextPageButton(pagingRoot);
    if (!nextBtn) break;

    const prevSig = tableBarcodeSignature(table);
    const prevPage = metaAfter.current;
    triggerClick(nextBtn);

    /**
     * Pager text ("page 2 of 2") often updates before tbody rows swap; do not treat meta alone as done.
     * Wait (event-driven) until the product-row barcode signature changes — MO fires on the row swap
     * even in a minimized window, so we move on immediately instead of waiting for a throttled timer.
     */
    let nextTable = null;
    const sigChanged = await waitForDomCondition(() => {
      const t2 = findProductsTable();
      if (!t2 || scoreProductRows(t2) === 0) return false;
      const sig2 = tableBarcodeSignature(t2);
      if (!sig2 || sig2 === prevSig) return false;
      nextTable = t2;
      return true;
    }, globalDeadline - Date.now());

    let navOk = false;
    if (sigChanged && nextTable) {
      table = nextTable;
      navOk = true;
    } else if (prevPage != null && metaAfter.total != null && prevPage < metaAfter.total) {
      tryJumpToPageNum(prevPage + 1, pagingRoot);
      nextTable = null;
      const jumpChanged = await waitForDomCondition(() => {
        const t3 = findProductsTable();
        if (!t3 || scoreProductRows(t3) === 0) return false;
        const sig3 = tableBarcodeSignature(t3);
        if (!sig3 || sig3 === prevSig) return false;
        nextTable = t3;
        return true;
      }, globalDeadline - Date.now());
      if (jumpChanged && nextTable) {
        table = nextTable;
        navOk = true;
      }
    }

    if (!navOk) break;
  }

  const pagingText =
    pagePagingTexts.length <= 1
      ? pagePagingTexts[0] || null
      : `${pagePagingTexts[0]} · ${pagePagingTexts.length} pages (${allRows.length} rows)`;

  // Capture the store the operator has selected in the Web EPOS store filter so
  // the app can show "Displayed products from <store> store" alongside the rows.
  let storeId = null;
  let storeName = null;
  try {
    const storeSel = document.querySelector('#storeId, select[name="storeId"]');
    if (storeSel) {
      storeId = storeSel.value || null;
      const opt = storeSel.selectedOptions && storeSel.selectedOptions[0];
      storeName = opt ? String(opt.textContent || '').trim() : null;
    }
  } catch (_) {}

  // Capture the Status filter (#status: onsale/soldout/unavailable/uploading) the
  // list was filtered to, so the app can show "scraped from <status>" and the
  // open-product flow can switch back to the same status before finding a row.
  let statusValue = null;
  let statusLabel = null;
  try {
    const statusSel = document.querySelector('#status, select[name="status"]');
    if (statusSel) {
      statusValue = statusSel.value || null;
      const opt = statusSel.selectedOptions && statusSel.selectedOptions[0];
      statusLabel = opt ? String(opt.textContent || '').trim() : null;
    }
  } catch (_) {}

  return {
    ok: true,
    headers,
    rows: allRows,
    pagingText,
    pageUrl: typeof location !== 'undefined' ? location.href : '',
    storeId,
    storeName,
    statusValue,
    statusLabel,
  };
}

/**
 * Core: open a Web EPOS product in a fresh unfocused tab by navigating the list
 * page and clicking the real link (in-app routing needs `storeId` from the session).
 * Returns the opened tabId on success so the caller can decide whether to focus
 * or close it.
 *
 * Only used by `navigateWebEposProductInWorkerForBridge`, which is itself the
 * single canonical opener behind the `navigateWebEposProductInWorker` bridge
 * action. Keep optimisations here or in that wrapper so every caller benefits.
 */
async function openWebEposProductInTab(appTabId, productHref, barcode, targetStore, targetStatus) {
  const hrefRaw = String(productHref || '').trim();
  const code = String(barcode || '').trim();
  if (!hrefRaw) {
    return { ok: false, error: 'Missing product link.' };
  }
  let parsed;
  try {
    parsed = new URL(hrefRaw);
  } catch {
    return { ok: false, error: 'Invalid product link.' };
  }
  if (parsed.hostname.toLowerCase() !== WEB_EPOS_UPLOAD_HOST) {
    return { ok: false, error: 'Link is not a Web EPOS URL.' };
  }

  let appTab;
  try {
    appTab = await chrome.tabs.get(appTabId);
  } catch {
    return { ok: false, error: 'Could not read the CG Suite tab.' };
  }
  const windowId = appTab.windowId;

  let navTabId = null;
  try {
    const created = await chrome.tabs.create({
      windowId,
      url: WEB_EPOS_PRODUCTS_URL,
      active: false,
    });
    navTabId = created.id;
    await waitForTabLoadComplete(navTabId, 90000, 'Web EPOS products page load timed out');
    const loaded = await chrome.tabs.get(navTabId);
    const u = String(loaded.url || '').trim();
    if (!u) {
      await chrome.tabs.remove(navTabId).catch(() => {});
      navTabId = null;
      return { ok: false, error: 'Could not read Web EPOS URL after load.' };
    }
    let loadParsed;
    try {
      loadParsed = new URL(u);
    } catch {
      await chrome.tabs.remove(navTabId).catch(() => {});
      navTabId = null;
      return { ok: false, error: 'Invalid Web EPOS URL after load.' };
    }
    if (loadParsed.hostname.toLowerCase() !== WEB_EPOS_UPLOAD_HOST) {
      await chrome.tabs.remove(navTabId).catch(() => {});
      navTabId = null;
      return { ok: false, error: 'Not on Web EPOS after load.' };
    }
    const loadPath = (loadParsed.pathname || '/').toLowerCase();
    if (WEB_EPOS_LOGIN_PATH.test(loadPath)) {
      await chrome.tabs.remove(navTabId).catch(() => {});
      navTabId = null;
      return { ok: false, error: 'You must be logged into Web EPOS to open products.' };
    }
    await sleep(400);

    // Filter the products list to the store the listings came from before walking
    // it — otherwise the product may be hidden behind a different store filter.
    // If that store isn't selectable, bail (caller closes the tab + tells the user).
    if (targetStore && (targetStore.storeId || targetStore.storeName)) {
      const storeSwitch = await injectWebEposSelectStoreOrFail(navTabId, targetStore);
      if (!storeSwitch.ok) {
        await chrome.tabs.remove(navTabId).catch(() => {});
        navTabId = null;
        if (storeSwitch.notFound) {
          return { ok: false, storeNotFound: true, error: 'Listings store not available in Web EPOS.' };
        }
        return { ok: false, error: storeSwitch.error || 'Could not set the Web EPOS store.' };
      }
    }

    // Then switch to the product's status (On Sale / Sold Out / …) — Web EPOS
    // only lists one status at a time, so without this a Sold Out item is invisible
    // while the filter sits on On Sale. Best-effort: never fails the open.
    if (targetStatus) {
      await injectWebEposSelectStatusOrSkip(navTabId, targetStatus).catch(() => {});
    }

    // Find the product, cycling the Status filter on miss: Web EPOS lists one
    // status at a time, so a Sold Out item is invisible while the filter sits on
    // On Sale. We try the product's own status first (switched above), then walk
    // the remaining statuses until found — this is what makes the open work for
    // products on a non-default store/status, not just the main store.
    let res = null;
    const triedStatuses = new Set();
    const upfrontStatus = String(targetStatus || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (upfrontStatus) triedStatuses.add(upfrontStatus);
    const STATUS_CYCLE = ['onsale', 'soldout', 'unavailable', 'uploading'];

    for (let findAttempt = 0; findAttempt <= STATUS_CYCLE.length; findAttempt += 1) {
      if (findAttempt > 0) {
        const nextStatus = STATUS_CYCLE.find((s) => !triedStatuses.has(s));
        if (!nextStatus) break;
        triedStatuses.add(nextStatus);
        const sw = await injectWebEposSelectStatusOrSkip(navTabId, nextStatus).catch(() => null);
        if (!sw || sw.noSelect) break; // no Status filter on this page → cycling can't help
      }
      const injected = await chrome.scripting.executeScript({
      target: { tabId: navTabId },
      func: async (fullHref, barcodeText) => {
        const MAX_PAGES = 200;
        const TABLE_LOAD_WAIT_MS = 30000;

        /**
         * Event-driven wait — unthrottled in minimized windows (MutationObserver beats setTimeout
         * which clamps to ≥1s when the window isn't focused).
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

        function firstProductTbodyRowBarcode() {
          const tr = document.querySelector('tbody tr');
          if (!tr) return '';
          const cell = tr.querySelector('td');
          return cell ? String(cell.textContent || '').trim().replace(/\s+/g, ' ') : '';
        }

        /**
         * Web EPOS renders the products page in two stages: the layout (including
         * the .paging stub) is in the SSR/initial markup, but the actual <tbody>
         * rows are populated after a separate API fetch. Mirrors the
         * `waitForDomCondition` gate used by `scrapeWebEposProductsTableInPageWithWait`
         * — without this gate, `tryClickFromDom` runs against an empty tbody on
         * page 1, falls through to clicking Next, and either bails (no .paging yet)
         * or skips page 1 entirely.
         */
        function tableHasProductRows() {
          const rows = document.querySelectorAll('tbody tr');
          for (let i = 0; i < rows.length; i += 1) {
            const td = rows[i].querySelector('td');
            if (td && String(td.textContent || '').trim().length > 0) return true;
          }
          return false;
        }

        function normPath(h) {
          try {
            const u = new URL(h, location.origin);
            return (u.pathname || '') + (u.search || '') + (u.hash || '');
          } catch {
            return String(h || '');
          }
        }

        const targetPath = normPath(fullHref);
        let targetAbs = '';
        try {
          targetAbs = new URL(fullHref).href;
        } catch (_) {}

        function tryClickFromDom() {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          for (let i = 0; i < anchors.length; i += 1) {
            const a = anchors[i];
            const raw = a.getAttribute('href') || '';
            if (!raw) continue;
            if (normPath(raw) === targetPath) {
              a.click();
              return true;
            }
            if (targetAbs && a.href === targetAbs) {
              a.click();
              return true;
            }
          }
          const want = String(barcodeText || '')
            .trim()
            .replace(/\s+/g, ' ');
          if (want) {
            const rows = document.querySelectorAll('tbody tr');
            for (let j = 0; j < rows.length; j += 1) {
              const tr = rows[j];
              const cell0 = tr.querySelector('td');
              if (!cell0) continue;
              const text = String(cell0.textContent || '')
                .trim()
                .replace(/\s+/g, ' ');
              if (text === want) {
                const link = cell0.querySelector('a');
                if (link) {
                  link.click();
                  return true;
                }
              }
            }
          }
          return false;
        }

        function isUsableNextButton(b) {
          if (!b) return false;
          if (b.disabled) return false;
          if (b.classList.contains('disabled')) return false;
          if (String(b.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
          return true;
        }

        function pickNextButton() {
          const buttons = Array.from(document.querySelectorAll('.paging button.next')).filter(
            isUsableNextButton
          );
          if (buttons.length === 0) return null;
          const single = buttons.find((b) => String(b.textContent || '').trim() === '»');
          return single || buttons[0];
        }

        async function jumpToProductsPageOne() {
          const jump =
            document.querySelector('.paging .jump-to-page') ||
            document.querySelector('.jump-to-page');
          const inp = jump && jump.querySelector('input[type="number"]');
          const go =
            (jump && jump.querySelector('button.go-to-page-button')) ||
            document.querySelector('.paging button.go-to-page-button');
          if (!inp || !go) return false;
          try {
            inp.focus();
          } catch (_) {}
          const beforeBc = firstProductTbodyRowBarcode();
          inp.value = '1';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            go.click();
          } catch (_) {}
          /**
           * Wait for rows to actually swap — but cap short. If we're already on page 1 the
           * "go" click is a no-op and the barcode never changes; without a cap we'd sit here
           * until the 120s deadline. 1500ms covers a real re-render while staying snappy on
           * the common already-on-page-1 path.
           */
          await waitForDomCondition(() => {
            const bc = firstProductTbodyRowBarcode();
            return bc && bc !== beforeBc;
          }, 1500);
          return true;
        }

        // Wait for the table to actually populate before searching. If this
        // gate ever times out the loop below will still try (might recover
        // mid-render), but the common case is that we proceed only once the
        // first row is visible.
        await waitForDomCondition(tableHasProductRows, TABLE_LOAD_WAIT_MS);

        await jumpToProductsPageOne();

        for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx += 1) {
          if (tryClickFromDom()) {
            return { ok: true, via: 'paged', pageIdx };
          }
          const nextBtn = pickNextButton();
          if (!nextBtn) break;
          const beforeBc = firstProductTbodyRowBarcode();
          nextBtn.click();
          /**
           * Per-page cap: real paginations settle well inside this window; a silently
           * no-op click (button disabled mid-transition, race with React) returns control
           * quickly so the next iteration re-reads the DOM instead of stalling.
           */
          const changed = await waitForDomCondition(() => {
            const bc = firstProductTbodyRowBarcode();
            return bc && bc !== beforeBc;
          }, 6000);
          if (!changed) break;
        }

        return { ok: false, error: 'NOT_FOUND' };
      },
      args: [hrefRaw, code],
      });
      res = injected && injected[0] ? injected[0].result : null;
      if (res && res.ok) break;
      // Stop on a real error (login/etc.); keep cycling only on NOT_FOUND.
      if (res && res.error && res.error !== 'NOT_FOUND') break;
    }
    if (!res || !res.ok) {
      if (navTabId != null) {
        await chrome.tabs.remove(navTabId).catch(() => {});
        navTabId = null;
      }
      return {
        ok: false,
        error:
          res && res.error === 'NOT_FOUND'
            ? 'That product was not found in the Web EPOS list (try again after the table has fully loaded).'
            : (res && res.error) || 'Could not open the product in Web EPOS.',
      };
    }

    return { ok: true, tabId: navTabId };
  } catch (e) {
    if (navTabId != null) {
      await chrome.tabs.remove(navTabId).catch(() => {});
    }
    return {
      ok: false,
      error: e && e.message ? String(e.message) : 'Could not open Web EPOS.',
    };
  }
}

/**
 * Bridge-level opener — the one canonical path used by:
 *  - Click-a-barcode in the Web EPOS products table (focusOnSuccess: true)
 *  - Audit-mode preview batch (focusOnSuccess: false, caller closes the tab)
 *
 * Return shape: `{ ok: true, tabId } | { ok: false, error }`. `tabId` is always
 * returned on success so batch callers can close it later.
 *
 * Keep changes to this function — it's the sole open path, so any speedups here
 * benefit every caller.
 */
async function navigateWebEposProductInWorkerForBridge(appTabId, productHref, barcode, options = {}) {
  // Web EPOS always loads with the first store selected, so a product that lives
  // under a different store won't be in the list until we switch. Pre-filter to
  // the store the snapshot came from (resolved by the caller: payload store or
  // the scrape's persisted store) before walking the list to find the product.
  // Same idea for the product's status (the list only shows one status at a time).
  const opened = await openWebEposProductInTab(
    appTabId,
    productHref,
    barcode,
    options.targetStore || null,
    options.targetStatus || null,
  );
  if (!opened.ok) {
    if (opened.storeNotFound) {
      return { ok: false, error: webEposStoreNotAvailableMessage(options.targetStore) };
    }
    return { ok: false, error: opened.error };
  }

  if (options.focusOnSuccess !== false) {
    try {
      const t = await chrome.tabs.get(opened.tabId);
      if (t.windowId != null) {
        await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(opened.tabId, { active: true }).catch(() => {});
    } catch (_) { /* tab gone — treat as success; opener already saw the open */ }
  }
  return { ok: true, tabId: opened.tabId };
}

/**
 * Send WEBEPOS_WAITING_FOR_DATA to the Web EPOS worker tab so its content script
 * shows the "filter then allow" panel. Retries because the content script may not
 * be ready the instant the products page finishes loading. Mirrors the eBay
 * `sendWaitingForData` handshake.
 */
async function sendWebEposWaitingForData(tabId, requestId, storeHint, retriesLeft) {
  const payload = {
    type: 'WEBEPOS_WAITING_FOR_DATA',
    requestId,
    nosposShop: storeHint?.nosposShop || null,
    expectedShopMatch: storeHint?.expectedShopMatch || null,
    expectedCgShopName: storeHint?.expectedCgShopName || null,
  };
  try {
    await chrome.tabs.sendMessage(tabId, payload);
    return true;
  } catch (err) {
    if (retriesLeft > 0) {
      await sleep(300);
      return sendWebEposWaitingForData(tabId, requestId, storeHint, retriesLeft - 1);
    }
    return false;
  }
}

/**
 * Reload-persistence: the Web EPOS products content script re-announces itself
 * via WEBEPOS_PAGE_READY on every (re)load. If a scrape is still pending for that
 * exact tab, re-send WEBEPOS_WAITING_FOR_DATA so the filter/allow panel comes
 * back — the operator can reload the page (or apply a filter that reloads it)
 * without losing the panel. Mirrors handleListingPageReady for the CeX/eBay flow.
 */
async function handleWebEposPageReady(senderTabId) {
  if (senderTabId == null) return { ok: false };
  const pending = await getPending();
  let requestId = null;
  for (const [rid, entry] of Object.entries(pending)) {
    if (
      entry &&
      entry.type === 'webEposScrape' &&
      Number(entry.listingTabId) === Number(senderTabId)
    ) {
      requestId = rid;
      break;
    }
  }
  if (!requestId) return { ok: false };
  const session = await readWebEposUploadSession();
  await sendWebEposWaitingForData(
    senderTabId,
    requestId,
    {
      nosposShop: session?.nosposShop || null,
      expectedShopMatch: session?.expectedShopMatch || null,
      expectedCgShopName: session?.expectedCgShopName || null,
    },
    4
  );
  return { ok: true };
}

/**
 * Step 1 of the product scrape: instead of scraping immediately, navigate the
 * worker tab to the products page and ask its content script to show the
 * filter/allow panel. The actual scrape happens in `handleWebEposScrapeConfirm`
 * once the operator clicks "Get these products". This mirrors the eBay flow
 * (LISTING_PAGE_READY → WAITING_FOR_DATA → user confirms → SCRAPED_DATA) so the
 * operator can filter to the right store before any data leaves the page.
 */
async function scrapeWebEposProductsAndRespond(requestId, appTabId) {
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

  try {
    const session = await readWebEposUploadSession();
    if (
      !session?.workerTabId ||
      Number(session.appTabId) !== Number(appTabId)
    ) {
      await respondErr(
        'No Web EPOS window for this session. Open the Upload module and wait for Web EPOS to load.'
      );
      return;
    }
    let tabId = session.workerTabId;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      await respondErr(
        'The Web EPOS window was closed. Reopen it from the launchpad prompt.'
      );
      return;
    }
    await chrome.tabs.update(tabId, { url: WEB_EPOS_PRODUCTS_URL });
    await waitForTabLoadComplete(tabId, 90000, 'Web EPOS products page load timed out');
    const tab = await chrome.tabs.get(tabId);
    const u = (tab.url || '').trim();
    if (!u) {
      await respondErr('Could not read Web EPOS URL.');
      return;
    }
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      await respondErr('Invalid Web EPOS URL.');
      return;
    }
    if (parsed.hostname.toLowerCase() !== WEB_EPOS_UPLOAD_HOST) {
      await respondErr('Not on Web EPOS.');
      return;
    }
    const path = (parsed.pathname || '/').toLowerCase();
    if (WEB_EPOS_LOGIN_PATH.test(path)) {
      await respondErr('You must be logged into Web EPOS to view products.');
      return;
    }

    // Default the Web EPOS store filter to the Cash EPOS branch the operator is
    // on, so the products list (and any audit / upload) is scoped to the store
    // they're working — no manual "switch store" step. Only Web EPOS is switched
    // here; the NosPos branch is left to the operator (the openWebEposUpload
    // preflight already gated NosPos). Non-fatal: if the branch isn't selectable
    // we log and carry on — the page still loads and the hub's store-match gate
    // still guards any write.
    const cgBranch = session.expectedCgShopName || session.expectedShopMatch || '';
    if (cgBranch) {
      let outcome;
      try {
        const storeDefault = await injectWebEposSelectStoreOrFail(tabId, { storeName: cgBranch });
        outcome = {
          requested: cgBranch,
          ok: !!storeDefault?.ok,
          selected: storeDefault?.selected || null,
          notFound: !!storeDefault?.notFound,
          skipped: !!storeDefault?.skipped,
        };
        console.log('[CG Suite] Web EPOS uploader: defaulted store to Cash EPOS branch', outcome);
      } catch (e) {
        outcome = { requested: cgBranch, ok: false, error: e?.message || String(e) };
        console.log('[CG Suite] Web EPOS uploader: store default failed', outcome);
      }
      // Stash the outcome so the scrape response (step 2) can carry it back to the
      // page, which toasts which store Web EPOS was set to (or that it couldn't be).
      await writeWebEposUploadSession({ storeDefault: outcome });
    }

    await sleep(400);

    // Bring the Web EPOS tab to the foreground so the operator lands on it and
    // can filter the products list — mirrors how the CeX flow focuses the tab it
    // opens. Focus is handed back to the app once they hit "Get these products"
    // (handleWebEposScrapeConfirm) or Cancel (handleWebEposScrapeCancel).
    try {
      const wt = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (wt.windowId != null) {
        await chrome.windows.update(wt.windowId, { focused: true });
      }
    } catch (_) {}

    // Register the pending scrape, then ask the content script to show the
    // filter/allow panel. We deliberately do NOT respond to the app yet — the
    // app keeps waiting until the operator confirms (or cancels) on Web EPOS.
    const pending = await getPending();
    pending[requestId] = { appTabId, listingTabId: tabId, type: 'webEposScrape' };
    await setPending(pending);

    const sent = await sendWebEposWaitingForData(
      tabId,
      requestId,
      {
        nosposShop: session.nosposShop || null,
        expectedShopMatch: session.expectedShopMatch || null,
        expectedCgShopName: session.expectedCgShopName || null,
      },
      8
    );
    if (!sent) {
      await clearPendingRequest(requestId);
      await respondErr('Could not show the product picker on the Web EPOS tab.');
      return;
    }
  } catch (e) {
    await clearPendingRequest(requestId).catch(() => {});
    await respondErr(e?.message || 'Failed to load Web EPOS products.');
  }
}

/**
 * Step 2: the operator clicked "Get these products" on the Web EPOS panel.
 * Scrape the (now filtered) products table and respond to the app, then close
 * the worker tab. Sender-tab is validated against the pending entry so a stray
 * message can't trigger a scrape of the wrong tab.
 */
async function handleWebEposScrapeConfirm(requestId, senderTabId) {
  const pending = await getPending();
  const entry = pending[requestId];
  if (!entry || entry.type !== 'webEposScrape') return { ok: false };
  const appTabId = entry.appTabId;
  const tabId = entry.listingTabId;
  if (senderTabId != null && Number(senderTabId) !== Number(tabId)) {
    return { ok: false };
  }
  // Remove the pending entry up-front so a double-click can't scrape twice.
  delete pending[requestId];
  await setPending(pending);

  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: scrapeWebEposProductsTableInPageWithWait,
      args: [120000],
    });
    const payload = injected && injected[0] ? injected[0].result : null;
    if (!payload || !payload.ok) {
      await notifyAppExtensionResponse(appTabId, requestId, {
        ok: false,
        error: payload?.error || 'Could not read products from Web EPOS.',
      });
      await focusAppTab(appTabId);
      return { ok: false };
    }
    // NosPos navbar shop label captured at upload-session open (preflight). The
    // app persists it as the product's NosPos store alongside the Web EPOS store.
    let nosposShop = null;
    let storeDefault = null;
    try {
      const sPre = await readWebEposUploadSession();
      nosposShop = (sPre && sPre.nosposShop) || null;
      storeDefault = (sPre && sPre.storeDefault) || null;
    } catch (_) {}
    await notifyAppExtensionResponse(appTabId, requestId, {
      ok: true,
      headers: payload.headers,
      rows: payload.rows,
      pagingText: payload.pagingText,
      pageUrl: payload.pageUrl,
      storeId: payload.storeId || null,
      storeName: payload.storeName || null,
      statusValue: payload.statusValue || null,
      statusLabel: payload.statusLabel || null,
      nosposShop,
      // Outcome of defaulting the Web EPOS store filter to the Cash EPOS branch
      // (set in step 1) — the page toasts it.
      storeDefault,
    });
    // Operator hit "Get these products" — return them to Cash EPOS, same as the
    // CeX flow focuses the app tab after SCRAPED_DATA.
    await focusAppTab(appTabId);
    try {
      const s2 = await readWebEposUploadSession();
      const lastUrl = payload.pageUrl || s2?.lastUrl || WEB_EPOS_PRODUCTS_URL;
      if (s2 && Number(s2.appTabId) === Number(appTabId)) {
        await writeWebEposUploadSession({
          workerTabId: null,
          appTabId,
          lastUrl,
          nosposShop: s2.nosposShop || null,
          // Remember the store the listings came from so later audit/upload flows
          // can switch Web EPOS back to it (backup for the store the app also
          // passes explicitly in the action payload).
          scrapedStoreId: payload.storeId || null,
          scrapedStoreName: payload.storeName || null,
        });
      }
      await removeWebEposWorkerByTabId(tabId);
    } catch (_) {}
    return { ok: true };
  } catch (e) {
    await notifyAppExtensionResponse(appTabId, requestId, {
      ok: false,
      error: e?.message || 'Failed to read Web EPOS products.',
    });
    await focusAppTab(appTabId);
    return { ok: false };
  }
}

/**
 * Step 2 (alt): the operator dismissed the panel without allowing. Tell the app
 * the sync was cancelled, return focus to Cash EPOS, and CLOSE the Web EPOS
 * worker tab (same as a successful scrape) — cancelling should not leave a stray
 * Web EPOS tab behind. A later Re-get reopens a fresh worker tab.
 */
async function handleWebEposScrapeCancel(requestId, senderTabId) {
  const pending = await getPending();
  const entry = pending[requestId];
  if (!entry || entry.type !== 'webEposScrape') return { ok: false };
  const appTabId = entry.appTabId;
  const tabId = entry.listingTabId;
  if (senderTabId != null && Number(senderTabId) !== Number(tabId)) {
    return { ok: false };
  }
  delete pending[requestId];
  await setPending(pending);
  await notifyAppExtensionResponse(appTabId, requestId, {
    ok: false,
    cancelled: true,
    error: 'Product sync cancelled.',
  });
  // Return focus to Cash EPOS, then close the worker tab so cancel tidies up
  // after itself instead of leaving the Web EPOS tab open behind the app.
  await focusAppTab(appTabId);
  try {
    const s2 = await readWebEposUploadSession();
    if (s2 && Number(s2.appTabId) === Number(appTabId)) {
      await writeWebEposUploadSession({
        workerTabId: null,
        appTabId,
        lastUrl: s2.lastUrl || WEB_EPOS_PRODUCTS_URL,
      });
    }
    await removeWebEposWorkerByTabId(tabId);
  } catch (_) {}
  return { ok: true };
}
