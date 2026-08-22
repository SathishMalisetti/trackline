#!/usr/bin/env python3
"""
Trackline device setup — a small GUI wizard, no terminal required.

Flow: Family ID + password -> "Look up family" -> pick your kid from a
dropdown (real names, not raw IDs) -> Finish. On success, writes the same
config.json the background sync script (trackline_agent.py) already reads,
and sets up a Windows Scheduled Task so syncing starts automatically —
no NSSM step, no keeping a terminal window open.

Design note: all the actual logic (API calls, config writing, building the
scheduled-task command) is in plain functions with no tkinter dependency,
specifically so it can be tested without a display — see the bottom of
this file for what's covered.
"""

import json
import os
import sys
import hashlib
import platform
import subprocess
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None  # only needed once the GUI actually runs; see main()

def _app_dir():
    """Same fix as trackline_agent.py's version — see that file for the
    full explanation. In short: TracklineSetup and TracklineAgent are two
    separate compiled programs (often in two separate --onedir folders),
    so exe-relative paths don't reliably point at the same place for both.
    A fixed OS-standard location does."""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / "TracklineAgent"
    d.mkdir(parents=True, exist_ok=True)
    return d

CONFIG_PATH = _app_dir() / "config.json"
TASK_NAME = "TracklineScreenTimeSync"


# ---------------------------------------------------------------------------
# Pure logic — no tkinter, no network side effects beyond what's obviously
# needed, so this is the part that's actually testable.
# ---------------------------------------------------------------------------

def simple_hash(s):
    """Identical to Trackline's own JS password hash — verified byte-for-byte
    against the real implementation (see the earlier round's test suite)."""
    h = 5381
    for ch in s:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return format(h, "x")

def lookup_family(backend_url, family_id, family_password, http_post):
    """http_post is injected so this is testable without a real network call.
    Returns (ok, result_or_error_message)."""
    backend_url = backend_url.strip().rstrip("/")
    resp = http_post(f"{backend_url}/api/family-members", json={
        "familyId": family_id.strip().upper(),
        "passwordHash": simple_hash(family_password),
    })
    if resp.get("status") == 200:
        return True, resp["json"]["members"]
    return False, resp.get("json", {}).get("error", "Could not look up that family.")

def pair_device(backend_url, family_id, family_password, member_id, member_name, label, hostname, timezone, http_post):
    """Same idea — returns (ok, result_or_error_message)."""
    backend_url = backend_url.strip().rstrip("/")
    resp = http_post(f"{backend_url}/api/device-pair", json={
        "familyId": family_id.strip().upper(),
        "passwordHash": simple_hash(family_password),
        "memberId": member_id,
        "hostname": hostname,
        "label": label,
    })
    if resp.get("status") == 200:
        body = resp["json"]
        return True, {
            "family_id": family_id.strip().upper(),
            "member_id": member_id,
            "member_name": member_name,  # for display in the Config Manager, avoids a network round-trip just to show who this device belongs to
            "label": label,              # was being sent to the pairing endpoint but never actually saved locally — fixed
            "device_id": body["deviceId"],
            "device_token": body["deviceToken"],
            "hostname": hostname,
            "backend_url": backend_url,
            "timezone": timezone,
            "sync_interval_minutes": 30,
            "excluded_apps": [],
            "excluded_title_keywords": [],  # e.g. ["bank", "password"] — hides matching titles even if the app itself isn't excluded
            "category_map": {},  # override/extend the defaults, e.g. {"discord.exe": "Study"}
        }
    return False, resp.get("json", {}).get("error", "Pairing failed.")

def write_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass

def detect_hostname():
    return platform.node() or "this-computer"

def detect_timezone():
    """Best-effort local IANA timezone name, falling back to a manual pick
    if it can't be determined — never blocks the wizard."""
    try:
        from tzlocal import get_localzone_name
        return get_localzone_name()
    except Exception:
        try:
            from datetime import datetime
            local_tz = datetime.now().astimezone().tzinfo
            return str(local_tz)
        except Exception:
            return "UTC"

AGENT_EXE_NAME = "TracklineAgent.exe"
# Expected layout — two SIBLING --onedir folders under one shared parent,
# each fully self-contained with its own _internal folder:
#   <parent>/TracklineSetup/TracklineSetup.exe   (this app)
#   <parent>/TracklineAgent/TracklineAgent.exe
# This deliberately avoids putting both onedir outputs in the same folder —
# each has its own _internal subfolder, and two different apps' _internal
# folders sharing one directory would collide.

def build_scheduled_task_xml(agent_exe_path):
    """Builds a full Task Scheduler XML task definition, rather than
    schtasks' simple /create flags — because the simple flags have no way
    to set two settings that matter a lot for a LAPTOP specifically:

    - WakeToRun: without this (the default), Task Scheduler does NOT wake
      a sleeping laptop to run a due task — the trigger is silently
      skipped, and "Next Run" still shows a perfectly valid future time,
      because the schedule itself is fine, only the execution was missed.
      This exact symptom — valid next-run shown, manual "Run Now" works,
      automatic runs silently don't push data — is the textbook signature
      of this specific setting being off, and matches a real report.
    - DisallowStartIfOnBatteries / StopIfGoingOnBatteries: a laptop that's
      unplugged shouldn't just stop syncing; both are explicitly disabled.

    Also sets StartWhenAvailable (a missed run — e.g. laptop was fully
    off — executes as soon as possible afterward, rather than just
    waiting for the next slot) and IgnoreNew for overlapping instances.
    """
    from xml.sax.saxutils import escape
    safe_path = escape(str(agent_exe_path))
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT30M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{safe_path}</Command>
      <Arguments>--sync-once</Arguments>
    </Exec>
  </Actions>
</Task>"""

def find_agent_exe():
    """Locates TracklineAgent.exe without assuming a single fixed layout —
    checks the two shapes PyInstaller --onedir builds actually produce in
    practice, in order of likelihood, before falling back to a file picker
    rather than guessing wrong a third time:

    1. Same folder as this wizard's own exe (both onedir folders merged
       into one — the simplest case, if anyone did that manually).
    2. Sibling onedir folder named "TracklineAgent" next to this wizard's
       own onedir folder — e.g. TracklineDeviceSetup\\TracklineAgent\\ next
       to TracklineDeviceSetup\\TracklineSetup\\. This is the layout
       PyInstaller actually produces when both are built into the same
       parent output folder, and is the one confirmed against a real
       reported case."""
    if not getattr(sys, "frozen", False):
        return None
    wizard_own_folder = Path(sys.executable).parent

    same_folder_candidate = wizard_own_folder / AGENT_EXE_NAME
    if same_folder_candidate.exists():
        return same_folder_candidate

    sibling_candidate = wizard_own_folder.parent / "TracklineAgent" / AGENT_EXE_NAME
    if sibling_candidate.exists():
        return sibling_candidate

    return None  # caller falls back to a file picker

def register_uninstaller(agent_exe_path):
    """Registers Trackline in Windows' Add/Remove Programs (Apps &
    Features) list. Same implementation as trackline_agent.py's version,
    deliberately duplicated — TracklineSetup and TracklineAgent are
    separate compiled programs and can't reliably share Python modules
    once frozen with PyInstaller. Uses HKEY_CURRENT_USER so no admin
    elevation is needed. UninstallString points at the compiled agent
    with --full-uninstall, which is non-interactive since Windows' own
    confirmation dialog already asks the user before calling it."""
    if platform.system() != "Windows":
        return False, "Add/Remove Programs registration is Windows-only."
    try:
        import winreg
    except ImportError:
        return False, "winreg not available on this system."
    try:
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\TracklineAgent"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, "Trackline Screen Time Agent")
            winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, f'"{agent_exe_path}" --full-uninstall')
            winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, "1.0")
            winreg.SetValueEx(key, "Publisher", 0, winreg.REG_SZ, "Trackline")
            winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, str(Path(agent_exe_path).parent))
            winreg.SetValueEx(key, "NoModify", 0, winreg.REG_DWORD, 1)
            winreg.SetValueEx(key, "NoRepair", 0, winreg.REG_DWORD, 1)
        return True, "Registered in Add/Remove Programs."
    except Exception as e:
        return False, f"Could not register in Add/Remove Programs: {e}"

def install_scheduled_task(agent_exe_path=None):
    """Actually creates the scheduled task, from the XML definition above.
    Windows-only — a no-op elsewhere, with a clear message rather than a
    confusing failure. agent_exe_path is optional — if not supplied,
    tries the low-risk auto-detect first."""
    if platform.system() != "Windows":
        return False, "Automatic background syncing via Task Scheduler is Windows-only. On macOS/Linux, use cron or launchd with the agent's --sync-once."
    if agent_exe_path is None:
        agent_exe_path = find_agent_exe()
    if agent_exe_path is None or not Path(agent_exe_path).exists():
        return False, (
            f"Couldn't automatically find {AGENT_EXE_NAME}, so automatic syncing "
            f"wasn't set up. Pairing itself succeeded. Point the installer at "
            f"{AGENT_EXE_NAME} manually to finish setting up automatic syncing."
        )
    xml_content = build_scheduled_task_xml(str(agent_exe_path))
    tmp_xml_path = _app_dir() / "_scheduled_task.xml"
    try:
        with open(tmp_xml_path, "w", encoding="utf-16") as f:
            f.write(xml_content)
        cmd = ["schtasks", "/create", "/tn", TASK_NAME, "/xml", str(tmp_xml_path), "/f"]
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        return True, "Automatic syncing every 30 minutes is now set up (including while asleep or on battery)."
    except subprocess.CalledProcessError as e:
        return False, f"Could not set up automatic syncing: {e.stderr}"
    finally:
        try:
            tmp_xml_path.unlink(missing_ok=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# The actual GUI. Thin on purpose — everything above this line is what's
# tested; this part just wires widgets to those functions.
# ---------------------------------------------------------------------------

def run_gui():
    import tkinter as tk
    from tkinter import ttk, messagebox, filedialog

    if requests is None:
        messagebox.showerror("Missing dependency", "This installer needs 'requests'. If you're running from source: pip install requests")
        sys.exit(1)

    def http_post(url, json):
        try:
            resp = requests.post(url, json=json, timeout=15)
            return {"status": resp.status_code, "json": resp.json()}
        except Exception as e:
            return {"status": 0, "json": {"error": f"Could not reach the server: {e}"}}

    root = tk.Tk()
    root.title("Trackline — Set up screen time on this device")
    root.geometry("420x420")
    root.resizable(False, False)

    backend_url_var = tk.StringVar(value=os.environ.get("TRACKLINE_BACKEND_URL", ""))
    family_id_var = tk.StringVar()
    family_password_var = tk.StringVar()
    label_var = tk.StringVar(value=f"{platform.node()}'s device")
    member_choice_var = tk.StringVar()
    members_by_label = {}  # display label -> member id

    frame = ttk.Frame(root, padding=16)
    frame.pack(fill="both", expand=True)

    ttk.Label(frame, text="Trackline backend URL").pack(anchor="w")
    ttk.Entry(frame, textvariable=backend_url_var, width=44).pack(fill="x", pady=(0,10))

    ttk.Label(frame, text="Family ID").pack(anchor="w")
    ttk.Entry(frame, textvariable=family_id_var, width=44).pack(fill="x", pady=(0,10))

    ttk.Label(frame, text="Family password").pack(anchor="w")
    ttk.Entry(frame, textvariable=family_password_var, show="*", width=44).pack(fill="x", pady=(0,10))

    status_label = ttk.Label(frame, text="", foreground="#a5323a", wraplength=380)
    status_label.pack(anchor="w", pady=(0,6))

    member_dropdown = ttk.Combobox(frame, textvariable=member_choice_var, state="disabled", width=41)
    member_dropdown.pack(fill="x", pady=(0,10))

    ttk.Label(frame, text="Label for this device").pack(anchor="w")
    ttk.Entry(frame, textvariable=label_var, width=44).pack(fill="x", pady=(0,14))

    finish_button = ttk.Button(frame, text="Finish registration", state="disabled")
    finish_button.pack(fill="x")

    def do_lookup():
        status_label.config(text="Looking up family...", foreground="#5c5847")
        root.update_idletasks()
        ok, result = lookup_family(backend_url_var.get(), family_id_var.get(), family_password_var.get(), http_post)
        if not ok:
            status_label.config(text=result, foreground="#a5323a")
            return
        members_by_label.clear()
        display_labels = []
        for m in result:
            disp = f"{m['name']} ({m['role']})"
            members_by_label[disp] = m["id"]
            display_labels.append(disp)
        member_dropdown["values"] = display_labels
        member_dropdown["state"] = "readonly"
        if display_labels:
            member_dropdown.current(0)
        finish_button["state"] = "normal"
        status_label.config(text=f"Found {len(display_labels)} family member(s). Pick who this device belongs to below.", foreground="#3d7a4f")

    def do_finish():
        chosen_label = member_choice_var.get()
        member_id = members_by_label.get(chosen_label)
        if not member_id:
            status_label.config(text="Pick a family member first.", foreground="#a5323a")
            return
        member_name = chosen_label.split(' (')[0]
        ok, result = pair_device(
            backend_url_var.get(), family_id_var.get(), family_password_var.get(),
            member_id, member_name, label_var.get(), detect_hostname(), detect_timezone(), http_post,
        )
        if not ok:
            status_label.config(text=result, foreground="#a5323a")
            return
        write_config(result)

        resolved_agent_path = find_agent_exe()
        task_ok, task_msg = install_scheduled_task(resolved_agent_path)
        if not task_ok:
            # Auto-detect failed — ask directly rather than leave automatic
            # syncing silently unconfigured.
            if messagebox.askyesno(
                "Set up automatic syncing?",
                f"{task_msg}\n\nWould you like to browse for {AGENT_EXE_NAME} now?"
            ):
                picked = filedialog.askopenfilename(
                    title=f"Locate {AGENT_EXE_NAME}",
                    filetypes=[("TracklineAgent", AGENT_EXE_NAME), ("All files", "*.*")],
                )
                if picked:
                    resolved_agent_path = picked
                    task_ok, task_msg = install_scheduled_task(picked)

        uninstall_msg = ""
        if resolved_agent_path:
            reg_ok, reg_msg = register_uninstaller(resolved_agent_path)
            uninstall_msg = f"\n{reg_msg}"

        messagebox.showinfo(
            "Paired successfully",
            f"This device is now sending screen time for {chosen_label.split(' (')[0]}.\n\n{task_msg}{uninstall_msg}"
        )
        root.destroy()

    ttk.Button(frame, text="Look up family", command=do_lookup).pack(fill="x", pady=(0,10))
    finish_button.config(command=do_finish)

    root.mainloop()


if __name__ == "__main__":
    run_gui()
