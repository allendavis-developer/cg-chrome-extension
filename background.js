/**
 * CG Suite Research — background service worker (Manifest V3) — bootstrap.
 *
 * This file used to be a 6,165-line monolith. It is now a thin loader.
 * Primitives live in sdk/, composed workflows in flows/, one file per
 * BRIDGE_FORWARD action in flows/bridge/actions/, and chrome.runtime.onMessage
 * handlers in handlers/.
 *
 * MV3 service workers are killed after ~30 s of inactivity. All pending-request
 * state is persisted in chrome.storage.session so it survives restarts.
 *
 * Storage schema (key "cgPending"):
 *   { [requestId]: { appTabId, listingTabId, competitor, marketComparisonContext } }
 *
 * Load order matters — importScripts is synchronous and loads into a shared
 * global scope. Files are listed in dependency order (constants → sdk → flows
 * → actions → handlers → listeners). Lazy imports (tasks/) happen at runtime.
 */

importScripts(
  // 1. Shared constants + state maps.
  'bootstrap/constants.js',

  // 2. SDK primitives (no flow deps).
  'bg/park-log.js',
  'bg/upload-log.js',
  'bg/tab-utils.js',
  'bg/nospos-url-utils.js',
  'bg/nospos-html.js',
  'sdk/park-ui.js',
  'sdk/nospos-tab-open.js',
  'sdk/nospos-recovery.js',
  'jewellery-scrap/constants.js',
  'jewellery-scrap/worker-session.js',

  // 3. Flows — composed workflows built on SDK primitives.
  'flows/nospos-park/agreement-scrape.js',
  'flows/nospos-park/tab-state.js',
  'flows/nospos-park/agreement-fill.js',
  'flows/nospos-repricing/storage.js',
  'flows/webepos/upload-session.js',
  'flows/webepos/scrape.js',
  'flows/webepos/product-forms.js',
  'flows/webepos/watch-upload.js',
  'flows/webepos/category-tree-scrape.js',
  'flows/bridge/core.js',
  'flows/nospos-repricing/orchestration.js',
  'flows/nospos-repricing/page-handlers.js',

  // 4. Bridge actions — one file per BRIDGE_FORWARD action the app can send.
  //    Each file defines handleBridgeAction_<name> at global scope.
  'flows/bridge/actions/cancel-nospos-repricing.js',
  'flows/bridge/actions/cancel-request.js',
  'flows/bridge/actions/check-nospos-customer-buying-session.js',
  'flows/bridge/actions/clear-last-repricing-result.js',
  'flows/bridge/actions/clear-nospos-park-agreement-ui.js',
  'flows/bridge/actions/click-nospos-sidebar-park-agreement.js',
  'flows/bridge/actions/close-nospos-park-agreement-tab.js',
  'flows/bridge/actions/close-tabs.js',
  'flows/bridge/actions/close-web-epos-upload-session.js',
  'flows/bridge/actions/delete-excluded-nospos-agreement-lines.js',
  'flows/bridge/actions/fill-nospos-agreement-first-item-category.js',
  'flows/bridge/actions/fill-nospos-agreement-first-item.js',
  'flows/bridge/actions/fill-nospos-agreement-item-step.js',
  'flows/bridge/actions/fill-nospos-agreement-items.js',
  'flows/bridge/actions/fill-nospos-park-agreement-category.js',
  'flows/bridge/actions/fill-nospos-park-agreement-rest.js',
  'flows/bridge/actions/focus-or-open-nospos-park-tab.js',
  'flows/bridge/actions/get-last-repricing-result.js',
  'flows/bridge/actions/get-nospos-repricing-status.js',
  'flows/bridge/actions/get-nospos-tab-url.js',
  'flows/bridge/actions/get-park-agreement-log.js',
  'flows/bridge/actions/get-upload-log.js',
  'flows/bridge/actions/navigate-web-epos-product-in-worker.js',
  'flows/bridge/actions/open-jewellery-scrap-prices.js',
  'flows/bridge/actions/open-nospos-and-wait.js',
  'flows/bridge/actions/open-nospos-for-customer-intake.js',
  'flows/bridge/actions/open-nospos-new-agreement-create-background.js',
  'flows/bridge/actions/open-nospos-site-for-category-fields-bulk.js',
  'flows/bridge/actions/open-nospos-site-for-category-fields.js',
  'flows/bridge/actions/open-nospos-site-for-fields.js',
  'flows/bridge/actions/open-nospos-site-only.js',
  'flows/bridge/actions/open-url.js',
  'flows/bridge/actions/open-web-epos-product-create-for-upload.js',
  'flows/bridge/actions/update-web-epos-product-prices.js',
  'flows/bridge/actions/open-web-epos-upload.js',
  'flows/bridge/actions/patch-nospos-agreement-field.js',
  'flows/bridge/actions/reopen-web-epos-upload.js',
  'flows/bridge/actions/resolve-nospos-park-agreement-line.js',
  'flows/bridge/actions/scrape-cex-super-categories.js',
  'flows/bridge/actions/scrape-nospos-stock-edit-for-upload.js',
  'flows/bridge/actions/scrape-nospos-listed-stock-page.js',
  'flows/bridge/actions/navigate-nospos-stock-edit-in-worker.js',
  'flows/bridge/actions/set-nospos-externally-listed-off.js',
  'flows/bridge/actions/set-nospos-externally-listed-on.js',
  'flows/bridge/actions/scrape-web-epos-category-selects.js',
  'flows/bridge/actions/scrape-web-epos-products.js',
  'flows/bridge/actions/scrape-webepos-category-hierarchy.js',
  'flows/bridge/actions/set-web-epos-on-sale-off.js',
  'flows/bridge/actions/search-nospos-barcode.js',
  'flows/bridge/actions/start-refine.js',
  'flows/bridge/actions/start-waiting-for-data.js',

  // 5. Bridge registry + dispatcher (loaded after every action handler it names).
  'flows/bridge/actions/registry.js',
  'flows/bridge/forward.js',

  // 6. chrome.runtime.onMessage handlers (use flows + bridge).
  'handlers/listing.js',
  'handlers/router.js',

  // 7. Top-level chrome.tabs event listeners (registered last).
  'bootstrap/listeners.js',
);
