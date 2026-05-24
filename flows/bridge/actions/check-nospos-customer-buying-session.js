/**
 * Check whether a NosPos customer already has an in-progress buying session,
 * and verify the operator is signed into the same shop on NosPos as they are
 * on Cash EPOS.
 *
 * Credentialed fetch of `/customer/{id}/buying`. We read the body now (rather
 * than cancelling) so we can extract the navbar branch label and compare it
 * to the expected CG shop name passed in by the website. Three negative
 * outcomes the caller can act on:
 *   - `{ ok: false, loginRequired: true }`  — NosPos redirected to login.
 *   - `{ ok: false, shopMismatch: true, nosposShop, expectedCgShop }`
 *   - `{ ok: false, error: '...' }`         — timeout / network / unparseable.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

async function nosposFetchCustomerBuyingSession(customerId, expectedCgShopName, expectedShopMatch, sessionCheckMs = 12000) {
  const id = parseInt(String(customerId ?? '').trim(), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'Invalid NosPos customer id' };
  }
  const buyingPageUrl = `https://nospos.com/customer/${id}/buying`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sessionCheckMs);
  let response;
  try {
    response = await fetch(buyingPageUrl, {
      credentials: 'include',
      headers: NOSPOS_HTML_FETCH_HEADERS,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const isAbort = e?.name === 'AbortError';
    return {
      ok: false,
      error: isAbort
        ? 'NoSpos did not respond in time. Check your connection, sign in at nospos.com in Chrome, and try again.'
        : e?.message || 'Could not verify NoSpos session',
    };
  }
  clearTimeout(timer);
  const finalUrl = response.url || '';
  if (nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl)) {
    try { await response.body?.cancel?.(); } catch (_) { /* ignore */ }
    return { ok: false, loginRequired: true };
  }
  let html;
  try {
    html = await response.text();
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not read NosPos response' };
  }
  const nosposShop = parseNosposBranchName(html);
  const mismatch = nosposShopMismatchReason(nosposShop, expectedCgShopName, expectedShopMatch);
  if (mismatch) {
    return {
      ok: false,
      shopMismatch: true,
      nosposShop,
      expectedCgShop: mismatch.expectedCgShop,
    };
  }
  return { ok: true, customerId: id, nosposShop };
}

async function handleBridgeAction_checkNosposCustomerBuyingSession({ requestId, appTabId, payload }) {
  logPark('handleBridgeForward', 'enter', {
    action: 'checkNosposCustomerBuyingSession',
    nosposCustomerId: payload.nosposCustomerId,
    expectedCgShopName: payload.expectedCgShopName || null,
    expectedShopMatch: payload.expectedShopMatch || null,
  }, 'Step 1: checking NoSpos customer buying session + shop match');
  return nosposFetchCustomerBuyingSession(
    payload.nosposCustomerId,
    payload.expectedCgShopName,
    payload.expectedShopMatch,
  );
}
