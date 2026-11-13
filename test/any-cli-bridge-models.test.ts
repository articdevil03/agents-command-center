import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { config, readWorkspaces, buildLeaderOptions, LEADER, WORKER, READER, TAB, OPENCODE_LEADER, CLAUDE_LEADER, exitWithin, withServer, script, bridgePost } from "./any-cli-helpers.ts";

const FIXED_TOOLS = ["accept_planner_report", "begin_planning", "finish_fixed_task", "get_fixed_task", "get_task_archive", "list_task_archives", "reconcile_task_execution", "request_task_action", "verify_task_evidence"];
const SONNET_SEAT = { cli: "claude", model: READER.model, effort: READER.effort };

// A saved fixed-crew file: the leader (with an optional advisor) and the Claude writer seat hold the given values; every other slot is unassigned.
// The fixture reaches config.ts, so it is loaded here, after the helpers imported config on the temp data root.
async function fixedFile(folder: string, worker: object, advisor?: string, leader: object = SONNET_SEAT) {
  const { fixedProject, fixedTab, fixedWorkspaces } = await import("./fixed-server-fixture.ts");
  const tab = fixedTab("p-dev", folder, { leader: { ...leader, ...(advisor !== undefined ? { advisor } : {}) }, [WORKER.slotId]: worker } as any);
  return fixedWorkspaces([{ ...fixedProject("p", folder, [tab]), name: "P" }]);
}

test("bridge: bearer token, no Origin, POST only, 1 MiB cap, the MCP methods", { timeout: 60000 }, async () => {
  await withServer({ leader: OPENCODE_LEADER }, async (h) => {
    const start = h.chat("start the leader"); await h.wait(() => h.turnEnded(start).length === 1, "turn"); await h.idle();
    const token = h.cliEntries().find((e) => e.path === "/mcp").body.config.headers.Authorization.slice("Bearer ".length);
    const path = `/api/leader-mcp/${TAB}`;
    const rpc = (method: string, params: object = {}, id: number | false = 1) => JSON.stringify({ jsonrpc: "2.0", ...(id === false ? {} : { id }), method, params });
    const good = { authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-11-25" };
    // The header set measured from OpenCode's MCP client: Host 127.0.0.1:<port>, Accept json+sse, no Origin, no session id.
    assert.equal((await bridgePost(h.port, path, {}, rpc("tools/list"))).status, 401, "no token");
    assert.equal((await bridgePost(h.port, path, { authorization: `Bearer ${"0".repeat(token.length)}` }, rpc("tools/list"))).status, 401, "wrong token");
    assert.equal((await bridgePost(h.port, path, { authorization: `Bearer ${token}x` }, rpc("tools/list"))).status, 401, "longer token");
    assert.equal((await bridgePost(h.port, path, { authorization: token }, rpc("tools/list"))).status, 401, "not a Bearer header");
    assert.equal((await bridgePost(h.port, path, { ...good, Origin: `http://127.0.0.1:${h.port}` }, rpc("tools/list"))).status, 403, "even the app's own Origin is refused");
    assert.equal((await bridgePost(h.port, path, { ...good, Origin: "http://evil.example" }, rpc("tools/list"))).status, 403, "a foreign Origin is refused");
    assert.equal((await bridgePost(h.port, path, { ...good, Host: "evil.example" }, rpc("tools/list"))).status, 403, "the Host check still applies");
    assert.equal((await bridgePost(h.port, path, good, "", "GET")).status, 405);
    assert.equal((await bridgePost(h.port, `/api/leader-mcp/other-tab`, good, rpc("tools/list"))).status, 401, "another tab is not reachable");
    const init = await bridgePost(h.port, path, good, rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    assert.equal(init.status, 200); assert.equal(JSON.parse(init.body).result.serverInfo.name, "tab-crew");
    const note = await bridgePost(h.port, path, good, rpc("notifications/initialized", {}, false));
    assert.deepEqual([note.status, note.body], [202, ""]);
    const list = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/list"))).body).result.tools;
    assert.deepEqual(list.map((t: any) => t.name).sort(), FIXED_TOOLS);
    const status = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "get_fixed_task", arguments: {} }))).body).result;
    assert.deepEqual(Object.keys(JSON.parse(status.content[0].text)).sort(), ["executions", "task"]); assert.equal(status.isError, undefined);
    const bad = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "begin_planning", arguments: { expected: null, brief: 1 } }))).body).result;
    assert.equal(bad.isError, true); assert.match(bad.content[0].text, /invalid arguments/);
    const missing = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "nope" }))).body).result;
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse((await bridgePost(h.port, path, good, rpc("resources/list"))).body).error.code, -32601);
    assert.equal((await bridgePost(h.port, path, good, "{not json")).status, 400);
    assert.equal((await bridgePost(h.port, path, good, "x".repeat(1024 * 1024 + 10))).status, 413);
    // Never in state or logs.
    assert.ok(!JSON.stringify(h.messages).includes(token));
  });
});

// ---- saved models must never stop the app from starting ----

test("saved models: an advisor alias, a seat alias and an unlisted full id start the server and stay in state", { timeout: 60000 }, async () => {
  await withServer({ leader: { ...CLAUDE_LEADER, model: "claude-opus-6-0" }, advisor: "fable", workerModel: "fable" }, async (h) => {
    assert.equal(h.seat(LEADER.slotId).advisor, "fable");
    assert.equal(h.seat(WORKER.slotId).model, "fable");
    assert.equal(h.seat(LEADER.slotId).model, "claude-opus-6-0");
    const saved = JSON.parse(readFileSync(join(h.temp, "data", "config", "workspaces.json"), "utf8")).projects[0].tabs[0];
    assert.equal(saved.fixedCrew.preferences.leader.assignment.advisor, "fable", "his saved value is not rewritten");
  });
});

test("saved models: a malformed Claude model or advisor is still refused at load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-savedmodel-"));
  try {
    const path = join(dir, "workspaces.json");
    const write = async (model: string, advisor?: string) => writeFileSync(path, JSON.stringify(await fixedFile(dir, { cli: "claude", model, effort: WORKER.effort }, advisor)));
    // A model that is safe in shape loads (the live list judges it only when a user picks it); an unsafe one is refused: the tab loads with a fresh
    // crew and says why (the recovery notice), and the bad value is nowhere in what was loaded.
    const loaded = () => readWorkspaces(path).projects[0].tabs[0].fixedCrew!.preferences;
    const refused = (message: RegExp, label: string) => {
      const preferences = loaded();
      assert.equal(preferences[WORKER.slotId].assignment, null, `${label}: the unsafe seat was not loaded`);
      assert.equal(preferences.leader.assignment, null, `${label}: the whole saved crew was set aside`);
      assert.match(config.fixedCrewRecovery("p-dev", path) ?? "", message, label);
    };
    for (const bad of ["../x", "a".repeat(200), "fa ble", 'fa"ble', "fa;ble", "fa&ble", "fa|ble", "fa\u0001ble", "fa\nble", "-flag", "a/../b", ""]) {
      await write(bad);
      refused(/Invalid crew assignment/, `seat model ${JSON.stringify(bad.slice(0, 20))}`);
      await write("sonnet", bad);
      refused(/Invalid crew advisor/, `advisor ${JSON.stringify(bad.slice(0, 20))}`);
    }
    await write("fable", "claude-opus-6-0");
    assert.deepEqual([loaded()[WORKER.slotId].assignment!.model, loaded().leader.assignment!.advisor], ["fable", "claude-opus-6-0"], "control: safe values load unchanged");
    await write("not-a-claude-model", "not-a-claude-model");
    assert.deepEqual([loaded()[WORKER.slotId].assignment!.model, loaded().leader.assignment!.advisor], ["not-a-claude-model", "not-a-claude-model"]);
  } finally { removeWithRetry(dir); }
});

test("saved models: an advisor chosen in the app still refuses an unknown model", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable" }, async (h) => {
    await h.refresh();
    const error = await h.assign(LEADER.slotId, { ...CLAUDE_LEADER, advisor: "nope" });
    assert.equal(error.type, "error"); assert.match(error.message, /Unknown crew advisor/);
    assert.equal(h.seat(LEADER.slotId).advisor, "fable");
  });
});

const SAVED_MODEL_CASES = ["fable", "fable.5", "fable-5", "default", "claude-opus-6-0[1m]"];

for (const saved of SAVED_MODEL_CASES) {
  test(`saved models: ${saved} as the advisor and as a Claude seat model starts the server, is listed, and later saves still work`, { timeout: 60000 }, async () => {
    await withServer({ leader: CLAUDE_LEADER, advisor: saved, workerModel: saved }, async (h) => {
      assert.equal(h.seat(LEADER.slotId).advisor, saved);
      assert.equal(h.seat(WORKER.slotId).model, saved);
      // Discovery is skipped in this server, so the live list holds the saved value only through the boot adoption.
      assert.ok(h.state().modelOptions.claude.includes(saved), "listed in modelOptions");
      assert.ok(h.state().claudeModels.some((m: any) => m.value === saved), "listed in claudeModels");
      await h.refresh();
      const answer = await h.assign(READER.slotId, { cli: "claude", model: saved, effort: READER.effort });
      assert.equal(answer.type, "actionResult", "the live list accepts a saved value for another seat");
      assert.equal(h.savedSeat(READER.slotId).model, saved);
      const extra = await h.roleExtra(WORKER.slotId, "a later save");
      assert.equal(extra.type, "actionResult", "a later save of another field works");
      assert.equal(h.savedFixed().roleExtras[WORKER.slotId], "a later save");
      assert.equal(h.savedSeat(WORKER.slotId).model, saved, "his value is not rewritten");
      assert.equal(h.savedSeat(LEADER.slotId).advisor, saved);
    });
  });
}

test("saved models: a saved discovered effort (ultra) starts the server, is listed, and later saves still work", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, workerEffort: "ultra" }, async (h) => {
    assert.equal(h.seat(WORKER.slotId).effort, "ultra");
    assert.ok(h.state().effortOptions.claude.includes("ultra"), "listed in effortOptions");
    const extra = await h.roleExtra(WORKER.slotId, "a later save");
    assert.equal(extra.type, "actionResult");
    assert.equal(h.savedSeat(WORKER.slotId).effort, "ultra");
  });
});

test("saved models: updateSeat still refuses a model, an effort or an advisor that is not in the live list", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable", workerModel: "fable", workerEffort: "ultra" }, async (h) => {
    await h.refresh();
    const saved = { cli: "claude", model: "fable", effort: "ultra" };
    for (const payload of [{ model: "nope" }, { model: "fable.7" }, { effort: "turbo" }, { effort: "ul tra" }, { model: "../x" }]) {
      const answer = await h.assign(WORKER.slotId, { ...saved, ...payload });
      assert.equal(answer.type, "error", JSON.stringify(payload));
    }
    assert.deepEqual(h.savedSeat(WORKER.slotId), saved, "every refusal left the saved seat alone");
    const refused = await h.assign(LEADER.slotId, { ...CLAUDE_LEADER, advisor: "fable.7" });
    assert.equal(refused.type, "error"); assert.match(refused.message, /Unknown crew advisor/);
    assert.equal(h.seat(LEADER.slotId).advisor, "fable");
  });
});

// A server run cannot spawn a real Claude worker, so the boot sequence index.ts runs (read the file, adopt, then build
// commands and take discovery) is driven in a child process with the real config and runner modules.
test("saved models: before discovery, and after a discovery that narrows the lists, saved models and efforts still build commands and save", { timeout: 60000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "cc-savedboot-"));
  try {
    const data = join(temp, "data"), work = join(temp, "work"), home = join(temp, "home");
    for (const dir of [join(data, "config"), work, home]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify(await fixedFile(work, { cli: "claude", model: "fable.5", effort: "ultra" }, "fable-5", { ...SONNET_SEAT, effort: "xhigh" })));
    const script = join(temp, "boot.mjs");
    const url = (file: string) => pathToFileURL(resolve(file)).href;
    writeFileSync(script, `
      const config = await import(${JSON.stringify(url("server/config.ts"))});
      const runner = await import(${JSON.stringify(url("server/runner.ts"))});
      const out = {};
      const run = (cli, model, effort) => ({ runId: "r1", seatKey: "p-dev.coder", slotId: "coder", name: "N", cli, model, effort, folder: ${JSON.stringify(work)}, canWrite: false, startedAt: 1 });
      const tryBuild = (key, model, effort) => { try { out[key] = runner.buildCommand(run("claude", model, effort), "C:/x/brief.txt"); } catch (e) { out[key] = "THROWS " + e.message; } };
      const workspaces = config.readWorkspaces();
      tryBuild("beforeAdopt", "fable.5", "ultra");
      config.adoptSavedValues(workspaces); // the line index.ts runs right after readWorkspaces
      tryBuild("beforeDiscovery", "fable.5", "ultra");
      tryBuild("advisorModel", "fable-5", "xhigh");
      await config.refreshDiscovery(async () => ({ values: ["low", "medium", "high"], fallback: false }), async (f) => ({ values: [...f], fallback: true }), async () => ({ fallback: false, values: [{ value: "claude-opus-5-5[1m]", displayName: "Opus", supportsEffort: true }] }));
      tryBuild("afterNarrowed", "fable.5", "ultra");
      tryBuild("afterNarrowedXhigh", "claude-opus-5-5[1m]", "xhigh");
      out.efforts = config.EFFORT_OPTIONS.claude;
      out.models = config.MODEL_OPTIONS.claude;
      try { config.writeWorkspaces(workspaces); out.write = "ok"; } catch (e) { out.write = "THROWS " + e.message; }
      out.strict = config.isValidModel("claude", "nope") || config.isValidEffort("claude", "turbo") ? "LOOSE" : "strict";
      console.log("RESULT " + JSON.stringify(out));
    `);
    const child = spawn(process.execPath, [script], { cwd: resolve("."), windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data } });
    let output = ""; child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
    await exitWithin(child);
    const line = output.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `child output: ${output.slice(-800)}`);
    const out = JSON.parse(line.slice(7));
    assert.match(out.beforeAdopt, /^THROWS .*refusing invalid/, "control: without the adoption the command is refused, so the rest proves the adoption");
    assert.match(out.beforeDiscovery, /--model fable\.5 --effort ultra/);
    assert.match(out.advisorModel, /--model fable-5 --effort xhigh/);
    assert.match(out.afterNarrowed, /--model fable\.5 --effort ultra/);
    assert.match(out.afterNarrowedXhigh, /--model claude-opus-5-5\[1m\] --effort xhigh/, "a saved xhigh survives a discovery that narrows to low/medium/high");
    assert.ok(out.efforts.includes("xhigh") && out.efforts.includes("ultra") && out.efforts.includes("low"), `efforts ${out.efforts}`);
    assert.ok(out.models.includes("fable-5") && out.models.includes("fable.5"), "the saved advisor and seat model stay listed after a refresh that omits them");
    assert.equal(out.write, "ok", "a later workspace write still passes");
    assert.equal(out.strict, "strict");
  } finally { removeWithRetry(temp); }
});

// Runs `body` in a child process that has the real config module, a data folder holding `workspace` (or none),
// and `make(patch, advisor)` which returns a fixed workspace with the Claude writer seat / the leader's advisor changed.
// The seed is written before the child imports config, so config never sees a legacy file.
async function configChild(workspace: object | null, body: string): Promise<any> {
  const temp = mkdtempSync(join(tmpdir(), "cc-configchild-"));
  try {
    const data = join(temp, "data"), work = join(temp, "work"), home = join(temp, "home");
    for (const dir of [join(data, "config"), work, home]) mkdirSync(dir, { recursive: true });
    if (workspace) writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify(workspace));
    const script = join(temp, "child.mjs");
    const base = await fixedFile(work, { cli: "claude", model: WORKER.model, effort: WORKER.effort });
    writeFileSync(script, `
      import { join } from "node:path";
      const config = await import(${JSON.stringify(pathToFileURL(resolve("server/config.ts")).href)});
      const out = {};
      const tmpPath = join(${JSON.stringify(temp)}, "scratch-workspaces.json");
      const base = ${JSON.stringify(base)};
      const make = (patch, advisor) => { const next = structuredClone(base), seats = next.projects[0].tabs[0].fixedCrew.preferences; seats[${JSON.stringify(WORKER.slotId)}].assignment = { ...seats[${JSON.stringify(WORKER.slotId)}].assignment, ...patch }; if (advisor) seats.leader.assignment = { ...seats.leader.assignment, advisor }; return next; };
      const attempt = (fn) => { try { fn(); return "ok"; } catch (e) { return "THROWS " + e.message; } };
      ${body}
      console.log("RESULT " + JSON.stringify(out));
    `);
    const child = spawn(process.execPath, [script], { cwd: resolve("."), windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FORCE_PACKAGED: "1", CC_DATA_DIR: data } });
    let output = ""; child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
    await exitWithin(child);
    const line = output.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `child output: ${output.slice(-800)}`);
    return JSON.parse(line.slice(7));
  } finally { removeWithRetry(temp); }
}

const DISCOVERED_CLAUDE = (extra: string[]) => `[${["sonnet", ...extra].map((value) => JSON.stringify({ value, displayName: value.slice(0, 20), supportsEffort: true })).join(",")}]`;

test("saved values: a write and a user pick need a safe shape AND the list/CLI check; unsafe discovery values are never offered, and every offered value saves and loads", { timeout: 60000 }, async () => {
  const out = await configChild(null, `
    const unsafeClaude = ["has space", "a".repeat(101), "-flag", "a/../b"];
    out.picks = [["opencode", "-vendor/model"], ["opencode", "vendor/../model"], ["claude", "has space"], ["claude", "a".repeat(101)], ["codex", "gpt-6 sol"]].map(([k, m]) => config.isValidModel(k, m));
    out.writes = ["-vendor/model", "vendor/../model"].map((m) => attempt(() => config.writeWorkspaces(make({ cli: "opencode", model: m, effort: "max" }), tmpPath)));
    out.advisorWrite = attempt(() => config.writeWorkspaces(make({}, "has space"), tmpPath));
    out.fileWritten = (await import("node:fs")).existsSync(tmpPath);
    await config.refreshDiscovery(async () => ({ values: ["low", "high", "bad eff", "-x"], fallback: false }), async () => ({ values: ["okprov/ok-model", "-vendor/model", "vendor/../model", "opencode/gpt-fine", "opencode/gpt-bad one"], fallback: false }), async () => ({ fallback: false, values: JSON.parse(${JSON.stringify(DISCOVERED_CLAUDE(["has space", "a".repeat(101), "-flag", "a/../b", "claude-x[1m]"]))}) }));
    out.claudeListed = config.MODEL_OPTIONS.claude; out.claudeInfo = config.CLAUDE_MODEL_INFO.map((m) => m.value);
    out.claudeEfforts = config.EFFORT_OPTIONS.claude; out.opencode = config.OPENCODE_MODEL_SUGGESTIONS; out.codex = config.MODEL_OPTIONS.codex;
    const trips = [];
    const trip = (cli, model, effort, advisor) => { try { config.writeWorkspaces(make({ cli, model, effort }, advisor), tmpPath); config.readWorkspaces(tmpPath); } catch (e) { trips.push(cli + " " + model + " " + effort + " -> " + e.message); } };
    for (const m of config.MODEL_OPTIONS.claude) trip("claude", m, "high", m);
    for (const m of config.MODEL_OPTIONS.codex) trip("codex", m, "high");
    for (const m of config.OPENCODE_MODEL_SUGGESTIONS) trip("opencode", m, "max");
    for (const e of config.EFFORT_OPTIONS.claude) trip("claude", "sonnet", e);
    for (const e of config.EFFORT_OPTIONS.codex) trip("codex", "gpt-6-sol", e);
    for (const e of config.EFFORT_OPTIONS.opencode) trip("opencode", "okprov/ok-model", e);
    out.trips = trips;
  `);
  assert.deepEqual(out.picks, [false, false, false, false, false], "user picks with an unsafe shape are refused");
  assert.ok(out.writes.every((w: string) => /^THROWS .*Invalid crew (assignment|model)/.test(w)), `writes ${out.writes}`);
  assert.match(out.advisorWrite, /^THROWS .*Invalid crew advisor/);
  assert.equal(out.fileWritten, false, "nothing was written for any refused value");
  const unsafe = ["has space", "a".repeat(101), "-flag", "a/../b", "bad eff", "-x", "-vendor/model", "vendor/../model", "gpt-bad one", "opencode/gpt-bad one"];
  for (const list of [out.claudeListed, out.claudeInfo, out.claudeEfforts, out.opencode, out.codex]) for (const bad of unsafe) assert.ok(!list.includes(bad), `${JSON.stringify(bad.slice(0, 20))} must not be offered`);
  assert.ok(out.claudeListed.includes("claude-x[1m]") && out.claudeEfforts.includes("high") && out.opencode.includes("okprov/ok-model") && out.codex.includes("gpt-fine"), "control: the safe discovered values are offered");
  assert.deepEqual(out.trips, [], "every offered value saves and loads");
});

test("saved values: the saved sets follow the current workspace, so a value nobody uses any more is not listed or accepted after a refresh", { timeout: 60000 }, async () => {
  const out = await configChild(await fixedFile(".", { cli: "claude", model: "fable.5", effort: "ultra" }, "fable-5"), `
    config.adoptSavedValues(config.readWorkspaces());
    const snapshot = () => ({ listed: config.MODEL_OPTIONS.claude.slice(), efforts: config.EFFORT_OPTIONS.claude.slice(), info: config.CLAUDE_MODEL_INFO.map((m) => m.value), fableOk: config.isValidModel("claude", "fable.5"), advisorOk: config.isValidModel("claude", "fable-5"), ultraOk: config.isValidEffort("claude", "ultra") });
    out.start = snapshot();
    // The coder seat moves to sonnet/high through a real workspace write; the advisor still uses fable-5.
    config.writeWorkspaces(make({ model: "sonnet", effort: "high" }, "fable-5"));
    out.afterWrite = snapshot();
    await config.refreshDiscovery(async () => ({ values: ["low", "medium", "high"], fallback: false }), async (f) => ({ values: [...f], fallback: true }), async () => ({ fallback: false, values: JSON.parse(${JSON.stringify(DISCOVERED_CLAUDE([]))}) }));
    out.afterRefresh = snapshot();
    config.writeWorkspaces(make({ model: "sonnet", effort: "high" }));
    out.afterAdvisorGone = snapshot();
    await config.refreshDiscovery(async () => ({ values: ["low", "medium", "high"], fallback: false }), async (f) => ({ values: [...f], fallback: true }), async () => ({ fallback: false, values: JSON.parse(${JSON.stringify(DISCOVERED_CLAUDE([]))}) }));
    out.afterSecondRefresh = snapshot();
  `);
  assert.ok(out.start.listed.includes("fable.5") && out.start.listed.includes("fable-5") && out.start.efforts.includes("ultra"), "control: adopted at boot");
  assert.ok(!out.afterWrite.listed.includes("fable.5") && !out.afterWrite.fableOk && !out.afterWrite.efforts.includes("ultra") && !out.afterWrite.ultraOk, "unused by the written workspace: gone at once");
  assert.ok(out.afterWrite.advisorOk && out.afterWrite.listed.includes("fable-5"), "a still-used value stays");
  for (const key of ["afterRefresh"]) {
    assert.ok(!out[key].listed.includes("fable.5") && !out[key].info.includes("fable.5") && !out[key].fableOk && !out[key].efforts.includes("ultra"), `${key}: a refresh does not bring the unused value back`);
    assert.ok(out[key].advisorOk && out[key].info.includes("fable-5"), `${key}: the still-used value survives the refresh`);
  }
  for (const key of ["afterAdvisorGone", "afterSecondRefresh"]) assert.ok(!out[key].listed.includes("fable-5") && !out[key].advisorOk, `${key}: the advisor's value is gone once the advisor stops using it`);
});

test("saved values: through the real server, a value whose last use is removed is no longer listed or accepted for user input (a still-used one stays)", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable", workerModel: "fable.5", workerEffort: "ultra" }, async (h) => {
    assert.ok(h.state().modelOptions.claude.includes("fable.5") && h.state().effortOptions.claude.includes("ultra"), "control: adopted at boot");
    await h.refresh();
    const moved = await h.assign(WORKER.slotId, { cli: "claude", model: "sonnet", effort: "high" });
    assert.equal(moved.type, "actionResult");
    await h.wait(() => !h.state().modelOptions.claude.includes("fable.5") && !h.state().effortOptions.claude.includes("ultra"), "unused values unlisted");
    assert.ok(h.state().modelOptions.claude.includes("fable"), "the advisor's value stays");
    const again = await h.assign(READER.slotId, { cli: "claude", model: "fable.5", effort: READER.effort });
    assert.equal(again.type, "error", "no longer accepted for user input");
    const removed = await h.assign(LEADER.slotId, CLAUDE_LEADER);
    assert.equal(removed.type, "actionResult", "the advisor is dropped by saving the leader without one");
    await h.wait(() => !h.seat(LEADER.slotId).advisor && !h.state().modelOptions.claude.includes("fable"), "advisor removed, its value unlisted");
  });
});

// ---- the advisor ----

test("advisor: buildLeaderOptions passes --advisor only with the native CLI and a chosen advisor", () => {
  const seat = { model: "claude-opus-5-5[1m]", effort: "high", advisor: "claude-fable-5-1[1m]" };
  assert.deepEqual(buildLeaderOptions(seat, ".", "C:/x/claude.exe").extraArgs, { effort: "high", advisor: "claude-fable-5-1[1m]", "replay-user-messages": null });
  assert.deepEqual(buildLeaderOptions({ ...seat, advisor: undefined }, ".", "C:/x/claude.exe").extraArgs, { effort: "high", "replay-user-messages": null });
  assert.equal(buildLeaderOptions(seat, ".", null).extraArgs, undefined, "no native CLI, no extra args at all");
});

test("advisor: the leader seat's saved advisor reaches the Claude leader's CLI args when its session starts", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, env: { CC_TEST_FAKE_LEADER: "1", CLAUDE_CLI_PATH: process.execPath } }, async (h) => {
    let start = h.chat(script({ tool: "Read", input: { file_path: "x" } }));
    await h.wait(() => h.turnEnded(start).length === 1, "first turn"); await h.idle();
    assert.deepEqual(h.ipc.find((m) => m.type === "queryStarted").extraArgs, { effort: LEADER.effort, "replay-user-messages": null }, "no advisor yet");
    // A changed advisor applies when the next session starts: end this one, then chat.
    // The saved change does not touch the idle session; the next message sees the new fixed signature and starts a fresh one.
    await h.refresh();
    assert.equal((await h.assign(LEADER.slotId, { ...CLAUDE_LEADER, advisor: "claude-fable-5-1[1m]" })).type, "actionResult");
    assert.equal(h.seat(LEADER.slotId).advisor, "claude-fable-5-1[1m]");
    const before = h.ipc.filter((m) => m.type === "queryStarted").length;
    start = h.chat(script({ tool: "Read", input: { file_path: "x" } }));
    await h.wait(() => h.ipc.filter((m) => m.type === "queryStarted").length > before, "new session");
    assert.deepEqual(h.ipc.filter((m) => m.type === "queryStarted").at(-1).extraArgs, { effort: LEADER.effort, advisor: "claude-fable-5-1[1m]", "replay-user-messages": null });
  });
});

// ---- other seats ----

test("a non-leader read-only seat can be assigned another CLI, and the saved choice is kept", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    assert.equal((await h.assign(READER.slotId, { cli: "opencode", model: "opencode/glm-5.2", effort: "max" })).type, "actionResult");
    assert.deepEqual([h.seat(READER.slotId).model, h.seat(READER.slotId).effort], ["opencode/glm-5.2", "max"]);
    assert.deepEqual(h.savedSeat(READER.slotId), { cli: "opencode", model: "opencode/glm-5.2", effort: "max" });
  });
});

test("the state the client receives carries the OpenCode catalogue, including a saved seat model discovery did not return", { timeout: 60000 }, async () => {
  await withServer({ leader: { cli: "opencode", model: "savedprov/saved-model", effort: "max" }, installed: ["opencode"] }, async (h) => {
    const models = h.state().opencodeModels;
    assert.ok(Array.isArray(models) && models.includes("savedprov/saved-model"), `client state opencodeModels=${JSON.stringify(models)}`);
  });
});
