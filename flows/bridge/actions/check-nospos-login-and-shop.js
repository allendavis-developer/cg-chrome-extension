/**
 * Read-only pre-flight: is the operator signed into NosPos, and on the same
 * shop Cash EPOS is on?
 *
 * Every flow that *writes* to NosPos already runs this check as part of opening
 * something (upload does it inside `openWebEposUpload`, park inside its own
 * open action). Repricing had no equivalent, because its first NosPos contact
 * is `openNosposAndWait` — by which point the operator has already built a
 * whole reprice list. This action gives the website a way to run the same check
 * on module entry without opening a tab or touching any state.
 *
 * Payload: { expectedCgShopName?: string, expectedShopMatch?: string }
 *   Pass both empty to check login only.
 *
 * Response: { ok: true, nosposShop }
 *         | { ok: false, loginRequired: true }
 *         | { ok: false, shopMismatch: true, nosposShop, expectedCgShop }
 *         | { ok: false, error }
 *
 * Fail-closed by construction: `nosposCheckLoginAndShop` reports a mismatch when
 * it can't read the navbar at all, so "couldn't verify" never reads as "fine".
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

async function handleBridgeAction_checkNosposLoginAndShop({ requestId, appTabId, payload }) {
  const expectedCgShopName = payload?.expectedCgShopName || '';
  const expectedShopMatch = payload?.expectedShopMatch || '';
  // Same probe URL the customer-intake / repricing pre-flights use — cheap page
  // that always carries the branch navbar when signed in.
  return nosposCheckLoginAndShop('https://nospos.com/customers', expectedCgShopName, expectedShopMatch);
}
