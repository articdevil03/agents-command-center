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
import { config, readWorkspaces, buildLeaderOptions, SEATS, LEADER, WORKER, READER, TAB, OPENCODE_LEADER, CLAUDE_LEADER, exitWithin, boot, withServer, script, bridgePost } from "./any-cli-helpers.ts";

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
    assert.deepEqual(list.map((t: any) => t.name).sort(), ["get_crew_status", "launch_seat", "list_requests", "send_request"]);
    const status = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "get_crew_status", arguments: {} }))).body).result;
    assert.equal(JSON.parse(status.content[0].text).tab, TAB); assert.equal(status.isError, undefined);
    const bad = JSON.parse((await bridgePost(h.port, path, good, rpc("tools/call", { name: "launch_seat", arguments: { slot: 1 } }))).body).result;
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
    assert.equal(saved.advisor.model, "fable", "his saved value is not rewritten: the file keeps its old shape until the next write");
  });
});

test("saved models: a malformed Claude model or advisor is still refused at load", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-savedmodel-"));
  try {
    const path = join(dir, "workspaces.json");
    const write = (model: string, advisor?: string) => writeFileSync(path, JSON.stringify({ projects: [{ id: "p", name: "P", folder: dir, tabs: [{ id: "p-dev", name: "Dev", kind: "dev", process: "main", folder: dir, ...(advisor !== undefined ? { advisor: { model: advisor } } : {}), crew: SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat === WORKER ? model : seat.model, effort: seat.effort })) }] }] }));
    // Was: ... "not-a-claude-model" ... refused at load. It is safe in shape, so round 8 loads it (the live list judges it only when a user picks it).
    for (const bad of ["../x", "a".repeat(200), "fa ble", 'fa"ble', "fa;ble", "fa&ble", "fa|ble", "fa\u0001ble", "fa\nble", "-flag", "a/../b", ""]) {
      write(bad);
      assert.throws(() => readWorkspaces(path), /invalid slot\/model\/effort/, `seat model ${JSON.stringify(bad.slice(0, 20))}`);
      write("sonnet", bad);
      assert.throws(() => readWorkspaces(path), /invalid advisor/, `advisor ${JSON.stringify(bad.slice(0, 20))}`);
    }
    write("fable", "claude-opus-6-0"); readWorkspaces(path);
    write("not-a-claude-model", "not-a-claude-model"); readWorkspaces(path);
  } finally { removeWithRetry(dir); }
});

test("saved models: an advisor chosen in the app still refuses an unknown model", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable" }, async (h) => {
    const start = h.messages.length;
    h.send({ type: "updateSeat", tabId: TAB, slot: LEADER.slotId, advisor: "nope" });
    const error = await h.wait(() => h.messages.slice(start).find((m) => m.type === "error"), "the advisor is refused");
    assert.match(error.message, /invalid advisor/);
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
      const answer = await h.update({ slot: READER.slotId, model: saved }, () => h.seat(READER.slotId).model === saved);
      assert.notEqual(answer.type, "error", "the live list accepts a saved value for another seat");
      const renamed = await h.update({ slot: WORKER.slotId, name: "Renamed" }, () => h.seat(WORKER.slotId).name === "Renamed");
      assert.notEqual(renamed.type, "error", "a later save of another field works");
      assert.equal(h.savedCrew().find((s) => s.slot === WORKER.slotId).model, saved, "his value is not rewritten");
      assert.equal(JSON.parse(readFileSync(join(h.temp, "data", "config", "workspaces.json"), "utf8")).projects[0].tabs[0].crew.find((seat: any) => seat.slot === LEADER.slotId).advisor, saved);
    });
  });
}

test("saved models: a saved discovered effort (ultra) starts the server, is listed, and later saves still work", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, workerEffort: "ultra" }, async (h) => {
    assert.equal(h.seat(WORKER.slotId).effort, "ultra");
    assert.ok(h.state().effortOptions.claude.includes("ultra"), "listed in effortOptions");
    const renamed = await h.update({ slot: WORKER.slotId, name: "Renamed" }, () => h.seat(WORKER.slotId).name === "Renamed");
    assert.notEqual(renamed.type, "error");
    assert.equal(h.savedCrew().find((s) => s.slot === WORKER.slotId).effort, "ultra");
  });
});

test("saved models: updateSeat still refuses a model, an effort or an advisor that is not in the live list", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, advisor: "fable", workerModel: "fable", workerEffort: "ultra" }, async (h) => {
    for (const payload of [{ model: "nope" }, { model: "fable.7" }, { effort: "turbo" }, { effort: "ul tra" }, { model: "../x" }]) {
      const answer = await h.update({ slot: WORKER.slotId, ...payload });
      assert.equal(answer.type, "error", JSON.stringify(payload));
    }
    const start = h.messages.length;
    h.send({ type: "updateSeat", tabId: TAB, slot: LEADER.slotId, advisor: "fable.7" });
    assert.match((await h.wait(() => h.messages.slice(start).find((m) => m.type === "error"), "the advisor is refused")).message, /invalid advisor/);
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
    const crew = SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat === WORKER ? "fable.5" : seat.model, effort: seat === WORKER ? "ultra" : seat.isLeader ? "xhigh" : seat.effort }));
    writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify({ projects: [{ id: "p", name: "P", folder: work, tabs: [{ id: "p-dev", name: "Dev", kind: "dev", process: "main", folder: work, crew, advisor: { model: "fable-5" } }] }] }));
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
// and `make(patch, advisor)` which returns that workspace with the coder seat / advisor changed.
async function configChild(workspace: object | null, body: string): Promise<any> {
  const temp = mkdtempSync(join(tmpdir(), "cc-configchild-"));
  try {
    const data = join(temp, "data"), work = join(temp, "work"), home = join(temp, "home");
    for (const dir of [join(data, "config"), work, home]) mkdirSync(dir, { recursive: true });
    if (workspace) writeFileSync(join(data, "config", "workspaces.json"), JSON.stringify(workspace));
    const script = join(temp, "child.mjs");
    const crew = SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort }));
    writeFileSync(script, `
      import { join } from "node:path";
      const config = await import(${JSON.stringify(pathToFileURL(resolve("server/config.ts")).href)});
      const out = {};
      const tmpPath = join(${JSON.stringify(temp)}, "scratch-workspaces.json");
      const process_ = await import(${JSON.stringify(pathToFileURL(resolve("server/process.ts")).href)});
      const make = (patch, advisor) => { const base = process_.legacySetup("dev", "main"); return { projects: [{ id: "p", name: "P", folder: ${JSON.stringify(work)}, tabs: [{ id: "p-dev", name: "Dev", kind: "dev", folder: ${JSON.stringify(work)}, setupName: base.name, steps: base.steps, crew: base.crew.map((s) => s.slot === ${JSON.stringify(WORKER.slotId)} ? { ...s, ...patch } : s.isLeader && advisor ? { ...s, advisor } : s) }] }] }; };
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
  assert.ok(out.writes.every((w: string) => /^THROWS .*invalid slot\/model\/effort/.test(w)), `writes ${out.writes}`);
  assert.match(out.advisorWrite, /^THROWS .*invalid advisor/);
  assert.equal(out.fileWritten, false, "nothing was written for any refused value");
  const unsafe = ["has space", "a".repeat(101), "-flag", "a/../b", "bad eff", "-x", "-vendor/model", "vendor/../model", "gpt-bad one", "opencode/gpt-bad one"];
  for (const list of [out.claudeListed, out.claudeInfo, out.claudeEfforts, out.opencode, out.codex]) for (const bad of unsafe) assert.ok(!list.includes(bad), `${JSON.stringify(bad.slice(0, 20))} must not be offered`);
  assert.ok(out.claudeListed.includes("claude-x[1m]") && out.claudeEfforts.includes("high") && out.opencode.includes("okprov/ok-model") && out.codex.includes("gpt-fine"), "control: the safe discovered values are offered");
  assert.deepEqual(out.trips, [], "every offered value saves and loads");
});

test("saved values: the saved sets follow the current workspace, so a value nobody uses any more is not listed or accepted after a refresh", { timeout: 60000 }, async () => {
  const seed = (model: string, effort: string, advisor?: string) => ({ projects: [{ id: "p", name: "P", folder: ".", tabs: [{ id: "p-dev", name: "Dev", kind: "dev", process: "main", folder: ".", ...(advisor ? { advisor: { model: advisor } } : {}), crew: SEATS.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat === WORKER ? model : seat.model, effort: seat === WORKER ? effort : seat.effort })) }] }] });
  const out = await configChild(seed("fable.5", "ultra", "fable-5"), `
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
    const moved = await h.update({ slot: WORKER.slotId, model: "sonnet", effort: "high" }, () => h.seat(WORKER.slotId).model === "sonnet" && h.seat(WORKER.slotId).effort === "high");
    assert.notEqual(moved.type, "error");
    await h.wait(() => !h.state().modelOptions.claude.includes("fable.5") && !h.state().effortOptions.claude.includes("ultra"), "unused values unlisted");
    assert.ok(h.state().modelOptions.claude.includes("fable"), "the advisor's value stays");
    const again = await h.update({ slot: READER.slotId, model: "fable.5" });
    assert.equal(again.type, "error", "no longer accepted for user input");
    const start = h.messages.length;
    h.send({ type: "updateSeat", tabId: TAB, slot: LEADER.slotId, advisor: null });
    await h.wait(() => !h.seat(LEADER.slotId).advisor && !h.state().modelOptions.claude.includes("fable"), "advisor removed, its value unlisted");
    assert.equal(h.messages.slice(start).some((m) => m.type === "error"), false);
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
    h.send({ type: "updateSeat", tabId: TAB, slot: LEADER.slotId, advisor: "claude-fable-5-1[1m]" });
    await h.wait(() => h.seat(LEADER.slotId).advisor === "claude-fable-5-1[1m]", "advisor saved");
    h.send({ type: "stopSeat", tabId: TAB, slot: LEADER.slotId });
    await h.wait(() => h.tab().leaderStatus === "not-started", "session ended");
    const before = h.ipc.filter((m) => m.type === "queryStarted").length;
    start = h.chat(script({ tool: "Read", input: { file_path: "x" } }));
    await h.wait(() => h.ipc.filter((m) => m.type === "queryStarted").length > before, "new session");
    assert.deepEqual(h.ipc.filter((m) => m.type === "queryStarted").at(-1).extraArgs, { effort: LEADER.effort, advisor: "claude-fable-5-1[1m]", "replay-user-messages": null });
  });
});

// ---- other seats ----

test("a non-leader read-only seat can also change CLI (the worker setup is per run)", { timeout: 60000 }, async () => {
  await withServer({ leader: CLAUDE_LEADER, installed: ["opencode"] }, async (h) => {
    await h.refresh();
    await h.update({ slot: READER.slotId, cli: "opencode", model: "opencode/glm-5.2" }, () => h.seat(READER.slotId).cli === "opencode");
    assert.deepEqual([h.seat(READER.slotId).model, h.seat(READER.slotId).effort], ["opencode/glm-5.2", "max"]);
    // A restart reads the saved seat back: a CLI that differs from the slot default is valid.
    assert.equal(h.savedCrew().find((s) => s.slot === READER.slotId).cli, "opencode");
  });
});

test("the state the client receives carries the OpenCode catalogue, including a saved seat model discovery did not return", { timeout: 60000 }, async () => {
  await withServer({ leader: { cli: "opencode", model: "savedprov/saved-model", effort: "max" }, installed: ["opencode"] }, async (h) => {
    const models = h.state().opencodeModels;
    assert.ok(Array.isArray(models) && models.includes("savedprov/saved-model"), `client state opencodeModels=${JSON.stringify(models)}`);
  });
});
