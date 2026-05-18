/**
 * Module-scoped constants and state maps shared across SDK + flow modules.
 * Loaded first so subsequent files can reference them.
 */

const NOSPOS_RELOAD_WAIT_MS = 20000;
/** Delay before Actions -> Delete Agreement / Park Agreement clicks to reduce rate-limit spikes. */
const NOSPOS_ACTION_POST_DELAY_MS = 1200;
/** Rate-limit guard before clicking Add item (does not affect item-form filling). */
const NOSPOS_ADD_ITEM_CLICK_DELAY_MS = 700;
/** Rate-limit guard before sending category set (does not affect item-form filling). */
const NOSPOS_SET_CATEGORY_DELAY_MS = 700;
/** Global park-flow pacing delay applied before extension-to-tab steps. */
const NOSPOS_PARK_GLOBAL_STEP_DELAY_MS = 450;
/** If NosPos returns 429 page, wait this long then reload. */
const NOSPOS_429_RELOAD_DELAY_MS = 4000;
/** After a 429 reload completes, sleep at least this long before retrying the save. */
const NOSPOS_RATELIMIT_RETRY_BACKOFF_MIN_MS = 1500;
/** Random extra wait on top of the min, picked per retry. */
const NOSPOS_RATELIMIT_RETRY_BACKOFF_JITTER_MS = 2000;
/** Hard cap on save attempts per item before giving up — prevents endless retry loops. */
const NOSPOS_RATELIMIT_MAX_ATTEMPTS = 3;
const nospos429LastRecoveryAtByTabId = new Map();

/**
 * TEST ONLY: when true, Park Agreement intentionally fails after 2 included items.
 * - stepIndex 0 => item 1 (passes)
 * - stepIndex 1 => item 2 (passes)
 * - stepIndex >= 2 => extension returns failure on purpose
 */
const CG_TEST_FAIL_PARK_AFTER_SECOND_ITEM = false;

// sendMessageToTabWithRetries — imported from bg/tab-utils.js
const NOSPOS_BUYING_AFTER_PARK_WAIT_MS = 60000;

/** Force-remove `tabs.onUpdated` listener for {@link waitForNosposTabBuyingAfterPark} when closing the tab from CG Suite. */
const nosposBuyingAfterParkDetachByTabId = new Map();
const nosposActiveParkTabIds = new Set();
const nosposParkClosedAbortByTabId = new Map();

const NOSPOS_PARK_TAB_CLOSED_ERR = 'NosPos tab was closed — parking failed.';
// `pendingNosposDuplicateChoices` is declared in flows/nospos-park/tab-state.js (where the helpers using it live).
const NOSPOS_OPEN_AGREEMENT_ITEMS_URL_WAIT_MS = 120000;
const WEB_EPOS_UPLOAD_HOST = 'webepos.cashgenerator.co.uk';
const WEB_EPOS_LOGIN_PATH = /^\/login(\/|$)/i;
/** Upload / gate / scrape: [products list](https://webepos.cashgenerator.co.uk/products) (logged-in table). */
const WEB_EPOS_PRODUCTS_URL = `https://${WEB_EPOS_UPLOAD_HOST}/products`;
const WEB_EPOS_PRODUCT_NEW_URL = `https://${WEB_EPOS_UPLOAD_HOST}/products/new`;
const WEB_EPOS_UPLOAD_SESSION_KEY = 'cgWebEposUploadSession';
const webEposUploadWatchAbortByTabId = new Map();
