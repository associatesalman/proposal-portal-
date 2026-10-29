import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { isUnavailableError, withAuthDeadline } from "@/lib/supabase/fetch";
import { AUTH_UNAVAILABLE_HEADER } from "@/lib/supabase/proxy";
import { createClient } from "@/lib/supabase/server";
import type { AppRole } from "@/types/database";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type InternalUser = {
  id: string;
  email: string | null;
  fullName: string;
  role: AppRole;
};

export type AuthState =
  | { status: "anonymous" }
  // Valid Supabase session, but no internal profile: must be denied.
  | { status: "unauthorized"; userId: string }
  | { status: "authorized"; user: InternalUser }
  // Supabase (Auth or the database) couldn't be reached or timed out. The
  // identity is UNKNOWN: callers must deny access to protected data, but
  // must not treat it as signed out (no redirect to /login, no session
  // changes), so a transient outage never signs anyone out.
  | { status: "unavailable" };

// Loads the caller's internal profile. The role comes only from
// public.profiles (readable for the caller's own row via RLS), never from
// user/app metadata or anything the browser sends.
export async function loadInternalUser(supabase: ServerSupabaseClient): Promise<AuthState> {
  // getUser() asks the Supabase Auth server to validate the session, so a
  // forged or revoked cookie is rejected. It is given a deadline.
  const result = await withAuthDeadline(supabase.boundedFetch, () => supabase.auth.getUser());
  if (!result.ok) return { status: "unavailable" };

  const {
    data: { user },
    error,
  } = result.value;

  if (error) {
    // A definite answer (no session, invalid or expired token) means signed
    // out; a network failure or 5xx means "don't know".
    return isUnavailableError(error) ? { status: "unavailable" } : { status: "anonymous" };
  }
  if (!user) return { status: "anonymous" };

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    if (isUnavailableError(profileError)) return { status: "unavailable" };
    // Anything else (e.g. a permission error) is a genuine fault, not an
    // outage: surface it rather than hiding it as "unavailable".
    throw new Error("Unable to load the internal profile.");
  }

  if (!profile) {
    return { status: "unauthorized", userId: user.id };
  }

  return {
    status: "authorized",
    user: {
      id: profile.id,
      email: user.email ?? null,
      fullName: profile.full_name,
      role: profile.role,
    },
  };
}

// Per-request memoized auth state for Server Components.
export const getAuthState = cache(async (): Promise<AuthState> => {
  // Auth state is per-request private data: never part of a prerender (the
  // Supabase client reads the clock, which Cache Components forbids there).
  await connection();
  // The proxy already found Supabase Auth unreachable for this request:
  // don't wait for it a second time. (This can only deny, never allow.)
  if ((await headers()).get(AUTH_UNAVAILABLE_HEADER) === "1") return { status: "unavailable" };
  const supabase = await createClient();
  return loadInternalUser(supabase);
});

// For Server Actions and Route Handlers: returns the verified internal user,
// or null (signed out, no profile, or Supabase unavailable). Callers must
// reject the request when this is null.
export async function getInternalUser(): Promise<InternalUser | null> {
  const state = await getAuthState();
  return state.status === "authorized" ? state.user : null;
}

// Like getInternalUser, but tells an outage apart from a missing session so
// actions can show the right message.
export async function getInternalUserOrReason(): Promise<
  { ok: true; user: InternalUser } | { ok: false; reason: "signed_out" | "unavailable" }
> {
  const state = await getAuthState();
  if (state.status === "authorized") return { ok: true, user: state.user };
  return { ok: false, reason: state.status === "unavailable" ? "unavailable" : "signed_out" };
}

export type PageUser = { status: "ok"; user: InternalUser } | { status: "unavailable" };

// For pages: redirects anyone who is not an authorized internal user. When
// Supabase is unavailable it returns { status: "unavailable" } so the page
// can render a "temporarily unavailable" state WITHOUT loading any data
// (fail closed) and without redirecting (no loops, no sign-out).
export async function requireInternalUser(): Promise<PageUser> {
  const state = await getAuthState();

  if (state.status === "anonymous") {
    redirect("/login");
  }

  if (state.status === "unauthorized") {
    redirect("/login?error=no_access");
  }

  if (state.status === "unavailable") {
    return { status: "unavailable" };
  }

  return { status: "ok", user: state.user };
}
