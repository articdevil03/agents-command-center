import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { editorTestMs, J, withPage, skipped, deliver } from "./pack18-editor-harness.ts";

// Pack 13 (Work on this project only), the page side, on the fixed crew page (harness fixture "fixed": the real page in a real headless Chrome, its
// state from the real server over a fake socket). The checked/unchecked payload and reopen cases moved to FCCREATE project-only
// (test/fixed-crew-creation.test.ts), which also holds the two labels, the AGENTS.md help and the chosen project name. What stays here is the
// server's projectRules reply shown as a toast, and the data-root safety checks of the old private fixture.
// The old CC_PACK13_SHOTS screenshot export is retired: it wrote PNG files for a person to look at, and nothing asserted on them.

const REPO = resolve(".");
const scratchDir = join(REPO, "scratch"), workspacesFile = join(REPO, "config", "workspaces.json");
const scratchCount = () => (existsSync(scratchDir) ? readdirSync(scratchDir).length : 0);
// The file is untracked, so a fresh clone has none: absent must stay absent, present must stay byte-identical.
const workspacesBytes = () => (existsSync(workspacesFile) ? readFileSync(workspacesFile) : null);

test("each projectRules reply shows its own text as a toast", { timeout: editorTestMs(90_000) }, async (t) => {
  if (skipped(t)) return;
  const scratchBefore = scratchCount(), workspacesBefore = workspacesBytes();
  await withPage(async ({ ev, waitFor, dataDir }) => {
    assert.ok(existsSync(join(dataDir, "scratch")) && existsSync(join(dataDir, "config", "workspaces.json")), "the server created its scratch and workspaces in the temp data root");
    const toast = () => ev(`(()=>{const el=document.querySelector("#toast");return el?{text:el.textContent,shown:!el.hidden&&el.getClientRects().length>0}:null})()`);
    let previous: string | null = null;
    for (const message of ["Added AGENTS.md", "This folder already has rules for Quokka, left alone", "This folder already has an AGENTS.md of its own, left alone", "Could not write AGENTS.md: the folder is read-only"]) {
      assert.notEqual(previous, message, "control: the next message differs from the toast already shown");
      assert.notEqual((await toast())?.text, message, "control: the toast does not already say it");
      await deliver(ev, { type: "projectRules", tabId: "x", outcome: "x", message });
      await waitFor(`document.querySelector("#toast")?.textContent===${J(message)}&&!document.querySelector("#toast").hidden`, `the toast says: ${message}`);
      const now = await toast();
      assert.notEqual(now, null, "the #toast element was FOUND");
      assert.deepEqual(now, { text: message, shown: true }, `the toast says exactly: ${message}`);
      previous = message;
    }
  }, { fixture: "fixed" });
  assert.equal(scratchCount(), scratchBefore, "the repo's own scratch/ gained no files");
  const after = workspacesBytes();
  assert.ok(workspacesBefore === null ? after === null : after !== null && workspacesBefore.equals(after), "the repo's workspaces file is untouched (same existence, same bytes)");
});
