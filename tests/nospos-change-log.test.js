/**
 * Regression suite for the NosPos stock-edit Changes grid parser.
 *
 * Run from chrome-extension/:
 *   node tests/nospos-change-log.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.resolve(__dirname, '..', 'bg', 'nospos-html.js');
const src = fs.readFileSync(srcPath, 'utf8');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src, ctx);

const { parseNosposStockEditPageChangeLog } = ctx;
if (typeof parseNosposStockEditPageChangeLog !== 'function') {
  console.error('parseNosposStockEditPageChangeLog not exported from bg/nospos-html.js');
  process.exit(2);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pjaxCardContent = `
<div class="card-content">
  <div id="p1" data-pjax-container="" data-pjax-timeout="9000" data-pjax-scrollto="1">
    <div id="w7" class="grid-view table-responsive"><div class="summary"></div>
      <table class="table table-hover">
        <thead>
          <tr><th>ID</th><th>Name</th><th>Old Value</th><th>New Value</th><th>Changed</th><th>Changed By</th></tr>
        </thead>
        <tbody>
          <tr data-key="577923"><td>#577923</td><td>Storage</td><td><span class="not-set" style="opacity: 0.5;">(not set)</span></td><td><div class="line-clamp-3 text-break" data-original-title="1TB">1TB</div></td><td>21 Jul 2026, 09:41:08</td><td>Linds</td></tr>
          <tr data-key="577922"><td>#577922</td><td>Serial</td><td><span class="not-set" style="opacity: 0.5;">(not set)</span></td><td><div class="line-clamp-3 text-break" data-original-title="f54a00gwm1400549">f54a00gwm1400549</div></td><td>21 Jul 2026, 09:41:08</td><td>Linds</td></tr>
          <tr data-key="577921"><td>#577921</td><td>Colour</td><td><span class="not-set" style="opacity: 0.5;">(not set)</span></td><td><div class="line-clamp-3 text-break" data-original-title="White">White</div></td><td>21 Jul 2026, 09:41:08</td><td>Linds</td></tr>
          <tr data-key="574716"><td>#574716</td><td>Quantity 28</td><td>1</td><td>0</td><td>14 Jul 2026, 09:22:00</td><td>Jessg</td></tr>
          <tr data-key="574715"><td>#574715</td><td>Quantity</td><td>0</td><td>1</td><td>14 Jul 2026, 09:22:00</td><td>Jessg</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>`;

const rows = parseNosposStockEditPageChangeLog(pjaxCardContent);
assert(rows.length === 5, `expected 5 rows, got ${rows.length}`);
assert(rows[0].changeEntryId === '577923', `unexpected first id: ${rows[0].changeEntryId}`);
assert(rows[0].columnName === 'Storage', `unexpected field: ${rows[0].columnName}`);
assert(rows[0].oldValue === '(not set)', `expected explicit '(not set)', got ${rows[0].oldValue}`);
assert(rows[0].newValue === '1TB', `unexpected new value: ${rows[0].newValue}`);
assert(rows[2].oldValue === '(not set)', `Colour old value was lost: ${rows[2].oldValue}`);
assert(rows[4].newValue === '1', `Quantity new value was lost: ${rows[4].newValue}`);

console.log('PASS nospos-change-log: PJAX grid and (not set) values');
