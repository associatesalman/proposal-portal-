-- Phase 2: privileges and row-level security.
--
-- Model:
--   admin     -> read/manage all clients and proposals; read all payments and profiles
--   team_lead -> read/manage only rows where owner_id = auth.uid(); read payments of own proposals
--   anon      -> no access to any application table
--   payments  -> read-only for internal users; writes only via trusted server code (service role)
--   profiles  -> read-only for internal users; created/changed only by trusted admin SQL
--
-- Two layers: table/column GRANTs decide which columns a role may touch at all;
-- RLS policies decide which rows.

-- ---------------------------------------------------------------------------
-- Role helper. SECURITY DEFINER so it can read profiles without re-entering
-- the profiles RLS policy (avoids recursion). Fixed empty search_path, fully
-- qualified names, lives in the non-exposed `private` schema, executable only
-- by the `authenticated` role.
-- ---------------------------------------------------------------------------
create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

revoke all on function private.is_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges. Supabase grants broad table privileges to anon/authenticated by
-- default; start from nothing and grant back only what is needed.
-- service_role (trusted server code) keeps its default privileges and
-- bypasses RLS.
-- ---------------------------------------------------------------------------
revoke all on table
  public.profiles,
  public.clients,
  public.proposals,
  public.payments
from anon, authenticated;

-- profiles: read only. No insert/update/delete for any browser role, so roles
-- cannot be changed and accounts cannot be provisioned through the API.
grant select on table public.profiles to authenticated;

-- clients: owner_id is settable on insert (checked by RLS) but never updatable.
grant select, delete on table public.clients to authenticated;
grant insert (owner_id, name, email) on table public.clients to authenticated;
grant update (name, email) on table public.clients to authenticated;

-- proposals: storage paths and total_pages are server-controlled (set by
-- trusted server code after validating the uploaded PDF in Phase 4).
-- status is not insertable (defaults to draft) and owner_id is never updatable.
grant select, delete on table public.proposals to authenticated;
grant insert (client_id, owner_id, title, free_preview_pages, unlock_price_minor, currency)
  on table public.proposals to authenticated;
grant update (client_id, title, free_preview_pages, unlock_price_minor, currency, status)
  on table public.proposals to authenticated;

-- payments: read only for internal users.
grant select on table public.payments to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.proposals enable row level security;
alter table public.payments enable row level security;

-- profiles ------------------------------------------------------------------
create policy "profiles_select_own_or_admin"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));

-- clients -------------------------------------------------------------------
create policy "clients_select_own_or_admin"
  on public.clients
  for select
  to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));

create policy "clients_insert_own_or_admin"
  on public.clients
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()) or (select private.is_admin()));

create policy "clients_update_own_or_admin"
  on public.clients
  for update
  to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()))
  with check (owner_id = (select auth.uid()) or (select private.is_admin()));

create policy "clients_delete_own_or_admin"
  on public.clients
  for delete
  to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));

-- proposals -----------------------------------------------------------------
-- The composite FK (client_id, owner_id) -> clients(id, owner_id) additionally
-- guarantees the referenced client belongs to the same owner.
create policy "proposals_select_own_or_admin"
  on public.proposals
  for select
  to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));

create policy "proposals_insert_own_or_admin"
  on public.proposals
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()) or (select private.is_admin()));

create policy "proposals_update_own_or_admin"
  on public.proposals
  for update
  to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()))
  with check (owner_id = (select auth.uid()) or (select private.is_admin()));

create policy "proposals_delete_own_or_admin"
  on public.proposals
  for delete
  to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));

-- payments ------------------------------------------------------------------
-- Select only. There are intentionally no insert/update/delete policies.
create policy "payments_select_own_proposals_or_admin"
  on public.payments
  for select
  to authenticated
  using (
    (select private.is_admin())
    or exists (
      select 1
      from public.proposals p
      where p.id = payments.proposal_id
        and p.owner_id = (select auth.uid())
    )
  );
