/**
 * Regression suite for the payment report's completeness check.
 *
 * Run from the chrome-extension/ directory:
 *   node tests/nospos-payment-report-count.test.js
 *
 * The bug this pins: the walk paginated a live, non-deterministically ordered
 * report and deduplicated what it saw twice — but nothing at all noticed what it
 * never saw. The 27 Jul - 27 Aug capture came back 1701 rows with payment ids
 * 263109, 263110 and 264075 simply missing from the middle of an otherwise
 * unbroken run, and the capture reported COMPLETED. Those three rows were £558
 * of sales and £60 of refunds, and they were the whole of that stage's
 * disagreement with NosPos's own trading report.
 *
 * Two halves, and both matter:
 *   - the walk asks for a STABLE order (`sort=id`), so a payment taken mid-walk
 *     lands after what we have read rather than inside it;
 *   - it reads the grid's own "of N items" count and holds itself to it, so a
 *     shortfall is a failure with a number on it rather than silence.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.resolve(__dirname, '..', 'flows', 'bridge', 'actions', 'scrape-nospos-payment-report.js');
const src = fs.readFileSync(srcPath, 'utf8');

// The file is loaded as a plain script by the service worker, so evaluating it
// in a bare context gives us its helpers without any of chrome.* being touched:
// nothing runs until the bridge action is dispatched.
const sandbox = { console, chrome: undefined, URLSearchParams };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let failures = 0;
function check(name, got, want) {
  if (got === want) {
    console.log('  ok  ', name);
    return;
  }
  failures += 1;
  console.log('  FAIL', name, '\n        got ', JSON.stringify(got), '\n        want', JSON.stringify(want));
}

const { nosposPaymentReportUrl, parseNosposGridTotal, parseNosposPaymentReportRows } = sandbox;

console.log('the report is asked for in a stable order');
const url = nosposPaymentReportUrl(3, '2026-07-27', '2026-08-27');
check('sorted by id, so pagination cannot reshuffle under the walk',
  new URL(url).searchParams.get('sort'), 'id');
check('and the date filter is still ours on every page',
  new URL(url).searchParams.get('PaymentSearch[fromDate]'), '2026-07-27');
check('and the page number is the one asked for',
  new URL(url).searchParams.get('page'), '3');

console.log("the grid's own count is read");
check('a paginated summary',
  parseNosposGridTotal('<div class="summary">Showing <b>1-100</b> of <b>1,704</b> items.</div>'), 1704);
check('a small one',
  parseNosposGridTotal('<div class="summary">Showing <b>1-7</b> of <b>7</b> items.</div>'), 7);
check('an unreadable summary is 0, never mistaken for an empty report',
  parseNosposGridTotal('<div class="summary"></div>'), 0);
check('and so is a page with no summary at all',
  parseNosposGridTotal('<table><tr data-key="1"><td>#1</td></tr></table>'), 0);

console.log('rows are still read the way they were');
const rowHtml = '<table><tr data-key="262995">'
  + '<td>#262995</td><td>PA #117319</td><td>Pay-In</td><td>PayPal</td><td>&pound;8.75</td>'
  + '<td><a href="/management/till/modify?id=4">SALES01</a></td>'
  + '<td>27 Jul 2026, 08:57:22</td><td>Jessg</td>'
  + '<td><a href="#">x</a><a href="/agreement/view?id=117319">View</a></td>'
  + '</tr></table>';
const rows = parseNosposPaymentReportRows(rowHtml);
check('one row', rows.length, 1);
check('its id', rows[0].id, '#262995');
check('its amount', rows[0].amount, '£8.75');
check('its till id, not just the name', rows[0].nospos_till_id, '4');
check('and the record it belongs to', rows[0].related_href, 'https://nospos.com/agreement/view?id=117319');

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
