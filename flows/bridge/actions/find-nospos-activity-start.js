/**
 * Find the first day for which NosPos's management Activity report contains
 * anything. NosPos refuses report windows longer than seven days, so the range
 * is divided into legal seven-day windows and binary-searched. Once the first
 * populated window is found, its seven individual days are checked in order.
 *
 * A trading branch's report is treated as a boundary: empty before the branch
 * began, populated afterwards. That turns roughly 366 weekly requests into at
 * most ten, followed by at most seven day requests.
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
  const totalWindows = nosposActivityWindowCount(firstAllowed, lastAllowed);
  const maximumBinarySteps = Math.ceil(Math.log2(totalWindows)) + 1;
  let windowsChecked = 0;
  let low = 0;
  let high = totalWindows - 1;
  const probes = new Map();

  const probeWindow = async (index) => {
    if (probes.has(index)) return probes.get(index);
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
    const found = { ...window, fromDay, toDay, count };
    probes.set(index, found);
    emitProgress({
      phase: 'binary',
      fromDay,
      toDay,
      count,
      windowsChecked,
      maximumBinarySteps,
      remainingWindows: high - low + 1,
    });
    return found;
  };

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeWindow(mid);
    if (probe.aborted) {
      return {
        ok: false,
        aborted: true,
        error: `Stopped — ${nosposAbort.reasonFor(appTabId) || 'the page that started it went away'}.`,
      };
    }
    if (probe.loginRequired) return { ok: false, loginRequired: true };
    if (probe.error) return { ok: false, error: probe.error };
    if (probe.count > 0) high = mid;
    else low = mid + 1;
  }

  const populatedWindow = await probeWindow(low);
  if (populatedWindow.aborted) return { ok: false, aborted: true, error: 'Stopped.' };
  if (populatedWindow.loginRequired) return { ok: false, loginRequired: true };
  if (populatedWindow.error) return { ok: false, error: populatedWindow.error };
  if (populatedWindow.count < 1) {
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
        searchMethod: 'binary',
        daysChecked,
        searchFrom: NOSPOS_ACTIVITY_SEARCH_FROM,
        searchTo: NOSPOS_ACTIVITY_SEARCH_TO,
      };
    }
    day = nosposActivityAddDays(day, 1);
  }

  return { ok: false, error: 'The first populated week could not be narrowed to a day.' };
}
