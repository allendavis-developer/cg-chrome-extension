/**
 * Open NosPos for a repricing flow and wait for the user / barcode queue.
 * Guard: original action required appTabId — dispatcher provides it when present.
 *
 * Pre-flight: credentialed fetch of `https://nospos.com/customers` to verify
 * the operator is signed in AND on the same shop as Cash EPOS — same pattern
 * as the customer-intake / park-agreement flows. Failure short-circuits before
 * any tab is opened or any repricing state is wiped.
 *
 * NOTE on response delivery: this action is in content-bridge.js's deferred
 * list — the page promise gets resolved by a later `EXTENSION_RESPONSE_TO_PAGE`
 * after the barcode queue finishes. When the pre-flight bails we have to post
 * the failure to the app tab ourselves; the bridge ignores our return value.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_openNosposAndWait({ requestId, appTabId, payload }) {
  if (appTabId == null) return { ok: false, error: 'No app tab' };

  const expectedCgShopName = payload?.expectedCgShopName || '';
  const preflight = await nosposCheckLoginAndShop('https://nospos.com/customers', expectedCgShopName);
  if (!preflight.ok) {
    chrome.tabs.sendMessage(appTabId, {
      type: 'EXTENSION_RESPONSE_TO_PAGE',
      requestId,
      response: preflight,
    }).catch(() => {});
    return preflight;
  }

  const url = 'https://nospos.com';
  await clearNosposRepricingState();
  await chrome.storage.local.remove('cgNosposLastRepricingResult');
  await clearRepricingStatus();
  const { tabId: nosposTabId } = await openBackgroundNosposTab(url, appTabId);

  const repricingData = payload.repricingData || [];
  const completedBarcodes = payload.completedBarcodes || {};
  const completedItems = payload.completedItems || [];
  const cartKey = payload.cartKey || '';

  const data = { repricingData, appTabId, completedBarcodes, completedItems, cartKey, nosposTabId };
  const pending = await getPending();
  pending[requestId] = { appTabId, listingTabId: nosposTabId, type: 'openNospos', repricingData };
  await setPending(pending);

  const stored = await chrome.storage.local.get('cgNosposRepricingProgress');
  const merged = stored.cgNosposRepricingProgress && stored.cgNosposRepricingProgress.cartKey === cartKey
    ? { ...data, completedBarcodes: { ...completedBarcodes, ...stored.cgNosposRepricingProgress.completedBarcodes }, completedItems: [...new Set([...completedItems, ...(stored.cgNosposRepricingProgress.completedItems || [])])] }
    : data;
  const initialData = {
    ...merged,
    queue: buildBarcodeQueue(repricingData, merged.completedBarcodes, merged.completedItems, {}),
    awaitingStockSelection: false,
    currentBarcode: '',
    currentItemId: '',
    currentItemIndex: null,
    currentBarcodeIndex: null,
    skippedBarcodes: {},
    ambiguousBarcodes: [],
    unverifiedBarcodes: [],
    justSaved: false,
    verifyRetries: 0,
    done: false,
    pendingCompletion: null,
    verifiedChanges: [],
    logs: [{
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'Started repricing.'
    }],
    step: 'starting',
    message: 'Opening hidden NoSpos worker'
  };
  await chrome.storage.session.set({
    cgNosposRepricingData: initialData
  });
  await chrome.storage.local.set({ cgNosposRepricingProgress: { cartKey, completedBarcodes: merged.completedBarcodes, completedItems: merged.completedItems, appTabId } });
  await broadcastRepricingStatus(appTabId, initialData, {
    step: 'starting',
    message: 'Opening hidden NoSpos worker'
  });

  console.log('[CG Suite] openNosposAndWait – waiting for user to land on nospos.com', { requestId, listingTabId: nosposTabId });
  return { ok: true };
}
