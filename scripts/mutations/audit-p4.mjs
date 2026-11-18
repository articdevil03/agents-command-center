// P4 owned-root guards. Catalogue data is exempt from the source line cap.
export const auditP4Mutations = [
  [
    "audit-p4-ancestor-rejection",
    "server/owned-path.js",
    "  const source = resolve(root), info = stat(io, source);",
    "  const source = resolve(root), info = stat(io, source);\n  for (let ancestor = dirname(source); dirname(ancestor) !== ancestor; ancestor = dirname(ancestor)) { if (stat(io, ancestor)?.isSymbolicLink()) throw new Error(\"Linked ancestor refused.\"); }"
  ],
  [
    "audit-p4-internal-link-check",
    "server/owned-path.js",
    "      if (info.isSymbolicLink()) throw new Error(\"Linked owned paths are refused.\");",
    "      // Link component check omitted."
  ],
  [
    "audit-p4-canonical-containment",
    "server/owned-path.js",
    "      if (!inside(root.path, canonical) || !same(canonical, current)) throw new Error(\"Owned path escapes its root.\");",
    "      // Canonical component containment omitted."
  ],
  [
    "audit-p4-pinned-root-identity",
    "server/owned-path.js",
    "if (state[key] !== null && identity(info) !== state[key])",
    "if (false)"
  ],
  [
    "audit-p4-default-root-link",
    "server/owned-path.js",
    "allowRootLink = false",
    "allowRootLink = true"
  ],
  [
    "audit-p4-missing-leaf-always",
    "server/owned-path.js",
    "if (!allowMissingLeaf) throw Object.assign",
    "if (false) throw Object.assign"
  ],
  [
    "audit-p4-data-root-helper",
    "server/data-root.ts",
    "resolveOwnedRoot(resolve(dir), { allowRootLink: true }).path",
    "resolve(dir)"
  ],
  [
    "audit-p4-backup-helper",
    "server/fixed-crew/recovery-backup.ts",
    "  assertOwnedPath(boundary, path, { allowMissingLeaf: true });",
    "  void boundary;"
  ],
  [
    "audit-p4-recovery-explicit-root",
    "server/fixed-crew/recovery.ts",
    "for (const folder of [\"config\", \"tasks\", \"executions\", \"backups\"]) noLinks(join(root, folder), root);",
    "for (const folder of [\"config\", \"tasks\", \"executions\", \"backups\"]) noLinks(join(root, folder));"
  ],
  [
    "audit-p4-revision-helper",
    "server/fixed-crew/task-revision.ts",
    "const check = (file: string) => assertOwnedPath(boundary, file, { allowMissingLeaf: true });",
    "const check = (file: string) => file;"
  ],
  [
    "audit-p4-store-explicit-root",
    "server/fixed-crew/task-store.ts",
    "refuseLinks(file, dataRoot);",
    "refuseLinks(file);"
  ],
  [
    "audit-p4-managed-link-check",
    "server/settings/opencode/paths.ts",
    "export function assertNoLinks(path: string): void {\n  for (const [root, app] of locations) {\n    if (!contains(root, path)) continue;\n    assertOwnedPath(pinned(dirname(app), true), path, { allowMissingLeaf: true });\n    // Pin both owned boundaries. Only ancestors ABOVE Command Center may relocate.\n    assertOwnedPath(pinned(app), path, { allowMissingLeaf: true });\n    assertOwnedPath(pinned(join(app, \"tools\")), path, { allowMissingLeaf: true });\n    return;\n  }\n  throw new Error(\"Unknown installation location\");\n}",
    "export function assertNoLinks(path: string): void { void path; }"
  ],
  [
    "audit-p4-activation-containment",
    "server/settings/opencode/paths.ts",
    "if (!contains(root, executable)) throw new Error(\"Installation executable escapes its root\");",
    "if (false) throw new Error(\"Installation executable escapes its root\");"
  ],
  [
    "audit-p4-managed-pin-setter",
    "server/settings/opencode/paths.ts",
    "boundaries.set(key, handle);",
    "/* handle not retained */"
  ],
  [
    "audit-p4-credential-directory-check",
    "electron/cli-credentials.js",
    "  const directory = resolve(dir);",
    "  const directory = io.existsSync(dir) ? io.realpathSync(dir) : resolve(dir);"
  ],
  [
    "audit-p4-credential-file-check",
    "electron/cli-credentials.js",
    "    checked(file);\n    try { const stat = io.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(\"Unsafe credential file.\"); }",
    "    // Credential file check omitted.\n    try { /* unchecked */ }"
  ],
  [
    "audit-p4-credential-root-pin",
    "electron/cli-credentials.js",
    "return assertOwnedPath(root, path, { allowMissingLeaf: true });",
    "return assertOwnedPath(resolveOwnedRoot(directory, { io }), path, { allowMissingLeaf: true });"
  ],
  [
    "audit-p4-installer-overlap",
    "build/installer.nsh",
    "  ${If} $R0 != \"\"\n  ${AndIf} $R1 != \"\"",
    "  ${If} 0 == 1\n  ${AndIf} $R1 != \"\""
  ],
  [
    "audit-p4-installer-root-change",
    "build/installer.nsh",
    "  ${If} $R4 != $R0\n  ${OrIf} $R5 != $R1",
    "  ${If} 0 == 1\n  ${OrIf} 0 == 1"
  ],
  [
    "audit-p4-installer-resolution-safe",
    "build/installer.nsh",
    "  ${If} $3 == 0\n  ${OrIf} $3 >= ${NSIS_MAX_STRLEN}\n    Goto ccResolveFailed",
    "  ${If} $3 == 0\n  ${OrIf} $3 >= ${NSIS_MAX_STRLEN}\n    StrCpy $3 1"
  ],
  [
    "audit-p4-root-canonical-equality",
    "server/owned-path.js",
    "|| !same(realFuture(state.io, root.source), root.path)",
    "|| false"
  ],
  [
    "audit-p4-root-final-recheck",
    "server/owned-path.js",
    "// Recheck the original spelling after traversal, including an ancestor alias retarget.\n  checkRoot(root, state);",
    "// Final root recheck omitted."
  ],
  [
    "audit-p4-fingerprint-root-pin",
    "server/fixed-crew/task-revision.ts",
    "boundary = resolveOwnedRoot(root);",
    "boundary = { path: resolve(root) } as any;"
  ],
  [
    "audit-p4-fingerprint-linked-message",
    "server/fixed-crew/task-revision.ts",
    "throw new Error(\"Linked task paths are refused\", { cause: error });",
    "throw error;"
  ],
  [
    "audit-p4-data-root-recovery-fallback",
    "server/data-root.ts",
    "catch { return resolve(dir); }",
    "catch (error) { throw error; }"
  ],
  [
    "audit-p4-recovery-root-required",
    "server/fixed-crew/recovery-backup.ts",
    "if (!root) throw new Error(\"A recovery root is required.\");",
    "if (!root) root = path;"
  ],
  [
    "audit-p4-verify-root-required",
    "server/fixed-crew/recovery-backup.ts",
    "export function verifyBackup(archive: string, entries: BackupEntry[], boundary: string): void {\n  noLinks(archive, boundary);",
    "export function verifyBackup(archive: string, entries: BackupEntry[], boundary = archive): void {\n  noLinks(archive, boundary);"
  ],
  [
    "audit-p4-copy-root-required",
    "server/fixed-crew/recovery-backup.ts",
    "export function copyBackup(root: string, archive: string, entries: BackupEntry[], boundary: string): void {\n  noLinks(archive, boundary);",
    "export function copyBackup(root: string, archive: string, entries: BackupEntry[], boundary = root): void {\n  noLinks(archive, boundary);"
  ],
  [
    "audit-p4-save-root-required",
    "server/fixed-crew/recovery-backup.ts",
    "record: unknown, root: string): void",
    "record: unknown, root = dirname(path)): void"
  ],
  [
    "audit-p4-task-root-required",
    "server/fixed-crew/task-revision.ts",
    "if (!root) throw new Error(\"A task storage root is required.\");",
    "if (!root) root = resolve(file, \"..\");"
  ],
  [
    "audit-p4-credential-root-retry",
    "electron/cli-credentials.js",
    "    if (!root) {",
    "    if (!root) {\n      if (base === null) throw new Error(\"Cached root failure.\");\n      base = null;"
  ],
  [
    "audit-p4-credential-before-rename",
    "electron/cli-credentials.js",
    "        checked(temp); checkFile(file);",
    "        // Pre-rename checks omitted."
  ],
  [
    "audit-p4-cleanup-checked-calls",
    "server/settings/opencode/paths.ts",
    "    if (handle) assertOwnedPath(handle, path, { allowMissingLeaf: true }); else assertNoLinks(path);",
    "    // Cleanup boundary omitted."
  ],
  [
    "audit-p4-publish-checked-rename",
    "server/settings/opencode/paths.ts",
    "    assertNoLinks(active);\n    await rename(path, active);",
    "    await rename(path, active);"
  ],
  [
    "audit-p4-publish-checked-rollback",
    "server/settings/opencode/paths.ts",
    "assertNoLinks(restore); await writeFile(restore, old, { flag: \"wx\" }); assertNoLinks(active); await rename(restore, active);",
    "assertNoLinks(restore); await writeFile(restore, old, { flag: \"wx\" }); await rename(restore, active);"
  ],
  [
    "audit-p4-installer-managed-relocation",
    "build/installer.nsh",
    "  ; Pin both resolved roots and recheck after inspecting the owned tree.",
    "  ReadEnvStr $R4 LOCALAPPDATA\n  System::Call 'kernel32::GetFileAttributesW(w \"$R4\\Command Center\\tools\") i.R5'\n  ${If} $R5 != -1\n    IntOp $R5 $R5 & 0x400\n    IntOp $ccUnsafeInstall $ccUnsafeInstall | $R5\n  ${EndIf}\n  ; Pin both resolved roots and recheck after inspecting the owned tree."
  ],
  [
    "audit-p4-installer-attribute-failure",
    "build/installer.nsh",
    "    ${If} $2 != 2\n    ${AndIf} $2 != 3",
    "    ${If} 0 == 1\n    ${AndIf} $2 != 3"
  ],
  [
    "audit-p4-installer-drive-parent",
    "build/installer.nsh",
    "        StrCpy $4 \"$4\\\"",
    "        StrCpy $4 $4"
  ],
  [
    "audit-p4-installer-entry-budget",
    "build/installer.nsh",
    "  ${If} $ccInstallEntries > 5000",
    "  ${If} 0 == 1"
  ],
  [
    "audit-p4-installer-silent-detail",
    "build/installer.nsh",
    '  FileWrite $0 "${line}$\\r$\\n"',
    '  ; Refusal log write omitted.'
  ],
  [
    "audit-p4-installer-second-tree",
    "build/installer.nsh",
    "  Push \"$INSTDIR\"\n  Call ccCheckInstallTree",
    "  ; Second tree check omitted."
  ],
  [
    "audit-p4-installer-second-resolve",
    "build/installer.nsh",
    "  Push \"$INSTDIR\"\n  Call ccResolveInstallPath\n  Pop $R4",
    "  StrCpy $R4 $R0"
  ],
  [
    "audit-p4-installer-overlap-contains",
    "build/installer.nsh",
    "  ${If} $R3 == $R0",
    "  ${If} 0 == 1"
  ],
  [
    "audit-p4-installer-overlap-inside",
    "build/installer.nsh",
    "  ${If} $R3 == $R1",
    "  ${If} 0 == 1"
  ],
  [
    "audit-p4-installer-managed-app-relocation",
    "build/installer.nsh",
    "  ; Pin both resolved roots and recheck after inspecting the owned tree.",
    "  ReadEnvStr $R4 LOCALAPPDATA\n  System::Call 'kernel32::GetFileAttributesW(w \"$R4\\Command Center\") i.R5'\n  ${If} $R5 != -1\n    IntOp $R5 $R5 & 0x400\n    IntOp $ccUnsafeInstall $ccUnsafeInstall | $R5\n  ${EndIf}\n  ; Pin both resolved roots and recheck after inspecting the owned tree."
  ],
  [
    "audit-p4-fingerprint-root-strict",
    "server/fixed-crew/task-revision.ts",
    "boundary = resolveOwnedRoot(root);",
    "boundary = resolveOwnedRoot(root, { allowRootLink: true });"
  ],
  [
    "audit-p4-installer-drive-separator",
    "build/installer.nsh",
    "      StrCpy $0 $0 -1",
    "      StrCpy $0 $0"
  ],
  [
    "audit-p4-installer-second-data-resolve",
    "build/installer.nsh",
    "  Push \"$APPDATA\\${APP_PACKAGE_NAME}\"\n  Call ccResolveInstallPath\n  Pop $R5",
    "  StrCpy $R5 $R1"
  ],
  ["audit-p4-real-root-type", "server/owned-path.js", "  if (realInfo && (realInfo.isSymbolicLink() || !realInfo.isDirectory())) throw new Error(\"Owned root changed or linked.\");", "  // Canonical root type check omitted."],
  ["audit-p4-lexical-escape", "server/owned-path.js", "  if (!inside(root.path, file)) throw new Error(\"Owned path escapes its root.\");", "  // Lexical containment omitted."],
  ["audit-p4-bigint-identity", "server/owned-path.js", "io.lstatSync(file, { bigint: true })", "io.lstatSync(file)"],
  ["audit-p4-installer-find-failure", "build/installer.nsh", "  FindFirst $1 $2 \"$0\\*\"\n  ${If} ${Errors}\n    StrCpy $ccUnsafeInstall 1", "  FindFirst $1 $2 \"$0\\*\"\n  ${If} ${Errors}\n    StrCpy $ccUnsafeInstall 0"],
  ["audit-p4-installer-empty-install", "build/installer.nsh", "  ${OrIf} $R0 == \"\"\n  ${OrIf} $R1 == \"\"", "  ${OrIf} 0 == 1\n  ${OrIf} $R1 == \"\""],
  ["audit-p4-installer-empty-data", "build/installer.nsh", "  ${OrIf} $R0 == \"\"\n  ${OrIf} $R1 == \"\"", "  ${OrIf} $R0 == \"\"\n  ${OrIf} 0 == 1"]
];
