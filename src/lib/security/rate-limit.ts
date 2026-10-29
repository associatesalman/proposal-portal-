import { createHash, createHmac } from "node:crypto";

import { getServerSupabaseConfig } from "@/lib/supabase/config";

// Shared, persistent rate limiting backed by PostgreSQL
// (public.rate_limit_consume, migration 20261030090000). Every server
// instance sees the same counters, and nothing is held in process memory.
//
// - Keys are HMAC-SHA-256 digests: no raw IP address, email address or link
//   token is sent to or stored in the database.
// - Fixed windows: a block always ends when its window ends (no permanent
//   lockout).
// - Limits are configurable as RATE_LIMIT_<RULE>="<limit>/<window seconds>",
//   e.g. RATE_LIMIT_LOGIN_IP="100/900". RATE_LIMIT_ENABLED=false turns
//   limiting off entirely (for example while load-testing locally).
// - Backend failure: callers choose. Public pages and login FAIL OPEN (a
//   limiter outage must not take down sign-in or client links; Supabase
//   Auth has its own limits behind login). Expensive internal actions FAIL
//   CLOSED, because they need the same database anyway.
//
// This module talks to PostgREST directly with the server-only secret key,
// using a short timeout. It is used from src/proxy.ts, which is why it does
// not go through the "server-only" privileged client.

export type RateRule = { scope: string; limit: number; windowSeconds: number };

const DEFAULTS = {
  // Sign-in: per address + email, per email (any address) and per address.
  // Generous per address so a shared office isn't blocked.
  login_ip_email: { limit: 10, windowSeconds: 900 },
  login_email: { limit: 20, windowSeconds: 900 },
  login_ip: { limit: 100, windowSeconds: 900 },
  // Public client links. A normal visit is one page load plus one preview
  // request; refreshing and retries stay far below these.
  link_page_ip: { limit: 120, windowSeconds: 60 },
  link_preview_ip: { limit: 120, windowSeconds: 60 },
  link_preview_token: { limit: 300, windowSeconds: 60 },
  // Full Access links: viewing the complete PDF, and file downloads (PDF or
  // original), per address and per link.
  link_document_ip: { limit: 120, windowSeconds: 60 },
  link_document_token: { limit: 300, windowSeconds: 60 },
  link_download_ip: { limit: 30, windowSeconds: 600 },
  link_download_token: { limit: 60, windowSeconds: 600 },
  // Lookups of links that don't exist, per address. Over the limit, further
  // unknown links get "too many requests" until the window ends; valid
  // links are not affected.
  link_miss_ip: { limit: 30, windowSeconds: 600 },
  // Expensive internal actions, per signed-in user.
  upload_prepare_user: { limit: 30, windowSeconds: 600 },
  upload_complete_user: { limit: 30, windowSeconds: 600 },
  preview_generate_user: { limit: 30, windowSeconds: 600 },
  proposal_delete_user: { limit: 30, windowSeconds: 600 },
  // Payments (client side, per address; checkout also per link). Polling a
  // purchase every few seconds for a couple of minutes stays well below.
  checkout_ip: { limit: 20, windowSeconds: 600 },
  checkout_token: { limit: 30, windowSeconds: 600 },
  purchase_ip: { limit: 120, windowSeconds: 60 },
  purchase_document_ip: { limit: 60, windowSeconds: 60 },
  // Recovery: requests per address and per typed email; redemptions per address.
  recovery_ip: { limit: 10, windowSeconds: 900 },
  recovery_email: { limit: 5, windowSeconds: 900 },
  recovery_claim_ip: { limit: 20, windowSeconds: 900 },
  // Webhook deliveries per address (each costs a PayPal verification call).
  webhook_ip: { limit: 240, windowSeconds: 60 },
  // Dashboard: recovery links issued per signed-in user.
  recovery_issue_user: { limit: 30, windowSeconds: 600 },
} as const satisfies Record<string, { limit: number; windowSeconds: number }>;

export type RateRuleName = keyof typeof DEFAULTS;

export function rateRule(name: RateRuleName): RateRule {
  const fallback = DEFAULTS[name];
  const raw = process.env[`RATE_LIMIT_${name.toUpperCase()}`];
  const match = raw ? /^\s*(\d{1,7})\s*\/\s*(\d{1,5})\s*$/.exec(raw) : null;
  if (match) {
    const limit = Number(match[1]);
    const windowSeconds = Number(match[2]);
    if (limit >= 1 && limit <= 1_000_000 && windowSeconds >= 1 && windowSeconds <= 86_400) {
      return { scope: name, limit, windowSeconds };
    }
  }
  return { scope: name, ...fallback };
}

export function rateLimitingEnabled(): boolean {
  return (process.env.RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

let cachedKey: Buffer | null = null;

// HMAC key: RATE_LIMIT_KEY_SECRET when set, otherwise derived from the
// server-only Supabase secret key (never the key itself).
function hmacKey(): Buffer {
  if (cachedKey) return cachedKey;
  const explicit = process.env.RATE_LIMIT_KEY_SECRET;
  const base = explicit || process.env.SUPABASE_SECRET_KEY;
  if (!base) throw new Error("No rate-limit key available");
  cachedKey = explicit
    ? Buffer.from(explicit)
    : createHash("sha256").update("proposal-portal/rate-limit/v1\0").update(base).digest();
  return cachedKey;
}

export function rateKey(...parts: string[]): string {
  return createHmac("sha256", hmacKey()).update(parts.join("\u0000")).digest("hex");
}

export type RateDecision =
  | { status: "allowed"; remaining: number }
  | { status: "limited"; retryAfterSeconds: number }
  // The limiter couldn't be reached; the caller applies its failure policy.
  | { status: "error" };

const LIMITER_TIMEOUT_MS = 2_000;

// Records `cost` hits (0 = just read) and returns the decision.
export async function consumeRate(rule: RateRule, keyHash: string, cost = 1): Promise<RateDecision> {
  if (!rateLimitingEnabled()) return { status: "allowed", remaining: rule.limit };

  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) return { status: "error" };
  const { url } = getServerSupabaseConfig();

  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/rate_limit_consume`, {
      method: "POST",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        p_scope: rule.scope,
        p_key_hash: keyHash,
        p_limit: rule.limit,
        p_window_seconds: rule.windowSeconds,
        p_cost: cost,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(LIMITER_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[rate-limit] backend error", response.status);
      return { status: "error" };
    }
    const rows = (await response.json()) as {
      allowed: boolean;
      remaining: number;
      retry_after_seconds: number;
    }[];
    const row = rows?.[0];
    if (!row) return { status: "error" };
    return row.allowed
      ? { status: "allowed", remaining: row.remaining }
      : { status: "limited", retryAfterSeconds: Math.max(1, row.retry_after_seconds) };
  } catch {
    console.error("[rate-limit] backend unavailable");
    return { status: "error" };
  }
}

// Checks several rules; the first that is exceeded wins. All are counted
// (in parallel), so a request that is blocked still counts against each.
export async function consumeAll(checks: { rule: RateRule; key: string }[]): Promise<RateDecision> {
  const results = await Promise.all(checks.map(({ rule, key }) => consumeRate(rule, key)));
  const limited = results.filter((result) => result.status === "limited");
  if (limited.length > 0) {
    return {
      status: "limited",
      retryAfterSeconds: Math.max(...limited.map((result) => (result.status === "limited" ? result.retryAfterSeconds : 1))),
    };
  }
  if (results.some((result) => result.status === "error")) return { status: "error" };
  return { status: "allowed", remaining: Math.min(...results.map((r) => (r.status === "allowed" ? r.remaining : 0))) };
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
