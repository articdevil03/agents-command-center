import assert from "node:assert/strict";
import { join } from "node:path";
import { assertAuditFinished, assertExactChecks, COLLISION_CHECKS, PACK3_CHECKS } from "./browser-constants.ts";
import { listen, chromeAudit } from "./browser-helpers.ts";
import type { BrowserProxy } from "./browser-real-types.ts";

// Every check each audit below runs, written out by name (never built from the audit it is compared with). Each audit also runs the two collision checks first.
const REAL_NAMES = [
  "Pack C shell controls render",
  "server state renders the shell, the open tab's own crew and all 18 fixed positions in Settings, and no retired mount",
  "tab switch reaches the server",
  "modal traps Tab focus at its final control",
  "Escape closes the add-tab dialog and restores focus",
  "add-tab dialog creates through the fixed crew: one request with the name, folder, projectOnly, fixedCrewVersion, the picked crewChoices and autoAssign, no kind or template, and the server's tab holds the pick",
  "new-project dialog creates through the fixed crew: one request with the name, folder, projectOnly, fixedCrewVersion, the picked crewChoices and autoAssign, no kind or template, and the server's first tab holds the pick",
  "held remove offers Undo before sending",
  "Undo cancels a held remove",
  "held remove sends after the Undo window",
  "picking a model shows no 'will use' toast before the server confirms",
  "seat model change reaches the server as one setCrewAssignment for that tab and position, and the saved assignment follows the server's answer",
  "seat effort change reaches the server as one setCrewAssignment that keeps the model, and the saved assignment follows the server's answer",
  "a worker's picture opens its seat card without leaving the chat",
  "the worker card's Watch opens that seat's work view",
  "the leader's picture opens its card even while a worker's view is showing",
  "a worker's name opens its work view and no card",
  "collapsed rail: the picture opens the card and Watch opens the work view",
  "the card switches to the leader's seat when its picture is clicked",
  "only the open card's picture reads as expanded",
  "the leader's card subtitle says leader once",
  "clicking the picture that opened the card closes it",
  "Escape hands focus back to the picture that opened the card, not the first one",
  "closing the card leaves no picture marked expanded",
  "the leader's name button announces a card while the chat is showing",
  "the leader's name button reads as expanded while its card is open",
  "the picker groups models by installed CLI, the seat's own first",
  "a CLI that was not checked (null) or is not installed is not offered, the seat's own always is",
  "the CLIs come back when the server finds them",
  "after a redraw only the checked effort is a tab stop",
  "searching narrows the list to models that match",
  "a typed Codex id that is not listed can be used",
  "a typed provider/model id can be used for OpenCode only",
  "clearing the search brings the whole list back",
  "a refused seat change shows the server's reason on its own position, matched by request id, and leaves the picker open",
  "the picker no longer claims the CLI comes with the crew",
  "a model of another CLI sends setCrewAssignment with the whole assignment: cli, model and effort",
  "the tick does not move before the server confirms",
  "the picker stays open after a pick and shows the effort row for the chosen model",
  "effort changes in the same visit as the model",
  "going back sends the CLI too",
  "a Claude leader's card shows the Advisor row",
  "a Claude leader: the card, the Settings position line and the Usage panel show the saved Advisor as read-only facts for the leader alone",
  "the leader switches CLI with setCrewAssignment: cli, model and effort for the leader position",
  "a Codex leader gets its limit in plain words: it cannot be held read-only, and the choice is saved for this tab",
  "a Codex leader: the card, the Settings position line and the Usage panel show no Advisor",
  "a Codex leader's card has no Advisor row",
  "an OpenCode leader (read-only is enforced) gets no read-only warning, only the saved note",
  "an OpenCode leader: the card, the Settings position line and the Usage panel show no Advisor",
  "the first-project screen says Claude, Codex or OpenCode can run the leader, not 'any one of these'",
  "folder picker updates the server tab folder",
  "project folder picker updates the default without changing existing tab folders",
  "new tab dialog defaults to the project folder",
];
// The fake-server layout case ("all" at each width: the fake case, then the layout case). The picture-migration check runs only where the page was seeded with an old saved picture (1600, 1280 and 1100), the tablet check only at 1100.
const layoutNames = (width: number, oldPicture: boolean): string[] => [
  ...COLLISION_CHECKS,
  `B1 model labels and effort fit at ${width}px`,
  "plan meters stay hidden without data and show the measured rateLimit",
  "tab arrow keys change server selection and retain focus",
  "server supplied seat text is rendered as text",
  "chatHistory renders its server transcript",
  "chat sends the current tab and message through the protocol",
  "chatMessage updates the visible transcript",
  "chatDelta renders the live transcript",
  "chatDone clears streaming text and leaves the final message",
  "a second chat turn shows both its message and the leader's reply without reopening the tab",
  "a finished server-shaped message is rendered once and then served from the cache",
  "chat transcript keeps the reader position and sticks within four pixels",
  "Usage shows only measured leader and running-seat snapshots",
  "a live run and a retained unconfirmed record on one seat show the count badge and independent record tabs, each with its own output",
  "Writes only inside shows the server's folderPath",
  "per-run stop sends only the selected run id",
  "Stop all sends the server action",
  "run sends the selected tab, seat and prompt",
  "Stop seat sends the selected tab and seat",
  "seat History requests its server log list",
  "historyRun requests and renders the selected server run",
  "History refreshes on reopen, run completion, and reconnect",
  "long server names truncate inside project, tab, crew and stage controls",
  "every visible button has an accessible name",
  "every audited stage target was found",
  "stage header, status line, transcript and composer fit and remain clickable",
  `layout at ${width}px has no horizontal scroll or panel overlap`,
  "both panels collapse to the mockup strips and expand accessibly",
  "the rail's open or closed choice is sent to the server as the crewRailOpen pref",
  "the crew rail and Details open or closed come from the server's client prefs, not localStorage",
  "theme and personal avatar choices stay usable",
  "launch safety warns about a seat whose CLI cannot enforce read-only, and not about one that can",
  "wrong launch-safety phrases stay local and the exact typed phrases are sent",
  "activity feed renders real launch, stall and completion events",
  "plain browser hides Electron-only folder pickers",
  "the top bar drags the window, and its controls, tabs and popovers are not drag areas",
  "without the app window's bridge the top bar shows no window buttons",
  "a picture that fails to load falls back once and never loops",
  ...(width === 1100 ? ["Details open or closed is saved only by the user and survives resizing"] : []),
  ...(oldPicture ? ["a personal picture saved before the simple look falls back to Ash, and an uploaded one is kept"] : []),
];
const TITLEBAR_NAMES = [
  "with the app bridge the window buttons show after the avatar, as labelled buttons the size and shape of Settings, and none of them drags the window",
  "each window button sends its own call once per click: minimize, maximize or restore, close",
  "the maximize button opens as Restore on a maximized window and swaps icon, label and tooltip on every maximize and restore",
  "at the app's minimum width nothing in the top bar overlaps or leaves the window",
  "at the app's minimum width the sound popover opens whole, inside the window, right under the speaker",
  "a close request with nothing working is answered close at once, with no warning",
  "a close request while tabs are working holds the close and names them as Project · Tab in the app's own warning",
  "a second close request while the warning shows redraws the same warning, never a second one",
  "Keep open, Escape and a click outside cancel the warning and tell the window to stay open",
  "Close anyway tells the window to close, and nothing after it says stay",
  "the warning names one working tab as it, and more than three as the first three and +N more",
  "the server's answer that a tab was created closes the Add tab dialog, not the close question open over it",
];
const PACK2_NAMES = [
  "while body.boot is set the app is hidden, so a dark launch never flashes the light look",
  "Accept and Decline on a request for another tab name that tab, and the server takes both",
  "a renamed leader is named in the approval title, the Waiting status, the Needs you card and the hand-over button",
  "a run's log starts from the server's tail, a chunk only appends, a resync fills what was missed, and the page keeps 200 KiB",
  "a stalled run is left for the owner and its card says it was not relaunched by itself",
  "a launch notice is one Activity line however it arrives, updated in place, and repeated states never push real events out",
  "a removal sent just before the connection dropped is sent again after the reconnect and completes",
  "a Stop that never got its answer before the drop is forgotten, so its button works again",
  "a refused Stop frees only the run it was for",
  "Check again sends a request id, ends on the server's success or failure answer, and never hangs when there is none",
  "a chat over 2 MiB is not sent, says so, and keeps the connection and the draft",
  "request details are measured in bytes: 24 KiB goes, one byte more is refused here with a reason",
  "a saved-runs list or saved run the server never answers stops spinning, and the list can be asked for again",
  "a successful Save asks for the leader's saved sessions again",
  "a refused tab selection does not stop the page asking for that tab's transcript later",
  "no tab in the project strip or the tab strip contains another button",
  "a failed attachment's ring is not the fixed light pink in the dark theme",
];

export async function realAudit(proxy: BrowserProxy, temp: string, folder: string) {
  const proxyPort = await listen(proxy.proxy);
  const real = await chromeAudit({ port: proxyPort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-real"), caseName: "render", virtualMs: 35_000 });
  console.log(`Browser real-server audit: ${JSON.stringify(real)}`);
  assert.equal(real.failure, undefined, `real browser audit failed: ${real.failure ?? JSON.stringify(real)}`);
  assertAuditFinished(real, "real");
  assert.deepEqual(real.errors, [], `real browser console/runtime errors: ${JSON.stringify(real.errors)}`);
  assertExactChecks("real-server render 1600px", real.checks, [...COLLISION_CHECKS, ...REAL_NAMES]);
}

export async function layoutAuditAtWidth(proxy: BrowserProxy, temp: string, folder: string, width: number, layoutResults: any[], oldMe: Record<number, { saved: string; expected: string }>) {
  const fakePort = await listen(proxy.proxy);
  const result = await chromeAudit({ port: fakePort, mode: "fake", folder, width, profile: join(temp, `chrome-${width}`), virtualMs: 35_000 });
  layoutResults.push(result);
  console.log(`Browser ${width}px audit: ${JSON.stringify(result)}`);
  assert.equal(result.failure, undefined, `${width}px browser audit failed: ${result.failure ?? JSON.stringify(result)}`);
  assertAuditFinished(result, "result");
  assert.deepEqual(result.errors, [], `${width}px browser console/runtime errors: ${JSON.stringify(result.errors)}`);
  assertExactChecks(`fake layout ${width}px`, result.checks, layoutNames(width, Boolean(oldMe[width])));
}

export async function titleBarAudit(proxy: BrowserProxy, temp: string, folder: string) {
  const titleBarPort = await listen(proxy.proxy);
  const titleBar = await chromeAudit({ port: titleBarPort, mode: "fake", folder, width: 900, profile: join(temp, "chrome-titlebar"), caseName: "titlebar", virtualMs: 35_000 });
  console.log(`Browser window-buttons audit: ${JSON.stringify(titleBar)}`);
  assert.equal(titleBar.failure, undefined, `window-buttons audit failed: ${titleBar.failure ?? JSON.stringify(titleBar)}`);
  assertAuditFinished(titleBar, "titleBar");
  assert.deepEqual(titleBar.errors, [], `window-buttons browser errors: ${JSON.stringify(titleBar.errors)}`);
  assertExactChecks("titlebar 900px", titleBar.checks, [...COLLISION_CHECKS, ...TITLEBAR_NAMES]);
}

export async function pack2Audit(proxy: BrowserProxy, temp: string, folder: string) {
  const pack2Port = await listen(proxy.proxy);
  const pack2 = await chromeAudit({ port: pack2Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-pack2"), caseName: "pack2", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 120_000 });
  console.log(`Browser fix pack 2 audit: ${JSON.stringify(pack2)}`);
  assert.equal(pack2.failures?.length ?? 0, 0, `fix pack 2 behaviour guard failed: ${(pack2.failures ?? []).map((item: any) => item.name).join(" | ")}`);
  assert.equal(pack2.failure, undefined, `fix pack 2 browser audit failed: ${pack2.failure ?? JSON.stringify(pack2)}`);
  assertAuditFinished(pack2, "pack2");
  assert.deepEqual(pack2.errors, [], `fix pack 2 browser console/runtime errors: ${JSON.stringify(pack2.errors)}`);
  assertExactChecks("pack2 1600px", pack2.checks, [...COLLISION_CHECKS, ...PACK2_NAMES]);
}

export async function pack3Audit(proxy: BrowserProxy, temp: string, folder: string) {
  const pack3Port = await listen(proxy.proxy);
  const pack3 = await chromeAudit({ port: pack3Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-pack3"), caseName: "pack3", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 120_000 });
  console.log(`Browser fix pack 3 audit: ${JSON.stringify(pack3)}`);
  assert.equal(pack3.failures?.length ?? 0, 0, `fix pack 3 behaviour guard failed: ${(pack3.failures ?? []).map((item: any) => item.name).join(" | ")}`);
  assert.equal(pack3.failure, undefined, `fix pack 3 browser audit failed: ${pack3.failure ?? JSON.stringify(pack3)}`);
  assertAuditFinished(pack3, "pack3");
  assert.deepEqual(pack3.errors, [], `fix pack 3 browser console/runtime errors: ${JSON.stringify(pack3.errors)}`);
  // Exact list, in order: a missing, extra, renamed or duplicated result fails here, and every result must have passed.
  assertExactChecks("pack3 1600px", pack3.checks, [...COLLISION_CHECKS, ...PACK3_CHECKS], true);
}
