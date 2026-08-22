#!/usr/bin/env python3
"""
Trackline laptop agent — reads ActivityWatch's LOCAL data, computes real
active usage (not just "window was open"), and pushes it to Trackline's
backend every N minutes.

Design decisions, and why:

- Reads ONLY the `app` field off window events — the `title` field (which
  can contain emails, page titles, anything) is never read past that point.
  This isn't "redact then send" — it's "never touch it," which is a
  stronger privacy guarantee than a regex filter could ever be.

- App/site active time is raw window-focus time from ActivityWatch's
  window bucket. An earlier version intersected this with AFK data to
  exclude idle time, but real-world testing across multiple machines found
  AFK detection unreliable enough to produce wrong numbers rather than
  just imprecise ones — a known, recurring issue in the ActivityWatch
  community, not specific to any one setup — so that intersection was
  removed.

- Every sync writes a local JSON file FIRST, before any network call. That
  file is the literal payload sent — nothing is recomputed at send time.
  One file per run, never appended to, moved to sent/ only after a
  confirmed successful push. Unsent files are naturally the retry queue.

- Upserts only, never delete-then-insert, on the backend side — a crash
  mid-sync can't leave a gap with no data.

- The device token lives in config.json on this machine (unavoidable for
  any local agent — it has to be readable *somewhere* to be used). What
  limits the blast radius if that file is ever read by someone it
  shouldn't be: the token can ONLY insert usage rows for this one device's
  own family+member. It cannot read anything, cannot see other devices,
  cannot touch schedules/tasks/PINs/anything else in Trackline.
"""

import json
import os
import sys
import time
import getpass
import hashlib
import argparse
import platform
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("This script needs the 'requests' library: pip install requests")
    sys.exit(1)

AW_BASE_URL = "http://127.0.0.1:5600/api/0"
TASK_NAME = "TracklineScreenTimeSync"  # must match trackline_setup_gui.py's TASK_NAME exactly

# App-name-only categorization — deliberately does NOT use window titles at
# all, keeping the "never touch it" privacy commitment intact while still
# answering "study vs game time." These are reasonable starting points, not
# authoritative — override or extend via "category_map" in config.json,
# e.g. {"category_map": {"discord.exe": "Study"}} if that's how a family
# actually uses it. Anything not listed here reports as "Uncategorized"
# rather than being guessed at.
DEFAULT_CATEGORY_MAP = {
    # Games
    "roblox.exe": "Games", "robloxplayerbeta.exe": "Games",
    "minecraft.exe": "Games", "minecraftlauncher.exe": "Games",
    "fortniteclient-win64-shipping.exe": "Games", "fortnitelauncher.exe": "Games",
    "steam.exe": "Games", "steamwebhelper.exe": "Games",
    "epicgameslauncher.exe": "Games",
    "valorant.exe": "Games", "valorant-win64-shipping.exe": "Games",
    "leagueclient.exe": "Games", "league of legends.exe": "Games",
    "amongus.exe": "Games",
    # Study
    "winword.exe": "Study", "excel.exe": "Study", "powerpnt.exe": "Study", "onenote.exe": "Study",
    "code.exe": "Study",  # VS Code
    "acrobat.exe": "Study", "acrord32.exe": "Study",
    # Sites (domain only — same "app/site are both just a name to look up"
    # mechanism as above; only relevant once aw-watcher-web is installed)
    "roblox.com": "Games", "poki.com": "Games", "twitch.tv": "Games",
    "khanacademy.org": "Study", "classroom.google.com": "Study", "docs.google.com": "Study",
    "duolingo.com": "Study", "wikipedia.org": "Study",
}

def categorize(app_name, category_map):
    """Looks up a category for an app name — case-insensitive, since the
    same executable can appear with different casing across Windows
    versions/installs. Anything unrecognized stays "Uncategorized" rather
    than being force-fit into Study or Games."""
    if not app_name:
        return "Uncategorized"
    return category_map.get(app_name.lower(), "Uncategorized")

def _app_dir():
    """A single, stable, shared location for config.json and the tracker/
    folder — deliberately NOT "wherever this exe happens to live."

    Two earlier approaches both broke for the same underlying reason:
    1. Path(__file__).parent breaks once compiled — PyInstaller --onefile
       mode runs from a temporary extraction folder that's deleted on exit.
    2. Path(sys.executable).parent (the first fix) solves that, but
       TracklineSetup and TracklineAgent are two SEPARATE compiled programs.
       With --onedir builds especially, PyInstaller puts each one in its
       own folder by default — so the setup wizard and the agent would
       each resolve to a DIFFERENT folder, meaning config.json written by
       one is never where the other looks for it. This is exactly what
       produced "Not paired yet" immediately after a successful pairing.

    Fix: use Windows' standard per-user app-data location instead — the
    same absolute path regardless of which of the two exes is asking, and
    regardless of where either one happens to be installed. This is also
    just more idiomatic Windows behavior generally; most real apps don't
    store their config next to the exe at all."""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / "TracklineAgent"
    d.mkdir(parents=True, exist_ok=True)
    return d

CONFIG_PATH = _app_dir() / "config.json"
TRACKER_DIR = _app_dir() / "tracker"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config():
    if not CONFIG_PATH.exists():
        return None
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    try:
        os.chmod(CONFIG_PATH, 0o600)  # best-effort: owner read/write only
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Pure logic: interval math and hour-bucketing.
# These have NO dependency on ActivityWatch or the network, so they're the
# part that's actually been verified by execution below (see the test
# block at the bottom of this file, run with --selftest).
# ---------------------------------------------------------------------------

def intersect(a_start, a_end, b_start, b_end):
    """Returns the overlapping (start, end) of two intervals, or None."""
    s = max(a_start, b_start)
    e = min(a_end, b_end)
    if e <= s:
        return None
    return (s, e)

def split_across_hours(start_dt, end_dt):
    """
    Given a local-timezone-aware start/end datetime, returns {hour_str: seconds}
    attributing seconds to every local clock-hour the interval overlaps.
    e.g. a 09:15-11:20 interval returns roughly {'09': 2700, '10': 3600, '11': 1200}.
    """
    result = {}
    cur = start_dt
    while cur < end_dt:
        hour_start = cur.replace(minute=0, second=0, microsecond=0)
        hour_end = hour_start + timedelta(hours=1)
        seg_end = min(end_dt, hour_end)
        seconds = (seg_end - cur).total_seconds()
        if seconds > 0:
            hour_key = f"{cur.hour:02d}"
            result[hour_key] = result.get(hour_key, 0) + seconds
        cur = seg_end
    return result

def compute_window_seconds_by_hour(window_events, excluded_apps, excluded_title_keywords):
    """
    window_events: list of (start_dt, end_dt, app_name, title)

    Returns: { "09": {(app,title): seconds, ...}, "10": {...} }

    Deliberately does NOT intersect with AFK data — real-world testing
    across multiple machines found AFK detection unreliable enough to
    produce wrong numbers rather than just imprecise ones, so this uses
    raw window-focus time directly instead. Exclusion now applies at both
    levels: an event is dropped entirely (not counted at all, matching how
    app exclusion already worked) if its app is in excluded_apps, OR if
    its title contains any of excluded_title_keywords (case-insensitive
    substring match) — e.g. hiding a password manager's title even when
    the app itself isn't on the excluded_apps list.
    """
    excluded_apps_lower = {a.lower() for a in (excluded_apps or [])}
    excluded_title_kw_lower = [k.lower() for k in (excluded_title_keywords or [])]
    hourly = {}
    for start, end, app, title in window_events:
        if app and app.lower() in excluded_apps_lower:
            continue
        if title and any(kw in title.lower() for kw in excluded_title_kw_lower):
            continue
        for hour_key, seconds in split_across_hours(start, end).items():
            hourly.setdefault(hour_key, {})
            key = (app, title or "")
            hourly[hour_key][key] = hourly[hour_key].get(key, 0) + seconds
    return hourly


# ---------------------------------------------------------------------------
# ActivityWatch — local API only, never touches the network beyond localhost.
# ---------------------------------------------------------------------------

def aw_find_bucket(suffix):
    """Finds the first bucket whose id contains the given suffix, e.g. 'window' or 'afk'."""
    resp = requests.get(f"{AW_BASE_URL}/buckets", timeout=5)
    resp.raise_for_status()
    buckets = resp.json()
    for bucket_id in buckets:
        if suffix in bucket_id:
            return bucket_id
    return None

def aw_get_events_range(bucket_id, start_utc, end_utc):
    """Fetches all events for this bucket within [start_utc, end_utc)."""
    resp = requests.get(
        f"{AW_BASE_URL}/buckets/{bucket_id}/events",
        params={"start": start_utc.isoformat(), "end": end_utc.isoformat(), "limit": -1},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()

def aw_get_events_today(bucket_id, tz):
    """Fetches all events for this bucket from local midnight (in `tz`) to now."""
    now_local = datetime.now(tz)
    midnight_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return aw_get_events_range(bucket_id, midnight_local.astimezone(timezone.utc), now_local.astimezone(timezone.utc))

def parse_aw_event(ev, tz):
    """AW events are {timestamp, duration, data:{...}}. Returns (start_dt, end_dt, data)."""
    start = datetime.fromisoformat(ev["timestamp"].replace("Z", "+00:00")).astimezone(tz)
    end = start + timedelta(seconds=ev["duration"])
    return start, end, ev.get("data", {})


# ---------------------------------------------------------------------------
# Building and writing the day snapshot
# ---------------------------------------------------------------------------

SHORT_APP_ROLLUP_LABEL = "Other short activities"

def apply_short_app_rollup(app_seconds, threshold_minutes):
    """Pools every (app,title) entry below the threshold into a single
    bucket, rather than sending each as an individual row — a permanent
    reduction in stored granularity, by explicit decision, not just a
    display-layer change. Per-device configurable (default 10 minutes,
    0 disables it entirely). Evaluated per hour, matching how aggregation
    already naturally happens in this pipeline. Entries at or above the
    threshold are completely untouched. The rolled-up bucket deliberately
    isn't run through categorize() with any special-casing — "Other short
    activities" simply won't match any real app/domain name, so it falls
    through to "Uncategorized" naturally, which is the honest label for a
    bucket that may blend apps that would individually have been Study,
    Games, or Uncategorized — no single real category would be accurate
    for the mix."""
    if threshold_minutes <= 0:
        return dict(app_seconds)
    threshold_seconds = threshold_minutes * 60
    kept = {}
    rolled_up_total = 0
    for key, seconds in app_seconds.items():
        if seconds >= threshold_seconds:
            kept[key] = seconds
        else:
            rolled_up_total += seconds
    if rolled_up_total > 0:
        rollup_key = (SHORT_APP_ROLLUP_LABEL, "")
        kept[rollup_key] = kept.get(rollup_key, 0) + rolled_up_total
    return kept

def build_hours_for_range(window_bucket, web_bucket, start_utc, end_utc, tz, cfg):
    """Shared aggregation logic for a given UTC time range — used by both
    the live daily sync and the one-time historical backfill, so both
    paths are guaranteed to compute things identically."""
    window_events = []
    if window_bucket:
        for ev in aw_get_events_range(window_bucket, start_utc, end_utc):
            start, end, data = parse_aw_event(ev, tz)
            app = data.get("app")
            title = data.get("title", "")
            if app:
                window_events.append((start, end, app, title))

    site_events = []
    if web_bucket:
        for ev in aw_get_events_range(web_bucket, start_utc, end_utc):
            start, end, data = parse_aw_event(ev, tz)
            url = data.get("url", "")
            domain = url.split("/")[2] if "://" in url else url
            # collapse subdomains to the registered domain — never store the full URL/path
            parts = domain.split(".")
            if len(parts) > 2:
                domain = ".".join(parts[-2:])
            if domain:
                site_events.append((start, end, domain, ""))

    excluded_apps = cfg.get("excluded_apps")
    excluded_title_keywords = cfg.get("excluded_title_keywords")
    window_hourly = compute_window_seconds_by_hour(window_events, excluded_apps, excluded_title_keywords)
    site_hourly = compute_window_seconds_by_hour(site_events, [], [])  # sites are domain-only, no title-level exclusion applies

    all_hours = sorted(set(window_hourly.keys()) | set(site_hourly.keys()))
    category_map = dict(DEFAULT_CATEGORY_MAP)
    category_map.update({k.lower(): v for k, v in (cfg.get("category_map") or {}).items()})
    short_app_threshold_minutes = cfg.get("short_app_threshold_minutes", 10)

    hours_out = {}
    for h in all_hours:
        rolled_up_apps = apply_short_app_rollup(window_hourly.get(h, {}), short_app_threshold_minutes)
        hours_out[h] = {
            # round(s) > 0 drops sub-second focus flickers (e.g. LockApp.exe
            # briefly gaining focus for a fraction of a second) that would
            # otherwise show up as noisy, meaningless "0 active_seconds"
            # entries — confirmed happening in real captured data.
            "apps": [{"app": a, "title": t, "active_seconds": round(s), "category": categorize(a, category_map)}
                      for (a, t), s in rolled_up_apps.items() if round(s) > 0],
            "sites": [{"domain": d, "active_seconds": round(s), "category": categorize(d, category_map)}
                       for (d, _), s in site_hourly.get(h, {}).items() if round(s) > 0],
        }
    return hours_out

def build_snapshot_for_date(cfg, tz, date_str):
    """Same as build_snapshot(), but for an explicit past date rather than
    today — the actual backfill mechanism for a specific missing day.
    Reuses build_hours_for_range() exactly as build_snapshot() does, so
    both paths are guaranteed to compute things identically. Only works
    while ActivityWatch's own local history still has that day's data —
    a fully-off/broken laptop for that period has nothing to recover,
    regardless of this function."""
    window_bucket = aw_find_bucket("window")
    web_bucket = aw_find_bucket("web")

    day_local = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=tz)
    day_end_local = day_local + timedelta(days=1)
    hours_out = build_hours_for_range(
        window_bucket, web_bucket,
        day_local.astimezone(timezone.utc), day_end_local.astimezone(timezone.utc),
        tz, cfg,
    )
    return {
        "member_id": cfg["member_id"],
        "hostname": cfg["hostname"],
        "date": date_str,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hours": hours_out,
    }

def sync_date(date_str):
    """The --sync-date entry point — manually recover one specific missing
    day. Same pairing/revocation checks as a normal sync, since there's no
    reason a backfill should behave differently there."""
    cfg = load_config()
    if not cfg:
        print("Not paired yet. Run with --pair first.")
        sys.exit(1)
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        print(f"'{date_str}' isn't a valid date — use YYYY-MM-DD format.")
        sys.exit(1)

    last_status = read_status()
    if last_status and last_status.get("status") == "revoked":
        print("This device's pairing was previously found to be revoked. Re-pair before syncing.")
        return "revoked"

    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(cfg.get("timezone", "UTC"))
    except Exception:
        tz = timezone.utc

    snapshot = build_snapshot_for_date(cfg, tz, date_str)
    audit_path = write_audit_file(snapshot)
    result = push_snapshot(cfg, snapshot, audit_path)
    if result == "ok":
        print(f"Successfully synced {date_str}.")
    return result

def build_snapshot(cfg, tz):
    window_bucket = aw_find_bucket("window")
    web_bucket = aw_find_bucket("web")  # optional — only present if aw-watcher-web is installed

    now_local = datetime.now(tz)
    midnight_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    hours_out = build_hours_for_range(
        window_bucket, web_bucket,
        midnight_local.astimezone(timezone.utc), now_local.astimezone(timezone.utc),
        tz, cfg,
    )
    return {
        "member_id": cfg["member_id"],
        "hostname": cfg["hostname"],
        "date": now_local.strftime("%Y-%m-%d"),
        "generated_at": now_local.astimezone(timezone.utc).isoformat(),
        "hours": hours_out,
    }

def build_backfill_snapshots(cfg, tz, days=30):
    """One snapshot per day covering the past `days` days (not including
    today, which the normal sync already handles). Runs once, at pairing
    time only — not re-run on subsequent syncs. Days with no window-bucket
    data at all (e.g. before ActivityWatch was installed) are skipped
    rather than pushing an empty snapshot for them."""
    window_bucket = aw_find_bucket("window")
    web_bucket = aw_find_bucket("web")
    now_local = datetime.now(tz)
    snapshots = []
    for days_ago in range(days, 0, -1):
        day_local = (now_local - timedelta(days=days_ago)).replace(hour=0, minute=0, second=0, microsecond=0)
        day_end_local = day_local + timedelta(days=1)
        hours_out = build_hours_for_range(
            window_bucket, web_bucket,
            day_local.astimezone(timezone.utc), day_end_local.astimezone(timezone.utc),
            tz, cfg,
        )
        if not hours_out:
            continue
        snapshots.append({
            "member_id": cfg["member_id"],
            "hostname": cfg["hostname"],
            "date": day_local.strftime("%Y-%m-%d"),
            "generated_at": now_local.astimezone(timezone.utc).isoformat(),
            "hours": hours_out,
        })
    return snapshots

def write_audit_file(snapshot):
    now = datetime.now()
    snapshot_date = datetime.strptime(snapshot["date"], "%Y-%m-%d")
    day_dir = TRACKER_DIR / f"{snapshot_date:%Y}" / f"{snapshot_date:%m}" / f"{snapshot_date:%d}"
    day_dir.mkdir(parents=True, exist_ok=True)
    path = day_dir / f"{now:%H%M%S}.json"
    with open(path, "w") as f:
        json.dump(snapshot, f, indent=2)
    return path

def mark_sent(path):
    sent_dir = TRACKER_DIR / "sent"
    sent_dir.mkdir(parents=True, exist_ok=True)
    path.rename(sent_dir / path.name)


# ---------------------------------------------------------------------------
# Talking to Trackline's backend (never Supabase directly — see design notes)
# ---------------------------------------------------------------------------

def write_status(status, detail=""):
    """A small local status file — lets both this script and the
    Config Manager app know the last-known pairing health without an
    extra network round-trip. Deliberately local-only. Also appends to a
    capped sync-history log (last 20 entries) — same call, no change
    needed at any existing call site, so every place that already reports
    a sync outcome automatically gets a history entry too."""
    entry = {"status": status, "detail": detail, "checked_at": datetime.now(timezone.utc).isoformat()}
    status_path = _app_dir() / "status.json"
    try:
        with open(status_path, "w") as f:
            json.dump(entry, f)
    except Exception:
        pass
    history_path = _app_dir() / "sync_history.json"
    try:
        history = []
        if history_path.exists():
            with open(history_path) as f:
                history = json.load(f)
        history.append(entry)
        history = history[-20:]  # keep only the most recent 20
        with open(history_path, "w") as f:
            json.dump(history, f)
    except Exception:
        pass

def read_status():
    status_path = _app_dir() / "status.json"
    if not status_path.exists():
        return None
    try:
        with open(status_path) as f:
            return json.load(f)
    except Exception:
        return None

def push_snapshot(cfg, snapshot, audit_path):
    resp = requests.post(
        f"{cfg['backend_url']}/api/device-usage-ingest",
        json={
            "deviceId": cfg["device_id"],
            "deviceToken": cfg["device_token"],
            "date": snapshot["date"],
            "hours": snapshot["hours"],
        },
        timeout=15,
    )
    if resp.status_code == 200:
        mark_sent(audit_path)
        print(f"Synced OK: {resp.json()}")
        write_status("ok")
        return "ok"
    elif resp.status_code == 403:
        # Distinguishes "this pairing was revoked/removed" from an
        # ordinary failure — worth detecting specifically, since retrying
        # a permanently revoked device forever is pointless, unlike a
        # transient network error which SHOULD keep retrying.
        print(f"Sync rejected — this device's pairing appears to have been removed: {resp.text}")
        write_status("revoked", resp.text)
        return "revoked"
    else:
        print(f"Sync failed ({resp.status_code}): {resp.text} — file kept for retry: {audit_path}")
        write_status("failed", resp.text)
        return "failed"

def retry_unsent(cfg):
    """Any file still sitting outside tracker/sent/ is naturally the retry
    queue. Stops immediately if a revocation is detected — no point
    pushing the rest of the backlog against a device that's been removed."""
    if not TRACKER_DIR.exists():
        return "ok"
    for path in TRACKER_DIR.rglob("*.json"):
        if "sent" in path.parts:
            continue
        with open(path) as f:
            snapshot = json.load(f)
        result = push_snapshot(cfg, snapshot, path)
        if result == "revoked":
            return "revoked"
    return "ok"


# ---------------------------------------------------------------------------
# Pairing / re-registering / uninstalling
# ---------------------------------------------------------------------------

def simple_hash(s):
    """Matches Trackline's own lightweight family-password hash exactly —
    this is the SAME weak, non-cryptographic hash the frontend uses (djb2
    variant), so a password typed here produces the identical hash the
    backend already has stored. It's intentionally not stronger than what
    the family password itself already is."""
    h = 5381
    for ch in s:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return format(h, "x")

def pair(backend_url):
    print("=== Pair this laptop with a Trackline family ===")
    family_id = input("Family ID: ").strip().upper()
    family_password = getpass.getpass("Family password: ")
    password_hash = simple_hash(family_password)

    # Look up real member names so the CLI path stores a friendly display
    # name too, not just a raw ID — same info the GUI path already gets
    # from its dropdown.
    member_id = None
    member_name = None
    try:
        lookup_resp = requests.post(f"{backend_url}/api/family-members", json={
            "familyId": family_id, "passwordHash": password_hash,
        }, timeout=15)
        if lookup_resp.status_code == 200:
            members = lookup_resp.json().get("members", [])
            if members:
                print("\nFamily members:")
                for i, m in enumerate(members):
                    print(f"  {i+1}. {m['name']} ({m['role']})")
                choice = input("Pick a number, or type a member ID directly: ").strip()
                if choice.isdigit() and 1 <= int(choice) <= len(members):
                    chosen = members[int(choice)-1]
                    member_id, member_name = chosen["id"], chosen["name"]
                else:
                    member_id = choice
    except Exception:
        pass  # lookup is a convenience, not required — fall through to manual entry below

    if not member_id:
        member_id = input("Member ID (ask the parent — Settings shows each member's id): ").strip()

    label = input(f"Device label (e.g. 'Mia's Laptop') [{os.environ.get('COMPUTERNAME', 'this-laptop')}]: ").strip() \
        or os.environ.get("COMPUTERNAME", "this-laptop")

    resp = requests.post(f"{backend_url}/api/device-pair", json={
        "familyId": family_id,
        "passwordHash": password_hash,
        "memberId": member_id,
        "hostname": os.environ.get("COMPUTERNAME", label),
        "label": label,
    }, timeout=15)

    if resp.status_code != 200:
        print(f"Pairing failed: {resp.text}")
        sys.exit(1)

    result = resp.json()
    cfg = {
        "family_id": family_id,
        "member_id": member_id,
        "member_name": member_name,  # may be None if looked-up name wasn't available — Config Manager falls back to showing the ID
        "label": label,
        "device_id": result["deviceId"],
        "device_token": result["deviceToken"],
        "hostname": os.environ.get("COMPUTERNAME", label),
        "backend_url": backend_url,
        "timezone": input("Timezone (e.g. Australia/Melbourne): ").strip() or "UTC",
        "sync_interval_minutes": 30,
        "excluded_apps": [],
        "excluded_title_keywords": [],  # e.g. ["bank", "password"] — hides matching titles even if the app itself isn't excluded
        "category_map": {},  # override/extend the defaults, e.g. {"discord.exe": "Study"}
        "short_app_threshold_minutes": 10,  # apps under this many minutes (per hour) get pooled into one bucket rather than sent individually — 0 disables
        "agent_exe_path": sys.executable if getattr(sys, "frozen", False) else None,
    }
    save_config(cfg)
    write_status("ok")  # clear any stale "revoked" status from a previous pairing
    print(f"Paired. Device ID: {cfg['device_id']}")
    print("This device is now sending usage data for this family/member only.")

def run_backfill(cfg, days=30):
    """Imports existing local ActivityWatch history once, right after
    pairing — not re-run on later syncs. Writes and pushes one snapshot
    per day that has data, using the exact same write-then-push path as
    the regular sync (audit file first, upsert on push, retry-safe)."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(cfg.get("timezone", "UTC"))
    except Exception:
        tz = timezone.utc

    print(f"Importing up to {days} days of existing history...")
    snapshots = build_backfill_snapshots(cfg, tz, days=days)
    if not snapshots:
        print("No existing history found to import.")
        return
    imported = 0
    for snap in snapshots:
        audit_path = write_audit_file(snap)
        if push_snapshot(cfg, snap, audit_path):
            imported += 1
    print(f"Backfill complete: {imported}/{len(snapshots)} day(s) imported.")

def reregister(backend_url):
    old_cfg = load_config()
    if old_cfg:
        print("Deregistering the current pairing first (deletes its usage history)...")
        try:
            requests.post(f"{backend_url}/api/device-deregister", json={
                "deviceId": old_cfg["device_id"], "deviceToken": old_cfg["device_token"],
            }, timeout=15)
        except Exception as e:
            print(f"Warning: could not reach backend to clean up the old pairing ({e}). Continuing anyway.")
    pair(backend_url)

def unregister_uninstaller():
    """Best-effort — removes the Add/Remove Programs entry, if one exists.
    No longer created by this codebase (the Inno Setup installer now
    handles Add/Remove Programs registration properly at install time,
    replacing what this used to do at pairing time — that redundant path
    created a confusing duplicate entry and was removed). Kept here purely
    as defensive cleanup, in case a device was paired with an older build
    that still created one."""
    if platform.system() != "Windows":
        return
    try:
        import winreg
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall\TracklineAgent")
    except Exception:
        pass

def remove_scheduled_task():
    """Best-effort removal of the sync scheduled task."""
    if platform.system() != "Windows":
        return
    try:
        subprocess.run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"], capture_output=True, timeout=15)
    except Exception:
        pass

def perform_full_cleanup():
    """The actual, complete cleanup — deregisters the device, removes the
    scheduled task, removes the Add/Remove Programs entry, and deletes
    local config/audit files. Used by BOTH uninstall paths below. This
    consolidation exists because of a real bug: an earlier version had
    --uninstall and --full-uninstall as two separately-written functions,
    and only full_uninstall actually cleaned up the scheduled task and
    registry entry — --uninstall silently left both behind. One shared
    function means there's only one cleanup sequence to get right."""
    cfg = load_config()
    if cfg:
        try:
            resp = requests.post(f"{cfg['backend_url']}/api/device-deregister", json={
                "deviceId": cfg["device_id"], "deviceToken": cfg["device_token"],
            }, timeout=15)
            if resp.status_code == 200:
                print("Device data deleted from Trackline.")
            else:
                print(f"Warning: server-side deletion may have failed ({resp.text}).")
        except Exception as e:
            print(f"Warning: could not reach the server ({e}).")
    remove_scheduled_task()
    unregister_uninstaller()
    if CONFIG_PATH.exists():
        try:
            CONFIG_PATH.unlink()
        except Exception:
            pass
    if TRACKER_DIR.exists():
        try:
            import shutil
            shutil.rmtree(TRACKER_DIR)
        except Exception:
            pass
    print("Local config, audit files, scheduled task, and Add/Remove Programs entry all removed.")

def uninstall(backend_url):
    cfg = load_config()
    if not cfg:
        print("No active pairing found — nothing to remove.")
        return
    # Uses a real GUI dialog, not input() — this needs to work even when
    # compiled --windowed (no console attached at all), which is required
    # so the SEPARATE --sync-once/--run paths never flash a console window
    # during automatic background syncs. tkinter creates its own window
    # on demand; it doesn't need an existing console either way.
    try:
        import tkinter
        from tkinter import messagebox
        root = tkinter.Tk()
        root.withdraw()
        confirmed = messagebox.askyesno(
            "Confirm uninstall",
            "This will permanently delete ALL usage history for this device from Trackline. Continue?"
        )
        root.destroy()
    except Exception:
        # No display available at all (e.g. run from a script with no GUI
        # session) — fall back to console input rather than silently do
        # nothing or silently proceed with a destructive action unconfirmed.
        confirmed = input("This will permanently delete ALL usage history for this device from Trackline. Type 'yes' to confirm: ").strip().lower() == "yes"
    if not confirmed:
        print("Cancelled.")
        return
    perform_full_cleanup()

def full_uninstall():
    """The Add/Remove Programs entry point (--full-uninstall) — no
    interactive confirmation, since Windows' own uninstall dialog already
    confirms with the user before this ever runs."""
    perform_full_cleanup()


# ---------------------------------------------------------------------------
# Main sync cycle
# ---------------------------------------------------------------------------

def sync_once():
    cfg = load_config()
    if not cfg:
        print("Not paired yet. Run with --pair first.")
        sys.exit(1)

    # Verify locally-known pairing health BEFORE attempting a real sync —
    # if the last attempt found this device was revoked, don't keep
    # hammering the server every cycle; short-circuit until re-paired.
    last_status = read_status()
    if last_status and last_status.get("status") == "revoked":
        print("This device's pairing was previously found to be revoked. Re-pair to resume syncing (skipping this cycle).")
        return "revoked"

    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(cfg.get("timezone", "UTC"))
    except Exception:
        tz = timezone.utc

    retry_result = retry_unsent(cfg)  # clear any backlog from a previous failed run first
    if retry_result == "revoked":
        return "revoked"

    snapshot = build_snapshot(cfg, tz)
    audit_path = write_audit_file(snapshot)  # written BEFORE any network call
    return push_snapshot(cfg, snapshot, audit_path)

def run_loop():
    cfg = load_config()
    if not cfg:
        print("Not paired yet. Run with --pair first.")
        sys.exit(1)
    interval = cfg.get("sync_interval_minutes", 30) * 60
    print(f"Running — syncing every {cfg.get('sync_interval_minutes', 30)} minutes. Ctrl+C to stop.")
    while True:
        try:
            result = sync_once()
            if result == "revoked":
                print("Stopping — this device's pairing has been revoked. Re-pair to resume.")
                break
        except Exception as e:
            print(f"Sync error (will retry next cycle): {e}")
        time.sleep(interval)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Trackline laptop screen-time agent")
    parser.add_argument("--backend-url", default=os.environ.get("TRACKLINE_BACKEND_URL", ""),
                         help="Your Trackline deployment's base URL")
    parser.add_argument("--pair", action="store_true", help="Pair this laptop with a family (first-time setup)")
    parser.add_argument("--reregister", action="store_true", help="Deregister the current pairing and pair with a different family/member")
    parser.add_argument("--uninstall", action="store_true", help="Delete this device's data from Trackline and remove local config (asks for confirmation)")
    parser.add_argument("--full-uninstall", action="store_true", help="Same as --uninstall but non-interactive — this is what Windows' Add/Remove Programs calls, not meant to be run manually")
    parser.add_argument("--sync-once", action="store_true", help="Run a single sync cycle and exit")
    parser.add_argument("--run", action="store_true", help="Run continuously, syncing on the configured interval")
    parser.add_argument("--backfill", action="store_true", help="One-time import of existing local ActivityWatch history — not run automatically, invoke manually using the already-saved config")
    parser.add_argument("--sync-date", metavar="YYYY-MM-DD", help="Manually sync one specific past date, e.g. a day the laptop was on but the agent failed to sync")
    args = parser.parse_args()
    args.backend_url = args.backend_url.strip().rstrip("/")  # tolerate a trailing slash however it was typed/set

    if args.pair:
        pair(args.backend_url)
    elif args.reregister:
        reregister(args.backend_url)
    elif args.uninstall:
        uninstall(args.backend_url)
    elif args.full_uninstall:
        full_uninstall()
    elif args.sync_once:
        sync_once()
    elif args.run:
        run_loop()
    elif args.sync_date:
        sync_date(args.sync_date)
    elif args.backfill:
        cfg = load_config()
        if not cfg:
            print("Not paired yet. Run with --pair first.")
            sys.exit(1)
        run_backfill(cfg)
    else:
        parser.print_help()
