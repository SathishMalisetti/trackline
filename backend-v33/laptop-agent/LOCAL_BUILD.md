# Build the installer on your Windows laptop

Install these prerequisites once:

- [Python 3.12 for Windows](https://www.python.org/downloads/windows/), including the Python launcher.
- [Inno Setup 6](https://jrsoftware.org/isdl.php).

Download and extract the **complete Trackline repository** using GitHub's **Code → Download ZIP**, or use your existing checkout with the latest changes. Do not copy only the build script.

Open `backend-v33/laptop-agent` and double-click **build-installer.cmd**. Alternatively, run this command from that folder:

```cmd
py -3.12 build_installer.py
```

The build installs dependencies in its own virtual environment, runs mocked recovery checks, builds all three windowless executables, then compiles the installer. Internet access is needed for dependencies. It stops if any step fails.

The resulting installer and agent-only update package are:

```text
backend-v33/laptop-agent/local-build/package/installer_output/TracklineAgentSetup.exe
backend-v33/laptop-agent/local-build/package/installer_output/TracklineAgentModule.zip
```

`SHA256.txt` is beside it. Build output is separate from the previously committed executables. The script does not install or run Trackline, change device pairing, query ActivityWatch, or upload data. Existing missing-day upload and family/device functionality are unchanged. ActivityWatch must still be installed separately on each target laptop.

If Inno Setup is installed in a custom location:

```cmd
py -3.12 build_installer.py --inno-compiler "D:\Tools\Inno Setup 6\ISCC.exe"
```

## Agent automatic updates

After a laptop-agent change is merged to `main`, GitHub Actions builds the installer and uploads `TracklineAgentModule.zip` to the latest GitHub release. Paired agents check that release after a scheduled sync, verify the asset SHA-256 reported by GitHub, and apply a newer module after the current sync process exits.

For each future agent release, increment `MyAppVersion` in `TracklineAgentSetup.iss`. The workflow reads that value for the build artifact name and module manifest. Existing paired laptops need this installer once to move the scheduled agent into the current user's AppData; the migration preserves pairing. Later agent-only updates run without an admin prompt.

Building locally does not sign the installer or establish that it is safe. The earlier Chrome dangerous-download verdict is still unresolved; Windows or antivirus software may also flag the local build. Keep protections enabled and review any detection rather than automatically overriding it.

## Automatic upload window

In Config Manager → Settings, enable the daily upload window, enter 24-hour
start/end times (for example `16:00`–`22:00`), and Apply with your existing
parent password. The laptop's local clock is used. Start is inclusive and
end exclusive; `22:00`–`04:00` is an overnight window. Disable it for all-day
uploads. Existing installs default to all-day uploads.

The scheduled task retains its interval but the agent skips querying and
uploading outside the window. It does not stop ActivityWatch recording,
and it does not restrict the reported usage to those hours. Sync now,
missing-day uploads, and explicit backfill bypass the window. There is no
extra final upload at the end boundary. If the laptop is off during the
entire window, automatic upload waits for a later allowed run; the
existing missing-day tool remains available for historical dates.
