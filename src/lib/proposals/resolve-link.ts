import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getServerSupabaseConfig } from "@/lib/supabase/config";
import { createBoundedFetch } from "@/lib/supabase/fetch";
import type { Database } from "@/types/database";

import { isCurrencyCode, type CurrencyCode } from "./currencies";
import { isWellFormedToken } from "./links";

// Resolves a private link token to the fields the client page shows: title,
// page counts and the unlock price (resolve_proposal_offer). Uses the
// publishable (anon) key; the database function hashes the token and matches active, fully prepared proposals only. No privileged key, no
// cookies, no table access, and no ids, owner, client, paths or hashes.
// Unknown, malformed, revoked and inactive tokens all give "not_found";
// a database that can't be reached gives "error", so the page can offer a
// retry instead of wrongly saying the link is dead.

export type ResolvedProposalLink = {
  title: string;
  totalPages: number;
  freePages: number;
  lockedPages: number;
  priceMinor: number;
  currency: CurrencyCode;
};

export type LinkResolution =
  | { status: "found"; proposal: ResolvedProposalLink }
  | { status: "not_found" }
  | { status: "error" };

export async function resolveProposalLink(token: string): Promise<LinkResolution> {
  if (!isWellFormedToken(token)) return { status: "not_found" };

  const { url, publishableKey } = getServerSupabaseConfig();
  const supabase = createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createBoundedFetch() },
  });

  const offer = await supabase.rpc("resolve_proposal_offer", { p_token: token });
  const error = offer.error;
  if (error) {
    // Never include the token in logs.
    console.error("[links] resolve failed", error.code || "network");
    return { status: "error" };
  }

  const row = offer.data?.[0];
  if (!row || !isCurrencyCode(row.currency)) return { status: "not_found" };
  if (!(row.free_preview_pages >= 1 && row.free_preview_pages < row.total_pages)) return { status: "not_found" };
  const proposal: ResolvedProposalLink = {
    title: row.title,
    totalPages: row.total_pages,
    freePages: row.free_preview_pages,
    lockedPages: row.total_pages - row.free_preview_pages,
    priceMinor: row.unlock_price_minor,
    currency: row.currency,
  };
  return { status: "found", proposal };
}
