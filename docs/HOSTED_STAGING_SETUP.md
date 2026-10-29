# Hosted staging setup (deployment preparation, payments pending)

Status on 27 Oct 2026: **prepared locally, not provisioned, not deployed.**

This machine has no Vercel CLI login, no `VERCEL_TOKEN`, no `SUPABASE_ACCESS_TOKEN` and no git remote. So no hosted project was created, linked, migrated or deployed, and **no hosted check has been run**. Everything that could be done without your accounts is done and tested locally (§2). The rest is written as exact steps for you to run (§4–§8), followed by the hosted checks to run afterwards (§9).

This is a **staging** environment for internal testing with disposable data. It is not a launch: **payments and paid access are not implemented** (Phase 8), and the portal must not be described as launched or payment-ready.

Numbering: this work comes before Phase 8 (payments). Phase 9 stays "production deployment" and reuses this guide.

---

## 1. Readiness review

The review covered the installed versions and code against the official docs fetched on 27 Oct 2026: Vercel Functions limits, request headers, cron jobs, Deployment Protection, runtime logs and fair use; Supabase backups and `db push`. The Next.js docs come from `node_modules/next/dist/docs/`.

| Area | Finding | Result |
|---|---|---|
| Versions | Next.js 16.4.3 (App Router, Cache Components/PPR, `src/proxy.ts`), React 19.3, Node 24.x locally (v24.14.1), npm lockfile v3 | Supported by Vercel. `engines.node` is set to `24.x`, so Vercel uses the same major version |
| Build | `npm run build` runs `prebuild`, which copies the PDF.js worker and data into `public/pdfjs/<version>/` (gitignored, so it is regenerated on Vercel) | OK. No custom build command is needed |
| Runtime | Every route uses the Node.js runtime. None uses Edge. The proxy (`src/proxy.ts`) runs as Vercel Routing Middleware | OK |
| PDF processing | Server Actions load the original with pdf-lib (up to `PDF_MAX_UPLOAD_MB`=20, 300 pages). The dashboard page sets `maxDuration = 60`, which also covers its Server Actions | Within Hobby/Pro limits (Fluid compute default 300 s; 2 GB memory on Hobby) |
| Uploads | The browser uploads straight to Supabase Storage with a signed upload URL. File bytes never pass through a Vercel function | Not affected by Vercel's 4.5 MB request limit. The bucket limit is 25 MiB |
| Preview delivery | `/p/<token>/preview` streams the storage object (no buffering) and checks the token on every request | Vercel documents a 4.5 MB response body limit, and its KB guide says streaming functions don't have it. **Not verified: measure on staging (§9, check H14).** It has not been switched to signed URLs |
| Server-only operations | The secret key is read only in `src/lib/supabase/privileged.ts`, the rate limiter and `scripts/`. No `NEXT_PUBLIC_` variable holds a secret | OK (§3) |
| Link base URL | Client links are built only from `NEXT_PUBLIC_APP_URL`, never from request headers | It must be the staging HTTPS URL **before the build** (§3) |
| Client IP | Vercel overwrites `X-Forwarded-For` and `X-Real-IP` with the real client address, so clients cannot spoof them. A custom trusted XFF proxy is Enterprise only | Use `RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip`. Leave `RATE_LIMIT_TRUSTED_PROXY_HOPS` unset |
| Headers | Static CSP, `frame-ancestors 'none'`, nosniff, Permissions-Policy, COOP. `/p/*`: `no-store`, `no-referrer`, `noindex`. Dashboard/login: `no-store` | Tested locally on a production build (`npm run test:cron`) |
| HSTS | The app sets no HSTS header. Preload and includeSubDomains are not used anywhere | Check what the Vercel edge sends on the staging URL (§9, check H20). Production-domain HSTS is a Phase 9 decision |
| Cron | Vercel Cron runs on all plans. Hobby allows **once a day**, at any time within the chosen hour. Only production deployments run crons. Vercel sends `Authorization: Bearer <CRON_SECRET>`, with no retries and possible duplicates | New secured endpoint plus `vercel.json` (§2) |
| Deployment Protection | With Standard Protection, every URL **except production domains** needs a Vercel login. Client links on a preview URL would therefore not open for signed-out clients. Password Protection is not available on Hobby | Use a **separate Vercel project** for staging and deploy to its *production* environment, which gives a stable `https://<project>.vercel.app` (§5) |
| Logs | Vercel runtime logs record the **Request Path** (and search params) of each function request, so `/p/<token>` appears in them. Retention is 1 h on Hobby and 1 day on Pro (30 days with Observability Plus). No path-redaction control is documented | Exposure is documented in §7. The app itself never logs tokens |
| Plan terms | Vercel **Hobby is non-commercial personal use only**. Any commercial project, including one where someone is paid to write the code, needs Pro or Enterprise | **Decision for you:** this portal is commercial, so hosting it on Vercel, staging included, likely needs **Pro ($20/month per member)**. Nothing was purchased (§10) |
| Migrations | 9 forward-only files, no seed data, no local user ids or emails. Uses `extensions.digest` (pgcrypto, enabled by default on hosted Supabase) and creates the private `proposals` bucket | Safe to apply to an empty staging project with `db push` |

No other blockers were found.

## 2. What was prepared locally (this step)

| File | Purpose |
|---|---|
| `src/app/api/cron/storage-cleanup/route.ts` | Scheduled storage cleanup. Returns **404 unless `CRON_SECRET` is set (32+ characters)** and **401** for anything other than `Authorization: Bearer <CRON_SECRET>` (constant-time compare). A query-string or other-header secret is refused. GET only. **Dry run by default**: it deletes only when `STORAGE_CLEANUP_CRON_APPLY=true`. It reuses `runStorageCleanup` from `scripts/storage-cleanup.mjs` unchanged, so files are kept when they are referenced, newer than the threshold (default 24 h, minimum 2 h) or unrecognised, and every batch is re-checked before deletion. The response and logs carry counts only: no names, ids or secrets. It also reports how many proposals are stuck in "Deletion pending". `maxDuration = 300`, capped at 2000 candidates per run |
| `src/lib/supabase/privileged.ts` | New narrow operation `runScheduledStorageCleanup` (the secret key stays in this one module) |
| `src/proxy.ts` | Matcher now skips `api/cron/`, which needs no session refresh because it has its own secret |
| `vercel.json` | One cron: `/api/cron/storage-cleanup` at `0 3 * * *` (daily, so Hobby-compatible) |
| `.vercelignore` | Keeps `.env*` (except `.env.example`), `.vercel`, `.next`, `node_modules`, `public/pdfjs`, Supabase local state, Studio snippets, tests, `*.pdf`, dumps/backups, logs and test output out of CLI uploads |
| `.gitignore` | Now also ignores `*.pdf`, `*.dump`, `*.sql.gz`, `*.backup` and test-output/screenshot folders |
| `package.json` | `engines.node: "24.x"`; `npm run test:cron` |
| `.env.example` | New staging/cron variables; a broken `§` character fixed |
| `supabase/provisioning/assign-internal-profile.sql` | Gives an existing hosted Auth user a name and role. It contains no passwords and creates no users |
| `supabase/tests/integration/deploy-cron.mjs` | 33 checks: disabled/401/405 cases, dry-run default, fresh uploads kept, apply-mode wiring, duplicate delivery, no names in output, production headers. It runs its own server on port 3102 and **never deletes local files** (the apply run uses a ~100-year threshold) |

Local results on 27 Oct 2026:
- lint, typecheck and build passed;
- `test:cron` 33/33;
- API 34/34, app 17/17, dashboard 38/38, PDF/links 72/72, client 68/68, history 100/100;
- hardening 106/106 (its real-PDF fixture checks were not run in this pass because `PDF_FIXTURES_DIR` was not set);
- pgTAP 263/263;
- `npm audit --omit=dev` found 0 vulnerabilities.

Local accounts, records, files and links were unchanged (every suite checks this). The CRM containers were not touched.

## 3. Environment variables

Set these in **Vercel → staging project → Settings → Environment Variables**, scope **Production** (the staging project's production environment). Never put hosted values in your local `.env.local`. `NEXT_PUBLIC_*` values are compiled into the build, so **redeploy after changing any of them**. `next.config.ts` also reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_APP_URL` at build time for the CSP.

| Variable | Visibility | Staging value |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | public (browser) | `https://<staging-project>.vercel.app` (no trailing path). Every client link is built from it |
| `NEXT_PUBLIC_SUPABASE_URL` | public | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | Supabase → Project Settings → API Keys → **Publishable** key (`sb_publishable_…`) |
| `SUPABASE_SECRET_KEY` | **server-only, mark Sensitive** | Supabase → API Keys → **Secret** key (`sb_secret_…`). Never `NEXT_PUBLIC_` |
| `RATE_LIMIT_KEY_SECRET` | **server-only, Sensitive** | A new random value (32+ bytes), not reused anywhere else |
| `RATE_LIMIT_CLIENT_IP_HEADER` | server-only | `x-real-ip` |
| `CRON_SECRET` | **server-only, Sensitive** | A new random value, 32+ characters |
| `STORAGE_CLEANUP_CRON_APPLY` | server-only | **Leave unset** (dry run) until the dry run has been reviewed (§6) |
| `STORAGE_CLEANUP_OLDER_THAN_HOURS` | server-only, optional | Default 24 (minimum 2) |
| `SUPABASE_SERVER_URL` | server-only | **Leave unset** on Vercel (it is only for local/outage testing) |
| `RATE_LIMIT_TRUSTED_PROXY_HOPS` | server-only | **Leave unset** on Vercel |
| `PDF_MAX_UPLOAD_MB`, `PDF_MAX_PAGES`, `SUPABASE_*_TIMEOUT_MS`, `RATE_LIMIT_*` rules | server-only, optional | Defaults are fine |

To generate a random value on your machine, so that it is shown only to you, run `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Paste the result straight into Vercel and don't save it in the repo.

## 4. Hosted Supabase (dedicated staging project)

1. **Create the project.** Go to supabase.com → New project in your organization, and name it e.g. `proposal-portal-staging`. Don't reuse any existing project. Pick a region near your users and note it, because Vercel's function region should match (§5). Save the database password in your password manager. The Free plan is enough for staging (§10).
2. **Confirm its identity.** Project Settings → General shows the **Project ref** and name. Check it is the new, empty staging project before going on.
3. **Link and review, from this folder.** The CLI is already a dev dependency.
   ```sh
   npx supabase login                                  # opens the browser; stores your token locally
   npx supabase projects list                          # confirm the staging ref and name
   npx supabase link --project-ref <staging-ref>       # asks for the database password
   npx supabase migration list --linked                # remote column should be empty
   npx supabase db push --linked --dry-run             # must list exactly the 9 files below, in this order
   ```
   The expected order is `20261026120000_core_schema`, `…120100_rls_policies`, `…120200_storage_proposals_bucket`, `20261027090000_phase3_drafts_and_list_views`, `20261028090000_phase4_pdf_offer_links`, `…090100_phase4_storage_helper_columns`, `20261029090000_phase5_client_page_resolvers`, `20261030090000_phase7_hardening`, `20261031090000_names_history_deletion`.
4. **Apply:** `npx supabase db push --linked`.
   - Do **not** add `--include-seed`.
   - **Never** run `supabase db reset --linked`, which drops remote data.
   - Do not run `supabase config push`: `config.toml` holds localhost URLs. Set Auth in the dashboard (step 5).
   - `supabase link` writes only `supabase/.temp/`, which is gitignored and excluded from deploys. Your local stack is not affected.
5. **Configure Auth** under Authentication → Sign In / Providers and URL Configuration:
   - Email provider: enabled. **Allow new users to sign up: off.**
   - Minimum password length: **12**, the same as local.
   - Site URL: `https://<staging-project>.vercel.app`. Redirect URLs: `https://<staging-project>.vercel.app/**`. The app uses email + password only and has no OAuth or magic-link callback.
   - Leave the other providers disabled.
6. **Verify the schema** in the SQL Editor (read-only queries):
   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets;          -- proposals | false | 26214400 | {application/pdf}
   select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;  -- every row: true
   select extname from pg_extension where extname = 'pgcrypto';                         -- one row
   select count(*) from pg_policies where schemaname in ('public','storage');           -- > 0
   ```
   Data API: keep it enabled with the `public` schema exposed (the default). The app uses PostgREST and RPC.
7. **Create the internal accounts by hand.** Use disposable staging accounts, not your local ones: one admin and at least two team leads.
   1. Authentication → Users → **Add user → Create new user**. Enter the email and **a password you choose** (12+ characters), and tick **Auto Confirm User**.
   2. In the SQL Editor, open `supabase/provisioning/assign-internal-profile.sql`, put in the email, display name and role (`admin` or `team_lead`), and run it. It returns the profile row. Run it once per account.

   An Auth user without a profile cannot use the portal.
8. **Do not copy local data.** No local users, clients, PDFs or links go to staging. Create test clients and proposals through the staging UI. Links issued on staging use the staging base URL.

## 5. Vercel (separate staging project)

1. **Create a new project** for staging only, e.g. `proposal-portal-staging`. Don't link this folder to any other project, and don't add or move a domain. Choose one of two ways:
   - **CLI (works without git):** `npx vercel@latest login`, then `npx vercel@latest link` and choose **create a new project** named `proposal-portal-staging`. `.vercelignore` controls what is uploaded.
   - **Git:** push this folder to a new private repository and import it in the Vercel dashboard. `.gitignore` already excludes secrets, PDFs and dumps.
2. **Project settings:**
   - Framework: Next.js (auto-detected).
   - Build command and output: defaults. `npm run build` runs `prebuild`.
   - Install: `npm install`, which uses `package-lock.json`.
   - Node.js: 24.x, from `engines`.
   - Functions → **Region:** the one closest to the Supabase region (e.g. `iad1` for `us-east-1`, `fra1` for `eu-central-1`).
   - Fluid compute: on (the default). Do not raise memory or duration on Hobby.
3. **Deployment Protection:** keep **Standard Protection**. It protects preview URLs. The staging project's *production* URL stays public, which signed-out client links need. All internal pages still need a portal login, and client pages need an unguessable token. Don't share the URL publicly.
4. **Environment variables** for the Production scope, as in §3.
5. **Deploy:** `npx vercel@latest deploy --prod`, or push to the production branch for git. The result is `https://proposal-portal-staging.vercel.app`, or the name Vercel assigns. If the assigned URL differs from what you put in `NEXT_PUBLIC_APP_URL` and the Supabase Site URL, fix both and redeploy.
6. **Cron:** after a production deployment, Settings → Cron Jobs should list `/api/cron/storage-cleanup`. Keep it in dry-run mode for now (§6).

Rollback: in Deployments, use **Instant Rollback** or promote an earlier deployment. Database changes are forward-only: fix a bad migration with a new corrective migration, never a reset.

## 6. Scheduled cleanup (dry run first)

1. **Manual dry run.** On your machine, put the secret in your shell first; don't paste it into files.
   ```sh
   curl -s -H "Authorization: Bearer $CRON_SECRET" https://<staging>/api/cron/storage-cleanup
   ```
   You get a JSON summary with counts only: `mode: "dry-run"`, `counts`, `candidates`, `deleted: 0` and `pendingDeletions`. Also run it without the header and expect 401.
2. Let the daily cron run in dry-run mode at least once, and check Logs for a `[cron] storage cleanup dry-run` line.
3. **Enable deletion** only after reviewing the counts: set `STORAGE_CLEANUP_CRON_APPLY=true` and redeploy. Files that are referenced, newer than 24 h or unrecognised are never deleted, and the cleanup can't delete a current original or preview.
4. **Retries.**
   - Cleanup: Vercel doesn't retry, and the next daily run picks up anything left. You can also re-run it by hand with curl, or locally with `npm run storage:cleanup` against staging (see the note below).
   - **Deletion pending:** if a permanent deletion stops partway, the proposal stays frozen and hidden from clients. It is finished with **Retry deletion** in Proposal History, by its owner or the CEO. The cron never completes deletions itself; it only reports `pendingDeletions` so they get noticed.
   - A file uploaded late through a signed URL that was issued before the deletion is an orphan in that proposal's folder. The cleanup removes it after the age threshold.

Note: `npm run storage:cleanup` reads `.env.local`. To point it at staging, set the variables in that one shell only, without changing `.env.local`, then close the shell.

## 7. Security and operations on the host

- **Rate limiting:** a shared PostgreSQL limiter keyed by `x-real-ip`, which Vercel sets and clients can't spoof. It fails open if the database is down, as designed in Phase 7.
- **Private routes:**
  - `/dashboard*` and `/login`: `private, no-store`.
  - `/p/*` and `/p/*/preview`: `private, no-store`, `no-referrer` and `X-Robots-Tag: noindex, nofollow, noarchive`. The page also has robots metadata.
  - The preview checks the token on every request, so a revocation applies on the next request.
- **Privileged credentials:** the secret key, `RATE_LIMIT_KEY_SECRET` and `CRON_SECRET` exist only as server env vars marked Sensitive. Check H18 confirms they aren't in the client bundle.
- **Provider access logs (remaining exposure):**
  - Vercel runtime logs show each function request's path. `/p/<token>` (page and preview) is therefore visible to **members of the Vercel team** for 1 h on Hobby, or 1 day on Pro (30 days with Observability Plus). No redaction setting for paths is documented.
  - The app adds nothing: its own logs never contain tokens, and the Next request log ignores `/p/`.
  - Mitigations:
    - keep the Vercel team to the people who need it;
    - don't add Log Drains or extended retention;
    - don't share log links;
    - if a token may have been seen, **regenerate the link** (the old one stops working immediately);
    - the database stores only token hashes.
  - Supabase API logs see only RPC calls with the token in the request body, not the URL. Treat them the same way.
- **HSTS:** not set by the app. Don't enable preload or includeSubDomains for `vercel.app`. Choosing a production-domain policy is a Phase 9 item.
- **Backups and recovery** (database and Storage are separate):
  - **Database:**
    - Supabase **Free has no listed daily backups**. Pro keeps daily backups for 7 days. PITR is a paid add-on.
    - For staging, recovery means re-running the migrations and re-creating the disposable test data.
    - If you want a copy, run `npx supabase db dump --linked -f <outside-the-repo>/staging-schema.sql` and add `--data-only` for data. Keep dumps out of this folder; they are gitignored and excluded from deploys anyway.
  - **Storage files:** Supabase states that **database backups do not include Storage objects**, and restoring a database doesn't bring back deleted files. No Storage backup is configured. Staging PDFs are disposable. For production (Phase 9), plan a separate copy of the `proposals` bucket.
  - **No backups are configured or verified.**

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Client link asks for a Vercel login | It is a preview URL (protected), not the staging project's production URL |
| Links show `localhost` or the wrong host | `NEXT_PUBLIC_APP_URL` was wrong at build time. Fix it and redeploy |
| Upload fails in the browser (CSP / network) | `NEXT_PUBLIC_SUPABASE_URL` was wrong or missing at build time (CSP `connect-src`) |
| Dashboard shows "temporarily unavailable" | Supabase is paused or unreachable, or the keys are wrong. Run `npm run health` with the staging variables in a temporary shell |
| Login refused for a new account | No profile row (§4 step 7), the user isn't confirmed, or the password is shorter than 12 characters |
| Cron returns 404 | `CRON_SECRET` is unset or shorter than 32 characters |
| Cron returns 401 | The header doesn't match `Bearer <CRON_SECRET>` exactly |
| Preview fails only for large documents | Possible 4.5 MB response limit. See check H14 and its fallback |
| Rate limits hit everyone at once | `RATE_LIMIT_CLIENT_IP_HEADER` is not set to `x-real-ip` |

## 9. Hosted checks (none run yet)

Use disposable staging data only. Run nothing high-volume or destructive against any production project. Remove only the fixtures you created.

| # | Check | How |
|---|---|---|
| H1 | Admin and two team leads sign in; header shows their profile names | Browser |
| H2 | Team lead A can't see or act on lead B's clients/proposals; admin sees both with owner names | Browser. Optionally run the local suites' API probes with the staging keys in a temporary shell (not the destructive suites) |
| H3 | Create a client and a proposal; upload a real PDF; free preview generated | Browser |
| H4 | Issued link starts with the staging URL | Copy the link |
| H5 | Signed-out (private window) link shows title, preview, counts and price only; no Team Lead name, email or ids in the HTML/RSC | View source; search for the lead's name |
| H6 | Locked pages appear as synthetic placeholders; the preview PDF holds only the free pages | Browser; download the preview and count its pages |
| H7 | Revoke → the next page **and** preview request answer 404; regenerate → the new link works and the old one doesn't | Browser + curl |
| H8 | Proposal History lists drafts/issued proposals with filters | Browser |
| H9 | Permanent deletion removes the row and its storage folder; payment-retained refusal still applies | Browser; Storage browser |
| H10 | Cron dry run (curl), 401 without the header; then one apply run after review | §6 |
| H11 | Rate limit: repeated bad logins answer "too many attempts"; a spoofed `X-Forwarded-For` does not change the key | Use 15 attempts or fewer, with your own test account |
| H12 | Login/logout; protected pages redirect to `/login` when signed out | Browser |
| H13 | Outage state: pause the staging Supabase project briefly → dashboard shows the retry state and no data; resume | Supabase dashboard (staging only) |
| H14 | **Preview over 4.5 MB** streams through the deployed route | Make the image-heavy fixture with `supabase/tests/fixtures/make-pdf-fixtures.mjs` (run it from a scratch folder as its header explains; the 19.8 MiB fixture produced a 6.9 MB preview) and upload it. Run `curl -s -o NUL -w "%{http_code} %{size_download}\n" https://<staging>/p/<token>/preview` and compare the size with the stored preview object. **If it fails:** record the status/error, keep the current behaviour, and choose between lowering the free-page count or file size, or moving to short-lived signed URLs (which changes revocation timing; needs your decision) |
| H15 | Originals are never reachable: the storage public URL for the original returns 400/404; the bucket is private | curl |
| H16 | Headers: `/p/*` no-store, no-referrer, noindex; CSP present; dashboard no-store | `curl -sI` |
| H17 | Logs: open a link, then search the runtime logs for the token. Expected: present only as the request path (§7), never in a log message | Vercel Logs |
| H18 | No secret in the client bundle | Search the downloaded `/_next/static` JS for `sb_secret_` and the `CRON_SECRET` value |
| H19 | `/pdfjs/<version>/` assets served with long caching; viewer renders | Browser |
| H20 | Record which `Strict-Transport-Security` header the Vercel edge sends on the staging URL | `curl -sI` |

## 10. Costs and payment requirements

Nothing was purchased and no charges were accepted.

- **Supabase:** the Free plan is enough for staging, at $0. It has no listed daily backups and has project limits. Production backups (Pro: 7 days) and PITR are paid.
- **Vercel:** Hobby is free but restricted to **non-commercial personal use**. This portal is a commercial project, so Vercel's terms point to **Pro (from $20 per member per month)** even for staging. Password Protection costs extra on Pro ($20/month per project) and isn't needed with the approach in §5. **This is your decision; nothing has been set up.**
- **Domains:** none needed for staging (`*.vercel.app` is used).

## 11. Limitations

- Nothing hosted exists yet. Every item in §9 is unverified.
- The 4.5 MB streaming question (H14) is still open.
- Daily cron only on Hobby, with a 1 h window and no retries.
- No backups. Storage files have no backup at all.
- Provider logs keep token-bearing paths for their retention period (§7).
- **Payments and paid access are not implemented** (Phase 8). Real accounts and webhook setup belong to production (Phase 9).
