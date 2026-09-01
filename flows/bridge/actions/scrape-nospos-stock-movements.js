/** Read NosPos's stock movement report for each supplied barserial. */

function stripNosposMovementHtml(value) {
  return decodeNosposHtmlText(String(value || '').replace(/<[^>]*>/g, ' '));
}

function classifyNosposStockMovement(summary) {
  const text = String(summary || '').toLowerCase();
  if (text.includes('reversed move to free')) return 'REVERSED_MOVE_TO_FREE';
  if (text.includes('moved to free')) return 'MOVED_TO_FREE';
  if (text.includes('bought back')) return 'BOUGHT_BACK';
  if (text.includes('renewed')) return 'RENEWED';
  if (text.includes('bought from customer')) return 'BOUGHT_FROM_CUSTOMER';
  return 'OTHER';
}

function parseNosposStockMovementsPage(html, requestedBarserial) {
  const details = {};
  const detailRe = /<div[^>]*class="detail"[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<span>([\s\S]*?)<\/span>\s*<\/div>/gi;
  let detail;
  while ((detail = detailRe.exec(html || '')) !== null) {
    details[stripNosposMovementHtml(detail[1])] = stripNosposMovementHtml(detail[2]);
  }

  const movements = [];
  const rowRe = /<tr[^>]*data-key="([^"]+)"[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html || '')) !== null) {
    const summary = stripNosposMovementHtml(row[2]);
    const agreement = row[2].match(/\/agreement\/view\?id=(\d+)/i)?.[1] || null;
    const operator = summary.match(/\bBy:\s*([^,]+?)(?:,\s*Agreement:|$)/i)?.[1]?.trim() || null;
    const price = summary.match(/\bPrice:\s*£?([\d,.]+)/i)?.[1]?.replace(/,/g, '') || null;
    movements.push({
      row_key: String(row[1]),
      summary,
      date: stripNosposMovementHtml(row[3]),
      event_type: classifyNosposStockMovement(summary),
      agreement_id: agreement,
      operator,
      price,
    });
  }

  return {
    barserial: details.Barserial || requestedBarserial || '',
    stock: {
      name: details.Name || '',
      category: details.Category || '',
      retail_price: details['Retail Price'] || '',
      cost_price: details['Cost Price'] || '',
      quantity: details.Quantity || '',
      quantity_12: details['Quantity 12'] || '',
      quantity_28: details['Quantity 28'] || '',
      faulty_quantity: details['Faulty Quantity'] || '',
    },
    movements,
  };
}

async function handleBridgeAction_scrapeNosposStockMovements({ requestId, appTabId, pageInstanceId, payload }) {
  const targets = Array.isArray(payload?.targets) ? payload.targets.filter((target) => target?.barserial) : [];
  if (!targets.length) return { ok: false, error: 'No barserials were supplied.' };
  if (targets.length > 100) return { ok: false, error: 'A maximum of 100 barserials may be read at once.' };

  const emit = (progress) => appTabId && chrome.tabs.sendMessage(
    appTabId, { type: 'EXTENSION_PROGRESS_TO_PAGE', requestId, payload: progress },
  ).catch(() => {});
  nosposAbort.begin(appTabId, pageInstanceId);
  let loginRequired = false;
  const failures = [];
  const results = [];
  const fetched = await nosposFetchPool(targets, async (target) => {
    const url = `https://nospos.com/reports/stock/movements?barserial=${encodeURIComponent(target.barserial)}`;
    return { target, url, response: await nosposCredentialedHtmlFetch(url) };
  }, {
    shouldStop: () => loginRequired || nosposAbort.isAborted(appTabId),
    onProgress: (done, total, entry) => {
      if (entry?.ok && entry.value?.response?.loginRequired) loginRequired = true;
      emit({ done, total, failures: failures.length });
    },
  });

  if (loginRequired) return { ok: false, loginRequired: true, results };
  fetched.forEach((entry) => {
    if (!entry?.ok) { failures.push({ barserial: '', error: entry?.error || 'Fetch failed' }); return; }
    const { target, url, response } = entry.value;
    if (!response.ok) { failures.push({ barserial: target.barserial, url, error: response.error || 'Fetch failed' }); return; }
    results.push({ ...parseNosposStockMovementsPage(response.html, target.barserial), url });
  });
  return { ok: true, results, failures };
}
