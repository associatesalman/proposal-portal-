# Phase 6 — White & Blue UI Redesign

Phase 6 redesigns the interface and makes interactions more reliable. All Phase 1–5 behaviour is unchanged: authentication, roles, RLS, server actions, PDF verification, preview generation, private links and secure preview delivery. It has no migrations, permission changes or data changes.

**Payment integration is deferred.** It was planned as Phase 6 and is now Phase 7, with hardening in Phase 8 and deployment in Phase 9. Earlier phase documents keep their original numbering. The client page still says "Online payment will be available soon." and has no checkout.

> **Refinement (6.1): bolder scale, larger cards and an animated login.** §10 below describes it and overrides the sizes in §1–§3 where they differ: buttons are now 44/48 px rather than 36/40 px, inputs 48 px rather than 40 px, headings use navy `#0B1E44`, and the login page has an illustration. Like the rest of Phase 6 it is a design change only, with no data, permission or database changes.

## 1. Design system

**Tokens** (`src/app/globals.css`). There is one light theme, and `color-scheme: light` keeps it white whatever the OS preference.

| Token | Value | Use |
| --- | --- | --- |
| background / surface | `#FFFFFF` | page, cards, dialogs |
| surface-muted / sunken | `#F8FAFC` / `#F1F5F9` | table header, hover, skeletons, viewer stage |
| foreground | `#0F172A` | primary text (17.9:1 on white) |
| muted / subtle | `#475569` / `#64748B` | secondary text (7.6:1) / hints (4.8:1) |
| border / border-strong | `#E2E8F0` / `#CBD5E1` | dividers / input borders |
| accent / accent-hover | `#2563EB` / `#1D4ED8` | primary actions, links, focus (5.2:1) |
| accent-soft / accent-border / accent-strong | `#EFF6FF` / `#BFDBFE` / `#1E40AF` | info callouts, selected states |
| danger, success, warning | `#B91C1C`, `#15803D`, `#B45309` (+ soft / border) | errors, verified, locks and local-only warnings |

The old dark-mode override and the client-page special case were removed. There are no gradients, glass effects, illustrations, hero sections, sidebars or invented charts.

**Shared pieces** (`src/components/ui/`):

- `styles.ts`:
  - buttons: `primary`, `secondary`, `subtle`, `destructive`, `rowAction` (36 px), `icon` (36 px);
  - inputs and selects (40 px), labels, hints, errors, cards, callouts (error/success/warning/info/neutral), badges, static skeletons;
  - one `focusRing` (2 px accent outline, 2 px offset).
- `fields.tsx`: labelled text and select fields with hint and error wiring (`aria-describedby`, `aria-invalid`) and a select chevron.
- `dialog.tsx`: the modal (see §3). `brand.tsx`: the brand mark. `link-pending.tsx`: a spinner for links that are navigating (`useLinkStatus`).
- `use-hydrated.ts`: tells controls that need JavaScript whether the page is interactive yet (`useSyncExternalStore`, false on the server).
- Dashboard: `feedback.tsx` (toasts), `badges.tsx` (status and PDF state), `list-states.tsx` (empty, no-results, past-last-page and error states), `data-table.tsx` (a table that becomes cards below 768 px), `pagination.tsx`, `dashboard-tabs.tsx`, `summary-cards.tsx`.

There is no UI library. Fonts are Geist via `next/font`, self-hosted at build time, so the browser makes no font requests. lucide-react icons are tree-shaken.

## 2. Screens changed

- **Login** (`src/app/(auth)/login/`):
  - a focused card with the brand mark, "Sign in" and guidance;
  - a show/hide password toggle (`aria-pressed`, `aria-controls`);
  - fields become read-only and the button reads "Signing in…" while signing in;
  - a full-width primary button, and the footer note "Accounts are created by your administrator. There is no self sign-up.";
  - auth, validation, safe redirects and missing-profile rejection are unchanged.
- **Dashboard** (`src/app/(dashboard)/dashboard/page.tsx`):
  - a sticky header with the brand, the user's name and role, and Sign out;
  - "Dashboard" with a role-specific subtitle;
  - three summary cards (Total clients, Total proposals, Draft proposals) using the same real counts as before;
  - a records card with tabs and counts, the contextual action (Add client / New proposal), and a toolbar: search with an icon, the team-lead filter for the admin only, Search, and Clear search;
  - a full-width table with row actions that becomes stacked cards on phones, and pagination ("Showing X–Y of N").
  - The skeleton fallback matches the final layout, so nothing jumps.
  - Role differences and access rules are unchanged.
- **Forms and dialogs:**
  - Add/Edit client and New/Rename proposal use the shared fields;
  - errors appear in a callout and inline per field;
  - the footer has Cancel and a primary submit that shows "Adding…" etc. while pending;
  - success is announced in a toast.
- **Manage PDF dialog** (`src/components/dashboard/proposal-setup-dialog.tsx`):
  - a three-step stepper (Upload PDF → Preview & price → Private link) with done, next and to-do states, announced to screen readers;
  - step 1 shows the verified file (name, size, page count, "Verified") and the real phases "Uploading to private storage…" then "Checking the file and counting pages…". There is no fake percentage;
  - step 2 shows a proportional free/locked bar ("Free: pages 1–N", "Locked: pages N+1–T (L of T)"), updated as you type, the currency next to the price, and "Clients will see £12.50" (marked "(saved)" when unchanged);
  - step 3 shows "Link active since …";
  - the link is shown once, with a copy button and status message, and a local-only warning for localhost links;
  - revoking needs confirmation, which explains that the old link stops working; focus starts on "Keep link".
  - While a link is active, a warning explains that the PDF and offer can't change until the link is revoked.
- **Client page** (`src/app/p/[token]/page.tsx`, `src/components/proposals/preview-viewer.tsx`):
  - consistency only: the same tokens, brand header, card styles, buttons and focus rings;
  - the title and page counts sit side by side on wider screens;
  - the unavailable state is a card.
  - Secure delivery, the viewer's behaviour and "Online payment will be available soon." are unchanged. There is no checkout.

## 3. Motion and interaction reliability

**Motion:**

- buttons and inputs: 150 ms colour, border and shadow transitions, with a 1 px press;
- dialogs: a 200 ms fade and lift in and fade out (`@starting-style`, `allow-discrete`);
- toasts: 180 ms in, 160 ms out.
- No continuous or bouncy animation; spinners only run while something is in progress.
- With `prefers-reduced-motion: reduce` every animation and transition takes 1 ms. The duration is not zero, so end events still fire, and nothing waits for an animation.

**Reliability fixes:**

- **Sign out "hydration" issue:** the old test clicked a Sign out button that React was still streaming. The element was in the HTML but hidden, so the click hit a 0×0 box. Sign out is still a standard server-action `<form>`, which also works before hydration and without JavaScript. Posting the server HTML form directly returns `303 → /login` and clears the session cookie (tested). Tests now wait for the button to be visible and enabled. There are no sleeps and no private React properties.
- **Truthful pre-hydration state:** controls that need JavaScript (dialog triggers, password toggle, Clear search) render disabled until the page is interactive. They never look clickable while ignoring clicks. Plain forms (login, search GET form, sign out, dialog forms) work as native forms before hydration.
- **Dialogs** (native `<dialog>` + `showModal()`):
  - focus is trapped and the first field focused; Escape closes; focus returns to the trigger; the body scrolls with the header always visible; a labelled Close button; no backdrop-click close, so typed input isn't lost;
  - while saving, Escape and Close are blocked (`closedby="none"` plus `cancel` prevention, `aria-busy`), so a result is never lost;
  - the busy state is set in a layout effect, in the same paint as the pending controls;
  - a closing dialog never blocks clicks during its fade.
  - Fixed during verification:
    - a click on the trigger right after Escape could be ignored, because the native `close` event arrives a task later. Escape and Close now update state immediately;
    - focus changes could scroll the dialog element itself, hiding the header and leaving a blank band. The dialog is now `overflow-clip` and only its body scrolls.
- **Forms:**
  - the fieldset is disabled while pending, so there are no double submits;
  - values and field errors come back after a server error;
  - the toast is raised from the action, so it still appears when the saved row leaves the filtered list.
  - Server-rendered forms keep their progressive server-action fields.
- **Search:**
  - inputs are controlled and never remounted, so focus and the typed value survive results updates, and values follow the URL on tab and back navigation;
  - the owner filter submits on change and keeps focus;
  - Clear search empties the field, keeps focus and replaces the URL without `q=`;
  - results come from the URL, so there are no stale results.
- **No PDF viewer remounts:** the viewer's structure and keys are unchanged, and only classes changed.

## 4. Accessibility

- A visible 2 px focus outline on every control. Tabs use `aria-current`, the stepper uses `aria-current="step"` plus screen-reader-only state text, and badges include text, not colour only.
- Contrast: text pairs are at least 4.5:1 (checked in the browser on representative text).
- Every input has a label; on the dashboard toolbar the labels are screen-reader-only. Required fields are marked, and errors are linked with `aria-describedby` and announced in `role=alert`.
- Toasts use a persistent `role=status aria-live=polite` region. They pause on hover or focus and have a "Dismiss notification" button.
- Touch targets: interactive controls on the 390 px dashboard are at least 36 px tall, and most are 40–44 px. Row actions are always visible and never hover-only.
- No horizontal page scroll at 390 px on the dashboard or the client page.

## 5. Performance

SSR and streaming are unchanged. PDF.js is loaded only on the client page, and the test confirms that no `pdfjs` request occurs on `/login` or `/dashboard`. No requests go to other hosts: no font CDN or analytics.

Bundle sizes (`npm run measure:bundles`, production build, headless Chrome, everything loaded on first view):

| Route | Before JS (raw / gzip) | After JS (raw / gzip) | Before CSS (gzip) | After CSS (gzip) |
| --- | --- | --- | --- | --- |
| `/login` | 8 files, 453.7 / 135.7 KB | 7 files, 458.6 / 136.8 KB | 8.8 KB | 8.3 KB |
| `/dashboard` | 10 files, 858.0 / 247.7 KB | 9 files, 872.1 / 251.7 KB | 8.8 KB | 8.3 KB |
| `/p/[token]` | 10 files, 963.0 / 289.9 KB | 9 files, 963.1 / 289.6 KB | 9.3 KB | 8.9 KB |

- The dashboard grows by about 4 KB gzip: the stepper, the page-split bar, the toast exit and the new icons.
- Login grows by about 1 KB: the password toggle.
- CSS is smaller because the dark-mode override was removed.
- Measured locally on one machine, so treat these as relative numbers.

## 6. Tests

New:

- `supabase/tests/integration/phase6-ui.mjs` (`npm run test:ui`, 80 checks). Covers:
  - login (white/blue tokens, toggle readiness and `aria-pressed`, wrong-password alert keeping the email);
  - dashboard at desktop, tablet and 390 px;
  - search focus and value retention, Clear search;
  - dialogs: focus, Escape, restoration, reopen right after Escape, validation with kept values, a held slow save with Escape and Close blocked;
  - toasts, count refresh, rename;
  - the whole Manage PDF flow (upload phases, page split, price preview, link once, copy, local-only, revoke confirmation, issued link removed after close);
  - dialog fit and scroll on tablet and phone, touch targets, no hover-only actions, no horizontal scroll;
  - dark OS preference (still white), reduced motion, motion durations, contrast;
  - the admin filter keeping focus;
  - the client page (no checkout);
  - sign out as soon as the button is visible, and sign out without JavaScript;
  - PDF.js only on the client page, no other hosts, no uncaught errors.
  - It saves 15 screenshots.
- `supabase/tests/integration/measure-bundles.mjs` (`npm run measure:bundles`).

Updated only where markup legitimately changed:

- `lib/browser.mjs`: a `ready()` helper (visible and enabled); `clickText` waits for a visible, enabled match.
- `phase3-browser.mjs`: waits for readiness instead of reading React internals; the mobile row may be block or grid.
- `phase3-dashboard.mjs`: assembles React's streamed segments before reading the HTML; the summary label regex allows the icon.
- `phase4-browser.mjs`: the new upload-phase texts, file summary, page-split text and revoke-confirmation scope.
- `phase5-browser.mjs`: the fit-width check uses the computed stage padding.

## 7. Verification results

Local stack, production build (`npx next start -p 3100`), headless Chrome:

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck`, `npm run build` | pass |
| `npm run db:test` (pgTAP) | 156/156 |
| `test:integration` / `test:app` / `test:dashboard` | 34/34, 17/17, 38/38 |
| `test:pdf` / `test:client` (with `SERVER_LOG`) | 72/72, 70/70 |
| `test:browser` / `test:pdf-browser` / `test:client-browser` | 28/28, 27/27, 64/64 |
| `test:ui` | 80/80 (four consecutive runs) |
| Existing accounts and data | unchanged (each suite checks this; disposable data and storage objects removed) |

**Screenshots inspected:**

- login error;
- lead clients and proposals (desktop);
- dialog validation and toast;
- the Manage PDF steps, link and revoke confirmation;
- dashboard and Manage PDF at tablet and 390 px;
- client page with a dark OS preference and at 390 px;
- admin filtered view.

## 8. Viewing locally

1. Start the stack if needed: `npm run db:start` (do not reset).
2. `npm run dev`, then open http://localhost:3000/login and sign in with your existing account.
3. Production-like: `npm run build && npx next start -p 3100`, then http://localhost:3100.
4. Client page: in Manage PDF, generate a link for a proposal with a PDF and an offer, then open it in the same browser. Localhost links only work on this computer.

## 9. Limitations

- Exit fades and `closedby` need a current Chromium. Firefox and Safari close dialogs correctly (the `cancel` event is still prevented while busy) but may skip the exit fade.
- Only tested in headless Chrome. No real devices, Safari/iOS, Firefox, Android or screen-reader pass; these stay in Phase 8 hardening.
- With JavaScript disabled, sign-in, search and sign-out work as plain forms, but the dashboard rows are revealed by React's streaming script. Without JavaScript that streamed content stays hidden, and dialogs need JavaScript.
- A toast raised while a modal is open shows behind the modal backdrop until it closes, because the native top layer sits above it. It is still announced.
- Bundle measurements come from one local machine.
- Payments, full-document unlock, rate limiting and deployment are not part of this phase.

## 10. Refinement 6.1: bolder scale, larger cards and an animated login

This pass makes the interface noticeably larger and more confident. It keeps the same screens, navigation, single-page dashboard and behaviour. It has no data, permission, database, Docker or dependency changes.

### What changed

**Tokens and shared styles** (`globals.css`, `components/ui/styles.ts`):

- New `--navy: #0B1E44` (16.4:1 on white) for headings and large numbers.
- New shadows: `raised`, `panel` (the login panel) and `accent` (primary-button hover, brand mark).
- Buttons: `primary`, `secondary`, `subtle` and `destructive` are 44 px on phones and 48 px from 640 px up.
  - `secondaryCompact` (40 px) is used for Sign out, pagination and the inline Reload.
  - `primaryLarge` (56 px) is the sign-in button.
  - `rowAction` and `icon` are 40 px.
  - Press feedback is `scale(0.98)`, and primary buttons gain a soft blue shadow on hover.
- Inputs and selects are 48 px with 16 px text; sign-in fields are 56 px (`inputLargeStyles`). The focus ring is 4 px and fades in over 150 ms.
- `controlStyles` is the input look without a height or text size, for the file picker and the link field. Heights are never overridden by a second `h-*` class.
- Labels are 15 px, hints 14 px, and callouts 14 px with more padding.
- New `panelStyles` (16 px radius) for dashboard panels, and `pageTitleStyles` / `sectionTitleStyles` for headings.

**Dashboard** (`dashboard/page.tsx`, `summary-cards.tsx`, `dashboard-tabs.tsx`, `list-filters.tsx`, `data-table.tsx`, `pagination.tsx`, `list-states.tsx`, `feedback.tsx`):

- The content container is up to 1440 px wide (16 / 24 / 40 px gutters).
- The header is 72 px, with a 40 px brand mark and the role shown as a pale-blue pill.
- The "Dashboard" title scales with `clamp()` from 32 px on phones to 48 px at 1440 px. The subtitle is 18 px.
- A visible "Overview" section heading (24–28 px) sits above the cards, with the totals scope on the right. Screen readers hear it as "Overview: <scope>".
- Summary cards (Total clients, Total proposals, Draft proposals):
  - at least 168 px tall with 24–28 px padding;
  - the label sits top left with a 48–56 px pale-blue icon tile top right;
  - values are 44 px at tablet width and 52 px on desktop, in navy.
  - They are not interactive, so they have no hover state and no pointer cursor.
  - On phones they stay three compact columns (28 px values, no icons).
  - The `<dt>`/`<dd>` markup the server tests read is unchanged.
- Tabs are 56–64 px tall with 15–17 px semibold labels and a 3 px indicator.
- On phones the tab bar is tighter, so "New proposal" fits on the same row; the bar wraps instead of clipping if it ever runs out of room.
- The search field and owner filter are 48 px (the search icon is 20 px).
- Table rows are 72 px with 15–16 px text and wrap naturally. Hovered rows get a faint blue tint.
- Empty and error states have a 56 px icon tile and an 18 px title. Toasts are larger, 15 px.

**Login** (`login/page.tsx`, new `login/login-art.tsx`, `login-form.tsx`, `actions.ts`, `state.ts`):

- **From 1024 px:** two columns.
  - Left: the brand, a 52–56 px heading ("Clients and proposals, in one place."), one line of supporting copy, and an original inline-SVG illustration (abstract proposal sheets, a page-split bar and a link chip in blue and pale blue).
  - Right: a 500 px white panel with a subtle border and a blue-tinted shadow. It has "Welcome back" at 36 px, 40 px padding, 56 px fields, an accessible show/hide toggle (`aria-pressed`, `aria-controls`) and a full-width 56 px Sign in button.
- **Below 1024 px:** the layout stacks with a shorter heading. The illustration is hidden, and so is the copy below 640 px. On phones the page starts at the top instead of centring vertically, so the form is in view at once. Nothing has a fixed height, so the page scrolls normally when the keyboard opens.
- **New connection-error state:**
  - On the server, an unreachable or failing auth service (`AuthRetryableFetchError` or a 5xx) now says "Can't connect to the sign-in service right now…" instead of "Invalid email or password."
  - In the browser, once the page is interactive, a request that never reaches the server shows the same message in an amber callout. The email is kept and the form is re-enabled.
  - Before hydration the form still posts natively to the server action.
- Validation, the "Signing in…" pending state (read-only fields, disabled button), safe redirects and the no-profile rejection are unchanged. There is no sign-up, social login, badges or security claims.

**Forms and dialogs** (`ui/dialog.tsx`, `ui/fields.tsx`, `action-form-dialog.tsx`, `proposal-setup-dialog.tsx`):

- Dialog titles are 20–24 px in navy, descriptions 15 px, and padding is 32 px from 640 px up.
- Widths are 576 px (default) and 768 px (wide), always with a 12–24 px margin. The radius is 16 px.
- Footers have a full-width divider and 48 px actions.
- Manage PDF:
  - the stepper has 28 px markers, a 6 px progress bar and 14–15 px labels (stacked under the marker on phones);
  - section headings are 18 px with 32 px markers, and the current step gets a pale-blue ring;
  - the document summary, upload phases, page-split bar, link box and revoke confirmation are all larger.
- Focus trapping, Escape, focus restoration, the busy lock, validation and kept values are untouched.
- The PDF viewer on the client page uses its own classes, so it is unchanged. It only inherits the slightly rounder card radius and the brand-mark shadow.

### Motion

| Where | What | Timing |
| --- | --- | --- |
| Login | heading column and panel fade and rise 14 px | 360 ms; the panel is 90 ms later |
| Login illustration | shapes rise, bars grow, one curve draws | all done within about 2.5 s, then still |
| Dashboard | title block, then the three cards 60 ms apart, then the records panel | 360 ms each; the last starts at 180 ms |
| Buttons and inputs | colour, border, shadow and focus-ring transitions; press scale | 150 ms |
| Dialogs | fade, lift and scale in and out; a navy-tinted backdrop | 200 ms |
| Toasts | rise in; fade out | 200 ms / 160 ms |

- Entrances use opacity and transform only.
- They run once, when an element mounts. Search, filters, pagination, refreshes and saves keep the same DOM nodes, and the test confirms the cards are not remounted, so entrances don't replay.
- Animating elements are clickable throughout, and the fields can be used immediately.
- With `prefers-reduced-motion: reduce`, every animation and transition takes 1 ms and entrance delays are zero.
- There is no bouncing, blur, parallax, looping background or animation library.

### Before → after (desktop)

| Element | Before | After |
| --- | --- | --- |
| Dashboard title | 24 px | 48 px at 1440 (`clamp`, 32 px on phones) |
| Section heading | 14 px scope label | 28 px "Overview" |
| Summary value / card height / icon | 24 px / ~106 px / 28 px | 52 px / ≥ 168 px / 56 px |
| Primary button / search field | 40 px / 40 px | 48 px / 48 px |
| Table row | ~57 px | 72 px |
| Dialog title | 16 px | 24 px |
| Login heading / panel width / fields / button | 20 px "Sign in" / 384 px / 40 px / 40 px | 56 px portal heading + 36 px "Welcome back" / 500 px / 56 px / 56 px |
| Manage PDF step marker / label | 16 px / 12 px | 28 px / 15 px |

On a 1280 × 900 laptop the first records are still visible without scrolling (checked by the test).

### Tests added or changed (`phase6-ui.mjs`, now 97 checks)

- **Login at 1440 px:**
  - two columns with a 460–520 px panel;
  - heading at least 48 px, "Welcome back" 32–40 px, 52–56 px fields, and a full-width Sign in button at least 52 px tall;
  - the form is clickable while it animates in, and every animation has finished within 3 s (none loop);
  - a connection failure, simulated by failing the POST with the DevTools Fetch domain, shows the connection message, keeps the email and re-enables the form.
- **Login at 390 px:** illustration hidden, Sign in visible without scrolling, no horizontal overflow.
- **Login colours:** the heading colour assertion is now navy `#0B1E44`, which was previously `#0F172A`.
- **Dashboard at 1440 px:**
  - title 40–48 px, section heading 24–30 px, body text at least 16 px;
  - values 44–56 px, cards 160–190 px tall with 24–32 px padding, icons 48–56 px, no pointer cursor;
  - 48 px button and search, 64–76 px rows, a container no wider than 1440 px;
  - entrances finished.
- **Dashboard at 1280 px:** records visible without scrolling.
- **Search:** the summary cards are not remounted, so their entrance doesn't replay.
- **Dialogs:** the client form has a heading of at least 24 px and 48 px fields and buttons (measured with `offsetHeight`, because the dialog is scaled while it opens); Manage PDF has a heading of at least 24 px, step markers of at least 28 px and labels of at least 14 px.
- **Mobile:** the tabs and the action fit on one row inside the records panel.
- **Reduced motion:** dashboard entrances have no delay and finish at once; the login panel and illustration are fully shown at once.
- **Screenshots:** they now wait (up to 3 s) for running entrance animations, so they show the settled page. New screenshots: `p6-00-login-desktop-1440`, `p6-00b-login-mobile`, `p6-00c-login-connection-error`, `p6-02b-lead-dashboard-1440` and `p6-03a-client-form`.

### Verification results (6.1)

Local Supabase stack, production build (`npx next start -p 3100`), headless Chrome over the DevTools protocol:

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck`, `npm run build` | pass |
| `npm run db:test` (pgTAP) | 156/156 |
| `test:integration` / `test:app` / `test:dashboard` | 34/34, 17/17, 38/38 |
| `test:pdf` / `test:client` (with `SERVER_LOG`) | 72/72, 70/70 |
| `test:browser` / `test:pdf-browser` / `test:client-browser` | 28/28, 27/27, 64/64 |
| `test:ui` | 97/97 (three consecutive runs) |
| `measure:bundles` | `/login` 137.3 KB, `/dashboard` 252.0 KB, `/p/[token]` 289.6 KB JS gzip; CSS 9.4 KB gzip |
| Existing accounts and data | unchanged (checked by every suite; disposable data and storage objects removed) |

- **During verification:**
  - The first run found that "New proposal" was clipped by the records panel at 390 px. The tabs are now tighter on phones, buttons use 16 px side padding below 640 px, and the bar can wrap. A new check guards this.
  - A thin gradient bar along the top of each summary card looked detached at the rounded corners, so it was removed.
- **Bundles:** compared with §5, `/login` grew by 0.5 KB gzip, `/dashboard` by 0.3 KB and CSS by 1.1 KB. The illustration is inline SVG in the server-rendered HTML, not JavaScript. No dependencies or font requests were added, and PDF.js still loads only on the client page.
- **Screenshots inspected:**
  - login at 1440 and 390 px, and the connection error;
  - lead dashboard at 1440 and 1280 px, tablet and 390 px;
  - admin filtered view;
  - client form;
  - Manage PDF steps, link and revoke, and Manage PDF on phone;
  - client page with a dark OS preference.
- **How the checks were made:** keyboard focus (a visible blue outline on the tabs), reduced motion, form submission, sign-out (with and without JavaScript), dark OS preference and mobile overflow were all checked by the automated browser suite. They were not checked by hand in a desktop browser.
- **Limitations:** the limitations in §9 still apply: headless Chrome only, with no Safari, Firefox, real-device or screen-reader pass.
