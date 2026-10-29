# Architecture

## 1. Responsibilities

| Layer | Responsible for | Never does |
| --- | --- | --- |
| **Browser (dashboard)** | Forms, dialogs, direct upload of the PDF to a server-issued signed upload URL, copying links | Decide roles or ownership, hold the service-role key, compute prices or tokens |
| **Browser (client page)** | Render preview/full PDF with PDF.js from short-lived URLs, start checkout, submit recovery code | Receive the original PDF before payment is verified, decide payment status |
| **Next.js server** (Server Components, Server Actions, Route Handlers, `proxy.ts`) | Auth session checks, validation (Zod), PDF validation and preview generation (pdf-lib), token generation, signed URL issuing, payment provider calls, webhook verification, access-grant/cookie logic | Trust client-supplied price, currency, owner, role or payment status |
| **Supabase Postgres** | Source of truth. RLS enforces ownership for authenticated (internal) users. Constraints enforce uniqueness and idempotency | Expose any table to the `anon` role |
| **Supabase Storage** | Two private buckets: originals and previews. Storage policies scope internal users by owner folder | Serve public URLs |
| **Payment provider** | Hosted checkout, signed webhooks / verification API | Be trusted without signature + amount/currency/reference verification |

### Supabase clients (planned in `src/lib/supabase/`)

- **Browser client** (publishable key + user session): dashboard reads/writes, all limited by RLS.
- **Server client** (`@supabase/ssr`, cookie-based user session): Server Components and Actions acting *as the logged-in user*, still subject to RLS.
- **Service-role client** (server-only module, `SUPABASE_SERVICE_ROLE_KEY` — added to `.env.example` only when the first feature needing it is built): used only for (a) token-based client page lookups, (b) webhook processing and grant creation, (c) signed URLs for client document access. Every use runs after an explicit server-side check. The module must never be imported into client components; the plan is to mark it with `import "server-only"`.
  - **As built (Phases 4–5):** `src/lib/supabase/privileged.ts` with `SUPABASE_SECRET_KEY`. It has exactly five operations:
    - four trusted proposal writes;
    - streaming the preview of the proposal a client token resolves to.
  - Client page lookups don't need it: they use the anon-callable `resolve_proposal_offer()` with the publishable key.

## 2. Routes (planned; payment routes as built)

| Route | Type | Auth | Purpose |
| --- | --- | --- | --- |
| `/` | page | — | Redirect to `/dashboard` or `/login` |
| `/login` | page `(auth)` | public | Email/password sign-in |
| `/dashboard` | page `(dashboard)` | internal user | The single internal page |
| `/p/[token]` | page | token | Client proposal page (preview / paid view / recovery) |
| `/api/proposals/...` | route handlers or Server Actions | internal user | Create signed upload URL, finalize upload (validate, count pages, build preview), regenerate token, issue recovery code |
| `/api/access/[token]/preview` | route handler | token | Return a short-lived signed URL for the preview PDF. **Built in Phase 5 as `GET /p/[token]/preview`, which streams the preview bytes** (§5) |
| `/p/[token]/checkout` | route handler (POST) | token + same origin | **Built (Phase 8).** Starts PayPal Checkout for the link's proposal; binds it to the browser's HttpOnly session cookie (§11) |
| `/p/[token]/recover` | route handler (POST) | token + same origin | **Built (Phase 8).** Emails a single-use access link when the address matches a purchase (needs an email provider) |
| `/p/[token]/document` | route handler (GET) | Full Access token | **Built (feature update).** Canonical PDF, inline, for the viewer (§12) |
| `/p/[token]/download` | route handler (GET) | Full Access token | **Built.** Canonical PDF as an attachment ("Download PDF") |
| `/p/[token]/original` | route handler (GET) | Full Access token | **Built.** Original DOCX/DOC/ODT/RTF/TXT as an attachment ("Download original"); 404 for PDF sources |
| `/purchase/[ref]` | page | browser session | **Built (Phase 8).** PayPal return/cancel page and the paid view; only for the browser that paid (or recovered) |
| `/purchase/[ref]/status` | route handler (POST) | browser session + same origin | **Built (Phase 8).** Capture / refresh / cancel; grants access to the paying browser |
| `/purchase/[ref]/document` | route handler (GET) | browser session | **Built (Phase 8).** Streams the purchased revision; authorized on every request |
| `/purchase/recover/[token]` + `/claim` | page + route handler (POST) | single-use token + same origin | **Built (Phase 8).** Shows, then redeems, an access link |
| `/api/payments/webhook` | route handler (POST) | PayPal signature (verified by PayPal's API) | **Built (Phase 8).** Triggers re-verification of the order |

Dashboard mutations may use Server Actions instead of `/api/proposals` handlers. Either way, they re-check the session and rely on RLS. `src/proxy.ts` refreshes the Supabase session and redirects unauthenticated requests for `/dashboard` to `/login`. Real authorization still happens in the server code and RLS, not only in the proxy.

## 3. Private link (token) design

- Token: 32 bytes from a cryptographically secure RNG, encoded base64url (~43 chars), so ~256 bits of entropy. It is generated on the server for every proposal, so the same lead uploading multiple proposals always gets distinct tokens. A unique DB constraint guarantees no collision.
- Link format: `${NEXT_PUBLIC_APP_URL}/p/<token>`.
- The token is stored on the proposal row so the dashboard can show "Copy link" repeatedly. The proposals table is never readable by `anon`. The server resolves tokens with the service-role client after validating the token format with Zod.
- Every failure (bad format, unknown, disabled, deleted) returns the same generic response. This avoids revealing whether a token exists.
- Disable/regenerate controls are available on the dashboard.
- Client pages send `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` (so the token does not leak via Referer to third parties), and `Cache-Control: private, no-store`.
- **Limitation (documented to users):** the link is a bearer credential. Anyone holding it sees the free preview. It proves possession, not identity.

## 4. Upload and PDF preview flow

Vercel serverless functions limit request bodies (~4.5 MB). Large PDFs therefore go **directly from the browser to Supabase Storage** instead of through a Next.js function.

1. The lead saves the proposal metadata → server creates a `proposals` row in `draft` status, owned by the lead.
2. The server issues a signed **upload** URL for `originals/<owner_id>/<proposal_id>/original.pdf`.
3. The browser uploads the PDF to that URL.
4. The browser calls "finalize". On the server (Node runtime):
   - Re-checks that the user owns the proposal (or is admin).
   - Downloads the original from storage using server credentials.
   - Validates: size ≤ limit, starts with `%PDF-`, loads in pdf-lib, is not encrypted/password protected, and has ≥ 1 page.
   - Records `page_count` from pdf-lib.
   - Validates `1 ≤ free_pages ≤ page_count` (Zod + DB check constraint).
   - Builds the preview: a **new** `PDFDocument` with only pages `0..free_pages-1` copied in via `copyPages`. Outline, attachments, form data and metadata from the original are not carried over.
   - Uploads the result to `previews/<owner_id>/<proposal_id>/preview.pdf`.
   - Generates the token if absent and sets status `active`.
   - On any failure, deletes the uploaded object and keeps the proposal in `draft` with an error message.
5. Changing `free_pages` later regenerates the preview (blocked after a successful payment).

## 5. Client document access

> **As built in Phase 5** (see [PHASE_5_SUMMARY.md](PHASE_5_SUMMARY.md)):
> - The page resolves the token with the anon-callable `resolve_proposal_offer()`. It returns title, page counts, price and currency only.
> - The preview is **streamed through the app** from `GET /p/[token]/preview`, not delivered as a signed URL. Every request re-checks the token in the database, so a revoked link stops working on the very next request, and no storage URL ever reaches the browser.
>   - The trade-off is the hosting platform's function response-size limit, to be verified at deployment (Phase 9). The fallback is a ~60 s signed URL issued after the same check.
> - The viewer is PDF.js (`pdfjs-dist`). It is loaded on demand, and its worker and data files come from `public/pdfjs/<version>/`.
> - The full-document route and paid-access state are Phase 7 (payments).
>
> The planned design follows.

- `/p/[token]` (Server Component) resolves the proposal and loads only safe fields: title, page_count, free_pages, price, currency, and paid-access state for *this* browser.
- **Preview:** the viewer requests `/api/access/[token]/preview`, which returns a signed URL for the preview object, valid ~60 s. PDF.js loads it.
- **Full document:** the viewer requests `/api/access/[token]/document`. The server checks that the paid-access cookie is valid for this proposal's id and that the grant is not revoked, then returns a signed URL for the original, valid ~60 s. Otherwise it returns 403. An unpaid browser never receives the original path or URL.
- The server responds with signed URLs rather than streaming bytes through the function, which avoids Vercel response size limits. The URLs are short-lived and per-request.
- **Accepted limitation:** once a client has paid and opened the full PDF, they can save and redistribute it. Preventing that requires DRM or watermarking, which is out of scope (watermarking listed in OPEN_QUESTIONS).

## 6. Paid access without client accounts

> **Superseded (Phase 8).** This section and §7 are the provider-neutral plan written before PayPal was chosen. The built design (no recovery codes, no access grants table, browser sessions instead of a checkout nonce) is in §11 and [PAYPAL_SETUP.md](PAYPAL_SETUP.md).

Two server-side records do the work: a **payment** (one checkout attempt) and an **access grant** (created once per succeeded payment). The browser holds an **access cookie**.

### 6.1 Binding the paying browser

1. `POST /api/payments/checkout` with the token. The server:
   - Resolves the proposal and refuses if the link is disabled or there is no preview.
   - Creates a `payments` row with status `created`, with **amount and currency copied from the proposal row** (never from the request).
   - Generates a random `checkout_nonce`, stores only its hash on the payment, and sets it in an `httpOnly`, `Secure`, `SameSite=Lax` cookie scoped to `/` with a short lifetime (e.g. 24 h).
   - Calls the provider adapter's `createCheckout` with `merchant_reference = payments.id`, plus amount, currency, description, return URL and cancel URL.
   - Returns the provider redirect URL.
2. The provider redirects back to `/p/<token>?payment=<payments.id>`. The page polls `/api/access/[token]/status`.

### 6.2 Claiming the grant

`/status` checks the payment's server-side state. If the state is still pending/created and the webhook hasn't arrived, it may call the provider verification API. The redirect itself proves nothing. Once the payment is `succeeded` **and** the request carries the matching `checkout_nonce` cookie:

- Look up the access grant created for that payment.
- If the grant hasn't been claimed yet, generate a recovery code (e.g. 10 random characters, grouped), store only its hash (a slow hash, or an HMAC with `ACCESS_SESSION_SECRET`), and show the plaintext **once**.
- Set the paid-access cookie: `httpOnly`, `Secure`, `SameSite=Lax`, holding a value signed with `ACCESS_SESSION_SECRET` that encodes `{grant_id, proposal_id, issued_at}`, with a long expiry (e.g. 180 days; pending decision).
- Clear the checkout cookie.

A forwarded link opened in another browser has neither cookie, so it sees only the preview.

### 6.3 Recovery on another device

`POST /api/access/[token]/recover` with `{email, code}`:

- Find non-revoked grants for this token's proposal whose buyer email matches (case-insensitive) and whose code hash verifies.
- On success, set the paid-access cookie. On failure, return a generic error.
- Rate-limit per token and per IP (e.g. 5 attempts / 15 min), and record failed attempts.

Fallback: the lead or admin clicks "Issue new recovery code" on the dashboard. This replaces the hash and shows the new code once. The lead sends it to the client manually.

Grants can be revoked from the dashboard (e.g. after a refund). Revocation invalidates every cookie and code for that grant, because each request re-checks the grant row.

## 7. Payment verification flow (provider-neutral)

### 7.1 Adapter interface (planned in `src/lib/payments/`)

- `createCheckout(input) → { redirectUrl, providerCheckoutRef }`
- `verifyWebhook(rawBody, headers) → NormalizedEvent | Invalid` — signature / shared-secret check per provider docs
- `fetchPayment(providerRef) → NormalizedPayment` — server-to-server verification API
- `NormalizedEvent`: `{ providerEventId, providerPaymentId, merchantReference, status: 'pending'|'succeeded'|'failed'|'cancelled'|'refunded', amountMinor, currency, occurredAt }`

A `fake` adapter for local development and tests implements the same interface. Gateway-specific code goes in one adapter file once the provider is known. **No SDK is installed until then.**

### 7.2 Webhook handling

1. Read the **raw** body (needed for signature checks). Verify the signature. If invalid → respond 400/401 and store nothing that can affect state (optionally log the rejection).
2. Insert into `payment_events` with unique `(provider, provider_event_id)`. If it already exists → respond 200 and stop (**idempotent replay**).
3. Find the payment by `merchant_reference` (= `payments.id`), falling back to `provider_payment_id`. If not found → mark the event `unmatched` and respond 200.
4. Verify that the event's amount and currency equal the payment's stored values, and that the payment's proposal is the one the payment was created for. On mismatch → mark the event `mismatch`, flag the payment for review, **do not unlock**, and respond 200.
5. When the provider supports it, confirm via `fetchPayment` before treating a payment as `succeeded` (defense-in-depth; pending decision per provider).
6. Apply the status transition in a single DB transaction with a row lock on the payment:
   - Allowed: `created → pending | succeeded | failed | cancelled`, `pending → succeeded | failed | cancelled`, `succeeded → refunded`.
   - Disallowed transitions (e.g. `succeeded → failed` from a late event) are recorded but ignored.
7. On the first transition to `succeeded`, insert one `access_grants` row (unique on `payment_id`). Duplicate deliveries hit the unique constraint and become no-ops.
8. On `refunded`, revoke the grant (policy pending).
9. Respond 2xx quickly. Processing stays small enough to finish inline.

### 7.3 Rules

- Never unlock based on the redirect URL, query string or client-side status.
- Amount, currency and proposal always come from the DB payment row, which was created from the proposal row.
- One succeeded payment unlocks exactly one proposal (`access_grants.proposal_id = payments.proposal_id`).
- If the price changes while a checkout is open, the payment keeps its original amount, and any mismatched event is rejected. Price changes are locked after the first successful payment.
- If a second payment succeeds for the same proposal (e.g. the same client paid twice), it creates its own grant. It is flagged on the dashboard for manual refund handling.

## 8. Security notes

- Secrets (`SUPABASE_SECRET_KEY`, `RATE_LIMIT_KEY_SECRET`, and later `ACCESS_SESSION_SECRET`, `PAYMENT_*`) are server-only and never use the `NEXT_PUBLIC_` prefix.
- Inputs are validated with Zod at every server boundary: tokens, IDs, page counts, prices (integer minor units > 0), and ISO 4217 currency codes from an allow-list.
- Supabase public sign-up is disabled in project settings.
- Internal sessions use Supabase SSR cookies. The proxy refreshes them, and every server mutation calls `getUser()` (not just `getSession()`) before acting.

## 9. Hardening (Phase 7)

Details: [PHASE_7_HARDENING_SUMMARY.md](PHASE_7_HARDENING_SUMMARY.md).

- **Bounded Supabase networking** (`src/lib/supabase/fetch.ts`): every server-side client waits at most `SUPABASE_FETCH_TIMEOUT_MS` for response headers (bodies may stream), and auth calls get a `SUPABASE_AUTH_TIMEOUT_MS` deadline after which the client's auth requests are closed (no late token rotation).
- **Auth states:** `authorized`, `unauthorized` (no profile), `anonymous`, and `unavailable` (Supabase unreachable). `unavailable` never redirects and never changes cookies; protected data is not loaded (fail closed). The proxy passes an internal `x-portal-auth-unavailable` request header (client copies are stripped; it can only deny).
- **Rate limiting** (`src/lib/security/`): `public.rate_limit_consume` in Postgres, HMAC-hashed keys, fixed windows. Login and public links fail open if the limiter is down; expensive internal actions fail closed. The client address comes from a trusted edge header or a trusted-hop count.
- **Public links:** `/p/<token>` is rate-limited in `src/proxy.ts` (429 + Retry-After); the preview route limits per address and per link; lookups of unknown links have their own per-address limit that never blocks valid links.
- **Storage lifecycle:** uploads must be completed within 1 hour; `scripts/storage-cleanup.mjs` removes unreferenced objects older than at least 2 h (default 24 h) after a database re-check, with an audit log.
- **Deletion:** `DELETE` on `proposals` is revoked from `anon` and `authenticated`. Rows are deleted only by the trusted workflow in §10.
- **Headers:** static CSP ("Without Nonces", compatible with PPR) with `'wasm-unsafe-eval'` for PDF.js, `frame-ancestors 'none'`, nosniff, Referrer-Policy, Permissions-Policy and COOP; signed-in pages are `private, no-store`.
- **Large previews:** streamed through the app. Vercel's 4.5 MB limit applies to buffered bodies, and Vercel's guidance says streamed responses don't have it. Signed URLs are not used, so revocation stays immediate.

## 10. Display names, History and deletion (feature update)

Details: [FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md](FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md).

- **Display names:** `profiles.full_name`, read by `getInternalUser` and the list views. `updateDisplayNameAction` writes only the signed-in user's own `full_name` through the RLS client; the database grants nothing else.
- **Client page:** the page and `resolve_proposal_offer` carry no owner data. Locked pages are `LockedPagePlaceholders`, generated from the counts only (no request, no rendering of locked content).
- **Proposal History:** `/dashboard?tab=history[&status=…][&owner=…]`, built on `proposal_list` (RLS, `security_invoker`), paginated in the database.
- **Deletion:**

  ```text
  deleteProposalAction (dashboard/actions.ts)
    ├─ getUser + profile, Zod id, load via RLS client (else "not found"), per-user rate limit
    └─ privileged.deleteProposalPermanently
         1. rpc proposal_begin_deletion  → mark, revoke link, draft (PT412 if payments)
         2. rpc proposal_deletion_objects → names under {owner}/{id}/  → storage.remove (repeat until empty)
         3. rpc proposal_finish_deletion → delete row (PT409 if objects remain, PT412 if payments)
  ```

  A marked proposal is frozen by trigger (`PT410`), never active (check constraint), refused by every trusted writer and the upload policy, and shown as "Deletion pending" with a retry. Late uploads through a signed URL issued before deletion land in the deleted proposal's folder and are removed by the storage cleanup utility.

## 11. Payments as built: PayPal Checkout (Phase 8)

Setup, behaviour, policies and what is verified: [PAYPAL_SETUP.md](PAYPAL_SETUP.md). Code: `src/lib/payments/`, `src/lib/supabase/privileged-payments.ts`, the routes in §2, migrations `20261101090000`–`20261101090200`.

- **Provider calls** (`paypal.ts`): REST without an SDK. OAuth client credentials; Orders v2 create, capture and show, each with `PayPal-Request-Id` (idempotent); and `verify-webhook-signature` with the raw body. Every call has a 15 s deadline, and only the status, issue code and debug id are logged.
- **Browser session** (`browser-session.ts`): a random 256-bit secret in an HttpOnly, SameSite=Lax cookie (`__Host-` and Secure on https). The database stores only its SHA-256. A checkout is bound to it, and access sessions are granted to it. Forwarding a link never forwards the cookie.
- **Checkout:** a same-origin POST with the token as the only input. In one transaction the database writes the attempt with the database price and currency, the immutable revision path and snapshots. Then the PayPal order is created and its id stored. Only then is the browser redirected.
- **Verification:** `verify.ts` evaluates the order (references, payee, one capture, exact amount and currency), and `payment_apply_state` re-checks it under a row lock with monotonic transitions. A mismatch flags the payment for review and grants nothing. Webhooks only trigger a re-read of the order (reversals can only remove access).
- **Access:** an entitlement per verified payment (purchased revision and pages), plus per-browser access sessions (checkout or recovery). The full PDF is authorized on every request and streamed `no-store`. It is independent of link rotation and of later document replacement.
- **Recovery:** single-use, expiring tokens (hash stored). They are issued by email to the payer or client address, or from the dashboard by the owner or CEO. A GET only shows the token; a same-origin POST redeems it.
- **Dashboard:** Payments tab (`payment_list` / `payment_totals`, security-invoker views under RLS). It shows summary amounts per currency, filters, pagination, and bounded auto-refresh that pauses when the tab is hidden.
- **Off by default:** without complete configuration, checkout and webhook answer 503 and the client page shows "Online payment will be available soon."

## 12. Access modes, downloads and multi-format uploads (feature update)

Details, workflow and results: [FEATURE_FULL_ACCESS_MULTIFORMAT.md](FEATURE_FULL_ACCESS_MULTIFORMAT.md). Migrations `20261102090000_access_modes_multiformat.sql`, `20261102090100_full_access_grant_names.sql`.

- **Modes:** `proposals.access_mode` is `preview` (default; free pages + locked pages + optional PayPal) or `full` (manual Full Access).
  - It can change only on a draft (`proposal_set_access_mode`).
  - `proposal_issue_link` issues Preview links only; `proposal_issue_full_link` issues Full links only and records a row in `proposal_full_access_grants`.
  - The server action picks the function from the database row, never from the browser.
- **Resolvers:**
  - `resolve_proposal_offer` and `resolve_proposal_preview_object` answer only for Preview links.
  - `resolve_proposal_full_access` (page data) and `resolve_proposal_full_object` (service role; paths) answer only for Full links. They need an open grant bound to the current canonical PDF.
  - `src/lib/proposals/resolve-link.ts` calls both and renders the matching page.
- **Delivery:** `src/lib/proposals/full-delivery.ts` re-resolves the token on every request and streams from the private bucket.
  - Headers: `no-store`, `nosniff`, `no-referrer`, CORP same-origin, `noindex`, and a `Content-Disposition` built from the sanitized title.
  - Rate limits: `link_document_*` and `link_download_*`.
- **Uploads:** the browser uploads the source to `<owner>/<proposal>/<revision>/source.<ext>`, or `original.pdf` for PDFs, with a server-issued ticket. The server then:
  1. downloads it and checks the bytes (`src/lib/documents/inspect.ts`: magic bytes, ZIP/CFB structure, macros, external references, encryption, bombs);
  2. converts it (`txt.ts` natively; `libreoffice.ts` for DOCX/DOC/ODT/RTF);
  3. verifies the PDF, uploads `original.pdf` and records both through `proposal_attach_document`.

  On failure, both files are removed and the previous document stays.
- **Converter:** headless LibreOffice, spawned without a shell, in an isolated temp workspace with a hardened throw-away profile and a minimal environment. It is bounded by a timeout (process-tree kill), an output cap and a concurrency semaphore. It is optional (`LIBREOFFICE_PATH`) and unavailable on Vercel; when it is missing, those formats are disabled with a message.
- **Viewer:** `src/components/proposals/preview-viewer.tsx`
  - fit width / fit page / zoom, page jump;
  - Fullscreen API with a fixed-overlay fallback;
  - download buttons only when the page passes them (Full links).
