/**
 * Open the Web EPOS upload worker tab (minimized).
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Pre-flight: although this opens a Web EPOS tab (not NosPos), the upload
 * session scrapes NosPos stock-edit pages for cost/retail/qty per item — so
 * the operator must be on the same NosPos shop as Cash EPOS before we start.
 * We do the same `nosposCheckLoginAndShop` probe used everywhere else; if it
 * fails the page promise is resolved with the failure (deferred-action path)
 * and no Web EPOS tab is opened.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openWebEposUpload({ requestId, appTabId, payload }) {
  resetUploadLog();
  logUpload('openWebEposUpload', 'start', { requestId, appTabId });
  if (appTabId == null) {
    logUpload('openWebEposUpload', 'error', { reason: 'no-app-tab' }, 'No app tab');
    return { ok: false, error: 'No app tab' };
  }

  const expectedCgShopName = payload?.expectedCgShopName || '';
  const expectedShopMatch = payload?.expectedShopMatch || '';
  // Local-dev escape hatch: the page only sends devLocal when it's running on
  // localhost (isLocalDev()), never on beta/prod. It lets the uploader open Web
  // EPOS even when NosPos isn't on the matching shop — the same bypass the page
  // applies to its own store-match gate. Without this the page proceeds past the
  // gate but the worker tab never opens, so the scrape later fails with
  // "No Web EPOS window for this session".
  const devLocal = !!payload?.devLocal;
  const preflight = await nosposCheckLoginAndShop('https://nospos.com/customers', expectedCgShopName, expectedShopMatch);
  if (!preflight.ok && !devLocal) {
    logUpload('openWebEposUpload', 'preflight-failed', {
      loginRequired: !!preflight.loginRequired,
      shopMismatch: !!preflight.shopMismatch,
      nosposShop: preflight.nosposShop || null,
      expectedCgShop: preflight.expectedCgShop || null,
    });
    chrome.tabs.sendMessage(appTabId, {
      type: 'EXTENSION_RESPONSE_TO_PAGE',
      requestId,
      response: preflight,
    }).catch(() => {});
    return preflight;
  }
  if (!preflight.ok && devLocal) {
    logUpload('openWebEposUpload', 'preflight-skipped-dev', {
      loginRequired: !!preflight.loginRequired,
      shopMismatch: !!preflight.shopMismatch,
      nosposShop: preflight.nosposShop || null,
    }, 'Local dev: NosPos preflight failed — opening Web EPOS anyway');
  }

  const { tabId: webeposTabId } = await ensureWebEposUploadWorkerTabOpen(
    WEB_EPOS_PRODUCTS_URL,
    appTabId
  );
  // Remember which NosPos shop the operator is logged into (and the distinctive
  // match substring) so the products tab can auto-filter Web EPOS to the same
  // store and tell them to keep it consistent (preflight already confirmed
  // login + shop match above).
  await writeWebEposUploadSession({
    nosposShop: preflight.nosposShop || null,
    expectedShopMatch: expectedShopMatch || null,
    expectedCgShopName: expectedCgShopName || null,
  });
  logUpload('openWebEposUpload', 'worker-tab-open', { webeposTabId, url: WEB_EPOS_PRODUCTS_URL });
  const pending = await getPending();
  const entry = { appTabId, listingTabId: webeposTabId, type: 'openWebEposUpload' };
  pending[requestId] = entry;
  await setPending(pending);
  watchWebEposUploadTab(webeposTabId, requestId, entry);
  logUpload('openWebEposUpload', 'watching', { requestId, listingTabId: webeposTabId });
  console.log('[CG Suite] openWebEposUpload – watching tab', { requestId, listingTabId: webeposTabId });
  return { ok: true };
}
