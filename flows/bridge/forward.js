/**
 * BRIDGE_FORWARD entry point.
 *
 * Looks up the action handler in BRIDGE_ACTIONS (flows/bridge/actions/registry.js)
 * and invokes it. Each handler is one small file under flows/bridge/actions/.
 * To add a new action, see the docs in registry.js.
 */

async function handleBridgeForward(message, sender) {
  const { requestId, payload } = message;
  const appTabId = sender.tab?.id;
  // Which injection of the content bridge this came from. A tab id alone cannot
  // tell one page load from the next, and a NosPos walk has to know whether a
  // stop belongs to the page that started it — see bg/nospos-abort.js.
  const pageInstanceId = message.pageInstanceId || '';

  const action = payload?.action;
  const handler = action != null ? BRIDGE_ACTIONS[action] : null;
  if (!handler) {
    return { ok: false, error: `Unknown bridge action: ${action ?? '(missing)'}` };
  }

  try {
    return await handler({ requestId, appTabId, pageInstanceId, payload });
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e) || 'Bridge action failed',
    };
  }
}
