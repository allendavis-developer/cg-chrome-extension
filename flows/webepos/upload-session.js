/**
 * Web EPOS upload-session state: normalize URL, classify URL, read/write/clear session,
 * ensure worker tab is open, handle worker tab removal.
 */

function normalizeWebEposUploadUrl(raw) {
  let url = String(raw || WEB_EPOS_PRODUCTS_URL).trim() || WEB_EPOS_PRODUCTS_URL;
  try {
    const pu = new URL(url);
    if (pu.hostname.toLowerCase() !== WEB_EPOS_UPLOAD_HOST) return WEB_EPOS_PRODUCTS_URL;
    return url;
  } catch {
    return WEB_EPOS_PRODUCTS_URL;
  }
}

/** Close the worker tab; if it is the only tab in its window, close the whole window (dedicated Web EPOS window). */
async function removeWebEposWorkerByTabId(tabId) {
  if (tabId == null) return;
  const workerTab = await chrome.tabs.get(tabId).catch(() => null);
  const wid = workerTab?.windowId;
  if (wid == null) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return;
  }
  try {
    const w = await chrome.windows.get(wid, { populate: true });
    const onlyTab =
      Array.isArray(w.tabs) &&
      w.tabs.length === 1 &&
      Number(w.tabs[0]?.id) === Number(tabId);
    if (onlyTab) {
      await chrome.windows.remove(wid).catch(() => chrome.tabs.remove(tabId).catch(() => {}));
    } else {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  } catch {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** @returns {'wait'|'login'|{ kind: 'ready', url: string }} */
function classifyWebEposUrl(u) {
  const url = String(u || '').trim();
  if (!url || url.startsWith('chrome://')) return 'wait';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'wait';
  }
  if (parsed.hostname.toLowerCase() !== WEB_EPOS_UPLOAD_HOST) return 'wait';
  const path = (parsed.pathname || '/').toLowerCase();
  if (WEB_EPOS_LOGIN_PATH.test(path)) return 'login';
  return { kind: 'ready', url };
}

async function readWebEposUploadSession() {
  try {
    const raw = await chrome.storage.session.get(WEB_EPOS_UPLOAD_SESSION_KEY);
    const s = raw[WEB_EPOS_UPLOAD_SESSION_KEY];
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch (_) {
    return null;
  }
}

async function writeWebEposUploadSession(partial) {
  try {
    const raw = await chrome.storage.session.get(WEB_EPOS_UPLOAD_SESSION_KEY);
    const cur =
      raw[WEB_EPOS_UPLOAD_SESSION_KEY] && typeof raw[WEB_EPOS_UPLOAD_SESSION_KEY] === 'object'
        ? raw[WEB_EPOS_UPLOAD_SESSION_KEY]
        : {};
    await chrome.storage.session.set({
      [WEB_EPOS_UPLOAD_SESSION_KEY]: { ...cur, ...partial },
    });
  } catch (_) {}
}

async function clearWebEposUploadSession() {
  try {
    await chrome.storage.session.remove(WEB_EPOS_UPLOAD_SESSION_KEY);
  } catch (_) {}
}

async function closeWebEposUploadSessionForAppTab(appTabId) {
  if (appTabId == null) return;
  const session = await readWebEposUploadSession();
  if (!session || Number(session.appTabId) !== Number(appTabId)) return;
  const workerTabId = session.workerTabId;
  if (workerTabId != null) {
    await writeWebEposUploadSession({ ...session, workerTabId: null });
    await removeWebEposWorkerByTabId(workerTabId);
  }
  await clearWebEposUploadSession();
}

/**
 * Only the tab id stored in our upload session is reused (never arbitrary Web EPOS tabs).
 * Otherwise opens a new minimised window via openBackgroundNosposTab.
 */
async function ensureWebEposUploadWorkerTabOpen(url, appTabId) {
  let session = await readWebEposUploadSession();
  if (
    session?.workerTabId != null &&
    session.appTabId != null &&
    Number(session.appTabId) !== Number(appTabId)
  ) {
    const wid = session.workerTabId;
    await writeWebEposUploadSession({ ...session, workerTabId: null });
    await removeWebEposWorkerByTabId(wid);
    await clearWebEposUploadSession();
    session = null;
  }
  if (session?.workerTabId != null) {
    try {
      await chrome.tabs.get(session.workerTabId);
      await chrome.tabs.update(session.workerTabId, { url });
      await writeWebEposUploadSession({
        workerTabId: session.workerTabId,
        appTabId,
        lastUrl: url,
      });
      if (appTabId != null) await focusAppTab(appTabId);
      return { tabId: session.workerTabId };
    } catch {
      await writeWebEposUploadSession({ workerTabId: null, appTabId, lastUrl: url });
    }
  }
  const { tabId } = await openBackgroundNosposTab(url, appTabId);
  await writeWebEposUploadSession({
    workerTabId: tabId,
    appTabId,
    lastUrl: url,
  });
  return { tabId };
}
/**
 * Always detect the upload worker closing — including after the initial open/watch has finished.
 * (Per-tab watch removes its listeners on success; without this, the app never learns the window was closed.)
 */
async function handleWebEposWorkerTabRemovedGlobally(removedTabId) {
  const abort = webEposUploadWatchAbortByTabId.get(removedTabId);
  if (typeof abort === 'function') abort();

  const session = await readWebEposUploadSession();
  if (
    !session ||
    session.workerTabId == null ||
    Number(session.workerTabId) !== Number(removedTabId)
  ) {
    return;
  }

  const lastUrl = session.lastUrl || WEB_EPOS_PRODUCTS_URL;
  const appTabId = session.appTabId;

  await writeWebEposUploadSession({
    workerTabId: null,
    appTabId,
    lastUrl,
  });

  const pending = await getPending();
  for (const [reqId, entry] of Object.entries(pending)) {
    if (
      entry.type === 'openWebEposUpload' &&
      entry.appTabId === appTabId &&
      Number(entry.listingTabId) === Number(removedTabId)
    ) {
      delete pending[reqId];
      await setPending(pending);
      chrome.tabs
        .sendMessage(appTabId, {
          type: 'EXTENSION_RESPONSE_TO_PAGE',
          requestId: reqId,
          error: 'Web EPOS window was closed.',
        })
        .catch(() => {});
      break;
    }
  }

  if (appTabId != null) {
    chrome.tabs
      .sendMessage(appTabId, {
        type: 'WEB_EPOS_UPLOAD_WORKER_TO_PAGE',
        lastUrl,
      })
      .catch(() => {});
    await focusAppTab(appTabId);
  }
}
