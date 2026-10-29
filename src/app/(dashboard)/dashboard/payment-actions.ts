"use server";

import { z } from "zod";

import { getInternalUserOrReason } from "@/lib/auth/session";
import {
  DASHBOARD_RECOVERY_MINUTES,
  generateRecoveryToken,
  recoveryLink,
} from "@/lib/payments/recovery";
import { limitUserAction } from "@/lib/security/internal-limits";
import { issueRecovery } from "@/lib/supabase/privileged-payments";
import { createClient } from "@/lib/supabase/server";

// Payments tab actions. There is deliberately NO action that creates,
// edits or marks payments: payment records are written only by the
// checkout and PayPal verification code (service_role functions).
//
// issueRecoveryLinkAction: the payment's Team Lead (or the CEO) creates a
// single-use, expiring link that restores paid access in whichever browser
// opens and confirms it, and sends it to the client personally (proof of
// purchase via the person who knows the client, no email provider needed).
// The payment is first loaded through the user's RLS-scoped client, then
// the database re-checks owner-or-admin and that access is not suspended.

export type RecoveryLinkResult =
  | { ok: true; url: string; expiresAt: string }
  | { ok: false; message: string };

const schema = z.object({ paymentId: z.uuid() });

export async function issueRecoveryLinkAction(input: { paymentId: string }): Promise<RecoveryLinkResult> {
  const auth = await getInternalUserOrReason();
  if (!auth.ok) {
    return {
      ok: false,
      message:
        auth.reason === "unavailable"
          ? "The service is temporarily unavailable. Try again in a moment."
          : "Your session has expired. Sign in again to continue.",
    };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "This payment could not be found." };

  const supabase = await createClient();
  const { data: payment, error } = await supabase
    .from("payment_list")
    .select("id, status")
    .eq("id", parsed.data.paymentId)
    .maybeSingle();
  if (error) return { ok: false, message: "The service is temporarily unavailable. Try again in a moment." };
  if (!payment) return { ok: false, message: "This payment could not be found, or you don't have access to it." };
  if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
    return { ok: false, message: "Access links can only be created for completed payments." };
  }

  const limit = await limitUserAction("recovery_issue_user", auth.user.id, "access link");
  if (!limit.ok) return { ok: false, message: limit.message };

  const { token, hash } = generateRecoveryToken();
  const url = recoveryLink(token);
  if (!url) return { ok: false, message: "The app URL is not configured (NEXT_PUBLIC_APP_URL)." };

  const issued = await issueRecovery({
    actorId: auth.user.id,
    paymentId: payment.id,
    tokenHash: hash,
    ttlMinutes: DASHBOARD_RECOVERY_MINUTES,
  });
  if (!issued.ok) {
    if (issued.code === "PT423") return { ok: false, message: "Access for this payment is suspended (refunded or reversed)." };
    if (issued.code === "PT404") return { ok: false, message: "This payment could not be found, or you don't have access to it." };
    return { ok: false, message: "The service is temporarily unavailable. Try again in a moment." };
  }
  return { ok: true, url, expiresAt: issued.data };
}
