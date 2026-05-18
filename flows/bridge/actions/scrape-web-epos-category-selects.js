/**
 * Read the cascading `#catLevel{1..N}` selects on a Web EPOS product edit page
 * (or any EPOS page that renders them) and return the selected option labels
 * per tab. Read-only — no page mutations.
 *
 * Used by the upload audit preview: while the tabs are open after navigation,
 * we reverse-engineer the product's CG category from its Web EPOS selects, so
 * each audit row can be pre-filled with a categoryObject without the user
 * having to pick one manually.
 *
 * Payload: { tabIds: number[] }
 * Response: { ok: true, byTabId: { [tabId]: { labels, uuids, error? } } }
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_scrapeWebEposCategorySelects({ payload }) {
  const ids = Array.isArray(payload?.tabIds)
    ? payload.tabIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  const byTabId = {};

  await Promise.all(
    ids.map(async (tabId) => {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          /**
           * Event-driven read. Web EPOS populates `#catLevel{N}` selects asynchronously
           * — product detail fetch, category tree fetch, and React's cascade each
           * update the DOM at different moments. A MutationObserver fires the moment
           * any of those writes land, so we read exactly when there's something to
           * read (no polling interval, no fixed caller-side delay).
           *
           * Resolution rule: the levels are "stable" when reading them returns the
           * same chain twice across consecutive mutations AND no further levels are
           * appearing. The outer safety cap is the only time-based thing here and it
           * exists purely so a genuinely broken page doesn't hang the scrape forever.
           */
          func: async () => {
            const MAX_LEVELS = 10;
            const SAFETY_CAP_MS = 20000;
            /** Once we have a non-empty chain, settle quickly — children have rendered. */
            const STABILITY_MS_WITH_CHAIN = 250;
            /**
             * Empty chain after price loaded: do NOT settle immediately. Web EPOS
             * sometimes hydrates `#catLevel1` noticeably later than `#price` (the
             * category tree fetch resolves separately), so a short settle window
             * caused false "no category" reports. Wait this long with no chain
             * change before accepting empty as the real answer.
             */
            const STABILITY_MS_EMPTY = 4000;
            /** Backstop poll so we still pick up React property writes that don't trigger MutationObserver (controlled-select `select.value = ...`). */
            const POLL_INTERVAL_MS = 250;

            const readAll = () => {
              const out = { labels: [], uuids: [] };
              for (let level = 1; level <= MAX_LEVELS; level += 1) {
                const sel = document.getElementById(`catLevel${level}`);
                if (!sel) break;
                const opt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
                if (!opt || !opt.value) break;
                out.labels.push(String(opt.textContent || '').trim());
                out.uuids.push(String(opt.value || '').trim());
              }
              return out;
            };

            /**
             * Has the product detail finished loading? We use `#price` having a value as
             * the signal: Web EPOS fills every form field from the same product payload.
             * Note that this is necessary but not sufficient for "category state is final"
             * — `#catLevel1` can be set even later, which is why the empty-chain settle
             * window is much longer than the with-chain one.
             */
            const productLoaded = () => {
              const price = document.getElementById('price');
              if (!price) return false;
              return String(price.value || '').trim().length > 0;
            };

            return await new Promise((resolve) => {
              let settled = false;
              const finish = (result) => {
                if (settled) return;
                settled = true;
                obs.disconnect();
                clearTimeout(cap);
                clearInterval(poll);
                if (settleTimer) clearTimeout(settleTimer);
                resolve(result);
              };

              let lastChain = '';
              let settleTimer = null;
              const check = () => {
                if (!productLoaded()) return;

                const out = readAll();
                const chain = out.uuids.join('|');
                const stabilityMs = chain ? STABILITY_MS_WITH_CHAIN : STABILITY_MS_EMPTY;

                if (chain === lastChain) {
                  // Same chain reading — arm the quiet-window settle if not already armed.
                  if (!settleTimer) settleTimer = setTimeout(() => finish(out), stabilityMs);
                  return;
                }
                lastChain = chain;
                if (settleTimer) {
                  clearTimeout(settleTimer);
                  settleTimer = null;
                }
                settleTimer = setTimeout(() => finish(out), stabilityMs);
              };

              const obs = new MutationObserver(check);
              obs.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['value', 'selected'],
              });
              // React's controlled-select `select.value = uuid` updates the property
              // without producing a `selected`-attribute mutation, so a pure MO
              // approach can miss late category fills. Poll as a backstop.
              const poll = setInterval(check, POLL_INTERVAL_MS);
              const cap = setTimeout(() => finish(readAll()), SAFETY_CAP_MS);

              /** Initial read in case the DOM is already populated by the time we attach. */
              check();
            });
          },
        });
        const out = injected && injected[0] ? injected[0].result : null;
        byTabId[tabId] = out && Array.isArray(out.labels)
          ? { labels: out.labels, uuids: Array.isArray(out.uuids) ? out.uuids : [] }
          : { labels: [], uuids: [] };
      } catch (e) {
        byTabId[tabId] = { labels: [], uuids: [], error: e?.message || 'scrape failed' };
      }
    })
  );

  return { ok: true, byTabId };
}
