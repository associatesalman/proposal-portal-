-- Phase 4: PDF upload, preview generation, offer settings and private links.
--
-- 1. New proposal columns: original file metadata and the private-link token
--    hash. Only a SHA-256 hash of the link token is stored; the raw token is
--    shown once when it is generated.
-- 2. Storage paths gain an immutable revision folder:
--      {owner_id}/{proposal_id}/{revision_uuid}/original.pdf
--      {owner_id}/{proposal_id}/{revision_uuid}/preview.pdf
--    A replacement upload never overwrites the document currently in use.
--    The Phase 2 fixed paths stay valid so existing rows remain valid.
-- 3. Database invariants: a preview needs a verified original and
--    1 <= free_preview_pages < total_pages; a positive price; a supported
--    currency; "active" <=> a link token exists, and only fully prepared
--    proposals can be active. Active proposals are locked until the link is
--    revoked (status returns to draft).
-- 4. Grants: browser roles can no longer write offer fields or status, and
--    cannot read the token hash. PDF metadata, offer values and link state
--    are written only by the trusted functions below. Those are executable
--    only by service_role and called from server code after the uploaded
--    bytes have been verified, with the acting user's id; each function
--    re-checks that user's access.
-- 5. Storage policies: uploads only into draft proposals; no overwrites
--    (no update policy); objects currently referenced by a proposal cannot
--    be deleted, so cleanup only removes superseded or orphaned files.
-- 6. resolve_proposal_link(token): returns only the title of an active
--    proposal whose token hash matches. Executable by anon; never lists rows.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.proposals
  add column original_file_name text
    constraint proposals_original_file_name_length
      check (original_file_name is null or char_length(original_file_name) between 1 and 255),
  add column original_size_bytes bigint
    constraint proposals_original_size_positive
      check (original_size_bytes is null or original_size_bytes > 0),
  add column link_token_hash text
    constraint proposals_link_token_hash_format
      check (link_token_hash is null or link_token_hash ~ '^[0-9a-f]{64}$')
    constraint proposals_link_token_hash_key unique,
  add column link_created_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Storage path formats (legacy fixed path or immutable revision path)
-- ---------------------------------------------------------------------------
alter table public.proposals
  drop constraint proposals_original_path_format,
  drop constraint proposals_preview_path_format;

alter table public.proposals
  add constraint proposals_original_path_format check (
    original_storage_path is null
    or original_storage_path = owner_id::text || '/' || id::text || '/original.pdf'
    or original_storage_path ~ (
      '^' || owner_id::text || '/' || id::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original\.pdf$'
    )
  ),
  add constraint proposals_preview_path_format check (
    preview_storage_path is null
    or preview_storage_path = owner_id::text || '/' || id::text || '/preview.pdf'
    or preview_storage_path ~ (
      '^' || owner_id::text || '/' || id::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/preview\.pdf$'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Invariants
-- ---------------------------------------------------------------------------
alter table public.proposals
  -- A page count only exists for a stored original, and vice versa.
  add constraint proposals_original_has_page_count check (
    (original_storage_path is null) = (total_pages is null)
  ),
  add constraint proposals_original_metadata_requires_original check (
    original_storage_path is not null
    or (original_file_name is null and original_size_bytes is null)
  ),
  -- A preview is generated from the stored original and leaves at least one
  -- page locked.
  add constraint proposals_preview_requires_original check (
    preview_storage_path is null
    or (
      original_storage_path is not null
      and preview_storage_path <> original_storage_path
      and free_preview_pages is not null
      and free_preview_pages < total_pages
    )
  ),
  add constraint proposals_unlock_price_positive check (
    unlock_price_minor is null or unlock_price_minor > 0
  ),
  -- Keep in sync with src/lib/proposals/currencies.ts.
  add constraint proposals_currency_supported check (
    currency is null or currency in ('USD', 'EUR', 'GBP', 'AED', 'PKR', 'JPY')
  ),
  add constraint proposals_link_fields_together check (
    (link_token_hash is null) = (link_created_at is null)
  ),
  -- Active means "has a usable private link", and only prepared proposals
  -- can have one.
  add constraint proposals_active_iff_link check (
    (status = 'active') = (link_token_hash is not null)
  ),
  add constraint proposals_active_requires_preview check (
    status <> 'active' or preview_storage_path is not null
  );

-- Active proposals are locked: revoke the link (back to draft) before
-- changing the document, offer or title. Applies to every role.
create function private.lock_active_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'active' and new.status = 'active' and (
       new.title is distinct from old.title
    or new.original_storage_path is distinct from old.original_storage_path
    or new.original_file_name is distinct from old.original_file_name
    or new.original_size_bytes is distinct from old.original_size_bytes
    or new.total_pages is distinct from old.total_pages
    or new.preview_storage_path is distinct from old.preview_storage_path
    or new.free_preview_pages is distinct from old.free_preview_pages
    or new.unlock_price_minor is distinct from old.unlock_price_minor
    or new.currency is distinct from old.currency
    or new.link_token_hash is distinct from old.link_token_hash
  ) then
    raise exception 'active proposals are locked; revoke the link first'
      using errcode = 'PT423';
  end if;
  return new;
end;
$$;

revoke all on function private.lock_active_proposal() from public;

create trigger proposals_lock_active
  before update on public.proposals
  for each row execute function private.lock_active_proposal();

-- ---------------------------------------------------------------------------
-- 4. Grants for browser roles
-- ---------------------------------------------------------------------------
-- Drafts are created bare; offer values and status are written only by the
-- trusted functions below.
revoke insert (free_preview_pages, unlock_price_minor, currency)
  on table public.proposals from authenticated;
revoke update (free_preview_pages, unlock_price_minor, currency, status)
  on table public.proposals from authenticated;

-- Every column except link_token_hash stays readable (RLS still limits rows).
revoke select on table public.proposals from authenticated;
grant select (
  id, client_id, owner_id, title,
  original_storage_path, preview_storage_path, total_pages,
  free_preview_pages, unlock_price_minor, currency, status,
  created_at, updated_at,
  original_file_name, original_size_bytes, link_created_at
) on table public.proposals to authenticated;

-- ---------------------------------------------------------------------------
-- Trusted write functions (service_role only)
--
-- Called by server code after it has authenticated the user through Supabase
-- Auth and verified the stored PDF bytes. p_actor is that user's id; every
-- function re-checks that the actor is the proposal's owner or an admin, so
-- a bug in the caller cannot widen access. Rows are locked FOR UPDATE and
-- compare-and-swap on the expected storage path, so concurrent or stale
-- submissions fail with PT409 instead of overwriting newer state.
--
-- Error codes: PT404 not found / no access, PT409 stale, PT423 wrong state,
-- 22023 invalid argument, 23514 invariant violated.
-- ---------------------------------------------------------------------------
create function private.lock_managed_proposal(p_actor uuid, p_proposal_id uuid)
returns public.proposals
language plpgsql
set search_path = ''
as $$
declare
  v public.proposals;
begin
  select * into v from public.proposals where id = p_proposal_id for update;

  if not found or not exists (
    select 1
    from public.profiles pr
    where pr.id = p_actor
      and (pr.role = 'admin' or pr.id = v.owner_id)
  ) then
    raise exception 'proposal not found' using errcode = 'PT404';
  end if;

  return v;
end;
$$;

revoke all on function private.lock_managed_proposal(uuid, uuid) from public;

create function public.proposal_attach_original(
  p_actor uuid,
  p_proposal_id uuid,
  p_expected_original_path text,
  p_path text,
  p_file_name text,
  p_size_bytes bigint,
  p_total_pages integer
)
returns table (previous_original_path text, previous_preview_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
begin
  v := private.lock_managed_proposal(p_actor, p_proposal_id);

  if v.status <> 'draft' then
    raise exception 'only drafts can change their document' using errcode = 'PT423';
  end if;
  if v.original_storage_path is distinct from p_expected_original_path then
    raise exception 'proposal changed since it was loaded' using errcode = 'PT409';
  end if;
  if p_path is null or p_path !~ '/[0-9a-f-]{36}/original\.pdf$' then
    raise exception 'invalid original path' using errcode = '22023';
  end if;
  if p_total_pages is null or p_total_pages < 2 then
    raise exception 'a paid preview needs at least two pages' using errcode = '22023';
  end if;

  -- The previous preview was cut from the previous original, so it is
  -- dropped. Offer values are kept as a starting point if still valid.
  update public.proposals
  set original_storage_path = p_path,
      original_file_name = p_file_name,
      original_size_bytes = p_size_bytes,
      total_pages = p_total_pages,
      preview_storage_path = null,
      free_preview_pages = case
        when free_preview_pages < p_total_pages then free_preview_pages
      end
  where id = p_proposal_id;

  return query select v.original_storage_path, v.preview_storage_path;
end;
$$;

create function public.proposal_save_offer(
  p_actor uuid,
  p_proposal_id uuid,
  p_expected_original_path text,
  p_preview_path text,
  p_free_pages integer,
  p_price_minor integer,
  p_currency text
)
returns table (previous_preview_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
begin
  v := private.lock_managed_proposal(p_actor, p_proposal_id);

  if v.status <> 'draft' then
    raise exception 'only drafts can change their offer' using errcode = 'PT423';
  end if;
  -- The preview was generated from this exact original.
  if v.original_storage_path is null
     or v.original_storage_path is distinct from p_expected_original_path then
    raise exception 'proposal changed since it was loaded' using errcode = 'PT409';
  end if;
  if p_preview_path is null or p_preview_path !~ '/[0-9a-f-]{36}/preview\.pdf$' then
    raise exception 'invalid preview path' using errcode = '22023';
  end if;

  -- Bounds, price and currency are enforced by table constraints.
  update public.proposals
  set preview_storage_path = p_preview_path,
      free_preview_pages = p_free_pages,
      unlock_price_minor = p_price_minor,
      currency = p_currency
  where id = p_proposal_id;

  return query select v.preview_storage_path;
end;
$$;

create function public.proposal_issue_link(
  p_actor uuid,
  p_proposal_id uuid,
  p_expected_preview_path text,
  p_token_hash text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
  created timestamptz;
begin
  v := private.lock_managed_proposal(p_actor, p_proposal_id);

  if v.status <> 'draft' then
    raise exception 'proposal already has a link or is archived' using errcode = 'PT423';
  end if;
  if v.preview_storage_path is null
     or v.preview_storage_path is distinct from p_expected_preview_path then
    raise exception 'proposal changed since it was loaded' using errcode = 'PT409';
  end if;

  -- Readiness (preview, offer, token format) is enforced by table constraints.
  update public.proposals
  set status = 'active',
      link_token_hash = p_token_hash,
      link_created_at = now()
  where id = p_proposal_id
  returning link_created_at into created;

  return created;
end;
$$;

create function public.proposal_revoke_link(p_actor uuid, p_proposal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
begin
  v := private.lock_managed_proposal(p_actor, p_proposal_id);

  if v.status <> 'active' then
    raise exception 'proposal has no active link' using errcode = 'PT423';
  end if;

  update public.proposals
  set status = 'draft',
      link_token_hash = null,
      link_created_at = null
  where id = p_proposal_id;
end;
$$;

revoke all on function public.proposal_attach_original(uuid, uuid, text, text, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.proposal_save_offer(uuid, uuid, text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.proposal_issue_link(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.proposal_revoke_link(uuid, uuid) from public, anon, authenticated;
grant execute on function public.proposal_attach_original(uuid, uuid, text, text, text, bigint, integer) to service_role;
grant execute on function public.proposal_save_offer(uuid, uuid, text, text, integer, integer, text) to service_role;
grant execute on function public.proposal_issue_link(uuid, uuid, text, text) to service_role;
grant execute on function public.proposal_revoke_link(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Storage policies
-- ---------------------------------------------------------------------------
-- Parses {owner}/{proposal}/original.pdf (legacy) or
-- {owner}/{proposal}/{revision}/(original|preview).pdf and returns the
-- proposal it belongs to, if the caller can see it (proposals RLS applies).
create function private.proposal_for_object(object_name text)
returns public.proposals
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  parts text[];
  n integer;
  v public.proposals;
begin
  if object_name is null then
    return null;
  end if;

  parts := string_to_array(object_name, '/');
  n := coalesce(array_length(parts, 1), 0);

  if n not in (3, 4)
     or parts[1] !~ uuid_pattern
     or parts[2] !~ uuid_pattern
     or (n = 4 and parts[3] !~ uuid_pattern)
     or parts[n] not in ('original.pdf', 'preview.pdf') then
    return null;
  end if;

  select * into v
  from public.proposals p
  where p.id = parts[2]::uuid
    and p.owner_id = parts[1]::uuid
    and (p.owner_id = (select auth.uid()) or (select private.is_admin()));

  return v;
end;
$$;

-- Read: any object of a proposal the caller manages.
create or replace function private.can_access_proposal_object(object_name text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select (private.proposal_for_object(object_name)).id is not null;
$$;

-- Upload: only into draft proposals.
create function private.can_upload_proposal_object(object_name text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((private.proposal_for_object(object_name)).status = 'draft', false);
$$;

-- Delete: only objects the proposal no longer references (superseded or
-- failed uploads). The document and preview in use cannot be deleted.
create function private.can_delete_proposal_object(object_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v public.proposals;
begin
  v := private.proposal_for_object(object_name);
  return v.id is not null
    and object_name is distinct from v.original_storage_path
    and object_name is distinct from v.preview_storage_path;
end;
$$;

revoke all on function private.proposal_for_object(text) from public;
revoke all on function private.can_upload_proposal_object(text) from public;
revoke all on function private.can_delete_proposal_object(text) from public;
grant execute on function private.proposal_for_object(text) to authenticated;
grant execute on function private.can_upload_proposal_object(text) to authenticated;
grant execute on function private.can_delete_proposal_object(text) to authenticated;

drop policy "proposals_bucket_insert_own_or_admin" on storage.objects;
drop policy "proposals_bucket_update_own_or_admin" on storage.objects;
drop policy "proposals_bucket_delete_own_or_admin" on storage.objects;

create policy "proposals_bucket_insert_draft_own_or_admin"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'proposals' and private.can_upload_proposal_object(name));

-- No update policy: stored objects are immutable (no overwrite / upsert).

create policy "proposals_bucket_delete_unreferenced_own_or_admin"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'proposals' and private.can_delete_proposal_object(name));

-- ---------------------------------------------------------------------------
-- 6. Private link resolution
-- ---------------------------------------------------------------------------
-- Takes the raw token (43 base64url characters = 256 bits), hashes it here,
-- and returns only the title of the matching active proposal. Unknown,
-- malformed and revoked tokens all return no row. Hashing in the database
-- means a leaked hash cannot be used as a link.
create function public.resolve_proposal_link(p_token text)
returns table (title text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.title
  from public.proposals p
  where p_token ~ '^[A-Za-z0-9_-]{43}$'
    and p.status = 'active'
    and p.link_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

revoke all on function public.resolve_proposal_link(text) from public, anon, authenticated;
grant execute on function public.resolve_proposal_link(text) to anon, authenticated, service_role;

comment on function public.resolve_proposal_link(text) is
  'Phase 4 link check: title of the active proposal for a raw private-link token, or nothing.';
