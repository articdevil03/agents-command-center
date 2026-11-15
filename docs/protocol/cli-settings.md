# CLI settings and catalog

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
