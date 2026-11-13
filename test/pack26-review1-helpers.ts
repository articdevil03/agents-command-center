import assert from "node:assert/strict";
import { bridgeCall } from "./pack18-orch-harness.ts";
import type { fixedServer } from "./fixed-crew-execution-helpers.ts";
import { fixedDependencies } from "./round2-fixed-deps.ts";
import { assignmentsDigest } from "../server/fixed-crew/bulk-assignment.ts";
// The shared VM fixture predates this state field. Inject its real production
// import through the fixture's existing dependency object, within this run's scope.
export const installReviewDependencies = () => Object.assign(fixedDependencies, { assignmentsDigest });
type Fixture = Awaited<ReturnType<typeof fixedServer>>;
export async function askAction(f: Fixture, kind: string, brief: string) {
  const bridge = await f.control("leader-bridge");
  assert.deepEqual(await f.c.request({ type: "setPermissionMode", tabId: "fixed", mode: "ask", confirm: true }), { ok: true });
  const result = bridgeCall(bridge.url, bridge.token, "tools/call", { name: "request_task_action", arguments: { expected: f.expected(), kind, brief } });
  const item = await f.c.wait(() => f.c.tab("fixed").pendingApprovals[0], "approval offered");
  return { item, result, answer: async (allow: boolean) => {
    assert.deepEqual(await f.c.request({ type: "answerApproval", tabId: "fixed", approvalId: item.approvalId, allow }), { ok: true });
    const response = await result;
    const content = response.body.result;
    return { ok: !content.isError, value: content.isError ? content.content[0].text : JSON.parse(content.content[0].text) };
  } };
}
export async function probe(f: Fixture, tabId: string) {
  const from = f.c.messages.length;
  f.c.send({ type: "testFolderBusy", tabId });
  const reply = await f.c.wait(() => f.c.messages.slice(from).find((m) => m.type === "testFolderBusyResult" || m.type === "error"), "folder probe response");
  assert.equal(reply.type, "testFolderBusyResult", JSON.stringify(reply));
  return reply.items;
}
