// Browser mutation row -> [the test file that catches it, its test-name pattern]. Mapping data only: test/tooling-sweep-proof.test.ts spreads it into PROOFS.
export const BROWSER_PROOFS: Record<string, [string, string]> = {
  "guard-browser-temp-removed-after-failed-stop": ["test/browser-fixed-contract.test.ts", "^BFIX teardown preserves cleanup after failed stop$"],
  "guard-browser-cap-armed-by-workload-promise": ["test/browser-guards.test.ts", "^the cap stops the whole tree of a Chrome"],
  "guard-pack7-r1-unlock-check-name": ["test/browser-fixed-contract.test.ts", "^BFIX fixed picker expected check names$"],
  "guard-browser-harness-reply-wait-own-start": ["test/browser-fixed-contract.test.ts", "^BFIX action-local reply wait plain Enter$"],
  "guard-browser-harness-reply-wait-own-start-chip": ["test/browser-fixed-contract.test.ts", "^BFIX action-local reply wait suggestion chip$"],
};
