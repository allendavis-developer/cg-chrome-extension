/**
 * Open a NosPos stock-edit page in a background worker tab and wait for it
 * to load, so the caller can drive the page (e.g. untick `externally_listed`
 * + Save) via `chrome.scripting.executeScript`.
 *
 * Mirrors `navigateWebEposProductInWorkerTab` for the WebEpos side. Each
 * untick task opens its own short-lived tab so we can run them in parallel.
 *
 * Caller is responsible for closing the tab afterwards (`closeTabsByIds`).
 *
 * Payload: { stockUrl }
 * Response: { ok: true, tabId: number }
 *         | { ok: false, loginRequired: true }
 *         | { ok: false, error: string }
 */
async function handleBridgeAction_navigateNosposStockEditInWorker({ payload }) {
  const stockUrl = String(payload?.stockUrl || '').trim();
  if (!stockUrl) return { ok: false, error: 'No stock URL' };
  const editUrl = normalizeNosposStockEditUrl(stockUrl);
  if (!editUrl) return { ok: false, error: 'Invalid stock URL' };

  let tab;
  try {
    tab = await chrome.tabs.create({ url: editUrl, active: false });
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not open tab' };
  }

  try {
    await waitForTabLoadComplete(tab.id, 60000, 'NosPos stock edit page took too long to load.');
  } catch (e) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    return { ok: false, error: e?.message || 'Page load failed' };
  }

  // If NosPos bounced us to a login page the caller can't proceed.
  let landedUrl = '';
  try {
    const refreshed = await chrome.tabs.get(tab.id);
    landedUrl = (refreshed.url || '').toLowerCase();
  } catch (_) {
    return { ok: false, error: 'Tab disappeared after load.' };
  }
  if (/\/login|\/signin|\/site\/standard-login|\/twofactor/.test(landedUrl)) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    return { ok: false, loginRequired: true };
  }

  return { ok: true, tabId: tab.id };
}
