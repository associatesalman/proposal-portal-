import "server-only";

import { createHash, randomBytes } from "node:crypto";

// Private link tokens: 32 random bytes (256 bits) from the OS CSPRNG,
// base64url-encoded to 43 characters. Not derived from ids, names or emails.
// Only the SHA-256 hash is stored; the raw token exists in the response that
// creates it and in the link itself. Never log tokens or link URLs.

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateLinkToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

// Hosts that only resolve on this machine or private network: a link built
// on them can't be opened by an external client.
function isLocalOnlyHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".test") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export type BuiltLink = { url: string; localOnly: boolean };

// Absolute URL from the configured base, never from request headers.
export function buildProposalLink(token: string): BuiltLink {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) throw new Error("NEXT_PUBLIC_APP_URL is not set.");
  const url = new URL(`/p/${token}`, base);
  return { url: url.toString(), localOnly: isLocalOnlyHost(url.hostname) };
}
