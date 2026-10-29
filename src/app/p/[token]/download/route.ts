import { connection } from "next/server";

import { deliverFullDocument } from "@/lib/proposals/full-delivery";

// GET /p/<token>/download: the complete canonical PDF of a Full Access link
// as a file download ("Download PDF"). Preview links get 404. See
// src/lib/proposals/full-delivery.ts.
export async function GET(request: Request, ctx: RouteContext<"/p/[token]/download">) {
  await connection();
  const { token } = await ctx.params;
  return deliverFullDocument(request, token, "download");
}
