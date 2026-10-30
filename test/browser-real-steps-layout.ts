import assert from "node:assert/strict";
import { join } from "node:path";
import { assertAuditFinished, PACK3_CHECKS } from "./browser-constants.ts";
import { listen, chromeAudit } from "./browser-helpers.ts";
import type { BrowserProxy } from "./browser-real-types.ts";

export async function realAudit(proxy: BrowserProxy, temp: string, folder: string) {
  const proxyPort = await listen(proxy.proxy);
  const real = await chromeAudit({ port: proxyPort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-real"), virtualMs: 35_000 });
  console.log(`Browser real-server audit: ${JSON.stringify(real)}`);
  assert.equal(real.failure, undefined, `real browser audit failed: ${real.failure ?? JSON.stringify(real)}`);
  assertAuditFinished(real, "real");
  assert.deepEqual(real.errors, [], `real browser console/runtime errors: ${JSON.stringify(real.errors)}`);
  const realNames = real.checks.map((item: any) => item.name);
  for (const name of [
    "server state renders every shell target, project, tab, crew and step",
    "Pack C shell controls render",
    "tab switch reaches the server",
    "add-tab dialog creates the selected kind and template on the server, and a new Development tab starts with Our process",
    "new-project dialog creates the selected kind and template on the server",
    "held remove offers Undo before sending",
    "Undo cancels a held remove",
    "held remove sends after the Undo window",
    "seat model change reaches the server",
    "seat effort change reaches the server",
    "folder picker updates the server tab folder",
    "project folder picker updates the default without changing existing tab folders",
    "new tab dialog defaults to the project folder",
    "crew switch waits for Undo and then reaches the server",
    "modal traps Tab focus at its final control",
    "Escape closes the add-tab dialog and restores focus",
  ]) assert.ok(realNames.includes(name), `missing real browser check ${name}; matched ${JSON.stringify(realNames)}`);

}

export async function layoutAuditAtWidth(proxy: BrowserProxy, temp: string, folder: string, width: number, layoutResults: any[], oldMe: Record<number, { saved: string; expected: string }>) {
  const fakePort = await listen(proxy.proxy);
  const result = await chromeAudit({ port: fakePort, mode: "fake", folder, width, profile: join(temp, `chrome-${width}`), virtualMs: 35_000 });
  layoutResults.push(result);
  console.log(`Browser ${width}px audit: ${JSON.stringify(result)}`);
  assert.equal(result.failure, undefined, `${width}px browser audit failed: ${result.failure ?? JSON.stringify(result)}`);
  assertAuditFinished(result, "result");
  assert.deepEqual(result.errors, [], `${width}px browser console/runtime errors: ${JSON.stringify(result.errors)}`);
  const names = result.checks.map((item: any) => item.name);
  for (const name of [
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
    "two parallel runs show the count badge and independent run tabs",
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
    "stage header, steps, transcript and composer fit and remain clickable",
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
  ]) assert.ok(names.includes(name), `missing ${width}px browser check ${name}; matched ${JSON.stringify(names)}`);
  if (width === 1100) assert.ok(names.includes("Details open or closed is saved only by the user and survives resizing"), `missing tablet persistence check; matched ${JSON.stringify(names)}`);
  if (oldMe[width]) assert.ok(names.includes("a personal picture saved before the simple look falls back to Ash, and an uploaded one is kept"), `missing saved-picture migration check at ${width}px; matched ${JSON.stringify(names)}`);
  assert.ok(names.includes("a picture that fails to load falls back once and never loops"), `missing picture fallback check at ${width}px; matched ${JSON.stringify(names)}`);
}

export async function titleBarAudit(proxy: BrowserProxy, temp: string, folder: string) {
  const titleBarPort = await listen(proxy.proxy);
  const titleBar = await chromeAudit({ port: titleBarPort, mode: "fake", folder, width: 900, profile: join(temp, "chrome-titlebar"), caseName: "titlebar", virtualMs: 35_000 });
  console.log(`Browser window-buttons audit: ${JSON.stringify(titleBar)}`);
  assert.equal(titleBar.failure, undefined, `window-buttons audit failed: ${titleBar.failure ?? JSON.stringify(titleBar)}`);
  assertAuditFinished(titleBar, "titleBar");
  assert.deepEqual(titleBar.errors, [], `window-buttons browser errors: ${JSON.stringify(titleBar.errors)}`);
  for (const name of [
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
  ]) assert.ok(titleBar.checks.some((item: any) => item.name === name && item.passed), `missing window-buttons proof ${name}; matched ${JSON.stringify(titleBar.checks)}`);
}

export async function pack2Audit(proxy: BrowserProxy, temp: string, folder: string) {
  const pack2Port = await listen(proxy.proxy);
  const pack2 = await chromeAudit({ port: pack2Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-pack2"), caseName: "pack2", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 120_000 });
  console.log(`Browser fix pack 2 audit: ${JSON.stringify(pack2)}`);
  assert.equal(pack2.failures?.length ?? 0, 0, `fix pack 2 behaviour guard failed: ${(pack2.failures ?? []).map((item: any) => item.name).join(" | ")}`);
  assert.equal(pack2.failure, undefined, `fix pack 2 browser audit failed: ${pack2.failure ?? JSON.stringify(pack2)}`);
  assertAuditFinished(pack2, "pack2");
  assert.deepEqual(pack2.errors, [], `fix pack 2 browser console/runtime errors: ${JSON.stringify(pack2.errors)}`);
  const pack2Names = pack2.checks.map((item: any) => item.name);
  for (const name of [
    "while body.boot is set the app is hidden, so a dark launch never flashes the light look",
    "Accept and Decline on a request for another tab name that tab, and the server takes both",
    "a renamed leader is named in the approval title, the Waiting status, the Needs you card and the hand-over button",
    "a run's log starts from the server's tail, a chunk only appends, a resync fills what was missed, and the page keeps 200 KiB",
    "a stalled run the server relaunches says so, and one it leaves for you says it was not relaunched",
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
  ]) assert.ok(pack2.checks.some((item: any) => item.name === name && item.passed), `missing fix pack 2 check ${name}; matched ${JSON.stringify(pack2Names)}`);
}

export async function pack3Audit(proxy: BrowserProxy, temp: string, folder: string) {
  const pack3Port = await listen(proxy.proxy);
  const pack3 = await chromeAudit({ port: pack3Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-pack3"), caseName: "pack3", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 120_000 });
  console.log(`Browser fix pack 3 audit: ${JSON.stringify(pack3)}`);
  assert.equal(pack3.failures?.length ?? 0, 0, `fix pack 3 behaviour guard failed: ${(pack3.failures ?? []).map((item: any) => item.name).join(" | ")}`);
  assert.equal(pack3.failure, undefined, `fix pack 3 browser audit failed: ${pack3.failure ?? JSON.stringify(pack3)}`);
  assertAuditFinished(pack3, "pack3");
  assert.deepEqual(pack3.errors, [], `fix pack 3 browser console/runtime errors: ${JSON.stringify(pack3.errors)}`);
  const pack3Names = pack3.checks.map((item: any) => item.name);
  for (const name of PACK3_CHECKS) assert.ok(pack3.checks.some((item: any) => item.name === name && item.passed), `missing fix pack 3 check ${name}; matched ${JSON.stringify(pack3Names)}`);
}
