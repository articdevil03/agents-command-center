import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildLeaderOptions } from "../leader.ts";
import { isInsideFolder } from "../leader-common.ts";
import { claudeCliPath, dataRoot, describeError, workspaces } from "./state.ts";
import { leaderSeatOf } from "./tabs.ts";

const leaderCheckTimeout = Number(process.env.CC_LEADER_HEALTH_TIMEOUT_MS) || 10_000;
const LEADER_CHECK_REUSE_MS = 24 * 60 * 60 * 1000;
export async function checkLeaderHealth(): Promise<void> {
  if (process.env.CC_SKIP_LEADER_CHECK === "1") return;
  const tab = workspaces.projects[0]?.tabs[0];
  const lead = tab && leaderSeatOf(tab);
  if (!tab || !lead || lead.cli !== "claude") return;
  // The check runs from the data root, but the same CLI path will start in this tab's folder: a CLI planted there is refused here too.
  if (claudeCliPath && isInsideFolder(claudeCliPath, tab.folder)) { console.error(`Claude leader health check skipped: the Claude CLI (${claudeCliPath}) lies inside the tab folder (${tab.folder})`); return; }
  // Every check is one paid model turn: one that passed in the last day for this model and CLI is not repeated.
  const checkFile = join(dataRoot, "leader-check.json");
  const checkedFor = { model: lead.model, cli: claudeCliPath ?? "" };
  try {
    const saved = JSON.parse(await readFile(checkFile, "utf8"));
    if (saved.model === checkedFor.model && saved.cli === checkedFor.cli && Number.isFinite(saved.at) && Date.now() - saved.at < LEADER_CHECK_REUSE_MS && Date.now() >= saved.at) {
      console.log("Claude leader health check skipped: it passed recently");
      return;
    }
  } catch { /* no usable earlier result: check now */ }
  const abortController = new AbortController();
  let handle: ReturnType<typeof query> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // The project's own settings (and their hooks) must not run just because the app started: user settings only, from the data root.
    handle = query({ prompt: "Reply with exactly: OK", options: { abortController, ...buildLeaderOptions({ model: lead.model, effort: lead.effort }, dataRoot, claudeCliPath), settingSources: ["user"] } });
    let receivedResult = false;
    const result = (async () => {
      for await (const message of handle!) {
        if (message.type !== "result") continue;
        if (message.is_error) throw new Error("health check returned an error result");
        receivedResult = true;
        return;
      }
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new Error("health check timed out"));
      }, leaderCheckTimeout);
    });
    await Promise.race([result, deadline]);
    if (!receivedResult) throw new Error("health check ended without a result");
    void Promise.resolve(handle.return()).catch(() => {});
    console.log("Claude leader health check passed");
    await writeFile(checkFile, JSON.stringify({ at: Date.now(), ...checkedFor }), "utf8").catch(() => {});
  } catch (err) {
    if (abortController.signal.aborted && handle) {
      try { void Promise.resolve(handle.return()).catch(() => {}); } catch { /* best effort after timeout */ }
    }
    console.error(`Claude leader health check failed: ${describeError(err)}`);
  }
  finally { if (timeout) clearTimeout(timeout); }
}
