import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getServerSupabaseConfig } from "@/lib/supabase/config";
import { createBoundedFetch, type BoundedFetch } from "@/lib/supabase/fetch";
import type { Database } from "@/types/database";

// Request-scoped client for Server Components, Server Actions and Route
// Handlers. Create a new one per request; never share it across requests.
// It acts as the signed-in user, so every query is limited by RLS.
// Network waits are bounded (src/lib/supabase/fetch.ts); `boundedFetch` is
// exposed so auth calls can be given a deadline with withAuthDeadline().
export async function createClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = getServerSupabaseConfig();
  const boundedFetch = createBoundedFetch();

  const client = createServerClient<Database>(url, publishableKey, {
    global: { fetch: boundedFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Components cannot write cookies. Session refresh is handled
          // by src/proxy.ts, so this is safe to ignore there.
        }
      },
    },
  });
  return Object.assign(client, { boundedFetch }) as typeof client & { boundedFetch: BoundedFetch };
}
