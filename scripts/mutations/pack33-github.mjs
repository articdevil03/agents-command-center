export const pack33GithubMutations = [
  [
    "p33-refresh-account-private", "server/settings/service.ts",
    'Object.assign(this.state.github, { ...parseGitHubAuthStatus(gh, "settings"), account: null });',
    'Object.assign(this.state.github, parseGitHubAuthStatus(gh, "settings"));'
  ],
  [
    "p33-reader-timeout-unknown", "server/settings/parse.ts",
    'if (reader === "settings" && (result.code === 124 || result.code === 127 || result.code < 0 || !text.trim())) return { connected: null, account: null };',
    'if (reader === "settings" && (result.code === 124 || result.code === 127 || result.code < 0 || !text.trim())) return { connected: false, account: null };'
  ],
  [
    "p33-ignore-unrelated-url", "server/settings/cli-login-output.ts",
    'if (!url) continue;', 'if (!url) throw new Error("unsafeOutput");'
  ],
  [
    "p33-config-dir", "server/settings/cli-login-runner.ts",
    'GH_CONFIG_DIR|CODEX_HOME', 'CODEX_HOME'
  ],
  [
    "p33-url-punctuation", "server/settings/cli-login-output.ts",
    'match[0].replace(/[.,);]+$/, "")', 'match[0]'
  ],
  [
    "p33-refusal-message", "public/first-run/login.js",
    'else if (view.state === "refused") text = view.text || "Could not connect. Try again.";',
    'else if (view.state === "refused") text = "Could not connect. Try again.";'
  ],
  [
    "p33-github-console",
    "server/settings/cli-login-runner.ts",
    "args = GITHUB_LOGIN_ARGS;",
    "args = [\"/c\", \"start\", \"\", \"gh\", \"auth\", \"login\", \"--web\"]; program = join(windowsSystem32(), \"cmd.exe\");"
  ],
  [
    "p33-github-url",
    "server/settings/cli-login-policy.js",
    "if (cli === \"github\") return value === \"https://github.com/login/device\" ? value : null;",
    "if (cli === \"github\") return value;"
  ],
  [
    "p33-github-enter",
    "server/settings/cli-login-runner.ts",
    "if (github.takeEnterPrompt()) child!.stdin!.write(\"\\n\");",
    "child!.stdin!.write(\"\\n\");"
  ],
  [
    "p33-github-exit-alone",
    "server/settings/parse.ts",
    "if (result.code === 0 && loggedIn && active && !negative) return { connected: true, account: loggedIn[1] };",
    "if (result.code === 0) return { connected: true, account: loggedIn?.[1] ?? null };"
  ],
  [
    "p33-github-text-alone",
    "server/settings/parse.ts",
    "if (result.code === 0 && loggedIn && active && !negative)",
    "if (loggedIn && active && !negative)"
  ],
  [
    "p33-github-tree",
    "server/settings/cli-login-runner.ts",
    "const swept = await tree!.sweep(endedAt, true);",
    "const swept = 0;"
  ],
  [
    "p33-github-deadline",
    "server/settings/cli-login.ts",
    "op.deadline = setTimeout(() => { op.failure = \"timeout\"; this.clearPrivate(op); this.publish(op, null, op.keyWriteAttempt ? \"possiblySaved\" : \"timeout\"); op.abort.abort(); }, this.deps.timeoutMs ?? 600_000);",
    "/* mutation: service deadline omitted */"
  ],
  [
    "p33-github-concurrent",
    "server/settings/cli-login.ts",
    "if (this.closed || this.active || this.deps.busy()",
    "if (this.closed || false || this.deps.busy()"
  ],
  [
    "p33-github-retain-code",
    "server/settings/cli-login.ts",
    "Object.assign(op.event, { loginId: null, verificationUrl: null, deviceCode: null, pasteRequired: false, expiresAt: null });",
    "Object.assign(op.event, { loginId: null, verificationUrl: null, pasteRequired: false, expiresAt: null });"
  ]
];
export const pack33GithubCatchMap = Object.fromEntries(pack33GithubMutations.map(([id]) => [id,
  id === "p33-refusal-message" ? "test/pack33-github-page.test.ts"
    : ["p33-refresh-account-private", "p33-reader-timeout-unknown", "p33-ignore-unrelated-url", "p33-config-dir", "p33-url-punctuation"].includes(id)
      ? "test/pack33-github-fixes.test.ts" : "test/pack33-github.test.ts"]));
