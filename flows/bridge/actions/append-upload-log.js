/**
 * Let the page write its own entries into the upload diagnostic log.
 *
 * Most of the uploader's log is produced inside the service worker (the bridge
 * actions that talk to NosPos / Web EPOS). The decisions *about* those results
 * — "this barcode was skipped because NosPos returned two matches" — are made
 * on the page, and used to live only in a React state array that vanished when
 * the modal closed. This action lets the page push those decisions into the
 * same log the operator downloads from the Upload Session View.
 *
 * Entries are sent in batches (the sync classifies hundreds of rows) — one
 * message per row would flood the bridge.
 *
 * Payload: { entries: [{ fn?, phase?, msg?, data? }, …] }
 *
 * Best-effort by contract: it never fails the caller, and the page treats a
 * missing action (older extension build) as a no-op.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */

const APPEND_UPLOAD_LOG_MAX_ENTRIES_PER_CALL = 500;

async function handleBridgeAction_appendUploadLog({ requestId, appTabId, payload }) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (entries.length === 0) return { ok: true, appended: 0 };

  let appended = 0;
  for (const entry of entries.slice(0, APPEND_UPLOAD_LOG_MAX_ENTRIES_PER_CALL)) {
    if (!entry || typeof entry !== 'object') continue;
    logUpload(
      String(entry.fn || 'page'),
      String(entry.phase || 'info'),
      entry.data && typeof entry.data === 'object' ? entry.data : {},
      String(entry.msg || '')
    );
    appended += 1;
  }
  return { ok: true, appended };
}
