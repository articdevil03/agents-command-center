// Pack 37: the proxy and Git Bash settings reach installers only in a plain form, the unreadable-version and not-ready wording, and the uninstaller's removal of the tools folder.
const PACKAGING = "test/pack29-packaging.test.ts";
export const pack37SmallFixesMutations = [
  ["p37-env-proxy-host", "server/settings/cli-runner.ts", "(?:[a-z0-9._-]+|\\[[0-9a-f:.]+\\])", "[^\\s/]+"],
  ["p37-env-kimi-bash", "server/settings/cli-runner.ts", "/(?:^|[\\\\/])bash\\.exe$/i.test(value)", "value.length > 0"],
  ["p37-not-ready-name", "server/first-run/complete.ts", "`${registered?.name ?? cli} is not ready: no supported leader model`", "`${cli} is not ready: no supported leader model`"],
  ["p37-settings-unreadable", "public/app/11-settings-render.js", '(tool.supportedVersion === false ? "OpenCode 1 is needed" : "The OpenCode version could not be read")', '"OpenCode 1 is needed"'],
  ["p37-wizard-unreadable", "public/first-run/tools.js", 'tool?.supportedVersion === false ? "OpenCode 1 is needed" : "The OpenCode version could not be read"', '"OpenCode 1 is needed"'],
  ["p37-uninstall-keep-on-update", "build/installer.nsh", "\${If} $R3 == 0", "\${If} $R3 == $R3"],
  ["p37-uninstall-link-guard", "build/installer.nsh", "\${If} $R4 == 0", "\${If} $R4 == $R4"],
  ["p37-uninstall-follows-links", "build/installer.nsh", `nsExec::Exec '"$SYSDIR\\cmd.exe" /d /c rd /s /q "%CC_UNINSTALL_TOOLS%"'`, 'RMDir /r "$R2"'],
];
export const pack37SmallFixesCatchMap = {
  "p37-env-proxy-host": "test/pack37-small-fixes.test.ts",
  "p37-env-kimi-bash": "test/pack37-small-fixes.test.ts",
  "p37-not-ready-name": "test/pack37-small-fixes.test.ts",
  "p37-settings-unreadable": "test/pack29-opencode-key-settings.test.ts",
  "p37-wizard-unreadable": "test/pack29-opencode-key-page.test.ts",
  "p37-uninstall-keep-on-update": PACKAGING,
  "p37-uninstall-link-guard": PACKAGING,
  "p37-uninstall-follows-links": PACKAGING,
};
