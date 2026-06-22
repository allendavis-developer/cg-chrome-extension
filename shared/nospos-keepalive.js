/**
 * Keep a NosPos tab alive while it sits in the background.
 *
 * Park (and the other NosPos worker flows) drive this tab from the extension's
 * service worker via chrome.scripting / executeScript. The NosPos tab is always
 * opened unfocused, which is fine while the operator stays on Cash EPOS — but
 * when they switch tabs or move to another Windows virtual desktop the whole
 * window goes unfocused and Chrome can FREEZE this background tab. A frozen tab
 * can't run injected code, so the automation "gets stuck on an item" until the
 * tab is refocused.
 *
 * Holding a Web Lock for the life of the document is a documented opt-out from
 * both tab freezing and intensive timer throttling, so the service worker can
 * keep driving the page while it's hidden. The lock releases automatically when
 * the document is torn down (navigation / close); because this script runs on
 * every nospos.com page load it is re-established after every reload the park
 * flow triggers (Add, set category, page nav, the final Park submit, ...).
 *
 * The lock NAME is unique per document so multiple NosPos tabs never contend for
 * the same exclusive lock (which would leave the second tab unprotected).
 */
(function () {
  if (window.__cgNosposKeepAlive) return;
  window.__cgNosposKeepAlive = true;
  try {
    if (navigator.locks && navigator.locks.request) {
      const name =
        'cg-nospos-keepalive-' +
        Date.now().toString(36) +
        '-' +
        Math.random().toString(36).slice(2);
      // Never-resolving callback → the lock is held until this document goes
      // away, which is exactly the "don't freeze me" signal we want.
      navigator.locks
        .request(name, { mode: 'exclusive' }, () => new Promise(() => {}))
        .catch(() => {});
    }
  } catch (_) {}
})();
