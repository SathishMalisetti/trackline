# Trackline — Supabase setup (current/primary backend)

This is now the active database. Azure Static Web Apps still hosts the site
itself — nothing changes there. Only where the data lives has changed, and
that's why the earlier VNet/private-endpoint problem is gone: Supabase is a
separate platform from Azure, with no ties to your work's subscription
policies, and its API is designed for direct browser access.

## Step 1 — Create the Supabase project

1. Go to supabase.com → sign up (free) → **New project**.
2. Pick any name, a database password (you won't need this password day-to-day
   — the app never uses it, it uses the API key instead, covered below), and
   a region close to you.
3. Wait a minute or two for it to finish provisioning.

## Step 2 — Create the table

1. In your new project, left menu → **SQL Editor** → **New query**.
2. Paste in the contents of `schema.sql` (in this same folder) and click **Run**.
3. This creates one table, `families`, with a JSON column that holds the
   whole family's data — same shape as everything else in this app.

## Step 3 — Get your API credentials

1. Left menu → **Project Settings** (gear icon) → **API**.
2. You need two values from this page:
   - **Project URL** — looks like `https://xxxxxxxxxxx.supabase.co`
   - **anon public** key — a long string under "Project API keys"
     (NOT the `service_role` key — that one is secret and must never go in
     frontend code; `anon` is specifically designed to be public/embeddable)

## Step 4 — Point the frontend at it

1. Open `index.html`, find near the top of the `<script>` block:
   ```js
   const SUPABASE_URL = '';
   const SUPABASE_ANON_KEY = '';
   ```
2. Fill both in:
   ```js
   const SUPABASE_URL = 'https://xxxxxxxxxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGciOi...(your long anon key)...';
   ```
3. Commit and push to your GitHub repo — the existing GitHub Actions workflow
   (set up when you deployed to Azure Static Web Apps) picks it up and
   redeploys automatically, same as always.

## Step 5 — Confirm it's actually syncing

1. Open your live site, go through onboarding (create a family, set a PIN).
2. In Supabase, left menu → **Table Editor** → `families`. You should see one
   row appear with your family's data in the `data` column.
3. To really confirm cross-device sync: open the same URL in a different
   browser or incognito window — it should land on the same family's
   dashboard instead of showing onboarding again.

## What's different from the Azure/Cosmos DB version

- **No backend API code needed at all** for this path — the frontend talks
  directly to Supabase's REST API. The Azure Function code (`api/` folder)
  is still in the repo and still fully works, but it's inactive right now
  because `SUPABASE_URL` takes priority over `AZURE_API_BASE` when both are
  set (see the storage-mode comment block at the top of `index.html`).
- **To switch back to Azure** at any point: just clear `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` back to `''`, and fill `AZURE_API_BASE` back in (see
  `azure-backend/README.md`). Nothing else needs to change — both paths were
  built side by side specifically so you can flip between them.

## Worth knowing before relying on this day-to-day

- **Free-tier projects pause after a week with no activity.** The first
  request after a pause takes a few extra seconds while it wakes back up —
  fine for a family actively checking the app, just don't be alarmed by one
  slow load if nobody's opened it in a while.
- **Security model is the same as the Azure version was**: the RLS policies
  in `schema.sql` allow anyone holding the `anon` key AND a specific family's
  ID to read/write that family's row. The family ID is a long random string,
  functioning like a bearer token — reasonable for personal use, not
  bulletproof. A future hardening step: add real Supabase Auth (email/password
  or social login) and scope the RLS policies to `auth.uid()` instead of
  "anyone with the ID" — a genuine access-control upgrade, not something
  needed to get started today.
- **Still no real email/SMS sending** — same as before, that's a separate
  step: Supabase has Edge Functions that could call an email/SMS provider
  server-side when you're ready for that.
