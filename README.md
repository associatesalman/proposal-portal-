# Editorial Proposal Portal

A small internal portal where team leads upload proposals or editorial reviews (PDF, or DOCX/DOC/ODT/RTF/TXT converted to PDF), generate a unique private link per proposal, and send that link to the client. With a **Preview** link the client reads a limited number of free pages and pays to unlock the full document. With a **Full Access** link (granted manually, e.g. after an off-portal payment) the client reads and downloads the whole document.

## Scope

- **One internal dashboard** for all internal work.
- **Six internal accounts**, all created manually: one CEO/Admin and five Team Leads. There is no public signup.
- **Leads** upload a client's document (PDF, or DOCX/DOC/ODT/RTF/TXT converted to a canonical PDF), choose how many pages are free to preview, set an unlock price and currency, and generate a separate private link for each proposal.
- **Clients** open their link without logging in. Each link shows only its own proposal.
- **Full access** requires either a payment verified on the server, or a manual **Full Access** link that a lead or the CEO issues deliberately (recorded as "Manual full access", never as a payment). A Preview link never sends the original to an unpaid client.
- **Visibility:** the CEO sees all records; each lead sees only their own clients, proposals and payments.

Out of scope: CRM features, extra dashboards, client accounts, AI features, analytics.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4 |
| Linting | ESLint 9 (`eslint-config-next`) |
| Database / Auth / Files | Supabase PostgreSQL, Supabase Auth, private Supabase Storage |
| PDF viewing | `pdfjs-dist` |
| PDF preview generation / page count / TXT to PDF | `pdf-lib` |
| DOCX/DOC/ODT/RTF to PDF | headless LibreOffice, **optional** (`LIBREOFFICE_PATH`; not available on Vercel), see [docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md](docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md) |
| Validation | `zod` |
| Icons | `lucide-react` |
| Deployment (planned) | Vercel |
| Payments | PayPal Checkout, Orders v2 REST API (no SDK); **off until configured**, see [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md) |

Package manager: **npm** (`package-lock.json`). Do not mix in pnpm or yarn. Source code lives in `src/`, and the `@/*` import alias maps to `src/*`.

## Commands

```bash
npm install          # install dependencies
npm run dev          # start dev server at http://localhost:3000
npm run lint         # ESLint
npm run typecheck    # route typegen + TypeScript (tsc --noEmit)
npm run build        # production build
npm run start        # serve the production build

# Local Supabase (requires Docker Desktop)
npm run db:start          # start local stack, apply migrations
npx supabase migration up # apply new migrations without wiping local data
npm run db:reset          # re-apply migrations from scratch (DELETES all local data)
npm run db:test           # pgTAP authorization tests
npm run db:stop
npm run test:integration  # API-level RLS/storage checks (local stack only)
npm run health            # is Supabase (Auth, DB, Storage) and the app reachable? prints no credentials
npm run storage:cleanup   # unreferenced storage objects: dry run by default; `-- --apply` deletes (see PHASE_7 §4)
PDF_FIXTURES_DIR=<dir> npm run test:hardening  # Phase 7: outages, rate limits, cleanup, deletion, real PDFs (own server on 3101)
npm run test:app          # app auth flow checks (needs `npm run start` running)
npm run test:dashboard    # dashboard workflow + tampering checks (needs `npm run start`)
npm run test:pdf          # PDF upload/preview/offer/link checks via real server actions (needs `npm run start`)
CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" \
  npm run test:browser -- <screenshot-dir>       # Phase 3 headless-Chrome UI checks + screenshots
CHROME_PATH="..." npm run test:pdf-browser -- <screenshot-dir>  # Phase 4 Manage Document dialog checks
npm run test:client       # client page + preview delivery checks (needs `npm run start`; SERVER_LOG=<file> adds log checks)
CHROME_PATH="..." npm run test:client-browser -- <screenshot-dir>  # Phase 5 client page / PDF viewer checks
CHROME_PATH="..." npm run test:ui -- <screenshot-dir>              # Phase 6 UI: every flow at desktop/tablet/390 px, dark pref, reduced motion, a11y
CHROME_PATH="..." npm run measure:bundles -- <out-dir>             # JS/CSS sizes (raw + gzip) for /login, /dashboard, /p/[token]
npm run test:cron         # scheduled cleanup endpoint + production headers (own server on :3102; needs `npm run build`)
npm run test:history      # display names, client-page privacy, Proposal History, permanent deletion (needs `npm run start`)
CHROME_PATH="..." npm run test:history-browser -- <screenshot-dir> # name dialog, History filters, delete dialog, locked-page placeholders
npm run test:payments     # Phase 8 payments against PayPal test doubles (own servers)
CHROME_PATH="..." npm run test:full-access -- <screenshot-dir>    # Full Access, downloads, formats, converter adapter, viewer (own servers on :3104/:3105; needs `npm run build`)
```

`npm run dev` and `npm run build` first copy the PDF.js worker and data files into `public/pdfjs/<version>/` (`scripts/copy-pdfjs-assets.mjs`, gitignored).

The app-level suites use `APP_URL` (default `http://localhost:3000`). Run them against a production build, for example `npx next start -p 3100` with `APP_URL=http://localhost:3100`. They create and remove their own disposable users and data.

## Environment setup

1. Copy the template: `cp .env.example .env.local`.
2. Fill in:
   - `NEXT_PUBLIC_APP_URL`: the app's base URL, e.g. `http://localhost:3000`, which is used to build client links.
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: from `npx supabase status` for the local stack, or Supabase **Project Settings → API Keys** for a hosted project.
3. `.env.local` and every other `.env*` file is gitignored. Only `.env.example` is tracked.
   - `SUPABASE_SECRET_KEY` (server-only, since Phase 4): the `SECRET_KEY` from `npx supabase status`, or a hosted project's secret key. It is read by `src/lib/supabase/privileged.ts` for the trusted proposal writes and preview reads, by the rate limiter (`src/lib/security/rate-limit.ts`, only `rate_limit_consume`) and by `scripts/storage-cleanup.mjs`. See [docs/PHASE_4_SUMMARY.md](docs/PHASE_4_SUMMARY.md) §6.
   - Optional: `PDF_MAX_UPLOAD_MB` (default 20, max 25) and `PDF_MAX_PAGES` (default 300).
   - Optional (Phase 7): Supabase timeouts (`SUPABASE_FETCH_TIMEOUT_MS`, `SUPABASE_AUTH_TIMEOUT_MS`), `SUPABASE_SERVER_URL`, and rate limiting (`RATE_LIMIT_*`, including the trusted client-address setting needed in production). See `.env.example` and [docs/PHASE_7_HARDENING_SUMMARY.md](docs/PHASE_7_HARDENING_SUMMARY.md) §3.
   - Optional (server-only): document conversion, `LIBREOFFICE_PATH`, `DOCUMENT_CONVERSION_TIMEOUT_MS`, `DOCUMENT_CONVERSION_CONCURRENCY`. Without `LIBREOFFICE_PATH`, only PDF and TXT uploads are offered. See [docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md](docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md) §7.
   - Optional (Phase 8, server-only): PayPal (`PAYMENTS_ENABLED`, `PAYPAL_*`) and the recovery email provider (`RECOVERY_EMAIL_*`, `RESEND_API_KEY`). Payments stay off until all required values are set. See [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md) §2.
4. Never put secrets in `NEXT_PUBLIC_*` variables. Restart `npm run dev` after changing `.env.local`.

Lint, typecheck and build run without environment values. Signing in needs a configured Supabase project with manually provisioned accounts. See [docs/PHASE_2_SETUP.md](docs/PHASE_2_SETUP.md) for auth settings, migrations, and how to create the Admin and Team Lead accounts.

## Folder structure

```
src/
  app/
    (auth)/login/            # internal login page
    (dashboard)/dashboard/   # the single internal dashboard
    p/[token]/               # client proposal page; preview/ streams the preview PDF,
                             # checkout/ starts PayPal Checkout, recover/ emails an access link;
                             # Full Access links: document/ (inline), download/, original/
    purchase/[ref]/          # PayPal return page + paid view; status/, document/ (full PDF)
    purchase/recover/[token] # single-use access link (+ claim/)
    api/
      proposals/             # internal proposal endpoints
      access/                # reserved (client access ended up under p/ and purchase/)
      payments/webhook/      # PayPal webhook (signature verified with PayPal)
  components/{ui,dashboard,proposals,pdf}/
  lib/{supabase,auth,proposals,pdf,documents,payments,validation}/  # documents/: format detection, safety checks, conversion
  types/
supabase/
  config.toml                # local Supabase config (signup disabled)
  migrations/                # schema, RLS, storage policies
  tests/database/            # pgTAP authorization tests
  tests/integration/         # API, app auth, dashboard and browser checks (local only)
docs/
public/
```

Folders without code yet hold a `.gitkeep`. The app routes so far are `/login`, `/dashboard` and the link destination `/p/[token]`, and `src/proxy.ts` handles session refresh (on `/p/<token>` it only applies the public rate limit). Rate limiting and client-address handling live in `src/lib/security/`, bounded Supabase networking in `src/lib/supabase/fetch.ts`, and operator scripts in `scripts/`. PDF, offer and link logic lives in `src/lib/proposals/`, the setup actions in `src/app/(dashboard)/dashboard/proposal-setup-actions.ts`, and the dialog in `src/components/dashboard/proposal-setup-dialog.tsx`. The dashboard lives in `src/app/(dashboard)/dashboard/` (page and server actions), with its UI in `src/components/dashboard/` and `src/components/ui/`, its queries and URL params in `src/lib/dashboard/`, and its validation in `src/lib/validation/dashboard.ts`. The root `page.tsx` redirects to `/dashboard`. Shared design tokens are in `src/app/globals.css` and shared UI pieces (button/field styles, dialog, brand mark) in `src/components/ui/`.

`api/access/` is an addition to the original folder list. Client document access is authorized by link token + cookie, not by login, so it is kept separate from the internal `api/proposals/` endpoints.

## Documents

- [docs/PHASE_1_CHECKLIST.md](docs/PHASE_1_CHECKLIST.md) — Phase 1 setup record and results
- [docs/PHASE_2_SETUP.md](docs/PHASE_2_SETUP.md) — Supabase setup, migrations, account provisioning, authorization model, verification results
- [docs/PHASE_3_SUMMARY.md](docs/PHASE_3_SUMMARY.md) — internal dashboard: features, migration, usage, verification, limitations
- [docs/PHASE_4_SUMMARY.md](docs/PHASE_4_SUMMARY.md) — PDF upload, preview generation, offer settings, private links: limits, flow, security, tests, manual steps
- [docs/PHASE_5_SUMMARY.md](docs/PHASE_5_SUMMARY.md) — client proposal page, secure preview delivery, PDF.js viewer: authorization, revocation, tests, manual steps, payment-phase needs (written when payments were numbered Phase 6)
- [docs/PHASE_6_UI_SUMMARY.md](docs/PHASE_6_UI_SUMMARY.md) — white & blue UI redesign: design system, changed screens, motion, accessibility, interaction reliability, bundle sizes, verification
- [docs/PHASE_7_HARDENING_SUMMARY.md](docs/PHASE_7_HARDENING_SUMMARY.md) — security review, outage handling, rate limiting, storage cleanup, deletion policy, CSP, real-PDF measurements, hosting findings, verification
- [docs/FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md](docs/FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md) — Team Lead display names, what the client page shows, synthetic locked-page placeholders, Proposal History, permanent deletion (lifecycle, retries, retention), tests, manual steps
- [docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md](docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md) — Manual Full Access workflow, downloads, multi-format uploads and conversion, deployment implications, test results, limitations
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) — scope, user journeys, phases, acceptance criteria
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — responsibilities, routes, PDF/link/payment flows
- [docs/DATABASE_PLAN.md](docs/DATABASE_PLAN.md) — tables, ownership, RLS, storage policies
- [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md) — Phase 8 payments: configuration, webhook registration, tunnel testing, recovery email, payment-link compatibility, refund policy, first real transaction, deployment, and what is verified vs. waiting for PayPal
- [docs/HOSTED_STAGING_SETUP.md](docs/HOSTED_STAGING_SETUP.md) — deployment preparation: readiness review, env vars (public vs server-only), hosted Supabase + Vercel staging steps, cron cleanup, logs, backups, hosted checks, costs
- [docs/IMPLEMENTATION_CHECKLIST.md](docs/IMPLEMENTATION_CHECKLIST.md) — ordered tasks and verification
- [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) — unresolved decisions

## Current status

**Feature update: Manual Full Access, document download and multi-format uploads is built and tested locally (not deployed; PayPal still off).** See [docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md](docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md).

- **Manage Document:** this replaces "Manage PDF" and offers two modes.
  - **Preview / Locked:** unchanged.
  - **Full Access:** all pages, downloads, no price or paywall; one-page documents allowed.
  - **Switching modes** means revoking and generating a new link, and no re-upload is needed.
  - **Each grant is recorded** with who, when, the revision and an optional internal note. It is labelled "Manual full access", never a payment.
- **Formats:** PDF and TXT always. DOCX/DOC/ODT/RTF only when LibreOffice is configured on the server, which isn't possible on Vercel. Macros, external references, encrypted files and mismatched or unsafe files are refused.
- **Viewer:** wider; fit width/page, zoom, page jump, full screen, mobile toolbar. Full Access links offer Download PDF and Download original.
- **Verification:**
  - pgTAP 456/456; `npm run test:full-access` 175/175; every earlier suite passes.
  - **Real LibreOffice conversion is not verified:** LibreOffice isn't installed here, so the adapter was tested with a test double.

Earlier status (payments):

**Phase 8 (payments) is built and tested locally against PayPal test doubles. It is not connected to PayPal, and payments stay off until configured.** See [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md).

- **Done locally:**
  - PayPal Checkout (Orders v2): create and capture, bound to the paying browser.
  - Signature-verified webhooks.
  - Verified unlock of the purchased PDF revision.
  - Refunds and reversals.
  - Access recovery (dashboard link; email adapter).
  - Dashboard Payments tab.
  - Tests: pgTAP 376/376 (113 new), `npm run test:payments` 151/151 (with Chrome), and every earlier suite still passes.
- **Waiting for you:** PayPal REST credentials, merchant ID and webhook registration; an email provider for email recovery; a sandbox test, then one controlled live payment ([PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md) §9).

Earlier status (deployment preparation):

**Deployment preparation (hosted staging) is prepared locally; nothing is provisioned or deployed yet.** Payments are still pending. See [docs/HOSTED_STAGING_SETUP.md](docs/HOSTED_STAGING_SETUP.md).

- **Done locally:** readiness review against current Vercel/Supabase docs; a secured, dry-run-by-default cleanup endpoint for Vercel Cron (`/api/cron/storage-cleanup`, `vercel.json`); `.vercelignore`; `engines.node` 24.x; env documentation; a provisioning SQL template; `npm run test:cron` 33/33, and every earlier suite still passes.
- **Needs your accounts:** a dedicated Supabase staging project and a separate Vercel staging project (no CLI login or tokens exist on this machine). No hosted check has been run.
- **Decisions for you:** Vercel Hobby is non-commercial only (Pro is $20 per member per month); the >4.5 MB preview streaming must be measured on staging.
- The portal is not launched. Payments are built but not connected to PayPal (see above).

Feature update (Team Lead names, private client view, Proposal History) is complete.
See [docs/FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md](docs/FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md).

- **Display names:** `profiles.full_name` is the one display name (header, CEO filter, Owner columns). Each internal user can change their own name with **Edit name**. The database allows updating only that column of their own row, never the role or anyone else's profile. The existing lead is now "Fassih Team Lead".
- **Client page:** shows only the title, preview, page counts, price and the payment notice. No Team Lead identity, ids, paths or history (checked in HTML, RSC payload, headers and resolver output). Locked pages appear as synthetic, paginated "Locked page" placeholders; the preview PDF still contains only the free pages.
- **Proposal History:** a new dashboard tab with drafts and issued proposals, a status filter, link-issued dates and (CEO) an owner filter. Team Leads see only their own rows, filtered in the database.
- **Permanent deletion:** from History, with a confirmation naming the proposal and client. The workflow marks the proposal and revokes its link first, removes its storage objects, then deletes the row. Failures leave a hidden, frozen "Deletion pending" state that can be retried. Proposals with payment records are refused.
- **Verification:** pgTAP 263/263, new suites 100/100 and 50/50, every earlier suite passes (UI 97/97, hardening 121/121).
- **Not started:** payments (Phase 8) and deployment (Phase 9).

Phase 7 (security, storage cleanup and performance hardening) is complete. See [docs/PHASE_7_HARDENING_SUMMARY.md](docs/PHASE_7_HARDENING_SUMMARY.md).

- **Outages:** Supabase waits are bounded. Pages show "Service temporarily unavailable" with a retry instead of hanging (~52 s before) or redirecting, actions say nothing was saved, and sessions are never changed by an outage.
- **Rate limiting:** a shared PostgreSQL limiter with hashed keys covers sign-in, client links, previews, unknown-link lookups and the expensive upload/preview actions, with clear retry messages and `Retry-After`.
- **Storage:** `npm run storage:cleanup` (dry run by default) removes unreferenced old objects safely; current local data has none.
- **Deletion:** no application role can delete proposals directly. The trusted deletion workflow followed in the feature update above.
- **Headers:** a static CSP and security headers that work with PPR and PDF.js.
- **PDFs:** real encrypted PDFs are rejected; CJK, scanned, 300-page and near-20 MiB files were measured with a wide margin.
- **Verification:** pgTAP 198/198, the new hardening suite 121/121, and every earlier suite passes.
- **Not started:** payments (now Phase 8) and deployment (Phase 9).

Phase 6 (UI redesign) delivered the white & blue design. See [docs/PHASE_6_UI_SUMMARY.md](docs/PHASE_6_UI_SUMMARY.md).

- **Design:** a single white & blue theme (#2563EB accent, slate text, #E2E8F0 borders) that stays light whatever the OS colour scheme, with shared tokens and UI pieces. There are no UI libraries or runtime font downloads.
- **Screens:** a focused login with show/hide password; a dashboard with a header, real summary cards, tabs with counts, a toolbar, tables that become cards on phones, and pagination; a three-step Manage PDF dialog (Upload PDF → Preview & price → Private link); a refined client page. Behaviour, permissions and data are unchanged.
- **Reliability:** controls that need JavaScript stay visibly disabled until the page is interactive. Sign out works before hydration and without JavaScript (server-action form). Dialogs block Escape/Close while saving, and the search keeps focus and value.
- **Verification:** lint, typecheck, build, pgTAP 156/156, API 34/34, app 17/17, dashboard 38/38, PDF/link 72/72, client 70/70, browser 28/28, PDF dialog 27/27, client viewer 64/64, and the new UI suite 80/80.
- **Not started:** payments and full-document unlock (now Phase 7). No hosted Supabase project has been configured, and nothing is deployed.

Phase 5 delivered the client proposal page and secure PDF preview viewer: the client proposal page and secure PDF preview viewer. See [docs/PHASE_5_SUMMARY.md](docs/PHASE_5_SUMMARY.md).

- **Client page (`/p/[token]`, no login):** the title; "Free preview: X of Y pages."; preview, total and locked page counts; a PDF.js viewer limited to the free preview pages; the locked-page notice with the formatted unlock price; and "Online payment will be available soon." It has a white/blue style and leaks no ids, client details, paths or hashes.
- **Preview delivery:** `GET /p/[token]/preview` re-checks the token in the database on every request and streams only that proposal's preview PDF from the private bucket. Revocation blocks the next request, and the original is never served.
- **Viewer:** pdfjs-dist is loaded on demand, with its worker served locally. It has page navigation, zoom from 50 to 300 %, fit width, a selectable text layer, keyboard support, mobile layout, and loading/error/retry states.
- **Verification at the end of Phase 5:** pgTAP 156/156, API 34/34, app 17/17, dashboard 38/38, PDF/link 72/72, client 70/70, browser suites 28/28 (Phase 3), 27/27 (Phase 4) and 64/64 (Phase 5).

Phase 4 delivered PDF upload, server-side verification, preview PDF generation, offer settings and private links. See [docs/PHASE_4_SUMMARY.md](docs/PHASE_4_SUMMARY.md).

- **Manage PDF dialog:** upload a PDF straight to private storage, and the server verifies the real bytes (PDF header, pdf-lib parse, no encryption, 2–300 pages, ≤ 20 MiB). Set free preview pages (1 ≤ free < total), currency and price. The server builds a separate preview PDF with only pages 1..N.
- **Private links:** a 256-bit token, stored only as a SHA-256 hash and shown once. Generating a link makes the proposal Active and locks it. Revoking returns it to Draft, and regenerating creates a new link.
- **Integrity:** immutable revision paths, compare-and-swap writes in `SECURITY DEFINER` functions, database invariants, and no browser-writable status, paths, page counts or offer columns.

Phase 3 delivered the internal dashboard, client management and draft proposal records:

- **Database (Phases 2–3):** SQL migrations for `profiles`, `clients`, `proposals` and `payments`, with RLS on every table and least-privilege grants. A private `proposals` storage bucket has policies tied to proposal ownership. Phase 3 adds a forward migration that allows drafts without offer fields, locks a proposal's client, and adds read-only list views that respect RLS.
- **Auth:** email/password login via Supabase Auth with no public signup, plus sign out. Users without an internal profile are denied.
- **Dashboard (`/dashboard`):** overall totals, Clients and Proposals tabs with search and pagination, dialogs to add and edit clients and to create and rename draft proposals. Team leads see only their own records. The CEO/Admin sees everything, can filter by team lead, and creates records on behalf of a lead.
- **Verification at the end of Phase 3:** see [docs/PHASE_3_SUMMARY.md](docs/PHASE_3_SUMMARY.md).

## Upcoming phases

| Phase | Scope |
| --- | --- |
| 8 | Payments (PayPal): **built locally**; connect credentials, register the webhook, run sandbox and one live test ([PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md)) |
| 9 | Production deployment (Vercel), building on the staging preparation in [HOSTED_STAGING_SETUP.md](docs/HOSTED_STAGING_SETUP.md) |

Phase 6 became the UI redesign, and Phase 7 became hardening (done before payments), so payments is now Phase 8 and deployment Phase 9. Hosted staging preparation was done before payments without renumbering. Earlier phase documents keep the numbering of their time.
