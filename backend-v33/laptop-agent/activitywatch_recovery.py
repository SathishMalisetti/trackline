"""Local ActivityWatch readiness/recovery; never changes pairing or uploads data."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import requests

API_URL = "http://127.0.0.1:5600/api/0/buckets/"


class ActivityWatchUnavailable(RuntimeError):
    pass


def api_ready(timeout=2):
    # Corporate proxy environment variables must not intercept localhost.
    try:
        with requests.Session() as session:
            session.trust_env = False
            response = session.get(API_URL, timeout=timeout)
            response.raise_for_status()
            return isinstance(response.json(), dict)
    except (requests.RequestException, ValueError):
        return False


def installed_executable(config=None):
    """Find aw-qt.exe without assuming a particular Windows install directory."""
    candidates = []
    override = (config or {}).get("activitywatch_executable")
    if override:
        candidates.append(Path(override))
    found = shutil.which("aw-qt.exe")
    if found:
        candidates.append(Path(found))
    for variable in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(variable)
        if base:
            candidates.extend([Path(base) / "ActivityWatch" / "aw-qt.exe",
                               Path(base) / "Programs" / "ActivityWatch" / "aw-qt.exe"])
    # Portable installations can optionally use the explicit config path above.
    if sys.platform == "win32":
        import winreg
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for key_name in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                             r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"):
                try:
                    with winreg.OpenKey(hive, key_name) as root:
                        for index in range(winreg.QueryInfoKey(root)[0]):
                            try:
                                with winreg.OpenKey(root, winreg.EnumKey(root, index)) as item:
                                    name = winreg.QueryValueEx(item, "DisplayName")[0]
                                    if "activitywatch" not in str(name).lower():
                                        continue
                                    location = winreg.QueryValueEx(item, "InstallLocation")[0]
                                    if location:
                                        candidates.append(Path(str(location).strip('"')) / "aw-qt.exe")
                            except OSError:
                                continue
                except OSError:
                    continue
    for candidate in candidates:
        if candidate.name.lower() == "aw-qt.exe" and candidate.is_file():
            return candidate.resolve()
    return None


def qt_running():
    """Avoid spawning another tray manager while an existing one is starting."""
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq aw-qt.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return result.returncode == 0 and '"aw-qt.exe"' in result.stdout.lower()
    except (OSError, subprocess.TimeoutExpired):
        return False


def ensure_activitywatch(config=None, wait_seconds=20):
    """Check first, launch at most once, then wait a bounded time for readiness.

    Uses aw-qt (server plus default watchers) in the current user session.
    Never kills processes or modifies/deletes ActivityWatch history.
    """
    if api_ready():
        return
    if sys.platform != "win32":
        raise ActivityWatchUnavailable("ActivityWatch is unavailable at localhost:5600. Start ActivityWatch and retry.")
    if not qt_running():
        executable = installed_executable(config)
        if not executable:
            raise ActivityWatchUnavailable(
                "ActivityWatch is unavailable and aw-qt.exe was not found. Start ActivityWatch, or set "
                "activitywatch_executable in the agent config for a portable installation.")
        try:
            subprocess.Popen(
                [str(executable)], cwd=str(executable.parent),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            raise ActivityWatchUnavailable("Could not start ActivityWatch. Start it manually and retry.") from exc
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if api_ready(timeout=min(2, remaining)):
            return
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise ActivityWatchUnavailable(
        "ActivityWatch did not become reachable at localhost:5600. "
        "Check its tray icon/server; the next scheduled sync will retry.")
