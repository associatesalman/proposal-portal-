import { NextResponse, type NextRequest } from "next/server";

import { limitLinkPage, tooManyRequests } from "@/lib/security/public-limits";
import { updateSession } from "@/lib/supabase/proxy";

const PROTECTED_PREFIXES = ["/dashboard"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const RATE_LIMITED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Too many requests</title>
<style>body{font:16px/1.5 system-ui,sans-serif;color:#0b1e44;background:#fff;margin:0;padding:48px 16px}
main{max-width:32rem;margin:0 auto}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#475569}</style></head>
<body><main><h1>Too many requests</h1><p>This page was opened too many times in a short period. Wait a moment, then reload the page.</p></main></body></html>`;

export async function proxy(request: NextRequest) {
  // Private client links (/p/<token>): no internal session is involved; the
  // proxy only applies the public rate limit (fails open, see
  // src/lib/security/public-limits.ts). The preview endpoint applies its own.
  // Purchase pages (/purchase/<ref>, /purchase/recover/<token>) are public
  // too and get the same page limit; their endpoints limit themselves.
  if (request.nextUrl.pathname.startsWith("/p/") || request.nextUrl.pathname.startsWith("/purchase/")) {
    const decision = await limitLinkPage(request.headers);
    if (decision.status === "limited") {
      return tooManyRequests(decision.retryAfterSeconds, RATE_LIMITED_PAGE, "text/html; charset=utf-8");
    }
    return NextResponse.next();
  }

  const { response, status } = await updateSession(request);

  // "unavailable" is NOT redirected: the page shows a retry state and loads
  // no protected data. Only a definite "signed out" goes to /login.
  if (status === "anonymous" && isProtectedPath(request.nextUrl.pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", request.nextUrl.pathname);

    const redirect = NextResponse.redirect(loginUrl);
    // Keep any cookie changes (e.g. a cleared expired session).
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, image optimization, the PDF.js assets,
    // the scheduler endpoint (api/cron/, authenticated by its own secret),
    // the PayPal webhook (api/payments/, verified by signature), and private
    // client links and purchase pages (handled by the entries below).
    "/((?!_next/static|_next/image|favicon.ico|p/|purchase/|pdfjs/|api/cron/|api/payments/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
    // The client link page only (one segment). Its /preview endpoint
    // rate-limits itself in the route handler.
    "/p/:token",
    // Purchase pages only; /status, /document and /claim limit themselves.
    "/purchase/:ref",
    "/purchase/recover/:token",
  ],
};
