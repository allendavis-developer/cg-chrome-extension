/**
 * Read NosPos sale pages (`/newsales/cart/{id}/view`) in the background, then
 * each sold item's stock record.
 *
 * This is what makes a trading report add up. The payment report says what money
 * moved; only the cart says what GOODS moved, and only the stock record behind
 * each line says what those goods cost us. Without this hop there is no cost, so
 * no VAT under the margin scheme, no margin, and no way to tell a graded sale
 * from a second-hand one.
 *
 * What it pulls off each cart:
 *   header   — the detail pairs (ID, Amount, Customer, Status, Created,
 *              Created By). **Created By is the seller**, and it is not the same
 *              person as the one who took the money: on 19 Aug a cart Charlie17
 *              rang up was paid at Becca's till, and the trading report credits
 *              Charlie17. Sales-by-user reads THIS field, never the payment's.
 *   items    — the Items grid: barserial + its stock id, name, price, quantity,
 *              subtotal, and per-line status ("Active", "Refunded")
 *   payments — the Payments grid, including the negative refund lines
 *   returns  — the Returns grid, present only once something has come back. Free
 *              Qty is the bit that matters: goods physically returned means the
 *              cost reverses, where a price adjustment leaves it spent.
 *   stock    — per item, the same stock-record read the agreement scrape does:
 *              cost, retail, grade, category, and Type ("Bought"/"Supplied").
 *              Type is the graded/second-hand split — supplied stock is graded.
 *
 * Tables are found by their own header cells, never by position: a refunded cart
 * carries three similar grids (Items, Payments, Returns) and the order they
 * appear in depends on whether anything was returned.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

const NOSPOS_CART_MAX = 500;

/** `/newsales/cart/70538/view` → "70538" */
function nosposCartIdFromUrl(url) {
  const match = String(url || '').match(/\/newsales\/cart\/(\d+)/i);
  return match ? match[1] : '';
}

function nosposCartRowCell(table, row, header) {
  const index = table.headers.findIndex(
    (h) => h.toLowerCase() === String(header).toLowerCase(),
  );
  if (index < 0) return '';
  return nosposAgreementText(row.cells[index] || '');
}

/** The Items grid: the one with Barserial AND Subtotal. */
function parseNosposCartItems(tables) {
  const table = tables.find(
    (candidate) =>
      candidate.headers.some((h) => h.toLowerCase() === 'barserial')
      && candidate.headers.some((h) => h.toLowerCase() === 'subtotal'),
  );
  if (!table) return [];
  return table.rows.map((row) => {
    const barserialCell = row.cells[table.headers.findIndex((h) => h.toLowerCase() === 'barserial')] || '';
    const stockMatch = barserialCell.match(/\/stock\/(\d+)\/edit/i);
    return {
      nospos_cart_item_id: row.key,
      barserial: nosposAgreementText(barserialCell),
      nospos_stock_id: stockMatch ? stockMatch[1] : '',
      name: nosposCartRowCell(table, row, 'Name'),
      price: nosposCartRowCell(table, row, 'Price'),
      quantity: nosposCartRowCell(table, row, 'Quantity'),
      subtotal: nosposCartRowCell(table, row, 'Subtotal'),
      status: nosposCartRowCell(table, row, 'Status'),
    };
  });
}

/** The Payments grid: Method + Amount, and no Barserial. */
function parseNosposCartPayments(tables) {
  const table = tables.find(
    (candidate) =>
      candidate.headers.some((h) => h.toLowerCase() === 'method')
      && candidate.headers.some((h) => h.toLowerCase() === 'amount')
      && !candidate.headers.some((h) => h.toLowerCase() === 'barserial'),
  );
  if (!table) return [];
  return table.rows.map((row) => ({
    nospos_payment_id: row.key,
    till: nosposCartRowCell(table, row, 'Till'),
    method: nosposCartRowCell(table, row, 'Method'),
    amount: nosposCartRowCell(table, row, 'Amount'),
    description: nosposCartRowCell(table, row, 'Description'),
    created: nosposCartRowCell(table, row, 'Created'),
    created_by: nosposCartRowCell(table, row, 'Created By'),
    status: nosposCartRowCell(table, row, 'Status'),
  }));
}

/** The Returns grid: the one with Free Qty. Absent until something comes back. */
function parseNosposCartReturns(tables) {
  const table = tables.find((candidate) =>
    candidate.headers.some((h) => h.toLowerCase() === 'free qty'),
  );
  if (!table) return [];
  return table.rows.map((row) => ({
    nospos_return_id: row.key,
    nospos_cart_item_id: nosposCartRowCell(table, row, 'Cart Item ID'),
    name: nosposCartRowCell(table, row, 'Name'),
    free_quantity: nosposCartRowCell(table, row, 'Free Qty'),
    faulty_quantity: nosposCartRowCell(table, row, 'Faulty Qty'),
    reason: nosposCartRowCell(table, row, 'Reason'),
    created: nosposCartRowCell(table, row, 'Created'),
    created_by: nosposCartRowCell(table, row, 'Created By'),
  }));
}

/**
 * The buyer's NosPos id, or '' when this sale has no customer.
 *
 * Deliberately NOT "the first customer link on the page": a cart page carries
 * links to customers that have nothing to do with this sale, so taking the
 * first one gave every sale in a day the same wrong buyer — including the sales
 * whose Customer cell plainly read "(not set)".
 *
 * An id is only returned when the detail block names a customer AND a link on
 * the page carries that same name. A name is not an identity, but it is enough
 * to tell the right link from an unrelated one, and a missing id is far better
 * than a confident wrong one — the whole point of capturing this is to avoid
 * duplicating customers on the way in.
 */
function nosposCartCustomerId(html, customerName) {
  var name = String(customerName || '').trim();
  if (!name || /^\(not set\)$/i.test(name)) return '';
  var re = /<a\s+href="\/customer\/(\d+)\/[a-z-]+"[^>]*>([\s\S]*?)<\/a>/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    if (nosposAgreementText(match[2]).toLowerCase() === name.toLowerCase()) return match[1];
  }
  return '';
}

function parseNosposCartPage(html, url) {
  const tables = parseNosposAgreementTables(html);
  const details = parseNosposAgreementDetails(html);
  return {
    url,
    nospos_cart_id: String(details.ID || '').replace('#', '') || nosposCartIdFromUrl(url),
    amount: details.Amount || '',
    customer: details.Customer || '',
    status: details.Status || '',
    created: details.Created || '',
    // The seller. See the note at the top: NOT whoever took the payment.
    created_by: details['Created By'] || '',
    // The buyer's id, matched to the named customer rather than taken from the
    // first customer link on the page — see nosposCartCustomerId.
    nospos_customer_id: nosposCartCustomerId(html, details.Customer),
    details,
    items: parseNosposCartItems(tables),
    payments: parseNosposCartPayments(tables),
    returns: parseNosposCartReturns(tables),
  };
}

async function handleBridgeAction_scrapeNosposCarts({ requestId, appTabId, payload }) {
  const urls = Array.isArray(payload?.urls) ? payload.urls.filter(Boolean) : [];
  if (!urls.length) return { ok: false, error: 'No sale links were supplied.' };
  if (urls.length > NOSPOS_CART_MAX) {
    return { ok: false, error: `Refusing to read ${urls.length} sales in one go (max ${NOSPOS_CART_MAX}).` };
  }

  const emitProgress = (data) => {
    if (!appTabId) return;
    chrome.tabs
      .sendMessage(appTabId, { type: 'EXTENSION_PROGRESS_TO_PAGE', requestId, payload: data })
      .catch(() => { /* app tab may be gone; not fatal */ });
  };

  // On by default here, unlike the agreement scrape: a cart without its stock
  // records is a list of prices with no costs, which is the one thing this
  // action exists to fetch.
  const withStock = payload?.withStock !== false;

  // ── Phase 1: every cart page, concurrently. ────────────────────────────
  // Was a one-at-a-time walk; see scrape-nospos-agreements.js for the shape.
  let loginRequired = false;
  const carts = [];
  const failures = [];

  const pageResults = await nosposFetchPool(
    urls,
    async (url) => {
      const r = await nosposCredentialedHtmlFetch(url);
      return { url, r };
    },
    {
      shouldStop: () => loginRequired,
      onProgress: (done, total, entry) => {
        if (entry?.ok && entry.value?.r?.loginRequired) loginRequired = true;
        emitProgress({ done, total, failures: failures.length, stage: 'cart' });
      },
    },
  );

  if (loginRequired) return { ok: false, loginRequired: true, carts };

  pageResults.forEach((entry) => {
    if (!entry) return;
    if (!entry.ok) {
      failures.push({ url: '', error: entry.error || 'could not be read' });
      return;
    }
    const { url, r } = entry.value;
    if (!r.ok) {
      // One unreadable sale must not sink the batch — the dry run needs to be
      // able to say exactly which ones are missing.
      failures.push({ url, error: r.error || 'could not be read' });
      return;
    }
    const cart = parseNosposCartPage(r.html, r.finalUrl || url);
    // Raw body for server-side staging; additive and optional.
    cart.html = r.html;
    carts.push(cart);
  });

  // ── Phase 2: the stock behind every line, deduplicated across carts. ──────
  // One flat keyed list, so a unit that appears on two tickets is read once.
  if (withStock) {
    const wanted = new Map();
    carts.forEach((cart) => {
      (cart.items || []).forEach((item) => {
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
          onProgress: (done, total) => emitProgress({
            done, total, failures: failures.length, stage: 'stock',
          }),
        },
      );

      stockResults.forEach((entry) => {
        if (!entry || !entry.ok) return;
        const { stockId, stockUrl, r } = entry.value;
        const items = wanted.get(String(stockId)) || [];
        if (!r.ok) {
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
          change_log: base.changeLog || [],
          ...parseNosposStockPageExtras(r.html),
        };
        items.forEach((item) => { item.stock = { ...stock, html: r.html }; });
      });
    }
  }

  console.log('[CG Suite] carts scraped', { ok: carts.length, failed: failures.length });
  return { ok: true, carts, failures };
}
