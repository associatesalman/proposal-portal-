-- Phase 7: security, storage cleanup and performance hardening.
--
-- Forward-only. No existing rows are changed or removed.
--
-- 1. Proposal deletion: API roles (authenticated, including admins) can no
--    longer delete proposals. Deleting a row would leave its stored PDFs
--    behind, and there is no coordinated deletion workflow yet. The
--    payments -> proposals foreign key (ON DELETE RESTRICT) is unchanged.
--    Only trusted backend code (service_role) can still delete rows; a
--    future trusted deletion procedure must also remove the storage objects
--    (see docs/PHASE_7_HARDENING_SUMMARY.md, "Deletion policy").
--
-- 2. Rate limiting: a fixed-window counter table in the private schema and
--    one atomic function, rate_limit_consume(), executable by service_role
--    only. Keys are hashed by the application before they get here (no raw
--    IP addresses, emails or link tokens are stored). Expired windows are
--    pruned opportunistically and by rate_limit_prune().
--
-- 3. Storage cleanup: service_role-only functions that classify objects in
--    the private "proposals" bucket (referenced / too recent / unrecognised
--    / orphan) and re-check candidates immediately before deletion, plus an
--    audit table for applied deletions. Deletion itself goes through the
--    Storage API (scripts/storage-cleanup.mjs), never through SQL.

-- ---------------------------------------------------------------------------
-- 1. Block direct proposal deletion by API roles
-- ---------------------------------------------------------------------------
drop policy "proposals_delete_own_or_admin" on public.proposals;
revoke delete on table public.proposals from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rate limiting
-- ---------------------------------------------------------------------------
create table private.rate_limit_counters (
  scope text not null
    constraint rate_limit_counters_scope_format check (scope ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- SHA-256/HMAC hex digest computed by the application.
  key_hash text not null
    constraint rate_limit_counters_key_hash_format check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  window_end timestamptz not null,
  hits integer not null default 0 constraint rate_limit_counters_hits_nonnegative check (hits >= 0),
  primary key (scope, key_hash, window_start)
);

create index rate_limit_counters_window_end_idx on private.rate_limit_counters (window_end);

alter table private.rate_limit_counters enable row level security;
revoke all on table private.rate_limit_counters from public, anon, authenticated;

-- Deletes up to p_max expired windows (kept 10 minutes past their end).
create function public.rate_limit_prune(p_max integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from private.rate_limit_counters c
  where c.ctid in (
    select ctid
    from private.rate_limit_counters
    where window_end < now() - interval '10 minutes'
    limit greatest(1, least(coalesce(p_max, 5000), 50000))
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Atomically records p_cost hits for (scope, key) in the current fixed
-- window and reports whether the caller is still within p_limit. Denied
-- attempts are counted too, but a block never outlasts its window: it ends
-- at window_end, so nobody is locked out permanently. p_cost = 0 only reads
-- the current count.
create function public.rate_limit_consume(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_cost integer default 1
)
returns table (allowed boolean, hits integer, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  started timestamptz;
  ends timestamptz;
  current_hits integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000000 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid window' using errcode = '22023';
  end if;
  if p_cost is null or p_cost < 0 or p_cost > 1000 then
    raise exception 'invalid cost' using errcode = '22023';
  end if;

  started := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  ends := started + make_interval(secs => p_window_seconds);

  insert into private.rate_limit_counters as c (scope, key_hash, window_start, window_end, hits)
  values (p_scope, p_key_hash, started, ends, p_cost)
  on conflict (scope, key_hash, window_start)
  do update set hits = c.hits + excluded.hits
  returning c.hits into current_hits;

  -- Bounded, opportunistic retention (about 1 call in 50).
  if random() < 0.02 then
    perform public.rate_limit_prune(500);
  end if;

  allowed := current_hits <= p_limit;
  hits := current_hits;
  remaining := greatest(p_limit - current_hits, 0);
  retry_after_seconds := case
    when current_hits <= p_limit then 0
    else greatest(1, ceil(extract(epoch from ends - clock_timestamp()))::integer)
  end;
  return next;
end;
$$;

revoke all on function public.rate_limit_consume(text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.rate_limit_prune(integer) from public, anon, authenticated;
grant execute on function public.rate_limit_consume(text, text, integer, integer, integer) to service_role;
grant execute on function public.rate_limit_prune(integer) to service_role;

comment on function public.rate_limit_consume(text, text, integer, integer, integer) is
  'Atomic fixed-window rate limiter. Keys must be application-side hashes. service_role only.';

-- ---------------------------------------------------------------------------
-- 3. Storage cleanup support
-- ---------------------------------------------------------------------------

-- True when the name follows the layout the application writes:
--   {owner}/{proposal}/{revision}/(original|preview).pdf  or the Phase 2
--   legacy {owner}/{proposal}/(original|preview).pdf
create function private.is_proposal_object_name(object_name text)
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
  );
$$;

revoke all on function private.is_proposal_object_name(text) from public;

-- One page (keyset on name) of objects in the proposals bucket, each with a
-- classification:
--   referenced    a proposal's current original or preview: never deleted
--   recent        created at or after p_created_before: may be an upload in
--                 progress, never deleted
--   unrecognised  not an application path: reported, never deleted
--   orphan        none of the above: a deletion candidate
create function public.storage_cleanup_scan(
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
        where p.original_storage_path = o.name or p.preview_storage_path = o.name
      ) then 'referenced'
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

-- Re-check right before deletion: returns only the names that still exist,
-- are still unreferenced, still older than p_created_before and still
-- follow the application layout.
create function public.storage_cleanup_recheck(p_names text[], p_created_before timestamptz)
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
      where p.original_storage_path = o.name or p.preview_storage_path = o.name
    );
$$;

create table private.storage_cleanup_log (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  object_name text not null,
  size_bytes bigint,
  object_created_at timestamptz,
  outcome text not null constraint storage_cleanup_log_outcome check (outcome in ('deleted', 'failed')),
  detail text constraint storage_cleanup_log_detail_length check (detail is null or char_length(detail) <= 200),
  logged_at timestamptz not null default now()
);

alter table private.storage_cleanup_log enable row level security;
revoke all on table private.storage_cleanup_log from public, anon, authenticated;

-- Appends audit rows: p_entries is a JSON array of
-- {name, size_bytes, created_at, outcome, detail}.
create function public.storage_cleanup_record(p_run_id uuid, p_entries jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted integer;
begin
  insert into private.storage_cleanup_log (run_id, object_name, size_bytes, object_created_at, outcome, detail)
  select
    p_run_id,
    e ->> 'name',
    nullif(e ->> 'size_bytes', '')::bigint,
    nullif(e ->> 'created_at', '')::timestamptz,
    e ->> 'outcome',
    left(e ->> 'detail', 200)
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as e;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- Read access to the audit log for operators (service_role only).
create function public.storage_cleanup_history(p_run_id uuid default null, p_limit integer default 200)
returns table (run_id uuid, object_name text, size_bytes bigint, outcome text, detail text, logged_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.run_id, l.object_name, l.size_bytes, l.outcome, l.detail, l.logged_at
  from private.storage_cleanup_log l
  where p_run_id is null or l.run_id = p_run_id
  order by l.id desc
  limit greatest(1, least(coalesce(p_limit, 200), 5000));
$$;

revoke all on function public.storage_cleanup_scan(timestamptz, text, text, integer) from public, anon, authenticated;
revoke all on function public.storage_cleanup_recheck(text[], timestamptz) from public, anon, authenticated;
revoke all on function public.storage_cleanup_record(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.storage_cleanup_history(uuid, integer) from public, anon, authenticated;
grant execute on function public.storage_cleanup_scan(timestamptz, text, text, integer) to service_role;
grant execute on function public.storage_cleanup_recheck(text[], timestamptz) to service_role;
grant execute on function public.storage_cleanup_record(uuid, jsonb) to service_role;
grant execute on function public.storage_cleanup_history(uuid, integer) to service_role;
