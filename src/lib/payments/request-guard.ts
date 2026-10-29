import "server-only";

// Cross-origin protection for the client-facing payment POST endpoints
// (checkout, capture/status, cancel, recovery). The browser session cookie
// is SameSite=Lax, which already keeps it off cross-site POSTs; on top of
// that a request must come from this app's own origin:
//   - Origin must be present and equal NEXT_PUBLIC_APP_URL's origin;
//   - Sec-Fetch-Site, when the browser sends it, must be "same-origin".
// The webhook endpoint is server-to-server and uses PayPal's signature
// verification instead.

export function isSameOriginRequest(request: Request): boolean {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return false;
  let expected: string;
  try {
    expected = new URL(base).origin;
  } catch {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin || origin !== expected) return false;
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...headers,
    },
  });
}
