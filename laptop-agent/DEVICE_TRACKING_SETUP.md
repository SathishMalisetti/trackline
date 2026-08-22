# Trackline — Device Screen-Time Tracking (v9)

## v27: Report drill-through added — day → top programs

New: clicking any non-empty day in the "Last 7 days" bar chart on a kid's
Screen Time card drills into that specific day — top 5 programs by time,
with category, and a "show all" expansion if there are more. Built and
tested using data modeled directly on real production data from Supabase
(confirmed the pipeline: Fortnite correctly showing as "Games", chrome.exe
correctly aggregating across many separate title-level rows into one
total).

New read-only endpoint: `api/device-usage-detail` — given a member+date,
aggregates every hour and every distinct title for that day down to one
total-time figure per app, sorted descending. Deliberately filters out
anything that rounds to 0 minutes (sub-minute noise from many small
title-switch events) so the list stays meaningful rather than cluttered.

No schema changes needed — reads the same `usage` table everything else
already uses.

## ⚠ v26 status: trackline_setup_gui.py rolled back directly to v20

Per explicit request, after v25's precise merge (v20 + 2 minimal
additions) still didn't complete registration — `trackline_setup_gui.py`
in this package is **byte-for-byte identical to v20's**, confirmed via
diff. No additions, no fixes layered on top.

**What this means practically:**
- The confirmed-working v20 pairing flow is back.
- **The duplicate-registration bug is also back** — re-running setup on
  an already-paired device will again create a new device row without
  removing the old one. Avoid re-running setup on an already-paired
  device until this is revisited; if you do need to re-pair, manually
  remove the old entry afterward via Settings → "Manage registered
  devices."
- **`agent_exe_path` won't be saved to config.json** — Config Manager's
  "Sync Now" and sync-interval-change features will show "Could not find
  the Trackline agent" until this is revisited, since nothing populates
  that field anymore. The scheduled task itself is unaffected (set up
  independently during pairing) — only Config Manager's two convenience
  features are affected.

Everything else in this package (Config Manager, the agent's title/
category/AFK-drop work, backend endpoints, retention) is unchanged from
v25 and unaffected by this rollback — it's scoped to
`trackline_setup_gui.py` only.

Built and tested this round (46 total passing checks across execution —
not just written and assumed correct): pairing, ingestion, deregistration,
device listing, and the laptop agent's core hour-splitting/AFK-intersection
logic, plus a byte-for-byte cross-language hash verification between the
agent's Python and Trackline's JS so password auth actually works.

## What changed from the previous round

The simpler `device_usage` table (memberId/deviceName/category/totalMinutes)
from last time is **replaced** by the richer `usage` table from the shared
design doc (hour-bucketed, per-app/per-site, matching real ActivityWatch
data). The `device-usage` GET endpoint was rewritten to aggregate the new
table down to the exact same shape the Screen Time UI already expects — so
**the frontend needs zero changes**, only the backend.

## Deploying the backend

1. Run `supabase-backend/schema-v7-device-tracking.sql` — drops the old
   `device_usage` table, creates `devices` and `usage`.
2. Add all four new `api/device-*` folders plus the **updated**
   `api/device-usage/index.js` (replace the version from the previous
   round — same folder, new content).
3. Push. No new environment variables — reuses `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY`, same as everything else.

## The security model, concretely

The laptop **never** gets `SUPABASE_SERVICE_ROLE_KEY`. It gets a
**narrow device token**, generated at pairing time, that can only ever:
insert usage rows for the one family+member it was paired to. Verified by
execution: a stolen/wrong token can't write, can't read anything, can't
touch a different family's or a different kid's data — even with two
devices actively paired and syncing at the same time.

**The honest limit, stated plainly (from our design discussion)**: none of
this stops the kid themself from tampering, since they have physical
access to the exact device doing the reporting. No token design fixes
that — it's the same limitation every parental-monitoring product has.
What we can do: make gaps visible rather than pretending they can't
happen. **Not built yet** — worth prioritizing next: the Screen Time UI
should show "No data since Aug 10, 3pm" for a stale device, not silently
show a flat 0h that day. Small addition, meaningfully more honest.

## Setting up a device — the simple way (GUI, no terminal)

**One new backend endpoint needed:** `api/family-members` — password-gated,
returns just `{id, name, role}` per member (verified: no PIN hashes or
anything sensitive ever leak through it). This is what powers the "pick
your kid from a dropdown" step instead of a parent hunting for a raw
member ID.

### New this round — Study vs Game time (not titles)

Goal clarified: study-vs-game visibility, not full content capture. Built
using **app/domain name only — never titles**, keeping the original
privacy commitment fully intact (verified by test that `build_snapshot()`
still never calls `data.get("title")` anywhere).

- `DEFAULT_CATEGORY_MAP` in `trackline_agent.py` — sensible starting
  defaults (Roblox/Minecraft/Fortnite → Games; Word/Excel/VS Code →
  Study). Anything unrecognized reports honestly as "Uncategorized" rather
  than being guessed at.
- **Customizable per family** — add `"category_map": {"discord.exe": "Study"}`
  (or whatever fits how your family actually uses things) to `config.json`;
  it merges with, and can override, the defaults.
- **Schema migration required** — since your `usage` table already exists
  live, re-run `schema-v7-device-tracking.sql`; the new
  `alter table usage add column if not exists category text` line applies
  even though `create table if not exists` alone would silently do nothing
  on an existing table.
- Trackline's Screen Time tab now shows a **"Today's activity"** breakdown
  (Study/Games/Uncategorized with percentages) on each kid's card.
- **You'll need to re-sync** after updating — historical rows already in
  Supabase won't retroactively get a category; only syncs from the updated
  agent going forward will populate it. Older/uncategorized rows still
  show correctly under "Uncategorized," nothing breaks, they just won't
  be split out until re-synced.

### Fixed this round — pairing appearing to silently stop partway through

**Reported**: "Finish registration" not completing, no success message, no
Add/Remove Programs entry — but Config Manager *did* show a device name.

That last detail was the key clue: `write_config()` runs early in the
flow, right after pairing itself succeeds — so its presence means pairing
genuinely worked, but something *after* that point never finished.

**Most likely cause**: the flow that runs when the agent can't be
auto-located has 2-3 sequential modal dialogs (a yes/no confirmation, a
file picker, a final success message). Any one of those can end up
hidden behind another window — plausibly Config Manager, if it was open
at the same time — silently pausing the whole wizard on a question nobody
saw, rather than crashing or erroring visibly.

**Fixed two ways**: removed one full dialog step entirely (skipped the
yes/no confirmation — go straight to the file picker, since cancelling it
already gives the same "skip automatic syncing" outcome); and forced the
window to the front (`lift()` + temporary `-topmost`) before showing any
remaining dialog in this chain, so it can't get lost behind another
window.

**Honest limitation**: I can verify the logic and the dialog *count* is
now lower, and confirmed no regressions to any of the underlying testable
functions — but I can't run a real Tk window in this environment to
confirm the focus-forcing behavior itself. Worth specifically re-testing
this exact scenario (Config Manager open at the same time as Setup) to
confirm it's actually resolved.

### Fixed this round — CRITICAL: duplicate device registrations

**What happened**: 10+ duplicate device entries under the same name,
confirmed as a real bug, not something you did wrong.

**Root cause**: `reregister()` in the CLI agent correctly deregisters an
existing pairing before creating a new one — but the GUI's "Finish
registration" had no equivalent check at all. It created a brand new
server-side device row *every single time it ran*, regardless of whether
this device was already paired. Re-running the setup wizard for any
reason (including the new "Pair this device" button from last round) on
an already-paired device silently orphaned the previous registration
instead of replacing it. Repeated runs compound directly into exactly
what you saw.

**Fixed**: extracted a new `pair_device_with_cleanup()` — checks for an
existing local pairing first, deregisters it, *then* creates the new one.
Mirrors what the CLI already did correctly. Also added a defensive guard
(the Finish button disables itself the instant it's clicked) so a rapid
double-click can't fire two pairing attempts before the first one even
completes, regardless of whatever the original trigger was.

Verified by test with the exact repeated-pairing scenario: three
consecutive pairing attempts on the same device now produce two
deregister calls (each attempt cleaning up the one before it) rather than
zero — confirming that without this fix, three duplicate rows really
would have piled up, and with it, they don't.

**You'll need to manually clean up the existing duplicates** — this fix
prevents new ones, it doesn't retroactively remove what's already there.
Settings → "Manage registered devices" in Trackline lets a parent remove
each one (enter the family password once, then Remove on each duplicate).

### Added this round — "Pair this device" from Config Manager

When Config Manager detects the device isn't paired, it now shows a
**"Pair this device"** button instead of just a text instruction — clicking
it finds and launches `TracklineSetup.exe` directly (same discovery logic
as the agent-path lookup: checks the same folder first, then the
sibling-onedir-folder layout, falling back to a file picker rather than
guessing wrong). Opens non-blocking, so the Config Manager stays open —
finish pairing in the setup window, then hit Refresh here to see it.

The "combine into one exe / auto-install to Program Files" idea is
deliberately still not built — confirmed we're skipping the admin-rights
requirement that comes with Program Files specifically, and this smaller,
well-scoped addition covers the actual immediate need instead.

### Added this round — sync interval control + Sync Now, in Config Manager

Two real additions, one real gap closed underneath:

- **Sync interval, editable** — changing `sync_interval_minutes` in
  `config.json` alone wouldn't have done anything, since Windows'
  Scheduled Task has the interval baked in at creation time and never
  reads config.json. `set_sync_interval()` updates both — config for
  display/consistency, and a real `schtasks /change` for the task itself.
  Verified by test: the actual command built targets the right task name
  and uses `/change` (not delete+recreate, so nothing else about the task
  gets disturbed).
- **Sync Now button** — triggers an immediate sync via the agent's
  `--sync-once`. This needed the agent's actual path to be known reliably,
  which surfaced a gap: nothing was saving it anywhere. Fixed by having
  the setup wizard save `agent_exe_path` into `config.json` once, at
  pairing time (both GUI and CLI paths) — every future tool that needs to
  invoke the agent now just reads it, no more fragile folder-guessing.
- Both fail cleanly and specifically when something's missing (not paired,
  agent path not recorded, recorded path doesn't actually exist) rather
  than a generic error or a silent no-op.

**One thing intentionally not done this round**: combining all three
tools (Setup, Agent, Config Manager) into a single self-installing exe
that installs itself and sets everything up automatically. That's a
substantially different architecture — worth its own dedicated round
rather than a rushed version bolted onto this one. Flagged for next time.

### Fixed this round — the registry entry that survived uninstall

Real bug, found via your actual testing: `--uninstall` (the interactive
CLI path) and `--full-uninstall` (Add/Remove Programs) were two
separately-written functions, and only `--full-uninstall` actually cleaned
up the scheduled task and registry entry — `--uninstall` silently left
both behind. Consolidated onto one shared `perform_full_cleanup()` used by
both, so there's only one cleanup sequence to get right. Verified by test
that the interactive path now removes everything the non-interactive path
already did, with no change to either path's actual behavior otherwise
(the confirmation prompt still works, declining still cancels cleanly).

### Added this round — sync verification before every cycle

"Verify before running again" — now checks a small local `status.json`
before attempting a sync at all. If the last attempt found this device's
pairing revoked (deleted by a parent, or via Remove in Settings), it skips
straight past — no wasted network call, no pointless retry. `--run` mode
now actually **stops** on revocation rather than retrying forever every 30
minutes. A fresh re-pairing clears the stale status automatically.
Verified by test across the whole chain: revoked vs. ordinary-failure are
correctly distinguished (not conflated), the local short-circuit genuinely
skips the network call, and the continuous loop genuinely terminates
rather than hanging.

### Added this round — Config Manager app + real device names stored

New: `trackline_config_manager.py` — a small, **read-only** status viewer.
Shows who a paired device belongs to (by name, not raw ID), its label,
family ID, sync interval, and sync health (last attempt + last confirmed
successful sync, cross-checked against two independent local sources).

This needed a real fix underneath: `config.json` was never actually
storing the member's name or the device label at all — `label` was being
sent to the pairing endpoint and then silently discarded, never saved
locally. Fixed in both the GUI (already had the name from its dropdown)
and the CLI (`--pair` now looks up real member names via the existing
`family-members` endpoint and lets you pick from a numbered list, falling
back to manual ID entry if the lookup fails for any reason).

**Build it the same way as the other two:**
```bash
pyinstaller --onefile --windowed --name TracklineConfigManager trackline_config_manager.py
```

### Corrected this round — backfill was overbuilt, replaced with real retention

The 30-day backfill from last round was a misunderstanding — removed the
automatic trigger from both `--pair` and the GUI (the underlying
`--backfill` command still exists if anyone wants to invoke it manually
later, but it's no longer part of default setup). What you actually
described: ongoing forward syncs (unchanged, already correct) plus **real
server-side retention**.

**15-day retention, now actually built**: `device-usage-ingest` deletes
this device's own rows older than 15 days on every sync — self-cleaning,
piggybacked on the sync that's already happening every 30 minutes, no
separate scheduled function needed. Verified by test: old data (this
device) gets deleted, recent data (this device) survives, and — the
important isolation check — another device's old data is completely
untouched even though it's equally old.

### Added this round — the big one: missing-day backfill, short-app rollup, and a real installer

Confirmed and built the whole plan from this round's design discussion:

1. **`--sync-date YYYY-MM-DD`** — manually recover one specific missing
   day, reusing the exact same aggregation logic as today's sync. Config
   Manager gets a date field + "Sync this date" button.
2. **Short-app rollup** — apps under a threshold (default 10 min,
   evaluated per hour, **0 disables it**) get pooled into one bucket
   rather than sent as individual rows. Permanent, changes what's stored,
   not just displayed — confirmed decision. Bucket categorized
   Uncategorized. Threshold is per-device, adjustable in Config Manager.
3. **Sync history log** — `write_status()` now also appends to a capped
   20-entry history file, displayed as a scrollable list in Config
   Manager's Status tab.
4. **Password-gated changes** — viewing status stays open to anyone;
   changing the interval, threshold, disconnecting, or syncing a missing
   date all require the real family password, verified against the
   actual backend (same endpoint pairing uses, not a separate check to
   keep in sync).
5. **Disconnect device**, from Config Manager — reuses `--full-uninstall`
   exactly as Add/Remove Programs does.
6. **Diagnostics button** — checks ActivityWatch reachability, backend
   reachability, and whether the scheduled task's actual settings still
   include WakeToRun (would have caught that regression proactively).
7. **Window fix** — resizable, centered on screen, sensible min size.
8. **A real TL icon** — generated and verified as a genuinely valid
   multi-resolution `.ico` (not just described how to make one), applied
   to Config Manager only.
9. **A real installer** — `TracklineAgentSetup.iss` (Inno Setup script,
   see `INSTALLER_BUILD_GUIDE.md`). Produces one `TracklineAgentSetup.exe`
   that installs to `C:\trackline`, creates an optional desktop icon, and
   launches Config Manager automatically at the end — the end user never
   manually extracts anything or picks between exes again.

**Testing**: 86 checks across 10 test files this round, all passing,
covering every new function in isolation and integrated into the real
pipeline. The GUI wiring itself and the Inno Setup script are the two
pieces that couldn't be executed and verified the way everything else
was — no display available for tkinter, no Inno Setup compiler available
at all. Both written carefully against documented, standard patterns;
both need a real pass on your end before trusting them.

### CRITICAL — rebuild TracklineAgent.exe with a different flag

**Reported**: every automatic sync briefly pops up a console window,
interrupting whatever the kid is doing (a game, specifically) badly
enough that they cancel it before it completes.

**Root cause**: `TracklineAgent.exe` was built with `--console` (done
intentionally early on, to see debug output when running manually from a
terminal) — but that means *every* invocation, including the automatic
scheduled sync every 30 minutes, briefly flashes a real console window.

**Fixed in code**: the one place that actually needed a console —
`--uninstall`'s "type yes to confirm" prompt — now uses a real GUI dialog
(`tkinter.messagebox`) instead of `input()`, with a console fallback if no
display is available at all. Verified for real, not mocked: this sandbox
genuinely has no display, so the fallback path was actually exercised,
not simulated.

**You need to rebuild, not just redeploy**: swap `--console` for
`--windowed` when building this one specific exe:

```bash
pyinstaller --onedir --windowed --name TracklineAgent trackline_agent.py
```

(TracklineSetup and TracklineConfigManager were already `--windowed` —
only TracklineAgent needed this.)

**Known accepted tradeoff**: `--pair` and `--reregister` (the CLI pairing
commands) still use `input()`/`getpass` in several places and will not
work correctly from a `--windowed` build — there's no console for them to
read from. This is fine in practice since `TracklineSetup.exe` (already
GUI-based) is the intended way to pair a device; the CLI pairing path was
always a secondary/advanced option. `--full-uninstall` (used by Add/Remove
Programs) was already fully non-interactive and is unaffected.

### Fixed this round — scheduled task not firing automatically

**Reported**: Task Scheduler shows a valid "Next Run" time, manually
clicking "Run" works correctly, but automatic triggers don't push data.

**Root cause**: Windows does not wake a sleeping laptop to run a due
scheduled task by default — the trigger is silently skipped, and "Next
Run" still shows a perfectly valid future time, since the *schedule*
itself is fine, only the *execution* was missed. `schtasks.exe`'s simple
`/create` flag syntax has no way to enable wake-to-run at all — it
requires a full XML task definition.

**Fixed**: replaced the flag-based `schtasks /create` with a proper XML
task definition, setting `WakeToRun=true` (the actual fix), plus disabling
the battery-power restrictions that have the same "silently skipped, still
shows a valid next-run" failure mode on an unplugged laptop, and enabling
`StartWhenAvailable` so a fully-missed run (laptop was off, not just
asleep) executes as soon as the laptop's next available rather than being
dropped until the next scheduled slot.

Verified by test: every setting present and correct in the generated XML,
confirmed the already-fixed `/rl highest` privilege issue from an earlier
round hasn't regressed, confirmed the executable path and `--sync-once`
argument are correctly embedded, and confirmed a path containing special
XML characters (`&`) gets safely escaped rather than injected raw.

### Fixed this round — the exact folder structure you reported

`find_agent_exe()` only checked "same folder as the setup wizard" — but
your real structure has them as sibling folders
(`TracklineDeviceSetup\TracklineAgent\` next to
`TracklineDeviceSetup\TracklineSetup\`), which is exactly what PyInstaller
`--onedir` produces when both are built into the same parent output
folder. Fixed to check both patterns; verified against your literal
reported folder structure, not just a similar one.

### Added this round — Add/Remove Programs entry + real uninstall

After successful pairing, Trackline now registers itself in Windows'
Add/Remove Programs (Apps & Features) list, using `HKEY_CURRENT_USER` so
no admin elevation is required. Uninstalling from there runs
`TracklineAgent.exe --full-uninstall` — deliberately non-interactive
(distinct from the standalone `--uninstall` command, which still asks for
a typed confirmation, since Windows' own uninstall dialog already confirms
before ever calling this). It deregisters the device (deletes all its
usage data server-side), removes the scheduled task, removes the
Add/Remove Programs entry itself, and deletes local config/audit files —
every step best-effort, so one failure doesn't block the others. Verified
by test: correct device credentials sent to deregistration, every cleanup
step actually invoked, local files genuinely removed, and running it twice
(nothing left to uninstall) doesn't crash.

### Redesigned last round — dropped AFK, added titles, added monthly backfill

Real-world testing across multiple machines found AFK detection
unreliable enough to produce wrong numbers, not just imprecise ones —
matches a known, recurring ActivityWatch community issue, not something
specific to your setup. Three real changes, all tested against your
actual uploaded sample data:

1. **AFK dependency dropped entirely.** "Active seconds" is now raw
   window-focus time from the window bucket alone. Simpler, and matches
   what's actually reliable in your data.
2. **Titles now captured**, not just app names — a genuine scope change
   from the original "never touch it" privacy design, now intentional.
   **Exclusion now applies to titles too**: `excluded_title_keywords` in
   `config.json` (e.g. `["bank", "password"]`) drops any event whose title
   contains a match, case-insensitive — even if the app itself isn't
   excluded.
3. **One-time 30-day history import**, automatic right after pairing
   (both CLI `--pair` and the GUI) — imports existing local ActivityWatch
   history using the same `/buckets/{id}/events` endpoint, just a wider
   date range. Runs once only, not re-run on later syncs, per your
   confirmation. Days with no data (e.g. before ActivityWatch was
   installed) are skipped rather than pushing empty snapshots.

**Schema migration required** (adds `title` column, widens the
uniqueness key to `(device_id, date, hour, source, name, title)` since
the same app can have many distinct titles within one hour) — re-run
`schema-v7-device-tracking.sql`.

**A real bug caught and fixed before it shipped**: my first pass stored
`title: null` for site rows (sites don't have titles). Postgres treats
every `NULL` as distinct from every other `NULL` in a unique constraint —
meaning upserting would have silently broken for every site row, inserting
duplicates instead of updating. Fixed by using `''` instead of `null`
throughout, and hardened at the schema level (`not null default ''`) so
this can't be silently reintroduced by different code later. Verified by
test that re-syncing the same site now correctly updates in place.

### Fixed this round

- **Zero-second "noise" entries** — confirmed against real uploaded data
  from a live sync (`LockApp.exe` appearing twice with `active_seconds: 0`).
  Caused by sub-second window-focus flickers (e.g. the lock screen briefly
  gaining focus) that round down to zero but still got included in the
  output. Fixed by dropping any app/site entry that rounds to zero before
  it's ever written — verified by test using data modeled directly on the
  real scenario (a 0.3-second flicker alongside a legitimate 31-second
  entry — confirmed only the real one survives).

- **"Not paired yet" immediately after successful pairing** — the deepest
  bug in this whole chain. `TracklineSetup` and `TracklineAgent` are two
  *separate* compiled programs, and `--onedir` builds put each in its own
  folder by default. The previous fix (`sys.executable`'s folder) solved
  the earlier temp-folder problem but didn't solve this one — the setup
  wizard and the agent were each resolving `config.json` to a *different*
  folder, so pairing would succeed and write a config the agent could
  never find. Fixed properly this time: both tools now share one fixed,
  OS-standard location (`%LOCALAPPDATA%\TracklineAgent\`) regardless of
  where either exe actually lives. Verified by test using paths modeled
  directly on the reported bug — two exes in genuinely different folders,
  confirmed both now resolve to the identical shared location, and a
  config written by one is actually found by the other.
- As a consequence, the installer's "find the agent to schedule it"
  logic also needed fixing (it can no longer assume the agent sits in a
  predictable spot relative to itself) — it now checks the one folder its
  own exe lives in first (covers the common case), and falls back to a
  file-picker dialog rather than silently failing or guessing wrong.

- **"Could not set up automatic syncing: ERROR: Access is denied"** — the
  scheduled-task command was requesting `/rl highest` (run with highest
  privileges), which requires the process *creating* the task to already
  be running as Administrator — something a normally double-clicked
  installer never is. The agent doesn't actually need elevated privileges
  for anything it does (querying ActivityWatch's local API, sending a
  normal HTTPS POST), so the flag was pure unnecessary caution on my part
  that silently broke setup for every non-admin parent. Removed entirely
  — verified by test that the command no longer requests elevation at all.

- **`_MEI` temp-folder "Bad Image" error persisted even with `--onedir`**
  — `_MEI` in the error path is specifically the signature of `--onefile`
  mode; `--onedir` never self-extracts to a temp folder at all. This means
  stale cached build artifacts (an old `build/` or `dist/` folder, or a
  `.spec` file left over from an earlier `--onefile` run) can cause
  PyInstaller not to fully honor a changed flag on the next build. Fix:
  delete `build/`, `dist/`, and any `.spec` files before rebuilding — see
  the exact commands below.
- **Where to actually put `TracklineSetup.exe` and `TracklineAgent.exe`**
  — this needed a real code fix, not just an instruction. Both are
  separately built `--onedir` apps, and each produces its own `_internal`
  folder alongside its `.exe`. Putting both flat in the same folder would
  make those two same-named `_internal` folders collide. Fixed by having
  the installer look for the agent in a **sibling folder** instead
  (`TracklineAgent/` sitting next to `TracklineSetup/`, both under one
  shared parent) — verified against a real on-disk folder structure, both
  when the agent is found correctly and when it's missing (confirms a
  clear message rather than a crash).

### Build and placement — current, correct instructions

```bash
pyinstaller --onedir --windowed --name TracklineSetup trackline_setup_gui.py
pyinstaller --onedir --console --name TracklineAgent trackline_agent.py
```

This produces two folders under `dist/`. Copy **both complete folders** —
`_internal` subfolder and all — as **siblings** under one shared parent
folder on the kid's laptop:

```
TracklineDeviceSetup/          <- copy this whole folder over
  TracklineSetup/
    TracklineSetup.exe
    _internal/  (leave this alone — don't move the .exe out on its own)
  TracklineAgent/
    TracklineAgent.exe
    _internal/
```

Run `TracklineSetup.exe` from inside its own folder, exactly where it is —
it'll automatically find `TracklineAgent.exe` in the sibling folder when
setting up the scheduled task.

- **Dropdown populates but "Finish registration" never appears / status
  text stuck on "Looking up family..."** — a real Tkinter bug: the code
  tried to position the device-label field using `before=finish_button`,
  but `finish_button` had never actually been packed yet, so Tkinter threw
  an error inside the button's click handler. Everything after that line
  (enabling Finish, updating the status text) silently never ran — while
  everything *before* it (populating the dropdown) worked fine, which is
  exactly the stuck state from the bug report. Fixed by keeping both
  widgets in their correct position from creation and just toggling
  `state` between disabled/normal, instead of hiding and re-packing them.
  Verified three ways: reproduced the exact original crash under a real
  (virtual) display, confirmed the fixed pattern doesn't crash, and then
  drove the actual shipped file end-to-end — real typing, real button
  click, real widget tree — reproducing your exact "k1 (kid)" dropdown
  value and confirming Finish correctly becomes clickable.

- **"Bad Image" error on `TracklineSetup.exe`** — a `--onefile` PyInstaller
  build self-extracts to a Temp folder on every launch, and antivirus
  software frequently interferes with that extraction, corrupting the
  bundled Python DLL. Switch to `--onedir` instead (see the build command
  below) — this sidesteps the whole problem, at the cost of shipping a
  folder instead of a single file.
- **"Could not reach the server: Expecting value: line 1 column 1 (char 0)"**
  — entering the backend URL *with* a trailing slash (e.g.
  `https://your-app.azurestaticapps.net/`) produced a double slash when
  concatenated with `/api/family-members`, which the server doesn't route
  correctly, returning an empty response the JSON parser then chokes on.
  Fixed by normalizing the URL (stripping trailing slashes) once, right
  when it's first used — verified by test using the exact URL from the
  bug report, both with and without a trailing slash, confirming identical
  correct behavior either way. This also fixes the same latent bug in the
  command-line agent's three network calls, all of which build their URLs
  the same way.

### Do end users need Python installed? — No, if you build both pieces

**Short answer: no** — but only if you compile *both* the setup wizard
*and* the agent, which the original instructions here didn't make clear
(worth being upfront: I caught this gap myself on review, not something
that was flagged for me). The setup wizard alone being compiled isn't
enough — the *ongoing* background sync (the part that actually matters,
running every 30 minutes) still invokes `trackline_agent.py`, which needs
a real Python interpreter unless it's *also* compiled.

There's a subtler trap here too, now fixed: the installer used to build
its Task Scheduler command from `sys.executable` — reasonable for a raw
`.py` script, but when the *setup wizard itself* is compiled with
PyInstaller, `sys.executable` inside that frozen process points at the
wizard's own `.exe`, not a real Python interpreter — so the scheduled
task would have silently tried to run
`TracklineSetup.exe trackline_agent.py --sync-once` and failed, since a
frozen app can't interpret a `.py` file passed as an argument. Fixed by
pointing Task Scheduler directly at a compiled agent `.exe` instead —
verified by test that the resulting command never references any Python
interpreter path at all, only the compiled executable.

**Build both, on a Windows machine:**

```bash
pip install pyinstaller requests tzlocal
```

See "Build and placement — current, correct instructions" above for the
exact commands and folder layout.

**Honest limitation, unchanged**: I can write and fully test this Python
logic, but I can't compile actual Windows `.exe` files in this
environment — no Windows machine here. Both `pyinstaller` commands above
are exact, you'd just run them yourself once.

### Where local files actually live

`config.json` (pairing credentials) and the `tracker/` audit-trail folder
live at **`%LOCALAPPDATA%\TracklineAgent\`** — a single fixed location,
the same for both `TracklineSetup.exe` and `TracklineAgent.exe`,
regardless of where either one is actually installed. e.g.
`%LOCALAPPDATA%\TracklineAgent\tracker\2026\08\15\0930.json` per sync,
moved to that same folder's `tracker\sent\` once successfully pushed.

This took two rounds to get right, worth being upfront about: the first
fix moved away from `Path(__file__).parent` (which breaks under
PyInstaller's `--onefile` temp-extraction folder) to `sys.executable`'s
own folder — correct for a single exe, but `TracklineSetup` and
`TracklineAgent` are two separate compiled programs, and `--onedir` builds
put each in its own folder by default. That meant the wizard and the
agent were each writing/reading `config.json` from a *different* place —
exactly the "Not paired yet immediately after successful pairing" bug.
Fixed by using a shared, fixed, OS-standard location instead of anything
exe-relative — verified by test using paths modeled on the actual report.

### What the parent actually does now

1. Copy the whole `TracklineDeviceSetup` parent folder (containing both
   the `TracklineSetup` and `TracklineAgent` sibling folders, complete
   with their `_internal` folders — see the layout above) to the kid's
   laptop.
2. Double-click `TracklineSetup.exe`.
3. Enter the Trackline backend URL, Family ID, and family password.
4. Click **"Look up family"** — a dropdown appears with real names
   ("Mia (kid)", "Leo (kid)", "Dad (parent)"), not raw IDs.
5. Pick the kid, optionally adjust the device label, click **"Finish
   registration."**

That's it. No `pip install`, no typing commands, no member ID lookup.

### What happens automatically after pairing

- Writes `config.json` next to the agent script — verified byte-for-byte
  compatible with what `trackline_agent.py`'s background sync already
  reads, so nothing else needs to change.
- **Sets up a Windows Scheduled Task automatically** (`schtasks`, built
  and tested), pointing directly at the compiled `TracklineAgent.exe`
  (never a Python interpreter path — see above) and running it every 30
  minutes — no NSSM, no manually wrapping it as a service, no keeping a
  terminal window open. Confirmed the exact command: creates (not
  queries/deletes), force-overwrites so re-running setup doesn't fail on
  an existing task, correctly uses `--sync-once` (letting Task Scheduler
  own the repetition), and — the specific thing that was broken and is now
  fixed — never references `python.exe` or any interpreter path at all.
- Timezone is **auto-detected** (via `tzlocal`, with a safe fallback) — no
  manual IANA timezone typing either.

### Re-registering / uninstalling

Re-registering to a different family, and fully deleting a device's data,
are still done via the command-line agent for now (`--reregister`,
`--uninstall` — see below) — folding those into the GUI too is a
reasonable next step if this workflow proves out, not built this round.

---

## The underlying command-line agent (what the GUI wraps)

Requirements: Python 3.9+, the `requests` library.

```bash
pip install requests
```

**First-time pairing** (run on the kid's laptop, needs the family password):
```bash
python trackline_agent.py --backend-url https://your-app.azurestaticapps.net --pair
```
Prompts for: Family ID, family password, the kid's member ID (a parent can
find this by asking — worth adding a "copy member ID" button to Settings
next round), a device label, and the local timezone.

**Re-registering to a different family** (e.g. the laptop changes hands):
```bash
python trackline_agent.py --backend-url <url> --reregister
```
Cleanly deregisters the old pairing (deleting its usage history) before
walking through pairing fresh.

**One-off sync** (useful for testing):
```bash
python trackline_agent.py --sync-once
```

**Run continuously** (syncs every 30 min by default, per the design doc):
```bash
python trackline_agent.py --run
```
For a real deployment, wrap this in a Windows Service (NSSM, per your
original plan) or a scheduled task so it survives reboots and doesn't need
a logged-in terminal window.

**Uninstall — deletes ALL of this device's data, not just stops tracking:**
```bash
python trackline_agent.py --backend-url <url> --uninstall
```
Asks for a typed "yes" confirmation first, since this is permanent. This
covers the "delete app, delete whole data" requirement from the device
side; the parent-facing equivalent (Settings → "Manage registered
devices" → Remove) covers the case where the laptop isn't available —
lost, broken, or the kid deleted the agent without running `--uninstall`
properly.

## What's still genuinely not built

- **Re-registration and uninstall in the GUI** — currently CLI-only (noted above)
- **The web watcher extension path** — the agent already reads a `sites`
  bucket if present (per-domain browser usage, collapsed to registered
  domain, never full URLs), but installing `aw-watcher-web` itself on the
  laptop is a manual step you'd do separately, per your open question in
  the design doc.
- **The 15-day backfill script** — the agent as built only syncs from
  local midnight forward each run; a one-time historical backfill (same
  hour-splitting logic, run once over a wider date range) is a small
  follow-up, not built this round.
- **macOS/Linux automatic scheduling** — the Task Scheduler setup is
  Windows-only; the installer shows a clear message on other platforms
  rather than failing silently, but cron/launchd setup isn't automated yet.
