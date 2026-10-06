# Trackline account authentication

This change adds verified Supabase email/password accounts in front of the existing Azure-hosted app. APIs validate access tokens through Supabase Auth, then authorize using `family_auth_memberships`. The service-role credential stays in Azure. PINs remain a legacy UI feature, not API credentials.

## Existing project prerequisites

Use the Supabase project already backing Trackline. Its relational schema must include `families`, `members`, `chores`, and the existing `get_family_data` / `save_family_data` RPCs. The old `schema.sql` is insufficient. Do not run this change against a fresh project without restoring the actual schema.

## Enable and configure Auth

1. Enable email/password authentication and email confirmation in Supabase Auth.
2. Set the Auth Site URL to the live Trackline origin. Add that exact origin to the redirect allow-list. Add explicit development/preview origins only when needed.
3. Set Azure Static Web Apps API application settings:
   - `SUPABASE_URL`: the existing project's HTTPS URL.
   - `SUPABASE_PUBLISHABLE_KEY`: the public publishable key (a legacy anon key is supported for compatibility).
   - `SUPABASE_SERVICE_ROLE_KEY`: the existing server-only service-role key.
4. Build the client with `npm ci && npm run build` in `app/`. The SDK version is pinned and bundled; no third-party CDN script is loaded.

## Prepare existing family accounts before deployment

Create and confirm an Auth account for each parent or child. An administrator must explicitly map each account to its existing family profile. Creating an account never automatically grants family or parent access. Family IDs, browser roles and editable user metadata cannot grant access.

Apply `supabase/migrations/20261005222249_add_trackline_auth.sql` to the existing relational database, then run the following with actual values using the SQL Editor or an authenticated management connection. The SELECT checks that the member belongs to the requested family; verify that exactly one row is inserted.

```sql
insert into public.family_auth_memberships (user_id, family_id, member_id, role)
select u.id, m.family_id, m.id, m.role
from auth.users u
join public.members m on m.id = 'EXISTING_MEMBER_ID'
where lower(u.email) = lower('ACCOUNT_EMAIL')
  and u.email_confirmed_at is not null
  and m.family_id = 'EXISTING_FAMILY_ID'
  and m.role in ('parent', 'kid');
```

Family signup/self-enrollment and parent-managed account invitations are not implemented by this change. New families and additional account links require administrator provisioning. A signed-in account without a membership sees an access-required screen. Changing a profile's role in the old UI does not change its account role; administrators must update the membership explicitly. Child accounts can view schedules, complete their own tasks and take their own exams; calendar and shopping mutations are now parent-only. The old child-proposal/collaborative-shopping controls do not grant write access.

## Database protection

The migration enables RLS and revokes direct browser access on known application tables. Memberships are readable only by their own authenticated account and cannot be written by clients. Azure APIs use the service role and perform membership/role checks before database operations. Existing RPCs lose their public execute grant. No application rows are deleted.

Review the real database before deployment: any additional exposed tables, views or privileged RPCs outside this repository must also be checked. Run Supabase Security Advisor after applying the migration.

## Route permissions

| Route | Access |
| --- | --- |
| `/api/auth-config` | Public; URL and publishable key only |
| `/api/auth-me` | Verified account; own memberships |
| `/api/family-data` GET | Own family; child responses omit password/PIN hashes |
| `/api/family-data` POST | Own family, parent only |
| `/api/chore-log` | Parent or child acting on an owned task |
| `/api/shopping-trip`, device pairing/list, export, join and schedule generation | Parent in the requested family |
| Study exams and assignments | Parent or linked child; profile ownership checked |
| Usage reads | Own family; children see their own usage |
| `/api/study-topics` | Verified account; shared curriculum |
| `/api/device-usage-ingest` | Existing device-token authentication |
| Device deregistration | Parent account plus existing family credential, or device's own token |

## Laptop installer compatibility

Existing paired devices continue syncing with device tokens. Pairing a new device now requires the parent's account email/password in addition to the legacy family password. Account passwords/access tokens are never persisted by the pairing tools. Local settings changes verify the parent account.

Rebuild all three Windows programs and the Inno Setup installer before distributing them; the committed executables are older builds and do not contain this change. Installers have not been rebuilt in this Linux workspace. Both source copies have been updated. Configurations made by older installers require re-pairing before changing settings.

## Verify before rollout

Run `npm test` in `api/`, build in `app/`, and run `npm ci`, `npm run test:sql` and `npm run test:browser` at the repository root. Browser tests require `npx playwright install chromium` (or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` pointing to Chromium). Then verify on a preview deployment:

- Signed-out app shows only sign-in; requests without valid access tokens return 401.
- Parent account opens its own family and can save changes.
- Child cannot change family state, access another child, or call parent endpoints.
- A different family's ID returns 403 even with a valid account token.
- Confirm-email and password-reset links return to the app and complete successfully.
- Existing device tokens still ingest usage; rebuilt pairing creates a device successfully.
- Direct REST requests using public keys cannot access application tables or family RPCs.

API authorization tests, browser flows with mocked Auth responses, and migration queries in an isolated PostgreSQL fixture passed locally. The migration was applied directly to project `pqusqljhzgqbsxroqpel` on 2026-10-05. Live permission checks confirmed own-account membership RLS, denied client membership insertion, and server-only application table/RPC access. The existing 9 families and 17 members were preserved. There were no Auth accounts at rollout. Azure environment settings, Auth Site URL/redirect configuration, account provisioning and links, and application deployment remain required before live login can be verified.

Sources: https://supabase.com/docs/guides/auth/passwords and https://supabase.com/docs/reference/javascript/auth-getuser
