-- Feature update: Team Lead display names, proposal history and safe
-- permanent proposal deletion. Forward-only; no existing data is changed.
--
-- 1. Display names: a signed-in internal user may update their OWN
--    profiles.full_name and nothing else (column grant + own-row policy).
--    role, id and other users' rows stay read-only for API roles.
-- 2. Deletion state: proposals.deletion_requested_at / _by mark a proposal
--    as "deleting". A marked proposal is never active (no public link),
--    accepts no further changes (trigger, every role), accepts no uploads
--    (storage policy) and is refused by every trusted writer.
-- 3. Trusted deletion workflow (service_role only, re-checks the actor):
--      proposal_begin_deletion   mark + revoke the link, atomically
--      proposal_deletion_objects storage objects under the proposal's folder
--      proposal_finish_deletion  delete the row once no object remains
--    Proposals with payment records are refused (retention); payments are
--    never deleted or cascaded. Direct DELETE stays revoked from API roles.
-- 4. History: proposal_list gains link_created_at, deletion_requested_at and
--    has_payments (appended columns; security_invoker unchanged).
--
-- Error codes added: PT410 deletion pending, PT412 payment records retained.

-- ---------------------------------------------------------------------------
-- 1. Display names
-- ---------------------------------------------------------------------------
grant update (full_name) on table public.profiles to authenticated;

create policy "profiles_update_own_name"
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Display names are shown in several places; keep them to one line of
-- printable text (the existing check already requires 1..200 trimmed chars).
alter table public.profiles
  add constraint profiles_full_name_printable check (full_name !~ '[[:cntrl:]]');

-- ---------------------------------------------------------------------------
-- 2. Deletion state
-- ---------------------------------------------------------------------------
alter table public.proposals
  add column deletion_requested_at timestamptz,
  -- Audit only (no FK, so profile changes never touch a frozen row).
  add column deletion_requested_by uuid;

alter table public.proposals
  add constraint proposals_deleting_not_active check (
    deletion_requested_at is null or status <> 'active'
  );

-- Browser roles may read the marker (history shows "Deletion pending"), but
-- never write it: their update grant remains title only.
grant select (deletion_requested_at) on table public.proposals to authenticated;

-- Once marked, a proposal is frozen for every role (including service_role
-- and the trusted functions): it can only be deleted.
create function private.freeze_deleting_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deletion_requested_at is not null then
    raise exception 'proposal is being deleted' using errcode = 'PT410';
  end if;
  return new;
end;
$$;

revoke all on function private.freeze_deleting_proposal() from public;

create trigger proposals_freeze_deleting
  before update on public.proposals
  for each row execute function private.freeze_deleting_proposal();

-- Uploads: only into draft proposals that are not being deleted.
create or replace function private.can_upload_proposal_object(object_name text)
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
      and p.status = 'draft'
      and p.deletion_requested_at is null
  );
$$;

-- The trusted writers lock the row through this helper; refusing here
-- covers attach_original, save_offer, issue_link and revoke_link (the
-- trigger above would also refuse their updates).
create or replace function private.lock_managed_proposal(p_actor uuid, p_proposal_id uuid)
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

  if v.deletion_requested_at is not null then
    raise exception 'proposal is being deleted' using errcode = 'PT410';
  end if;

  return v;
end;
$$;

-- Same access rule without the deletion check, for the deletion workflow.
create function private.lock_deletable_proposal(p_actor uuid, p_proposal_id uuid)
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

revoke all on function private.lock_deletable_proposal(uuid, uuid) from public;

-- Storage folder of a proposal: every object the application writes for it
-- (current and superseded revisions, abandoned uploads, legacy paths) lives
-- under {owner}/{proposal}/ — enforced by the path checks and the upload
-- policy. Built only from the database row, never from request input.
create function private.proposal_folder(v public.proposals)
returns text
language sql
immutable
set search_path = ''
as $$
  select v.owner_id::text || '/' || v.id::text || '/';
$$;

revoke all on function private.proposal_folder(public.proposals) from public;

-- ---------------------------------------------------------------------------
-- 3. Trusted deletion workflow (service_role only)
-- ---------------------------------------------------------------------------

-- Step 1: mark as deleting and revoke public access in one statement. Safe
-- to repeat: an already-marked proposal is returned unchanged (retry).
create function public.proposal_begin_deletion(p_actor uuid, p_proposal_id uuid)
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

-- Step 2: the objects still stored for a marked proposal.
create function public.proposal_deletion_objects(p_actor uuid, p_proposal_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.proposals;
begin
  select * into v from public.proposals where id = p_proposal_id;

  if not found or not exists (
    select 1
    from public.profiles pr
    where pr.id = p_actor
      and (pr.role = 'admin' or pr.id = v.owner_id)
  ) then
    raise exception 'proposal not found' using errcode = 'PT404';
  end if;

  if v.deletion_requested_at is null then
    raise exception 'deletion has not been started' using errcode = 'PT423';
  end if;

  return query
    select o.name
    from storage.objects o
    where o.bucket_id = 'proposals'
      and starts_with(o.name, private.proposal_folder(v))
    order by o.name
    limit 1000;
end;
$$;

-- Step 3: remove the row, only once storage is empty for it. Payments are
-- re-checked under the row lock (and the payments FK is ON DELETE RESTRICT).
create function public.proposal_finish_deletion(p_actor uuid, p_proposal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.proposals;
begin
  v := private.lock_deletable_proposal(p_actor, p_proposal_id);

  if v.deletion_requested_at is null then
    raise exception 'deletion has not been started' using errcode = 'PT423';
  end if;

  if exists (select 1 from public.payments pay where pay.proposal_id = v.id) then
    raise exception 'proposal has payment records that must be retained' using errcode = 'PT412';
  end if;

  if exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'proposals'
      and starts_with(o.name, private.proposal_folder(v))
  ) then
    raise exception 'stored files remain for this proposal' using errcode = 'PT409';
  end if;

  delete from public.proposals p where p.id = v.id;
end;
$$;

revoke all on function public.proposal_begin_deletion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.proposal_deletion_objects(uuid, uuid) from public, anon, authenticated;
revoke all on function public.proposal_finish_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.proposal_begin_deletion(uuid, uuid) to service_role;
grant execute on function public.proposal_deletion_objects(uuid, uuid) to service_role;
grant execute on function public.proposal_finish_deletion(uuid, uuid) to service_role;

comment on function public.proposal_begin_deletion(uuid, uuid) is
  'Marks a proposal as deleting and revokes its link (idempotent). Refuses proposals with payment records (PT412). service_role only.';
comment on function public.proposal_deletion_objects(uuid, uuid) is
  'Storage objects under a deleting proposal''s own folder. service_role only.';
comment on function public.proposal_finish_deletion(uuid, uuid) is
  'Deletes a deleting proposal once no storage object remains (PT409 otherwise). service_role only.';

-- ---------------------------------------------------------------------------
-- 4. History columns on the list view (appended; same security_invoker)
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
  pr.title || E'\n' || c.name as search_text,
  pr.link_created_at,
  pr.deletion_requested_at,
  exists (select 1 from public.payments pay where pay.proposal_id = pr.id) as has_payments
from public.proposals pr
join public.clients c on c.id = pr.client_id
left join public.profiles p on p.id = pr.owner_id;

revoke all on table public.proposal_list from anon, authenticated;
grant select on table public.proposal_list to authenticated;
