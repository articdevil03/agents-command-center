export const pack35MimoMutations = [
  ["p35-mimo-reserved-model", "server/settings/cli-key-profiles.ts", 'if (tool === "mimo" && field.id === "model" && /^(?:__proto__|constructor|prototype)$/i.test(trimmed)) throw new Error("Invalid MiMo model name.");', '/* mutation: reserved model accepted */'],
  ["p35-mimo-secret-json", "server/settings/cli-key-profiles.ts", 'headers: { "api-key": "{env:MIMO_API_KEY}" }', 'headers: { "api-key": record.key }'],
  ["p35-mimo-concatenated-json", "server/settings/cli-key-profiles.ts", 'MIMOCODE_CONFIG_CONTENT: JSON.stringify({', `MIMOCODE_CONFIG_CONTENT: ((config) => '{"provider":' + JSON.stringify(config.provider) + ',"model":"' + config.model + '"}')({`],
  ["p35-mimo-model-validation", "server/settings/cli-key-profiles.ts", 'if (tool === "mimo" && field.id === "model" && !/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) throw new Error("Invalid MiMo model name.");', '/* mutation: missing MiMo model validation */'],
  ["p35-mimo-wrong-tool", "server/settings/cli-key.ts", 'const record = this.#cache.get(tool.id);', 'const record = this.#cache.get(tool.id) ?? this.#cache.get("mimo");'],
  ["p35-mimo-derived-env", "server/settings/cli-key-profiles.ts", '...profile.derive?.(checked)', '/* mutation: derived environment omitted */'],
];
export const pack35MimoCatchMap = Object.fromEntries(pack35MimoMutations.map(([id]) => [id, "test/pack35-mimo.test.ts"]));
