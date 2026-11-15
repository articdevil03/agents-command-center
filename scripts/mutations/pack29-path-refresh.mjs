export const pack29PathRefreshMutations = [
  ["p29-path-refresh-call", "server/main/messages/settings.ts", "    await refreshProcessPath();\n    await settingsService.refreshAll(folder);", "    await settingsService.refreshAll(folder);"],
  ["p29-path-refresh-dedupe", "server/leader-common/path-refresh.ts", "if (seen.has(pathKey(entry))) continue;", "if (false) continue;"],
  ["p29-path-refresh-exists", "server/leader-common/path-refresh.ts", "if (!isDirectory(entry)) continue;", "if (false) continue;"],
  ["p29-path-refresh-skip-folders", "server/leader-common/path-refresh.ts", "if (skip.some((folder) => isInsideFolder(entry, folder))) continue;", "if (false) continue;"],
  ["p29-path-refresh-append-only", "server/leader-common/path-refresh.ts", "if (added.length) env[key] = merged;", "if (added.length) env[key] = added.join(';');"],
  ["p29-path-refresh-cap", "server/leader-common/path-refresh.ts", "if (merged.length > 8000) return { added: [] };", "if (false) return { added: [] };"],
];

pack29PathRefreshMutations.push(["p29-path-refresh-r1-fake-injected","server/leader-common/path-refresh.ts","env.CC_TEST_FAKE_CLI === \"1\" || process.env.CC_TEST_FAKE_CLI === \"1\" || process.env.NODE_TEST_CONTEXT !== undefined","process.env.CC_TEST_FAKE_CLI === \"1\" || process.env.NODE_TEST_CONTEXT !== undefined"]);
pack29PathRefreshMutations.push(["p29-path-refresh-r1-fake-host","server/leader-common/path-refresh.ts","process.env.CC_TEST_FAKE_CLI === \"1\" || process.env.NODE_TEST_CONTEXT !== undefined","process.env.NODE_TEST_CONTEXT !== undefined"]);
pack29PathRefreshMutations.push(["p29-path-refresh-r1-node-test","server/leader-common/path-refresh.ts"," || process.env.NODE_TEST_CONTEXT !== undefined",""]);
