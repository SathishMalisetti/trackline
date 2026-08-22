#!/usr/bin/env python3
"""
Trackline Config Manager — a small status/settings tool for a laptop
that's already been paired. Shows who a device is paired to and whether
it's actually syncing, lets you change the sync interval (updates both
config.json AND the actual Windows Scheduled Task, since Task Scheduler
doesn't read config.json — the interval is baked in at task-creation
time), and can trigger an immediate sync on demand.

Does not re-pair or uninstall — for those, use TracklineSetup or the
agent's own CLI flags directly.
"""

import json
import os
import sys
import platform
import subprocess
import requests
from pathlib import Path
from datetime import datetime, timezone


def simple_hash(s):
    """Identical algorithm to trackline_setup_gui.py's and the backend
    JS's simpleHash() — duplicated here for the same reason as everything
    else in this file: three separate compiled programs, can't share
    modules once frozen."""
    h = 5381
    for ch in s:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return format(h, "x")

def verify_family_password(cfg, password):
    """Confirms a typed password is actually correct by calling the same
    family-members endpoint the pairing flow already uses — no new
    backend endpoint needed, and no separate password-verification logic
    to keep in sync with the real one. Returns (ok, message)."""
    try:
        resp = requests.post(f"{cfg['backend_url']}/api/family-members", json={
            "familyId": cfg["family_id"], "passwordHash": simple_hash(password),
        }, timeout=15)
        if resp.status_code == 200:
            return True, ""
        return False, "Incorrect family password."
    except Exception as e:
        return False, f"Could not verify password: {e}"


def _app_dir():
    """Same fixed, shared location trackline_agent.py and
    trackline_setup_gui.py use — duplicated here for the same reason as
    those two: this is a third separate compiled program and can't
    reliably import from the others once frozen with PyInstaller."""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / "TracklineAgent"
    d.mkdir(parents=True, exist_ok=True)
    return d

TASK_NAME = "TracklineScreenTimeSync"  # must match trackline_setup_gui.py's TASK_NAME exactly
SETUP_EXE_NAME = "TracklineSetup.exe"

def find_setup_exe():
    """Locates TracklineSetup.exe — same discovery approach as
    trackline_setup_gui.py's find_agent_exe(), and for the same reason:
    can't assume a single fixed folder layout. Checks the folder this
    Config Manager's own exe lives in, then the sibling-onedir-folder
    pattern PyInstaller --onedir actually produces when multiple tools are
    built into the same parent output folder. Unlike agent_exe_path,
    there's nowhere to persist this discovery across runs — config.json
    doesn't exist yet in the exact scenario this function matters for
    (the device isn't paired), so it's re-discovered each time."""
    if not getattr(sys, "frozen", False):
        return None
    own_folder = Path(sys.executable).parent

    same_folder_candidate = own_folder / SETUP_EXE_NAME
    if same_folder_candidate.exists():
        return same_folder_candidate

    sibling_candidate = own_folder.parent / "TracklineSetup" / SETUP_EXE_NAME
    if sibling_candidate.exists():
        return sibling_candidate

    return None

def launch_setup(setup_exe_path):
    """Launches the setup wizard as a separate, non-blocking process —
    the Config Manager doesn't wait for it to finish, since it's a GUI
    the person will interact with on their own. Returns (ok, message)."""
    try:
        subprocess.Popen([str(setup_exe_path)])
        return True, "Opening the setup wizard..."
    except Exception as e:
        return False, f"Could not open the setup wizard: {e}"


# ---------------------------------------------------------------------------
# Pure logic — reads local files only, no network calls, fully testable.
# ---------------------------------------------------------------------------

def read_config():
    path = _app_dir() / "config.json"
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

def read_status():
    path = _app_dir() / "status.json"
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

def read_sync_history():
    """Reads the capped sync history the agent now writes alongside its
    normal status.json update — most recent first, for display."""
    path = _app_dir() / "sync_history.json"
    if not path.exists():
        return []
    try:
        with open(path) as f:
            history = json.load(f)
        return list(reversed(history))
    except Exception:
        return []

def find_most_recent_sent_file():
    """Scans tracker/sent/ for the most recently modified file — a second,
    independent signal of "when did this device last actually sync
    successfully," corroborating (or contradicting) status.json."""
    sent_dir = _app_dir() / "tracker" / "sent"
    if not sent_dir.exists():
        return None
    files = list(sent_dir.glob("*.json"))
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)

def relative_time_label(iso_or_epoch):
    """Turns a timestamp into a short "X min/hours/days ago" label."""
    try:
        if isinstance(iso_or_epoch, (int, float)):
            when = datetime.fromtimestamp(iso_or_epoch, tz=timezone.utc)
        else:
            when = datetime.fromisoformat(str(iso_or_epoch).replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - when
        minutes = delta.total_seconds() / 60
        if minutes < 1:
            return "just now"
        if minutes < 60:
            return f"{int(minutes)} min ago"
        hours = minutes / 60
        if hours < 24:
            return f"{int(hours)}h ago"
        return f"{int(hours/24)}d ago"
    except Exception:
        return "unknown"

def write_config(cfg):
    path = _app_dir() / "config.json"
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)

def build_schtasks_change_command(minutes, task_name=TASK_NAME):
    """Task Scheduler doesn't read config.json — the interval is baked in
    at task-creation time — so changing it in config.json alone wouldn't
    do anything. This updates the actual task. Uses /change (not
    delete+recreate) to preserve everything else about the task (the
    command it runs, its trigger type) and only touch the interval."""
    return ["schtasks", "/change", "/tn", task_name, "/ri", str(minutes)]

def set_sync_interval(minutes):
    """Updates BOTH config.json and the real scheduled task. Returns
    (ok, message). If the scheduled task update fails (e.g. it was never
    set up, or was removed some other way), config.json still gets
    updated — better to have a correct config with a task that needs
    fixing separately than to block on a task that isn't there."""
    cfg = read_config()
    if not cfg:
        return False, "This device isn't paired."
    cfg["sync_interval_minutes"] = minutes
    write_config(cfg)

    if platform.system() != "Windows":
        return True, "Interval saved. Scheduled Task updates are Windows-only — update your cron/launchd entry manually."
    try:
        subprocess.run(build_schtasks_change_command(minutes), check=True, capture_output=True, text=True, timeout=15)
        return True, f"Sync interval updated to every {minutes} minutes."
    except subprocess.CalledProcessError as e:
        return False, f"Interval saved, but could not update the scheduled task: {e.stderr}"
    except Exception as e:
        return False, f"Interval saved, but could not update the scheduled task: {e}"

def sync_now():
    """Triggers an immediate sync using the agent path saved at pairing
    time. Returns (ok, message). Runs synchronously with a generous
    timeout — a real sync (querying ActivityWatch, pushing to the
    backend) should finish well within it."""
    cfg = read_config()
    if not cfg:
        return False, "This device isn't paired."
    agent_path = cfg.get("agent_exe_path")
    if not agent_path or not Path(agent_path).exists():
        return False, "Could not find the Trackline agent to run it — re-pairing (via TracklineSetup) will fix this."
    try:
        result = subprocess.run([agent_path, "--sync-once"], capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            return True, "Sync completed."
        return False, f"Sync did not complete cleanly: {result.stdout or result.stderr}"
    except subprocess.TimeoutExpired:
        return False, "Sync is taking longer than expected — check back in a minute."
    except Exception as e:
        return False, f"Could not run a sync: {e}"

def set_short_app_threshold(minutes):
    """Updates the per-device short-app rollup threshold. Simple config
    write only — unlike sync interval, this doesn't touch the scheduled
    task at all, since it's read fresh by the agent on every sync, not
    baked into anything at creation time."""
    cfg = read_config()
    if not cfg:
        return False, "This device isn't paired."
    try:
        minutes = int(minutes)
        if minutes < 0:
            raise ValueError()
    except (ValueError, TypeError):
        return False, "Enter a whole number of minutes (0 to disable)."
    cfg["short_app_threshold_minutes"] = minutes
    write_config(cfg)
    if minutes == 0:
        return True, "Short-app rollup disabled — every app will be sent individually."
    return True, f"Apps under {minutes} min (per hour) will now be grouped into one entry instead of sent individually."

def sync_missing_date(date_str):
    """Manually recovers one specific missing day via the agent's
    --sync-date flag. Returns (ok, message)."""
    cfg = read_config()
    if not cfg:
        return False, "This device isn't paired."
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return False, "Enter a date in YYYY-MM-DD format."
    agent_path = cfg.get("agent_exe_path")
    if not agent_path or not Path(agent_path).exists():
        return False, "Could not find the Trackline agent to run it — re-pairing (via TracklineSetup) will fix this."
    try:
        result = subprocess.run([agent_path, "--sync-date", date_str], capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            return True, f"Synced {date_str}."
        return False, f"Could not sync {date_str}: {result.stdout or result.stderr}"
    except subprocess.TimeoutExpired:
        return False, "Sync is taking longer than expected — check back in a minute."
    except Exception as e:
        return False, f"Could not sync that date: {e}"

def disconnect_device():
    """Fully disconnects this device — deregisters it (deletes all its
    usage history server-side, via cascade), removes the scheduled task,
    removes the Add/Remove Programs entry, and deletes local config.
    Reuses --full-uninstall exactly as Add/Remove Programs does, rather
    than reimplementing any of that logic here. Returns (ok, message)."""
    cfg = read_config()
    if not cfg:
        return False, "This device isn't paired."
    agent_path = cfg.get("agent_exe_path")
    if not agent_path or not Path(agent_path).exists():
        return False, "Could not find the Trackline agent to run the disconnect — you can still remove this device from the family's Settings page in the web app."
    try:
        result = subprocess.run([agent_path, "--full-uninstall"], capture_output=True, text=True, timeout=30)
        return True, "Device disconnected. All its usage history has been removed."
    except subprocess.TimeoutExpired:
        return False, "Disconnect is taking longer than expected — check Task Scheduler and Add/Remove Programs manually if this persists."
    except Exception as e:
        return False, f"Could not disconnect: {e}"

def run_diagnostics():
    """Checks the three things most likely to silently break syncing:
    ActivityWatch running locally, the backend reachable, and the
    scheduled task actually configured the way it should be (this last
    one would have caught the WakeToRun regression proactively instead
    of after the fact). Returns a list of (label, ok, detail) tuples."""
    results = []

    try:
        r = requests.get("http://127.0.0.1:5600/api/0/buckets", timeout=3)
        results.append(("ActivityWatch", r.status_code == 200, "Running and responding" if r.status_code==200 else f"Responded with status {r.status_code}"))
    except Exception as e:
        results.append(("ActivityWatch", False, f"Not reachable locally — is it running? ({e})"))

    cfg = read_config()
    if cfg and cfg.get("backend_url"):
        try:
            requests.get(cfg["backend_url"], timeout=8)
            results.append(("Backend server", True, "Reachable"))
        except Exception as e:
            results.append(("Backend server", False, f"Not reachable — check your internet connection ({e})"))
    else:
        results.append(("Backend server", False, "Not paired, nothing to check"))

    if platform.system() != "Windows":
        results.append(("Scheduled task", False, "Windows-only check"))
    else:
        try:
            out = subprocess.run(["schtasks", "/query", "/tn", TASK_NAME, "/xml"], capture_output=True, text=True, timeout=15)
            if out.returncode != 0:
                results.append(("Scheduled task", False, "Not found — automatic syncing isn't set up"))
            else:
                has_wake = "<WakeToRun>true</WakeToRun>" in out.stdout
                results.append(("Scheduled task", has_wake, "Configured correctly (wakes the laptop to sync)" if has_wake else "Exists, but WakeToRun is missing — re-run setup to fix"))
        except Exception as e:
            results.append(("Scheduled task", False, f"Could not check: {e}"))

    return results

def get_pairing_summary():
    """The single function the UI calls — returns everything needed to
    render the status view, or None if this device isn't paired at all.
    Pure, deterministic, testable without a display."""
    cfg = read_config()
    if not cfg:
        return None

    status = read_status()
    last_sent_file = find_most_recent_sent_file()

    return {
        "paired": True,
        "family_id": cfg.get("family_id", "unknown"),
        "member_name": cfg.get("member_name") or cfg.get("member_id", "unknown"),
        "member_id": cfg.get("member_id", "unknown"),
        "device_label": cfg.get("label") or cfg.get("hostname", "unknown"),
        "hostname": cfg.get("hostname", "unknown"),
        "backend_url": cfg.get("backend_url", "unknown"),
        "sync_interval_minutes": cfg.get("sync_interval_minutes", 30),
        "status": (status or {}).get("status", "unknown"),
        "status_detail": (status or {}).get("detail", ""),
        "status_checked_label": relative_time_label(status["checked_at"]) if status and status.get("checked_at") else "never",
        "last_successful_sync_label": relative_time_label(last_sent_file.stat().st_mtime) if last_sent_file else "never",
    }


# ---------------------------------------------------------------------------
# The GUI — thin on purpose, everything above this line is what's tested.
# ---------------------------------------------------------------------------

def run_gui():
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox, simpledialog

    root = tk.Tk()
    root.title("Trackline — Device status")
    window_width, window_height = 460, 560
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    x = (screen_width // 2) - (window_width // 2)
    y = (screen_height // 2) - (window_height // 2)
    root.geometry(f"{window_width}x{window_height}+{x}+{y}")
    root.minsize(380, 420)
    root.resizable(True, True)

    outer = ttk.Frame(root, padding=14)
    outer.pack(fill="both", expand=True)

    action_label = ttk.Label(outer, text="", wraplength=420, foreground="#5c5847")
    action_label.pack(pady=(0,8))

    notebook = ttk.Notebook(outer)
    notebook.pack(fill="both", expand=True)
    status_tab = ttk.Frame(notebook, padding=10)
    settings_tab = ttk.Frame(notebook, padding=10)
    notebook.add(status_tab, text="Status")
    notebook.add(settings_tab, text="Settings")

    interval_var = tk.StringVar()
    threshold_var = tk.StringVar()
    sync_date_var = tk.StringVar()
    button_row = ttk.Frame(outer)

    def prompt_password_and_verify():
        """Shows a password prompt, verifies it against the real backend
        (same endpoint pairing already uses). Returns True only if
        correct — cancelling or entering the wrong password both return
        False, with a clear message either way."""
        cfg = read_config()
        if not cfg:
            return False
        pwd = simpledialog.askstring("Family password required", "Enter your family password to make this change:", show="*", parent=root)
        if pwd is None:
            return False
        ok, msg = verify_family_password(cfg, pwd)
        if not ok:
            messagebox.showerror("Incorrect password", msg or "Incorrect family password.")
        return ok

    def do_pair_now():
        setup_path = find_setup_exe()
        if not setup_path:
            picked = filedialog.askopenfilename(
                title=f"Locate {SETUP_EXE_NAME}",
                filetypes=[("TracklineSetup", SETUP_EXE_NAME), ("All files", "*.*")],
            )
            if not picked:
                return
            setup_path = picked
        ok, msg = launch_setup(setup_path)
        action_label.config(text=msg, foreground="#3d7a4f" if ok else "#a5323a")
        if ok:
            messagebox.showinfo("Setup opened", "Finish pairing in the setup window, then click Refresh here to see the updated status.")

    def render():
        for w in status_tab.winfo_children():
            w.destroy()
        for w in settings_tab.winfo_children():
            w.destroy()
        for w in button_row.winfo_children():
            w.destroy()
        summary = get_pairing_summary()

        if not summary:
            ttk.Label(status_tab, text="This device is not paired yet.", font=("Segoe UI", 11, "bold")).pack(pady=(10,4))
            ttk.Label(status_tab, text="Pair it with a family to start reporting screen time.", wraplength=380).pack(pady=(0,14))
            ttk.Button(status_tab, text="Pair this device", command=do_pair_now).pack()
            ttk.Button(button_row, text="Refresh", command=render).pack(side="left")
            return

        status_colors = {"ok": "#3d7a4f", "failed": "#c98a2e", "revoked": "#a5323a", "unknown": "#8a8468"}
        status_labels = {"ok": "Syncing normally", "failed": "Last sync failed (will retry)", "revoked": "Pairing was removed — re-pair to resume", "unknown": "No sync attempted yet"}

        # ---------------- STATUS TAB ----------------
        rows = [
            ("Paired to", f"{summary['member_name']}"),
            ("Family ID", summary["family_id"]),
            ("Device label", summary["device_label"]),
            ("Hostname", summary["hostname"]),
            ("Last sync attempt", summary["status_checked_label"]),
            ("Last successful sync", summary["last_successful_sync_label"]),
        ]
        for label, value in rows:
            row = ttk.Frame(status_tab)
            row.pack(fill="x", pady=3)
            ttk.Label(row, text=label, width=18, foreground="#5c5847").pack(side="left")
            ttk.Label(row, text=str(value), font=("Segoe UI", 9, "bold")).pack(side="left")

        status_row = ttk.Frame(status_tab)
        status_row.pack(fill="x", pady=(10,10))
        color = status_colors.get(summary["status"], "#8a8468")
        text = status_labels.get(summary["status"], summary["status"])
        ttk.Label(status_row, text="●", foreground=color, font=("Segoe UI", 12)).pack(side="left")
        ttk.Label(status_row, text=text, foreground=color, font=("Segoe UI", 10, "bold")).pack(side="left", padx=(4,0))

        ttk.Separator(status_tab).pack(fill="x", pady=(4,10))
        ttk.Label(status_tab, text="Sync history", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        history = read_sync_history()
        if not history:
            ttk.Label(status_tab, text="No sync attempts recorded yet.", foreground="#8a8468").pack(anchor="w", pady=(4,0))
        else:
            hist_frame = ttk.Frame(status_tab)
            hist_frame.pack(fill="both", expand=True, pady=(4,0))
            canvas = tk.Canvas(hist_frame, highlightthickness=0, height=140)
            scrollbar = ttk.Scrollbar(hist_frame, orient="vertical", command=canvas.yview)
            inner = ttk.Frame(canvas)
            inner.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
            canvas.create_window((0,0), window=inner, anchor="nw")
            canvas.configure(yscrollcommand=scrollbar.set)
            canvas.pack(side="left", fill="both", expand=True)
            scrollbar.pack(side="right", fill="y")
            for entry in history[:20]:
                c = status_colors.get(entry.get("status"), "#8a8468")
                when = relative_time_label(entry.get("checked_at")) if entry.get("checked_at") else "?"
                line = ttk.Frame(inner)
                line.pack(fill="x", pady=1)
                ttk.Label(line, text="●", foreground=c, font=("Segoe UI", 8)).pack(side="left")
                ttk.Label(line, text=f" {when} — {entry.get('status','?')}", font=("Segoe UI", 8)).pack(side="left")

        ttk.Button(button_row, text="Sync now", command=do_sync_now).pack(side="left", padx=(0,8))
        ttk.Button(button_row, text="Refresh", command=render).pack(side="left")

        # ---------------- SETTINGS TAB ----------------
        interval_row = ttk.Frame(settings_tab)
        interval_row.pack(fill="x", pady=(0,10))
        ttk.Label(interval_row, text="Sync interval", width=16, foreground="#5c5847").pack(side="left")
        interval_var.set(str(summary["sync_interval_minutes"]))
        ttk.Combobox(interval_row, textvariable=interval_var, values=["15","30","60","120"], width=6, state="normal").pack(side="left")
        ttk.Label(interval_row, text="min").pack(side="left", padx=(4,8))
        ttk.Button(interval_row, text="Apply", command=apply_interval).pack(side="left")

        cfg = read_config() or {}
        threshold_row = ttk.Frame(settings_tab)
        threshold_row.pack(fill="x", pady=(0,10))
        ttk.Label(threshold_row, text="Short-app rollup", width=16, foreground="#5c5847").pack(side="left")
        threshold_var.set(str(cfg.get("short_app_threshold_minutes", 10)))
        ttk.Entry(threshold_row, textvariable=threshold_var, width=6).pack(side="left")
        ttk.Label(threshold_row, text="min (0 = off)").pack(side="left", padx=(4,8))
        ttk.Button(threshold_row, text="Apply", command=apply_threshold).pack(side="left")

        ttk.Separator(settings_tab).pack(fill="x", pady=8)

        ttk.Label(settings_tab, text="Sync a missing day", foreground="#5c5847").pack(anchor="w")
        date_row = ttk.Frame(settings_tab)
        date_row.pack(fill="x", pady=(4,10))
        ttk.Entry(date_row, textvariable=sync_date_var, width=12).pack(side="left")
        ttk.Label(date_row, text="YYYY-MM-DD").pack(side="left", padx=(4,8))
        ttk.Button(date_row, text="Sync this date", command=apply_sync_date).pack(side="left")

        ttk.Separator(settings_tab).pack(fill="x", pady=8)

        ttk.Button(settings_tab, text="Run diagnostics", command=do_diagnostics).pack(anchor="w", pady=(0,10))

        ttk.Separator(settings_tab).pack(fill="x", pady=8)
        ttk.Label(settings_tab, text="Disconnecting removes this device and ALL its usage history permanently.", foreground="#a5323a", wraplength=380).pack(anchor="w", pady=(0,6))
        ttk.Button(settings_tab, text="Disconnect this device", command=do_disconnect).pack(anchor="w")

    def apply_interval():
        try:
            minutes = int(interval_var.get())
            if minutes < 1:
                raise ValueError()
        except ValueError:
            action_label.config(text="Enter a whole number of minutes.", foreground="#a5323a")
            return
        if not prompt_password_and_verify():
            return
        action_label.config(text="Updating...", foreground="#5c5847")
        root.update_idletasks()
        ok, msg = set_sync_interval(minutes)
        action_label.config(text=msg, foreground="#3d7a4f" if ok else "#a5323a")
        render()

    def apply_threshold():
        if not prompt_password_and_verify():
            return
        action_label.config(text="Updating...", foreground="#5c5847")
        root.update_idletasks()
        ok, msg = set_short_app_threshold(threshold_var.get())
        action_label.config(text=msg, foreground="#3d7a4f" if ok else "#a5323a")
        render()

    def apply_sync_date():
        date_str = sync_date_var.get().strip()
        if not prompt_password_and_verify():
            return
        action_label.config(text=f"Syncing {date_str}...", foreground="#5c5847")
        root.update_idletasks()
        ok, msg = sync_missing_date(date_str)
        action_label.config(text=msg, foreground="#3d7a4f" if ok else "#a5323a")
        render()

    def do_sync_now():
        action_label.config(text="Syncing now — this can take a moment...", foreground="#5c5847")
        root.update_idletasks()
        ok, msg = sync_now()
        action_label.config(text=msg, foreground="#3d7a4f" if ok else "#a5323a")
        render()

    def do_diagnostics():
        action_label.config(text="Running diagnostics...", foreground="#5c5847")
        root.update_idletasks()
        results = run_diagnostics()
        lines = [f"{'✓' if ok else '✗'} {label}: {detail}" for label, ok, detail in results]
        messagebox.showinfo("Diagnostics", "\n\n".join(lines))
        action_label.config(text="Diagnostics complete.", foreground="#5c5847")

    def do_disconnect():
        if not messagebox.askyesno("Disconnect this device?", "This permanently deletes ALL usage history for this device. This cannot be undone. Continue?"):
            return
        if not prompt_password_and_verify():
            return
        action_label.config(text="Disconnecting...", foreground="#5c5847")
        root.update_idletasks()
        ok, msg = disconnect_device()
        action_label.config(text=msg, foreground="#3d7a4f" if ok else "#a5323a")
        render()

    render()
    button_row.pack(pady=(10,0))

    root.mainloop()


if __name__ == "__main__":
    run_gui()
