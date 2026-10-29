# Phase 4 — PDF Upload, Preview Generation, Offer Settings and Private Links

Phase 4 lets a team lead (or the CEO/Admin, for any proposal) take a draft proposal and:

1. Upload its PDF to private storage. The server verifies it.
2. Choose how many pages are free and set an unlock price and currency. The server builds a separate preview PDF.
3. Generate a unique private link. The link resolves to exactly one proposal.

The link page `/p/[token]` currently shows only the proposal title and "Document preview will be available here soon." The preview viewer is Phase 5 and payments are Phase 6. Neither is started. The white/blue redesign was deferred as requested, so the new UI uses the existing tokens and components.

## 1. What a user sees

Each non-archived proposal in the Proposals tab gets a **Manage PDF** button (aria-label "Manage PDF and link for {title}"). It opens a wide dialog titled **Manage PDF and link** with three numbered steps.

**1. PDF document**
- Choose a PDF, then **Upload PDF** (or **Upload replacement**).
- The progress text shows "Uploading the PDF to private storage…", then "Checking the PDF on the server…".
- On success the dialog shows the file name, size and page count, marked "(verified on the server)".
- A hint states the limits (PDF only, up to 20 MB and 300 pages, at least 2 pages, no password-protected files) and that a replacement removes the current preview.
- Errors appear inline on the file field, which gets `aria-invalid`.

**2. Preview and price**
- Free preview pages, an explicit **Currency** select (it starts on "Select…" with no default) and **Unlock price**.
- The hint under the pages field states the allowed range ("1 to 5. At least one page stays locked.").
- **Save offer and generate preview** builds the preview PDF on the server. Afterwards a summary appears, e.g. "Preview: pages 1–2 of 6 free · Unlock price: US$19.99".

**3. Private link**
- A readiness checklist, then **Generate private link**.
- The full link is shown **once**, with **Copy link** and the label "Private link (copy it now)". It can't be shown again later, because only its hash is stored.
- If the link points at localhost or a private address, a warning says it is local-only.
- After that the step shows "Link active since …" and **Revoke link…**, which asks for confirmation (**Keep link** / **Revoke link**).
- Revoking returns the proposal to Draft. **Generate private link** then has to be clicked again, which creates a new, different link.

While a link is active, the upload and offer controls are disabled, with an explanation. The proposal list shows **Active** and **Preview ready**. The Edit (rename) button is shown only for drafts.

## 2. Limits and production constraints

| Limit | Default | Override (server env) | Hard cap |
| --- | --- | --- | --- |
| File size | 20 MiB | `PDF_MAX_UPLOAD_MB` | 25 MiB (bucket `file_size_limit`; larger values are clamped) |
| Page count | 300 | `PDF_MAX_PAGES` | 1000 |
| Minimum pages | 2 | — | At least one page must stay locked |
| Server action duration | 60 s | `maxDuration` on the dashboard page | Vercel plan limit |

Why these values (documented in `src/lib/proposals/limits.ts`):
- **The PDF never passes through a Vercel function body.** The browser uploads directly to Supabase Storage with a signed upload URL, so Vercel's ~4.5 MB request-body limit doesn't apply.
- **The server holds the whole file in memory.** To verify it, the server downloads the stored file and parses it with pdf-lib. pdf-lib keeps the bytes and the parsed object graph in memory, and preview generation copies pages into a second document. 20 MiB and 300 pages stay comfortably inside a default 2 GB function and the 60 s duration.
- **Raise the limits only after measuring.** If they are raised in production, measure memory and time with real worst-case files first. Very large or image-heavy PDFs would need background processing, which is out of scope.
- **The size is checked three times:**
  1. Against the size the browser declares, before an upload ticket is issued.
  2. Against the stored object's size from storage metadata, before downloading.
  3. Against the downloaded byte length.

## 3. Validation

All checks run on the server against the **stored bytes**. File names, MIME types and sizes from the browser are never trusted.

| Input | Result |
| --- | --- |
| Not a PDF (no `%PDF-` header in the first 1024 bytes, e.g. a renamed text file) | "That file isn't a PDF." |
| Corrupt or truncated PDF (pdf-lib throws, or zero pages) | Rejected as unreadable |
| Encrypted / password-protected (`Encrypt` in the trailer) | Rejected. Encryption is never bypassed or removed. |
| One-page PDF | Rejected: at least one page must stay locked behind payment |
| More than `PDF_MAX_PAGES` pages | Rejected with the limit |
| Too large | Rejected before upload, and again after upload |
| Free pages not an integer, < 1, or ≥ total pages | Field error explaining `1 ≤ free < total` |
| Price empty, zero, negative, not a number, too many decimals for the currency, or above 1,000,000 | Field error |
| Currency missing or not in the allow-list | "Select a currency." |

**Currencies** (`src/lib/proposals/currencies.ts`, mirrored by the `proposals_currency_supported` check):
- USD, EUR, GBP, AED and PKR use 2 decimal places; JPY uses 0.
- Prices are parsed as strings, never as floats, and stored as integer **minor units**. For example, 49.99 USD is stored as 4999 and 1500 JPY as 1500.
- This list is a placeholder until the currency question in OPEN_QUESTIONS is answered. Changing it means a new migration plus an edit to `currencies.ts`.

## 4. Processing and storage flow

```
browser                         server action (as the user, RLS)               trusted DB function
───────                         ────────────────────────────────               ───────────────────
Upload PDF ─► prepareUploadAction: auth, size, draft? new revision UUID,
              createSignedUploadUrl(owner/proposal/rev/original.pdf)  ← storage INSERT policy (draft, own/admin)
PUT bytes ──► (Supabase Storage, private bucket)
           ─► completeUploadAction: stale/draft check, info() size, download,
              header + pdf-lib parse + encryption + page count/limits ─────► proposal_attach_original (CAS on old path)
              success: remove old original + preview                          clears preview, keeps offer if still valid
              failure: remove only the new object

Save offer ─► saveOfferAction: validate fields, download original,
              buildPreviewPdf(1..N), verify page count, upload new
              owner/proposal/rev/preview.pdf ────────────────────────────────► proposal_save_offer (CAS on original path)
              success: remove old preview; failure: remove only the new preview

Generate ──► generateLinkAction: 32 random bytes → token, SHA-256 hash ──────► proposal_issue_link (CAS on preview path)
              raw URL returned once; never stored or logged                    status → active
Revoke ────► revokeLinkAction ───────────────────────────────────────────────► proposal_revoke_link → draft, hash cleared
```

**Preview PDF** (`src/lib/proposals/pdf.ts`, `buildPreviewPdf`):
- A new document containing only pages 1..N, copied with `copyPages`. Nothing is hidden visually or cropped.
- Page-level keys that could reach other pages or carry extra content are removed before copying: `Annots`, `AA`, `B`, `Thumb`, `Metadata`, `PieceInfo`. Link annotations, page actions, article beads, thumbnails and page metadata are therefore not carried over.
- The new document has no attachments, outline, forms or document metadata. Title, author, producer and dates are blank, and pdf-lib's defaults are suppressed.
- Before saving, the server checks that the output contains exactly N Page objects. After saving, it re-parses the result and checks the page count again.
- Tests check that the preview has exactly N pages, that they are pages 1..N in order, and that a link annotation pointing at page 10 does not pull page 10 in.

**Immutable revision paths.** Every upload goes to a fresh path, so a stored object is never overwritten:
- Originals: `{owner_id}/{proposal_id}/{revision_uuid}/original.pdf`
- Previews: `{owner_id}/{proposal_id}/{revision_uuid}/preview.pdf`

The database constraints accept these paths and the legacy Phase 2 path `{owner}/{id}/original.pdf`. Only a trusted function can write a path. The bucket has **no UPDATE policy**, so objects can't be replaced in place.

### Consistency, concurrency and retries

- **No transaction spans the upload.** The upload and PDF processing happen with no database transaction open. Only the final short write is transactional, inside one `SECURITY DEFINER` function that takes `SELECT … FOR UPDATE` on the proposal row.
- **Compare-and-swap.** Each write carries the path the user's view was based on: the expected original path for upload and offer, the expected preview path for link issue. If the row has changed since then, the function raises `PT409`. The user sees "This proposal changed while you were working on it…" with a **Reload** button.
  - Two concurrent replacements: exactly one wins.
  - An offer built from a replaced document: rejected.
  - Two concurrent link generations: exactly one link is issued.
- **Success order.** The new file is verified, then the database points at it, and only then are superseded files removed.
- **Failure order.** Only the object created by the failed operation is removed. A failure never leaves a usable link, never activates a proposal and never touches the current valid document or preview.
- **Known gap (orphans).** If the browser or network drops after the upload but before `completeUploadAction` runs, the uploaded object stays in storage. Nothing references it, and it is never served. Removing a superseded file is best-effort after the database commit, so a storage error can also leave an orphan. A periodic cleanup job (list objects not referenced by any proposal) is deferred to Phase 7.
- **Delete rules.** The storage DELETE policy only allows removing objects that are **not** the proposal's current original or preview. Even a buggy or forged call can't delete the live document.

### Draft and active rules

- PDF and offer changes require `status = 'draft'`. This is checked in the server action, the trusted function and the storage INSERT policy.
- Issuing a link sets `status = 'active'`, and **active ⇔ a link exists**: `proposals_active_iff_link`, with `proposals_active_requires_preview` requiring a preview and offer as well.
  - This replaces the earlier plan's "finalize → active" step: a proposal goes live exactly when it has a link.
- While active, the trigger `private.lock_active_proposal` rejects changes to the title, document fields, offer fields and link hash with `PT423`. The UI explains that the link must be revoked first.
- Revoking clears the hash and returns the proposal to draft, after which edits are allowed again. A new link always needs an explicit **Generate private link**; revoking never re-issues one automatically.
- No delete UI was added. Archived proposals remain "Not editable".

## 5. Private links

- **Token:** `crypto.randomBytes(32)`, i.e. 256 bits from the OS CSPRNG, encoded as 43 base64url characters.
- **Storage:** only `SHA-256(token)` is stored, as hex in `link_token_hash` (unique, format-checked).
  - The raw token exists only in the action's response, so the dialog says to copy it now.
  - `authenticated` has no SELECT privilege on `link_token_hash`: table-level select was revoked and column select granted on every other column. Even the owner and the admin can't read the hash through the API.
- **URL:** `${NEXT_PUBLIC_APP_URL}/p/${token}`.
  - The link is flagged `localOnly` when the host is localhost, 127.x, ::1, a private IPv4 range, `.local` or `.test`. The UI then warns that clients can't open it.
- **Revoke / regenerate:** both clear or replace the hash, so the old link immediately resolves to the generic unavailable page.
- **Resolution (`public.resolve_proposal_link`):**
  - `SECURITY DEFINER`, executable by `anon`. It checks the token format (`^[A-Za-z0-9_-]{43}$`), hashes it, matches only `status = 'active'` rows, and returns **only the title**.
  - `anon` still has no table, view or storage access.
  - The `/p/[token]` page calls it with the publishable key, so **no secret key is needed for link resolution**.
- **`/p/[token]` response:**
  - `Cache-Control: private, no-store, max-age=0`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow, noarchive`, set in `next.config.ts`, plus robots/referrer metadata.
  - Invalid, revoked and inactive links all render the same "This link isn't available" page.
  - The route is excluded from the auth proxy.
- **Tokens stay out of logs:**
  - Next's request log ignores `/p/*`, via `logging.incomingRequests.ignore`.
  - The resolver logs only error codes, and server actions never log tokens.
  - **Caveat:** a deployment's platform access logs (e.g. Vercel's) will still record `/p/…` request paths.
- **Possession of a link grants access.** It doesn't prove who the recipient is, so anyone the client forwards it to can open it. Revoking and regenerating is the remedy, and Phase 6 adds a separate paid-access check.

## 6. Authorization and the secret key

- **Every action authenticates and authorizes.** Each server action calls `getInternalUser()`, which validates the session with Supabase Auth and loads the role from `profiles`. It validates its input and loads the proposal through the **user's RLS-scoped client**. A lead can only see, and therefore only manage, their own proposals.
- **Browser roles can't write the sensitive columns.** The migration revokes INSERT/UPDATE on `free_preview_pages`, `unlock_price_minor`, `currency` and `status` from `authenticated`. Paths, page counts, file metadata and the token hash were never writable by browser roles. A lead calling PostgREST directly cannot forge any of these. This was tested.
- **Four trusted writes use the secret key.** `src/lib/supabase/privileged.ts` (`server-only`) is the **only** module that reads `SUPABASE_SECRET_KEY`. It exposes exactly four calls (`recordVerifiedOriginal`, `recordPreviewAndOffer`, `activateLink`, `revokeLink`), and each calls one database function.
  - The functions are `SECURITY DEFINER` and executable by `service_role` only.
  - Each re-checks inside the transaction that the **actor id passed by the server** is the owner or an admin. Otherwise it returns `PT404`, so a server-side bug can't widen access.
  - They also enforce draft-only edits, the path format (`owner/proposal/uuid/kind.pdf` for **this** proposal's owner), page bounds and compare-and-swap.
  - The secret key is never used for dashboard reads, lists, client or proposal CRUD, uploads or link resolution, and it is never sent to the browser.
- **Uploads are scoped by storage policy.** Signed upload URLs are created **as the user**, so the storage INSERT policy applies: the bucket matches, the path parses to a proposal the caller can see, the first segment equals that proposal's owner, and the proposal is a draft.
  - An admin's upload lands under the lead's folder.
  - The bucket remains private (`public = false`, PDF MIME only, 25 MiB).
- **Database-level invariants** (`20261028090000_phase4_pdf_offer_links.sql`):
  - An original requires a page count and file metadata.
  - A preview requires an original, must use a different path, and needs `free < total`.
  - The price must be positive and the currency supported.
  - The link hash and its timestamp are set together.
  - Active ⇔ link, and active ⇒ preview + offer.

## 7. Migrations

Both are forward-only and were applied with `npx supabase migration up`. No reset was done, and earlier migrations were not edited.

| Migration | Contents |
| --- | --- |
| `20261028090000_phase4_pdf_offer_links.sql` | Columns `original_file_name`, `original_size_bytes`, `link_token_hash`, `link_created_at`; revision-path constraints; invariants above; lock trigger; grant changes; `private.lock_managed_proposal`; the four trusted functions; `resolve_proposal_link` |
| `20261028090100_phase4_storage_helper_columns.sql` | Fix-forward: the storage policy helper used `select *`, which broke once the hash column became unreadable. Replaced by `private.proposal_id_for_object` plus three predicate functions (`can_access_…`, `can_upload_…`, `can_delete_…`). New INSERT (draft only) and DELETE (unreferenced only) policies; still no UPDATE policy |

Existing Phase 2/3 tests were updated where Phase 4 deliberately tightened behaviour:
- Inserts no longer set offer columns.
- A lead's status update now expects 42501.
- Admin counts are scoped to fixture ids, so your real local admin doesn't change them.
- One test reads explicit columns instead of `*`.
- The Phase 3 browser test now waits for the Sign out button to hydrate before clicking it. With the larger Phase 4 dashboard bundle, the test clicked it before React attached its handler, and that click was lost.

## 8. Environment setup

Add to `.env.local` (gitignored):

```
SUPABASE_SECRET_KEY=<secret key>     # server-only; never NEXT_PUBLIC_
# optional:
# PDF_MAX_UPLOAD_MB=20
# PDF_MAX_PAGES=300
```

- **Local:** use the `SECRET_KEY` (`sb_secret_…`) value from `npx supabase status`. It has already been added to this machine's `.env.local`, but it was not printed.
- **Hosted:** Project Settings → API Keys → Secret keys.
- `NEXT_PUBLIC_APP_URL` must be the public base URL in production. Otherwise the generated links point at localhost.
- **Restart `npm run dev` after editing `.env.local`.** Without `SUPABASE_SECRET_KEY`, the setup actions fail with a generic error and nothing is written.

## 9. Tests run

Run against the local Supabase stack and a production build (`npm run build && npx next start -p 3100`, `APP_URL=http://localhost:3100`).

| Check | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run db:test` (pgTAP, Phases 2–4, 3 files) | 132/132 |
| `npm run test:integration` (Phase 2 API/RLS/storage) | 34/34 |
| `npm run test:app` (Phase 2 auth flows) | 17/17 |
| `npm run test:dashboard` (Phase 3) | 38/38 |
| `npm run test:pdf` (Phase 4, new) | 72/72 |
| `npm run test:pdf-browser` (Phase 4 headless Chrome, new) | 27/27 |
| `npm run test:browser` (Phase 3 headless Chrome) | 28/28 |

**pgTAP Phase 4** (`phase4_pdf_offer_links.test.sql`):
- Every constraint, plus revoked column grants and hash unreadability.
- Trusted functions are not executable by `authenticated` or `anon`.
- Error codes: PT404 for another lead's or a missing proposal, PT409 on a stale expected path, PT423 when locked, and 22023/23514 for bad bounds, paths, prices and currencies.
- The resolver: active only, title only, malformed and hash-as-token rejected.
- Revoke behaviour, the storage INSERT policy, and the delete predicate.

**`test:pdf`** calls the **real server actions over HTTP** as disposable signed-in users and inspects the results through RLS-scoped clients and the storage API. It covers:
- A valid 10-page upload, and a preview with exactly 3 pages that are pages 1–3 in order and don't pull in a linked page.
- Rejection of: not a PDF, a renamed text file, corrupt, truncated, encrypted, one-page, too many pages, an oversized declared size, an oversized stored file with a lying declared size, and a missing upload.
- Invalid bounds, prices and currencies, the locked-page message, and JPY whole units.
- Failures leaving no stray objects, and a re-saved offer replacing the old preview.
- Concurrency: two concurrent replacements (one wins, the other is told to reload), a stale offer, a stale upload, and two concurrent link generations (one link).
- Active locks for the PDF, the offer and the title. A lead can't write status, paths, page counts, price or the hash via PostgREST, or call the trusted functions.
- Revoke, double revoke and regenerate; old links unavailable.
- Three leads get three distinct links, each resolving only its own title.
- Admin cross-lead management, with uploads kept under the lead's folder.
- `anon` can't read any table or view; signed-out action calls are redirected; a user with no profile is denied.
- Your existing account and data are unchanged before and after, and all disposable objects and users are removed.

**`test:pdf-browser`** drives headless Chrome through the real dialog:
- Open the dialog; disabled steps before a PDF exists.
- The one-page error with `aria-invalid`; pending states; the verified details (name, size, 6 pages).
- The missing-currency and free = total errors; saving the offer; the summary.
- Generate the link; the local-only warning; Copy (clipboard); controls locked while active.
- Escape closes the dialog and returns focus; the list shows Active and Preview ready; the reopened dialog doesn't show the raw link.
- The `/p/` page shows the title and placeholder.
- Revoke with confirmation; controls unlock; the revoked link shows the unavailable page.
- Mobile 390 px: the dialog fits and scrolls.

I reviewed the screenshots (uploaded state, link generated, active list, mobile dialog).

**Unverified or approximate:**
- **The encrypted-PDF fixture is a structurally valid PDF with an `Encrypt` entry in its trailer, not real ciphertext.** Detection only depends on the trailer entry, but a real password-protected file from a PDF tool was not tested.
- **No real-world PDFs.** Only generated fixtures were used (scanned, image-heavy or very large files were not tried), so memory and time at the 20 MiB / 300-page limit were not measured.
- **The light colour scheme and screen-reader announcements** were not checked, as in Phase 3.
- **Your Chrome** was not used. Checks ran in an isolated headless Chrome profile.

## 10. Manual local test

1. Make sure the local stack is running (`npm run db:start`; it is a no-op if already up) and that `.env.local` contains `SUPABASE_SECRET_KEY`.
2. Restart the dev server so the new env var loads: stop `npm run dev`, then start it again. Open http://localhost:3000/login.
3. Sign in as your Team Lead, or as your Admin. If you don't have a lead yet, see PHASE_2_SETUP §4.
4. **Add client**, then **New proposal**. In the Proposals tab, click the **Manage PDF** icon on the draft.
5. Try a one-page PDF and a renamed `.txt` file. Both should be rejected with an explanation. Then upload a real multi-page PDF and check the name, size and page count.
6. Set free pages (try a value equal to the total; it should be rejected), pick a currency and enter a price. Click **Save offer and generate preview**.
7. Click **Generate private link**, then **Copy link**, and open the link in a private window. It should show the title and the placeholder.
8. Close and reopen the dialog. The link is no longer displayed, the controls are locked and the list shows **Active**.
9. **Revoke link…** → **Revoke link**. Reload the private window: it should show "This link isn't available". Generate again and you get a different link.
10. Optional: in Studio (http://127.0.0.1:54323 → Storage → `proposals`), check that the files are under `owner/proposal/revision/` and the bucket is private.

## 11. Limitations and deferrals

- **Phase 5:**
  - The preview viewer (pdf.js) on `/p/[token]`.
  - Short-lived signed URLs for the preview, issued by the server after token resolution. This will be the first anonymous path that needs storage access.
- **Phase 6:** payments, access grants, the original-document download, and the content lock after payment. **No payment code exists.**
- **Phase 7:**
  - Orphan-object cleanup.
  - Rate limiting on `/p/` lookups. With 256-bit tokens, rate limiting is about load, not guessing.
  - Measuring limits with real files.
- **Proposal deletion:** Phase 2 still grants DELETE on proposals to `authenticated`, but there is no UI.
  - Deleting a proposal row through the API would leave its storage objects orphaned, because the delete policy needs the proposal row.
  - Revoking this grant or adding a trusted delete that also removes storage is a follow-up.
- **The dialogs need JavaScript**, as in Phase 3. A click on a form button (e.g. Sign out) in the brief window before the page hydrates does nothing; clicking again works.
- **Legacy paths:** the Phase 2 path format is still accepted for compatibility. No rows use it.
- **Prerender clock fix:** `getAuthState` and the link page now call `await connection()`. This removes the "used `Date.now()` while prerendering" errors that `next dev` / `next start` had been logging on every dashboard request since Phase 2.

## 12. Files

**New**
- Migrations: the two listed in §7.
- `src/lib/supabase/privileged.ts`
- `src/lib/proposals/{currencies,limits,paths,pdf,links,resolve-link,setup-types}.ts`
- `src/app/(dashboard)/dashboard/proposal-setup-actions.ts`
- `src/components/dashboard/proposal-setup-dialog.tsx`
- `src/app/p/[token]/page.tsx`
- Tests:
  - `supabase/tests/database/phase4_pdf_offer_links.test.sql`
  - `supabase/tests/integration/phase4-pdf-links.mjs`
  - `supabase/tests/integration/phase4-browser.mjs`
  - `supabase/tests/integration/lib/browser.mjs`

**Changed**
- App code:
  - `src/app/(dashboard)/dashboard/page.tsx`: `maxDuration`, limits prop.
  - `src/components/dashboard/proposals-section.tsx`: Manage PDF button.
  - `src/components/dashboard/proposal-dialogs.tsx`: description text.
  - `src/components/ui/dialog.tsx`: wide size, scrolling.
  - `src/lib/format.ts`
  - `src/lib/auth/session.ts`: `connection()`.
  - `src/proxy.ts`: excludes `/p/`.
  - `next.config.ts`: headers, log filter.
  - `src/types/database.ts`
  - `.env.example`
  - `package.json`: `test:pdf`, `test:pdf-browser`.
- Phase 2/3 tests: see §7.
- Docs: README, IMPLEMENTATION_CHECKLIST, DATABASE_PLAN, PHASE_2_SETUP.
