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
 */

var nosposAbort = (function () {
  /** Tabs whose work should stop. Cleared when that tab starts something new. */
  var aborted = new Set();

  /**
   * A new walk is starting for this tab, so forget any earlier abort.
   *
   * Without this a single stop would poison every later capture from the same
   * tab, and the only cure would be a reload — which is the behaviour this
   * module exists to remove, not to add.
   */
  function begin(tabId) {
    if (tabId != null) aborted.delete(tabId);
  }

  function abort(tabId) {
    if (tabId != null) aborted.add(tabId);
  }

  function isAborted(tabId) {
    return tabId != null && aborted.has(tabId);
  }

  return { begin: begin, abort: abort, isAborted: isAborted };
})();

// The tab going away is the signal that cannot be missed: pagehide can be
// skipped when a process is killed, but a removed tab is always reported.
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    nosposAbort.abort(tabId);
  });
}
