import { cookies } from "next/headers";
import { connection } from "next/server";

import { readSessionHash } from "@/lib/payments/browser-session";
import { isPublicRef } from "@/lib/payments/refs";
import { limitPayment, tooManyRequests } from "@/lib/security/public-limits";
import { openPurchasedDocument } from "@/lib/supabase/privileged-payments";

// GET /purchase/<ref>/document: the complete purchased PDF, streamed from
// the private bucket. Authorized on EVERY request in the database: this
// browser's session must hold an unexpired, unrevoked access session for an
// ACTIVE entitlement of this purchase (suspended after a full refund or
// reversal). The file is the exact revision that was bought, even if the
// proposal's document or link changed since. Nothing is cached, and the
// response can't be embedded or read cross-site. `?download=1` (the paid
// view's "Download PDF") only switches the response to an attachment; the
// authorization is identical.

const NO_STORE = "private, no-store, max-age=0";

function plain(status: number, message: string, extra: Record<string, string> = {}) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE, "X-Content-Type-Options": "nosniff", ...extra },
  });
}

export async function GET(request: Request, ctx: RouteContext<"/purchase/[ref]/document">) {
  await connection();
  const { ref } = await ctx.params;
  const asDownload = new URL(request.url).searchParams.get("download") === "1";

  // Same-origin fetches (the viewer) or direct navigation only.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return plain(403, "Forbidden");

  const limit = await limitPayment("purchase_document_ip", request.headers);
  if (limit.status === "limited") {
    return tooManyRequests(limit.retryAfterSeconds, "Too many requests. Wait a moment and try again.");
  }
  if (!isPublicRef(ref)) return plain(404, "Not available.");

  const sessionHash = readSessionHash(await cookies());
  if (!sessionHash) return plain(404, "Not available.");

  let document;
  try {
    document = await openPurchasedDocument(ref, sessionHash);
  } catch {
    console.error("[purchase] document delivery failed");
    return plain(503, "The document is temporarily unavailable.", { "Retry-After": "5" });
  }
  if (!document.ok) {
    if (document.reason === "denied") return plain(404, "Not available.");
    console.error(`[purchase] ${document.reason === "missing" ? "purchased file missing" : "storage read failed"}`);
    return plain(503, "The document is temporarily unavailable.", { "Retry-After": "5" });
  }

  return new Response(document.stream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="proposal.pdf"`,
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}
