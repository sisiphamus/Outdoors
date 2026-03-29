╔══════════════════════════════════════════════════════════════╗
║       OUTDOORS — READ THIS BEFORE OPENING THE APP           ║
╚══════════════════════════════════════════════════════════════╝

  macOS will BLOCK this app unless you run the commands below.
  It takes 10 seconds.

  ── Step 1: Open Terminal ─────────────────────────────────

  Press Cmd+Space, type "Terminal", press Enter.

  ── Step 2: Allow Outdoors to run ─────────────────────────

  sudo spctl --master-disable

  Enter your Mac password (it won't show as you type).
  This temporarily allows apps from any source.

  ── Step 3: Install and launch ────────────────────────────

  sudo xattr -cr ~/Downloads/Outdoors*.dmg && hdiutil attach ~/Downloads/Outdoors*.dmg -nobrowse -quiet && sudo cp -r /Volumes/Outdoors*/Outdoors.app /Applications/ && hdiutil detach /Volumes/Outdoors* -quiet && sudo xattr -cr /Applications/Outdoors.app && open /Applications/Outdoors.app

  ── Step 4: Re-enable Gatekeeper ──────────────────────────

  After Outdoors opens successfully, re-enable Gatekeeper:

  sudo spctl --master-enable

  Outdoors will continue to work after re-enabling.

  ── If the .dmg is not in Downloads ───────────────────────

  Replace ~/Downloads/ in step 3 with the folder where
  you saved the file.

