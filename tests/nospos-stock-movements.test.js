const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'flows', 'bridge', 'actions', 'scrape-nospos-stock-movements.js'), 'utf8');
const sandbox = {
  decodeNosposHtmlText(value) {
    return String(value || '').replace(/&amp;/g, '&').replace(/&pound;/g, '£').replace(/\s+/g, ' ').trim();
  },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const html = `
<h4 class="card-title">Movements</h4>
<div class="detail"><strong>Barserial</strong><span>BBWY8I7GMMHPY</span></div>
<div class="detail"><strong>Name</strong><span>iphone 16e 128gb</span></div>
<div class="detail"><strong>Quantity 28</strong><span>1</span></div>
<table><tbody>
<tr data-key="11"><td>Agreement Item Reversed Move to Free, By: Jen, Agreement: <a href="/agreement/view?id=110235">#110235</a></td><td>16 Oct 2025, 16:26:28</td></tr>
<tr data-key="12"><td>Agreement Item Moved to Free, By: Jessg, Agreement: <a href="/agreement/view?id=110235">#110235</a></td><td>16 Oct 2025, 11:55:08</td></tr>
<tr data-key="13"><td>Agreement Item Renewed, Price: £87.50, Agreement: <a href="/agreement/view?id=109614">#109614</a></td><td>16 Sept 2025, 11:28:06</td></tr>
</tbody></table>`;

const parsed = sandbox.parseNosposStockMovementsPage(html, 'wrong');
if (parsed.barserial !== 'BBWY8I7GMMHPY') throw new Error('barserial was not parsed');
if (parsed.stock.quantity_28 !== '1') throw new Error('28-day quantity was not parsed');
if (parsed.movements.length !== 3) throw new Error('movement rows were not parsed');
if (parsed.movements[0].event_type !== 'REVERSED_MOVE_TO_FREE') throw new Error('reverse classification lost');
if (parsed.movements[0].operator !== 'Jen') throw new Error('operator was not parsed');
if (parsed.movements[1].event_type !== 'MOVED_TO_FREE') throw new Error('move classification lost');
if (parsed.movements[2].price !== '87.50') throw new Error('price was not parsed');
if (parsed.movements[2].agreement_id !== '109614') throw new Error('agreement link was not parsed');
if (!parsed.valid) throw new Error('a complete movements page was rejected');

const incomplete = sandbox.parseNosposStockMovementsPage('<div>temporary NosPos error</div>', 'BBWY8I7GMMHPY');
if (incomplete.valid) throw new Error('an error page was accepted as an empty movement history');

console.log('PASS nospos-stock-movements');
