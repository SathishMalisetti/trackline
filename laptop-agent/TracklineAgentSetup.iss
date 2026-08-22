; ============================================================================
; Trackline Agent — Windows Installer
; ============================================================================
; Compile with Inno Setup (free): https://jrsoftware.org/isinfo.php
; Download and run the Inno Setup installer once, then open this .iss file
; in the Inno Setup Compiler (Script menu > Compile, or just press F9/Run).
; Produces ONE file: installer_output\TracklineAgentSetup.exe — that's the
; single file you upload/distribute. Nobody who receives it ever sees this
; script or needs Inno Setup themselves.
;
; ----------------------------------------------------------------------------
; BEFORE COMPILING — folder layout this script expects, as siblings of
; this .iss file (exactly what PyInstaller --onedir produces, unrenamed):
;
;   TracklineSetup\              (from: pyinstaller --onedir --windowed --name TracklineSetup trackline_setup_gui.py)
;   TracklineAgent\              (from: pyinstaller --onedir --windowed --name TracklineAgent trackline_agent.py)
;                                  MUST be --windowed, not --console — a --console
;                                  build here reintroduces the exact console-popup
;                                  bug that was fixed two rounds ago.
;   TracklineConfigManager\      (from: pyinstaller --onedir --windowed --icon=trackline_icon.ico --name TracklineConfigManager trackline_config_manager.py)
;   trackline_icon.ico           (provided alongside this script)
;
; The exact sibling folder names "TracklineAgent" and "TracklineSetup" are
; NOT arbitrary — Config Manager's and Setup's own exe-discovery logic
; specifically looks for sibling folders with these exact names (already
; built and tested against this pattern). Renaming them here would silently
; break "Pair this device" and "Sync Now" after install.
; ============================================================================

#define MyAppName "Trackline Agent"
#define MyAppVersion "1.0"
#define MyAppPublisher "Trackline"
#define MyConfigManagerExe "TracklineConfigManager.exe"

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppId={{8F2C9A1E-4B6D-4E3A-9C7F-3D5A8B1E6F42}
DefaultDirName=C:\trackline
DisableProgramGroupPage=yes
DisableWelcomePage=no
OutputDir=installer_output
OutputBaseFilename=TracklineAgentSetup
Compression=lzma
SolidCompression=yes
SetupIconFile=trackline_icon.ico
UninstallDisplayIcon={app}\TracklineConfigManager\{#MyConfigManagerExe}
; Writing to C:\ root requires an admin-elevated install on a standard
; Windows account — this is the same admin-rights tradeoff flagged earlier
; when Program Files was ruled out for exactly this reason, now applying
; here since C:\trackline was chosen explicitly over the no-admin-needed
; per-user AppData alternative. Whoever runs this installer will see a UAC
; prompt.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
; Each PyInstaller onedir output goes into its own exact-named subfolder —
; keeps the three separate _internal dependency trees fully isolated (not
; safe to merge; each has its own bundled dependency versions), while the
; end user only ever sees and thinks about the one C:\trackline folder.
Source: "TracklineSetup\*"; DestDir: "{app}\TracklineSetup"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "TracklineAgent\*"; DestDir: "{app}\TracklineAgent"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "TracklineConfigManager\*"; DestDir: "{app}\TracklineConfigManager"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Trackline Config Manager"; Filename: "{app}\TracklineConfigManager\{#MyConfigManagerExe}"; IconFilename: "{app}\TracklineConfigManager\{#MyConfigManagerExe}"
Name: "{commondesktop}\Trackline Config Manager"; Filename: "{app}\TracklineConfigManager\{#MyConfigManagerExe}"; IconFilename: "{app}\TracklineConfigManager\{#MyConfigManagerExe}"; Tasks: desktopicon

[Run]
; Automatically opens Config Manager right after install finishes, exactly
; as required — the end user never has to go looking for which exe to run.
; Since nothing is paired yet at this point, Config Manager will correctly
; open straight to its "Pair this device" screen.
Filename: "{app}\TracklineConfigManager\{#MyConfigManagerExe}"; Description: "Open Trackline Config Manager"; Flags: postinstall nowait skipifsilent
