// Packaged privacy guards. Every target must occur exactly once.
export const pack29ScanMutations = [
  ["p29-scan-allow-hash","scripts/export-public/scan.mjs","createHash(\"sha256\").update(bytes).digest(\"hex\") === entry.sha256.toLowerCase()","true"],
  ["p29-scan-allow-scope","scripts/export-public/scan.mjs","const reviewedPath = (path) => path.startsWith(\"node_modules/\") && !path.includes(\"\\\\\") && path.split(\"/\").every((part) => part && part !== \".\" && part !== \"..\");","const reviewedPath = (path) => true;"],
  ["p29-scan-allow-malformed","scripts/export-public/scan.mjs","catch { refuse(\"refusing packaged scan: reviewed third-party allowlist is missing or malformed\"); }","catch { return []; }"],
  ["p29-package-scan","scripts/dist-installer.mjs","    await scanPackaged(join(stage, \"win-unpacked/resources/app\"));","    // packaged scan removed"],
  ["p29-scan-node-modules","scripts/export-public/scan.mjs","  for (const { path, bytes } of files) {","  for (const { path, bytes } of files) {\n    if (packaged && path.startsWith(\"node_modules/\")) continue;"],
  ["p29-scan-heuristic-scope","scripts/export-public/scan.mjs","const heuristics = !packaged || !path.startsWith(\"node_modules/\");","const heuristics = true;"],
  ["p29-scan-empty-control","scripts/export-public/scan.mjs","if (files.length < MIN_PACKAGED_FILES)","if (false)"],
  ["p29-scan-forbidden","scripts/export-public/scan.mjs","if (FORBIDDEN_PACKAGED_ENTRIES.some((entry) =>","if (FORBIDDEN_PACKAGED_ENTRIES.filter((entry) => entry !== \"config/first-run.json\").some((entry) =>"],
  ["p29-export-first-run","scripts/export-public.mjs","\"config/first-run.json\", \"config/setups.json\",","\"config/setups.json\","],
];
