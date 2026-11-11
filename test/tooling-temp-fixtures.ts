import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const root = fileURLToPath(new URL("..", import.meta.url));
export function source(file: string): string {
  const text = readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
  assert.ok(text.length > 0, `source found: ${file}`);
  return file.endsWith(".ts") ? stripTypeScriptTypes(text) : text;
}
export function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `entry found: ${start} -> ${end}`);
  return text.slice(a, b);
}
export function plain(text: string): string {
  return text.replace(/^import[\s\S]*?;\n/gm, "").replace(/\bexport /g, "")
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.join(root, "test", "fixture.ts")).href));
}
export const cleanupSource = () => plain(between(source("scripts/mutation-proof.mjs"), "// Only the supplied", "export const mutations"));
const error = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });
type Entry = { kind: "dir" | "file" | "link"; data?: any; target?: string };
export function fixture() {
  const entries = new Map<string, Entry>();
  const key = (p: any) => path.resolve(String(p));
  const waits: number[] = [], logs: string[] = [], touched: string[] = [];
  const hooks: Function[] = [], tests: Array<{ name: string; fn: Function }> = [];
  const proc: any = { env: {}, argv: ["node", "fixture"], execPath: "node", pid: 987654, platform: "fixture", exitCode: undefined, cwd: () => root };
  let seq = 0, failedCalls = 0;
  let failure: undefined | ((p: string) => string | undefined);
  function check(p: any) { const code = failure?.(key(p)); if (code) { failedCalls++; throw error(code); } }
  const put = (p: any, kind: Entry["kind"] = "dir", data?: any, target?: string) => { entries.set(key(p), { kind, data, target }); return String(p); };
  function info(p: any) {
    check(p); const entry = entries.get(key(p)); if (!entry) throw error("ENOENT");
    return { isSymbolicLink: () => entry.kind === "link", isDirectory: () => entry.kind === "dir", mtimeMs: 0 };
  }
  const children = (p: any) => {
    const entry = entries.get(key(p)); if (!entry) throw error("ENOENT");
    const base = entry.kind === "link" ? key(entry.target) : key(p);
    return [...entries.keys()].filter((n) => path.dirname(n) === base).map((n) => path.basename(n));
  };
  const fs: any = {
    lstatSync: info, statSync: info, existsSync: (p: any) => entries.has(key(p)),
    readdirSync: children,
    unlinkSync(p: any) { check(p); const e = entries.get(key(p)); if (!e) throw error("ENOENT"); if (e.kind === "dir") throw error("EISDIR"); touched.push(key(p)); entries.delete(key(p)); },
    rmdirSync(p: any) { check(p); const e = entries.get(key(p)); if (!e) throw error("ENOENT"); if (e.kind === "link") { touched.push(key(p)); entries.delete(key(p)); return; } if (children(p).length) throw error("ENOTEMPTY"); touched.push(key(p)); entries.delete(key(p)); },
    mkdtempSync(prefix: string) { return put(`${prefix}${++seq}`); },
    mkdirSync(p: any) { put(p); },
    writeFileSync(p: any, data: any) { put(p, "file", data); },
    readFileSync(p: any) { const e = entries.get(key(p)); if (!e) throw error("ENOENT"); return e.data; },
    realpathSync: (p: any) => String(p), copyTree() {}, cpSync() {},
    openSync(p: any) { put(p, "file"); return p; }, closeSync() {},
    renameSync(a: any, b: any) { const e = entries.get(key(a)); assert.ok(e); entries.delete(key(a)); entries.set(key(b), e); },
    copyFileSync(a: any, b: any) { put(b, "file", fs.readFileSync(a)); },
  };
  const register: any = (name: string, options: any, fn?: Function) => tests.push({ name, fn: fn ?? options });
  register.after = (fn: Function) => hooks.push(fn);
  const timers = new Set<any>();
  const context: any = {
    ...path, ...fs, assert, URL, Buffer, EventEmitter, fileURLToPath, pathToFileURL,
    process: proc, console: { log: (...v: any[]) => logs.push(v.join(" ")), error: (...v: any[]) => logs.push(v.join(" ")), warn: (...v: any[]) => logs.push(v.join(" ")) },
    Atomics: { wait: (_a: any, _b: any, _c: any, ms: number) => waits.push(ms) }, SharedArrayBuffer, Int32Array,
    tmpdir: () => path.join(root, "virtual-temp"), test: register, after: register.after,
    setTimeout: (fn: Function) => { const timer = { fn }; timers.add(timer); return timer; },
    clearTimeout: (timer: any) => timers.delete(timer),
    createHash,
    randomUUID: () => "fixture-token", randomBytes: () => Buffer.alloc(32),
  };
  context.removeWithRetry = runInNewContext(`${cleanupSource()}; removeWithRetry`, context);
  return { context, proc, fs, put, entries, waits, logs, touched, hooks, tests, key, timers,
    fail(fn?: typeof failure) { failure = fn; }, get failedCalls() { return failedCalls; },
    evaluate(text: string, tail = "") { return runInNewContext(`${plain(text)}\n${tail}`, context); },
    async entry(file: string) { await runInNewContext(`(async () => {${plain(source(file))}\n})()`, context); },
  };
}

// Execute the real hook and real allocator, without importing unrelated server modules.
export function hookFixture(file: string) {
  const f = fixture(), s = source(file);
  let code: string, allocate: string;
  if (file === "test/temp-root.ts") {
    code = s; allocate = "({ tempRoot, scratchDir })";
  } else if (file.includes("pack1-process")) {
    code = between(s, "const made", '\ntest("A5:'); allocate = "({ scratch })";
    f.context.restoreDataEnv = () => {};
  } else if (file.includes("pack2-process")) {
    code = between(s, "export const made", "// ---- the tracker"); allocate = "({ scratch })";
    code = between(s, "export async function killSeen(", "export function scratch(") + code;
    f.context.restoreDataEnv = () => {};
  } else if (file.includes("pack18")) {
    code = between(s, "const madeLogDirs", "const alive =");
    const shared = f.evaluate(source("test/temp-root.ts"), "; ({ scratchDir })");
    f.context.scratchDir = shared.scratchDir;
    // Stop at the process-environment boundary after the real start() allocator.
    f.proc.env = new Proxy({}, { set(_target, name, value) {
      if (name === "FAKE_LEADER_LOG") throw new Error(`allocated:${value}`);
      return true;
    } });
    allocate = "({ start })";
  } else {
    code = between(s, "const REAL_TMP", "function fake"); allocate = "({ scratch })";
  }
  if (file.includes("pack1") || file.includes("pack2")) {
    const envCode = between(source("test/temp-root.ts"), "export function setEnv(", "// Loads server modules");
    code = envCode + "\nconst restoreDataEnv = setEnv({});\n" + code;
  }
  const api = f.evaluate(code, `; ${allocate}`);
  if (file !== "test/temp-root.ts") assert.ok(f.hooks.length > 0, `${file}: actual hook registered`);
  return Object.assign(f, { api });
}
