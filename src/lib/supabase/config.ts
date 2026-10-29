// Public Supabase connection settings. Both values are safe to expose to the
// browser; privileges are enforced by Postgres RLS, not by keeping these secret.
// The NEXT_PUBLIC_ variables must be referenced literally so Next.js can inline them.

export type SupabaseConfig = {
  url: string;
  publishableKey: string;
};

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

export function getSupabaseConfig(): SupabaseConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local (see docs/PHASE_2_SETUP.md).",
    );
  }

  return { url, publishableKey };
}

// Server-side code may reach Supabase through a different address than the
// browser (e.g. an internal hostname). SUPABASE_SERVER_URL is optional and
// read at runtime; it is also how the Phase 7 outage tests point a dedicated
// server process at a simulated outage. Never used in browser code.
export function getServerSupabaseConfig(): SupabaseConfig {
  const config = getSupabaseConfig();
  const serverUrl = typeof window === "undefined" ? process.env.SUPABASE_SERVER_URL : undefined;
  return serverUrl ? { ...config, url: serverUrl } : config;
}
