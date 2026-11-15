; Keep electron-builder's maintained installer and uninstaller templates.
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
  ; A junction or symlink could disguise an installation inside protected data.
  StrCpy $R4 $R0
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w R4) i.R5'
    ${If} $R5 != -1
      IntOp $R5 $R5 & 0x400
      ${If} $R5 != 0
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONSTOP "Command Center cannot be installed here because the install folder is, or sits inside, a link. Setup stopped and changed nothing."
        ${EndIf}
        SetErrorLevel 3
        Quit
      ${EndIf}
    ${EndIf}
    ${GetParent} "$R4" $R5
    ${If} $R5 == $R4
      ${Break}
    ${EndIf}
    StrCpy $R4 $R5
  ${LoopUntil} $R4 == ""
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
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Command Center cannot be installed here because the install folder overlaps the folder that holds your saved data. Setup stopped and did not change your saved data."
    ${EndIf}
    SetErrorLevel 3
    Quit
  ${EndIf}
  StrLen $R2 $R1
  StrCpy $R3 $R0 $R2
  ${If} $R3 == $R1
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
