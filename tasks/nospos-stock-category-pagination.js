/**
 * NosPos stock category index pagination — sequential visits after login.
 * Invoked from background.js when openNosposSiteOnly reaches NOSPOS_PAGE_READY.
 *
 * URLs: /stock/category/index?page={n}&per-page=100
 */

const NOSPOS_STOCK_CATEGORY_PAGINATION = {
  startPage: 1,
  endPage: 12,
  perPage: 100,
};

function buildNosposStockCategoryIndexUrl(page) {
  const start = NOSPOS_STOCK_CATEGORY_PAGINATION.startPage;
  const end = NOSPOS_STOCK_CATEGORY_PAGINATION.endPage;
  const n = Math.max(start, Math.min(end, Math.floor(Number(page) || start)));
  const per = NOSPOS_STOCK_CATEGORY_PAGINATION.perPage;
  return `https://nospos.com/stock/category/index?page=${n}&per-page=${per}`;
}

/**
 * Load each category index page in order in the given tab (waits for status=complete between steps).
 * @param {number} tabId
 * @param {{ loadTimeoutMs?: number, onPage?: (page: number, url: string) => void, afterPageLoad?: (page: number, url: string) => Promise<void> }} [options]
 */
async function runNosposStockCategoryPageLoop(tabId, options) {
  const loadTimeoutMs = options?.loadTimeoutMs ?? 90000;
  const { startPage, endPage } = NOSPOS_STOCK_CATEGORY_PAGINATION;
  for (let page = startPage; page <= endPage; page += 1) {
    const url = buildNosposStockCategoryIndexUrl(page);
    if (options?.onPage) {
      try {
        options.onPage(page, url);
      } catch (e) {
        console.warn('[CG Suite] nospos-stock-category-pagination onPage:', e?.message);
      }
    }
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoadComplete(
      tabId,
      loadTimeoutMs,
      `NoSpos category index page ${page} did not finish loading in time.`
    );
    if (options?.afterPageLoad) {
      await options.afterPageLoad(page, url);
    }
  }
}

/** Default category id for Data → NosPos fields (stock/category/modify). */
const NOSPOS_STOCK_CATEGORY_MODIFY_DEFAULT_ID = 1;

function buildNosposStockCategoryModifyUrl(categoryId) {
  const id = Math.max(
    1,
    Math.floor(Number(categoryId ?? NOSPOS_STOCK_CATEGORY_MODIFY_DEFAULT_ID))
  );
  return `https://nospos.com/stock/category/modify?id=${id}`;
}
