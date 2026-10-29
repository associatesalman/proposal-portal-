import { cookies } from "next/headers";
import { connection } from "next/server";

import { ensureSession, writeSession } from "@/lib/payments/browser-session";
import { getPaymentConfig, warnIfIncomplete } from "@/lib/payments/config";
import { isSameOriginRequest, jsonResponse } from "@/lib/payments/request-guard";
import { startCheckout } from "@/lib/payments/service";
import { isWellFormedToken } from "@/lib/proposals/links";
import { limitPayment } from "@/lib/security/public-limits";

// POST /p/<token>/checkout: starts PayPal Checkout for the proposal the link
// resolves to and answers { url } (PayPal's approval page). The browser
// navigates there itself (a fetch + location change keeps the strict
// form-action CSP intact).
//
// - The ONLY input is the link token. Amount, currency, revision and owner
//   are read from the database; the request body is ignored.
// - Same-origin POST only (Origin header), rate-limited per address and per
//   link; fails closed if the limiter is unavailable (it calls PayPal).
// - Binds the checkout to this browser's HttpOnly session cookie (created
//   here if missing). Only that browser can later capture it or get access.
// - Payments disabled or not fully configured: 503, nothing is created.

export async function POST(request: Request, ctx: RouteContext<"/p/[token]/checkout">) {
  await connection();
  const { token } = await ctx.params;

  const config = getPaymentConfig();
  if (!config) {
    warnIfIncomplete();
    return jsonResponse(503, { error: "unavailable", message: "Online payment isn't available yet." });
  }
  if (!isSameOriginRequest(request)) return jsonResponse(403, { error: "forbidden" });
  if (!isWellFormedToken(token)) return jsonResponse(404, { error: "not_found" });

  const limit = await limitPayment("checkout_ip", request.headers, { rule: "checkout_token", value: token });
  if (limit.status === "limited") {
    return jsonResponse(
      429,
      { error: "busy", message: "Too many payment attempts. Wait a few minutes, then try again." },
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
  }
  if (limit.status === "error") {
    return jsonResponse(503, { error: "unavailable", message: "Payment is temporarily unavailable. Please try again in a moment." });
  }

  const store = await cookies();
  const session = ensureSession(store);
  const outcome = await startCheckout(config, { token, sessionHash: session.hash });
  // Kept even when starting failed: a retry reuses the same open attempt.
  writeSession(store, session.secret, config.accessDays);

  switch (outcome.kind) {
    case "redirect":
      return jsonResponse(200, { url: outcome.url, ref: outcome.publicRef });
    case "unavailable":
      return jsonResponse(404, { error: "not_found", message: "This link isn't available." });
    case "not_purchasable":
      return jsonResponse(409, {
        error: "not_purchasable",
        message: "This document can't be paid for online. Please contact the person who sent you this link.",
      });
    default:
      return jsonResponse(502, {
        error: "provider",
        message: "We couldn't start the payment. You haven't been charged. Please try again in a moment.",
      });
  }
}
