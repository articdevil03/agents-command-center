export const NEVER_LAUNCHED_PROOFS: Record<string, [string, string]> = {
  "p26r7-never-dispatch": [
    "test/pack26-review2-never-launched.test.ts",
    "^P26R7N denial and successful no-tool reply cancellation$"
  ],
  "p26r7-never-legacy-interrupted": [
    "test/pack26-review2-never-launched.test.ts",
    "^P26R7N legacy interrupted reservation cancellation$"
  ],
  "p26r7-never-normalization-stage": [
    "test/pack26-review2-never-launched.test.ts",
    "^P26R7N cold restart preserves task-only stage$"
  ],
  "p26r7-never-cancel-publication": [
    "test/pack26-review2-never-launched.test.ts",
    "^P26R7N publication failure and exact fresh retry$"
  ],
  "p26r7-never-stage-release": [
    "test/pack26-review2-never-launched.test.ts",
    "^P26R7N historical stage clears only after final unresolved execution$"
  ],
  "p26r7-never-completion": [
    "test/pack26-review2-never-launched.test.ts",
    "^P26R7N direct and browser cancellation completion$"
  ],
  "p26r7-never-request-proof": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N request receipt refusal matrix$"
  ],
  "p26r7-never-live-journal": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N journal admission remains held$"
  ],
  "p26r7-never-archive": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N archived admission remains held$"
  ],
  "p26r7-never-runtime": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N runtime contradictions remain held$"
  ],
  "p26r7-never-location": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N captured authority and location remain bound$"
  ],
  "p26r7-never-positive-result": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N positive result provenance remains held$"
  ],
  "p26r7-never-journal-facts": [
    "test/pack26-review2-never-launched-refusals.test.ts",
    "^P26R7N malformed retained journal facts cannot prove no admission$"
  ]
};
