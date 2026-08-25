/**
 * Stopping a NosPos walk when the page that asked for it goes away.
 *
 * Globals: nosposAbort
 *
 * A capture is hundreds of fetches driven from the service worker, which does
 * NOT die when the tab that started it does. Close the tab, hit back, or
 * navigate away mid-capture and the walk carried on hammering NosPos with
 * nobody watching and no way to stop it short of removing the extension. That
 * is not a tidiness problem — it is someone else's production server being
 * hit by a process its owner has already tried to end.
 *
 * Three ways a walk is told to stop, because no single one of them is reliable:
 *
 *   * `pagehide` from the content bridge — fires on navigation and on most tab
 *     closes, but is not guaranteed on a crash or a killed process.
 *   * `chrome.tabs.onRemoved` — catches the tab going away regardless.
 *   * An explicit Stop from the page, for a capture somebody just wants to end.
 *
 * A walk checks `isAborted(tabId)` between pages, so it stops within one fetch
 * rather than at the end of the batch.
 *
 * ── Why a stop is tied to a page instance, not just a tab ───────────────────
 *
 * Aborts used to be a sticky flag per tab id, and that flag outlived the page
 * that set it. A reload fires `pagehide`, which wakes the service worker and
 * queues an abort for that tab; the replacement page loads into the SAME tab
 * id. If the abort was processed late — and waking a service worker is not
 * instant — it landed on the fresh page's walk and killed it on arrival. The
 * capture stopped before it fetched anything, reported that the page which
 * started it had gone away, and staged nothing.
 *
 * So an unload aborts only the page instance that is unloading. The content
 * bridge stamps a new instance id every time it is injected, sends it with the
 * walk and with the unload, and a stop from one page instance can no longer
 * reach a walk started by its successor. A removed tab still stops everything
 * in it, because there is then no successor to protect.
 */

var nosposAbort = (function () {
  /**
   * Per tab: which page instance owns the current walk, whether it is stopped,
   * and what stopped it. The reason is carried so a capture that ends early can
   * say which of the three signals ended it rather than leaving it to be
   * guessed from timing.
   */
  var state = new Map();

  function entry(tabId) {
    var found = state.get(tabId);
    if (!found) {
      found = { instanceId: null, aborted: false, reason: '' };
      state.set(tabId, found);
    }
    return found;
  }

  /**
   * A new walk is starting for this tab, so forget any earlier abort.
   *
   * Without this a single stop would poison every later capture from the same
   * tab, and the only cure would be a reload — which is the behaviour this
   * module exists to remove, not to add.
   */
  function begin(tabId, instanceId) {
    if (tabId == null) return;
    var current = entry(tabId);
    current.instanceId = instanceId || null;
    current.aborted = false;
    current.reason = '';
  }

  /** Stop this tab's walk whatever started it — the tab itself is going. */
  function abort(tabId, reason) {
    if (tabId == null) return;
    var current = entry(tabId);
    current.aborted = true;
    current.reason = reason || 'stopped';
  }

  /**
   * Stop this tab's walk only if `instanceId` is the page that started it.
   *
   * An unload announcement that arrives after its replacement has already begun
   * work refers to a page that is gone, and must not stop the new one. An
   * announcement with no instance id at all comes from a content bridge older
   * than this scheme, and is honoured as before.
   */
  function abortInstance(tabId, instanceId, reason) {
    if (tabId == null) return;
    var current = entry(tabId);
    if (instanceId && current.instanceId && current.instanceId !== instanceId) return;
    current.aborted = true;
    current.reason = reason || 'stopped';
  }

  function isAborted(tabId) {
    return tabId != null && Boolean(state.get(tabId)?.aborted);
  }

  /** Why the current walk was stopped, for the message the operator reads. */
  function reasonFor(tabId) {
    return (tabId != null && state.get(tabId)?.reason) || '';
  }

  function forget(tabId) {
    state.delete(tabId);
  }

  return {
    begin: begin,
    abort: abort,
    abortInstance: abortInstance,
    isAborted: isAborted,
    reasonFor: reasonFor,
    forget: forget,
  };
})();

// The tab going away is the signal that cannot be missed: pagehide can be
// skipped when a process is killed, but a removed tab is always reported. No
// instance check here — there is no successor page to protect.
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    nosposAbort.abort(tabId, 'the tab was closed');
  });
}
