import { readFileSync } from "node:fs";
import { acpClisPath, publishConfigFile, liveWritePath, isObject } from "./config-files.ts";
import type { AcpKind } from "./config.ts";

// ---- ACP CLIs: leader CLIs the user added from Settings by their start command (config/acp-clis.json). No shell ever: the program is a bare name resolved on PATH, the arguments are a list of plain tokens. ----
export type AcpCli = { id: string; name: string; program: string; args: string[]; lastModel?: string };
export const ACP_MAX_CLIS = 12;
const ACP_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ACP_ARG = /^[A-Za-z0-9._:=/@+,-]{1,120}$/;
export const acpIdFromName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
export const acpKindOf = (cli: AcpCli): AcpKind => `acp:${cli.id}`;
export function validateAcpCli(value: unknown): AcpCli {
  if (!isObject(value)) throw new Error("An ACP CLI needs a name and a start command");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f<>]/.test(name)) throw new Error("The CLI name must be 1 to 40 characters, with no control characters or < >");
  const id = acpIdFromName(name);
  if (!id || (typeof value.id === "string" && value.id !== id)) throw new Error("The CLI name needs at least one letter or digit");
  if (typeof value.program !== "string" || !ACP_PROGRAM.test(value.program)) throw new Error("The program must be a plain command name (like gemini), not a path or anything that needs a shell");
  if (!Array.isArray(value.args) || value.args.length > 16 || !value.args.every((arg) => typeof arg === "string" && ACP_ARG.test(arg))) throw new Error("The arguments must be plain words (letters, digits and . _ : = / @ + , -), 16 at most");
  const lastModel = typeof value.lastModel === "string" && /^[ -~]{1,100}$/.test(value.lastModel) ? value.lastModel : undefined;
  return { id, name, program: value.program, args: [...value.args] as string[], ...(lastModel ? { lastModel } : {}) };
}
// "gemini --acp" -> { program: "gemini", args: ["--acp"] }. Quotes, pipes, redirects or variables are refused (there is no shell to run them).
export function parseAcpStartCommand(text: unknown): { program: string; args: string[] } {
  const words = typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean) : [];
  if (!words.length) throw new Error("The start command is required (for example: gemini --acp)");
  return { program: words[0], args: words.slice(1) };
}
export function readAcpClis(path: string = acpClisPath): AcpCli[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`ACP CLI list is unreadable: ${path} (${(err as Error).message}); fix or delete it`); }
  if (!isObject(raw) || !Array.isArray(raw.clis)) throw new Error(`ACP CLI list is malformed, expected { clis: [] }: ${path}`);
  const list = raw.clis.map(validateAcpCli);
  if (new Set(list.map((cli) => cli.id)).size !== list.length) throw new Error(`ACP CLI list has a duplicate name: ${path}`);
  return list;
}
export function writeAcpClis(clis: AcpCli[], path?: string): void {
  const checked = clis.map(validateAcpCli);
  if (new Set(checked.map((cli) => cli.id)).size !== checked.length) throw new Error("that name is already used by another ACP CLI");
  if (checked.length > ACP_MAX_CLIS) throw new Error(`at most ${ACP_MAX_CLIS} ACP CLIs`);
  publishConfigFile(JSON.stringify({ clis: checked }, null, 2) + "\n", liveWritePath(path, acpClisPath), true);
}
