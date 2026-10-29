-- Manual Full Access grants keep the granter's display name as recorded at
-- grant time (like payments' owner_name_snapshot). Profiles are RLS-limited,
-- so a Team Lead couldn't otherwise see that the CEO granted access to one
-- of their proposals. Internal only: never returned to clients.
-- Additive: the table is new and the column is nullable.

alter table public.proposal_full_access_grants
  add column granted_by_name text check (granted_by_name is null or char_length(granted_by_name) <= 200);

create or replace function public.proposal_issue_full_link(
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
  actor_name text;
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

  select left(pr.full_name, 200) into actor_name from public.profiles pr where pr.id = p_actor;

  update public.proposals
  set status = 'active',
      link_token_hash = p_token_hash,
      link_created_at = now()
  where id = p_proposal_id
  returning link_created_at into created;

  insert into public.proposal_full_access_grants (
    proposal_id, owner_id, granted_by, granted_by_name, granted_at, revision_id, document_path,
    source_format, total_pages, note
  ) values (
    v.id, v.owner_id, p_actor, actor_name, created, parts[3]::uuid, v.original_storage_path,
    v.source_format, v.total_pages, v_note
  );

  return created;
end;
$$;

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
  coalesce(g.granted_by_name, gp.full_name) as full_access_granted_by_name
from public.proposals pr
join public.clients c on c.id = pr.client_id
left join public.profiles p on p.id = pr.owner_id
left join public.proposal_full_access_grants g on g.proposal_id = pr.id and g.ended_at is null
left join public.profiles gp on gp.id = g.granted_by;
