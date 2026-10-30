import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertMatchingBuildArtifacts } from "../packaged-smoke.mjs";

export const root = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
export const tempRoot = realpathSync(tmpdir());
export const distScript = join(root, "scripts", "dist.mjs");
export const tempOnly = process.argv.includes("--temp-only");
const artifactArgs = process.argv.slice(2).filter((arg) => arg !== "--temp-only");
if ((tempOnly && artifactArgs.length !== 0) || (!tempOnly && artifactArgs.length !== 2)) {
  console.error("Usage: node scripts/packaged-smoke-proof.mjs <win-unpacked/resources/app> <matching Command Center.exe> | --temp-only");
  process.exit(2);
}
const matchingArtifacts = tempOnly
  ? null
  : assertMatchingBuildArtifacts(realpathSync(artifactArgs[0]), realpathSync(artifactArgs[1]));
export const packedAppSource = matchingArtifacts?.app;
