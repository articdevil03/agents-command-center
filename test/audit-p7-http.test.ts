import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { resolve, extname, join } from "node:path";
import * as security from "../server/security.ts";
import { scratchDir } from "./temp-root.ts";
import { loadFixed, connect, waitFor } from "./round2-helpers.ts";

// Evaluate the complete HTTP module, with fakes only at its I/O boundaries.
const httpSource = stripTypeScriptTypes(readFileSync("server/main/http.ts", "utf8"))
  .replace(/^import\s+(?:.|\r?\n)*?from\s+["'][^"']+["'];\r?\n/gm, "")
  .replace(/^export /gm, "");
const host = "127.0.0.1:4317", key = "a".repeat(64);
security.setAllowedPort(4317);
security.setAppKey(key);

function httpHarness(options: { rejectBridge?: boolean; partial?: boolean } = {}) {
  const reads: string[] = [], broadcasts: unknown[] = [], errors: unknown[][] = [];
  const handler = runInNewContext(`${httpSource}\nhandleHttpRequest;`, {
    console: { error: (...args: unknown[]) => errors.push(args) }, describeError: String,
    ...security, URL, Buffer, resolve, extname, publicDir: resolve("public"),
    IMAGE_EXT_TO_MIME: {},
    isSafeRequestId: () => false,
    readFile: async (path: string) => {
      reads.push(path);
      if (/(?:^|[\\/])(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[:. \\/]|$)/i.test(path)) throw new Error("filesystem must not see a device name");
      return Buffer.from("ordinary file");
    },
    leaderBridge: { handle: async (_req: any, res: any) => {
      if (options.partial) res.writeHead(200);
      if (options.rejectBridge) throw new Error("private boundary failure " + ["C:", "Users", "HiddenName"].join("\\") + "\\app.ts token=secretValue Authorization: Bearer syntheticBearerCredential");
      res.end("bridge");
    } },
    broadcast: (message: unknown) => broadcasts.push(message),
  });
  async function request(url: string, method = "GET", headers: Record<string, string> = {}) {
    const res = {
      status: 0, body: undefined as unknown, ended: 0, destroyed: false, headersSent: false, writableEnded: false,
      setHeader() {},
      writeHead(status: number) { this.status = status; this.headersSent = true; },
      end(body?: unknown) { this.body = body; this.ended++; this.writableEnded = true; },
      destroy() { this.destroyed = true; },
    };
    let rejection: unknown;
    try { await handler({ url, method, headers: { host, ...headers } }, res); }
    catch (error) { rejection = error; }
    return { res, rejection };
  }
  return { request, reads, broadcasts, errors };
}

test("P7 malformed targets finish with 400 and no global error", async () => {
  const h = httpHarness();
  for (const target of ["//", "///", "http://[", "http://", "//:"]) {
    const { res, rejection } = await h.request(target);
    assert.equal(res.status, 400, target);
    assert.equal(res.ended, 1, target);
    assert.equal(rejection, undefined, target);
  }
  assert.equal(h.reads.length, 0);
  assert.equal(h.broadcasts.length, 0);
});

test("P7 rejected handler finishes 500 or closes an already started response", async () => {
  for (const partial of [false, true]) {
    const h = httpHarness({ rejectBridge: true, partial });
    const { res, rejection } = await h.request("/api/leader-mcp/tab");
    assert.equal(rejection, undefined);
    if (partial) assert.equal(res.destroyed, true);
    else {
      assert.equal(res.status, 500);
      assert.equal(res.ended, 1);
      assert.equal(res.body, "Request could not be completed.");
    }
    assert.equal(h.errors.length, 1, "one stderr record");
    assert.match(String(h.errors[0]), /HTTP request failed.*private boundary failure/);
    assert.doesNotMatch(String(h.errors[0]), /HiddenName|secretValue|syntheticBearerCredential/);
    assert.deepEqual(h.broadcasts, []);
    assert.deepEqual(h.reads, []);
  }
});

test("P7 Host, Origin and key refusals precede URL parsing and file work", async () => {
  const h = httpHarness();
  for (const [headers, body] of [
    [{ host: "evil.example", origin: "https://evil.example" }, "forbidden host"],
    [{ origin: "https://evil.example" }, "forbidden origin"],
    [{ "x-app-key": "wrong" }, "forbidden"],
    [{}, "forbidden"],
  ] as const) {
    const { res, rejection } = await h.request("//", "POST", headers);
    assert.equal(res.status, 403);
    assert.equal(res.body, body);
    assert.equal(res.ended, 1);
    assert.equal(rejection, undefined);
  }
  const allowed = await h.request("//", "POST", { "x-app-key": key });
  assert.equal(allowed.res.status, 400, "valid key reaches target validation");
  assert.deepEqual(h.reads, []);
});

test("P7 device aliases in every path segment are refused before file I/O", async () => {
  const h = httpHarness();
  const names = ["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`), "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"];
  for (const name of names) for (const alias of [name, name.toLowerCase(), `${name}.txt`, `${name}.`, `${name} `, `${name}:`, `${name}:stream`]) {
    for (const target of [`/${alias}`, `/nested/${encodeURIComponent(alias)}/file.txt`, `/%${alias.charCodeAt(0).toString(16)}${encodeURIComponent(alias.slice(1))}`, `/nested%5c${encodeURIComponent(alias)}%5cfile.txt`]) {
      const { res } = await h.request(target);
      assert.equal(res.status, 403, target);
      assert.equal(res.ended, 1, target);
      assert.equal(h.reads.length, 0, `refuse before readFile: ${target}`);
    }
  }
});

test("P7 a very long run of dots or spaces is handled in bounded time and device aliases stay refused", async () => {
  const h = httpHarness();
  for (const filler of [".", "%20", ". "]) {
    const run = filler.repeat(40_000 / filler.length);
    for (const target of [`/${run}`, `/x${run}`, `/${run}x`]) {
      const started = performance.now();
      const { res, rejection } = await h.request(target);
      const elapsed = performance.now() - started;
      assert.equal(rejection, undefined);
      assert.ok([200, 403, 404].includes(res.status), `finished with a status: ${res.status}`);
      assert.ok(elapsed < 250, `40,000-character run took ${elapsed.toFixed(0)} ms`);
    }
    for (const alias of ["con", "CON"]) {
      const started = performance.now();
      const { res } = await h.request(`/${alias}${run}`);
      assert.equal(res.status, 403, `${alias} followed by a long run is still a device alias`);
      assert.ok(performance.now() - started < 250);
    }
  }
  for (const alias of ["/con.", "/con ", "/con%20", "/con. ."]) assert.equal((await h.request(alias)).res.status, 403, alias);
});

test("P7 colons in ordinary static path segments are refused before file I/O", async () => {
  const h = httpHarness();
  for (const target of ["/con:", "/nul:x", "/COM1:", "/file:stream", "/nested/file%3Astream.txt", "/nested%5cfile%3Astream"]) {
    const { res } = await h.request(target);
    assert.equal(res.status, 403, target); assert.deepEqual(h.reads, [], target);
  }
});

test("P7 ordinary filenames and HEAD still serve, including names resembling devices", async () => {
  const h = httpHarness();
  for (const target of ["/", "/index.html", "/nested/file.txt", "/company.txt", "/lpt10.txt"]) {
    const { res } = await h.request(target);
    assert.equal(res.status, 200, target);
    assert.equal(String(res.body), "ordinary file");
  }
  const { res } = await h.request("/index.html", "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.body, undefined);
  assert.equal(res.ended, 1);
  assert.equal(h.reads.length, 6);
});

test("P7 failed folder persistence keeps the old folder and idle leader session", async () => {
  let fail = false;
  const events: string[] = [];
  const server = await loadFixed({ testRoot: scratchDir(), skipHealth: true, failWorkspaceWrite: () => { events.push("save"); return fail; } });
  const newFolder = join(server.testRoot, "project"); mkdirSync(newFolder);
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create idle session" });
  await waitFor(() => server.leaders.has("alpha-dev") && server.activeLeaderTurns.size === 0, "idle leader");
  const leader = server.leaders.get("alpha-dev")!;
  const originalStop = leader.stop.bind(leader);
  leader.stop = () => { events.push("stop"); originalStop(); };
  const oldFolder = server.getWorkspaces().projects[0].tabs[0].folder;
  const creates = server.leaderCreates.length;
  events.length = 0; fail = true;
  try {
    ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: newFolder });
    assert.deepEqual(events, ["save"], ws.messages.at(-1)?.message);
    assert.equal(server.getWorkspaces().projects[0].tabs[0].folder, oldFolder);
    assert.equal(server.tabs.get("alpha-dev").state.folderPath, oldFolder);
    assert.equal(server.leaders.get("alpha-dev"), leader);
    assert.equal(server.leaderCreates.length, creates);
    assert.match(ws.messages.at(-1).message, /could not save.*folder/i);
  } finally { server.stopLeaderSession("alpha-dev"); }
});

test("P7 successful folder persistence precedes one stop and waits for next chat to replace leader", async () => {
  const events: string[] = [];
  const server = await loadFixed({ testRoot: scratchDir(), skipHealth: true, failWorkspaceWrite: () => { events.push("save"); return false; } });
  const newFolder = join(server.testRoot, "project"); mkdirSync(newFolder);
  const ws = connect(server);
  ws.message({ type: "chat", tabId: "alpha-dev", text: "create idle session" });
  await waitFor(() => server.leaders.has("alpha-dev") && server.activeLeaderTurns.size === 0, "idle leader");
  const leader = server.leaders.get("alpha-dev")!;
  const originalStop = leader.stop.bind(leader);
  leader.stop = () => {
    assert.equal(server.getWorkspaces().projects[0].tabs[0].folder, newFolder, "disk holds new folder before stop");
    events.push("stop"); originalStop();
  };
  const creates = server.leaderCreates.length;
  events.length = 0;
  ws.message({ type: "changeFolder", tabId: "alpha-dev", folder: newFolder });
  assert.deepEqual(events, ["save", "stop"], ws.messages.at(-1)?.message);
  assert.equal(server.tabs.get("alpha-dev").state.folderPath, newFolder);
  assert.equal(server.leaders.has("alpha-dev"), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(server.leaderCreates.length, creates, "refresh never starts a replacement");
  try {
    ws.message({ type: "chat", tabId: "alpha-dev", text: "next message" });
    await waitFor(() => server.leaderCreates.length === creates + 1, "replacement on next chat");
    await server.getQueue();
    assert.equal(events.filter((event) => event === "stop").length, 1);
  } finally { server.stopLeaderSession("alpha-dev"); }
});
