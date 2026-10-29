import { connection } from "next/server";

import { deliverFullDocument } from "@/lib/proposals/full-delivery";

// GET /p/<token>/document: the complete canonical PDF of a Full Access link,
// inline, for the client page's viewer. Preview links get 404. See
// src/lib/proposals/full-delivery.ts.
export async function GET(request: Request, ctx: RouteContext<"/p/[token]/document">) {
  await connection();
  const { token } = await ctx.params;
  return deliverFullDocument(request, token, "document");
}
