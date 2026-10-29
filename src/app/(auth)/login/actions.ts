"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getSafeRedirectPath } from "@/lib/auth/redirect";
import { loadInternalUser } from "@/lib/auth/session";
import { clientAddress } from "@/lib/security/client-ip";
import { consumeAll, formatWait, rateKey, rateRule } from "@/lib/security/rate-limit";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isUnavailableError, withAuthDeadline } from "@/lib/supabase/fetch";
import { createClient } from "@/lib/supabase/server";
import { loginSchema } from "@/lib/validation/auth";

import { CONNECTION_ERROR, type LoginState } from "./state";

const INVALID_CREDENTIALS = "Invalid email or password.";

// Sign-in attempts are limited per address + email, per email and per
// address (src/lib/security/rate-limit.ts). The same limits apply whether
// or not the email belongs to an account, so the response never reveals
// that. If the limiter itself is unavailable, sign-in continues (fail open):
// Supabase Auth's own rate limits still apply behind it.
async function limitLogin(email: string) {
  const address = clientAddress(await headers());
  const normalizedEmail = email.toLowerCase();
  return consumeAll([
    { rule: rateRule("login_ip_email"), key: rateKey("login", address, normalizedEmail) },
    { rule: rateRule("login_email"), key: rateKey("login-email", normalizedEmail) },
    { rule: rateRule("login_ip"), key: rateKey("login-ip", address) },
  ]);
}

export async function login(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const rawEmail = formData.get("email");
  const email = typeof rawEmail === "string" ? rawEmail.trim().slice(0, 320) : "";

  const parsed = loginSchema.safeParse({
    email: rawEmail,
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    return {
      status: "error",
      message: "Check the highlighted fields and try again.",
      fieldErrors: {
        email: fieldErrors.email?.[0],
        password: fieldErrors.password?.[0],
      },
      email,
    };
  }

  if (!isSupabaseConfigured()) {
    return {
      status: "error",
      message: "Sign-in is not configured yet. Contact your administrator.",
      email,
    };
  }

  const limit = await limitLogin(parsed.data.email);
  if (limit.status === "limited") {
    return {
      status: "error",
      kind: "rate_limited",
      message: `Too many sign-in attempts. Wait ${formatWait(limit.retryAfterSeconds)} and try again.`,
      retryAfterSeconds: limit.retryAfterSeconds,
      email,
    };
  }
  if (limit.status === "error") console.error("[login] rate limiter unavailable; continuing");

  const supabase = await createClient();
  const attempt = await withAuthDeadline(supabase.boundedFetch, () =>
    supabase.auth.signInWithPassword(parsed.data),
  );
  if (!attempt.ok) {
    return { status: "error", kind: "connection", message: CONNECTION_ERROR, email };
  }
  const { error } = attempt.value;

  if (error) {
    // The auth service is down or unreachable: say so rather than blaming
    // the password.
    if (isUnavailableError(error)) {
      return { status: "error", kind: "connection", message: CONNECTION_ERROR, email };
    }
    if (error.status === 429) {
      return {
        status: "error",
        message: "Too many sign-in attempts. Wait a few minutes and try again.",
        email,
      };
    }
    // Same message for unknown email, wrong password, disabled account, etc.
    return { status: "error", message: INVALID_CREDENTIALS, email };
  }

  // A valid Supabase login is not enough: the account must also have an
  // internal profile provisioned by an administrator.
  const auth = await loadInternalUser(supabase);

  if (auth.status === "unavailable") {
    // The session is valid but the profile couldn't be checked. Keep the
    // session (an outage must not sign anyone out); the next page load
    // checks the profile again and nothing protected is shown until then.
    return { status: "error", kind: "connection", message: CONNECTION_ERROR, email };
  }

  if (auth.status !== "authorized") {
    await supabase.auth.signOut({ scope: "local" });
    return {
      status: "error",
      message: "This account is not authorized to use the portal. Contact your administrator.",
      email,
    };
  }

  redirect(getSafeRedirectPath(formData.get("next")));
}
