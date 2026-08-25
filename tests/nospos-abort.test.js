/**
 * Regression suite for nosposAbort.
 *
 * Run from the chrome-extension/ directory:
 *   node tests/nospos-abort.test.js
 *
 * The bug this pins: aborts were a sticky flag keyed only on tab id, and the
 * flag outlived the page that set it. Reloading Cash EPOS fires `pagehide`,
 * which wakes the service worker and queues an abort for that tab — while the
 * replacement page loads into the SAME tab id. When that message was processed
 * late it landed on the new page's walk and stopped it on arrival, so pressing
 * "Trial: first 20" finished instantly, staged nothing, and reported that the
 * page which started it had gone away.
 *
 * The contract is therefore two-sided and both halves matter:
 *   - a stop from one page instance must NEVER reach a walk started by its
 *     successor, or captures die for no reason the operator can see;
 *   - a tab that is genuinely gone must still stop everything in it, because
 *     the whole point of this module is not leaving a walk hammering someone
 *     else's production server with nobody watching.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.resolve(__dirname, '..', 'bg', 'nospos-abort.js');
const src = fs.readFileSync(srcPath, 'utf8');

// No `chrome` in the sandbox, so the tabs.onRemoved registration is skipped and
// the module under test is just its logic.
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { nosposAbort } = sandbox;

let failures = 0;
function check(name, got, want) {
  if (got === want) {
    console.log('  ok  ', name);
    return;
  }
  console.log('  FAIL', name, '— got', JSON.stringify(got), 'want', JSON.stringify(want));
  failures += 1;
}

const TAB = 7;

console.log('a stale unload cannot stop its successor');
nosposAbort.begin(TAB, 'page-A');
nosposAbort.abortInstance(TAB, 'page-A', 'the page that started it went away');
nosposAbort.begin(TAB, 'page-B');
check('a fresh walk starts un-aborted', nosposAbort.isAborted(TAB), false);
nosposAbort.abortInstance(TAB, 'page-A', 'the page that started it went away');
check('page A cannot stop page B', nosposAbort.isAborted(TAB), false);

console.log('the page that owns a walk can still stop it');
nosposAbort.abortInstance(TAB, 'page-B', 'the page that started it went away');
check('page B stops its own walk', nosposAbort.isAborted(TAB), true);
check('and the reason is kept', nosposAbort.reasonFor(TAB), 'the page that started it went away');

console.log('a tab that is gone stops everything in it');
nosposAbort.begin(TAB, 'page-C');
nosposAbort.abort(TAB, 'the tab was closed');
check('no instance check when the tab itself goes', nosposAbort.isAborted(TAB), true);

console.log('an explicit stop stands on its own');
nosposAbort.begin(TAB, 'page-D');
nosposAbort.abort(TAB, 'you pressed stop');
check('stop aborts', nosposAbort.isAborted(TAB), true);
check('stop names itself', nosposAbort.reasonFor(TAB), 'you pressed stop');

console.log('a content bridge older than the instance scheme still works');
nosposAbort.begin(TAB, 'page-E');
nosposAbort.abortInstance(TAB, '', 'the page that started it went away');
check('an unstamped unload is honoured', nosposAbort.isAborted(TAB), true);

console.log('tabs do not leak into each other');
nosposAbort.begin(1, 'page-F');
nosposAbort.abort(2, 'the tab was closed');
check('aborting tab 2 leaves tab 1 running', nosposAbort.isAborted(1), false);
check('a tab nobody has walked is not aborted', nosposAbort.isAborted(99), false);
check('a missing tab id is never aborted', nosposAbort.isAborted(null), false);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
