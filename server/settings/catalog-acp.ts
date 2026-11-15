import { ACP_MAX_CLIS, acpIdFromName, validateAcpCli, type AcpCli } from "../config-acp.ts";
import { CLI_CATALOG, type CatalogEntry } from "./cli-catalog.ts";
import { catalogTool } from "./cli-catalog-validation.ts";
import { readChatRequestId } from "../chat-store.ts";
import type { CatalogToolFacts, SettingsState } from "./types.ts";

export function validateCatalogRequest(message: unknown): CatalogEntry {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid catalog request");
  const value = message as Record<string, unknown>;
  if (!readChatRequestId(value.requestId)) throw new Error("requestId is required");
  if (Object.keys(value).some((key) => !["type", "requestId", "cli", "confirm"].includes(key))) throw new Error("Unexpected catalog request field");
  if (value.type !== "registerCatalogCli" || value.confirm !== true) throw new Error("Catalog connection confirmation is required");
  return catalogTool(value.cli);
}
export function catalogProfile(entry: CatalogEntry): AcpCli {
  if (entry.leader.kind !== "acp" || !entry.leader.start) throw new Error("This tool uses its built-in connection");
  return validateAcpCli({ name: entry.leader.registrationName, ...entry.leader.start });
}
const sameProfile = (a: AcpCli, b: AcpCli) => a.id === b.id && a.name === b.name && a.program === b.program && JSON.stringify(a.args) === JSON.stringify(b.args);
export function catalogOwner(cli: AcpCli): CatalogEntry | undefined {
  return CLI_CATALOG.find((entry) => entry.leader.kind === "acp" && acpIdFromName(entry.leader.registrationName!) === cli.id);
}
export function catalogLeaderEligible(cli: AcpCli, facts: Record<string, CatalogToolFacts> = {}): boolean {
  const entry = catalogOwner(cli);
  if (!entry) return true; // Manual custom ACP entries retain the existing first-chat connection check.
  const status = facts[entry.id];
  return sameProfile(cli, catalogProfile(entry)) && status?.installed === true
    && !!status.version;
}
// The launch gate is looser than the picker (the same rule as OpenCode, cli-availability.ts): it blocks only a KNOWN missing tool or a saved
// connection that does not match the catalog. An unknown state (not checked yet, or a slow --version) does not stop a chat; the real start
// then fails with the clear not-found error if the program is missing.
export function catalogLaunchAllowed(cli: AcpCli, facts: Record<string, CatalogToolFacts> = {}): boolean {
  const entry = catalogOwner(cli);
  if (!entry) return true;
  return sameProfile(cli, catalogProfile(entry)) && facts[entry.id]?.installed !== false;
}
export function eligibleAcpClis(clis: AcpCli[], state: SettingsState): AcpCli[] {
  return clis.filter((cli) => catalogLeaderEligible(cli, state.catalogTools));
}
export function assertCatalogLeaderEligible(cli: AcpCli, state: SettingsState): void {
  if (!catalogLaunchAllowed(cli, state.catalogTools)) throw new Error("This tool is unavailable or its saved connection does not match. Check installation and add its connection again.");
}
export function catalogLeaderLabel(cli: AcpCli) {
  const entry = catalogOwner(cli);
  if (!entry) return {}; // Custom manual entries keep their published shape.
  const tested = entry.leader.qualified === true;
  return { tested, leaderLabel: tested ? "Tested" as const : "Not tested yet" as const };
}
export function catalogFacts(state: SettingsState, clis: AcpCli[]): Record<string, CatalogToolFacts> {
  return Object.fromEntries(CLI_CATALOG.map((entry) => {
    const facts = state.catalogTools[entry.id];
    const existing = entry.leader.kind === "acp" ? clis.find((cli) => cli.id === acpIdFromName(entry.leader.registrationName!)) : undefined;
    const legacy = Object.hasOwn(state.tools, entry.id) ? state.tools[entry.id as keyof typeof state.tools] : undefined;
    const installed = legacy?.installed ?? facts.installed, signedIn = legacy?.signedIn ?? facts.signedIn;
    return [entry.id, { ...facts, tested: entry.leader.qualified === true, leaderLabel: entry.leader.qualified === true ? "Tested" : "Not tested yet", ...(legacy ? { installed, signedIn, version: legacy.version } : {}),
      registered: !!existing && sameProfile(existing, catalogProfile(entry)),
      leaderEligible: entry.leader.kind === "builtin" ? installed === true && signedIn === true : !!existing && catalogLeaderEligible(existing, state.catalogTools) }];
  }));
}
export function registerCatalogConnection(message: unknown, deps: {
  clis: () => AcpCli[]; resolve: (program: string) => string; write: (clis: AcpCli[]) => void; publish: (clis: AcpCli[]) => void;
}): { id: string } {
  const entry = validateCatalogRequest(message);
  try {
    const profile = catalogProfile(entry);
    deps.resolve(entry.detection!.program);
    deps.resolve(profile.program);
    const saved = deps.clis();
    const existing = saved.find((cli) => cli.id === profile.id);
    if (existing) {
      if (!sameProfile(existing, profile)) throw new Error("Conflicting saved connection; preserved");
      return { id: profile.id };
    }
    if (saved.length >= ACP_MAX_CLIS) throw new Error(`At most ${ACP_MAX_CLIS} ACP CLIs; capacity reached`);
    const next = [...saved, profile];
    deps.write(next);
    deps.publish(next);
    return { id: profile.id };
  } catch (error) { throw new Error(`Installed. Connection could not be added. ${(error as Error).message}`); }
}
