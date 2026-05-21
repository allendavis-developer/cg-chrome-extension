/**
 * Registry of BRIDGE_FORWARD actions.
 *
 * The service worker loads one file per action (see flows/bridge/actions/*.js).
 * Each file defines a handleBridgeAction_<action> function at global scope;
 * this map associates each action string with its handler. The dispatcher in
 * flows/bridge/forward.js looks the handler up and calls it.
 *
 * To add a new bridge action:
 *   1. Add an action file under flows/bridge/actions/ — name it kebab-case
 *      after the action (e.g. "my-new-action.js") and export
 *      handleBridgeAction_myNewAction(ctx).
 *   2. Register it in the BRIDGE_ACTIONS map below.
 *   3. Add the new file to the importScripts list in background.js.
 */

const BRIDGE_ACTIONS = {
  startWaitingForData: handleBridgeAction_startWaitingForData,
  scrapeCexSuperCategories: handleBridgeAction_scrapeCexSuperCategories,
  cancelRequest: handleBridgeAction_cancelRequest,
  searchNosposBarcode: handleBridgeAction_searchNosposBarcode,
  scrapeNosposStockEditForUpload: handleBridgeAction_scrapeNosposStockEditForUpload,
  scrapeNosposListedStockPage: handleBridgeAction_scrapeNosposListedStockPage,
  navigateNosposStockEditInWorker: handleBridgeAction_navigateNosposStockEditInWorker,
  setNosposExternallyListedOff: handleBridgeAction_setNosposExternallyListedOff,
  setNosposExternallyListedOn: handleBridgeAction_setNosposExternallyListedOn,
  getParkAgreementLog: handleBridgeAction_getParkAgreementLog,
  getUploadLog: handleBridgeAction_getUploadLog,
  checkNosposCustomerBuyingSession: handleBridgeAction_checkNosposCustomerBuyingSession,
  clearNosposParkAgreementUi: handleBridgeAction_clearNosposParkAgreementUi,
  openNosposNewAgreementCreateBackground: handleBridgeAction_openNosposNewAgreementCreateBackground,
  fillNosposAgreementFirstItem: handleBridgeAction_fillNosposAgreementFirstItem,
  fillNosposAgreementItems: handleBridgeAction_fillNosposAgreementItems,
  fillNosposAgreementItemStep: handleBridgeAction_fillNosposAgreementItemStep,
  resolveNosposParkAgreementLine: handleBridgeAction_resolveNosposParkAgreementLine,
  deleteExcludedNosposAgreementLines: handleBridgeAction_deleteExcludedNosposAgreementLines,
  clickNosposSidebarParkAgreement: handleBridgeAction_clickNosposSidebarParkAgreement,
  focusOrOpenNosposParkTab: handleBridgeAction_focusOrOpenNosposParkTab,
  getNosposTabUrl: handleBridgeAction_getNosposTabUrl,
  closeNosposParkAgreementTab: handleBridgeAction_closeNosposParkAgreementTab,
  fillNosposParkAgreementCategory: handleBridgeAction_fillNosposParkAgreementCategory,
  fillNosposParkAgreementRest: handleBridgeAction_fillNosposParkAgreementRest,
  patchNosposAgreementField: handleBridgeAction_patchNosposAgreementField,
  fillNosposAgreementFirstItemCategory: handleBridgeAction_fillNosposAgreementFirstItemCategory,
  openNosposForCustomerIntake: handleBridgeAction_openNosposForCustomerIntake,
  openNosposForNewCustomer: handleBridgeAction_openNosposForNewCustomer,
  openNosposSiteOnly: handleBridgeAction_openNosposSiteOnly,
  openNosposSiteForFields: handleBridgeAction_openNosposSiteForFields,
  openNosposSiteForCategoryFields: handleBridgeAction_openNosposSiteForCategoryFields,
  openNosposSiteForCategoryFieldsBulk: handleBridgeAction_openNosposSiteForCategoryFieldsBulk,
  openUrl: handleBridgeAction_openUrl,
  [CG_JEWELLERY_SCRAP.BRIDGE_OPEN_ACTION]: handleBridgeAction_openJewelleryScrapPrices,
  openWebEposUpload: handleBridgeAction_openWebEposUpload,
  reopenWebEposUpload: handleBridgeAction_reopenWebEposUpload,
  closeWebEposUploadSession: handleBridgeAction_closeWebEposUploadSession,
  scrapeWebEposProducts: handleBridgeAction_scrapeWebEposProducts,
  openWebEposProductCreateForUpload: handleBridgeAction_openWebEposProductCreateForUpload,
  updateWebEposProductPrices: handleBridgeAction_updateWebEposProductPrices,
  setWebEposProductOnSaleOff: handleBridgeAction_setWebEposProductOnSaleOff,
  navigateWebEposProductInWorker: handleBridgeAction_navigateWebEposProductInWorker,
  scrapeWebEposCategorySelects: handleBridgeAction_scrapeWebEposCategorySelects,
  scrapeWebeposCategoryHierarchy: handleBridgeAction_scrapeWebeposCategoryHierarchy,
  closeTabs: handleBridgeAction_closeTabs,
  openNosposAndWait: handleBridgeAction_openNosposAndWait,
  getLastRepricingResult: handleBridgeAction_getLastRepricingResult,
  clearLastRepricingResult: handleBridgeAction_clearLastRepricingResult,
  getNosposRepricingStatus: handleBridgeAction_getNosposRepricingStatus,
  cancelNosposRepricing: handleBridgeAction_cancelNosposRepricing,
  startRefine: handleBridgeAction_startRefine,
};
