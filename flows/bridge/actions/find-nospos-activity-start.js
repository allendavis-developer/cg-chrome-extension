/**
 * Find the first day for which NosPos's management Activity report contains
 * anything. NosPos refuses report windows longer than seven days, so the range
 * is divided into legal seven-day windows and checked in small parallel batches.
 * Once the first populated window is found, its seven individual days are
 * checked in order.
 *
 * This deliberately is NOT a binary search. A weekly report can be empty after
 * a branch started (closures, gaps, incomplete history), so "this week has
 * activity" is not a monotonic predicate and binary search can return a later
 * 0→1 transition. Parallel chronological batches keep the wall-clock time low
 * while still proving that no earlier permitted window contains activity.
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

function nosposActivityWindowCount(firstAllowed, lastAllowed) {
  const days = Math.floor((lastAllowed.getTime() - firstAllowed.getTime()) / 86400000) + 1;
  return Math.ceil(days / NOSPOS_ACTIVITY_WINDOW_DAYS);
}

function nosposActivityWindowAt(firstAllowed, lastAllowed, index) {
  const start = nosposActivityAddDays(firstAllowed, index * NOSPOS_ACTIVITY_WINDOW_DAYS);
  const end = new Date(Math.min(
    nosposActivityAddDays(start, NOSPOS_ACTIVITY_WINDOW_DAYS - 1).getTime(),
    lastAllowed.getTime(),
  ));
  return { start, end };
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
  // Never infer a count from other markup. The supplied page can contain
  // unrelated data-key attributes even while Activity says "No results found".
  // An unreadable Summary is an error, not evidence of one event.
  return null;
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
  const totalWindows = nosposActivityWindowCount(firstAllowed, lastAllowed);
  const parallelism = 6;
  let windowsChecked = 0;
  let populatedWindow = null;

  const probeWindow = async (index) => {
    if (nosposAbort.isAborted(appTabId)) {
      return { aborted: true };
    }
    const window = nosposActivityWindowAt(firstAllowed, lastAllowed, index);
    const fromDay = nosposActivityIsoDay(window.start);
    const toDay = nosposActivityIsoDay(window.end);
    const response = await nosposCredentialedHtmlFetch(nosposActivityReportUrl(fromDay, toDay));
    if (response.loginRequired) return { loginRequired: true };
    if (!response.ok) return { error: response.error || 'Could not read the NosPos activity report.' };
    windowsChecked += 1;
    const count = parseNosposActivityCount(response.html);
    if (count == null) {
      return { error: `NosPos returned ${fromDay} to ${toDay}, but its Summary count could not be read.` };
    }
    const found = { ...window, fromDay, toDay, count };
    emitProgress({
      phase: 'weeks',
      fromDay,
      toDay,
      count,
      windowsChecked,
      totalWindows,
    });
    return found;
  };

  for (let batchStart = 0; batchStart < totalWindows; batchStart += parallelism) {
    if (nosposAbort.isAborted(appTabId)) {
      return { ok: false, aborted: true, error: 'Stopped.' };
    }
    const indices = Array.from(
      { length: Math.min(parallelism, totalWindows - batchStart) },
      (_, offset) => batchStart + offset,
    );
    // Six small report requests at a time: fast enough for discovery without
    // sending hundreds at once or retaining any HTML after its count is read.
    // eslint-disable-next-line no-await-in-loop
    const batch = await Promise.all(indices.map((index) => probeWindow(index)));
    const aborted = batch.find((probe) => probe.aborted);
    if (aborted) {
      return {
        ok: false,
        aborted: true,
        error: `Stopped — ${nosposAbort.reasonFor(appTabId) || 'the page that started it went away'}.`,
      };
    }
    if (batch.some((probe) => probe.loginRequired)) return { ok: false, loginRequired: true };
    const failed = batch.find((probe) => probe.error);
    if (failed) return { ok: false, error: failed.error };
    populatedWindow = batch.find((probe) => probe.count > 0) || null;
    if (populatedWindow) break;
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
        searchMethod: 'parallel_weekly',
        daysChecked,
        searchFrom: NOSPOS_ACTIVITY_SEARCH_FROM,
        searchTo: NOSPOS_ACTIVITY_SEARCH_TO,
      };
    }
    day = nosposActivityAddDays(day, 1);
  }

  return { ok: false, error: 'The first populated week could not be narrowed to a day.' };
}
