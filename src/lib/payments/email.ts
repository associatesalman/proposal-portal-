import "server-only";

// Email adapter for paid-access recovery links. Isolated so the provider
// can be swapped without touching the recovery flow. Server-only settings:
//
//   RECOVERY_EMAIL_PROVIDER=resend   the only adapter implemented
//   RESEND_API_KEY                   provider API key (secret)
//   RECOVERY_EMAIL_FROM              verified sender, e.g. "Proposals <billing@example.com>"
//
// RECOVERY_EMAIL_API_BASE_URL (automated tests only) points the adapter at
// a loopback test double; any other value, or a Vercel production
// deployment, makes email recovery unavailable.
//
// Without all three, email recovery is UNAVAILABLE: the client page doesn't
// offer it and the endpoint refuses. Recovery links issued from the
// dashboard (copied and sent by the Team Lead) work without email.
//
// Actual delivery has NOT been tested (no provider account yet); see
// docs/PAYPAL_SETUP.md.

export type RecoveryEmail = { to: string; link: string; title: string; expiresMinutes: number };

type Adapter = { send(message: RecoveryEmail): Promise<boolean> };

const RESEND_API = "https://api.resend.com";

function apiBase(): string | null {
  const override = process.env.RECOVERY_EMAIL_API_BASE_URL?.trim();
  if (!override) return RESEND_API;
  try {
    const url = new URL(override);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return url.protocol === "http:" && loopback && process.env.VERCEL_ENV !== "production" ? url.origin : null;
  } catch {
    return null;
  }
}

function resendAdapter(base: string, apiKey: string, from: string): Adapter {
  return {
    async send(message) {
      try {
        const response = await fetch(`${base}/emails`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: "Your link to restore access to your proposal",
            text:
              `Someone asked to restore access to "${message.title}" in this browser.\n\n` +
              `Open this link within ${message.expiresMinutes} minutes to restore access. It works once:\n` +
              `${message.link}\n\n` +
              "If you didn't ask for this, you can ignore this email.",
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) console.error("[email] send failed", response.status);
        return response.ok;
      } catch {
        console.error("[email] provider unavailable");
        return false;
      }
    },
  };
}

function adapter(): Adapter | null {
  const provider = process.env.RECOVERY_EMAIL_PROVIDER?.trim().toLowerCase();
  const from = process.env.RECOVERY_EMAIL_FROM?.trim();
  if (provider === "resend") {
    const key = process.env.RESEND_API_KEY?.trim();
    const base = apiBase();
    return key && from && base ? resendAdapter(base, key, from) : null;
  }
  return null;
}

export function isRecoveryEmailConfigured(): boolean {
  return adapter() !== null;
}

export async function sendRecoveryEmail(message: RecoveryEmail): Promise<boolean> {
  const configured = adapter();
  return configured ? configured.send(message) : false;
}
