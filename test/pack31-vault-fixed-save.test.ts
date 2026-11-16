import test from "node:test";
import assert from "node:assert/strict";
import { withServer, tabOf, sleep } from "./pack12-server-helpers.ts";

// No vault connected: a fixed-crew leader replaced inside Save's own turn has only read the handover and a short chat tail,
// so Save must not confirm from it (the same behaviour as before the vault existed).
test("real server, no vault: Save right after the fixed leader's setting changed does not confirm", { timeout: 60000 }, async () => {
  await withServer({ FAKE_CLAUDE_VAULT_WRITE: "0" }, async (server, c) => {
    const tab = tabOf("claude", 1);
    await c.start(tab, "work"); await c.finished(tab, 1, "first turn finished");
    c.send({ type: "setCrewRoleExtra", requestId: "extra", tabId: tab, slot: "leader", text: "Answer briefly." });
    await c.wait(() => c.messages.some((row) => row.requestId === "extra" && (row.type === "actionResult" || row.type === "error")), "role extra answered");
    assert.equal(c.messages.some((row) => row.type === "error" && row.requestId === "extra"), false, "the setting change was accepted");
    c.send({ type: "save", tabId: tab });
    await c.wait(() => c.messages.some((row) => row.type === "error" && row.action === "save" && row.tabId === tab), "Save refused");
    assert.match(c.messages.find((row) => row.type === "error" && row.action === "save" && row.tabId === tab).message, /leader could not save the handover/);
    await sleep(200);
    assert.equal(c.messages.some((row) => row.type === "saved" && row.tabId === tab), false, "the tab is not marked saved");
  });
});
