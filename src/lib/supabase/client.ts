import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseConfig } from "@/lib/supabase/config";
import type { Database } from "@/types/database";

// Browser client for Client Components. It acts as the signed-in user, so
// every query is limited by RLS. Never use it to make authorization decisions.
export function createClient() {
  const { url, publishableKey } = getSupabaseConfig();
  return createBrowserClient<Database>(url, publishableKey);
}
