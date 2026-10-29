// Payment checks (PayPal Checkout, Orders v2) against ISOLATED TEST DOUBLES.
// No PayPal account, sandbox or real money is involved: what passes here is
// this app's own logic, not PayPal's real behaviour (see
// docs/PAYPAL_SETUP.md, "Verified locally vs. waiting for PayPal").
//
//   npm run build
//   npm run test:payments
//
// How it works (nothing shared is stopped or reconfigured):
// - A local HTTP test double (DOUBLE_PORT, default 54510) plays PayPal's
//   REST API (OAuth token, create/capture/show order, webhook signature
//   verification) and an email provider. "Signatures" are a fixed marker
//   that only this double accepts.
// - Two DEDICATED app servers are started from the current build:
//     PAY_PORT (3102)    payments enabled, PAYPAL_API_BASE_URL -> the double
//     NOPAY_PORT (3103)  payments enabled but credentials missing
//   The running dev server (if any) is not touched.
// - NEXT_PUBLIC_APP_URL is inlined at build time, so the servers' own
//   origin checks expect the BUILD's app URL; requests send that Origin.
// - Everything is created by disposable users (lib/portal.mjs) and removed
//   again, payment rows first. Existing accounts, proposals, files and
//   payments are snapshotted and must be unchanged.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";

const PAY_PORT = Number(process.env.PAY_PORT ?? 3102);
const NOPAY_PORT = Number(process.env.NOPAY_PORT ?? 3103);
const DOUBLE_PORT = Number(process.env.DOUBLE_PORT ?? 54510);
const PAY_URL = `http://localhost:${PAY_PORT}`;
const NOPAY_URL = `http://localhost:${NOPAY_PORT}`;
const DOUBLE_URL = `http://127.0.0.1:${DOUBLE_PORT}`;
process.env.APP_URL = PAY_URL;

const { createHarness, BUCKET } = await import("./lib/portal.mjs");
const h = createHarness("pay");
const { trusted, check, provisionUser, publishProposal, runId } = h;

// Origin the servers expect (NEXT_PUBLIC_APP_URL inlined by the build).
const BUILD_ORIGIN = (() => {
  const env = readFileSync(".env.local", "utf8");
  const value = /^NEXT_PUBLIC_APP_URL=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
  return new URL(value ?? "http://localhost:3000").origin;
})();

const OUT = join(process.env.TEMP ?? "/tmp", `portal-payments-${process.pid}`);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MERCHANT = "TESTMERCHANT01";
const CLIENT_ID = `test-client-${randomBytes(8).toString("hex")}`;
const CLIENT_SECRET = `test-secret-${randomBytes(12).toString("hex")}`;
const WEBHOOK_ID = "WH-TEST-0001";
const GOOD_SIG = `double-signature-${randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------------------
// PayPal + email test double
// ---------------------------------------------------------------------------
const double = {
  orders: new Map(),
  byRequestId: new Map(),
  captureRequests: new Map(),
  emails: [],
  createCalls: 0,
  verifyCalls: 0,
  verifyDown: false,
  // Per-order behaviour for the next capture.
  loseNextCaptureResponse: new Set(),
  declineNextCapture: new Set(),
  seq: 0,
};

function orderView(order) {
  return {
    id: order.id,
    status: order.status,
    intent: "CAPTURE",
    payer: order.payerEmail ? { email_address: order.payerEmail } : undefined,
    purchase_units: [
      {
        reference_id: order.unit.reference_id,
        custom_id: order.unit.custom_id,
        invoice_id: order.unit.invoice_id,
        amount: order.unit.amount,
        payee: { merchant_id: order.payee },
        ...(order.capture
          ? {
              payments: {
                captures: [order.capture],
                ...(order.refunds.length ? { refunds: order.refunds } : {}),
              },
            }
          : {}),
      },
    ],
    links: [
      { rel: "self", href: `${DOUBLE_URL}/v2/checkout/orders/${order.id}`, method: "GET" },
      { rel: "payer-action", href: `${DOUBLE_URL}/checkoutnow?token=${order.id}`, method: "GET" },
    ],
  };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function paypalError(res, status, issue) {
  send(res, status, { name: "UNPROCESSABLE_ENTITY", details: [{ issue }], debug_id: `dbg-${double.seq}` });
}

const doubleServer = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, DOUBLE_URL);
  const path = url.pathname;

  if (req.method === "POST" && path === "/v1/oauth2/token") {
    const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
    if (req.headers.authorization !== expected) return send(res, 401, { error: "invalid_client" });
    return send(res, 200, { access_token: "double-access-token", token_type: "Bearer", expires_in: 3600 });
  }
  if (path === "/emails" && req.method === "POST") {
    double.emails.push(JSON.parse(raw));
    return send(res, 200, { id: `email-${double.emails.length}` });
  }
  if (req.headers.authorization !== "Bearer double-access-token") return send(res, 401, { name: "AUTHENTICATION_FAILURE" });

  if (req.method === "POST" && path === "/v2/checkout/orders") {
    const requestId = req.headers["paypal-request-id"];
    if (requestId && double.byRequestId.has(requestId)) {
      return send(res, 200, orderView(double.orders.get(double.byRequestId.get(requestId))));
    }
    double.createCalls += 1;
    const body = JSON.parse(raw);
    const unit = body.purchase_units[0];
    const id = `ORD${runId.toUpperCase()}${String(++double.seq).padStart(4, "0")}`;
    const order = {
      id,
      status: "PAYER_ACTION_REQUIRED",
      unit,
      payee: unit.payee?.merchant_id ?? null,
      body,
      requestId,
      capture: null,
      refunds: [],
      payerEmail: null,
      // Test controls for the eventual capture.
      captureStatus: "COMPLETED",
      captureAmount: null,
      capturePayee: null,
    };
    double.orders.set(id, order);
    if (requestId) double.byRequestId.set(requestId, id);
    return send(res, 200, orderView(order));
  }

  let m = /^\/v2\/checkout\/orders\/([A-Z0-9-]+)\/capture$/.exec(path);
  if (req.method === "POST" && m) {
    const order = double.orders.get(m[1]);
    if (!order) return paypalError(res, 404, "INVALID_RESOURCE_ID");
    const requestId = req.headers["paypal-request-id"];
    if (order.capture) {
      if (requestId && double.captureRequests.get(order.id) === requestId) return send(res, 201, orderView(order));
      return paypalError(res, 422, "ORDER_ALREADY_CAPTURED");
    }
    if (order.status !== "APPROVED") return paypalError(res, 422, "ORDER_NOT_APPROVED");
    if (double.declineNextCapture.delete(order.id)) return paypalError(res, 422, "INSTRUMENT_DECLINED");
    const value = order.captureAmount ?? order.unit.amount.value;
    order.capture = {
      id: `CAP${order.id.slice(3)}`,
      status: order.captureStatus,
      ...(order.captureStatus === "PENDING" ? { status_details: { reason: "PENDING_REVIEW" } } : {}),
      amount: { currency_code: order.unit.amount.currency_code, value },
      custom_id: order.unit.custom_id,
      create_time: new Date().toISOString(),
    };
    if (order.capturePayee) order.payee = order.capturePayee;
    order.status = "COMPLETED";
    if (requestId) double.captureRequests.set(order.id, requestId);
    if (double.loseNextCaptureResponse.delete(order.id)) return req.socket.destroy();
    return send(res, 201, orderView(order));
  }

  m = /^\/v2\/checkout\/orders\/([A-Z0-9-]+)$/.exec(path);
  if (req.method === "GET" && m) {
    const order = double.orders.get(m[1]);
    return order ? send(res, 200, orderView(order)) : paypalError(res, 404, "INVALID_RESOURCE_ID");
  }

  if (req.method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
    double.verifyCalls += 1;
    if (double.verifyDown) return send(res, 503, { name: "SERVICE_UNAVAILABLE" });
    const envelope = JSON.parse(raw);
    const ok =
      envelope.webhook_id === WEBHOOK_ID &&
      envelope.transmission_sig === GOOD_SIG &&
      envelope.auth_algo === "SHA256withRSA" &&
      typeof envelope.webhook_event?.id === "string";
    return send(res, 200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
  }

  return send(res, 404, { name: "RESOURCE_NOT_FOUND" });
});

// Test controls: what the buyer and PayPal do on PayPal's side.
function approve(orderId, payerEmail = `buyer-${runId}@paypal.test`) {
  const order = double.orders.get(orderId);
  order.status = "APPROVED";
  order.payerEmail = payerEmail;
}
function refund(orderId, value) {
  const order = double.orders.get(orderId);
  const id = `REF${order.id.slice(3)}${order.refunds.length + 1}`;
  order.refunds.push({ id, status: "COMPLETED", amount: { currency_code: order.capture.amount.currency_code, value } });
  const refunded = order.refunds.reduce((sum, r) => sum + Number(r.amount.value), 0);
  order.capture.status = refunded >= Number(order.capture.amount.value) ? "REFUNDED" : "PARTIALLY_REFUNDED";
  return id;
}
function orderFor(paymentId) {
  return [...double.orders.values()].find((o) => o.unit.custom_id === paymentId);
}

// ---------------------------------------------------------------------------
// App servers
// ---------------------------------------------------------------------------
const servers = [];
async function startServer(port, extraEnv) {
  const log = createWriteStream(join(OUT, `server-${port}.log`));
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      RATE_LIMIT_ENABLED: "true",
      // Generous limits: each scenario uses its own client address anyway.
      RATE_LIMIT_CHECKOUT_IP: "200/60",
      RATE_LIMIT_CHECKOUT_TOKEN: "200/60",
      RATE_LIMIT_PURCHASE_IP: "500/60",
      RATE_LIMIT_PURCHASE_DOCUMENT_IP: "500/60",
      RATE_LIMIT_WEBHOOK_IP: "500/60",
      RATE_LIMIT_LINK_PAGE_IP: "500/60",
      RATE_LIMIT_RECOVERY_CLAIM_IP: "100/60",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  servers.push(child);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/login`)).status === 200) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`app server on ${port} did not start`);
}
function stopServers() {
  for (const child of servers) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

const PAY_ENV = {
  PAYMENTS_ENABLED: "true",
  PAYPAL_ENVIRONMENT: "sandbox",
  PAYPAL_CLIENT_ID: CLIENT_ID,
  PAYPAL_CLIENT_SECRET: CLIENT_SECRET,
  PAYPAL_MERCHANT_ID: MERCHANT,
  PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
  PAYPAL_API_BASE_URL: DOUBLE_URL,
  RECOVERY_EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "double-email-key",
  RECOVERY_EMAIL_FROM: "Proposals <test@example.test>",
  RECOVERY_EMAIL_API_BASE_URL: DOUBLE_URL,
};
const NOPAY_ENV = {
  PAYMENTS_ENABLED: "true",
  PAYPAL_ENVIRONMENT: "sandbox",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  PAYPAL_MERCHANT_ID: "",
  PAYPAL_WEBHOOK_ID: "",
  PAYPAL_API_BASE_URL: "",
  RECOVERY_EMAIL_PROVIDER: "",
  RESEND_API_KEY: "",
  RECOVERY_EMAIL_FROM: "",
};

// ---------------------------------------------------------------------------
// Client browsers (cookie jars) and requests
// ---------------------------------------------------------------------------
let ipSeq = 1;
function browser(base = PAY_URL) {
  return { base, jar: new Map(), ip: `198.51.100.${(ipSeq++ % 250) + 1}` };
}

async function request(b, path, { method = "GET", body, origin = BUILD_ORIGIN, headers = {} } = {}) {
  const res = await fetch(`${b.base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "x-forwarded-for": b.ip,
      ...(b.jar.size ? { cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      ...(method !== "GET" && origin ? { origin } : {}),
      ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value) b.jar.set(name, value);
    else b.jar.delete(name);
  }
  return res;
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const checkout = (b, token, extra = {}) => request(b, `/p/${token}/checkout`, { method: "POST", body: {}, ...extra });
const status = (b, ref, action = "refresh") => request(b, `/purchase/${ref}/status`, { method: "POST", body: { action } });
const page = async (b, path) => {
  const res = await request(b, path);
  return { res, html: await res.text() };
};

async function startPaid(b, proposal) {
  const res = await checkout(b, proposal.token);
  const body = await json(res);
  if (res.status !== 200) throw new Error(`checkout ${res.status} ${JSON.stringify(body)}`);
  const row = await paymentByRef(body.ref);
  return { ref: body.ref, url: body.url, row, order: orderFor(row.id) };
}

async function paymentByRef(ref) {
  const { data } = await trusted.from("payments").select("*").eq("public_ref", ref).single();
  return data;
}
async function paymentById(id) {
  const { data } = await trusted.from("payments").select("*").eq("id", id).single();
  return data;
}

let eventSeq = 0;
function webhookEvent(type, resource) {
  return {
    id: `WH-${runId}-${++eventSeq}`,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: type.startsWith("CHECKOUT.ORDER") ? "checkout-order" : type.includes("REFUNDED") || type.includes("REVERSED") ? "refund" : "capture",
    event_type: type,
    summary: type,
    resource,
  };
}
async function deliver(event, { sig = GOOD_SIG, raw } = {}) {
  const res = await fetch(`${PAY_URL}/api/payments/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.50",
      "paypal-transmission-id": randomUUID(),
      "paypal-transmission-time": new Date().toISOString(),
      "paypal-transmission-sig": sig,
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test",
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: raw ?? JSON.stringify(event),
  });
  return { status: res.status, body: await res.text() };
}
const captureResource = (order, status = order.capture?.status ?? "COMPLETED") => ({
  id: order.capture?.id ?? `CAP${order.id.slice(3)}`,
  status,
  amount: order.capture?.amount ?? order.unit.amount,
  supplementary_data: { related_ids: { order_id: order.id } },
});
const refundResource = (order, refundId) => ({
  id: refundId,
  status: "COMPLETED",
  links: [{ rel: "up", href: `${DOUBLE_URL}/v2/payments/captures/${order.capture.id}`, method: "GET" }],
  supplementary_data: { related_ids: { order_id: order.id } },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function makePdf(label, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([420, 595]).drawText(`${label} page ${i} ${runId}`, { x: 30, y: 520, size: 20, font });
  return Buffer.from(await doc.save());
}
async function pageCount(bytes) {
  return (await PDFDocument.load(bytes)).getPageCount();
}

const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const actionId = (file, name) =>
  Object.entries(manifest).find(([, v]) => v.filename?.endsWith(file) && v.exportedName === name)?.[0];

async function serverAction(user, file, name, arg) {
  const id = actionId(file, name);
  if (!id) throw new Error(`action ${name} not in manifest`);
  const res = await fetch(`${PAY_URL}/dashboard`, {
    method: "POST",
    headers: { cookie: user.cookie, origin: PAY_URL, "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
    body: JSON.stringify([arg]),
    redirect: "manual",
  });
  const text = await res.text();
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+):([[{].*)$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  const head = JSON.parse(rows.get("0") ?? "{}");
  const ref = typeof head.a === "string" && head.a.startsWith("$@") ? head.a.slice(2) : null;
  return ref ? JSON.parse(rows.get(ref)) : head.a;
}

function assembleStreamedHtml(html) {
  const segments = new Map();
  html = html.replace(
    /<(?:div hidden|table hidden><tbody|table hidden><tr) id="S:([0-9a-f]+)">([\s\S]*?)<\/(?:div|tbody><\/table|tr><\/table)><script>\$RS\("S:\1","P:\1"\)<\/script>/g,
    (_, n, content) => {
      segments.set(n, content);
      return "";
    },
  );
  for (let pass = 0; pass < 10 && html.includes('<template id="P:'); pass++) {
    html = html.replace(/<template id="P:([0-9a-f]+)"><\/template>/g, (placeholder, n) => segments.get(n) ?? placeholder);
  }
  return html;
}
async function dashboardHtml(user, query) {
  const res = await fetch(`${PAY_URL}/dashboard${query}`, { headers: { cookie: user.cookie }, redirect: "manual" });
  return assembleStreamedHtml(await res.text());
}

// ---------------------------------------------------------------------------
// Cleanup: payment records of disposable users only (FKs are RESTRICT).
// ---------------------------------------------------------------------------
const testUsers = [];
async function cleanupPayments() {
  if (!testUsers.length) return;
  const { data: pays } = await trusted.from("payments").select("id").in("owner_id", testUsers);
  const ids = (pays ?? []).map((p) => p.id);
  if (ids.length) {
    const { data: ents } = await trusted.from("payment_entitlements").select("id").in("payment_id", ids);
    const entIds = (ents ?? []).map((e) => e.id);
    if (entIds.length) {
      await trusted.from("payment_access_sessions").delete().in("entitlement_id", entIds);
      await trusted.from("payment_recovery_tokens").delete().in("entitlement_id", entIds);
      await trusted.from("payment_entitlements").delete().in("id", entIds);
    }
    await trusted.from("payment_refunds").delete().in("payment_id", ids);
    await trusted.from("payment_events").delete().in("payment_id", ids);
    await trusted.from("payments").delete().in("id", ids);
  }
  await trusted.from("payment_events").delete().like("provider_event_id", `WH-${runId}-%`);
}

async function otherPayments() {
  let query = trusted.from("payments").select("id, status, updated_at").order("id");
  if (testUsers.length) query = query.not("owner_id", "in", `(${testUsers.join(",")})`);
  const { data } = await query;
  return JSON.stringify(data ?? []);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
async function main() {
  await new Promise((resolve) => doubleServer.listen(DOUBLE_PORT, "127.0.0.1", resolve));
  await Promise.all([startServer(PAY_PORT, PAY_ENV), startServer(NOPAY_PORT, NOPAY_ENV)]);
  console.log(`servers up (payments: ${PAY_URL}, unconfigured: ${NOPAY_URL}); origin ${BUILD_ORIGIN}\n`);

  const leadA = await provisionUser("lead-a", "team_lead");
  const leadB = await provisionUser("lead-b", "team_lead");
  const admin = await provisionUser("admin", "admin");
  testUsers.push(leadA.id, leadB.id, admin.id);
  const paymentsOfOthersBefore = await otherPayments();

  const pdf = await makePdf("Alpha", 6);
  const alpha = await publishProposal(leadA, { title: `Alpha ${runId}`, pdf, offer: { freePages: "2", price: "25.00", currency: "USD" } });
  const bravo = await publishProposal(leadB, { title: `Bravo ${runId}`, pdf: await makePdf("Bravo", 4), offer: { freePages: "1", price: "9.50", currency: "EUR" } });
  const dirham = await publishProposal(leadA, { title: `Dirham ${runId}`, pdf: await makePdf("Dirham", 3), offer: { freePages: "1", price: "100.00", currency: "AED" } });
  const charlie = await publishProposal(leadA, { title: `Charlie ${runId}`, pdf: await makePdf("Charlie", 5), offer: { freePages: "1", price: "40.00", currency: "USD" } });

  // 1. Unconfigured --------------------------------------------------------
  {
    const b = browser(NOPAY_URL);
    const { html } = await page(b, `/p/${alpha.token}`);
    check("unconfigured: client page still shows the preview", html.includes("data-locked-notice"));
    check("unconfigured: client page says payment is not available yet", html.includes("Online payment will be available soon."));
    check("unconfigured: no pay button", !html.includes("data-pay-button") && !html.includes("data-checkout"));
    const res = await checkout(b, alpha.token);
    check("unconfigured: checkout refused (503)", res.status === 503);
    const hook = await fetch(`${NOPAY_URL}/api/payments/webhook`, { method: "POST", body: "{}" });
    check("unconfigured: webhook refused (503)", hook.status === 503);
    const recover = await request(b, `/p/${alpha.token}/recover`, { method: "POST", body: { email: "a@b.test" } });
    check("unconfigured: email recovery unavailable (503)", recover.status === 503);
    const { count } = await trusted.from("payments").select("id", { count: "exact", head: true }).eq("proposal_id", alpha.id);
    check("unconfigured: no payment rows were created", count === 0);
    const login = await fetch(`${NOPAY_URL}/login`);
    check("unconfigured: login page unaffected", login.status === 200);
    check("unconfigured: no PayPal calls were made", double.createCalls === 0 && double.verifyCalls === 0);
  }

  // 2. Client page and checkout guards ---------------------------------------
  {
    const b = browser();
    const { res, html } = await page(b, `/p/${alpha.token}`);
    check("configured: pay button shown with the database price", html.includes("data-checkout") && html.includes("$25.00"));
    check("client page is no-store", (res.headers.get("cache-control") ?? "").includes("no-store"));
    const { html: aed } = await page(b, `/p/${dirham.token}`);
    check("unsupported currency (AED): notice instead of the pay button", /data-payment-notice[^>]*>[^<]*available for (<!-- -->)?AED/.test(aed) && !aed.includes("data-checkout"));
    const aedRes = await checkout(b, dirham.token);
    check("unsupported currency (AED): checkout refused (409)", aedRes.status === 409);

    const cross = await checkout(b, alpha.token, { origin: "https://evil.example" });
    check("cross-origin checkout refused (403)", cross.status === 403);
    const noOrigin = await checkout(b, alpha.token, { origin: null });
    check("checkout without Origin refused (403)", noOrigin.status === 403);
    const crossSite = await checkout(b, alpha.token, { headers: { "sec-fetch-site": "cross-site" } });
    check("cross-site fetch metadata refused (403)", crossSite.status === 403);
    const unknown = await checkout(b, "A".repeat(43));
    check("unknown link: checkout 404", unknown.status === 404);
    const { count } = await trusted.from("payments").select("id", { count: "exact", head: true }).eq("proposal_id", alpha.id);
    check("refused checkouts created nothing", count === 0);
  }

  // 3. Happy path: approve on PayPal, return, capture, unlock ----------------
  const buyer = browser();
  let paid;
  {
    const res = await checkout(buyer, alpha.token, { body: { amount: 1, currency: "JPY", ownerId: leadB.id, path: "x" } });
    const body = await json(res);
    check("checkout answers with a PayPal approval URL", res.status === 200 && body?.url?.startsWith(`${DOUBLE_URL}/checkoutnow`));
    const cookieName = [...buyer.jar.keys()].find((k) => k.endsWith("pp_session"));
    check("checkout sets the HttpOnly session cookie", Boolean(cookieName));
    const setCookie = res.headers.getSetCookie().join("\n");
    check("session cookie is HttpOnly and SameSite=Lax", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));

    const row = await paymentByRef(body.ref);
    const order = orderFor(row.id);
    paid = { ref: body.ref, row, order };
    check("browser-submitted amount/currency/owner are ignored", row.amount_minor === 2500 && row.currency === "USD" && row.owner_id === leadA.id);
    check("PayPal order uses the database amount and currency", order.unit.amount.value === "25.00" && order.unit.amount.currency_code === "USD");
    check("PayPal order names the configured payee", order.payee === MERCHANT);
    check("PayPal order is tied to the payment (custom_id/reference_id)", order.unit.custom_id === row.id && order.unit.reference_id === row.id);
    check("pending attempt persisted before redirect (order id stored)", row.provider_order_id === order.id && row.status === "created");
    check("checkout snapshot: revision, page count and title", row.original_storage_path === alpha.row.original_storage_path && row.total_pages === 6 && row.title_snapshot === `Alpha ${runId}`);
    check("return/cancel URLs point at the purchase page", order.body.payment_source.paypal.experience_context.return_url.endsWith(`/purchase/${body.ref}?result=return`));

    const again = await json(await checkout(buyer, alpha.token));
    const createsBefore = double.createCalls;
    const third = await json(await checkout(buyer, alpha.token));
    check("double submit reuses the same attempt", again.ref === body.ref && third.ref === body.ref);
    check("double submit creates no second PayPal order", double.createCalls === createsBefore);
    const { count } = await trusted.from("payments").select("id", { count: "exact", head: true }).eq("proposal_id", alpha.id);
    check("one payment row after repeated submits", count === 1);

    // Forged success: return URL without approval.
    const early = await json(await status(buyer, body.ref, "capture"));
    check("return URL without approval does not unlock", early?.state === "awaiting_approval" && early?.hasAccess === false);
    const { html: earlyPage } = await page(buyer, `/purchase/${body.ref}?result=return`);
    check("forged success URL shows no success message", !earlyPage.includes("data-payment-success"));
    const earlyDoc = await request(buyer, `/purchase/${body.ref}/document`);
    check("no document before payment", earlyDoc.status === 404);
    check("no entitlement before payment", !(await trusted.from("payment_entitlements").select("id").eq("payment_id", row.id)).data?.length);

    approve(order.id);
    const done = await json(await status(buyer, body.ref, "capture"));
    check("after approval + capture: completed with access", done?.state === "completed" && done?.hasAccess === true);
    const stored = await paymentById(row.id);
    check("payment verified with capture reference and time", stored.status === "succeeded" && stored.provider_payment_id === order.capture.id && Boolean(stored.verified_at));
    check("payer email recorded server-side", stored.payer_email === `buyer-${runId}@paypal.test`);

    const { res: purchaseRes, html: purchase } = await page(buyer, `/purchase/${body.ref}`);
    check("purchase page shows 'Payment received successfully'", purchase.includes("Payment received successfully"));
    check("purchase page is no-store", (purchaseRes.headers.get("cache-control") ?? "").includes("no-store"));
    const doc = await request(buyer, `/purchase/${body.ref}/document`);
    const bytes = Buffer.from(await doc.arrayBuffer());
    check("full document is served (all 6 pages)", doc.status === 200 && (await pageCount(bytes)) === 6);
    check("document response is no-store and same-origin only", (doc.headers.get("cache-control") ?? "").includes("no-store") && doc.headers.get("cross-origin-resource-policy") === "same-origin");
    const { html: client } = await page(buyer, `/p/${alpha.token}`);
    check("client link shows the paid view in the paying browser", client.includes("data-paid-view") && !client.includes("data-checkout"));
    const { html: again2 } = await page(buyer, `/purchase/${body.ref}`);
    check("access survives a refresh", again2.includes("Payment received successfully"));

    const leaks = [leadA.fullName, leadA.email, leadA.id, alpha.row.original_storage_path, "storage/v1", "original.pdf"];
    const exposed = [client, purchase, JSON.stringify(done)].some((text) => leaks.some((value) => text.includes(value)));
    check("no Team Lead name/email, owner id or storage path in client responses", !exposed);
  }

  // 4. Forwarded links and other browsers -------------------------------------
  {
    const other = browser();
    const { html } = await page(other, `/p/${alpha.token}`);
    check("forwarded client link: preview only, pay button shown", !html.includes("data-paid-view") && html.includes("data-checkout"));
    const { html: purchase } = await page(other, `/purchase/${paid.ref}`);
    check("forwarded purchase URL: not available", purchase.includes("isn&#x27;t available in this browser") && !purchase.includes("Payment received"));
    const doc = await request(other, `/purchase/${paid.ref}/document`);
    check("forwarded document URL: 404", doc.status === 404);
    const st = await status(other, paid.ref);
    check("another browser cannot query the purchase status (404)", st.status === 404);
    const stolen = browser();
    stolen.jar.set("pp_session", "x".repeat(43));
    const doc2 = await request(stolen, `/purchase/${paid.ref}/document`);
    check("a made-up session cookie opens nothing", doc2.status === 404);
    const crossStatus = await request(buyer, `/purchase/${paid.ref}/status`, { method: "POST", body: { action: "refresh" }, origin: "https://evil.example" });
    check("cross-origin status call refused (403)", crossStatus.status === 403);
    const crossDoc = await request(buyer, `/purchase/${paid.ref}/document`, { headers: { "sec-fetch-site": "cross-site" } });
    check("cross-site document request refused (403)", crossDoc.status === 403);
    check("proposal is not globally paid (other browser still sees preview)", !html.includes("Payment received successfully"));
  }

  // 5. Webhooks ------------------------------------------------------------------
  {
    const before = double.verifyCalls;
    const unsigned = await fetch(`${PAY_URL}/api/payments/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("webhook without signature headers: 400", unsigned.status === 400);
    const forged = webhookEvent("PAYMENT.CAPTURE.COMPLETED", captureResource(paid.order));
    const bad = await deliver(forged, { sig: "forged" });
    check("webhook with invalid signature: 400", bad.status === 400);
    check("invalid signature was checked with PayPal", double.verifyCalls === before + 1);
    const { count: stored } = await trusted.from("payment_events").select("id", { count: "exact", head: true }).eq("provider_event_id", forged.id);
    check("nothing stored for an unverified webhook", stored === 0);

    double.verifyDown = true;
    const down = await deliver(webhookEvent("PAYMENT.CAPTURE.COMPLETED", captureResource(paid.order)));
    double.verifyDown = false;
    check("verification unavailable: 5xx so PayPal retries, nothing granted", down.status >= 500);

    const ev = webhookEvent("PAYMENT.CAPTURE.COMPLETED", captureResource(paid.order));
    const first = await deliver(ev);
    const dup = await deliver(ev);
    check("verified completion webhook accepted", first.status === 200);
    check("duplicate delivery recognised", dup.status === 200 && dup.body === "duplicate");
    const unmatched = await deliver(webhookEvent("CHECKOUT.ORDER.APPROVED", { id: "ORDUNKNOWN0001", status: "APPROVED" }));
    check("webhook for an unknown order: acknowledged, unmatched", unmatched.status === 200 && unmatched.body === "unmatched");
    const ignored = await deliver(webhookEvent("BILLING.SUBSCRIPTION.CREATED", { id: "I-1" }));
    check("unrelated event type ignored", ignored.status === 200 && ignored.body === "ignored");
    const late = await deliver(webhookEvent("PAYMENT.CAPTURE.PENDING", captureResource(paid.order, "PENDING")));
    const after = await paymentById(paid.row.id);
    check("out-of-order PENDING after completion changes nothing", late.status === 200 && after.status === "succeeded");
    const tampered = webhookEvent("PAYMENT.CAPTURE.COMPLETED", { ...captureResource(paid.order), amount: { currency_code: "USD", value: "0.01" } });
    await deliver(tampered);
    check("webhook payload amounts are not trusted (state re-read from PayPal)", (await paymentById(paid.row.id)).needs_review === false);
  }

  // 6. Buyer closes the tab: webhook captures, the same browser gets access later
  {
    const b = browser();
    const { ref, row, order } = await startPaid(b, charlie);
    approve(order.id);
    const hook = await deliver(webhookEvent("CHECKOUT.ORDER.APPROVED", { id: order.id, status: "APPROVED" }));
    const stored = await paymentById(row.id);
    check("ORDER.APPROVED webhook captures and verifies", hook.status === 200 && stored.status === "succeeded");
    // Race: the browser returns afterwards and asks to capture again.
    const st = await json(await status(b, ref, "capture"));
    check("capture/webhook race: one capture, browser gets access", st?.state === "completed" && st?.hasAccess && order.capture && (await paymentById(row.id)).provider_payment_id === order.capture.id);
    const other = browser();
    check("webhook-verified purchase does not open in another browser", (await request(other, `/purchase/${ref}/document`)).status === 404);
  }

  // 7. Capture response lost (PayPal captured, our request timed out) ---------
  {
    const b = browser();
    const { ref, row, order } = await startPaid(b, charlie);
    approve(order.id);
    double.loseNextCaptureResponse.add(order.id);
    const st = await json(await status(b, ref, "capture"));
    check("lost capture response: reconciled from the order", st?.state === "completed" && (await paymentById(row.id)).status === "succeeded");
  }

  // 8. Wrong amount / wrong payee: never unlocks, flagged for review ---------
  {
    const b = browser();
    const { ref, row, order } = await startPaid(b, charlie);
    approve(order.id);
    order.captureAmount = "39.99";
    const st = await json(await status(b, ref, "capture"));
    const stored = await paymentById(row.id);
    check("captured amount differs: no access", st?.hasAccess === false && stored.status !== "succeeded");
    check("captured amount differs: flagged for review", stored.needs_review === true);
    check("captured amount differs: document stays locked", (await request(b, `/purchase/${ref}/document`)).status === 404);
  }
  {
    const b = browser();
    const { ref, row, order } = await startPaid(b, charlie);
    approve(order.id);
    order.capturePayee = "OTHERMERCHANT9";
    const st = await json(await status(b, ref, "capture"));
    const stored = await paymentById(row.id);
    check("different payee: no access, flagged", st?.hasAccess === false && stored.needs_review === true && stored.status !== "succeeded");
  }

  // 9. Pending, declined, failed, cancelled ----------------------------------
  {
    const b = browser();
    const { ref, row, order } = await startPaid(b, charlie);
    approve(order.id);
    order.captureStatus = "PENDING";
    const st = await json(await status(b, ref, "capture"));
    check("pending capture: 'pending', no access", st?.state === "pending" && st?.hasAccess === false);
    check("pending capture: document locked", (await request(b, `/purchase/${ref}/document`)).status === 404);
    order.capture.status = "COMPLETED";
    delete order.capture.status_details;
    await deliver(webhookEvent("PAYMENT.CAPTURE.COMPLETED", captureResource(order)));
    check("pending -> completed via webhook", (await paymentById(row.id)).status === "succeeded");
    await sleep(4200); // refresh throttle
    const later = await json(await status(b, ref));
    check("the paying browser then gets access", later?.state === "completed" && later?.hasAccess === true);
  }
  {
    const b = browser();
    const { ref, order } = await startPaid(b, charlie);
    approve(order.id);
    double.declineNextCapture.add(order.id);
    const st = await json(await status(b, ref, "capture"));
    check("instrument declined: buyer can retry on PayPal", st?.declined === true && Boolean(st?.approveUrl) && st?.hasAccess === false);
  }
  {
    const b = browser();
    const { ref, row, order } = await startPaid(b, charlie);
    approve(order.id);
    order.captureStatus = "DECLINED";
    const st = await json(await status(b, ref, "capture"));
    check("capture declined: 'failed', no access", st?.state === "failed" && st?.hasAccess === false && (await paymentById(row.id)).status === "denied");
  }
  {
    const b = browser();
    const { ref, row } = await startPaid(b, charlie);
    const st = await json(await status(b, ref, "cancel"));
    check("buyer cancels on PayPal: 'cancelled'", st?.state === "cancelled" && (await paymentById(row.id)).status === "cancelled");
    const retry = await json(await checkout(b, charlie.token));
    check("after a cancel, paying again starts a new attempt", retry?.ref && retry.ref !== ref);
    const other = browser();
    const forged = await request(other, `/purchase/${retry.ref}/status`, { method: "POST", body: { action: "cancel" } });
    check("another browser cannot cancel someone's attempt", forged.status === 404);
  }

  // 10. Link rotation and document replacement don't affect paid access -----
  {
    const revoked = await h.act(leadA, "revokeLinkAction", { proposalId: alpha.id });
    check("lead revokes the client link", revoked.ok === true);
    const doc = await request(buyer, `/purchase/${paid.ref}/document`);
    check("paid access survives link revocation", doc.status === 200);
    const { html } = await page(buyer, `/purchase/${paid.ref}`);
    check("purchase page still works after revocation", html.includes("Payment received successfully"));
    const del = await serverActionForm(leadA, "deleteProposalAction", { proposalId: alpha.id });
    check("a proposal with payments cannot be deleted", del?.status === "error");
    const { data: still } = await trusted.from("proposals").select("id").eq("id", alpha.id);
    check("purchased proposal still exists", still?.length === 1);
    const objects = await h.objectsUnder(`${leadA.id}/${alpha.id}`);
    check("purchased file is retained in storage", objects.includes(alpha.row.original_storage_path));
  }

  // 11. Refunds and reversals -------------------------------------------------
  {
    const partialId = refund(paid.order.id, "5.00");
    await deliver(webhookEvent("PAYMENT.CAPTURE.REFUNDED", refundResource(paid.order, partialId)));
    const partial = await paymentById(paid.row.id);
    check("partial refund recorded (policy: access kept)", partial.status === "partially_refunded" && partial.refunded_amount_minor === 500);
    check("partial refund: document still opens", (await request(buyer, `/purchase/${paid.ref}/document`)).status === 200);
    const fullId = refund(paid.order.id, "20.00");
    const ev = webhookEvent("PAYMENT.CAPTURE.REFUNDED", refundResource(paid.order, fullId));
    await deliver(ev);
    const full = await paymentById(paid.row.id);
    check("full refund: refunded", full.status === "refunded" && full.refunded_amount_minor === 2500);
    check("full refund: document access ends", (await request(buyer, `/purchase/${paid.ref}/document`)).status === 404);
    const { html } = await page(buyer, `/purchase/${paid.ref}`);
    check("full refund: purchase page says refunded, no success", !html.includes("data-payment-success"));
    const { data: ent } = await trusted.from("payment_entitlements").select("status").eq("payment_id", paid.row.id).single();
    check("full refund: entitlement suspended, record kept", ent.status === "suspended");
    const replay = await deliver(webhookEvent("PAYMENT.CAPTURE.COMPLETED", captureResource(paid.order, "COMPLETED")));
    check("a replayed completion does not restore access", replay.status === 200 && (await paymentById(paid.row.id)).status === "refunded");
  }
  let reversedRef;
  {
    const b = browser();
    const { ref, row, order } = await startPaid(b, charlie);
    approve(order.id);
    await status(b, ref, "capture");
    check("second purchase verified", (await paymentById(row.id)).status === "succeeded");
    const wrong = await deliver(webhookEvent("PAYMENT.CAPTURE.REVERSED", { ...refundResource(order, "REV-X"), links: [{ rel: "up", href: `${DOUBLE_URL}/v2/payments/captures/CAPOTHER` }] }));
    check("reversal naming another capture changes nothing", wrong.status === 200 && (await paymentById(row.id)).status === "succeeded");
    await deliver(webhookEvent("PAYMENT.CAPTURE.REVERSED", refundResource(order, `REV${order.id}`)));
    check("reversal: reversed and access ends", (await paymentById(row.id)).status === "reversed" && (await request(b, `/purchase/${ref}/document`)).status === 404);
    reversedRef = ref;
  }

  // 12. EUR purchase (lead B) for currency grouping -------------------------
  const euroBuyer = browser();
  let euro;
  {
    euro = await startPaid(euroBuyer, bravo);
    approve(euro.order.id, `euro-${runId}@paypal.test`);
    const st = await json(await status(euroBuyer, euro.ref, "capture"));
    check("EUR purchase completed", st?.state === "completed" && euro.order.unit.amount.value === "9.50" && euro.order.unit.amount.currency_code === "EUR");
  }

  // 13. Recovery ---------------------------------------------------------------
  {
    const fresh = browser();
    const generic = await json(await request(fresh, `/p/${bravo.token}/recover`, { method: "POST", body: { email: `nobody-${runId}@test.local` } }));
    const emailsBefore = double.emails.length;
    const match = await json(await request(fresh, `/p/${bravo.token}/recover`, { method: "POST", body: { email: `EURO-${runId}@paypal.test` } }));
    check("recovery answers identically for unknown and known emails", generic?.message === match?.message);
    check("recovery email sent only for the payer address", double.emails.length === emailsBefore + 1 && double.emails.at(-1).to[0] === `euro-${runId}@paypal.test`);
    const link = /https?:\/\/\S+\/purchase\/recover\/([A-Za-z0-9_-]{43})/.exec(double.emails.at(-1).text);
    check("email contains a single-use recovery link", Boolean(link));
    const token = link[1];
    const typed = await request(fresh, `/purchase/${euro.ref}/document`);
    check("typing the email alone grants nothing", typed.status === 404);

    const { html: peek } = await page(fresh, `/purchase/recover/${token}`);
    const { html: peek2 } = await page(fresh, `/purchase/recover/${token}`);
    check("opening the recovery link (GET) does not use it up", peek.includes("data-recover-ready") && peek2.includes("data-recover-ready"));
    const cross = await request(fresh, `/purchase/recover/${token}/claim`, { method: "POST", body: "", origin: "https://evil.example" });
    check("cross-origin recovery claim refused (403)", cross.status === 403);
    const claim = await request(fresh, `/purchase/recover/${token}/claim`, { method: "POST", body: "" });
    check("claim redirects to the purchase", claim.status === 303 && (claim.headers.get("location") ?? "").endsWith(`/purchase/${euro.ref}`));
    const doc = await request(fresh, `/purchase/${euro.ref}/document`);
    check("recovered browser can open the document", doc.status === 200 && (await pageCount(Buffer.from(await doc.arrayBuffer()))) === 4);
    const thief = browser();
    const reuse = await request(thief, `/purchase/recover/${token}/claim`, { method: "POST", body: "" });
    check("a used recovery link cannot be redeemed again", reuse.status === 303 && !(reuse.headers.get("location") ?? "").includes(`/purchase/${euro.ref}`));
    check("the second browser got nothing", (await request(thief, `/purchase/${euro.ref}/document`)).status === 404);
    const { html: used } = await page(thief, `/purchase/recover/${token}`);
    check("used link shows the expired notice", used.includes("data-recover-expired"));
    const typedRef = await page(thief, `/purchase/${euro.ref}`);
    check("knowing the public reference restores nothing", typedRef.html.includes("isn&#x27;t available in this browser"));

    const leadBDenied = await serverAction(leadB, "payment-actions.ts", "issueRecoveryLinkAction", { paymentId: (await paymentsOf(leadA, "succeeded"))[0] });
    check("Team Lead B cannot issue an access link for lead A's payment", leadBDenied?.ok === false);
    const issued = await serverAction(leadB, "payment-actions.ts", "issueRecoveryLinkAction", { paymentId: euro.row.id });
    check("owner issues a dashboard access link", issued?.ok === true && /\/purchase\/recover\/[A-Za-z0-9_-]{43}$/.test(issued.url));
    const refundedDenied = await serverAction(leadA, "payment-actions.ts", "issueRecoveryLinkAction", { paymentId: paid.row.id });
    check("no access link for a refunded purchase", refundedDenied?.ok === false);
  }

  // 14. Browser roles can't fake payments --------------------------------------
  {
    const { error: rpcError } = await leadA.client.rpc("payment_apply_state", {
      p_payment_id: paid.row.id, p_status: "succeeded", p_order_id: paid.order.id, p_capture_id: "X", p_amount_minor: 2500,
      p_currency: "USD", p_merchant_id: MERCHANT, p_payer_email: null, p_status_detail: null, p_captured_at: null, p_review_reason: null,
    });
    check("a signed-in user cannot call payment functions", Boolean(rpcError));
    const { data: upd } = await leadA.client.from("payments").update({ status: "succeeded" }).eq("id", paid.row.id).select("id");
    check("a signed-in user cannot change payment status", !upd?.length && (await paymentById(paid.row.id)).status === "refunded");
    const { error: ins } = await leadA.client.from("payments").insert({ proposal_id: charlie.id, provider: "paypal", amount_minor: 1, currency: "USD", status: "succeeded" });
    check("a signed-in user cannot insert payments", Boolean(ins));
    const { error: ent } = await leadA.client.from("payment_entitlements").select("id");
    check("a signed-in user cannot read entitlements", Boolean(ent));
    const { error: anonErr } = await h.anon.rpc("payment_begin_checkout", { p_token: charlie.token, p_session_hash: "a".repeat(64), p_environment: "sandbox" });
    check("anonymous callers cannot start checkouts directly", Boolean(anonErr));
  }

  // 15. Dashboard visibility ------------------------------------------------------
  {
    const listA = await leadA.client.from("payment_list").select("owner_id");
    const listB = await leadB.client.from("payment_list").select("owner_id");
    const listAdmin = await admin.client.from("payment_list").select("owner_id").in("owner_id", [leadA.id, leadB.id]);
    check("lead A sees only their payments", listA.data?.length > 0 && listA.data.every((r) => r.owner_id === leadA.id));
    check("lead B sees only their payments", listB.data?.length === 1 && listB.data[0].owner_id === leadB.id);
    check("admin sees both leads' payments", new Set(listAdmin.data?.map((r) => r.owner_id)).size === 2);

    // Search narrows to the purchase (lead A has many Charlie attempts).
    const htmlA = await dashboardHtml(leadA, `?tab=payments&q=${encodeURIComponent(`Alpha ${runId}`)}`);
    check("lead A payments tab lists their purchase", htmlA.includes(`Alpha ${runId}`) && htmlA.includes("data-payment-summary"));
    check("lead A does not see lead B's payment", !(await dashboardHtml(leadA, `?tab=payments&q=${runId}`)).includes(`Bravo ${runId}`));
    check("lead view has no Team Lead column", !/>Team Lead<\/th>/.test(htmlA));
    const htmlAdmin = await dashboardHtml(admin, `?tab=payments&q=${runId}`);
    const adminAlpha = await dashboardHtml(admin, `?tab=payments&q=${encodeURIComponent(`Alpha ${runId}`)}`);
    check(
      "admin payments tab shows both leads with their Team Lead",
      adminAlpha.includes(leadA.fullName) && htmlAdmin.includes(`Bravo ${runId}`) && htmlAdmin.includes(leadB.fullName),
    );
    check("admin summary keeps currencies separate", /data-currency="USD"/.test(htmlAdmin) && /data-currency="EUR"/.test(htmlAdmin));
    const filtered = await dashboardHtml(admin, `?tab=payments&owner=${leadB.id}`);
    check("admin filter by Team Lead", filtered.includes(`Bravo ${runId}`) && !filtered.includes(`Alpha ${runId}`));
    const refundedOnly = await dashboardHtml(leadA, "?tab=payments&status=refunded");
    check("status filter: refunded", refundedOnly.includes(`Alpha ${runId}`));
    check("capture reference shown", htmlAdmin.includes(euro.order.capture.id));
    check("no invented demo transactions", !/demo transaction|sample transaction/i.test(htmlA));
    void reversedRef;
  }

  // 16. Headers and indexing ---------------------------------------------------------
  {
    const b = browser();
    const res = await request(b, `/purchase/${"Z".repeat(22)}`);
    check("unknown purchase ref: noindex and no-store", (res.headers.get("x-robots-tag") ?? "").includes("noindex") && (res.headers.get("cache-control") ?? "").includes("no-store"));
    const st = await status(b, "Z".repeat(22));
    check("status endpoint is no-store", (st.headers.get("cache-control") ?? "").includes("no-store"));
  }

  // 17. Browser rendering (optional: CHROME_PATH) --------------------------------
  // The checkout click itself can't run in a browser here (the build's app
  // origin differs from this server's port, so the same-origin guard refuses
  // it, as it should); the paid states are reached over HTTP above and their
  // session cookies are handed to headless Chrome.
  if (process.env.CHROME_PATH) {
    const { launchBrowser } = await import("./lib/browser.mjs");
    const shots = join(OUT, "screens");
    const b = await launchBrowser({ chromePath: process.env.CHROME_PATH, outDir: shots, appUrl: PAY_URL });
    try {
      const withCookies = async (jar) => {
        await b.send("Network.clearBrowserCookies");
        for (const [name, value] of jar) await b.send("Network.setCookie", { name, value, url: PAY_URL, httpOnly: true, sameSite: "Lax" });
      };
      const noOverflow = () => b.evaluate("document.documentElement.scrollWidth <= innerWidth");
      for (const [width, height, mobile, tag] of [[1280, 900, false, "desktop"], [390, 844, true, "mobile"]]) {
        await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });

        await withCookies(new Map());
        await b.navigate(`/p/${charlie.token}`);
        check(`${tag}: client page shows 'Pay with PayPal' and the price`, await b.waitFor(`document.body.innerText.includes("Pay with PayPal") && document.body.innerText.includes("$40.00")`, 15000));
        check(`${tag}: client page has no horizontal scroll`, await noOverflow());
        await b.evaluate(`document.querySelector('#unlock-heading')?.scrollIntoView({ block: "start" })`);
        await sleep(400);
        await b.screenshot(`pay-01-client-${tag}`);

        await withCookies(euroBuyer.jar);
        await b.navigate(`/purchase/${euro.ref}`);
        check(
          `${tag}: purchase page renders the full document after payment`,
          await b.waitFor(`document.body.innerText.includes("Payment received successfully") && document.querySelectorAll('[data-rendered-page] canvas').length >= 1`, 20000),
        );
        check(`${tag}: viewer covers all purchased pages`, await b.waitFor(`document.body.innerText.includes("of 4")`, 10000));
        check(`${tag}: purchase page has no horizontal scroll`, await noOverflow());
        await b.screenshot(`pay-02-purchase-${tag}`);

        await b.navigate(`/p/${bravo.token}`);
        check(`${tag}: client link opens the paid view in the paying browser`, await b.waitFor(`!!document.querySelector('[data-paid-view] [data-rendered-page] canvas')`, 20000));
        await b.screenshot(`pay-03-paid-link-${tag}`);

        await withCookies(admin.jar);
        await b.navigate(`/dashboard?tab=payments&q=${runId}`);
        check(`${tag}: dashboard Payments tab renders`, await b.waitFor(`!!document.querySelector('[data-payment-summary]') && document.body.innerText.includes(${JSON.stringify(`Bravo ${runId}`)})`, 20000));
        check(`${tag}: dashboard Payments tab has no horizontal scroll`, await noOverflow());
        await b.evaluate(`document.querySelector('section[aria-labelledby=records-heading]')?.scrollIntoView({ block: "start" })`);
        await sleep(900); // entrance animation
        await b.screenshot(`pay-04-dashboard-${tag}`);
      }
      console.log(`       screenshots: ${shots}`);
    } finally {
      await b.close();
    }
  } else {
    console.log("skip   browser rendering checks (set CHROME_PATH to run them)");
  }

  const paymentsOfOthersAfter = await otherPayments();
  check("payments of real proposals untouched", paymentsOfOthersBefore === paymentsOfOthersAfter);
}

async function paymentsOf(user, statusName) {
  const { data } = await trusted.from("payments").select("id").eq("owner_id", user.id).eq("status", statusName);
  return (data ?? []).map((r) => r.id);
}

// Form-style dashboard action ([previousState, FormData]).
async function serverActionForm(user, name, fields) {
  const { createRequire } = await import("node:module");
  const require = createRequire(`${process.cwd()}/package.json`);
  const { encodeReply } = require("next/dist/compiled/react-server-dom-turbopack/client.edge.js");
  const id = actionId("dashboard/actions.ts", name);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${PAY_URL}/dashboard`, {
    method: "POST",
    headers: { cookie: user.cookie, "next-action": id, accept: "text/x-component", origin: PAY_URL },
    body: await encodeReply([{ status: "idle" }, form]),
    redirect: "manual",
  });
  const text = await res.text();
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+):([[{].*)$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  const head = JSON.parse(rows.get("0") ?? "{}");
  const ref = typeof head.a === "string" && head.a.startsWith("$@") ? head.a.slice(2) : null;
  return ref ? JSON.parse(rows.get(ref)) : head.a;
}

await h.run(async () => {
  try {
    await main();
  } finally {
    await cleanupPayments();
    stopServers();
    doubleServer.close();
    void BUCKET;
  }
});
