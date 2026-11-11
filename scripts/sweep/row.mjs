import { unlinkSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { CANARY, needsEndCheck, testKey } from "./report.mjs";

// One row's decision tree. Everything it touches arrives in `ctx` (run.mjs and lanes.mjs functions, slots, catch data), so tests fake the far boundary.
const MAX_CANDIDATES = 4;
const ABORTED = Symbol("aborted");

// The canary's own run uses red=false: the catalogue test it trips is skipped under CC_MUTATION_PROOF=1.
const redFlag = (name) => name !== CANARY;
const rank = (counts) => [...counts].sort((a, b) => b[1] - a[1]).map(([file]) => file);

// The row's own catch-map entry; else the files already learned for rows on the SAME target file (this sweep first, then the catch map), most frequent first.
export function candidateFiles(ctx, name, target) {
  const own = ctx.catchMap.get(name);
  if (own) return [own];
  const fromMap = new Map();
  for (const [other, file] of ctx.catchMap) if (ctx.targetOf.get(other) === target) fromMap.set(file, (fromMap.get(file) ?? 0) + 1);
  return [...new Set([...rank(ctx.learned.get(target) ?? new Map()), ...rank(fromMap)])].slice(0, MAX_CANDIDATES);
}

function newRecord(name, file, lane) {
  return { type: "row", name, file, status: null, lane, ms: 0, catching: null, runs: [], notes: [], evidence: [] };
}

function removeQuietly(path) { try { unlinkSync(path); } catch { /* never written, or gone */ } }

// Run logs live in runs/. A row that is not RED keeps all of them; a RED row keeps only the runs marked as flake evidence.
function settle(ctx, rec, status, note) {
  rec.status = status;
  if (note) rec.notes.push(note);
  if (status !== "RED") rec.catching = null;
  for (const run of rec.runs) {
    if (!run.logPath) continue;
    if (status !== "RED" || run.keep) run.log = relative(ctx.sweepDir, run.logPath).replaceAll("\\", "/"); else removeQuietly(run.logPath);
    delete run.logPath;
    delete run.keep;
  }
  rec.evidence = rec.runs.map((run) => run.log).filter(Boolean);
  return rec;
}

function catchingOf(result) {
  const { file, name } = result.catching;
  return { file, name, message: result.failures.find((failure) => failure.file === file && failure.name === name)?.message ?? "" };
}

// Runs the suite or some files in the lane, holding its share of the load budget (a quiet run holds all of it).
async function execute(ctx, lane, rec, { kind, files, red, earlyStop, quiet = false, keep = false }) {
  const concurrency = files === null ? 8 : Math.min(files.length, 4);
  const need = quiet ? ctx.slots.total : concurrency;
  const logPath = join(ctx.runsDir, `${ctx.seq()}-${rec.name.replace(/[^\w.-]/g, "_")}-${kind}.log`);
  await ctx.slots.acquire(need);
  let result;
  try {
    result = await ctx.sweep.runTests({ lane, files, red, earlyStop, timeoutMs: ctx.timeoutFor(files), concurrency, logPath, signal: ctx.signal });
  } finally {
    ctx.slots.release(need);
  }
  const run = { kind, files, ms: result.ms, outcome: result.outcome, exitCode: result.exitCode, logPath, keep };
  rec.runs.push(run);
  if (result.outcome === "aborted") throw ABORTED;
  return { run, result };
}

function noteResync(rec, resynced) {
  if (resynced.recopied.length) rec.notes.push(`pollution: recopied ${resynced.recopied.join(", ")}`);
  if (resynced.removed.length) rec.notes.push(`pollution: removed ${resynced.removed.join(", ")}`);
  if (resynced.tempLeftovers.length) rec.notes.push(`lane temp leftovers: ${resynced.tempLeftovers.join(", ")}`);
  return resynced;
}

// Reads the original, checks the target matches exactly once (LF-normalised, replacement as a function so `$&` stays literal) and that the result still parses.
async function prepare(ctx, lane, [name, file, from, to]) {
  let original;
  try { original = ctx.sweep.readPristine(lane, file).toString("utf8").replaceAll("\r\n", "\n"); }
  catch (err) { return { note: `${name}: ${file} is not in the lane copy (${err.message})` }; }
  const matches = from.length === 0 ? 0 : original.split(from).length - 1;
  if (matches === 0) return { note: `${name}: mutation target missing` };
  if (matches > 1) return { note: `${name}: mutation target matches ${matches} times in ${file} (expected exactly 1)` };
  const mutated = original.replace(from, () => to);
  if (ctx.syntaxChecked.has(extname(file)) && !(await ctx.parses(lane, file, mutated)) && await ctx.parses(lane, file, original)) {
    return { note: `${name}: the mutation leaves ${file} unparseable (a catalogue error, not a caught mutation)` };
  }
  return { mutated };
}

// The mutation is in place only while `body` runs; the original bytes go back and the lane is re-synced whatever happens (also on an abort).
async function withMutation(ctx, lane, file, mutated, rec, body, quiet = false) {
  ctx.sweep.writeVerified(lane, file, mutated);
  try {
    const outcome = await body();
    return outcome.caught ? await confirmCatch(ctx, lane, rec, outcome, quiet) : outcome;
  }
  finally {
    ctx.sweep.writeVerified(lane, file, ctx.sweep.readPristine(lane, file));
    noteResync(rec, ctx.sweep.resyncLane(lane));
  }
}

// A catch counts only when the same assertion repeats with the mutation still applied.
async function confirmCatch(ctx, lane, rec, outcome, quiet) {
  const originalRun = rec.runs.at(-1);
  const { run, result } = await execute(ctx, lane, rec, {
    kind: "red-confirm", files: [outcome.caught.file], red: redFlag(rec.name),
    earlyStop: true, quiet,
  });
  run.catching = result.catching;
  if (result.outcome === "assertion" && testKey(result.catching) === testKey(outcome.caught)) return outcome;
  originalRun.keep = true;
  run.keep = true;
  if (result.outcome !== "pass" && result.outcome !== "assertion") {
    return { status: "ERROR", note: `${rec.name}: catch confirmation ended ${result.outcome}` };
  }
  const unconfirmed = [{ file: outcome.caught.file, name: outcome.caught.name }];
  if (result.outcome === "assertion") unconfirmed.push(result.catching);
  ctx.addFlakes(unconfirmed);
  return {
    status: quiet ? "ERROR" : "SURVIVED",
    note: `${rec.name}: catch confirmation mismatch: ${testKey(outcome.caught)} then ${result.outcome === "assertion" ? testKey(result.catching) : result.outcome}`,
  };
}

// The whole suite with the mutation in place: assertion = caught, pass = survived, anything else = error.
async function wholeSuite(ctx, lane, rec, name, options) {
  const { result } = await execute(ctx, lane, rec, { kind: "red-whole", files: null, red: redFlag(name), earlyStop: true, ...options });
  if (result.outcome === "assertion") return { caught: catchingOf(result) };
  if (result.outcome === "pass") return { status: "SURVIVED" };
  return { status: "ERROR", note: `${name}: whole-suite run ended ${result.outcome}${result.failures[0] ? ` (${result.failures[0].cause}: ${result.failures[0].message})` : ""}` };
}

// A scoped run on the known catching files first; only a miss falls back to the whole suite, and only the whole suite can declare a survivor.
async function redPhase(ctx, lane, rec, [name, file]) {
  const candidates = candidateFiles(ctx, name, file);
  if (candidates.length) {
    const { result } = await execute(ctx, lane, rec, { kind: "red-scoped", files: candidates, red: redFlag(name), earlyStop: true });
    if (result.outcome === "assertion") return { caught: catchingOf(result) };
  }
  return wholeSuite(ctx, lane, rec, name, {});
}

async function restoredRun(ctx, lane, rec, file, quiet) {
  const { run, result } = await execute(ctx, lane, rec, { kind: quiet ? "restored-retry" : "restored", files: [file], red: false, earlyStop: false, quiet });
  const { leaked } = noteResync(rec, ctx.sweep.resyncLane(lane));
  const clean = result.outcome === "pass" && leaked.length === 0;
  if (!clean) { run.keep = true; rec.notes.push(`${quiet ? "quiet re-run" : "restored check"} of ${file} was not clean: ${result.outcome}${leaked.length ? `, leaked ${leaked.join(", ")}` : ""}`); }
  return { clean, failures: result.failures.map(({ file: failedFile, name }) => ({ file: failedFile, name })) };
}

// The catching file alone on the restored tree must pass. A failure joins the flake list and gets one quiet re-run.
async function restoredCheck(ctx, lane, rec, file) {
  const first = await restoredRun(ctx, lane, rec, file, false);
  if (first.clean) return true;
  ctx.addFlakes(first.failures);
  return (await restoredRun(ctx, lane, rec, file, true)).clean;
}

// Returns the finished record, or null when the owner's hard stop aborted the row (it stays unfinished for a resume).
export async function runRow(ctx, lane, entry) {
  const [name, file] = entry;
  const rec = newRecord(name, file, lane.index);
  const started = Date.now();
  const done = (status, note) => { rec.ms = Date.now() - started; return settle(ctx, rec, status, note); };
  try {
    const prepared = await prepare(ctx, lane, entry);
    if (prepared.note) return done("ERROR", prepared.note);
    const outcome = await withMutation(ctx, lane, file, prepared.mutated, rec, () => redPhase(ctx, lane, rec, entry));
    if (!outcome.caught) return done(outcome.status, outcome.note);
    rec.catching = outcome.caught;
    if (!(await restoredCheck(ctx, lane, rec, outcome.caught.file))) return done("ERROR", `${name}: restored file red twice (${outcome.caught.file})`);
    ctx.learn(file, outcome.caught.file);
    return done("RED");
  } catch (err) {
    if (err === ABORTED) return null;
    throw err;
  }
}

// The end phase re-checks a finished row with its mutation back in place, quietly. `body` returns { caught, note } or { status, note }.
async function endCheck(ctx, lane, entry, prior, body) {
  const [name, file] = entry;
  const rec = { ...prior, runs: [...prior.runs], notes: [...prior.notes], endChecked: true, phase: "end", lane: lane.index };
  const started = Date.now();
  const done = (status, note) => { rec.ms = prior.ms + Date.now() - started; return settle(ctx, rec, status, note); };
  try {
    const prepared = await prepare(ctx, lane, entry);
    if (prepared.note) return done("ERROR", prepared.note);
    const outcome = await withMutation(ctx, lane, file, prepared.mutated, rec, () => body(rec, name), true);
    if (outcome.quietOnly) rec.quietOnly = true;
    if (outcome.caught) { rec.catching = outcome.caught; return done("RED", outcome.note); }
    return done(outcome.status, outcome.note);
  } catch (err) {
    if (err === ABORTED) return null;
    throw err;
  }
}

// A RED whose catching test is on the flake list: the catching file alone, quiet; still caught = RED, else redo from the whole suite, quiet.
export function recheckFlaky(ctx, lane, entry, prior) {
  return endCheck(ctx, lane, entry, prior, async (rec, name) => {
    const { result } = await execute(ctx, lane, rec, { kind: "flake-recheck", files: [prior.catching.file], red: redFlag(name), earlyStop: true, quiet: true, keep: true });
    if (result.outcome === "assertion") return { caught: catchingOf(result), note: "flake re-check: caught again when quiet" };
    return wholeSuite(ctx, lane, rec, name, { kind: "flake-recheck-whole", quiet: true, keep: true });
  });
}

// A survivor candidate: one quiet whole-suite run with the mutation in place. Caught now = RED, "caught only when quiet".
export function recheckSurvivor(ctx, lane, entry, prior) {
  return endCheck(ctx, lane, entry, prior, async (rec, name) => {
    const outcome = await wholeSuite(ctx, lane, rec, name, { kind: "survivor-recheck", quiet: true, keep: true });
    return outcome.caught ? { ...outcome, note: "caught only when quiet", quietOnly: true } : outcome;
  });
}

// Every row that still needs a re-check, on one lane, one at a time (a quiet run takes every slot anyway). Stops between rows.
export async function runEndPhase(ctx, lane, { entries, finals, flakes, record, shouldStop }) {
  for (const [name, prior] of [...finals]) {
    const flakeKeys = new Set(flakes.keys());
    const entry = entries.get(name);
    if (!entry || !needsEndCheck(prior, flakeKeys) || shouldStop()) continue;
    const next = await (prior.status === "SURVIVED" ? recheckSurvivor : recheckFlaky)(ctx, lane, entry, prior);
    if (next) record(next);
  }
}
