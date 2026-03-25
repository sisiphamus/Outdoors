; Outdoors NSIS installer customization
; CRITICAL: NEVER delete user data (bot memory, skills, outputs, logs, credentials).
; Only clean up program files and temp/cache data.

!macro customInit
  ; Kill any running Outdoors processes
  nsExec::ExecToLog 'taskkill /F /IM "Outdoors.exe" /T'

  ; Uninstall old version from default location
  StrCpy $0 "$LOCALAPPDATA\Programs\Outdoors\Uninstall Outdoors.exe"
  IfFileExists $0 0 +3
    ExecWait '"$0" /S --force-run'
    Sleep 2000

  ; Remove old install directory (program files only — NOT user data)
  RMDir /r "$LOCALAPPDATA\Programs\Outdoors"

  ; DO NOT delete $APPDATA\outdoors-desktop — it contains irreplaceable user data:
  ;   - bot/memory/skills (learned behaviors)
  ;   - bot/memory (user preferences, knowledge)
  ;   - bot/logs (conversation history)
  ;   - bot/outputs (generated files)
  ;   - config.json, .env, auth_state
  ; The app's ensureWorkspace() handles upgrades safely.

  ; Remove outdoors-desktop-updater (cache only, safe to delete)
  RMDir /r "$LOCALAPPDATA\outdoors-desktop-updater"

  ; DO NOT delete .google_workspace_mcp — contains OAuth credentials for multiple accounts

  ; Remove temp files from previous installs
  Delete "$TEMP\outdoors-out.log"
  Delete "$TEMP\outdoors-err.log"
  Delete "$TEMP\outdoors-debug.log"
  Delete "$TEMP\outdoors-onboarding-prompt.txt"
  RMDir /r "$TEMP\outdoors-asar-extract"
  RMDir /r "$TEMP\outdoors-upgrade-backup"
!macroend
