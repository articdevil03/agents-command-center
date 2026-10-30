import { appSource } from "./source-text.ts";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";

// Execute the actual handler, state selectors and request renderer. Only DOM and unrelated rendering are stubbed.
export function actionClient() {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, value: "", textContent: "", innerHTML: "", dataset: {}, options: [],
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, setAttribute() {},
      classList: { contains: () => false, toggle() {}, add() {}, remove() {} }, style: {} });
    return nodes.get(id);
  };
  const source = appSource();
  const end = source.lastIndexOf("  bindEvents();");
  assert.ok(end > 0, "client initialization boundary found");
  const api = runInNewContext(source.slice(0, end) + `
    renderAll = () => {}; addStateNotices = () => {}; newApprovalRequests = () => {}; settleConfirmedActions = () => {};
    return { onMessage, actionStateFor, actionStatusMarkup, settingsActionRunning, renderRequests,
      pendingSettingsActions, pendingRequestActions, pendingPermissionAction, requestFormCleared,
      seenListedActions, resultSize: () => settingsActionResults.size,
      setState: (state) => { serverState = state; },
    };
  })()`, { document: { getElementById: node, querySelectorAll: () => [], activeElement: null },
    window: { localStorage: { getItem: () => null } }, Map, Set, console, CSS: { escape: (s: string) => s },
    location: { protocol: "http:", host: "127.0.0.1" }, setTimeout, clearTimeout, performance: { now: () => 0 } });
  return { ...api, node };
}
