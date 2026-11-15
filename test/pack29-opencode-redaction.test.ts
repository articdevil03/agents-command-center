import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./pack29-cli-install.setup.ts";
import { importWithTempDataRoot, setEnv } from "./temp-root.ts";
import { goCredentialSecrets } from "../server/settings/opencode/credentials.ts";
import { until } from "./pack29-cli-login.setup.ts";
const { modules: { createOpencodeLeader } } = await importWithTempDataRoot(() => import("../server/leader-opencode.ts"));
const key = 'synthetic-saved-go-"\\-key-' + "q".repeat(130);

test("private reader uses only synthetic Go credential and honors isolated profile and XDG paths", () => {
  const fx = fixture();
  try {
    const base = join(fx.root, "xdg"); mkdirSync(base); mkdirSync(join(base, "opencode"));
    const file = join(base, "opencode", "auth.json"), bytes = JSON.stringify({ "opencode-go": { type: "api", key }, unrelated: { type: "api", key: "other-provider" } });
    writeFileSync(file, bytes);
    assert.deepEqual(goCredentialSecrets({ ...fx.env, XDG_DATA_HOME: base }), [key, JSON.stringify(key).slice(1, -1)]);
    assert.deepEqual(goCredentialSecrets({}), []);
    assert.deepEqual(goCredentialSecrets({ XDG_DATA_HOME: "relative" }), []);
    assert.deepEqual(goCredentialSecrets({ ...fx.env, OPENCODE_AUTH_CONTENT: "{}" }), []);
    assert.equal(readFileSync(file, "utf8"), bytes, "credential store is never written");
    writeFileSync(file, "{invalid");
    assert.deepEqual(goCredentialSecrets({ ...fx.env, XDG_DATA_HOME: base }), []);
  } finally { fx.close(); }
});

for (const failure of [false, true]) {
  test("actual leader redacts saved synthetic key " + (failure ? "from errors" : "across stream parts"), async (t) => {
    const fx = fixture(), xdg = join(fx.root, "xdg");
    mkdirSync(xdg); mkdirSync(join(xdg, "opencode"));
    const file = join(xdg, "opencode", "auth.json"), bytes = JSON.stringify({ "opencode-go": { type: "api", key } });
    writeFileSync(file, bytes);
    const restore = setEnv({ USERPROFILE: fx.root, HOME: fx.root, XDG_DATA_HOME: xdg, OPENCODE_AUTH_CONTENT: undefined });
    const deltas: string[] = [], errors: string[] = [], calls: string[] = [];
    let stream!: ReadableStreamDefaultController<Uint8Array>, child: any, leader: any, ended = false;
    const event = (type: string, properties: any) => stream.enqueue(Buffer.from("data: " + JSON.stringify({ type, properties }) + "\n\n"));
    const fetchSpy = t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
      const route = new URL(String(url)).pathname; calls.push(route);
      if (route === "/global/health") return Response.json({ healthy: true });
      if (route === "/mcp") return Response.json({ "tab-crew": { status: "connected" } });
      if (route === "/session") return Response.json({ id: "ses_redact" });
      if (route === "/event") {
        const body = new ReadableStream({ start(controller) { stream = controller; } });
        init.signal.addEventListener("abort", () => { if (!ended) { ended = true; stream.close(); } }, { once: true });
        return new Response(body);
      }
      if (route.endsWith("/prompt_async")) {
        if (failure) return Response.json({ data: { message: key + " " + JSON.stringify(key).slice(1, -1) } }, { status: 500 });
        event("message.updated", { sessionID: "ses_redact", info: { id: "msg_a", role: "assistant" } });
        for (const [id, text] of [["part_a", key.slice(0, 75)], ["part_b", key.slice(75) + " safe"]]) {
          event("message.part.updated", { sessionID: "ses_redact", part: { id, type: "text", messageID: "msg_a" } });
          event("message.part.delta", { sessionID: "ses_redact", partID: id, messageID: "msg_a", field: "text", delta: text });
        }
        return Response.json(null);
      }
      if (route.endsWith("/abort")) return Response.json(true);
      throw new Error("unexpected fake route");
    });
    try {
      leader = createOpencodeLeader({ model: "fake/model", effort: "low" } as any, fx.data,
        { onDelta: (s: string) => deltas.push(s), onError: (s: string) => errors.push(s), onDone() {} } as any,
        { mode: "ask", bridge: { url: "http://127.0.0.1:1", token: "synthetic-bridge" }, ask: async () => false,
          pickPort: async () => 12345, spawnFn: (() => {
            child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
            child.kill = () => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); return true; };
            return child;
          }) as any });
      leader.send("synthetic prompt");
      await until(() => calls.some((s) => s.endsWith("/prompt_async")));
      if (failure) await until(() => errors.length > 0);
      else { await new Promise((done) => setTimeout(done, 20)); leader.stop(); }
      const visible = deltas.join("") + errors.join("");
      assert.equal(visible.includes(key), false);
      assert.equal(visible.includes(JSON.stringify(key).slice(1, -1)), false);
      assert.match(visible, /\[hidden\]/);
      if (!failure) assert.match(deltas.join(""), /safe/);
      assert.equal(readFileSync(file, "utf8"), bytes);
    } finally {
      leader?.stop(); await new Promise((done) => setTimeout(done, 250));
      if (!ended && stream) { ended = true; stream.close(); }
      child?.kill(); // In-memory fake has no OS PID and owns no process to kill.
      const childEnded = child?.exitCode === 0;
      fetchSpy.mock.restore(); restore(); fx.close();
      assert.equal(childEnded, true);
    }
  });
}
