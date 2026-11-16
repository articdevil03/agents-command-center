# CLI settings and catalog

The permission mode cannot change while an OpenCode or Codex turn is running: "Finish or stop <name>'s current turn first, then change the mode." OpenCode reads its permission rules when a turn starts, so a change must wait until that turn ends. In Bypass, the leader also auto-answers OpenCode permission requests.

Canonical install progress survives page refresh/reconnect in `state.settings.catalogTools[id].action`:
`{requestId, kind:"install", status:"running"|"done"|"failed", phase:"checking"|"installing"|"verifying"|"cancelling"|null, reason:null|"needsNode"|"needsGit"|"needsWinget"|"needsPowerShell"|"downloadFailed"|"blockedByWindows"|"notFoundAfterInstall"|"cancelled"|"cleanupUnconfirmed"|"timeout"|"installFailed", message}`.
Messages are static server strings. `installed`, `version` and `signedIn` use catalog detection profiles (unknown is null, Copilot uses `copilot version`).
Raw output, credentials and environment never enter state or logs. Each output stream retains at most 64 KiB while still draining.
`cleanupUnconfirmed` retains the lock and `globalWork` close warning; another stop attempt retries owned cleanup.

## Catalog connections

`registerCatalogCli` accepts exactly `{ type:"registerCatalogCli", requestId, cli, confirm:true }`.
The ID must be an installable server catalog ID with an ACP profile. Built-in adapters
need no registration. Unknown IDs, provider-only IDs, prototype names, extra fields
(including command, url, script, package, args, cwd, env and pid), and missing/false
confirmation are refused at both handler and registration boundaries.
The tool must already resolve outside project folders. Only the catalog's extensionless
program and fixed args are saved using the existing ACP writer, then published in memory.
An identical saved connection succeeds without writing; a conflicting connection is
preserved. Capacity is 12. Failure says `Installed. Connection could not be added.` with
a reason. Connect retry never installs, signs in, grants Full access or starts a process.
Catalog registrations use `Command Center <displayName>` and its deterministic ACP ID,
preserving existing manual names such as `Gemini CLI`. `leader.connectionId` in metadata
identifies that saved entry; clients must use it rather than derive an ID from the tool ID.
The existing `completeFirstRun.acpConsent === true` check still gates Full access.

`state.cliCatalog` is sanitized metadata for all 16 entries: `id`, `displayName`, `vendor`,
`platforms`, `wave`, `prerequisites`, `installable`, display-only `command`, `signIn`
(`command`, `guidance`, `verified`, `managed`, `unsupportedMessage`), `leader` (`kind`, `verified`, `qualified`, `limitation`, `connectionId`),
`sources`, `guidance`, `limitation`, and `verified`. It contains no executable recipe object.
`verified` is `verified`, `candidate` or `NOT VERIFIED`; documented commands do not prove
installation compatibility. All catalog qualification flags start false.

`state.settings.catalogTools[id]` keeps runtime facts separate from metadata:
`installed`, `version`, `signedIn`, `registered`, `leaderEligible`, `tested`, `leaderLabel`, `connection`
(`unknown`, `verified`, `failed`), and optional existing `action`.
Unknown detection/authentication is null. Built-in detection is read from existing
`settings.tools`; new probes and managed sign-in belong to the installer block.
ACP registration is derived from the current saved matching profile, never inferred
from installation or authentication. `state.acpClis[]` additionally has `leaderEligible`,
`tested` and `leaderLabel`. For catalog ACP entries, selection requires a matching saved
profile, `installed === true` and a detected version. `leaderEligible` means the tool may
be selected and attempted after consent, not that it is authenticated or tested.
`tested` is derived only from `entry.leader.qualified === true`; `leaderLabel` is
`Tested` or `Not tested yet`. No action sets qualification. Untested tools say
`Not tested yet. Connection checked when you first chat.` and are never auto-selected.
Manual custom ACP entries keep their eligibility and first-chat behavior.
Installation, registration, login and setup start no ACP session. Setup requires
`acpConsent === true`, validates the saved command and safely resolves the executable.
First chat retains ACP initialization and session checks. Grok's catalog handshake
limitation remains unverified; selection makes no compatibility claim.

## Catalog keys

`catalogTools[id]` additionally exposes `keyProfile: { fields } | null` and
`keySaved: boolean`. Field descriptors contain `id`, `kind` (`secret`, `choice`,
`text`), `label`, `required`, `maxLength`, and optional `choices: [{label,value}]`.
They contain no environment variable names or saved values. The shared wizard and
Settings panel renders these descriptors. Existing OpenCode key sign-in is separate.

| Message | Exact fields |
|---|---|
| `submitCliKey` | `type`, `requestId`, `cli`, `fields: {key, model?, endpoint?}` |
| `removeCliKey` | `type`, `requestId`, `cli` |

Only profile field IDs are accepted. Secret values are trimmed, 8-4096 bytes,
without controls or newlines. Models require 1-128 conservative plain characters.
Endpoint choices must match the profile. Each socket request is consumed once;
per-tool admission is synchronous. Neither action returns any credential value.
Secrets and their temporary field object are cleared immediately at submission and
never enter browser storage or Settings drafts. Non-secret model and region fields remain
available after a failed save. Cancel closes the fields without changing the saved key.
Replacement is explicit and opens empty fields. Removal deletes the stored record and the usable server cache entry.

| Profile | Fields | Fixed launch environment |
|---|---|---|
| Gemini | key | GEMINI_API_KEY |
| Mistral | key | MISTRAL_API_KEY (also vibe-acp) |
| Grok | key | XAI_API_KEY |
| Kimi | key, model | KIMI_MODEL_API_KEY, KIMI_MODEL_NAME |
| Copilot | key (GitHub token) | COPILOT_GITHUB_TOKEN |
| Qwen | key, endpoint (China or International), model | OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL |
| MiMo | key, model (required, no default) | MIMO_API_KEY, derived MIMOCODE_CONFIG_CONTENT |

Qwen choices are `https://coding.dashscope.aliyuncs.com/v1` and
`https://coding-intl.dashscope.aliyuncs.com/v1`; the model has no default.
MiMo has key and model fields, with no default model. The model is trimmed and must use 1-64 letters, digits, dots, underscores or hyphens. Its private launch environment contains `MIMO_API_KEY` and `MIMOCODE_CONFIG_CONTENT`. The latter is server-built JSON with the fixed MiMo provider, `options.baseURL` set to `https://api.xiaomimimo.com/v1`, `options.headers` containing the literal `{"api-key":"{env:MIMO_API_KEY}"}`, exactly the selected model in `models`, and top-level `model` set to `mimo/<model>`. The key never enters that JSON. `MIMO_API_KEY` works through this placeholder, not as a built-in vendor variable.

NOT VERIFIED 2026-11-16, because no released MiMo binary or account was used: the exact nesting of `headers` (provider `options` versus provider level) in the live schema, how `MIMOCODE_CONFIG_CONTENT` ranks against a project `mimocode.json`, and whether a project config can override the `baseURL`.

MiniMax is not offered: its official examples show `mcode provider add --api-key-env` storing the key value in plaintext in `config.yaml`. That breaks the rule that a key never reaches a file the app does not encrypt. Its API base URL and model IDs are not published on the vendor pages read. A saved key does not establish Signed in or
Connected. Success says `Key saved. Connection checked when you first chat.`
Matching installed catalog ACP tools can be registered and selected without
`signedIn`; Start still requires the saved profile, executable and Full access consent.

Qwen endpoint source: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/

Kimi variable source: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html
`KIMI_MODEL_NAME` enables the override; the example value is `kimi-for-coding`.

NOT VERIFIED 2026-11-16, because no released binary or account was used: whether a previously cached sign-in mode of Qwen or Gemini ignores the saved key; whether project settings can override the base URL; other endpoints of the same vendor are not offered.

Private server-child IPC, never renderer IPC:
`{type:"cliCredentialRequest", id, operation:"set"|"get"|"remove", tool, record?}`
returns `{type:"cliCredentialResult", id, available, ok, record?}` on the same channel.
`record` is required only for set, returned only for successful get, and null for
missing, unreadable or invalid ciphertext. Extra fields are refused. Tool IDs match
`^[a-z0-9]+(?:-[a-z0-9]+)*$` (at most 32 characters); IDs are strings at most 64
characters. Record JSON is limited to 16 KiB. The client timeout is five seconds.

Electron encrypts JSON using safeStorage into `<userData>/credentials/<tool>.cred`.
The directory must resolve without links. Set writes an exclusive random temporary
file beside the destination, flushes and closes it, then renames atomically. Before
writing, set removes only that tool's pre-existing regular temporary files. Failure
preserves the previous record and removes only its temporary file. Encryption
unavailable means `ok:false` with no write and no plaintext fallback. No record or
field value is logged, included in error text, shared state or persisted drafts.
Launch environments are private per child, selected by catalog identity; saved keys
never enter argv or process.env. Streaming redaction protects persisted output.
Replacement/removal invalidate prior connection evidence. A timed-out change clears
the usable cache entry and says "Could not confirm the change. Check again." The next
prepare/refresh reads the store again. Reads retry once after a short delay; confirmed
absence allows launches without a saved key, while two failed reads refuse launch.
Shutdown clears the cache.

## Managed hidden sign-in

Only these exact request keys are accepted at both handler and service:

| Message | Fields |
|---|---|
| `cliLogin` | `type`, `requestId`, `cli` |
| `getCliLoginState` | `type`, `requestId`, `cli`, `loginId` |
| `openCliLogin` | `type`, `requestId`, `cli`, `loginId` |
| `submitCliLoginCode` | `type`, `requestId`, `cli`, `loginId`, `code` |
| `cancelCliLogin` | `type`, `requestId`, `cli`, `loginRequestId` |

`cli` is a fixed installable catalog ID. Extra keys are refused, including commands,
URLs, paths, environment, PIDs and timeouts. `signIn.command` is display-only;
the page never sends it back. Every catalog `signIn` has `managed:boolean` and
`unsupportedMessage:string|null`. True means managed login is enabled; false has
`This tool has no verified sign-in flow in Command Center yet.`

The original `cliLogin` action remains running until completion. Admission is not Done.
The server privately sends only the initiating socket:
`{type:"cliLoginState", cli, loginRequestId, loginId, revision, status, phase, reason, verificationUrl, deviceCode, pasteRequired, expiresAt}`.
`status` is `running|done|failed`. `phase` is `starting|waitingBrowser|waitingCode|verifying|null`.
`reason` is a static reason below or null. `verificationUrl`, `deviceCode`, `loginId`
and `expiresAt` are nullable. `pasteRequired` is boolean. Revision increases per update.
The unpredictable capability stays in page memory. Reconnect can resubscribe using it;
a reload loses it and says `Sign-in is already running. Cancel to start again.`
Cancel uses the public original `loginRequestId`, and returns no private details.
Private fields are cleared on completion, cancel, expiry and shutdown.

Shared `state.settings.catalogTools[id].action` contains ONLY
`{requestId, kind:"login", status, phase, reason, message}`. No URL, device code,
pasted code, capability or raw output enters shared state, actionResult, logs or errors.
The current validated progress event replaces its predecessor; no transcript or event
history is retained (the current event stays below 64 KiB).

| Tool | Fixed hidden command | Policy |
|---|---|---|
| Claude | `claude auth login` | claude.com or platform.claude.com, /oauth/ or /cai/oauth/; known browser and paste prompts; stdin paste supported; status `claude auth status` |
| Codex | `codex login --device-auth` | auth.openai.com/codex/device; known link/code prompts; code `^[A-Z0-9]{4}-[A-Z0-9]{5}$`; status `codex login status` |
| Copilot | `copilot login --device-code` | github.com/login/device; documented visit/code prompt; code `^[A-Z0-9]{4}-[A-Z0-9]{4}$`; no status probe |
| Grok | `grok login --device-auth` | candidate, auth.x.ai; generic login/device prompt and bounded code envelope; exact vendor text NOT VERIFIED; no status probe |
| OpenCode, Gemini, Qwen, Kimi, MiMo, Mistral, MiniMax | unsupported | No verified piped flow or verification host. Existing saved authentication can still be checked at first chat. |

Only recognized positive read-only status probes can establish Signed in. Login exit
zero or success text cannot. No paid chat is a silent probe. Other tools finish with
`statusUnknown` and `signedIn:null`. Probes are serial, at 3-second cadence.

An owned hidden child uses server-fixed arguments, an absolute program outside project
folders, neutral cwd, allow-listed environment, piped stdin/stdout/stderr, shell:false,
windowsHide:true, detached:false. Windows shims use absolute System32 cmd.exe /d /s /c,
never start. One synchronous login lock is serialized with installer admission.
The deadline is ten minutes; parser carry is at most 8 KiB and total output at most
1 MiB. Owned PID identities and descendants are tracked while live and strictly swept
on exit, cancel, timeout and shutdown. Unknown cleanup retains the lock and globalWork
close warning. Cancel again retries cleanup. Shutdown closes admission synchronously
and drains login beside installers, workers and Git, including the fallback path.

Browser opening sends IDs only from the page. The server validates its saved URL and
privately asks Electron over the existing child IPC. Electron independently uses the
same HTTPS/host/path policy before shell.openExternal, returning only success/failure.
No renderer arbitrary-URL IPC is added. URLs need a recognized vendor prompt, exact
host and expected path, no credentials or unexpected port; conflicting URLs fail closed.
Device codes require the known code prompt and strict profile pattern.

Pasted authorization codes require matching tool/capability, live writable stdin and
waitingCode. Only 1-2048 printable ASCII, no controls/newlines/URL; one submit consumes
the waiting prompt atomically, writing code plus newline once. Attempts are limited to
one per two seconds and five per operation. Codes never enter argv, env, retry queues,
messages, state or logs. Potential vendor echo after submission is discarded.

| Reason | Static message |
|---|---|
| unsupported | This tool has no verified sign-in flow in Command Center yet. |
| notInstalled | Install the tool first. |
| installationUnknown | Could not confirm the installation. |
| busy | Another installation or sign-in is running. |
| launchFailed | Could not start sign-in. |
| unsafeOutput / outputLimit | The tool returned unsupported sign-in information. |
| browserUnavailable | Could not open the browser. Copy the address below. (Login remains active.) |
| cancelled | Sign-in stopped. |
| timeout | Sign-in expired. Try again. |
| cleanupUnconfirmed | Could not confirm sign-in stopped. (Lock and Stop again retained.) |
| statusUnknown | Sign-in command finished. Connection will be checked when you first chat. |
| notSignedIn / loginFailed | Sign-in did not finish. Try again. |

Native vendor sign-in, credential persistence and absence of vendor-created consoles
still require real-account visual qualification. No automated test logs in to a vendor.

## Managed Copilot installation

Copilot uses the managed official GitHub release ZIP route, with no WinGet, npm or
script fallback. It selects the numerically latest non-draft, non-prerelease
`v1.x.y` release of `github/copilot-cli`. Assets are `copilot-win32-x64.zip` and
`copilot-win32-arm64.zip`. Required API size and SHA-256 digest must match the
streamed bytes. HTTPS origins and manual redirects use the shared release policy.
The download ceiling is 192 MiB, expanded ceiling 256 MiB. OpenCode retains its
128 MiB download and 512 MiB expanded ceilings and existing transfer-only fallback.
Copilot has a 1500-second install deadline; OpenCode retains 600 seconds.
After admission, Copilot best-effort removes orphan install folders before creating
a candidate, preserving the active descriptor target, in-progress candidates and links.

The entire archive must contain exactly one regular `copilot.exe`. Unsafe paths,
links, duplicates, case variants, empty archives and oversized entries are refused.
An isolated throwaway home and hidden bounded `--version` probe must report exactly
the selected `GitHub Copilot CLI <version>` before atomic publication of
`%LOCALAPPDATA%/Command Center/tools/copilot/active.json`. Its executable points to
`install-<id>/copilot.exe` within that same managed folder, with links refused.
Activation failure rolls back the old descriptor and removes only the candidate.
Unconfirmed owned-process cleanup retains admission until Stop again confirms it.

Detection, login, ACP leaders and crew prefer a valid managed descriptor outside
project folders, then safe PATH discovery. Detection uses offline `--version`.
Only managed Copilot launches get `COPILOT_AUTO_UPDATE=false`; PATH installations
retain the user's update setting. Selected `COPILOT_GITHUB_TOKEN` delivery remains
private to keyed launches and never enters argv. Managed Copilot does not update
itself and the app does not update it in this pack. Wizard and Settings retain
Install, progress, Cancel, Installed and Try again states with no shell instructions.
Copilot offers no manual installation button or setup-guide link.
The obsolete Copilot prerequisites were removed: installation needs neither
WinGet nor PowerShell. PowerShell 6+ is not consumed as catalog data and was removed.
Uninstalling Command Center removes `%LOCALAPPDATA%\Command Center\tools` (the managed
OpenCode and Copilot installations); an update keeps it (the old uninstaller runs with
`--updated` and `/KEEP_APP_DATA`). The folder is removed with `rd /s` through an
environment variable, never `RMDir /r`, which follows a link inside the folder and
empties its target. A link at the folder or its parent leaves it where it is. Copilot's own
runtime folder `%LOCALAPPDATA%\copilot` is Copilot's and stays.

NOT VERIFIED 2026-11-16: real release download, native execution on x64 or arm64,
real sign-in and ACP sessions, vendor-created windows, and whether Copilot shell
tools require PowerShell 6+ on a PC. No real vendor session was run for this pack.

## Removing an app-installed tool

`removeCliInstall` accepts exactly `{type, requestId, cli, confirm:true}` with
`cli` equal to `opencode` or `copilot`, through the existing Settings action handler.
`managedInstall` is a server-detected boolean. Settings offers Remove for an
installed managed copy, and offers retry after partial removal. Other tools have
no in-app removal. The wizard has no Remove action.

Removal shares the installer and sign-in admission lock. A live leader or running
crew process using the tool refuses removal. Built-in and catalog-owned ACP leader,
crew-seat and key launches are refused while the owner's removal action is running.
Progress uses `kind:"remove"`, `status:"running"`,
and `message:"Removing..."`; errors use static, non-secret text.

Paths come only from the selected tool's managed root, never from the descriptor
or request. Links are refused. Removal deletes `active.json` first, then only
directories matching `^install-[a-f0-9-]+$`, files before verified-empty folders,
without recursive deletion. Unrelated names and sibling tools survive. Locked
files leave partial cleanup and a retry message. Detection refreshes before the
action completes. Saved connections, encrypted keys, sign-in and vendor data stay.

First-run OpenCode auto-selection prefers `opencode/longcat-2.5-free` only when
present in the supplied model list, based on the owner's tool-using demo on
2026-11-16. With no match, the prior selection is unchanged. Regular automatic
assignment and user-selected seat models are unchanged.
