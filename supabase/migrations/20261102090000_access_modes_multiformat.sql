-- Manual Full Access links, document downloads and multi-format sources.
--
-- Forward-only and additive. Existing rows keep their behaviour:
--   - access_mode is added with the default 'preview' (a catalog-only change,
--     no row is rewritten), so every existing proposal and link stays a
--     preview link;
--   - the source_* columns are NULL for every existing row, meaning "the
--     uploaded file was the PDF itself".
--
-- Access modes (authoritative here, never taken from the browser):
--   preview  the existing behaviour: a separate preview PDF with the first N
--            pages, a price, locked pages and the payment panel.
--   full     a Full Access link: the holder can read and download the whole
--            canonical PDF of ONE document revision (and its original source
--            file, if it wasn't a PDF). No preview, price or payment. Granted
--            manually by the owner or the CEO (e.g. after an offline
--            payment); this is NOT a payment and creates no payment record.
--
-- Changing the mode is only possible on a draft (no active link), so the
-- access behind an issued link never changes silently: revoke (the old token
-- is cleared and stays invalid), switch the mode, then issue a new token.
--
-- Every Full Access link is recorded in proposal_full_access_grants: who
-- granted it, when, for which revision, with an optional internal note, and
-- when/by whom it ended (revocation or deletion). The full-document resolver
-- only serves a link that has an open grant for the current revision.
--
-- Multi-format sources: a revision folder {owner}/{proposal}/{revision}/ may
-- now also hold source.(docx|doc|odt|rtf|txt), the file as uploaded. The
-- canonical original.pdf (converted on the server) is what is viewed,
-- counted, previewed and downloaded as PDF. Storage policies, deletion
-- protection and the cleanup scan treat the source like the original.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.proposals
  add column access_mode text not null default 'preview',
  add column source_storage_path text,
  add column source_format text,
  add column source_size_bytes bigint;

alter table public.proposals
  add constraint proposals_access_mode_valid
    check (access_mode in ('preview', 'full')),
  add constraint proposals_source_format_valid
    check (source_format is null or source_format in ('docx', 'doc', 'odt', 'rtf', 'txt')),
  add constraint proposals_source_fields_together
    check ((source_storage_path is null) = (source_format is null)
       and (source_storage_path is null) = (source_size_bytes is null)),
  add constraint proposals_source_size_positive
    check (source_size_bytes is null or source_size_bytes > 0),
  -- The source lives next to its canonical PDF, in the same revision folder.
  add constraint proposals_source_matches_original
    check (source_storage_path is null or (
      original_storage_path ~ '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/original\.pdf$'
      and source_storage_path = regexp_replace(original_storage_path, 'original\.pdf$', '') || 'source.' || source_format
    ));

-- Readiness rules now depend on the mode: a Full Access link needs only the
-- canonical PDF; a preview link still needs the preview and the offer.
alter table public.proposals
  drop constraint proposals_active_requires_documents,
  drop constraint proposals_active_requires_offer,
  drop constraint proposals_active_requires_preview;

alter table public.proposals
  add constraint proposals_active_requires_documents
    check (status <> 'active' or (original_storage_path is not null and total_pages is not null)),
  add constraint proposals_active_requires_preview
    check (status <> 'active' or access_mode = 'full' or preview_storage_path is not null),
  add constraint proposals_active_requires_offer
    check (status <> 'active' or access_mode = 'full' or (
      free_preview_pages is not null and unlock_price_minor is not null and currency is not null
    ));

grant select (access_mode, source_storage_path, source_format, source_size_bytes)
  on public.proposals to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Full Access grant audit
-- ---------------------------------------------------------------------------

create table public.proposal_full_access_grants (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  granted_by uuid not null references public.profiles (id) on delete restrict,
  granted_at timestamptz not null default now(),
  revision_id uuid not null,
  document_path text not null,
  source_format text,
  total_pages integer not null check (total_pages > 0),
  note text check (note is null or char_length(note) between 1 and 500),
  ended_at timestamptz,
  ended_by uuid references public.profiles (id) on delete restrict,
  constraint proposal_full_access_grants_ended_together check ((ended_at is null) = (ended_by is null))
);

-- At most one open grant per proposal (one active link at a time).
create unique index proposal_full_access_grants_one_open
  on public.proposal_full_access_grants (proposal_id) where ended_at is null;
create index proposal_full_access_grants_proposal
  on public.proposal_full_access_grants (proposal_id, granted_at desc);

alter table public.proposal_full_access_grants enable row level security;

-- Internal users read grants for proposals they can see (own, or all for the
-- CEO). Nobody writes them from the browser: only the trusted functions
-- below (service_role) do.
create policy proposal_full_access_grants_select_own_or_admin
  on public.proposal_full_access_grants
  for select to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));

revoke all on public.proposal_full_access_grants from anon, authenticated;
grant select on public.proposal_full_access_grants to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Locks
-- ---------------------------------------------------------------------------

create or replace function private.lock_active_proposal()
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
    or new.access_mode is distinct from old.access_mode
    or new.source_storage_path is distinct from old.source_storage_path
    or new.source_format is distinct from old.source_format
    or new.source_size_bytes is distinct from old.source_size_bytes
  ) then
    raise exception 'active proposals are locked; revoke the link first'
      using errcode = 'PT423';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Trusted writes (service_role only; p_actor re-checked as owner or CEO)
-- ---------------------------------------------------------------------------

-- Records a verified document revision: the canonical PDF and, for non-PDF
-- uploads, the source file in the same revision folder. Returns the paths
-- that are no longer referenced so the caller can remove them.
create function public.proposal_attach_document(
  p_actor uuid,
  p_proposal_id uuid,
  p_expected_original_path text,
  p_path text,
  p_source_path text,
  p_source_format text,
  p_source_size_bytes bigint,
  p_file_name text,
  p_size_bytes bigint,
  p_total_pages integer
)
returns table (previous_original_path text, previous_preview_path text, previous_source_path text)
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
  if p_total_pages is null or p_total_pages < 1 then
    raise exception 'a document needs at least one page' using errcode = '22023';
  end if;
  -- Exact path and format pairing is also enforced by table constraints.
  if (p_source_path is null) <> (p_source_format is null)
     or (p_source_path is null) <> (p_source_size_bytes is null) then
    raise exception 'incomplete source file' using errcode = '22023';
  end if;

  -- The previous preview was cut from the previous original, so it is
  -- dropped. Offer values are kept as a starting point if still valid. The
  -- access mode is kept (it is a property of the proposal, not the file).
  update public.proposals
  set original_storage_path = p_path,
      original_file_name = p_file_name,
      original_size_bytes = p_size_bytes,
      total_pages = p_total_pages,
      source_storage_path = p_source_path,
      source_format = p_source_format,
      source_size_bytes = p_source_size_bytes,
      preview_storage_path = null,
      free_preview_pages = case
        when free_preview_pages < p_total_pages then free_preview_pages
      end
  where id = p_proposal_id;

  return query select v.original_storage_path, v.preview_storage_path, v.source_storage_path;
end;
$$;

-- The original PDF-only entry point stays for compatibility (no source).
create or replace function public.proposal_attach_original(
  p_actor uuid,
  p_proposal_id uuid,
  p_expected_original_path text,
  p_path text,
  p_file_name text,
  p_size_bytes bigint,
  p_total_pages integer
)
returns table (previous_original_path text, previous_preview_path text)
language sql
security definer
set search_path = ''
as $$
  select d.previous_original_path, d.previous_preview_path
  from public.proposal_attach_document(
    p_actor, p_proposal_id, p_expected_original_path, p_path,
    null, null, null, p_file_name, p_size_bytes, p_total_pages
  ) d;
$$;

-- Draft only: switching the mode never changes what an issued link shows.
create function public.proposal_set_access_mode(p_actor uuid, p_proposal_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
begin
  v := private.lock_managed_proposal(p_actor, p_proposal_id);

  if p_mode is null or p_mode not in ('preview', 'full') then
    raise exception 'invalid access mode' using errcode = '22023';
  end if;
  if v.status <> 'draft' then
    raise exception 'revoke the link before changing the access mode' using errcode = 'PT423';
  end if;

  update public.proposals set access_mode = p_mode where id = p_proposal_id;
end;
$$;

-- Preview links: unchanged, but only in preview mode.
create or replace function public.proposal_issue_link(
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
  if v.access_mode <> 'preview' then
    raise exception 'proposal is in Full Access mode' using errcode = 'PT409';
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

-- Full Access links: bound to the current canonical PDF revision, recorded
-- in the grant audit in the same transaction.
create function public.proposal_issue_full_link(
  p_actor uuid,
  p_proposal_id uuid,
  p_expected_original_path text,
  p_token_hash text,
  p_note text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
  created timestamptz;
  parts text[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v := private.lock_managed_proposal(p_actor, p_proposal_id);

  if v.status <> 'draft' then
    raise exception 'proposal already has a link or is archived' using errcode = 'PT423';
  end if;
  if v.access_mode <> 'full' then
    raise exception 'proposal is in Preview mode' using errcode = 'PT409';
  end if;
  if v.original_storage_path is null
     or v.original_storage_path is distinct from p_expected_original_path then
    raise exception 'proposal changed since it was loaded' using errcode = 'PT409';
  end if;
  parts := string_to_array(v.original_storage_path, '/');
  if coalesce(array_length(parts, 1), 0) <> 4 then
    raise exception 'this document has no immutable revision; upload it again' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note is too long' using errcode = '22023';
  end if;

  update public.proposals
  set status = 'active',
      link_token_hash = p_token_hash,
      link_created_at = now()
  where id = p_proposal_id
  returning link_created_at into created;

  insert into public.proposal_full_access_grants (
    proposal_id, owner_id, granted_by, granted_at, revision_id, document_path,
    source_format, total_pages, note
  ) values (
    v.id, v.owner_id, p_actor, created, parts[3]::uuid, v.original_storage_path,
    v.source_format, v.total_pages, v_note
  );

  return created;
end;
$$;

create or replace function public.proposal_revoke_link(p_actor uuid, p_proposal_id uuid)
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

  update public.proposal_full_access_grants
  set ended_at = now(), ended_by = p_actor
  where proposal_id = p_proposal_id and ended_at is null;
end;
$$;

create or replace function public.proposal_begin_deletion(p_actor uuid, p_proposal_id uuid)
returns table (owner_id uuid, deletion_requested_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
begin
  v := private.lock_deletable_proposal(p_actor, p_proposal_id);

  if exists (select 1 from public.payments pay where pay.proposal_id = v.id) then
    raise exception 'proposal has payment records that must be retained' using errcode = 'PT412';
  end if;

  if v.deletion_requested_at is null then
    update public.proposal_full_access_grants g
    set ended_at = now(), ended_by = p_actor
    where g.proposal_id = v.id and g.ended_at is null;

    update public.proposals p
    set status = case when p.status = 'active' then 'draft'::public.proposal_status else p.status end,
        link_token_hash = null,
        link_created_at = null,
        deletion_requested_at = now(),
        deletion_requested_by = p_actor
    where p.id = v.id
    returning * into v;
  end if;

  return query select v.owner_id, v.deletion_requested_at;
end;
$$;

revoke all on function public.proposal_attach_document(uuid, uuid, text, text, text, text, bigint, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.proposal_set_access_mode(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.proposal_issue_full_link(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.proposal_attach_document(uuid, uuid, text, text, text, text, bigint, text, bigint, integer) to service_role;
grant execute on function public.proposal_set_access_mode(uuid, uuid, text) to service_role;
grant execute on function public.proposal_issue_full_link(uuid, uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Token resolvers
-- ---------------------------------------------------------------------------

-- Preview resolvers answer only for preview-mode links (and never for a
-- proposal being deleted), so a Full Access token is not a preview token.
create or replace function public.resolve_proposal_offer(p_token text)
returns table (title text, total_pages integer, free_preview_pages integer, unlock_price_minor integer, currency text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.title, p.total_pages, p.free_preview_pages, p.unlock_price_minor, p.currency::text
  from private.proposal_for_token(p_token) p
  where p.access_mode = 'preview'
    and p.preview_storage_path is not null
    and p.total_pages is not null
    and p.free_preview_pages is not null
    and p.unlock_price_minor is not null
    and p.currency is not null;
$$;

create or replace function public.resolve_proposal_preview_object(p_token text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.preview_storage_path
  from private.proposal_for_token(p_token) p
  where p.access_mode = 'preview'
    and p.preview_storage_path is not null
    and p.original_storage_path is not null
    and p.preview_storage_path <> p.original_storage_path;
$$;

-- The client page's view of a Full Access link: display facts only (no ids,
-- paths, owner, note or grant details). Same anon access as
-- resolve_proposal_offer.
create function public.resolve_proposal_full_access(p_token text)
returns table (title text, total_pages integer, source_format text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.title, p.total_pages, p.source_format
  from private.proposal_for_token(p_token) p
  join public.proposal_full_access_grants g
    on g.proposal_id = p.id
   and g.ended_at is null
   and g.document_path = p.original_storage_path
  where p.access_mode = 'full'
    and p.original_storage_path is not null
    and p.total_pages is not null;
$$;

-- Server-only: the objects a Full Access link may deliver. The token is the
-- only input; the paths come from the proposal row and its open grant.
create function public.resolve_proposal_full_object(p_token text)
returns table (title text, original_path text, source_path text, source_format text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.title, p.original_storage_path, p.source_storage_path, p.source_format
  from private.proposal_for_token(p_token) p
  join public.proposal_full_access_grants g
    on g.proposal_id = p.id
   and g.ended_at is null
   and g.document_path = p.original_storage_path
  where p.access_mode = 'full'
    and p.original_storage_path is not null;
$$;

revoke all on function public.resolve_proposal_full_access(text) from public;
grant execute on function public.resolve_proposal_full_access(text) to anon, authenticated, service_role;
revoke all on function public.resolve_proposal_full_object(text) from public, anon, authenticated;
grant execute on function public.resolve_proposal_full_object(text) to service_role;

-- Checkout is for preview links only; a Full Access link has no price.
create or replace function public.payment_begin_checkout(p_token text, p_session_hash text, p_environment text)
returns table (payment_id uuid, public_ref text, amount_minor integer, currency text, title text, request_id uuid, provider_order_id text, approve_url text, reused boolean)
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
  if v.status <> 'active' or v.deletion_requested_at is not null or v.access_mode <> 'preview'
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

-- ---------------------------------------------------------------------------
-- 6. Storage: source files are revision objects too
-- ---------------------------------------------------------------------------

create or replace function private.proposal_id_for_object(object_name text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  parts text[];
  n integer;
  found_id uuid;
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
     or not (
       parts[n] in ('original.pdf', 'preview.pdf')
       -- Source files exist only in revision folders.
       or (n = 4 and parts[n] in ('source.docx', 'source.doc', 'source.odt', 'source.rtf', 'source.txt'))
     ) then
    return null;
  end if;

  select p.id into found_id
  from public.proposals p
  where p.id = parts[2]::uuid
    and p.owner_id = parts[1]::uuid
    and (p.owner_id = (select auth.uid()) or (select private.is_admin()));

  return found_id;
end;
$$;

create or replace function private.is_proposal_object_name(object_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select object_name ~ (
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?'
    || '(original|preview)\.pdf$'
  ) or object_name ~ (
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || 'source\.(docx|doc|odt|rtf|txt)$'
  );
$$;

-- A purchased revision keeps its canonical PDF and its source file.
create or replace function private.is_purchased_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payments pay
    where pay.original_storage_path = object_name
       or (object_name ~ '/source\.(docx|doc|odt|rtf|txt)$'
           and pay.original_storage_path = regexp_replace(object_name, 'source\.[a-z]+$', 'original.pdf'))
  );
$$;

create or replace function private.can_delete_proposal_object(object_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.proposals p
    where p.id = private.proposal_id_for_object(object_name)
      and object_name is distinct from p.original_storage_path
      and object_name is distinct from p.preview_storage_path
      and object_name is distinct from p.source_storage_path
  )
  and not private.is_purchased_object(object_name);
$$;

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
        where p.original_storage_path = o.name
           or p.preview_storage_path = o.name
           or p.source_storage_path = o.name
      ) or private.is_purchased_object(o.name) then 'referenced'
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
      where p.original_storage_path = o.name
         or p.preview_storage_path = o.name
         or p.source_storage_path = o.name
    )
    and not private.is_purchased_object(o.name);
$$;

-- The bucket accepts the supported source types. The server never trusts
-- these declared types: every upload is identified from its bytes.
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/plain'
]
where id = 'proposals';

-- ---------------------------------------------------------------------------
-- 7. Dashboard list: mode, source format, open manual grant
-- ---------------------------------------------------------------------------

create or replace view public.proposal_list
with (security_invoker = true)
as
select
  pr.id,
  pr.owner_id,
  pr.client_id,
  pr.title,
  pr.status,
  pr.original_storage_path is not null as has_original,
  pr.preview_storage_path is not null as has_preview,
  pr.created_at,
  pr.updated_at,
  c.name as client_name,
  p.full_name as owner_name,
  (pr.title || E'\n') || c.name as search_text,
  pr.link_created_at,
  pr.deletion_requested_at,
  exists (select 1 from public.payments pay where pay.proposal_id = pr.id) as has_payments,
  pr.access_mode,
  pr.source_format,
  g.granted_at as full_access_granted_at,
  gp.full_name as full_access_granted_by_name
from public.proposals pr
join public.clients c on c.id = pr.client_id
left join public.profiles p on p.id = pr.owner_id
left join public.proposal_full_access_grants g on g.proposal_id = pr.id and g.ended_at is null
left join public.profiles gp on gp.id = g.granted_by;
