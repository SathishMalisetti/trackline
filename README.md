# Trackline — Azure free-tier deployment

This gives Trackline real multi-device sync: the family tablet, a kid's laptop,
anyone's phone — all seeing the same live schedule, backed by Azure Cosmos DB.

**Cost: $0/month** at family scale. Both pieces below use Azure's *always-free*
tiers (Cosmos DB free tier never expires; Static Web Apps Free plan includes
its Functions API at no extra charge).

## What you're deploying

- **Azure Static Web Apps (Free plan)** — hosts `index.html` (your Trackline
  file, renamed) *and* the `/api` Azure Function together, in one deployment.
- **Azure Cosmos DB (Free tier)** — one always-free account gives you
  1,000 RU/s and 25 GB storage forever. This app uses a tiny fraction of that.

## Folder layout expected

```
your-repo/
├── index.html              <- rename trackline.html to this
├── staticwebapp.config.json
└── api/
    ├── host.json
    ├── package.json
    └── family-data/
        ├── function.json
        └── index.js
```

## Step 1 — Create the Cosmos DB free tier account

1. In the Azure Portal, create a new **Azure Cosmos DB** resource → choose the
   **Azure Cosmos DB for NoSQL** API.
2. On the free tier prompt, select **Apply Free Tier Discount** (one per
   subscription). This is what makes it $0.
3. Once created, go to **Keys** in the left menu and copy the
   **Primary Connection String** — you'll need it in Step 3.
   (The database `trackline` and container `families` are created
   automatically the first time the API runs — no manual setup needed there.)

## Step 2 — Create the Static Web App

1. In the Azure Portal, create a new **Static Web App** resource.
2. Choose the **Free** plan.
3. Easiest path: connect it to a GitHub repo containing the folder layout
   above — Azure sets up a GitHub Actions workflow automatically that deploys
   on every push. Point:
   - **App location** → `/` (where `index.html` lives)
   - **Api location** → `api`
   - **Output location** → leave blank
4. If you'd rather not use GitHub, you can deploy directly from your machine
   with the [SWA CLI](https://azure.github.io/static-web-apps-cli/) instead
   (`npm install -g @azure/static-web-apps-cli`, then `swa deploy`).

## Step 3 — Connect the two

1. In your new Static Web App resource → **Configuration** (left menu) →
   **Application settings** → add a new setting:
   - Name: `COSMOS_CONNECTION_STRING`
   - Value: the connection string you copied in Step 1
2. Save. The API can now read/write Cosmos DB.

## Step 4 — Point the frontend at it

1. Once deployed, your Static Web App has a URL like
   `https://<something>.azurestaticapps.net`.
2. Open `index.html`, find this line near the top of the `<script>` block:
   ```js
   const AZURE_API_BASE = '';
   ```
3. Set it to your Static Web App's URL:
   ```js
   const AZURE_API_BASE = 'https://<something>.azurestaticapps.net';
   ```
4. Redeploy (push the change, or `swa deploy` again).

That's it — the app auto-detects `AZURE_API_BASE` is set and switches from
local-only storage to syncing through the API into Cosmos DB. Nothing else in
the app changes; every feature (logins, PINs, chores, activities) already
only talks to storage through the two functions this setting affects.

## Worth knowing before you rely on this day-to-day

- **The API is set to "anonymous" auth** (`function.json` → `authLevel:
  anonymous`) to keep first setup simple. That means anyone who has both your
  API URL *and* a specific family's ID could read/write that family's data.
  A family ID is a random generated string (not guessable, works like a
  bearer token) — reasonable for a personal family app, but if you want real
  hardening later: Static Web Apps has **built-in authentication**
  (Microsoft/GitHub/Google login) included free, which can gate the API
  properly per logged-in user instead of relying on an unguessable ID. That's
  a good next step, not something you need on day one.
- **The in-app PIN system stays exactly as it is** — it's a device-level lock
  in the browser, separate from this. This step only changes *where the data
  lives*, not how people log in. Upgrading to real server-side login (hashed
  passwords checked on the server) would be a separate follow-up.
- **Still no real email/SMS sending** — that's a further step: wire an email
  service (e.g. Azure Communication Services or SendGrid) into the same API,
  triggered server-side, never from the browser.
