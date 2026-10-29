import "server-only";

import { PROPOSALS_BUCKET } from "@/lib/proposals/paths";
import type { Database, PaymentStatus } from "@/types/database";

import { privilegedClient } from "./privileged";

// Payment data access with the server-only secret key. Limited to the
// service_role-only payment_* functions (migration 20261101090100) and one
// storage read: the purchased PDF whose path payment_document_for_session
// returned for this browser. Browser input never names a path, an amount or
// a status; ids passed here come from the database or from PayPal responses.

type Fn = Database["public"]["Functions"];
type Rows<K extends keyof Fn> = Fn[K]["Returns"];

export type StoreResult<T> = { ok: true; data: T } | { ok: false; code: string };

function fail(error: { code?: string } | null): { ok: false; code: string } {
  return { ok: false, code: error?.code || "unavailable" };
}

export async function beginCheckout(args: { token: string; sessionHash: string; environment: string }) {
  const { data, error } = await privilegedClient().rpc("payment_begin_checkout", {
    p_token: args.token,
    p_session_hash: args.sessionHash,
    p_environment: args.environment,
  });
  if (error) return fail(error);
  return { ok: true as const, data: (data as Rows<"payment_begin_checkout">)[0] ?? null };
}

export async function recordOrder(args: { paymentId: string; orderId: string; approveUrl: string }) {
  const { error } = await privilegedClient().rpc("payment_record_order", {
    p_payment_id: args.paymentId,
    p_order_id: args.orderId,
    p_approve_url: args.approveUrl,
  });
  return error ? fail(error) : { ok: true as const, data: null };
}

export type SessionPayment = Rows<"payment_session_view">[number];

export async function paymentForSession(publicRef: string, sessionHash: string): Promise<StoreResult<SessionPayment | null>> {
  const { data, error } = await privilegedClient().rpc("payment_session_view", {
    p_public_ref: publicRef,
    p_session_hash: sessionHash,
  });
  if (error) return fail(error);
  return { ok: true, data: (data ?? [])[0] ?? null };
}

export async function lookupByProvider(orderId: string | null, captureId: string | null) {
  const { data, error } = await privilegedClient().rpc("payment_lookup_provider", {
    p_order_id: orderId,
    p_capture_id: captureId,
  });
  if (error) return fail(error);
  return { ok: true as const, data: data ?? [] };
}

export async function markCancelled(paymentId: string, sessionHash: string) {
  const { data, error } = await privilegedClient().rpc("payment_mark_cancelled", {
    p_payment_id: paymentId,
    p_session_hash: sessionHash,
  });
  return error ? fail(error) : { ok: true as const, data: data as PaymentStatus };
}

export type ApplyArgs = {
  paymentId: string;
  status: PaymentStatus;
  orderId: string;
  captureId: string | null;
  amountMinor: number | null;
  currency: string | null;
  merchantId: string | null;
  payerEmail: string | null;
  statusDetail: string | null;
  capturedAt: string | null;
  reviewReason: string | null;
};

export async function applyState(args: ApplyArgs) {
  const { data, error } = await privilegedClient().rpc("payment_apply_state", {
    p_payment_id: args.paymentId,
    p_status: args.status,
    p_order_id: args.orderId,
    p_capture_id: args.captureId,
    p_amount_minor: args.amountMinor,
    p_currency: args.currency,
    p_merchant_id: args.merchantId,
    p_payer_email: args.payerEmail,
    p_status_detail: args.statusDetail,
    p_captured_at: args.capturedAt,
    p_review_reason: args.reviewReason,
  });
  if (error) return fail(error);
  const row = (data ?? [])[0];
  return row ? { ok: true as const, data: row } : fail(null);
}

export async function recordRefund(args: {
  paymentId: string;
  refundId: string;
  amountMinor: number;
  currency: string;
  status: string;
}) {
  const { data, error } = await privilegedClient().rpc("payment_record_refund", {
    p_payment_id: args.paymentId,
    p_refund_id: args.refundId,
    p_amount_minor: args.amountMinor,
    p_currency: args.currency,
    p_status: args.status,
  });
  return error ? fail(error) : { ok: true as const, data: data as number };
}

export async function grantSessionAccess(paymentId: string, sessionHash: string, days: number) {
  const { data, error } = await privilegedClient().rpc("payment_grant_session_access", {
    p_payment_id: paymentId,
    p_session_hash: sessionHash,
    p_days: days,
  });
  return error ? fail(error) : { ok: true as const, data: (data as string | null) ?? null };
}

export async function accessForLink(token: string, sessionHash: string) {
  const { data, error } = await privilegedClient().rpc("payment_access_for_link", {
    p_token: token,
    p_session_hash: sessionHash,
  });
  return error ? fail(error) : { ok: true as const, data: data ?? [] };
}

export type PurchasedDocument =
  | { ok: true; stream: ReadableStream<Uint8Array>; totalPages: number }
  | { ok: false; reason: "denied" | "missing" | "error" };

// Full-PDF delivery: authorizes THIS browser for THIS purchase in the
// database first (active entitlement, valid access session), then streams
// exactly the purchased revision from the private bucket.
export async function openPurchasedDocument(publicRef: string, sessionHash: string): Promise<PurchasedDocument> {
  const client = privilegedClient();
  const { data, error } = await client.rpc("payment_document_for_session", {
    p_public_ref: publicRef,
    p_session_hash: sessionHash,
  });
  if (error) return { ok: false, reason: "error" };
  const row = (data ?? [])[0];
  if (!row || !row.original_storage_path.endsWith("/original.pdf")) return { ok: false, reason: "denied" };

  const { data: stream, error: storageError } = await client.storage
    .from(PROPOSALS_BUCKET)
    .download(row.original_storage_path)
    .asStream();
  if (storageError || !stream) {
    const status = (storageError as { status?: number } | null)?.status;
    return { ok: false, reason: status === 404 ? "missing" : "error" };
  }
  return { ok: true, stream: stream as ReadableStream<Uint8Array>, totalPages: row.total_pages };
}

export async function requestRecovery(args: { token: string; email: string; tokenHash: string; ttlMinutes: number }) {
  const { data, error } = await privilegedClient().rpc("payment_recovery_request", {
    p_token: args.token,
    p_email: args.email,
    p_token_hash: args.tokenHash,
    p_ttl_minutes: args.ttlMinutes,
  });
  return error ? fail(error) : { ok: true as const, data: (data ?? [])[0] ?? null };
}

export async function issueRecovery(args: { actorId: string; paymentId: string; tokenHash: string; ttlMinutes: number }) {
  const { data, error } = await privilegedClient().rpc("payment_recovery_issue", {
    p_actor: args.actorId,
    p_payment_id: args.paymentId,
    p_token_hash: args.tokenHash,
    p_ttl_minutes: args.ttlMinutes,
  });
  return error ? fail(error) : { ok: true as const, data: data as string };
}

export async function peekRecovery(tokenHash: string) {
  const { data, error } = await privilegedClient().rpc("payment_recovery_peek", { p_token_hash: tokenHash });
  return error ? fail(error) : { ok: true as const, data: (data ?? [])[0] ?? null };
}

export async function consumeRecovery(tokenHash: string, sessionHash: string, days: number) {
  const { data, error } = await privilegedClient().rpc("payment_recovery_consume", {
    p_token_hash: tokenHash,
    p_session_hash: sessionHash,
    p_days: days,
  });
  return error ? fail(error) : { ok: true as const, data: (data as string | null) ?? null };
}

export async function beginEvent(args: {
  eventId: string;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
}) {
  const { data, error } = await privilegedClient().rpc("payment_event_begin", {
    p_provider: "paypal",
    p_event_id: args.eventId,
    p_event_type: args.eventType,
    p_resource_type: args.resourceType,
    p_resource_id: args.resourceId,
  });
  if (error) return fail(error);
  const row = (data ?? [])[0];
  return row ? { ok: true as const, data: row } : fail(null);
}

export async function finishEvent(id: string, result: string, paymentId: string | null, detail: string | null) {
  const { error } = await privilegedClient().rpc("payment_event_finish", {
    p_id: id,
    p_result: result,
    p_payment_id: paymentId,
    p_detail: detail,
  });
  return error ? fail(error) : { ok: true as const, data: null };
}
