/**
 * Apply the category phase of the first line of a new agreement.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_fillNosposAgreementFirstItemCategory({ requestId, appTabId, payload }) {
  const categoryId = String(payload.categoryId ?? '').trim();
  if (!categoryId) {
    return { ok: false, error: 'No category id' };
  }
  const r = await fillNosposAgreementFirstItemImpl({
    tabId: payload.tabId,
    categoryId,
    name: '',
    quantity: '',
    retailPrice: '',
    boughtFor: '',
    stockFields: [],
  });
  if (r?.ok) {
    return { ok: true, label: r.categoryLabel || r.label };
  }
  return r;
}
