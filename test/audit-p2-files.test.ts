import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These roots contain only files this test creates. Delete exact files, then empty directories.
const roots: string[] = [];
function scratch(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "cc-p2-files-")); roots.push(root); return root;
}
function clean(path: string): void {
  assert.equal(fs.lstatSync(path).isSymbolicLink(), false);
  for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) clean(child); else fs.unlinkSync(child);
  }
  assert.deepEqual(fs.readdirSync(path), []); fs.rmdirSync(path);
}
after(() => { for (const root of roots) clean(root); });
const env = { CC_DATA_DIR: process.env.CC_DATA_DIR, CC_TEST_FORCE_PACKAGED: process.env.CC_TEST_FORCE_PACKAGED };
process.env.CC_DATA_DIR = scratch(); process.env.CC_TEST_FORCE_PACKAGED = "1";
const prefs = await import("../server/config-prefs.ts");
const configFiles = await import("../server/config-files.ts");
const { SettingsService } = await import("../server/settings/service.ts");
const safe = await import("../server/safe-file.ts");
const state = await import("../server/main/state.ts");
const { handleMessage } = await import("../server/main/messages/index.ts");
const { stateMessage } = await import("../server/main/broadcast.ts");
for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }

const original = { readFileSync: fs.readFileSync, copyFileSync: fs.copyFileSync, renameSync: fs.renameSync };
function inject(name: keyof typeof original, replacement: Function): () => void {
  (fs as any)[name] = replacement; syncBuiltinESMExports();
  return () => { (fs as any)[name] = original[name]; syncBuiltinESMExports(); };
}
function ioError(code: string): never { throw Object.assign(new Error("injected storage failure"), { code }); }
function service(root: string) {
  return new SettingsService({ dataRoot: root, env: { PATH: "", HOME: root, USERPROFILE: root },
    runCli: async () => { throw new Error("No vendor commands allowed"); } });
}
const saved = { notesVaultPath: null, defaultProjectFolder: "saved-folder", permissionModes: { tab: "bypass" } };
const copies = (root: string) => fs.readdirSync(root).filter((name) => name.includes(".bad-"));

test("identical damaged bytes across starts reuse one copy; changed bytes get another", () => {
  const root = scratch(), path = join(root, "settings.json");
  fs.writeFileSync(path, "broken-one");
  assert.equal(service(root).permissionMode("tab"), "ask");
  assert.equal(service(root).permissionMode("tab"), "ask");
  assert.equal(copies(root).length, 1);
  fs.writeFileSync(path, "broken-two"); service(root);
  assert.equal(copies(root).length, 2);
  assert.deepEqual(copies(root).map((name) => fs.readFileSync(join(root, name), "utf8")).sort(), ["broken-one", "broken-two"]);
  const result = safe.preserveBadFile(path);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(fs.readFileSync(result.path, "utf8"), "broken-two");
});

for (const code of ["EBUSY", "EACCES"]) {
  test(`settings ${code} retries, starts in Ask, refuses saving without changing bytes or memory`, async () => {
    const root = scratch(), path = join(root, "settings.json"), bytes = JSON.stringify(saved);
    fs.writeFileSync(path, bytes); let reads = 0;
    const restore = inject("readFileSync", (p: any, ...args: any[]) => {
      if (String(p) === path) { reads++; ioError(code); } return (original.readFileSync as any)(p, ...args);
    });
    let s: ReturnType<typeof service>;
    try { assert.doesNotThrow(() => { s = service(root); }); } finally { restore(); }
    assert.equal(s!.permissionMode("tab"), "ask");
    await assert.rejects(s!.setDefaultProjectFolder("folder", root), /cannot be saved/);
    await assert.rejects(s!.setPermissionMode("tab", "mode", "accept", true, async () => true, () => false), /could not be saved/);
    assert.equal(s!.state.folders.defaultProjectFolder, ""); assert.equal(s!.permissionMode("tab"), "ask");
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
    assert.equal(reads, 3); assert.match(s!.takeRecoveryNotice()!, /could not be read/);
    assert.equal(service(root).permissionMode("tab"), "bypass", "a fresh intact read recovers saved modes");
  });
  test(`settings transient ${code} preserves saved modes, vault and folder`, () => {
    const root = scratch(), path = join(root, "settings.json");
    fs.writeFileSync(path, JSON.stringify({ ...saved, notesVaultPath: root })); let reads = 0;
    const restore = inject("readFileSync", (p: any, ...args: any[]) => {
      if (String(p) === path && ++reads === 1) ioError(code); return (original.readFileSync as any)(p, ...args);
    });
    try {
      const s = service(root); assert.equal(reads, 2); assert.equal(s.permissionMode("tab"), "bypass");
      assert.equal(s.state.vault.path, root); assert.equal(s.state.folders.defaultProjectFolder, "saved-folder");
      assert.equal(s.takeRecoveryNotice(), null); assert.deepEqual(copies(root), []);
    } finally { restore(); }
  });
}

for (const bytes of ["bad json", '{"permissionModes": []}']) {
  test(`settings preservation failure blocks replacement: ${bytes}`, async () => {
    const root = scratch(), path = join(root, "settings.json"); fs.writeFileSync(path, bytes);
    const restore = inject("copyFileSync", () => ioError("EACCES"));
    let s: ReturnType<typeof service>;
    try { assert.doesNotThrow(() => { s = service(root); }); } finally { restore(); }
    assert.equal(s!.permissionMode("tab"), "ask"); assert.match(s!.takeRecoveryNotice()!, /could not be copied/);
    await assert.rejects(s!.setDefaultProjectFolder("folder", root), /cannot be saved/);
    assert.equal(s!.state.folders.defaultProjectFolder, ""); assert.equal(fs.readFileSync(path, "utf8"), bytes);
    assert.deepEqual(copies(root), []);
  });
  test(`settings preserves invalid bytes before replacement: ${bytes}`, async () => {
    const root = scratch(), path = join(root, "settings.json"); fs.writeFileSync(path, bytes);
    const s = service(root); assert.equal(s.permissionMode("tab"), "ask");
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
    await s.setDefaultProjectFolder("folder", root);
    assert.equal(fs.readFileSync(join(root, copies(root)[0]), "utf8"), bytes);
    assert.equal(service(root).permissionMode("another-tab"), "ask");
  });
}

test("settings failed atomic replacement keeps original bytes and published values", async () => {
  const root = scratch(), path = join(root, "settings.json"), bytes = JSON.stringify(saved);
  fs.writeFileSync(path, bytes); const s = service(root);
  const restore = inject("renameSync", () => ioError("EIO"));
  try {
    await assert.rejects(s.setDefaultProjectFolder("folder", root));
    await assert.rejects(s.setPermissionMode("tab", "mode", "accept", true, async () => true, () => false), /could not be saved/);
  } finally { restore(); }
  assert.equal(fs.readFileSync(path, "utf8"), bytes); assert.equal(s.state.folders.defaultProjectFolder, "saved-folder");
  assert.equal(s.permissionMode("tab"), "bypass"); assert.deepEqual(fs.readdirSync(root), ["settings.json"]);
});

for (const bytes of ["bad json", "[]", '{"avatar": 3, "dismissedRuns": "bad"}', '{"avatar": 3}', '{"dismissedRuns": "bad"}']) {
  test(`preferences preserve damaged bytes before replacement: ${bytes}`, () => {
    const root = scratch(), path = join(root, "client-prefs.json"); fs.writeFileSync(path, bytes);
    const loaded = prefs.readClientPrefs(path); assert.deepEqual(loaded, prefs.DEFAULT_CLIENT_PREFS);
    assert.equal(fs.readFileSync(path, "utf8"), bytes); assert.equal(copies(root).length, 1);
    prefs.readClientPrefs(path); assert.equal(copies(root).length, 1);
    prefs.writeClientPrefs({ ...loaded, avatar: "momo.svg", dismissedRuns: ["saved"] }, path);
    assert.equal(fs.readFileSync(join(root, copies(root)[0]), "utf8"), bytes);
    assert.deepEqual(prefs.readClientPrefs(path).dismissedRuns, ["saved"]);
  });
  test(`preferences failed preservation blocks saving: ${bytes}`, () => {
    const root = scratch(), path = join(root, "client-prefs.json"); fs.writeFileSync(path, bytes);
    const restore = inject("copyFileSync", () => ioError("EACCES"));
    try {
      const loaded = prefs.readClientPrefs(path), before = structuredClone(loaded);
      assert.throws(() => prefs.writeClientPrefs({ ...loaded, avatar: "momo.svg", dismissedRuns: ["rejected"] }, path), /cannot be saved/);
      assert.deepEqual(loaded, before); assert.equal(fs.readFileSync(path, "utf8"), bytes); assert.deepEqual(copies(root), []);
    } finally { restore(); }
  });
}

for (const code of ["EBUSY", "EACCES"]) {
  test(`preferences persistent ${code} blocks writes and transient ${code} retries`, () => {
    const root = scratch(), path = join(root, "client-prefs.json");
    const previous = { ...prefs.DEFAULT_CLIENT_PREFS, avatar: "momo.svg", dismissedRuns: ["saved"] };
    const bytes = JSON.stringify(previous); fs.writeFileSync(path, bytes); let reads = 0, transient = false;
    const restore = inject("readFileSync", (p: any, ...args: any[]) => {
      if (String(p) === path && (!transient || ++reads === 1)) ioError(code);
      return (original.readFileSync as any)(p, ...args);
    });
    try {
      const loaded = prefs.readClientPrefs(path); assert.deepEqual(loaded, prefs.DEFAULT_CLIENT_PREFS);
      assert.throws(() => prefs.writeClientPrefs({ ...loaded, avatar: "ash.svg" }, path), /cannot be saved/);
      assert.equal(original.readFileSync(path, "utf8"), bytes); assert.deepEqual(loaded, prefs.DEFAULT_CLIENT_PREFS);
      transient = true; assert.deepEqual(prefs.readClientPrefs(path), previous); assert.equal(reads, 2);
    } finally { restore(); }
  });
}

test("preferences stay blocked after a startup lock clears, preserving earlier choices", () => {
  const path = join(scratch(), "client-prefs.json");
  const previous = { ...prefs.DEFAULT_CLIENT_PREFS, avatar: "momo.svg", dismissedRuns: ["saved"], bellEnabled: true, previewUrl: "https://example.test" };
  const bytes = JSON.stringify(previous); fs.writeFileSync(path, bytes);
  const restore = inject("readFileSync", (p: any, ...args: any[]) => {
    if (String(p) === path) ioError("EBUSY"); return (original.readFileSync as any)(p, ...args);
  });
  let loaded: typeof previous;
  try { loaded = prefs.readClientPrefs(path); } finally { restore(); }
  assert.throws(() => prefs.writeClientPrefs({ ...loaded!, theme: "dark" }, path), /cannot be saved/);
  assert.equal(fs.readFileSync(path, "utf8"), bytes);
});
test("a failed re-read at write time refuses only that save; a later save works (the start-up read was good)", () => {
  const root = scratch(), path = join(root, "client-prefs.json");
  const previous = { ...prefs.DEFAULT_CLIENT_PREFS, avatar: "momo.svg" }; fs.writeFileSync(path, JSON.stringify(previous));
  const loaded = prefs.readClientPrefs(path); assert.deepEqual(loaded, previous);
  let failing = true;
  const restore = inject("readFileSync", (p: any, ...args: any[]) => { if (String(p) === path && failing) ioError("EBUSY"); return (original.readFileSync as any)(p, ...args); });
  try {
    assert.throws(() => prefs.writeClientPrefs({ ...loaded, theme: "dark" }, path), /cannot be saved/);
    assert.deepEqual(JSON.parse(original.readFileSync(path, "utf8") as string), previous, "the refused save changed nothing");
    failing = false;
    assert.doesNotThrow(() => prefs.writeClientPrefs({ ...loaded, theme: "dark" }, path), "the lock cleared, so the next save is not blocked until restart");
    assert.equal(JSON.parse(original.readFileSync(path, "utf8") as string).theme, "dark");
  } finally { restore(); }
});
test("preferences recheck damage introduced after reading before writing", () => {
  const root = scratch(), path = join(root, "client-prefs.json");
  const loaded = prefs.readClientPrefs(path); fs.writeFileSync(path, "new damage");
  const restore = inject("copyFileSync", () => ioError("EACCES"));
  try { assert.throws(() => prefs.writeClientPrefs(loaded, path), /cannot be saved/); }
  finally { restore(); }
  assert.equal(fs.readFileSync(path, "utf8"), "new damage"); assert.deepEqual(copies(root), []);
});
test("real preference message handler keeps rejected values out of memory, next state and later saves", () => {
  const path = configFiles.clientPrefsPath;
  const previous = { ...prefs.DEFAULT_CLIENT_PREFS, avatar: "momo.svg", dismissedRuns: ["saved"] };
  prefs.writeClientPrefs(previous); const bytes = fs.readFileSync(path, "utf8");
  state.setClientPrefs(previous); state.setWorkspaces({ projects: [], version: 1 } as any);
  state.setAcpClis([]); state.setSettingsService(service(scratch()));
  state.setRequestsStore({ list: () => [] } as any);
  state.setLaunchSafety({ blocked: [], timestamps: [], notices: [], nextNoticeId: 1, released: [], uncertain: [], live: [] });
  state.setBlockedSeatKeys(new Set());
  const messages: any[] = [], ws = { send: (value: string) => messages.push(JSON.parse(value)) } as any;
  const restore = inject("renameSync", () => ioError("EIO"));
  try {
    for (const [key, value] of [["avatar", "ash.svg"], ["dismissedRuns", ["rejected"]]]) {
      handleMessage(ws, JSON.stringify({ type: "setClientPref", key, value }));
      assert.deepEqual(state.clientPrefs, previous); assert.equal(fs.readFileSync(path, "utf8"), bytes);
      assert.deepEqual(stateMessage().clientPrefs, previous);
      assert.equal(messages.at(-1)?.type, "error"); assert.match(messages.at(-1)?.message, /could not be saved/);
    }
  } finally { restore(); }
  handleMessage(ws, JSON.stringify({ type: "updateClientPref", key: "bellEnabled", value: true }));
  assert.deepEqual(state.clientPrefs, { ...previous, bellEnabled: true });
  assert.deepEqual(prefs.readClientPrefs(path), { ...previous, bellEnabled: true });
  assert.deepEqual(stateMessage().clientPrefs, { ...previous, bellEnabled: true });
});
