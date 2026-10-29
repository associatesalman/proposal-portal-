import { cookies } from "next/headers";
import { connection } from "next/server";

import { ensureSession, writeSession } from "@/lib/payments/browser-session";
import { paymentAccessDays } from "@/lib/payments/config";
import { hashRecoveryToken, isWellFormedRecoveryToken } from "@/lib/payments/recovery";
import { isSameOriginRequest } from "@/lib/payments/request-guard";
import { limitPayment } from "@/lib/security/public-limits";
import { consumeRecovery } from "@/lib/supabase/privileged-payments";

// POST /purchase/recover/<token>/claim (form post from the recover page):
// redeems the single-use token atomically and gives THIS browser an access
// session, then redirects to the purchase page. Expired, used or unknown
// tokens go back to the recover page, which says so. Same-origin only,
// rate-limited per address (fails closed).

function redirect(location: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return new Response(null, {
    status: 303,
    headers: { Location: new URL(location, base).toString(), "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function POST(request: Request, ctx: RouteContext<"/purchase/recover/[token]/claim">) {
  await connection();
  const { token } = await ctx.params;
  if (!isSameOriginRequest(request)) return new Response("Forbidden", { status: 403 });
  if (!isWellFormedRecoveryToken(token)) return redirect("/purchase/recover/invalid");

  const limit = await limitPayment("recovery_claim_ip", request.headers);
  if (limit.status !== "allowed") {
    return new Response("Too many attempts. Wait a few minutes, then try again.", {
      status: limit.status === "limited" ? 429 : 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const store = await cookies();
  const session = ensureSession(store);
  const days = paymentAccessDays();
  const claimed = await consumeRecovery(hashRecoveryToken(token), session.hash, days);
  if (!claimed.ok) return new Response("Temporarily unavailable. Please try again.", { status: 503 });
  if (!claimed.data) return redirect(`/purchase/recover/${token}`);

  writeSession(store, session.secret, days);
  return redirect(`/purchase/${claimed.data}`);
}
