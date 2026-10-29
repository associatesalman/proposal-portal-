-- Feature update tests (pgTAP): own display-name updates, the proposal
-- deletion state and trusted deletion workflow, payment retention, upload
-- blocking and the history columns of proposal_list. Runs in one
-- transaction that is rolled back; all data is disposable.

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('18111111-1111-4111-8111-111111111111', 'f8-lead-a@test.local', 'authenticated', 'authenticated'),
  ('18222222-2222-4222-8222-222222222222', 'f8-lead-b@test.local', 'authenticated', 'authenticated'),
  ('18333333-3333-4333-8333-333333333333', 'f8-admin@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('18111111-1111-4111-8111-111111111111', 'F8 Lead A', 'team_lead'),
  ('18222222-2222-4222-8222-222222222222', 'F8 Lead B', 'team_lead'),
  ('18333333-3333-4333-8333-333333333333', 'F8 Admin', 'admin');

insert into public.clients (id, owner_id, name, email) values
  ('c8000000-0000-4000-8000-00000000000a', '18111111-1111-4111-8111-111111111111', 'Client A', 'a@client.test'),
  ('c8000000-0000-4000-8000-00000000000b', '18222222-2222-4222-8222-222222222222', 'Client B', 'b@client.test');

-- A1: active with a link; A2: draft; A3: draft with a payment; B1: lead B's.
insert into public.proposals (
  id, client_id, owner_id, title, status,
  original_storage_path, total_pages, preview_storage_path, free_preview_pages,
  unlock_price_minor, currency, link_token_hash, link_created_at
) values (
  'd8000000-0000-4000-8000-0000000000a1', 'c8000000-0000-4000-8000-00000000000a',
  '18111111-1111-4111-8111-111111111111', 'Proposal A1', 'active',
  '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/original.pdf', 5,
  '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/preview.pdf', 2,
  1000, 'USD', encode(extensions.digest(repeat('A', 43), 'sha256'), 'hex'), now()
);

insert into public.proposals (id, client_id, owner_id, title) values
  ('d8000000-0000-4000-8000-0000000000a2', 'c8000000-0000-4000-8000-00000000000a',
   '18111111-1111-4111-8111-111111111111', 'Proposal A2'),
  ('d8000000-0000-4000-8000-0000000000a3', 'c8000000-0000-4000-8000-00000000000a',
   '18111111-1111-4111-8111-111111111111', 'Proposal A3'),
  ('d8000000-0000-4000-8000-0000000000b1', 'c8000000-0000-4000-8000-00000000000b',
   '18222222-2222-4222-8222-222222222222', 'Proposal B1');

insert into public.payments (proposal_id, provider, amount_minor, currency)
values ('d8000000-0000-4000-8000-0000000000a3', 'fake', 1000, 'USD');

-- Storage objects: A1's current files, an older revision and an abandoned
-- upload; plus objects of A2 and B1 that must never be touched.
insert into storage.objects (bucket_id, name, metadata)
select 'proposals', n, jsonb_build_object('size', 100)
from unnest(array[
  '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/original.pdf',
  '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/preview.pdf',
  '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000000/original.pdf',
  '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000009/original.pdf',
  '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a2/e8000000-0000-4000-8000-000000000002/original.pdf',
  '18222222-2222-4222-8222-222222222222/d8000000-0000-4000-8000-0000000000b1/e8000000-0000-4000-8000-000000000003/original.pdf'
]) as n;

-- 1. Display names -------------------------------------------------------------
select ok(has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE'), 'authenticated may update profiles.full_name');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE'), 'authenticated may not update profiles.role');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE'), 'authenticated may not update profiles.id');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE'), 'authenticated may not update profiles.created_at');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'INSERT'), 'authenticated may not insert profiles');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'DELETE'), 'authenticated may not delete profiles');
select ok(not has_any_column_privilege('anon', 'public.profiles', 'UPDATE'), 'anon may not update profiles');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"18111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
create temporary table f8_rows (k text, n int) on commit drop;
grant all on f8_rows to authenticated, service_role;

with u as (update public.profiles set full_name = 'Fassih Test Lead' where id = '18111111-1111-4111-8111-111111111111' returning 1)
insert into f8_rows select 'own', count(*) from u;
with u as (update public.profiles set full_name = 'Hijacked' where id = '18222222-2222-4222-8222-222222222222' returning 1)
insert into f8_rows select 'other', count(*) from u;
select throws_ok(
  $$ update public.profiles set role = 'admin' where id = '18111111-1111-4111-8111-111111111111' $$,
  '42501', null, 'a team lead cannot change their own role'
);
select throws_ok(
  $$ update public.profiles set full_name = 'X', role = 'admin' where id = '18111111-1111-4111-8111-111111111111' $$,
  '42501', null, 'a name update cannot carry a role change'
);
select throws_ok(
  $$ update public.profiles set full_name = E'Bad\u0007Name' where id = '18111111-1111-4111-8111-111111111111' $$,
  '23514', null, 'control characters are rejected'
);
select throws_ok(
  $$ update public.profiles set full_name = '   ' where id = '18111111-1111-4111-8111-111111111111' $$,
  '23514', null, 'a blank name is rejected'
);

select set_config('request.jwt.claims', '{"sub":"18333333-3333-4333-8333-333333333333","role":"authenticated"}', true);
with u as (update public.profiles set full_name = 'Renamed by admin' where id = '18222222-2222-4222-8222-222222222222' returning 1)
insert into f8_rows select 'admin_other', count(*) from u;
select is(
  (select owner_name from public.proposal_list where id = 'd8000000-0000-4000-8000-0000000000a2'),
  'Fassih Test Lead', 'the CEO sees the updated name as the owner (same profile source)'
);
reset role;

select is((select n from f8_rows where k = 'own'), 1, 'a team lead can rename themselves');
select is((select n from f8_rows where k = 'other'), 0, 'a team lead cannot rename another user');
select is((select n from f8_rows where k = 'admin_other'), 0, 'an admin cannot rename another user through the API');
select is(
  (select array_agg(full_name || ':' || role order by full_name) from public.profiles where id::text like '18%'),
  array['F8 Admin:admin', 'F8 Lead B:team_lead', 'Fassih Test Lead:team_lead'],
  'only the own name changed; roles unchanged'
);

-- 2. Deletion functions: privileges ---------------------------------------------
select ok(not has_function_privilege('anon', 'public.proposal_begin_deletion(uuid, uuid)', 'EXECUTE'), 'anon cannot begin deletion');
select ok(not has_function_privilege('authenticated', 'public.proposal_begin_deletion(uuid, uuid)', 'EXECUTE'), 'authenticated cannot begin deletion');
select ok(not has_function_privilege('authenticated', 'public.proposal_deletion_objects(uuid, uuid)', 'EXECUTE'), 'authenticated cannot list deletion objects');
select ok(not has_function_privilege('authenticated', 'public.proposal_finish_deletion(uuid, uuid)', 'EXECUTE'), 'authenticated cannot finish deletion');
select ok(has_function_privilege('service_role', 'public.proposal_finish_deletion(uuid, uuid)', 'EXECUTE'), 'service_role can finish deletion');
select ok(not has_table_privilege('authenticated', 'public.proposals', 'DELETE'), 'direct DELETE on proposals stays revoked');
select ok(not has_column_privilege('authenticated', 'public.proposals', 'deletion_requested_at', 'UPDATE'), 'authenticated cannot write the deletion marker');
select ok(has_column_privilege('authenticated', 'public.proposals', 'deletion_requested_at', 'SELECT'), 'authenticated can read the deletion marker');

-- 3. Begin deletion -------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select * from public.proposal_begin_deletion('18222222-2222-4222-8222-222222222222', 'd8000000-0000-4000-8000-0000000000a1') $$,
  'PT404', null, 'lead B cannot delete lead A''s proposal'
);
select throws_ok(
  $$ select * from public.proposal_begin_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000ff') $$,
  'PT404', null, 'a guessed id is not found'
);
select throws_ok(
  $$ select * from public.proposal_begin_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a3') $$,
  'PT412', null, 'a proposal with payment records is refused'
);
reset role;
select ok(
  (select deletion_requested_at is null from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a3'),
  'the refused proposal is not marked'
);
select is((select count(*)::int from public.resolve_proposal_offer(repeat('A', 43))), 1, 'A1 link works before deletion');

set local role service_role;
select is(
  (select owner_id from public.proposal_begin_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a1')),
  '18111111-1111-4111-8111-111111111111'::uuid, 'the owner can begin deletion'
);
reset role;

select is(
  (select row(status::text, link_token_hash is null, link_created_at is null, deletion_requested_at is not null, deletion_requested_by::text)
   from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a1'),
  row('draft'::text, true, true, true, '18111111-1111-4111-8111-111111111111'::text),
  'begin: link revoked, back to draft, marked with the actor'
);
select is((select count(*)::int from public.resolve_proposal_offer(repeat('A', 43))), 0, 'the client link stops resolving immediately');
select is((select count(*)::int from public.resolve_proposal_link(repeat('A', 43))), 0, 'resolve_proposal_link returns nothing');

create temporary table f8_mark as select deletion_requested_at from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a1';
set local role service_role;
select lives_ok(
  $$ select * from public.proposal_begin_deletion('18333333-3333-4333-8333-333333333333', 'd8000000-0000-4000-8000-0000000000a1') $$,
  'begin is idempotent (an admin can retry)'
);
reset role;
select is(
  (select deletion_requested_at from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a1'),
  (select deletion_requested_at from f8_mark), 'a retry keeps the original marker'
);

-- 4. A deleting proposal is frozen ----------------------------------------------
set local role service_role;
select throws_ok(
  $$ select public.proposal_issue_link('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a1',
       '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/preview.pdf',
       repeat('b', 64)) $$,
  'PT410', null, 'a new link cannot be issued while deleting'
);
select throws_ok(
  $$ select * from public.proposal_attach_original('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a1',
       '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/original.pdf',
       '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000009/original.pdf',
       'x.pdf', 100, 3) $$,
  'PT410', null, 'a document cannot be attached while deleting'
);
select throws_ok(
  $$ update public.proposals set deletion_requested_at = null where id = 'd8000000-0000-4000-8000-0000000000a1' $$,
  'PT410', null, 'the marker cannot be cleared, even by service_role'
);
select throws_ok(
  $$ update public.proposals set status = 'active', link_token_hash = repeat('c', 64), link_created_at = now()
     where id = 'd8000000-0000-4000-8000-0000000000a1' $$,
  'PT410', null, 'a deleting proposal can never become active again'
);
reset role;
select throws_ok(
  $$ insert into public.proposals (client_id, owner_id, title, status, original_storage_path, total_pages,
       preview_storage_path, free_preview_pages, unlock_price_minor, currency, link_token_hash, link_created_at, deletion_requested_at)
     select client_id, owner_id, 'x', 'active', null, null, null, null, null, null, repeat('d', 64), now(), now()
     from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a2' $$,
  '23514', null, 'the constraint forbids an active proposal with a deletion marker'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"18111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$ update public.proposals set title = 'Renamed' where id = 'd8000000-0000-4000-8000-0000000000a1' $$,
  'PT410', null, 'the owner cannot edit the title while deleting'
);
select ok(
  not private.can_upload_proposal_object('18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000007/original.pdf'),
  'uploads into a deleting proposal are refused'
);
select ok(
  private.can_upload_proposal_object('18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a2/e8000000-0000-4000-8000-000000000007/original.pdf'),
  'uploads into other drafts still work'
);
select is(
  (select array_agg(id::text order by id) from public.proposal_list where id::text like 'd8%'),
  array['d8000000-0000-4000-8000-0000000000a1', 'd8000000-0000-4000-8000-0000000000a2', 'd8000000-0000-4000-8000-0000000000a3'],
  'history: lead A sees only their own proposals (including the deleting one)'
);
select is(
  (select row(deletion_requested_at is not null, link_created_at is null, has_payments)
   from public.proposal_list where id = 'd8000000-0000-4000-8000-0000000000a1'),
  row(true, true, false), 'history columns: deletion pending, no link, no payments'
);
select is(
  (select has_payments from public.proposal_list where id = 'd8000000-0000-4000-8000-0000000000a3'),
  true, 'history shows payment-protected proposals'
);
select set_config('request.jwt.claims', '{"sub":"18333333-3333-4333-8333-333333333333","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.proposal_list where id::text like 'd8%'),
  4, 'history: the CEO sees proposals across leads'
);
reset role;

-- 5. Objects and finish -----------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select * from public.proposal_deletion_objects('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a2') $$,
  'PT423', null, 'objects are only listed for a proposal being deleted'
);
select throws_ok(
  $$ select * from public.proposal_deletion_objects('18222222-2222-4222-8222-222222222222', 'd8000000-0000-4000-8000-0000000000a1') $$,
  'PT404', null, 'another lead cannot list a deleting proposal''s objects'
);
select is(
  (select array_agg(n order by n) from public.proposal_deletion_objects('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a1') n),
  array[
    '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000000/original.pdf',
    '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/original.pdf',
    '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000001/preview.pdf',
    '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/e8000000-0000-4000-8000-000000000009/original.pdf'
  ],
  'exactly the proposal''s own objects (current, old revision, abandoned upload)'
);
select throws_ok(
  $$ select public.proposal_finish_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a1') $$,
  'PT409', null, 'finish is refused while stored files remain (retryable)'
);
select throws_ok(
  $$ select public.proposal_finish_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a2') $$,
  'PT423', null, 'finish requires a started deletion'
);
reset role;
select ok(exists (select 1 from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a1'), 'the row survives a failed finish');

-- Simulate the Storage API removing the objects (it deletes these rows).
set local storage.allow_delete_query = 'true';
delete from storage.objects
where bucket_id = 'proposals'
  and name like '18111111-1111-4111-8111-111111111111/d8000000-0000-4000-8000-0000000000a1/%';

set local role service_role;
select throws_ok(
  $$ select public.proposal_finish_deletion('18222222-2222-4222-8222-222222222222', 'd8000000-0000-4000-8000-0000000000a1') $$,
  'PT404', null, 'another lead cannot finish the deletion'
);
select lives_ok(
  $$ select public.proposal_finish_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a1') $$,
  'finish succeeds once storage is empty'
);
select throws_ok(
  $$ select public.proposal_finish_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a1') $$,
  'PT404', null, 'a repeated finish is a clean "not found"'
);
reset role;

select ok(not exists (select 1 from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a1'), 'the proposal row is gone');
select is((select count(*)::int from public.clients where id = 'c8000000-0000-4000-8000-00000000000a'), 1, 'the client record is kept');
select is((select count(*)::int from public.proposals where id::text like 'd8%'), 3, 'other proposals are kept');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'proposals' and name like '18%'),
  2, 'other proposals'' objects are untouched'
);
select is((select count(*)::int from public.payments where proposal_id = 'd8000000-0000-4000-8000-0000000000a3'), 1, 'payment records are untouched');

-- A payment recorded after deletion started still blocks the final delete.
set local role service_role;
select lives_ok(
  $$ select * from public.proposal_begin_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a2') $$,
  'A2 deletion started'
);
reset role;
insert into public.payments (proposal_id, provider, amount_minor, currency)
values ('d8000000-0000-4000-8000-0000000000a2', 'fake', 500, 'USD');
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'proposals' and name like '%/d8000000-0000-4000-8000-0000000000a2/%';
set local role service_role;
select throws_ok(
  $$ select public.proposal_finish_deletion('18111111-1111-4111-8111-111111111111', 'd8000000-0000-4000-8000-0000000000a2') $$,
  'PT412', null, 'finish re-checks payment records'
);
reset role;
select ok(exists (select 1 from public.proposals where id = 'd8000000-0000-4000-8000-0000000000a2'), 'the proposal with a late payment is kept');

-- The payments FK still restricts deletion (no cascade of financial records).
select is(
  (select confdeltype from pg_constraint
   where conrelid = 'public.payments'::regclass and confrelid = 'public.proposals'::regclass and contype = 'f'),
  'r', 'payments -> proposals foreign key is still ON DELETE RESTRICT'
);

select * from finish();
rollback;
