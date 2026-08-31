/**
 * Find the first day for which NosPos's management Activity report contains
 * anything. NosPos refuses report windows longer than seven days, so the walk
 * checks consecutive seven-day windows from 2015 through 2021, then checks the
 * seven individual days in the first populated window.
 *
 * A binary search over weeks would be wrong here: "this week has activity" is
 * not monotonic because a real branch can have a quiet week. The bounded weekly
 * scan is still only 366 small, one-row report requests in the worst case and
 * cannot skip an older isolated record.
 */

const NOSPOS_ACTIVITY_REPORT_URL = 'https://nospos.com/reports/management/activity/index';
const NOSPOS_ACTIVITY_SEARCH_FROM = '2015-01-01';
const NOSPOS_ACTIVITY_SEARCH_TO = '2021-12-31';
const NOSPOS_ACTIVITY_WINDOW_DAYS = 7;

const NOSPOS_ACTIVITY_INCLUDE_FIELDS = [
  'stock',
  'book_out_stock',
  'faulty',
  'written_off',
  'out_for_repair',
  'moved_to_free',
  'currency_reconciliation',
  'currency_replenishment',
  'agreements',
  'listings',
  'carts',
  'payments',
  'stock_returns',
  'customers',
  'customer_changes',
  'customer_notes',
  'setting_changes',
];

function nosposActivityIsoDay(date) {
  return date.toISOString().slice(0, 10);
}

function nosposActivityAddDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function nosposActivityReportUrl(fromDay, toDay) {
  const params = new URLSearchParams();
  params.set('ActivityReport[from_time]', `${fromDay}T00:00:00`);
  params.set('ActivityReport[to_time]', `${toDay}T23:59:59`);
  params.set('ActivityReport[created_by]', '');
  NOSPOS_ACTIVITY_INCLUDE_FIELDS.forEach((field) => {
    params.set(`ActivityReport[include_${field}]`, '1');
  });
  // We need the summary count, not the rows. Asking for one keeps every probe
  // small even when the tested week contains thousands of events.
  params.set('page', '1');
  params.set('per-page', '15');
  return `${NOSPOS_ACTIVITY_REPORT_URL}?${params.toString()}`;
}

/** "<strong>Count</strong><span>1,128</span>" -> 1128. */
function parseNosposActivityCount(html) {
  const source = String(html || '');
  const match = source.match(/<strong>\s*Count\s*<\/strong>\s*<span[^>]*>\s*([\d,]+)\s*<\/span>/i);
  if (match) {
    const count = Number.parseInt(match[1].replace(/,/g, ''), 10);
    if (Number.isFinite(count)) return count;
  }
  // Defensive fallback for a changed Summary card: any real activity row has
  // a data-key, so this preserves the only distinction the search needs.
  return /<tr\b[^>]*\bdata-key="[^"]+"/i.test(source) ? 1 : 0;
}

async function handleBridgeAction_findNosposActivityStart({ requestId, appTabId, pageInstanceId }) {
  const emitProgress = (payload) => {
    if (!appTabId) return;
    chrome.tabs.sendMessage(appTabId, {
      type: 'EXTENSION_PROGRESS_TO_PAGE',
      requestId,
      payload,
    }).catch(() => {});
  };

  nosposAbort.begin(appTabId, pageInstanceId);
  const firstAllowed = new Date(`${NOSPOS_ACTIVITY_SEARCH_FROM}T00:00:00Z`);
  const lastAllowed = new Date(`${NOSPOS_ACTIVITY_SEARCH_TO}T00:00:00Z`);
  let cursor = firstAllowed;
  let windowsChecked = 0;
  let populatedWindow = null;

  while (cursor <= lastAllowed) {
    if (nosposAbort.isAborted(appTabId)) {
      return {
        ok: false,
        aborted: true,
        error: `Stopped — ${nosposAbort.reasonFor(appTabId) || 'the page that started it went away'}.`,
      };
    }

    const windowEnd = new Date(Math.min(
      nosposActivityAddDays(cursor, NOSPOS_ACTIVITY_WINDOW_DAYS - 1).getTime(),
      lastAllowed.getTime(),
    ));
    const fromDay = nosposActivityIsoDay(cursor);
    const toDay = nosposActivityIsoDay(windowEnd);
    // eslint-disable-next-line no-await-in-loop
    const response = await nosposCredentialedHtmlFetch(nosposActivityReportUrl(fromDay, toDay));
    if (response.loginRequired) return { ok: false, loginRequired: true };
    if (!response.ok) return { ok: false, error: response.error || 'Could not read the NosPos activity report.' };

    windowsChecked += 1;
    const count = parseNosposActivityCount(response.html);
    emitProgress({ phase: 'weeks', fromDay, toDay, count, windowsChecked });
    if (count > 0) {
      populatedWindow = { start: cursor, end: windowEnd, count };
      break;
    }

    cursor = nosposActivityAddDays(cursor, NOSPOS_ACTIVITY_WINDOW_DAYS);
    // Avoid turning a bounded discovery pass into a burst against NosPos.
    // eslint-disable-next-line no-await-in-loop
    await nosposHtmlFetchSleep(120);
  }

  if (!populatedWindow) {
    return {
      ok: false,
      notFound: true,
      error: `No activity was found between ${NOSPOS_ACTIVITY_SEARCH_FROM} and ${NOSPOS_ACTIVITY_SEARCH_TO}.`,
      windowsChecked,
    };
  }

  let day = populatedWindow.start;
  let daysChecked = 0;
  while (day <= populatedWindow.end) {
    if (nosposAbort.isAborted(appTabId)) {
      return { ok: false, aborted: true, error: 'Stopped before the first activity day was confirmed.' };
    }
    const date = nosposActivityIsoDay(day);
    // eslint-disable-next-line no-await-in-loop
    const response = await nosposCredentialedHtmlFetch(nosposActivityReportUrl(date, date));
    if (response.loginRequired) return { ok: false, loginRequired: true };
    if (!response.ok) return { ok: false, error: response.error || 'Could not confirm the first activity day.' };
    daysChecked += 1;
    const count = parseNosposActivityCount(response.html);
    emitProgress({ phase: 'days', fromDay: date, toDay: date, count, windowsChecked, daysChecked });
    if (count > 0) {
      return {
        ok: true,
        startDate: date,
        activityCount: count,
        firstPopulatedWindow: {
          from: nosposActivityIsoDay(populatedWindow.start),
          to: nosposActivityIsoDay(populatedWindow.end),
          count: populatedWindow.count,
        },
        windowsChecked,
        daysChecked,
        searchFrom: NOSPOS_ACTIVITY_SEARCH_FROM,
        searchTo: NOSPOS_ACTIVITY_SEARCH_TO,
      };
    }
    day = nosposActivityAddDays(day, 1);
  }

  return { ok: false, error: 'The first populated week could not be narrowed to a day.' };
}
