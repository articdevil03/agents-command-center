import type { CliId, SettingsState } from "./types.ts";
import { LOGIN_MESSAGES } from "./cli-login.ts";

export function cliAvailability(cli: CliId, state: SettingsState): boolean | null {
  const facts = cli === "opencode" ? state.catalogTools.opencode : state.tools[cli];
  if (cli === "opencode" && facts.installed === true) return facts.supportedVersion === false ? false : true;
  return facts.installed ?? null;
}

export function assertCliAvailable(cli: string, state: SettingsState): void {
  if (cli !== "opencode") return;
  if (cliAvailability(cli, state) !== false) return;
  const facts = state.catalogTools.opencode;
  throw new Error(facts.installed === true ? LOGIN_MESSAGES.unsupportedVersion
    : facts.installed === false ? LOGIN_MESSAGES.notInstalled : LOGIN_MESSAGES.installationUnknown);
}
