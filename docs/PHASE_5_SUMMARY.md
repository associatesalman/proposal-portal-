# Phase 5 — Client Proposal Page and Secure PDF Preview Viewer

Phase 5 replaces the Phase 4 placeholder at `/p/[token]` with the client-facing proposal page. A client opens their private link without an account and sees:
- the proposal title;
- the free/total/locked page counts;
- a PDF.js viewer showing only the free preview pages;
- a notice of which pages are locked and the unlock price;
- "Online payment will be available soon."

**Payments and full-document unlock are not implemented.** There is no payment button, checkout, simulated payment or route that serves the original PDF. That is Phase 6.

The internal dashboard and login page were not redesigned. Only the new client page uses the white/blue style.

## 1. Client page (`src/app/p/[token]/page.tsx`)

| Shown | Source |
| --- | --- |
| Title | `resolve_proposal_offer(token)` |
| "Free preview: X of Y pages." plus three count tiles (Preview pages, Total pages, Locked pages) | Same, with locked = total − free |
| PDF viewer | `GET /p/[token]/preview` (§2), PDF.js (§3) |
| Locked notice: "N pages are locked. Pages X+1–Y of Y are not included in this preview. The full document can be unlocked for €1,250.50 (EUR)." (singular wording for one page) | Price formatted with `Intl.NumberFormat` from integer minor units: 2 decimals for EUR, USD, GBP, AED and PKR; 0 for JPY |
| "Online payment will be available soon." | Static text, with no button or form |
| "This page is private to whoever holds the link. Anyone you forward it to can open the same preview." | Honest statement of the bearer-link model |

**Never shown or sent to the browser:** client name or email, owner name or id, proposal id, storage paths, file names, token hash, payments, timestamps. The test suite checks the page HTML for each of these.

**Style:** white background, slate-900 text, subtle slate borders, blue-600 accents and compact spacing.
- `globals.css` forces the page light (`body:has([data-client-page])`) even when the visitor's OS uses a dark colour scheme. Other routes are unaffected.

**Unavailable state:** malformed, unknown, revoked (draft) and archived links render the same "This link isn't available" card. The page never reveals whether a proposal exists.

**Headers:** `Cache-Control: private, no-store, max-age=0`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow, noarchive`, from `next.config.ts` for `/p/:token*`. The page also has robots and referrer meta tags. `/p/*` is excluded from the auth proxy and from Next's request log.

There is no client signup, login or extra dashboard.

## 2. Preview delivery and authorization (`src/app/p/[token]/preview/route.ts`)

`GET /p/<token>/preview` streams the preview PDF through the app:

1. The token format is checked (43 base64url characters). Anything else gets **404 "This link isn't available."**
2. `openPreviewForLink(token)` in `src/lib/supabase/privileged.ts` calls `resolve_proposal_preview_object(token)` with the server-only secret key.
   - The function matches only an **active** proposal whose stored SHA-256 hash equals the token's hash, with a preview path that differs from the original's.
   - It returns that **preview** path and nothing else. No match gives the same **404**.
3. Only then is storage read: `download(path).asStream()` for exactly that path. The bytes are streamed to the client with no buffering of the whole file.
4. **Response headers:**
   - `Content-Type: application/pdf`
   - `Content-Disposition: inline; filename="preview.pdf"`
   - `Cache-Control: private, no-store, max-age=0`
   - `X-Content-Type-Options: nosniff`
   - `Cross-Origin-Resource-Policy: same-origin`
   - `Referrer-Policy: no-referrer`
   - `X-Robots-Tag: noindex, nofollow, noarchive`
5. If the link is valid but the preview object is missing or storage fails, the response is **503 "The preview is temporarily unavailable."** with `Retry-After: 5`. The message carries no path or storage detail.
   - This reveals nothing new, because the holder of a valid link has already seen the title.
   - The server logs only `[preview] preview object missing` or `storage read failed`, never the token or path.

**Why it can't leak other content:**
- **The token is the only input.** Query strings (`?path=`, `?id=`, `?token=`), headers and extra path segments are ignored.
- **No route can name a path or proposal id**, and none serves the original: `/p/<token>/original`, `/document` and the planned `/api/access/...` routes all return 404.
- **The original's path is never selected.** The SQL function can't return it, the server checks the path ends in `/preview.pdf`, and storage is only read for the resolved path.
- **The bucket stays private.** Anonymous storage download, signed-URL creation, the public object URL and the authenticated object route with the anon key are all denied (tested).
- **The privileged key never reaches the browser.** No signed or storage URL is ever sent to the client.

**Why streaming rather than signed URLs:**
- Each preview request is authorized against the database **at that moment**, so revoking a link blocks the next request immediately. A signed URL would stay valid for its lifetime.
- The browser never learns a storage URL.

**Privileged access is narrow.** The secret key is used for exactly one storage read per request, after the database has matched the token. It is still never used for dashboard reads or lists, and never sent to the browser. The page's metadata lookup uses the publishable key.

### Database change (forward migration `20261029090000_phase5_client_page_resolvers.sql`)

Phase 4's `resolve_proposal_link` returns only the title, which isn't enough for the page, and there was no way to resolve the preview path. The smallest compatible change was to add two functions and leave everything else alone. No table, grant, RLS or storage policy changed.

| Function | Executable by | Returns |
| --- | --- | --- |
| `resolve_proposal_offer(p_token)` | anon, authenticated, service_role | `title, total_pages, free_preview_pages, unlock_price_minor, currency` of an active, fully prepared proposal |
| `resolve_proposal_preview_object(p_token)` | **service_role only** | That proposal's `preview_storage_path` |

- Both are `SECURITY DEFINER` with `search_path = ''`.
- Both reject malformed tokens, hash the token with `extensions.digest`, and match nothing for draft (revoked), archived or unprepared rows.
- `resolve_proposal_link` is kept unchanged for compatibility, and the app no longer calls it.

## 3. Viewer (`src/components/proposals/preview-viewer.tsx`)

**Loading:**
- **Fetching:** the viewer `fetch`es `/p/<token>/preview` with `cache: "no-store"` and `credentials: "omit"`, then gives the bytes straight to PDF.js. No object URLs are created, and nothing else is requested.
- **On-demand import:** `pdfjs-dist/legacy/build/pdf.mjs` is imported dynamically when the viewer mounts, so it ships as a separate ~490 KB chunk that only the client page loads.
  - The legacy build is used for compatibility with older client browsers.
  - A test confirms that no dashboard script and no initial script of the client page contains PDF.js.
- **Local assets:** `scripts/copy-pdfjs-assets.mjs` runs before `dev` and `build`. It copies the matching worker, standard fonts, CMaps, ICC profiles and image-decoder wasm into `public/pdfjs/<version>/`. That folder is gitignored, cached as immutable and excluded from the proxy.
  - Nothing comes from a CDN, and no third-party scripts or viewer services are used.
  - PDF scripting (quickjs) is not copied, XFA is disabled, and the worker version is checked against the library.
- **No endless spinner:** a 30 s timeout covers the fetch and the parse.
- **Cleanup:** unmounting or retrying aborts the fetch and calls `loadingTask.destroy()`, which destroys the document and terminates its dedicated worker.

**Rendering:**
- **One page at a time, on demand.** Only the current page is rendered. Locked pages don't exist in the file, so nothing (canvas, text or thumbnails) can be produced for them.
- **No stale renders.** Each render cancels the previous `RenderTask` and `TextLayer`, draws into a new canvas, and swaps it in only when finished. The old canvas's memory is released (width and height set to 0).
  - Rapid page and zoom clicks end with exactly one canvas and one text layer, matching the page shown (tested).
- **Canvas size cap.** The backing store is capped at 4096² pixels (~16.7 MP). Very large pages, such as 200 × 200 in at 300 %, render at a lower pixel density instead of exhausting memory (tested).
- **Selectable text.** A text layer (CSS adapted from `pdf_viewer.css`, Apache-2.0) makes preview text selectable and findable with the browser's find-in-page (tested).

**Controls:**
- **Navigation:** Previous/Next, plus "Page N of M", announced politely to screen readers.
- **Zoom:** in and out from 50 % to 300 % in ×1.25 steps, where 100 % is printed size. Steps build on the requested level, so quick clicks add up. **Fit width** is the default and refits on resize and rotation (ResizeObserver).
- **Keyboard:** when the viewer has focus, ←/→, PageUp/PageDown, Home/End and +/−. All controls are native buttons with accessible names, in a sensible Tab order.
- **Mobile:** at 390 px the toolbar wraps and centres, buttons are at least 36 px, the page fits the width, and a zoomed page scrolls inside the viewer without making the whole page scroll sideways.

The UI keeps three numbers distinct: preview pages, total pages and locked pages. On the last preview page it adds: "End of the free preview. The remaining N pages are locked."

**States:**

| Situation | What the client sees |
| --- | --- |
| Loading | "Loading preview…" (role=status); after 30 s, the timeout error |
| Network failure | "We couldn't load the preview. Check your connection and try again." + **Try again** |
| 503 (missing object or storage error) | "The preview is temporarily unavailable. Please try again in a moment." + **Try again** |
| Unreadable or corrupt PDF, or a render failure | "The preview couldn't be displayed. Please try again." + **Try again** (page-level render errors retry just that page) |
| 404 (link revoked or invalid after the page loaded) | "This link is no longer available. It may have been withdrawn…" + **Check again** |

**Try again** and **Check again** always issue a new request to the server, so access is re-checked. A cached result is never reused.

No claim of "download prevention" is made. Anything delivered to a browser can be saved or captured.

## 4. Revocation and downloaded content

- **Revoking** (dashboard → Manage PDF → Revoke link) returns the proposal to Draft and clears the hash in one transaction. From that moment:
  - every new preview request gets the generic 404;
  - reloading the page shows "This link isn't available";
  - **Check again** in an open viewer stays unavailable.
- **Already downloaded content stays with the client.** A viewer that already downloaded the preview before revocation keeps showing those pages until the tab is reloaded, and the client may have saved them. Revocation prevents new requests and continued access on reload. It can't remove bytes already delivered.
- **The "revoked mid-load" case** (the request paused in the browser, the link revoked, then the request released) ends in the "no longer available" state. This is tested.

## 5. Environment

- **No new environment variables.** The preview endpoint uses the existing server-only `SUPABASE_SECRET_KEY` (Phase 4).
- **Local migration:** apply it with `npx supabase migration up`. It was already applied on this machine without a reset.
- **PDF.js assets:**
  - `npm run dev` and `npm run build` now run `scripts/copy-pdfjs-assets.mjs` first (`predev` / `prebuild`).
  - A dev server that was already running before this phase didn't run it. The script was run manually once, so `public/pdfjs/6.4.299/` exists.
  - After a fresh clone or a `pdfjs-dist` upgrade, run `npm run dev` / `npm run build` (or `node scripts/copy-pdfjs-assets.mjs`).

## 6. Tests run

Local Supabase stack plus a production build (`npm run build && npx next start -p 3100`, `APP_URL=http://localhost:3100`).

| Check | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run db:test` (pgTAP, Phases 2–5, 4 files) | 156/156 |
| `npm run test:integration` (Phase 2 API/RLS/storage) | 34/34 |
| `npm run test:app` (Phase 2 auth) | 17/17 |
| `npm run test:dashboard` (Phase 3) | 38/38 |
| `npm run test:pdf` (Phase 4) | 72/72 |
| `npm run test:client` (Phase 5, new) | 70/70 |
| `npm run test:browser` (Phase 3 headless Chrome) | 28/28 |
| `npm run test:pdf-browser` (Phase 4 headless Chrome) | 27/27 |
| `npm run test:client-browser` (Phase 5 headless Chrome, new) | 64/64 |

**pgTAP Phase 5** (`phase5_client_resolvers.test.sql`, 24 checks):
- **Grants:** anon may call the offer resolver; only service_role may call the path resolver (not PUBLIC, anon, or authenticated, including the owner).
- **Return values:** exact fields and values for two tokens, and the preview path, never the original's.
- **Rejected tokens:** unknown, malformed, null and hash-as-token.
- **Revocation:** a revoked link stops resolving immediately while the other link keeps working.
- **Anon** still has no table access.

**`test:client`** creates three proposals through the real dashboard server actions, as three disposable leads. The fixtures have distinctive text: FREEMARK on free pages, LOCKEDMARK on locked pages. Then, anonymously, it checks:
- **The page:**
  - the title, "Free preview: 2 of 5 pages.", the tiles and the locked range;
  - €25.00 (EUR), ¥1,500 (JPY) and the singular wording;
  - the payment notice, with no form or payment button;
  - the headers;
  - **none** of: proposal id, owner id, client email or name, owner name, both storage paths, the file name, the token hash, the storage URL, "original.pdf".
- **The delivered preview bytes,** parsed with PDF.js:
  - exactly 2, 3 and 1 pages, which are pages 1..N with FREEMARK;
  - **no LOCKEDMARK** in the extracted text, or in the raw or inflated bytes (literal or hex);
  - no original title metadata;
  - not the original's bytes.
  - A control check confirms the original *does* contain LOCKEDMARK, so the test can detect a leak.
- **Isolation:** three links give three different previews, each byte-identical to its own stored object and containing only its own pages.
- **Tampering:**
  - `?path=` (B's original or preview), `?id=`, `?token=` and `?kind=original` are ignored, and A still gets exactly A's preview.
  - Guessed routes never serve a PDF: original, document, path-as-token, id-as-token, hash-as-token, `/api/access/...`.
  - A one-character token change gets the generic response, and POST gets 405.
- **Storage and database stay closed:**
  - Anon download, signed URLs, public URLs, the authenticated route with the anon key, and listing are all denied.
  - Anon and signed-in leads can't call the path resolver.
  - The offer resolver returns exactly 5 fields and rejects hashes.
  - Anon can't read any table or view.
  - No public response contains original paths, storage URLs or signed-URL tokens.
- **Invalid and revoked links:**
  - Malformed and unknown tokens get an identical generic 404 and page.
  - Revocation blocks the very next preview request, the reload and the resolver.
  - A never-linked draft is unreachable.
  - A regenerated link works while the old one stays dead.
- **Missing object:** 503 with `Retry-After` and a generic body, while the page still loads. Restoring the object makes a retry succeed.
- **Logs:** the server log contains no tokens and no storage paths.
- **Your data:** existing local accounts and data are unchanged, and all disposable objects are removed.

**`test:client-browser`** (headless Chrome, isolated profile, screenshots `p5-01`…`p5-11`):
- **Rendering and content:**
  - The page renders, with ink on the canvas.
  - Title, counts, price and notice are present, with no pay or unlock button.
  - The text layer has selectable text, and find-in-page finds it.
  - White background, dark text and blue accents, and still white under an emulated dark OS scheme.
- **Navigation:** Prev/Next with the right disabled states, and the end-of-preview locked message.
- **Keyboard:** arrows, Home and End; Enter and Space on buttons; Tab order; accessible names.
- **Zoom and fit:**
  - Fit width fills the stage, and zoom in/out stops at 300 % and 50 %.
  - The + key works, and Fit restores the fit.
  - The zoomed page scrolls inside the viewer only.
- **Rapid clicking:** after 20 quick page and zoom clicks, exactly one canvas and text layer remain, matching the page shown, with no script errors.
- **Network:**
  - Every request goes to the app's own origin: no CDN, storage host or third parties.
  - No URL contains "original".
  - The worker comes from `/pdfjs/<version>/` and matches the library version.
- **Bundles:** the dashboard (signed-in lead) ships no PDF.js, and on the client page PDF.js is loaded only on demand.
- **Edge cases:**
  - A one-page preview ("Page 1 of 1", both nav buttons disabled).
  - A 200 × 200 in page at 300 %, with the canvas within the 16.7 MP cap.
  - Mobile 390 px: no page overflow, page fits, buttons at least 36 px, zoom scrolls inside the viewer.
- **Error states:**
  - Network failure, then error and **Try again** with a new server request.
  - Corrupt bytes, then the render error and recovery.
  - Missing object (503), then the message, the object restored, and **Try again** succeeds.
  - Revoked mid-load, then "no longer available"; **Check again** stays unavailable; reload shows the generic page.
  - A request held for over 30 s, then the timeout error and **Try again**.

I reviewed the screenshots of the desktop view, last preview page, mobile view (top and bottom), network error, revoked-after-load, unavailable page and one-page preview.

**Tests changed:**
- `phase4-pdf-links.mjs` and `phase4-browser.mjs` checked for the Phase 4 placeholder text. They now check for the client page's "Free preview:" summary.
- `lib/browser.mjs` gained `on()` for DevTools events.
- `lib/portal.mjs` is a new shared harness for the Phase 5 suites (disposable users, real server actions, data snapshot and cleanup).

**Not verified:**
- **Real client devices and browsers:** Safari, iOS, Firefox and Android. Only headless Chrome was used, including the 390 px emulation. The legacy PDF.js build targets older browsers, but that wasn't exercised.
- **Screen readers.** Only ARIA roles, labels and live regions were checked.
- **Real-world PDFs:** scanned, image-heavy, JPEG 2000, CJK, or files with non-embedded fonts. Fixtures are generated with pdf-lib and Helvetica, so the copied CMaps, standard fonts and wasm decoders are served but weren't exercised.
- **Behaviour on the production host**, including the response-size and streaming question (§7).
- **Real network conditions** such as slow 3G. Only failures and timeouts were simulated.

## 7. Limitations and open items

- **Production response limits (open question Q11).** Vercel documents a ~4.5 MB function response limit. Previews larger than that may not stream there.
  - Verify in Phase 8.
  - Fallback: issue a ~60 s signed URL after the same token check. The revocation window would then be up to 60 s.
- **Revocation can't recall delivered bytes** (§4).
- **Possession of the link grants preview access** (bearer link). Forwarding the link shares the preview.
- **Platform access logs will record `/p/<token>` paths** once deployed. Next's own request log excludes them.
- **No rate limiting** on `/p/*` yet (Phase 7). Guessing a 256-bit token is infeasible, so this is about load only.
- **No range requests or partial loading.** The whole preview is downloaded before rendering. That's fine for previews of a few MB; larger ones would benefit from range support.
- **Desktop fit-to-width** makes portrait pages tall, so the locked notice sits below the viewer and needs scrolling.

## 8. Manual local test

1. Make sure the local stack is running (`npm run db:start`) and your dev server is on http://localhost:3000. Restarting `npm run dev` is optional; it now also runs the asset copy.
2. Sign in as your Team Lead.
3. Prepare the proposal: create a client and a proposal, open **Manage PDF**, upload a multi-page PDF, set free pages, a currency and a price, then **Generate private link** → **Copy link**.
4. Open the link in a private/incognito window, signed out. Check:
   - the title, "Free preview: X of Y pages." and the three counts;
   - the price with its currency, and "Online payment will be available soon.";
   - that only the free pages can be viewed: Next stops at the last free page and shows the locked message.
5. Try zoom in/out, **Fit width**, the arrow keys after clicking the viewer, selecting text, and a narrow window or phone-sized responsive mode.
6. In DevTools → Network, confirm the only PDF request is `/p/<token>/preview`, there are no storage or CDN requests, and its response headers include `no-store`.
7. Revoke the link in the dashboard, then in the client window click **Next**/**Fit** (the page stays in memory). Reload: you should get "This link isn't available". `/p/<token>/preview` now returns 404.
8. Generate a new link. The new URL works and the old one stays unavailable.

## 9. What Phase 6 still needs

- **Payments:**
  - a provider-neutral adapter and a fake local adapter;
  - checkout creation with server-side amount and currency;
  - a signed, idempotent webhook;
  - access grants;
  - a status-polling claim;
  - recovery codes;
  - the dashboard payment list.
- **Full-document delivery:** a route that serves or signs the **original** only for a valid paid-access grant for this proposal, plus the paid view on `/p/[token]`.
- **Content lock after the first successful payment** (`content_locked_at`).
- **An unlock button** on the client page, replacing "Online payment will be available soon." once a real or fake provider exists.
- **The real provider adapter**, which stays blocked until provider details arrive (OPEN_QUESTIONS P1–P8).

## 10. Files

**New:**
- `supabase/migrations/20261029090000_phase5_client_page_resolvers.sql`
- `src/app/p/[token]/preview/route.ts`
- `src/components/proposals/preview-viewer.tsx`
- `src/components/proposals/pdf-text-layer.css`
- `scripts/copy-pdfjs-assets.mjs`
- Tests:
  - `supabase/tests/database/phase5_client_resolvers.test.sql`
  - `supabase/tests/integration/phase5-client.mjs`
  - `supabase/tests/integration/phase5-browser.mjs`
  - `supabase/tests/integration/lib/portal.mjs`

**Changed:**
- App code:
  - `src/app/p/[token]/page.tsx`: the client page.
  - `src/lib/proposals/resolve-link.ts`: the offer resolver.
  - `src/lib/supabase/privileged.ts`: `openPreviewForLink`.
  - `src/types/database.ts`
  - `src/app/globals.css`: the always-light client page.
  - `src/proxy.ts`: excludes `/pdfjs/`.
  - `next.config.ts`: `/pdfjs` caching, comment.
- Config:
  - `eslint.config.mjs`: ignores `public/pdfjs`.
  - `.gitignore`: `/public/pdfjs/`.
  - `package.json`: `predev`, `prebuild`, `test:client`, `test:client-browser`.
- Tests: `supabase/tests/integration/phase4-pdf-links.mjs`, `phase4-browser.mjs`, `lib/browser.mjs`.
- Docs: README, IMPLEMENTATION_CHECKLIST, ARCHITECTURE (§1 clients, §2 routes, §5), DATABASE_PLAN (status), OPEN_QUESTIONS (Q11).
