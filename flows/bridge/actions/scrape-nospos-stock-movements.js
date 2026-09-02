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
    valid: Boolean(details.Barserial && /<h4[^>]*class="[^"]*card-title[^"]*"[^>]*>\s*Movements\s*<\/h4>/i.test(html || '')),
  };
}

function nosposStockMovementFetchWithTimeout(url, timeoutMs) {
  return Promise.race([
    nosposCredentialedHtmlFetch(url),
    new Promise((resolve) => setTimeout(
      () => resolve({ ok: false, error: `NosPos did not answer within ${Math.round(timeoutMs / 1000)} seconds` }),
      timeoutMs,
    )),
  ]);
}

/**
 * Did this response mean the SESSION is gone, or just that this one page is?
 *
 * `nosposCredentialedHtmlFetch` reports 401/403 and a login redirect alike as
 * `loginRequired`, which is right for a single page read on demand and wrong
 * for a walk: one barserial NosPos refuses (deleted stock, another shop's item)
 * would otherwise be read as "you are logged out" and end a run of ten thousand.
 * Only a redirect away from the report is a lost session.
 */
function nosposStockMovementSessionLost(response) {
  if (!response || !response.loginRequired) return false;
  const finalUrl = String(response.finalUrl || '').toLowerCase();
  if (!finalUrl) return true;
  return !finalUrl.includes('/reports/stock/movements');
}

async function scrapeOneNosposStockMovementTarget(target) {
  const requested = String(target.barserial || '').trim();
  const firstUrl = `https://nospos.com/reports/stock/movements?barserial=${encodeURIComponent(requested)}`;
  let lastError = 'NosPos returned an unreadable stock movements page.';

  // The shared fetch helper already retries throttles/network errors five times.
  // This extra page-level retry covers a successful HTTP response containing a
  // half-rendered/error grid — something NosPos does under load with status 200.
  for (let pageAttempt = 0; pageAttempt < 2; pageAttempt += 1) {
    let url = firstUrl;
    const pagesSeen = new Set();
    let combined = null;
    let failed = null;
    for (let page = 0; page < 20 && url; page += 1) {
      if (pagesSeen.has(url)) { failed = 'NosPos pagination looped back to an earlier page.'; break; }
      pagesSeen.add(url);
      const response = await nosposStockMovementFetchWithTimeout(url, 45_000);
      if (!response.ok) return { target, url, response };
      const parsed = parseNosposStockMovementsPage(response.html, requested);
      if (!parsed.valid || parsed.barserial.toLowerCase() !== requested.toLowerCase()) {
        failed = parsed.barserial
          ? `NosPos returned barserial ${parsed.barserial} while ${requested} was requested.`
          : 'NosPos returned a page without the Stock and Movements sections.';
        break;
      }
      if (!combined) combined = { ...parsed, movements: [] };
      combined.movements.push(...parsed.movements);
      const next = parseNosposPaginationNextHref(response.html, response.finalUrl || url);
      if (next && !next.includes('/reports/stock/movements')) {
        failed = 'NosPos pagination pointed outside the stock movements report.';
        break;
      }
      url = next;
    }
    if (url && !failed) failed = 'NosPos stock movement history exceeded the 20-page safety limit.';
    if (!failed && combined) {
      const unique = new Map();
      combined.movements.forEach((movement) => {
        const key = `${movement.row_key}|${movement.date}|${movement.summary}`;
        if (!unique.has(key)) unique.set(key, movement);
      });
      combined.movements = [...unique.values()];
      return { target, url: firstUrl, response: { ok: true }, parsed: combined, pages: pagesSeen.size };
    }
    lastError = failed || lastError;
    await nosposHtmlFetchSleep(600 + Math.floor(Math.random() * 300));
  }
  return { target, url: firstUrl, response: { ok: false, error: lastError } };
}

async function handleBridgeAction_scrapeNosposStockMovements({ requestId, appTabId, pageInstanceId, payload }) {
  const deduplicated = new Map();
  (Array.isArray(payload?.targets) ? payload.targets : []).forEach((target) => {
    const barserial = String(target?.barserial || target?.barcode || '').trim();
    const key = barserial.toLowerCase();
    if (key && !deduplicated.has(key)) deduplicated.set(key, { ...target, barserial });
  });
  const targets = [...deduplicated.values()];
  if (!targets.length) return { ok: false, error: 'No barserials were supplied.' };
  if (targets.length > 100) return { ok: false, error: 'A maximum of 100 barserials may be read at once.' };

  const emit = (progress) => appTabId && chrome.tabs.sendMessage(
    appTabId, { type: 'EXTENSION_PROGRESS_TO_PAGE', requestId, payload: progress },
  ).catch(() => {});
  nosposAbort.begin(appTabId, pageInstanceId);
  // A walk that a previous capture's throttling knocked down to one in flight
  // stays there: the governor only climbs a slot per twenty clean pages, so a
  // ten-thousand barserial run inherits a crawl it did nothing to earn. This
  // step is the operator's whole action, so it starts from a clean ceiling.
  nosposFetchGovernor.reset();
  let sessionLost = false;
  const failures = [];
  const results = [];
  let completedFailures = 0;
  const fetched = await nosposFetchPool(targets, scrapeOneNosposStockMovementTarget, {
    shouldStop: () => sessionLost || nosposAbort.isAborted(appTabId),
    onProgress: (done, total, entry) => {
      if (entry?.ok && nosposStockMovementSessionLost(entry.value?.response)) sessionLost = true;
      if (!entry?.ok || (entry.value?.response && !entry.value.response.ok)) completedFailures += 1;
      emit({ done, total, failures: completedFailures, concurrency: nosposFetchGovernor.current() });
    },
  });

  fetched.forEach((entry, index) => {
    const expected = targets[index];
    // A slot the pool never got to (the walk stopped, or the tab went away)
    // has no entry at all. It is not a failure to report against a barserial —
    // it simply was not attempted, and the next run picks it up.
    if (entry === undefined) return;
    if (!entry?.ok) { failures.push({ barserial: expected?.barserial || '', error: entry?.error || 'Fetch failed' }); return; }
    const { target, url, response } = entry.value;
    if (!response.ok) {
      failures.push({
        barserial: target.barserial,
        url,
        error: response.error
          || (response.loginRequired
            ? `NosPos refused this page (HTTP ${response.status || '403'})`
            : 'Fetch failed'),
      });
      return;
    }
    results.push({ ...entry.value.parsed, url, pages: entry.value.pages });
  });

  // Everything that WAS read comes back, whatever ended the walk. Returning
  // only the verdict threw away every page already fetched, so a single refused
  // barserial cost the whole batch and the run could never save a row.
  return {
    ok: true,
    requested: targets.length,
    completed: results.length + failures.length,
    attempted: fetched.filter((entry) => entry !== undefined).length,
    results,
    failures,
    loginRequired: sessionLost,
    stopped: nosposAbort.isAborted(appTabId) ? (nosposAbort.reasonFor(appTabId) || 'stopped') : '',
  };
}
