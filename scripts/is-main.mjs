import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Portable main-module detection for every supported Node 24 release.
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    const normalize = (path) => {
      const real = realpathSync(resolve(path));
      return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return normalize(process.argv[1]) === normalize(fileURLToPath(moduleUrl));
  } catch { return false; }
}
