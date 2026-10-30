import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { keyedWsUrl } from "./temp-root.ts";
import { getProcessDefinition } from "../server/process.ts";
import { attachCrashCatcher } from "./crash-catcher.ts";
import { SERVER_START_MS } from "./server-start.ts";
import { APP_KEY, CHROME, HOST, REPO, WIDTHS, bootstrap, buildSeed, chatMessages, delay, spaced, unbroken } from "./overlap-helpers.ts";
import { chromeAudit, type Finding } from "./overlap-chrome.ts";

function backendState(port: number): Promise<any> {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${port}`, APP_KEY), { origin: `http://${HOST}:${port}` });
    const timer = setTimeout(() => { ws.terminate(); bad(new Error("server state request timed out")); }, 8000);
    ws.once("open", () => ws.send(JSON.stringify({ type: "hello" })));
    ws.on("message", (data) => { const message = JSON.parse(data.toString()); if (message.type === "state") { clearTimeout(timer); ws.close(); ok(message); } });
    ws.once("error", (error) => { clearTimeout(timer); bad(error); });
  });
}

test("overlap audit: no visible text or control overlaps or is clipped, at 1600, 1280 and 1024, on every screen with long data", async (t) => {
  if (process.env.CC_SKIP_BROWSER === "1") { t.skip("CC_SKIP_BROWSER=1 was explicitly set"); return; }
  assert.ok(existsSync(CHROME), `Headless Chrome is required at ${CHROME}; set CC_SKIP_BROWSER=1 only when intentionally running without it`);
  const temp = mkdtempSync(join(tmpdir(), "cc-overlap-"));
  const dataDir = join(temp, "data"); mkdirSync(join(dataDir, "config"), { recursive: true });
  // Two projects of its own (the audit needs a second one); the server runs on this temp data root, never the repo's.
  const crew = getProcessDefinition("dev", "main").seats.map((seat) => ({ slot: seat.slotId, name: seat.defaultName, cli: seat.cli, model: seat.model, effort: seat.effort }));
  const project = (id: string) => ({ id, name: id, folder: temp, tabs: [{ id: `${id}-dev`, name: "Development", kind: "dev", process: "main", folder: temp, crew }] });
  writeFileSync(join(dataDir, "config", "workspaces.json"), JSON.stringify({ projects: [project("alpha"), project("beta")] }));
  const home = join(temp, "home"); mkdirSync(home, { recursive: true });
  const script = join(temp, "fake-cli-script.json");
  writeFileSync(script, JSON.stringify({ responses: {} }));
  const attachDir = join(temp, "attach"); mkdirSync(attachDir);
  const extraFiles = [`${unbroken("attachment-", 120)}.md`, `${spaced("report", 90)}.txt`].map((name) => { const path = join(attachDir, name); writeFileSync(path, "long name attachment\n"); return path; });
  let serverPort = 0; // read from the server's ready line below
  const env = { ...process.env, HOME: home, USERPROFILE: home, CC_TEST_FAKE_CLI: "1", CC_TEST_FAKE_CLI_SCRIPT: script, CC_TEST_FAKE_CLI_RECORD: join(temp, "argv.jsonl"), CC_DATA_DIR: dataDir, CC_TEST_FORCE_PACKAGED: "1", CC_PORT: "0", CC_APP_KEY: APP_KEY, CC_SKIP_DISCOVERY: "1", CC_SKIP_LEADER_CHECK: "1" };
  assert.equal(env.CC_TEST_FAKE_CLI, "1"); assert.equal(env.CC_PORT, "0"); // the OS picks the port at the server's own listen, so no other test can take it first
  // The EFFECT, not the env: this server must run on the temp data root (under node --test a CC_DATA_DIR alone is ignored),
  // so the uploads end up there and the repo's own scratch/ and workspaces file are left exactly as they were.
  const repoScratch = join(REPO, "scratch"), repoScratchCount = () => (existsSync(repoScratch) ? readdirSync(repoScratch).length : 0);
  const repoScratchBefore = repoScratchCount(), repoWorkspacesPath = join(REPO, "config", "workspaces.json");
  // The file is untracked, so a fresh clone has none: absent must stay absent, present must stay byte-identical.
  const readRepoWorkspaces = () => (existsSync(repoWorkspacesPath) ? readFileSync(repoWorkspacesPath, "utf8") : null), repoWorkspacesBefore = readRepoWorkspaces();
  const server = spawn(process.execPath, [join(REPO, "server", "index.ts")], { cwd: REPO, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  attachCrashCatcher(server.pid, "overlap");
  let proxy: http.Server | null = null;
  try {
    await new Promise<void>((ok, bad) => {
      let output = ""; const timer = setTimeout(() => bad(new Error(`server did not become ready; output=${output}`)), SERVER_START_MS);
      server.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); const line = /running at http:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (line) { clearTimeout(timer); serverPort = Number(line[1]); ok(); } });
      server.once("exit", (code) => bad(new Error(`server exited early (${code}); output=${output}`)));
    });
    assert.notEqual(serverPort, 4317, "the test server must never use the real app's port");
    const seed = buildSeed(await backendState(serverPort));
    const html = readFileSync(join(REPO, "public", "index.html"), "utf8").replace(/<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, "")
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") // the page's policy stays, except for the inline bootstrap injected here
      .replace("</head>", `<script>${bootstrap(seed, chatMessages())}</script>\n</head>`);
    proxy = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname === "/__audit") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); return; }
      const headers = { ...request.headers, host: `${HOST}:${serverPort}`, origin: `http://${HOST}:${serverPort}`, "accept-encoding": "identity" };
      const upstream = http.request({ host: HOST, port: serverPort, method: request.method, path: request.url, headers }, (result) => { response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response); });
      upstream.on("error", (error) => { response.writeHead(502); response.end(error.message); });
      request.pipe(upstream);
    });
    await new Promise<void>((ok, bad) => { proxy!.once("error", bad); proxy!.listen(0, HOST, ok); });
    const proxyPort = (proxy.address() as { port: number }).port;
    const all: Finding[] = []; const inventory: string[] = [];
    for (const width of WIDTHS) {
      const perWidth: string[] = [];
      const { findings, errors } = await chromeAudit(proxyPort, join(temp, `chrome-${width}`), width, extraFiles, perWidth);
      assert.deepEqual(errors, [], `page errors at ${width}px: ${JSON.stringify(errors)}`);
      console.log(`Overlap audit ${width}px checked ${perWidth.length} screens/states:\n  ${perWidth.join("\n  ")}`);
      inventory.push(...perWidth); all.push(...findings);
    }
    assert.ok(inventory.length >= WIDTHS.length * 40, `audit checked ${inventory.length} screens/states`);
    const unique = new Map<string, Finding & { widths: number[] }>();
    for (const item of all) {
      const key = `${item.state}|${item.type}|${item.a}|${item.b}`;
      const entry = unique.get(key) ?? { ...item, widths: [] };
      if (!entry.widths.includes(item.width)) entry.widths.push(item.width);
      unique.set(key, entry);
    }
    const report = [...unique.values()].map((item) => `[${item.widths.join("/")}px] ${item.state}: ${item.type}: ${item.a} <-> ${item.b} (${item.detail})`);
    console.log(`Overlap audit findings: ${report.length}${report.length ? `\n  ${report.join("\n  ")}` : ""}`);
    assert.equal(report.length, 0, `overlaps or clipped text found:\n${report.join("\n")}`);
    assert.ok(readdirSync(join(dataDir, "scratch")).length >= extraFiles.length, `the ${extraFiles.length} uploads landed in the temp data root: ${JSON.stringify(readdirSync(join(dataDir, "scratch")))}`);
    assert.ok(existsSync(join(dataDir, "config", "workspaces.json")), "the server seeded its workspaces into the temp data root");
    assert.equal(repoScratchCount(), repoScratchBefore, "the repo's own scratch/ gained no files");
    assert.equal(readRepoWorkspaces(), repoWorkspacesBefore, "the repo's workspaces file is untouched");
  } finally {
    // The temp folder is removed whatever the check says.
    try {
      proxy?.close();
      if (server.exitCode === null && server.signalCode === null) { const exited = once(server, "exit"); server.kill(); await Promise.race([exited, delay(7000)]); }
      assert.ok(server.exitCode !== null || server.signalCode !== null, `server PID ${server.pid} exited after the overlap audit`);
    } finally { await removeWithRetry(temp); }
  }
});
