const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'flows', 'bridge', 'actions', 'find-nospos-activity-start.js'),
  'utf8',
);
const sandbox = { console, URLSearchParams, Date };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) return console.log('  ok  ', name);
  failures += 1;
  console.log('  FAIL', name, JSON.stringify(actual), '!=', JSON.stringify(expected));
}

const url = new URL(sandbox.nosposActivityReportUrl('2019-02-01', '2019-02-07'));
check('uses the Activity report', url.pathname, '/reports/management/activity/index');
check('sets the start time', url.searchParams.get('ActivityReport[from_time]'), '2019-02-01T00:00:00');
check('sets the end time', url.searchParams.get('ActivityReport[to_time]'), '2019-02-07T23:59:59');
check('includes payments', url.searchParams.get('ActivityReport[include_payments]'), '1');
check('uses the report\'s supported small page size', url.searchParams.get('per-page'), '15');
const suppliedSummary = sandbox.parseNosposActivitySummary(
  '<div id="w0" class="detail-view"><div class="detail"><strong>From</strong><span>27 Mar 2015, 16:29:14</span></div>'
  + '<div class="detail"><strong>To</strong><span>30 Mar 2015, 17:29:14</span></div>'
  + '<div class="detail"><strong>Count</strong><span>1,128</span></div></div></div>'
  + '<table><tbody><tr data-key="unrelated"><td>No results found.</td></tr></tbody></table>',
);
check('reads the Summary from day', suppliedSummary.fromDay, '2015-03-27');
check('reads the Summary to day', suppliedSummary.toDay, '2015-03-30');
check('reads the Summary comma count', suppliedSummary.count, 1128);
check('does not invent a count from unrelated rows', sandbox.parseNosposActivitySummary('<tr data-key="4"><td>x</td></tr>').count, null);

const first = new Date('2015-01-01T00:00:00Z');
const last = new Date('2021-12-31T00:00:00Z');
check('the search range becomes 366 legal windows', sandbox.nosposActivityWindowCount(first, last), 366);
check('window zero begins at the lower bound', sandbox.nosposActivityIsoDay(sandbox.nosposActivityWindowAt(first, last, 0).start), '2015-01-01');
check('window one advances exactly seven days', sandbox.nosposActivityIsoDay(sandbox.nosposActivityWindowAt(first, last, 1).start), '2015-01-08');
check('the final window is capped at the upper bound', sandbox.nosposActivityIsoDay(sandbox.nosposActivityWindowAt(first, last, 365).end), '2021-12-31');

async function checkBinaryWalk() {
  const actualStart = '2019-05-06';
  let requests = 0;
  const reportDate = (iso) => {
    const [year, month, day] = iso.split('-');
    // NosPos sometimes renders September as "Sept". Discovery deliberately
    // uses only Summary Count, so display-date spelling cannot stop the search.
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
    return `${Number(day)} ${months[Number(month) - 1]} ${year}, 00:00:00`;
  };
  sandbox.chrome = { tabs: { sendMessage: () => Promise.resolve() } };
  sandbox.nosposAbort = {
    begin: () => {},
    isAborted: () => false,
    reasonFor: () => '',
  };
  sandbox.nosposCredentialedHtmlFetch = async (value) => {
    requests += 1;
    const request = new URL(value);
    const from = request.searchParams.get('ActivityReport[from_time]').slice(0, 10);
    const to = request.searchParams.get('ActivityReport[to_time]').slice(0, 10);
    const populated = to >= actualStart && (from === to ? from >= actualStart : true);
    return {
      ok: true,
      html: '<div id="w0"><div><strong>From</strong><span>' + reportDate(from) + '</span></div>'
        + '<div><strong>To</strong><span>' + reportDate(to) + '</span></div>'
        + `<div><strong>Count</strong><span>${populated ? 4 : 0}</span></div></div></div>`,
      finalUrl: value,
    };
  };

  const result = await sandbox.handleBridgeAction_findNosposActivityStart({
    requestId: 'test', appTabId: 1, pageInstanceId: 'page',
  });
  check('binary walk finds the exact day', result.startDate, actualStart);
  check('binary search uses at most ten weekly probes', result.windowsChecked <= 10, true);
  check('exact-day narrowing is at most seven requests', result.daysChecked <= 7, true);
  check('the whole discovery stays small', requests <= 17, true);
}

checkBinaryWalk().then(() => {
  if (failures) process.exit(1);
  console.log('\nall good');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
