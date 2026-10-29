import "server-only";

import { z } from "zod";

// Payment configuration (PayPal Checkout, Orders v2). Everything here is
// SERVER-ONLY: no NEXT_PUBLIC_ variable is involved, and the client secret
// never leaves this process. Values are validated, never logged; problems
// are reported by variable NAME only.
//
// Payments stay unavailable (the client page shows a notice, checkout and
// webhooks refuse) unless ALL of these hold:
//   PAYMENTS_ENABLED=true            explicit switch, default off
//   PAYPAL_ENVIRONMENT               "sandbox" or "live"
//   PAYPAL_CLIENT_ID / _SECRET       REST app credentials
//   PAYPAL_MERCHANT_ID               expected payee (merchant account ID)
//   PAYPAL_WEBHOOK_ID                ID of the registered webhook
//   NEXT_PUBLIC_APP_URL              absolute base for return/cancel URLs
// Missing or invalid values never break login, the dashboard or previews.
//
// PAYPAL_API_BASE_URL is for automated tests only: it may point the client
// at a loopback test double (127.0.0.1 / localhost / ::1), and is refused
// for "live" and on Vercel production deployments.

export type PayPalEnvironment = "sandbox" | "live";

export type PaymentConfig = {
  environment: PayPalEnvironment;
  clientId: string;
  clientSecret: string;
  merchantId: string;
  webhookId: string;
  apiBaseUrl: string;
  appUrl: string;
  brandName: string | null;
  // Lifetime of a browser's paid access (days).
  accessDays: number;
  usingTestDouble: boolean;
};

export type PaymentConfigState =
  | { status: "ready"; config: PaymentConfig }
  | { status: "disabled" }
  // Enabled, but something is missing or invalid (names only, no values).
  | { status: "incomplete"; problems: string[] };

const API_BASE: Record<PayPalEnvironment, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

const DEFAULT_ACCESS_DAYS = 180;

// Shapes documented for PayPal credentials and IDs; deliberately loose on
// length so a valid value is never rejected, strict on characters.
const schema = z.object({
  PAYPAL_ENVIRONMENT: z.enum(["sandbox", "live"]),
  PAYPAL_CLIENT_ID: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  PAYPAL_CLIENT_SECRET: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  PAYPAL_MERCHANT_ID: z.string().regex(/^[A-Z0-9]{8,20}$/),
  PAYPAL_WEBHOOK_ID: z.string().regex(/^[A-Za-z0-9-]{6,64}$/),
  NEXT_PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }),
});

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function paymentsEnabledFlag(): boolean {
  return (process.env.PAYMENTS_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function getPaymentConfigState(): PaymentConfigState {
  if (!paymentsEnabledFlag()) return { status: "disabled" };

  const raw = {
    PAYPAL_ENVIRONMENT: read("PAYPAL_ENVIRONMENT"),
    PAYPAL_CLIENT_ID: read("PAYPAL_CLIENT_ID"),
    PAYPAL_CLIENT_SECRET: read("PAYPAL_CLIENT_SECRET"),
    PAYPAL_MERCHANT_ID: read("PAYPAL_MERCHANT_ID"),
    PAYPAL_WEBHOOK_ID: read("PAYPAL_WEBHOOK_ID"),
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL?.trim() || undefined,
  };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    return { status: "incomplete", problems: names.map((name) => `${name} is missing or invalid`) };
  }
  const env = parsed.data;
  const problems: string[] = [];

  let apiBaseUrl = API_BASE[env.PAYPAL_ENVIRONMENT];
  let usingTestDouble = false;
  const override = read("PAYPAL_API_BASE_URL");
  if (override) {
    let url: URL | null = null;
    try {
      url = new URL(override);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "http:" || !isLoopback(url)) {
      problems.push("PAYPAL_API_BASE_URL must be a loopback http URL (tests only)");
    } else if (env.PAYPAL_ENVIRONMENT === "live" || process.env.VERCEL_ENV === "production") {
      problems.push("PAYPAL_API_BASE_URL is not allowed for live payments or production deployments");
    } else {
      apiBaseUrl = url.origin;
      usingTestDouble = true;
    }
  }

  const appUrl = new URL(env.NEXT_PUBLIC_APP_URL);
  if (env.PAYPAL_ENVIRONMENT === "live" && appUrl.protocol !== "https:") {
    problems.push("NEXT_PUBLIC_APP_URL must use https for live payments");
  }

  const accessDays = paymentAccessDays();
  const brand = read("PAYPAL_BRAND_NAME");

  if (problems.length > 0) return { status: "incomplete", problems };
  return {
    status: "ready",
    config: {
      environment: env.PAYPAL_ENVIRONMENT,
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      merchantId: env.PAYPAL_MERCHANT_ID,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      apiBaseUrl,
      appUrl: appUrl.origin,
      // PayPal limits brand_name to 127 characters.
      brandName: brand ? brand.slice(0, 127) : null,
      accessDays,
      usingTestDouble,
    },
  };
}

// Lifetime of a browser's paid access (PAYMENT_ACCESS_DAYS, 1–400, default
// 180). Independent of the PayPal settings: purchases made earlier keep
// working even if payments are switched off later.
export function paymentAccessDays(): number {
  const days = Number(read("PAYMENT_ACCESS_DAYS") ?? DEFAULT_ACCESS_DAYS);
  return Number.isInteger(days) && days >= 1 && days <= 400 ? days : DEFAULT_ACCESS_DAYS;
}

export function getPaymentConfig(): PaymentConfig | null {
  const state = getPaymentConfigState();
  return state.status === "ready" ? state.config : null;
}

// Logged once per process when payments are enabled but not usable, so an
// operator sees WHICH variable is wrong (never its value).
let warned = false;
export function warnIfIncomplete(): void {
  if (warned) return;
  const state = getPaymentConfigState();
  if (state.status === "incomplete") {
    warned = true;
    console.warn(`[payments] enabled but unavailable: ${state.problems.join("; ")}`);
  }
}
