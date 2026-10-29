import { cookies } from "next/headers";
import { connection } from "next/server";
import { z } from "zod";

import { ensureSession, readSessionHash, writeSession } from "@/lib/payments/browser-session";
import { getPaymentConfig, paymentAccessDays } from "@/lib/payments/config";
import { isPublicRef } from "@/lib/payments/refs";
import { isSameOriginRequest, jsonResponse } from "@/lib/payments/request-guard";
import { captureAndRecord, clientState, paymentRef, refreshFromPayPal } from "@/lib/payments/service";
import { formatPrice, isCurrencyCode } from "@/lib/proposals/currencies";
import { limitPayment } from "@/lib/security/public-limits";
import { grantSessionAccess, markCancelled, paymentForSession } from "@/lib/supabase/privileged-payments";

// POST /purchase/<ref>/status  { action: "capture" | "refresh" | "cancel" }
//
// The purchase page calls this after PayPal sends the buyer back, and then
// polls it (bounded) while the payment is pending. Only a browser that
// started this checkout (or already holds access to it) gets an answer;
// anyone else gets 404, whatever the reference.
//
// - "capture": capture the approved order (idempotent) and record the
//   verified result. "refresh": re-read the order from PayPal (at most every
//   few seconds per payment) and capture it if it was approved meanwhile.
//   "cancel": the buyer came back through PayPal's cancel URL; an attempt
//   nobody paid becomes "cancelled".
// - The answer is "completed" only when the database holds a verified
//   payment with an active entitlement; this browser then receives its
//   access session (HttpOnly cookie, SameSite=Lax).
// - The query string of the return URL is never trusted: it isn't read.

const BODY = z.object({ action: z.enum(["capture", "refresh", "cancel"]) });
const REFRESH_INTERVAL_MS = 4_000;
const OPEN_STATES = new Set(["created", "pending", "cancelled"]);

export async function POST(request: Request, ctx: RouteContext<"/purchase/[ref]/status">) {
  await connection();
  const { ref } = await ctx.params;

  if (!isSameOriginRequest(request)) return jsonResponse(403, { error: "forbidden" });
  const limit = await limitPayment("purchase_ip", request.headers);
  if (limit.status === "limited") {
    return jsonResponse(429, { error: "busy" }, { "Retry-After": String(limit.retryAfterSeconds) });
  }
  if (!isPublicRef(ref)) return jsonResponse(404, { error: "not_found" });

  let action: z.infer<typeof BODY>["action"];
  try {
    action = BODY.parse(await request.json()).action;
  } catch {
    return jsonResponse(400, { error: "bad_request" });
  }

  const store = await cookies();
  const sessionHash = readSessionHash(store);
  if (!sessionHash) return jsonResponse(404, { error: "not_found" });

  let view = await paymentForSession(ref, sessionHash);
  if (!view.ok) return jsonResponse(503, { error: "unavailable" });
  if (!view.data) return jsonResponse(404, { error: "not_found" });

  const config = getPaymentConfig();
  let declined = false;
  let unknown = false;
  const current = view.data;
  const providerRef = paymentRef(current);

  if (current.bound && config && current.environment === config.environment && providerRef) {
    if (action === "cancel") {
      if (current.status === "created") await markCancelled(current.payment_id, sessionHash);
    } else if (OPEN_STATES.has(current.status) || (current.needs_review && current.status === "created")) {
      const lastSync = current.last_synced_at ? Date.parse(current.last_synced_at) : 0;
      const due = action === "capture" || Date.now() - lastSync >= REFRESH_INTERVAL_MS;
      if (due) {
        let outcome =
          action === "capture" && current.status !== "pending"
            ? await captureAndRecord(config, providerRef)
            : await refreshFromPayPal(config, providerRef);
        if (outcome.kind === "open" && outcome.orderStatus === "APPROVED" && !outcome.declined) {
          outcome = await captureAndRecord(config, providerRef);
        }
        declined = outcome.kind === "open" && outcome.declined;
        unknown = outcome.kind === "unavailable";
      }
    }
    view = await paymentForSession(ref, sessionHash);
    if (!view.ok || !view.data) return jsonResponse(503, { error: "unavailable" });
  }

  let payment = view.data;
  // Verified and active, started in THIS browser, no access yet: grant it.
  if (payment.bound && payment.entitlement_active && !payment.has_access) {
    const days = paymentAccessDays();
    const granted = await grantSessionAccess(payment.payment_id, sessionHash, days);
    if (granted.ok && granted.data) {
      writeSession(store, ensureSession(store).secret, days);
      const reloaded = await paymentForSession(ref, sessionHash);
      if (reloaded.ok && reloaded.data) payment = reloaded.data;
    }
  }

  const state = clientState(payment);
  return jsonResponse(200, {
    state: state === "completed" && !payment.has_access ? "verifying" : state,
    hasAccess: payment.has_access,
    title: payment.title,
    amount: isCurrencyCode(payment.currency) ? formatPrice(payment.amount_minor, payment.currency) : null,
    currency: payment.currency,
    declined,
    // PayPal couldn't be reached this time; the client keeps polling.
    retryLater: unknown,
    // Only the browser that started the checkout may go back to PayPal.
    approveUrl: payment.bound && (state === "awaiting_approval" || declined) ? payment.approve_url : null,
  });
}
