> **Update (2026-10-29): manual Full Access has been removed.** Migration `20261103090000_remove_manual_full_access.sql` revoked every Full Access link (proposals became Preview drafts; documents and files kept), ended open grants (rows kept as history) and dropped the Full Access functions. `/p/<token>/document`, `/download` and `/original` no longer exist. The only way to see the whole document is a verified PayPal purchase. Multi-format uploads (§3, §4, §6) are unchanged. Sections 2 and 5 below describe the removed feature.

# Feature: Manual Full Access, document download and multi-format uploads

Status: **built and tested locally**. Nothing is deployed, and PayPal stays disabled. Real Word/OpenDocument/RTF conversion has **not** been verified: LibreOffice isn't installed on this machine (see §8).

## 1. What changed

- **"Manage PDF" is now "Manage Document".** The dialog has three steps: *Upload document → Access & price → Private link*.
- **Two access modes per proposal**, stored in `proposals.access_mode`:
  - **Preview** (`preview`, the default): the existing behaviour. Free pages 1..N are served from a separate preview PDF, and the remaining pages are locked. The original is never sent to an unpaid visitor.
  - **Full Access** (`full`): the link shows every page and offers downloads. There is no preview selection, price, paywall or payment notice. One-page documents are allowed.
- **Multi-format uploads.** The allowlist is PDF, DOCX, DOC, ODT, RTF and TXT, and nothing else. Every upload becomes a canonical PDF; the original source file is kept privately next to it.
- **A wider client viewer** with fit width, fit page, zoom, a page-jump box, accessible full screen (Fullscreen API with an in-page fallback), and a mobile toolbar. Full Access links also get download buttons.

## 2. The manual full-access workflow

This covers the case where a client pays outside the portal (for example by bank transfer) and should then get the whole document.

1. Upload the document, for example 15 pages, in **Manage Document**.
2. Keep **Preview**, choose 12 free pages (pages 13–15 locked), set a price, and generate the private link. The client sees 12 pages.
3. The client pays outside the portal.
4. Open **Manage Document** again and **Revoke link**. The old link stops working immediately and permanently.
5. Under **Access for the next link**, choose **Full Access**. You don't need to upload the file again: the stored document is reused.
6. Read the warning: *"anyone holding this full-access link can read and download the complete document."* Optionally add an **internal note** (≤ 500 characters, e.g. "Bank transfer ref 4471"). Clients never see it.
7. Click **Generate Full Access link** and send the new link. The client sees all 15 pages and can download the document.

Rules enforced by the database (`SECURITY DEFINER` functions, service-role only):

- **The mode can only change on a draft.** An active link never changes behaviour silently. You must revoke it (the old token stays invalid forever) and explicitly generate a new token.
- **The mode comes from the database row.** The link-generation action reads `access_mode` from the database and calls `proposal_issue_link` (Preview only) or `proposal_issue_full_link` (Full only). Each function refuses the other mode. Browser-submitted modes, owner ids, paths and readiness flags are ignored.
- **Every grant is recorded** in `proposal_full_access_grants`:
  - who granted it (`granted_by`, plus a name snapshot `granted_by_name`) and when;
  - which document revision (`revision_id`, `document_path`, `source_format`, `total_pages`);
  - the optional note.
  
  Revoking the link or starting deletion ends the open grant (`ended_at`). There is at most one open grant per proposal.
- **It is labelled "Manual full access", never a payment.** No payment row is created and no PayPal transaction is marked paid. History and the dashboard show an **Access** column ("Preview" / "Full Access", plus "Manual full access · date"). Existing PayPal payments and purchased revisions are untouched, and Full Access proposals can't start a PayPal checkout (`payment_begin_checkout` refuses them).
- **Ownership.** Team Leads manage only their own proposals; the CEO/Admin manages all. This is checked in the server actions and again in the database (`private.lock_managed_proposal`).
- **Grant and note visibility.** Owners and the CEO can read grant rows through RLS. Notes and granter names never reach public pages or responses.

## 3. Formats

| Format | Upload | How it becomes the canonical PDF |
| --- | --- | --- |
| PDF | always | verified as before (header, pdf-lib parse, no encryption, page limit) |
| TXT | always | built in: rendered with pdf-lib (Courier, Windows-1252). Characters outside that set are refused with a clear message. |
| DOCX, DOC, ODT, RTF | **only when LibreOffice is configured** (`LIBREOFFICE_PATH`) | headless LibreOffice, converting locally on the app server |

Without a converter, the dialog lists the unavailable formats with this message: *"Word, OpenDocument and RTF uploads need the document converter (LibreOffice), which isn't set up on this server…"*. The server refuses those formats too. The file input's `accept` list only mirrors what the server allows; it is not the check.

**Refused before conversion** (detected from the bytes, not the file name):

- a format mismatch (e.g. a `.docx` that is really a PDF);
- password-protected or encrypted files;
- macro-enabled content (VBA projects, ODT Basic/scripts, event listeners, DOC macro storages);
- external references: linked images, `INCLUDEPICTURE`/`INCLUDETEXT`/`LINK` fields, altChunks, external hrefs, RTF `\object` links;
- ZIP bombs and oversized archives (entry count, total size and compression-ratio limits);
- corrupt files and binary "text" files.

Macro formats (`.docm`, `.dotm`…), executables and archives are not on the allowlist.

**Never sent elsewhere:** files are never uploaded to an external conversion service.

## 4. Conversion pipeline

```
browser ──upload ticket──▶ private bucket: <owner>/<proposal>/<revision>/source.<ext>
server: download → inspect bytes → convert (TXT natively, others via LibreOffice) → verify PDF
     → upload <revision>/original.pdf (canonical) → record both via proposal_attach_document
     → Preview mode: build <revision>/preview.pdf from the canonical PDF
```

**The LibreOffice adapter** (`src/lib/documents/libreoffice.ts`):

- Runs `spawn` with `shell: false`; the file name is never part of a command string.
- Each conversion gets its own `mkdtemp` workspace with a throw-away profile. That profile disables macros (security level 3, macro execution off), blocks untrusted referer links and turns off link updates.
- The child gets a minimal environment, so no Supabase/PayPal secrets.
- **Time:** the conversion is killed after `DOCUMENT_CONVERSION_TIMEOUT_MS` (default 60 s, max 300 s). The whole process tree is killed (`taskkill /T /F` on Windows, process group on POSIX).
- **Output:** capped at 25 MiB before it is read.
- **Concurrency:** `DOCUMENT_CONVERSION_CONCURRENCY` slots per server instance (default 1, max 8), with a 30 s queue wait.
- **Cleanup:** the workspace is always removed.

**If anything fails**, the uploaded source and any partial canonical PDF are deleted, the previous document stays in place, and the user sees a specific message ("took too long", "couldn't be converted", "contains macros", …).

**Limits:** the same size limit as PDFs (`PDF_MAX_UPLOAD_MB`, default 20 MiB) and page limit (`PDF_MAX_PAGES`, default 300) apply to the source and the result.

## 5. Links and downloads

| Route | Mode | What it returns |
| --- | --- | --- |
| `/p/[token]` | both | Preview page (free pages + locked placeholders) **or** the Full Access page ("Full document: N pages. You can read it here or download it.") |
| `/p/[token]/preview` | Preview | the preview PDF only |
| `/p/[token]/document` | Full | canonical PDF, `inline` (used by the viewer) |
| `/p/[token]/download` | Full | canonical PDF, `attachment` ("Download PDF") |
| `/p/[token]/original` | Full, non-PDF sources | the original DOCX/DOC/ODT/RTF/TXT, `attachment` ("Download original") |

**Token scope:**

- A Preview token resolves only through the preview-mode resolvers and can never fetch `/document`, `/download` or `/original`.
- A Full token resolves only through `resolve_proposal_full_object`, which requires an open grant whose `document_path` equals the proposal's current original. That ties the token to the revision that was granted.
- Revoked, inactive, archived and deleting proposals return the unavailable page or a 404.
- Authorization is re-checked on every request.

**Responses:**

- Files are streamed from the private bucket by the server. There are no public bucket URLs and no signed URLs.
- Headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and `X-Robots-Tag: noindex`.
- `Content-Type` comes from the stored format.
- `Content-Disposition` uses a sanitized title for the filename (ASCII `filename` + UTF-8 `filename*`).

**Rate limits:**

- `link_document_ip/token`: 120/60 s and 300/60 s.
- `link_download_ip/token`: 30/600 s and 60/600 s.
- Unknown tokens count toward `link_miss_ip`.

**Revocation stops future access only.** The revoke confirmation says so: "Copies the client already downloaded can't be removed."

## 6. Storage and lifecycle

- **New columns:** `source_storage_path`, `source_format` and `source_size_bytes` on `proposals`. For PDFs, `source_format = 'pdf'` and there's no separate source file.
- **Replacing a document** removes the superseded source, original and preview files unless a purchase protects them.
- **Cleanup:** `storage_cleanup_scan` / `recheck` and `npm run storage:cleanup` know about `source.*` files. A purchased revision's source is protected like its PDF.
- **Permanent deletion** removes source, canonical and preview files, and ends any open grant.
- **History** shows the source format ("Document" column) and the access mode/grant ("Access" column).
- **Migrations are forward-only:** `20261102090000_access_modes_multiformat.sql` and `20261102090100_full_access_grant_names.sql`. They were applied locally with `npx supabase migration up`; the database was not reset.

## 7. Deployment implications

- **Vercel cannot run LibreOffice.** On Vercel, leave `LIBREOFFICE_PATH` unset; PDF and TXT keep working, and DOCX/DOC/ODT/RTF show the "not set up" message. The test double (`LIBREOFFICE_TEST_DOUBLE`) is refused on Vercel.
- **To support Word/OpenDocument/RTF in production**, run the app (or a dedicated internal conversion service you control) in a container or VM with LibreOffice installed:
  - set `LIBREOFFICE_PATH` (e.g. `/usr/bin/soffice`);
  - set a container memory limit (the code bounds time, output size and concurrency, but not per-process memory);
  - keep `DOCUMENT_CONVERSION_CONCURRENCY` low;
  - deny the container outbound network access if possible.
  
  This needs a separate decision.
- **Fonts:** install the fonts your documents use, or the PDFs will substitute them.
- **Bucket MIME types:** the migration adds the six MIME types to the bucket's `allowed_mime_types`. A hosted project picks this up when the migration runs.

## 8. Verification (actual results, 2026-10-29)

**Static checks:** `npm run lint`, `npm run typecheck` and `npm run build` are clean.

**pgTAP:** **456/456** across 8 files. The new `phase10_access_modes.test.sql` has 80 checks: mode changes only on drafts, mode-specific issuing, grant records, resolver scoping, revoke/deletion ending grants, checkout refusal, cleanup protection, and lead/CEO permissions.

**`npm run test:full-access`: 175/175**, with headless Chrome, two servers of its own (converter double on 3104, no converter on 3105) and disposable fixtures. It covers:
- the 15-page flow: 12 free / 3 locked, then revoke, Full Access without re-upload, a new link with all 15 pages and downloads, the old token dead, and the preview token unable to fetch full routes;
- forged mode, owner and path parameters;
- cross-lead denial and CEO management;
- one-page Full Access;
- download headers and filenames;
- every format through the LibreOffice adapter;
- every unsafe-file case;
- timeout kills and temp-workspace cleanup;
- the no-converter server's messages and refusals;
- deletion of source, canonical and preview files;
- viewer full screen (native and fallback), fit width/page, and the mobile toolbar.

**Earlier suites** (all pass; run against `next start -p 3100`):

| Suite | Result |
| --- | --- |
| integration | 34/34 |
| app | 17/17 |
| dashboard | 38/38 |
| pdf | 72/72 |
| client | 68/68 |
| history | 100/100 |
| cron | 33/33 |
| hardening | 106/106 |
| payments | 151/151 |
| browser | 28/28 |
| pdf-browser | 27/27 |
| client-browser | 64/64 |
| ui | 97/97 |
| history-browser | 50/50 |

**Test updates made by design:**
- "Manage PDF" became "Manage Document".
- The Phase 4 test that rejected one-page PDFs now asserts they are accepted. The browser check now uses a fake `.pdf` for its inline-error case.
- The streamed-HTML helper in three suites now handles React's hex segment ids (`S:a`…).
- The 390 px touch-target check skips a dialog that is still fading out.

**Rate-limit carry-over:** two browser suites first failed only because earlier suites had used up the shared localhost `link_miss_ip` budget (88 of 30). They passed when re-run after the window expired.

**Real data was unchanged:** 3 proposals, 3 clients, 5 users and 0 payments; no grants exist.

## 9. Not verified / limitations

- **Real LibreOffice conversion of DOCX/DOC/ODT/RTF has not been run.** The adapter was tested with a test double that checks the arguments, workspace, hardened profile and environment, and simulates success, hangs, crashes, missing output and bad output. Layout fidelity, fonts and real-world timings need a machine with LibreOffice.
- **Per-process memory isn't limited by the code;** use a container memory limit.
- **DOC (binary Word) field codes aren't scanned** for external links. Macros and encryption are detected, and LibreOffice runs with link updates off.
- **Copies a client already downloaded can't be revoked.**
- **Full Access is a manual decision.** It doesn't verify that an off-portal payment happened. The grant record, granter and note are the audit trail.
- **TXT supports Windows-1252 characters only** (e.g. no CJK). Convert such text to PDF first.
