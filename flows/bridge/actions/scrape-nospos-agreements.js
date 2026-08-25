/**
 * Read NosPos agreement pages (`/agreement/view?id=…`) in the background and
 * return their contents structured.
 *
 * Migration reaches these from the payment report's Pay-Out rows, each of which
 * links to the agreement the money went out on. Nothing is opened or clicked:
 * this is the same credentialed fetch walk the payment report itself uses, so a
 * hundred agreements cost a hundred fetches and no tabs.
 *
 * What it pulls off each page:
 *   header    — the detail-view pairs (ID, Type, Status, Started, Expires, Created)
 *               plus the whole `details` map verbatim, because an EasyPay (SA)
 *               page carries money the buyback pages don't (Deposit, Total,
 *               Total Paid, To Pay) and the trading report needs the Total: a
 *               completed EasyPay ticket counts as a sale at its FULL price on
 *               the day it completes, not at the instalment that finished it
 *   customer  — display name, address line, and the customer id out of its href
 *   items     — the Items grid (barserial, stock id, product, location, rate,
 *               qty, bought/renew/buy-back prices, per-item status)
 *   payments  — the Payments grid (type, method, till, amount, created, by)
 *
 * Tables are identified by their OWN header cells rather than by position or
 * DOM id, because the page carries three similar grids — Items, the late-fee
 * calculator, and Payments — and the late-fee one repeats "Rate"/"Bought For"
 * closely enough to be mistaken for Items if you go by column names alone. The
 * discriminator is "Barserial" + "Qty", which only the real Items grid has.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

const NOSPOS_AGREEMENT_MAX = 500;

function nosposAgreementText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&pound;/gi, '£')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&hellip;/gi, '\u2026')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `<div class="detail"><strong>KEY</strong><span>VALUE</span></div>` pairs. */
function parseNosposAgreementDetails(html) {
  const details = {};
  const re = /<div class="detail">\s*<strong>([\s\S]*?)<\/strong>\s*<span>([\s\S]*?)<\/span>\s*<\/div>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const key = nosposAgreementText(match[1]);
    if (key) details[key] = nosposAgreementText(match[2]);
  }
  return details;
}

/** Name + address + customer id from the profile block at the top left. */
function parseNosposAgreementCustomer(html) {
  const linkRe = /<a\s+href="\/customer\/(\d+)\/[a-z-]+"[^>]*>([\s\S]*?)<\/a>/i;
  const link = html.match(linkRe);
  let address = '';
  const addressRe = /<p class="text-muted[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
  const addressMatch = html.match(addressRe);
  if (addressMatch) address = nosposAgreementText(addressMatch[1]);
  return {
    nospos_customer_id: link ? link[1] : '',
    name: link ? nosposAgreementText(link[2]) : '',
    address,
  };
}

/** Every `<table class="table table-hover">` as { headers: [...], rows: [[cellHtml]] }. */
function parseNosposAgreementTables(html) {
  const tables = [];
  const tableRe = /<table class="table table-hover">([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const body = tableMatch[1];
    const headers = [];
    const headRe = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
    let headMatch;
    while ((headMatch = headRe.exec(body)) !== null) headers.push(nosposAgreementText(headMatch[1]));
    const rows = [];
    const rowRe = /<tr\b[^>]*\bdata-key="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(body)) !== null) {
      const cells = [];
      const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[2])) !== null) cells.push(cellMatch[1]);
      rows.push({ key: rowMatch[1], cells });
    }
    tables.push({ headers, rows });
  }
  return tables;
}

function findTable(tables, required) {
  return tables.find((table) =>
    required.every((name) =>
      table.headers.some((header) => header.toLowerCase() === name.toLowerCase()),
    ),
  ) || null;
}

/** Value of the column named `name`, by that table's own header order. */
function cellByHeader(table, row, name) {
  const index = table.headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  if (index < 0 || index >= row.cells.length) return '';
  return nosposAgreementText(row.cells[index]);
}

function parseNosposAgreementItems(tables) {
  // "Barserial" + "Qty" is what tells the real Items grid apart from the
  // late-fee calculator, which also carries Rate and Bought For.
  const table = findTable(tables, ['Barserial', 'Qty']);
  if (!table) return [];
  return table.rows.map((row) => {
    const barserialCell = row.cells[table.headers.findIndex((h) => h.toLowerCase() === 'barserial')] || '';
    const stockMatch = barserialCell.match(/\/stock\/(\d+)\/edit/i);
    const productCell = row.cells[table.headers.findIndex((h) => h.toLowerCase() === 'product')] || '';
    // The grey <small> under the product name is NosPos's own reference, not
    // part of the product name — keep them apart so item_name stays clean.
    const smallMatch = productCell.match(/<small\b[^>]*>([\s\S]*?)<\/small>/i);
    const productName = nosposAgreementText(productCell.replace(/<small\b[^>]*>[\s\S]*?<\/small>/i, ''));
    return {
      nospos_item_id: row.key,
      barserial: nosposAgreementText(barserialCell),
      nospos_stock_id: stockMatch ? stockMatch[1] : '',
      product: productName,
      product_ref: smallMatch ? nosposAgreementText(smallMatch[1]) : '',
      location: cellByHeader(table, row, 'Location'),
      rate: cellByHeader(table, row, 'Rate'),
      quantity: cellByHeader(table, row, 'Qty'),
      bought_for: cellByHeader(table, row, 'Bought For'),
      // NosPos writes these in the PAST tense - "Renewed For", "Bought Back
      // For" - and the present-tense guesses returned nothing at all, which is
      // how a buyback fee line can read £0 while the page plainly shows money.
      // Both spellings are tried so an older page shape still parses.
      renew_for: cellByHeader(table, row, 'Renewed For') || cellByHeader(table, row, 'Renew For'),
      buy_back_for: cellByHeader(table, row, 'Bought Back For') || cellByHeader(table, row, 'Buy Back For'),
      status: cellByHeader(table, row, 'Status'),
    };
  });
}

/**
 * The Charges grid - "Agreement Item Late Fee £28" and the like.
 *
 * Not needed to work out the fee (that falls out of payment minus principal),
 * but it is the evidence for WHY a redemption cost more than its buy-back
 * price, and without it a £28 difference looks like a bug rather than a charge.
 */
function parseNosposAgreementCharges(tables) {
  const table = tables.find(
    (candidate) =>
      candidate.headers.some((h) => h.toLowerCase() === 'charge')
      && candidate.headers.some((h) => h.toLowerCase().includes('agreement item id')),
  );
  if (!table) return [];
  return table.rows.map((row) => ({
    nospos_charge_id: row.key,
    nospos_item_id: nosposAgreementText(
      row.cells[table.headers.findIndex((h) => h.toLowerCase().includes('agreement item id'))] || '',
    ),
    type: nosposAgreementText(row.cells[table.headers.findIndex((h) => h.toLowerCase() === 'type')] || ''),
    amount: nosposAgreementText(row.cells[table.headers.findIndex((h) => h.toLowerCase() === 'charge')] || ''),
    created: nosposAgreementText(row.cells[table.headers.findIndex((h) => h.toLowerCase() === 'created')] || ''),
    created_by: nosposAgreementText(row.cells[table.headers.findIndex((h) => h.toLowerCase() === 'created by')] || ''),
  }));
}

function parseNosposAgreementPayments(tables) {
  // Payments is the grid with Method + Created By and no Barserial.
  const table = tables.find(
    (candidate) =>
      candidate.headers.some((h) => h.toLowerCase() === 'method')
      && candidate.headers.some((h) => h.toLowerCase() === 'created by')
      && !candidate.headers.some((h) => h.toLowerCase() === 'barserial'),
  );
  if (!table) return [];
  return table.rows.map((row) => ({
    payment_id: row.key,
    type: cellByHeader(table, row, 'Type'),
    method: cellByHeader(table, row, 'Method'),
    till: cellByHeader(table, row, 'Till'),
    amount: cellByHeader(table, row, 'Amount'),
    created: cellByHeader(table, row, 'Created'),
    created_by: cellByHeader(table, row, 'Created By'),
  }));
}

/** The selected `<option>` of one `<select>`, as { value, label }. */
function nosposSelectedOption(html, selectId) {
  const blockRe = new RegExp(`<select[^>]*id="${selectId}"[\\s\\S]*?</select>`, 'i');
  const block = html.match(blockRe);
  if (!block) return { value: '', label: '' };
  const optionRe = /<option\s+value="([^"]*)"[^>]*\sselected[^>]*>([\s\S]*?)<\/option>/i;
  const option = block[0].match(optionRe);
  if (!option) return { value: '', label: '' };
  return { value: option[1], label: nosposAgreementText(option[2]) };
}

/**
 * The parts of a stock-edit page that `parseNosposStockEditPageDetails` (in
 * bg/nospos-html.js) doesn't already cover: the Summary card's own detail pairs
 * and the two dropdowns whose meaning lives in the SELECTED option rather than
 * in an input value.
 */
function parseNosposStockPageExtras(html) {
  const details = parseNosposAgreementDetails(html);
  const grade = nosposSelectedOption(html, 'stock-grade');
  const category = nosposSelectedOption(html, 'stock-category');
  return {
    stock_type: details.Type || '',            // "Bought", "Traded", …
    total_quantity: details['Total Quantity'] || '',
    created_by: details['Created By'] || '',
    bought_by: details['Bought By'] || '',
    grade: grade.label || '',
    // NosPos's own category tree ("Video Games > Consoles > Microsoft > …"),
    // which is NOT our ProductCategory — kept as evidence, never as a match.
    nospos_category: category.label || '',
    nospos_category_id: category.value || '',
  };
}

function parseNosposAgreementPage(html, url) {
  const tables = parseNosposAgreementTables(html);
  const details = parseNosposAgreementDetails(html);
  const idMatch = String(url || '').match(/[?&]id=(\d+)/);
  return {
    url,
    nospos_agreement_id: details.ID || (idMatch ? idMatch[1] : ''),
    type: details.Type || '',
    status: details.Status || '',
    started: details.Started || '',
    expires: details.Expires || '',
    created: details.Created || '',
    // EasyPay's own figures. Named here because the trading report depends on
    // them, and passed through whole in `details` so the next field NosPos adds
    // costs a transform change rather than another extension release.
    deposit: details.Deposit || '',
    total: details.Total || '',
    total_paid: details['Total Paid'] || '',
    to_pay: details['To Pay'] || '',
    details,
    customer: parseNosposAgreementCustomer(html),
    items: parseNosposAgreementItems(tables),
    payments: parseNosposAgreementPayments(tables),
    charges: parseNosposAgreementCharges(tables),
  };
}

async function handleBridgeAction_scrapeNosposAgreements({ requestId, appTabId, pageInstanceId, payload }) {
  const urls = Array.isArray(payload?.urls) ? payload.urls.filter(Boolean) : [];
  if (!urls.length) return { ok: false, error: 'No agreement links were supplied.' };
  if (urls.length > NOSPOS_AGREEMENT_MAX) {
    return { ok: false, error: `Refusing to read ${urls.length} agreements in one go (max ${NOSPOS_AGREEMENT_MAX}).` };
  }

  const emitProgress = (data) => {
    if (!appTabId) return;
    chrome.tabs
      .sendMessage(appTabId, { type: 'EXTENSION_PROGRESS_TO_PAGE', requestId, payload: data })
      .catch(() => { /* app tab may be gone; not fatal */ });
  };

  // Each item's barserial links to its stock record, which carries what the
  // agreement row leaves out: cost and retail price, grade, NosPos's category,
  // who bought it in, and the stock's own created time. Following those is one
  // extra fetch per item, so it is opt-in (`withStock`, on by default) and each
  // one is reported through progress — a 40-item batch is 40 more reads.
  const withStock = payload?.withStock !== false;

  // ── Phase 1: every agreement page, concurrently. ────────────────────────
  //
  // This used to be a `for … await` loop — one page in flight at a time, the
  // next request not even sent until the last had been parsed. The pool runs
  // several at once and stands down on its own when NosPos throttles.
  // A fresh walk for this tab clears any earlier stop, so one abort cannot
  // poison every later capture from the same page.
  nosposAbort.begin(appTabId, pageInstanceId);
  const stopped = () => nosposAbort.isAborted(appTabId);
  let loginRequired = false;
  const agreements = [];
  const failures = [];

  const pageResults = await nosposFetchPool(
    urls,
    async (url) => {
      const r = await nosposCredentialedHtmlFetch(url);
      return { url, r };
    },
    {
      shouldStop: () => loginRequired || stopped(),
      onProgress: (done, total, entry) => {
        if (entry?.ok && entry.value?.r?.loginRequired) loginRequired = true;
        emitProgress({ done, total, failures: failures.length, stage: 'agreement' });
      },
    },
  );

  // Login trouble is the one failure worth abandoning the batch for: every
  // remaining fetch would hit the same wall and the operator needs telling once.
  if (loginRequired) return { ok: false, loginRequired: true, agreements };

  pageResults.forEach((entry) => {
    if (!entry) return;
    if (!entry.ok) {
      failures.push({ url: '', error: entry.error || 'could not be read' });
      return;
    }
    const { url, r } = entry.value;
    if (!r.ok) {
      // One unreadable agreement must not sink the batch — record it and carry
      // on, so the dry run can say exactly which ones are missing.
      failures.push({ url, error: r.error || 'could not be read' });
      return;
    }
    const agreement = parseNosposAgreementPage(r.html, r.finalUrl || url);
    // The raw body rides along so the migration can stage it server-side and
    // re-parse later without walking NosPos again. Additive and optional — an
    // older Cash EPOS build simply ignores the field.
    agreement.html = r.html;
    agreements.push(agreement);
  });

  // ── Phase 2: the stock behind every item, deduplicated across agreements. ──
  //
  // Flattened rather than nested per agreement, for two reasons. Concurrency:
  // a pool inside a pool would have serialised each agreement's items anyway.
  // And identity: the SAME stock unit appears on every renewal fork of the
  // contract it sits on, so a nested walk re-reads one unit once per fork. One
  // flat list keyed by stock id reads it once.
  if (withStock) {
    const wanted = new Map();
    agreements.forEach((agreement) => {
      (agreement.items || []).forEach((item) => {
        if (!item.nospos_stock_id) return;
        const key = String(item.nospos_stock_id);
        if (!wanted.has(key)) wanted.set(key, []);
        wanted.get(key).push(item);
      });
    });

    const stockIds = [...wanted.keys()];
    if (stockIds.length) {
      const stockResults = await nosposFetchPool(
        stockIds,
        async (stockId) => {
          const stockUrl = `https://nospos.com/stock/${stockId}/edit`;
          const r = await nosposCredentialedHtmlFetch(stockUrl);
          return { stockId, stockUrl, r };
        },
        {
          shouldStop: stopped,
          onProgress: (done, total) => emitProgress({
            done, total, failures: failures.length, stage: 'stock',
          }),
        },
      );

      stockResults.forEach((entry) => {
        if (!entry) return;
        if (!entry.ok) return;
        const { stockId, stockUrl, r } = entry.value;
        const items = wanted.get(String(stockId)) || [];
        if (!r.ok) {
          // A missing stock page is a gap in detail, not a reason to lose the
          // agreement it belongs to.
          const stock = { url: stockUrl, error: r.loginRequired ? 'login required' : (r.error || 'could not be read') };
          items.forEach((item) => { item.stock = { ...stock }; });
          return;
        }
        const base = parseNosposStockEditPageDetails(r.html);
        const stock = {
          url: stockUrl,
          nospos_stock_id: String(stockId),
          name: base.name,
          cost_price: base.costPrice,
          retail_price: base.retailPrice,
          quantity: base.quantity,
          created_at: base.createdAt,
          externally_listed: base.externallyListed,
          // The stock record's own Changes grid — every edit NosPos logged, with
          // who made it and when. This is the history our InventoryUnitAudit
          // table is for, so it comes back whole rather than summarised.
          change_log: base.changeLog || [],
          ...parseNosposStockPageExtras(r.html),
        };
        // Each item gets its own copy: the migration mutates these downstream
        // and a shared object would let one agreement's edit reach another's.
        items.forEach((item) => { item.stock = { ...stock, html: r.html }; });
      });
    }
  }

  if (stopped()) {
    return { ok: false, aborted: true, error: `Stopped — ${nosposAbort.reasonFor(appTabId) || 'the page that started this went away'}.`, agreements };
  }

  console.log('[CG Suite] agreements scraped', { ok: agreements.length, failed: failures.length });
  return { ok: true, agreements, failures };
}
