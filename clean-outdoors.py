"""
Clean Outdoors — Kill all Outdoors processes, delete app data, and wipe AutomationProfile.
Run as Administrator if processes won't die or folders won't delete.
"""

import subprocess
import shutil
import os
import time
import sys

APPDATA_DIR = os.path.join(os.environ["APPDATA"], "outdoors-desktop")
AUTOMATION_PROFILE = os.path.join(os.environ["LOCALAPPDATA"], "Google", "Chrome", "AutomationProfile")

PROCESS_NAMES = ["Outdoors.exe", "outdoors.exe"]


def kill_processes():
    print("[1/3] Killing Outdoors + Chrome processes...")
    killed = False
    for name in PROCESS_NAMES:
        result = subprocess.run(
            ["taskkill", "/F", "/IM", name, "/T"],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"  Killed {name} (and child processes)")
            killed = True
    if not killed:
        print("  No Outdoors processes found.")

    # Kill any Chrome using the AutomationProfile
    print("  Checking for Chrome instances using AutomationProfile...")
    ps_cmd = (
        "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" "
        "| Where-Object { $_.CommandLine -match 'AutomationProfile' } "
        "| Select-Object -ExpandProperty ProcessId"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_cmd],
        capture_output=True, text=True
    )
    for line in result.stdout.strip().splitlines():
        pid = line.strip()
        if pid.isdigit():
            subprocess.run(["taskkill", "/F", "/PID", pid],
                           capture_output=True, text=True)
            print(f"  Killed Chrome PID {pid} (AutomationProfile)")
            killed = True

    # Give OS time to release file handles
    time.sleep(2)


def delete_dir(label, path):
    if os.path.exists(path):
        print(f"  Deleting {path}")
        try:
            shutil.rmtree(path)
            print(f"  Done.")
        except PermissionError:
            print(f"  ERROR: Permission denied. Try running as Administrator.")
        except Exception as e:
            print(f"  ERROR: {e}")
    else:
        print(f"  {label} not found at {path}, skipping.")


def main():
    kill_processes()

    print("[2/3] Removing Outdoors app data...")
    delete_dir("App data", APPDATA_DIR)

    print("[3/3] Removing Chrome AutomationProfile...")
    delete_dir("AutomationProfile", AUTOMATION_PROFILE)

    print("\nCleanup complete.")


if __name__ == "__main__":
    main()
