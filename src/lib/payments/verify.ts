import type { PaymentStatus } from "@/types/database";

import { payPalValueToMinor } from "./money";

// Turns a PayPal order (GET /v2/checkout/orders/{id} or the capture
// response, both Orders v2 representations) into the state this app may
// record for one payment. Pure: no I/O, so it is unit-testable.
//
// A verified payment ("succeeded" and the refund states that follow it)
// requires ALL of:
//   - the order id is the one stored for the payment;
//   - exactly one purchase unit, whose reference_id / custom_id is our
//     payment id (the order was created for THIS checkout);
//   - the payee merchant id equals the configured PAYPAL_MERCHANT_ID;
//   - exactly one capture, with custom_id (when present) = our payment id;
//   - capture status COMPLETED (or REFUNDED / PARTIALLY_REFUNDED later);
//   - capture amount and currency exactly equal to the checkout snapshot.
// Anything inconsistent returns a review reason and no status: the payment
// is flagged and stays locked. The database re-checks amount, currency,
// references and the purchased file before creating an entitlement.

export type Expectation = {
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  merchantId: string;
};

export type RefundInfo = { id: string; status: string; amountMinor: number; currency: string };

export type Evaluation = {
  // null: nothing to record yet (e.g. not approved / not captured).
  status: PaymentStatus | null;
  orderStatus: string | null;
  captureId: string | null;
  amountMinor: number | null;
  currency: string | null;
  merchantId: string | null;
  payerEmail: string | null;
  statusDetail: string | null;
  capturedAt: string | null;
  refunds: RefundInfo[];
  reviewReason: string | null;
};

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const CAPTURE_STATUS: Record<string, PaymentStatus> = {
  COMPLETED: "succeeded",
  PENDING: "pending",
  DECLINED: "denied",
  FAILED: "failed",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
};

const VERIFIED: PaymentStatus[] = ["succeeded", "partially_refunded", "refunded"];

export function evaluateOrder(order: unknown, expected: Expectation): Evaluation {
  const result: Evaluation = {
    status: null,
    orderStatus: null,
    captureId: null,
    amountMinor: null,
    currency: null,
    merchantId: null,
    payerEmail: null,
    statusDetail: null,
    capturedAt: null,
    refunds: [],
    reviewReason: null,
  };
  const review = (reason: string): Evaluation => ({ ...result, status: null, reviewReason: reason });

  const o = obj(order);
  if (!o) return review("unreadable PayPal order");
  if (str(o.id) !== expected.orderId) return review("PayPal returned a different order");
  result.orderStatus = str(o.status);

  const payer = obj(o.payer);
  const paypalSource = obj(obj(o.payment_source)?.paypal);
  result.payerEmail = str(payer?.email_address) ?? str(paypalSource?.email_address);

  const units = list(o.purchase_units);
  if (units.length !== 1) return review("order does not have exactly one purchase unit");
  const unit = obj(units[0]);
  if (!unit) return review("unreadable purchase unit");
  const reference = str(unit.reference_id);
  const customId = str(unit.custom_id);
  if ((reference ?? customId) !== expected.paymentId || (customId !== null && customId !== expected.paymentId)) {
    return review("order was not created for this payment");
  }

  const payeeId = str(obj(unit.payee)?.merchant_id);
  result.merchantId = payeeId;

  switch (result.orderStatus) {
    case "CREATED":
    case "SAVED":
    case "APPROVED":
    case "PAYER_ACTION_REQUIRED":
      // Not paid yet (awaiting approval or capture).
      return result;
    case "VOIDED":
      result.status = "cancelled";
      result.statusDetail = "ORDER_VOIDED";
      return result;
    case "COMPLETED":
      break;
    default:
      return review("unknown order status");
  }

  const payments = obj(unit.payments);
  const captures = list(payments?.captures);
  if (captures.length !== 1) return review("order does not have exactly one capture");
  const capture = obj(captures[0]);
  if (!capture) return review("unreadable capture");

  result.captureId = str(capture.id);
  const captureStatus = str(capture.status);
  const status = captureStatus ? CAPTURE_STATUS[captureStatus] : undefined;
  if (!result.captureId || !status) return review("capture without id or known status");
  if (str(capture.custom_id) !== null && str(capture.custom_id) !== expected.paymentId) {
    return review("capture was not made for this payment");
  }

  const amount = obj(capture.amount);
  result.currency = str(amount?.currency_code);
  result.amountMinor = result.currency ? payPalValueToMinor(amount?.value, result.currency) : null;
  result.statusDetail = str(obj(capture.status_details)?.reason);
  result.capturedAt = str(capture.create_time);

  result.refunds = list(payments?.refunds).flatMap((entry) => {
    const refund = obj(entry);
    const refundAmount = obj(refund?.amount);
    const id = str(refund?.id);
    const refundStatus = str(refund?.status);
    const currency = str(refundAmount?.currency_code);
    const minor = currency ? payPalValueToMinor(refundAmount?.value, currency) : null;
    return id && refundStatus && currency && minor !== null && minor > 0
      ? [{ id, status: refundStatus, amountMinor: minor, currency }]
      : [];
  });

  // Money moved (or was refunded): everything must match exactly.
  if (VERIFIED.includes(status) || status === "pending") {
    if (payeeId !== expected.merchantId) return review("payee is not the configured merchant account");
    if (result.currency !== expected.currency) return review("captured currency differs from the checkout");
    if (result.amountMinor !== expected.amountMinor) return review("captured amount differs from the checkout");
  }

  result.status = status;
  return result;
}

// Order id a webhook resource refers to: orders (CHECKOUT.ORDER.*) carry it
// as their id; captures (PAYMENT.CAPTURE.*) in supplementary_data.
export function webhookReferences(eventType: string, resource: unknown): { orderId: string | null; captureId: string | null } {
  const r = obj(resource);
  if (!r) return { orderId: null, captureId: null };
  if (eventType.startsWith("CHECKOUT.ORDER.")) return { orderId: str(r.id), captureId: null };
  const related = obj(obj(r.supplementary_data)?.related_ids);
  const orderId = str(related?.order_id);
  if (eventType === "PAYMENT.CAPTURE.REFUNDED" || eventType === "PAYMENT.CAPTURE.REVERSED") {
    // The resource is the refund; its "up" link points at the capture.
    const up = list(r.links)
      .map(obj)
      .find((link) => link?.rel === "up" && typeof link.href === "string");
    const match = up ? /\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/.exec(String(up.href)) : null;
    return { orderId, captureId: match?.[1] ?? str(related?.capture_id) };
  }
  return { orderId, captureId: str(r.id) };
}
