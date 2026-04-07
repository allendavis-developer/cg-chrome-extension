/**
 * Jewellery reference prices — injected ONLY by the service worker for Jewellery worker tabs
 * (chrome.scripting.executeScript). Not in manifest content_scripts.
 *
 * Message type / poll: keep in sync with jewellery-scrap/constants.js (CG_JEWELLERY_SCRAP).
 */
(function jewelleryScrapPricesIife() {
  if (window.__CG_SUITE_JEWELLERY_SCRAPER__) return;
  window.__CG_SUITE_JEWELLERY_SCRAPER__ = true;

  const MSG_SCRAPED = 'JEWELLERY_SCRAP_PRICES_SCRAPED';
  const POLL_MS = 500;
  const POLL_MAX = 40;

  const EXPECTED_SECTIONS = ['Gold', 'Gold Coins', 'Silver', 'Platinum', 'Palladium'];

  function tableSectionTitle(table) {
    const first = table.querySelector('thead tr td, thead tr th');
    return first ? first.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function titleToId(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
  }

  function scrapeTableRows(table) {
    const rows = [];
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 3) return;
      const label = cells[0].textContent.replace(/\s+/g, ' ').trim();
      const unit = cells[1].textContent.replace(/\s+/g, ' ').trim();
      const priceCell = cells[2];
      const metricEl = priceCell.querySelector('.metric');
      const raw = metricEl ? metricEl.textContent.trim() : priceCell.textContent.replace(/£/g, '').trim();
      const priceGbp = raw.replace(/,/g, '').trim();
      rows.push({ label, unit, priceGbp });
    });
    return rows;
  }

  function scrapeAllSections() {
    const map = new Map();
    document.querySelectorAll('table').forEach((table) => {
      const title = tableSectionTitle(table);
      if (!EXPECTED_SECTIONS.includes(title)) return;
      const rows = scrapeTableRows(table);
      if (!rows.length) return;
      map.set(title, { id: titleToId(title), title, rows });
    });
    return EXPECTED_SECTIONS.filter((t) => map.has(t)).map((t) => map.get(t));
  }

  let done = false;
  let pollAttempt = 0;

  function tick() {
    if (done) return;
    const path = (location.pathname || '').toLowerCase();
    if (!path.includes('scrap-prices')) return;

    const sections = scrapeAllSections();
    pollAttempt += 1;

    const complete = sections.length === EXPECTED_SECTIONS.length;
    const shouldSend =
      sections.length > 0 && (complete || pollAttempt >= POLL_MAX);

    if (!shouldSend) return;

    done = true;
    chrome.runtime
      .sendMessage({
        type: MSG_SCRAPED,
        payload: {
          sections,
          sourceUrl: location.href,
          scrapedAt: new Date().toISOString(),
        },
      })
      .catch(() => {});
  }

  tick();
  const pollId = window.setInterval(() => {
    tick();
    if (done || pollAttempt >= POLL_MAX) {
      window.clearInterval(pollId);
    }
  }, POLL_MS);
})();
