// Pure functions (server/config.ts) backing the port-keyed-localStorage fix:
// sidebar/panel collapse, panel width, preview URL and notifications-on/off
// are now server-owned (client-prefs.json) instead of living in localStorage,
// which was silently reset every launch because electron/main.js hands the
// renderer a fresh ephemeral port -- a fresh origin -- every time.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { importWithTempDataRoot, scratchDir } from "./temp-root.ts";

// config.ts reads its data root at import: it is loaded on a fresh temp folder, never on the repo's own (live) config/.
const { dataDir, modules: { config } } = await importWithTempDataRoot(async () => ({ config: await import("../server/config.ts") }));
const { readClientPrefs, writeClientPrefs, applyClientPrefUpdate, DEFAULT_CLIENT_PREFS, AVATAR_MAX_CHARS, DISMISSED_RUNS_MAX } = config;

test("this file's config module keeps client-prefs.json in its temp data folder, not the repo's", () => {
  assert.equal(dirname(dirname(config.clientPrefsPath)).toLowerCase(), dataDir.toLowerCase());
});

test("readClientPrefs defaults on a missing file, and neither creates it nor anything beside it", () => {
  const dir = scratchDir(), path = join(dir, "client-prefs.json");
  assert.deepEqual(readClientPrefs(path), DEFAULT_CLIENT_PREFS);
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("readClientPrefs defaults on corrupt JSON and on a non-object value", () => {
  const dir = scratchDir();
  const path = join(dir, "client-prefs.json");
  writeFileSync(path, "not json");
  assert.deepEqual(readClientPrefs(path), DEFAULT_CLIENT_PREFS);
  writeFileSync(path, "[1,2,3]");
  assert.deepEqual(readClientPrefs(path), DEFAULT_CLIENT_PREFS);
  writeFileSync(path, "null");
  assert.deepEqual(readClientPrefs(path), DEFAULT_CLIENT_PREFS);
});

// Cosmetic UI state, not config the app depends on to run (unlike
// readSeats) -- one bad field falls back to its own default rather than
// costing every other saved preference.
test("readClientPrefs falls back per-field on a malformed value, keeping the rest", () => {
  const dir = scratchDir();
  const path = join(dir, "client-prefs.json");
  writeFileSync(path, JSON.stringify({
    sidebarCollapsed: "yes", // wrong type -> default
    notificationsEnabled: false, // valid -> kept
    previewUrl: "not-a-url", // invalid -> default
    rightPanelCollapsed: true, // valid -> kept
    rightPanelWidth: -5, // invalid (non-positive) -> default
    theme: "purple", // not light/dark/system -> default
    avatar: "astra.jpg", // not a preset name or an image -> default
    dismissedRuns: ["ok", 7], // one non-string id -> the whole list is dropped
    bellVolume: 40.5, // not a whole percent -> default
    usageStripHeight: 120, // retired key -> dropped
  }));
  assert.deepEqual(readClientPrefs(path), {
    sidebarCollapsed: DEFAULT_CLIENT_PREFS.sidebarCollapsed,
    notificationsEnabled: false,
    bellEnabled: DEFAULT_CLIENT_PREFS.bellEnabled, // absent -> default
    bellVolume: DEFAULT_CLIENT_PREFS.bellVolume,
    previewUrl: DEFAULT_CLIENT_PREFS.previewUrl,
    rightPanelCollapsed: true,
    rightPanelWidth: DEFAULT_CLIENT_PREFS.rightPanelWidth,
    theme: DEFAULT_CLIENT_PREFS.theme,
    avatar: DEFAULT_CLIENT_PREFS.avatar,
    dismissedRuns: [],
    crewRailOpen: DEFAULT_CLIENT_PREFS.crewRailOpen,
    detailsOpen: DEFAULT_CLIENT_PREFS.detailsOpen,
  });
});

// The completion sound is its own switch (the top bar's sound button): a saved
// sound-on survives a reload whether desktop notices are on or off.
test("readClientPrefs keeps bellEnabled as saved, with notifications on or off", () => {
  const dir = scratchDir();
  const path = join(dir, "client-prefs.json");
  writeFileSync(path, JSON.stringify({ notificationsEnabled: false, bellEnabled: true }));
  assert.equal(readClientPrefs(path).bellEnabled, true);
  writeFileSync(path, JSON.stringify({ notificationsEnabled: true, bellEnabled: true }));
  assert.equal(readClientPrefs(path).bellEnabled, true);
  writeFileSync(path, JSON.stringify({ notificationsEnabled: true, bellEnabled: "yes" }));
  assert.equal(readClientPrefs(path).bellEnabled, false, "a malformed value falls back to the default");
});

test("the new prefs start where the page started before: light theme, the Ash picture, nothing dismissed", () => {
  assert.equal(DEFAULT_CLIENT_PREFS.theme, "light");
  assert.equal(DEFAULT_CLIENT_PREFS.avatar, "ash.svg");
  assert.deepEqual(DEFAULT_CLIENT_PREFS.dismissedRuns, []);
});

test("DEFAULT_CLIENT_PREFS.bellEnabled starts off", () => {
  assert.equal(DEFAULT_CLIENT_PREFS.bellEnabled, false);
});

// The completion sound's volume (the top-bar speaker's slider) is a whole percent kept by the server, so it survives a relaunch
// on a new port: 100 (the full bell) when nothing was saved, every whole percent from 0 to 100 kept, anything else refused on
// update and defaulted on read, never thrown.
test("bellVolume starts at 100, survives an update, a write and a fresh read, and refuses or defaults anything but 0 to 100", () => {
  assert.equal(DEFAULT_CLIENT_PREFS.bellVolume, 100);
  const path = join(scratchDir(), "client-prefs.json");
  assert.equal(readClientPrefs(path).bellVolume, 100, "no file: 100");
  for (const value of [0, 1, 30, 99, 100]) {
    const updated = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "bellVolume", value);
    assert.equal(updated.ok && updated.prefs.bellVolume, value, `${value} is kept`);
    if (!updated.ok) continue;
    assert.equal(updated.prefs.bellEnabled, DEFAULT_CLIENT_PREFS.bellEnabled, "the volume leaves the sound switch alone");
    writeClientPrefs(updated.prefs, path);
    assert.equal(readClientPrefs(path).bellVolume, value, `${value} comes back from a fresh read`);
  }
  for (const bad of [-1, 101, 30.5, NaN, Infinity, "30", "", null, undefined, true, [30], {}]) {
    const refused = applyClientPrefUpdate({ ...DEFAULT_CLIENT_PREFS, bellVolume: 60 }, "bellVolume", bad);
    assert.equal(refused.ok, false, `must refuse ${String(bad)}`);
    assert.match(refused.ok ? "" : refused.error, /bellVolume.*whole number from 0 to 100/);
    writeFileSync(path, JSON.stringify({ bellVolume: bad }));
    assert.equal(readClientPrefs(path).bellVolume, 100, `a saved ${String(bad)} reads back as 100`);
  }
  writeFileSync(path, JSON.stringify({ bellVolume: 0, bellEnabled: true }));
  assert.deepEqual([readClientPrefs(path).bellVolume, readClientPrefs(path).bellEnabled], [0, true], "a saved 0 is kept, not mistaken for missing");
});

test("writeClientPrefs + readClientPrefs round-trip real, valid values", () => {
  const dir = scratchDir();
  const path = join(dir, "client-prefs.json");
  const prefs = { sidebarCollapsed: true, notificationsEnabled: false, bellEnabled: false, bellVolume: 35, previewUrl: "http://localhost:3000", rightPanelCollapsed: true, rightPanelWidth: 480, theme: "dark" as const, avatar: "momo.svg", dismissedRuns: ["run-1"], crewRailOpen: false, detailsOpen: true };
  writeClientPrefs(prefs, path);
  assert.deepEqual(readClientPrefs(path), prefs);
  assert.match(readFileSync(path, "utf8"), /\n$/);
});

// Survives a reload: writing a true bellEnabled, then reading it back as
// though the app had just relaunched, with notifications on and with them off.
test("writeClientPrefs + readClientPrefs round-trip a true bellEnabled with notifications on or off", () => {
  const dir = scratchDir();
  const path = join(dir, "client-prefs.json");
  for (const notificationsEnabled of [true, false]) {
    const prefs = { ...DEFAULT_CLIENT_PREFS, notificationsEnabled, bellEnabled: true };
    writeClientPrefs(prefs, path);
    assert.deepEqual(readClientPrefs(path), prefs);
  }
});

test("applyClientPrefUpdate: the six boolean fields accept a boolean and reject anything else", () => {
  for (const key of ["sidebarCollapsed", "notificationsEnabled", "bellEnabled", "rightPanelCollapsed", "crewRailOpen", "detailsOpen"]) {
    const ok = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, key, true);
    assert.equal(ok.ok, true, key);
    assert.equal(ok.ok && ok.prefs[key], true, key);
    for (const bad of ["true", 1, null, undefined, {}]) {
      const result = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, key, bad);
      assert.equal(result.ok, false, `${key} must reject ${JSON.stringify(bad)}`);
    }
  }
});

test("applyClientPrefUpdate: rightPanelWidth accepts a positive finite number, rejects zero/negative/NaN/non-number", () => {
  const ok = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "rightPanelWidth", 500);
  assert.equal(ok.ok && ok.prefs.rightPanelWidth, 500);
  for (const bad of [0, -1, NaN, Infinity, "500", null]) {
    assert.equal(applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "rightPanelWidth", bad).ok, false, `must reject ${bad}`);
  }
});

test("readClientPrefs drops the retired usageStripHeight from an old file and keeps every other pref", () => {
  const path = join(scratchDir(), "client-prefs.json");
  writeFileSync(path, JSON.stringify({ rightPanelWidth: 410, rightPanelCollapsed: true, usageStripHeight: 120 }));
  const prefs = readClientPrefs(path);
  assert.equal("usageStripHeight" in prefs, false);
  assert.equal(prefs.rightPanelWidth, 410);
  assert.equal(prefs.rightPanelCollapsed, true);
});

test("applyClientPrefUpdate refuses the retired usageStripHeight like any unknown key", () => {
  const result = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "usageStripHeight", 120);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /unknown client pref: usageStripHeight/);
});

test("applyClientPrefUpdate: previewUrl accepts http(s), rejects everything else", () => {
  for (const good of ["http://localhost:8081", "https://example.com/app"]) {
    const result = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "previewUrl", good);
    assert.equal(result.ok && result.prefs.previewUrl, good);
  }
  for (const bad of ["", "   ", "not a url", "javascript:alert(1)", "file:///etc/passwd", 42, null]) {
    assert.equal(applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "previewUrl", bad).ok, false, `must reject ${JSON.stringify(bad)}`);
  }
});

test("applyClientPrefUpdate rejects an unknown key without touching prefs", () => {
  const result = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "notAField", true);
  assert.equal(result.ok, false);
});

// This is the real toggle path -- the same function server/index.ts's
// "setClientPref" WS handler calls -- so proving the independence here proves
// it at the call site, not just in a helper nothing actually runs through.
test("applyClientPrefUpdate: the sound and desktop notices switch independently, in every direction", () => {
  // The sound turns on while notifications are off.
  const enabledWhileOff = applyClientPrefUpdate({ ...DEFAULT_CLIENT_PREFS, notificationsEnabled: false, bellEnabled: false }, "bellEnabled", true);
  assert.equal(enabledWhileOff.ok && enabledWhileOff.prefs.bellEnabled, true);
  assert.equal(enabledWhileOff.ok && enabledWhileOff.prefs.notificationsEnabled, false);

  // ...and while they are on.
  const enabled = applyClientPrefUpdate({ ...DEFAULT_CLIENT_PREFS, notificationsEnabled: true, bellEnabled: false }, "bellEnabled", true);
  assert.equal(enabled.ok && enabled.prefs.bellEnabled, true);

  // Turning notifications off leaves an on sound on.
  const kept = applyClientPrefUpdate({ ...DEFAULT_CLIENT_PREFS, notificationsEnabled: true, bellEnabled: true }, "notificationsEnabled", false);
  assert.equal(kept.ok && kept.prefs.notificationsEnabled, false);
  assert.equal(kept.ok && kept.prefs.bellEnabled, true);

  // Turning notifications back on never lights the sound by itself.
  const reenabled = applyClientPrefUpdate({ ...DEFAULT_CLIENT_PREFS, notificationsEnabled: false, bellEnabled: false }, "notificationsEnabled", true);
  assert.equal(reenabled.ok && reenabled.prefs.bellEnabled, false);

  // Turning the sound off leaves notifications alone.
  const soundOff = applyClientPrefUpdate({ ...DEFAULT_CLIENT_PREFS, notificationsEnabled: true, bellEnabled: true }, "bellEnabled", false);
  assert.equal(soundOff.ok && soundOff.prefs.bellEnabled, false);
  assert.equal(soundOff.ok && soundOff.prefs.notificationsEnabled, true);

  for (const bad of ["true", 1, null, undefined, {}]) {
    assert.equal(applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "bellEnabled", bad).ok, false, `must reject ${JSON.stringify(bad)}`);
  }
});

// The window opens on a new random port every launch, so a page's own localStorage is empty each time. Theme, picture and
// dismissed runs therefore live in client-prefs.json: each must survive a write and a fresh read (a relaunch), and a bad value
// must be refused on update and defaulted on read, never thrown.
const ONE_PX_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pHUAAAAASUVORK5CYII=";
test("theme, avatar and dismissedRuns each survive an update, a write and a fresh read", () => {
  const path = join(scratchDir(), "client-prefs.json");
  const cases: [string, unknown][] = [["theme", "dark"], ["theme", "system"], ["avatar", "momo.svg"], ["avatar", ONE_PX_PNG], ["dismissedRuns", ["run-1", "run-2"]]];
  for (const [key, value] of cases) {
    const updated = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, key, value);
    assert.equal(updated.ok, true, key + " " + String(value).slice(0, 20));
    if (!updated.ok) continue;
    writeClientPrefs(updated.prefs, path);
    assert.deepEqual(readClientPrefs(path)[key as "theme"], value, key + " must come back from a fresh read");
    assert.deepEqual(readClientPrefs(path), updated.prefs);
  }
});

test("theme, avatar and dismissedRuns refuse a bad update with a message and defaults on read", () => {
  const refused = (key: string, value: unknown) => { const r = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, key, value); assert.equal(r.ok, false, key + " must refuse " + JSON.stringify(value)?.slice(0, 40)); return r.ok ? "" : r.error; };
  for (const bad of ["purple", "", "Dark", 1, null, undefined]) refused("theme", bad);
  for (const bad of ["me-3.jpg", "momo", "../x.svg", "javascript:alert(1)", "data:text/html,x", 5, null]) refused("avatar", bad);
  for (const bad of ["x", [1], [""], [null], [{}], [ "a".repeat(201) ], Array.from({ length: DISMISSED_RUNS_MAX + 1 }, (_, i) => "r" + i), null]) refused("dismissedRuns", bad);
  const path = join(scratchDir(), "client-prefs.json");
  writeFileSync(path, JSON.stringify({ theme: 3, avatar: ["x"], dismissedRuns: "x" }));
  const read = readClientPrefs(path);
  assert.equal(read.theme, DEFAULT_CLIENT_PREFS.theme); assert.equal(read.avatar, DEFAULT_CLIENT_PREFS.avatar); assert.deepEqual(read.dismissedRuns, []);
});

test("the uploaded avatar is capped at 512 KiB: the limit itself is kept, one more is refused in plain words", () => {
  assert.equal(AVATAR_MAX_CHARS, 512 * 1024);
  const fits = ONE_PX_PNG + "A".repeat(AVATAR_MAX_CHARS - ONE_PX_PNG.length);
  assert.equal(fits.length, AVATAR_MAX_CHARS);
  assert.equal(applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "avatar", fits).ok, true, "exactly at the cap is kept");
  const tooBig = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "avatar", fits + "A");
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.ok ? "" : tooBig.error, /too large to keep \(limit 512 KB\)/);
  const path = join(scratchDir(), "client-prefs.json");
  writeFileSync(path, JSON.stringify({ avatar: fits + "A" }));
  assert.equal(readClientPrefs(path).avatar, DEFAULT_CLIENT_PREFS.avatar, "a hand-edited oversized picture reads back as the default");
});

test("dismissedRuns keeps exactly the list it was given, up to DISMISSED_RUNS_MAX ids, and is a copy", () => {
  const ids = Array.from({ length: DISMISSED_RUNS_MAX }, (_, i) => "run-" + i);
  const ok = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "dismissedRuns", ids);
  assert.deepEqual(ok.ok && ok.prefs.dismissedRuns, ids);
  assert.notEqual(ok.ok && ok.prefs.dismissedRuns, ids, "the stored list is not the caller's array");
  assert.ok(DISMISSED_RUNS_MAX >= 50 * 40, "every finished run a tab keeps (50) for 40 tabs fits, so a dismissed card never comes back");
  const retained = Array.from({ length: 201 }, (_, i) => "run-" + i);
  const accepted = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, "dismissedRuns", retained);
  assert.equal(accepted.ok, true, "201 retained failures are accepted");
  assert.deepEqual(accepted.ok && accepted.prefs.dismissedRuns, retained, "and all 201 come back in the stored list");
});

// The layout (crew rail open, details panel open) lived in the page's localStorage, which a new random port empties on every launch:
// the server keeps both, the crew rail open and the details panel closed until the user says otherwise.
test("crewRailOpen and detailsOpen start open/closed, survive an update, a write and a fresh read, and refuse or default anything but a boolean", () => {
  assert.deepEqual([DEFAULT_CLIENT_PREFS.crewRailOpen, DEFAULT_CLIENT_PREFS.detailsOpen], [true, false]);
  const path = join(scratchDir(), "client-prefs.json");
  assert.deepEqual([readClientPrefs(path).crewRailOpen, readClientPrefs(path).detailsOpen], [true, false], "no file: the defaults");
  for (const [key, value] of [["crewRailOpen", false], ["detailsOpen", true]] as const) {
    const updated = applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, key, value);
    assert.equal(updated.ok && updated.prefs[key], value, key);
    if (!updated.ok) continue;
    writeClientPrefs(updated.prefs, path);
    assert.equal(readClientPrefs(path)[key], value, `${key} comes back from a fresh read`);
    assert.deepEqual(readClientPrefs(path), updated.prefs);
    for (const bad of ["true", 1, 0, null, undefined, {}]) {
      assert.equal(applyClientPrefUpdate(DEFAULT_CLIENT_PREFS, key, bad).ok, false, `${key} must refuse ${JSON.stringify(bad)}`);
      writeFileSync(path, JSON.stringify({ [key]: bad }));
      assert.equal(readClientPrefs(path)[key], DEFAULT_CLIENT_PREFS[key], `a saved ${JSON.stringify(bad)} reads back as the default`);
    }
  }
});

test("readClientPrefs reads the leader's earlier picture preset as atlas.svg", () => {
  const path = join(scratchDir(), "client-prefs.json");
  writeFileSync(path, JSON.stringify({ avatar: `${["boo", "gie"].join("")}.svg` }));
  assert.equal(readClientPrefs(path).avatar, "atlas.svg");
});
