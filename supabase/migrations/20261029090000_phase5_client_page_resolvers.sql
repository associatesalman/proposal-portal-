-- Phase 5: client proposal page and preview delivery.
--
-- Forward-only. No table, grant, RLS or storage policy changes. Adds two
-- token resolvers next to Phase 4's resolve_proposal_link (which returns
-- only the title and is kept unchanged for compatibility):
--
-- 1. resolve_proposal_offer(token): the display fields the client page
--    needs (title, page counts, price, currency) for an ACTIVE proposal.
--    Executable by anon, like resolve_proposal_link. Returns no ids, owner,
--    client, paths, hashes or timestamps.
--
-- 2. resolve_proposal_preview_object(token): the storage path of the
--    preview PDF of an ACTIVE proposal. Executable by service_role ONLY;
--    called from server code (src/lib/supabase/privileged.ts) that then
--    streams exactly that object. Never returns the original's path.
--
-- Both hash the raw token with SHA-256 and compare it with the stored hash,
-- reject malformed tokens, and match nothing for draft (revoked) or
-- archived proposals. Phase 4 constraints already guarantee that an active
-- proposal has a preview, page counts and an offer
-- (proposals_active_requires_preview / _iff_link); the explicit not-null
-- checks below are a second line of defence.

create function public.resolve_proposal_offer(p_token text)
returns table (
  title text,
  total_pages integer,
  free_preview_pages integer,
  unlock_price_minor integer,
  currency text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.title, p.total_pages, p.free_preview_pages, p.unlock_price_minor, p.currency::text
  from public.proposals p
  where p_token ~ '^[A-Za-z0-9_-]{43}$'
    and p.status = 'active'
    and p.link_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and p.preview_storage_path is not null
    and p.total_pages is not null
    and p.free_preview_pages is not null
    and p.unlock_price_minor is not null
    and p.currency is not null;
$$;

revoke all on function public.resolve_proposal_offer(text) from public, anon, authenticated;
grant execute on function public.resolve_proposal_offer(text) to anon, authenticated, service_role;

comment on function public.resolve_proposal_offer(text) is
  'Client page display fields for an active proposal matching a raw link token. Safe fields only.';

create function public.resolve_proposal_preview_object(p_token text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.preview_storage_path
  from public.proposals p
  where p_token ~ '^[A-Za-z0-9_-]{43}$'
    and p.status = 'active'
    and p.link_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and p.preview_storage_path is not null
    and p.original_storage_path is not null
    and p.preview_storage_path <> p.original_storage_path;
$$;

revoke all on function public.resolve_proposal_preview_object(text) from public, anon, authenticated;
grant execute on function public.resolve_proposal_preview_object(text) to service_role;

comment on function public.resolve_proposal_preview_object(text) is
  'Preview object path for an active proposal matching a raw link token. service_role only (server-side preview streaming).';
