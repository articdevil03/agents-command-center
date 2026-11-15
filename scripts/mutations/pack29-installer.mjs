export const pack29InstallerMutations = [
  [
    "p29-installer-default-dir",
    "build/installer.nsh",
    "!macro customInit\n  ; initMultiUser has already resolved the previous install and /D override.\n  Push $R0\n  Push $R1\n  Push $R2\n  Push $R3\n  Push $R4\n  Push $R5\n  ClearErrors\n  GetFullPathName $R0 \"$INSTDIR\"\n  ${If} ${Errors}\n  ${OrIf} $R0 == \"\"\n    StrCpy $R0 \"$INSTDIR\"\n  ${EndIf}\n  ClearErrors\n  GetFullPathName $R1 \"$APPDATA\\${APP_PACKAGE_NAME}\"\n  ${If} ${Errors}\n  ${OrIf} $R1 == \"\"\n    StrCpy $R1 \"$APPDATA\\${APP_PACKAGE_NAME}\"\n  ${EndIf}\n  ClearErrors\n  ; A junction or symlink could disguise an installation inside protected data.\n  StrCpy $R4 $R0\n  ${Do}\n    System::Call 'kernel32::GetFileAttributesW(w R4) i.R5'\n    ${If} $R5 != -1\n      IntOp $R5 $R5 & 0x400\n      ${If} $R5 != 0\n        ${IfNot} ${Silent}\n          MessageBox MB_OK|MB_ICONSTOP \"Command Center cannot be installed here because the install folder is, or sits inside, a link. Setup stopped and changed nothing.\"\n        ${EndIf}\n        SetErrorLevel 3\n        Quit\n      ${EndIf}\n    ${EndIf}\n    ${GetParent} \"$R4\" $R5\n    ${If} $R5 == $R4\n      ${Break}\n    ${EndIf}\n    StrCpy $R4 $R5\n  ${LoopUntil} $R4 == \"\"\n  ; Normalize separators even when the full-path API could not resolve a new folder.\n  ${Do}\n    StrCpy $R2 $R0 1 -1\n    ${If} $R2 != \"\\\"\n      ${Break}\n    ${EndIf}\n    StrCpy $R0 $R0 -1\n  ${Loop}\n  ${Do}\n    StrCpy $R2 $R1 1 -1\n    ${If} $R2 != \"\\\"\n      ${Break}\n    ${EndIf}\n    StrCpy $R1 $R1 -1\n  ${Loop}\n  ; The template assigns INSTDIR before this hook. Never compare empty results.\n  ${If} $R0 != \"\"\n  ${AndIf} $R1 != \"\"\n  ; Include a separator so similarly prefixed sibling folders remain valid.\n  StrCpy $R0 \"$R0\\\"\n  StrCpy $R1 \"$R1\\\"\n  StrLen $R2 $R0\n  StrCpy $R3 $R1 $R2\n  ${If} $R3 == $R0\n    ${IfNot} ${Silent}\n      MessageBox MB_OK|MB_ICONSTOP \"Command Center cannot be installed here because the install folder overlaps the folder that holds your saved data. Setup stopped and did not change your saved data.\"\n    ${EndIf}\n    SetErrorLevel 3\n    Quit\n  ${EndIf}\n  StrLen $R2 $R1\n  StrCpy $R3 $R0 $R2\n  ${If} $R3 == $R1\n    ${IfNot} ${Silent}\n      MessageBox MB_OK|MB_ICONSTOP \"Command Center cannot be installed here because the install folder overlaps the folder that holds your saved data. Setup stopped and did not change your saved data.\"\n    ${EndIf}\n    SetErrorLevel 3\n    Quit\n  ${EndIf}\n  ${EndIf}\n  Pop $R5\n  Pop $R4\n  Pop $R3\n  Pop $R2\n  Pop $R1\n  Pop $R0\n!macroend",
    "!macro customInit\n  ; initMultiUser has already resolved the previous install and /D override.\n  Push $R0\n  Push $R1\n  Push $R2\n  Push $R3\n  Push $R4\n  Push $R5\n  GetFullPathName $R0 \"$INSTDIR\"\n  GetFullPathName $R1 \"$APPDATA\\${APP_PACKAGE_NAME}\"\n  ; A junction or symlink could disguise an installation inside protected data.\n  StrCpy $R4 $R0\n  ${Do}\n    System::Call 'kernel32::GetFileAttributesW(w R4) i.R5'\n    ${If} $R5 != -1\n      IntOp $R5 $R5 & 0x400\n      ${If} $R5 != 0\n        ${IfNot} ${Silent}\n          MessageBox MB_OK|MB_ICONSTOP \"Command Center cannot be installed here because the install folder is, or sits inside, a link. Setup stopped and changed nothing.\"\n        ${EndIf}\n        SetErrorLevel 3\n        Quit\n      ${EndIf}\n    ${EndIf}\n    ${GetParent} \"$R4\" $R5\n    ${If} $R5 == $R4\n      ${Break}\n    ${EndIf}\n    StrCpy $R4 $R5\n  ${LoopUntil} $R4 == \"\"\n  ; Normalize separators even when the full-path API could not resolve a new folder.\n  ${Do}\n    StrCpy $R2 $R0 1 -1\n    ${If} $R2 != \"\\\"\n      ${Break}\n    ${EndIf}\n    StrCpy $R0 $R0 -1\n  ${Loop}\n  ${Do}\n    StrCpy $R2 $R1 1 -1\n    ${If} $R2 != \"\\\"\n      ${Break}\n    ${EndIf}\n    StrCpy $R1 $R1 -1\n  ${Loop}\n  ; The template assigns INSTDIR before this hook. Never compare empty results.\n  ${If} $R0 != \"\"\n  ${AndIf} $R1 != \"\"\n  ; Include a separator so similarly prefixed sibling folders remain valid.\n  StrCpy $R0 \"$R0\\\"\n  StrCpy $R1 \"$R1\\\"\n  StrLen $R2 $R0\n  StrCpy $R3 $R1 $R2\n  ${If} $R3 == $R0\n    ${IfNot} ${Silent}\n      MessageBox MB_OK|MB_ICONSTOP \"Command Center cannot be installed here because the install folder overlaps the folder that holds your saved data. Setup stopped and did not change your saved data.\"\n    ${EndIf}\n    SetErrorLevel 3\n    Quit\n  ${EndIf}\n  StrLen $R2 $R1\n  StrCpy $R3 $R0 $R2\n  ${If} $R3 == $R1\n    ${IfNot} ${Silent}\n      MessageBox MB_OK|MB_ICONSTOP \"Command Center cannot be installed here because the install folder overlaps the folder that holds your saved data. Setup stopped and did not change your saved data.\"\n    ${EndIf}\n    SetErrorLevel 3\n    Quit\n  ${EndIf}\n  ${EndIf}\n  Pop $R5\n  Pop $R4\n  Pop $R3\n  Pop $R2\n  Pop $R1\n  Pop $R0\n!macroend"
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
