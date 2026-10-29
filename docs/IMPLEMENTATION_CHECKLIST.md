# Implementation Checklist

Work top to bottom. Each phase ends with its verification items passing. Use the local Supabase stack (`npm run db:start`) or a dedicated dev project. Never test against production data.

Phase numbers changed twice. After Phase 5 the UI redesign became Phase 6. In Phase 7 hardening was done before payments, so the order is now 7 hardening (done), 8 payments, 9 deployment. Completed phase summaries keep the numbering of their time (in Phase 5 documents "Phase 6" means payments; in Phase 6 documents "Phase 7" means payments).

## Phase 1 — Planning and scaffolding ✅

- [x] Next.js (App Router, TS, Tailwind, ESLint, `src/`) initialized in place with npm
- [x] Core deps installed: `@supabase/supabase-js`, `@supabase/ssr`, `pdfjs-dist`, `pdf-lib`, `zod`, `lucide-react`
- [x] Folder structure + `.gitkeep` files
- [x] `.env.example` (`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` placeholders only; `.gitignore` allows it while ignoring other `.env*`)
- [x] Planning docs
- [x] `npm run lint`, `npm run typecheck`, `npm run build` pass on the stock scaffold (see PHASE_1_CHECKLIST.md)

## Phase 2 — Database, auth, roles, private storage ✅

Details and results: [PHASE_2_SETUP.md](PHASE_2_SETUP.md).

- [x] Migrations: enums, `profiles`, `clients`, `proposals`, `payments` (`supabase/migrations/`)
- [x] Constraints: composite FK `(client_id, owner_id)`, price/amount ≥ 0, page-count bounds, ISO-format currency, unique `(provider, provider_payment_id)`, storage paths fixed to `{owner_id}/{proposal_id}/…`
- [x] Server-controlled timestamps (triggers); owner change blocked for API roles (trigger + column grants)
- [x] `private.is_admin()` (SECURITY DEFINER, empty search_path, non-exposed schema, execute only for `authenticated`)
- [x] RLS on all tables; least-privilege table/column grants; no `anon` access
- [x] Private `proposals` bucket + storage policies tied to proposal rows
- [x] Supabase SSR browser/server clients, `src/proxy.ts` session refresh, server-side auth helpers
- [x] `/login` (email/password, generic errors, no signup), sign out, protected `/dashboard` placeholder
- [x] Local config: public signups disabled, localhost auth URLs, min password length 12, no seed data
- **Verify** (local stack; all passed — see PHASE_2_SETUP.md §8)
  - [x] Lead A cannot read/update/delete/reassign lead B's clients, proposals, payments
  - [x] Lead A cannot attach a proposal to lead B's client
  - [x] Lead cannot promote self (profile update or auth metadata)
  - [x] Admin reads/manages across leads; cannot write payments or change roles via the API
  - [x] Anon has no table or storage access; bucket not public
  - [x] Lead cannot read/list/sign/upload/delete another lead's PDF objects
  - [x] Unauthenticated → `/login`; login + logout work; missing profile denied

## Phase 3 — Dashboard (no upload) ✅

Details and results: [PHASE_3_SUMMARY.md](PHASE_3_SUMMARY.md).

- [x] Forward migration `20261027090000_phase3_drafts_and_list_views.sql`: drafts without offer fields, `active` requires them, `client_id` locked, read-only `security_invoker` list views
- [x] Summary counts (overall totals, role-scoped, following the admin owner filter)
- [x] Clients tab: list, search (name/email), pagination, add/edit dialogs; Owner column for admin
- [x] Proposals tab: list, search (title/client name), pagination, new-draft and rename-draft dialogs; status and PDF state shown separately; non-drafts are read-only
- [x] Admin: team-lead filter, create clients for a lead, create drafts for any client
- [x] Zod-validated server actions that authenticate, load the role, derive ownership on the server and use the RLS-scoped client
- [x] Empty / no-results / past-last-page / load-error states, pending states, toast feedback, accessible dialogs, mobile layout
- **Verify** (local stack; all passed, see PHASE_3_SUMMARY.md)
  - [x] Lead sees only their own rows and counts; admin sees all, or one lead when filtered
  - [x] Tampered form payloads (other owner, other lead's client, other lead's proposal/client id, non-draft edit) are rejected
  - [x] A proposal's client can't be changed through the API
  - [x] pgTAP, API, app-auth, dashboard and headless-browser checks pass

## Phase 4 — Upload and PDF processing ✅

Details and results: [PHASE_4_SUMMARY.md](PHASE_4_SUMMARY.md).

- [x] Forward migrations `20261028090000_phase4_pdf_offer_links.sql` and `20261028090100_phase4_storage_helper_columns.sql`: file metadata, `link_token_hash` (hash only, unreadable by API roles), revision paths, invariants, active lock trigger, offer/status grants revoked, trusted `SECURITY DEFINER` write functions, anon-callable `resolve_proposal_link` (title only), storage INSERT (draft) / DELETE (unreferenced) policies
- [x] Server-only privileged client (`src/lib/supabase/privileged.ts`) limited to four trusted writes; `SUPABASE_SECRET_KEY` in `.env.example` without `NEXT_PUBLIC_`
- [x] Signed upload URL created as the user (storage RLS applies), to an immutable revision path
- [x] Server verification of the stored bytes: size, header, pdf-lib parse, encryption, 2…`PDF_MAX_PAGES` pages
- [x] Offer: `1 ≤ free < total`, positive price in integer minor units, currency allow-list with per-currency decimals, no default currency
- [x] Preview generation (pages 1..N only, page keys stripped, page count re-verified) stored privately; regenerated on every offer save
- [x] Private link: 256-bit token, SHA-256 stored, shown once, copy button, local-only warning, revoke and explicit regenerate
- [x] Status → active when a link is issued (the planned "finalize → active" became "active ⇔ link"); active proposals locked until revoked
- [x] Concurrency: compare-and-swap on expected paths, no transaction open during upload; cleanup of only the operation's own or superseded files
- [x] `/p/[token]` placeholder: title only, generic unavailable state, no-store / no-referrer / noindex, excluded from request logs
- [x] Content lock after payment: replaced by per-payment immutable revision snapshots (Phase 8)
- **Verify** (local stack; all passed, see PHASE_4_SUMMARY.md §9)
  - [x] **Three leads upload three different proposals** → three different tokens, each resolving only its own proposal. Each preview has exactly its `free_preview_pages` pages
  - [x] `free_preview_pages = 0`, `= total_pages`, `> total_pages`, negative and non-integer values are all rejected on the server, even when the UI is bypassed
  - [x] Non-PDF renamed to `.pdf`, encrypted PDF (trailer-flagged fixture), oversized file, corrupt/truncated PDF and one-page PDF are all rejected cleanly, leaving no files
  - [x] Preview PDF opened standalone contains only pages 1..N (a link annotation to a later page isn't followed)
  - [x] Unauthorized lead, anon and signed-out callers are rejected; status/paths/page counts/price/hash can't be forged via the API
  - [x] Revoke and regenerate invalidate the old link; concurrent link/upload/offer operations resolve to one winner
  - [x] Existing local accounts and data unchanged

## Phase 5 — Client page ✅

Details and results: [PHASE_5_SUMMARY.md](PHASE_5_SUMMARY.md).

- [x] `/p/[token]`: token format validation, generic unavailable page, safe field selection, headers (Phase 4), now the full client page: title, "Free preview: X of Y pages.", preview/total/locked counts, locked notice, formatted price, "Online payment will be available soon." (white/blue, no payment button)
- [x] Forward migration `20261029090000_phase5_client_page_resolvers.sql`: anon `resolve_proposal_offer` (display fields only), service-role-only `resolve_proposal_preview_object`
- [x] Preview delivery: `GET /p/[token]/preview` streams the preview through the app after a per-request token check (planned as a ~60 s signed URL at `/api/access/[token]/preview`; streaming chosen so revocation applies to the next request; production size limit is open question Q11)
- [x] PDF.js viewer component: loaded on demand, local worker/data files (`public/pdfjs/<version>/`), one page at a time, prev/next, zoom 50–300 %, fit width, text layer, keyboard, mobile, loading/error/timeout/retry states
- [x] Headers: `noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store` (Phase 4 `next.config.ts`; the preview response sets them too)
- **Verify** (local stack; all passed, see PHASE_5_SUMMARY.md §6)
  - [x] **Link A shows only Client A's proposal; Link B only B's; Link C only C's**, each delivering only its own preview pages
  - [x] Random / modified / revoked (disabled) / regenerated-old tokens show the same generic page and the same 404 from the preview endpoint
  - [x] **Unpaid client cannot retrieve the original PDF**: page HTML and preview responses contain no original path, storage URL or signed URL; guessed original/document routes (incl. `/api/access/[token]/document`) never serve a PDF; anon storage access is denied
  - [x] Delivered preview contains exactly the free pages; locked-page text is absent (PDF.js text extraction and inflated bytes)
  - [x] Revocation blocks the next preview request and reloads (replaces "signed preview URL stops working after expiry": no signed URLs are issued)
  - [x] Missing object / network / corrupt bytes / timeout show useful error states with a retry that re-checks access

## Phase 6 — White & blue UI redesign ✅

Details and results: [PHASE_6_UI_SUMMARY.md](PHASE_6_UI_SUMMARY.md). No schema, permission or data changes. Payments are deferred to Phase 7.

- [x] Design tokens in `globals.css` (white, blue #2563EB / #1D4ED8 / #EFF6FF, slate text and borders, semantic colours), always light (`color-scheme: light`, no dark-mode override)
- [x] Shared UI: button variants (primary, secondary, subtle, destructive, row action, icon), inputs, selects, search, labels/hints/errors, tabs, badges, summary cards, table + mobile cards, dialog, toast, skeletons, empty/error states; no UI library, fonts self-hosted at build time
- [x] Login: focused panel, show/hide password, existing auth, validation, safe redirects and missing-profile rejection unchanged; no sign-up
- [x] Dashboard: header (identity, name, role, Sign out), summary cards from real counts, tabs with counts, toolbar (search, admin lead filter, add action), table/mobile cards, pagination; role differences unchanged
- [x] Manage PDF dialog: three-step stepper (Upload PDF, Preview & price, Private link), real upload phases (no fake percentage), free/locked page split, currency and live price, active-link lock notice, link shown once, revoke confirmation (old link stops working), local-only warning
- [x] Dialogs: native modal (focus trap), Escape, focus restoration, body scroll, close button, blocked while saving, values kept after errors, no double submits
- [x] Client page: consistent tokens and layout; secure delivery and "Online payment will be available soon." unchanged; no checkout
- [x] Motion: controls ~150 ms, dialogs ~200 ms, toasts 160–180 ms; no continuous/bouncy animation; reduced motion respected
- [x] Reliability: pre-hydration controls disabled (truthful), Sign out is a progressive server-action form (works without JS), search keeps focus and value, no stale results; tests wait on observable readiness (visible + enabled)
- [x] PDF.js only on the client page; bundle sizes compared before/after
- **Verify** (local stack; all passed, see PHASE_6_UI_SUMMARY.md §7)
  - [x] lint, typecheck, build; pgTAP and all earlier suites (tests updated only where markup changed)
  - [x] `npm run test:ui` (80 checks): desktop, tablet, 390 px, dark OS preference, reduced motion, keyboard/focus, contrast, touch targets, no horizontal scroll, no-JS sign-out
  - [x] Existing local accounts and data unchanged

## Phase 7 — Security, storage cleanup and performance hardening ✅

Details and results: [PHASE_7_HARDENING_SUMMARY.md](PHASE_7_HARDENING_SUMMARY.md).

- [x] Review and prioritize findings (session/outage handling, authorization, public token and preview delivery, uploads, storage lifecycle, privileged key use, caching, hosting delivery)
- [x] Bounded Supabase network waits; "temporarily unavailable" states with retry; no redirect loops; no session changes during outages; fail closed on protected data
- [x] Shared PostgreSQL rate limiter (hashed keys, atomic, fixed windows, bounded retention) on login, link pages, previews, unknown-link lookups, upload/preview actions; documented trusted-proxy configuration
- [x] Storage cleanup utility (dry run by default, `--apply`, ≥ 2 h age, re-check before delete, audit log); upload completion window (1 h)
- [x] Revoke proposal DELETE from application roles (incl. admin); trusted deletion procedure recorded as deferred
- [x] Global security headers and static CSP compatible with Next.js PPR and PDF.js; private/no-store on signed-in pages
- [x] Real PDF fixtures (encrypted RC4/AES user and owner-only, CJK, scanned, 300/301 pages, 19.8/22 MiB) measured; limits unchanged
- [x] Large-preview hosting constraint investigated (streaming keeps instant revocation); verification step added to Phase 9
- [x] `npm audit` reviewed (0 findings); log content audited
- **Verify** (all passed on 27 Oct 2026)
  - [x] lint, typecheck, build; pgTAP 198/198; `npm run test:hardening` 121/121; all earlier suites
  - [x] Existing local accounts, data and CRM services unchanged; no deployment, no payment code
- **Deferred**
  - [x] Trusted proposal deletion: done in the feature update below (owner or admin, refuses with payments, removes storage)
  - [ ] Real-device pass (Safari/iOS, Firefox, Android) and screen-reader pass on the client page
  - [ ] JPEG 2000 / JBIG2 / non-embedded-font real-world PDFs

## Feature update — Team Lead names, private client view, Proposal History ✅

Details and results: [FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md](FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md). Migration `20261031090000_names_history_deletion.sql`.

- [x] `profiles.full_name` as the single display name; own-name edit (column grant + own-row policy, Zod validation); role/id/other profiles not editable
- [x] Existing lead renamed "Team Lead 1" → "Fassih Team Lead" with one guarded single-row update (no accounts created)
- [x] Client page: no internal identity in HTML, RSC payload, headers, metadata or resolver output
- [x] Synthetic, paginated locked-page placeholders; preview vs document page numbers; preview bytes still free-only
- [x] Proposal History tab (status filter, link-issued date, CEO owner filter); RLS-filtered, paginated server queries
- [x] Permanent deletion: mark + revoke → remove folder objects → delete row; frozen, retryable "Deletion pending" state; payment records block deletion; uploads/links/edits refused while deleting
- [x] Link regeneration wording: old links can't be recovered, a new link replaces the previous one
- **Verify** (all passed on 27 Oct 2026)
  - [x] lint, typecheck, build; pgTAP 263/263; `npm run test:history` 100/100; `npm run test:history-browser` 50/50
  - [x] All earlier suites (API, app, dashboard, PDF, client, three browser suites, UI 97/97, hardening 121/121, bundles); `npm audit` 0
  - [x] Existing accounts, the existing proposal and its files unchanged (apart from the requested rename)
- **Deferred**
  - [ ] Retention/archive workflow for proposals with payment records
  - [ ] Real-device and screen-reader pass of the placeholders and dialogs

## Deployment preparation — hosted staging (payments pending)

Guide and results: [HOSTED_STAGING_SETUP.md](HOSTED_STAGING_SETUP.md). Comes before Phase 8; no renumbering.

- [x] Readiness review against current Vercel/Supabase docs (versions, PDF processing, streaming, limits, server-only operations, plan terms)
- [x] Secured cron endpoint `/api/cron/storage-cleanup`: 404 without a 32+ char `CRON_SECRET`, 401 otherwise, dry run unless `STORAGE_CLEANUP_CRON_APPLY=true`, counts only; reuses `runStorageCleanup`
- [x] `vercel.json` (daily cron, Hobby-compatible), `.vercelignore`, `.gitignore` additions, `engines.node` 24.x, `.env.example`
- [x] Public vs server-only variable list; staging configuration steps; provisioning SQL template (no passwords)
- [x] Local verify: lint, typecheck, build, `npm run test:cron` 33/33, earlier suites and pgTAP 263/263 pass, `npm audit` 0
- **Needs account access (not done)**
  - [ ] Dedicated Supabase staging project: identity confirmed, `db push --dry-run` reviewed, migrations applied, Auth configured (signup off, min 12, site URL)
  - [ ] Staging accounts created manually (admin + 2 team leads) with names/roles
  - [ ] Separate Vercel staging project, env vars, `deploy --prod`, cron listed and dry run reviewed
  - [ ] Hosted checks H1–H20, incl. the >4.5 MB preview (H14) and the `x-real-ip` spoof test (H11)
- **Decisions pending:** Vercel plan (Hobby is non-commercial only), Storage file backups, production HSTS

## Phase 8 — Payments and paid access (PayPal)

Guide and results: [PAYPAL_SETUP.md](PAYPAL_SETUP.md). The provider is PayPal Checkout (Orders v2, REST without an SDK). The planned provider-neutral adapter, recovery codes and `access_grants` were replaced by the design in ARCHITECTURE §11.

- [x] Migrations `20261101090000`–`20261101090200`:
  - payments snapshot, browser binding and provider references;
  - entitlements, access sessions, recovery tokens, events and refunds;
  - views `payment_list` and `payment_totals`;
  - purchased-file retention.

  Additive, applied without reset; existing data unchanged.
- [x] Config placeholders, off by default (`PAYMENTS_ENABLED`, `PAYPAL_*`); incomplete config means unavailable, and nothing else breaks.
- [x] Checkout `POST /p/<token>/checkout`:
  - database amount, currency and revision only;
  - attempt persisted before the redirect;
  - idempotent (`PayPal-Request-Id`, reuse of the open attempt);
  - same-origin; rate-limited (fails closed).
- [x] Return, capture and status `POST /purchase/<ref>/status`: session-bound; idempotent capture; lost-response reconciliation; pending, declined, failed and cancelled states.
- [x] Verification:
  - order, purchase unit, `custom_id`, payee merchant, single capture, exact amount and currency;
  - database re-check under a row lock, with monotonic states;
  - mismatch → needs review, no access.
- [x] Webhook `POST /api/payments/webhook`:
  - PayPal signature verification (raw body) before anything is stored;
  - dedupe by event id; unmatched/ignored handling;
  - re-read of the order; 5xx so PayPal retries.
- [x] Refunds (partial keeps access; documented policy) and full refund/reversal (suspends access, record kept).
- [x] Entitlements: purchased revision only; per-browser HttpOnly session; authorized on every full-PDF request (`no-store`); independent of link rotation and document replacement; purchased files retained.
- [x] Client UI: Pay with PayPal, unavailable and unsupported-currency notices, processing/pending/failed/cancelled/declined/completed states, full PDF in the same viewer, white/blue, mobile.
- [x] Recovery: dashboard access link (owner/CEO, single-use, 72 h); email link (payer or client address, single-use, 30 min, GET-safe) behind an isolated email adapter.
- [x] Dashboard Payments tab:
  - CEO sees all and can filter by Team Lead, status and search; leads see only their own (RLS);
  - per-currency totals; pagination;
  - bounded polling that pauses when the tab is hidden.
- [x] Tests: pgTAP `phase9_payments.test.sql` (113); `npm run test:payments` with a PayPal/email test double (135 HTTP checks + 16 browser checks).
- [ ] **Waiting for credentials/external configuration:** PayPal REST app (sandbox, then live), merchant ID, webhook registration and ID, email provider (Resend) and a verified sender domain.
- [ ] **Waiting for real PayPal:** sandbox end-to-end run (approve, capture, webhook, refund, negative tests); one controlled live low-value payment and refund (PAYPAL_SETUP §9).
- **Verify (all checked locally against the test double)**
  - [x] **Successful payment unlocks only the purchased proposal** and only in the paying browser; a forwarded link or purchase URL stays preview-only.
  - [x] Return URL / `?result=return` without a verified capture → no unlock.
  - [x] **Failed/declined** capture → no access; UI shows failure / retry on PayPal.
  - [x] **Pending** capture → no access until completed.
  - [x] **Fake** webhook (bad / missing signature) → rejected, nothing stored.
  - [x] **Mismatched** amount, currency or payee → review, no access.
  - [x] Event for an unknown order → `unmatched`, no access.
  - [x] **Duplicate** deliveries and capture/webhook races → one entitlement.
  - [x] Late `PENDING`/`FAILED` after completion → ignored.
  - [x] Access restored only via a single-use recovery link (email or dashboard), never by typed email or public reference.
  - [x] Full refund / reversal → access ends on the next request.
  - [x] Price or document changed after checkout → the attempt keeps its snapshot; access is to the purchased revision.

## Feature update — Manual Full Access, downloads, multi-format uploads ✅ (local)

Details and results: [FEATURE_FULL_ACCESS_MULTIFORMAT.md](FEATURE_FULL_ACCESS_MULTIFORMAT.md). Migrations `20261102090000`, `20261102090100`.

- [x] "Manage PDF" → "Manage Document"; Preview / Full Access chooser; Full Access warning; optional internal note
- [x] Mode from database state; changes only on drafts; revoke + new token to switch; old token stays invalid; no re-upload
- [x] Grant audit (who, when, revision, note), labelled "Manual full access"; no payment rows; PayPal checkout refused for Full proposals
- [x] Token scope: Preview tokens never reach full routes; Full tokens bound to the granted revision; revoked/deleting unavailable; checked per request
- [x] `/p/[token]/document`, `/download`, `/original`: private streaming, no-store, nosniff, safe filenames, rate limits
- [x] Formats: PDF, TXT (native), DOCX/DOC/ODT/RTF via optional LibreOffice; unsafe-file checks; disabled with a message when no converter
- [x] Source + canonical + preview tracked; cleanup and deletion cover sources; no orphans on failure
- [x] Viewer: wide layout, fit width/page, zoom, page jump, full screen (+ fallback), mobile toolbar, downloads on Full links
- **Verify** (29 Oct 2026)
  - [x] lint, typecheck, build; pgTAP 456/456; `npm run test:full-access` 175/175
  - [x] All earlier suites pass (incl. payments 151/151, UI 97/97, hardening 106/106); real data unchanged
- **Not done / needs a decision**
  - [ ] Real LibreOffice conversion check (DOCX/DOC/ODT/RTF fidelity, fonts, timings) on a machine with LibreOffice
  - [ ] Hosting for conversion (container with memory limit, outbound network denied); not possible on Vercel
  - [ ] Real-device and screen-reader pass of the viewer's full screen and toolbar

## Phase 9 — Deployment (Vercel)

Staging steps and checks: [HOSTED_STAGING_SETUP.md](HOSTED_STAGING_SETUP.md). Repeat them for production with real accounts.

- [ ] Production Supabase project, bucket, migrations applied (`supabase db push`, reviewed first)
- [ ] Env vars set in Vercel (server-only secrets without `NEXT_PUBLIC_`)
- [ ] Create the 6 real accounts manually; set roles
- [ ] Register the PayPal webhook URL (`/api/payments/webhook`); run one real low-value test payment end to end (PAYPAL_SETUP §9–10)
- [ ] Verify preview streaming on the host: stream a preview larger than 4.5 MB from a preview deployment (full byte count, 200) and confirm a revoked link fails on the next request (PHASE_7 §9, OPEN_QUESTIONS Q11)
- [ ] Rate-limit client address: set `RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip` (or the host's equivalent) and confirm a spoofed `X-Forwarded-For` does not change the key
- [ ] Apply migration `20261030090000_phase7_hardening.sql`; schedule `npm run storage:cleanup -- --apply` (dry runs first)
- [ ] HSTS at the edge for the production domain
- [ ] `npm run health` against the hosted Supabase project
- [ ] Make sure the build runs `prebuild` (PDF.js assets in `public/pdfjs/<version>/`) and that `/pdfjs/*` is served
