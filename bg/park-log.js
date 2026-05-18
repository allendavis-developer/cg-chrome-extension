/**
 * Park agreement diagnostic log.
 * Globals: cgParkLog, cgParkLogStartTs, logPark
 */

var cgParkLog = [];
var cgParkLogStartTs = null;

function logPark(fn, phase, data, msg) {
  var now = Date.now();
  if (cgParkLogStartTs == null) cgParkLogStartTs = now;
  var safe = {};
  try {
    safe = JSON.parse(
      JSON.stringify(data ?? {}, function (_k, v) {
        if (v === undefined) return null;
        if (typeof v === 'function') return '[Function]';
        if (
          typeof v === 'object' && v !== null && !Array.isArray(v) &&
          Object.keys(v).length > 30
        ) return '[Object]';
        return v;
      })
    );
  } catch (_) {}
  var entry = { ts: now, rel: now - cgParkLogStartTs, fn: fn, phase: phase, msg: msg || '', data: safe };
  cgParkLog.push(entry);
  console.log('[CG Park Log] [' + fn + '] [' + phase + ']' + (msg ? ' ' + msg : ''), safe);
}
