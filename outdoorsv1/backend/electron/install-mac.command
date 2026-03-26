#!/bin/bash
# Outdoors macOS Installer Helper
# Double-click this file FIRST, then open Outdoors.app

echo ""
echo "  Outdoors — Installing..."
echo ""

# Find the app (either in same directory as script, or in /Applications)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="$SCRIPT_DIR/Outdoors.app"

if [ ! -d "$APP_PATH" ]; then
  APP_PATH="/Applications/Outdoors.app"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "  Please drag Outdoors.app to Applications first, then run this again."
  echo ""
  read -p "  Press Enter to close..."
  exit 1
fi

# Remove quarantine attribute (prevents "damaged file" error)
echo "  Removing quarantine attribute..."
xattr -cr "$APP_PATH" 2>/dev/null

echo ""
echo "  Done! Opening Outdoors..."
echo ""

# Launch the app
open "$APP_PATH"
