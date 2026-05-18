/**
 * Locate the correct line index for a given CG marker in the NosPos agreement.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_resolveNosposParkAgreementLine({ requestId, appTabId, payload }) {
  const tabId = parseInt(String(payload.tabId ?? '').trim(), 10);
  const stepIndex = Math.max(0, parseInt(String(payload.stepIndex ?? '0'), 10) || 0);
  const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return { ok: false, error: 'Invalid tab' };
  }
  const closed = await failIfNosposParkTabClosedOrMissing(tabId);
  if (closed) return closed;
  if (CG_TEST_FAIL_PARK_AFTER_SECOND_ITEM && stepIndex >= 2) {
    const intentionalError =
      `Intentional test failure (CG_TEST_FAIL_PARK_AFTER_SECOND_ITEM=true): ` +
      `blocking Park Agreement at stepIndex=${stepIndex} (after 2 items).`;
    logPark(
      'handleBridgeForward',
      'error',
      { stepIndex, tabId, intentionalTestFail: true },
      intentionalError
    );
    return { ok: false, intentionalTestFail: true, error: intentionalError };
  }
  return resolveNosposParkAgreementLineImpl(tabId, stepIndex, item, {
    noAdd: payload.noAdd === true,
    ensureTab: payload.ensureTab === true,
    negotiationLineIndex: payload.negotiationLineIndex,
    parkNegotiationLineCount: payload.parkNegotiationLineCount,
  });
}
