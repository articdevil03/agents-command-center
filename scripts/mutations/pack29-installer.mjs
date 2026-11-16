export const pack29InstallerMutations = [
  [
    "p29-installer-default-dir",
    "build/installer.nsh",
    // One line, because the installer include has CRLF line endings and the old multi-line target never matched. The guard that refuses an install folder inside the saved-data folder.
    '${If} $R3 == $R1',
    '${If} $R3 == "never"',
  ],
  [
    "p29-uninstall-default",
    "package.json",
    "\"deleteAppDataOnUninstall\": false",
    "\"deleteAppDataOnUninstall\": true"
  ],
  [
    "p29-uninstall-switch",
    "build/installer.nsh",
    "  ${GetOptions} $R0 \"--delete-app-data\" $R1",
    "  ${GetOptions} $R0 \"--p29-disabled-delete-app-data\" $R1"
  ],
  [
    "p29-portable-preservation",
    "scripts/dist-installer.mjs",
    "const output = join(dist, \"installers\");",
    "const output = dist;"
  ],
  [
    "p29-installer-publish-on-failure",
    "scripts/dist-installer.mjs",
    "await run(process.execPath, [proof, \"--electron\", exe], { env });",
    "await run(process.execPath, [proof, \"--electron\", exe], { env }).catch(() => {});"
  ],
  [
    "p29-installer-no-proof",
    "scripts/dist-installer.mjs",
    "await run(process.execPath, [proof, \"--electron\", exe], { env });",
    "void proof;"
  ],
  [
    "p29-smoke-system-node",
    "scripts/packaged-smoke.mjs",
    "child = spawnProcess(exe, [...(permission",
    "child = spawnProcess(process.execPath, [...(permission"
  ],
  [
    "p29-installer-junction-guard",
    "build/installer.nsh",
    "System::Call 'kernel32::GetFileAttributesW(w R4) i.R5'",
    "System::Call 'kernel32::GetFileAttributesW(w rR4) i.rR5'"
  ]
];
