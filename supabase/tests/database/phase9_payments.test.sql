-- Payment tests (pgTAP): browser roles can't touch payment data or
-- functions, checkout snapshots come from the proposal, the verified-state
-- machine, entitlements and browser access sessions, refunds, recovery
-- tokens, webhook event dedupe, purchased-file retention and dashboard RLS.
-- Runs in one transaction that is rolled back; all data is disposable.

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('19111111-1111-4111-8111-111111111111', 'p9-lead-a@test.local', 'authenticated', 'authenticated'),
  ('19222222-2222-4222-8222-222222222222', 'p9-lead-b@test.local', 'authenticated', 'authenticated'),
  ('19333333-3333-4333-8333-333333333333', 'p9-admin@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('19111111-1111-4111-8111-111111111111', 'P9 Lead A', 'team_lead'),
  ('19222222-2222-4222-8222-222222222222', 'P9 Lead B', 'team_lead'),
  ('19333333-3333-4333-8333-333333333333', 'P9 Admin', 'admin');

insert into public.clients (id, owner_id, name, email) values
  ('c9000000-0000-4000-8000-00000000000a', '19111111-1111-4111-8111-111111111111', 'Client A', 'client-a@client.test'),
  ('c9000000-0000-4000-8000-00000000000b', '19222222-2222-4222-8222-222222222222', 'Client B', 'client-b@client.test');

-- A1: lead A, active, link token repeat('P', 43). B1: lead B, active, link
-- token repeat('Q', 43). A2: lead A, active but its file is missing.
insert into public.proposals (
  id, client_id, owner_id, title, status,
  original_storage_path, total_pages, preview_storage_path, free_preview_pages,
  unlock_price_minor, currency, link_token_hash, link_created_at
) values (
  'd9000000-0000-4000-8000-0000000000a1', 'c9000000-0000-4000-8000-00000000000a',
  '19111111-1111-4111-8111-111111111111', 'Proposal A1', 'active',
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf', 6,
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/preview.pdf', 2,
  2500, 'USD', encode(extensions.digest(repeat('P', 43), 'sha256'), 'hex'), now()
), (
  'd9000000-0000-4000-8000-0000000000b1', 'c9000000-0000-4000-8000-00000000000b',
  '19222222-2222-4222-8222-222222222222', 'Proposal B1', 'active',
  '19222222-2222-4222-8222-222222222222/d9000000-0000-4000-8000-0000000000b1/e9000000-0000-4000-8000-000000000003/original.pdf', 4,
  '19222222-2222-4222-8222-222222222222/d9000000-0000-4000-8000-0000000000b1/e9000000-0000-4000-8000-000000000003/preview.pdf', 1,
  900, 'EUR', encode(extensions.digest(repeat('Q', 43), 'sha256'), 'hex'), now()
), (
  'd9000000-0000-4000-8000-0000000000a2', 'c9000000-0000-4000-8000-00000000000a',
  '19111111-1111-4111-8111-111111111111', 'Proposal A2', 'active',
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a2/e9000000-0000-4000-8000-000000000002/original.pdf', 3,
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a2/e9000000-0000-4000-8000-000000000002/preview.pdf', 1,
  1000, 'USD', encode(extensions.digest(repeat('R', 43), 'sha256'), 'hex'), now()
);

insert into storage.objects (bucket_id, name, metadata)
select 'proposals', n, jsonb_build_object('size', 100)
from unnest(array[
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf',
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/preview.pdf',
  '19222222-2222-4222-8222-222222222222/d9000000-0000-4000-8000-0000000000b1/e9000000-0000-4000-8000-000000000003/original.pdf',
  '19222222-2222-4222-8222-222222222222/d9000000-0000-4000-8000-0000000000b1/e9000000-0000-4000-8000-000000000003/preview.pdf'
]) as n;

create temporary table p9 (k text primary key, v text) on commit drop;
grant all on p9 to authenticated, service_role;

-- 1. Browser roles: no payment data, no payment functions ------------------------
select ok(not has_table_privilege('authenticated', 'public.payments', 'INSERT'), 'authenticated may not insert payments');
select ok(not has_any_column_privilege('authenticated', 'public.payments', 'UPDATE'), 'authenticated may not update payments');
select ok(not has_table_privilege('authenticated', 'public.payments', 'DELETE'), 'authenticated may not delete payments');
select ok(not has_any_column_privilege('anon', 'public.payments', 'SELECT'), 'anon may not read payments');
select ok(not has_column_privilege('authenticated', 'public.payments', 'checkout_session_hash', 'SELECT'), 'browser session hash is not readable');
select ok(not has_column_privilege('authenticated', 'public.payments', 'payer_email', 'SELECT'), 'payer email is not readable');
select ok(not has_column_privilege('authenticated', 'public.payments', 'original_storage_path', 'SELECT'), 'storage path is not readable');
select ok(not has_column_privilege('authenticated', 'public.payments', 'approve_url', 'SELECT'), 'approve url is not readable');
select ok(not has_column_privilege('authenticated', 'public.payments', 'public_ref', 'SELECT'), 'public ref is not readable');
select ok(has_column_privilege('authenticated', 'public.payments', 'provider_payment_id', 'SELECT'), 'capture reference is readable (RLS-limited)');

select ok(
  not exists (
    select 1
    from unnest(array['public.payment_entitlements', 'public.payment_access_sessions', 'public.payment_recovery_tokens',
                      'public.payment_events', 'public.payment_refunds']) t,
         unnest(array['anon', 'authenticated']) r,
         unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) priv
    where has_table_privilege(r, t, priv)
  ),
  'browser roles have no privileges on entitlement, session, token, event or refund tables'
);

select ok(
  not exists (
    select 1
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace,
         unnest(array['anon', 'authenticated']) r
    where n.nspname = 'public' and f.proname like 'payment\_%' and has_function_privilege(r, f.oid, 'EXECUTE')
  ),
  'browser roles cannot execute any payment_* function'
);
select ok(
  (select count(*) from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname = 'public' and f.proname like 'payment\_%' and has_function_privilege('service_role', f.oid, 'EXECUTE')) >= 16,
  'service_role can execute the payment functions'
);

-- 2. Checkout attempts ---------------------------------------------------------------
set local role service_role;

insert into p9 select 'a1', payment_id::text from public.payment_begin_checkout(repeat('P', 43), repeat('a', 64), 'sandbox');
insert into p9 select 'a1_ref', public_ref from public.payment_begin_checkout(repeat('P', 43), repeat('a', 64), 'sandbox');
select is(
  (select reused from public.payment_begin_checkout(repeat('P', 43), repeat('a', 64), 'sandbox')),
  true, 'a second checkout from the same browser reuses the open attempt'
);
select is(
  (select count(*)::integer from public.payments where proposal_id = 'd9000000-0000-4000-8000-0000000000a1'),
  1, 'double submits create one payment row'
);
select is(
  (select amount_minor from public.payment_begin_checkout(repeat('P', 43), repeat('a', 64), 'sandbox')),
  2500, 'amount comes from the proposal'
);
insert into p9 select 'a1_other', payment_id::text from public.payment_begin_checkout(repeat('P', 43), repeat('b', 64), 'sandbox');
select isnt((select v from p9 where k = 'a1_other'), (select v from p9 where k = 'a1'), 'another browser gets its own attempt');

select is_empty($$ select * from public.payment_begin_checkout(repeat('Z', 43), repeat('a', 64), 'sandbox') $$, 'unknown link: no checkout');
select is_empty($$ select * from public.payment_begin_checkout('short', repeat('a', 64), 'sandbox') $$, 'malformed link: no checkout');
select throws_ok(
  $$ select * from public.payment_begin_checkout(repeat('P', 43), 'not-a-hash', 'sandbox') $$,
  '22023', null, 'a checkout needs a browser session hash'
);
select throws_ok(
  $$ select * from public.payment_begin_checkout(repeat('P', 43), repeat('a', 64), 'production') $$,
  '22023', null, 'environment must be sandbox or live'
);
select throws_ok(
  $$ select * from public.payment_begin_checkout(repeat('R', 43), repeat('a', 64), 'sandbox') $$,
  'PT423', null, 'a proposal whose file is missing cannot be bought'
);

reset role;
select is(
  (select owner_id::text || '|' || client_id::text || '|' || revision_id::text || '|' || title_snapshot || '|' || owner_name_snapshot
   from public.payments where id = (select v from p9 where k = 'a1')::uuid),
  '19111111-1111-4111-8111-111111111111|c9000000-0000-4000-8000-00000000000a|e9000000-0000-4000-8000-000000000001|Proposal A1|P9 Lead A',
  'owner, client, revision and snapshots come from the proposal'
);
select throws_ok(
  format($$ update public.payments set amount_minor = 1 where id = %L $$, (select v from p9 where k = 'a1')),
  'PT423', null, 'the checkout amount is immutable'
);
select throws_ok(
  format($$ update public.payments set original_storage_path = null where id = %L $$, (select v from p9 where k = 'a1')),
  'PT423', null, 'the purchased revision is immutable'
);
select throws_ok(
  format($$ insert into public.payments (proposal_id, provider, amount_minor, currency, status, public_ref, environment,
    revision_id, original_storage_path, total_pages, free_preview_pages, title_snapshot, client_name_snapshot,
    owner_name_snapshot, checkout_session_hash)
    values ('d9000000-0000-4000-8000-0000000000a1', 'paypal', 2500, 'USD', 'created', 'AAAAAAAAAAAAAAAAAAAAAA', 'sandbox',
    'e9000000-0000-4000-8000-000000000003',
    '19222222-2222-4222-8222-222222222222/d9000000-0000-4000-8000-0000000000b1/e9000000-0000-4000-8000-000000000003/original.pdf',
    4, 1, 'x', 'x', 'x', %L) $$, repeat('c', 64)),
  '23514', null, 'a payment cannot point at another proposal''s file'
);

-- 3. Orders and the per-browser view ----------------------------------------------
set local role service_role;
select lives_ok(
  format($$ select public.payment_record_order(%L, 'ORDER-A1', 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-A1') $$, (select v from p9 where k = 'a1')),
  'order is recorded'
);
select lives_ok(
  format($$ select public.payment_record_order(%L, 'ORDER-A1', null) $$, (select v from p9 where k = 'a1')),
  'recording the same order again is idempotent'
);
select throws_ok(
  format($$ select public.payment_record_order(%L, 'ORDER-OTHER', null) $$, (select v from p9 where k = 'a1')),
  'PT409', null, 'a payment cannot be re-pointed at another order'
);
select is(
  (select bound from public.payment_session_view((select v from p9 where k = 'a1_ref'), repeat('a', 64))),
  true, 'the initiating browser sees its purchase'
);
select is_empty(
  format($$ select * from public.payment_session_view(%L, %L) $$, (select v from p9 where k = 'a1_ref'), repeat('b', 64)),
  'another browser (forwarded purchase URL) sees nothing'
);
select throws_ok(
  format($$ select public.payment_mark_cancelled(%L, %L) $$, (select v from p9 where k = 'a1'), repeat('b', 64)),
  'PT404', null, 'another browser cannot cancel the attempt'
);

-- 4. Verified state machine -----------------------------------------------------------
select throws_ok(
  format($$ select * from public.payment_apply_state(%L, 'succeeded', 'ORDER-WRONG', 'CAP-A1', 2500, 'USD', 'MERCHANT1', null, null, now(), null) $$,
    (select v from p9 where k = 'a1')),
  'PT409', null, 'a state for a different order is refused'
);

select is(
  (select status::text || '|' || coalesce(entitlement_id::text, 'none') from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', 'CAP-A1', 2400, 'USD', 'MERCHANT1', null, null, now(), null)),
  'created|none', 'a wrong amount grants nothing'
);
select is(
  (select needs_review from public.payment_session_view((select v from p9 where k = 'a1_ref'), repeat('a', 64))),
  true, 'a wrong amount is flagged for review'
);
select is(
  (select status::text || '|' || coalesce(entitlement_id::text, 'none') from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', 'CAP-A1', 2500, 'EUR', 'MERCHANT1', null, null, now(), null)),
  'created|none', 'a wrong currency grants nothing'
);
select is(
  (select status::text || '|' || coalesce(entitlement_id::text, 'none') from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', 'CAP-A1', 2500, 'USD', null, null, null, now(), null)),
  'created|none', 'an unconfirmed payee grants nothing'
);
select is(
  (select status::text || '|' || coalesce(entitlement_id::text, 'none') from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', null, 2500, 'USD', 'MERCHANT1', null, null, now(), null)),
  'created|none', 'a verified state without a capture grants nothing'
);
select is(
  (select status::text || '|' || coalesce(entitlement_id::text, 'none') from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'pending', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'MERCHANT1', 'buyer@paypal.test', 'PENDING_REVIEW', null, null)),
  'pending|none', 'a pending capture grants nothing'
);
select is(
  (select coalesce(entitlement_status, 'none') from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'MERCHANT1', 'buyer@paypal.test', null, now(), null)),
  'active', 'a verified capture creates an active entitlement'
);
select is(
  (select status::text || '|' || changed::text from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'MERCHANT1', null, null, now(), null)),
  'succeeded|false', 'a duplicate completion changes nothing'
);
select is(
  (select status::text from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'pending', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'MERCHANT1', null, null, null, null)),
  'succeeded', 'a late (out-of-order) pending never undoes a verified payment'
);
select is(
  (select status::text from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'failed', 'ORDER-A1', null, null, null, null, null, null, null, null)),
  'succeeded', 'a late failure never undoes a verified payment'
);
select is(
  (select status::text from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'cancelled', 'ORDER-A1', null, null, null, null, null, null, null, null)),
  'succeeded', 'a paid attempt cannot be cancelled'
);
select is(
  (select changed from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', 'CAP-DIFFERENT', 2500, 'USD', 'MERCHANT1', null, null, now(), null)),
  false, 'a different capture id for the same order changes nothing'
);
select is(
  (select review_reason from public.payments where id = (select v from p9 where k = 'a1')::uuid),
  'PayPal reported a different capture for this order', 'a different capture id for the same order is flagged'
);
select is(
  (select count(*)::integer from public.payment_entitlements where payment_id = (select v from p9 where k = 'a1')::uuid),
  1, 'exactly one entitlement per payment'
);

-- 5. Browser access -------------------------------------------------------------------
select is(
  public.payment_grant_session_access((select v from p9 where k = 'a1')::uuid, repeat('b', 64), 180),
  null, 'access is never granted to a browser that did not start the checkout'
);
select isnt(
  public.payment_grant_session_access((select v from p9 where k = 'a1')::uuid, repeat('a', 64), 180),
  null, 'the initiating browser gets access'
);
select is(
  (select has_access from public.payment_session_view((select v from p9 where k = 'a1_ref'), repeat('a', 64))),
  true, 'the purchase shows as accessible to that browser'
);
select is(
  (select original_storage_path from public.payment_document_for_session((select v from p9 where k = 'a1_ref'), repeat('a', 64))),
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf',
  'the document resolves to the purchased revision'
);
select is_empty(
  format($$ select * from public.payment_document_for_session(%L, %L) $$, (select v from p9 where k = 'a1_ref'), repeat('b', 64)),
  'another browser cannot open the document'
);
select is(
  (select current_revision from public.payment_access_for_link(repeat('P', 43), repeat('a', 64))),
  true, 'the client link shows the purchase to the paying browser'
);
select is_empty(
  format($$ select * from public.payment_access_for_link(%L, %L) $$, repeat('P', 43), repeat('b', 64)),
  'the forwarded client link shows no purchase'
);
select is_empty(
  format($$ select * from public.payment_access_for_link(%L, %L) $$, repeat('Q', 43), repeat('a', 64)),
  'a purchase never unlocks another proposal'
);

-- Paid access survives link rotation (keyed by entitlement, not token).
-- (The app rotates through a trusted function; the lock trigger is skipped
-- here so the test only changes the hash.)
reset role;
set local session_replication_role = replica;
update public.proposals set link_token_hash = encode(extensions.digest(repeat('S', 43), 'sha256'), 'hex')
where id = 'd9000000-0000-4000-8000-0000000000a1';
set local session_replication_role = origin;
set local role service_role;
select is(
  (select total_pages from public.payment_document_for_session((select v from p9 where k = 'a1_ref'), repeat('a', 64))),
  6, 'paid access does not depend on the client link'
);
select is_empty(
  format($$ select * from public.payment_access_for_link(%L, %L) $$, repeat('P', 43), repeat('a', 64)),
  'the old link no longer resolves after rotation'
);
select is(
  (select count(*)::integer from public.payment_access_for_link(repeat('S', 43), repeat('a', 64))),
  1, 'the rotated link still shows the purchase to the paying browser'
);

-- 6. Recovery tokens ---------------------------------------------------------------------
select throws_ok(
  format($$ select public.payment_recovery_issue('19222222-2222-4222-8222-222222222222', %L, %L, 60) $$,
    (select v from p9 where k = 'a1'), repeat('1', 64)),
  'PT404', null, 'another Team Lead cannot issue an access link'
);
select isnt(
  public.payment_recovery_issue('19111111-1111-4111-8111-111111111111', (select v from p9 where k = 'a1')::uuid, repeat('1', 64), 60),
  null, 'the owner can issue an access link'
);
select isnt(
  public.payment_recovery_issue('19333333-3333-4333-8333-333333333333', (select v from p9 where k = 'a1')::uuid, repeat('2', 64), 60),
  null, 'an admin can issue an access link'
);
select is((select title from public.payment_recovery_peek(repeat('1', 64))), 'Proposal A1', 'peek shows the title without using the token');
select is((select count(*)::integer from public.payment_recovery_peek(repeat('1', 64))), 1, 'peek does not consume the token');
select is(
  public.payment_recovery_consume(repeat('1', 64), repeat('d', 64), 180),
  (select v from p9 where k = 'a1_ref'), 'redeeming gives this browser the purchase'
);
select is(public.payment_recovery_consume(repeat('1', 64), repeat('e', 64), 180), null, 'a token works once');
select is(
  (select total_pages from public.payment_document_for_session((select v from p9 where k = 'a1_ref'), repeat('d', 64))),
  6, 'the recovered browser can open the document'
);
select is(public.payment_recovery_consume(repeat('9', 64), repeat('e', 64), 180), null, 'an unknown token does nothing');

reset role;
update public.payment_recovery_tokens set expires_at = now() - interval '1 minute' where token_hash = repeat('2', 64);
set local role service_role;
select is(public.payment_recovery_consume(repeat('2', 64), repeat('e', 64), 180), null, 'an expired token does nothing');
select is_empty($$ select * from public.payment_recovery_peek(repeat('2', 64)) $$, 'an expired token is not shown');

select is_empty(
  format($$ select * from public.payment_recovery_request(%L, 'stranger@test.local', %L, 30) $$, repeat('S', 43), repeat('3', 64)),
  'an unrelated email gets no token'
);
select is(
  (select title from public.payment_recovery_request(repeat('S', 43), 'BUYER@paypal.test', repeat('4', 64), 30)),
  'Proposal A1', 'the payer email gets a token (sent to that address)'
);
select is(
  (select title from public.payment_recovery_request(repeat('S', 43), 'client-a@client.test', repeat('5', 64), 30)),
  'Proposal A1', 'the portal client email gets a token'
);
select is(
  (select title from public.payment_recovery_request(repeat('S', 43), 'client-a@client.test', repeat('6', 64), 30)),
  'Proposal A1', 'a third open token is allowed'
);
select is_empty(
  format($$ select * from public.payment_recovery_request(%L, 'client-a@client.test', %L, 30) $$, repeat('S', 43), repeat('7', 64)),
  'at most three open tokens per purchase'
);
select is_empty(
  format($$ select * from public.payment_recovery_request(%L, 'client-b@client.test', %L, 30) $$, repeat('S', 43), repeat('8', 64)),
  'another proposal''s client email gets no token'
);

-- 7. Refunds and reversals ------------------------------------------------------------------
select is(
  public.payment_record_refund((select v from p9 where k = 'a1')::uuid, 'REFUND-1', 500, 'USD', 'COMPLETED'),
  500, 'a completed partial refund is recorded'
);
select is(
  public.payment_record_refund((select v from p9 where k = 'a1')::uuid, 'REFUND-1', 500, 'USD', 'COMPLETED'),
  500, 'the same refund is recorded once'
);
select throws_ok(
  format($$ select public.payment_record_refund(%L, 'REFUND-2', 100, 'EUR', 'COMPLETED') $$, (select v from p9 where k = 'a1')),
  '22023', null, 'a refund in another currency is refused'
);
select is(
  (select entitlement_status from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'partially_refunded', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'MERCHANT1', null, null, null, null)),
  'active', 'policy: a partial refund keeps access'
);
-- The file going missing must not block a refund from ending access.
reset role;
set local session_replication_role = replica;
delete from storage.objects where name = '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf';
set local session_replication_role = origin;
set local role service_role;
select is(
  (select entitlement_status from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'refunded', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'MERCHANT1', null, null, null, null)),
  'suspended', 'a full refund suspends access'
);
select is_empty(
  format($$ select * from public.payment_document_for_session(%L, %L) $$, (select v from p9 where k = 'a1_ref'), repeat('a', 64)),
  'a refunded purchase can no longer be opened'
);
reset role;
insert into storage.objects (bucket_id, name, metadata) values ('proposals',
  '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf',
  jsonb_build_object('size', 100));
set local role service_role;
select is(
  (select has_access from public.payment_session_view((select v from p9 where k = 'a1_ref'), repeat('a', 64))),
  false, 'the purchase page shows no access after a refund'
);
select is(
  (select status::text || '|' || entitlement_status from public.payment_apply_state(
    (select v from p9 where k = 'a1')::uuid, 'succeeded', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'MERCHANT1', null, null, now(), null)),
  'refunded|suspended', 'a late completion does not restore a refunded purchase'
);
select is_empty($$ select * from public.payment_recovery_peek(repeat('4', 64)) $$, 'open recovery tokens stop working after a refund');
select throws_ok(
  format($$ select public.payment_recovery_issue('19111111-1111-4111-8111-111111111111', %L, %L, 60) $$,
    (select v from p9 where k = 'a1'), repeat('0', 64)),
  'PT423', null, 'no access links for a refunded purchase'
);

-- Reversal on a second purchase (another browser of the same proposal).
select lives_ok(
  format($$ select public.payment_record_order(%L, 'ORDER-A1B', null) $$, (select v from p9 where k = 'a1_other')),
  'second order is recorded'
);
select is(
  (select entitlement_status from public.payment_apply_state(
    (select v from p9 where k = 'a1_other')::uuid, 'succeeded', 'ORDER-A1B', 'CAP-A1B', 2500, 'USD', 'MERCHANT1', null, null, now(), null)),
  'active', 'second purchase is verified'
);
select is(
  (select entitlement_status from public.payment_apply_state(
    (select v from p9 where k = 'a1_other')::uuid, 'reversed', 'ORDER-A1B', 'CAP-A1B', 2500, 'USD', 'MERCHANT1', null, 'REVERSED', null, null)),
  'suspended', 'a reversal suspends access'
);

-- 8. Cancellation and a late capture ---------------------------------------------------------
insert into p9 select 'b1', payment_id::text from public.payment_begin_checkout(repeat('Q', 43), repeat('f', 64), 'sandbox');
select lives_ok(
  format($$ select public.payment_record_order(%L, 'ORDER-B1', null) $$, (select v from p9 where k = 'b1')),
  'B1 order is recorded'
);
select is(
  public.payment_mark_cancelled((select v from p9 where k = 'b1')::uuid, repeat('f', 64)),
  'cancelled'::public.payment_status, 'the buyer cancels the attempt'
);
select is(
  (select status::text from public.payment_apply_state(
    (select v from p9 where k = 'b1')::uuid, 'succeeded', 'ORDER-B1', 'CAP-B1', 900, 'EUR', 'MERCHANT1', null, null, now(), null)),
  'succeeded', 'a verified capture still wins over an earlier cancel (money was taken)'
);

-- 9. Webhook events --------------------------------------------------------------------------
insert into p9 select 'ev', id::text from public.payment_event_begin('paypal', 'WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'capture', 'CAP-A1');
select is(
  (select id::text || '|' || result from public.payment_event_begin('paypal', 'WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'capture', 'CAP-A1')),
  (select v from p9 where k = 'ev') || '|received', 'an unfinished event is processed again on retry'
);
select lives_ok(
  format($$ select public.payment_event_finish(%L, 'applied', null, null) $$, (select v from p9 where k = 'ev')),
  'event is finished'
);
select is(
  (select result from public.payment_event_begin('paypal', 'WH-1', 'PAYMENT.CAPTURE.COMPLETED', 'capture', 'CAP-A1')),
  'applied', 'a duplicate delivery is recognised'
);
select is(
  (select count(*)::integer from public.payment_events where provider_event_id = 'WH-1'),
  1, 'one row per event id'
);
reset role;

-- 10. Purchased files are retained -------------------------------------------------------------
-- The document is replaced by a new revision (trigger skipped as above).
set local session_replication_role = replica;
update public.proposals
set original_storage_path = '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000009/original.pdf',
    preview_storage_path = '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000009/preview.pdf'
where id = 'd9000000-0000-4000-8000-0000000000a1';
set local session_replication_role = origin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"19111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select ok(
  not private.can_delete_proposal_object('19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf'),
  'a replaced document that was bought is not deletable'
);
select ok(
  private.can_delete_proposal_object('19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/preview.pdf'),
  'the old preview of that revision is still deletable'
);
reset role;
select is(
  (select classification from public.storage_cleanup_scan(now() + interval '1 day', '19111111-1111-4111-8111-111111111111/', '', 1000) s
   where s.name = '19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf'),
  'referenced', 'storage cleanup treats a purchased file as referenced'
);
select is_empty(
  $$ select * from public.storage_cleanup_recheck(
       array['19111111-1111-4111-8111-111111111111/d9000000-0000-4000-8000-0000000000a1/e9000000-0000-4000-8000-000000000001/original.pdf'],
       now() + interval '1 day') $$,
  'storage cleanup recheck never deletes a purchased file'
);
select throws_ok(
  $$ delete from public.proposals where id = 'd9000000-0000-4000-8000-0000000000a1' $$,
  '23503', null, 'a proposal with payments cannot be hard-deleted'
);

-- 11. Dashboard visibility (RLS) -------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"19111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is(
  (select count(*)::integer from public.payment_list where owner_id = '19111111-1111-4111-8111-111111111111'), 2,
  'lead A sees their payments'
);
select is((select count(*)::integer from public.payment_list where owner_id <> '19111111-1111-4111-8111-111111111111'), 0, 'lead A sees no one else''s payments');
select is((select count(*)::integer from public.payment_totals where owner_id <> '19111111-1111-4111-8111-111111111111'), 0, 'lead A totals exclude others');
select throws_ok(
  $$ select checkout_session_hash from public.payments limit 1 $$,
  '42501', null, 'a lead cannot read session hashes'
);
select throws_ok(
  $$ select * from public.payment_entitlements $$,
  '42501', null, 'a lead cannot read entitlements directly'
);
select throws_ok(
  format($$ select public.payment_apply_state(%L, 'succeeded', 'ORDER-A1', 'CAP-A1', 2500, 'USD', 'M', null, null, now(), null) $$,
    (select v from p9 where k = 'a1')),
  '42501', null, 'a signed-in user cannot mark a payment successful'
);
select throws_ok(
  format($$ update public.payments set status = 'succeeded' where id = %L $$, (select v from p9 where k = 'a1')),
  '42501', null, 'a signed-in user cannot update payment status'
);

select set_config('request.jwt.claims', '{"sub":"19222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select is((select count(*)::integer from public.payment_list where owner_id = '19222222-2222-4222-8222-222222222222'), 1, 'lead B sees their payment');
select is((select count(*)::integer from public.payment_list where owner_id = '19111111-1111-4111-8111-111111111111'), 0, 'lead B sees none of lead A''s payments');

select set_config('request.jwt.claims', '{"sub":"19333333-3333-4333-8333-333333333333","role":"authenticated"}', true);
select is(
  (select count(*)::integer from public.payment_list where owner_id in ('19111111-1111-4111-8111-111111111111', '19222222-2222-4222-8222-222222222222')),
  3, 'the admin sees every Team Lead''s payments'
);
select is(
  (select owner_name from public.payment_list where provider_order_id = 'ORDER-B1'),
  'P9 Lead B', 'the admin sees the owning Team Lead'
);
select is(
  (select string_agg(currency || ':' || status::text, ',' order by currency, status::text) from public.payment_totals
   where owner_id in ('19111111-1111-4111-8111-111111111111', '19222222-2222-4222-8222-222222222222')),
  'EUR:succeeded,USD:refunded,USD:reversed', 'totals are grouped by currency and status'
);

set local role anon;
select throws_ok($$ select * from public.payment_list $$, '42501', null, 'anon cannot read the payments list');
reset role;

select * from finish();
rollback;
