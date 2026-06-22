/**
 * Keep a NosPos tab alive while it sits in the background.
 *
 * Park (and the other NosPos worker flows) drive this tab from the extension's
 * service worker via chrome.scripting / executeScript. The NosPos tab is always
 * opened unfocused, which is fine while the operator stays on Cash EPOS — but
 * when they switch tabs or move to another Windows virtual desktop the whole
 * window goes unfocused and Chrome can FREEZE this background tab. A frozen tab
 * can't run page JS, so NosPos never renders the next row and the automation
 * "gets stuck on an item" until the tab is refocused.
 *
 * Holding a Web Lock for the life of the document is a documented opt-out from
 * both tab freezing and intensive timer throttling, so the service worker can
 * keep driving the page while it's hidden. The lock releases automatically when
 * the document is torn down (navigation / close); because this script runs on
 * every nospos.com page load it is re-established after every reload the park
 * flow triggers (Add, set category, page nav, the final Park submit, ...).
 *
 * Hardening notes:
 * - This file is injected in BOTH the isolated content-script world AND the page
 *   MAIN world (see manifest content_scripts). Whether a content-script-held lock
 *   counts toward Chrome's freeze exemption is not clearly specified, so we also
 *   hold one from the page's own context where it definitely counts. The two
 *   worlds have separate `window` globals, so the re-entry guard below naturally
 *   keeps them independent, and the lock NAME is unique per acquisition so the
 *   two never contend for the same exclusive lock.
 * - If the held lock is ever released (it shouldn't be, short of the document
 *   being torn down), we immediately re-acquire a fresh one so the tab never
 *   spends a moment unprotected.
 * - A visibilitychange handler re-asserts the lock the instant the tab is hidden,
 *   belt-and-braces in case the original acquisition was lost.
 */
(function () {
  if (window.__cgNosposKeepAlive) return;
  window.__cgNosposKeepAlive = true;

  function uniqueLockName() {
    return (
      'cg-nospos-keepalive-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2)
    );
  }

  // True only while we are actively holding (or acquiring) a keepalive lock, so
  // the visibilitychange re-assert never stacks redundant requests.
  var holding = false;

  function acquireKeepAliveLock() {
    if (holding) return;
    if (!navigator.locks || !navigator.locks.request) return;
    holding = true;
    var name = uniqueLockName();
    try {
      navigator.locks
        .request(name, { mode: 'exclusive' }, function () {
          // Never-resolving callback → the lock is held until this document goes
          // away (navigation / close), which is exactly the "don't freeze me"
          // signal we want. The returned promise never settles, so the only way
          // out is document teardown — at which point a fresh page load re-runs
          // this script.
          return new Promise(function () {});
        })
        .then(function () {
          // Reached only if the lock was somehow released without the document
          // going away — re-acquire immediately so we're never left unprotected.
          holding = false;
          acquireKeepAliveLock();
        })
        .catch(function () {
          // request() rejected (e.g. transient) — allow a retry on next trigger.
          holding = false;
        });
    } catch (_) {
      holding = false;
    }
  }

  acquireKeepAliveLock();

  // Re-assert the moment the tab is hidden — the highest-risk transition for the
  // freeze/throttle heuristics — in case the initial acquisition was lost.
  try {
    document.addEventListener(
      'visibilitychange',
      function () {
        if (document.visibilityState === 'hidden') acquireKeepAliveLock();
      },
      { passive: true }
    );
  } catch (_) {}
})();
