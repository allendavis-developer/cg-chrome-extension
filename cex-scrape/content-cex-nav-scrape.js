/**
 * CeX nav scrape — content script entry (uk.webuy.com / www.webuy.com).
 * Receives messages from the background worker and returns parsed category trees.
 * Parsing logic lives in cex-nav-parser.js.
 */
(function initCexNavContentScrape() {
  'use strict';

  function runParse() {
    var parser = typeof globalThis !== 'undefined' && globalThis.__cgCexNavParser;
    if (!parser || typeof parser.parseSuperCategories !== 'function') {
      return {
        ok: false,
        code: 'PARSER_MISSING',
        categories: [],
        scrapedAt: new Date().toISOString(),
        sourceUrl: typeof location !== 'undefined' ? location.href : '',
      };
    }

    var parsed = parser.parseSuperCategories(document);
    return {
      ok: !!parsed.ok,
      code: parsed.code,
      categories: parsed.categories || [],
      warnings: parsed.warnings,
      scrapedAt: new Date().toISOString(),
      sourceUrl: typeof location !== 'undefined' ? location.href : '',
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== 'CEX_SCRAPE_SUPER_CATEGORIES') return false;
    sendResponse(runParse());
    return false;
  });
})();
