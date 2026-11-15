import { pathToFileURL } from "node:url";

export function serverNodeRuntime(serverEntry, passDiscoverySkip, executable = process.execPath) {
  return { command: executable, args: buildServerCommandArgs(serverEntry, passDiscoverySkip), env: { ELECTRON_RUN_AS_NODE: "1" } };
}

export function buildServerCommandArgs(serverEntry, passDiscoverySkip) {
  if (!passDiscoverySkip) return [serverEntry];
  // Direct `node <entry>` cannot clear this startup-only flag after the entry
  // imports but before the server launches agents. The bootstrap keeps it in
  // the server during discovery and removes it before agent children spawn.
  const entryUrl = pathToFileURL(serverEntry).href;
  const bootstrap = "im" + "port(" + JSON.stringify(entryUrl) + ").then(() => { delete process.env.CC_SKIP_DISCOVERY; });";
  return ["--input-type=module", "--eval", bootstrap];
}
