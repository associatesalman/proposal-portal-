-- Phase 5 database tests (pgTAP): the client page resolvers
-- resolve_proposal_offer (anon) and resolve_proposal_preview_object
-- (service_role only). Runs in one transaction that is rolled back; all data
-- is disposable.

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('15111111-1111-4111-8111-111111111111', 'p5-lead-a@test.local', 'authenticated', 'authenticated'),
  ('15222222-2222-4222-8222-222222222222', 'p5-lead-b@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('15111111-1111-4111-8111-111111111111', 'P5 Lead A', 'team_lead'),
  ('15222222-2222-4222-8222-222222222222', 'P5 Lead B', 'team_lead');

insert into public.clients (id, owner_id, name, email) values
  ('c5000000-0000-4000-8000-00000000000a', '15111111-1111-4111-8111-111111111111', 'Client A', 'a@client.test'),
  ('c5000000-0000-4000-8000-00000000000b', '15222222-2222-4222-8222-222222222222', 'Client B', 'b@client.test');

insert into public.proposals (id, client_id, owner_id, title) values
  ('d5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-00000000000a',
   '15111111-1111-4111-8111-111111111111', 'Proposal A'),
  ('d5000000-0000-4000-8000-00000000000b', 'c5000000-0000-4000-8000-00000000000b',
   '15222222-2222-4222-8222-222222222222', 'Proposal B');

create temporary table p5 (key text primary key, value text) on commit drop;
insert into p5 values
  ('a_orig', '15111111-1111-4111-8111-111111111111/d5000000-0000-4000-8000-00000000000a/e5000000-0000-4000-8000-000000000001/original.pdf'),
  ('a_prev', '15111111-1111-4111-8111-111111111111/d5000000-0000-4000-8000-00000000000a/e5000000-0000-4000-8000-000000000002/preview.pdf'),
  ('b_orig', '15222222-2222-4222-8222-222222222222/d5000000-0000-4000-8000-00000000000b/e5000000-0000-4000-8000-000000000003/original.pdf'),
  ('b_prev', '15222222-2222-4222-8222-222222222222/d5000000-0000-4000-8000-00000000000b/e5000000-0000-4000-8000-000000000004/preview.pdf'),
  ('token_a', 'P5a_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_A'),
  ('token_b', 'P5b_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_B'),
  ('unknown', 'P5u_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_U');
grant select on p5 to authenticated, anon, service_role;

-- Prepare and activate both proposals through the trusted Phase 4 functions.
set local role service_role;
select public.proposal_attach_original('15111111-1111-4111-8111-111111111111',
  'd5000000-0000-4000-8000-00000000000a', null, (select value from p5 where key = 'a_orig'), 'a.pdf', 1000, 5);
select public.proposal_save_offer('15111111-1111-4111-8111-111111111111',
  'd5000000-0000-4000-8000-00000000000a', (select value from p5 where key = 'a_orig'),
  (select value from p5 where key = 'a_prev'), 2, 2500, 'EUR');
select public.proposal_issue_link('15111111-1111-4111-8111-111111111111',
  'd5000000-0000-4000-8000-00000000000a', (select value from p5 where key = 'a_prev'),
  encode(extensions.digest((select value from p5 where key = 'token_a'), 'sha256'), 'hex'));
select public.proposal_attach_original('15222222-2222-4222-8222-222222222222',
  'd5000000-0000-4000-8000-00000000000b', null, (select value from p5 where key = 'b_orig'), 'b.pdf', 1000, 4);
select public.proposal_save_offer('15222222-2222-4222-8222-222222222222',
  'd5000000-0000-4000-8000-00000000000b', (select value from p5 where key = 'b_orig'),
  (select value from p5 where key = 'b_prev'), 3, 1500, 'JPY');
select public.proposal_issue_link('15222222-2222-4222-8222-222222222222',
  'd5000000-0000-4000-8000-00000000000b', (select value from p5 where key = 'b_prev'),
  encode(extensions.digest((select value from p5 where key = 'token_b'), 'sha256'), 'hex'));
reset role;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('anon', 'public.resolve_proposal_offer(text)', 'execute'),
  'anon can execute resolve_proposal_offer');
select ok(not has_function_privilege('anon', 'public.resolve_proposal_preview_object(text)', 'execute'),
  'anon cannot execute resolve_proposal_preview_object');
select ok(not has_function_privilege('authenticated', 'public.resolve_proposal_preview_object(text)', 'execute'),
  'authenticated cannot execute resolve_proposal_preview_object');
select ok(has_function_privilege('service_role', 'public.resolve_proposal_preview_object(text)', 'execute'),
  'service_role can execute resolve_proposal_preview_object');
select ok(not has_function_privilege('public', 'public.resolve_proposal_preview_object(text)', 'execute'),
  'PUBLIC has no execute on resolve_proposal_preview_object');

-- ---------------------------------------------------------------------------
-- resolve_proposal_offer (anon)
-- ---------------------------------------------------------------------------
set local role anon;
select results_eq(
  $$ select title, total_pages, free_preview_pages, unlock_price_minor, currency
     from public.resolve_proposal_offer((select value from p5 where key = 'token_a')) $$,
  $$ values ('Proposal A'::text, 5, 2, 2500, 'EUR'::text) $$,
  'token A resolves to proposal A''s display fields only'
);
select results_eq(
  $$ select title, total_pages, free_preview_pages, unlock_price_minor, currency
     from public.resolve_proposal_offer((select value from p5 where key = 'token_b')) $$,
  $$ values ('Proposal B'::text, 4, 3, 1500, 'JPY'::text) $$,
  'token B resolves to proposal B, not A'
);
select is_empty(
  $$ select * from public.resolve_proposal_offer((select value from p5 where key = 'unknown')) $$,
  'an unknown token resolves to nothing'
);
select is_empty(
  $$ select * from public.resolve_proposal_offer(
       encode(extensions.digest((select value from p5 where key = 'token_a'), 'sha256'), 'hex')) $$,
  'the stored hash is not a usable token'
);
select is_empty($$ select * from public.resolve_proposal_offer('short') $$, 'a malformed token resolves to nothing');
select is_empty($$ select * from public.resolve_proposal_offer(null) $$, 'a null token resolves to nothing');
select throws_ok(
  $$ select * from public.resolve_proposal_preview_object((select value from p5 where key = 'token_a')) $$,
  '42501', null, 'anon calling the preview-path resolver is denied'
);
select throws_ok(
  $$ select * from public.proposals $$,
  '42501', null, 'anon still has no table access'
);
reset role;

select is(
  (select array_to_string(proargnames, ',') from pg_proc where proname = 'resolve_proposal_offer'),
  'p_token,title,total_pages,free_preview_pages,unlock_price_minor,currency',
  'resolve_proposal_offer returns exactly title, page counts, price and currency'
);

-- ---------------------------------------------------------------------------
-- resolve_proposal_preview_object (service_role)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"15111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$ select public.resolve_proposal_preview_object((select value from p5 where key = 'token_a')) $$,
  '42501', null, 'even the owner cannot call the preview-path resolver from the API'
);
reset role;

set local role service_role;
select is(
  public.resolve_proposal_preview_object((select value from p5 where key = 'token_a')),
  (select value from p5 where key = 'a_prev'),
  'token A resolves to proposal A''s PREVIEW path'
);
select is(
  public.resolve_proposal_preview_object((select value from p5 where key = 'token_b')),
  (select value from p5 where key = 'b_prev'),
  'token B resolves to proposal B''s preview path'
);
select ok(
  public.resolve_proposal_preview_object((select value from p5 where key = 'token_a')) like '%/preview.pdf'
  and public.resolve_proposal_preview_object((select value from p5 where key = 'token_a'))
      <> (select value from p5 where key = 'a_orig'),
  'the resolver never returns the original''s path'
);
select is(public.resolve_proposal_preview_object((select value from p5 where key = 'unknown')), null,
  'unknown token: no path');
select is(public.resolve_proposal_preview_object('short'), null, 'malformed token: no path');
select is(
  public.resolve_proposal_preview_object(
    encode(extensions.digest((select value from p5 where key = 'token_a'), 'sha256'), 'hex')),
  null, 'hash as token: no path'
);

-- Revoking returns A to draft: both resolvers stop matching immediately.
select public.proposal_revoke_link('15111111-1111-4111-8111-111111111111', 'd5000000-0000-4000-8000-00000000000a');
select is(public.resolve_proposal_preview_object((select value from p5 where key = 'token_a')), null,
  'revoked token: no preview path');
reset role;

set local role anon;
select is_empty(
  $$ select * from public.resolve_proposal_offer((select value from p5 where key = 'token_a')) $$,
  'revoked token: no display fields'
);
select results_eq(
  $$ select title from public.resolve_proposal_offer((select value from p5 where key = 'token_b')) $$,
  $$ values ('Proposal B'::text) $$,
  'revoking A leaves B''s link working'
);
reset role;

select * from finish();
rollback;
