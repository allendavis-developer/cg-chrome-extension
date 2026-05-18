/**
 * Update a single field on a NosPos agreement line.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_patchNosposAgreementField({ requestId, appTabId, payload }) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  const patchDead = await failIfNosposParkTabClosedOrMissing(tabId);
  if (patchDead) return patchDead;
  try {
    const r = await sendMessageToTabWithRetries(
      tabId,
      {
        type: 'NOSPOS_AGREEMENT_PATCH_FIELD',
        lineIndex: payload.lineIndex ?? 0,
        patchKind: payload.patchKind,
        fieldLabel: payload.fieldLabel ?? '',
        value: payload.value ?? '',
      },
      10,
      450
    );
    return r && typeof r === 'object' ? r : { ok: false, error: 'No response from NoSpos page' };
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not update NoSpos' };
  }
}
