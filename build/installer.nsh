; Keep electron-builder's maintained installer and uninstaller templates.
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    ; Reject instead of allowing the template's destructive opt-in.
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; Keep refusals findable even before the details window exists or in silent mode.
!macro ccSetupDetail line
  DetailPrint "${line}"
  Push $0
  FileOpen $0 "$TEMP\command-center-setup.log" a
  FileSeek $0 0 END
  FileWrite $0 "${line}$\r$\n"
  FileClose $0
  Pop $0
!macroend

!ifdef BUILD_RESOURCES_DIR
  !include "${BUILD_RESOURCES_DIR}\installer-lifecycle.nsh"
!else
  ; A non-builder consumer must never fall back to the template's broad termination.
  !macro customCheckAppRunning
    !insertmacro ccSetupDetail "Setup could not check whether Command Center has closed safely. Setup stopped."
    SetErrorLevel 6
    Quit
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
Var ccUnsafeInstall
Var ccInstallEntries

; Stack: absolute path -> final path, including missing future leaves, or empty.
; Opening the nearest existing ancestor follows profile junctions exactly once.
Function ccResolveInstallPath
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $1 ""
  ${Do}
    System::Call 'kernel32::CreateFileW(w r0, i 0, i 7, p 0, i 3, i 0x02000000, p 0) p.r2 ?e'
    Pop $3
    ${If} $2 != -1
      ${Break}
    ${EndIf}
    ${If} $3 != 2
    ${AndIf} $3 != 3
      Goto ccResolveFailed
    ${EndIf}
    ${GetFileName} "$0" $3
    ${GetParent} "$0" $4
    ${If} $4 == ""
    ${OrIf} $4 == $0
      Goto ccResolveFailed
    ${EndIf}
    StrLen $2 $1
    StrLen $4 $3
    IntOp $2 $2 + $4
    IntOp $2 $2 + 1
    ${If} $2 >= ${NSIS_MAX_STRLEN}
      Goto ccResolveFailed
    ${EndIf}
    ${GetParent} "$0" $4
    ; GetParent returns X: for a drive-root child. Never open a drive-relative path.
    StrLen $2 $4
    ${If} $2 == 2
      StrCpy $2 $4 1 1
      ${If} $2 == ":"
        StrCpy $4 "$4\"
      ${EndIf}
    ${EndIf}
    StrCpy $1 "\$3$1"
    StrCpy $0 $4
  ${Loop}
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r2, w .r0, i ${NSIS_MAX_STRLEN}, i 0) i.r3'
  System::Call 'kernel32::CloseHandle(p r2)'
  ${If} $3 == 0
  ${OrIf} $3 >= ${NSIS_MAX_STRLEN}
    Goto ccResolveFailed
  ${EndIf}
  StrLen $4 $1
  IntOp $3 $3 + $4
  ${If} $3 >= ${NSIS_MAX_STRLEN}
    Goto ccResolveFailed
  ${EndIf}
  ${If} $1 != ""
    StrCpy $4 $0 1 -1
    ${If} $4 == "\"
      StrCpy $0 $0 -1
    ${EndIf}
  ${EndIf}
  StrCpy $0 "$0$1"
  Goto ccResolveDone
ccResolveFailed:
  StrCpy $0 ""
ccResolveDone:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd

; Walk only the owned tree. Never enumerate a reparse point's target.
Function ccCheckInstallTree
  Exch $0
  Push $1
  Push $2
  Push $3
  IntOp $ccInstallEntries $ccInstallEntries + 1
  ${If} $ccInstallEntries > 5000
    StrCpy $ccUnsafeInstall 1
    !insertmacro ccSetupDetail "This install folder has too many files to check safely. Choose a separate folder for Command Center."
    Goto ccTreeDone
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r3 ?e'
  Pop $2
  ${If} $3 == -1
    ${If} $2 != 2
    ${AndIf} $2 != 3
      StrCpy $ccUnsafeInstall 1
    ${EndIf}
    Goto ccTreeDone
  ${EndIf}
  IntOp $2 $3 & 0x400
  ${If} $2 != 0
    StrCpy $ccUnsafeInstall 1
    Goto ccTreeDone
  ${EndIf}
  IntOp $2 $3 & 0x10
  ${If} $2 == 0
    Goto ccTreeDone
  ${EndIf}
  ClearErrors
  FindFirst $1 $2 "$0\*"
  ${If} ${Errors}
    StrCpy $ccUnsafeInstall 1
    Goto ccTreeDone
  ${EndIf}
  ${Do}
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      Push "$0\$2"
      Call ccCheckInstallTree
    ${EndIf}
    ${If} $ccUnsafeInstall != 0
      ${Break}
    ${EndIf}
    ClearErrors
    FindNext $1 $2
  ${LoopUntil} ${Errors}
  FindClose $1
ccTreeDone:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!macro customInit
  ; initMultiUser has already resolved the previous install and /D override.
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  ClearErrors
  GetFullPathName $R0 "$INSTDIR"
  ${If} ${Errors}
  ${OrIf} $R0 == ""
    StrCpy $R0 "$INSTDIR"
  ${EndIf}
  ClearErrors
  GetFullPathName $R1 "$APPDATA\${APP_PACKAGE_NAME}"
  ${If} ${Errors}
  ${OrIf} $R1 == ""
    StrCpy $R1 "$APPDATA\${APP_PACKAGE_NAME}"
  ${EndIf}
  ClearErrors
  StrCpy $ccUnsafeInstall 0
  StrCpy $ccInstallEntries 0
  Push $R0
  Call ccCheckInstallTree
  Push $R0
  Call ccResolveInstallPath
  Pop $R0
  Push $R1
  Call ccResolveInstallPath
  Pop $R1
  ${If} $ccUnsafeInstall != 0
  ${OrIf} $R0 == ""
  ${OrIf} $R1 == ""
    !insertmacro ccSetupDetail "Command Center could not check this install folder safely. Setup stopped and did not change your saved data."
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Command Center could not check this install folder safely. Setup stopped and did not change your saved data."
    ${EndIf}
    SetErrorLevel 3
    Quit
  ${EndIf}
  ; Pin both resolved roots and recheck after inspecting the owned tree.
  StrCpy $ccInstallEntries 0
  Push "$INSTDIR"
  Call ccCheckInstallTree
  Push "$INSTDIR"
  Call ccResolveInstallPath
  Pop $R4
  Push "$APPDATA\${APP_PACKAGE_NAME}"
  Call ccResolveInstallPath
  Pop $R5
  ${If} $R4 != $R0
  ${OrIf} $R5 != $R1
  ${OrIf} $ccUnsafeInstall != 0
    !insertmacro ccSetupDetail "The install folder changed while Setup was checking it. Setup stopped and did not change your saved data."
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "The install folder changed while Setup was checking it. Setup stopped and did not change your saved data."
    ${EndIf}
    SetErrorLevel 3
    Quit
  ${EndIf}
  ; Normalize separators even when the full-path API could not resolve a new folder.
  ${Do}
    StrCpy $R2 $R0 1 -1
    ${If} $R2 != "\"
      ${Break}
    ${EndIf}
    StrCpy $R0 $R0 -1
  ${Loop}
  ${Do}
    StrCpy $R2 $R1 1 -1
    ${If} $R2 != "\"
      ${Break}
    ${EndIf}
    StrCpy $R1 $R1 -1
  ${Loop}
  ; The template assigns INSTDIR before this hook. Never compare empty results.
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
  ; Include a separator so similarly prefixed sibling folders remain valid.
  StrCpy $R0 "$R0\"
  StrCpy $R1 "$R1\"
  StrLen $R2 $R0
  StrCpy $R3 $R1 $R2
  ${If} $R3 == $R0
    !insertmacro ccSetupDetail "The install folder overlaps your saved data. Setup stopped without changing your saved data."
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Command Center cannot be installed here because the install folder overlaps the folder that holds your saved data. Setup stopped and did not change your saved data."
    ${EndIf}
    SetErrorLevel 3
    Quit
  ${EndIf}
  StrLen $R2 $R1
  StrCpy $R3 $R0 $R2
  ${If} $R3 == $R1
    !insertmacro ccSetupDetail "The install folder overlaps your saved data. Setup stopped without changing your saved data."
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Command Center cannot be installed here because the install folder overlaps the folder that holds your saved data. Setup stopped and did not change your saved data."
    ${EndIf}
    SetErrorLevel 3
    Quit
  ${EndIf}
  ${EndIf}
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
