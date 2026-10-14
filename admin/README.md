# Trackline platform administration

The separate `/admin` page manages platform administrators, shared curriculum references, reusable lesson versions, AI generation jobs, read-only family support and audit history. It does not use family authentication or change existing child study plans. Official curriculum extraction and the new child/parent study experience are later phases.

## Database and first administrator

1. Apply `admin/schema.sql` once in the Supabase SQL editor if it has not already been installed. It creates six independent tables and server-only functions. It does not change existing family tables or seed credentials. Do not rerun this creation script after installation.
2. On your computer, with Node.js 22 or newer, run from the repository root:

   ```sh
   node admin/provision-admin.cjs
   ```

3. Choose your administrator username, a password of 12–128 characters, and a 4-digit PIN. The helper creates `first-admin.sql` containing salted scrypt hashes. Keep this file private. Execute it in the Supabase SQL editor, then delete it locally. Do not put plaintext passwords into the account table or share your credentials in chat.
4. After deployment, open `https://victorious-field-093009200.7.azurestaticapps.net/admin`. Enter username/password, then PIN. Your remembered administrator session lasts up to 30 days; PIN access locks after 15 minutes of inactivity. Password verification is required for publishing, adding administrators and account changes when the previous verification is more than five minutes old.

The `platform_admins` table contains `username`, `password_hash`, `pin_hash`, `enabled` and credential/session controls. You can manage accounts from **Administrators** and change your own credentials from **My account** after provisioning the first account. Changing credentials revokes remembered sessions, including when the platform owner edits hashes directly in SQL. Five unsuccessful password/PIN attempts lock the account for five minutes. Recovery remains an owner-controlled database operation in this phase.

All six new tables have RLS enabled and no browser role grants. Only server code with the existing `SUPABASE_SERVICE_ROLE_KEY` accesses them, after checking the independent administrator session. Never expose that key in static HTML or the browser.

## AI generation settings

In Azure Static Web Apps **Configuration / Application settings**, retain the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and add:

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-only OpenAI API key for real draft generation; usage is billed by the provider. |
| `ADMIN_GENERATION_MODEL` | Optional Responses API model supporting structured JSON output; default `gpt-4.1-mini`. |
| `ADMIN_GENERATION_WORKER_KEY` | A randomly generated server secret of at least 32 characters, shared only with the scheduled worker. |

Generate a worker secret locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

In GitHub repository **Settings → Secrets and variables → Actions**:

- Set repository variable `ADMIN_API_ORIGIN` to `https://victorious-field-093009200.7.azurestaticapps.net` (no trailing slash).
- Set repository secret `ADMIN_GENERATION_WORKER_KEY` to the same value configured in Azure.

The `Curriculum generation worker` workflow runs on the default branch on a five-minute schedule and can be dispatched manually. GitHub may delay scheduled runs. Each invocation processes up to three queued jobs; an administrator can also choose **Process now**. Database leases prevent concurrent workers from saving the same result, recover interrupted jobs and cap automatic processing attempts at three. A failed job can be retried deliberately; this limit applies to generation infrastructure, not children’s assessments. Cancelling a running job discards its eventual result but cannot undo provider usage already incurred.

The API times out provider requests after 40 seconds. Large or slow generations can fail and need smaller units or another attempt. Missing configuration produces a setup error, never fabricated success. Actual provider generation must be verified after your server key is configured; automated tests use mocked provider responses.

## Curriculum workflow

1. **Curriculum → Add curriculum unit**: choose Year 4 or 7 and Mathematics, English or Science. Paste the genuine VCAA descriptor code/text and an HTTPS VCAA reference URL. Alternatively import a reviewed JSON array of reference objects with these fields:

   ```json
   [{
     "title": "Your reviewed unit title",
     "subject": "Mathematics",
     "year_level": 4,
     "curriculum_version": "Victorian Curriculum F-10 Version 2.0",
     "source_url": "https://f10.vcaa.vic.edu.au/",
     "descriptor_code": "REPLACE_WITH_ACTUAL_OFFICIAL_CODE",
     "descriptor_text": "Replace with the actual official curriculum descriptor text."
   }]
   ```

   This illustrates the format; it is not an official mapped curriculum unit. No reference URL is fetched or extracted in this phase. Once content exists, source references are immutable: create a new unit for a changed descriptor.

2. Open **Content & versions → Generate draft**. The job saves original AI-created content as an unpublished version. Importing lesson JSON is also supported; its format is defined by `api/shared/admin-generation.js` and enforced by the API. Each skill contains `title`, `prerequisites` (string array), `lesson`, `worked_examples` (string array), `questions` and `writing_rubric`. Questions contain `question`, `type` (`mcq` or `short_text`), `options` (string array), `answer`, `explanation`, `purpose` (`practice`, `checkpoint`, `assessment`) and `difficulty` (`introductory`, `developing`, `application`). Rubric entries contain `criterion`, `description`, and integer `weight`; nonempty rubrics total 100. Include 1–6 skills and 4–40 questions per skill.
3. Review the readable lesson, examples, answers and rubric. Edit draft JSON and review notes as needed. **Check structure** validates the format; it does not establish factual correctness or VCAA coverage.
4. Confirm educational review, then **Publish version**. Publishing atomically retires the previous published version. Published content cannot be edited; generate a new version to revise it. Old versions remain available for review.

Content records snapshot the reference and proposed 30-minute learning, 15-minute practice, 5-minute checkpoint session with 80% mastery. Year 4 generation is guided; Year 7 asks for more independent reasoning. No child attempt locks or parent unlock requirements are introduced. Monthly revision, placement, schedules and AI marking for children are not wired into the existing study module by this admin-only change.

## Family support and audit

Family lists show account summaries. Opening detailed information requires an explicit confirmation and is audited before data retrieval. Members, tasks, schedules, saved study progress and devices are shown read-only. Additional saved information includes up to 250 recent task logs/exam attempts/progress records and 50 shopping lists. Password/PIN hashes, tokens and credential fields are excluded. No family-edit or impersonation operation is provided.

## Verification

```sh
npm ci
npm ci --prefix api
npm test --prefix api
node tests/admin-sql.cjs
npx playwright install chromium
node tests/admin-layout.cjs
```

The SQL test uses isolated PGlite accounts and records. The layout check mocks GET responses and blocks writes; it does not submit login forms or call the production database. Live functionality QA remains paused.
