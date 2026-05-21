/**
 * Return the extension's current protocol/manifest version so Cash EPOS can
 * compare against the backend's MIN_EXTENSION_PROTOCOL_VERSION. Used as a
 * fallback when the page mounted its window-message listener after content-
 * bridge's initial CG_EXT_HELLO announcement.
 */
async function handleBridgeAction_getExtensionStatus() {
  let manifestVersion = null;
  try {
    const m = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : null;
    manifestVersion = m && m.version ? m.version : null;
  } catch (e) {
    /* unreachable in practice; fall through with null */
  }
  const protocolVersion =
    typeof CG_EXT_PROTOCOL_VERSION === 'number' ? CG_EXT_PROTOCOL_VERSION : 1;
  return {
    ok: true,
    protocolVersion,
    manifestVersion,
  };
}
