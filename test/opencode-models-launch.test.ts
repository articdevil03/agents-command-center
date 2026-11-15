import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { modelOutput, noVendor, ownedTemp } from "./opencode-models.setup.ts";
import { config, runner, FakeProc, makeRun, captureCallbacks } from "./runner-helpers.ts";

test("empty effort persists, worker command omits variant, literal none and tagged ids reach the worker", async (t) => {
  noVendor(t);
  const root = ownedTemp(t), file = join(root, "workspaces.json");
  const { parseOpenCodeModelInfo } = await import("../server/settings/opencode/models.ts");
  config.applyOpenCodeModels(parseOpenCodeModelInfo(modelOutput("provider/model:tag", ["none"])), {});
  const { createFixedCrewService } = await import("../server/main/fixed-crew.ts");
  let workspace = config.defaultWorkspaces(root);
  const service = createFixedCrewService({ workspace: () => workspace, selectedTabId: () => "example-development",
    catalogue: () => ({ clis: [{ id: "opencode", installed: true, models: null, efforts: [], advisor: false }], opencodeModelInfo: config.OPENCODE_MODEL_INFO }),
    seatBusy: () => false, leaderActive: () => false, writeWorkspace: (draft) => config.writeWorkspaces(draft, file),
    setWorkspace: (draft) => { workspace = draft; }, announce() {} });
  for (const effort of ["", "none"]) {
    const assignment = { cli: "opencode" as const, model: "provider/model:tag", effort };
    assert.doesNotThrow(() => service.change("example-development", "setCrewAssignment", "coder", assignment), "default and literal none are valid stored assignments");
    const saved = config.readWorkspaces(file).projects[0].tabs[0].fixedCrew!.preferences.coder.assignment!;
    assert.deepEqual(saved, assignment);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).projects[0].tabs[0].fixedCrew.preferences.coder.assignment.effort, effort);
    const proc = new FakeProc(), calls: any[] = [], capture = captureCallbacks();
    const result = runner.runSeat(makeRun({ ...saved, runId: "w8-launch-" + (effort || "default"), folder: root }), "synthetic brief", capture.callbacks,
      ((command: string, options: any) => { calls.push({ command, options }); return proc; }) as any);
    try {
      assert.equal(result.ok, true, JSON.stringify(capture)); assert.equal(calls.length, 1);
      assert.match(calls[0].command, /-m provider\/model:tag/);
      if (effort === "") assert.doesNotMatch(calls[0].command, /--variant/);
      else assert.match(calls[0].command, /--variant none/);
    } finally { proc.emit("close", 0); }
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
    const seat: any = { model: "provider/model:tag", effort: "" };
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
    assert.deepEqual(bodies[0].model, { providerID: "provider", modelID: "model:tag" });
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

