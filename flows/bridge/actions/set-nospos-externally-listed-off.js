/**
 * Untick `externally_listed` (a.k.a. "Manually Listed") on an open NosPos
 * stock-edit tab, then click Save. Mirrors `setWebEposProductOnSaleOff` —
 * caller opens the tab via `navigateNosposStockEditInWorker` and closes it
 * afterwards via `closeTabsByIds`.
 *
 * Save behaviour (verified against the existing repricing flow at
 * flows/nospos-repricing/page-handlers.js): NosPos's Save does a full form
 * POST and redirects back to `/stock/N/edit` (same URL, fresh page). So we:
 *
 *   1. Throttle + recover from any pre-existing NosPos 429 page (mirrors the
 *      park flow's SDK pattern in sdk/nospos-recovery.js). The Sync modal
 *      runs this action 4-wide and NosPos rate-limits aggressively, so this
 *      is also where we sleep a randomized jitter before the Save click.
 *   2. Inject script: wait for `#stock-externally_listed_at`, untick + dispatch
 *      change, sleep `preSaveDelayMs` (random — short for most, occasional
 *      longer spike), then click Save.
 *   3. Wait for the tab's `loading → complete` cycle (the post-save reload),
 *      tab removal, or a fixed fallback timeout.
 *   4. Re-run the 429 recovery on the post-save page. If NosPos returned 429,
 *      the SDK reloads back to a usable stock-edit page; the outer retry loop
 *      then sleeps NOSPOS_RATELIMIT_RETRY_BACKOFF_* and re-runs steps 1-5 on
 *      the fresh page (up to NOSPOS_RATELIMIT_MAX_ATTEMPTS times). Only after
 *      every attempt is exhausted do we surface a rate-limit error.
 *   5. Inject a verification script: confirm `#stock-externally_listed_at` is
 *      now unchecked on the freshly-served page. If the checkbox is missing
 *      (tab navigated elsewhere, e.g. /stock/search) treat as success too.
 *      If it's still checked, surface a clear "save didn't persist" error.
 *
 * Payload: { tabId: number }
 * Response: { ok: true, alreadyOff?: boolean } | { ok: false, error: string }
 */

const NOSPOS_UNTICK_FIELD_TIMEOUT_MS = 15000;
const NOSPOS_UNTICK_SAVE_WAIT_MS = 5000;

// Random pre-save jitter to break up parallel save bursts. Most calls get a
// short pause; a minority ("every now and then") wait a longer spike. Values
// chosen to keep the 4-wide pool comfortably under NosPos's 429 threshold
// while not noticeably slowing the typical sync.
const NOSPOS_UNTICK_BASE_MIN_MS = 200;
const NOSPOS_UNTICK_BASE_MAX_MS = 600;
const NOSPOS_UNTICK_SPIKE_MIN_MS = 1200;
const NOSPOS_UNTICK_SPIKE_MAX_MS = 2800;
const NOSPOS_UNTICK_SPIKE_PROB = 0.3;

function pickNosposUntickPreSaveDelayMs() {
  if (Math.random() < NOSPOS_UNTICK_SPIKE_PROB) {
    return Math.floor(
      NOSPOS_UNTICK_SPIKE_MIN_MS +
        Math.random() * (NOSPOS_UNTICK_SPIKE_MAX_MS - NOSPOS_UNTICK_SPIKE_MIN_MS),
    );
  }
  return Math.floor(
    NOSPOS_UNTICK_BASE_MIN_MS +
      Math.random() * (NOSPOS_UNTICK_BASE_MAX_MS - NOSPOS_UNTICK_BASE_MIN_MS),
  );
}

async function handleBridgeAction_setNosposExternallyListedOff({ payload }) {
  const tabId = Number(payload?.tabId);
  if (!Number.isFinite(tabId)) return { ok: false, error: 'Missing tabId' };

  // Pre-save throttle + 429 recovery (same SDK helpers the park flow uses).
  // If the tab is already showing a 429 page when we arrive, this reloads it.
  await throttleAndRecoverNospos429(tabId, 'setNosposExternallyListedOff:enter');

  // Retry loop: a post-save 429 reload puts the page back into a usable
  // stock-edit state, so we sleep + retry the save instead of failing the
  // item outright. Mirrors how the park flow keeps recovering after 429s.
  let lastError = null;
  for (let attempt = 1; attempt <= NOSPOS_RATELIMIT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const backoff =
        NOSPOS_RATELIMIT_RETRY_BACKOFF_MIN_MS +
        Math.floor(Math.random() * NOSPOS_RATELIMIT_RETRY_BACKOFF_JITTER_MS);
      await sleep(backoff);
    }
    const r = await tryNosposExternallyListedOffSave(tabId);
    if (r.kind === 'ok') return { ok: true, alreadyOff: !!r.alreadyOff };
    if (r.kind === 'rate-limited') {
      lastError = r.error || 'NosPos rate-limited the save (429).';
      continue; // page already reloaded by maybeRecoverNospos429Page
    }
    return { ok: false, error: r.error };
  }
  return {
    ok: false,
    error:
      lastError ||
      `NosPos rate-limited the save repeatedly — gave up after ${NOSPOS_RATELIMIT_MAX_ATTEMPTS} attempts.`,
  };
}

async function tryNosposExternallyListedOffSave(tabId) {
  const preSaveDelayMs = pickNosposUntickPreSaveDelayMs();

  let scriptResult;
  try {
    const exec = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [NOSPOS_UNTICK_FIELD_TIMEOUT_MS, preSaveDelayMs],
      func: async (fieldTimeoutMs, preSaveDelayMs) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitForCheckbox = () =>
          new Promise((resolve, reject) => {
            const sel = '#stock-externally_listed_at[type="checkbox"]';
            const found = document.querySelector(sel);
            if (found) return resolve(found);
            const deadline = Date.now() + fieldTimeoutMs;
            const tick = () => {
              const el = document.querySelector(sel);
              if (el) return resolve(el);
              if (Date.now() > deadline) {
                return reject(new Error('"Manually Listed" checkbox did not appear in time.'));
              }
              setTimeout(tick, 100);
            };
            tick();
          });

        let extEl;
        try {
          extEl = await waitForCheckbox();
        } catch (e) {
          return { ok: false, error: e.message };
        }

        if (!extEl.checked) return { ok: true, alreadyOff: true };

        extEl.checked = false;
        extEl.dispatchEvent(new Event('input', { bubbles: true }));
        extEl.dispatchEvent(new Event('change', { bubbles: true }));

        const saveBtn =
          document.querySelector('button.btn.btn-blue[type="submit"]') ||
          Array.from(document.querySelectorAll('button.btn.btn-blue')).find(
            (b) => (b.textContent || '').trim().includes('Save')
          );
        if (!saveBtn) return { ok: false, error: 'Save button not found.' };

        // Random pre-save jitter so 4-wide parallel saves don't all hit
        // NosPos in the same tick and trigger 429.
        if (preSaveDelayMs > 0) await sleep(preSaveDelayMs);

        // Re-assert off right before click in case anything tried to flip it back.
        if (extEl.checked) {
          extEl.checked = false;
          extEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        saveBtn.click();
        return { ok: true, alreadyOff: false, preSaveDelayMs };
      },
    });
    scriptResult = exec?.[0]?.result;
  } catch (e) {
    return { kind: 'error', error: e?.message || 'Untick script failed.' };
  }

  if (!scriptResult || !scriptResult.ok) {
    return { kind: 'error', error: scriptResult?.error || 'Untick script returned no result.' };
  }
  if (scriptResult.alreadyOff) return { kind: 'ok', alreadyOff: true };

  // Wait for the post-save page (loading → complete) or fallback timeout.
  await waitForNosposSavePosted(tabId, NOSPOS_UNTICK_SAVE_WAIT_MS);

  // If NosPos returned a 429 page after the save, the SDK reloads it back to
  // a usable stock-edit page. recovered=true means the save itself was
  // rate-limited and the untick did NOT persist — bubble that up so the outer
  // retry loop can sleep and try again on the now-fresh page.
  const recovery = await maybeRecoverNospos429Page(tabId, 'setNosposExternallyListedOff:postSave');
  if (recovery && recovery.recovered) {
    return {
      kind: 'rate-limited',
      error: 'NosPos rate-limited the save (429) — page reloaded.',
    };
  }

  // Verify the save took: re-read `#stock-externally_listed_at` on the
  // freshly-served page. If the checkbox is missing the tab has navigated
  // off the edit page (e.g. /stock/search), which is also a success signal.
  try {
    const verify = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const el = document.querySelector('#stock-externally_listed_at[type="checkbox"]');
        if (!el) return { ok: true };
        return { ok: !el.checked, stillChecked: !!el.checked };
      },
    });
    const v = verify?.[0]?.result;
    if (v && !v.ok) {
      return {
        kind: 'error',
        error: 'Save did not persist — Manually Listed is still ticked after reload.',
      };
    }
  } catch (_) {
    // executeScript can fail if the tab is unloading / gone. Treat as success.
  }
  return { kind: 'ok', alreadyOff: false };
}

function waitForNosposSavePosted(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}
