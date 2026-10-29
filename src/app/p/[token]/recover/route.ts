import { connection } from "next/server";
import { z } from "zod";

import { isRecoveryEmailConfigured, sendRecoveryEmail } from "@/lib/payments/email";
import { EMAIL_RECOVERY_MINUTES, generateRecoveryToken, recoveryLink } from "@/lib/payments/recovery";
import { isSameOriginRequest, jsonResponse } from "@/lib/payments/request-guard";
import { isWellFormedToken } from "@/lib/proposals/links";
import { limitPayment } from "@/lib/security/public-limits";
import { requestRecovery } from "@/lib/supabase/privileged-payments";

// POST /p/<token>/recover { email }: emails a single-use recovery link when
// the address matches the PayPal payer or the portal client of an ACTIVE
// purchase of this link's proposal. The response never says whether it
// matched. Unavailable (503) unless an email provider is configured
// (src/lib/payments/email.ts). Rate-limited per address and per typed email,
// failing closed.

const BODY = z.object({ email: z.email().max(320) });
const ANSWER =
  "If that address matches a completed payment for this proposal, we've sent it a link that restores access. It works once and expires in 30 minutes.";

export async function POST(request: Request, ctx: RouteContext<"/p/[token]/recover">) {
  await connection();
  const { token } = await ctx.params;

  if (!isRecoveryEmailConfigured()) {
    return jsonResponse(503, { message: "Restoring access by email isn't available. Please contact the person who sent you this link." });
  }
  if (!isSameOriginRequest(request)) return jsonResponse(403, { message: "Forbidden." });
  if (!isWellFormedToken(token)) return jsonResponse(404, { message: "This link isn't available." });

  let email: string;
  try {
    email = BODY.parse(await request.json()).email.trim().toLowerCase();
  } catch {
    return jsonResponse(400, { message: "Enter a valid email address." });
  }

  const limit = await limitPayment("recovery_ip", request.headers, { rule: "recovery_email", value: email });
  if (limit.status === "limited") {
    return jsonResponse(429, { message: "Too many requests. Wait a few minutes, then try again." }, { "Retry-After": String(limit.retryAfterSeconds) });
  }
  if (limit.status === "error") return jsonResponse(503, { message: "This is temporarily unavailable. Please try again in a moment." });

  const { token: recoveryToken, hash } = generateRecoveryToken();
  const issued = await requestRecovery({ token, email, tokenHash: hash, ttlMinutes: EMAIL_RECOVERY_MINUTES });
  if (!issued.ok) return jsonResponse(503, { message: "This is temporarily unavailable. Please try again in a moment." });

  const link = recoveryLink(recoveryToken);
  if (issued.data && link) {
    const sent = await sendRecoveryEmail({ to: email, link, title: issued.data.title, expiresMinutes: EMAIL_RECOVERY_MINUTES });
    if (!sent) console.error("[recovery] email not sent");
  }
  return jsonResponse(200, { message: ANSWER });
}
