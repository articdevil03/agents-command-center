import { CLI_CATALOG } from "./cli-catalog.ts";

export type KeyField = { id: string; kind: "secret" | "choice" | "text"; label: string; required: true; maxLength: number; choices?: readonly { label: string; value: string }[]; placeholder?: string };
type BoundField = KeyField & { env?: string };
export type KeyRecord = Record<string, string>;
type KeyProfile = readonly BoundField[] & { derive?: (record: KeyRecord) => Record<string, string> };
const secret = (env: string, label = "API key"): BoundField => ({ id: "key", kind: "secret", label, required: true, maxLength: 4096, env });
const model = (env: string, placeholder?: string): BoundField => ({ id: "model", kind: "text", label: "Model name", required: true, maxLength: 128, env, ...(placeholder ? { placeholder } : {}) });
export const CLI_KEY_PROFILES: Readonly<Record<string, KeyProfile>> = Object.freeze({
  mimo: Object.assign([secret("MIMO_API_KEY"), { id: "model", kind: "text" as const, label: "Model name", required: true as const, maxLength: 64, placeholder: "mimo-v2.5-pro" }], {
    derive: (record: KeyRecord) => ({ MIMOCODE_CONFIG_CONTENT: JSON.stringify({
      provider: { mimo: { npm: "@ai-sdk/openai-compatible", name: "MiMo",
        options: { baseURL: "https://api.xiaomimimo.com/v1", headers: { "api-key": "{env:MIMO_API_KEY}" } },
        models: { [record.model]: { name: record.model } } } }, model: `mimo/${record.model}`,
    }) }),
  }),
  gemini: [secret("GEMINI_API_KEY")],
  mistral: [secret("MISTRAL_API_KEY")],
  grok: [secret("XAI_API_KEY")],
  // https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html
  // KIMI_MODEL_NAME enables the model override; the documented example is kimi-for-coding.
  kimi: [secret("KIMI_MODEL_API_KEY"), model("KIMI_MODEL_NAME", "kimi-for-coding")],
  copilot: [secret("COPILOT_GITHUB_TOKEN", "GitHub token")],
  // https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
  // NOT VERIFIED 2026-11-16, because no released binary or account was used: whether a previously cached sign-in mode of Qwen or Gemini ignores the saved key; whether project settings can override the base URL; other endpoints of the same vendor are not offered.
  qwen: [secret("OPENAI_API_KEY"), { id: "endpoint", kind: "choice", label: "Region", required: true, maxLength: 128, env: "OPENAI_BASE_URL", choices: [
    { label: "China", value: "https://coding.dashscope.aliyuncs.com/v1" },
    { label: "International", value: "https://coding-intl.dashscope.aliyuncs.com/v1" },
  ] }, model("OPENAI_MODEL")],
});
export function validateKeyProfiles(profiles = CLI_KEY_PROFILES): void {
  for (const [tool, fields] of Object.entries(profiles)) {
    if (!CLI_CATALOG.some((entry) => entry.id === tool && entry.recipe) || !fields.length) throw new Error("Invalid key profile tool.");
    const ids = new Set<string>(), envs = new Set<string>();
    for (const field of fields) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(field.id) || ids.has(field.id) || (field.env !== undefined && (!/^[A-Z][A-Z0-9_]+$/.test(field.env) || envs.has(field.env)))
        || (!field.env && !fields.derive) || !["secret", "choice", "text"].includes(field.kind) || !field.label || field.required !== true || field.maxLength !== (field.kind === "secret" ? 4096 : tool === "mimo" ? 64 : 128)) throw new Error("Invalid key profile field.");
      ids.add(field.id); if (field.env) envs.add(field.env);
      if (field.kind === "choice" && (!field.choices?.length || new Set(field.choices.map((c) => c.value)).size !== field.choices.length || field.choices.some((c) => !c.label || new URL(c.value).protocol !== "https:"))) throw new Error("Invalid key profile choices.");
      if (field.choices) { field.choices.forEach(Object.freeze); Object.freeze(field.choices); } Object.freeze(field);
    }
    Object.freeze(fields);
  }
}
validateKeyProfiles();
export function keyProfile(tool: string): { fields: KeyField[] } | null {
  if (!Object.hasOwn(CLI_KEY_PROFILES, tool)) return null;
  return { fields: CLI_KEY_PROFILES[tool].map(({ env: _env, ...field }) => structuredClone(field)) };
}
export function validateKeyRecord(tool: unknown, input: unknown): KeyRecord {
  if (typeof tool !== "string" || !Object.hasOwn(CLI_KEY_PROFILES, tool)) throw new Error("This tool does not support saved keys.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid key fields.");
  const fields = CLI_KEY_PROFILES[tool], raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((id) => !fields.some((field) => field.id === id))) throw new Error("Unknown key field.");
  const record: KeyRecord = {};
  for (const field of fields) {
    const value = raw[field.id];
    if (!Object.hasOwn(raw, field.id) || typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) throw new Error("Invalid key field value.");
    const trimmed = value.trim();
    if (field.kind === "secret" && (Buffer.byteLength(trimmed) < 8 || Buffer.byteLength(trimmed) > 4096)) throw new Error("The key must be between 8 and 4096 bytes.");
    if (field.kind === "text" && !/^[A-Za-z0-9._/:\-]{1,128}$/.test(trimmed)) throw new Error("Invalid model name.");
    if (tool === "mimo" && field.id === "model" && !/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) throw new Error("Invalid MiMo model name.");
    if (tool === "mimo" && field.id === "model" && /^(?:__proto__|constructor|prototype)$/i.test(trimmed)) throw new Error("Invalid MiMo model name.");
    if (field.kind === "choice" && !field.choices!.some((choice) => choice.value === value)) throw new Error("Choose an allowed region.");
    record[field.id] = trimmed;
  }
  return record;
}
export function keyEnvFor(tool: string, record: KeyRecord): Record<string, string> {
  const checked = validateKeyRecord(tool, record);
  const profile = CLI_KEY_PROFILES[tool];
  return { ...Object.fromEntries(profile.filter((field) => field.env).map((field) => [field.env!, checked[field.id]])), ...profile.derive?.(checked) };
}
