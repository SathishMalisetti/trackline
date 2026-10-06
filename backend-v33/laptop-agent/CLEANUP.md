# Installer archives pending deletion

The active Windows installer workflow uses the Python sources and `TracklineAgentSetup.iss` in this directory. It builds fresh executable folders into a generated package before compiling the installer. The local-build script and instructions are introduced by PR #13.

These archived paths are prefixed with `tbd-` for review and eventual deletion. Nothing has been deleted or rebuilt in this cleanup.

| Old path | Archive path | Reason |
|---|---|---|
| `build/` | `tbd-build/` | Previously generated PyInstaller intermediate output |
| `TracklineAgent/` | `tbd-TracklineAgent/` | Stale packaged executable and dependencies |
| `TracklineSetup/` | `tbd-TracklineSetup/` | Stale packaged executable and dependencies |
| `TracklineConfigManager/` | `tbd-TracklineConfigManager/` | Stale packaged executable and dependencies |
| `installer_output/` | `tbd-installer_output/` | Previously compiled installer; not the Actions 1.1.0 artifact |
| `TracklineAgent.spec` | `tbd-TracklineAgent.spec` | Generated build specification; current workflow builds from `.py` |
| `TracklineSetup.spec` | `tbd-TracklineSetup.spec` | Generated build specification; current workflow builds from `.py` |
| `TracklineConfigManager.spec` | `tbd-TracklineConfigManager.spec` | Generated build specification; current workflow builds from `.py` |
| Repository root `laptop-agent/` | Repository root `tbd-laptop-agent/` | Older separate source/build copy, unused by the current installer workflow |

Executable folders are archived as complete units; internal filenames remain intact. Keep active `.py` files, `activitywatch_recovery.py`, `account_auth.py`, tests, `trackline_icon.ico`, `TracklineAgentSetup.iss` and installer workflows. Keep the local-build scripts/documentation when PR #13 is merged.

Do not compile `TracklineAgentSetup.iss` directly against these archives. Use the current build workflow or the local-build script from PR #13, which supplies fresh sibling executable folders in its generated package directory.
