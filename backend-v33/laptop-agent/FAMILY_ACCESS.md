# Installer family access (1.1.3)

Pair a laptop using the published Trackline backend URL, Family ID and family password, then select its family member and device label. Parent email, parent password and a parent PIN are not required by the installer.

Config Manager confirms settings changes and disconnection using the family password. Existing configurations work without an `account_email` field; already-paired devices retain their device token.

Interactive actions verify the family password through the existing family-session login and its attempt limiter. The installer uses a temporary family connection for member lookup/pairing, then deletes that connection. Neither the family password nor that connection is saved to config.json. Scheduled uploads continue using the existing device token.

The family-connected API exception applies only to family-members and device-pair. Website feature access, member PIN gates, permissions, and the email flow remain unchanged. There is no database migration.

After merging and Azure deployment, build the updated installer on Windows:

```powershell
cd backend-v33\laptop-agent
py -3.12 build_installer.py
```

Output: `local-build\package\installer_output\TracklineAgentSetup.exe`. Sign the rebuilt file using the same certificate as the previous installer. Replace the old release download only after verifying the new Windows build. This source change does not update an EXE already installed or uploaded to a release.

Local verification uses mocked API/network tests; no live pairing or database-write QA was performed.
