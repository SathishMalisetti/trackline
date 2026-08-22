# Building TracklineAgentSetup.exe — the one file you distribute

## What you're building

One installer (`TracklineAgentSetup.exe`) that does everything for the
end user: download, run, click through a standard wizard, Config Manager
opens automatically at the end. No zip extraction, no picking between
three exes, no manual folder placement.

**This build process happens once, on your machine, per version.** The
end user (other parent, kid's laptop) never sees any of these steps.

---

## Step 1 — Build the three exes with PyInstaller

Run these from the `laptop-agent/` folder, in order:

```bash
pip install pyinstaller requests tzlocal

pyinstaller --onedir --windowed --name TracklineSetup trackline_setup_gui.py

pyinstaller --onedir --windowed --name TracklineAgent trackline_agent.py

pyinstaller --onedir --windowed --icon=trackline_icon.ico --name TracklineConfigManager trackline_config_manager.py
```

**Two things that matter here, both already caught and fixed in earlier
rounds — worth double-checking, not just trusting the copy-paste:**

- `TracklineAgent` must be `--windowed`, **not** `--console`. A console
  build here reintroduces the exact bug where every automatic sync
  flashes a console window and interrupts whatever's running.
- Only `TracklineConfigManager` gets `--icon=trackline_icon.ico` — Setup
  and Agent stay unbranded, per what was asked.

This produces three folders in `dist/`:
```
dist/TracklineSetup/           (TracklineSetup.exe + _internal/)
dist/TracklineAgent/           (TracklineAgent.exe + _internal/)
dist/TracklineConfigManager/   (TracklineConfigManager.exe + _internal/)
```

## Step 2 — Gather everything in one place

Copy these four items into the **same folder** as `TracklineAgentSetup.iss`:

```
TracklineAgentSetup.iss
trackline_icon.ico
TracklineSetup/            (copied from dist/)
TracklineAgent/             (copied from dist/)
TracklineConfigManager/     (copied from dist/)
```

**The three folder names must be exactly this** — not renamed, not
nested differently. Config Manager's and Setup's own exe-discovery logic
specifically looks for sibling folders with these exact names (already
built and tested against this pattern); renaming them here would silently
break "Pair this device" and "Sync Now" after install, even though the
installer itself would compile and run fine.

## Step 3 — Install Inno Setup (one-time, free)

Download from https://jrsoftware.org/isinfo.php — a few minutes,
standard installer, no special configuration needed.

## Step 4 — Compile

Open `TracklineAgentSetup.iss` in the Inno Setup Compiler (double-click
it, or File → Open from within Inno Setup), then press **F9** (or
Build → Compile).

Output: `installer_output/TracklineAgentSetup.exe` — this is the one
file to upload to GitHub / distribute. Everything else in this folder
(the three source exe folders, the .iss script) stays on your machine.

---

## What the end user actually experiences

1. Download `TracklineAgentSetup.exe`
2. Run it — Windows will show a UAC prompt (admin approval), since
   installing to `C:\trackline` requires it
3. Standard wizard: Next → Next → optional "Create a desktop icon"
   checkbox → Install → Finish
4. Config Manager opens automatically, showing "Pair this device" since
   nothing's paired yet
5. From then on: desktop icon (if they checked that box) or Start Menu →
   Trackline Config Manager. That's the only thing they ever need to
   find again.

**One thing worth knowing, not hiding**: the UAC prompt in step 2 is a
direct consequence of installing to `C:\trackline` specifically — this
is the same admin-rights tradeoff discussed earlier when Program Files
was ruled out for the same reason, now applying here since `C:\trackline`
was chosen explicitly over the no-admin-needed AppData alternative. If
whoever's running the installer doesn't have admin rights on that
laptop, this will fail at that step.

---

## Honest limitation

I wrote `TracklineAgentSetup.iss` carefully against Inno Setup's
documented, standard syntax, but **I cannot compile or run Inno Setup
myself** — it's Windows-only tooling with nothing equivalent available
in my environment, the same limitation as the Android build and the
PyInstaller exes themselves. This needs a real compile-and-test pass on
your end before it's trustworthy — specifically worth confirming: the
installer actually produces a working exe, the desktop icon checkbox
behaves as expected, Config Manager actually launches automatically at
the end, and "Pair this device" / "Sync Now" still correctly find their
sibling exes after a real install (not just a manually-arranged folder).
