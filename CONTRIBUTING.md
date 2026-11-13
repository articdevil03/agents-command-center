# Contributing

Thanks for helping.

## Setup

```sh
npm install
npm test
npm start
```

## Before a pull request

- `npm test` passes.
- Run `npm run verify` before sending a change (it also checks that no changed file is over 400 lines).
- New behaviour comes with a test that fails without your change.
- Keep changes small and focused; one fix or feature per pull request.
- Update `README.md` or `PROTOCOL.md` when you change behaviour they describe.

## Test environment (the one inventory)

`npm test` runs `node --import ./test/crash-catcher-self.ts --test test/*.test.ts`. To run one file, use the same command with that file. Every switch below was checked against the test code that reads it.

**Needed for a full run**

- Windows and Node 24 or newer.
- Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`. The browser tests fail without it.
- `CC_SKIP_BROWSER=1` leaves the real-browser tests out on purpose. That run is **omitted browser coverage, not a full verification**; say so when you report it.

**Native Windows checks (off unless you opt in)**

These run real Git, hooks, processes and `taskkill`, so run them outside a write sandbox. A file that is not opted in prints a `NOT RUN` line.

- `CC_P26_RUN2_NATIVE=1` (`test/pack26-review1-run2-native.test.ts`): Git, hooks and process trees. It finds Git for Windows' bundled `sh.exe` next to the `git` it resolves and puts it on its own `PATH`.
- `CC_P26_RUN3_NATIVE=1` (`test/pack26-review1-run3-native.test.ts`): hook edits during a commit. It looks `sh` up the way the server does, so `sh` must resolve there.
- `CC_P26_RUN4_NATIVE=1` (`test/pack26-review1-run4-native.test.ts`): it looks for Git's `sh.exe` next to the `git` executable.
- `CC_FCX_NATIVE_REPLAY=1` (`fixed-crew-slice-fixture`, `pack18-orchestrator`, and the fixed server helper in `pack9-server-helpers.ts`): the fixed-task replay on real process trees.
- `CC_FCX_NATIVE_PROCESS=1` (`pack18-integration`, `pack18-rw-launch`): the fixed-task launch on real processes.
- `CC_P26_FINAL_NATIVE=1` (`pack26-final-shutdown-native`, `pack26-final-codex-native`): a real shutdown that ends a live worker, and a Codex-shaped log through real pipes.

**Selecting or narrowing a run**

- `CC_SWEEP_PROOF_ROW=<row name>` runs one expensive mutation proof (`C1 scoped mutation proof` in `test/tooling-sweep-proof.test.ts`). Without it that test is skipped.
- `CC_BROWSER_PHASES`, `CC_BROWSER_WIDTHS` and `CC_BROWSER_DEBUG_ONLY=1` run only part of the browser suite. They are announced, and refused under `npm test`: a narrowed run is never a full run.

**Screenshots (opt-in output, never part of verification)**

- `CC_FC_SHOTS=<folder>` (`fixed-crew-shots`) and `CC_FCT_SHOTS=<folder>` (`fixed-crew-task-shots`, `fixed-crew-task-archives-shots`) write screenshots to that folder. Without them those tests skip. **`fixed-crew-task-shots` also rewrites `docs/screenshot.png`** when `CC_FCT_SHOTS` is set; do not run it unless that is intended.
- `CC_FCT_SHOTS_ONLY=list-polish` or `review2` selects which screenshots `fixed-crew-task-archives-shots` takes.
- `CC_PACK9_SHOTS=<folder>` and `CC_PACK14_SHOTS=<folder>` only add screenshot output to page tests that already run and assert without them.

**Crash capture (diagnostics, not coverage)**

Each test process is watched by Sysinternals ProcDump, attached by pid, so a rare native crash leaves its exception and a dump. ProcDump must be on `PATH`; if it is not, one `crash catcher off` line is printed and nothing is created. When it is on, dumps go to `audits/crash-dumps` in the project folder next to `app` (outside the repository), and only the newest 10 are kept. `CC_NO_CRASH_CATCHER=1` turns capture off. It changes diagnostics only; no test is skipped.

## Bugs and ideas

Open an issue with what you did, what you expected and what happened. Screenshots help.
