import "server-only";

import { consumeRate, formatWait, rateKey, rateRule, type RateRuleName } from "./rate-limit";

// Per-user limits for expensive dashboard actions (upload tickets, PDF
// verification, preview generation). Keyed by the verified user id, never
// by anything the browser sends. These FAIL CLOSED: if the limiter can't be
// reached, the action is refused (it needs the same database anyway).

export type UserLimit = { ok: true } | { ok: false; message: string };

export async function limitUserAction(
  name: Extract<RateRuleName, `${string}_user`>,
  userId: string,
  action: string,
): Promise<UserLimit> {
  const decision = await consumeRate(rateRule(name), rateKey("user", userId));
  if (decision.status === "allowed") return { ok: true };
  if (decision.status === "limited") {
    return {
      ok: false,
      message: `Too many ${action} attempts in a short time. Try again in ${formatWait(decision.retryAfterSeconds)}.`,
    };
  }
  return { ok: false, message: "The service is temporarily unavailable. Nothing was saved. Try again in a moment." };
}
