/**
 * Close a list of tabs by id. Failures per-tab are swallowed (tab may already
 * be closed / out of scope). Used by the upload audit preview after its
 * parallel opens hold long enough for the user to see them.
 *
 * Dispatched from flows/bridge/forward.js via the BRIDGE_ACTIONS registry.
 */
async function handleBridgeAction_closeTabs({ payload }) {
  const ids = Array.isArray(payload?.tabIds)
    ? payload.tabIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  if (ids.length === 0) return { ok: true, closed: 0 };
  await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
  return { ok: true, closed: ids.length };
}
