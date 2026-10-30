#!/usr/bin/env node
// PayPal configuration check. Reads .env.local (like the app) and reports
// each setting by NAME only: never a value, a prefix or a length.
//
//   npm run paypal:check              shape checks only (no network)
//   npm run paypal:check -- --auth    also asks PayPal SANDBOX for an OAuth
//                                     token with the client ID and secret
//                                     (proves the pair works; no order, no
//                                     charge). Refused for live.
//
// The shape rules mirror src/lib/payments/config.ts. Exit code 0 when every
// required value is present and valid, 1 otherwise.

import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const read = (name) => process.env[name]?.trim() || undefined;

const RULES = [
  ["PAYPAL_ENVIRONMENT", (v) => v === "sandbox" || v === "live", 'must be "sandbox" or "live"'],
  ["PAYPAL_CLIENT_ID", (v) => /^[A-Za-z0-9_-]{20,128}$/.test(v), "unexpected characters or length"],
  ["PAYPAL_CLIENT_SECRET", (v) => /^[A-Za-z0-9_-]{20,128}$/.test(v), "unexpected characters or length"],
  ["PAYPAL_MERCHANT_ID", (v) => /^[A-Z0-9]{8,20}$/.test(v), "expected upper-case letters/digits (merchant account ID)"],
  ["PAYPAL_WEBHOOK_ID", (v) => /^[A-Za-z0-9-]{6,64}$/.test(v), "unexpected characters or length"],
  [
    "NEXT_PUBLIC_APP_URL",
    (v) => {
      try {
        return ["http:", "https:"].includes(new URL(v).protocol);
      } catch {
        return false;
      }
    },
    "must be an absolute http(s) URL",
  ],
];

let failures = 0;
const enabled = (process.env.PAYMENTS_ENABLED ?? "").trim().toLowerCase() === "true";
console.log(`info  PAYMENTS_ENABLED: ${enabled ? "true (checkout is ON when everything below is valid)" : "off"}`);

for (const [name, valid, hint] of RULES) {
  const value = read(name);
  if (!value) {
    failures++;
    console.log(`MISS  ${name}`);
  } else if (!valid(value)) {
    failures++;
    console.log(`BAD   ${name}: ${hint}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

const environment = read("PAYPAL_ENVIRONMENT");
if (read("PAYPAL_API_BASE_URL")) {
  failures++;
  console.log("BAD   PAYPAL_API_BASE_URL is set: it is for automated tests only; remove it");
}
if (environment === "live") console.log("warn  PAYPAL_ENVIRONMENT is live: use sandbox until the sandbox test has passed");
const appUrl = read("NEXT_PUBLIC_APP_URL");
if (appUrl && !appUrl.startsWith("https://")) {
  console.log("info  NEXT_PUBLIC_APP_URL is not https: PayPal can't reach the webhook; use the tunnel URL for a sandbox test");
}

if (process.argv.includes("--auth")) {
  const id = read("PAYPAL_CLIENT_ID");
  const secret = read("PAYPAL_CLIENT_SECRET");
  if (environment !== "sandbox") {
    failures++;
    console.log("FAIL  --auth only runs against the sandbox (set PAYPAL_ENVIRONMENT=sandbox)");
  } else if (!id || !secret) {
    failures++;
    console.log("FAIL  --auth needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  } else {
    try {
      const res = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(10000),
      });
      // The token itself is discarded unread.
      await res.body?.cancel();
      if (res.ok) {
        console.log("ok    sandbox OAuth: PayPal accepted the client ID and secret");
      } else {
        failures++;
        console.log(`FAIL  sandbox OAuth: PayPal answered HTTP ${res.status} (wrong pair, or not a sandbox app)`);
      }
    } catch {
      failures++;
      console.log("FAIL  sandbox OAuth: PayPal couldn't be reached");
    }
  }
}

console.log(failures === 0 ? "\nAll PayPal settings look valid." : `\n${failures} problem(s). Values are never shown; fix them in .env.local.`);
// exitCode, not process.exit(): exiting while fetch's connection is still
// closing aborts Node on Windows (libuv "UV_HANDLE_CLOSING" assertion).
process.exitCode = failures === 0 ? 0 : 1;
