; Outdoors NSIS installer customization
; Cleans up ALL prior versions, updater data, and user data before install

!macro customInit
  ; Kill any running Outdoors processes
  nsExec::ExecToLog 'taskkill /F /IM "Outdoors.exe" /T'

  ; Uninstall old version from default location
  StrCpy $0 "$LOCALAPPDATA\Programs\Outdoors\Uninstall Outdoors.exe"
  IfFileExists $0 0 +3
    ExecWait '"$0" /S --force-run'
    Sleep 2000

  ; Remove old install directory
  RMDir /r "$LOCALAPPDATA\Programs\Outdoors"

  ; Remove outdoors-desktop app data (workspace, config, logs, auth state, bot memory)
  RMDir /r "$APPDATA\outdoors-desktop"

  ; Remove outdoors-desktop-updater
  RMDir /r "$LOCALAPPDATA\outdoors-desktop-updater"

  ; Remove cached Google Workspace MCP credentials (prevents cross-account data leaks)
  RMDir /r "$PROFILE\.google_workspace_mcp"

  ; Remove WhatsApp auth state (force fresh QR scan)
  ; This is inside outdoors-desktop which was already removed above, but just in case:
  RMDir /r "$APPDATA\outdoors-desktop\workspace\outdoorsv1\backend\auth_state"

  ; Remove temp files from previous installs
  Delete "$TEMP\outdoors-out.log"
  Delete "$TEMP\outdoors-err.log"
  Delete "$TEMP\outdoors-debug.log"
  Delete "$TEMP\outdoors-onboarding-prompt.txt"
  RMDir /r "$TEMP\outdoors-asar-extract"
  RMDir /r "$TEMP\outdoors-upgrade-backup"
!macroend
