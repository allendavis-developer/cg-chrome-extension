/**
 * Read NosPos's own Trading Report (`/reports/management/trading/view`) so ours
 * can be checked against it automatically.
 *
 * This is the answer to "is it right on a day I have not tested?". Every rule in
 * computeTradingReport was worked out from a handful of days held up against
 * NosPos by eye; this makes that comparison one click, on any day, so a rule
 * that only fits the days it was derived from gets caught immediately.
 *
 * Only the Sales & Income Summary is parsed - that is the table our report
 * mirrors. Cells NosPos leaves blank (`class="empty"`) come back as null rather
 * than zero, because "not applicable" and "nil" are different claims and a diff
 * that confuses them would report differences that are not there.
 *
 * The report is filtered by `TradingReportForm[fromDate]` / `[toDate]`, the same
 * pair its own filter form submits, so any day can be checked without opening
 * NosPos first. The page's printed date comes back as well, and the caller
 * compares it with what it asked for - a silent fall back to today would diff
 * this morning's figures against a day in July and call it a match.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

const NOSPOS_TRADING_REPORT_URL = 'https://nospos.com/reports/management/trading/view';

/** The `<p class="category">3 Jul 2026</p>` under the report's title. */
function parseNosposTradingReportDate(html) {
  const match = String(html || '').match(/<p class="category">([\s\S]*?)<\/p>/i);
  return match ? nosposAgreementText(match[1]) : '';
}

/**
 * "£1,675" → 1675 · "42.36%" → 42.36 · "-£35" → -35 · an empty cell → null.
 *
 * Null matters: NosPos prints nothing in the cells a line does not have (a fee
 * has no cost), and turning those into 0 would invent agreement or difference
 * where there is neither.
 */
function parseNosposTradingReportCell(cellHtml) {
  if (/class="empty"/i.test(cellHtml)) return null;
  const text = nosposAgreementText(cellHtml).replace(/[£,%\s]/g, '');
  if (!text || text === '-') return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * The Sales & Income Summary rows, in the order NosPos prints them.
 *
 * Found by its own heading rather than by position: the page carries four
 * similar tables (Agreements Overview, Stock & Balances, Income vs Target,
 * Sales by User) and any of them would parse into plausible-looking nonsense.
 */
function parseNosposTradingReportSummary(html) {
  const section = String(html || '').split(/<h5>\s*Sales\s*&(?:amp;)?\s*Income Summary\s*<\/h5>/i)[1];
  if (!section) return [];
  const table = section.split('</table>')[0] || '';
  const rows = [];
  const rowRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(table)) !== null) {
    const cells = [];
    const cellRe = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[2])) !== null) {
      cells.push(`<td${cellMatch[1]}>${cellMatch[2]}</td>`);
    }
    if (cells.length < 7) continue;                 // the header row has <th>
    rows.push({
      label: nosposAgreementText(cells[0]),
      gross: parseNosposTradingReportCell(cells[1]),
      vat: parseNosposTradingReportCell(cells[2]),
      net: parseNosposTradingReportCell(cells[3]),
      cost: parseNosposTradingReportCell(cells[4]),
      margin: parseNosposTradingReportCell(cells[5]),
      percent: parseNosposTradingReportCell(cells[6]),
      is_total: /class="[^"]*\btotal\b/i.test(rowMatch[1]),
    });
  }
  return rows;
}

async function handleBridgeAction_scrapeNosposTradingReport({ payload }) {
  const fromDate = String(payload?.fromDate || payload?.date || '').trim();
  const toDate = String(payload?.toDate || payload?.date || '').trim();
  let url = NOSPOS_TRADING_REPORT_URL;
  if (fromDate || toDate) {
    const params = new URLSearchParams();
    params.set('TradingReportForm[fromDate]', fromDate || toDate);
    params.set('TradingReportForm[toDate]', toDate || fromDate);
    url = `${NOSPOS_TRADING_REPORT_URL}?${params.toString()}`;
  }

  const r = await nosposCredentialedHtmlFetch(url);
  if (r.loginRequired) return { ok: false, loginRequired: true };
  if (!r.ok) return { ok: false, error: r.error || 'Could not read the NosPos trading report.' };

  const rows = parseNosposTradingReportSummary(r.html);
  if (!rows.length) {
    return { ok: false, error: 'Read the page but found no Sales & Income Summary on it.' };
  }
  return {
    ok: true,
    url: r.finalUrl || url,
    requested_date: fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`,
    reported_date: parseNosposTradingReportDate(r.html),
    rows,
  };
}
