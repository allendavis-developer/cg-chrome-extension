/**
 * Toggle Web EPOS "On Sale" to off on an already-opened product edit tab, then click
 * Save/Update. Expects the caller to have opened the tab via the canonical opener
 * (`navigateWebEposProductInWorkerTab` with `focusOnSuccess: false`) so the routing is
 * session-safe.
 *
 * Sequence:
 *   1. Wait for the edit form to mount (`#price` exists).
 *   2. Wait for the product JSON to hydrate (`#price` has a value). Skipping this loses the
 *      race to React — our click lands, then the loaded product replays "on".
 *   3. `injectWebEposEnsureOnSaleOff` — first toggle so the user sees the switch flip off
 *      while the next steps run. The save helper re-asserts off immediately before clicking.
 *   4. `injectWebEposEditProductFinishSaveOffSale` — mirrors the new-product save pipeline
 *      that's known to work (`finishNewProductAfterFill`): poke `#price` to dirty React's
 *      form state so it stops resyncing the switch from product JSON, run `ensureOnSaleOff`
 *      again right before click, clear RRP Source, then click Save/Update and wait for the
 *      Web EPOS redirect away from the edit URL.
 *
 * Why this is NOT `injectWebEposEditProductFinishSave`: that helper calls `ensureOnSaleOn`
 * before saving (audit price-edit invariant — keep live products live). Calling it here
 * would flip On Sale back ON the instant before save — that was the original
 * "off then immediately back on then save" bug.
 *
 * Payload: { tabId: number }
 * Response: { ok: true } | { ok: false, error: string }
 */
async function handleBridgeAction_setWebEposProductOnSaleOff({ payload }) {
  const tabId = Number(payload?.tabId);
  if (!Number.isFinite(tabId)) return { ok: false, error: 'Missing tabId' };
  try {
    await injectWebEposWaitForEditFormReady(tabId);
    await injectWebEposWaitForProductLoaded(tabId);
    await injectWebEposEnsureOnSaleOff(tabId);
    await injectWebEposEditProductFinishSaveOffSale(tabId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'Failed to toggle On Sale off' };
  }
}
