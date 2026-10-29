# Phase 3 — Internal Dashboard

Phase 3 replaces the dashboard placeholder with a working internal dashboard at `/dashboard`. It covers client management and draft proposal records only. There are no uploads, previews, private links, client viewer or payments yet; those belong to Phases 4–6.

## 1. Features

**Page layout (one page, using tabs and dialogs)**
- A header with the portal name, the signed-in user's name and role, and **Sign out**.
- **Overall totals:** Total clients, Total proposals and Draft proposals. These come from real `count` queries through the user's RLS-scoped session. They follow the admin's team-lead filter but deliberately ignore search and pagination. The label says whose totals they are: "Your overall totals", "Overall totals for <lead>" or "Overall totals, all team leads".
- **Clients** and **Proposals** tabs, linked by URL (`?tab=proposals`), plus **Add client** and **New proposal** buttons. New proposal is disabled, with an explanation, until at least one accessible client exists.

**Clients**
- The table shows name, email, proposal count, created date, owner (admin only) and an edit button.
- Search matches name or email and is case-insensitive. `%`, `_` and `\` are matched literally.
- Pages hold 10 rows each and show "Showing X–Y of N clients".
- **Add client** takes a name and email. Team leads always own the clients they create, and any submitted owner is ignored. The admin must pick an existing team lead.
- **Edit client** changes the name and email only. There is no reassignment and no deletion.

**Draft proposals**
- The table shows title, client, **Status** (Draft / Active / Archived), **PDF** (Not uploaded / Uploaded / Preview ready, shown as a separate badge), created date, owner (admin only) and an action.
- Search matches the title or the client name.
- **New proposal** asks for an accessible client and a title. The server derives the owner from the client, as loaded through RLS. New rows are always `draft` with no storage paths, page counts, price, currency or link.
- **Rename draft** edits only the title, and only while the proposal is a draft. Non-draft proposals show "Not editable". A proposal's client and owner can never change.

**Admin (CEO/Admin)**
- Sees all clients and proposals with owner names.
- An optional **Team lead** filter applies on change and resets pagination. It also scopes the totals.
- Can create clients for a chosen lead and drafts for any client. The admin cannot own records, because the schema assigns ownership to team leads.

**UX**
- Every input has a label and "(required)" marker. Errors appear inline under each field, the field gets `aria-invalid` and `aria-describedby`, and a summary alert sits at the top of the form.
- The dialogs are native `<dialog>` elements opened modally. They trap focus, close on Escape or a backdrop click, return focus to the button that opened them, and open with a clean form each time.
- While a submit is pending the fieldset is disabled, which prevents double submits. After a server error the entered values stay in place.
- Success shows a toast in a polite live region, and the lists and totals refresh with `refresh()` (no full reload).
- There are four distinct empty states:
  - **No records yet** for an empty account or lead.
  - **No search results** with a "Clear search" link.
  - **No records on this page** for a page past the end, with a link to page 1.
  - **Couldn't load** when a query fails.
- If rendering fails, an error boundary offers a retry.
- Changing the search or the owner filter drops the page number.
- On narrow screens the tables turn into stacked cards. Text is rendered by React, so it is escaped. There is no demo data, no fake metric, and every button works.

## 2. Security model

- **The server is the authority.**
  - Each server action (`src/app/(dashboard)/dashboard/actions.ts`) calls `getInternalUser()`, which uses `auth.getUser()` and loads the role from `profiles`. It validates with Zod and then works through the cookie-bound Supabase client, so **RLS stays in force**.
  - No service-role or secret key is used anywhere in the app.
- **Ownership is derived on the server.**
  - A lead's submitted `ownerId` is ignored.
  - An admin's `ownerId` must belong to a `team_lead` profile.
  - A proposal's owner is copied from its client, which must be visible to the caller through RLS.
- **Updates must touch a row.** An update that matches no row (for a foreign, missing or malformed id) returns the same safe "could not be found, or you don't have access" message. Title edits also filter on `status = 'draft'`.
- **Lists are filtered in the database.** All filtering, search and pagination happens in SQL. A team lead's browser only ever receives that lead's rows. The admin owner filter is a server-validated query parameter.
- **Nothing is cached between users.** Data is read per request inside `<Suspense>` with cookies. There is no cross-session cache.
- **Errors are safe.** Database errors are logged as codes only. Users see generic messages.

## 3. Migration: `20261027090000_phase3_drafts_and_list_views.sql`

This is a forward-only migration. The Phase 2 migrations were not modified. It was applied locally with `npx supabase migration up`, without a reset.

| Change | Why |
| --- | --- |
| `free_preview_pages` loses its default and NOT NULL; `unlock_price_minor` and `currency` lose NOT NULL | Phase 2 required offer fields on every proposal, so a "draft with nothing decided yet" couldn't be stored honestly. Drafts now leave these fields null. |
| Check `proposals_active_requires_offer`: `status <> 'active'` or all three offer fields are set | Keeps active proposals fully specified once Phase 4 starts activating them. |
| `revoke update (client_id) on proposals from authenticated` | The phase requires that a proposal's client cannot be changed. Before this, changing it would have failed with an FK error at best. Now it is a permission error (42501). |
| Views `client_list`, `proposal_list` (`security_invoker = true`, SELECT-only for `authenticated`, nothing for `anon`) | Lets the dashboard list rows with owner and client names, proposal counts and a combined search column in one query. Because the views run as the caller, the same table RLS applies. |

The Phase 2 pgTAP test "lead A cannot move their proposal onto lead B's client" now expects 42501 instead of 23503. The protection is stronger, not weaker.

## 4. Files

**New**
- `supabase/migrations/20261027090000_phase3_drafts_and_list_views.sql`
- `supabase/tests/database/phase3_drafts_and_views.test.sql`: pgTAP checks for draft creation, the active requirement, the client lock, view RLS and read-only views.
- `supabase/tests/integration/phase3-dashboard.mjs`: 38 HTTP-level workflow and tampering checks.
- `supabase/tests/integration/phase3-browser.mjs`: 28 headless-Chrome UI checks plus screenshots.
- `src/app/(dashboard)/dashboard/actions.ts`, `error.tsx`
- `src/lib/dashboard/{params,queries,form-state}.ts`, `src/lib/validation/dashboard.ts`, `src/lib/format.ts`
- `src/components/ui/{styles.ts,dialog.tsx,fields.tsx}`
- `src/components/dashboard/`: `action-form-dialog`, `badges`, `client-dialogs`, `clients-section`, `dashboard-tabs`, `data-table`, `feedback`, `list-filters`, `list-states`, `pagination`, `proposal-dialogs`, `proposals-section`, `summary-cards`

**Changed**
- `src/app/(dashboard)/dashboard/page.tsx`: the placeholder is replaced by the dashboard.
- `src/components/dashboard/sign-out-button.tsx`: restyled.
- `src/app/globals.css`: colour tokens with light and dark modes, plus the dialog backdrop.
- `src/app/layout.tsx`: the page title.
- `src/types/database.ts`: nullable offer columns and the view types.
- `supabase/tests/database/phase2_authorization.test.sql`: one expectation changed (see §3).
- `supabase/tests/integration/phase2-app.mjs`: the dashboard marker text.
- `package.json`: the `test:dashboard` and `test:browser` scripts.
- Docs: README, IMPLEMENTATION_CHECKLIST, DATABASE_PLAN (status note), PHASE_2_SETUP (grant table row).

## 5. Using it locally

1. `npm run db:start`, which starts the local Supabase stack in Docker. To apply new migrations, use `npx supabase migration up`. Don't use `db:reset`, because it wipes local data.
2. Create internal accounts as described in [PHASE_2_SETUP.md](PHASE_2_SETUP.md) §4: add the user in Studio (http://127.0.0.1:54323 → Authentication), then insert a `profiles` row with role `team_lead` or `admin`. No accounts are seeded.
3. `npm run dev`, then open http://localhost:3000/login and sign in. You land on `/dashboard`.
4. As a team lead, use **Add client** first, then **New proposal**. As the admin, pick a team lead in the dialog, or use the **Team lead** filter to view one lead.

## 6. Checks run (local stack, production build via `npm run start`)

| Check | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run db:test` (pgTAP, Phases 2 and 3) | 90/90 |
| `npm run test:integration` (Phase 2 API/RLS/storage) | 34/34 |
| `npm run test:app` (Phase 2 auth flows) | 17/17 |
| `npm run test:dashboard` | 38/38 |
| `npm run test:browser` (headless Chrome) | 28/28 |

**`test:dashboard`** signs in as disposable users and submits the real forms without JavaScript, including forged fields. It then verifies the results through RLS-scoped clients. It covers:
- An empty dashboard.
- Create and edit with normalisation.
- Inline validation, with the submitted values carried back.
- A forged owner, a forged client id and a forged proposal id.
- Malformed ids.
- Draft defaults, and Draft shown separately from "Not uploaded".
- Another lead's client being rejected.
- Non-draft edits being rejected, and archived rows listed without an edit action.
- Team leads' owner parameter being ignored.
- Admin create-for-lead, and the admin owner validation.
- Admin cross-lead lists and the filter.
- Totals ignoring search.
- Proposal search by client name.
- Pagination, and a page past the end.
- LIKE wildcards matched literally.
- Logged-out redirects.

**`test:browser`** drives real headless Chrome through the login form. It checks:
- The empty state and totals.
- Dialog open, focus, Tab trapping, Escape and focus return.
- Inline validation in the UI, the preserved email, and `aria-invalid` with `aria-describedby`.
- A successful submit, the toast and the refreshed totals.
- The reopened dialog starting clean.
- Edit, the lead-scoped client dropdown, and draft creation.
- The search URL.
- Mobile (390 px): no horizontal overflow, stacked rows, and the dialog fitting the viewport.
- Sign out.
- The admin Owner column and the owner filter.

I reviewed the screenshots of the desktop view, the validation dialog, the proposals list, mobile and the filtered admin view. All test data is disposable, and the database was confirmed empty afterwards (0 users, profiles, clients and proposals).

## 7. Known limitations

- **The dialogs need JavaScript.** The actions themselves work without JS (the tests rely on that). But with Cache Components, a no-JS POST does not re-render validation messages into the HTML; they only appear in the RSC payload.
- **Not visually verified:**
  - The "Couldn't load" state and the error boundary. They were not forced in a browser; the error branches are only covered by code paths.
  - The light colour scheme. Headless Chrome rendered the dark scheme; the light tokens exist but weren't screenshotted.
  - Screen-reader announcements. Only the live-region markup and ARIA attributes were checked.
- **Login page styling:** `/login` still uses the Phase 2 styling, not the new tokens.
- **Accounts:** there are no permanent local accounts. Accounts are still created manually (PHASE_2_SETUP §4).
- **No deletion or reassignment** of clients or proposals, by design for this phase.
- **Client dropdown cap:** the New proposal dropdown loads up to 1000 accessible clients, sorted by name.
- **Admin ownership:** the admin can't own clients or proposals; every record belongs to a team lead.
