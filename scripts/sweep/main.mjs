import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, releaseLock } from "../lock.mjs";
import * as realCatalogue from "../mutation-proof.mjs";
import { checkedBefore } from "./history.mjs";
import { CANARY, appendRecord, catchMapText, checkControls, exitCodeFor, finalRecords, flakeList, mergeCatchMap, needsEndCheck, readRecords, readState, resultEntries, sweepFolderFor, testKey, writeReports, writeState } from "./report.mjs";
import { killTracked } from "./proctree.mjs";
import { runEndPhase, runRow } from "./row.mjs";

// Control row target: the sweep rewrites this comment and it must survive.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BASELINE_TIMEOUT_MS = 900_000;
const BASELINE_CONCURRENCY = 8;
const DEFAULT_LANES = 3;
const DEFAULT_SLOTS = 12;

// Everything outside this file arrives through `deps` so tests never start a real run: A's functions (sweep), the lock, git, the clock, the signals.
async function resolveDeps(overrides) {
  const root = overrides.root ?? REPO_ROOT;
  const catalogue = overrides.catalogue ?? realCatalogue;
  const git = overrides.git ?? realGit(root, catalogue.COPIED_PATHS);
  const sweep = overrides.sweep ?? { ...(await import("./run.mjs")), ...(await import("./lanes.mjs")), killTracked };
  const lock = overrides.lock ?? { acquireLock, releaseLock };
  return {
    root, catalogue, git, sweep, lock, lockPath: resolve(root, ".mutation-proof.lock"),
    catchMapPath: overrides.catchMapPath ?? join(root, "scripts", "mutations", "catch-map.json"),
    parses: overrides.parses ?? parseCheck, now: overrides.now ?? (() => new Date()), signals: overrides.signals ?? process, log: overrides.log ?? console.log,
  };
}

function realGit(root, copiedPaths) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  return { state: () => ({ head: run(["rev-parse", "HEAD"]), dirty: run(["status", "--porcelain", "--", ...copiedPaths]) }) };
}

// A mutation that leaves a script unparseable crashes every test file that loads it, which would look like a caught mutation.
function parseCheck(lane, file, text) {
  const path = join(lane.dir, `.parse-check${extname(file)}`);
  writeFileSync(path, text);
  try { return spawnSync(process.execPath, ["--check", path], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).status === 0; }
  finally { try { unlinkSync(path); } catch { /* already gone */ } }
}

const OPTIONS = ["lanes", "slots", "until", "out", "resume"];
const USAGE = "node scripts/mutation-proof.mjs [name parts, comma separated] [--lanes N] [--slots N] [--until HH:MM] [--out <folder>] [--resume <sweep folder>]";

// Bad values are refused here, before the lock. Lanes and slots stay null when not given so a resume can take them from state.json.
export function parseArgs(argv, defaultOut) {
  const given = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { positional.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (!OPTIONS.includes(key)) throw new Error(`unknown option ${argv[i]}
${USAGE}`);
    given[key] = argv[++i];
    if (given[key] === undefined || given[key].startsWith("--")) throw new Error(`${argv[i - 1]} needs a value
${USAGE}`);
  }
  if (positional.length > 1) throw new Error(`expected one comma separated list of name parts, got ${positional.length} arguments
${USAGE}`);
  const count = (key, max) => {
    if (given[key] === undefined) return null;
    if (!/^\d+$/.test(given[key]) || Number(given[key]) < 1 || Number(given[key]) > max) throw new Error(`--${key} must be a whole number from 1 to ${max}, got "${given[key]}"`);
    return Number(given[key]);
  };
  if (given.until !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(given.until)) throw new Error(`--until must look like 22:30 (24 hour local time), got "${given.until}"`);
  const filters = (positional[0] ?? "").split(",").filter(Boolean);
  if (given.resume && filters.length) throw new Error("a resume keeps the filters the sweep started with; give none");
  return { filters, lanes: count("lanes", 8), slots: count("slots", 64), until: given.until ?? null, out: resolve(given.out ?? defaultOut), resume: given.resume ?? null };
}

// The next time the local clock shows HH:MM; a time that is not ahead of now means tomorrow.
export function resolveUntil(text, now) {
  const [hours, minutes] = text.split(":").map(Number);
  const deadline = new Date(now);
  deadline.setHours(hours, minutes, 0, 0);
  if (deadline <= now) deadline.setDate(deadline.getDate() + 1);
  return deadline;
}

const readCatchMap = (path) => new Map(existsSync(path) ? Object.entries(JSON.parse(readFileSync(path, "utf8"))) : []);

// Canary and control rows are always in; design rows without a design/ folder are recorded as SKIPPED by the caller, never dropped.
function selectEntries(catalogue, filters) {
  const controls = [...catalogue.mutations.filter(([name]) => name === CANARY), ...catalogue.controlMutations];
  const wanted = catalogue.mutations.filter(([name]) => !filters.length || filters.some((part) => name.includes(part)));
  const byName = new Map([...controls, ...wanted].map((entry) => [entry[0], entry]));
  return { entries: [...byName.values()], controlNames: new Set(controls.map(([name]) => name)) };
}

// Controls first of all, then never-checked groups, then the rest; a group is one target file and runs in one lane so the first catch teaches the rest.
export function buildGroups(entries, controlNames, checked) {
  const controls = entries.filter(([name]) => controlNames.has(name)).map((entry) => [entry]);
  const groups = [new Map(), new Map()];
  for (const entry of entries.filter(([name]) => !controlNames.has(name))) {
    const kind = groups[checked.has(entry[0]) ? 1 : 0];
    kind.set(entry[1], [...(kind.get(entry[1]) ?? []), entry]);
  }
  return [...controls, ...groups[0].values(), ...groups[1].values()];
}

// Refuses (returns the reason) when the copied tree is not what the sweep started from.
function resumeRefusal(state, now, names) {
  if (state.head !== now.head) return `HEAD is ${now.head.slice(0, 7)} but this sweep started at ${state.head.slice(0, 7)}`;
  if (now.dirty) return `copied paths have uncommitted changes, so the results would mix two trees:\n${now.dirty}`;
  const gone = state.selected.filter((name) => !names.has(name));
  return gone.length ? `rows no longer in the catalogue: ${gone.join(", ")}` : null;
}

function skippedRecord(name, file) {
  return { type: "row", name, file, status: "SKIPPED", lane: null, ms: 0, catching: null, runs: [], notes: ["design/ folder is not part of this checkout"], evidence: [] };
}

// Opens a new sweep folder or the one being resumed. Returns { refusal } or the sweep's identity.
function openSweep(deps, args, tree) {
  const { catalogue, root, now } = deps;
  const names = new Set([...catalogue.mutations, ...catalogue.controlMutations].map(([name]) => name));
  if (args.resume) {
    const dir = resolve(args.resume);
    const state = readState(dir);
    const refusal = resumeRefusal(state, tree, names);
    if (refusal) return { refusal };
    const finals = finalRecords(readRecords(dir));
    if (state.selected.every((name) => finals.has(name)) && ![...finals.values()].some((record) => needsEndCheck(record, new Set(flakeList(readRecords(dir)).map(testKey))))) return { refusal: "this sweep is already complete" };
    const { entries, controlNames } = selectEntries(catalogue, state.filters);
    state.lanes = args.lanes ?? state.lanes;
    state.slots = args.slots ?? state.slots;
    state.parts.push({ part: state.parts.length + 1, startedAt: now().toISOString(), endedAt: null, endReason: null });
    return { dir, state, entries: entries.filter(([name]) => state.selected.includes(name)), controlNames };
  }
  const { entries, controlNames } = selectEntries(catalogue, args.filters);
  const dir = sweepFolderFor(args.out, now());
  const state = { version: 1, head: tree.head, startedAt: now().toISOString(), selected: entries.map(([name]) => name), filters: args.filters, lanes: args.lanes ?? DEFAULT_LANES, slots: args.slots ?? DEFAULT_SLOTS, parts: [{ part: 1, startedAt: now().toISOString(), endedAt: null, endReason: null }] };
  writeState(dir, state);
  for (const [name, file] of entries) if (file.startsWith("design/") && !catalogue.hasDesignFolder(root)) appendRecord(dir, skippedRecord(name, file));
  return { dir, state, entries, controlNames };
}

// Stop requests are all checked between rows; a second Ctrl-C or SIGHUP aborts the rows in flight through the AbortController.
function stopControl(deps, dir, until) {
  const abort = new AbortController();
  const stop = { reason: null, abort, signal: abort.signal };
  let interrupts = 0;
  const hardStop = (reason) => { stop.reason ??= reason; abort.abort(); };
  const handlers = {
    SIGINT: () => { if (++interrupts === 1) { stop.reason ??= "Ctrl-C"; deps.log("Ctrl-C: finishing the rows in flight. Press again to abort them."); } else hardStop("second Ctrl-C"); },
    SIGHUP: () => hardStop("SIGHUP"),
  };
  for (const [signalName, handler] of Object.entries(handlers)) deps.signals.on(signalName, handler);
  stop.release = () => { for (const [signalName, handler] of Object.entries(handlers)) deps.signals.off(signalName, handler); };
  stop.requested = () => {
    if (stop.reason) return true;
    if (existsSync(join(dir, "STOP"))) { unlinkSync(join(dir, "STOP")); stop.reason = "STOP file"; }
    else if (until && deps.now() >= until) stop.reason = "--until";
    return stop.reason !== null;
  };
  return stop;
}

export async function main(argv, overrides = {}) {
  const deps = await resolveDeps(overrides);
  let args;
  try {
    args = parseArgs(argv, resolve(deps.root, "..", "audits"));
    // A part that matches no row is a typo: running anyway would finish "0/0 RED", so it is refused before the lock, the copy and any run.
    const unmatched = args.filters.filter((part) => !deps.catalogue.mutations.some(([name]) => name.includes(part)));
    if (unmatched.length) throw new Error(`argv[2]: no catalogue entry name contains ${unmatched.join(", ")}`);
  } catch (err) { deps.log(err.message); return 1; }
  const priority = deps.sweep.lowerOwnPriority();
  try { deps.lock.acquireLock(deps.lockPath); } catch (err) { deps.log(err.message); return 1; }
  const session = { deps, args, priority, lanes: [], problems: [], leftovers: [], dir: null, report: null };
  let thrown;
  try { await runSweep(session); } catch (err) { thrown = err; session.problems.push(err.message); }
  finally { await cleanup(session); deps.lock.releaseLock(deps.lockPath); }
  if (session.cleanupFailure) { if (!thrown) throw session.cleanupFailure; deps.log(`ALSO: ${session.cleanupFailure.message}`); }
  if (thrown) { deps.log(`ERROR ${thrown.message}`); return 1; }
  return session.exitCode ?? 1;
}

// Every lane removed, its leftovers listed and never forced; then the report, so it can carry them. A failure here never hides an earlier one.
// A lane still holding tracked processes (its run's own kill threw) gets one more kill first, through the same refusing killTracked.
async function cleanup(session) {
  for (const lane of session.lanes) {
    if (lane.tracked?.size > 0) {
      try { await session.deps.sweep.killTracked(lane.tracked); }
      catch (err) { session.cleanupFailure ??= err; session.problems.push(`lane ${lane.index} kill retry: ${err.message}`); }
    }
    try { session.leftovers.push(...session.deps.sweep.removeLane(lane).leftovers); }
    catch (err) { session.cleanupFailure ??= err; session.problems.push(`lane ${lane.index} cleanup: ${err.message}`); }
  }
  session.lanes = [];
  session.stop?.release();
  try { session.finishReport?.(); } catch (err) { session.cleanupFailure ??= err; }
}

async function runSweep(session) {
  const { deps, args } = session;
  const { sweep, log, catalogue } = deps;
  const startLeftovers = sweep.cleanupLeftovers(deps.root);
  if (startLeftovers.leftovers.length) log(`start-up leftovers not removed: ${startLeftovers.leftovers.join("; ")}`);
  const tree = deps.git.state();
  const treeProblem = args.resume ? null : tree.dirty ? `copied paths have uncommitted changes:\n${tree.dirty}` : null;
  if (treeProblem) { log(`REFUSED: ${treeProblem}`); session.exitCode = 1; return; }
  const opened = openSweep(deps, args, tree);
  if (opened.refusal) { log(`REFUSED: ${opened.refusal}`); session.exitCode = 1; return; }
  const { dir, state, entries, controlNames } = opened;
  session.dir = dir;
  const part = state.parts.at(-1);
  const until = args.until ? resolveUntil(args.until, deps.now()) : null;
  if (until) log(`Stops after the rows in flight at ${until.toString()}`);
  const stop = session.stop = stopControl(deps, dir, until);
  const records = readRecords(dir);
  const finals = finalRecords(records);
  const flakes = new Map(flakeList(records).map((flake) => [testKey(flake), flake]));
  const targetOf = new Map(entries.map(([name, file]) => [name, file]));
  const catchMap = readCatchMap(deps.catchMapPath);
  const learned = new Map();
  const learn = (target, file) => { const counts = learned.get(target) ?? new Map(); counts.set(file, (counts.get(file) ?? 0) + 1); learned.set(target, counts); };
  for (const record of finals.values()) if (record.status === "RED" && record.catching) learn(record.file, record.catching.file);
  const record = (rec) => { appendRecord(dir, rec); finals.set(rec.name, rec); log(JSON.stringify({ name: rec.name, status: rec.status, ms: rec.ms, lane: rec.lane, done: state.selected.filter((n) => finals.has(n)).length, of: state.selected.length })); };
  const addFlakes = (failures) => { for (const { file, name } of failures) if (!flakes.has(testKey({ file, name }))) { flakes.set(testKey({ file, name }), { file, name }); appendRecord(dir, { type: "flake", file, name }); } };
  let sequence = 0;
  const timing = { wholeMs: BASELINE_TIMEOUT_MS, fileMs: {} };
  const ctx = {
    sweep, slots: sweep.createSlots(state.slots), sweepDir: dir, runsDir: join(dir, "runs"), signal: stop.signal, syntaxChecked: catalogue.SYNTAX_CHECKED, parses: deps.parses,
    catchMap, targetOf, learned, learn, addFlakes, seq: () => `p${part.part}-${String(++sequence).padStart(5, "0")}`,
    timeoutFor: (files) => Math.max(60_000, 6 * (files === null ? timing.wholeMs : files.reduce((sum, file) => sum + (timing.fileMs[file] ?? 0), 0))),
  };
  mkdirSync(ctx.runsDir, { recursive: true });
  const baseTree = tree;
  session.finishReport = () => finishPart({ session, ctx, state, part, entries, controlNames, finals, flakes, baseTree, stop });
  const todo = entries.filter(([name]) => !finals.has(name) && state.selected.includes(name));
  const checked = checkedBefore({ out: resolve(dir, "..", ".."), catchMap, exclude: dir });
  const groups = buildGroups(todo, controlNames, checked);
  const laneCount = Math.max(1, Math.min(state.lanes, groups.length));
  for (let index = 0; index < laneCount; index++) session.lanes.push(sweep.createLane(deps.root, catalogue.COPIED_PATHS, index));
  if (!(await baseline(session, ctx, timing, addFlakes, part))) return;
  await Promise.all(session.lanes.map((lane) => laneWorker({ session, ctx, lane, groups, record, stop })));
  const allFinal = state.selected.every((name) => finals.has(name));
  if (allFinal && !stop.requested() && session.lanes.length) {
    const byName = new Map(entries.map((entry) => [entry[0], entry]));
    await runEndPhase(ctx, session.lanes[0], { entries: byName, finals, flakes, record, shouldStop: stop.requested });
  }
  part.endReason = stop.reason ? `stopped: ${stop.reason}` : "finished";
}

// One quiet whole-suite run on lane 0 with the lane copy untouched. Red twice ends the part.
async function baseline(session, ctx, timing, addFlakes, part) {
  const { sweep } = session.deps;
  const lane = session.lanes[0];
  for (const attempt of [1, 2]) {
    const logPath = join(ctx.runsDir, `${ctx.seq()}-baseline.log`);
    await ctx.slots.acquire(ctx.slots.total);
    let result;
    try { result = await sweep.runTests({ lane, files: null, red: false, earlyStop: false, timeoutMs: BASELINE_TIMEOUT_MS, concurrency: BASELINE_CONCURRENCY, logPath, signal: ctx.signal }); }
    finally { ctx.slots.release(ctx.slots.total); }
    const { leaked } = sweep.resyncLane(lane);
    if (result.outcome === "aborted") { part.endReason = "stopped: aborted during the baseline"; return false; }
    if (result.outcome === "pass" && !leaked.length) {
      timing.wholeMs = result.ms;
      timing.fileMs = result.fileMs;
      try { unlinkSync(logPath); } catch { /* never written */ }
      return true;
    }
    addFlakes(result.failures);
    const why = `${result.outcome}${leaked.length ? `, leaked ${leaked.join(", ")}` : ""} (log ${logPath})`;
    if (attempt === 1) session.deps.log(`baseline was red (${why}); one quiet retry`); else session.problems.push(`baseline red twice: ${why}`);
  }
  part.endReason = "ERROR baseline red twice";
  return false;
}

// A lane takes the next group from the shared queue and runs its rows in order, stopping between rows.
async function laneWorker({ session, ctx, lane, groups, record, stop }) {
  while (groups.length && !stop.requested()) {
    for (const entry of groups.shift()) {
      if (stop.requested()) return;
      let rec;
      try { rec = await runRow(ctx, lane, entry); }
      catch (err) {
        session.problems.push(`lane ${lane.index} stopped on ${entry[0]}: ${err.message}`);
        record({ type: "row", name: entry[0], file: entry[1], status: "ERROR", lane: lane.index, ms: 0, catching: null, runs: [], notes: [`lane ${lane.index} failed: ${err.message}`], evidence: [] });
        return;
      }
      if (rec) record(rec);
    }
  }
}

// Written at the end of EVERY part: tree check, controls, results.json, summary.txt, state.json, and the catch map once the sweep is complete.
function finishPart({ session, ctx, state, part, entries, controlNames, finals, flakes, baseTree, stop }) {
  const { deps } = session;
  const end = deps.git.state();
  const treeChanged = end.head !== baseTree.head || end.dirty !== baseTree.dirty;
  if (treeChanged) session.problems.push("tree changed during the sweep");
  const flakeKeys = new Set(flakes.keys());
  const results = resultEntries(state.selected, finals);
  const complete = state.selected.every((name) => finals.has(name)) && ![...finals.values()].some((rec) => needsEndCheck(rec, flakeKeys));
  const failed = session.problems.length > 0;
  const { controls, broken } = checkControls({ selected: state.selected, results, controlNames: [...controlNames].filter((name) => name !== CANARY), treeChanged });
  const paused = !complete && stop.reason !== null && !failed;
  const exitCode = exitCodeFor({ complete, paused, failed, controls, results, controlNames: [...controlNames] });
  let catchMapNote = null;
  if (complete && !failed && controls.every((control) => control.ok)) {
    const names = new Set([...deps.catalogue.mutations, ...deps.catalogue.controlMutations].map(([name]) => name));
    const merged = mergeCatchMap(Object.fromEntries(ctx.catchMap), results, names);
    writeFileSync(deps.catchMapPath, catchMapText(merged));
    catchMapNote = `Catch map updated (${Object.keys(merged).length} rows): commit scripts/mutations/catch-map.json before the next sweep, or its tree check will refuse.`;
  }
  part.endedAt = deps.now().toISOString();
  part.endReason ??= failed ? "failed" : "did not end cleanly";
  writeState(session.dir, state);
  const summary = { dir: session.dir, results, selected: state.selected, exitCode, complete, paused, broken, state, priority: session.priority, flakes: [...flakes.values()], controls, controlNames: [...controlNames], leftovers: session.leftovers, catchMapNote, problems: session.problems, treeStart: describeTree(baseTree), treeEnd: treeChanged ? `CHANGED (${end.head.slice(0, 7)}${end.dirty ? ", uncommitted changes" : ""})` : "unchanged", quietOnly: results.filter((entry) => entry.quietOnly).map((entry) => entry.name) };
  writeReports(session.dir, summary);
  session.exitCode = exitCode;
  deps.log(`Sweep folder ${session.dir}, exit code ${exitCode}`);
}

const describeTree = (tree) => `${tree.head.slice(0, 7)}${tree.dirty ? " with uncommitted changes" : " clean"}`;
