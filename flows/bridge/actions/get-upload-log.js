/**
 * Return the persisted upload (audit + upload-new) log entries for debugging.
 * Falls back to chrome.storage.local when the in-memory log was cleared by a
 * service-worker restart between the run finishing and the user clicking Download.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_getUploadLog({ requestId, appTabId, payload }) {
  if (cgUploadLog.length > 0) {
    return { ok: true, entries: cgUploadLog.slice(), startTs: cgUploadLogStartTs };
  }
  try {
    const stored = await chrome.storage.local.get(['cgUploadLog', 'cgUploadLogStartTs']);
    const entries = Array.isArray(stored.cgUploadLog) ? stored.cgUploadLog : [];
    const startTs = stored.cgUploadLogStartTs ?? null;
    return { ok: true, entries, startTs };
  } catch (e) {
    return { ok: true, entries: [], startTs: null };
  }
}
