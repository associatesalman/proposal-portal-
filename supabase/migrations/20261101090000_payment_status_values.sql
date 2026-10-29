-- Payments (PayPal): extra payment states.
--
-- Separate migration because a value added with ALTER TYPE ... ADD VALUE
-- can't be used in the same transaction that adds it; the next migration
-- uses these values.
--
--   denied             PayPal declined/denied the capture (no money taken)
--   partially_refunded part of a verified payment was refunded (access kept)
--   reversed           a verified payment was reversed (e.g. chargeback)
--
-- Forward-only; no rows change.

alter type public.payment_status add value if not exists 'denied';
alter type public.payment_status add value if not exists 'partially_refunded';
alter type public.payment_status add value if not exists 'reversed';
