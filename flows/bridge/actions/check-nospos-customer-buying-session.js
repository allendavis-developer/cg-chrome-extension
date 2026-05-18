/**
 * Check whether a NosPos customer already has an in-progress buying session.
 *
 * Credentialed HEAD-style fetch of `/customer/{id}/buying`; we don't read the
 * body — we just need NosPos's login-redirect signal to confirm the user is
 * signed in before park flow opens any tabs.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

async function nosposFetchCustomerBuyingSession(customerId, sessionCheckMs = 12000) {
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
  try { await response.body?.cancel?.(); } catch (_) { /* ignore */ }
  if (nosposHtmlFetchIndicatesNotLoggedIn(response, finalUrl)) {
    return { ok: false, loginRequired: true };
  }
  return { ok: true, customerId: id };
}

async function handleBridgeAction_checkNosposCustomerBuyingSession({ requestId, appTabId, payload }) {
  logPark('handleBridgeForward', 'enter', { action: 'checkNosposCustomerBuyingSession', nosposCustomerId: payload.nosposCustomerId }, 'Step 1: checking NoSpos customer buying session');
  return nosposFetchCustomerBuyingSession(payload.nosposCustomerId);
}
