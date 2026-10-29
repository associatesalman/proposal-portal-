-- Payments follow-up: a refund or reversal always ends access.
--
-- payment_apply_state applied the "verified purchase" checks (exact amount,
-- confirmed payee, purchased file still in storage) to refunded/reversed
-- too, so a refund of a purchase whose file had gone missing was flagged
-- for review instead of suspending access. Refunded/reversed now need only
-- the order reference and the payment's known capture; an entitlement is
-- created only by succeeded/partially_refunded (never by a refund arriving
-- for an attempt that was never verified). Grants are unchanged (CREATE OR
-- REPLACE keeps them).

create or replace function public.payment_apply_state(
  p_payment_id uuid,
  p_status public.payment_status,
  p_order_id text,
  p_capture_id text,
  p_amount_minor integer,
  p_currency text,
  p_merchant_id text,
  p_payer_email text,
  p_status_detail text,
  p_captured_at timestamptz,
  p_review_reason text
)
returns table (status public.payment_status, entitlement_id uuid, entitlement_status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  ent public.payment_entitlements;
  reason text := p_review_reason;
  old_rank integer;
  new_rank integer;
  allowed boolean;
begin
  select * into pay from public.payments where id = p_payment_id for update;
  if not found or pay.provider <> 'paypal' then
    raise exception 'payment not found' using errcode = 'PT404';
  end if;
  if pay.provider_order_id is null or p_order_id is distinct from pay.provider_order_id then
    raise exception 'order reference does not match this payment' using errcode = 'PT409';
  end if;

  if reason is null and p_capture_id is not null and pay.provider_payment_id is not null
     and p_capture_id <> pay.provider_payment_id then
    reason := 'PayPal reported a different capture for this order';
  end if;

  -- Refunded / reversed only ever END access: they need the known capture,
  -- but not the amount, payee or file checks (a missing file must not keep
  -- a refunded purchase open).
  if reason is null and p_status in ('refunded', 'reversed') then
    if p_capture_id is null or pay.provider_payment_id is null then
      reason := 'refund or reversal for a payment without a verified capture';
    end if;
  elsif reason is null and private.payment_status_rank(p_status) >= 3 then
    if p_capture_id is null then
      reason := 'verified state without a capture reference';
    elsif p_amount_minor is distinct from pay.amount_minor or p_currency is distinct from pay.currency::text then
      reason := 'captured amount or currency differs from the checkout';
    elsif p_merchant_id is null then
      reason := 'payee merchant not confirmed';
    elsif not exists (
      select 1 from storage.objects o where o.bucket_id = 'proposals' and o.name = pay.original_storage_path
    ) then
      reason := 'purchased document file is missing';
    end if;
  end if;

  if reason is not null then
    update public.payments
    set needs_review = true, review_reason = left(reason, 200), last_synced_at = now()
    where id = pay.id;
    select e.* into ent from public.payment_entitlements e where e.payment_id = pay.id;
    return query select pay.status, ent.id, ent.status, false;
    return;
  end if;

  old_rank := private.payment_status_rank(pay.status);
  new_rank := private.payment_status_rank(p_status);
  allowed := case
    when p_status = 'created' then false
    -- Only an attempt nobody paid can be cancelled.
    when p_status = 'cancelled' then pay.status = 'created'
    when p_status = pay.status then true
    when old_rank >= 3 then new_rank > old_rank
    else true
  end;

  if allowed then
    update public.payments
    set status = p_status,
        provider_payment_id = coalesce(pay.provider_payment_id, p_capture_id),
        status_detail = left(p_status_detail, 100),
        payer_email = coalesce(left(p_payer_email, 320), pay.payer_email),
        merchant_id = coalesce(left(p_merchant_id, 64), pay.merchant_id),
        captured_at = coalesce(pay.captured_at, p_captured_at),
        verified_at = case when new_rank >= 3 then coalesce(pay.verified_at, now()) else pay.verified_at end,
        last_synced_at = now()
    where id = pay.id;
  else
    update public.payments set last_synced_at = now() where id = pay.id;
  end if;

  if allowed and new_rank between 3 and 4 then
    insert into public.payment_entitlements (payment_id, proposal_id, owner_id, original_storage_path, total_pages)
    values (pay.id, pay.proposal_id, pay.owner_id, pay.original_storage_path, pay.total_pages)
    on conflict (payment_id) do nothing;

    -- The same browser already holds a verified purchase of this proposal:
    -- keep both (money was taken) but flag for a refund decision.
    if old_rank < 3 and exists (
      select 1 from public.payments other
      where other.proposal_id = pay.proposal_id
        and other.id <> pay.id
        and other.checkout_session_hash = pay.checkout_session_hash
        and private.payment_status_rank(other.status) between 3 and 4
    ) then
      update public.payments
      set needs_review = true, review_reason = 'possible duplicate payment by the same browser'
      where id = pay.id;
    end if;
  end if;

  if allowed and p_status in ('refunded', 'reversed') then
    update public.payment_entitlements e
    set status = 'suspended', suspended_at = coalesce(e.suspended_at, now()), suspended_reason = p_status::text
    where e.payment_id = pay.id;
  end if;

  select e.* into ent from public.payment_entitlements e where e.payment_id = pay.id;
  return query select (select x.status from public.payments x where x.id = pay.id), ent.id, ent.status, allowed and p_status <> pay.status;
end;
$$;
