# Feature update: Team Lead names, private client view and Proposal History

Completed 27 Oct 2026, between Phase 7 (hardening) and Phase 8 (payments). Payments and deployment are still deferred. No accounts were created or recreated, no database was reset, and the CRM services were not touched.

Migration: `supabase/migrations/20261031090000_names_history_deletion.sql` (forward only, applied locally with `npx supabase migration up --local`).

## 1. Display names

- `profiles.full_name` is the only display name. It is used in the dashboard header, the CEO's Team Lead filter, the Owner columns (Proposals, Clients, History) and the Manage PDF dialog. Name and role stay separate: the header shows the name, then the role badge ("Team Lead" / "CEO / Admin").
- **Edit name** (header button, labelled "Edit display name") opens a dialog with one field. `updateDisplayNameAction` does the following:
  - Authenticates the user.
  - Validates the name server-side with Zod: trims it, collapses whitespace, requires 1–100 characters and rejects control characters.
  - Updates `full_name` only, on the row whose id comes from the verified session. Nothing in the form selects the row.
- **Database enforcement:**
  - `grant update (full_name)` on `profiles` to `authenticated`; this is the only column grant.
  - Policy `profiles_update_own_name` requires `id = auth.uid()` for both `using` and `with check`.
  - Role, id and created_at are not updatable. Nobody, including the CEO, can rename another user through the API.
  - A new check, `profiles_full_name_printable`, rejects control characters.
- **Existing account:** the Team Lead account `fassihteamlead@gmail.com` was uniquely identifiable (it was the only `team_lead` and the only "Team Lead 1"). One guarded statement renamed it to **Fassih Team Lead**, matching on id, the old name and the role, and affected exactly one row. Nothing else changed, and email addresses are never parsed into names.
- **Manual step for other environments:** have the lead use **Edit name** after signing in. Alternatively, run this as the database owner:

  ```sql
  update public.profiles set full_name = 'Fassih Team Lead'
  where id = '<profile id>' and full_name = 'Team Lead 1' and role = 'team_lead';
  -- expect: UPDATE 1
  ```

## 2. What the client page shows (and doesn't)

`/p/<token>` shows only:
- the title;
- the PDF preview;
- free, total and locked page counts;
- the price;
- the existing "Online payment will be available soon." notice.

Checked against the rendered HTML, the RSC payload, the response headers of the page and the preview, the metadata (`<title>Proposal</title>`) and the public resolver output (`resolve_proposal_offer` returns exactly title, total_pages, free_preview_pages, unlock_price_minor and currency). None of these contain:
- the Team Lead's name or email, or the CEO's name;
- owner, client or proposal ids, or the client's name or email;
- storage paths;
- other proposals, or any history.

The generated preview PDF is a new document. It doesn't copy the original's document information (title or author), which the test verified. **The page content is the author's own**: whatever names appear inside the uploaded PDF pages remain in the free preview pages. That content is not modified or removed.

## 3. Locked-page placeholders

- `src/components/proposals/locked-pages.tsx` renders page-shaped cards after the viewer.
- **What each card contains:**
  - "Page N of T" (the actual document page number);
  - a blurred, neutral pattern of grey bars, identical for every document;
  - a lock icon;
  - "Locked page" and "Full access isn't available yet."
- **Synthetic only:**
  - The cards are built from the page counts the page already has.
  - No request is made for them, nothing is rendered from the locked pages, and no CSS blur is applied to real content.
  - The served preview PDF still contains only the free pages. The test parses it with PDF.js: only free-page text is present and the page count equals the free-page count.
  - In the browser, the only document request is `/p/<token>/preview`.
- **Paginated:** at most 6 cards are shown at a time, with Previous / Next buttons and a "Document pages 3–8 of 9" label. A 300-page document still renders 6 cards.
- **Page numbering:** the viewer toolbar now says "Preview page X of F" with "Document page X of T" under it, so preview numbering and document numbering are distinct.
- The price section and the payment notice are unchanged. There is no checkout and no unlock.
- **Accessibility:** a labelled section, a list of groups (each labelled "Document page N of T, locked"), keyboard-operable controls, and a 2-column grid on phones.

## 4. Proposal History

- **Where it lives:** a third dashboard tab, **Proposal History** ("History" on phones), at `/dashboard?tab=history`. It is built from the `proposals` table through the existing `proposal_list` view (RLS, `security_invoker`); no history table was added.
- **Columns:**
  - Proposal, Client, Status, PDF, Created;
  - Link issued (the active link's creation date, or "—");
  - Owner (CEO/Admin only);
  - actions: Manage PDF and Delete (or "Retry deletion").
- **Filters:**
  - search;
  - status: All, Draft, Active (link issued), Archived, Deletion pending;
  - Team Lead (CEO/Admin only).
- **Persistence:** filters live in the URL and are applied in the database query, so they survive refresh. History itself is stored data, so it survives logout and login.
- **Visibility:**
  - A Team Lead's query returns only their own rows, because RLS filters them in the database. A forged `owner` parameter is ignored for leads.
  - The CEO sees every lead and can filter by lead.
  - Nothing from History is reachable through client links.
- **Links are hash-only.** History shows when the current link was issued. The page and the Manage PDF dialog say that an earlier link can't be shown or recovered, and that generating a new link replaces the previous one, which stops working.

## 5. Permanent deletion

### Who

- **Team Leads** can delete their own proposals. **CEO/Admin** can delete any proposal.
- **Payment records:** a proposal with any payment record is refused (`PT412`) with "This proposal has payment records, which must be kept…". History shows it as "Kept: has payments" with no Delete button. Payments are never deleted or cascaded, and the FK stays `ON DELETE RESTRICT`.

### Confirmation

An accessible dialog names the proposal and its client. It states that the proposal, its original and preview PDFs (including earlier versions) and its client link are permanently removed, and that the client record and other proposals are kept. The final button is a red "Delete permanently". The dialog supports Escape and Cancel and is keyboard-operable.

### Workflow

`deleteProposalAction` delegates the trusted steps to `src/lib/supabase/privileged.ts` → `deleteProposalPermanently`:

1. **Authorize.** Authenticate, validate the id (UUID), and load the proposal through the user's RLS client. Another lead's proposal, or a guessed or malformed id, is "not found" and never reaches the trusted steps. A per-user rate limit applies: `proposal_delete_user`, 30 per 10 minutes.
2. **`proposal_begin_deletion(actor, id)`** (service_role only). It locks the row, re-checks that the actor is the owner or an admin, refuses if payments exist, and then, in one statement:
   - sets `deletion_requested_at` / `deletion_requested_by`;
   - clears the link hash (the link stops working immediately);
   - returns an active proposal to draft.

   Calling it again is safe: an already-marked proposal is returned unchanged.
3. **Storage.** `proposal_deletion_objects` lists every object under the proposal's own folder `{owner}/{proposal}/`. That folder is built from the database row, never from the request, and includes current files, older revisions and abandoned uploads. The server removes the objects through the Storage API with the secret key, checks the prefix again, and re-lists until none remain.
4. **`proposal_finish_deletion`** deletes the row only if the proposal is marked, no object remains, and no payment exists (re-checked under the row lock).
5. **Result.** Success is reported only after step 4.

### While a proposal is being deleted

- It never becomes public again. A check constraint forbids an active status with a marker, and a trigger freezes the row for every role (including service_role and the trusted functions): the marker can't be cleared and nothing can be changed.
- New uploads are refused: the storage insert policy requires no marker.
- New links, offer changes, document changes and title edits are refused with "This proposal is being deleted…".
- Manage PDF is hidden. The Proposals tab shows "Being deleted (see History)".

### Failures and retries

- If storage or the final step fails, the proposal stays marked: hidden, linkless and frozen. History shows **Deletion pending** with **Retry deletion**, and the message says the link no longer works. Every step is idempotent, so retrying completes the deletion.
- Two simultaneous deletions both report a finished deletion: the second sees that the first already completed it.

### In-flight uploads (measured)

A signed upload URL issued **before** deletion started still accepts an upload **after** deletion finished. The storage policy is checked when the URL is created, not when it is used.

That object lands in the deleted proposal's own folder. It is never referenced or served, and completing it is refused. The cleanup utility classifies it as an orphan and removes it once it is old enough. The minimum age is 2 h, which is longer than the upload URL's 2 h validity and the 1 h completion window; the default is 24 h.

If a late upload lands between the storage step and the final step, the final step refuses (`PT409`) and a retry removes it.

### Not claimed

- No disk space figure is reported.
- Direct `DELETE` on `proposals` stays revoked for `anon` and `authenticated`. Only the trusted function deletes rows.

## 6. Database and security summary

| Change | Detail |
| --- | --- |
| `profiles` | `update (full_name)` grant, own-row update policy, printable-name check |
| `proposals` | `deletion_requested_at`, `deletion_requested_by` (audit, no FK); `proposals_deleting_not_active`; trigger `proposals_freeze_deleting` (`PT410`); select grant on `deletion_requested_at` only |
| Storage | `can_upload_proposal_object` also requires no deletion marker |
| Trusted writers | `private.lock_managed_proposal` refuses marked proposals (`PT410`) |
| New functions (service_role only) | `proposal_begin_deletion`, `proposal_deletion_objects`, `proposal_finish_deletion` (+ private `lock_deletable_proposal`, `proposal_folder`) |
| `proposal_list` view | appended `link_created_at`, `deletion_requested_at`, `has_payments` (still `security_invoker`) |

The secret key stays server-only (`privileged.ts` and the rate limiter). The bucket stays private, and originals are still never served.

## 7. Tests actually run (27 Oct 2026, local stack, production build on port 3100)

| Suite | Result |
| --- | --- |
| lint, typecheck, build | pass |
| pgTAP (`npm run db:test`) | **263/263** (65 new in `phase8_names_history_deletion.test.sql`) |
| `npm run test:history` (new) | **100/100** |
| `npm run test:history-browser` (new) | **50/50** |
| `npm run test:integration` / `test:app` / `test:dashboard` | 34/34, 17/17, 38/38 |
| `npm run test:pdf` / `test:client` | 72/72, 70/70 |
| `npm run test:browser` / `test:pdf-browser` / `test:client-browser` | 28/28, 27/27, 64/64 |
| `npm run test:ui` | 97/97 |
| `npm run test:hardening` (own server on 3101) | 121/121 |
| `npm run measure:bundles` | 3/3 |
| `npm audit` | 0 vulnerabilities |

**What the new suites cover:**
- **Names:**
  - The new name appears in the header and in the CEO's filter and Owner column, and persists after reload.
  - Forged `role`/`id` fields are ignored. API attempts to change a role, or to rename another user (as a lead or as the CEO), fail.
  - Empty, too-long and control-character names are rejected.
- **Public view:**
  - No identity or internal data in the HTML, RSC payload, headers or resolver output.
  - Preview bytes contain the free pages only.
  - Placeholders contain no locked text, images, canvases or document URLs, and the browser makes no other document request.
- **History:**
  - Leads see only their own rows; the CEO sees all leads and can filter by lead.
  - Status filters work.
  - History persists after logout/login and after reload.
- **Isolation and deletion:**
  - Lead A can't delete, edit or manage Lead B's proposal.
  - A deletion kills the link immediately (page and preview) and removes every object, including the abandoned upload.
  - The client, other proposals and their files are untouched.
  - An interrupted deletion is frozen and retryable.
  - Three races of delete against link generation, upload and title edit; two concurrent deletions.
  - Payment-protected proposals are refused for the lead and the CEO.
  - Behaviour with an outstanding upload ticket, and its cleanup.
- **Browser:**
  - Desktop and 390 px.
  - Name dialog (focus, Escape, focus return).
  - History filters and reload.
  - Delete dialog (content, Cancel, keyboard path to the destructive button, toast).
  - CEO filter.
  - Mobile layout without overflow.
  - Placeholders on desktop and mobile with keyboard paging.

**Existing suites changed (expectations only):**
- `phase5-browser`: the toolbar label is now "Preview page X of F".
- `phase6-ui`: the sign-out selector now targets `form[data-sign-out]`, because the header also contains the name dialog's form.

Every suite verified that existing accounts and data were unchanged and that disposable objects were removed. A cleanup dry run on the real local data afterwards found 2 referenced objects and 0 candidates.

**Not verified:**
- Real devices (Safari/iOS, Firefox, Android) and a screen reader.
- Interrupted deletion is tested by stopping after step 1, through the trusted RPC, which is the state a crash leaves. A storage-API outage during step 3 was not injected.

## 8. Manual testing

1. `npx supabase migration up --local`, then `npm run dev` (or `npm run build && npx next start -p 3100`).
2. **Name:**
   1. Sign in as the Team Lead. The header shows "Fassih Team Lead" and a "Team Lead" badge.
   2. Click **Edit name**, change the name and save. The header updates.
   3. Sign in as the CEO: the Team Lead filter and the Owner columns show the new name.
3. **Client page:**
   1. Open a proposal link in a private window.
   2. Check the title, counts, preview, placeholders ("Page N of T", lock, "Locked page"), **Next** under "Locked pages", the price and the payment notice.
   3. View the page source and search for the lead's name or email: nothing is found.
4. **History:**
   1. Open **Proposal History**. Filter by status and reload; the filter is kept.
   2. As the CEO, filter by Team Lead.
   3. As a lead, confirm that another lead's proposals never appear.
5. **Deletion** (use a test proposal, not a real one):
   1. Click **Delete**. The dialog names the proposal and client. Cancel, then reopen and click **Delete permanently**.
   2. The row disappears, a confirmation appears, and the old client link shows "This link isn't available".
   3. `npm run storage:cleanup` (dry run) shows no candidates for it.
6. **Retention:** a proposal with a payment record shows "Kept: has payments". The server refuses deletion even if the request is forged.

## 9. Deferred

- Payments (Phase 8) and deployment (Phase 9).
- A retention/archive workflow for proposals with payment records.
- Revoking outstanding signed upload URLs at deletion time: Storage offers no API for this, so late uploads are covered by the cleanup utility instead.
