-- Phase 3: draft proposals and dashboard list views.
--
-- 1. Drafts are created before a PDF is uploaded or an offer is configured.
--    The Phase 2 schema required free_preview_pages (default 1), unlock_price_minor
--    and currency on every row, which would force placeholder offer values onto
--    drafts. These become nullable, and an active proposal must have all three.
--    Existing range/format checks still apply whenever a value is present.
-- 2. A proposal's client can no longer be changed through the API.
-- 3. Read-only list views for the dashboard. security_invoker = true means
--    the caller's RLS on the underlying tables applies; the views grant nothing new.

-- ---------------------------------------------------------------------------
-- 1. Draft-friendly offer columns
-- ---------------------------------------------------------------------------
alter table public.proposals
  alter column free_preview_pages drop default,
  alter column free_preview_pages drop not null,
  alter column unlock_price_minor drop not null,
  alter column currency drop not null;

alter table public.proposals
  add constraint proposals_active_requires_offer check (
    status <> 'active'
    or (
      free_preview_pages is not null
      and unlock_price_minor is not null
      and currency is not null
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Client of an existing proposal is fixed
-- ---------------------------------------------------------------------------
revoke update (client_id) on table public.proposals from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Dashboard list views (RLS of the caller applies)
-- ---------------------------------------------------------------------------
create view public.client_list
with (security_invoker = true)
as
select
  c.id,
  c.owner_id,
  c.name,
  c.email,
  c.created_at,
  c.updated_at,
  p.full_name as owner_name,
  (
    select count(*)
    from public.proposals pr
    where pr.client_id = c.id
  )::integer as proposal_count,
  -- Newline separator: search terms cannot contain control characters, so a
  -- match can never span the name/email boundary.
  c.name || E'\n' || c.email as search_text
from public.clients c
left join public.profiles p on p.id = c.owner_id;

create view public.proposal_list
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
  pr.title || E'\n' || c.name as search_text
from public.proposals pr
join public.clients c on c.id = pr.client_id
left join public.profiles p on p.id = pr.owner_id;

revoke all on table public.client_list, public.proposal_list from anon, authenticated;
grant select on table public.client_list, public.proposal_list to authenticated;

comment on view public.client_list is
  'Dashboard client list. security_invoker: callers only see rows their RLS allows.';
comment on view public.proposal_list is
  'Dashboard proposal list. security_invoker: callers only see rows their RLS allows.';
