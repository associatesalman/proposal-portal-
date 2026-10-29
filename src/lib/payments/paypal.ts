import "server-only";

import type { PaymentConfig } from "./config";

// Minimal PayPal REST client (no SDK): OAuth 2.0 client-credentials token,
// Orders v2 create / capture / show, Payments v2 capture and refund details,
// and webhook signature verification (POST /v1/notifications/
// verify-webhook-signature). Every call has a deadline. Request and
// response bodies are never logged (they contain payer details); only the
// HTTP status, PayPal's issue code and debug id are.
//
// Idempotency: create and capture send PayPal-Request-Id, so a retry after a
// timeout returns the original result instead of creating a second order or
// capture.

const TIMEOUT_MS = 15_000;

export type PayPalResult<T> =
  | { ok: true; status: number; body: T }
  // status 0 = network failure / timeout (outcome unknown).
  | { ok: false; status: number; issue: string | null; debugId: string | null };

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

function basicAuth(config: PaymentConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
}

async function accessToken(config: PaymentConfig): Promise<string | null> {
  const key = `${config.apiBaseUrl}\0${config.clientId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  try {
    const response = await fetch(`${config.apiBaseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[paypal] token request failed", response.status);
      return null;
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") return null;
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 300;
    tokenCache = { key, token: body.access_token, expiresAt: Date.now() + seconds * 1000 };
    return body.access_token;
  } catch {
    console.error("[paypal] token request unavailable");
    return null;
  }
}

async function call<T>(
  config: PaymentConfig,
  method: "GET" | "POST",
  path: string,
  options: { body?: string; requestId?: string; context: string },
): Promise<PayPalResult<T>> {
  const token = await accessToken(config);
  if (!token) return { ok: false, status: 0, issue: "AUTHENTICATION_FAILED", debugId: null };
  try {
    const response = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.requestId ? { "PayPal-Request-Id": options.requestId } : {}),
        // Full resource in the response (orders, captures).
        Prefer: "return=representation",
      },
      body: options.body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.status === 401) tokenCache = null;
    if (!response.ok) {
      const error = (json ?? {}) as { name?: unknown; details?: { issue?: unknown }[]; debug_id?: unknown };
      const issue =
        typeof error.details?.[0]?.issue === "string"
          ? error.details[0].issue
          : typeof error.name === "string"
            ? error.name
            : null;
      const debugId = typeof error.debug_id === "string" ? error.debug_id : null;
      console.error(`[paypal] ${options.context} failed`, response.status, issue ?? "", debugId ?? "");
      return { ok: false, status: response.status, issue, debugId };
    }
    return { ok: true, status: response.status, body: json as T };
  } catch {
    console.error(`[paypal] ${options.context} unavailable`);
    return { ok: false, status: 0, issue: null, debugId: null };
  }
}

export type CreateOrderInput = {
  requestId: string;
  paymentId: string;
  amountValue: string;
  currency: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
};

// intent CAPTURE, one purchase unit tied to our payment id (reference_id,
// custom_id, invoice_id) with the expected payee, PayPal-hosted approval.
export function createOrder(config: PaymentConfig, input: CreateOrderInput) {
  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: input.paymentId,
        custom_id: input.paymentId,
        // PayPal refuses a second payment with the same invoice id, an extra
        // guard against paying one attempt twice.
        invoice_id: `PP-${input.paymentId}`,
        description: input.description.slice(0, 127),
        amount: { currency_code: input.currency, value: input.amountValue },
        payee: { merchant_id: config.merchantId },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          ...(config.brandName ? { brand_name: config.brandName } : {}),
        },
      },
    },
  };
  return call<unknown>(config, "POST", "/v2/checkout/orders", {
    body: JSON.stringify(body),
    requestId: input.requestId,
    context: "create order",
  });
}

export function captureOrder(config: PaymentConfig, orderId: string, requestId: string) {
  return call<unknown>(config, "POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    body: "{}",
    requestId,
    context: "capture order",
  });
}

export function getOrder(config: PaymentConfig, orderId: string) {
  return call<unknown>(config, "GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { context: "show order" });
}

export function getCapture(config: PaymentConfig, captureId: string) {
  return call<unknown>(config, "GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`, {
    context: "show capture",
  });
}

export function getRefund(config: PaymentConfig, refundId: string) {
  return call<unknown>(config, "GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`, {
    context: "show refund",
  });
}

export type WebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

// PayPal's postback verification. The event is embedded as the RAW body
// text (not re-serialized), as PayPal requires the exact bytes it sent.
// Returns true only for verification_status "SUCCESS".
export async function verifyWebhookSignature(
  config: PaymentConfig,
  headers: WebhookHeaders,
  rawBody: string,
): Promise<"verified" | "rejected" | "unavailable"> {
  const envelope =
    `{"auth_algo":${JSON.stringify(headers.authAlgo)},` +
    `"cert_url":${JSON.stringify(headers.certUrl)},` +
    `"transmission_id":${JSON.stringify(headers.transmissionId)},` +
    `"transmission_sig":${JSON.stringify(headers.transmissionSig)},` +
    `"transmission_time":${JSON.stringify(headers.transmissionTime)},` +
    `"webhook_id":${JSON.stringify(config.webhookId)},` +
    `"webhook_event":${rawBody}}`;
  const result = await call<{ verification_status?: unknown }>(
    config,
    "POST",
    "/v1/notifications/verify-webhook-signature",
    { body: envelope, context: "verify webhook" },
  );
  if (!result.ok) return result.status === 0 || result.status >= 500 ? "unavailable" : "rejected";
  return result.body?.verification_status === "SUCCESS" ? "verified" : "rejected";
}

// Approval URL from an order's links. Only PayPal's own HTTPS hosts are
// accepted (or the loopback test double when configured).
export function approvalUrl(config: PaymentConfig, order: unknown): string | null {
  const links = (order as { links?: { rel?: unknown; href?: unknown }[] } | null)?.links;
  if (!Array.isArray(links)) return null;
  const link = links.find((l) => l?.rel === "payer-action") ?? links.find((l) => l?.rel === "approve");
  if (typeof link?.href !== "string") return null;
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return null;
  }
  const paypalHost = url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  const testHost = config.usingTestDouble && new URL(config.apiBaseUrl).host === url.host;
  return paypalHost || testHost ? url.toString() : null;
}
