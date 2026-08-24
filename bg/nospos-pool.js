/**
 * Bounded-concurrency worker pool for NosPos page reads.
 *
 * Globals: nosposFetchPool, nosposFetchGovernor, NOSPOS_POOL_DEFAULT_CONCURRENCY
 *
 * Every NosPos walk in this extension used to be a plain `for … await` loop:
 * one page in flight at a time, the next request not even sent until the last
 * one had come back and been parsed. Reading a day of agreements plus the stock
 * behind each of their items is hundreds of pages, and at one-at-a-time that is
 * the whole cost of a migration.
 *
 * This runs N of them at once. It is deliberately NOT `Promise.all` over the
 * whole list: NosPos throttles, and firing four hundred fetches at a server
 * that answers 429 is slower than firing six, not faster.
 *
 * Two things keep it polite:
 *
 *   1. **A hard ceiling on in-flight requests.** Work is pulled off a shared
 *      cursor by a fixed number of workers, so the list can be any length
 *      without changing how much pressure NosPos sees.
 *   2. **A governor that backs off on throttling.** `nosposCredentialedHtmlFetch`
 *      already retries a 429 internally, which means the caller never learns it
 *      was throttled and keeps sending at the same rate — the retry absorbs the
 *      symptom and hides the cause. The governor watches the observer hook that
 *      fetch now emits, halves concurrency the moment NosPos pushes back, and
 *      lets it climb again only after a run of clean responses.
 *
 * Ordering is not preserved by the pool itself — results come back in the slot
 * they were submitted in, so callers get a list that lines up with their input
 * while the work itself completes in whatever order it finishes.
 */

var NOSPOS_POOL_DEFAULT_CONCURRENCY = 6;
var NOSPOS_POOL_MIN_CONCURRENCY = 1;

/**
 * Shared throttle state. One governor for the whole service worker: two
 * simultaneous walks (agreements and their stock) must not each think they own
 * the full budget, or the ceiling is silently double what it says.
 */
var nosposFetchGovernor = (function () {
  var limit = NOSPOS_POOL_DEFAULT_CONCURRENCY;
  var ceiling = NOSPOS_POOL_DEFAULT_CONCURRENCY;
  var cleanRun = 0;
  var throttledAt = 0;

  function setCeiling(value) {
    var next = Number(value);
    if (!Number.isFinite(next) || next < NOSPOS_POOL_MIN_CONCURRENCY) return;
    ceiling = Math.floor(next);
    if (limit > ceiling) limit = ceiling;
  }

  function onThrottled() {
    throttledAt = Date.now();
    cleanRun = 0;
    // Halve rather than drop to one: a single 429 is a nudge, a sustained run
    // of them walks the limit down to the floor on its own.
    limit = Math.max(NOSPOS_POOL_MIN_CONCURRENCY, Math.floor(limit / 2));
  }

  function onSuccess() {
    cleanRun += 1;
    // Climb back slowly, and only well clear of the last push-back.
    if (limit < ceiling && cleanRun >= 20 && Date.now() - throttledAt > 5000) {
      limit += 1;
      cleanRun = 0;
    }
  }

  function current() {
    return limit;
  }

  function currentCeiling() {
    return ceiling;
  }

  function reset(value) {
    setCeiling(value == null ? NOSPOS_POOL_DEFAULT_CONCURRENCY : value);
    limit = ceiling;
    cleanRun = 0;
    throttledAt = 0;
  }

  return {
    current: current,
    ceiling: currentCeiling,
    reset: reset,
    setCeiling: setCeiling,
    onThrottled: onThrottled,
    onSuccess: onSuccess,
  };
})();

function nosposPoolSleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// Wire the governor to the fetch helper's observer hook (see bg/nospos-html.js).
// Assigned here rather than inside the helper so the helper stays a pure
// fetch/retry primitive with no knowledge of who is scheduling it.
NOSPOS_FETCH_OBSERVER = function (event) {
  if (!event) return;
  if (event.kind === 'throttled') nosposFetchGovernor.onThrottled();
  else if (event.kind === 'ok') nosposFetchGovernor.onSuccess();
};

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 *
 * @param {Array<any>} items
 * @param {(item: any, index: number) => Promise<any>} worker
 * @param {{ concurrency?: number, onProgress?: (done: number, total: number, result: any, index: number) => void, shouldStop?: () => boolean }} [options]
 * @returns {Promise<Array<{ ok: boolean, value?: any, error?: string, index: number }>>}
 *   One entry per input item, in input order. A worker that throws is captured
 *   as `{ ok: false }` rather than sinking the batch — one unreadable page must
 *   not lose the other three hundred.
 */
async function nosposFetchPool(items, worker, options) {
  var list = Array.isArray(items) ? items : [];
  var opts = options || {};
  var total = list.length;
  var results = new Array(total);
  if (!total) return results;

  var requested = Number(opts.concurrency);
  if (Number.isFinite(requested) && requested >= NOSPOS_POOL_MIN_CONCURRENCY) {
    nosposFetchGovernor.setCeiling(requested);
  }

  var cursor = 0;
  var done = 0;
  var stopped = false;

  /**
   * One worker, pinned to a slot number.
   *
   * Throttling is handled by PARKING the high-numbered slots rather than by
   * retiring and re-spawning workers: slot 5 simply waits while the governor's
   * limit is 3, and resumes when it climbs back. Same effect on the request
   * rate, none of the bookkeeping — and no way for a worker to be lost or
   * double-counted while the limit moves underneath it.
   */
  async function runWorker(slot) {
    while (true) {
      if (stopped) return;
      if (typeof opts.shouldStop === 'function' && opts.shouldStop()) {
        stopped = true;
        return;
      }

      // Park while this slot is above the governor's current limit. Slot 0 is
      // never parked, so the walk always makes progress however hard NosPos
      // pushes back.
      while (slot >= nosposFetchGovernor.current() && slot > 0) {
        if (stopped || cursor >= total) return;
        await nosposPoolSleep(250);
      }

      var index = cursor;
      if (index >= total) return;
      cursor += 1;

      var entry;
      try {
        entry = { ok: true, value: await worker(list[index], index), index: index };
      } catch (e) {
        entry = { ok: false, error: (e && e.message) || 'Failed', index: index };
      }
      results[index] = entry;
      done += 1;
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress(done, total, entry, index); } catch (_) {}
      }
    }
  }

  // Spawn up to the CEILING, not the current limit: a governor knocked down by
  // an earlier walk would otherwise permanently cap every walk after it. The
  // parking loop above is what enforces the live limit.
  var slots = Math.min(total, Math.max(NOSPOS_POOL_MIN_CONCURRENCY, nosposFetchGovernor.ceiling()));
  var workers = [];
  for (var slot = 0; slot < slots; slot += 1) workers.push(runWorker(slot));
  await Promise.all(workers);
  return results;
}
