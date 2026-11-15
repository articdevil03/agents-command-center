import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SettingsService } from "../server/settings/service.ts";
import { OpenCodeModelRefresh, type OpenCodeModelInfo } from "../server/settings/opencode/models.ts";
import { modelOutput, noVendor, ownedTemp, deferred } from "./opencode-models.setup.ts";
import { installFixture, ok } from "./pack29-opencode-install.setup.ts";
import type { CliResult } from "../server/settings/types.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

test("coalesces refresh, rejects an older generation, retains the last good catalogue and drains pending discovery", async (t) => {
  noVendor(t);
  const first = deferred<CliResult>(), second = deferred<CliResult>();
  let calls = 0, models: OpenCodeModelInfo[] = [], status: any = {};
  const busyStates: boolean[] = [];
  const refresh = new OpenCodeModelRefresh(() => ++calls === 1 ? first.promise : second.promise,
    (items, state) => { if (items) models = items; Object.assign(status, state); if (state.refreshing) busyStates.push(refresh.busy); });
  const old = refresh.refresh();
  const concurrent = Array.from({ length: 8 }, () => refresh.refresh());
  const samePromise = concurrent.every((work) => work === old);
  await Promise.resolve();
  const coalescedCalls = calls;
  const newer = refresh.refresh(true);
  await Promise.resolve();
  const freshCalls = calls;
  second.resolve(ok(modelOutput("new/model", []))); await newer;
  assert.equal(models[0].value, "new/model");
  first.resolve(ok(modelOutput("old/model", ["max"]))); await old;
  const catalogues = await Promise.all(concurrent.map(async (work) => { await work; return models; }));
  assert.equal(samePromise, true, "all concurrent refresh callers share the same catalogue promise");
  assert.equal(coalescedCalls, 1, "eight concurrent refresh callers launch exactly one discovery");
  assert.equal(freshCalls, 2, "forced refresh launches a new discovery");
  assert.ok(catalogues.every((catalogue) => catalogue === models));
  assert.equal(models[0].value, "new/model", "older result cannot overwrite newer generation");
  assert.equal(calls, 2);
  assert.deepEqual(busyStates, [true, true], "discovery is tracked before publishing its start");
  const third = refresh.refresh(); await third;
  assert.equal(models[0].value, "new/model");
  await refresh.drain(); assert.equal(refresh.busy, false);
  await refresh.refresh(); assert.equal(calls, 3, "closed discovery cannot launch");
});

test("fresh failure invents no models, failed refresh retains last success, drain waits for an in-flight probe", async (t) => {
  noVendor(t);
  const pending = deferred<CliResult>();
  let catalogue: OpenCodeModelInfo[] = [], status: any = {}, calls = 0;
  const refresh = new OpenCodeModelRefresh(async () => {
    calls++;
    if (calls === 1 || calls === 3) throw new Error("missing CLI");
    return calls === 2 ? ok(modelOutput()) : pending.promise;
  }, (items, state) => { if (items) catalogue = items; Object.assign(status, state); });
  await refresh.refresh(); assert.deepEqual(catalogue, []); assert.equal(status.stale, false); assert.ok(status.error);
  await refresh.refresh(); assert.equal(catalogue.length, 1); assert.equal(status.error, null);
  await refresh.refresh(); assert.equal(catalogue.length, 1); assert.equal(status.stale, true);
  const work = refresh.refresh(); let drained = false;
  const drain = refresh.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); assert.equal(refresh.busy, true);
  pending.resolve(ok(modelOutput())); await work; await drain; assert.equal(refresh.busy, false);
});

test("boot/Check again and picker refresh use the same service catalogue; successful key save forces fresh discovery", async (t) => {
  noVendor(t);
  const root = ownedTemp(t), calls: string[][] = [], publications: any[] = [];
  let output = modelOutput("before/model", []);
  const service = new SettingsService({ dataRoot: join(root, "data"), env: { HOME: root, USERPROFILE: root, PATH: "" },
    refreshPath: async () => {}, runKey: async () => ({ saved: true, cleanupConfirmed: true }),
    runCli: async (bin, args) => { calls.push([bin, ...args]); return ok(args[0] === "models" ? output : args[0] === "auth" ? "0 credentials" : "1.19.5"); },
    onOpenCodeModels: (models, state) => publications.push({ models, state }) });
  await service.refreshAll(null); // same entry point as boot and Check again
  await service.refreshAll(null);
  await service.models.refresh(); // picker message delegates here
  assert.equal(calls.filter((args) => args.join(" ") === "opencode models --verbose").length, 3);
  Object.assign(service.state.catalogTools.opencode, { installed: true, supportedVersion: true, credentialSource: "none" });
  const events: any[] = [];
  const login = service.cliLogin({ type: "cliLogin", cli: "opencode", requestId: "start" }, (event) => events.push(event));
  assert.equal(events.at(-1).phase, "waitingKey");
  output = modelOutput("after/model", ["max"]);
  await service.cliLogin({ type: "submitCliLoginKey", cli: "opencode", requestId: "key", loginId: events.at(-1).loginId,
    apiKey: "synthetic-test-key" }, () => {});
  await login;
  assert.equal(calls.filter((args) => args.join(" ") === "opencode models --verbose").length, 4, "key save refreshes models");
  assert.equal(publications.filter((item) => item.models).at(-1).models[0].value, "after/model");
  assert.equal(service.state.tools.opencode.credentialSource, "stored");
  assert.equal(service.state.catalogTools.opencode.action?.status, "done");
  await service.models.drain(); await service.login.drain(); await service.installer.drain();
});

test("successful managed install refreshes models and discovery failure cannot roll it back", async (t) => {
  let fixture: Awaited<ReturnType<typeof installFixture>>;
  let versions = 0, discoveries = 0;
  fixture = await installFixture(t, { run: async (bin, args) => {
    if (args[0] === "models") { discoveries++; throw new Error("discovery failed"); }
    if (bin === "opencode" && args[0] === "--version") return versions++ === 0 ? ok("", { code: 127 }) : ok();
    return ok(args[0] === "auth" ? "0 credentials" : "1.19.5");
  } });
  try {
    await fixture.service.installCli(fixture.request);
    assert.equal(discoveries, 1);
    assert.equal(fixture.service.state.catalogTools.opencode.action?.status, "done");
    assert.equal(fixture.service.state.tools.opencode.installed, true);
  } finally { await fixture.service.models.drain(); await fixture.close(); }
});

test("a rejected discovery coordinator cannot undo a completed install or key save", async (t) => {
  let versions = 0;
  const fixture = await installFixture(t, { run: async (bin, args) => {
    if (bin === "opencode" && args[0] === "--version") return versions++ === 0 ? ok("", { code: 127 }) : ok();
    return ok(args[0] === "auth" ? "0 credentials" : "1.19.5");
  } });
  let refreshes = 0;
  fixture.service.models.refresh = async () => { refreshes++; throw new Error("synthetic coordinator rejection"); };
  try {
    await assert.doesNotReject(fixture.service.installCli(fixture.request), "discovery rejection must not fail installation");
    assert.equal(refreshes, 1); assert.equal(fixture.service.state.catalogTools.opencode.action?.status, "done");
    assert.equal(fixture.service.state.catalogTools.opencode.installed, true);
  } finally { await fixture.close(); }
  noVendor(t);
  const root = ownedTemp(t), events: any[] = [];
  const service = new SettingsService({ dataRoot: join(root, "data"), env: { HOME: root, USERPROFILE: root, PATH: "" },
    refreshPath: async () => {}, runKey: async () => ({ saved: true, cleanupConfirmed: true }),
    runCli: async (_bin, args) => ok(args[0] === "auth" ? "0 credentials" : "1.19.5") });
  service.models.refresh = async () => { refreshes++; throw new Error("synthetic coordinator rejection"); };
  Object.assign(service.state.catalogTools.opencode, { installed: true, supportedVersion: true, credentialSource: "none" });
  const login = service.cliLogin({ type: "cliLogin", cli: "opencode", requestId: "start" }, (event) => events.push(event));
  try {
    await assert.doesNotReject(service.cliLogin({ type: "submitCliLoginKey", cli: "opencode", requestId: "key", loginId: events.at(-1).loginId, apiKey: "synthetic-key" }, () => {}), "discovery rejection must not fail key saving");
    await login;
    assert.equal(refreshes, 2); assert.equal(service.state.catalogTools.opencode.action?.status, "done");
    assert.equal(service.state.catalogTools.opencode.credentialSource, "stored");
  } finally { await service.models.drain(); await service.login.drain(); await service.installer.drain(); }
});

test("worker default omits --variant and per-model validation keeps none distinct", async (t) => {
  noVendor(t);
  const root = ownedTemp(t), previous = process.env.CC_DATA_DIR, packaged = process.env.CC_TEST_FORCE_PACKAGED;
  process.env.CC_DATA_DIR = root; process.env.CC_TEST_FORCE_PACKAGED = "1";
  try {
    const config = await import("../server/config.ts"), { buildCommand } = await import("../server/runner.ts");
    const { parseOpenCodeModelInfo } = await import("../server/settings/opencode/models.ts");
    config.applyOpenCodeModels(parseOpenCodeModelInfo(modelOutput()), {});
    const run = { runId: "test", seatKey: "tab.coder", slotId: "coder", name: "Coder", cli: "opencode" as const,
      model: "provider/model", effort: "", folder: root, canWrite: true, startedAt: 1 };
    assert.doesNotMatch(buildCommand(run, join(root, "brief.txt")), /--variant/);
    assert.match(buildCommand({ ...run, effort: "none" }, join(root, "brief.txt")), /--variant none/);
    assert.throws(() => buildCommand({ ...run, model: "different/model", effort: "thinking" }, "brief.txt"), /invalid effort/);
    config.applyOpenCodeModels(parseOpenCodeModelInfo(modelOutput("opencode/gpt-future", [])), {});
    assert.ok(config.MODEL_OPTIONS.codex?.includes("gpt-future"), "live discovery preserves Codex catalogue enrichment");
    await config.refreshDiscovery(async (values) => ({ values: [...values], fallback: true }),
      async () => ({ values: [], fallback: true }), async (values) => ({ values: [...values], fallback: true }));
    assert.ok(config.MODEL_OPTIONS.codex?.includes("gpt-future"), "later Claude discovery cannot undo the newer OpenCode catalogue");
  } finally {
    if (previous === undefined) delete process.env.CC_DATA_DIR; else process.env.CC_DATA_DIR = previous;
    if (packaged === undefined) delete process.env.CC_TEST_FORCE_PACKAGED; else process.env.CC_TEST_FORCE_PACKAGED = packaged;
  }
});

test("leader HTTP prompt omits variant for default and preserves literal none", async (t) => {
  noVendor(t);
  const root = ownedTemp(t), previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CC_DATA_DIR: process.env.CC_DATA_DIR, CC_TEST_FORCE_PACKAGED: process.env.CC_TEST_FORCE_PACKAGED };
  Object.assign(process.env, { HOME: root, USERPROFILE: root, CC_DATA_DIR: root, CC_TEST_FORCE_PACKAGED: "1" });
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined, closed = false;
  const bodies: any[] = [];
  const fetched = t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.equal(new URL(String(url)).hostname, "127.0.0.1");
    const route = new URL(String(url)).pathname;
    if (route === "/global/health") return Response.json({ healthy: true });
    if (route === "/mcp") return Response.json({ "tab-crew": { status: "connected" } });
    if (route === "/session") return Response.json({ id: "ses_default" });
    if (route === "/event") {
      const body = new ReadableStream({ start(controller) { stream = controller; } });
      init.signal.addEventListener("abort", () => { if (!closed) { closed = true; stream?.close(); } }, { once: true });
      return new Response(body);
    }
    if (route.endsWith("/prompt_async")) { bodies.push(JSON.parse(init.body)); return Response.json(null); }
    if (route.endsWith("/abort")) return Response.json(true);
    assert.fail(`unexpected fake route ${route}`);
  });
  const child: any = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); return true; };
  let leader: any;
  try {
    const { createOpencodeLeader } = await import("../server/leader-opencode.ts");
    const seat: any = { model: "provider/model", effort: "" };
    leader = createOpencodeLeader(seat, root, { onDelta() {}, onDone() {}, onError(message) { assert.fail(message); } } as any,
      { mode: "ask", bridge: { url: "http://127.0.0.1:1", token: "synthetic" }, ask: async () => false,
        pickPort: async () => 12345, spawnFn: (() => child) as any });
    leader.send("default");
    const until = async (count: number) => {
      const end = Date.now() + 2000;
      while (bodies.length < count && Date.now() < end) await new Promise((done) => setTimeout(done, 5));
      assert.equal(bodies.length, count, "actual HTTP boundary received prompt");
    };
    await until(1); assert.equal(Object.hasOwn(bodies[0], "variant"), false);
    seat.effort = "none"; leader.send("literal none");
    await until(2); assert.equal(bodies[1].variant, "none");
  } finally {
    leader?.stop(); await new Promise((done) => setTimeout(done, 250)); child.kill();
    if (!closed) { closed = true; stream?.close(); }
    fetched.mock.restore();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(child.exitCode, 0);
  }
});

test("real refresh message broadcasts metadata and fake OpenCode server receives a default prompt without variant", { timeout: 60_000 }, async () => {
  const { withServer, LEADER } = await import("./any-cli-helpers.ts");
  await withServer({ leader: { cli: "opencode", model: "fakeprov/fake-model", effort: "" }, installed: ["opencode"] }, async (h) => {
    assert.deepEqual(h.state().opencodeModelInfo, []);
    const reply = await h.action({ type: "refreshOpenCodeModels" });
    assert.equal(reply.type, "actionResult");
    await h.wait(() => h.state().opencodeModelInfo.length === 2, "metadata broadcast after picker refresh");
    await h.wait(() => !h.state().globalWork.includes("models are being refreshed"), "refresh releases background-work state");
    const info = h.state().opencodeModelInfo.find((item: any) => item.value === "fakeprov/fake-model");
    assert.deepEqual(info.variants, ["max", "high"]);
    assert.deepEqual(h.state().effortOptions.opencode, []);
    const beforeCheck = h.messages.length;
    await h.refresh();
    assert.ok(h.messages.slice(beforeCheck).some((m: any) => m.type === "state" && m.discoveryInfo?.opencodeModels?.refreshing === true), "Check again starts discovery through the real handler");
    assert.equal(h.seat(LEADER.slotId).effort, "");
    const start = h.chat("default effort");
    await h.wait(() => h.turnEnded(start).length === 1, "default prompt completed");
    const prompt = h.cliEntries().find((entry) => entry.path?.endsWith("/prompt_async"));
    assert.ok(prompt); assert.equal(Object.hasOwn(prompt.body, "variant"), false);
  });
});
