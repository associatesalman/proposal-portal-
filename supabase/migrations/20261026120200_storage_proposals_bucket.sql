-- Phase 2: private storage for proposal PDFs.
--
-- Bucket: proposals (private, PDF only, 25 MiB limit)
-- Object paths:
--   {owner_id}/{proposal_id}/original.pdf
--   {owner_id}/{proposal_id}/preview.pdf
--
-- Access:
--   admin     -> all objects that belong to an existing proposal
--   team_lead -> only objects whose path matches a proposal row they own
--   anon      -> nothing (no policies; bucket is not public)
-- Client-facing delivery (later phases) must go through authorized server
-- code issuing short-lived signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proposals', 'proposals', false, 26214400, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- True only when the object path is exactly {owner_id}/{proposal_id}/(original|preview).pdf
-- AND a proposal with that id and owner exists AND the caller owns it or is admin.
-- A matching path prefix alone is not enough: the proposal row must exist and
-- its owner must match the first path segment.
-- SECURITY INVOKER: the proposals lookup is also filtered by proposals RLS.
create function private.can_access_proposal_object(object_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  parts text[];
begin
  if object_name is null then
    return false;
  end if;

  parts := string_to_array(object_name, '/');

  if coalesce(array_length(parts, 1), 0) <> 3
     or parts[1] !~ uuid_pattern
     or parts[2] !~ uuid_pattern
     or parts[3] not in ('original.pdf', 'preview.pdf') then
    return false;
  end if;

  return exists (
    select 1
    from public.proposals p
    where p.id = parts[2]::uuid
      and p.owner_id = parts[1]::uuid
      and (p.owner_id = (select auth.uid()) or (select private.is_admin()))
  );
end;
$$;

revoke all on function private.can_access_proposal_object(text) from public;
grant execute on function private.can_access_proposal_object(text) to authenticated;

create policy "proposals_bucket_select_own_or_admin"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'proposals' and private.can_access_proposal_object(name));

create policy "proposals_bucket_insert_own_or_admin"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'proposals' and private.can_access_proposal_object(name));

create policy "proposals_bucket_update_own_or_admin"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'proposals' and private.can_access_proposal_object(name))
  with check (bucket_id = 'proposals' and private.can_access_proposal_object(name));

create policy "proposals_bucket_delete_own_or_admin"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'proposals' and private.can_access_proposal_object(name));
