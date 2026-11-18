; Both installer and uninstaller override the template before changing app files.
!macro customCheckAppRunning
  ; A first install has no app executable in the folder, so nothing of the app can be running from it.
  ; Upgrade, reinstall over an existing install and uninstall always find it and keep the check.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    InitPluginsDir
    File /oname=$PLUGINSDIR\installer-process.ps1 "${BUILD_RESOURCES_DIR}\installer-process.ps1"
    System::Call 'kernel32::SetEnvironmentVariableW(w "CC_INSTALL_DIR", w "$INSTDIR")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "CC_INSTALL_EXE", w "${APP_EXECUTABLE_FILENAME}")'
    System::Call 'kernel32::GetCurrentProcessId() i.R2'
    System::Call 'kernel32::SetEnvironmentVariableW(w "CC_SETUP_PID", w R2)'
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-process.ps1"'
    Pop $R0
    Pop $R1
    ${If} $R0 != 0
      ${If} $R0 != 4
        ; Deliberately refuse uninstall too when inspection cannot run. Fail safe before changing files.
        !insertmacro ccSetupDetail "Process check could not run, exit=$R0. Setup stopped without changing app files."
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONSTOP "Setup could not check whether Command Center is running on this PC, so it stopped without changing anything."
        ${EndIf}
        SetErrorLevel 6
        Quit
      ${EndIf}
      !insertmacro ccSetupDetail "Command Center could not close safely. Setup stopped without replacing or deleting the app."
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "Command Center could not close safely. Close Command Center and try again."
      ${EndIf}
      SetErrorLevel 4
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  Push $R0
  Push $R1
  Push $R2
  StrCpy $R2 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $R2 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    StrCpy $R2 1
  ${EndIf}
  ${If} $R2 == 0
    InitPluginsDir
    File /oname=$PLUGINSDIR\installer-tools.ps1 "${BUILD_RESOURCES_DIR}\installer-tools.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-tools.ps1"'
    Pop $R0
    Pop $R1
    ${If} $R0 != 0
      !insertmacro ccSetupDetail "Some tool files were kept because they could not be safely removed. Command Center can still be uninstalled."
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "Some tool files were kept because they could not be safely removed. Command Center can still be uninstalled."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
