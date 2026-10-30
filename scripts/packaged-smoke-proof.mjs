// Scoped packaging mutation proof. Every fixture lives in an OS temp directory;
// no builder invocation or smoke run targets the repo's real dist/ folder.
import { tempOnly } from "./packaged-smoke-proof/context.mjs";
await import("./packaged-smoke-proof/steps-dist-1.mjs");
await import("./packaged-smoke-proof/steps-dist-2.mjs");
await import("./packaged-smoke-proof/steps-dist-3.mjs");
await import("./packaged-smoke-proof/steps-isolated.mjs");

console.log(tempOnly
  ? "ALL PACKAGED SMOKE GUARDS PASSED (temp-only: dist wrapper and write containment; the isolated server steps need a build)"
  : "ALL PACKAGED SMOKE GUARDS PASSED");
