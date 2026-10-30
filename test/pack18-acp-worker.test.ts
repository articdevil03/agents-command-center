// Pack 18, Block 2: an ACP CLI (Agent Client Protocol) works as a crew seat. runSeat starts the adapter in worker mode against the fake ACP agent
// (shapes measured on `opencode acp`), with only the spawn replaced. W1 done + log + no shell, W2 read-only seats refuse permissions, W3 Stop and errors,
// W4 a refused start, W5 the crew tools over HTTP (and the early fail without HTTP), W6 the token never shown.
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";
import { spawnFakeAcp } from "./fake-leader-cli.ts";

const { modules: { runner, history } } = await importWithTempDataRoot(async () => ({
  runner: await import("../server/runner.ts"),
  history: await import("../server/history.ts"),
}));

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const TOKEN = "tok-p18w-0123456789abcdef0123456789abcdef";
const CREW = { url: "http://127.0.0.1:1/api/leader-mcp/p18-tab.run", token: TOKEN };
let counter = 0;
// Every start() makes one folder for the fake agent's log in the OS temp dir; each is removed when the file ends (its log file, then the empty folder, never a recursive delete).
const madeLogDirs: string[] = [];
after(async () => {
  for (const dir of madeLogDirs) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        if (!existsSync(dir)) break;
        if (lstatSync(dir).isSymbolicLink()) break; // never follow a link
        for (const name of readdirSync(dir)) { if (!lstatSync(join(dir, name)).isSymbolicLink()) unlinkSync(join(dir, name)); }
        rmdirSync(dir);
        break;
      } catch { await sleep(200); } // the agent process may still hold its log for a moment
    }
  }
});

type Started = {
  run: import("../server/runner.ts").RunnerRun; folder: string; fakeLog: string; logPath: string;
  statuses: string[]; outputs: string[]; calls: Array<{ program: string; args: unknown; options: any }>; timestamp: number;
  fake: () => any[]; until: (fn: () => unknown, label: string, ms?: number) => Promise<void>; final: () => Promise<string>;
};
function start(scenario: string, over: Partial<import("../server/runner.ts").RunnerRun> = {}, prompt = "Do the thing"): Started {
  const folder = scratchDir();
  const logDir = mkdtempSync(join(tmpdir(), "cc-p18w-"));
  madeLogDirs.push(logDir);
  const fakeLog = join(logDir, "fake.log");
  process.env.FAKE_LEADER_LOG = fakeLog;
  const statuses: string[] = [], outputs: string[] = [], calls: Started["calls"] = [];
  const run = {
    runId: `p18w-${++counter}`, seatKey: `p18-tab.coder`, slotId: "coder", name: "Kay", cli: "acp:fake" as const, model: "default", effort: "default",
    folder, canWrite: true, startedAt: 1, acp: { name: "Fake", program: "fake-acp", args: [`--scenario=${scenario}`] }, ...over,
  };
  const spawnRecorder = ((program: string, args: unknown, options: any) => { calls.push({ program, args, options }); return spawnFakeAcp(program, args as string[], options); }) as any;
  const result = runner.runSeat(run, prompt, { onOutput: (_run, text) => outputs.push(text), onStatus: (_run, status) => statuses.push(status) }, spawnRecorder);
  assert.equal(result.ok, true, JSON.stringify(result));
  const timestamp = (result as { timestamp: number }).timestamp;
  const logPath = join(runner.logsDir, `${run.seatKey}-${timestamp}.log`);
  const fake = (): any[] => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const until = async (fn: () => unknown, label: string, ms = 20000): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    assert.fail(`${label}: statuses ${JSON.stringify(statuses)} outputs ${JSON.stringify(outputs.join(""))} fake ${JSON.stringify(fake().map((row) => row.received ?? row.scenario))}`);
  };
  const final = async (): Promise<string> => { await until(() => statuses.some((status) => status !== "working"), "the run reports its end"); return statuses.at(-1)!; };
  return { run, folder, fakeLog, logPath, statuses, outputs, calls, timestamp, fake, until, final };
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("W1: an ACP seat runs the brief as ONE prompt, the text reaches the log and the output, a normal end is done, and the process is gone", async () => {
  const w = start("basic");
  assert.deepEqual(w.statuses, ["working"], "working is reported at start");
  assert.equal(await w.final(), "done", `a normal end of the prompt is done (statuses ${JSON.stringify(w.statuses)})`);
  const shown = w.outputs.join("");
  assert.match(shown, /Hello from the fake\. You said: Do the thing/);
  assert.match(shown, /All done\./);
  const log = readFileSync(w.logPath, "utf8");
  assert.ok(log.includes("Hello from the fake. You said: Do the thing"), "the text is in the saved log");
  assert.equal(history.parseOutcome(log).status, "done", "the log ends with the done marker that History reads");
  const prompts = w.fake().filter((row) => row.prompt);
  assert.equal(prompts.length, 1, "one prompt");
  assert.equal(prompts[0].text, "Do the thing", "the brief is the prompt");
  const pid = w.fake().find((row) => row.started).pid;
  await w.until(() => !alive(pid), "the agent process is gone after the run");
  assert.equal(runner.isRunning(w.run.runId), false);
  assert.equal(readFileSync(join(runner.logsDir, `${w.run.seatKey}-${w.timestamp}.brief.txt`), "utf8"), "Do the thing", "the brief file is kept like every run's");
});

test("W1b: the CLI is started as a program with an argument list, never through a shell", async () => {
  const w = start("basic");
  await w.final();
  assert.equal(w.calls.length, 1, "the CLI is started once");
  assert.equal(w.calls[0].program, "fake-acp", "the program alone, not a command line");
  assert.deepEqual(w.calls[0].args, ["--scenario=basic"], "the argument list reaches spawn exactly");
  assert.notEqual(w.calls[0].options.shell, true, "no shell");
  assert.equal(w.calls[0].options.cwd, w.folder, "it works in the tab folder");
  assert.equal(Object.hasOwn(w.calls[0].options.env, "CC_DATA_DIR"), false, "the private data root does not reach it");
});

test("W2: a read-only ACP seat refuses every permission request, a write seat allows once", async () => {
  const ro = start("permission", { canWrite: false });
  assert.equal(await ro.final(), "done");
  assert.match(ro.outputs.join(""), /permission:cancelled:-/, "the agent got 'cancelled'");
  assert.deepEqual(ro.fake().find((row) => row.permissionAnswer).permissionAnswer, { outcome: { outcome: "cancelled" } });
  const rw = start("permission", { canWrite: true });
  assert.equal(await rw.final(), "done");
  assert.match(rw.outputs.join(""), /permission:selected:once/, "the agent got allow-once");
});

test("W3: Stop is 'stopped' (no error line), an error from the CLI is 'failed' and says why", async () => {
  const stopping = start("cancel");
  await stopping.until(() => stopping.fake().some((row) => row.prompt), "the prompt reached the agent");
  await stopping.until(() => stopping.outputs.join("").includes("working"), "it is working");
  assert.equal(runner.killRun(stopping.run.runId), true);
  assert.equal(await stopping.final(), "stopped");
  assert.doesNotMatch(readFileSync(stopping.logPath, "utf8"), /\[error\]/, "a Stop is not an error");
  assert.equal(history.parseOutcome(readFileSync(stopping.logPath, "utf8")).status, "stopped");
  const failing = start("promptauth");
  assert.equal(await failing.final(), "failed");
  assert.match(failing.outputs.join(""), /\[error\] Fake is not signed in/);
  const dying = start("die");
  assert.equal(await dying.final(), "failed", "a CLI that exits in the middle is failed");
  assert.match(readFileSync(dying.logPath, "utf8"), /part of the reply/, "what it had said is kept");
});

test("W4: a CLI that cannot be found refuses the start and leaves no file; an ACP seat without a start command is refused", () => {
  const folder = scratchDir();
  const before = readdirSync(runner.logsDir).length;
  const refused = runner.runSeat(
    { runId: "p18w-ghost", seatKey: "p18-tab.ghost", slotId: "ghost", name: "G", cli: "acp:ghost", model: "default", effort: "default", folder, canWrite: true, startedAt: 1, acp: { name: "Ghost", program: "ghost-acp", args: [] } },
    "x", { onOutput: () => {}, onStatus: () => {} }, spawnFakeAcp as any);
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /ghost-acp was not found on PATH/);
  assert.equal(readdirSync(runner.logsDir).length, before, "no brief or log is left behind");
  assert.equal(runner.isRunning("p18w-ghost"), false);
  const noCommand = runner.runSeat({ runId: "p18w-nocmd", seatKey: "p18-tab.nocmd", slotId: "x", name: "N", cli: "acp:fake", model: "default", effort: "default", folder, canWrite: true, startedAt: 1 }, "x", { onOutput: () => {}, onStatus: () => {} });
  assert.equal(noCommand.ok, false);
  assert.throws(() => runner.runSeat({ runId: "p18w-badcli", seatKey: "p18-tab.bad", slotId: "x", name: "N", cli: "gemini" as any, model: "default", effort: "default", folder, canWrite: true, startedAt: 1 }, "x", { onOutput: () => {}, onStatus: () => {} }), /refusing invalid model/, "any other unknown CLI still throws, as before");
});

test("W5: the crew tools go to the CLI over HTTP; without HTTP the run fails before any prompt; a seat without crew tools gets none", async () => {
  const withTools = start("basic", { crewTools: CREW });
  assert.equal(await withTools.final(), "done");
  const session = withTools.fake().find((row) => row.received === "session/new");
  assert.equal(session.params.mcpServers[0].type, "http");
  assert.equal(session.params.mcpServers[0].name, "tab-crew");
  assert.equal(session.params.mcpServers[0].url, CREW.url);
  assert.equal(session.params.mcpServers[0].headers[0].value, `Bearer ${TOKEN}`);
  const noTools = start("basic");
  assert.equal(await noTools.final(), "done");
  assert.deepEqual(noTools.fake().find((row) => row.received === "session/new").params.mcpServers, [], "a seat that does not run the process gets no tool server");
  assert.doesNotMatch(noTools.outputs.join(""), /crew tools/i, "and no notice about them");
  const noHttp = start("nohttp", { crewTools: CREW });
  assert.equal(await noHttp.final(), "failed");
  assert.match(noHttp.outputs.join(""), /does not take tool servers over HTTP/);
  assert.equal(noHttp.fake().some((row) => row.received === "session/prompt"), false, "session/prompt was never sent");
  assert.equal(noHttp.fake().some((row) => row.prompt), false, "the agent never saw a prompt");
  const plainNoHttp = start("nohttp");
  assert.equal(await plainNoHttp.final(), "done", "a seat that does not need the tools runs on a CLI without HTTP");
});

test("W6: the crew token never reaches the log or the output, whole or split across chunks", async () => {
  const w = start("echotoken", { crewTools: CREW });
  assert.equal(await w.final(), "done");
  const shown = w.outputs.join(""), log = readFileSync(w.logPath, "utf8");
  assert.ok(!shown.includes(TOKEN) && !log.includes(TOKEN), "the token is not shown or saved");
  assert.ok(shown.includes("[hidden]") && log.includes("[hidden]"), "it is replaced where it was");
  for (const chunk of w.outputs) assert.ok(!chunk.includes(TOKEN.slice(0, 20)), "no output chunk even starts it");
});

test("W4b: a failed ACP brief write spawns no child", () => {
  let spawned = 0;
  const write = fs.writeFileSync;
  const mocked = mock.method(fs, "writeFileSync", (...args: any[]) => {
    if (String(args[0]).endsWith(".brief.txt")) throw new Error("brief disk full");
    return (write as any)(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => runner.runSeat({ runId: "p18w-disk", seatKey: "p18-tab.disk", slotId: "disk", name: "D", cli: "acp:fake", model: "default", effort: "default", folder: scratchDir(), canWrite: true, startedAt: 1, acp: { name: "Fake", program: "fake-acp", args: [] } }, "x", { onOutput: () => {}, onStatus: () => {} }, (() => { spawned++; throw new Error("spawn reached"); }) as any), /brief disk full/);
    assert.equal(spawned, 0, "disk failure happens before any child can start");
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
