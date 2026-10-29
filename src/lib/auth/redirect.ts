export const DEFAULT_AUTHENTICATED_PATH = "/dashboard";

const INTERNAL_ORIGIN = "http://internal.invalid";

// Returns a same-origin path to redirect to after sign-in, or the default.
// Rejects absolute URLs, protocol-relative URLs (//evil.com), backslash
// tricks (/\evil.com), control characters and redirects back to /login.
export function getSafeRedirectPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return DEFAULT_AUTHENTICATED_PATH;
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_AUTHENTICATED_PATH;
  }

  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "\\") {
      return DEFAULT_AUTHENTICATED_PATH;
    }
  }

  try {
    const url = new URL(value, INTERNAL_ORIGIN);
    if (url.origin !== INTERNAL_ORIGIN || url.pathname === "/login") {
      return DEFAULT_AUTHENTICATED_PATH;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_AUTHENTICATED_PATH;
  }
}
