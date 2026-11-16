export const pack36ModeLockMutations = [
  ["p36-remove-mode-lock", "server/leader-opencode.ts", "modeLocked: () => turnOpen, ", ""],
  ["p36-never-mode-lock", "server/leader-opencode.ts", "modeLocked: () => turnOpen, ", "modeLocked: () => false, "],
  ["p36-prompt-skips-mode-patch", "server/leader-opencode.ts", "return afterModePatch(() => prompt(text, images)).then(", "return prompt(text, images).then("],
  ["p36-steer-skips-mode-patch", "server/leader-opencode.ts", "void ready.then(() => afterModePatch(() => prompt(text, images))).then(", "void ready.then(() => prompt(text, images)).then("],
  ["p36-posts-after-stop", "server/leader-opencode.ts", "(stopped || dead ? undefined : run())", "run()"],
  ["p36-attempt-no-settle", "test/pack18-harness.ts", "while (!error && Date.now() < until) { await sleep(20); error = findError(); }", "while (false) { await sleep(20); error = findError(); }"],
];
export const pack36ModeLockCatchMap = Object.fromEntries(pack36ModeLockMutations.map(([id]) => [id, id === "p36-attempt-no-settle" ? "test/pack36-attempt.test.ts" : "test/pack36-opencode-mode-lock.test.ts"]));
