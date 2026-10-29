import { createHash } from "node:crypto";

import { clientAddress } from "./client-ip";
import { consumeAll, consumeRate, rateKey, rateRule, type RateDecision } from "./rate-limit";

// Rate limits for private client links (/p/<token>, its preview, and the
// document and downloads of Full Access links).
//
// Keys: the client address (see client-ip.ts) and, for the preview, the
// link's token hash. The raw token never leaves the request: it is SHA-256
// hashed, then HMAC-keyed, before it reaches the limiter.
//
// All of these FAIL OPEN: if the limiter is unavailable the request goes
// ahead, because the token is still checked against the database and the
// preview is still the only thing that can be served.

function addressKey(headers: Headers) {
  return rateKey("ip", clientAddress(headers));
}

function tokenKey(token: string) {
  return rateKey("token", createHash("sha256").update(token).digest("hex"));
}

export async function limitLinkPage(headers: Headers): Promise<RateDecision> {
  return consumeRate(rateRule("link_page_ip"), addressKey(headers));
}

export async function limitLinkPreview(headers: Headers, token: string): Promise<RateDecision> {
  return consumeAll([
    { rule: rateRule("link_preview_ip"), key: addressKey(headers) },
    { rule: rateRule("link_preview_token"), key: tokenKey(token) },
  ]);
}

// Full Access links: the inline document (viewer) and the downloads.
export async function limitLinkDocument(headers: Headers, token: string, kind: "view" | "download"): Promise<RateDecision> {
  return consumeAll(
    kind === "view"
      ? [
          { rule: rateRule("link_document_ip"), key: addressKey(headers) },
          { rule: rateRule("link_document_token"), key: tokenKey(token) },
        ]
      : [
          { rule: rateRule("link_download_ip"), key: addressKey(headers) },
          { rule: rateRule("link_download_token"), key: tokenKey(token) },
        ],
  );
}

// Called after a lookup found no active link for the token. Over the limit,
// the caller answers "too many requests" instead of "not available", which
// slows down guessing. Only lookups of links that DON'T exist are affected:
// a valid link is never blocked because someone else on the same network
// mistyped or guessed links.
export async function recordLinkMiss(headers: Headers): Promise<RateDecision> {
  return consumeRate(rateRule("link_miss_ip"), addressKey(headers));
}

// Payment endpoints: per client address, plus an optional second key (a
// link token or a typed email; hashed before it reaches the limiter).
// Callers decide the failure policy for { status: "error" }.
export async function limitPayment(
  addressRule: "checkout_ip" | "purchase_ip" | "purchase_document_ip" | "recovery_ip" | "recovery_claim_ip" | "webhook_ip",
  headers: Headers,
  second?: { rule: "checkout_token" | "recovery_email"; value: string },
): Promise<RateDecision> {
  const checks = [{ rule: rateRule(addressRule), key: addressKey(headers) }];
  if (second) {
    checks.push({
      rule: rateRule(second.rule),
      key: rateKey(second.rule, createHash("sha256").update(second.value).digest("hex")),
    });
  }
  return consumeAll(checks);
}

export function tooManyRequests(retryAfterSeconds: number, body: string, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status: 429,
    headers: {
      "Content-Type": contentType,
      "Retry-After": String(retryAfterSeconds),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}
