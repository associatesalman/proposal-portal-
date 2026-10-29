# Phase 7 — Security, Storage Cleanup and Performance Hardening

Status: **complete** (local stack). Nothing was deployed, no hosted service was set up, and no payment code was written.

Phase numbering changed with this phase. Phase 7 is now hardening, Phase 8 is payments and paid access, and Phase 9 is deployment. Older documents keep their original numbers.

---

## 1. Starting point

These UI refinements were confirmed as implemented before Phase 7 began (see [PHASE_6_UI_SUMMARY.md](PHASE_6_UI_SUMMARY.md) §10):
- the larger dashboard scale and summary cards;
- the two-column animated login, with a connection-error state;
- reduced-motion support;
- larger forms and dialogs.

They are unchanged here, apart from the new "temporarily unavailable" and "too many attempts" states described below.

## 2. Findings and fixes

| # | Finding (evidence) | Fix |
| --- | --- | --- |
| F1 | **About 52 s `/login` during a Supabase outage** (`AuthRetryableFetchError: fetch failed`, status 0). auth-js retries a failed token refresh with exponential backoff for up to ~30 s per call, and the proxy and the page each made one. | All server-side Supabase clients use a bounded `fetch` (`src/lib/supabase/fetch.ts`). Response headers must arrive within `SUPABASE_FETCH_TIMEOUT_MS` (10 s); bodies may still stream. Every auth call runs under `withAuthDeadline` (`SUPABASE_AUTH_TIMEOUT_MS`, 6 s). On timeout the client's auth requests are closed, so the abandoned refresh cannot rotate the browser's refresh token later. Measured: an outage now answers in about 50 ms (connection refused) to 3 s (hanging upstream), with the test timeouts. |
| F2 | **Outage treated as "signed out" or crashing the page.** `getAuthState` mapped network errors to anonymous (redirect to /login), and a failed profile query threw (the Suspense error). | `AuthState` gains `unavailable`. The proxy passes it through with **no redirect and no cookie changes**, and pages show "Service temporarily unavailable" with a retry. Actions return "The service is temporarily unavailable. Nothing was saved." Sign-in reports a connection problem, not invalid credentials. Genuine results are unchanged: a forged cookie still goes to /login, and a missing profile still gets "not authorized" (both tested with Supabase up). |
| F3 | **A dead link was shown when the database was down.** `resolveProposalLink` returned `null` on any error, which rendered "This link isn't available". | The resolver returns `found`, `not_found` or `error`. On `error` the page shows "can't be loaded right now" with a retry, and the preview answers 503 with `Retry-After`. |
| F4 | **Proposal deletion left PDFs orphaned.** Phase 2 granted `DELETE` on `proposals` and had a delete policy, but there is no coordinated storage removal. | Migration `20261030090000_phase7_hardening.sql` drops the policy and revokes `DELETE` from `anon` and `authenticated`. Admins are included. The payment FK (`ON DELETE RESTRICT`) is unchanged, and there is no delete button. See §5. |
| F5 | **Orphaned storage objects** came from abandoned uploads, superseded revisions whose best-effort removal failed, and failed operations. Nothing cleaned them up. | Dry-run-first cleanup utility (`npm run storage:cleanup`), described in §4. |
| F6 | **No application rate limiting** except Supabase Auth's own. | A shared PostgreSQL limiter (§3) on login, link pages, previews, unknown-link lookups and the expensive upload/preview actions. |
| F7 | **No global security headers or CSP.** | A static CSP plus nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy and COOP (`next.config.ts`). `/login` and `/dashboard` are `private, no-store`. `/p/*` keeps `no-referrer` and `no-store`. See §6. |
| F8 | **Forwarded-IP trust.** Next.js fills `X-Forwarded-For` only when it is absent, so on a directly exposed server a client can choose it. | The client address is taken from a configured trusted edge header or a trusted-hop count (`src/lib/security/client-ip.ts`). The local default is documented as spoofable. See §3.3. |
| F9 | **Upload completion had no time bound.** An old unreferenced object could in theory become referenced while a cleanup deleted it. | `completeUploadAction` rejects objects stored more than 1 hour earlier ("This upload is too old to finish"). Cleanup never touches anything younger than 2 hours (default 24). |
| F10 | **Encryption detection was untested against real encrypted files.** | Tested with real Standard Security Handler files: RC4-40, RC4-128, AES-128 and AES-256, both user-password and owner-only. All six are rejected as "password-protected or encrypted", none as "corrupt", and nothing is left in storage. No code change was needed. |
| F11 | **`signOut` could hang during an outage.** | `signOut` is bounded. If Supabase doesn't answer, this browser's session cookies are cleared directly. |

**Reviewed and found sound (no change):**
- Every server action authorizes independently: role from `profiles`, RLS-scoped loads, and `SECURITY DEFINER` re-checks.
- Cross-lead isolation: all six PDF/link actions answer "not found" across leads (re-tested).
- The secret key is used only server-side: `privileged.ts`, the rate limiter, and the cleanup script, run by an operator.
- Public resolvers expose only title, page counts and price.
- The original PDF is never served.
- Zod validation covers tokens, ids, page counts, prices and currencies.
- React escaping handles all user text, with no `dangerouslySetInnerHTML`.
- `getSafeRedirectPath` only allows same-origin relative paths.
- Server logs contain only fixed strings and error codes (log checks in the test suites).
- PDF.js loads only on `/p/[token]` (bundle sizes unchanged from Phase 6).
- Dashboard queries are paginated and bounded.
- `npm audit`: **0 vulnerabilities** (info, low, moderate, high, critical all 0; 482 dependencies). Nothing was upgraded.

## 3. Rate limiting

### 3.1 Design

- **Storage:** `private.rate_limit_counters (scope, key_hash, window_start, window_end, hits)` in the project's own Postgres. There is no Redis or other new service, and no process-memory counters. All server instances share it.
- **Atomic:** `public.rate_limit_consume(scope, key_hash, limit, window_seconds, cost)` does a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`. Thirty concurrent requests against a limit of 15 let exactly 15 through (tested).
- **Fixed windows** aligned to the epoch. A block always ends with its window, so there is no permanent lockout. As with any fixed window, a burst that straddles a boundary can reach up to 2× the limit; the limits are set with that in mind.
- **Hashed keys:** keys are HMAC-SHA-256 (`RATE_LIMIT_KEY_SECRET`, or a key derived from `SUPABASE_SECRET_KEY`). The table never holds a raw IP address, email or link token, and a CHECK constraint accepts only 64-hex keys. Link tokens are SHA-256-hashed first, then HMAC-keyed.
- **Privileges:** the functions run as service_role only. `anon` and `authenticated` cannot call them or read the table (pgTAP).
- **Retention:** expired windows are pruned 10 minutes after they end. Pruning happens opportunistically (about 2 % of calls, at most 500 rows) and in bulk by `npm run storage:cleanup -- --apply` (`rate_limit_prune`).

### 3.2 Rules and defaults

Override any rule with `RATE_LIMIT_<RULE>="<limit>/<window seconds>"`. `RATE_LIMIT_ENABLED=false` turns limiting off.

| Rule | Key | Default | Over the limit | Limiter down |
| --- | --- | --- | --- | --- |
| `LOGIN_IP_EMAIL` | address + email | 10 / 15 min | "Too many sign-in attempts. Wait N minutes and try again." | fail **open** (Supabase Auth limits still apply) |
| `LOGIN_EMAIL` | email (any address) | 20 / 15 min | same | open |
| `LOGIN_IP` | address | 100 / 15 min (shared offices) | same | open |
| `LINK_PAGE_IP` | address | 120 / min | 429 HTML page + `Retry-After` (in `src/proxy.ts`) | open |
| `LINK_PREVIEW_IP` | address | 120 / min | 429 + `Retry-After`; the viewer shows a retry | open |
| `LINK_PREVIEW_TOKEN` | link (hashed) | 300 / min | same | open |
| `LINK_MISS_IP` | address | 30 unknown links / 10 min | unknown links get 429 / "Too many attempts". **Valid links are never blocked by this rule.** | open |
| `UPLOAD_PREPARE_USER` | user id | 30 / 10 min | "Too many upload attempts… Try again in N minutes." | fail **closed** |
| `UPLOAD_COMPLETE_USER` | user id | 30 / 10 min | same | closed |
| `PREVIEW_GENERATE_USER` | user id | 30 / 10 min | "Too many preview attempts…" | closed |

**Fairness:**
- Login limits treat known and unknown emails identically, so they don't reveal whether an account exists (tested).
- A blocked sign-in stays blocked even with the correct password until the window ends.
- Normal viewing (a page load plus its preview, and repeated reloads) is far below the limits (tested).
- Seven people behind one address can sign in normally (tested).
- Internal limits are keyed by the verified user id, never by anything the browser sends, and access checks run first.

### 3.3 Client address and proxies

`src/lib/security/client-ip.ts` resolves the client address from the first matching option:
1. `RATE_LIMIT_CLIENT_IP_HEADER` (e.g. `x-real-ip`): a header your edge proxy **overwrites** on every request. Its first value is used.
2. `RATE_LIMIT_TRUSTED_PROXY_HOPS=N`: the number of trusted proxies that **append** to `X-Forwarded-For`. The client is N entries from the right, and spoofed left-hand entries are ignored.
3. Neither set (local development): the rightmost `X-Forwarded-For` entry. That is the socket address when the client sent none, but **a client can spoof it**. Production must configure option 1 or 2.

IPv6 addresses are bucketed by /64. Unparseable values become `unknown`.

**Intended hosting (Vercel):** set `RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip`, which Vercel's edge sets from the connecting client. Confirm against Vercel's request-header documentation at deployment time and test it with a spoofed `X-Forwarded-For` (Phase 9 item). **Behind your own reverse proxy:** use `RATE_LIMIT_TRUSTED_PROXY_HOPS=1` (or the right count), and make the app reachable only through that proxy.

## 4. Storage cleanup

```bash
npm run storage:cleanup                                  # dry run: report only (default)
npm run storage:cleanup -- --older-than-hours 72         # stricter age
npm run storage:cleanup -- --prefix <owner-id>/ --show-paths
npm run storage:cleanup -- --apply                       # delete the candidates
npm run storage:cleanup -- --apply --json                # machine-readable report
```

- **Classification** (`public.storage_cleanup_scan`, keyset-paginated, 500 per page). The scan covers the `proposals` bucket only, and every object gets one of four classes:
  - `referenced`: a proposal's current original or preview. Never deleted.
  - `recent`: newer than the threshold (default 24 h, **minimum 2 h**). Never deleted, because it may be an in-progress upload.
  - `unrecognised`: not in the application layout `{owner}/{proposal}/[{revision}/](original|preview).pdf`. Reported, never deleted.
  - `orphan`: everything else. These are the deletion candidates.
- **Why 2 h is safe:** the app refuses to finish an upload more than 1 h after the object was stored. An object old enough to be a candidate can therefore never become referenced.
- **Apply.** Batches of 100 are processed in four steps:
  1. **Re-check** in the database just before deletion (`storage_cleanup_recheck`): the object still exists, is still unreferenced, still old, and still in the app layout.
  2. Delete through the Storage API, with 3 attempts and backoff.
  3. Confirm each name against the API's response.
  4. Write every deletion or failure to `private.storage_cleanup_log` (`storage_cleanup_history(run_id)`).

  Partial failures are counted and give exit code 1, and the run can simply be repeated. `--max-objects` (default 5000) bounds a run.
- **Output:** counts and sizes only. Object names appear only with `--show-paths`. No keys, links or document contents are ever printed.
- **Credentials:** `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_SERVER_URL`) and `SUPABASE_SECRET_KEY`, from the environment or `.env.local`.

**Current local data (dry run, 27 Oct 2026):** 2 referenced objects, 0 recent, 0 unrecognised, **0 candidates**. Cleanup was **not** applied to real documents. Destructive runs were tested only under disposable test users' prefixes.

**Scheduling (not set up; do it after deployment):**
- Run `npm run storage:cleanup -- --apply --json` daily from a trusted machine or a CI job that holds the secret key. Examples: a GitHub Actions `schedule:` workflow, or cron on an ops host.
- Review the dry-run output for the first few runs before enabling `--apply`.
- Don't run it from a public route, and don't put the secret key in a browser-reachable function.

## 5. Proposal deletion policy

- **Now:** no application role (team lead or admin) can delete a proposal. Tests prove this with real sessions through the REST API (`42501`) and in pgTAP. Clients keep their FK protection (`23503` while proposals exist). Payments keep `ON DELETE RESTRICT`. The dashboard has no delete control.
- **Deferred (Phase 8 or later): a trusted deletion procedure.** It should:
  - be an admin-only server action backed by a `SECURITY DEFINER` function;
  - refuse while payments exist, and refuse active proposals (revoke first);
  - lock the row, record the storage paths, delete the row, then remove the objects;
  - leave anything the removal misses for the cleanup utility, which already handles orphans;
  - keep an audit row.

  Until then, proposals are archived or left as drafts.

## 6. Headers and CSP

The CSP is static. Next.js's nonce-based CSP forces dynamic rendering and is incompatible with Partial Prerendering, which this app uses, so this follows the "Without Nonces" setup from the bundled Next.js 16 CSP guide.

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' <supabase origin>; worker-src 'self' blob:;
frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
[; upgrade-insecure-requests when NEXT_PUBLIC_APP_URL is https]
```

- `'unsafe-inline'` scripts are required by Next's inline bootstrap without nonces. This is the main remaining weakness of a static CSP.
- `'wasm-unsafe-eval'` is for PDF.js image decoders. PDF.js 6 has no eval paths, so `'unsafe-eval'` is added in development only.
- `connect-src` includes the Supabase origin because signed uploads go straight from the browser to Storage.
- Verified in headless Chrome:
  - **no CSP violations** on login, dashboard or the viewer;
  - the PDF.js viewer renders with its worker and wasm;
  - every existing browser suite passes with the policy active (hydration, forms, dialogs, uploads, viewer).

## 7. Outage behaviour and local health checks

| Situation | Behaviour |
| --- | --- |
| Supabase down, `/dashboard` | 200 "Service temporarily unavailable" + Try again. No data queried, no redirect, no cookie changes. |
| Supabase down, `/login` | Form shown with "The sign-in service isn't responding right now" (when a session exists); submitting says it can't connect. |
| Supabase down, server action | "The service is temporarily unavailable. Nothing was saved." |
| Supabase down, client link | "This proposal can't be loaded right now" + retry; preview 503 + `Retry-After`. |
| Access token expired during outage | Refresh abandoned within the deadline; no background refresh after recovery (tested by counting token requests); the same session works when Supabase returns. |
| Recovery | Next request works normally; nothing to clear. |

```bash
npm run health                              # Supabase Auth, REST (DB), Storage and the app at NEXT_PUBLIC_APP_URL
npm run health -- --app-url http://localhost:3100
```

`npm run health` prints status and timings only, never keys, tokens or cookies, and exits 1 when a required service is down.

**Local recovery:**
- `npx supabase status` shows the stack's state.
- `npm run db:start` starts this project's containers only.
- Then retry in the browser. The app needs no restart.

Optional server-only env vars:
- `SUPABASE_FETCH_TIMEOUT_MS` (default 10000);
- `SUPABASE_AUTH_TIMEOUT_MS` (default 6000);
- `SUPABASE_SERVER_URL`: a server-side Supabase address, also used by the outage tests.

## 8. Real PDFs: measured limits and performance

Fixtures were generated locally by `supabase/tests/fixtures/make-pdf-fixtures.mjs` (pdfkit, not a project dependency):

| Fixture | Size | Result | Verify (app) | Preview gen (app) |
| --- | --- | --- | --- | --- |
| text, 12 pages | 0.01 MiB | accepted | 88–110 ms | 108–114 ms |
| Unicode/CJK (YaHei, MS Gothic, Malgun, Georgia, Consolas subsets) | 0.05 MiB | accepted | 91–103 ms | 108–129 ms |
| scanned/image-heavy, 6 pages | 10.6 MiB | accepted | 253–456 ms | 346–462 ms |
| 300 pages | 0.19 MiB | accepted | 214–247 ms | 205–221 ms |
| near-limit, 9 image pages | 19.8 MiB | accepted (preview 6.9 MB) | 395–398 ms | 482–496 ms |
| 301 pages | 0.19 MiB | rejected: "has 301 pages. The limit is 300." | | |
| 22 MiB | 22.0 MiB | rejected before upload (declared size) **and** from the stored size when the declared size lies | | |
| encrypted, user password: RC4-40, RC4-128, AES-128, AES-256 | small | rejected as encrypted (PDF.js confirms each needs a password) | | |
| encrypted, owner-only (opens without a password): RC4-128, AES-256 | small | rejected as encrypted (by design: preview generation would need decryption) | | |

- **Memory and time:** in a standalone Node process running the app's own `inspectPdf` and `buildPreviewPdf`, peak RSS was **117–208 MiB**; the largest was the 22 MiB file. Inspection took at most 134 ms and preview generation at most 148 ms. "Verify (app)" includes the storage download over the local network.
- **Conclusion:** the limits (20 MiB, 300 pages, 60 s action budget) are stable with a wide margin, and they were **not changed**.
- These numbers come from one Windows development machine against local Supabase. They are **not** production measurements.
- **Not covered:**
  - JPEG 2000 and JBIG2 scans (no generator available);
  - PDFs with non-embedded fonts or broken cross-reference tables from real-world tools;
  - files near the 25 MiB bucket limit with very many small objects;
  - real devices: Safari/iOS, Firefox, Android.

**Viewer:**
- PDF.js is lazy-loaded only on `/p/[token]` (`/login` 137.3 KB, `/dashboard` 252.0 KB, `/p` 289.6 KB gzip, unchanged).
- It renders one page at a time and cancels stale renders on fast navigation or zoom; the existing Phase 5 suite covers this.
- It now shows a specific retryable message for a rate-limited preview.

## 9. Hosting: large previews

Official Vercel documentation, checked on 27 Oct 2026:
- [Functions limits](https://vercel.com/docs/functions/limitations) says the maximum payload for request **or response** bodies is **4.5 MB** (`413 FUNCTION_PAYLOAD_TOO_LARGE`).
- The knowledge-base guide [How to bypass the 4.5 MB body size limit](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions) recommends streaming functions, "which don't have this limit".
- Streaming is enabled by default for Node.js functions.
- The function's max duration (300 s default with Fluid compute) includes the time spent streaming.

The preview route already **streams** the storage object (`ReadableStream`, `Cache-Control: no-store`), with no buffering. Previews over 4.5 MB do happen: the 19.8 MiB fixture produced a 6.9 MB preview.

**Approach:** keep streaming through the app, which keeps per-request token checks and **instant revocation**. Nothing was switched to signed URLs. Phase 9 must still:
- deploy a preview build;
- stream a preview of over 4.5 MB from it and confirm a 200 with the full byte count;
- confirm a revoked link fails on the next request.

Only if that test fails should short-lived signed URLs be considered, and that would be a documented change to revocation semantics (OPEN_QUESTIONS Q11).

## 10. Verification (actually run, 27 Oct 2026)

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck`, `npm run build` | pass |
| `npm run db:test` (pgTAP, incl. new `phase7_hardening.test.sql`) | **198/198** (156 earlier + 42 new) |
| `npm run test:hardening` (new; dedicated server on 3101, simulated outages, fixtures, headless Chrome) | **121/121**. Earlier runs: 112/119, then 118/119, caused by test bugs (HTML entities, a wrong assertion, fixed-window alignment). The final pre-release run was 120/121: the assertion's regex accepted only "Wait N seconds", but the app correctly said "Wait 1 minute". After fixing the regex, the final run was 121/121. |
| `test:integration` / `test:app` / `test:dashboard` | 34/34, 17/17, 38/38 |
| `test:pdf` / `test:client` (with `SERVER_LOG` log checks) | 72/72, 70/70 |
| `test:browser` / `test:pdf-browser` / `test:client-browser` / `test:ui` | 28/28, 27/27, 64/64, 97/97 |
| `measure:bundles` | 3/3, sizes unchanged |
| `npm run health`, `npm run storage:cleanup` (dry run on real data) | ok; 0 candidates |

- The regression server ran with `RATE_LIMIT_LINK_MISS_IP=100000/600`. The older suites deliberately request dozens of unknown links from one address, which correctly hit the default 30 / 10 min miss limit and failed 11 of their checks on a second consecutive run. All other limits ran at their defaults.
- Every suite ends by checking that existing local accounts and data are unchanged and that all disposable storage objects were removed. All passed.
- Outages were simulated only in front of the dedicated test server, with a local HTTP proxy that refuses connections, hangs, or fails just the limiter. No Docker service was stopped.

## 11. Commands and configuration added

- **npm scripts:** `npm run health`, `npm run storage:cleanup`, `npm run test:hardening`.
- **Migration:** `20261030090000_phase7_hardening.sql`. It has already been applied locally. On other environments run `npx supabase migration up` (it is forward-only and changes no existing rows).
- **New server-only env vars** (all optional, see `.env.example`):
  - `SUPABASE_SERVER_URL`, `SUPABASE_FETCH_TIMEOUT_MS`, `SUPABASE_AUTH_TIMEOUT_MS`;
  - `RATE_LIMIT_ENABLED`, `RATE_LIMIT_KEY_SECRET`, `RATE_LIMIT_CLIENT_IP_HEADER`, `RATE_LIMIT_TRUSTED_PROXY_HOPS`, `RATE_LIMIT_<RULE>`.

## 12. Remaining work

- **Deployment (Phase 9):**
  - hosted Supabase plus migrations;
  - Vercel env vars, including `RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip` (verify with a spoofed XFF);
  - the >4.5 MB preview streaming and revocation test (§9);
  - the scheduled cleanup job (§4);
  - HSTS at the edge;
  - the real-device browser pass.
- **Payments (Phase 8):** everything in IMPLEMENTATION_CHECKLIST Phase 8. Its recovery and checkout endpoints must use the same limiter (add rules such as `RECOVER_IP_EMAIL`). Blocked on provider details (OPEN_QUESTIONS P1–P8).
- **Trusted proposal deletion** (§5).
- **CSP:** consider nonces or SRI if Partial Prerendering is dropped.
- **Fixtures:** test JPEG 2000 / JBIG2 / non-embedded-font fixtures when real samples are available.
