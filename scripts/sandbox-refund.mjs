#!/usr/bin/env node
// Full refund of ONE sandbox payment through PayPal's Refunds API
// (POST /v2/payments/captures/{capture_id}/refund), for testing refund
// handling when the sandbox merchant's web login isn't usable.
//
//   node scripts/sandbox-refund.mjs <payment public_ref>            dry run
//   node scripts/sandbox-refund.mjs <payment public_ref> --confirm  refund
//
// Guards: PayPal SANDBOX API host only (hard-coded); the payment is read from
// the LOCAL Supabase stack (127.0.0.1) and must be a sandbox payment that
// completed. The database is NOT updated here: the app must learn about the
// refund from PayPal's PAYMENT.CAPTURE.REFUNDED webhook, as in production.
// Prints statuses and PayPal ids only; never credentials or tokens.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const [ref, flag] = process.argv.slice(2);
if (!ref || !/^[A-Za-z0-9_-]{8,64}$/.test(ref)) {
  console.error("usage: node scripts/sandbox-refund.mjs <payment public_ref> [--confirm]");
  process.exit(1);
}

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
if ((process.env.PAYPAL_ENVIRONMENT ?? "").trim() !== "sandbox") {
  console.error("PAYPAL_ENVIRONMENT must be sandbox; refusing.");
  process.exit(1);
}

const status = JSON.parse(execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString());
if (new URL(status.API_URL).hostname !== "127.0.0.1") {
  console.error("not the local Supabase stack; refusing.");
  process.exit(1);
}

// Returns the exit code instead of calling process.exit() once fetch has run:
// exiting while its sockets close trips a libuv assertion on Windows.
async function main() {
  const rest = await fetch(
    `${status.API_URL}/rest/v1/payments?public_ref=eq.${encodeURIComponent(ref)}&select=environment,status,provider_payment_id,amount_minor,currency,refunded_amount_minor`,
    { headers: { apikey: status.SECRET_KEY, Authorization: `Bearer ${status.SECRET_KEY}` } },
  );
  const [payment] = await rest.json();
  if (!payment) {
    console.error("no payment with that reference in the local database.");
    return 1;
  }
  console.log(`payment: environment=${payment.environment} status=${payment.status} amount=${payment.amount_minor} ${payment.currency} refunded=${payment.refunded_amount_minor ?? 0}`);
  if (payment.environment !== "sandbox" || !["succeeded", "partially_refunded"].includes(payment.status) || !payment.provider_payment_id) {
    console.error("only a completed sandbox payment with a capture id can be refunded here; refusing.");
    return 1;
  }
  if (flag !== "--confirm") {
    console.log("dry run: add --confirm to issue a FULL refund of this sandbox capture.");
    return 0;
  }

  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!tokenRes.ok) {
    console.error(`sandbox OAuth failed: HTTP ${tokenRes.status}`);
    return 1;
  }
  const { access_token: token } = await tokenRes.json();

  // Empty body = refund the full remaining amount of the capture.
  const res = await fetch(`${SANDBOX_API}/v2/payments/captures/${encodeURIComponent(payment.provider_payment_id)}/refund`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(),
      Prefer: "return=minimal",
    },
    body: "{}",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`refund failed: HTTP ${res.status} ${body?.details?.[0]?.issue ?? body?.name ?? ""} debug_id=${body?.debug_id ?? ""}`);
    return 1;
  }
  console.log(`refund accepted by PayPal sandbox: id=${body.id} status=${body.status}`);
  console.log("The app updates the payment when PayPal delivers PAYMENT.CAPTURE.REFUNDED to the webhook.");
  return 0;
}
process.exitCode = await main();
