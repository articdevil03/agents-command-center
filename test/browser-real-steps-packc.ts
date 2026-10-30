import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { keyedWsUrl } from "./temp-root.ts";
import { HOST, APP_KEY, assertAuditFinished, C2_APPROVAL_CHECKS, packCWidthChecks, packCFileUndoChecks } from "./browser-constants.ts";
import { getServerState, listen, chromeAudit } from "./browser-helpers.ts";
import { chromeDialogAudit } from "./browser-dialog-audit.ts";
import type { BrowserProxy } from "./browser-real-types.ts";

export async function packCWidthAudit(proxy: BrowserProxy, temp: string, folder: string, width: number) {
  const c2Port = await listen(proxy.proxy);
  const c2 = await chromeAudit({ port: c2Port, mode: "fake", folder, width, profile: join(temp, `chrome-packc-${width}`), caseName: "c2", virtualMs: 60_000 });
  console.log(`Browser Pack C ${width}px audit: ${JSON.stringify(c2)}`);
  assert.equal(c2.failures?.length ?? 0, 0, `Pack C ${width}px call-site mutation detected: ${(c2.failures ?? []).map((item: any) => item.name).join(" | ")}`);
  assert.equal(c2.failure, undefined, `Pack C ${width}px browser audit failed: ${c2.failure ?? JSON.stringify(c2)}`);
  assertAuditFinished(c2, "c2");
  assert.deepEqual(c2.errors, [], `Pack C ${width}px browser console/runtime errors: ${JSON.stringify(c2.errors)}`);
  const c2Names = c2.checks.map((item: any) => item.name);
  for (const name of C2_APPROVAL_CHECKS) assert.ok(c2Names.includes(name), `missing Pack C approval check ${name}; matched ${JSON.stringify(c2Names)}`);
  for (const name of packCWidthChecks(width)) assert.ok(c2Names.includes(name), `missing Pack C ${width}px browser check ${name}; matched ${JSON.stringify(c2Names)}`);
  for (const name of packCFileUndoChecks()) assert.ok(c2Names.includes(name), `missing Pack C file check ${name}; matched ${JSON.stringify(c2Names)}`);
  if (width === 1600 || width === 1024) {
    const dialogAudit = await chromeDialogAudit({ port: c2Port, folder, width, profile: join(temp, `chrome-dialog-close-${width}`) });
    assert.deepEqual(dialogAudit.dialogs, ["#inboxPop", "#setModal", "#avModal", "#viewer", "#modal", "#projModal", "#runModal"]);
    console.log(`Dialog browser audit ${width}px passed: ${JSON.stringify(dialogAudit)}`);
  }
}

export async function packCRealSettingsAudit(proxy: BrowserProxy, temp: string, settingsFolder: string, width: number) {
  const settingsPort = await listen(proxy.proxy);
  const settingsAudit = await chromeAudit({ port: settingsPort, mode: "real", folder: settingsFolder, width, profile: join(temp, `chrome-packc-real-settings-${width}`), caseName: "c2-settings", virtualMs: 60_000 });
  console.log(`Browser Pack C real-server Settings ${width}px audit: ${JSON.stringify(settingsAudit)}`);
  assert.equal(settingsAudit.failures?.length ?? 0, 0, `Pack C real Settings ${width}px check failed: ${(settingsAudit.failures ?? []).map((item: any) => item.name).join(" | ")}`);
  assert.equal(settingsAudit.failure, undefined, `Pack C real Settings ${width}px browser audit failed: ${settingsAudit.failure ?? JSON.stringify(settingsAudit)}`);
  assertAuditFinished(settingsAudit, "settingsAudit");
  assert.deepEqual(settingsAudit.errors, [], `Pack C real Settings ${width}px browser errors: ${JSON.stringify(settingsAudit.errors)}`);
  const settingsNames = settingsAudit.checks.map((item: any) => item.name);
  for (const name of [
    `real fake-runner Settings and permission targets exist at ${width}px`,
    `real Settings nav finds all eight sections at ${width}px`,
    `real Gemini remains install-only with server instruction inventory at ${width}px`,
    `Gemini install shows real server status for its fresh id at ${width}px`,
    `Claude sign-in shows real server status for its fresh id at ${width}px`,
    `GitHub connect shows real server status for its fresh id at ${width}px`,
    `Notes vault refusal shows real server status for its fresh id at ${width}px`,
    `Notes vault save shows real server status for its fresh id at ${width}px`,
    `real Notes vault Open in Obsidian uses the encoded server path at ${width}px`,
    `Default folder refusal shows real server status for its fresh id at ${width}px`,
    `Default folder save shows real server status for its fresh id at ${width}px`,
    `real folder pickers update the default and selected tab at ${width}px`,
    `MCP add shows real server status for its fresh id at ${width}px`,
    `MCP remove shows real server status for its fresh id at ${width}px`,
    `Plugin install shows real server status for its fresh id at ${width}px`,
    `Plugin remove shows real server status for its fresh id at ${width}px`,
    `real MCP and plugin actions use server refusals and require confirmation at ${width}px`,
    `real per-tab permission flow uses server state and confirmation at ${width}px`,
    `Clear Notes vault shows real server status for its fresh id at ${width}px`,
    `real Notes vault clears back to its honest no-vault state at ${width}px`,
  ]) assert.ok(settingsNames.includes(name), `missing real fake-runner Settings check ${name}; matched ${JSON.stringify(settingsNames)}`);
}

export async function requestsRealAudit(proxy: BrowserProxy, temp: string, folder: string) {
  const requestPort = await listen(proxy.proxy);
  const requestAudit = await chromeAudit({ port: requestPort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-packc-requests"), caseName: "c2-requests", virtualMs: 35_000 });
  console.log(`Browser Pack C real-server requests audit: ${JSON.stringify(requestAudit)}`);
  assert.equal(requestAudit.failure, undefined, `Pack C real request audit failed: ${requestAudit.failure ?? JSON.stringify(requestAudit)}`);
  assertAuditFinished(requestAudit, "requestAudit");
  assert.deepEqual(requestAudit.errors, [], `Pack C real request browser errors: ${JSON.stringify(requestAudit.errors)}`);
  assert.ok(requestAudit.checks.some((item: any) => item.name === "the real browser server probes Gemini and GitHub through its scripted fake runner"), `missing real fake-runner settings proof; matched ${JSON.stringify(requestAudit.checks.map((item: any) => item.name))}`);
  assert.ok(requestAudit.checks.some((item: any) => item.name === "requests run end to end on the fake-runner server: send, badge, accept/decline, and destination removed"), `missing real-server request proof; matched ${JSON.stringify(requestAudit.checks.map((item: any) => item.name))}`);
}

export async function looksWriteAudit(proxy: BrowserProxy, temp: string, folder: string) {
  const writePort = await listen(proxy.proxy);
  const looksWrite = await chromeAudit({ port: writePort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-looks-write"), caseName: "looks-write", virtualMs: 35_000 });
  console.log(`Browser looks-write audit: ${JSON.stringify(looksWrite)}`);
  assert.equal(looksWrite.failure, undefined, `looks-write audit failed: ${looksWrite.failure ?? JSON.stringify(looksWrite)}`);
  assertAuditFinished(looksWrite, "looksWrite");
  assert.deepEqual(looksWrite.errors, [], `looks-write browser errors: ${JSON.stringify(looksWrite.errors)}`);
  for (const name of ["a theme and picture chosen in one page load are kept by the real server", "a sound volume set in one page load is kept by the real server"]) assert.ok(looksWrite.checks.some((item: any) => item.name === name), `missing looks-write proof ${name}; matched ${JSON.stringify(looksWrite.checks)}`);
  return { looksWrite, writePort };
}

export async function looksRefusalAudit(actualPort: number) {
  const kept = (await getServerState(actualPort)).clientPrefs;
  assert.equal(kept.theme, "dark", "the server itself holds the chosen theme"); assert.equal(kept.avatar, "momo.svg", "the server itself holds the chosen picture");
  assert.equal(kept.bellVolume, 35, "the server itself holds the chosen sound volume");
  // A picture over the cap that reaches the server anyway is refused in plain words and changes nothing.
  const refusal = await new Promise<any>((resolveRefusal, rejectRefusal) => {
    const ws = new WebSocket(keyedWsUrl(`ws://${HOST}:${actualPort}`, APP_KEY), { origin: `http://${HOST}:${actualPort}` });
    const timer = setTimeout(() => { ws.terminate(); rejectRefusal(new Error("no answer to the oversized picture")); }, 5000);
    ws.once("open", () => ws.send(JSON.stringify({ type: "updateClientPref", key: "avatar", value: "data:image/png;base64," + "A".repeat(512 * 1024) })));
    ws.on("message", (data) => { const message = JSON.parse(data.toString()); if (message.type !== "error") return; clearTimeout(timer); ws.close(); resolveRefusal(message); });
    ws.once("error", (error) => { clearTimeout(timer); rejectRefusal(error); });
  });
  assert.match(refusal.message, /too large to keep \(limit 512 KB\)/, `the refusal says why: ${JSON.stringify(refusal)}`);
  assert.equal((await getServerState(actualPort)).clientPrefs.avatar, "momo.svg", "the refused picture changed nothing");
}

export async function looksReadAudit(proxy: BrowserProxy, temp: string, folder: string, looksWrite: any, writePort: number) {
  const readPort = await listen(proxy.proxy);
  assert.notEqual(readPort, writePort, "the second page load must be a different origin");
  const looksRead = await chromeAudit({ port: readPort, mode: "real", folder, width: 1600, profile: join(temp, "chrome-looks-read"), caseName: "looks-read", virtualMs: 35_000 });
  console.log(`Browser looks-read audit: ${JSON.stringify(looksRead)}`);
  assert.equal(looksRead.failure, undefined, `looks-read audit failed: ${looksRead.failure ?? JSON.stringify(looksRead)}`);
  assertAuditFinished(looksRead, "looksRead");
  assert.deepEqual(looksRead.errors, [], `looks-read browser errors: ${JSON.stringify(looksRead.errors)}`);
  for (const name of ["a fresh page load on a different port opens in the theme and picture chosen before", "a fresh page load on a different port opens the sound popover at the volume set before"]) assert.ok(looksRead.checks.some((item: any) => item.name === name), `missing looks-read proof ${name}; matched ${JSON.stringify(looksRead.checks)}`);
  assert.equal(looksWrite.matched.port, String(writePort)); assert.equal(looksRead.matched.port, String(readPort));
  assert.notEqual(looksWrite.matched.port, looksRead.matched.port, "the two page loads ran on different ports");
}

export async function fakeRunnerRecordAudit(fakeRecord: string) {
  const recordedCalls = readFileSync(fakeRecord, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(recordedCalls.every((argv) => Array.isArray(argv) && argv.every((arg: unknown) => typeof arg === "string")), `fake runner recorded argv arrays only: ${JSON.stringify(recordedCalls)}`);
  assert.ok(recordedCalls.some((argv) => JSON.stringify(argv) === JSON.stringify(["gemini", "--version"])), `Gemini version probe was recorded by the fake runner: ${JSON.stringify(recordedCalls)}`);
  assert.ok(recordedCalls.some((argv) => JSON.stringify(argv) === JSON.stringify(["gh", "auth", "status"])), `GitHub auth status was recorded by the fake runner: ${JSON.stringify(recordedCalls)}`);
}
