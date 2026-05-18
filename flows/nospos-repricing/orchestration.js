/**
 * NosPos repricing orchestration: next-barcode picker, ambiguous-barcode handling,
 * completion payload builder, finalizeNosposRepricing.
 */

function findNextBarcode(repricingData, completedBarcodes, completedItems, skippedBarcodes = {}) {
  for (let i = 0; i < repricingData.length; i++) {
    const item = repricingData[i];
    if (completedItems.includes(item?.itemId)) continue;
    const done = completedBarcodes[item?.itemId] || [];
    const skipped = skippedBarcodes[item?.itemId] || [];
    for (let j = 0; j < (item?.barcodes?.length || 0); j++) {
      if (done.includes(j) || skipped.includes(j)) continue;
      const barcode = (item.barcodes[j] || '').trim();
      if (barcode) return { itemIndex: i, barcodeIndex: j, barcode };
    }
  }
  return null;
}

function applyVerifiedBarcodeCompletion(data) {
  const pendingCompletion = data?.pendingCompletion;
  if (!pendingCompletion?.itemId || pendingCompletion?.barcodeIndex == null) {
    return null;
  }

  const completedBarcodes = { ...(data.completedBarcodes || {}) };
  const completedItems = [...(data.completedItems || [])];
  const itemId = pendingCompletion.itemId;
  const barcodeIndex = pendingCompletion.barcodeIndex;

  if (!completedBarcodes[itemId]) completedBarcodes[itemId] = [];
  if (!completedBarcodes[itemId].includes(barcodeIndex)) {
    completedBarcodes[itemId] = [...completedBarcodes[itemId], barcodeIndex];
  }

  const item = (data.repricingData || []).find((entry) => entry?.itemId === itemId);
  const itemBarcodeCount = item?.barcodes?.length || 0;
  if (itemBarcodeCount > 0 && completedBarcodes[itemId].length >= itemBarcodeCount && !completedItems.includes(itemId)) {
    completedItems.push(itemId);
  }

  const verifiedChanges = [...(data.verifiedChanges || [])];
  if (item) {
    verifiedChanges.push({
      item_identifier: item.itemId != null ? String(item.itemId) : '',
      title: item.title || '',
      quantity: item.quantity || 1,
      barcode: pendingCompletion.barcode || '',
      stock_barcode: pendingCompletion.stockBarcode || '',
      stock_url: pendingCompletion.stockUrl || '',
      old_retail_price: pendingCompletion.oldRetailPrice || null,
      new_retail_price: item.salePrice != null ? String(item.salePrice) : null,
      cex_sell_at_repricing: item.cexSellAtRepricing != null ? String(item.cexSellAtRepricing) : null,
      our_sale_price_at_repricing: item.ourSalePriceAtRepricing != null ? String(item.ourSalePriceAtRepricing) : null,
      raw_data: item.raw_data || {},
      cash_converters_data: item.cash_converters_data || {}
    });
  }

  return { completedBarcodes, completedItems, verifiedChanges };
}

function markBarcodeAsAmbiguous(data, next) {
  if (!data || !next) return data;

  const item = (data.repricingData || [])[next.itemIndex];
  const itemId = item?.itemId;
  if (itemId == null) return data;

  const skippedBarcodes = { ...(data.skippedBarcodes || {}) };
  if (!skippedBarcodes[itemId]) skippedBarcodes[itemId] = [];
  if (!skippedBarcodes[itemId].includes(next.barcodeIndex)) {
    skippedBarcodes[itemId] = [...skippedBarcodes[itemId], next.barcodeIndex];
  }

  const ambiguousBarcodes = [...(data.ambiguousBarcodes || [])];
  const alreadyTracked = ambiguousBarcodes.some(
    (entry) => String(entry?.itemId) === String(itemId) && entry?.barcodeIndex === next.barcodeIndex
  );

  if (!alreadyTracked) {
    ambiguousBarcodes.push({
      itemId,
      itemTitle: item?.title || '',
      barcodeIndex: next.barcodeIndex,
      barcode: next.barcode
    });
  }

  return {
    ...data,
    skippedBarcodes,
    ambiguousBarcodes,
    awaitingStockSelection: false,
    currentBarcode: '',
    verifyRetries: 0
  };
}

function buildRepricingCompletionPayload(data) {
  const verifiedChanges = [...(data?.verifiedChanges || [])];
  const ambiguousBarcodes = [...(data?.ambiguousBarcodes || [])];
  const unverifiedBarcodes = [...(data?.unverifiedBarcodes || [])];

  return {
    cart_key: data?.cartKey || '',
    item_count: [...new Set(verifiedChanges.map((item) => item.item_identifier).filter(Boolean))].length,
    barcode_count: verifiedChanges.length,
    items_data: verifiedChanges,
    ambiguous_barcodes: ambiguousBarcodes,
    unverified_barcodes: unverifiedBarcodes
  };
}

async function finalizeNosposRepricing(data, tabId) {
  const completedData = appendRepricingLog(
    { ...data, done: true, step: 'completed', message: 'Repricing completed.' },
    'Repricing completed.',
    'success'
  );
  const finalPayload = buildRepricingCompletionPayload(data);
  if (finalPayload.barcode_count > 0 || finalPayload.ambiguous_barcodes.length > 0) {
    await setLastRepricingResult(finalPayload);
    await sendRepricingComplete(data?.appTabId, finalPayload);
  }
  await setRepricingStatus(buildRepricingStatusPayload(completedData, {
    step: 'completed',
    message: 'Repricing completed.'
  }));
  await clearNosposRepricingState(tabId);
  await focusAppTab(data?.appTabId);
  if (tabId != null) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  return finalPayload;
}
