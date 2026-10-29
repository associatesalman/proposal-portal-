# Open Questions

None of these block phases 1–8. The defaults below are the working assumptions until someone decides otherwise.

## Payments (Phase 8: PayPal chosen and built; see PAYPAL_SETUP.md)

| # | Question | Status |
| --- | --- | --- |
| P1 | Which payment provider/gateway? | **Decided: PayPal Checkout (Orders v2 REST).** |
| P2 | Hosted checkout/redirect, or embedded? | **Hosted redirect** to PayPal's approval page. No PayPal JS in the browser. |
| P3 | Webhook signature scheme? Unique event id? | **PayPal postback verification** (`verify-webhook-signature`, raw body); events carry a unique `id` (deduped). |
| P4 | Server-to-server verification API? | **Yes:** `GET /v2/checkout/orders/{id}`. Every webhook and poll re-reads the order. |
| P5 | Currencies? | PayPal accepts USD, EUR, GBP, JPY from our list; **AED and PKR can't be paid online** (notice shown). Open: should leads be warned when choosing AED/PKR? |
| P6 | Payer email? | Returned by PayPal and stored server-side; used only to match email-recovery requests, never alone to identify the client. |
| P7 | Refunds? | Full refund or reversal suspends access. **Partial refund keeps access (policy).** Open: confirm this policy. |
| P8 | Sandbox/live credentials, webhook registration? | **Open:** waiting for the merchant account details (PAYPAL_SETUP §2–3). PayPal publishes no fixed webhook IP list to allow-list; signature verification is the control. |
| P9 | Email provider for access recovery? | Resend adapter included; **open:** which provider/sender domain (or rely on dashboard access links only). |
| P10 | Retention: proposals with payment records (even abandoned checkouts) can't be deleted. | **Open:** archive workflow and retention period (also Q9). |

## Product

| # | Question | Working assumption |
| --- | --- | --- |
| Q1 | Default currency (and should leads be able to pick any currency)? | Lead picks from a short allow-list. Default pending |
| Q2 | Maximum upload size? | 20 MiB and 300 pages (`PDF_MAX_UPLOAD_MB`, `PDF_MAX_PAGES`; bucket hard limit 25 MiB). Measured in Phase 7 with real fixtures: stable with a wide margin |
| Q3 | Can a proposal be fully free (`free_pages = page_count`)? | Allowed, but the unlock button is hidden |
| Q4 | Paid-access cookie lifetime? | 180 days (`PAYMENT_ACCESS_DAYS`; implemented in Phase 8) |
| Q5 | Recovery preference: recovery code vs. emailed magic link | **Decided in Phase 8:** single-use links: issued from the dashboard by the lead/CEO (works now), or emailed to the payer/client address (needs an email provider, P9). No recovery codes. |
| Q6 | Should links expire automatically after N days? | No expiry; manual disable/regenerate |
| Q7 | Watermark the full PDF with buyer email? | Not planned (out of scope) |
| Q8 | When the admin creates a proposal, who owns it — admin, or a chosen lead? | Admin can choose the owning lead |
| Q9 | Should leads be able to delete proposals/clients, or only disable them? | Decided in the feature update: leads can permanently delete their own proposals and the CEO any proposal, through a trusted workflow that removes storage. Proposals with payment records are refused until a retention/archive workflow exists (open: what that archive keeps and for how long). Clients: delete only if they have no proposals (unchanged) |
| Q10 | Password reset for internal users: Supabase email reset, or admin resets manually? | Admin resets manually in Supabase |
| Q11 | Preview delivery on the production host (added in Phase 5): can the hosting plan stream previews larger than its function response limit (Vercel documents 4.5 MB)? | Phase 7 finding: Vercel's 4.5 MB limit applies to buffered request/response bodies; Vercel's guidance says streaming functions don't have this limit, and streaming is on by default for Node.js functions. The preview route already streams. Keep streaming (instant revocation); still unmeasured: check H14 on the staging deployment (HOSTED_STAGING_SETUP.md). Note that preview URLs are behind Vercel Authentication, so it is measured on the staging project's production URL. Signed URLs only if that test fails, as a documented change to revocation |
| Q12 | Which edge header carries the real client address in production (rate limiting)? | Vercel: `x-real-ip` (`RATE_LIMIT_CLIENT_IP_HEADER`). Vercel docs confirm it overwrites `X-Forwarded-For`/`X-Real-IP` (no client spoofing). Still to test on staging (check H11 in HOSTED_STAGING_SETUP.md) |
| Q13 | Who runs the scheduled storage cleanup, and where does the secret key live for it? | A daily trusted job (CI schedule or ops host) running `npm run storage:cleanup -- --apply`, after a few reviewed dry runs |

## Branding

| # | Question |
| --- | --- |
| B1 | Company name, logo, colors and font for the client page and dashboard |
| B2 | Custom domain for private links (affects `NEXT_PUBLIC_APP_URL`) |
| B3 | Client-page wording (unlock CTA, legal/terms text, support contact) |
