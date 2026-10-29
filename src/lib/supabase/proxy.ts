import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getServerSupabaseConfig, isSupabaseConfigured } from "@/lib/supabase/config";
import { createBoundedFetch, isUnavailableError, withAuthDeadline } from "@/lib/supabase/fetch";
import type { Database } from "@/types/database";

// Internal request header: set ONLY by the proxy (any incoming copy is
// removed) when Supabase Auth didn't answer in time, so the page can show
// "temporarily unavailable" at once instead of waiting a second time. It can
// only ever make a request see LESS (it never grants access), so a forged
// value would only affect the sender.
export const AUTH_UNAVAILABLE_HEADER = "x-portal-auth-unavailable";

export type SessionStatus = "authenticated" | "anonymous" | "unavailable";

type SessionResult = {
  response: NextResponse;
  status: SessionStatus;
};

// Refreshes the Supabase auth session on each request and forwards updated
// cookies to both the downstream request and the browser response.
// The result is only used for coarse redirects; pages, actions and route
// handlers still verify the user and their profile themselves.
//
// When Supabase Auth is unreachable or slow, the status is "unavailable":
// the request continues WITHOUT any cookie changes (an outage never signs
// anyone out) and without a redirect to /login (no loops); the page then
// denies protected data and shows a retry state.
// Continues the request with its current headers (including any refreshed
// cookies), minus any client-supplied copy of the internal header.
function next(request: NextRequest, unavailable = false) {
  const headers = new Headers(request.headers);
  headers.delete(AUTH_UNAVAILABLE_HEADER);
  if (unavailable) headers.set(AUTH_UNAVAILABLE_HEADER, "1");
  return NextResponse.next({ request: { headers } });
}

export async function updateSession(request: NextRequest): Promise<SessionResult> {
  let response = next(request);

  if (!isSupabaseConfigured()) {
    return { response, status: "anonymous" };
  }

  const { url, publishableKey } = getServerSupabaseConfig();
  const boundedFetch = createBoundedFetch();

  const supabase = createServerClient<Database>(url, publishableKey, {
    global: { fetch: boundedFetch },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = next(request);
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        Object.entries(headers).forEach(([key, value]) =>
          response.headers.set(key, value),
        );
      },
    },
  });

  // getClaims() validates the JWT (signature / Auth server) and refreshes an
  // expired session. Do not run other code between client creation and this call.
  const result = await withAuthDeadline(boundedFetch, () => supabase.auth.getClaims());

  if (!result.ok || (result.value.error && isUnavailableError(result.value.error))) {
    // A fresh response discards anything the client queued: no cookie
    // changes reach the browser.
    return { response: next(request, true), status: "unavailable" };
  }

  const { data, error } = result.value;
  return {
    response,
    status: !error && data?.claims?.sub ? "authenticated" : "anonymous",
  };
}
