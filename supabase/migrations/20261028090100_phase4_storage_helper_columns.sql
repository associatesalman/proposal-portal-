-- Phase 4 fix: the storage policy helpers run as the calling user
-- (security invoker), who may no longer read proposals.link_token_hash.
-- private.proposal_for_object() used "select *" and returned the whole row,
-- which now fails with "permission denied". It is replaced by a helper that
-- returns only the proposal id, and the policy functions read just the
-- columns they need. Policy behaviour is unchanged.

drop function private.can_access_proposal_object(text) cascade;
drop function private.can_upload_proposal_object(text) cascade;
drop function private.can_delete_proposal_object(text) cascade;
drop function private.proposal_for_object(text);

-- Parses {owner}/{proposal}/original.pdf (legacy) or
-- {owner}/{proposal}/{revision}/(original|preview).pdf and returns the id of
-- the proposal it belongs to, if the caller manages it (proposals RLS applies).
create function private.proposal_id_for_object(object_name text)
returns uuid
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
     or parts[n] not in ('original.pdf', 'preview.pdf') then
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

-- Read: any object of a proposal the caller manages.
create function private.can_access_proposal_object(object_name text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.proposal_id_for_object(object_name) is not null;
$$;

-- Upload: only into draft proposals.
create function private.can_upload_proposal_object(object_name text)
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
  );
$$;

-- Delete: only objects the proposal no longer references (superseded or
-- failed uploads). The document and preview in use cannot be deleted.
create function private.can_delete_proposal_object(object_name text)
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
  );
$$;

revoke all on function private.proposal_id_for_object(text) from public;
revoke all on function private.can_access_proposal_object(text) from public;
revoke all on function private.can_upload_proposal_object(text) from public;
revoke all on function private.can_delete_proposal_object(text) from public;
grant execute on function private.proposal_id_for_object(text) to authenticated;
grant execute on function private.can_access_proposal_object(text) to authenticated;
grant execute on function private.can_upload_proposal_object(text) to authenticated;
grant execute on function private.can_delete_proposal_object(text) to authenticated;

-- The cascade above dropped the policies that used these functions.
create policy "proposals_bucket_select_own_or_admin"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'proposals' and private.can_access_proposal_object(name));

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
