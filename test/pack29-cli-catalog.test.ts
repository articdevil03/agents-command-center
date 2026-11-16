import test from "node:test";
import assert from "node:assert/strict";
import { CLI_CATALOG, type CatalogEntry } from "../server/settings/cli-catalog.ts";
import { catalogTool, catalogMetadata, validateCatalog } from "../server/settings/cli-catalog-validation.ts";

const commands = {
  claude: "irm https://claude.ai/install.ps1 | iex",
  codex: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  opencode: "Install verified OpenCode 1", grok: "irm https://x.ai/cli/install.ps1 | iex",
  gemini: "npm install -g @google/gemini-cli", copilot: "Install verified GitHub Copilot CLI",
  qwen: "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
  kimi: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
  mimo: 'powershell -ep Bypass -c "irm https://mimo.xiaomi.com/install.ps1 | iex"',
  mistral: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex", then uv tool install mistral-vibe',
  minimax: "irm https://filecdn.minimax.chat/public/install.ps1 | iex",
};
const starts = { grok: "grok agent stdio", gemini: "gemini --acp", copilot: "copilot --acp", qwen: "qwen --acp", kimi: "kimi acp", mimo: "mimo acp", mistral: "vibe-acp", minimax: "mcode acp" };
const providers = ["deepseek", "glm", "nemotron", "perplexity", "muse"];
function sweep(entries: readonly CatalogEntry[]): number {
  validateCatalog(entries);
  assert.deepEqual(entries.map((e) => e.id).sort(), [...Object.keys(commands), ...providers].sort(), `actual catalog IDs: ${entries.map((e) => e.id)}`);
  let checked = 0;
  for (const entry of entries) {
    const context = JSON.stringify(entry);
    assert.ok(entry.displayName && entry.vendor && entry.limitation && entry.sources.length, context);
    assert.equal(entry.wave, 1, context); assert.equal(entry.verified, "NOT VERIFIED", context);
    assert.equal(entry.leader.qualified, false, context);
    if (providers.includes(entry.id)) {
      assert.equal(entry.recipe, null, context); assert.equal(entry.detection, null, context);
      assert.ok(entry.guidance, context); assert.equal(entry.leader.kind, "provider", context);
    } else {
      assert.equal(entry.recipe?.command, commands[entry.id as keyof typeof commands], context);
      const checkRecipe = (recipe: NonNullable<CatalogEntry["recipe"]>) => {
        if (recipe.kind === "powershell") assert.equal(recipe.url, recipe.command.match(/https:\/\/[^\s"]+/)?.[0], context);
        if (recipe.kind === "npm") assert.equal(recipe.command, `npm install -g ${recipe.package}`, context);
        if (recipe.kind === "winget") assert.equal(recipe.command, `winget install ${recipe.id}`, context);
        if (recipe.kind === "uv") assert.equal(recipe.command, `uv tool install ${recipe.package}`, context);
        if (recipe.kind === "ordered") {
          assert.equal(recipe.steps.map((step) => step.command).join(", then "), recipe.command, context);
          recipe.steps.forEach(checkRecipe);
        }
      };
      checkRecipe(entry.recipe!);
      assert.ok(entry.detection?.program && entry.detection.args.length && entry.prerequisites.length, context);
      assert.equal(catalogTool(entry.id), entry, context);
      if (entry.leader.kind === "acp") assert.equal([entry.leader.start!.program, ...entry.leader.start!.args].join(" "), starts[entry.id as keyof typeof starts], context);
      else assert.equal(entry.leader.builtin, entry.id, context);
    }
    checked++;
  }
  return checked;
}
test("catalog sweep checks every actual entry, with empty, duplicate and equal-size-swap controls", () => {
  assert.equal(sweep(CLI_CATALOG), 16);
  assert.throws(() => sweep([]), /empty/);
  assert.throws(() => sweep([...CLI_CATALOG.slice(1), CLI_CATALOG[1]]), /duplicate/);
  assert.throws(() => sweep([{ ...CLI_CATALOG[0], id: "imposter" }, ...CLI_CATALOG.slice(1)]), /actual catalog IDs/);
  const changedAddress = structuredClone(CLI_CATALOG);
  (changedAddress[0].recipe as any).url = "https://different.example/install.ps1";
  assert.throws(() => sweep(changedAddress), /claude/);
  console.log(`catalog sweep: ${CLI_CATALOG.length} entries checked: ${CLI_CATALOG.map((e) => e.id).join(", ")}`);
});
test("catalog rejects unknown, prototype and provider-only ids", () => {
  for (const id of ["unknown", "__proto__", "constructor", "toString", ...providers, {}, [], null]) assert.throws(() => catalogTool(id), /Unknown or provider-only/, JSON.stringify(id));
});
test("catalog validates every address and ACP token at load boundaries", () => {
  for (const address of ["http://example.com/a", "https://user:password@example.com/a", "file:///a"]) {
    assert.throws(() => validateCatalog([{ ...CLI_CATALOG[0], sources: [address] }]), /Unsafe catalog address/, address);
    assert.throws(() => validateCatalog([{ ...CLI_CATALOG[0], recipe: { kind: "powershell", url: address, command: "fixed" } }]), /Unsafe catalog address/, address);
  }
  const entry = catalogTool("gemini");
  for (const start of [{ program: "../evil", args: [] }, { program: "gemini.cmd", args: [] }, { program: "gemini", args: ["a&b"] }, { program: "gemini", args: Array(17).fill("x") }]) {
    assert.throws(() => validateCatalog([{ ...entry, leader: { ...entry.leader, start } }]), /Catalog gemini/, JSON.stringify(start));
  }
  assert.throws(() => validateCatalog([{ ...entry, recipe: { kind: "evil", command: "evil" } as any }]), /Unknown catalog recipe/);
  const metadata = catalogMetadata();
  assert.equal(metadata.length, 16); assert.ok(metadata.every((entry) => !("recipe" in entry)));
  assert.match(metadata.find((e) => e.id === "muse")!.guidance!, /No verified official installation/);
});
