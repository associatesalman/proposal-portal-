-- Removes manual Full Access. Every link is a preview link again; the whole
-- document is only ever delivered to a browser with a verified PayPal
-- purchase (payments, payment_entitlements, payment_access_sessions), which
-- this migration does not touch.
--
-- Forward-only and data-preserving:
--   - open grants are ended (ended_by = the granter, since no user acts
--     here); the grant rows, notes and names stay as the audit trail;
--   - active Full Access links are revoked exactly like proposal_revoke_link
--     (draft, token cleared: the old token never works again);
--   - every proposal returns to preview mode; documents, sources and
--     storage objects are kept, so a lead can save an offer and send a new
--     preview link without re-uploading;
--   - the Full Access functions are dropped and access_mode is pinned to
--     'preview'. The column and the grant table remain for compatibility.

update public.proposal_full_access_grants
set ended_at = now(), ended_by = granted_by
where ended_at is null;

update public.proposals
set status = 'draft',
    link_token_hash = null,
    link_created_at = null,
    access_mode = 'preview'
where access_mode = 'full' and status = 'active';

update public.proposals
set access_mode = 'preview'
where access_mode = 'full';

alter table public.proposals drop constraint proposals_access_mode_valid;
alter table public.proposals
  add constraint proposals_access_mode_valid check (access_mode = 'preview');

drop function public.proposal_issue_full_link(uuid, uuid, text, text, text);
drop function public.proposal_set_access_mode(uuid, uuid, text);
drop function public.resolve_proposal_full_access(text);
drop function public.resolve_proposal_full_object(text);

-- Grants are read-only history now.
revoke insert, update, delete on public.proposal_full_access_grants from authenticated, anon;
