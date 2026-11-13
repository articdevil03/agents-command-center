import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWithRetry } from "../scripts/mutation-proof.mjs";
import { listen, proxyServer, shutProxy, workspaces } from "./browser-helpers.ts";
import { idleFixedState, withActiveFixedRun, withRetainedFixedRun, withUnconfirmedStop } from "./browser-fixed-steps.ts";
import { taskFixture } from "./pack18-editor-task-fixture.ts";
import { FIXED_CREW } from "../server/fixed-crew/roster.ts";
import { validateFixedCrew } from "../server/fixed-crew/preferences.ts";
import { B2_EARLY_NAMES } from "./browser-real-steps-b2.ts";
import { assertExactChecks, c2EarlyNames, c2FullNames, C2_APPROVAL_CHECKS, C2_R1_NAMES, COLLISION_CHECKS, exactCheckDiff, PACK3_CHECKS, PACK3_FIXED_PICKER_CHECKS } from "./browser-constants.ts";

// Pure checks (no server, no browser) on the shared fixed-crew browser fixtures: the seed, the scenario helpers, the page-side operations and the fake transport.
const root = join(import.meta.dirname, "..");
const lf = (path: string) => readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
function withSeed<T>(body: (data: any, folder: string) => Promise<T> | T): Promise<T> {
  const temp = mkdtempSync(join(tmpdir(), "cc-bfix-"));
  return Promise.resolve().then(() => body(workspaces(temp), temp)).finally(() => removeWithRetry(temp));
}
const tabsOf = (data: any) => data.projects.flatMap((project: any) => project.tabs);

test("BFIX seed: every saved tab is a valid fixed tab with its own crew, the known positions and only cli, model and effort", () => withSeed((data) => {
  const tabs = tabsOf(data);
  assert.deepEqual(tabs.map((tab: any) => tab.id), ["alpha-dev", "alpha-design", "beta-dev"], "the three seeded tab ids");
  assert.deepEqual(tabs.map((tab: any) => tab.name), ["Development", "Design", "Development"]);
  const known = FIXED_CREW.map((seat) => seat.slot) as string[];
  for (const tab of tabs) {
    assert.equal(tab.setupName, "Fixed crew"); assert.deepEqual([tab.crew, tab.steps, tab.lookPause, "process" in tab], [[], [], false, false], `${tab.id}: no legacy crew, steps or process`);
    assert.deepEqual(validateFixedCrew(tab.fixedCrew), tab.fixedCrew, `${tab.id}: the server's own validation accepts the fixed crew unchanged`);
    assert.deepEqual(Object.keys(tab.fixedCrew.preferences).sort(), [...known].sort(), `${tab.id}: all ${known.length} known positions`);
    const assigned = Object.entries(tab.fixedCrew.preferences).filter(([, preference]: any) => preference.assignment);
    assert.ok(assigned.length >= 2 && assigned.some(([slot]) => slot === "leader"), `${tab.id}: explicit assignments including the leader`);
    for (const [slot, preference] of assigned as any) assert.deepEqual(Object.keys(preference.assignment).sort(), ["cli", "effort", "model"], `${tab.id}.${slot}: no pic, role, canWrite or runtime fields`);
  }
  assert.ok(tabs[0].fixedCrew.preferences.fixer1.assignment && !("fixer" in tabs[0].fixedCrew.preferences), "fixer1, never fixer");
  const owners = new Set(tabs.map((tab: any) => tab.fixedCrew)), prefs = new Set(tabs.map((tab: any) => tab.fixedCrew.preferences));
  assert.equal(owners.size, 3); assert.equal(prefs.size, 3, "no preference object is shared between tabs");
  assert.notEqual(tabs[0].fixedCrew.preferences.leader.assignment, tabs[2].fixedCrew.preferences.leader.assignment, "equal assignments are still separate objects");
  // Control: a seed with a field the contract forbids is refused, so the checks above can go red.
  const planted = structuredClone(tabs[0].fixedCrew); planted.preferences.leader.assignment.canWrite = true;
  assert.throws(() => validateFixedCrew(planted), /Unknown or locked crew field/);
  const legacy = structuredClone(tabs[0].fixedCrew); legacy.preferences.fixer = legacy.preferences.fixer1;
  assert.throws(() => validateFixedCrew(legacy), /Unknown or locked crew field/);
}));

test("BFIX scenarios: one active run, retained history and an unconfirmed stop keep every view consistent, and never claim two heavy runs", () => withSeed((data) => {
  const idle = idleFixedState(data), before = JSON.stringify(idle);
  const keys = tabsOf(idle).flatMap((tab: any) => tab.crew.map((seat: any) => seat.seatKey));
  assert.equal(new Set(keys).size, keys.length); assert.ok(keys.every((key: string) => /^(alpha-dev|alpha-design|beta-dev)\./.test(key)));
  assert.ok(tabsOf(idle).every((tab: any) => tab.processState.tabId === tab.id && !tab.derived.busy && Object.values(tab.fixedCrew.busy).every((busy) => busy === false)), "the idle baseline is idle and owned per tab");
  const active = withActiveFixedRun(idle), tab = tabsOf(active)[0], other = tabsOf(active)[2];
  assert.equal(JSON.stringify(idle), before, "the input state is never changed");
  const live = tab.processState.runs.filter((run: any) => run.status === "working");
  assert.deepEqual([tab.runs.map((run: any) => run.runId), live.map((run: any) => run.id), tab.crew.find((seat: any) => seat.slot === "coder").runs, tab.derived.runViews.liveBySeat.coder.map((run: any) => run.id)], [["fixed-run-1"], ["fixed-run-1"], ["fixed-run-1"], ["fixed-run-1"]]);
  assert.deepEqual([tab.runs[0].seatKey, tab.derived.busy, tab.fixedCrew.busy.coder, tab.fixedCrew.busy.leader, tab.derived.workingSeats.map((seat: any) => seat.slotId), tab.processState.seats.find((seat: any) => seat.slotId === "coder").status], ["alpha-dev.coder", true, true, false, ["coder"], "working"]);
  assert.equal(other.derived.busy || other.runs.length > 0, false, "another tab is untouched");
  assert.throws(() => withActiveFixedRun(active, "alpha-dev", "reviewer1", "second"), /already has an active run/, "a second heavy run on one fixed tab is refused");
  assert.throws(() => withActiveFixedRun(idle, "alpha-dev", "designCoder"), /has an assigned model/, "an unassigned position cannot run");
  const kept = tabsOf(withRetainedFixedRun(idle, "alpha-dev", "coder", "failed"))[0];
  assert.deepEqual([kept.derived.busy, kept.derived.runViews.history.map((run: any) => [run.id, run.status]), kept.derived.runViews.liveBySeat, kept.runs[0].status, kept.runs[0].seatKey], [false, [["fixed-history-1", "failed"]], {}, "failed", "alpha-dev.coder"]);
  const stuck = withUnconfirmedStop(idle);
  assert.deepEqual(stuck.launchSafety.uncertain, [{ seatId: "alpha-dev.coder", pid: 4242, runId: "fixed-unconfirmed-1" }]);
  assert.equal(tabsOf(stuck)[0].derived.busy, true, "an unconfirmed stop is still a working run");
}));

// The fake socket and the page-side operations run in a vm with only what they touch, so no Chrome is needed to see their replies and their request identities.
async function fakePage(seed: any, tasks: Record<string, unknown>) {
  const proxy = proxyServer(1, { folder: "x", mode: "fake", seed, fixedTasks: tasks }, "");
  try {
    const html = await fetch(`http://127.0.0.1:${await listen(proxy.proxy)}/__audit?mode=fake`).then((response) => response.text());
    const source = html.split("<script>").find((part) => part.includes("class FakeWebSocket"))?.split("</script>")[0];
    assert.ok(source, "the fake transport script was found in the audit page");
    const context: any = { console: { error() {}, log() {} }, URLSearchParams, structuredClone, setTimeout, clearTimeout, Date, location: { search: "?mode=fake" }, MediaQueryList: class { addEventListener() {} }, Storage: class {}, addEventListener() {} };
    context.window = context; vm.createContext(context); vm.runInContext(source, context);
    const received: any[] = [], assignments: any[] = [];
    context.__ccHarness = { fixed: { changeAssignment: (...args: unknown[]) => assignments.push(args) } };
    const socket = new context.WebSocket();
    socket.addEventListener("message", (event: any) => received.push(JSON.parse(event.data)));
    await new Promise((ok) => setTimeout(ok, 10));
    const ask = async (message: unknown) => { const start = received.length; socket.send(JSON.stringify(message)); await new Promise((ok) => setTimeout(ok, 10)); return received.slice(start); };
    return { context, ask, assignments };
  } finally { shutProxy(proxy); }
}

test("BFIX transport: fixed replies carry the request, tab and task identity, holds stay holds and nothing is accepted on its own", () => withSeed(async (data, temp) => {
  const state = idleFixedState(data), task = taskFixture(temp, "alpha-dev", "planned");
  const { context, ask, assignments } = await fakePage(state, { "alpha-dev": task });
  const hello = await ask({ type: "hello" });
  assert.deepEqual(hello[0].projects.flatMap((project: any) => project.tabs.map((tab: any) => tab.id)), ["alpha-dev", "alpha-design", "beta-dev"]);
  const read = await ask({ type: "getFixedTask", requestId: "r-read", tabId: "alpha-dev" });
  assert.deepEqual([read[0].type, read[0].requestId, read[0].tabId, read[0].task.id, read[0].task.planVersion, read[0].task.recordRevision], ["fixedTask", "r-read", "alpha-dev", task.id, task.planVersion, task.recordRevision]);
  const none = await ask({ type: "getFixedTask", requestId: "r-none", tabId: "beta-dev" });
  assert.deepEqual([none[0].requestId, none[0].tabId, none[0].task], ["r-none", "beta-dev", null], "a tab without a task gets no invented one");
  context.__ccFixedTaskReply = "refuse";
  assert.deepEqual((await ask({ type: "getFixedTask", requestId: "r-bad", tabId: "alpha-dev" })).map((m: any) => [m.type, m.requestId, m.tabId]), [["error", "r-bad", "alpha-dev"]]);
  context.__ccFixedTaskReply = "hold";
  assert.deepEqual(await ask({ type: "getFixedTask", requestId: "r-held", tabId: "alpha-dev" }), [], "a held task read gets no reply");
  const assign = { type: "setCrewAssignment", requestId: "r-assign", tabId: "alpha-dev", slot: "coder", assignment: { cli: "codex", model: "gpt-6.1-sol", effort: "low" } };
  assert.deepEqual(await ask(assign), [], "with no scenario set, an assignment is neither accepted nor refused");
  context.__ccAssignmentReply = "refuse";
  assert.deepEqual((await ask(assign)).map((m: any) => [m.type, m.action, m.requestId, m.tabId]), [["error", "setCrewAssignment", "r-assign", "alpha-dev"]]);
  context.__ccAssignmentReply = "ack";
  const acked = await ask({ ...assign, type: "clearCrewAssignment", requestId: "r-clear", slot: "coder" });
  assert.deepEqual(acked.map((m: any) => [m.type, m.requestId, m.tabId]).slice(0, 1), [["actionResult", "r-clear", "alpha-dev"]]);
  assert.deepEqual(assignments, [["alpha-dev", "coder", null]], "an acknowledged clear changes exactly that tab and position");
}));

test("BFIX operations: the page-side fixed fixtures find, clone, change, busy and task exactly what they name, and fail on anything missing", () => withSeed((data, temp) => {
  const state = idleFixedState(data), delivered: any[] = [];
  const context: any = { structuredClone, JSON, Number, window: null };
  context.window = context; vm.createContext(context);
  context.__ccHarness = { fail: (message: string) => { throw new Error(message); }, check() {}, waitFor: async () => {}, text: () => "", $() {}, requireElement() {}, pressEscape() {}, pickProject() {} };
  context.__ccSeed = structuredClone(state); context.__latestState = context.__ccSeed; context.__ccFixedTasks = {}; context.__ccDeliver = (message: unknown) => delivered.push(message);
  vm.runInContext(readFileSync(join(root, "test/browser-harness/01b-fixed-fixtures.js"), "utf8"), context);
  const fixed = context.__ccHarness.fixed, seed = () => tabsOf(context.__ccSeed);
  assert.equal(fixed.findSlot("alpha-dev", "fixer1").seat.slot, "fixer1");
  assert.throws(() => fixed.findSlot("alpha-dev", "fixer"), /fixed position missing: alpha-dev\.fixer/);
  assert.throws(() => fixed.findSlot("gone", "coder"), /fixed tab missing: gone/);
  const clone = fixed.cloneIdleTab("alpha-dev", "alpha-copy", "Copy");
  assert.deepEqual([seed().length, delivered.length, clone.processState.tabId, clone.fixedTask], [4, 1, "alpha-copy", null]);
  assert.ok(clone.crew.every((seat: any) => seat.seatKey.startsWith("alpha-copy.")) && !JSON.stringify(clone).includes('"alpha-dev'), "every id and seat key is rekeyed");
  assert.notEqual(clone.fixedCrew.preferences, seed()[0].fixedCrew.preferences, "the clone owns its preferences");
  assert.throws(() => fixed.cloneIdleTab("alpha-dev", "alpha-copy", "Again"), /already exists/);
  const next = { cli: "claude", model: "claude-opus-5-5[1m]", effort: "low" };
  fixed.changeAssignment("alpha-copy", "coder", next);
  const changed = seed().find((tab: any) => tab.id === "alpha-copy");
  assert.deepEqual([changed.fixedCrew.preferences.coder.assignment.model, changed.fixedCrew.preferences.coder.source, changed.crew.find((s: any) => s.slot === "coder").model, changed.processState.seats.find((s: any) => s.slotId === "coder").effort], [next.model, "user", next.model, "low"]);
  assert.equal(seed()[0].crew.find((s: any) => s.slot === "coder").model, "gpt-6.1-sol", "the source tab keeps its own coder");
  fixed.changeAssignment("alpha-copy", "coder", null);
  assert.deepEqual([changed.fixedCrew.preferences.coder.assignment, changed.crew.some((s: any) => s.slot === "coder"), changed.processState.seats.some((s: any) => s.slotId === "coder")], [null, false, false]);
  fixed.changeAssignment("alpha-copy", "helper", next);
  assert.ok(changed.crew.some((s: any) => s.slot === "helper" && s.seatKey === "alpha-copy.helper") && changed.processState.seats.some((s: any) => s.slotId === "helper"));
  fixed.setBusy("alpha-copy", "leader", true);
  assert.deepEqual([changed.fixedCrew.busy.leader, changed.derived.busy], [true, true]);
  fixed.setBusy("alpha-copy", "leader", false);
  assert.equal(changed.derived.busy, false);
  fixed.setFixedTask("alpha-dev", taskFixture(temp, "alpha-dev", "approved"));
  const record = context.__ccFixedTasks["alpha-dev"];
  assert.equal(JSON.stringify(seed()[0].fixedTask), JSON.stringify({ taskId: record.id, planVersion: record.planVersion, detailRevision: record.recordRevision, stage: record.stage }), "the summary matches the record");
  assert.throws(() => fixed.setFixedTask("alpha-dev", { id: "x" }), /lacks an id, plan version or record revision/);
  context.__ccSeed = structuredClone(withActiveFixedRun(state)); context.__latestState = context.__ccSeed;
  assert.throws(() => fixed.cloneIdleTab("alpha-dev", "alpha-busy", "Busy"), /not an idle fixed tab/);
}));

test("BFIX monitor two: both Chrome argument arrays place the window at X 1920", () => {
  const helpers = lf("test/browser-helpers.ts"), dialog = lf("test/browser-dialog-audit.ts");
  const audit = helpers.slice(helpers.indexOf("args.chrome?.args ?? ["), helpers.indexOf("], { windowsHide", helpers.indexOf("args.chrome?.args ?? [")));
  const native = dialog.slice(dialog.indexOf("spawn(CHROME, ["), dialog.indexOf("], { windowsHide", dialog.indexOf("spawn(CHROME, [")));
  assert.ok(audit.includes("--headless=new") && audit.includes('"--window-position=1920,0"'), "the audit Chrome arguments carry the position");
  assert.ok(native.includes("--headless=new") && native.includes('"--window-position=1920,0"'), "the native-input Chrome arguments carry the position");
});

test("BFIX real render: the real-server case drives only the fixed crew, and the host expects every check it runs by name", () => {
  const harness = lf("test/browser-harness/02-real.js"), host = lf("test/browser-real-steps-layout.ts");
  const names = [...new Set([...harness.matchAll(/check\(("(?:[^"\\]|\\.)*"),/g)].map((match) => JSON.parse(match[1]) as string))];
  assert.ok(names.length > 40, `control: the scan found the harness checks (${names.length})`);
  const missing = names.filter((name) => !host.includes(JSON.stringify(name)));
  assert.deepEqual(missing, [], "every check of the real render case is a positive expectation of realAudit");
  const body = harness.split("\n").filter((line) => !line.includes("const retiredMounts")).join("\n");
  for (const retired of ["data-seat-model", "updateSeat", "useSetup", "Kind and crew", "data-use-template", "#pipe", "#tplBox", "#kindBox", "message.template", "message.kind"]) assert.equal(body.includes(retired), false, `the real render case no longer uses ${retired}`);
  for (const live of ["setCrewAssignment", "[data-fc-model]", "data-fc-new-model", "fixedCrewVersion", "crewChoices", "autoAssign", "requestId"]) assert.ok(harness.includes(live), `the real render case drives ${live}`);
  assert.ok(/chromeAudit\(\{[^}]*mode: "real"[^}]*caseName: "render"/.test(host), "the real audit runs the render case only, never the unconverted layout");
});

test("BFIX fake layout: the fake case and the layout case use only the fixed crew, and the host expects every check they run by name", () => {
  const fake = lf("test/browser-harness/03-fake.js"), layout = lf("test/browser-harness/08-layout.js"), host = lf("test/browser-real-steps-layout.ts");
  const namesOf = (source: string) => [...new Set([...source.matchAll(/check\(("(?:[^"\\]|\\.)*"),/g)].map((match) => JSON.parse(match[1]) as string))];
  const names = [...namesOf(fake), ...namesOf(layout)];
  assert.ok(names.length > 35, `control: the scan found the fake and layout checks (${names.length})`);
  assert.deepEqual(names.filter((name) => !host.includes(JSON.stringify(name))), [], "every check of the fake and layout cases is a positive expectation of layoutAuditAtWidth");
  for (const retired of ["[data-seat-model]", "updateSeat", "#pipe", "two parallel runs", 'blocked: ["alpha-dev.coder"']) assert.equal(fake.includes(retired) || layout.includes(retired), false, `the fake and layout cases no longer use ${retired}`);
  for (const live of ["seedLiveAndRetainedRecords", "alpha-dev.planner", "audit-parallel-2", "plannerSeat"]) assert.ok(fake.includes(live), `the fake case drives ${live}`);
  assert.ok(layout.includes(".rowb .model-label") && layout.includes('"gpt-6.1-sol"'), "the layout case reads the card's saved model fact");
});

test("BFIX requests, window and pack two: the three cases use only the fixed crew, and the hosts expect every check they run by name", () => {
  const files = ["06-requests-real", "13-looks-and-window", "14-pack-two"].map((name) => lf(`test/browser-harness/${name}.js`));
  const [requests, windows, pack2] = files, hosts = lf("test/browser-real-steps-layout.ts") + lf("test/browser-real-steps-packc.ts");
  const namesOf = (source: string) => [...new Set([...source.matchAll(/check\(("(?:[^"\\]|\\.)*"),/g)].map((match) => JSON.parse(match[1]) as string))];
  const names = files.flatMap(namesOf);
  assert.ok(names.length >= 30, `control: the scan found the checks of the three cases (${names.length})`);
  assert.deepEqual(names.filter((name) => !hosts.includes(JSON.stringify(name))), [], "every check of the three cases is a positive expectation of its host");
  assert.ok(/addedTab = \{.*fixedCrewVersion: 1, crewChoices: \{.*autoAssign: false \}/.test(requests) && !/kind: "dev"|template:/.test(requests), "the request destination tab is created with the fixed crew fields, no kind or template");
  for (const file of files) assert.equal(/structuredClone\([^)]*tabs\[0\]\)|\.tabs\.push\(/.test(file), false, "no id-only tab clone is left: tabs are made by the fixed clone helper");
  assert.ok(windows.includes('["beta-dev", "beta-qa", "QA"]') && windows.includes('["alpha-dev", "alpha-new", "New tab"]') && windows.includes("cloneIdleTab") && windows.includes("tab.derived.busy = !tab.activeWork"), "the window case uses the fixed clone helper and keeps its activeWork-versus-busy control");
  assert.ok(pack2.includes('cloneIdleTab("alpha-design", "alpha-lost", "Lost")') && pack2.includes("seedLiveAndRetainedRecords") && !pack2.includes("Parallel run"), "pack two clones alpha-lost with the helper and seeds one live run and one retained record, never parallel runs");
  assert.equal([...windows.matchAll(/\bcheck\(/g)].length + [...pack2.matchAll(/\bcheck\(/g)].length, 16 + 17, "the sixteen window and appearance checks and the seventeen regression checks all remain");
});

test("BFIX B2 early: seats, settings, history and notifications use only the fixed crew, and the host expects exactly the checks they run, in order", () => {
  const files = ["1-seats-and-settings", "2-leader-history-and-undo", "3-notifications-and-bell"].map((name) => lf(`test/browser-harness/04-b2-${name}.js`));
  const namesOf = (source: string) => [...source.matchAll(/check\(("(?:[^"\\]|\\.)*"),/g)].map((match) => JSON.parse(match[1]) as string);
  const names = files.flatMap(namesOf);
  assert.ok(names.length === 34 && new Set(names).size === 34, `control: the scan found the 34 early checks (${names.length})`);
  assert.deepEqual(names, B2_EARLY_NAMES, "the host expects every early check by name, in the order the page runs them");
  const body = files.join(" ");
  for (const retired of ["[data-seat-model]", "#pipe", "processState.approval", "data-process-action", "data-ask-changes", "nova.svg", "approvalTab", '[data-seat-id="fixer"]']) assert.equal(body.includes(retired), false, `the early B2 route no longer uses ${retired}`);
  for (const live of ["approveFixedRough", "data-fct-approve", "data-fct-ask", "pendingApprovals", "fixer1", "changeAssignment", "roughRevision", ".rowb .model-label"]) assert.ok(body.includes(live), `the early B2 route drives ${live}`);
  assert.ok(lf("test/browser-real.test.ts").includes('includes("b2-early")') && lf("test/browser-harness/04-b2.js").includes("runB2Early"), "the early route is explicit: named in CC_BROWSER_PHASES, never part of a default run");
});

test("BFIX B2 later: unread, races and removals use only the fixed crew, and the host expects the four retained race results by name", () => {
  const files = ["4-unread-and-avatars", "6-undo-races-and-sends", "7-switches-and-removals"].map((name) => lf(`test/browser-harness/04-b2-${name}.js`));
  const body = files.join(" "), [avatars, races, switches] = files, host = lf("test/browser-real-steps-b2.ts");
  for (const retired of ["data-seat-picture", "updateSeat", "openSeatCard", "processState.approval", "data-wait-tab", "useSetup", "data-use-template", '"process"']) assert.equal(body.includes(retired), false, `the later B2 files no longer use ${retired}`);
  assert.equal(/structuredClone\([^)]*tabs\[0\]\)|\.tabs\.push\(/.test(switches), false, "no id-only tab clone is left in the switches and removals part");
  assert.equal([...switches.matchAll(/cloneIdleTab\("/g)].length, 3, "the fallback and the two queued tabs are made by the fixed clone helper"); assert.ok(switches.includes("cloneIdleTab(pickSource, id, name)"), "Pick A, B and C are made by the same helper");
  assert.ok(switches.includes('data-wait-approval="b2-pick-approval"') && switches.includes("pendingApprovals"), "the waiting card is a real pending tool approval");
  assert.ok(races.includes('for (const kind of ["tab", "project"])') && races.includes("unknown held action kind"), "the Undo races run the two retained kinds, both read orders, and refuse any other kind");
  assert.ok(avatars.includes("uploadBytes") && avatars.includes("Your avatar upload stores the image data URL"), "the personal avatar upload and the bytes later parts use remain");
  assert.ok(host.includes("four removed-preview results, not six") && !host.includes("seat avatar presets") && !/"process"\]/.test(host), "the host expects four removed-preview results, no seat avatar and no process race");
});

test("BFIX C2 early: uploads, approvals, R6 and R7 keep their real image, file and approval paths, never the retired seat picture, process or step routes, and the host expects every named check", () => {
  const files = ["05-pack-c-5-uploads", "09-tool-approvals", "10-r6-fixes", "11-r7-fixes"].map((name) => lf(`test/browser-harness/${name}.js`));
  const [uploads, approvals, r6, r7] = files, body = files.join(" ");
  const names = files.flatMap((source) => [...source.matchAll(/check\(("(?:[^"\\]|\\.)*"),/g)].map((match) => JSON.parse(match[1]) as string));
  const expected = c2EarlyNames(1600);
  assert.ok(names.length >= 27, `control: the scan found the literal checks (${names.length})`);
  assert.deepEqual(names.filter((name) => !expected.includes(name)), [], "every literal check of the four files is a positive expectation of the early route");
  assert.equal(new Set(expected).size, expected.length, "the expected list has no duplicate");
  for (const retired of ["data-seat-picture", "updateSeat", "useSetup", "setupsBtn", "processState.approval", "stepBar", "data-open-screenshots", "openSeatCard", "avUp", "avModal", "avatarStatus", "[\"tab\", \"project\", \"process\"]"]) assert.equal(body.includes(retired), false, `the early C2 files no longer use ${retired}`);
  assert.equal(uploads.includes("/api/avatar") || r6.includes("/api/avatar"), false, "no seat avatar upload is intercepted or driven");
  for (const live of ["/api/paste-image", "/api/paste-file", "[data-open-shot]", "dataset.openShot === screenshotUpload.path", 'for (const kind of ["tab", "project"])', "unknown held action kind", "read-before-undo", "read-after-undo"]) assert.ok(uploads.includes(live), `the uploads part drives ${live}`);
  assert.ok(approvals.includes("answerApproval") && r6.includes("pointerdown") && r6.includes("repeat: true") && r6.includes("setDefaultProjectFolder") && r6.includes("sendRequest"), "the approval, pointer, key, Settings draft and request checks remain");
  assert.ok(r7.includes("example.test") && r7.includes("avatar-not-a-uuid") && r7.includes("#stagehead .av.big img"), "the seat picture check reads the crew row and the stage header, with the invalid route and remote URL falls");
  assert.ok(lf("test/browser-real.test.ts").includes('includes("c2-early")') && lf("test/browser-real-steps-packc.ts").includes('"c2-through-r7"'), "the early route is explicit: named in CC_BROWSER_PHASES, never part of a default run");
});

test("BFIX C2 approvals: the full approval route drives the fixed Settings picker and keeps its nine create, launch and refresh checks, never the retired crew picker, setup debounce, step pause or card edit routes", () => {
  const r1 = lf("test/browser-harness/12-r1-fixes.js"), pointer = lf("test/browser-dialog-seat-pointer.ts");
  const names = [...r1.matchAll(/check\(("(?:[^"\\]|\\.)*"),/g)].map((match) => JSON.parse(match[1]) as string);
  assert.equal(names.length, 10, `control: the scan found the ten R1 checks (${names.length}): one picker identity and nine create, launch and refresh checks`);
  assert.deepEqual(names, C2_R1_NAMES, "the full case expects every R1 check by name, in the order the page runs them");
  assert.deepEqual(C2_R1_NAMES.filter((name) => !C2_APPROVAL_CHECKS.includes(name)), [], "every R1 check is also a positive expectation of the approval list");
  assert.equal(new Set(names).size, names.length, "no duplicate R1 check name");
  for (const retired of ["useSetup", "Kind and crew", "data-use-template", "openTabMenu", "clickMenuItem", "stepBar", "processState.approval", "advanceStep", "reviewFindings", "finishFix", "data-process-action", "stepActs"]) assert.equal(r1.includes(retired), false, `the R1 file no longer uses ${retired}`);
  for (const live of ["setCrewAssignment", "[data-fc-model]", "cloneIdleTab", "dropAndReconnect", "Outcome unknown", "Retry save", "Not sure it was created", "data-settings-refresh"]) assert.ok(r1.includes(live), `the R1 file drives ${live}`);
  assert.equal(r1.includes("__ccAssignmentReply") || /type: "actionResult", action: "(addTab|addProject)"/.test(r1), false, "the deliberately lost creation requests are never acknowledged");
  for (const retired of ["[data-seat-model]", "[data-pop-back]", "Picture, Model, Back, Escape"]) assert.equal(pointer.replace('#seatPop [data-seat-model],#seatPop [data-seat-rename],#seatPop [data-pop-back],#seatPop [data-advisor]', "").includes(retired), false, `the seat pointer probes no longer drive ${retired}`);
  for (const live of ["realClick", "mousePressed", "data-fc-model", "#setModal", "fixedCrew.busy.coder", "pointer-run-1", "data-seat-unblock", "data-stop-seat", "collapsed", "decoyIn"]) assert.ok(pointer.includes(live), `the seat pointer probes keep ${live}`);
});

test("BFIX fixed picker expected check names", () => {
  const source = lf("test/browser-harness/15-pack-three-2b.js");
  const found = [...source.matchAll(/\bcheck\(("(?:[^"\\]|\\.)*"),/g)].map((match) => JSON.parse(match[1]) as string);
  assert.ok(found.length > 0, `control: the scan found the fixed lock and Escape checks; matched ${JSON.stringify(found)}`);
  assert.equal(found.length, 3, `the three fixed lock and Escape checks; matched ${JSON.stringify(found)}`);
  assert.equal(new Set(found).size, found.length, `no duplicate check name; matched ${JSON.stringify(found)}`);
  assert.deepEqual(found, PACK3_FIXED_PICKER_CHECKS, "the page runs exactly the expected fixed picker checks, in order");
  const at = PACK3_CHECKS.indexOf(found[0]);
  assert.ok(at >= 0 && JSON.stringify(PACK3_CHECKS.slice(at, at + 3)) === JSON.stringify(found), "the Pack 3 expected list holds them together");
  assert.equal(new Set(PACK3_CHECKS).size, PACK3_CHECKS.length, "no duplicate in the Pack 3 expected list");
  for (const retired of ["data-seat-model", "data-seat-rename", "[data-fixer]", "updateSeat", "data-advisor", "leaderFree"]) assert.equal(source.includes(retired), false, `the lock part no longer uses ${retired}`);
  assert.ok(source.includes("[data-fc-model]") && source.includes("fixed.setBusy") && source.includes('setBusy("leader", true)'), "the lock part drives the fixed chips and the busy observation, the leader included");
});

// The exact comparison every audit host uses, and the full Pack C inventory it compares against, with no browser: each defect kind must go red, and the controls show the comparison can fail.
test("BFIX exact expected-name comparison: a missing, extra, renamed, duplicated, reordered or failed check each fails, and the full Pack C inventory is consistent", () => {
  const expected = ["a", "b", "c"], ran = (names: string[]) => names.map((name) => ({ name, passed: true }));
  assertExactChecks("control equal", ran(expected), expected, true);
  assertExactChecks("control unordered", ran(["c", "a", "b"]), expected);
  const reds: Array<[string, string[]]> = [["missing", ["a", "b"]], ["extra", ["a", "b", "c", "d"]], ["renamed", ["a", "b", "RENAMED c"]], ["duplicate", ["a", "b", "c", "c"]], ["duplicate replacing another", ["a", "b", "b"]]];
  for (const [kind, names] of reds) assert.throws(() => assertExactChecks(kind, ran(names), expected), assert.AssertionError, `a ${kind} name must fail the comparison`);
  assert.throws(() => assertExactChecks("order", ran(["c", "a", "b"]), expected, true), assert.AssertionError, "a reordered list fails when the order is required");
  assert.throws(() => assertExactChecks("failed", [{ name: "a", passed: true }, { name: "b", passed: false }, { name: "c", passed: true }], expected), assert.AssertionError, "a result that did not pass fails the comparison");
  assert.throws(() => assertExactChecks("unmarked", [{ name: "a" }, { name: "b" }, { name: "c" }], expected), assert.AssertionError, "a result with no passed mark fails the comparison");
  assert.deepEqual(exactCheckDiff(["a", "a", "x"], ["a", "b"]), { missing: ["b"], extra: ["x"], duplicates: ["a"] }, "the diff names each kind");
  for (const width of [1600, 1280, 1024]) {
    const full = c2FullNames(width);
    assert.equal(full.length, 2 + c2EarlyNames(width).length + C2_R1_NAMES.length, `the full Pack C case is the collision pair, the early route and R1 at ${width}px`);
    assert.equal(full.length, 84, `the full Pack C case expects 84 checks at ${width}px`);
    assert.equal(new Set(full).size, full.length, `no duplicate in the full Pack C list at ${width}px`);
    assert.deepEqual(full.slice(0, 2), COLLISION_CHECKS, "the collision pair runs first");
    assert.deepEqual(C2_APPROVAL_CHECKS.filter((name) => !full.includes(name)), [], `the approval list is part of the full case at ${width}px`);
    assert.ok(full.filter((name) => name.includes("px")).every((name) => !/\b\d{3,4}px\b/.test(name) || name.includes(`${width}px`)), `every width-specific name carries ${width}px`);
  }
  assert.equal(c2FullNames(1600).filter((name) => name.includes("1600px")).length, c2FullNames(1280).filter((name) => name.includes("1280px")).length, "the same width-specific checks run at every width");
  assert.equal(new Set(PACK3_CHECKS).size, PACK3_CHECKS.length, "no duplicate in the Pack 3 expected list");
});

// The action-local reply waits of the Enter and chip checks: the actual predicates are cut out of the harness file and run against reply lists.
function replyWait(label: string, marker: string) {
  const source = lf("test/browser-harness/15-pack-three-2d.js");
  const found = [...source.matchAll(new RegExp(`waitFor\\((\\(\\) => window\\.__received\\.slice\\(\\w+\\)\\.some\\(.*?\\)), "the reply to the ${marker}"\\)`, "g"))];
  assert.equal(found.length, 1, `${label}: the reply wait for "${marker}" was found exactly once; matched ${found.length}`);
  const predicate = new Function("window", "receivedFrom", "from", "sent", `return (${found[0][1]})();`) as (...args: unknown[]) => boolean;
  const done = (tabId: string) => ({ type: "chatDone", tabId });
  const sent = [{ tabId: "alpha-dev" }], received: any[] = [done("alpha-dev"), { type: "state" }]; // an OLD completion sits before this action's start
  const receivedStart = received.length; // the action's own start in the received list; the sent list started at 0, a different index
  const settles = () => predicate({ __received: received }, receivedStart, 0, sent);
  assert.equal(settles(), false, `${label}: an old completion before the action's own start does not settle`);
  received.push(done("alpha-design"));
  assert.equal(settles(), false, `${label}: a new completion for another tab does not settle`);
  received.push({ type: "chatDelta", tabId: "alpha-dev" });
  assert.equal(settles(), false, `${label}: a new message that is not a completion does not settle`);
  received.push(done("alpha-dev"));
  assert.equal(settles(), true, `${label}: a new matching completion settles`);
}
test("BFIX action-local reply wait plain Enter", () => replyWait("plain Enter", "plain Enter"));
test("BFIX action-local reply wait suggestion chip", () => replyWait("suggestion chip", "chip"));

// The finally sequence of the browser entries, executed with stand-ins for the stop and the folder removal (no process is stopped, no file removed).
function teardownOf(file: string): string {
  const text = lf(file), opening = "} finally {\n", start = text.lastIndexOf(opening);
  assert.ok(start >= 0, `${file}: the finally block was not found`);
  const end = text.indexOf("\n  }\n});", start);
  assert.ok(end > start, `${file}: the end of the finally block was not found`);
  const body = text.slice(start + opening.length, end);
  assert.ok(/stopServer\(child\)/.test(body) && /rmSync\(temp/.test(body), `${file}: the block no longer holds the stop and the removal: ${body}`);
  return body;
}
test("BFIX teardown preserves cleanup after failed stop", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const file of ["test/browser-real.test.ts", "test/browser-approval.test.ts"]) {
    const run = new AsyncFunction("proxy", "stopServer", "child", "rmSync", "temp", teardownOf(file));
    const failure = new Error("stop failed"); let stops = 0, cleanups = 0, closed = 0;
    await assert.rejects(run({ wss: { close: () => closed++ }, proxy: { close: () => closed++ } }, async () => { stops++; throw failure; }, {}, () => { cleanups++; }, "T"), (error: unknown) => error === failure, `${file}: the stop's own rejection still surfaces`);
    assert.deepEqual([stops, closed], [1, 2], `${file}: the stop ran once after the proxy was closed`);
    assert.equal(cleanups, 1, `${file}: the temp folder removal ran exactly once after the failed stop`);
  }
});
