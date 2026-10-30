-- Manual Full Access removed (20261103090000) and multi-format sources (pgTAP).
-- Covers: the Full Access functions are gone and access_mode is pinned to
-- 'preview'; grants are read-only history; preview links still issue,
-- revoke and re-issue on the same stored document (the old token stays
-- invalid); source files in storage policies, purchase protection and
-- cleanup; deletion still ends any open grant; cross-lead denial.
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

-- 1. Full Access is gone ----------------------------------------------------------
select ok(
  (select access_mode from public.proposals where id = 'da000000-0000-4000-8000-0000000000f1') = 'preview',
  'proposals are in Preview mode'
);
select is((select count(*)::int from public.proposals where access_mode <> 'preview'), 0, 'no proposal is in Full Access mode');
select hasnt_function('public', 'proposal_issue_full_link', 'proposal_issue_full_link is dropped');
select hasnt_function('public', 'proposal_set_access_mode', 'proposal_set_access_mode is dropped');
select hasnt_function('public', 'resolve_proposal_full_access', 'resolve_proposal_full_access is dropped');
select hasnt_function('public', 'resolve_proposal_full_object', 'resolve_proposal_full_object is dropped');
select throws_ok(
  $$ update public.proposals set access_mode = 'full' where id = 'da000000-0000-4000-8000-0000000000f1' $$,
  '23514', null, 'access_mode can no longer be set to full'
);
select is((select count(*)::int from public.proposal_full_access_grants where ended_at is null), 0, 'no grant is open');
select ok(not has_column_privilege('authenticated', 'public.proposals', 'access_mode', 'UPDATE'), 'authenticated may not set the access mode');
select ok(not has_column_privilege('authenticated', 'public.proposals', 'source_storage_path', 'UPDATE'), 'authenticated may not set a source path');
select ok(not has_table_privilege('authenticated', 'public.proposal_full_access_grants', 'INSERT'), 'authenticated may not create grants');
select ok(not has_table_privilege('authenticated', 'public.proposal_full_access_grants', 'UPDATE'), 'authenticated may not change grants');
select ok(not has_table_privilege('authenticated', 'public.proposal_full_access_grants', 'DELETE'), 'authenticated may not delete grants');
select ok(not has_table_privilege('anon', 'public.proposal_full_access_grants', 'SELECT'), 'anon may not read grants');
select ok(not has_function_privilege('authenticated', 'public.proposal_attach_document(uuid, uuid, text, text, text, text, bigint, text, bigint, integer)', 'EXECUTE'), 'authenticated may not record documents');
select ok(
  (select allowed_mime_types @> array['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']
   from storage.buckets where id = 'proposals'),
  'the private bucket accepts the supported source types'
);
select ok((select not public from storage.buckets where id = 'proposals'), 'the bucket stays private');

-- 2. Preview links: issue, revoke, re-issue on the same document ------------------------
set local role service_role;
select lives_ok(
  $$ select public.proposal_issue_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1', '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf',
       encode(extensions.digest(repeat('X', 43), 'sha256'), 'hex')) $$,
  'a preview link (12 free of 15) is issued'
);
select results_eq(
  $$ select total_pages, free_preview_pages from public.resolve_proposal_offer(repeat('X', 43)) $$,
  $$ values (15, 12) $$,
  'the preview token resolves to 12 free pages of 15'
);
select ok(public.resolve_proposal_preview_object(repeat('X', 43)) = '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf', 'the preview token resolves only the preview PDF');
select throws_ok(
  $$ select * from public.proposal_attach_document('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1', '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf',
       '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000009/original.pdf',
       null, null, null, 'x.pdf', 10, 3) $$,
  'PT423', null, 'the document behind an active link cannot be replaced'
);
select lives_ok($$ select public.proposal_revoke_link('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1') $$, 'the preview link is revoked');
select is_empty($$ select * from public.resolve_proposal_offer(repeat('X', 43)) $$, 'the revoked token no longer resolves');
select throws_ok(
  $$ select public.proposal_issue_link('1a222222-2222-4222-8222-222222222222', 'da000000-0000-4000-8000-0000000000f1', '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf',
       encode(extensions.digest(repeat('Y', 43), 'sha256'), 'hex')) $$,
  'PT404', null, 'another Team Lead cannot issue a link'
);
select lives_ok(
  $$ select public.proposal_issue_link('1a333333-3333-4333-8333-333333333333', 'da000000-0000-4000-8000-0000000000f1', '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/preview.pdf',
       encode(extensions.digest(repeat('Y', 43), 'sha256'), 'hex')) $$,
  'the CEO issues a new preview link without re-uploading'
);
select results_eq(
  $$ select total_pages, free_preview_pages from public.resolve_proposal_offer(repeat('Y', 43)) $$,
  $$ values (15, 12) $$,
  'the new link is a preview link (12 of 15), never the whole document'
);
select is_empty($$ select * from public.resolve_proposal_offer(repeat('X', 43)) $$, 'the old token stays invalid');

-- 3. Source files (multi-format uploads) ------------------------------------------------
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

-- 4. Deletion still ends an open grant (history rows from before the removal) ------------
insert into public.proposal_full_access_grants (proposal_id, owner_id, granted_by, granted_at, revision_id, document_path, total_pages)
values ('da000000-0000-4000-8000-0000000000f1', '1a111111-1111-4111-8111-111111111111', '1a111111-1111-4111-8111-111111111111', now(), 'ea000000-0000-4000-8000-000000000001', '1a111111-1111-4111-8111-111111111111/da000000-0000-4000-8000-0000000000f1/ea000000-0000-4000-8000-000000000001/original.pdf', 15);
set local role service_role;
select lives_ok(
  $$ select * from public.proposal_begin_deletion('1a111111-1111-4111-8111-111111111111', 'da000000-0000-4000-8000-0000000000f1') $$,
  'deletion starts'
);
select is(
  (select count(*)::int from public.proposal_full_access_grants where proposal_id = 'da000000-0000-4000-8000-0000000000f1' and ended_at is null),
  0, 'starting deletion ends an open grant'
);
select is_empty($$ select * from public.resolve_proposal_offer(repeat('Y', 43)) $$, 'a proposal being deleted has no working link');
reset role;

select * from finish();
rollback;
