/**
 * Upload (audit + upload-new) diagnostic log.
 * Globals: cgUploadLog, cgUploadLogStartTs, logUpload, resetUploadLog
 *
 * Mirrors bg/park-log.js: a flat array of structured entries, captured for the
 * lifetime of the service worker. Frontend pulls via the getUploadLog bridge
 * action and renders a .txt download on the Upload Session View screen.
 */

var cgUploadLog = [];
var cgUploadLogStartTs = null;

function logUpload(fn, phase, data, msg) {
  var now = Date.now();
  if (cgUploadLogStartTs == null) cgUploadLogStartTs = now;
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
  var entry = { ts: now, rel: now - cgUploadLogStartTs, fn: fn, phase: phase, msg: msg || '', data: safe };
  cgUploadLog.push(entry);
  console.log('[CG Upload Log] [' + fn + '] [' + phase + ']' + (msg ? ' ' + msg : ''), safe);
  // Best-effort mirror to chrome.storage.local so the log survives a service-worker
  // termination between the run finishing and the user clicking Download.
  try {
    chrome.storage.local.set({
      cgUploadLog: cgUploadLog.slice(-2000),
      cgUploadLogStartTs: cgUploadLogStartTs,
    });
  } catch (_) {}
}

function resetUploadLog() {
  cgUploadLog = [];
  cgUploadLogStartTs = Date.now();
  try {
    chrome.storage.local.set({
      cgUploadLog: [],
      cgUploadLogStartTs: cgUploadLogStartTs,
    });
  } catch (_) {}
}
