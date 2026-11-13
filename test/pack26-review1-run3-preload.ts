import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";

if (process.env.CC_TEST_FAKE_CLI !== "1") throw new Error("Run 3 controls require the isolated test harness.");
if (process.env.CC_DATA_DIR) {
  const root = process.env.CC_DATA_DIR, base = join(root, "..");
  const state = await import("../server/main/state.ts");
  const { fixedGitOperations } = await import("../server/main/fixed-task-actions.ts");
  const file = join(base, "run3-publication-control.json");
  const rename = fs.renameSync;
  // Inject failure at the durable publication boundary, before disk/cache change.
  fs.renameSync = ((from: any, to: any) => {
    if (existsSync(file)) {
      const control = JSON.parse(readFileSync(file, "utf8"));
      const dest = String(to).replaceAll("\\", "/");
      if (control.failJournalFinal && dest.endsWith("/executions/fixed.json")) {
        const journal = JSON.parse(readFileSync(from, "utf8"));
        if (journal.executions.at(-1)?.consumed && journal.executions.at(-1)?.status === "failed") throw new Error("injected final journal publication failure");
      }
      if (control.failResult && dest.endsWith("/tasks/fixed.json")) {
        const task = JSON.parse(readFileSync(from, "utf8"));
        if (task.executions.at(-1)?.status === "failed") throw new Error("injected durable result publication failure");
      }
    }
    return rename(from, to);
  }) as typeof rename;
  syncBuiltinESMExports();
  process.on("message", (message: any) => {
    if (!message?.run3Control) return;
    try {
      const id = message.runId, tabId = message.tabId ?? "fixed";
      let value: any;
      if (message.run3Control === "registry") {
        const op = fixedGitOperations.get(id);
        value = op ? { terminal: op.terminal, treesEnded: op.treesEnded, finalized: op.finalized, cleanup: op.cleanup.size, cancelChild: !!op.cancelChild } : null;
      } else if (message.run3Control === "journal") {
        value = (awaitJournal());
      } else if (message.run3Control === "fail-result") {
        writeFileSync(file, JSON.stringify({ failResult: message.fail })); value = true;
      } else if (message.run3Control === "fail-journal") {
        writeFileSync(file, JSON.stringify({ failJournalFinal: message.fail })); value = true;
      } else if (message.run3Control === "start-leader") {
        // A harmless tool read through chat remains the normal tool authority setup.
        value = state.leaderInstances.has(tabId);
      }
      process.send?.({ run3Reply: message.id, value });
    } catch (error) { process.send?.({ run3Reply: message.id, error: (error as Error).message }); }
    function awaitJournal() {
      return readFileSync(join(root, "executions", `${message.tabId ?? "fixed"}.json`), "utf8");
    }
  });
}
