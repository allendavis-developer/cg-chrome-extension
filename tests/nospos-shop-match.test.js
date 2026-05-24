/**
 * Regression suite for nosposShopMismatchReason.
 *
 * Run from the chrome-extension/ directory:
 *   node tests/nospos-shop-match.test.js
 *
 * Pinned safety contract: when a caller asks for a shop check, the function
 * must NEVER fail-open. Either it positively confirms the shop matches
 * (returns null) or it returns a mismatch object. Empty navbar / unparseable
 * page must be reported as a mismatch, not silently passed — otherwise the
 * park-agreement flow runs against whatever shop the operator happens to be
 * signed into on NosPos, even when that's the wrong shop for the active
 * Cash EPOS store.
 *
 * Background: prior to this fix the function returned null whenever the
 * navbar regex didn't match, which let park agreement fill an agreement on
 * the wrong NosPos shop without any user-visible error.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.resolve(__dirname, '..', 'bg', 'nospos-html.js');
const src = fs.readFileSync(srcPath, 'utf8');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src, ctx);

const { nosposShopMismatchReason } = ctx;
if (typeof nosposShopMismatchReason !== 'function') {
  console.error('nosposShopMismatchReason not exported from bg/nospos-html.js');
  process.exit(2);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    passed++;
  } catch (e) {
    console.error('  FAIL  ' + name + '\n        ' + e.message);
    failed++;
  }
}

function assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      (msg || 'mismatch') + ': got ' + JSON.stringify(actual) +
      ', want ' + JSON.stringify(expected)
    );
  }
}

console.log('nosposShopMismatchReason');

test('no expectations passed → null (caller intentionally skipped check)', () => {
  assertEq(nosposShopMismatchReason('CG Warrington', '', ''), null);
  assertEq(nosposShopMismatchReason('', '', ''), null);
  assertEq(nosposShopMismatchReason(null, null, null), null);
});

test('matchStr substring matches label → null', () => {
  assertEq(
    nosposShopMismatchReason('CG Warrington', 'CG Warrington', 'warrington'),
    null
  );
});

test('matchStr substring matches label, case insensitive', () => {
  assertEq(
    nosposShopMismatchReason('Liverpool - Toxteth', 'CG Toxteth', 'toxteth'),
    null
  );
});

test('matchStr substring NOT in label → mismatch', () => {
  const r = nosposShopMismatchReason('CG Toxteth', 'CG Warrington', 'warrington');
  if (!r) throw new Error('expected mismatch, got null');
  assertEq(r.expectedCgShop, 'CG Warrington', 'mismatch payload');
});

test('FAIL-CLOSED: empty label + matchStr present → mismatch (bug fix)', () => {
  // Pre-fix behaviour: returned null and let park agreement run against the
  // wrong shop. Test pins the new safety contract.
  const r = nosposShopMismatchReason('', 'CG Warrington', 'warrington');
  if (!r) {
    throw new Error(
      'expected mismatch when label is empty; got null. ' +
      'This is the fail-open regression that lets park agreement run against ' +
      'the wrong NosPos shop.'
    );
  }
  assertEq(r.expectedCgShop, 'CG Warrington');
});

test('FAIL-CLOSED: empty label + only legacy expectedCgShopName → mismatch', () => {
  const r = nosposShopMismatchReason('', 'CG Warrington', '');
  if (!r) {
    throw new Error('expected mismatch when label is empty; got null (legacy path)');
  }
  assertEq(r.expectedCgShop, 'CG Warrington');
});

test('FAIL-CLOSED: empty label + only matchStr → mismatch with match string fallback', () => {
  // Caller didn't pass a friendly name, so we fall back to the substring.
  const r = nosposShopMismatchReason('', '', 'warrington');
  if (!r) throw new Error('expected mismatch, got null');
  assertEq(r.expectedCgShop, 'warrington');
});

test('legacy (no matchStr): exact normalised match → null', () => {
  assertEq(nosposShopMismatchReason('CG Warrington', 'CG Warrington', ''), null);
  assertEq(nosposShopMismatchReason('Warrington CG', 'CG Warrington', ''), null);
});

test('legacy (no matchStr): different shops → mismatch', () => {
  const r = nosposShopMismatchReason('CG Toxteth', 'CG Warrington', '');
  if (!r) throw new Error('expected mismatch, got null');
  assertEq(r.expectedCgShop, 'CG Warrington');
});

test('legacy strict-normalised does NOT loose-match substrings', () => {
  // "CG Liverpool - Toxteth" should NOT match "CG Toxteth" under strict
  // normalised equality — this is exactly why the matchStr path exists.
  const r = nosposShopMismatchReason('Liverpool - Toxteth', 'CG Toxteth', '');
  if (!r) throw new Error('legacy strict compare should mismatch substrings');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
