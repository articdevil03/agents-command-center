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
  "a seat-picture upload that finishes after its dialog was closed still applies and leaves the open Settings dialog alone",
  "a crew picker closed on one tab cannot redraw or send for it after another tab's picker opens",
  "an Outcome unknown launch stays locked when the brief is edited and sends no second run",
  "a Save that went unknown is not confirmed when the saved revision had not moved",
  "a Save that went unknown is confirmed when the saved revision moved past its start",
  "a New project create lost with the connection frees Create and says it is not known",
  "an Add tab create lost with the connection frees Create and says it is not known",
  "Check again is usable again after the connection dropped before its answer",
  "a force-enabled Start after an Outcome unknown launch sends no second run",
  "a project create that landed with its reply lost frees Create tab in the open Add tab dialog",
  "a tab create that landed with its reply lost frees Create project in the open New project dialog",
  // After "Check again is usable again..." in the harness (runR1Fixes): crew picks and the step button. The harness ends them last, so a cut-short audit lacks exactly these.
  "two crew picks for one tab leave exactly one notice; picking the current crew cancels the waiting change and sends nothing",
  "two quick crew picks send exactly one useSetup, the last pick",
  "three rapid clicks on the step button advance exactly one step, and a click after the pause works",
  "a step change arriving after an unrelated state still blocks the immediate click, and a click after the pause works",
  "a review round change (Found findings, Finish fixes) pauses the next step click for 600 ms, and a click after the pause works",
  "a tab that left the state loses its sent mark: a later change starts no pause",
  "a connection drop between a step click and its state keeps the pause: the immediate click is ignored, a click after the pause works",
];
export const packCWidthChecks = (width: number): string[] => [
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
  `Pack C Needs you request target list finds incoming and sent card parts at ${width}px`,
  `Pack C Needs you separates pending, answered and sent requests with the handoff button at ${width}px`,
  `Pack C permission picker target list finds all approved modes at ${width}px`,
  `Pack C permission picker matches approved labels and descriptions at ${width}px`,
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
  `Requests waiting, accept, decline, destination-removed and per-id refusal render at ${width}px`,
  `Needs you returns focus to its opener at ${width}px`,
  `Per-tab permission picker shows all modes, saved state, confirmation and status at ${width}px`,
  `Seat picture uploads with an id, applies its server route and restores focus at ${width}px`,
  `Approval screenshots use only the selected tab transcript at ${width}px`,
  `chat waits for an in-flight non-image file read before sending at ${width}px`,
  `non-image attachment uploads, waits, sends files and renders a transcript chip at ${width}px`,
];
export const packCFileUndoChecks = (): string[] => ["tab", "project", "process"].flatMap((kind) => ["read-before-undo", "read-after-undo"].flatMap((order) => [
  `file attachment packc-undo-${kind}-${order}.md completes in ${order} around ${kind} Undo`,
  `completed file attachment packc-undo-${kind}-${order}.md releases and does not duplicate`,
]));

// Fix pack 3: page behaviour that had no test (runPackThree in test/browser-harness/*.js), one named check each.
export const PACK3_CHECKS: string[] = [
  "the fake clock's ids are never the positive integers real timers use, clearing a real timer leaves a fake one alone, and a fake id never reaches the real clearTimeout after restore",
  "Needs you offers Release all N for a seat with several unconfirmed stops, refuses a wrong phrase, and sends one releaseUnconfirmedSeat with the typed phrase",
  "a failed Save shows a Retry save card in Needs you; its button closes Needs you and sends save for that tab, and the card is gone once the save lands",
  "a stalled run's card has a Stop this run button that sends killRun for that run only",
  "the Advisor picker sends updateSeat with the seat and the chosen advisor, and null for Off",
  "the seat card's pencil renames the seat: Enter sends updateSeat with the new name, Escape sends nothing",
  "a working crew seat's Model row, open picker and Settings button lock with Locked while working, the leader never locks, and they unlock when the run ends",
  "an open picker, seat card and Settings unlock when the run ends, searching a locked picker keeps its models locked, focus stays inside the surface when its control locks, and an unconfirmed stop locks the seat until released",
  "Escape on a Settings model picker whose chip locked meanwhile puts focus in the Settings dialog on an enabled control, never the page body",
  "Settings New tabs Browse sends changeProjectFolder for the shown project with the picked folder",
  "the fixer radios choose who fixes the round: a pick sends selectFixer once, the checked one follows the server, and picking the checked one sends nothing",
  "the Details width grip drags the panel (clamped 280 to 560), saves the width once on release, and the arrow keys move it by 16",
  "Match my PC follows the PC's light or dark setting, saves theme system, and keeps following it",
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
