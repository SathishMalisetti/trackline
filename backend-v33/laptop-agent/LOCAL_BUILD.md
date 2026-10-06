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

The resulting file is:

```text
backend-v33/laptop-agent/local-build/package/installer_output/TracklineAgentSetup.exe
```

`SHA256.txt` is beside it. Build output is separate from the previously committed executables. The script does not install or run Trackline, change device pairing, query ActivityWatch, or upload data. Existing missing-day upload and family/device functionality are unchanged. ActivityWatch must still be installed separately on each target laptop.

If Inno Setup is installed in a custom location:

```cmd
py -3.12 build_installer.py --inno-compiler "D:\Tools\Inno Setup 6\ISCC.exe"
```

Building locally does not sign the installer or establish that it is safe. The earlier Chrome dangerous-download verdict is still unresolved; Windows or antivirus software may also flag the local build. Keep protections enabled and review any detection rather than automatically overriding it.
