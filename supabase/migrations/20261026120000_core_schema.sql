-- Phase 2: core schema for the Editorial Proposal Portal.
--
-- Tables: profiles, clients, proposals, payments.
-- Access rules (RLS, grants) live in the next migration; storage in the one after.
--
-- Deletion behaviour (intentional):
--   auth.users  -> profiles : CASCADE  (a profile cannot outlive its auth user)
--   profiles    -> clients / proposals : RESTRICT (an account that owns records cannot be deleted)
--   clients     -> proposals : RESTRICT (archive proposals instead of deleting clients)
--   proposals   -> payments  : RESTRICT (payment history is never cascaded away)
-- Net effect: deleting an auth user who owns records fails; payment history is preserved.

-- ---------------------------------------------------------------------------
-- Private schema for helper/trigger functions. Not exposed through the Data API.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'team_lead');
create type public.proposal_status as enum ('draft', 'active', 'archived');
create type public.payment_status as enum (
  'created',
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'refunded'
);

-- ---------------------------------------------------------------------------
-- profiles: one row per internal account, provisioned manually by an admin.
-- The role lives only here; it is never derived from auth user metadata.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null
    constraint profiles_full_name_length check (char_length(btrim(full_name)) between 1 and 200),
  role public.app_role not null default 'team_lead',
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Internal accounts (1 admin, 5 team leads). Rows are created manually by a trusted administrator.';

-- ---------------------------------------------------------------------------
-- clients: owned by exactly one internal user.
-- ---------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete restrict,
  name text not null
    constraint clients_name_length check (char_length(btrim(name)) between 1 and 200),
  email text not null
    constraint clients_email_format check (
      char_length(email) <= 320
      and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of the composite FK from proposals: lets the database enforce
  -- that a proposal's client belongs to the proposal's owner.
  constraint clients_id_owner_id_key unique (id, owner_id)
);

create index clients_owner_id_idx on public.clients (owner_id);

-- ---------------------------------------------------------------------------
-- proposals
-- ---------------------------------------------------------------------------
create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  title text not null
    constraint proposals_title_length check (char_length(btrim(title)) between 1 and 300),
  original_storage_path text,
  preview_storage_path text,
  total_pages integer
    constraint proposals_total_pages_positive check (total_pages is null or total_pages > 0),
  free_preview_pages integer not null default 1
    constraint proposals_free_preview_pages_positive check (free_preview_pages >= 1),
  unlock_price_minor integer not null
    constraint proposals_unlock_price_nonnegative check (unlock_price_minor >= 0),
  currency char(3) not null
    constraint proposals_currency_format check (currency ~ '^[A-Z]{3}$'),
  status public.proposal_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The client must belong to the same owner as the proposal.
  constraint proposals_client_owner_fkey
    foreign key (client_id, owner_id) references public.clients (id, owner_id)
    on delete restrict,

  constraint proposals_free_pages_within_total check (
    total_pages is null or free_preview_pages <= total_pages
  ),

  -- Storage paths are fixed by owner and proposal id, so a record can only
  -- ever point at its own objects: {owner_id}/{proposal_id}/original.pdf
  constraint proposals_original_path_format check (
    original_storage_path is null
    or original_storage_path = owner_id::text || '/' || id::text || '/original.pdf'
  ),
  constraint proposals_preview_path_format check (
    preview_storage_path is null
    or preview_storage_path = owner_id::text || '/' || id::text || '/preview.pdf'
  ),

  -- A proposal can only be active once its PDF has been processed.
  constraint proposals_active_requires_documents check (
    status <> 'active'
    or (
      original_storage_path is not null
      and preview_storage_path is not null
      and total_pages is not null
    )
  )
);

create index proposals_owner_id_idx on public.proposals (owner_id);
create index proposals_client_id_owner_id_idx on public.proposals (client_id, owner_id);
create index proposals_status_idx on public.proposals (status);

-- ---------------------------------------------------------------------------
-- payments: one row per payment attempt. Written only by trusted server code
-- (Phase 6). Paid client access will be modelled separately; there is
-- deliberately no "paid" flag on proposals.
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete restrict,
  provider text not null
    constraint payments_provider_format check (provider ~ '^[a-z0-9_-]{1,50}$'),
  provider_payment_id text
    constraint payments_provider_payment_id_length check (
      provider_payment_id is null or char_length(provider_payment_id) between 1 and 255
    ),
  amount_minor integer not null
    constraint payments_amount_nonnegative check (amount_minor >= 0),
  currency char(3) not null
    constraint payments_currency_format check (currency ~ '^[A-Z]{3}$'),
  status public.payment_status not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A provider reference can map to at most one payment row (NULLs allowed
  -- until the provider assigns one).
  constraint payments_provider_payment_id_key unique (provider, provider_payment_id)
);

create index payments_proposal_id_idx on public.payments (proposal_id);
create index payments_status_idx on public.payments (status);

-- ---------------------------------------------------------------------------
-- Server-controlled timestamps
-- ---------------------------------------------------------------------------
create function private.set_timestamps()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
  else
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create function private.set_created_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger profiles_set_created_at
  before insert or update on public.profiles
  for each row execute function private.set_created_at();

create trigger clients_set_timestamps
  before insert or update on public.clients
  for each row execute function private.set_timestamps();

create trigger proposals_set_timestamps
  before insert or update on public.proposals
  for each row execute function private.set_timestamps();

create trigger payments_set_timestamps
  before insert or update on public.payments
  for each row execute function private.set_timestamps();

-- ---------------------------------------------------------------------------
-- Ownership is immutable for application users (admin included): storage
-- paths embed owner_id, so a transfer needs a dedicated trusted procedure
-- that also moves objects. Trusted roles (postgres, service_role) may still
-- run such a procedure later.
-- ---------------------------------------------------------------------------
create function private.prevent_owner_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id
     and current_user in ('authenticated', 'anon') then
    raise exception 'owner_id cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger clients_prevent_owner_change
  before update of owner_id on public.clients
  for each row execute function private.prevent_owner_change();

create trigger proposals_prevent_owner_change
  before update of owner_id on public.proposals
  for each row execute function private.prevent_owner_change();

-- Trigger functions are invoked by the trigger mechanism, not called directly.
revoke all on function private.set_timestamps() from public;
revoke all on function private.set_created_at() from public;
revoke all on function private.prevent_owner_change() from public;
