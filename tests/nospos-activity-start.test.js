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
check('reads a comma count', sandbox.parseNosposActivityCount('<strong>Count</strong><span>1,128</span>'), 1128);
check('reads an empty count', sandbox.parseNosposActivityCount('<strong>Count</strong><span>0</span>'), 0);
check('falls back to a real row', sandbox.parseNosposActivityCount('<tr data-key="4"><td>x</td></tr>'), 1);

if (failures) process.exit(1);
console.log('\nall good');
