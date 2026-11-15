import { UNSUPPORTED_MESSAGE } from "./cli-login-policy.js";
import { acpIdFromName, validateAcpCli } from "../config-acp.ts";
import { CLI_CATALOG, type CatalogEntry, type CatalogRecipe } from "./cli-catalog.ts";

function httpsAddress(address: string): void {
  const url = new URL(address);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`Unsafe catalog address: ${address}`);
}
function validateRecipe(recipe: CatalogRecipe, depth = 0): void {
  if (!recipe || depth > 1 || typeof recipe.command !== "string" || !recipe.command) throw new Error("Invalid catalog recipe");
  switch (recipe.kind) {
    case "opencode": break;
    case "powershell": httpsAddress(recipe.url); break;
    case "npm":
    case "uv": if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(recipe.package)) throw new Error("Invalid catalog package"); break;
    case "winget": if (!/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(recipe.id)) throw new Error("Invalid WinGet id"); break;
    case "ordered":
      if (!Array.isArray(recipe.steps) || recipe.steps.length !== 2) throw new Error("Invalid ordered recipe");
      recipe.steps.forEach((step) => validateRecipe(step, depth + 1)); break;
    default: throw new Error("Unknown catalog recipe kind");
  }
}
export function validateCatalog(entries: readonly CatalogEntry[]): void {
  if (!entries.length) throw new Error("Catalog is empty");
  const ids = new Set<string>();
  for (const entry of entries) {
    try {
      if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || ["constructor", "toString", "__proto__"].includes(entry.id) || ids.has(entry.id)) throw new Error("Invalid or duplicate id");
      ids.add(entry.id);
      if (!entry.sources.length) throw new Error("Missing catalog sources");
      entry.sources.forEach(httpsAddress);
      if (entry.recipe) validateRecipe(entry.recipe);
      if (typeof entry.signIn.managed !== "boolean" || entry.signIn.unsupportedMessage !== (entry.signIn.managed ? null : UNSUPPORTED_MESSAGE)) throw new Error("Invalid managed sign-in policy");
      if (entry.signIn.managed && !entry.signIn.command) throw new Error("Managed sign-in needs a fixed command");
      if (entry.leader.kind === "acp") {
        const checked = validateAcpCli({ name: entry.leader.registrationName, ...entry.leader.start });
        if (/\.(?:exe|cmd|bat|com|ps1)$/i.test(checked.program)) throw new Error("Catalog programs must be extensionless");
      }
    } catch (error) { throw new Error(`Catalog ${entry.id}: ${(error as Error).message}`); }
  }
}
validateCatalog(CLI_CATALOG);
const byId = new Map(CLI_CATALOG.map((entry) => [entry.id, entry]));
export function catalogTool(id: unknown): CatalogEntry {
  const entry = typeof id === "string" ? byId.get(id) : undefined;
  if (!entry || !entry.recipe) throw new Error("Unknown or provider-only catalog CLI");
  return entry;
}

// Only display metadata crosses to the renderer. Recipes remain server-owned.
export function catalogMetadata() {
  return CLI_CATALOG.map(({ id, displayName, vendor, platforms, wave, prerequisites, recipe, signIn, leader, sources, guidance, limitation, verified }) =>
    ({ id, displayName, vendor, platforms, wave, prerequisites, installable: recipe !== null, command: recipe?.command ?? null,
      signIn: { ...signIn }, leader: { kind: leader.kind, verified: leader.verified, qualified: leader.qualified, limitation: leader.limitation,
        connectionId: leader.registrationName ? acpIdFromName(leader.registrationName) : null }, sources, guidance, limitation, verified }));
}
