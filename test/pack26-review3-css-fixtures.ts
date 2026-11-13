import { readFileSync } from "node:fs";
// Byte-exact historical inputs: run21 = e7487bc; restored = 2a075cc.
// These hashes explain provenance only. Tests do not need Git or history.
export const historicalCss = (version: "run21" | "restored", paths: string[]) =>
  paths.map(path => readFileSync(new URL(`./fixtures/pack26-css/${version}/${path}`, import.meta.url), "utf8"));
