/**
 * Shared message type constants for CG Suite Chrome extension.
 * Used by background.js, content scripts, and bridge.
 */

var CG_MSG = {
  // Page -> bridge -> background
  EXTENSION_MESSAGE: 'EXTENSION_MESSAGE',
  BRIDGE_FORWARD: 'BRIDGE_FORWARD',
  CG_APP_PAGE_UNLOADING: 'CG_APP_PAGE_UNLOADING',

  // Background -> content -> page
  EXTENSION_RESPONSE_TO_PAGE: 'EXTENSION_RESPONSE_TO_PAGE',
  EXTENSION_PROGRESS_TO_PAGE: 'EXTENSION_PROGRESS_TO_PAGE',
  REPRICING_PROGRESS_TO_PAGE: 'REPRICING_PROGRESS_TO_PAGE',
  REPRICING_COMPLETE_TO_PAGE: 'REPRICING_COMPLETE_TO_PAGE',

  // Page-facing (after bridge translation)
  EXTENSION_RESPONSE: 'EXTENSION_RESPONSE',
  EXTENSION_PROGRESS: 'EXTENSION_PROGRESS',
  REPRICING_PROGRESS: 'REPRICING_PROGRESS',
  REPRICING_COMPLETE: 'REPRICING_COMPLETE',

  // Content -> background
  LISTING_PAGE_READY: 'LISTING_PAGE_READY',
  SCRAPED_DATA: 'SCRAPED_DATA',
  NOSPOS_PAGE_READY: 'NOSPOS_PAGE_READY',
  NOSPOS_STOCK_SEARCH_READY: 'NOSPOS_STOCK_SEARCH_READY',
  NOSPOS_STOCK_EDIT_READY: 'NOSPOS_STOCK_EDIT_READY',
  NOSPOS_PAGE_LOADED: 'NOSPOS_PAGE_LOADED',
  NOSPOS_LOGIN_REQUIRED: 'NOSPOS_LOGIN_REQUIRED',
  NOSPOS_CUSTOMER_SEARCH_READY: 'NOSPOS_CUSTOMER_SEARCH_READY',
  NOSPOS_CUSTOMER_DETAIL_READY: 'NOSPOS_CUSTOMER_DETAIL_READY',
  NOSPOS_CUSTOMER_DONE: 'NOSPOS_CUSTOMER_DONE',
  FETCH_ADDRESS_SUGGESTIONS: 'FETCH_ADDRESS_SUGGESTIONS',
  PARK_LOG_ENTRY: 'PARK_LOG_ENTRY',

  // Background -> content tab
  WAITING_FOR_DATA: 'WAITING_FOR_DATA',
  CEX_SCRAPE_SUPER_CATEGORIES: 'CEX_SCRAPE_SUPER_CATEGORIES',
  SCRAPE_NOSPOS_STOCK_CATEGORY: 'SCRAPE_NOSPOS_STOCK_CATEGORY',
  SCRAPE_NOSPOS_STOCK_CATEGORY_MODIFY: 'SCRAPE_NOSPOS_STOCK_CATEGORY_MODIFY',
  NOSPOS_VERIFY_RETAIL_PRICE: 'NOSPOS_VERIFY_RETAIL_PRICE',
  NOSPOS_AGREEMENT_FILL_PHASE: 'NOSPOS_AGREEMENT_FILL_PHASE',
  NOSPOS_AGREEMENT_PATCH_FIELD: 'NOSPOS_AGREEMENT_PATCH_FIELD',

  // Jewellery
  JEWELLERY_SCRAP_PRICES_SCRAPED: 'JEWELLERY_SCRAP_PRICES_SCRAPED',
  JEWELLERY_SCRAP_PRICES_TO_CONTENT: 'JEWELLERY_SCRAP_PRICES_TO_CONTENT',
  JEWELLERY_SCRAP_PRICES: 'JEWELLERY_SCRAP_PRICES',

  // Handshake the content-bridge announces to the page so Cash EPOS can
  // detect the extension's protocol version (see CG_EXT_PROTOCOL_VERSION).
  CG_EXT_HELLO: 'CG_EXT_HELLO',
};

/**
 * Integer protocol version for the Cash EPOS ↔ extension contract.
 *
 * BUMP this whenever you change a message shape, add/remove a required bridge
 * action, or otherwise make the extension incompatible with an older Cash
 * EPOS deployment (or vice-versa). The Django side carries the matching
 * MIN_EXTENSION_PROTOCOL_VERSION constant in pricing/version.py — when the
 * two diverge, Cash EPOS will lock the operational modules and show the
 * "extension out of sync" banner until the operator reinstalls.
 *
 * The marketing version in manifest.json moves independently (semver-ish for
 * users); this integer is the only thing the runtime compares against.
 */
var CG_EXT_PROTOCOL_VERSION = 4;
