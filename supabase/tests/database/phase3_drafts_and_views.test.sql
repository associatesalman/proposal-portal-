-- Phase 3 database tests (pgTAP): draft proposals and dashboard list views.
-- Runs in one transaction that is rolled back; all data is disposable.

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'p3-admin@test.local',  'authenticated', 'authenticated'),
  ('11111111-1111-4111-8111-111111111111', 'p3-lead-a@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'p3-lead-b@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'P3 Admin',  'admin'),
  ('11111111-1111-4111-8111-111111111111', 'P3 Lead A', 'team_lead'),
  ('22222222-2222-4222-8222-222222222222', 'P3 Lead B', 'team_lead');

insert into public.clients (id, owner_id, name, email) values
  ('c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'Acme Ltd',   'ops@acme.test'),
  ('c0000000-0000-4000-8000-0000000000a2', '11111111-1111-4111-8111-111111111111', 'Second A',   'two@a.test'),
  ('c0000000-0000-4000-8000-00000000000b', '22222222-2222-4222-8222-222222222222', 'Bravo GmbH', 'hi@bravo.test');

-- Draft proposals -------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

select lives_ok(
  $$ insert into public.proposals (client_id, owner_id, title)
     values ('c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'Draft for Acme') $$,
  'a draft can be created with only client, owner and title'
);

select ok(
  (select status = 'draft'
      and original_storage_path is null and preview_storage_path is null
      and total_pages is null and free_preview_pages is null
      and unlock_price_minor is null and currency is null
   from public.proposals where title = 'Draft for Acme'),
  'new draft has no PDF, page count or offer values'
);

select throws_ok(
  $$ update public.proposals set client_id = 'c0000000-0000-4000-8000-0000000000a2'
     where title = 'Draft for Acme' $$,
  '42501', null, 'a proposal''s client cannot be changed, even to another own client'
);

-- Phase 3 expected 23514 (constraint). Since Phase 4 status is not writable
-- by browser roles at all; the constraint itself is still checked below.
select throws_ok(
  $$ update public.proposals set status = 'active' where title = 'Draft for Acme' $$,
  '42501', null, 'a draft without documents/offer cannot become active'
);

reset role;

-- Completed proposals are still strict (as migration owner, simulating server code)
select throws_ok(
  $$ insert into public.proposals
       (client_id, owner_id, title, status, original_storage_path, preview_storage_path, total_pages)
     select 'c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'No offer', 'active',
            '11111111-1111-4111-8111-111111111111/' || id || '/original.pdf',
            '11111111-1111-4111-8111-111111111111/' || id || '/preview.pdf', 5
     from (select gen_random_uuid() as id) g $$,
  '23514', null, 'active proposal without free pages / price / currency is rejected'
);

insert into public.proposals (id, client_id, owner_id, title, status) values
  ('d0000000-0000-4000-8000-0000000000a9', 'c0000000-0000-4000-8000-00000000000a',
   '11111111-1111-4111-8111-111111111111', 'Archived A', 'archived'),
  ('d0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-00000000000b',
   '22222222-2222-4222-8222-222222222222', 'Bravo draft', 'draft');

-- Views: lead A -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

select results_eq(
  $$ select name, proposal_count, owner_name from public.client_list order by name $$,
  $$ values ('Acme Ltd'::text, 2, 'P3 Lead A'::text), ('Second A'::text, 0, 'P3 Lead A'::text) $$,
  'lead A: client_list shows only own clients with correct proposal counts'
);

select results_eq(
  $$ select title from public.proposal_list order by title $$,
  $$ values ('Archived A'::text), ('Draft for Acme'::text) $$,
  'lead A: proposal_list shows only own proposals'
);

select is(
  (select count(*)::int from public.proposal_list where search_text ilike '%bravo%'),
  0,
  'lead A: searching for lead B''s client finds nothing'
);

select is(
  (select count(*)::int from public.client_list where search_text ilike '%acme.test%'),
  1,
  'client search matches email'
);

select is(
  (select count(*)::int from public.client_list where search_text ilike '%ltd' || chr(10) || 'ops%'),
  1,
  'search_text uses a newline separator (control chars are stripped from user queries)'
);

select throws_ok(
  $$ update public.client_list set name = 'x' $$,
  null, null, 'list views reject writes'
);

reset role;

select ok(
  not has_table_privilege('authenticated', 'public.client_list', 'INSERT, UPDATE, DELETE')
  and not has_table_privilege('authenticated', 'public.proposal_list', 'INSERT, UPDATE, DELETE'),
  'authenticated has no write privileges on list views'
);

-- Views: admin ------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);

-- Limited to fixture leads so real local data doesn't affect the count.
select is((select count(*)::int from public.client_list where owner_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')), 3, 'admin: client_list spans all leads');
select is((select count(*)::int from public.proposal_list where owner_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')), 3, 'admin: proposal_list spans all leads');
select is(
  (select count(*)::int from public.proposal_list where owner_id = '22222222-2222-4222-8222-222222222222'),
  1,
  'admin: owner filter on proposal_list'
);
select is(
  (select owner_name from public.proposal_list where title = 'Bravo draft'),
  'P3 Lead B',
  'admin: proposal_list exposes owner name'
);

reset role;

-- Views: anon -------------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.client_list $$,   '42501', null, 'anon cannot read client_list');
select throws_ok($$ select * from public.proposal_list $$, '42501', null, 'anon cannot read proposal_list');
reset role;

select * from finish();

rollback;
