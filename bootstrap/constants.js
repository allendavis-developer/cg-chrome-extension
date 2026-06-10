/**
 * Module-scoped constants and state maps shared across SDK + flow modules.
 * Loaded first so subsequent files can reference them.
 */

// Hard safety cap for a genuine navigation/reload. waitForAgreementItemsPageReload bails out
// early (after NOSPOS_NO_RELOAD_GRACE_MS) when NosPos updates in place and no reload is coming,
// and otherwise resolves the instant the reload completes — so this cap is only ever paid for a
// real reload that is pathologically slow. Kept generous so a slow reload doesn't error out.
const NOSPOS_RELOAD_WAIT_MS = 12000;
/** If a navigation hasn't STARTED within this window after an action, NosPos updated in place — stop waiting. */
const NOSPOS_NO_RELOAD_GRACE_MS = 500;
/** Fallback rows-per-page for NosPos' agreement items pager (?items-page=N). NosPos instances
 *  don't all use the same page size (observed: 11 on one tenant, not 20), so this is only the
 *  seed value — the real size is detected at runtime from the live pager and cached per tab in
 *  `nosposItemsPerPageByTabId`. Read it via {@link getNosposItemsPerPage}, never directly. */
const NOSPOS_ITEMS_PER_PAGE = 20;
/** Per-tab detected rows-per-page, learned the first time the agreement spills onto a 2nd page
 *  (a full, non-last page's row count IS the page size). Falls back to NOSPOS_ITEMS_PER_PAGE. */
const nosposItemsPerPageByTabId = new Map();
/** After the category reload settles, wait this long before filling the line's fields. */
const NOSPOS_POST_CATEGORY_FILL_DELAY_MS = 400;
/** Delay before Actions -> Delete Agreement / Park Agreement clicks to reduce rate-limit spikes. */
const NOSPOS_ACTION_POST_DELAY_MS = 600;
/** Rate-limit guard before clicking Add item (does not affect item-form filling). Moderate: enough
 *  spacing to keep NosPos from throttling on a long agreement, without the old 3s tax. */
const NOSPOS_ADD_ITEM_CLICK_DELAY_MS = 800;
/** How long to poll for the new row after Add before handing off to the recovery reload. Doesn't
 *  need to be huge anymore: if the row was created but the render stalled past this, the recovery
 *  reload finds it (success); if it wasn't created, the recovery confirms the drop and we cool
 *  down + retry. So this is just the "give the normal render a chance" window. */
const NOSPOS_ADD_ROW_WAIT_MS = 20000;
/** When the new row hasn't appeared by the end of the post-Add wait, re-fetch (GET) and recount
 *  this many times, with growing backoff, BEFORE concluding the Add was dropped. NosPos throttles
 *  hard around items ~10-12, and a successful Add's row can persist/render after our first reload —
 *  patient re-reads find it instead of falsely declaring it missing and re-Adding (a duplicate
 *  risk). Each re-read is a GET, never a POST, so the rechecks themselves can never duplicate. */
const NOSPOS_ADD_ROW_RECOVERY_RECHECKS = 4;
/** Rate-limit guard before sending category set (does not affect item-form filling). */
const NOSPOS_SET_CATEGORY_DELAY_MS = 150;
/** Global park-flow pacing delay applied before extension-to-tab steps. Small, just enough to
 *  keep from machine-gunning NosPos on a long agreement (which is what tips it into the slow
 *  throttled reloads that blow the Add cap). The POST actions keep their own larger guards. */
const NOSPOS_PARK_GLOBAL_STEP_DELAY_MS = 100;
/** If NosPos returns 429 page, wait this long then reload. */
const NOSPOS_429_RELOAD_DELAY_MS = 4000;
/** After a 429 reload completes, sleep at least this long before retrying the save. */
const NOSPOS_RATELIMIT_RETRY_BACKOFF_MIN_MS = 1500;
/** Random extra wait on top of the min, picked per retry. */
const NOSPOS_RATELIMIT_RETRY_BACKOFF_JITTER_MS = 2000;
/** Hard cap on save attempts per item before giving up — prevents endless retry loops. */
const NOSPOS_RATELIMIT_MAX_ATTEMPTS = 3;
/** Max Add attempts per row (the first try plus retries after a confirmed-dropped Add). */
const NOSPOS_ADD_MAX_ATTEMPTS = 4;
/** After an Add is confirmed dropped (row never created, throttled), wait this long for NosPos's
 *  POST throttle to reset before re-clicking Add. Re-adding is safe here: the reload proved no
 *  row was created, so there's no duplicate risk. Validation rejections (NosPos re-rendering the
 *  form with .has-error) are detected and handled separately and never reach this cooldown —
 *  that's what used to inflate it; with those filtered out a genuine throttle drop is rare and
 *  the patient GET re-checks already buy recovery time, so this stays modest. */
const NOSPOS_ADD_DROP_COOLDOWN_MS = 8000;
/** Once a drop happens, pace ALL subsequent Adds wider by this step (per drop) so we stop
 *  hammering NosPos into the throttle. Decays on a clean Add. */
const NOSPOS_ADD_COOLDOWN_STEP_MS = 2000;
/** Ceiling for the adaptive per-Add pacing. */
const NOSPOS_ADD_COOLDOWN_MAX_MS = 8000;
/** Adaptive extra pre-Add pacing, grown by confirmed drops and decayed by clean Adds. */
let nosposAddCooldownMs = 0;
const nospos429LastRecoveryAtByTabId = new Map();
/** Last time the 429 probe ran and found NO 429, per tab. Lets us skip the (expensive on a
 *  backgrounded tab) executeScript probe during rapid message bursts. */
const nospos429LastCleanProbeAtByTabId = new Map();
/** How long a clean 429 probe stays valid before we re-probe (ms). The probe is an executeScript
 *  into a backgrounded tab — expensive, and it runs before every tab message — so keep the cache
 *  wide. The places where a 429 genuinely matters (the post-Add wait, the recovery reload) FORCE
 *  the probe and bypass this cache, so widening it doesn't delay real 429 detection there. */
const NOSPOS_429_PROBE_CACHE_MS = 6000;

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
