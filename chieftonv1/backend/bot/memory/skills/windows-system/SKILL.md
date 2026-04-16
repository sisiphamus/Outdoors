# Windows System Actions

## Key Insight
**Never say "I can't do system things."** We CAN launch settings pages, run PowerShell commands, and interact with Windows via shell and Playwright. Always try `start ms-settings:*` or PowerShell before saying something is outside our tools. Don't lead with disclaimers — just act.

## Classification Trap: "Move my cursor"
When the user says "move my cursor to the left/right/up/down", this is a **desktop mouse automation task**, NOT a text editor or terminal navigation question. The user wants their actual mouse cursor moved on screen. Jump straight to the Mouse Control section below and use PowerShell `SetCursorPos`. Never answer with keyboard shortcuts — that's the wrong interpretation.

## Bluetooth

### Quick path: Open settings + use Playwright to click through
1. Open settings: `start ms-settings:bluetooth`
2. Use Playwright to navigate the Settings page — snapshot the window, find "Add device" or the target speaker, and click it. This is faster and more helpful than telling the user to do it manually.

### PowerShell approach (programmatic)
- List Bluetooth devices: `Get-PnpDevice -Class Bluetooth`
- Check if a device is already paired: `Get-PnpDevice -Class Bluetooth | Where-Object { $_.FriendlyName -match "JBL" }`
- Enable/disable Bluetooth radio: PowerShell can toggle via `Get-NetAdapter` or device manager commands
- For previously paired devices, reconnect via: `DeviceConnect` in PowerShell or use `start ms-settings:bluetooth` + Playwright click

### Strategy for "connect to my speaker"
1. First check if device is already paired: `Get-PnpDevice -Class Bluetooth -Status OK`
2. If paired, open settings + use Playwright to click the device to connect
3. If not paired, open settings + use Playwright to click "Add device" > "Bluetooth" and wait for discovery
4. **Don't just open settings and leave the user hanging** — use Playwright to complete the action

### Settings URIs
- Bluetooth: `start ms-settings:bluetooth`
- Paired devices: `start ms-settings:connecteddevices`

## Other Useful Settings URIs
- Wi-Fi: `start ms-settings:network-wifi`
- Sound: `start ms-settings:sound`
- Display: `start ms-settings:display`
- Apps: `start ms-settings:appsfeatures`
- Notifications: `start ms-settings:notifications`
- Volume mixer: `start ms-settings:apps-volume`
- Default audio output: `start ms-settings:sound` (then use Playwright to select device)

## Mouse Control

**We CAN move the mouse.** Use PowerShell with the Win32 `SetCursorPos` API:

```powershell
# Move mouse to specific coordinates
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint); [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; } }'
[Mouse]::SetCursorPos(500, 500)
```

```powershell
# Get current mouse position
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position
```

```powershell
# Simulate mouse click at current position
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Click { [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo); }'
[Click]::mouse_event(0x0002, 0, 0, 0, 0)  # left down
[Click]::mouse_event(0x0004, 0, 0, 0, 0)  # left up
```

- If user says "move left/right/up/down", get current position first, then offset by ~300px in that direction (200px is too subtle on high-res displays).
- If user says "move my mouse" without coords, ask where or move it to center of screen as a demo.
- Can also get screen resolution: `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds`
- **NEVER say "I can't move your mouse."** This file proves we can. Always check memory before claiming inability.

## Display Messages / Notifications

**Show a message box on screen:**

```powershell
# Simple message box with "OK" button
powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Your message here', 'Title')"
```

Use this for:
- Quick confirmations to the user
- Displaying results on screen
- Simple yes/no prompts (can use additional parameters for different button types)

## Media Playback Control

**We CAN control media playback (Spotify, YouTube, etc.)** using Windows media keys via PowerShell:

```powershell
# Play/Pause (works for Spotify, YouTube, any media player)
powershell -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class MediaKey { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo); }'; [MediaKey]::keybd_event(0xB3, 0, 0, 0); [MediaKey]::keybd_event(0xB3, 0, 2, 0)"
```

Other media keys:
- `0xB3` - Play/Pause
- `0xB0` - Next track
- `0xB1` - Previous track
- `0xB2` - Stop
- `0xAE` - Volume Down
- `0xAF` - Volume Up
- `0xAD` - Volume Mute

Pattern for all media keys:
1. Call `keybd_event` with key code and `0` (key down)
2. Call `keybd_event` with same key code and `2` (key up)

This works system-wide — doesn't need Spotify window to be focused. Same command works for YouTube in browser, Windows Media Player, etc.

## Opening Apps via URI Schemes
- **Spotify**: `start spotify:` (launches or brings to focus)
- **Spotify web**: `start https://open.spotify.com`
- **Calculator**: `start calculator:`
- **Maps**: `start bingmaps:`
- **Mail**: `start mailto:someone@example.com`

## Shell Environment: Git Bash Quirks

The executor runs in **Git bash on Windows**. This causes issues with Windows CLI tools that use `/` flags:

- `taskkill /IM Spotify.exe /F` → **FAILS** — Git bash interprets `/IM` as a Unix path
- Use `//IM` or wrap in PowerShell instead:

```bash
# Always use PowerShell for Windows commands with / flags:
powershell -Command "Stop-Process -Name 'Spotify' -Force"
powershell -Command "taskkill /IM Spotify.exe /F"
```

**Rule: For any Windows command that uses `/Flag` syntax, run it via `powershell -Command "..."`** to avoid Git bash path mangling.

## Pattern: System Task Execution
For any Windows system task, the workflow is:
1. Open the relevant settings page via `start ms-settings:*`
2. Use Playwright to snapshot the settings window and interact with it
3. Complete the action programmatically — don't punt to the user
4. If Playwright can't access the Settings app window, fall back to PowerShell automation
5. Only as a last resort, tell the user what to click — but be specific (exact button names, exact steps)
