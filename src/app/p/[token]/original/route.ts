import { connection } from "next/server";

import { deliverFullDocument } from "@/lib/proposals/full-delivery";

// GET /p/<token>/original: the original upload (DOCX, DOC, ODT, RTF or TXT)
// of a Full Access link as a file download ("Download original"). 404 for
// preview links and for documents uploaded as PDF. See
// src/lib/proposals/full-delivery.ts.
export async function GET(request: Request, ctx: RouteContext<"/p/[token]/original">) {
  await connection();
  const { token } = await ctx.params;
  return deliverFullDocument(request, token, "original");
}
