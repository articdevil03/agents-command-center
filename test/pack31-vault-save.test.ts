import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { withServer, tabOf, fakeLog, sleep } from "./pack12-server-helpers.ts";
import { vaultHandoverPath } from "../server/vault.ts";
import { scratchDir } from "./temp-root.ts";
import { delimiter } from "node:path";

const message = "Saved in this project. The vault copy needs attention.";
for (const scenario of ["fresh", "missing", "stale", "plan", "none"] as const) test(`Save real server: ${scenario} vault, local success and retry history`, { timeout: 60000 }, async () => {
  await withServer({ FAKE_CLAUDE_VAULT_WRITE: scenario === "fresh" ? "1" : "0", FAKE_VAULT_CAPTURE: "1" }, async (server, c) => {
    const tab = tabOf("claude", 1), vault = join(server.temp, "vault");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, "README.md"), "Notes go here. Daily notes live in Daily.");
    writeFileSync(join(vault, "User.md"), "do not replace");
    writeFileSync(join(vault, "User (conflict).md"), "do not merge");
    const note = vaultHandoverPath(vault, "P12", tab);
    if (scenario !== "none") {
      c.send({ type: "setNotesVault", requestId: "connect-vault", path: vault });
      await c.wait(() => c.state().settings.vault.path === vault, "vault connected");
      assert.equal(c.state().settings.vault.status, "connected");
    }
    if (scenario === "plan") {
      c.send({ type: "setPermissionMode", requestId: "set-plan", tabId: tab, mode: "plan" });
      await c.wait(() => c.state().settings.permissionModes[tab] === "plan", "Plan saved");
    }
    if (scenario === "stale") {
      mkdirSync(dirname(note), { recursive: true }); writeFileSync(note, "stale");
      utimesSync(note, new Date(1000), new Date(1000));
    }
    await c.start(tab, "work"); await c.finished(tab, 1, "first turn finished");
    const first = fakeLog(server).find((row) => row.cli === "claude" && row.userText)?.userText;
    assert.ok(first.includes("Before replying, first read the existing handover at "));
    assert.equal(first.includes("Connected notes vault:"), scenario !== "none");
    if (scenario !== "none") for (const text of [vault.replaceAll("\\", "\\\\"), "Daily notes are append-only", "Never delete or overwrite", "Never write secrets"]) assert.ok(first.includes(text), text);
    c.send({ type: "save", tabId: tab });
    await c.wait(() => c.messages.some((row) => row.type === "saved" && row.tabId === tab), "local saved event");
    await c.wait(() => !c.tabState(tab).derived.busy, "Save released tab");
    await sleep(80);
    const prompt = fakeLog(server).filter((row) => row.cli === "claude" && row.userText?.startsWith("Your role:")).map((row) => row.userText).find((text) => text.includes("Current message:\nSave a concise handover")) ?? fakeLog(server).find((row) => row.userText?.includes("Save a concise handover"))?.userText;
    assert.ok(prompt, "FOUND Save prompt");
    const actual = prompt.slice(prompt.lastIndexOf("Current message:\n") + "Current message:\n".length);
    const original = `Save a concise handover of this tab's current work to ${join(server.work, ".command-center", tab, "RESUME.md")}. Include current decisions, open work, and exact files changed. Create the folder if it does not exist.`;
    assert.ok(actual.startsWith(original), actual);
    if (scenario === "none" || scenario === "plan") assert.equal(actual, original, "exact unchanged prompt");
    else assert.ok(actual.includes(`Also write the same handover as a note at ${note}.`));
    const partial = scenario === "missing" || scenario === "stale";
    assert.equal(c.messages.some((row) => row.type === "chatNotice" && row.message === message), partial);
    const savedEvent = c.messages.find((row) => row.type === "saved" && row.tabId === tab);
    assert.ok(savedEvent.savedRevision > 0);
    assert.equal(c.tabState(tab).savedRevision, savedEvent.savedRevision);
    await c.wait(() => c.tabState(tab).vaultCopyNeedsAttention === partial, "server supplies vault warning flag");
    assert.equal(savedEvent.revision, savedEvent.savedRevision);
    const history = () => readdirSync(join(server.data, "logs")).filter((name) => name.startsWith(`${tab}.leader-`) && name.endsWith(".brief.txt"));
    const entries = history(); assert.equal(entries.length, 1, "one local Save history entry");
    if (partial) {
      c.send({ type: "save", tabId: tab });
      await c.wait(() => c.messages.filter((row) => row.type === "saved" && row.tabId === tab).length === 2, "retry saved locally");
      assert.deepEqual(history(), entries, "retry does not add duplicate local history");
      c.send({ type: "setPermissionMode", requestId: "warning-plan", tabId: tab, mode: "plan" });
      await c.wait(() => c.state().settings.permissionModes[tab] === "plan", "Plan saved");
      c.send({ type: "save", tabId: tab });
      await c.wait(() => c.messages.filter((row) => row.type === "saved" && row.tabId === tab).length === 3, "Plan Save confirmed locally");
      await c.wait(() => !c.tabState(tab).derived.busy, "Plan Save ended");
      assert.equal(c.tabState(tab).vaultCopyNeedsAttention, true, "Plan Save cannot clear an unverified vault warning");
      c.send({ type: "setNotesVault", requestId: "disconnect-warning", path: null });
      await c.wait(() => c.tabState(tab).vaultCopyNeedsAttention === false, "disconnect clears warning");
      c.send({ type: "setNotesVault", requestId: "reconnect-warning", path: vault });
      await c.wait(() => c.state().settings.vault.path === vault, "reconnected");
      assert.equal(c.tabState(tab).vaultCopyNeedsAttention, false, "old warning does not return on reconnect");
    }
    assert.equal(readFileSync(join(vault, "User.md"), "utf8"), "do not replace");
    assert.equal(readFileSync(join(vault, "User (conflict).md"), "utf8"), "do not merge");
  });
});

test("a verified retry clears the persistent warning in server state", { timeout: 60000 }, async () => {
  await withServer({ CC_TEST_SAVE_WRITE_DELAY_MS: "350" }, async (server, c) => {
    const tab = tabOf("claude", 1), vault = join(server.temp, "vault"); mkdirSync(vault);
    c.send({ type: "setNotesVault", requestId: "connect", path: vault });
    await c.wait(() => c.state().settings.vault.path === vault, "connected");
    await c.start(tab, "work"); await c.finished(tab, 1, "work done");
    c.send({ type: "save", tabId: tab });
    await c.wait(() => c.tabState(tab).vaultCopyNeedsAttention === true, "failed copy flagged");
    await c.wait(() => !c.tabState(tab).derived.busy, "first Save ended");
    const note = vaultHandoverPath(vault, "P12", tab);
    c.send({ type: "save", tabId: tab });
    await c.wait(() => c.tabState(tab).derived.busy, "retry started");
    await sleep(80); mkdirSync(dirname(note), { recursive: true }); writeFileSync(note, "verified copy");
    await c.wait(() => c.messages.filter((row) => row.type === "saved").length === 2, "retry saved");
    await c.wait(() => c.tabState(tab).vaultCopyNeedsAttention === false, "verified copy clears flag");
  });
});

test("connection changes replace a leader next turn; notice is first-turn only and disconnect removes grants", { timeout: 60000 }, async () => {
  await withServer({ FAKE_VAULT_CAPTURE: "1" }, async (server, c) => {
    const tab = tabOf("claude", 1), vault = join(server.temp, "vault"); mkdirSync(vault);
    const turn = async (count: number) => { await c.start(tab, `work-${count}`); await c.finished(tab, count, `turn ${count}`); };
    await turn(1);
    c.send({ type: "setNotesVault", requestId: "on", path: vault });
    await c.wait(() => c.state().settings.vault.path === vault, "connected");
    await turn(2); await turn(3);
    c.send({ type: "setNotesVault", requestId: "off", path: null });
    await c.wait(() => c.state().settings.vault.path === null, "disconnected");
    await turn(4);
    const captured = fakeLog(server).filter((row) => row.cli === "claude" && row.options).map((row) => row.options);
    assert.equal(captured.length, 3, "sessions before, during and after connection");
    assert.equal(captured[0].additionalDirectories, undefined);
    assert.deepEqual(captured[1].additionalDirectories, [vault]);
    assert.equal(captured[2].additionalDirectories, undefined);
    const prompts = fakeLog(server).filter((row) => row.cli === "claude" && row.userText).map((row) => row.userText);
    assert.deepEqual(prompts.map((text) => text.includes("Connected notes vault:")), [false, true, false, false]);
  });
});

test("ACP receives only the shared first-turn vault notice and retains Full access", { timeout: 60000 }, async () => {
  const bin = scratchDir(); writeFileSync(join(bin, "fake-acp.cmd"), "@echo off\r\n");
  await withServer({ PATH: `${bin}${delimiter}${process.env.PATH}` }, async (server, c) => {
    const tab = tabOf("claude", 1), vault = join(server.temp, "vault"); mkdirSync(vault);
    let sequence = 0;
    const request = async (payload: any) => {
      const requestId = `acp-vault-${++sequence}`;
      c.send({ ...payload, requestId });
      const reply = await c.wait(() => c.messages.find((row) => row.requestId === requestId && ["actionResult", "error"].includes(row.type)), "ACP setup reply");
      assert.equal(reply.type, "actionResult", JSON.stringify(reply));
    };
    await request({ type: "addAcpCli", name: "Fake vault", command: "fake-acp --scenario=basic" });
    await request({ type: "refreshSettings" });
    c.send({ type: "selectTab", tabId: tab });
    await request({ type: "setCrewAssignment", tabId: tab, slot: "leader", assignment: { cli: "acp:fake-vault", model: "default", effort: "default" } });
    await request({ type: "setNotesVault", path: vault });
    await c.start(tab, "read my guide"); await c.finished(tab, 1, "ACP first turn");
    const rows = fakeLog(server).filter((row) => row.cli === "acp");
    const session = rows.find((row) => row.received === "session/new");
    assert.ok(session, "FOUND ACP session creation");
    assert.deepEqual(Object.keys(session.params).sort(), ["cwd", "mcpServers"], "ACP gains no directory policy");
    assert.equal(session.params.cwd, server.work);
    const prompt = rows.find((row) => row.prompt);
    assert.ok(prompt, "FOUND ACP prompt");
    assert.ok(prompt.text.includes("Connected notes vault:"));
    assert.equal(c.tabState(tab).permissionMode, "bypass");
    assert.equal(c.failed(tab), 0);
    await request({ type: "setNotesVault", path: null });
    await c.start(tab, "same ACP session after disconnect"); await c.finished(tab, 2, "ACP second turn");
    await request({ type: "setNotesVault", path: vault });
    await c.start(tab, "same ACP session after reconnect"); await c.finished(tab, 3, "ACP third turn");
    assert.equal(fakeLog(server).filter((row) => row.cli === "acp" && row.received === "session/new").length, 1, "vault changes keep ACP session");
  });
});

for (const change of ["connect", "disconnect"]) test(`Save immediately after vault ${change} refuses until a message reads the handover`, { timeout: 60000 }, async () => {
  await withServer({ FAKE_CLAUDE_VAULT_WRITE: "1" }, async (server, c) => {
    const tab = tabOf("claude", 1), vault = join(server.temp, "vault"); mkdirSync(vault);
    if (change === "disconnect") {
      c.send({ type: "setNotesVault", requestId: "initial-vault", path: vault });
      await c.wait(() => c.state().settings.vault.path === vault, "initial vault connected");
    }
    await c.start(tab, "work before connection"); await c.finished(tab, 1, "initial work");
    const local = join(server.work, ".command-center", tab, "RESUME.md");
    mkdirSync(dirname(local), { recursive: true }); writeFileSync(local, "good handover must survive");
    const path = change === "connect" ? vault : null;
    c.send({ type: "setNotesVault", requestId: "change-before-save", path });
    await c.wait(() => c.state().settings.vault.path === path, "vault changed");
    c.send({ type: "save", tabId: tab });
    const result = await c.wait(() => c.messages.find((row) => row.type === "saved" || (row.type === "error" && row.action === "save")), "Save completed after session refresh");
    assert.equal(result.type, "error", JSON.stringify(result));
    assert.equal(result.message, "send a message first so the leader reads the saved handover; saving now would overwrite it");
    assert.equal(readFileSync(local, "utf8"), "good handover must survive");
    await c.start(tab, "read first"); await c.finished(tab, 2, "replacement read-first turn");
    c.send({ type: "save", tabId: tab });
    await c.wait(() => c.messages.some((row) => row.type === "saved"), "Save after read succeeds");
    assert.equal(c.messages.some((row) => row.type === "chatNotice" && row.message === message), false);
  });
});
