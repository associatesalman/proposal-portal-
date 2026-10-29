# Database Plan (Supabase)

> **Status (Phase 5):** the minimal subset is implemented in `supabase/migrations/`. See [PHASE_2_SETUP.md](PHASE_2_SETUP.md) for what actually exists. Differences from the full design below:
> - Implemented tables: `profiles` (no `email`/`is_active`/`updated_at`), `clients`, `proposals`, `payments`.
> - Column names as built: `original_storage_path`, `preview_storage_path`, `total_pages`, `free_preview_pages`, `unlock_price_minor`; status is `draft | active | archived`.
> - One private bucket `proposals` holds both `original.pdf` and `preview.pdf` (instead of two buckets). Storage access requires a matching proposal row, not just a path prefix.
> - Ownership is immutable for all API users, admin included.
> - **Phase 3 migration** (`20261027090000_phase3_drafts_and_list_views.sql`): drafts may leave `free_preview_pages`, `unlock_price_minor` and `currency` null, but `active` requires all three (`proposals_active_requires_offer`). A proposal's `client_id` can no longer be updated. Read-only `security_invoker` views `client_list` and `proposal_list` back the dashboard lists, and RLS still applies to them.
> - **Phase 4 migrations** (`20261028090000_phase4_pdf_offer_links.sql`, `20261028090100_phase4_storage_helper_columns.sql`):
>   - Columns:
>     - `original_file_name` and `original_size_bytes`.
>     - `link_token_hash`: SHA-256 hex of the raw token, unique. The raw token is never stored, and `authenticated` has no column SELECT on it.
>     - `link_created_at`.
>   - Storage paths use immutable revisions: `{owner}/{proposal}/{revision_uuid}/original.pdf|preview.pdf`. The legacy path is still accepted.
>   - Invariants:
>     - An original requires a page count and file metadata.
>     - A preview requires an original and `1 ≤ free < total`.
>     - The price must be > 0 and the currency in the allow-list (USD, EUR, GBP, AED, PKR, JPY).
>     - **Active ⇔ a link exists**, and active requires a preview and offer. The planned `access_token`/`disabled` status was replaced by "revoke → draft".
>   - Trigger `private.lock_active_proposal` blocks title, document, offer and hash changes while active (PT423).
>   - `authenticated` lost INSERT/UPDATE on the offer columns and `status`. Those are written only by four `SECURITY DEFINER` functions (`proposal_attach_original`, `proposal_save_offer`, `proposal_issue_link`, `proposal_revoke_link`). They are executable by `service_role` only, re-check owner/admin for the passed actor, and use compare-and-swap on expected paths (PT409).
>   - `public.resolve_proposal_link(token)` is callable by `anon` and returns only the title of an active proposal.
>   - Storage: INSERT only for draft proposals; DELETE only for objects that are not the current original/preview; no UPDATE.
>   - See [PHASE_4_SUMMARY.md](PHASE_4_SUMMARY.md).
> - **Phase 5 migration** (`20261029090000_phase5_client_page_resolvers.sql`):
>   - `resolve_proposal_offer(token)` (anon) returns only title, page counts, price and currency of an active, prepared proposal, for the client page.
>   - `resolve_proposal_preview_object(token)` (**service_role only**) returns that proposal's preview path, for server-side preview streaming. It never returns the original's path.
>   - No table, grant, RLS or storage policy changes; anon still has no table or storage access. See [PHASE_5_SUMMARY.md](PHASE_5_SUMMARY.md).
> - Payments as built (Phase 8, PayPal): see §8. `access_grants` and recovery codes were replaced by `payment_entitlements`, `payment_access_sessions` and `payment_recovery_tokens`; `content_locked_at` was not needed (each payment snapshots its immutable PDF revision instead).
>
> The sections below remain the target design for later phases.

Conventions: `uuid` primary keys, `timestamptz` timestamps (`created_at`, `updated_at`), and money stored as **integer minor units** with an ISO 4217 currency code. All tables in `public` have RLS **enabled**. The `anon` role gets **no** table privileges. Client-facing access goes through server code using the service role after explicit token checks.

## 1. Tables

### 1.1 `profiles` — internal users (6 rows)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | = `auth.users.id` (FK, on delete cascade) |
| `email` | text | Copied from auth for display |
| `full_name` | text | |
| `role` | enum `user_role` (`admin`, `team_lead`) | Not null, default `team_lead` |
| `is_active` | boolean | Default true. Inactive users are treated as having no access |
| `created_at`, `updated_at` | timestamptz | |

Accounts are created manually: the admin creates the auth user in the Supabase dashboard, then inserts the profile row (with role) using the SQL editor / service role. There is no signup trigger that grants roles.

### 1.2 `clients`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `owner_id` | uuid FK → `profiles.id` | Not null. The team lead who owns the client |
| `name` | text | Not null |
| `email` | text | Not null, basic format check |
| `created_at`, `updated_at` | timestamptz | |

Unique `(id, owner_id)`, used by the composite FK below.

### 1.3 `proposals`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `owner_id` | uuid FK → `profiles.id` | Not null |
| `client_id` | uuid | Not null. **Composite FK `(client_id, owner_id)` → `clients(id, owner_id)`**, so a proposal can only reference a client with the same owner |
| `title` | text | Not null |
| `status` | enum (`draft`, `active`, `disabled`) | `active` requires preview + token |
| `access_token` | text | Unique, nullable until finalized. ~43-char base64url |
| `original_path` | text | Storage key in originals bucket |
| `preview_path` | text | Storage key in previews bucket |
| `original_size_bytes` | bigint | |
| `page_count` | int | Set by server from pdf-lib. > 0 |
| `free_pages` | int | Check `free_pages >= 1 AND free_pages <= page_count` |
| `price_minor` | int | Check > 0 |
| `currency` | char(3) | Uppercase ISO 4217; allow-list in app (and optionally a check) |
| `content_locked_at` | timestamptz | Set on first succeeded payment. When set, PDF/free_pages/price/currency cannot change (trigger) |
| `processing_error` | text | Last finalize error, if any |
| `created_at`, `updated_at` | timestamptz | |

### 1.4 `payments` — one row per checkout attempt

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | Also sent to provider as merchant reference |
| `proposal_id` | uuid FK → `proposals.id` | Not null. On delete restrict |
| `owner_id` | uuid FK → `profiles.id` | Denormalized from proposal at creation, for RLS |
| `provider` | text | e.g. `fake`, later the real provider key |
| `provider_checkout_ref` | text | From `createCheckout` |
| `provider_payment_id` | text | When known. Unique `(provider, provider_payment_id)` |
| `amount_minor` | int | Copied from proposal at creation |
| `currency` | char(3) | Copied from proposal at creation |
| `status` | enum (`created`, `pending`, `succeeded`, `failed`, `cancelled`, `refunded`) | Monotonic transitions (ARCHITECTURE §7.2) |
| `checkout_nonce_hash` | text | Binds the initiating browser |
| `payer_email` | text | From provider if given, else entered before checkout |
| `needs_review` | boolean | Set on mismatch / duplicate success |
| `succeeded_at` | timestamptz | |
| `created_at`, `updated_at` | timestamptz | |

### 1.5 `payment_events` — raw provider callbacks (audit + idempotency)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `provider` | text | |
| `provider_event_id` | text | **Unique `(provider, provider_event_id)`**. If the provider has no event id, use a hash of the provider payment id + status + timestamp |
| `payment_id` | uuid FK → `payments.id` | Nullable (unmatched events) |
| `event_type` | text | |
| `normalized_status` | text | |
| `amount_minor`, `currency` | | As reported by provider |
| `result` | enum (`applied`, `duplicate`, `ignored_transition`, `unmatched`, `mismatch`) | |
| `payload` | jsonb | Raw body (minus secrets) |
| `received_at` | timestamptz | |

### 1.6 `access_grants` — paid entitlement

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `payment_id` | uuid FK → `payments.id` | **Unique** — at most one grant per payment |
| `proposal_id` | uuid FK → `proposals.id` | Must equal the payment's proposal (enforced in the server transaction, and optionally by trigger) |
| `owner_id` | uuid | Denormalized for RLS |
| `buyer_email` | text | For recovery matching |
| `recovery_code_hash` | text | Nullable until claimed. Plaintext never stored |
| `claimed_at` | timestamptz | First browser bound |
| `revoked_at` | timestamptz | Null = valid |
| `last_used_at` | timestamptz | |
| `created_at` | timestamptz | |

Optional (only if abuse appears): `access_recovery_attempts(token_or_proposal_id, ip_hash, succeeded, created_at)` for rate limiting. Initially, rate limiting can use this table or an in-memory/edge store. Decide in phase 7.

## 2. Relationships

```
auth.users 1─1 profiles 1─* clients 1─* proposals 1─* payments 1─0..1 access_grants
                                               proposals 1─* access_grants
                         payments 1─* payment_events
```

## 3. Ownership and role enforcement

Helper functions (SQL, `security definer`, `stable`, fixed `search_path`):

- `is_admin()` → true if `profiles.role = 'admin'` and `is_active` for `auth.uid()`.
- `is_active_user()` → true if the caller has an active profile.

Rules:

1. **Roles cannot be self-assigned.** `profiles` has no INSERT/DELETE policy for `authenticated`. UPDATE is not granted on `role`, `is_active` or `id` (column-level privileges revoked). An additional trigger rejects role changes unless they come from the service role / database owner. Role changes happen only manually via the Supabase dashboard.
2. **Ownership cannot be transferred by a lead.** A trigger on `clients`/`proposals` rejects changes to `owner_id` unless `is_admin()`. Inserts by leads must have `owner_id = auth.uid()` (RLS `WITH CHECK`).
3. **Cross-owner linking is impossible.** The composite FK `(client_id, owner_id)` prevents a lead from attaching a proposal to another lead's client.
4. **Server-only columns.** `access_token`, `page_count`, `original_path`, `preview_path` and `content_locked_at` are set only by server code using the service role after validation. `authenticated` gets no UPDATE privilege on those columns.
5. **Payments are server-written only.** `authenticated` has SELECT only (scoped). INSERT/UPDATE happen exclusively via the service role in the checkout/webhook code.

## 4. RLS policies (prose)

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `profiles` | Own row, or all if admin | none | Own `full_name` only (column grant) | none |
| `clients` | `owner_id = auth.uid()` or admin | `WITH CHECK owner_id = auth.uid()` (admin: any owner) | Same as SELECT, `WITH CHECK` same | Own (or admin), only if the client has no proposals with payments |
| `proposals` | `owner_id = auth.uid()` or admin | `WITH CHECK owner_id = auth.uid()` (admin: any) | Same as SELECT, limited to editable columns; lock and deletion-freeze triggers apply | None for API roles (Phase 7). Only the trusted deletion workflow (owner or admin, refused when payments exist) deletes rows (see §7) |
| `payments` | `owner_id = auth.uid()` or admin | none (service role) | none | none |
| `payment_events` | admin only | none | none | none |
| `access_grants` | `owner_id = auth.uid()` or admin (hash column excluded via a view or column grants) | none | none (revoke / new code via server action using service role after ownership check) | none |

All policies also require `is_active_user()`. The `anon` role has no policies and no grants on any of these tables.

## 5. Private Storage

Two **private** buckets (no public URLs):

| Bucket | Object path | Contents |
| --- | --- | --- |
| `proposal-originals` | `<owner_id>/<proposal_id>/original.pdf` | Uploaded full PDF |
| `proposal-previews` | `<owner_id>/<proposal_id>/preview.pdf` | Server-generated free-page PDF |

Policies on `storage.objects`:

- **Originals — INSERT** (direct upload): `authenticated`, bucket = originals, and the first path segment = `auth.uid()`, and the proposal id in the second segment belongs to the caller. In practice, uploads use a server-issued signed upload URL created after the ownership check, so a direct policy can be even narrower or absent.
- **Originals / Previews — SELECT**: `authenticated` where the first path segment = `auth.uid()`, or `is_admin()`. This is used for the dashboard's own previews.
- **UPDATE/DELETE**: same owner-or-admin rule. The server also blocks replacement after `content_locked_at`.
- **anon**: no policies. Client pages get access only through server-issued signed URLs (~60 s), created with the service role after token (and, for originals, paid-grant) checks.
- Bucket settings: allowed MIME type `application/pdf`, file size limit = `MAX_UPLOAD_MB`.

## 6. Payment records summary

> Planning-era summary; the built schema is in §8.

- `payments` = one per checkout attempt, carrying the authoritative amount/currency copied from the proposal.
- `payment_events` = every callback, unique by provider event id (idempotency + audit).
- `access_grants` = one per succeeded payment (unique `payment_id`), tied to exactly one proposal.
- Dashboard "Paid" status for a proposal = it has ≥ 1 non-revoked grant. Totals come from succeeded payments only.

## 7. As built: display names, History, deletion (feature update)

Migration `20261031090000_names_history_deletion.sql`. Details: [FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md](FEATURE_NAMES_HISTORY_DELETION_SUMMARY.md).

- `profiles`: `grant update (full_name)` to `authenticated`, policy `profiles_update_own_name` (`id = auth.uid()`), check `profiles_full_name_printable`.
- `proposals`: `deletion_requested_at timestamptz`, `deletion_requested_by uuid` (audit, no FK). Constraint `proposals_deleting_not_active`; trigger `proposals_freeze_deleting` (`PT410`) blocks every update of a marked row. `authenticated` may read `deletion_requested_at` and cannot write it.
- Storage upload policy: draft **and** not being deleted.
- Service-role functions: `proposal_begin_deletion`, `proposal_deletion_objects`, `proposal_finish_deletion`. They re-check owner-or-admin and refuse payment records (`PT412`). `payments → proposals` stays `ON DELETE RESTRICT`.
- `proposal_list` view: appended `link_created_at`, `deletion_requested_at`, `has_payments`.

## 8. As built: PayPal payments (Phase 8)

Migrations:

- `20261101090000_payment_status_values.sql` adds the enum values `denied`, `partially_refunded` and `reversed`.
- `20261101090100_paypal_payments.sql` holds the schema, functions and views below.
- `20261101090200_payment_refund_state.sql` makes a refund or reversal always end access.

All are additive: no existing rows change.

- **`payments`** (one row per checkout attempt and browser):
  - New columns:
    - references: `owner_id`, `client_id` (filled from the proposal by trigger), `public_ref` (22-char, unique; not a credential), `environment` (`sandbox|live`);
    - snapshot: `revision_id`, `original_storage_path`, `total_pages`, `free_preview_pages`, `title_snapshot`, `client_name_snapshot`, `owner_name_snapshot`;
    - binding and provider: `checkout_session_hash`, `provider_request_id`, `provider_order_id` (unique per provider), `approve_url`;
    - review and outcome: `payer_email`, `merchant_id`, `status_detail`, `needs_review`, `review_reason`, `refunded_amount_minor`, `captured_at`, `verified_at`, `last_synced_at`.
  - Trigger `payments_fill_and_guard`:
    - the snapshot and amount are immutable (`PT423`);
    - the order and capture ids are set once (`PT409`).
  - Checks:
    - a PayPal row has a complete snapshot;
    - the path is this proposal's own revision original;
    - verified states need a capture, an order and `verified_at`;
    - the refund total is ≤ the amount.
  - Column grants: `authenticated` cannot read the session hash, payer email, path, approve URL, request id or public ref. It has no INSERT, UPDATE or DELETE.
- **New tables:** RLS is on and nothing is granted to `anon`/`authenticated`; they are written only by `SECURITY DEFINER` functions executable by `service_role`.
  - `payment_entitlements`: unique per payment; `active|suspended`.
  - `payment_access_sessions`: unique `(entitlement, session_hash)`, `checkout|recovery`, `expires_at`, `revoked_at`.
  - `payment_recovery_tokens`: hash, `email|dashboard`, `expires_at`, `used_at`.
  - `payment_events`: unique `(provider, event id)`; result `received|applied|ignored|unmatched|review|error`.
  - `payment_refunds`: unique provider refund id.
- **Functions:** `payment_begin_checkout`, `payment_record_order`, `payment_session_view`, `payment_lookup_provider`, `payment_mark_cancelled`, `payment_apply_state`, `payment_record_refund`, `payment_grant_session_access`, `payment_access_for_link`, `payment_document_for_session`, `payment_recovery_request|issue|peek|consume`, `payment_event_begin|finish`.
  - Status ranks: `created` 0; `cancelled`/`failed`/`denied` 1; `pending` 2; `succeeded` 3; `partially_refunded` 4; `refunded`/`reversed` 5.
  - A verified state never moves back, and a cancel applies only to an unpaid attempt.
- **Storage:** `private.is_purchased_object` makes purchased revision files undeletable. They count as referenced in `storage_cleanup_scan` and `storage_cleanup_recheck`, even after the proposal's document is replaced. Proposals with any payment row still can't be deleted (`PT412`, FK `RESTRICT`).
- **Views:** `payment_list` and `payment_totals` (`security_invoker`, SELECT for `authenticated`). RLS limits a Team Lead to their own rows; the CEO sees all. Totals are per owner, currency and status, and never mixed across currencies.
- **Tests:** `supabase/tests/database/phase9_payments.test.sql` (113 checks).

## 9. As built: access modes and multi-format sources (feature update)

Migrations `20261102090000_access_modes_multiformat.sql` and `20261102090100_full_access_grant_names.sql` are forward-only and were applied with `migration up`. See [FEATURE_FULL_ACCESS_MULTIFORMAT.md](FEATURE_FULL_ACCESS_MULTIFORMAT.md).

- **`proposals`** gains `access_mode` (`preview|full`, default `preview`), `source_storage_path`, `source_format` (`pdf|docx|doc|odt|rtf|txt`) and `source_size_bytes`.
  - Constraints tie the source to the original's revision folder.
  - An active Full proposal needs only the canonical PDF (no preview, free pages or price).
  - The new columns are trigger-locked like the other trusted columns and readable through column grants.
- **`proposal_full_access_grants`**, the manual Full Access audit trail:
  - Columns: `proposal_id`, `owner_id`, `granted_by`, `granted_by_name` (snapshot), `granted_at`, `revision_id`, `document_path`, `source_format`, `total_pages`, `note` (≤ 500), `ended_at`.
  - A unique index allows one open grant per proposal.
  - RLS: the owner or the CEO can SELECT; nothing else is granted. Rows are written only by `SECURITY DEFINER` functions.
  - Revoke and deletion end the open grant. It is not a payment and creates no payment rows.
- **Functions:**
  - `proposal_attach_document` (min 1 page; `proposal_attach_original` wraps it), `proposal_set_access_mode`, `proposal_issue_full_link`.
  - Mode checks were added to `proposal_issue_link` and `payment_begin_checkout`.
  - Resolvers `resolve_proposal_full_access` (anon) and `resolve_proposal_full_object` (service role). The Preview resolvers now ignore Full links.
- **Storage:** the bucket's `allowed_mime_types` gains DOCX, DOC, ODT, RTF and TXT. The ownership helpers, `is_purchased_object` (which also protects a purchased revision's source) and the cleanup scan/recheck recognise `source.<ext>` objects.
- **View:** `proposal_list` adds `access_mode`, `source_format`, `full_access_granted_at` and `full_access_granted_by_name`.
- **Tests:** `supabase/tests/database/phase10_access_modes.test.sql` (80 checks); pgTAP total 456/456.
