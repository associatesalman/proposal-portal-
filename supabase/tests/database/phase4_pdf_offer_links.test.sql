-- Phase 4 database tests (pgTAP): document/offer/link invariants, trusted
-- write functions, storage policies and link resolution.
-- Runs in one transaction that is rolled back; all data is disposable.

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'p4-admin@test.local',  'authenticated', 'authenticated'),
  ('11111111-1111-4111-8111-111111111111', 'p4-lead-a@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'p4-lead-b@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'P4 Admin',  'admin'),
  ('11111111-1111-4111-8111-111111111111', 'P4 Lead A', 'team_lead'),
  ('22222222-2222-4222-8222-222222222222', 'P4 Lead B', 'team_lead');

insert into public.clients (id, owner_id, name, email) values
  ('c4000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'Client A', 'a@client.test'),
  ('c4000000-0000-4000-8000-00000000000b', '22222222-2222-4222-8222-222222222222', 'Client B', 'b@client.test');

insert into public.proposals (id, client_id, owner_id, title) values
  ('d4000000-0000-4000-8000-00000000000a', 'c4000000-0000-4000-8000-00000000000a',
   '11111111-1111-4111-8111-111111111111', 'Proposal A'),
  ('d4000000-0000-4000-8000-00000000000b', 'c4000000-0000-4000-8000-00000000000b',
   '22222222-2222-4222-8222-222222222222', 'Proposal B');

-- Paths used below (revision folders r1/r2, all under lead A's proposal).
create temporary table p4 (key text primary key, value text) on commit drop;
insert into p4 values
  ('a_orig_r1', '11111111-1111-4111-8111-111111111111/d4000000-0000-4000-8000-00000000000a/e1000000-0000-4000-8000-000000000001/original.pdf'),
  ('a_prev_r2', '11111111-1111-4111-8111-111111111111/d4000000-0000-4000-8000-00000000000a/e2000000-0000-4000-8000-000000000002/preview.pdf'),
  ('a_orig_r3', '11111111-1111-4111-8111-111111111111/d4000000-0000-4000-8000-00000000000a/e3000000-0000-4000-8000-000000000003/original.pdf'),
  ('token',     'Zx9_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_A'),
  ('token2',    'Qx9_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_B');
grant select on p4 to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Table invariants (as migration owner, so only constraints apply)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.proposals
     set original_storage_path = '22222222-2222-4222-8222-222222222222/d4000000-0000-4000-8000-00000000000a/e1000000-0000-4000-8000-000000000001/original.pdf',
         total_pages = 5
     where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'original path must be under the proposal''s own owner and id'
);

select throws_ok(
  $$ update public.proposals set original_storage_path = (select value from p4 where key = 'a_orig_r1')
     where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'a stored original needs a page count'
);

select throws_ok(
  $$ update public.proposals
     set original_storage_path = (select value from p4 where key = 'a_orig_r1'), total_pages = 5,
         preview_storage_path = (select value from p4 where key = 'a_prev_r2'), free_preview_pages = 5
     where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'a preview must leave at least one page locked (free < total)'
);

select throws_ok(
  $$ update public.proposals set unlock_price_minor = 0 where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'unlock price must be positive'
);

select throws_ok(
  $$ update public.proposals set currency = 'CHF' where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'currency must be in the supported list'
);

select throws_ok(
  $$ update public.proposals set link_token_hash = repeat('a', 64), link_created_at = now()
     where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'a link token can only exist on an active proposal'
);

select throws_ok(
  $$ update public.proposals set status = 'active', link_token_hash = repeat('a', 64), link_created_at = now()
     where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'a proposal without preview and offer cannot be active, even with a token'
);

-- ---------------------------------------------------------------------------
-- Trusted write functions: not callable by browser roles
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

select throws_ok(
  $$ select * from public.proposal_attach_original('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', null, (select value from p4 where key = 'a_orig_r1'), 'x.pdf', 100, 5) $$,
  '42501', null, 'leads cannot call proposal_attach_original'
);
select throws_ok(
  $$ select public.proposal_issue_link('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', 'x', repeat('a', 64)) $$,
  '42501', null, 'leads cannot call proposal_issue_link'
);
select throws_ok(
  $$ select link_token_hash from public.proposals $$,
  '42501', null, 'leads cannot read token hashes'
);
select throws_ok(
  $$ update public.proposals set free_preview_pages = 1 where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'leads cannot write offer fields directly'
);
reset role;

set local role anon;
select throws_ok(
  $$ select public.proposal_revoke_link('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a') $$,
  '42501', null, 'anon cannot call proposal_revoke_link'
);
reset role;

-- ---------------------------------------------------------------------------
-- Trusted write functions: access, state and staleness checks
-- ---------------------------------------------------------------------------
set local role service_role;

select throws_ok(
  $$ select * from public.proposal_attach_original('22222222-2222-4222-8222-222222222222',
       'd4000000-0000-4000-8000-00000000000a', null, (select value from p4 where key = 'a_orig_r1'), 'x.pdf', 100, 5) $$,
  'PT404', null, 'another lead (as actor) gets "not found"'
);

select throws_ok(
  $$ select * from public.proposal_attach_original('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_orig_r3'),
       (select value from p4 where key = 'a_orig_r1'), 'x.pdf', 100, 5) $$,
  'PT409', null, 'a stale expected original is rejected'
);

select throws_ok(
  $$ select * from public.proposal_attach_original('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', null, (select value from p4 where key = 'a_orig_r1'), 'x.pdf', 100, 0) $$,
  '22023', null, 'a document without pages is rejected (one page is allowed for Full Access)'
);

select lives_ok(
  $$ select * from public.proposal_attach_original('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', null, (select value from p4 where key = 'a_orig_r1'), 'a.pdf', 1234, 5) $$,
  'owner records a verified original'
);

select throws_ok(
  $$ select public.proposal_issue_link('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_prev_r2'),
       encode(extensions.digest((select value from p4 where key = 'token'), 'sha256'), 'hex')) $$,
  'PT409', null, 'a link cannot be issued before a preview exists'
);

select throws_ok(
  $$ select * from public.proposal_save_offer('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_orig_r1'),
       (select value from p4 where key = 'a_prev_r2'), 5, 1000, 'USD') $$,
  '23514', null, 'save_offer rejects free pages = total pages'
);

select throws_ok(
  $$ select * from public.proposal_save_offer('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_orig_r1'),
       (select value from p4 where key = 'a_prev_r2'), 2, 1000, 'XYZ') $$,
  '23514', null, 'save_offer rejects an unsupported currency'
);

select lives_ok(
  $$ select * from public.proposal_save_offer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_orig_r1'),
       (select value from p4 where key = 'a_prev_r2'), 2, 4999, 'USD') $$,
  'admin (as actor) saves the offer for a lead''s proposal'
);

select lives_ok(
  $$ select public.proposal_issue_link('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_prev_r2'),
       encode(extensions.digest((select value from p4 where key = 'token'), 'sha256'), 'hex')) $$,
  'owner issues a link for a prepared draft'
);

select is(
  (select status::text from public.proposals where id = 'd4000000-0000-4000-8000-00000000000a'),
  'active', 'issuing a link activates the proposal'
);

select throws_ok(
  $$ select * from public.proposal_attach_original('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_orig_r1'),
       (select value from p4 where key = 'a_orig_r3'), 'b.pdf', 100, 5) $$,
  'PT423', null, 'an active proposal cannot get a new document'
);

select throws_ok(
  $$ select public.proposal_issue_link('11111111-1111-4111-8111-111111111111',
       'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_prev_r2'),
       encode(extensions.digest((select value from p4 where key = 'token2'), 'sha256'), 'hex')) $$,
  'PT423', null, 'a second link cannot be issued while one is active'
);
reset role;

-- Active proposals are locked for every role.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$ update public.proposals set title = 'Changed' where id = 'd4000000-0000-4000-8000-00000000000a' $$,
  'PT423', null, 'an active proposal''s title is locked'
);
reset role;

-- ---------------------------------------------------------------------------
-- Link resolution
-- ---------------------------------------------------------------------------
set local role anon;
select results_eq(
  $$ select title from public.resolve_proposal_link((select value from p4 where key = 'token')) $$,
  $$ values ('Proposal A'::text) $$,
  'anon resolves an active token to the title only'
);
select is_empty(
  $$ select * from public.resolve_proposal_link((select value from p4 where key = 'token2')) $$,
  'an unknown token resolves to nothing'
);
select is_empty(
  $$ select * from public.resolve_proposal_link(
       encode(extensions.digest((select value from p4 where key = 'token'), 'sha256'), 'hex')) $$,
  'the stored hash itself is not a usable token'
);
select is_empty(
  $$ select * from public.resolve_proposal_link('short') $$,
  'a malformed token resolves to nothing'
);
reset role;

set local role service_role;
select lives_ok(
  $$ select public.proposal_revoke_link('11111111-1111-4111-8111-111111111111', 'd4000000-0000-4000-8000-00000000000a') $$,
  'owner revokes the link'
);
select throws_ok(
  $$ select public.proposal_revoke_link('22222222-2222-4222-8222-222222222222', 'd4000000-0000-4000-8000-00000000000b') $$,
  'PT423', null, 'revoking a proposal without a link is refused'
);
reset role;

select is(
  (select status::text || ':' || coalesce(link_token_hash, 'null')
   from public.proposals where id = 'd4000000-0000-4000-8000-00000000000a'),
  'draft:null', 'revoking clears the token and returns to draft'
);

set local role anon;
select is_empty(
  $$ select * from public.resolve_proposal_link((select value from p4 where key = 'token')) $$,
  'a revoked token resolves to nothing'
);
reset role;

-- ---------------------------------------------------------------------------
-- Storage policies
-- ---------------------------------------------------------------------------
insert into storage.objects (bucket_id, name) values
  ('proposals', (select value from p4 where key = 'a_orig_r1')),
  ('proposals', (select value from p4 where key = 'a_prev_r2')),
  ('proposals', '11111111-1111-4111-8111-111111111111/d4000000-0000-4000-8000-00000000000a/e9000000-0000-4000-8000-000000000009/original.pdf');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

select lives_ok(
  $$ insert into storage.objects (bucket_id, name) values ('proposals', (select value from p4 where key = 'a_orig_r3')) $$,
  'lead uploads a new revision into their own draft'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('proposals',
       '22222222-2222-4222-8222-222222222222/d4000000-0000-4000-8000-00000000000b/e1000000-0000-4000-8000-000000000001/original.pdf') $$,
  '42501', null, 'lead cannot upload into another lead''s proposal'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('proposals',
       '11111111-1111-4111-8111-111111111111/d4000000-0000-4000-8000-00000000000a/not-a-uuid/original.pdf') $$,
  '42501', null, 'revision folder must be a uuid'
);

-- Direct SQL deletes on storage tables are blocked by Supabase
-- (storage.protect_delete), so the delete policy's predicate is checked here;
-- real deletes through the Storage API are covered by `npm run test:pdf`.
select is(
  private.can_delete_proposal_object((select value from p4 where key = 'a_orig_r1')),
  false, 'the document a proposal uses cannot be deleted'
);
select is(
  private.can_delete_proposal_object((select value from p4 where key = 'a_prev_r2')),
  false, 'the preview a proposal uses cannot be deleted'
);
select is(
  private.can_delete_proposal_object(
    '11111111-1111-4111-8111-111111111111/d4000000-0000-4000-8000-00000000000a/e9000000-0000-4000-8000-000000000009/original.pdf'),
  true, 'an unreferenced (orphaned) upload can be cleaned up'
);
select is(
  private.can_delete_proposal_object(
    '22222222-2222-4222-8222-222222222222/d4000000-0000-4000-8000-00000000000b/e9000000-0000-4000-8000-000000000009/original.pdf'),
  false, 'another lead''s objects cannot be deleted'
);

with u as (
  update storage.objects set name = name where bucket_id = 'proposals'
    and name = (select value from p4 where key = 'a_orig_r1') returning 1
)
select is(count(*)::int, 0, 'stored objects cannot be overwritten (no update policy)') from u;
reset role;

-- Uploads into an active proposal are refused.
set local role service_role;
select public.proposal_issue_link('11111111-1111-4111-8111-111111111111',
  'd4000000-0000-4000-8000-00000000000a', (select value from p4 where key = 'a_prev_r2'),
  encode(extensions.digest((select value from p4 where key = 'token2'), 'sha256'), 'hex'));
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('proposals',
       '11111111-1111-4111-8111-111111111111/d4000000-0000-4000-8000-00000000000a/e8000000-0000-4000-8000-000000000008/original.pdf') $$,
  '42501', null, 'no uploads into an active proposal'
);
reset role;

select * from finish();
rollback;
