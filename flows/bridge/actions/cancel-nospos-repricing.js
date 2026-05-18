/**
 * Cancel an in-flight NosPos repricing session.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_cancelNosposRepricing({ requestId, payload }) {
  // We ignore the sender's appTabId and use the one stored with the session,
  // because the user may click Cancel from a tab that didn't start the flow.
  const nosposData = (await chrome.storage.session.get('cgNosposRepricingData')).cgNosposRepricingData;
  const progress = (await chrome.storage.local.get('cgNosposRepricingProgress')).cgNosposRepricingProgress;
  const appTabId = nosposData?.appTabId ?? progress?.appTabId;
  const nosposTabId = nosposData?.nosposTabId;
  const cartKey = nosposData?.cartKey ?? progress?.cartKey ?? payload.cartKey ?? '';

  await clearNosposRepricingState(nosposTabId || 0);
  const cancelledStatus = {
    cartKey,
    running: false,
    done: false,
    cancelled: true,
    step: 'cancelled',
    message: 'Repricing was cancelled.',
    completedBarcodes: nosposData?.completedBarcodes ?? progress?.completedBarcodes ?? {},
    completedItems: nosposData?.completedItems ?? progress?.completedItems ?? [],
    logs: [...(nosposData?.logs || []), {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'Repricing was cancelled by the user.'
    }].slice(-200)
  };
  await setRepricingStatus(cancelledStatus);
  if (appTabId) {
    chrome.tabs.sendMessage(appTabId, {
      type: 'REPRICING_PROGRESS_TO_PAGE',
      payload: cancelledStatus
    }).catch(() => {});
  }
  if (nosposTabId) {
    chrome.tabs.remove(nosposTabId).catch(() => {});
  }
  return { ok: true };
}
