-- Phase 2 authorization tests (pgTAP). Run with: npm run db:test
--
-- Everything runs inside one transaction and is rolled back: all users and
-- rows below are disposable. Isolation checks switch to the real
-- `authenticated` / `anon` roles with JWT claims set, so RLS and grants are
-- exercised exactly as for API requests. The service role is never used for
-- isolation checks (it bypasses RLS).

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures (as the migration owner)
-- ---------------------------------------------------------------------------
-- admin   aaaaaaaa-...  lead A  11111111-...  lead B  22222222-...
-- nobody  99999999-...  (authenticated, but no profile)
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin@test.local',  'authenticated', 'authenticated'),
  ('11111111-1111-4111-8111-111111111111', 'lead-a@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'lead-b@test.local', 'authenticated', 'authenticated'),
  ('99999999-9999-4999-8999-999999999999', 'nobody@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Admin',  'admin'),
  ('11111111-1111-4111-8111-111111111111', 'Test Lead A', 'team_lead'),
  ('22222222-2222-4222-8222-222222222222', 'Test Lead B', 'team_lead');

insert into public.clients (id, owner_id, name, email) values
  ('c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'Client A', 'a@client.test'),
  ('c0000000-0000-4000-8000-00000000000b', '22222222-2222-4222-8222-222222222222', 'Client B', 'b@client.test');

insert into public.proposals
  (id, client_id, owner_id, title, original_storage_path, total_pages, free_preview_pages, unlock_price_minor, currency)
values
  ('d0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-00000000000a',
   '11111111-1111-4111-8111-111111111111', 'Proposal A',
   '11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-00000000000a/original.pdf',
   10, 2, 5000, 'USD'),
  ('d0000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-00000000000b',
   '22222222-2222-4222-8222-222222222222', 'Proposal B',
   '22222222-2222-4222-8222-222222222222/d0000000-0000-4000-8000-00000000000b/original.pdf',
   8, 3, 7000, 'EUR');

insert into public.payments (id, proposal_id, provider, provider_payment_id, amount_minor, currency, status) values
  ('e0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-00000000000a', 'test', 'pay_a', 5000, 'USD', 'succeeded'),
  ('e0000000-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-00000000000b', 'test', 'pay_b', 7000, 'EUR', 'pending');

insert into storage.objects (bucket_id, name) values
  ('proposals', '11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-00000000000a/original.pdf'),
  ('proposals', '22222222-2222-4222-8222-222222222222/d0000000-0000-4000-8000-00000000000b/original.pdf');

-- ---------------------------------------------------------------------------
-- Schema-level guarantees (as migration owner)
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(relrowsecurity) from pg_class
   where oid in ('public.profiles'::regclass, 'public.clients'::regclass,
                 'public.proposals'::regclass, 'public.payments'::regclass)),
  'RLS is enabled on all application tables'
);

select is(
  (select public from storage.buckets where id = 'proposals'),
  false,
  'proposals bucket is private'
);

select throws_ok(
  $$ insert into public.proposals (client_id, owner_id, title, total_pages, free_preview_pages, unlock_price_minor, currency)
     values ('c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'x', 3, 4, 100, 'USD') $$,
  '23514', null, 'free_preview_pages cannot exceed total_pages'
);

select throws_ok(
  $$ insert into public.proposals (client_id, owner_id, title, free_preview_pages, unlock_price_minor, currency)
     values ('c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'x', 0, 100, 'USD') $$,
  '23514', null, 'free_preview_pages must be at least 1'
);

select throws_ok(
  $$ insert into public.proposals (client_id, owner_id, title, unlock_price_minor, currency)
     values ('c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'x', -1, 'USD') $$,
  '23514', null, 'negative unlock price is rejected'
);

select throws_ok(
  $$ insert into public.proposals (client_id, owner_id, title, unlock_price_minor, currency)
     values ('c0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'x', 100, 'usd') $$,
  '23514', null, 'lowercase / invalid currency code is rejected'
);

select throws_ok(
  $$ update public.proposals
     set original_storage_path = '22222222-2222-4222-8222-222222222222/d0000000-0000-4000-8000-00000000000b/original.pdf'
     where id = 'd0000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'a proposal cannot point at another proposal''s storage path'
);

select throws_ok(
  $$ update public.proposals set status = 'active' where id = 'd0000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'proposal cannot become active without original, preview and page count'
);

select throws_ok(
  $$ insert into public.payments (proposal_id, provider, provider_payment_id, amount_minor, currency)
     values ('d0000000-0000-4000-8000-00000000000a', 'test', 'pay_a', 5000, 'USD') $$,
  '23505', null, 'provider payment reference is unique per provider'
);

select throws_ok(
  $$ insert into public.payments (proposal_id, provider, amount_minor, currency)
     values ('d0000000-0000-4000-8000-00000000000a', 'test', -5, 'USD') $$,
  '23514', null, 'negative payment amount is rejected'
);

select throws_ok(
  $$ delete from public.proposals where id = 'd0000000-0000-4000-8000-00000000000a' $$,
  '23503', null, 'a proposal with payments cannot be deleted (payment history preserved)'
);

select throws_ok(
  $$ delete from public.clients where id = 'c0000000-0000-4000-8000-00000000000a' $$,
  '23503', null, 'a client with proposals cannot be deleted'
);

select throws_ok(
  $$ delete from auth.users where id = '11111111-1111-4111-8111-111111111111' $$,
  '23503', null, 'deleting an auth user who owns records is blocked'
);

insert into public.clients (id, owner_id, name, email, created_at, updated_at)
values ('c0000000-0000-4000-8000-0000000000ff', '11111111-1111-4111-8111-111111111111',
        'Timestamp probe', 't@client.test', '2000-01-01', '2000-01-01');

select ok(
  (select created_at > '2020-01-01' and updated_at > '2020-01-01'
   from public.clients where id = 'c0000000-0000-4000-8000-0000000000ff'),
  'timestamps are set by the server, not the caller'
);

delete from public.clients where id = 'c0000000-0000-4000-8000-0000000000ff';

-- ---------------------------------------------------------------------------
-- Anonymous visitor
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select throws_ok($$ select * from public.clients $$,   '42501', null, 'anon cannot read clients');
select throws_ok($$ select * from public.proposals $$, '42501', null, 'anon cannot read proposals');
select throws_ok($$ select * from public.payments $$,  '42501', null, 'anon cannot read payments');
select throws_ok($$ select * from public.profiles $$,  '42501', null, 'anon cannot read profiles');

select is(
  (select count(*)::int from storage.objects where bucket_id = 'proposals'),
  0,
  'anon cannot list or read proposal PDF objects'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('proposals', '11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-00000000000a/preview.pdf') $$,
  '42501', null, 'anon cannot upload proposal objects'
);

reset role;

-- ---------------------------------------------------------------------------
-- Authenticated user WITHOUT a profile
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', true);

select is((select count(*)::int from public.profiles),  0, 'no-profile user sees no profiles');
select is((select count(*)::int from public.clients),   0, 'no-profile user sees no clients');
select is((select count(*)::int from public.proposals), 0, 'no-profile user sees no proposals');
select is((select count(*)::int from public.payments),  0, 'no-profile user sees no payments');
select is((select count(*)::int from storage.objects where bucket_id = 'proposals'), 0,
  'no-profile user sees no proposal objects');

select throws_ok(
  $$ insert into public.clients (owner_id, name, email)
     values ('99999999-9999-4999-8999-999999999999', 'x', 'x@client.test') $$,
  '23503', null, 'no-profile user cannot create clients'
);

select throws_ok(
  $$ insert into public.profiles (id, full_name, role)
     values ('99999999-9999-4999-8999-999999999999', 'Me', 'admin') $$,
  '42501', null, 'no-profile user cannot provision their own profile'
);

reset role;

-- ---------------------------------------------------------------------------
-- Lead A
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","user_metadata":{"role":"admin"},"app_metadata":{"role":"admin"}}',
  true);

select is((select private.is_admin()), false, 'lead A is not admin (JWT metadata claims are ignored)');

select results_eq(
  $$ select id from public.profiles $$,
  $$ values ('11111111-1111-4111-8111-111111111111'::uuid) $$,
  'lead A reads only their own profile'
);

select results_eq(
  $$ select id from public.clients $$,
  $$ values ('c0000000-0000-4000-8000-00000000000a'::uuid) $$,
  'lead A reads only their own clients'
);

select results_eq(
  $$ select id from public.proposals $$,
  $$ values ('d0000000-0000-4000-8000-00000000000a'::uuid) $$,
  'lead A reads only their own proposals'
);

select results_eq(
  $$ select id from public.payments $$,
  $$ values ('e0000000-0000-4000-8000-00000000000a'::uuid) $$,
  'lead A reads only payments for their own proposals'
);

-- Writes against lead B's rows silently match zero rows under RLS.
with u as (
  update public.clients set name = 'hijacked'
  where id = 'c0000000-0000-4000-8000-00000000000b' returning 1
)
select is(count(*)::int, 0, 'lead A cannot update lead B''s client') from u;

with u as (
  update public.proposals set title = 'hijacked'
  where id = 'd0000000-0000-4000-8000-00000000000b' returning 1
)
select is(count(*)::int, 0, 'lead A cannot update lead B''s proposal') from u;

with d as (
  delete from public.clients where id = 'c0000000-0000-4000-8000-00000000000b' returning 1
)
select is(count(*)::int, 0, 'lead A cannot delete lead B''s client') from d;

-- Since Phase 7 no application role can delete proposals at all (not even
-- its own; see phase7_hardening.test.sql), so this is a privilege error.
select throws_ok(
  $$ delete from public.proposals where id = 'd0000000-0000-4000-8000-00000000000b' $$,
  '42501', null, 'lead A cannot delete lead B''s proposal'
);

select throws_ok(
  $$ insert into public.clients (owner_id, name, email)
     values ('22222222-2222-4222-8222-222222222222', 'Planted', 'p@client.test') $$,
  '42501', null, 'lead A cannot create a client owned by lead B'
);

-- Since Phase 4, offer values and status are not insertable/updatable by
-- browser roles (trusted server functions set them), so these inserts omit them.
select throws_ok(
  $$ insert into public.proposals (client_id, owner_id, title)
     values ('c0000000-0000-4000-8000-00000000000b', '22222222-2222-4222-8222-222222222222', 'Planted') $$,
  '42501', null, 'lead A cannot create a proposal owned by lead B'
);

select throws_ok(
  $$ insert into public.proposals (client_id, owner_id, title)
     values ('c0000000-0000-4000-8000-00000000000b', '11111111-1111-4111-8111-111111111111', 'Attach') $$,
  '23503', null, 'lead A cannot attach a new proposal to lead B''s client'
);

-- Since Phase 3, client_id is not updatable at all (42501); before that the
-- composite FK rejected this (23503).
select throws_ok(
  $$ update public.proposals set client_id = 'c0000000-0000-4000-8000-00000000000b'
     where id = 'd0000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'lead A cannot move their proposal onto lead B''s client'
);

select throws_ok(
  $$ update public.clients set owner_id = '22222222-2222-4222-8222-222222222222'
     where id = 'c0000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'lead A cannot reassign their client to lead B'
);

select throws_ok(
  $$ update public.proposals set owner_id = '22222222-2222-4222-8222-222222222222'
     where id = 'd0000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'lead A cannot reassign their proposal to lead B'
);

select throws_ok(
  $$ update public.profiles set role = 'admin' where id = '11111111-1111-4111-8111-111111111111' $$,
  '42501', null, 'lead A cannot promote themselves to admin'
);

select throws_ok(
  $$ insert into public.profiles (id, full_name, role)
     values ('99999999-9999-4999-8999-999999999999', 'Sock puppet', 'admin') $$,
  '42501', null, 'lead A cannot provision profiles'
);

select throws_ok(
  $$ update public.proposals set total_pages = 1000 where id = 'd0000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'lead A cannot set server-controlled total_pages'
);

select throws_ok(
  $$ update public.proposals set preview_storage_path = 'x' where id = 'd0000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'lead A cannot set server-controlled storage paths'
);

select throws_ok(
  $$ insert into public.payments (proposal_id, provider, amount_minor, currency)
     values ('d0000000-0000-4000-8000-00000000000a', 'test', 1, 'USD') $$,
  '42501', null, 'lead A cannot create payment records'
);

select throws_ok(
  $$ update public.payments set status = 'succeeded' where id = 'e0000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'lead A cannot update payment records'
);

select throws_ok(
  $$ delete from public.payments where id = 'e0000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'lead A cannot delete payment records'
);

-- Own records remain fully manageable.
select lives_ok(
  $$ insert into public.clients (owner_id, name, email)
     values ('11111111-1111-4111-8111-111111111111', 'Client A2', 'a2@client.test') $$,
  'lead A can create their own client'
);

select lives_ok(
  $$ insert into public.proposals (client_id, owner_id, title)
     values ((select id from public.clients where name = 'Client A2'),
             '11111111-1111-4111-8111-111111111111', 'Proposal A2') $$,
  'lead A can create a proposal for their own client'
);

-- status is no longer writable by browser roles (Phase 4); the title is.
with u as (
  update public.proposals set title = 'Proposal A (edited)'
  where id = 'd0000000-0000-4000-8000-00000000000a' returning 1
)
select is(count(*)::int, 1, 'lead A can update their own proposal') from u;

-- Storage
select results_eq(
  $$ select name from storage.objects where bucket_id = 'proposals' $$,
  $$ values ('11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-00000000000a/original.pdf'::text) $$,
  'lead A sees only their own proposal objects'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('proposals', '22222222-2222-4222-8222-222222222222/d0000000-0000-4000-8000-00000000000b/preview.pdf') $$,
  '42501', null, 'lead A cannot write into lead B''s proposal folder'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('proposals', '11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-00000000000b/original.pdf') $$,
  '42501', null, 'own owner prefix + lead B''s proposal id is rejected'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('proposals', '11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-0000000000ee/original.pdf') $$,
  '42501', null, 'own owner prefix with a non-existent proposal id is rejected'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('proposals', '11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-00000000000a/other.pdf') $$,
  '42501', null, 'only original.pdf / preview.pdf object names are allowed'
);

select lives_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('proposals', '11111111-1111-4111-8111-111111111111/d0000000-0000-4000-8000-00000000000a/preview.pdf') $$,
  'lead A can write an object for their own proposal'
);

-- Direct SQL deletes on storage tables are blocked for everyone by Supabase's
-- storage.protect_delete trigger; API-level deletes are covered by
-- supabase/tests/integration/phase2-api.mjs.
with u as (
  update storage.objects set metadata = '{"tampered":true}'::jsonb
  where bucket_id = 'proposals'
    and name = '22222222-2222-4222-8222-222222222222/d0000000-0000-4000-8000-00000000000b/original.pdf'
  returning 1
)
select is(count(*)::int, 0, 'lead A cannot modify lead B''s PDF object') from u;

reset role;

-- ---------------------------------------------------------------------------
-- Lead B (symmetry check: cannot see A's rows, including those A just created)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);

select results_eq(
  $$ select id from public.clients $$,
  $$ values ('c0000000-0000-4000-8000-00000000000b'::uuid) $$,
  'lead B reads only their own clients'
);

select results_eq(
  $$ select title from public.proposals $$,
  $$ values ('Proposal B'::text) $$,
  'lead B reads only their own proposals (and A''s edits did not touch B)'
);

reset role;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is((select private.is_admin()), true, 'admin is recognised from profiles.role');
-- Counts are limited to fixture rows so real local data doesn't affect them.
select is((select count(*)::int from public.profiles where id in ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')),  3, 'admin reads all internal profiles');
select is((select count(*)::int from public.clients where owner_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')),   3, 'admin reads clients across leads');
select is((select count(*)::int from public.proposals where owner_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')), 3, 'admin reads proposals across leads');
select is((select count(*)::int from public.payments pm where exists (select 1 from public.proposals p where p.id = pm.proposal_id and p.owner_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'))),  2, 'admin reads all payments');
select is((select count(*)::int from storage.objects where bucket_id = 'proposals' and (name like '11111111-1111-4111-8111-111111111111/%' or name like '22222222-2222-4222-8222-222222222222/%')), 3,
  'admin reads all proposal objects');

with u as (
  update public.proposals set title = 'Edited by admin'
  where id = 'd0000000-0000-4000-8000-00000000000b' returning 1
)
select is(count(*)::int, 1, 'admin can update a lead''s proposal') from u;

select lives_ok(
  $$ insert into public.clients (owner_id, name, email)
     values ('22222222-2222-4222-8222-222222222222', 'Admin-created for B', 'ab@client.test') $$,
  'admin can create a client on behalf of a lead'
);

select throws_ok(
  $$ update public.proposals set owner_id = '11111111-1111-4111-8111-111111111111'
     where id = 'd0000000-0000-4000-8000-00000000000b' $$,
  '42501', null, 'ownership is immutable through the API, even for admin'
);

select throws_ok(
  $$ insert into public.payments (proposal_id, provider, amount_minor, currency)
     values ('d0000000-0000-4000-8000-00000000000b', 'test', 1, 'EUR') $$,
  '42501', null, 'admin cannot write payment records from the browser'
);

select throws_ok(
  $$ update public.profiles set role = 'team_lead' where id = '22222222-2222-4222-8222-222222222222' $$,
  '42501', null, 'roles cannot be changed through the API, even by admin'
);

reset role;

select * from finish();

rollback;
