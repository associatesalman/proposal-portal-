import { connection } from "next/server";

import { isWellFormedToken } from "@/lib/proposals/links";
import { limitLinkPreview, recordLinkMiss, tooManyRequests } from "@/lib/security/public-limits";
import { openPreviewForLink } from "@/lib/supabase/privileged";

// GET /p/<token>/preview: the free-preview PDF of the proposal the token
// resolves to, streamed through the app from the private bucket.
//
// - The token is validated on EVERY request (format, then the hash match on
//   an active proposal in the database) before storage is touched. Revoking
//   a link therefore blocks the very next request; nothing is cached.
// - The only input is the token. Query strings, other path segments and
//   headers are ignored, so no request can name a storage path or proposal
//   id. Only the preview object is ever read; the original never is.
// - Invalid, malformed, revoked and inactive links get the same 404. A
//   valid link whose preview is missing or unreadable gets 503, which the
//   viewer shows as a retryable error (the page has already shown the title
//   to the holder of a valid link, so this reveals nothing new).
// - Requests are rate-limited per client address and per link (hashed
//   keys; fails open, see src/lib/security/public-limits.ts). Lookups of
//   unknown links count toward the address's miss limit. Over a limit the
//   answer is 429 with Retry-After.
// - The token is never logged. Request logging of /p/* is disabled in
//   next.config.ts, which also adds no-store / no-referrer / noindex here.

const NO_STORE = "private, no-store, max-age=0";

function plain(status: number, message: string, extra: Record<string, string> = {}) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

async function notAvailable(request: Request) {
  const misses = await recordLinkMiss(request.headers);
  if (misses.status === "limited") {
    return tooManyRequests(misses.retryAfterSeconds, "Too many requests. Wait a moment and try again.");
  }
  return plain(404, "This link isn't available.");
}

export async function GET(request: Request, ctx: RouteContext<"/p/[token]/preview">) {
  await connection();
  const { token } = await ctx.params;

  const decision = await limitLinkPreview(request.headers, token);
  if (decision.status === "limited") {
    return tooManyRequests(decision.retryAfterSeconds, "Too many requests. Wait a moment and try again.");
  }

  if (!isWellFormedToken(token)) return notAvailable(request);

  let preview;
  try {
    preview = await openPreviewForLink(token);
  } catch {
    console.error("[preview] delivery failed");
    return plain(503, "The preview is temporarily unavailable.", { "Retry-After": "5" });
  }

  if (!preview.ok) {
    if (preview.reason === "unavailable") return notAvailable(request);
    console.error(`[preview] ${preview.reason === "missing" ? "preview object missing" : "storage read failed"}`);
    return plain(503, "The preview is temporarily unavailable.", { "Retry-After": "5" });
  }

  return new Response(preview.stream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="preview.pdf"',
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      // Only this origin's viewer may load it (no cross-site embedding).
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}
