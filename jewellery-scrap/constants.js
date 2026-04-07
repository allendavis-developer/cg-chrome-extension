/**
 * Jewellery reference scraper — extension service worker config.
 * SCRAPER_SCRIPT_FILE is injected only via scripting.executeScript on extension-opened worker tabs.
 * Keep POLL_MS / POLL_MAX in sync with content-jewellery-scrap-prices.js.
 */
const JEWELLERY_SCRAP_HOST = String.fromCharCode(
  109, 97, 115, 116, 101, 114, 109, 101, 108, 116, 103, 114, 111, 117, 112, 46, 99, 111, 109
);

globalThis.CG_JEWELLERY_SCRAP = {
  STORAGE_KEY: 'cgJewelleryScrapWorkerByTab',
  SCRAP_PRICES_URL: `https://www.${JEWELLERY_SCRAP_HOST}/scrap-prices/`,
  SCRAPER_SCRIPT_FILE: 'content-jewellery-scrap-prices.js',
  INJECT_URL_HOST: JEWELLERY_SCRAP_HOST,
  SCRAPER_INJECT_LISTENER_TIMEOUT_MS: 60_000,
  BRIDGE_OPEN_ACTION: 'openJewelleryScrapPrices',
  MSG_SCRAPED: 'JEWELLERY_SCRAP_PRICES_SCRAPED',
  MSG_TO_PAGE: 'JEWELLERY_SCRAP_PRICES_TO_CONTENT',
  POLL_MS: 500,
  POLL_MAX: 40,
};
