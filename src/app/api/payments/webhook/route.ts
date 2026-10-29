import { connection } from "next/server";

import { getPaymentConfig, warnIfIncomplete } from "@/lib/payments/config";
import { handleWebhook } from "@/lib/payments/service";
import { limitPayment } from "@/lib/security/public-limits";

// POST /api/payments/webhook: PayPal webhook listener (register this exact
// path in the PayPal app, see docs/PAYPAL_SETUP.md).
//
// - Unconfigured (payments off or any PayPal setting missing): 503 and
//   nothing is read or stored. PayPal retries failed deliveries for up to
//   3 days, so events sent before configuration is fixed are not lost.
// - Every event is signature-verified with PayPal (verify-webhook-signature,
//   using PAYPAL_WEBHOOK_ID) BEFORE anything is stored. Unverified: 400.
// - Verified events are recorded once (unique event id); the payment's
//   state is then re-read from the PayPal API, never taken from the event
//   body (reversals, which only remove access, are the one exception).
// - 2xx only after processing; 5xx makes PayPal retry.

const NO_STORE = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };
const MAX_BYTES = 64 * 1024;

export async function POST(request: Request) {
  await connection();
  const config = getPaymentConfig();
  if (!config) {
    warnIfIncomplete();
    return new Response("payments not configured", { status: 503, headers: NO_STORE });
  }

  // Fails open: legitimate deliveries must not be dropped by a limiter outage.
  const limit = await limitPayment("webhook_ip", request.headers);
  if (limit.status === "limited") {
    return new Response("busy", { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfterSeconds) } });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return new Response("too large", { status: 413, headers: NO_STORE });

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return new Response("invalid body", { status: 400, headers: NO_STORE });
  }

  try {
    const outcome = await handleWebhook(config, raw, request.headers);
    return new Response(outcome.body, { status: outcome.status, headers: NO_STORE });
  } catch {
    console.error("[webhook] processing failed");
    return new Response("error", { status: 500, headers: NO_STORE });
  }
}
