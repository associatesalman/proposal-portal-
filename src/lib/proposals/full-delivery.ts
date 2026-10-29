import "server-only";

import { formatInfo } from "@/lib/documents/formats";
import { isWellFormedToken } from "@/lib/proposals/links";
import { limitLinkDocument, recordLinkMiss, tooManyRequests } from "@/lib/security/public-limits";
import { openFullDocumentForLink } from "@/lib/supabase/privileged";

// Delivery of a Full Access link's complete document:
//   /p/<token>/document  the canonical PDF, inline (the viewer fetches it)
//   /p/<token>/download  the canonical PDF as a file download
//   /p/<token>/original  the original upload (DOCX, DOC, ODT, RTF, TXT) as
//                        a download; 404 when the upload was a PDF
//
// Same rules as the preview endpoint (src/app/p/[token]/preview/route.ts):
// the token is the ONLY input (query strings, headers and other segments
// are ignored, so nothing can name a path, proposal, revision or mode); it
// is checked against the database on every request; only a link in Full
// Access mode with an open grant for the current revision resolves, so a
// preview token gets the same 404 as a revoked or unknown one. Objects are
// streamed from the private bucket (no storage URLs), with no-store,
// nosniff, no-referrer and same-origin resource policy. Rate-limited per
// address and per link; unknown links count toward the miss limit.
//
// Once downloaded, a file is outside the portal's control: revoking the
// link stops further access but can't remove copies already saved.

export type FullDeliveryKind = "document" | "download" | "original";

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

// A download name from the (public) title: ASCII fallback plus an RFC 5987
// UTF-8 name. Never a storage path or id.
export function downloadName(title: string, extension: string): { ascii: string; utf8: string } {
  const base = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120)
    .trim();
  const safeBase = base || "proposal";
  const ascii =
    safeBase
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["%;\\]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "proposal";
  return { ascii: `${ascii}.${extension}`, utf8: `${safeBase}.${extension}` };
}

function contentDisposition(type: "inline" | "attachment", title: string, extension: string) {
  const name = downloadName(title, extension);
  return `${type}; filename="${name.ascii}"; filename*=UTF-8''${encodeURIComponent(name.utf8)}`;
}

export async function deliverFullDocument(request: Request, token: string, kind: FullDeliveryKind): Promise<Response> {
  const decision = await limitLinkDocument(request.headers, token, kind === "document" ? "view" : "download");
  if (decision.status === "limited") {
    return tooManyRequests(decision.retryAfterSeconds, "Too many requests. Wait a moment and try again.");
  }

  if (!isWellFormedToken(token)) return notAvailable(request);

  let result;
  try {
    result = await openFullDocumentForLink(token, kind === "original" ? "original" : "pdf");
  } catch {
    console.error("[full-access] delivery failed");
    return plain(503, "The document is temporarily unavailable.", { "Retry-After": "5" });
  }

  if (!result.ok) {
    if (result.reason === "unavailable") return notAvailable(request);
    console.error(`[full-access] ${result.reason === "missing" ? "document object missing" : "storage read failed"}`);
    return plain(503, "The document is temporarily unavailable.", { "Retry-After": "5" });
  }

  const format = result.format ? formatInfo(result.format) : formatInfo("pdf");
  return new Response(result.stream, {
    status: 200,
    headers: {
      "Content-Type": format.mime,
      "Content-Disposition": contentDisposition(
        kind === "document" ? "inline" : "attachment",
        result.title,
        format.extension,
      ),
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}
