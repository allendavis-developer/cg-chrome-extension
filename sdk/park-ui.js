/**
 * NosPos park-overlay primitives: show/hide the modal overlay, the duplicate-detection
 * prompt, and focus / fallback-open for the parked tab.
 * Exports (all attached to the service-worker global scope):
 *   NOSPOS_PARK_UI_STORAGE_KEY, NOSPOS_PARK_OVERLAY_DEFAULT_MSG, NOSPOS_DUPLICATE_DECLINED_ERROR,
 *   sendNosposParkOverlayToTab, sendNosposParkDuplicatePromptToTab, focusNosposTabForPark,
 *   activateNosposParkAgreementUi, clearNosposParkAgreementUiLock, focusOrOpenNosposParkTabImpl
 */

const NOSPOS_PARK_UI_STORAGE_KEY = 'cgNosposParkUiLock';
const NOSPOS_PARK_OVERLAY_DEFAULT_MSG =
  'CG Suite is updating this agreement — please wait. Do not use this tab until finished.';

async function sendNosposParkOverlayToTab(tabId, show, message) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'NOSPOS_PARK_OVERLAY',
      show,
      message: message || NOSPOS_PARK_OVERLAY_DEFAULT_MSG,
    });
  } catch (_) {
    /* Content script may not be ready yet; onUpdated + pageshow sync will re-apply. */
  }
}

/** User-facing error when a duplicate NosPos draft exists and they decline auto-delete. */
const NOSPOS_DUPLICATE_DECLINED_ERROR =
  'Failed to create new agreement for this customer because an existing one already exists, please delete it or resolve it before retrying parking';

async function sendNosposParkDuplicatePromptToTab(tabId, requestId, agreementId) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'NOSPOS_PARK_OVERLAY_DUPLICATE_PROMPT',
      requestId,
      agreementId: agreementId != null ? String(agreementId) : '',
    });
  } catch (_) {
    /* Same as overlay: content script may not be ready; onUpdated + sync will re-apply. */
  }
}

async function focusNosposTabForPark(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    logPark('focusNosposTabForPark', 'error', { tabId, error: e?.message }, 'Could not focus NoSpos tab');
  }
}

async function activateNosposParkAgreementUi(tabId, appTabId) {
  const msg = NOSPOS_PARK_OVERLAY_DEFAULT_MSG;
  await chrome.storage.session.set({
    [NOSPOS_PARK_UI_STORAGE_KEY]: {
      active: true,
      tabId,
      appTabId: appTabId ?? null,
      message: msg,
    },
  });
  await focusNosposTabForPark(tabId);
  await sendNosposParkOverlayToTab(tabId, true, msg);
}

async function clearNosposParkAgreementUiLock(options = {}) {
  const focusApp = options.focusApp !== false;
  const data = await chrome.storage.session.get(NOSPOS_PARK_UI_STORAGE_KEY);
  const lock = data[NOSPOS_PARK_UI_STORAGE_KEY];
  if (!lock || !lock.active) return;
  await chrome.storage.session.remove(NOSPOS_PARK_UI_STORAGE_KEY);
  if (lock.tabId != null) {
    unregisterNosposParkTab(lock.tabId);
    await sendNosposParkOverlayToTab(lock.tabId, false);
  }
  if (focusApp && lock.appTabId != null) {
    await focusAppTab(lock.appTabId);
  }
}
/**
 * Bring the parked NoSpos tab to the foreground; if it was closed, open fallbackCreateUrl (new agreement).
 */
async function focusOrOpenNosposParkTabImpl({ tabId, fallbackCreateUrl, appTabId = null }) {
  const id = parseInt(String(tabId ?? '').trim(), 10);
  const fallback = String(fallbackCreateUrl || '').trim();
  if (Number.isFinite(id) && id > 0) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab?.id) {
        await chrome.tabs.update(id, { active: true });
        if (tab.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        return { ok: true, tabId: id, mode: 'focused' };
      }
    } catch (_) {}
  }
  let okUrl = false;
  try {
    const u = new URL(fallback);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    okUrl =
      (host === 'nospos.com' || host.endsWith('.nospos.com')) &&
      u.protocol === 'https:' &&
      /^\/newagreement\//i.test(u.pathname || '');
  } catch (_) {
    okUrl = false;
  }
  if (!okUrl) {
    return {
      ok: false,
      error:
        'NoSpos tab not found. It may have been closed — run Park agreement again or open NoSpos manually.',
    };
  }
  let windowId = null;
  if (appTabId) {
    try {
      const t = await chrome.tabs.get(appTabId);
      windowId = t.windowId;
    } catch (_) {}
  }
  if (windowId == null) {
    try {
      const w = await chrome.windows.getLastFocused({ populate: false });
      windowId = w?.id ?? null;
    } catch (_) {}
  }
  const opts = { url: fallback, active: true };
  if (windowId != null) opts.windowId = windowId;
  const newTab = await chrome.tabs.create(opts);
  await putTabInYellowGroup(newTab.id);
  console.log('[CG Suite] NosPos park: opened fallback agreement tab', { tabId: newTab.id });
  return { ok: true, tabId: newTab.id, mode: 'opened' };
}
