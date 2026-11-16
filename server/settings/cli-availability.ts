import type { CliId, SettingsState } from "./types.ts";
import { LOGIN_MESSAGES } from "./cli-login.ts";
import { catalogOwner, REMOVING_MESSAGE } from "./catalog-acp.ts";

export function cliAvailability(cli: CliId, state: SettingsState): boolean | null {
  const facts = cli === "opencode" ? state.catalogTools.opencode : state.tools[cli];
  if (cli === "opencode" && facts.installed === true) return facts.supportedVersion === false ? false : true;
  return facts.installed ?? null;
}

export function assertCliNotRemoving(kind: string, state: SettingsState): void {
  const cli = kind.startsWith("acp:") ? catalogOwner({ id: kind.slice(4) })?.id ?? kind : kind;
  if (state.catalogTools[cli]?.action?.kind === "remove" && state.catalogTools[cli].action?.status === "running") throw new Error(REMOVING_MESSAGE);
}

export function assertCliAvailable(cli: string, state: SettingsState): void {
  assertCliNotRemoving(cli, state);
  if (cli !== "opencode") return;
  if (cliAvailability(cli, state) !== false) return;
  const facts = state.catalogTools.opencode;
  throw new Error(facts.installed === true ? LOGIN_MESSAGES.unsupportedVersion
    : facts.installed === false ? LOGIN_MESSAGES.notInstalled : LOGIN_MESSAGES.installationUnknown);
}
