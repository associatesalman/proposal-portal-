# PayPal payments: setup, behaviour and verification

Payments use **PayPal Checkout with the Orders v2 REST API** (server-side create and capture, PayPal-hosted approval page) and **webhooks verified by PayPal's signature-verification API**. No PayPal SDK and no PayPal JavaScript run in the browser.

**Current state (2026-10-29):**

- **Sandbox verified.** The integration was tested end to end against the real **PayPal sandbox**, through an HTTPS tunnel, on the **local** Supabase stack. That run included a genuine buyer payment, genuine signed webhooks, PayPal re-delivering an event, a cancel, and a full refund. See [section 12](#12-verified-locally-vs-verified-with-paypal).
- **Live not connected.** There are no live credentials or live webhook, and no real-money transaction has been made.
- **Hosted and production are off.** Payments stay off until every setting below is present and valid, and `PAYMENTS_ENABLED` is `false`.

Contents

1. [What clients and Team Leads see](#1-what-clients-and-team-leads-see)
2. [Configuration (environment variables)](#2-configuration-environment-variables)
3. [Webhook: path, registration, events](#3-webhook-path-registration-events)
4. [Testing with a public HTTPS tunnel](#4-testing-with-a-public-https-tunnel)
5. [Access-recovery email](#5-access-recovery-email)
6. [PayPal "payment links" (compatibility check)](#6-paypal-payment-links-compatibility-check)
7. [How a payment is verified](#7-how-a-payment-is-verified)
8. [Refunds, reversals and the partial-refund policy](#8-refunds-reversals-and-the-partial-refund-policy)
9. [First controlled real transaction](#9-first-controlled-real-transaction)
10. [Deployment requirements](#10-deployment-requirements)
11. [Automated tests (test doubles)](#11-automated-tests-test-doubles)
12. [Verified locally vs. verified with PayPal](#12-verified-locally-vs-verified-with-paypal)
13. [Going live: checklist](#13-going-live-checklist)

---

## 1. What clients and Team Leads see

**Client page `/p/<token>`**

- **Payments off or incomplete:** the preview stays exactly as before, and the panel says *"Online payment will be available soon."*
- **Currency PayPal can't take** (AED, PKR): *"Online payment isn't available for AED. Please contact the person who sent you this link."* PayPal supports USD, EUR, GBP and JPY from this app's list (`src/lib/payments/money.ts`).
- **Configured:** a **Pay with PayPal** button shows the database price. The client approves on PayPal and comes back to `/purchase/<ref>`, which then moves through these states:
  - Processing (capturing)
  - Payment pending verification
  - Payment failed
  - Payment cancelled
  - Payment method declined (with *Continue on PayPal*)
  - Payment received successfully

  "Payment received successfully" appears **only** after the server has verified the capture with PayPal and stored an active entitlement.
- **Paid browser:** opening the client link again shows the **complete purchased PDF** in the same viewer. It survives refreshes, link revocation and link regeneration.
- **Another browser, or the link forwarded:** sees the preview and the pay button. Paid access is per browser and never per link.
- **Restore access:** see [section 5](#5-access-recovery-email) for email recovery, and the dashboard *Access link* below.

**Dashboard → Payments tab**

- **Columns:** Client · Proposal (with PDF revision) · Team Lead (CEO view only) · Amount · Status · Verified (date/time) · PayPal reference (capture id, or the order id before capture).
- **Who sees what:** the CEO sees every payment and can filter by Team Lead and status and search by proposal or client. A Team Lead sees only their own payments. Both are enforced by RLS and a security-invoker view, not only by the UI.
- **Summary:** completed count, pending count, and *Received, net of refunds* **grouped by currency**. Currencies are never added together. A warning appears when payments need review.
- **Updates:** while the tab is visible, the page refreshes every 20 s, at most 30 times. It pauses when the tab is hidden and stops when you leave. Lists are paginated.
- **Access link** (completed purchases): the payment's Team Lead or the CEO creates a single-use link, valid 72 h, and sends it to the client through their own channel. It restores access in whichever browser redeems it.
- **What's shown:** only real records. There is no demo data, and sandbox payments carry a *Sandbox* badge.

## 2. Configuration (environment variables)

All payment settings are **server-only**. None is `NEXT_PUBLIC_`. Problems are logged by variable **name** only and never by value. Missing or invalid settings leave payments unavailable, and login, the dashboard, previews and links keep working.

| Variable | Required | Value |
| --- | --- | --- |
| `PAYMENTS_ENABLED` | yes | `true` to enable. Anything else (or unset) = off. **Default off.** |
| `PAYPAL_ENVIRONMENT` | yes | `sandbox` or `live` |
| `PAYPAL_CLIENT_ID` | yes | REST app client ID (PayPal Developer Dashboard → Apps & Credentials) |
| `PAYPAL_CLIENT_SECRET` | yes | REST app secret. **Secret.** |
| `PAYPAL_MERCHANT_ID` | yes | The account that must receive the money: the PayPal **merchant account ID** (Account settings → Business information; 13 characters, upper-case letters/digits). Orders name it as payee, and a capture is only accepted if PayPal reports this payee. |
| `PAYPAL_WEBHOOK_ID` | yes | ID PayPal shows after you register the webhook ([section 3](#3-webhook-path-registration-events)) |
| `NEXT_PUBLIC_APP_URL` | yes | Already used for client links. Builds return/cancel URLs; `https://` required for `live`. Inlined at **build** time: rebuild after changing it. |
| `PAYPAL_BRAND_NAME` | no | Name shown on PayPal's page (≤127 characters) |
| `PAYMENT_ACCESS_DAYS` | no | Lifetime of a browser's paid access, default **180** days (OPEN_QUESTIONS Q4) |
| `PAYPAL_API_BASE_URL` | **tests only** | Points at a loopback test double. Refused for `live` and on Vercel production. Never set it in a real environment. |

Rate limits (optional overrides, `"<limit>/<window seconds>"`, defaults shown):

```
RATE_LIMIT_CHECKOUT_IP=20/600         RATE_LIMIT_CHECKOUT_TOKEN=30/600
RATE_LIMIT_PURCHASE_IP=120/60         RATE_LIMIT_PURCHASE_DOCUMENT_IP=60/60
RATE_LIMIT_RECOVERY_IP=10/900         RATE_LIMIT_RECOVERY_EMAIL=5/900
RATE_LIMIT_RECOVERY_CLAIM_IP=20/900   RATE_LIMIT_RECOVERY_ISSUE_USER=30/600
RATE_LIMIT_WEBHOOK_IP=240/60
```

Checkout, recovery and claims **fail closed** if the limiter is down. The webhook fails open, because PayPal's signature still has to verify.

Check them without revealing them: `npm run paypal:check` lists each variable as `ok`, `MISS` or `BAD` (names only, never values). `npm run paypal:check -- --auth` also asks the PayPal **sandbox** for an OAuth token to prove the client ID/secret pair works (no order, no charge; refused for live).

Where to put the values:

- **Local:** `.env.local`, which is never committed.
- **Vercel:** Project → Settings → Environment Variables. Use separate values for Preview and Production, and keep `sandbox` on anything that isn't production.

## 3. Webhook: path, registration, events

**Webhook URL** (exact path):

```
https://<your-domain>/api/payments/webhook
```

PayPal requires a public **HTTPS** URL. `localhost` can't be registered; see [section 4](#4-testing-with-a-public-https-tunnel).

**Registering the webhook** (once per environment; sandbox and live are separate apps):

1. PayPal Developer Dashboard → **Apps & Credentials** → choose *Sandbox* or *Live* → open the REST app → **Webhooks → Add webhook**.
2. Enter the URL above.
3. Select exactly these six events. This is the set used in the verified sandbox run:
   - `CHECKOUT.ORDER.APPROVED` (buyer approved but may not come back; the server captures)
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.PENDING`
   - `PAYMENT.CAPTURE.DECLINED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.CAPTURE.REVERSED`

   The handler also accepts `CHECKOUT.ORDER.COMPLETED` and `PAYMENT.CAPTURE.DENIED`. PayPal's current event list documents those two only for marketplace and v1 integrations, so they aren't needed for this Orders v2 checkout. Subscribing to them as well does no harm.
4. Save, then copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` and redeploy or restart. The ID is read at runtime, so a restart is enough and no rebuild is needed.
5. If only the host changes, for example a new tunnel, the same webhook can be moved with `PATCH /v1/notifications/webhooks/{id}` (`[{"op":"replace","path":"/url","value":"https://<host>/api/payments/webhook"}]`). The ID stays the same.

**How deliveries are handled** (`src/app/api/payments/webhook/route.ts`, `src/lib/payments/service.ts`):

- **Before anything is stored:** the size limit is 64 KB, and all five `PAYPAL-TRANSMISSION-*`/`PAYPAL-AUTH-ALGO`/`PAYPAL-CERT-URL` headers are required. The **raw** body is sent to `POST /v1/notifications/verify-webhook-signature`. Only `SUCCESS` continues; anything else gets `400` and nothing is stored.
- **When verification can't run:** if PayPal is unreachable or the database fails, the answer is `5xx` and PayPal retries the delivery (PayPal documents up to 25 retries over 3 days).
- **Dedupe:** each event id is recorded once, so duplicates answer `200 duplicate`. Unknown orders are acknowledged as `unmatched` and grant nothing.
- **The event only triggers work.** Its payload is not trusted for state: the server **re-reads the order from PayPal** and applies that. The one exception is `PAYMENT.CAPTURE.REVERSED`, which can only *remove* access and must name the payment's known capture.

## 4. Testing with a public HTTPS tunnel

For a sandbox test from your machine, PayPal must be able to reach the webhook. The setup below keeps sandbox data **out of the hosted database**, and leaves `.env.local` and your dev server on port 3000 unchanged.

1. **Local stack.** Start the local Supabase stack. `scripts/sandbox-local.mjs` takes the Supabase URL and keys from `npx supabase status`, and refuses anything that isn't `127.0.0.1`.
2. **Overrides file.** Put the sandbox-only overrides in **`.env.sandbox.local`** (git-ignored by `.env*`). PayPal credentials stay in `.env.local`.
   ```
   NEXT_PUBLIC_APP_URL=https://<tunnel-host>
   PAYMENTS_ENABLED=true
   PAYPAL_WEBHOOK_ID=<sandbox webhook id>
   ```
3. **Tunnel.** Start a tunnel that exposes **only** the sandbox app port: `cloudflared tunnel --no-autoupdate --url http://localhost:3106`. This Cloudflare quick tunnel needs no account.
4. **Build and run.** `NEXT_PUBLIC_APP_URL` is compiled into the build, so rebuild whenever the tunnel host changes:
   ```
   node scripts/sandbox-local.mjs npm run build
   node scripts/sandbox-local.mjs node node_modules/next/dist/bin/next start -p 3106
   ```
   These commands rewrite `.next`. Rebuild with your normal configuration afterwards.
5. **Webhook.** Register (or move, [section 3](#3-webhook-path-registration-events)) `https://<tunnel-host>/api/payments/webhook` on the **sandbox** app.
6. **Open the client link through the tunnel URL.** The session cookie becomes `__Host-pp_session` (Secure) on https.
7. **Refund.** Use `node scripts/sandbox-local.mjs node scripts/sandbox-refund.mjs <public_ref> [--confirm]`. It does a dry run without `--confirm`. It uses the sandbox host only and payments in the local database only. It doesn't touch the database: the app learns of the refund from the `PAYMENT.CAPTURE.REFUNDED` webhook, as in production.
8. **Clean up.** When done, stop the tunnel and the 3106 server, and rebuild with your normal configuration.

**Tunnel findings from the sandbox run:**

- **Pinggy free tunnels don't work for the viewer.** They show browsers a "trust this website" interstitial. The preview fetch is sent without credentials, so Pinggy answered it with its HTML page instead of the PDF, and the viewer said *"The preview couldn't be displayed."* The app was right not to work around this.
- **localhost.run free tunnels are unusable here.** They have no interstitial, but they throttle and stall on larger responses: the PDF.js worker and JavaScript chunks never finished loading.
- **Cloudflare quick tunnels worked.** There was no interstitial, files loaded fast, and the tunnel has no fixed expiry. It stops when the process, the PC or the network does.

## 5. Access-recovery email

There are two ways for a client to restore access in another browser. Neither works from just a typed email or a public reference:

- **Dashboard access link** (works now): the Team Lead or CEO clicks *Access link* on a completed payment and sends the single-use 72 h link themselves.
- **Email link** (needs a provider): the client enters their email under *Already paid in another browser or device?*.
  - If it matches the **PayPal payer email** or the **portal client's email** of an active purchase of *that* proposal, a single-use link valid 30 minutes is **emailed to that address**. The page answers the same way either way.
  - At most 3 open links per purchase; rate-limited.

**How redemption works:** opening a link does not use it up, so mail scanners can't burn it. The client presses *Restore access in this browser*, which sends a same-origin POST. That redeems the link atomically and sets this browser's HttpOnly cookie.

**Email provider:** a Resend adapter is included (`src/lib/payments/email.ts`). To enable it:

```
RECOVERY_EMAIL_PROVIDER=resend
RESEND_API_KEY=<secret>
RECOVERY_EMAIL_FROM="Proposals <billing@your-domain>"   # domain verified in Resend
```

Without all three, the email form is hidden and the endpoint answers `503`. Another provider means another adapter in that one file. `RECOVERY_EMAIL_API_BASE_URL` exists for the test double only (loopback; ignored on Vercel production). **Real email delivery has not been tested.**

## 6. PayPal "payment links" (compatibility check)

PayPal's no-code **payment links / PayPal.Me / hosted buttons** are **not compatible** with this app's unlock logic. Do not paste one into a proposal and expect it to unlock anything. A capture is accepted only if all of these hold:

- the PayPal order was **created by this server**;
- its purchase unit's `custom_id`/`reference_id` equals the internal payment id (one per checkout and browser);
- the payee is `PAYPAL_MERCHANT_ID`;
- the amount and currency equal the stored checkout snapshot.

A no-code link can't carry a per-checkout id. A payment made through one shows up, at most, as an `unmatched` webhook event and **grants nothing**. That is intentional.

**Compatibility check for any PayPal product you consider using instead:**

1. Does it create an **Orders v2** order through *our* REST app?
2. Can **we** set `custom_id` per checkout?
3. Can we capture it, or read it back with `GET /v2/checkout/orders/{id}`?

All three must be yes.

## 7. How a payment is verified

**Checkout** (`POST /p/<token>/checkout`):

1. The request must be same-origin (Origin and Sec-Fetch-Site) and is rate-limited. The **only** input is the link token; any amount, currency, owner or path in the body is ignored.
2. In one transaction, `payment_begin_checkout` locks the proposal and confirms it is active, not being deleted, and has its revision file in storage. It then writes a payment row with the **database** price and currency, the immutable PDF revision path, page counts, title/client/Team Lead snapshots, and the SHA-256 of this browser's HttpOnly session cookie.
3. A second click from the same browser reuses the open attempt, so there is no second order.
4. The PayPal order is created with `PayPal-Request-Id` set to the row's request id (idempotent), and its order id is stored **before** the browser is redirected.

**Return and capture** (`POST /purchase/<ref>/status`):

- **Who can call it:** only the browser bound to the checkout.
- **Capture:** the capture uses a fixed `PayPal-Request-Id`. If its response is lost, or PayPal says the order was already captured, the order is re-read.
- **Checks on the result** (`src/lib/payments/verify.ts`):
  - order id;
  - exactly one purchase unit with our payment id;
  - payee = configured merchant;
  - exactly one capture with our `custom_id`;
  - capture status;
  - **exact** amount and currency.
- **Database re-check:** `payment_apply_state` checks again under a row lock: order and capture references, amount, currency, payee and file. Status moves only forward, so a late `PENDING`/`FAILED`/duplicate never undoes a verified payment. Any mismatch → **needs review**, no access.

**Access:**

- **First verified state:** one entitlement is created for this payment and revision, and the **initiating browser** gets an access session (HttpOnly; Secure on https; SameSite=Lax; 180 days).
- **Every request is re-checked:** each full-PDF request (`GET /purchase/<ref>/document`) is authorized in the database (active entitlement plus an unexpired access session for this browser). Responses are `no-store`, `Cross-Origin-Resource-Policy: same-origin`, `noindex`.
- **Never trusted:** the return URL, `?result=`, browser callbacks, screenshots and unverified webhooks never change a payment.
- **Retention:** proposals with payment records can't be deleted, and purchased revision files are excluded from storage cleanup and deletion, even after the proposal's PDF is replaced.

## 8. Refunds, reversals and the partial-refund policy

- **Full refund** (`REFUNDED`) or **reversal/chargeback** (`PAYMENT.CAPTURE.REVERSED`): the payment becomes `refunded`/`reversed`. Its entitlement is **suspended** and every access session stops working on the next request. Outstanding recovery links also stop working. The financial record and history are kept.
- **Partial refund** (`PARTIALLY_REFUNDED`), the policy: **access is kept.** The payment shows *Partially refunded*, and the received total is shown net of refunds. A partial refund is treated as a goodwill or price adjustment by the merchant. To end access as well, refund the full amount.
- **Restoring suspended access** is not automatic. A later completed event never re-activates a refunded purchase; the client has to pay again.
- **Refunds are issued in PayPal**, not in this app. The app only records them, from the order representation.

## 9. First controlled real transaction

**Sandbox: done (2026-10-29).** The steps below were carried out with a disposable proposal, a separate Sandbox Personal buyer and the local stack ([section 12](#12-verified-locally-vs-verified-with-paypal)). Declined-card negative testing was not run. Repeat these steps on the production deployment with sandbox credentials before going live.

1. In the PayPal Developer Dashboard, create a sandbox REST app and use the sandbox business account's merchant ID.
2. Set the [section 2](#2-configuration-environment-variables) variables with `PAYPAL_ENVIRONMENT=sandbox`, run through a tunnel ([section 4](#4-testing-with-a-public-https-tunnel)) or on staging, and register the sandbox webhook.
3. Create a **disposable** proposal; don't use a real client's. Pay with a sandbox *personal* account, then confirm:
   - the success page and the full PDF appear;
   - the dashboard shows *Completed* with the capture id;
   - the webhook events show `applied` (table `payment_events`);
   - a second browser sees only the preview.
4. Refund it in the sandbox merchant account, then confirm access ends and the payment shows *Refunded*.
5. Try a cancel and a declined card (PayPal sandbox negative testing) and confirm no access is granted.

**Live, one low-value payment (not done; needs separate authorization):**

1. Create a live REST app, set the live credentials, `PAYPAL_ENVIRONMENT=live`, the live merchant ID, and an https `NEXT_PUBLIC_APP_URL`. Register the live webhook.
2. Create a disposable proposal at the smallest price you're comfortable with, in USD/EUR/GBP/JPY. Pay with a real PayPal account you control.
3. Check the same points as in sandbox. Confirm that the PayPal merchant account received the money.
4. Refund it in PayPal, then confirm suspension.
5. Delete nothing. The payment record keeps the proposal by design. Archive it in your own records.

## 10. Deployment requirements

- **Migrations:** all 15 files in `supabase/migrations/` are required, in order. Use `supabase db push` and review the dry run first. The hosted project `hpsrgoiwndbcquejhyuf` already has all 15, up to and including `20261103090000_remove_manual_full_access.sql`.
- **Environment variables:** as in [section 2](#2-configuration-environment-variables), server-only. **Never** set `PAYPAL_API_BASE_URL` or `RECOVERY_EMAIL_API_BASE_URL` in a real environment.
- **HTTPS everywhere:** cookies are `__Host-` + Secure there.
- **Rate limits:** `RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip` on Vercel (Phase 7), so payment rate limits key on the real address.
- **Webhook:** registered per environment, with its ID set.
- **Keep payments off until each step is ready:** leave `PAYMENTS_ENABLED` unset until the sandbox test in [section 9](#9-first-controlled-real-transaction) has passed on that deployment.

## 11. Automated tests (test doubles)

```
npm run db:test                       # pgTAP: phase9_payments.test.sql (113 checks) + earlier phases
npm run build
npm run test:payments                 # 157 checks with CHROME_PATH=…/chrome.exe (HTTP + browser)
```

`test:payments` starts:

- a local **PayPal + email test double** on 127.0.0.1:54510. It fakes OAuth, create, capture and show order, and signature verification (accepting only its own marker). It can force pending, declined, wrong-amount and wrong-payee captures, lost responses, refunds and outages.
- two dedicated app servers: **3102**, configured to use the double, and **3103**, enabled but missing credentials.

It uses disposable users and proposals only. Payment rows are removed first, and existing accounts, proposals, files and payments are snapshotted and must be unchanged. Your dev server (port 3000) is not touched.

The checkout click itself isn't driven in Chrome: the build's inlined `NEXT_PUBLIC_APP_URL` origin differs from the test port, and the same-origin guard correctly refuses that. The paid states are reached over HTTP and then rendered in Chrome.

## 12. Verified locally vs. verified with PayPal

**Verified locally (test doubles):** everything in [section 7](#7-how-a-payment-is-verified) and [section 8](#8-refunds-reversals-and-the-partial-refund-policy) as this app implements it. That covers:
- checkout binding and idempotency;
- the forged-success guards, capture, and review on mismatch;
- the webhook signature gate, dedupe, and out-of-order and race handling;
- refunds and reversals, partial refunds, and recovery;
- RLS, the dashboard, headers and rendering.

**Verified with the real PayPal sandbox (2026-10-29).** The run used the local Supabase stack and a Cloudflare HTTPS tunnel, with a disposable USD 5.00 proposal (3 of 6 pages free) and a separate Sandbox Personal buyer:

- **Before payment.** Only the 3-page preview PDF reaches the browser. The page HTML and the DOM contain no locked-page text, and the original, download and document routes return 404. Checked in headless Chrome: all 3 pages render, and navigation works.
- **Checkout.** PayPal accepted the Orders v2 order with `payee.merchant_id`. The buyer approved it on PayPal, and the capture completed. The payee PayPal reported equals `PAYPAL_MERCHANT_ID`; this was the first proof that the merchant ID is correct.
- **Webhooks.** Genuine `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` deliveries passed signature verification and were applied.
- **Duplicate delivery.** PayPal's resend API (`POST /v1/notifications/webhooks-events/{id}/resend`) re-delivered the same signed event. Its attempt count went up, with no second entitlement or event row.
- **Paid access.** In the paying browser, pages 4–6 rendered. Full screen, refresh and **Download PDF** (an attachment, `no-store`) all worked.
- **Forwarded link.** A forwarded client link or purchase URL still showed only the preview. The document and download routes returned 404, and the status endpoint returned 404 (or 403 cross-origin).
- **Payments tab.** The CEO saw client, proposal, Team Lead, US$5.00 and status. The owning lead saw the payment, and another lead could neither see it nor issue an access link for it.
- **Recovery.** A dashboard access link restored access in a new browser and could not be used twice. Email recovery answered 503 because no email provider is configured, so a typed email or a public reference grants nothing.
- **Cancel or tampered return.** A new unapproved order: a capture attempt answered `awaiting_approval`, and cancel recorded `cancelled`. Neither created an entitlement or served a document.
- **Full refund.** A full refund through the Refunds API was followed by the genuine `PAYMENT.CAPTURE.REFUNDED` webhook. The payment went to `refunded` (amount and record kept, refund row stored), and the entitlement was suspended rather than deleted. The previously paid browser got 404 for the document and download on its next request. No new access link could be issued, and the CEO view shows *Refunded*.

**Real PayPal response incompatibilities found:** none. The app needed no change for real PayPal responses. The sandbox run surfaced a tunnel problem (the Pinggy interstitial, [section 4](#4-testing-with-a-public-https-tunnel)) and a libuv exit assertion in the helper scripts on Windows, fixed by setting `process.exitCode` instead of calling `process.exit()` after `fetch`.

**Still not verified:**
- live credentials and payouts;
- a real-money payment and refund;
- `PENDING`, `DECLINED` and `REVERSED` from real PayPal (covered by test doubles only);
- sandbox negative-testing codes;
- the partial-refund path against real PayPal;
- real email delivery.

## 13. Going live: checklist

Each step is a separate decision. Use placeholders here and never commit values.

1. **Code.** Commit and push the reviewed changes, then deploy to the production host (for example Vercel) on your own domain over **HTTPS**.
2. **Hosted Supabase Auth.** Public signup is currently **enabled** on the hosted project. In Dashboard → Authentication → Sign In / Providers, turn off **Allow new users to sign up**. Review the password policy (minimum length and required characters) under Authentication settings.
3. **PayPal live app.** Your live **Business** account must be verified. In developer.paypal.com → Apps & Credentials → **Live**, create a REST app. Take the Live Client ID and Secret from that app. Take the merchant ID from paypal.com → Account settings → Business information → **Merchant account ID**.
4. **Live webhook.** On the live app, add `https://<your-domain>/api/payments/webhook` with the six events in [section 3](#3-webhook-path-registration-events), and copy its Webhook ID.
5. **Production environment** (hosting dashboard only):
   ```
   NEXT_PUBLIC_APP_URL=https://<your-domain>
   NEXT_PUBLIC_SUPABASE_URL=<hosted project URL>
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<hosted publishable key>
   SUPABASE_SECRET_KEY=<hosted secret key>
   PAYPAL_ENVIRONMENT=live
   PAYPAL_CLIENT_ID=<live client id>
   PAYPAL_CLIENT_SECRET=<live client secret>
   PAYPAL_MERCHANT_ID=<live merchant account id>
   PAYPAL_WEBHOOK_ID=<live webhook id>
   RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip
   PAYMENTS_ENABLED=false
   ```
   Optional: `PAYPAL_BRAND_NAME`, `PAYMENT_ACCESS_DAYS`, and the recovery email settings in [section 5](#5-access-recovery-email). Never set `PAYPAL_API_BASE_URL` or `RECOVERY_EMAIL_API_BASE_URL`. Never reuse sandbox values in production.
6. **Deploy with payments off,** then check that login, the dashboard and client previews work on the domain.
7. **Turn payments on** (`PAYMENTS_ENABLED=true`), then do **one** small real payment and a full refund ([section 9](#9-first-controlled-real-transaction)). Confirm unlock, `payment_events` `applied`, the money in the merchant account, and suspension after the refund. This step needs separate authorization.
8. **Monitor.** Watch PayPal's webhook delivery log and the Payments tab, and act on any *needs review*.
