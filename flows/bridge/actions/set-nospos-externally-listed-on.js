/**
 * Tick `externally_listed` (a.k.a. "Manually Listed") on an open NosPos
 * stock-edit tab, then click Save. Mirror of `set-nospos-externally-listed-off.js`
 * — caller opens the tab via `navigateNosposStockEditInWorker` and closes it
 * afterwards via `closeTabsByIds`.
 *
 * Same throttle/jitter/429-retry/verify pipeline as the off-variant; the only
 * functional differences are `extEl.checked = true` and an inverted final
 * verify. Post-save 429s reload the page and the outer loop retries the save
 * up to NOSPOS_RATELIMIT_MAX_ATTEMPTS times before giving up.
 *
 * Payload: { tabId: number }
 * Response: { ok: true, alreadyOn?: boolean } | { ok: false, error: string }
 */

const NOSPOS_TICK_FIELD_TIMEOUT_MS = 15000;
const NOSPOS_TICK_SAVE_WAIT_MS = 5000;

const NOSPOS_TICK_BASE_MIN_MS = 200;
const NOSPOS_TICK_BASE_MAX_MS = 600;
const NOSPOS_TICK_SPIKE_MIN_MS = 1200;
const NOSPOS_TICK_SPIKE_MAX_MS = 2800;
const NOSPOS_TICK_SPIKE_PROB = 0.3;

function pickNosposTickPreSaveDelayMs() {
  if (Math.random() < NOSPOS_TICK_SPIKE_PROB) {
    return Math.floor(
      NOSPOS_TICK_SPIKE_MIN_MS +
        Math.random() * (NOSPOS_TICK_SPIKE_MAX_MS - NOSPOS_TICK_SPIKE_MIN_MS),
    );
  }
  return Math.floor(
    NOSPOS_TICK_BASE_MIN_MS +
      Math.random() * (NOSPOS_TICK_BASE_MAX_MS - NOSPOS_TICK_BASE_MIN_MS),
  );
}

async function handleBridgeAction_setNosposExternallyListedOn({ payload }) {
  const tabId = Number(payload?.tabId);
  if (!Number.isFinite(tabId)) return { ok: false, error: 'Missing tabId' };

  await throttleAndRecoverNospos429(tabId, 'setNosposExternallyListedOn:enter');

  // Mirror of the off-action: retry the save after a 429 reload instead of
  // failing the item outright.
  let lastError = null;
  for (let attempt = 1; attempt <= NOSPOS_RATELIMIT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const backoff =
        NOSPOS_RATELIMIT_RETRY_BACKOFF_MIN_MS +
        Math.floor(Math.random() * NOSPOS_RATELIMIT_RETRY_BACKOFF_JITTER_MS);
      await sleep(backoff);
    }
    const r = await tryNosposExternallyListedOnSave(tabId);
    if (r.kind === 'ok') return { ok: true, alreadyOn: !!r.alreadyOn };
    if (r.kind === 'rate-limited') {
      lastError = r.error || 'NosPos rate-limited the save (429).';
      continue;
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

async function tryNosposExternallyListedOnSave(tabId) {
  const preSaveDelayMs = pickNosposTickPreSaveDelayMs();

  let scriptResult;
  try {
    const exec = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [NOSPOS_TICK_FIELD_TIMEOUT_MS, preSaveDelayMs],
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

        if (extEl.checked) return { ok: true, alreadyOn: true };

        extEl.checked = true;
        extEl.dispatchEvent(new Event('input', { bubbles: true }));
        extEl.dispatchEvent(new Event('change', { bubbles: true }));

        const saveBtn =
          document.querySelector('button.btn.btn-blue[type="submit"]') ||
          Array.from(document.querySelectorAll('button.btn.btn-blue')).find(
            (b) => (b.textContent || '').trim().includes('Save')
          );
        if (!saveBtn) return { ok: false, error: 'Save button not found.' };

        if (preSaveDelayMs > 0) await sleep(preSaveDelayMs);

        if (!extEl.checked) {
          extEl.checked = true;
          extEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        saveBtn.click();
        return { ok: true, alreadyOn: false, preSaveDelayMs };
      },
    });
    scriptResult = exec?.[0]?.result;
  } catch (e) {
    return { kind: 'error', error: e?.message || 'Tick script failed.' };
  }

  if (!scriptResult || !scriptResult.ok) {
    return { kind: 'error', error: scriptResult?.error || 'Tick script returned no result.' };
  }
  if (scriptResult.alreadyOn) return { kind: 'ok', alreadyOn: true };

  await waitForNosposExternallyListedOnSavePosted(tabId, NOSPOS_TICK_SAVE_WAIT_MS);

  const recovery = await maybeRecoverNospos429Page(tabId, 'setNosposExternallyListedOn:postSave');
  if (recovery && recovery.recovered) {
    return {
      kind: 'rate-limited',
      error: 'NosPos rate-limited the save (429) — page reloaded.',
    };
  }

  try {
    const verify = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const el = document.querySelector('#stock-externally_listed_at[type="checkbox"]');
        if (!el) return { ok: true };
        return { ok: !!el.checked, stillUnchecked: !el.checked };
      },
    });
    const v = verify?.[0]?.result;
    if (v && !v.ok) {
      return {
        kind: 'error',
        error: 'Save did not persist — Manually Listed is still unticked after reload.',
      };
    }
  } catch (_) {
    // executeScript can fail if the tab is unloading / gone. Treat as success.
  }
  return { kind: 'ok', alreadyOn: false };
}

function waitForNosposExternallyListedOnSavePosted(tabId, timeoutMs) {
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
