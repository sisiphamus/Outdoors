; Chiefton NSIS installer customization
; CRITICAL: NEVER delete user data (bot memory, skills, outputs, logs, credentials).
; Only clean up program files and temp/cache data.

!macro customInit
  ; Kill any running Chiefton processes (and their entire process tree)
  nsExec::ExecToLog 'taskkill /F /IM "Chiefton.exe" /T'

  ; Kill orphaned backend processes from previous runs that hold file locks.
  ; The backend listens on port 3847 — find its PID and kill the entire process tree
  ; (covers node.exe backend + python.exe ML workers spawned as children).
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3847 -State Listen -EA 0 | ForEach-Object { taskkill /F /T /PID $$_.OwningProcess }"'

  ; Uninstall old version from default location
  StrCpy $0 "$LOCALAPPDATA\Programs\Chiefton\Uninstall Chiefton.exe"
  IfFileExists $0 0 +3
    ExecWait '"$0" /S --force-run'
    Sleep 2000

  ; Remove old install directory (program files only — NOT user data)
  RMDir /r "$LOCALAPPDATA\Programs\Chiefton"

  ; DO NOT delete $APPDATA\chiefton-desktop — it contains irreplaceable user data:
  ;   - bot/memory/skills (learned behaviors)
  ;   - bot/memory (user preferences, knowledge)
  ;   - bot/logs (conversation history)
  ;   - bot/outputs (generated files)
  ;   - config.json, .env, auth_state
  ; The app's ensureWorkspace() handles upgrades safely.

  ; Remove chiefton-desktop-updater (cache only, safe to delete)
  RMDir /r "$LOCALAPPDATA\chiefton-desktop-updater"

  ; DO NOT delete .google_workspace_mcp — contains OAuth credentials for multiple accounts

  ; Remove temp files from previous installs
  Delete "$TEMP\chiefton-out.log"
  Delete "$TEMP\chiefton-err.log"
  Delete "$TEMP\chiefton-debug.log"
  Delete "$TEMP\chiefton-onboarding-prompt.txt"
  RMDir /r "$TEMP\chiefton-asar-extract"
  RMDir /r "$TEMP\chiefton-upgrade-backup"
!macroend
