"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/supabase/config";
import { withAuthDeadline } from "@/lib/supabase/fetch";
import { createClient } from "@/lib/supabase/server";

export async function signOut() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    // Ends this browser's session only; other devices stay signed in. The
    // local cookies are cleared even if Supabase Auth can't be reached, and
    // the wait for it is bounded.
    const result = await withAuthDeadline(supabase.boundedFetch, () => supabase.auth.signOut({ scope: "local" }));
    if (!result.ok) {
      // Supabase didn't answer in time: the user asked to sign out, so
      // remove this browser's session cookies directly. (The server-side
      // session can't be revoked during the outage; this browser no longer
      // holds its tokens.)
      const cookieStore = await cookies();
      for (const { name } of cookieStore.getAll()) {
        if (/^sb-.+-auth-token(?:\.\d+)?$/.test(name)) cookieStore.delete(name);
      }
    }
  }

  redirect("/login");
}
