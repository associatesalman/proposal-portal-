# Project Plan — Editorial Proposal Portal

## 1. Purpose

Team leads upload PDF proposals or editorial reviews, generate one private link per proposal, and send that link to the client manually. The client reads a limited free preview and pays to unlock the complete document. Payment is verified on the server before anything is unlocked.

## 2. Functional scope

### In scope

| Area | What it does |
| --- | --- |
| Internal login | Email/password via Supabase Auth. Accounts created manually. No signup, no public password-reset UI beyond Supabase's standard flow (see OPEN_QUESTIONS). |
| Roles | `admin` (CEO, 1 account) and `team_lead` (5 accounts). |
| Dashboard | One page: summary counts, client/proposal list, add/edit dialogs, PDF upload, free-page count, price + currency, copy link, payment/unlock status. |
| Clients | Name + email records owned by a team lead. |
| Proposals | Title, client, uploaded PDF, free page count, price, currency, private link, link enabled/disabled. |
| Client page | `/p/<token>`: preview viewer, price, "Unlock full document" button, "Already paid? Restore access", full viewer once paid. |
| Payments | Provider-neutral checkout + server-verified confirmation (webhook and/or verification API). |
| Paid access | Payment-linked access grant, browser cookie session, recovery code for other devices/browsers. |

### Out of scope

CRM pipelines, multiple dashboards, client accounts/login, AI features, automated emailing of links, analytics, multi-tenant/organization support, invoicing, refunds UI (refunds are handled in the provider console; see OPEN_QUESTIONS), DRM.

## 3. Roles and access rules

| Capability | Admin (CEO) | Team Lead | Client (link holder) |
| --- | --- | --- | --- |
| Log in to dashboard | Yes | Yes | No |
| View clients/proposals/payments | All | Own only | — |
| Create/edit clients and proposals | All | Own only | — |
| Change any role | Only via Supabase admin (manual) | Never | — |
| View preview of a proposal | Via dashboard | Own via dashboard | Only the proposal for their token |
| View full document | Via dashboard | Own via dashboard | Only after verified payment for that proposal |
| Browse other proposals | — | — | Never |

**Important:** a private link is a bearer link. Whoever holds the link can view the free preview. The link does not verify the client's identity. The paid document requires a separate paid-access session (see ARCHITECTURE §6), so forwarding the link alone does not hand over the paid document.

## 4. User journeys

### 4.1 Team lead — create and share a proposal

1. Log in at `/login` → redirected to `/dashboard`.
2. Click "New proposal". In one dialog: pick an existing client or enter a new client name + email, then enter the proposal title.
3. Choose a PDF (size limit, PDF only).
4. The PDF uploads directly to private storage. The server validates it, counts the pages and shows "N pages".
5. Enter the number of free preview pages (1 to N), the price, and the currency.
6. Save. The server generates the preview PDF and a unique private token.
7. Click "Copy link" and send the link to the client by their usual channel.
8. Track status in the list: Draft → Link active → Paid (with paid date/amount), or Link disabled.

### 4.2 Team lead — edit a proposal

- Before any successful payment: title, client, free pages, price, currency and the PDF can change. Changing the PDF or free pages regenerates the preview.
- After a successful payment: the PDF, price and currency are locked so the buyer keeps the document they paid for. Title edits are allowed. To send a different document, create a new proposal.
- Disable link: the token stops working immediately (shows a generic "link unavailable" page).
- Regenerate link: issues a new token; the old link stops working. Existing paid grants remain valid because they are tied to the proposal, not the token.

### 4.3 CEO/Admin

Same dashboard, but the list and counts cover all team leads. It includes an "Owner" column and an owner filter. The admin can edit or disable any proposal.

### 4.4 Client — preview and pay

1. Open `/p/<token>`. An invalid, disabled or unknown token shows the same generic "link unavailable" page.
2. See the proposal title, the free preview pages (rendered from the preview PDF only), "Pages 1–K of N", the price, and an **Unlock full document** button.
3. Click Unlock → redirected to the provider's hosted checkout.
4. Return to `/p/<token>?payment=<ref>`. The page shows "Confirming payment…" until the server confirms the payment through the webhook or verification API.
5. Once confirmed, this browser receives a paid-access session, and the page shows the full document plus a one-time **recovery code** with an instruction to save it.
6. If the payment failed or was cancelled, the page shows a clear message and the Unlock button again. If it is pending, the page shows "Payment pending — this page will update" and polls the server.

### 4.5 Client — restore access on another device/browser

On `/p/<token>`, click "Already paid? Restore access". Enter the email used at payment and the recovery code. The server verifies them and sets a paid-access session in that browser. If the client lost the code, they contact the team lead, who can issue a new recovery code from the dashboard (this invalidates the old code).

## 5. Dashboard behaviour (single page)

- **Summary counts** (scoped by role): total proposals, active links, paid proposals, total paid amount per currency.
- **List**: one row per proposal. Columns: client, title, pages (free/total), price, status, created date, owner (admin only), and actions (copy link, edit, disable/enable, regenerate link, view payments, issue recovery code).
- **Dialogs**: add/edit client, add/edit proposal (includes upload). No separate pages.
- **Filters**: text search on client/title; status filter; owner filter (admin only).
- **Payment detail**: expandable row or dialog listing payment attempts with status, amount, currency, provider reference and timestamps.

## 6. Client experience

- Minimal, branded (branding pending) page with no navigation to other content.
- Mobile-friendly PDF.js viewer.
- The price shows in the proposal currency with correct decimals.
- No indexing (`noindex`), `Referrer-Policy: no-referrer`, and no shared caching.

## 7. Implementation phases

| Phase | Deliverable |
| --- | --- |
| 1 | Planning + scaffolding (**done**) |
| 2 | Database (schema, RLS, private storage) + internal email/password auth, roles, `/login`, protected `/dashboard` placeholder (**done** — see PHASE_2_SETUP.md) |
| 3 | Dashboard: summary counts, list, client/proposal dialogs (no upload yet) (**done**) |
| 4 | PDF pipeline: private link tokens, direct-to-storage upload, server validation, page count, preview generation, copy link (**done**) |
| 5 | Client page: token resolution, preview viewer, disabled/invalid states (**done**) |
| 6 | UI redesign: white & blue design system, dashboard/login/dialog/client-page polish, interaction reliability (**done** — see PHASE_6_UI_SUMMARY.md). Payments moved to Phase 7. |
| 7 | Payments: provider adapter interface, checkout endpoint, webhook, verification fallback, access grants, cookie session, recovery codes. **Blocked on provider details** — can be built against a local fake adapter first. |
| 8 | Hardening: rate limits, headers, error states, full verification checklist |
| 9 | Vercel deployment (production env vars, provider webhook URL registration) |

Phase numbers changed after Phase 5: a UI redesign became Phase 6, so payments, hardening and deployment moved to 7, 8 and 9. Completed phase documents (PHASE_4_SUMMARY.md, PHASE_5_SUMMARY.md) and applied migrations keep the old numbering, where "Phase 6" means payments.

## 8. Acceptance criteria

1. Only the six manually created accounts can log in. There is no signup route, and Supabase public signups are disabled.
2. A team lead cannot see, edit or infer another lead's clients, proposals, files or payments, whether through the UI, direct API calls, or direct Supabase queries with their own session.
3. A team lead cannot change their own role or any `owner_id`.
4. The admin sees and can manage all records.
5. Three leads uploading three proposals get three distinct, unguessable links. Each link shows only its own proposal.
6. Uploading the same PDF twice gives two different tokens.
7. The free page count must be between 1 and the PDF's actual page count. Anything else is rejected on the server.
8. An unpaid client receives only the preview PDF. No network response to an unpaid browser contains the original PDF or a URL that can fetch it.
9. Protected files are fetched only through short-lived, server-issued signed URLs.
10. A document unlocks only after server-verified payment for the correct proposal, amount and currency. A browser redirect alone never unlocks it.
11. Failed, pending, cancelled, forged, mismatched or duplicate payment events never produce an incorrect unlock or a duplicate grant.
12. A successful payment unlocks only the purchased proposal.
13. Forwarding the link to another browser shows only the preview until valid recovery credentials are entered.
14. `npm run lint`, `npm run typecheck` and `npm run build` pass.
