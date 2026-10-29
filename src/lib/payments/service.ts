import "server-only";

import {
  applyState,
  beginCheckout,
  beginEvent,
  finishEvent,
  lookupByProvider,
  recordOrder,
  recordRefund,
  type SessionPayment,
} from "@/lib/supabase/privileged-payments";
import type { PaymentStatus } from "@/types/database";

import type { PaymentConfig } from "./config";
import { isPayPalCurrency, minorToPayPalValue } from "./money";
import {
  approvalUrl,
  captureOrder,
  createOrder,
  getOrder,
  verifyWebhookSignature,
  type PayPalResult,
  type WebhookHeaders,
} from "./paypal";
import { evaluateOrder, webhookReferences, type Evaluation } from "./verify";

// Payment orchestration. The order of operations is what makes it safe:
//
// Checkout   payment row (snapshot, browser binding) is written FIRST, then
//            the PayPal order (idempotent PayPal-Request-Id), then the order
//            id is stored, and only then is the browser sent to PayPal.
// Capture    only for the browser bound to the payment; idempotent capture
//            request id; the response is evaluated (verify.ts) and applied
//            through payment_apply_state, which re-checks it.
// Reconcile  any later look (status polling, webhooks) re-reads the order
//            from PayPal and applies it again. Applying is idempotent and
//            monotonic, so captures racing webhooks, duplicate or
//            out-of-order deliveries, and "PayPal captured but our database
//            write failed" all converge on the same verified state.
// Never      a success URL, query string, browser callback or unverified
//            webhook payload changes a payment.

type PaymentRef = {
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
};

export type CheckoutOutcome =
  | { kind: "redirect"; url: string; publicRef: string }
  | { kind: "unavailable" } // link not usable (same answer as an invalid link)
  | { kind: "not_purchasable" } // currency/document can't be bought online
  | { kind: "error" }; // PayPal or database unavailable; nothing charged

export async function startCheckout(
  config: PaymentConfig,
  args: { token: string; sessionHash: string },
): Promise<CheckoutOutcome> {
  const begun = await beginCheckout({ token: args.token, sessionHash: args.sessionHash, environment: config.environment });
  if (!begun.ok) return begun.code === "PT423" ? { kind: "not_purchasable" } : { kind: "error" };
  const row = begun.data;
  if (!row) return { kind: "unavailable" };
  if (!isPayPalCurrency(row.currency)) return { kind: "not_purchasable" };

  if (row.provider_order_id && row.approve_url) {
    return { kind: "redirect", url: row.approve_url, publicRef: row.public_ref };
  }

  const purchaseUrl = `${config.appUrl}/purchase/${row.public_ref}`;
  const created = await createOrder(config, {
    requestId: row.request_id,
    paymentId: row.payment_id,
    amountValue: minorToPayPalValue(row.amount_minor, row.currency),
    currency: row.currency,
    description: `Proposal: ${row.title}`,
    returnUrl: `${purchaseUrl}?result=return`,
    cancelUrl: `${purchaseUrl}?result=cancel`,
  });
  if (!created.ok) return { kind: "error" };

  const orderId = (created.body as { id?: unknown } | null)?.id;
  const url = approvalUrl(config, created.body);
  if (typeof orderId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(orderId) || !url) {
    console.error("[payments] order response without id or approval link");
    return { kind: "error" };
  }
  // Persisted before the browser is redirected; if this fails the order is
  // never approved and nothing is charged.
  const recorded = await recordOrder({ paymentId: row.payment_id, orderId, approveUrl: url });
  if (!recorded.ok) return { kind: "error" };
  return { kind: "redirect", url, publicRef: row.public_ref };
}

export type SyncOutcome =
  | { kind: "applied"; status: PaymentStatus; review: boolean }
  // Nothing to record yet: not approved, or approved and not captured.
  | { kind: "open"; orderStatus: string | null; declined: boolean }
  // PayPal or the database couldn't be reached: state unknown, retry later.
  | { kind: "unavailable" };

async function apply(config: PaymentConfig, ref: PaymentRef, evaluation: Evaluation): Promise<SyncOutcome> {
  for (const refund of evaluation.refunds) {
    if (refund.currency !== ref.currency) continue;
    const recorded = await recordRefund({ paymentId: ref.paymentId, refundId: refund.id, amountMinor: refund.amountMinor, currency: refund.currency, status: refund.status });
    if (!recorded.ok) return { kind: "unavailable" };
  }

  if (!evaluation.status && !evaluation.reviewReason) {
    return { kind: "open", orderStatus: evaluation.orderStatus, declined: false };
  }
  const applied = await applyState({
    paymentId: ref.paymentId,
    // Ignored by the database when a review reason is given.
    status: evaluation.status ?? "pending",
    orderId: ref.orderId,
    captureId: evaluation.captureId,
    amountMinor: evaluation.amountMinor,
    currency: evaluation.currency,
    merchantId: evaluation.merchantId === config.merchantId ? evaluation.merchantId : null,
    payerEmail: evaluation.payerEmail,
    statusDetail: evaluation.statusDetail,
    capturedAt: evaluation.capturedAt,
    reviewReason: evaluation.reviewReason,
  });
  if (!applied.ok) {
    console.error("[payments] could not record verified state", applied.code);
    return { kind: "unavailable" };
  }
  if (evaluation.reviewReason) console.error("[payments] payment flagged for review");
  return { kind: "applied", status: applied.data.status, review: Boolean(evaluation.reviewReason) };
}

function expectation(config: PaymentConfig, ref: PaymentRef) {
  return { paymentId: ref.paymentId, orderId: ref.orderId, amountMinor: ref.amountMinor, currency: ref.currency, merchantId: config.merchantId };
}

async function applyOrderResult(config: PaymentConfig, ref: PaymentRef, result: PayPalResult<unknown>): Promise<SyncOutcome> {
  if (!result.ok) return { kind: "unavailable" };
  return apply(config, ref, evaluateOrder(result.body, expectation(config, ref)));
}

// Re-reads the order from PayPal and records its verified state.
export async function refreshFromPayPal(config: PaymentConfig, ref: PaymentRef): Promise<SyncOutcome> {
  return applyOrderResult(config, ref, await getOrder(config, ref.orderId));
}

// Captures an approved order (idempotent: the same PayPal-Request-Id for
// every attempt on this payment), then records the verified result. When
// PayPal says it was already captured, or the outcome is unknown, the order
// is re-read instead.
export async function captureAndRecord(config: PaymentConfig, ref: PaymentRef): Promise<SyncOutcome> {
  const captured = await captureOrder(config, ref.orderId, `capture-${ref.paymentId}`);
  if (captured.ok) return applyOrderResult(config, ref, captured);

  if (captured.issue === "ORDER_NOT_APPROVED" || captured.issue === "PAYER_ACTION_REQUIRED") {
    return { kind: "open", orderStatus: "CREATED", declined: false };
  }
  if (captured.issue === "INSTRUMENT_DECLINED") {
    // The buyer can pick another funding source on the same order.
    return { kind: "open", orderStatus: "APPROVED", declined: true };
  }
  // ORDER_ALREADY_CAPTURED, network failure, 5xx, anything else: the order
  // itself is the source of truth.
  return refreshFromPayPal(config, ref);
}

export function paymentRef(payment: Pick<SessionPayment, "payment_id" | "provider_order_id" | "amount_minor" | "currency">): PaymentRef | null {
  return payment.provider_order_id
    ? { paymentId: payment.payment_id, orderId: payment.provider_order_id, amountMinor: payment.amount_minor, currency: payment.currency }
    : null;
}

// What the client sees for a payment (never "completed" without a verified,
// active entitlement in the database).
export type ClientPaymentState =
  | "awaiting_approval"
  | "pending"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"
  | "refunded";

export function clientState(payment: Pick<SessionPayment, "status" | "needs_review" | "entitlement_active">): ClientPaymentState {
  switch (payment.status) {
    case "succeeded":
    case "partially_refunded":
      return payment.entitlement_active ? "completed" : "verifying";
    case "refunded":
    case "reversed":
      return "refunded";
    case "pending":
      return "pending";
    case "failed":
    case "denied":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return payment.needs_review ? "verifying" : "awaiting_approval";
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type WebhookOutcome = { status: number; body: string };

const MAX_WEBHOOK_BYTES = 64 * 1024;

const HANDLED_EVENTS = new Set([
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
]);

export function webhookHeaders(headers: Headers): WebhookHeaders | null {
  const pick = (name: string) => headers.get(name)?.trim() || null;
  const transmissionId = pick("paypal-transmission-id");
  const transmissionTime = pick("paypal-transmission-time");
  const transmissionSig = pick("paypal-transmission-sig");
  const certUrl = pick("paypal-cert-url");
  const authAlgo = pick("paypal-auth-algo");
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) return null;
  if ([transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo].some((value) => value.length > 2048)) return null;
  return { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo };
}

export async function handleWebhook(config: PaymentConfig, rawBody: string, headers: Headers): Promise<WebhookOutcome> {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) return { status: 413, body: "too large" };
  const signed = webhookHeaders(headers);
  if (!signed) return { status: 400, body: "missing signature" };

  let event: { id?: unknown; event_type?: unknown; resource_type?: unknown; resource?: unknown };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "invalid body" };
  }
  if (typeof event.id !== "string" || typeof event.event_type !== "string" || event.id.length > 128) {
    return { status: 400, body: "invalid event" };
  }

  // Nothing is stored or changed before PayPal confirms the signature.
  const verification = await verifyWebhookSignature(config, signed, rawBody);
  if (verification === "unavailable") return { status: 503, body: "verification unavailable" };
  if (verification !== "verified") return { status: 400, body: "invalid signature" };

  const eventType = event.event_type;
  const refs = webhookReferences(eventType, event.resource);
  const begun = await beginEvent({
    eventId: event.id,
    eventType,
    resourceType: typeof event.resource_type === "string" ? event.resource_type : null,
    resourceId: refs.captureId ?? refs.orderId,
  });
  if (!begun.ok) return { status: 500, body: "storage unavailable" };
  if (begun.data.result !== "received" && begun.data.result !== "error") return { status: 200, body: "duplicate" };
  const eventRowId = begun.data.id;

  const finish = async (result: string, paymentId: string | null, detail: string | null, status = 200) => {
    await finishEvent(eventRowId, result, paymentId, detail);
    return { status, body: result };
  };

  if (!HANDLED_EVENTS.has(eventType)) return finish("ignored", null, "event type not used");

  const found = await lookupByProvider(refs.orderId, refs.captureId);
  if (!found.ok) return finish("error", null, "lookup failed", 500);
  if (found.data.length === 0) return finish("unmatched", null, "no payment for this reference");
  if (found.data.length > 1) return finish("review", null, "reference matches several payments");
  const payment = found.data[0];
  if (payment.environment !== config.environment) return finish("ignored", payment.payment_id, "other PayPal environment");
  const ref = paymentRef(payment);
  if (!ref) return finish("unmatched", payment.payment_id, "payment has no order");
  if (refs.orderId && refs.orderId !== ref.orderId) return finish("review", payment.payment_id, "order reference mismatch");

  let outcome: SyncOutcome;
  if (eventType === "CHECKOUT.ORDER.APPROVED" && (payment.status === "created" || payment.status === "cancelled")) {
    // The buyer approved but may never come back (closed tab): capture now.
    // Access still goes only to the initiating browser (or recovery).
    outcome = await captureAndRecord(config, ref);
  } else {
    outcome = await refreshFromPayPal(config, ref);
  }
  if (outcome.kind === "unavailable") return finish("error", payment.payment_id, "PayPal or database unavailable", 500);

  if (eventType === "PAYMENT.CAPTURE.REVERSED") {
    // A reversal only ever REMOVES access, so the signature-verified event
    // is enough; the database checks it names this payment's capture.
    if (!refs.captureId || refs.captureId !== payment.provider_payment_id) {
      return finish("review", payment.payment_id, "reversal for an unknown capture");
    }
    const reversed = await applyState({
      paymentId: ref.paymentId,
      status: "reversed",
      orderId: ref.orderId,
      captureId: refs.captureId,
      amountMinor: ref.amountMinor,
      currency: ref.currency,
      merchantId: config.merchantId,
      payerEmail: null,
      statusDetail: "REVERSED",
      capturedAt: null,
      reviewReason: null,
    });
    if (!reversed.ok) return finish("error", payment.payment_id, "could not record reversal", 500);
  }

  const review = outcome.kind === "applied" && outcome.review;
  return finish(review ? "review" : "applied", payment.payment_id, outcome.kind === "applied" ? outcome.status : "no change");
}
