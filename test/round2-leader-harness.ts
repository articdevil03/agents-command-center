import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as usage from "../server/usage.ts";
import { permissionModeForSdk } from "../server/settings.ts";
import * as leaderCommon from "../server/leader-common.ts";
import { leaderChildEnv, isInsideFolder, isFullyQualified } from "../server/leader-common.ts";
import { config } from "./round2-setup.ts";

export function loadLeaderHarness(query: (args: any) => any, env: Record<string, string> = {}) {
  const leaderSource = stripTypeScriptTypes(readFileSync("server/leader.ts", "utf8"))
    .replace(/^import\s+(?:.|\r?\n)*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replace(/^export\s*\{[^}]*\}\s*from\s+["'][^"']+["'];\r?\n/gm, "")
    .replaceAll("export function", "function");
  return runInNewContext(`${leaderSource}; createLeader`, {
    ...path, ...leaderCommon, isInsideFolder, isFullyQualified, leaderChildEnv, homedir,
    process: { env },
    AbortController,
    readFileSync,
    randomUUID,
    IMAGE_EXT_TO_MIME: config.IMAGE_EXT_TO_MIME,
    usageDeltaFromResult: usage.usageDeltaFromResult,
    permissionModeForSdk,
    query,
  }) as (settings: { model: string; effort: string }, folder: string, cliPath: string | null, callbacks: any, tools?: any, mode?: string) => any;
}
