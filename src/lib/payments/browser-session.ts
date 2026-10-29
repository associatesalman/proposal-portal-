import "server-only";

import { createHash, randomBytes } from "node:crypto";

// The client's browser session for payments: one random 256-bit secret in an
// HttpOnly cookie. The database stores only its SHA-256 hash:
//   - payments.checkout_session_hash binds a checkout to the browser that
//     started it (only that browser can capture it or receive access);
//   - payment_access_sessions grant that browser access to a purchase.
// Forwarding the client link or a purchase URL never forwards the cookie,
// so it never forwards paid access.
//
// SameSite=Lax (not Strict): the buyer comes back from paypal.com with a
// top-level GET navigation, which must carry the cookie. State-changing
// requests are POSTs that additionally require a same-origin Origin header
// (see ./request-guard.ts). Secure whenever the app runs on HTTPS; the
// __Host- prefix (Secure, path=/, no Domain) is used there too.

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isHttpsApp(): boolean {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "").startsWith("https://");
}

export function sessionCookieName(): string {
  return isHttpsApp() ? "__Host-pp_session" : "pp_session";
}

export function hashSessionSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export type CookieReader = { get(name: string): { value: string } | undefined };

// Hash of this request's browser session, or null when there is none.
export function readSessionHash(cookies: CookieReader): string | null {
  const value = cookies.get(sessionCookieName())?.value;
  return value && SECRET_PATTERN.test(value) ? hashSessionSecret(value) : null;
}

export type IssuedSession = { secret: string; hash: string; isNew: boolean };

// Existing session, or a new one that the caller must set on its response.
export function ensureSession(cookies: CookieReader): IssuedSession {
  const value = cookies.get(sessionCookieName())?.value;
  if (value && SECRET_PATTERN.test(value)) return { secret: value, hash: hashSessionSecret(value), isNew: false };
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: hashSessionSecret(secret), isNew: true };
}

export function sessionCookieOptions(maxAgeDays: number) {
  return {
    httpOnly: true,
    secure: isHttpsApp(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeDays * 24 * 60 * 60,
  };
}

export type CookieWriter = {
  set(name: string, value: string, options: ReturnType<typeof sessionCookieOptions>): unknown;
};

// (Re)sets the cookie so its lifetime covers the paid access just granted.
export function writeSession(cookies: CookieWriter, secret: string, maxAgeDays: number) {
  cookies.set(sessionCookieName(), secret, sessionCookieOptions(maxAgeDays));
}
