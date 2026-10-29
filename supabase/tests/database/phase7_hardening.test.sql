-- Phase 7 database tests (pgTAP): proposal deletion blocked for API roles,
-- the PostgreSQL rate limiter, and the storage cleanup functions. Runs in
-- one transaction that is rolled back; all data is disposable.

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('17111111-1111-4111-8111-111111111111', 'p7-lead@test.local', 'authenticated', 'authenticated'),
  ('17222222-2222-4222-8222-222222222222', 'p7-admin@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('17111111-1111-4111-8111-111111111111', 'P7 Lead', 'team_lead'),
  ('17222222-2222-4222-8222-222222222222', 'P7 Admin', 'admin');

insert into public.clients (id, owner_id, name, email) values
  ('c7000000-0000-4000-8000-00000000000a', '17111111-1111-4111-8111-111111111111', 'Client', 'c@client.test');

insert into public.proposals (id, client_id, owner_id, title) values
  ('d7000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a',
   '17111111-1111-4111-8111-111111111111', 'Proposal A'),
  ('d7000000-0000-4000-8000-00000000000b', 'c7000000-0000-4000-8000-00000000000a',
   '17111111-1111-4111-8111-111111111111', 'Proposal B');

-- 1. Proposal deletion ---------------------------------------------------------
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'proposals' and cmd = 'DELETE'),
  0, 'no DELETE policy remains on proposals'
);
select ok(not has_table_privilege('authenticated', 'public.proposals', 'DELETE'), 'authenticated has no DELETE privilege on proposals');
select ok(not has_table_privilege('anon', 'public.proposals', 'DELETE'), 'anon has no DELETE privilege on proposals');
select ok(has_any_column_privilege('authenticated', 'public.proposals', 'SELECT'), 'authenticated can still read proposals (RLS-scoped)');
select ok(has_any_column_privilege('authenticated', 'public.proposals', 'UPDATE'), 'authenticated can still update proposal fields (RLS-scoped)');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"17111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$ delete from public.proposals where id = 'd7000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'a team lead cannot delete their own proposal'
);
select set_config('request.jwt.claims',
  '{"sub":"17222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select throws_ok(
  $$ delete from public.proposals where id = 'd7000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'an admin cannot delete a proposal'
);
reset role;
select is((select count(*)::int from public.proposals where id::text like 'd7%'), 2, 'both proposals still exist');

-- Payment protection is unchanged: the FK still restricts deletion.
select is(
  (select confdeltype from pg_constraint
   where conrelid = 'public.payments'::regclass and confrelid = 'public.proposals'::regclass and contype = 'f'),
  'r', 'payments -> proposals foreign key is still ON DELETE RESTRICT'
);

-- 2. Rate limiter ----------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.rate_limit_counters', 'SELECT'), 'counters are not readable by authenticated');
select ok(not has_function_privilege('anon', 'public.rate_limit_consume(text, text, integer, integer, integer)', 'EXECUTE'), 'anon cannot call rate_limit_consume');
select ok(not has_function_privilege('authenticated', 'public.rate_limit_consume(text, text, integer, integer, integer)', 'EXECUTE'), 'authenticated cannot call rate_limit_consume');
select ok(has_function_privilege('service_role', 'public.rate_limit_consume(text, text, integer, integer, integer)', 'EXECUTE'), 'service_role can call rate_limit_consume');
select ok(not has_function_privilege('authenticated', 'public.rate_limit_prune(integer)', 'EXECUTE'), 'authenticated cannot prune counters');

set local role service_role;
create temporary table p7_rl (n int, allowed boolean, hits int, remaining int, retry int) on commit drop;
insert into p7_rl select 1, * from public.rate_limit_consume('p7_test', repeat('a', 64), 3, 3600);
insert into p7_rl select 2, * from public.rate_limit_consume('p7_test', repeat('a', 64), 3, 3600);
insert into p7_rl select 3, * from public.rate_limit_consume('p7_test', repeat('a', 64), 3, 3600);
insert into p7_rl select 4, * from public.rate_limit_consume('p7_test', repeat('a', 64), 3, 3600);
insert into p7_rl select 5, * from public.rate_limit_consume('p7_test', repeat('b', 64), 3, 3600);
insert into p7_rl select 6, * from public.rate_limit_consume('p7_test', repeat('a', 64), 3, 3600, 0);
reset role;

select is((select array_agg(allowed order by n) from p7_rl where n <= 4), array[true, true, true, false], 'limit 3: three allowed, the fourth denied');
select is((select array_agg(remaining order by n) from p7_rl where n <= 3), array[2, 1, 0], 'remaining counts down');
select ok((select retry between 1 and 3600 from p7_rl where n = 4), 'a denied call gets a Retry-After within the window');
select is((select retry from p7_rl where n = 1), 0, 'an allowed call has no Retry-After');
select ok((select allowed from p7_rl where n = 5), 'another key is counted separately');
select is((select hits from p7_rl where n = 6), 4, 'cost 0 reads without counting');

select throws_ok($$ select * from public.rate_limit_consume('p7_test', 'not-a-hash', 3, 60) $$,
  '23514', null, 'raw (non-hash) keys are rejected');
select throws_ok($$ select * from public.rate_limit_consume('p7_test', repeat('a', 64), 0, 60) $$,
  '22023', null, 'a zero limit is rejected');
select throws_ok($$ select * from public.rate_limit_consume('p7_test', repeat('a', 64), 3, 0) $$,
  '22023', null, 'a zero window is rejected');

-- Expiry: an old window is pruned, a current one is kept.
insert into private.rate_limit_counters (scope, key_hash, window_start, window_end, hits)
values ('p7_test', repeat('c', 64), now() - interval '2 hours', now() - interval '1 hour', 99);
set local role service_role;
select ok(public.rate_limit_prune(100000) >= 1, 'prune removes expired windows');
reset role;
select is((select count(*)::int from private.rate_limit_counters where key_hash = repeat('c', 64)), 0, 'the expired window is gone');
select is((select count(*)::int from private.rate_limit_counters where key_hash = repeat('a', 64)), 1, 'the current window is kept');

-- A new window starts a fresh count (no permanent lockout).
select is(
  (select allowed from public.rate_limit_consume('p7_test', repeat('d', 64), 1, 1)),
  true, 'one-second window: first call allowed'
);
select pg_sleep(1.1);
select is(
  (select allowed from public.rate_limit_consume('p7_test', repeat('d', 64), 1, 1)),
  true, 'after the window ends the key is allowed again'
);

-- 3. Storage cleanup functions --------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.storage_cleanup_scan(timestamptz, text, text, integer)', 'EXECUTE'), 'authenticated cannot scan storage');
select ok(not has_function_privilege('anon', 'public.storage_cleanup_recheck(text[], timestamptz)', 'EXECUTE'), 'anon cannot recheck storage');
select ok(not has_function_privilege('authenticated', 'public.storage_cleanup_record(uuid, jsonb)', 'EXECUTE'), 'authenticated cannot write the cleanup audit');
select ok(has_function_privilege('service_role', 'public.storage_cleanup_scan(timestamptz, text, text, integer)', 'EXECUTE'), 'service_role can scan storage');

create temporary table p7 (key text primary key, value text) on commit drop;
grant select on p7 to service_role;
insert into p7 values
  ('prefix', '17111111-1111-4111-8111-111111111111/'),
  ('current_orig', '17111111-1111-4111-8111-111111111111/d7000000-0000-4000-8000-00000000000a/e7000000-0000-4000-8000-000000000001/original.pdf'),
  ('current_prev', '17111111-1111-4111-8111-111111111111/d7000000-0000-4000-8000-00000000000a/e7000000-0000-4000-8000-000000000002/preview.pdf'),
  ('old_orphan', '17111111-1111-4111-8111-111111111111/d7000000-0000-4000-8000-00000000000a/e7000000-0000-4000-8000-000000000003/original.pdf'),
  ('legacy_orphan', '17111111-1111-4111-8111-111111111111/d7000000-0000-4000-8000-00000000000b/original.pdf'),
  ('recent_upload', '17111111-1111-4111-8111-111111111111/d7000000-0000-4000-8000-00000000000b/e7000000-0000-4000-8000-000000000004/original.pdf'),
  ('odd_name', '17111111-1111-4111-8111-111111111111/notes.txt');

insert into storage.objects (bucket_id, name, created_at, metadata)
select 'proposals', value,
  case when key = 'recent_upload' then now() else now() - interval '3 days' end,
  jsonb_build_object('size', 1000)
from p7 where key <> 'prefix';

set local role service_role;
select public.proposal_attach_original('17111111-1111-4111-8111-111111111111',
  'd7000000-0000-4000-8000-00000000000a', null, (select value from p7 where key = 'current_orig'), 'a.pdf', 1000, 5);
select public.proposal_save_offer('17111111-1111-4111-8111-111111111111',
  'd7000000-0000-4000-8000-00000000000a', (select value from p7 where key = 'current_orig'),
  (select value from p7 where key = 'current_prev'), 2, 2500, 'EUR');

create temporary table p7_scan on commit drop as
select * from public.storage_cleanup_scan(now() - interval '24 hours', (select value from p7 where key = 'prefix'), '', 500);
reset role;

select is((select classification from p7_scan where name = (select value from p7 where key = 'current_orig')), 'referenced', 'the current original is "referenced"');
select is((select classification from p7_scan where name = (select value from p7 where key = 'current_prev')), 'referenced', 'the current preview is "referenced"');
select is((select classification from p7_scan where name = (select value from p7 where key = 'old_orphan')), 'orphan', 'an old superseded original is an orphan');
select is((select classification from p7_scan where name = (select value from p7 where key = 'legacy_orphan')), 'orphan', 'an old unreferenced legacy-layout object is an orphan');
select is((select classification from p7_scan where name = (select value from p7 where key = 'recent_upload')), 'recent', 'a recent (possibly in-progress) upload is protected');
select is((select classification from p7_scan where name = (select value from p7 where key = 'odd_name')), 'unrecognised', 'a non-application name is never a candidate');

-- Pagination: two pages of 3 cover all six objects exactly once.
set local role service_role;
create temporary table p7_pages on commit drop as
with first_page as (
  select * from public.storage_cleanup_scan(now() - interval '24 hours', (select value from p7 where key = 'prefix'), '', 3)
)
select name from first_page
union all
select name from public.storage_cleanup_scan(now() - interval '24 hours', (select value from p7 where key = 'prefix'),
  (select max(name) from first_page), 3);
reset role;
select is((select count(distinct name)::int from p7_pages), 6, 'keyset pagination returns every object once');

-- Recheck: a candidate that became referenced in the meantime is dropped.
set local role service_role;
select public.proposal_attach_original('17111111-1111-4111-8111-111111111111',
  'd7000000-0000-4000-8000-00000000000b', null, (select value from p7 where key = 'legacy_orphan'), 'b.pdf', 1000, 5);
create temporary table p7_recheck on commit drop as
select * from public.storage_cleanup_recheck(
  array(select value from p7 where key in ('old_orphan', 'legacy_orphan', 'recent_upload', 'current_orig', 'odd_name')),
  now() - interval '24 hours');
reset role;
select is(
  (select array_agg(p order by p) from p7_recheck as r(p)),
  array[(select value from p7 where key = 'old_orphan')],
  'recheck keeps only still-unreferenced, old, application-layout objects'
);

-- Audit log.
set local role service_role;
select is(
  public.storage_cleanup_record('a7000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('name', 'x/y.pdf', 'size_bytes', 10, 'outcome', 'deleted'))),
  1, 'cleanup audit rows can be recorded'
);
select is(
  (select outcome from public.storage_cleanup_history('a7000000-0000-4000-8000-000000000001', 10)),
  'deleted', 'cleanup history returns the recorded outcome'
);
reset role;

select * from finish();
rollback;
