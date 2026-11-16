// Fresh per-launch environment. Windows variable names are case-insensitive.
// Keep this at each launch boundary, including injected leader and crew spawns.
import { isAbsolute, relative } from "node:path";
import { assertNoLinks, managedCli, managedRoot } from "./paths.ts";

export function disableCopilotUpdate(env: NodeJS.ProcessEnv, program?: string, profile: NodeJS.ProcessEnv = env, candidate = false): NodeJS.ProcessEnv {
  const copilot = !!program && /(?:^|[\\/])copilot\.exe$/i.test(program);
  const active = copilot ? managedCli(profile, "copilot") : null;
  const root = copilot && candidate ? managedRoot(profile, "copilot") : null;
  let managed = !!active && program === active;
  if (!managed && candidate && root && program && isAbsolute(program)) {
    const path = relative(root, program);
    try { assertNoLinks(program); managed = /^install-[a-f0-9-]+[\\/]copilot\.exe$/.test(path); } catch { /* refuse linked candidates */ }
  }
  if (!managed) return { ...env };
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "copilot_auto_update")), COPILOT_AUTO_UPDATE: "false" };
}
