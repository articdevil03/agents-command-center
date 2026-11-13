import assert from "node:assert/strict";
import { resolve } from "node:path";
import { newAppKey } from "./temp-root.ts";

export const HOST = "127.0.0.1";
// One app key for every server this file spawns; each spawn passes it as CC_APP_KEY and the page gets it from window.cc.appKey().
export const APP_KEY = newAppKey();
export const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
export const REPO = resolve(".");
// Real milliseconds a Chrome audit may take beyond its virtual-time budget (the cap is virtual + this). The old 60 s left Pack C (60 s virtual) a cap of 120 s,
// which a parallel `npm test` once passed. Measured 2026-10-13 on an ordinary PC: the slowest audit, Pack C, takes 25-28 s of real time, the whole file 2.5-3 minutes.
// A Chrome that hangs still ends at its cap (a test below proves it, and that nothing of it is left running), so more headroom only delays that verdict.
export const CHROME_CAP_HEADROOM_MS = 120_000;

// Mutation sweeps run one part of this suite at a time: CC_BROWSER_PHASES=b2,titlebar (real, layout, titlebar, pack2, b2, packc, pack3, looks, approvals) and CC_BROWSER_WIDTHS=1600. Unset, everything runs.
export const phase = (name: string) => !process.env.CC_BROWSER_PHASES || process.env.CC_BROWSER_PHASES.split(",").includes(name);
// Anything that narrows the run is said loudly, and under `npm test` it fails: a leftover variable must never turn most of the browser coverage into a quiet pass.
export const NARROWED = [process.env.CC_BROWSER_PHASES && `CC_BROWSER_PHASES=${process.env.CC_BROWSER_PHASES}`, process.env.CC_BROWSER_WIDTHS && `CC_BROWSER_WIDTHS=${process.env.CC_BROWSER_WIDTHS}`, process.env.CC_BROWSER_DEBUG_ONLY === "1" && "CC_BROWSER_DEBUG_ONLY=1"].filter(Boolean) as string[];
if (NARROWED.length) console.log(`!!!!! NOT A FULL BROWSER RUN: ${NARROWED.join(" ")} skips part of this suite !!!!!`);
export function narrowedRunError(env: NodeJS.ProcessEnv, narrowed: string[]): string | null {
  return narrowed.length && env.npm_lifecycle_event === "test" ? `npm test must run the whole browser suite, but ${narrowed.join(" ")} is set (it skips phases). Unset it.` : null;
}

// The harness writes audit.finished only when its last step ran; a report cut short by the virtual-time budget has checks but no failure and no marker.
export function assertAuditFinished(audit: any, label: string) {
  assert.equal(audit?.finished, true, `${label}: the audit did not finish (the virtual-time budget or a crash ended it early); it ran ${audit?.checks?.length ?? 0} checks and the last was ${JSON.stringify(audit?.checks?.at(-1)?.name)}`);
}

// The exact comparison every audit host uses: the executed names against a hand-written expected list, as multisets (sorted, so a missing, extra, renamed or duplicated name fails and is named),
// every executed result passed, and the two counts printed. `ordered` also requires the page's own order. The expected list is never built from the audit it checks.
export function exactCheckDiff(executed: string[], expected: string[]): { missing: string[]; extra: string[]; duplicates: string[] } {
  const count = (names: string[]) => names.reduce((map, name) => map.set(name, (map.get(name) ?? 0) + 1), new Map<string, number>());
  const have = count(executed), want = count(expected);
  const missing: string[] = [], extra: string[] = [], duplicates: string[] = [];
  for (const [name, n] of want) if ((have.get(name) ?? 0) < n) missing.push(name);
  for (const [name, n] of have) { if (!want.has(name)) extra.push(name); else if (n > want.get(name)!) duplicates.push(name); }
  return { missing, extra, duplicates };
}
export function assertExactChecks(label: string, checks: { name: string; passed?: boolean }[], expected: string[], ordered = false): void {
  const executed = checks.map((item) => item.name);
  console.log(`EXPECTED-VS-EXECUTED ${label}: expected ${expected.length}, executed ${executed.length}${ordered ? " (in order)" : ""}`);
  const diff = exactCheckDiff(executed, expected);
  assert.deepEqual(diff, { missing: [], extra: [], duplicates: [] }, `${label}: the audit ran exactly its expected checks (expected ${expected.length}, executed ${executed.length}): ${JSON.stringify(diff)}`);
  assert.deepEqual([...executed].sort(), [...expected].sort(), `${label}: sorted executed and expected names are equal`);
  if (ordered) assert.deepEqual(executed, expected, `${label}: the checks ran in the expected order`);
  assert.deepEqual(checks.filter((item) => item.passed !== true).map((item) => item.name), [], `${label}: every check passed`);
}

// Every check the Pack C audit (case "c2") must have run, in the real-app test and in the approval test.
export const C2_APPROVAL_CHECKS: string[] = [
  "tool approval panel, answers, focus, Waiting status and reconnect",
  "an answer in flight when the socket drops fails with Disconnected and unlocks Allow and Deny",
  "approval panel and Waiting status clear after answer",
  "a second click 30 ms after Allow cannot answer the next approval, and works after it settles",
  "a press that began on another approval is ignored and the next fresh press answers",
  "a held Enter key repeat is blocked on the approval buttons and a first press is not",
  "a new approval sends one desktop notification naming the tab and the change",
  "Settings keeps every unsaved field across a state broadcast",
  "Settings drops a draft once its save is done and keeps the others",
  "Settings opens with no leftover unsaved text after it was closed",
  "a sent request empties the form once and a second click sends no duplicate",
  "a fixed Settings picker closed on one tab cannot redraw or send for it after another tab's picker opens, and an old reply leaves the open picker's request alone",
  "an Outcome unknown launch stays locked when the brief is edited and sends no second run",
  "a Save that went unknown is not confirmed when the saved revision had not moved",
  "a Save that went unknown is confirmed when the saved revision moved past its start",
  "a New project create lost with the connection frees Create and says it is not known",
  "an Add tab create lost with the connection frees Create and says it is not known",
  "Check again is usable again after the connection dropped before its answer",
  "a force-enabled Start after an Outcome unknown launch sends no second run",
  "a project create that landed with its reply lost frees Create tab in the open Add tab dialog",
  "a tab create that landed with its reply lost frees Create project in the open New project dialog",
];
// The early C2 route (CC_BROWSER_PHASES=c2-early, harness case c2-through-r7) runs Pack C, tool approvals, R6 and R7 only, no R1: exactly these checks, in this order, after the two collision checks.
export const c2EarlyNames = (width: number): string[] => [
  `Pack C target selector list finds every required control at ${width}px`,
  `Settings section target list finds all eight sections at ${width}px`,
  `Settings scroll tracking marks the section and the final section at ${width}px`,
  `request badge reads the selected tab at ${width}px`,
  `Changes and Notes pills render server empty state and no-vault action at ${width}px`,
  `Pack C Changes target list finds every mockup row and status at ${width}px`,
  `Pack C Changes rows match Branch, Last commit, Remote and Not committed at ${width}px`,
  `Pack C Notes target list finds the heading, rows and no-vault state at ${width}px`,
  `Pack C composer target list finds Attach and the permission pill at ${width}px`,
  `Pack C composer puts Attach before the permission pill at ${width}px`,
  `Pack C AI tool target list finds every right-column install detail at ${width}px`,
  `Pack C Gemini Install stays right-aligned with its real npm argv at ${width}px`,
  `Gemini stays install-only, unknown sign-in stays unknown, and unconfirmed Install sends nothing at ${width}px`,
  `Gemini Install at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `CLI login at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `GitHub connect at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Notes vault save at ${width}px sends its exact request, shows that id's done status, restores focus, and re-enables`,
  `Default project folder save at ${width}px sends its exact request, shows that id's done status, restores focus, and re-enables`,
  `Folders keep each tab's Browse and the new-project default at ${width}px`,
  `MCP add at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `MCP remove at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Plugin install at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Plugin remove at ${width}px sends its exact request, shows that id's failed status, restores focus, and re-enables`,
  `Skills and MCP controls respect Gemini/OpenCode limits and validate names and endpoints at ${width}px`,
  `Obsidian opens only the encoded server vault path at ${width}px`,
  `Obsidian and folder pickers hide without the Electron bridge at ${width}px`,
  `Requests send fresh cross-project protocol ids and show refusal at ${width}px`,
  `Pack C Needs you request target list finds incoming and sent card parts at ${width}px`,
  `Pack C Needs you separates pending, answered and sent requests with the handoff button at ${width}px`,
  `Requests waiting, accept, decline, destination-removed and per-id refusal render at ${width}px`,
  `Needs you returns focus to its opener at ${width}px`,
  `Pack C permission picker target list finds all approved modes at ${width}px`,
  `Pack C permission picker matches approved labels and descriptions at ${width}px`,
  `Per-tab permission picker shows all modes, saved state, confirmation and status at ${width}px`,
  `Transcript images open in the viewer with their exact returned path, close, and stay with their own tab at ${width}px`,
  "file attachment packc-undo-tab-read-before-undo.md completes in read-before-undo around tab Undo",
  "completed file attachment packc-undo-tab-read-before-undo.md releases and does not duplicate",
  "file attachment packc-undo-tab-read-after-undo.md completes in read-after-undo around tab Undo",
  "completed file attachment packc-undo-tab-read-after-undo.md releases and does not duplicate",
  "file attachment packc-undo-project-read-before-undo.md completes in read-before-undo around project Undo",
  "completed file attachment packc-undo-project-read-before-undo.md releases and does not duplicate",
  "file attachment packc-undo-project-read-after-undo.md completes in read-after-undo around project Undo",
  "completed file attachment packc-undo-project-read-after-undo.md releases and does not duplicate",
  `chat waits for an in-flight non-image file read before sending at ${width}px`,
  `non-image attachment uploads, waits, sends files and renders a transcript chip at ${width}px`,
  "pending approval keeps composer usable",
  "settled Allow sends its approval answer",
  "an answer in flight when the socket drops fails with Disconnected and unlocks Allow and Deny",
  "tool approval panel, answers, focus, Waiting status and reconnect",
  "approval panel and Waiting status clear after answer",
  "a second click 30 ms after Allow cannot answer the next approval, and works after it settles",
  "a press that began on another approval is ignored and the next fresh press answers",
  "a held Enter key repeat is blocked on the approval buttons and a first press is not",
  "a new approval sends one desktop notification naming the tab and the change",
  "Settings keeps every unsaved field across a state broadcast",
  "Settings drops a draft once its save is done and keeps the others",
  "Settings opens with no leftover unsaved text after it was closed",
  "a sent request empties the form once and a second click sends no duplicate",
  "a preset or uploaded seat picture is displayed in the crew row and the stage header, and an invalid route or a remote URL falls back",
  "the permission picker closes when the user clicks outside it",
  "Requests Send is not stuck on an earlier send the server already forgot",
  "Save folder is not stuck on an earlier action the server already forgot",
  "completed folder Save stays Done after 1001 other completions",
  "in-flight MCP Add button stays disabled and Working after another action and 33 completions",
  "MCP Add unlocks and shows Done only after its terminal result",
  "a request send and a folder save are not stuck on Working after the server forgot them",
  "Requests Send is not stuck on Working after a socket drop lost its result",
  "a resolved request card never shows Working, whether or not the server still lists its action",
  "a Requests send in one tab does not show its status or lock Send in another tab",
  "request title and body, the approval summary, a changed file path and an MCP server name are shown as text, never markup",
  "a fixed-action approval reads <leader> wants to start fixed work",
  "a tool version with & and < is shown once-escaped, as typed",
];
// The R1 part of the full Pack C case (runR1Fixes, test/browser-harness/12-r1-fixes.js): the one picker identity check and the nine create, launch and refresh checks, in the order the page runs them.
export const C2_R1_NAMES: string[] = [
  "a fixed Settings picker closed on one tab cannot redraw or send for it after another tab's picker opens, and an old reply leaves the open picker's request alone",
  "an Outcome unknown launch stays locked when the brief is edited and sends no second run",
  "a force-enabled Start after an Outcome unknown launch sends no second run",
  "a Save that went unknown is not confirmed when the saved revision had not moved",
  "a Save that went unknown is confirmed when the saved revision moved past its start",
  "a New project create lost with the connection frees Create and says it is not known",
  "an Add tab create lost with the connection frees Create and says it is not known",
  "a project create that landed with its reply lost frees Create tab in the open Add tab dialog",
  "a tab create that landed with its reply lost frees Create project in the open New project dialog",
  "Check again is usable again after the connection dropped before its answer",
];
// The full Pack C case (harness case "c2", the real and approval entries, every width): the collision pair, everything the early route runs, then R1. 2 + 72 + 10 = 84 names.
export const c2FullNames = (width: number): string[] => [...COLLISION_CHECKS, ...c2EarlyNames(width), ...C2_R1_NAMES];

// The three fixed model-lock and Escape checks of runPackThreeB, in the order the page runs them.
export const PACK3_FIXED_PICKER_CHECKS: string[] = [
  "a fixed Settings model chip and its open picker lock while the position is busy and unlock when it ends",
  "an open fixed picker and Settings chip unlock when work ends, locked search sends nothing, focus stays enabled, and an unconfirmed stop stays locked until released",
  "Escape on a Settings model picker whose chip locked meanwhile puts focus in the Settings dialog on an enabled control, never the page body",
];
export const COLLISION_CHECKS = ["no top-level name in the page scripts overwrote a built-in window function", "control: the collision scan reports a planted print()"];
// Fix pack 3: page behaviour that had no test (runPackThree in test/browser-harness/*.js), one named check each.
export const PACK3_CHECKS: string[] = [
  "the fake clock's ids are never the positive integers real timers use, clearing a real timer leaves a fake one alone, and a fake id never reaches the real clearTimeout after restore",
  "Needs you offers Release all N for a seat with several unconfirmed stops, refuses a wrong phrase, and sends one releaseUnconfirmedSeat with the typed phrase",
  "a failed Save shows a Retry save card in Needs you; its button closes Needs you and sends save for that tab, and the card is gone once the save lands",
  "a stalled run's card has a Stop this run button that sends killRun for that run only",
  ...PACK3_FIXED_PICKER_CHECKS,
  "Settings New tabs Browse sends changeProjectFolder for the shown project with the picked folder",
  "the Details width grip drags the panel (clamped 280 to 560), saves the width once on release, and the arrow keys move it by 16",
  "Match my PC follows the PC's light or dark setting, saves theme system, and keeps following it",
  "Match my PC: the page's own media change listener moves the theme with no state broadcast",
  "a capped saved run offers Load the fuller log, asks for the full log once, and labels the fuller reply",
  "the Copy button copies the install command and says so, and falls back to a hidden text copy when the clipboard refuses",
  "Enter sends the message, but not while an input method is composing or with Shift held",
  "the empty chat's suggestion chips send their own text, and cannot be pressed while a Save is waiting for its answer",
  "Retry now on the Disconnected banner opens a new connection at once",
  "the screenshot viewer's Prev, Next and Fit buttons step through the pictures, disable at the ends and toggle the size",
  "live output appends to the open run's log, follows the end, stays put when the reader scrolled up, and Jump to latest returns to the end",
  "the seat card's Watch on a run opens that run in the work view",
  "Allow again in the Run dialog asks for the typed phrase, then sends unblockSeat; cancelling sends nothing",
  "the first-project screen's New project opens the project dialog and each Set up opens Settings on AI tools",
  "Rename tab in the tab menu sends renameTab with the new name",
  "Acknowledge all sends ackLaunchNotices for the finished launch records only",
];
