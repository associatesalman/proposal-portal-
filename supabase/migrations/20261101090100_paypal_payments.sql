-- Payments (PayPal Checkout, Orders v2): checkout attempts bound to an
-- immutable PDF revision and a browser session, verified state, paid-access
-- entitlements, browser access sessions, recovery tokens, webhook events and
-- refunds. Forward-only; existing rows are not changed (there are none in
-- payments yet, and the backfill below is a no-op on an empty table).
--
-- Trust model
--   - Browser roles (anon, authenticated) can't write any payment table.
--     authenticated can READ payments (RLS: own proposals, admin all) through
--     a column grant that excludes session hashes, payer email, storage paths
--     and provider URLs; the new tables are not readable at all.
--   - Every write goes through SECURITY DEFINER functions executable by
--     service_role only, called from server code (src/lib/payments/*) after
--     PayPal has been queried server-to-server. The functions re-check the
--     invariants that matter for money and access (amount, currency,
--     capture reference, order reference, purchased file, monotonic status),
--     so a bug in the caller can't grant access on its own.
--   - A payment row snapshots the offer at checkout: amount, currency, the
--     exact original PDF revision (immutable path), page count, and the
--     title / client / Team Lead names for the history. Later price, title,
--     document or name changes don't alter it.
--   - Access is an entitlement per verified payment (proposal + revision),
--     never a "paid" flag on the proposal. A browser gets access only via an
--     access session: created for the browser that started the checkout
--     (checkout_session_hash), or by redeeming a single-use recovery token.
--   - Purchased revision files are protected from deletion (storage policy,
--     cleanup utility); proposals with payment records can't be deleted
--     (existing PT412 + ON DELETE RESTRICT).
--
-- Error codes: PT404 not found, PT409 conflicting reference, PT423 not
-- purchasable / wrong state, 22023 invalid argument.

-- ---------------------------------------------------------------------------
-- 1. payments: checkout snapshot, provider references, verification state
-- ---------------------------------------------------------------------------
alter table public.payments
  add column owner_id uuid references public.profiles (id) on delete restrict,
  add column client_id uuid references public.clients (id) on delete restrict,
  -- Opaque reference used in the client's purchase URL (/purchase/<ref>).
  -- Not a credential: every purchase route also requires the browser session.
  add column public_ref text
    constraint payments_public_ref_format check (public_ref is null or public_ref ~ '^[A-Za-z0-9_-]{22}$')
    constraint payments_public_ref_key unique,
  add column environment text
    constraint payments_environment_check check (environment is null or environment in ('sandbox', 'live')),
  add column revision_id uuid,
  add column original_storage_path text,
  add column total_pages integer
    constraint payments_total_pages_positive check (total_pages is null or total_pages > 1),
  add column free_preview_pages integer,
  add column title_snapshot text
    constraint payments_title_snapshot_length check (title_snapshot is null or char_length(title_snapshot) <= 300),
  add column client_name_snapshot text
    constraint payments_client_name_snapshot_length check (client_name_snapshot is null or char_length(client_name_snapshot) <= 200),
  add column owner_name_snapshot text
    constraint payments_owner_name_snapshot_length check (owner_name_snapshot is null or char_length(owner_name_snapshot) <= 200),
  -- SHA-256 of the initiating browser's session secret (cookie). Never the secret.
  add column checkout_session_hash text
    constraint payments_checkout_session_hash_format check (checkout_session_hash is null or checkout_session_hash ~ '^[0-9a-f]{64}$'),
  -- Sent as PayPal-Request-Id so retries of create/capture are idempotent.
  add column provider_request_id uuid not null default gen_random_uuid(),
  add column provider_order_id text
    constraint payments_provider_order_id_length check (provider_order_id is null or char_length(provider_order_id) between 1 and 64),
  add column approve_url text
    constraint payments_approve_url_length check (approve_url is null or char_length(approve_url) <= 2048),
  add column payer_email text
    constraint payments_payer_email_length check (payer_email is null or char_length(payer_email) <= 320),
  add column merchant_id text
    constraint payments_merchant_id_length check (merchant_id is null or char_length(merchant_id) <= 64),
  add column status_detail text
    constraint payments_status_detail_length check (status_detail is null or char_length(status_detail) <= 100),
  add column needs_review boolean not null default false,
  add column review_reason text
    constraint payments_review_reason_length check (review_reason is null or char_length(review_reason) <= 200),
  add column refunded_amount_minor integer not null default 0
    constraint payments_refunded_amount_nonnegative check (refunded_amount_minor >= 0),
  add column captured_at timestamptz,
  -- When this server verified the completed capture with PayPal.
  add column verified_at timestamptz,
  add column last_synced_at timestamptz;

-- Backfill (no rows exist yet; kept for completeness), then require.
update public.payments pay
set owner_id = pr.owner_id, client_id = pr.client_id
from public.proposals pr
where pr.id = pay.proposal_id and (pay.owner_id is null or pay.client_id is null);

alter table public.payments
  alter column owner_id set not null,
  alter column client_id set not null;

alter table public.payments
  add constraint payments_provider_order_id_key unique (provider, provider_order_id),
  -- PayPal checkouts carry the complete snapshot.
  add constraint payments_paypal_snapshot check (
    provider <> 'paypal'
    or (
      public_ref is not null and environment is not null and revision_id is not null
      and original_storage_path is not null and total_pages is not null
      and title_snapshot is not null and client_name_snapshot is not null
      and owner_name_snapshot is not null and checkout_session_hash is not null
    )
  ),
  -- The purchased file is this proposal's own immutable revision original.
  add constraint payments_original_path_format check (
    original_storage_path is null
    or original_storage_path ~ (
      '^' || owner_id::text || '/' || proposal_id::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original\.pdf$'
    )
  ),
  add constraint payments_revision_matches_path check (
    revision_id is null or original_storage_path like '%/' || revision_id::text || '/original.pdf'
  ),
  -- A verified state needs the capture reference and verification time.
  add constraint payments_verified_requires_capture check (
    provider <> 'paypal'
    or status not in ('succeeded', 'partially_refunded', 'refunded', 'reversed')
    or (provider_payment_id is not null and verified_at is not null and provider_order_id is not null)
  ),
  add constraint payments_refund_within_amount check (refunded_amount_minor <= amount_minor);

create index payments_owner_id_idx on public.payments (owner_id);
create index payments_owner_created_idx on public.payments (owner_id, created_at desc);
create index payments_created_idx on public.payments (created_at desc);
create index payments_checkout_session_idx on public.payments (proposal_id, checkout_session_hash);
create index payments_original_path_idx on public.payments (original_storage_path) where original_storage_path is not null;

-- Owner and client always come from the proposal (never from the caller),
-- and the checkout snapshot and references can't be rewritten afterwards.
create function private.payments_fill_and_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  owner uuid;
  client uuid;
begin
  if tg_op = 'INSERT' then
    select p.owner_id, p.client_id into owner, client from public.proposals p where p.id = new.proposal_id;
    if not found then
      raise exception 'proposal not found' using errcode = 'PT404';
    end if;
    new.owner_id := owner;
    new.client_id := client;
    return new;
  end if;

  if new.proposal_id is distinct from old.proposal_id
     or new.owner_id is distinct from old.owner_id
     or new.client_id is distinct from old.client_id
     or new.provider is distinct from old.provider
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.public_ref is distinct from old.public_ref
     or new.environment is distinct from old.environment
     or new.revision_id is distinct from old.revision_id
     or new.original_storage_path is distinct from old.original_storage_path
     or new.total_pages is distinct from old.total_pages
     or new.free_preview_pages is distinct from old.free_preview_pages
     or new.title_snapshot is distinct from old.title_snapshot
     or new.client_name_snapshot is distinct from old.client_name_snapshot
     or new.owner_name_snapshot is distinct from old.owner_name_snapshot
     or new.checkout_session_hash is distinct from old.checkout_session_hash
     or new.provider_request_id is distinct from old.provider_request_id then
    raise exception 'payment snapshot is immutable' using errcode = 'PT423';
  end if;
  -- Provider references are set once.
  if old.provider_order_id is not null and new.provider_order_id is distinct from old.provider_order_id then
    raise exception 'order reference is immutable' using errcode = 'PT409';
  end if;
  if old.provider_payment_id is not null and new.provider_payment_id is distinct from old.provider_payment_id then
    raise exception 'capture reference is immutable' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke all on function private.payments_fill_and_guard() from public;

create trigger payments_fill_and_guard
  before insert or update on public.payments
  for each row execute function private.payments_fill_and_guard();

-- Read access for the dashboard: only display columns (RLS still limits
-- rows to the lead's own proposals, or all for the admin).
revoke select on table public.payments from authenticated;
grant select (
  id, proposal_id, owner_id, client_id, provider, provider_payment_id, provider_order_id,
  amount_minor, currency, status, status_detail, needs_review, review_reason,
  refunded_amount_minor, revision_id, title_snapshot, client_name_snapshot,
  owner_name_snapshot, environment, captured_at, verified_at, created_at, updated_at
) on table public.payments to authenticated;

-- ---------------------------------------------------------------------------
-- 2. New tables (no browser access at all)
-- ---------------------------------------------------------------------------
create table public.payment_entitlements (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete restrict
    constraint payment_entitlements_payment_key unique,
  proposal_id uuid not null references public.proposals (id) on delete restrict,
  owner_id uuid not null,
  original_storage_path text not null,
  total_pages integer not null constraint payment_entitlements_pages_positive check (total_pages > 1),
  status text not null default 'active'
    constraint payment_entitlements_status check (status in ('active', 'suspended')),
  suspended_at timestamptz,
  suspended_reason text
    constraint payment_entitlements_reason_length check (suspended_reason is null or char_length(suspended_reason) <= 100),
  created_at timestamptz not null default now(),
  constraint payment_entitlements_suspension check ((status = 'suspended') = (suspended_at is not null))
);

create index payment_entitlements_proposal_idx on public.payment_entitlements (proposal_id);

create table public.payment_access_sessions (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.payment_entitlements (id) on delete restrict,
  session_hash text not null constraint payment_access_sessions_hash_format check (session_hash ~ '^[0-9a-f]{64}$'),
  granted_via text not null constraint payment_access_sessions_via check (granted_via in ('checkout', 'recovery')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint payment_access_sessions_key unique (entitlement_id, session_hash)
);

create index payment_access_sessions_session_idx on public.payment_access_sessions (session_hash);

create table public.payment_recovery_tokens (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.payment_entitlements (id) on delete restrict,
  token_hash text not null constraint payment_recovery_tokens_hash_format check (token_hash ~ '^[0-9a-f]{64}$')
    constraint payment_recovery_tokens_hash_key unique,
  issued_via text not null constraint payment_recovery_tokens_via check (issued_via in ('email', 'dashboard')),
  issued_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index payment_recovery_tokens_entitlement_idx on public.payment_recovery_tokens (entitlement_id);

-- Verified webhook deliveries (idempotency + audit). Only identifiers and a
-- small summary are stored, never the payer's personal data.
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null constraint payment_events_event_id_length check (char_length(provider_event_id) between 1 and 128),
  event_type text not null constraint payment_events_type_length check (char_length(event_type) between 1 and 100),
  resource_type text,
  resource_id text,
  payment_id uuid references public.payments (id) on delete restrict,
  result text not null default 'received'
    constraint payment_events_result check (result in ('received', 'applied', 'ignored', 'unmatched', 'review', 'error')),
  detail text constraint payment_events_detail_length check (detail is null or char_length(detail) <= 200),
  attempts integer not null default 1,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint payment_events_provider_event_key unique (provider, provider_event_id)
);

create index payment_events_payment_idx on public.payment_events (payment_id);

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete restrict,
  provider_refund_id text not null constraint payment_refunds_id_length check (char_length(provider_refund_id) between 1 and 64)
    constraint payment_refunds_provider_key unique,
  amount_minor integer not null constraint payment_refunds_amount_positive check (amount_minor > 0),
  currency char(3) not null,
  status text not null constraint payment_refunds_status_length check (char_length(status) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payment_refunds_payment_idx on public.payment_refunds (payment_id);

alter table public.payment_entitlements enable row level security;
alter table public.payment_access_sessions enable row level security;
alter table public.payment_recovery_tokens enable row level security;
alter table public.payment_events enable row level security;
alter table public.payment_refunds enable row level security;

revoke all on table
  public.payment_entitlements,
  public.payment_access_sessions,
  public.payment_recovery_tokens,
  public.payment_events,
  public.payment_refunds
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Purchased files are retained
-- ---------------------------------------------------------------------------
-- True when a payment (any attempt: an open checkout may still be paid)
-- references the object. SECURITY DEFINER because browser roles can't read
-- payments.original_storage_path; it answers only yes/no for one name.
create function private.is_purchased_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.payments pay where pay.original_storage_path = object_name);
$$;

revoke all on function private.is_purchased_object(text) from public;
grant execute on function private.is_purchased_object(text) to authenticated, service_role;

-- Delete: only objects the proposal no longer references AND no payment
-- references (a replaced document that someone bought stays stored).
create or replace function private.can_delete_proposal_object(object_name text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.proposals p
    where p.id = private.proposal_id_for_object(object_name)
      and object_name is distinct from p.original_storage_path
      and object_name is distinct from p.preview_storage_path
  )
  and not private.is_purchased_object(object_name);
$$;

-- Storage cleanup: purchased files count as referenced (never deleted).
create or replace function public.storage_cleanup_scan(
  p_created_before timestamptz,
  p_prefix text default '',
  p_after text default '',
  p_limit integer default 500
)
returns table (name text, created_at timestamptz, size_bytes bigint, classification text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.name,
    o.created_at,
    nullif(o.metadata ->> 'size', '')::bigint,
    case
      when exists (
        select 1 from public.proposals p
        where p.original_storage_path = o.name or p.preview_storage_path = o.name
      ) or exists (
        select 1 from public.payments pay where pay.original_storage_path = o.name
      ) then 'referenced'
      when o.created_at is null or o.created_at >= p_created_before then 'recent'
      when not private.is_proposal_object_name(o.name) then 'unrecognised'
      else 'orphan'
    end
  from storage.objects o
  where o.bucket_id = 'proposals'
    and o.name > coalesce(p_after, '')
    and starts_with(o.name, coalesce(p_prefix, ''))
  order by o.name
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
$$;

create or replace function public.storage_cleanup_recheck(p_names text[], p_created_before timestamptz)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'proposals'
    and o.name = any (p_names)
    and o.created_at < p_created_before
    and private.is_proposal_object_name(o.name)
    and not exists (
      select 1 from public.proposals p
      where p.original_storage_path = o.name or p.preview_storage_path = o.name
    )
    and not exists (
      select 1 from public.payments pay where pay.original_storage_path = o.name
    );
$$;

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
create function private.new_public_ref()
returns text
language sql
volatile
set search_path = ''
as $$
  select translate(rtrim(encode(extensions.gen_random_bytes(16), 'base64'), '='), '+/', '-_');
$$;

revoke all on function private.new_public_ref() from public;

-- Ordering used to keep status changes monotonic. Verified money states
-- (>= 3) never go back to an unverified state.
create function private.payment_status_rank(s public.payment_status)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case s
    when 'created' then 0
    when 'cancelled' then 1
    when 'failed' then 1
    when 'denied' then 1
    when 'pending' then 2
    when 'succeeded' then 3
    when 'partially_refunded' then 4
    when 'refunded' then 5
    when 'reversed' then 5
  end;
$$;

revoke all on function private.payment_status_rank(public.payment_status) from public;

-- Active proposal for a raw link token (same hashing and rules as the
-- client page resolvers), not being deleted.
create function private.proposal_for_token(p_token text)
returns public.proposals
language sql
stable
set search_path = ''
as $$
  select p.*
  from public.proposals p
  where p_token ~ '^[A-Za-z0-9_-]{43}$'
    and p.status = 'active'
    and p.deletion_requested_at is null
    and p.link_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

revoke all on function private.proposal_for_token(text) from public;

-- ---------------------------------------------------------------------------
-- 5. Checkout (service_role only)
-- ---------------------------------------------------------------------------

-- Starts (or reuses) a checkout attempt for the proposal a link token
-- resolves to. Everything that is charged or delivered comes from the
-- proposal row here; the caller supplies only the token, the browser
-- session hash and the configured PayPal environment. A still-open attempt
-- of the same browser for the same offer and revision is reused, so double
-- clicks and retries don't create duplicate orders. Returns no row when the
-- link is not usable.
create function public.payment_begin_checkout(p_token text, p_session_hash text, p_environment text)
returns table (
  payment_id uuid,
  public_ref text,
  amount_minor integer,
  currency text,
  title text,
  request_id uuid,
  provider_order_id text,
  approve_url text,
  reused boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
  found_id uuid;
  pay public.payments;
  parts text[];
  owner_name text;
  client_name text;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid session' using errcode = '22023';
  end if;
  if p_environment is null or p_environment not in ('sandbox', 'live') then
    raise exception 'invalid environment' using errcode = '22023';
  end if;

  select p.id into found_id from private.proposal_for_token(p_token) p;
  if found_id is null then
    return;
  end if;
  -- Serialises concurrent checkouts for this proposal (double submits).
  select * into v from public.proposals p where p.id = found_id for update;
  if v.status <> 'active' or v.deletion_requested_at is not null
     or v.original_storage_path is null or v.preview_storage_path is null
     or v.unlock_price_minor is null or v.currency is null or v.total_pages is null then
    return;
  end if;

  parts := string_to_array(v.original_storage_path, '/');
  if coalesce(array_length(parts, 1), 0) <> 4 then
    raise exception 'this document has no immutable revision' using errcode = 'PT423';
  end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'proposals' and o.name = v.original_storage_path
  ) then
    raise exception 'document file is missing' using errcode = 'PT423';
  end if;

  select * into pay
  from public.payments x
  where x.proposal_id = v.id
    and x.checkout_session_hash = p_session_hash
    and x.status = 'created'
    and not x.needs_review
    and x.environment = p_environment
    and x.original_storage_path = v.original_storage_path
    and x.amount_minor = v.unlock_price_minor
    and x.currency = v.currency
    and x.created_at > now() - interval '3 hours'
  order by x.created_at desc
  limit 1;

  if found then
    return query select pay.id, pay.public_ref, pay.amount_minor, pay.currency::text, pay.title_snapshot,
      pay.provider_request_id, pay.provider_order_id, pay.approve_url, true;
    return;
  end if;

  select pr.full_name into owner_name from public.profiles pr where pr.id = v.owner_id;
  select c.name into client_name from public.clients c where c.id = v.client_id;

  insert into public.payments (
    proposal_id, provider, amount_minor, currency, status, public_ref, environment,
    revision_id, original_storage_path, total_pages, free_preview_pages,
    title_snapshot, client_name_snapshot, owner_name_snapshot, checkout_session_hash
  ) values (
    v.id, 'paypal', v.unlock_price_minor, v.currency, 'created', private.new_public_ref(), p_environment,
    parts[3]::uuid, v.original_storage_path, v.total_pages, v.free_preview_pages,
    v.title, coalesce(client_name, '—'), coalesce(owner_name, '—'), p_session_hash
  )
  returning * into pay;

  return query select pay.id, pay.public_ref, pay.amount_minor, pay.currency::text, pay.title_snapshot,
    pay.provider_request_id, pay.provider_order_id, pay.approve_url, false;
end;
$$;

-- Stores the PayPal order created for an attempt (before the browser is
-- sent to PayPal). Idempotent for the same order id; a different one fails.
create function public.payment_record_order(p_payment_id uuid, p_order_id text, p_approve_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
begin
  if p_order_id is null or p_order_id !~ '^[A-Za-z0-9-]{1,64}$' then
    raise exception 'invalid order id' using errcode = '22023';
  end if;
  select * into pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'PT404';
  end if;
  if pay.provider_order_id is not null then
    if pay.provider_order_id <> p_order_id then
      raise exception 'payment already has a different order' using errcode = 'PT409';
    end if;
    return;
  end if;
  if pay.status <> 'created' then
    raise exception 'payment is no longer open' using errcode = 'PT423';
  end if;
  update public.payments
  set provider_order_id = p_order_id, approve_url = p_approve_url, last_synced_at = now()
  where id = p_payment_id;
end;
$$;

-- The purchase as seen by one browser: returned only when the browser
-- started this checkout (bound) or holds a valid access session for its
-- entitlement. Anyone else gets no row (forwarded purchase URLs show nothing).
create function public.payment_session_view(p_public_ref text, p_session_hash text)
returns table (
  payment_id uuid,
  status public.payment_status,
  amount_minor integer,
  currency text,
  title text,
  total_pages integer,
  environment text,
  provider_order_id text,
  approve_url text,
  needs_review boolean,
  created_at timestamptz,
  last_synced_at timestamptz,
  bound boolean,
  entitlement_active boolean,
  has_access boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    pay.id, pay.status, pay.amount_minor, pay.currency::text, pay.title_snapshot, pay.total_pages,
    pay.environment, pay.provider_order_id, pay.approve_url, pay.needs_review, pay.created_at,
    pay.last_synced_at,
    pay.checkout_session_hash = p_session_hash,
    coalesce(ent.status = 'active', false),
    exists (
      select 1 from public.payment_access_sessions s
      where s.entitlement_id = ent.id and s.session_hash = p_session_hash
        and s.revoked_at is null and s.expires_at > now()
    ) and coalesce(ent.status = 'active', false)
  from public.payments pay
  left join public.payment_entitlements ent on ent.payment_id = pay.id
  where p_public_ref ~ '^[A-Za-z0-9_-]{22}$'
    and p_session_hash ~ '^[0-9a-f]{64}$'
    and pay.public_ref = p_public_ref
    and pay.provider = 'paypal'
    and (
      pay.checkout_session_hash = p_session_hash
      or exists (
        select 1 from public.payment_access_sessions s
        where s.entitlement_id = ent.id and s.session_hash = p_session_hash
          and s.revoked_at is null and s.expires_at > now()
      )
    );
$$;

-- Payment for a PayPal order or capture id (webhooks).
create function public.payment_lookup_provider(p_order_id text, p_capture_id text)
returns table (
  payment_id uuid,
  provider_order_id text,
  provider_payment_id text,
  amount_minor integer,
  currency text,
  environment text,
  status public.payment_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select pay.id, pay.provider_order_id, pay.provider_payment_id, pay.amount_minor, pay.currency::text,
    pay.environment, pay.status
  from public.payments pay
  where pay.provider = 'paypal'
    and (
      (p_order_id is not null and pay.provider_order_id = p_order_id)
      or (p_capture_id is not null and pay.provider_payment_id = p_capture_id)
    )
  order by pay.created_at
  limit 2;
$$;

-- Buyer returned through the cancel URL: an attempt that was never
-- approved/captured becomes "cancelled". Only for the initiating browser.
-- A later verified capture can still move it on (see payment_apply_state).
create function public.payment_mark_cancelled(p_payment_id uuid, p_session_hash text)
returns public.payment_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
begin
  select * into pay from public.payments where id = p_payment_id for update;
  if not found or pay.checkout_session_hash is distinct from p_session_hash then
    raise exception 'payment not found' using errcode = 'PT404';
  end if;
  if pay.status = 'created' then
    update public.payments set status = 'cancelled', status_detail = 'BUYER_CANCELLED', last_synced_at = now()
    where id = p_payment_id
    returning status into pay.status;
  end if;
  return pay.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Verified state from PayPal (service_role only)
-- ---------------------------------------------------------------------------
-- Applies a state that server code obtained from the PayPal API (or, for
-- refunds/reversals, from a signature-verified webhook). Re-checks under a
-- row lock:
--   - the order reference is the one stored for this payment;
--   - the capture reference never changes once known;
--   - verified states require the exact stored amount and currency, a
--     capture id, a payee merchant id, and the purchased file in storage;
--   - status only moves forward (monotonic ranks; a late "pending" or
--     "failed" never undoes a verified payment).
-- p_review_reason (set by the caller on any mismatch) flags the payment for
-- review and changes nothing else. First verified state -> one entitlement
-- (unique per payment). Full refund / reversal -> entitlement suspended.
-- Partial refund -> entitlement stays active (documented policy).
create function public.payment_apply_state(
  p_payment_id uuid,
  p_status public.payment_status,
  p_order_id text,
  p_capture_id text,
  p_amount_minor integer,
  p_currency text,
  p_merchant_id text,
  p_payer_email text,
  p_status_detail text,
  p_captured_at timestamptz,
  p_review_reason text
)
returns table (status public.payment_status, entitlement_id uuid, entitlement_status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  ent public.payment_entitlements;
  reason text := p_review_reason;
  old_rank integer;
  new_rank integer;
  allowed boolean;
begin
  select * into pay from public.payments where id = p_payment_id for update;
  if not found or pay.provider <> 'paypal' then
    raise exception 'payment not found' using errcode = 'PT404';
  end if;
  if pay.provider_order_id is null or p_order_id is distinct from pay.provider_order_id then
    raise exception 'order reference does not match this payment' using errcode = 'PT409';
  end if;

  if reason is null and p_capture_id is not null and pay.provider_payment_id is not null
     and p_capture_id <> pay.provider_payment_id then
    reason := 'PayPal reported a different capture for this order';
  end if;

  if reason is null and private.payment_status_rank(p_status) >= 3 then
    if p_capture_id is null then
      reason := 'verified state without a capture reference';
    elsif p_amount_minor is distinct from pay.amount_minor or p_currency is distinct from pay.currency::text then
      reason := 'captured amount or currency differs from the checkout';
    elsif p_merchant_id is null then
      reason := 'payee merchant not confirmed';
    elsif not exists (
      select 1 from storage.objects o where o.bucket_id = 'proposals' and o.name = pay.original_storage_path
    ) then
      reason := 'purchased document file is missing';
    end if;
  end if;

  if reason is not null then
    update public.payments
    set needs_review = true, review_reason = left(reason, 200), last_synced_at = now()
    where id = pay.id;
    select e.* into ent from public.payment_entitlements e where e.payment_id = pay.id;
    return query select pay.status, ent.id, ent.status, false;
    return;
  end if;

  old_rank := private.payment_status_rank(pay.status);
  new_rank := private.payment_status_rank(p_status);
  allowed := case
    when p_status = 'created' then false
    -- Only an attempt nobody paid can be cancelled.
    when p_status = 'cancelled' then pay.status = 'created'
    when p_status = pay.status then true
    when old_rank >= 3 then new_rank > old_rank
    else true
  end;

  if allowed then
    update public.payments
    set status = p_status,
        provider_payment_id = coalesce(pay.provider_payment_id, p_capture_id),
        status_detail = left(p_status_detail, 100),
        payer_email = coalesce(left(p_payer_email, 320), pay.payer_email),
        merchant_id = coalesce(left(p_merchant_id, 64), pay.merchant_id),
        captured_at = coalesce(pay.captured_at, p_captured_at),
        verified_at = case when new_rank >= 3 then coalesce(pay.verified_at, now()) else pay.verified_at end,
        last_synced_at = now()
    where id = pay.id;
  else
    update public.payments set last_synced_at = now() where id = pay.id;
  end if;

  if allowed and new_rank >= 3 then
    insert into public.payment_entitlements (payment_id, proposal_id, owner_id, original_storage_path, total_pages)
    values (pay.id, pay.proposal_id, pay.owner_id, pay.original_storage_path, pay.total_pages)
    on conflict (payment_id) do nothing;

    -- The same browser already holds a verified purchase of this proposal:
    -- keep both (money was taken) but flag for a refund decision.
    if old_rank < 3 and exists (
      select 1 from public.payments other
      where other.proposal_id = pay.proposal_id
        and other.id <> pay.id
        and other.checkout_session_hash = pay.checkout_session_hash
        and private.payment_status_rank(other.status) between 3 and 4
    ) then
      update public.payments
      set needs_review = true, review_reason = 'possible duplicate payment by the same browser'
      where id = pay.id;
    end if;
  end if;

  if allowed and p_status in ('refunded', 'reversed') then
    update public.payment_entitlements e
    set status = 'suspended', suspended_at = coalesce(e.suspended_at, now()), suspended_reason = p_status::text
    where e.payment_id = pay.id;
  end if;

  select e.* into ent from public.payment_entitlements e where e.payment_id = pay.id;
  return query select (select x.status from public.payments x where x.id = pay.id), ent.id, ent.status, allowed and p_status <> pay.status;
end;
$$;

-- Records a refund (from the PayPal API) and returns the completed refund
-- total for the payment.
create function public.payment_record_refund(
  p_payment_id uuid,
  p_refund_id text,
  p_amount_minor integer,
  p_currency text,
  p_status text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  total integer;
begin
  select * into pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'PT404';
  end if;
  if p_currency is distinct from pay.currency::text then
    raise exception 'refund currency differs from the payment' using errcode = '22023';
  end if;

  insert into public.payment_refunds (payment_id, provider_refund_id, amount_minor, currency, status)
  values (pay.id, p_refund_id, p_amount_minor, p_currency, upper(p_status))
  on conflict (provider_refund_id) do update
    set status = excluded.status, amount_minor = excluded.amount_minor, updated_at = now()
    where public.payment_refunds.payment_id = excluded.payment_id;

  select coalesce(sum(r.amount_minor), 0)::integer into total
  from public.payment_refunds r
  where r.payment_id = pay.id and r.status = 'COMPLETED';

  update public.payments set refunded_amount_minor = least(total, pay.amount_minor) where id = pay.id;
  return total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Browser access (service_role only)
-- ---------------------------------------------------------------------------

-- Gives the browser that STARTED the checkout access to the verified
-- purchase. Any other browser (forwarded link or purchase URL) is refused.
create function public.payment_grant_session_access(p_payment_id uuid, p_session_hash text, p_days integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  ent public.payment_entitlements;
begin
  if p_days is null or p_days < 1 or p_days > 400 then
    raise exception 'invalid lifetime' using errcode = '22023';
  end if;
  select e.* into ent
  from public.payment_entitlements e
  join public.payments pay on pay.id = e.payment_id
  where e.payment_id = p_payment_id
    and e.status = 'active'
    and pay.checkout_session_hash = p_session_hash;
  if not found then
    return null;
  end if;

  insert into public.payment_access_sessions (entitlement_id, session_hash, granted_via, expires_at)
  values (ent.id, p_session_hash, 'checkout', now() + make_interval(days => p_days))
  on conflict (entitlement_id, session_hash) do update
    set expires_at = greatest(public.payment_access_sessions.expires_at, excluded.expires_at)
    where public.payment_access_sessions.revoked_at is null;
  return ent.id;
end;
$$;

-- Purchases this browser can open for the proposal a link token resolves
-- to (newest first). Used by the client page to show the full document.
create function public.payment_access_for_link(p_token text, p_session_hash text)
returns table (public_ref text, total_pages integer, verified_at timestamptz, current_revision boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select pay.public_ref, ent.total_pages, pay.verified_at, ent.original_storage_path = p.original_storage_path
  from private.proposal_for_token(p_token) p
  join public.payment_entitlements ent on ent.proposal_id = p.id and ent.status = 'active'
  join public.payments pay on pay.id = ent.payment_id
  where p_session_hash ~ '^[0-9a-f]{64}$'
    and exists (
      select 1 from public.payment_access_sessions s
      where s.entitlement_id = ent.id and s.session_hash = p_session_hash
        and s.revoked_at is null and s.expires_at > now()
    )
  order by ent.original_storage_path = p.original_storage_path desc, pay.verified_at desc
  limit 5;
$$;

-- The purchased file for one browser. Checked on EVERY full-PDF request:
-- active entitlement + unexpired, unrevoked access session of this browser.
-- Returns the storage path of the purchased revision only (never another
-- proposal's or the current revision's, unless that is what was bought).
create function public.payment_document_for_session(p_public_ref text, p_session_hash text)
returns table (original_storage_path text, total_pages integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  path text;
  pages integer;
  sess uuid;
begin
  if p_public_ref !~ '^[A-Za-z0-9_-]{22}$' or p_session_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select e.original_storage_path, e.total_pages, s.id into path, pages, sess
  from public.payments pay
  join public.payment_entitlements e on e.payment_id = pay.id and e.status = 'active'
  join public.payment_access_sessions s on s.entitlement_id = e.id
  where pay.public_ref = p_public_ref
    and s.session_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > now();
  if sess is null then
    return;
  end if;
  update public.payment_access_sessions set last_used_at = now() where id = sess;
  return query select path, pages;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Recovery tokens (service_role only)
-- ---------------------------------------------------------------------------

-- Email recovery request: issues a single-use token only when the typed
-- address matches the PayPal payer email or the portal client's email of
-- an ACTIVE purchase of this link's proposal. The token itself is sent to
-- that address; typing an email never grants access. At most 3 open tokens
-- per purchase. No row = nothing to send (the caller answers identically).
create function public.payment_recovery_request(p_token text, p_email text, p_token_hash text, p_ttl_minutes integer)
returns table (title text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  ent_id uuid;
  ent_title text;
begin
  if p_ttl_minutes is null or p_ttl_minutes < 5 or p_ttl_minutes > 1440 then
    raise exception 'invalid lifetime' using errcode = '22023';
  end if;
  if p_email is null or char_length(p_email) > 320 or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return;
  end if;

  select ent.id, pay.title_snapshot into ent_id, ent_title
  from private.proposal_for_token(p_token) p
  join public.payment_entitlements ent on ent.proposal_id = p.id and ent.status = 'active'
  join public.payments pay on pay.id = ent.payment_id
  left join public.clients c on c.id = pay.client_id
  where lower(pay.payer_email) = lower(btrim(p_email)) or lower(c.email) = lower(btrim(p_email))
  order by pay.verified_at desc
  limit 1;

  if ent_id is null then
    return;
  end if;
  if (select count(*) from public.payment_recovery_tokens t
      where t.entitlement_id = ent_id and t.used_at is null and t.expires_at > now()) >= 3 then
    return;
  end if;

  insert into public.payment_recovery_tokens (entitlement_id, token_hash, issued_via, expires_at)
  values (ent_id, p_token_hash, 'email', now() + make_interval(mins => p_ttl_minutes));
  return query select ent_title;
end;
$$;

-- Dashboard recovery link: the payment's owner or an admin issues a
-- single-use token for an active purchase and sends the link themselves.
create function public.payment_recovery_issue(p_actor uuid, p_payment_id uuid, p_token_hash text, p_ttl_minutes integer)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  ent public.payment_entitlements;
  expires timestamptz;
begin
  if p_ttl_minutes is null or p_ttl_minutes < 5 or p_ttl_minutes > 10080 then
    raise exception 'invalid lifetime' using errcode = '22023';
  end if;
  select e.* into ent
  from public.payment_entitlements e
  join public.payments pay on pay.id = e.payment_id
  where e.payment_id = p_payment_id
    and exists (
      select 1 from public.profiles pr
      where pr.id = p_actor and (pr.role = 'admin' or pr.id = pay.owner_id)
    );
  if not found then
    raise exception 'payment not found' using errcode = 'PT404';
  end if;
  if ent.status <> 'active' then
    raise exception 'access for this payment is suspended' using errcode = 'PT423';
  end if;

  insert into public.payment_recovery_tokens (entitlement_id, token_hash, issued_via, issued_by, expires_at)
  values (ent.id, p_token_hash, 'dashboard', p_actor, now() + make_interval(mins => p_ttl_minutes))
  returning expires_at into expires;
  return expires;
end;
$$;

-- Is a recovery token still redeemable? (Shown before the browser redeems
-- it; does NOT consume it, so link scanners can't burn it.)
create function public.payment_recovery_peek(p_token_hash text)
returns table (title text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select pay.title_snapshot, t.expires_at
  from public.payment_recovery_tokens t
  join public.payment_entitlements ent on ent.id = t.entitlement_id and ent.status = 'active'
  join public.payments pay on pay.id = ent.payment_id
  where t.token_hash = p_token_hash and t.used_at is null and t.expires_at > now();
$$;

-- Redeems a token once, atomically, and gives THIS browser access.
create function public.payment_recovery_consume(p_token_hash text, p_session_hash text, p_days integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ent_id uuid;
  ref text;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid session' using errcode = '22023';
  end if;
  if p_days is null or p_days < 1 or p_days > 400 then
    raise exception 'invalid lifetime' using errcode = '22023';
  end if;

  update public.payment_recovery_tokens t
  set used_at = now()
  where t.token_hash = p_token_hash
    and t.used_at is null
    and t.expires_at > now()
    and exists (select 1 from public.payment_entitlements e where e.id = t.entitlement_id and e.status = 'active')
  returning t.entitlement_id into ent_id;
  if ent_id is null then
    return null;
  end if;

  insert into public.payment_access_sessions (entitlement_id, session_hash, granted_via, expires_at)
  values (ent_id, p_session_hash, 'recovery', now() + make_interval(days => p_days))
  on conflict (entitlement_id, session_hash) do update
    set expires_at = greatest(public.payment_access_sessions.expires_at, excluded.expires_at),
        revoked_at = null;

  select pay.public_ref into ref
  from public.payment_entitlements e join public.payments pay on pay.id = e.payment_id
  where e.id = ent_id;
  return ref;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Webhook events (service_role only)
-- ---------------------------------------------------------------------------
-- Records a verified delivery. Returns the event row id and its current
-- result: 'received'/'error' means "process it (again)", anything else is
-- a duplicate that was already handled.
create function public.payment_event_begin(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_resource_type text,
  p_resource_id text
)
returns table (id uuid, result text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  insert into public.payment_events as e (provider, provider_event_id, event_type, resource_type, resource_id)
  values (p_provider, p_event_id, left(p_event_type, 100), left(p_resource_type, 50), left(p_resource_id, 64))
  on conflict (provider, provider_event_id) do update set attempts = e.attempts + 1
  returning e.id, e.result;
end;
$$;

create function public.payment_event_finish(p_id uuid, p_result text, p_payment_id uuid, p_detail text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.payment_events
  set result = p_result, payment_id = coalesce(p_payment_id, payment_id), detail = left(p_detail, 200), processed_at = now()
  where id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants for the functions
-- ---------------------------------------------------------------------------
revoke all on function public.payment_begin_checkout(text, text, text) from public, anon, authenticated;
revoke all on function public.payment_record_order(uuid, text, text) from public, anon, authenticated;
revoke all on function public.payment_session_view(text, text) from public, anon, authenticated;
revoke all on function public.payment_lookup_provider(text, text) from public, anon, authenticated;
revoke all on function public.payment_mark_cancelled(uuid, text) from public, anon, authenticated;
revoke all on function public.payment_apply_state(uuid, public.payment_status, text, text, integer, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.payment_record_refund(uuid, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.payment_grant_session_access(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.payment_access_for_link(text, text) from public, anon, authenticated;
revoke all on function public.payment_document_for_session(text, text) from public, anon, authenticated;
revoke all on function public.payment_recovery_request(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.payment_recovery_issue(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.payment_recovery_peek(text) from public, anon, authenticated;
revoke all on function public.payment_recovery_consume(text, text, integer) from public, anon, authenticated;
revoke all on function public.payment_event_begin(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.payment_event_finish(uuid, text, uuid, text) from public, anon, authenticated;

grant execute on function public.payment_begin_checkout(text, text, text) to service_role;
grant execute on function public.payment_record_order(uuid, text, text) to service_role;
grant execute on function public.payment_session_view(text, text) to service_role;
grant execute on function public.payment_lookup_provider(text, text) to service_role;
grant execute on function public.payment_mark_cancelled(uuid, text) to service_role;
grant execute on function public.payment_apply_state(uuid, public.payment_status, text, text, integer, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.payment_record_refund(uuid, text, integer, text, text) to service_role;
grant execute on function public.payment_grant_session_access(uuid, text, integer) to service_role;
grant execute on function public.payment_access_for_link(text, text) to service_role;
grant execute on function public.payment_document_for_session(text, text) to service_role;
grant execute on function public.payment_recovery_request(text, text, text, integer) to service_role;
grant execute on function public.payment_recovery_issue(uuid, uuid, text, integer) to service_role;
grant execute on function public.payment_recovery_peek(text) to service_role;
grant execute on function public.payment_recovery_consume(text, text, integer) to service_role;
grant execute on function public.payment_event_begin(text, text, text, text, text) to service_role;
grant execute on function public.payment_event_finish(uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Dashboard views (security_invoker: the caller's RLS applies)
-- ---------------------------------------------------------------------------
-- One row per checkout attempt. Proposal title is the snapshot at checkout
-- (what was bought); client and Team Lead names are the current names,
-- falling back to the snapshot if the record is gone.
create view public.payment_list
with (security_invoker = true)
as
select
  pay.id,
  pay.owner_id,
  pay.proposal_id,
  pay.client_id,
  pay.provider,
  pay.environment,
  coalesce(c.name, pay.client_name_snapshot) as client_name,
  coalesce(pay.title_snapshot, pr.title) as proposal_title,
  pay.revision_id,
  pay.amount_minor,
  pay.currency::text as currency,
  pay.status,
  pay.status_detail,
  pay.needs_review,
  pay.review_reason,
  pay.refunded_amount_minor,
  pay.captured_at,
  pay.verified_at,
  pay.provider_payment_id,
  pay.provider_order_id,
  pay.created_at,
  pay.updated_at,
  coalesce(o.full_name, pay.owner_name_snapshot) as owner_name,
  coalesce(pay.title_snapshot, pr.title, '') || E'\n' || coalesce(c.name, pay.client_name_snapshot, '') as search_text
from public.payments pay
left join public.clients c on c.id = pay.client_id
left join public.proposals pr on pr.id = pay.proposal_id
left join public.profiles o on o.id = pay.owner_id;

-- Counts and sums per owner/currency/status, for summary cards. Never mixes
-- currencies; the application groups by currency.
create view public.payment_totals
with (security_invoker = true)
as
select
  pay.owner_id,
  pay.currency::text as currency,
  pay.status,
  count(*)::integer as payments,
  coalesce(sum(pay.amount_minor), 0)::bigint as amount_minor,
  coalesce(sum(pay.refunded_amount_minor), 0)::bigint as refunded_minor
from public.payments pay
group by pay.owner_id, pay.currency, pay.status;

revoke all on table public.payment_list, public.payment_totals from anon, authenticated;
grant select on table public.payment_list, public.payment_totals to authenticated;

comment on view public.payment_list is
  'Dashboard payments list. security_invoker: callers only see rows their RLS allows.';
comment on view public.payment_totals is
  'Dashboard payment counts and sums per owner, currency and status. security_invoker.';
