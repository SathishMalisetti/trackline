# Security release

This release keeps the existing family entry, optional email, parent password,
four-digit PIN, profile switching, task, schedule, shopping and device flows.
The demonstration family's local behavior is retained.

## Deployment

Coordinate the database SQL and application deployment. The application needs
the new shopping and credential RPCs; the database no longer accepts credential
changes through the general family save. Do not leave the old application
running against the credential-hardening SQL as an intermediate release.

Run these reviewed SQL files in order, then deploy the application:

1. security/shopping-isolation.sql
2. security/family-credentials.sql
3. security/family-isolation.sql

These replace functions and permissions; they do not remove family records,
change existing credentials, or reset profiles. Existing weak credentials are
upgraded on successful verification by the existing authentication endpoints.
New family-password changes use salted scrypt. Credential hashes stay on the
server; the browser receives hasPassword/hasPin flags.

The export form still asks for the family password. It now submits that password
over HTTPS for server-side verification instead of submitting the legacy hash.
Device administration relies on its existing verified parent session.

## Laptop updates

Build the version 1.1.5 installer and module with the existing Windows build
process. The updater verifies a detached CMS signature covering the whole zip,
including its DLLs and manifest, against the existing Trackline certificate:
297D507182D51329D8E40BEF20E709060D806D53.

On the Windows computer holding that certificate's private key, run:

    powershell -File sign-agent-module.ps1 -Bundle local-build/package/installer_output/TracklineAgentModule.zip

Upload TracklineAgentModule.zip and TracklineAgentModule.zip.p7s to the same
GitHub release. Checks still run after sync with the existing six-hour interval.
Unsigned or modified packages are skipped; sync continues normally. The CI
artifact cannot be publisher-signed without the private key. Do not commit or
upload that private key to the public repository. Bootstrap existing laptops
with this signed installer, or publish this module plus its detached signature.

The pinned certificate is intentionally checked independently of Windows root
trust, so its self-signed chain does not require importing a root certificate.
Protect the signing key; rotate the pinned certificate in a separately reviewed
release if it changes.

## Verification and remaining limits

Automated API tests use mocked requests. SQL regression tests use an isolated
PostgreSQL engine and fabricated families. Functional QA, live sign-in flows,
and production data writes remain paused.

The Windows-only CMS integration test signs fabricated bytes with a temporary
test certificate, verifies them, and checks rejection after tampering. It never
uses the real publisher's private key.

The CSP blocks framing, plugins and foreign base URLs while preserving existing
inline scripts, styles and handlers. A strict script CSP requires a separate
renderer refactor; this release validates the IDs/colors used in those contexts.
This does not claim a comprehensive penetration test or protection against a
person with access to the same Windows account.

Supabase leaked-password protection remains a dashboard setting to enable when
available for this project. It applies to optional email authentication.
