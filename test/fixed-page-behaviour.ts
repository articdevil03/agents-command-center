import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { delay, deliverState, withPage as withFixedPage } from "./pack18-editor-harness.ts";

// The shared fixed-crew behaviour page: the harness's real server, real Chrome and fixture "fixed2" (two separate fixed tabs), with the server's own
// discovered state delivered before the body runs. Boot, ownership and teardown stay in pack18-editor-harness.ts; nothing here starts a process.
// tabA / tabB are the two fixed tabs' ids; seed is the discovered state. With CC_PACK9_SHOTS=<folder>, shot(name) saves a PNG there (off otherwise).

export type Page = {
  ev: (expression: string) => Promise<any>;
  waitFor: (expression: string, label: string, timeoutMs?: number) => Promise<void>;
  seed: any; tabA: string; tabB: string;
  shot: (name: string) => Promise<void>;
};

const REPO = resolve(".");

export async function withFixedBehaviour(body: (page: Page) => Promise<void>) {
  const repoScratch = join(REPO, "scratch"), repoScratchCount = () => (existsSync(repoScratch) ? readdirSync(repoScratch).length : 0);
  const repoScratchBefore = repoScratchCount();
  await withFixedPage(async ({ ev, waitFor, page, seed: fresh, fixed, secondFixed, discovered, dataDir }) => {
    assert.ok(discovered, "control: the server's discovered state is there");
    const tabs = [fixed, secondFixed];
    assert.ok(tabs.every((tab) => tab?.fixedCrew), "control: two fixed tabs");
    const [tabA, tabB] = tabs.map((tab) => tab.id as string);
    assert.notEqual(tabA, tabB, "control: two independent fixed tabs");
    for (const state of [fresh, discovered]) assert.deepEqual(state.projects[0].tabs.map((tab: any) => tab.id), [tabA, tabB], "control: both states hold the same two fixed tabs");
    for (const tab of discovered.projects[0].tabs) {
      assert.equal(tab.processState?.tabId, tab.id, `control: ${tab.id} is its own process owner`);
      assert.ok(tab.fixedCrew.preferences.leader?.assignment && tab.fixedCrew.preferences.coder?.assignment, `control: ${tab.id} has an assigned leader and coder`);
      assert.deepEqual(tab.crew.map((seat: any) => seat.seatKey), tab.crew.map((seat: any) => `${tab.id}.${seat.slot}`), `control: ${tab.id}'s seat keys carry its own id`);
      assert.ok(tab.crew.some((seat: any) => seat.slot === "leader") && tab.crew.some((seat: any) => seat.slot === "coder"), `control: ${tab.id} shows a leader and a coder seat`);
    }
    await page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await deliverState(ev, discovered);
    await waitFor(`document.querySelector('#crew [data-seat-id="coder"] [data-seat-open]')!==null&&document.querySelector("#view .thread")!==null&&document.querySelectorAll("#tabs [role=tab]").length>1`, "the discovered state is drawn");
    const shot = async (name: string) => {
      const dir = process.env.CC_PACK9_SHOTS;
      if (!dir) return;
      await delay(600); // the dialog and the toast fade in
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from((await page("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    };
    await body({ ev, waitFor, seed: discovered, tabA, tabB, shot });
    assert.deepEqual(await ev("window.__ccErrors"), [], "no page errors");
    assert.ok(existsSync(join(dataDir, "scratch")) && existsSync(join(dataDir, "config", "workspaces.json")), "the server created its scratch and workspaces in the temp data root");
    assert.equal(repoScratchCount(), repoScratchBefore, "the repo's own scratch/ gained no files");
  }, { fixture: "fixed2" });
}
