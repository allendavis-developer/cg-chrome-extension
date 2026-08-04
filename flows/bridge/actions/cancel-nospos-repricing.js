/**
 * Cancel an in-flight NosPos repricing session.
 *
 * Two things this has to do beyond stopping the work, both of which were
 * missing and are why Cancel looked like it did nothing:
 *
 *   1. **Answer the page's pending promise.** The page is sitting on an
 *      `await openNospos(...)` whose response only arrives when the barcode
 *      queue finishes. `clearNosposRepricingState` deletes that pending entry,
 *      so the await was left hanging forever and the caller's cleanup never
 *      ran. We now post a cancelled response to every in-flight openNospos
 *      request *before* the pending map is cleared.
 *
 *   2. **Report where it got to.** The return value carries the counts and the
 *      last item touched, so the page can tell the operator exactly how far the
 *      run got without depending on a broadcast landing.
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
  // `||` not `??`: an empty-string cartKey is as useless as a missing one, and
  // the page drops any progress payload whose cartKey is blank.
  const cartKey = nosposData?.cartKey || progress?.cartKey || payload.cartKey || '';

  const completedBarcodes = nosposData?.completedBarcodes ?? progress?.completedBarcodes ?? {};
  const completedItems = nosposData?.completedItems ?? progress?.completedItems ?? [];
  const repricingData = nosposData?.repricingData || [];
  const totalBarcodes = countTotalBarcodes(repricingData);
  const completedBarcodeCount = countCompletedBarcodes(completedBarcodes);

  const summary = {
    cancelled: true,
    cartKey,
    totalBarcodes,
    completedBarcodeCount,
    completedItemCount: completedItems.length,
    totalItems: repricingData.length,
    lastItemTitle: nosposData?.currentItemTitle || '',
    lastBarcode: nosposData?.currentBarcode || '',
  };

  const stoppedAt = totalBarcodes > 0
    ? `Cancelled after ${completedBarcodeCount} of ${totalBarcodes} barcodes.`
    : 'Cancelled before any barcode was saved.';

  const cancelledStatus = {
    cartKey,
    running: false,
    done: false,
    cancelled: true,
    step: 'cancelled',
    message: stoppedAt,
    // Keep the counts on the payload so the overlay's progress bars show where
    // it stopped instead of snapping back to 0/0 as this merges in.
    totalBarcodes,
    completedBarcodeCount,
    currentItemTitle: summary.lastItemTitle,
    currentBarcode: summary.lastBarcode,
    completedBarcodes,
    completedItems,
    logs: [...(nosposData?.logs || []), {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: `Repricing was cancelled by the user. ${stoppedAt}`
    }].slice(-200)
  };

  // Resolve in-flight openNospos requests before clearing the pending map.
  const pending = await getPending();
  for (const [pendingRequestId, entry] of Object.entries(pending)) {
    if (entry?.type !== 'openNospos' || entry.appTabId == null) continue;
    chrome.tabs.sendMessage(entry.appTabId, {
      type: 'EXTENSION_RESPONSE_TO_PAGE',
      requestId: pendingRequestId,
      response: { ok: false, ...summary },
    }).catch(() => {});
  }

  await clearNosposRepricingState(nosposTabId || 0);
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
  return { ok: true, ...summary };
}
