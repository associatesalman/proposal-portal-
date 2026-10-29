import "server-only";

import { createHash, randomBytes } from "node:crypto";

// Single-use, expiring recovery tokens that restore paid access in another
// browser. 256 random bits, base64url; only the SHA-256 hash is stored.
// A token is redeemed by an explicit POST from the page it opens, never by
// the GET itself, so link scanners in mail clients can't use it up.

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Emailed links: short-lived. Dashboard links: the Team Lead sends them
// through their own channel, so they get a little longer.
export const EMAIL_RECOVERY_MINUTES = 30;
export const DASHBOARD_RECOVERY_MINUTES = 72 * 60;

export function generateRecoveryToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRecoveryToken(token) };
}

export function hashRecoveryToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedRecoveryToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function recoveryLink(token: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return null;
  return new URL(`/purchase/recover/${token}`, base).toString();
}
