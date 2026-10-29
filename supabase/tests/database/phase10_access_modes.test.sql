-- Full Access links, manual grants and multi-format sources (pgTAP).
-- Covers: browser roles can't set modes or touch grants; the 15/12/3 manual
-- workflow (preview link -> revoke -> Full Access on the same stored
-- document -> new link; the old token stays invalid); preview and full
-- tokens resolve only their own objects; no payment is created for a Full
-- Access link; one-page documents; source files in storage policies,
-- deletion protection and cleanup; grants end on revoke and deletion; the
-- dashboard view; cross-lead denial and CEO access.
-- Runs in one transaction that is rolled back; all data is disposable.

begin;

create extension if not exists pgtap with schema extensions;

select * from no_plan();

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('1a111111-1111-4111-8111-111111111111', 'p10-lead-a@test.local', 'authenticated', 'authenticated'),
  ('1a222222-2222-4222-8222-222222222222', 'p10-lead-b@test.local', 'authenticated', 'authenticated'),
  ('1a333333-3333-4333-8333-333333333333', 'p10-admin@test.local', 'authenticated', 'authenticated');

insert into public.profiles (id, full_name, role) values
  ('1a111111-1111-4111-8111-111111111111', 'P10 Lead A', 'team_lead'),
  ('1a222222-2222-4222-8222-222222222222', 'P10 Lead B', 'team_lead'),
  ('1a333333-3333-4333-8333-333333333333', 'P10 Admin', 'admin');

insert into public.clients (id, owner_id, name, email) values
  ('ca000000-0000-4000-8000-00000000000a', '1a111111-1111-4111-8111-111111111111', 'Client A', 'client-a@client.test');

-- F: lead A, draft, a 15-page document with a 12-page preview and a price.
-- G: lead A, empty draft (one-page and source-file checks).
insert into public.proposals (
  id, client_id, owner_id, title, status,
  original_storage_path, total_pages, preview_storage_path, free_preview_pages,
  unlock_price_minor, currency
) values (
  'da000000-0000-4000-8000-0000000000f1', 'ca000000-0000-4000-8000-00000000000a',
  '1a111111-1111-4111-8111-111111111111', 'Fifteen pages', 'draft',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf', 15,
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf', 12,
  5000, 'USD'
), (
  'da000000-0000-4000-8000-0000000000f2', 'ca000000-0000-4000-8000-00000000000a',
  '1a111111-1111-4111-8111-111111111111', 'Proposal G', 'draft',
  null, null, null, null, null, null
);

insert into storage.objects (bucket_id, name, metadata)
select 'proposals', n, jsonb_build_object('size', 100)
from unnest(array[
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/original.pdf',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/source.odt',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000004/original.pdf'
]) as n;

-- 1. Browser roles ------------------------------------------------------------------
select ok(
  (select access_mode from public.proposals where id = 'da000000-0000-4000-8000-0000000000f1') = 'preview',
  'proposals default to Preview mode (existing rows keep their behaviour)'
);
select ok(not has_column_privilege('authenticated', 'public.proposals', 'access_mode', 'UPDATE'), 'authenticated may not set the access mode directly');
select ok(not has_column_privilege('authenticated', 'public.proposals', 'source_storage_path', 'UPDATE'), 'authenticated may not set a source path');
select ok(has_column_privilege('authenticated', 'public.proposals', 'access_mode', 'SELECT'), 'authenticated may read the access mode (RLS-limited)');
select ok(not has_table_privilege('authenticated', 'public.proposal_full_access_grants', 'INSERT'), 'authenticated may not create grants');
select ok(not has_table_privilege('authenticated', 'public.proposal_full_access_grants', 'UPDATE'), 'authenticated may not change grants');
select ok(not has_table_privilege('authenticated', 'public.proposal_full_access_grants', 'DELETE'), 'authenticated may not delete grants');
select ok(not has_table_privilege('anon', 'public.proposal_full_access_grants', 'SELECT'), 'anon may not read grants');
select ok(not has_function_privilege('authenticated', 'public.proposal_set_access_mode(uuid, uuid, text)', 'EXECUTE'), 'authenticated may not call proposal_set_access_mode');
select ok(not has_function_privilege('anon', 'public.proposal_issue_full_link(uuid, uuid, text, text, text)', 'EXECUTE'), 'anon may not issue Full Access links');
select ok(not has_function_privilege('authenticated', 'public.proposal_issue_full_link(uuid, uuid, text, text, text)', 'EXECUTE'), 'authenticated may not issue Full Access links');
select ok(not has_function_privilege('authenticated', 'public.proposal_attach_document(uuid, uuid, text, text, text, text, bigint, text, bigint, integer)', 'EXECUTE'), 'authenticated may not record documents');
select ok(not has_function_privilege('anon', 'public.resolve_proposal_full_object(text)', 'EXECUTE'), 'anon may not resolve storage paths of Full Access links');
select ok(has_function_privilege('anon', 'public.resolve_proposal_full_access(text)', 'EXECUTE'), 'anon may resolve the display fields of a Full Access link');
select ok(
  (select allowed_mime_types @> array['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']
   from storage.buckets where id = 'proposals'),
  'the private bucket accepts the supported source types'
);
select ok((select not public from storage.buckets where id = 'proposals'), 'the bucket stays private');

-- 2. The manual 15/12/3 workflow ------------------------------------------------------
set local role service_role;

select lives_ok(
  $$ select public.proposal_issue_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf',
       encode(extensions.digest(repeat('X', 43), 'sha256'), 'hex')) $$,
  'a preview link (12 free of 15) is issued'
);
select results_eq(
  $$ select total_pages, free_preview_pages from public.resolve_proposal_offer(repeat('X', 43)) $$,
  $$ values (15, 12) $$,
  'the preview token resolves to 12 free pages of 15'
);
select is_empty($$ select * from public.resolve_proposal_full_access(repeat('X', 43)) $$, 'a preview token is not a Full Access token');
select is_empty($$ select * from public.resolve_proposal_full_object(repeat('X', 43)) $$, 'a preview token resolves no complete document');

select throws_ok(
  $$ select public.proposal_set_access_mode('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1', 'full') $$,
  'PT423', null, 'the mode cannot change behind an active link'
);
reset role;
select throws_ok(
  $$ update public.proposals set access_mode = 'full' where id = 'da000000-0000-4000-8000-0000000000f1' $$,
  'PT423', null, 'the lock trigger also blocks a direct mode change while active'
);
set local role service_role;

select lives_ok(
  $$ select public.proposal_revoke_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1') $$,
  'the preview link is revoked'
);
select is_empty($$ select * from public.resolve_proposal_offer(repeat('X', 43)) $$, 'the revoked preview token no longer resolves');

select throws_ok(
  $$ select public.proposal_set_access_mode('1a222222-2222-4222-8222-222222222222', 'da000000-0000-4000-8000-0000000000f1', 'full') $$,
  'PT404', null, 'another Team Lead cannot change the mode'
);
select throws_ok(
  $$ select public.proposal_set_access_mode('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1', 'everything') $$,
  '22023', null, 'an unknown mode is refused'
);
select lives_ok(
  $$ select public.proposal_set_access_mode('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1', 'full') $$,
  'the owner selects Full Access for the same stored document'
);
select throws_ok(
  $$ select public.proposal_issue_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf',
       encode(extensions.digest(repeat('Z', 43), 'sha256'), 'hex')) $$,
  'PT409', null, 'a preview link cannot be issued in Full Access mode'
);
select throws_ok(
  $$ select public.proposal_issue_full_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-00000000000f/original.pdf',
       encode(extensions.digest(repeat('Y', 43), 'sha256'), 'hex'), null) $$,
  'PT409', null, 'a Full Access link is refused for a stale document revision'
);
select throws_ok(
  $$ select public.proposal_issue_full_link('1a222222-2222-4222-8222-222222222222', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
       encode(extensions.digest(repeat('Y', 43), 'sha256'), 'hex'), null) $$,
  'PT404', null, 'another Team Lead cannot grant Full Access'
);
select throws_ok(
  $$ select public.proposal_issue_full_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
       encode(extensions.digest(repeat('Y', 43), 'sha256'), 'hex'), repeat('n', 501)) $$,
  '22023', null, 'an internal note over 500 characters is refused'
);
-- The CEO grants it for lead A's proposal.
select lives_ok(
  $$ select public.proposal_issue_full_link('1a333333-3333-4333-8333-333333333333', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
       encode(extensions.digest(repeat('Y', 43), 'sha256'), 'hex'), '  Paid by bank transfer, INV-15  ') $$,
  'the CEO generates a new Full Access link (manual grant)'
);
select results_eq(
  $$ select granted_by, revision_id, document_path, total_pages, note, ended_at is null
     from public.proposal_full_access_grants where proposal_id = 'da000000-0000-4000-8000-0000000000f1' $$,
  $$ values ('1a333333-3333-4333-8333-333333333333'::uuid, 'ea000000-0000-4000-8000-000000000001'::uuid,
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
       15, 'Paid by bank transfer, INV-15', true) $$,
  'the grant records who, when, which revision, the page count and the trimmed note'
);
select results_eq(
  $$ select title, total_pages, source_format from public.resolve_proposal_full_access(repeat('Y', 43)) $$,
  $$ values ('Fifteen pages'::text, 15, null::text) $$,
  'the new token resolves to all 15 pages (display fields only)'
);
select results_eq(
  $$ select original_path, source_path from public.resolve_proposal_full_object(repeat('Y', 43)) $$,
  $$ values ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf'::text, null::text) $$,
  'the Full Access token is bound to the canonical PDF of its revision'
);
select is_empty($$ select * from public.resolve_proposal_offer(repeat('Y', 43)) $$, 'a Full Access token is not a preview token');
select ok(public.resolve_proposal_preview_object(repeat('Y', 43)) is null, 'a Full Access token resolves no preview object');
select is_empty($$ select * from public.resolve_proposal_full_access(repeat('X', 43)) $$, 'the old preview token stays invalid');
select is_empty($$ select * from public.resolve_proposal_offer(repeat('X', 43)) $$, 'the old preview token stays invalid for previews too');

select is_empty(
  $$ select * from public.payment_begin_checkout(repeat('Y', 43), repeat('a', 64), 'sandbox') $$,
  'checkout is refused for a Full Access link'
);
select is(
  (select count(*)::int from public.payments where proposal_id = 'da000000-0000-4000-8000-0000000000f1'),
  0, 'no payment record is created or faked for a manual grant'
);

select throws_ok(
  $$ select * from public.proposal_attach_document('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000009/original.pdf',
       null, null, null, 'x.pdf', 10, 3) $$,
  'PT423', null, 'the document behind an active Full Access link cannot be replaced'
);

-- 3. Dashboard view and grant visibility ----------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"1a111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select results_eq(
  $$ select access_mode, full_access_granted_at is not null, full_access_granted_by_name
     from public.proposal_list where id = 'da000000-0000-4000-8000-0000000000f1' $$,
  $$ values ('full'::text, true, 'P10 Admin'::text) $$,
  'the owner sees Full Access and the open manual grant in the dashboard view'
);
select is((select count(*)::int from public.proposal_full_access_grants), 1, 'the owner can read their grant');
select set_config('request.jwt.claims', '{"sub":"1a222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.proposal_full_access_grants), 0, 'another Team Lead cannot read the grant');
select is((select count(*)::int from public.proposal_list where id = 'da000000-0000-4000-8000-0000000000f1'), 0, 'another Team Lead cannot see the proposal');
select set_config('request.jwt.claims', '{"sub":"1a333333-3333-4333-8333-333333333333","role":"authenticated"}', true);
select is((select count(*)::int from public.proposal_full_access_grants), 1, 'the CEO can read every grant');
reset role;

-- 4. Revocation ends the grant ------------------------------------------------------
set local role service_role;
select lives_ok(
  $$ select public.proposal_revoke_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1') $$,
  'the Full Access link is revoked'
);
select results_eq(
  $$ select ended_by, ended_at is not null from public.proposal_full_access_grants where proposal_id = 'da000000-0000-4000-8000-0000000000f1' $$,
  $$ values ('1a111111-1111-4111-8111-111111111111'::uuid, true) $$,
  'revoking ends the grant and records who ended it'
);
select is_empty($$ select * from public.resolve_proposal_full_access(repeat('Y', 43)) $$, 'the revoked Full Access token no longer resolves');
select is_empty($$ select * from public.resolve_proposal_full_object(repeat('Y', 43)) $$, 'the revoked Full Access token delivers nothing');

-- 5. One-page documents and source files -------------------------------------------------
select throws_ok(
  $$ select * from public.proposal_attach_document('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2', null,
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/source.docx',
       'docx', 2000, 'one.docx', 900, 1) $$,
  '23514', null, 'a source file must sit in the same revision folder as its PDF'
);
select throws_ok(
  $$ select * from public.proposal_attach_document('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2', null,
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx',
       'docm', 2000, 'one.docm', 900, 1) $$,
  '23514', null, 'formats outside the allowlist are refused'
);
select lives_ok(
  $$ select * from public.proposal_attach_document('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2', null,
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx',
       'docx', 2000, 'one.docx', 900, 1) $$,
  'a one-page DOCX revision (source + canonical PDF) is recorded'
);
select lives_ok(
  $$ select public.proposal_set_access_mode('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2', 'full') $$,
  'Full Access is selected for the one-page document'
);
select lives_ok(
  $$ select public.proposal_issue_full_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf',
       encode(extensions.digest(repeat('W', 43), 'sha256'), 'hex'), null) $$,
  'a one-page document gets a Full Access link without preview or price'
);
select results_eq(
  $$ select total_pages, source_format from public.resolve_proposal_full_access(repeat('W', 43)) $$,
  $$ values (1, 'docx'::text) $$,
  'the one-page Full Access link resolves with its source format'
);
select results_eq(
  $$ select source_path, source_format from public.resolve_proposal_full_object(repeat('W', 43)) $$,
  $$ values ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx'::text, 'docx'::text) $$,
  'the Full Access link may deliver its own revision''s original'
);
select lives_ok(
  $$ select public.proposal_revoke_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2') $$,
  'the one-page link is revoked'
);
-- Replace with revision 3 (ODT): revision 2's files become unreferenced.
select results_eq(
  $$ select previous_original_path, previous_source_path from public.proposal_attach_document(
       '1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/source.odt',
       'odt', 3000, 'three.odt', 1500, 3) $$,
  $$ values ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf'::text,
             '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx'::text) $$,
  'replacing a revision returns the superseded PDF and source for removal'
);
reset role;

-- A payment snapshot of revision 3 (any payment row protects its files).
insert into public.payments (proposal_id, provider, amount_minor, currency, status, public_ref, environment,
  revision_id, original_storage_path, total_pages, free_preview_pages, title_snapshot, client_name_snapshot,
  owner_name_snapshot, checkout_session_hash)
values ('da000000-0000-4000-8000-0000000000f2', 'paypal', 1000, 'USD', 'created', 'GGGGGGGGGGGGGGGGGGGGGG', 'sandbox',
  'ea000000-0000-4000-8000-000000000003',
  '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/original.pdf',
  3, 1, 'Proposal G', 'Client A', 'P10 Lead A', repeat('d', 64));

set local role service_role;
select lives_ok(
  $$ select * from public.proposal_attach_document('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f2',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000004/original.pdf',
       null, null, null, 'four.pdf', 1000, 4) $$,
  'a PDF upload replaces the converted revision and clears the source'
);
reset role;
select results_eq(
  $$ select source_storage_path, source_format, source_size_bytes from public.proposals where id = 'da000000-0000-4000-8000-0000000000f2' $$,
  $$ values (null::text, null::text, null::bigint) $$,
  'the PDF revision has no source file'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"1a111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select ok(
  private.proposal_id_for_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx') is not null,
  'storage policies recognise source files in revision folders'
);
select ok(
  private.proposal_id_for_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.exe') is null,
  'storage policies refuse other file names'
);
select ok(
  private.proposal_id_for_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/source.docx') is null,
  'source files are not accepted outside a revision folder'
);
select ok(
  private.can_upload_proposal_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000005/source.rtf'),
  'the owner may upload a source file into a new revision of a draft'
);
select ok(
  private.can_delete_proposal_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx'),
  'a superseded, unpurchased source file is deletable'
);
select ok(
  not private.can_delete_proposal_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/source.odt'),
  'a purchased revision''s source file is not deletable'
);
select ok(
  not private.can_delete_proposal_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/original.pdf'),
  'a purchased revision''s PDF is not deletable'
);
select set_config('request.jwt.claims', '{"sub":"1a222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select ok(
  not private.can_delete_proposal_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx'),
  'another Team Lead cannot delete the source file'
);
select ok(
  not private.can_upload_proposal_object('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000005/source.rtf'),
  'another Team Lead cannot upload into the proposal'
);
reset role;

select ok(private.is_proposal_object_name('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.txt'), 'cleanup recognises source files');
select ok(not private.is_proposal_object_name('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docm'), 'cleanup does not recognise other names');
select results_eq(
  $$ select s.name, s.classification from public.storage_cleanup_scan(now() + interval '1 day', '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/', '', 1000) s order by s.name $$,
  $$ values
     ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/original.pdf'::text, 'orphan'::text),
     ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx', 'orphan'),
     ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/original.pdf', 'referenced'),
     ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/source.odt', 'referenced'),
     ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000004/original.pdf', 'referenced') $$,
  'cleanup: superseded files are orphans; current and purchased files (PDF and source) are referenced'
);
select results_eq(
  $$ select * from public.storage_cleanup_recheck(array[
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000003/source.odt'],
       now() + interval '1 day') $$,
  $$ values ('1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f2/ea000000-0000-4000-8000-000000000002/source.docx'::text) $$,
  'cleanup recheck never deletes a purchased source file'
);

-- 6. Deletion ends an open grant ----------------------------------------------------
set local role service_role;
select lives_ok(
  $$ select public.proposal_issue_full_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
       encode(extensions.digest(repeat('V', 43), 'sha256'), 'hex'), null) $$,
  'a second Full Access link for F is issued'
);
select lives_ok(
  $$ select * from public.proposal_begin_deletion('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1') $$,
  'deletion starts'
);
select is(
  (select count(*)::int from public.proposal_full_access_grants where proposal_id = 'da000000-0000-4000-8000-0000000000f1' and ended_at is null),
  0, 'starting deletion ends the open grant'
);
select is_empty($$ select * from public.resolve_proposal_full_object(repeat('V', 43)) $$, 'a proposal being deleted delivers nothing');
select throws_ok(
  $$ select public.proposal_set_access_mode('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1', 'preview') $$,
  'PT410', null, 'a proposal being deleted cannot change mode'
);
reset role;

select * from finish();
rollback;
