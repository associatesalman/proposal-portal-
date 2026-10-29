"use server";

import { randomUUID } from "node:crypto";

import { refresh } from "next/cache";
import { z } from "zod";

import { getInternalUserOrReason, type InternalUser } from "@/lib/auth/session";
import { isFormatEnabled, toCanonicalPdf, uploadFormats, CONVERTER_MISSING } from "@/lib/documents/convert";
import { formatInfo, isDocumentFormat, isSourceFormat, type DocumentFormat } from "@/lib/documents/formats";
import { isCurrencyCode, parsePrice } from "@/lib/proposals/currencies";
import { getPdfLimits } from "@/lib/proposals/limits";
import { buildProposalLink, generateLinkToken, hashLinkToken } from "@/lib/proposals/links";
import { documentPath, PROPOSALS_BUCKET, revisionOf, sourcePath } from "@/lib/proposals/paths";
import { buildPreviewPdf } from "@/lib/proposals/pdf";
import { limitUserAction } from "@/lib/security/internal-limits";
import type {
  IssuedLink,
  ProposalSetup,
  SetupResult,
  UploadTicket,
} from "@/lib/proposals/setup-types";
import {
  activateLink,
  recordPreviewAndOffer,
  recordVerifiedOriginal,
  revokeLink,
  type TrustedWriteError,
} from "@/lib/supabase/privileged";
import { isUnavailableError } from "@/lib/supabase/fetch";
import { createClient } from "@/lib/supabase/server";

// "Manage Document" actions. Every action independently:
//   1. verifies the signed-in internal user (role from profiles);
//   2. validates its input with Zod;
//   3. loads the proposal through the user's RLS-scoped client, so another
//      lead's proposal is simply "not found";
//   4. reads/writes storage objects as that user (storage RLS applies);
//   5. applies a per-user rate limit to the expensive steps (upload
//      tickets, PDF verification, preview generation);
//   6. records verified facts through src/lib/supabase/privileged.ts, whose
//      SQL functions re-check access, draft state and staleness.
// Nothing the browser says about the file (name aside, which is display-only)
// is trusted: size, format and page count come from the stored bytes, and
// non-PDF uploads are converted on the server (src/lib/documents/). Every
// link is a preview link: free pages plus a price, unlocked only by a
// verified PayPal payment. Link tokens and URLs are never logged.

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const SESSION_EXPIRED = "Your session has expired. Sign in again to continue.";
const SERVICE_UNAVAILABLE = "The service is temporarily unavailable. Nothing was saved. Try again in a moment.";
const GENERIC_ERROR = "Something went wrong. Try again.";
const NOT_FOUND = "This proposal could not be found, or you don't have access to it.";
const STALE =
  "This proposal was changed somewhere else (another tab or person). Reload it and try again.";
const LOCKED = "This proposal has an active link. Revoke the link before changing the document or offer.";
const DELETING = "This proposal is being deleted. Its document, offer and link can no longer be changed.";

const PROPOSAL_COLUMNS =
  "id, owner_id, title, status, original_storage_path, preview_storage_path, total_pages, " +
  "free_preview_pages, unlock_price_minor, currency, original_file_name, original_size_bytes, link_created_at, deletion_requested_at, " +
  "source_storage_path, source_format, source_size_bytes";

type ProposalRow = {
  id: string;
  owner_id: string;
  title: string;
  status: "draft" | "active" | "archived";
  original_storage_path: string | null;
  preview_storage_path: string | null;
  total_pages: number | null;
  free_preview_pages: number | null;
  unlock_price_minor: number | null;
  currency: string | null;
  original_file_name: string | null;
  original_size_bytes: number | null;
  link_created_at: string | null;
  deletion_requested_at: string | null;
  source_storage_path: string | null;
  source_format: string | null;
  source_size_bytes: number | null;
};

type Context = { user: InternalUser; supabase: ServerSupabaseClient; row: ProposalRow };

function fail(message: string, extra?: Omit<Extract<SetupResult<never>, { ok: false }>, "ok" | "message">) {
  return { ok: false as const, message, ...extra };
}

function log(context: string, error: { code?: string } | unknown) {
  const code =
    error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "unknown";
  console.error(`[proposal-setup] ${context} failed`, code);
}

function trustedWriteFailure(error: TrustedWriteError, invariantMessage: string) {
  switch (error.code) {
    case "PT404":
      return fail(NOT_FOUND);
    case "PT409":
      return fail(STALE, { stale: true });
    case "PT423":
      return fail(LOCKED, { stale: true });
    case "PT410":
      return fail(DELETING, { stale: true });
    case "23514":
    case "22023":
      return fail(invariantMessage, { stale: true });
    default:
      log("trusted write", error);
      return fail(GENERIC_ERROR);
  }
}

const proposalIdSchema = z.uuid();
const revisionSchema = z.union([z.uuid(), z.literal("legacy")]);

async function loadContext(proposalId: unknown): Promise<{ ok: true; ctx: Context } | ReturnType<typeof fail>> {
  const auth = await getInternalUserOrReason();
  if (!auth.ok) return fail(auth.reason === "unavailable" ? SERVICE_UNAVAILABLE : SESSION_EXPIRED);
  const { user } = auth;

  const id = proposalIdSchema.safeParse(proposalId);
  if (!id.success) return fail(NOT_FOUND);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("id", id.data)
    .maybeSingle<ProposalRow>();

  if (error) {
    log("load proposal", error);
    return fail(isUnavailableError(error) ? SERVICE_UNAVAILABLE : GENERIC_ERROR);
  }
  if (!data) return fail(NOT_FOUND);
  // A proposal being deleted is frozen (the database refuses every change
  // and new uploads); stop here with a clear message.
  if (data.deletion_requested_at) return fail(DELETING);
  return { ok: true, ctx: { user, supabase, row: data } };
}

async function toSetup(supabase: ServerSupabaseClient, row: ProposalRow): Promise<ProposalSetup> {
  const { data: names } = await supabase
    .from("proposal_list")
    .select("client_name, owner_name")
    .eq("id", row.id)
    .maybeSingle();

  const documentRevision = revisionOf(row.original_storage_path);
  const previewRevision = revisionOf(row.preview_storage_path);

  return {
    id: row.id,
    title: row.title,
    clientName: names?.client_name ?? "",
    ownerName: names?.owner_name ?? null,
    status: row.status,
    document:
      documentRevision && row.total_pages
        ? {
            revision: documentRevision,
            fileName: row.original_file_name,
            sizeBytes: row.source_size_bytes ?? row.original_size_bytes,
            totalPages: row.total_pages,
            sourceFormat: isSourceFormat(row.source_format) ? row.source_format : null,
          }
        : null,
    preview:
      previewRevision && row.free_preview_pages
        ? { revision: previewRevision, pages: row.free_preview_pages }
        : null,
    offer: {
      freePages: row.free_preview_pages,
      priceMinor: row.unlock_price_minor,
      currency: isCurrencyCode(row.currency) ? row.currency : null,
    },
    link: row.status === "active" && row.link_created_at ? { createdAt: row.link_created_at } : null,
    upload: { ...uploadFormats(), maxMb: Math.floor(getPdfLimits().maxBytes / (1024 * 1024)) },
  };
}

async function reloadSetup(supabase: ServerSupabaseClient, id: string): Promise<ProposalSetup | null> {
  const { data } = await supabase
    .from("proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("id", id)
    .maybeSingle<ProposalRow>();
  return data ? toSetup(supabase, data) : null;
}

// Best-effort removal of objects this server created or that are no longer
// referenced. Storage RLS only allows deleting unreferenced objects, so a
// document still in use can never be removed here.
async function removeObjects(supabase: ServerSupabaseClient, paths: (string | null)[], context: string) {
  const targets = paths.filter((path): path is string => Boolean(path));
  if (targets.length === 0) return;
  const { error } = await supabase.storage.from(PROPOSALS_BUCKET).remove(targets);
  if (error) log(`cleanup (${context})`, error);
}

// See completeUploadAction. Must stay well below the cleanup utility's
// minimum age (MIN_AGE_HOURS in scripts/storage-cleanup.mjs).
const UPLOAD_COMPLETION_WINDOW_MS = 60 * 60 * 1000;

function cleanFileName(name: string, format: DocumentFormat): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return cleaned || `document.${formatInfo(format).extension}`;
}

function formatMiB(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export async function loadProposalSetupAction(proposalId: string): Promise<SetupResult<ProposalSetup>> {
  const loaded = await loadContext(proposalId);
  if (!loaded.ok) return loaded;
  const { supabase, row } = loaded.ctx;
  return { ok: true, data: await toSetup(supabase, row), message: "" };
}

// ---------------------------------------------------------------------------
// Upload: 1) ticket for a direct-to-storage upload, 2) verify, convert and
// record. PDF uploads go to {revision}/original.pdf; other formats go to
// {revision}/source.<ext> and the server writes the converted canonical PDF
// to {revision}/original.pdf.
// ---------------------------------------------------------------------------

const formatSchema = z
  .string()
  .max(10)
  .optional()
  .transform((value) => value ?? "pdf")
  .refine((value): value is DocumentFormat => isDocumentFormat(value));

const prepareSchema = z.object({
  proposalId: z.uuid(),
  sizeBytes: z.number().int().positive(),
  format: formatSchema,
});

function uploadPathFor(row: ProposalRow, revision: string, format: DocumentFormat) {
  return format === "pdf"
    ? documentPath(row.owner_id, row.id, revision, "original")
    : sourcePath(row.owner_id, row.id, revision, format);
}

function unavailableFormat(format: DocumentFormat) {
  const message =
    format === "pdf"
      ? "PDF uploads aren't available."
      : `${formatInfo(format).extension.toUpperCase()} uploads aren't available on this server. ${CONVERTER_MISSING}`;
  return fail(message, { fieldErrors: { file: message } });
}

export async function prepareUploadAction(input: {
  proposalId: string;
  sizeBytes: number;
  // The format the file NAME claims (pdf when omitted). Verified from the
  // bytes when the upload is completed.
  format?: string;
}): Promise<SetupResult<UploadTicket>> {
  const loaded = await loadContext(input?.proposalId);
  if (!loaded.ok) return loaded;
  const { supabase, row } = loaded.ctx;

  const parsed = prepareSchema.safeParse(input);
  if (!parsed.success) {
    const message = "Choose a PDF, DOCX, DOC, ODT, RTF or TXT document.";
    return fail(message, { fieldErrors: { file: message } });
  }
  const format = parsed.data.format as DocumentFormat;
  if (!isFormatEnabled(format)) return unavailableFormat(format);

  const { maxBytes } = getPdfLimits();
  if (parsed.data.sizeBytes > maxBytes) {
    const message = `This file is larger than ${formatMiB(maxBytes)}. Upload a smaller ${format === "pdf" ? "PDF" : "document"}.`;
    return fail(message, { fieldErrors: { file: message } });
  }
  if (row.status !== "draft") return fail(LOCKED, { stale: true });

  const limited = await limitUserAction("upload_prepare_user", loaded.ctx.user.id, "upload");
  if (!limited.ok) return fail(limited.message);

  // A fresh revision folder: the upload can never overwrite the current file.
  const revision = randomUUID();
  const path = uploadPathFor(row, revision, format);

  // Created as the user, so storage RLS (own draft proposal only) applies.
  // The token allows exactly one upload to exactly this path.
  const { data, error } = await supabase.storage
    .from(PROPOSALS_BUCKET)
    .createSignedUploadUrl(path, { upsert: false });
  if (error || !data) {
    log("create signed upload url", error);
    return fail(GENERIC_ERROR);
  }

  return {
    ok: true,
    data: { revision, path: data.path, token: data.token, contentType: formatInfo(format).mime },
    message: "",
  };
}

const completeSchema = z.object({
  proposalId: z.uuid(),
  revision: z.uuid(),
  expectedRevision: revisionSchema.nullable(),
  fileName: z.string().max(1000),
  format: formatSchema,
});

export async function completeUploadAction(input: {
  proposalId: string;
  revision: string;
  expectedRevision: string | null;
  fileName: string;
  format?: string;
}): Promise<SetupResult<ProposalSetup>> {
  const loaded = await loadContext(input?.proposalId);
  if (!loaded.ok) return loaded;
  const { user, supabase, row } = loaded.ctx;

  const parsed = completeSchema.safeParse(input);
  if (!parsed.success) return fail(GENERIC_ERROR);
  const { revision, expectedRevision } = parsed.data;
  const format = parsed.data.format as DocumentFormat;

  // Only the server-chosen layout is accepted: owner and proposal come from
  // the database row, never from the browser.
  const uploadPath = uploadPathFor(row, revision, format);
  const canonicalPath = documentPath(row.owner_id, row.id, revision, "original");
  const storage = supabase.storage.from(PROPOSALS_BUCKET);
  // Anything that goes wrong from here removes only this upload's objects
  // (the uploaded file and, for conversions, the canonical PDF). The
  // proposal's current document is never touched.
  const discard = () =>
    removeObjects(supabase, [uploadPath, format === "pdf" ? null : canonicalPath], "rejected upload");
  const fileError = async (message: string) => {
    await discard();
    return fail(message, { fieldErrors: { file: message } });
  };

  if (!isFormatEnabled(format)) {
    await discard();
    return unavailableFormat(format);
  }

  // Limited before any storage read, parsing or conversion. A refusal leaves
  // the uploaded object in place so the user can retry; if they never do,
  // the storage cleanup utility removes it once it is old enough.
  const limited = await limitUserAction("upload_complete_user", user.id, "upload");
  if (!limited.ok) return fail(limited.message);

  if (row.status !== "draft") {
    await discard();
    return fail(LOCKED, { stale: true });
  }
  const expectedPath = expectedRevision
    ? documentPath(row.owner_id, row.id, expectedRevision, "original")
    : null;
  if (row.original_storage_path !== expectedPath) {
    await discard();
    return fail(STALE, { stale: true });
  }

  const { maxBytes, maxPages } = getPdfLimits();
  const noun = format === "pdf" ? "PDF" : "document";

  // Size check on the stored object before downloading or parsing it.
  const { data: info, error: infoError } = await storage.info(uploadPath);
  if (infoError || !info) {
    return fail("The upload didn't reach storage. Try uploading again.", {
      fieldErrors: { file: "The upload didn't reach storage. Try again." },
    });
  }
  if (typeof info.size === "number" && info.size > maxBytes) {
    return fileError(`This file is larger than ${formatMiB(maxBytes)}. Upload a smaller ${noun}.`);
  }
  // Uploads must be completed soon after they are made. This guarantees
  // that an object old enough for the storage cleanup utility (at least
  // 2 hours, see scripts/storage-cleanup.mjs) can never become referenced
  // while the cleanup is deleting it.
  const uploadedAt = Date.parse(String(info.createdAt ?? ""));
  if (!Number.isFinite(uploadedAt) || Date.now() - uploadedAt > UPLOAD_COMPLETION_WINDOW_MS) {
    return fileError(`This upload is too old to finish. Choose the ${noun} and upload it again.`);
  }

  const { data: blob, error: downloadError } = await storage.download(uploadPath);
  if (downloadError || !blob) {
    log("download upload", downloadError);
    await discard();
    return fail(GENERIC_ERROR);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return fileError(`This file is empty. Choose a ${noun}.`);
  if (bytes.byteLength > maxBytes) {
    return fileError(`This file is larger than ${formatMiB(maxBytes)}. Upload a smaller ${noun}.`);
  }

  // Identify from the bytes, check for unsafe content, convert if needed and
  // re-check the resulting PDF.
  const canonical = await toCanonicalPdf(bytes, format, { title: row.title, maxPages });
  if (!canonical.ok) {
    if (canonical.retryable) return fail(canonical.message, { fieldErrors: { file: canonical.message } });
    return fileError(canonical.message);
  }
  if (canonical.pageCount > maxPages) {
    return fileError(`This ${noun} has ${canonical.pageCount} pages. The limit is ${maxPages}.`);
  }

  if (format !== "pdf") {
    const { error: uploadError } = await storage.upload(canonicalPath, canonical.pdf, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (uploadError) {
      log("upload converted pdf", uploadError);
      await discard();
      return fail(GENERIC_ERROR);
    }
  }

  const recorded = await recordVerifiedOriginal({
    actorId: user.id,
    proposalId: row.id,
    expectedOriginalPath: expectedPath,
    path: canonicalPath,
    source: isSourceFormat(format) ? { path: uploadPath, format, sizeBytes: bytes.byteLength } : null,
    fileName: cleanFileName(parsed.data.fileName, format),
    sizeBytes: canonical.pdf.byteLength,
    totalPages: canonical.pageCount,
  });
  if (!recorded.ok) {
    await discard();
    return trustedWriteFailure(recorded.error, GENERIC_ERROR);
  }

  // The replaced revision (canonical PDF, its preview and source) is no
  // longer referenced. Storage RLS refuses to delete anything still in use
  // or purchased, so a paid revision is kept.
  await removeObjects(
    supabase,
    [recorded.data.previousOriginalPath, recorded.data.previousPreviewPath, recorded.data.previousSourcePath],
    "superseded document",
  );

  refresh();
  const setup = await reloadSetup(supabase, row.id);
  if (!setup) return fail(NOT_FOUND);
  const pages = `${canonical.pageCount} page${canonical.pageCount === 1 ? "" : "s"}`;
  const what =
    format === "pdf"
      ? `PDF verified: ${pages}.`
      : `${formatInfo(format).extension.toUpperCase()} converted to PDF: ${pages}.`;
  return {
    ok: true,
    data: setup,
    message:
      canonical.pageCount === 1
        ? `${what} A one-page document can't get a link: a preview needs at least two pages, with at least one locked.`
        : what,
  };
}

// ---------------------------------------------------------------------------
// Offer: preview pages, price, currency -> generate and store the preview
// ---------------------------------------------------------------------------

const offerSchema = z.object({
  proposalId: z.uuid(),
  expectedRevision: revisionSchema,
  freePages: z.string().max(20),
  price: z.string().max(40),
  currency: z.string().max(10),
});

export async function saveOfferAction(input: {
  proposalId: string;
  expectedRevision: string;
  freePages: string;
  price: string;
  currency: string;
}): Promise<SetupResult<ProposalSetup>> {
  const loaded = await loadContext(input?.proposalId);
  if (!loaded.ok) return loaded;
  const { user, supabase, row } = loaded.ctx;

  const parsed = offerSchema.safeParse(input);
  if (!parsed.success) return fail(GENERIC_ERROR);

  if (row.status !== "draft") return fail(LOCKED, { stale: true });
  if (!row.original_storage_path || !row.total_pages) {
    return fail("Upload the document before setting the offer.", { stale: true });
  }
  const expectedPath = documentPath(row.owner_id, row.id, parsed.data.expectedRevision, "original");
  if (row.original_storage_path !== expectedPath) return fail(STALE, { stale: true });

  // Field validation (server-side; the form's own checks are only hints).
  const fieldErrors: Partial<Record<"freePages" | "price" | "currency", string>> = {};
  const total = row.total_pages;

  const freePagesText = parsed.data.freePages.trim();
  const freePages = /^\d+$/.test(freePagesText) ? Number(freePagesText) : NaN;
  if (!Number.isInteger(freePages) || freePages < 1 || freePages >= total) {
    fieldErrors.freePages = `Enter a whole number from 1 to ${total - 1}. At least one of the ${total} pages must stay locked.`;
  }

  let priceMinor: number | null = null;
  const currency = parsed.data.currency;
  if (!isCurrencyCode(currency)) {
    fieldErrors.currency = "Select a currency.";
  } else {
    const price = parsePrice(parsed.data.price, currency);
    if (price.ok) priceMinor = price.minor;
    else fieldErrors.price = price.message;
  }

  if (Object.keys(fieldErrors).length > 0 || priceMinor === null || !isCurrencyCode(currency)) {
    return fail("Check the highlighted fields and try again.", { fieldErrors });
  }

  const limited = await limitUserAction("preview_generate_user", user.id, "preview");
  if (!limited.ok) return fail(limited.message);

  const storage = supabase.storage.from(PROPOSALS_BUCKET);
  const { data: blob, error: downloadError } = await storage.download(row.original_storage_path);
  if (downloadError || !blob) {
    log("download original", downloadError);
    return fail(GENERIC_ERROR);
  }

  let previewBytes: Uint8Array;
  try {
    previewBytes = await buildPreviewPdf(new Uint8Array(await blob.arrayBuffer()), freePages);
  } catch (error) {
    log("build preview", error);
    return fail("The preview couldn't be generated from this PDF. Try exporting the PDF again and re-uploading it.");
  }

  const previewPath = documentPath(row.owner_id, row.id, randomUUID(), "preview");
  const { error: uploadError } = await storage.upload(previewPath, previewBytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (uploadError) {
    log("upload preview", uploadError);
    // A failed upload may still have left an object; remove only that one.
    await removeObjects(supabase, [previewPath], "failed preview upload");
    return fail(GENERIC_ERROR);
  }

  const recorded = await recordPreviewAndOffer({
    actorId: user.id,
    proposalId: row.id,
    expectedOriginalPath: expectedPath,
    previewPath,
    freePages,
    priceMinor,
    currency,
  });
  if (!recorded.ok) {
    await removeObjects(supabase, [previewPath], "rejected preview");
    return trustedWriteFailure(recorded.error, "Check the preview pages, price and currency.");
  }

  await removeObjects(supabase, [recorded.data.previousPreviewPath], "superseded preview");

  refresh();
  const setup = await reloadSetup(supabase, row.id);
  if (!setup) return fail(NOT_FOUND);
  return {
    ok: true,
    data: setup,
    message: `Offer saved. Preview generated with page${freePages === 1 ? "" : "s"} 1${freePages > 1 ? `–${freePages}` : ""} of ${total}.`,
  };
}

// ---------------------------------------------------------------------------
// Private link (preview only: free pages, locked pages and the price)
// ---------------------------------------------------------------------------

const linkSchema = z.object({
  proposalId: z.uuid(),
  // The preview revision the user saw (stale-edit guard).
  expectedPreviewRevision: z.uuid(),
});

export async function generateLinkAction(input: {
  proposalId: string;
  expectedPreviewRevision: string;
}): Promise<SetupResult<IssuedLink>> {
  const loaded = await loadContext(input?.proposalId);
  if (!loaded.ok) return loaded;
  const { user, supabase, row } = loaded.ctx;

  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return fail(STALE, { stale: true });

  if (row.status === "active") {
    return fail("This proposal already has an active link. Revoke it to create a new one.", { stale: true });
  }
  if (row.status !== "draft") return fail("Archived proposals can't get a link.");

  if (!row.original_storage_path || !row.preview_storage_path || !row.unlock_price_minor || !row.currency) {
    return fail("Upload the document and save the offer before generating a link.", { stale: true });
  }
  const expectedPath = documentPath(row.owner_id, row.id, parsed.data.expectedPreviewRevision, "preview");
  if (row.preview_storage_path !== expectedPath) return fail(STALE, { stale: true });

  let link: ReturnType<typeof buildProposalLink>;
  const token = generateLinkToken();
  try {
    link = buildProposalLink(token);
  } catch (error) {
    log("build link (app URL)", error);
    return fail("The app's base URL (NEXT_PUBLIC_APP_URL) isn't configured, so a link can't be created.");
  }

  const activated = await activateLink({
    actorId: user.id,
    proposalId: row.id,
    expectedPreviewPath: expectedPath,
    tokenHash: hashLinkToken(token),
  });
  if (!activated.ok) {
    return trustedWriteFailure(activated.error, "This proposal isn't ready for a link yet.");
  }

  refresh();
  const setup = await reloadSetup(supabase, row.id);
  if (!setup) return fail(NOT_FOUND);
  return {
    ok: true,
    data: { setup, url: link.url, localOnly: link.localOnly },
    message: "Private link created. Copy it now: it can't be shown again.",
  };
}

export async function revokeLinkAction(input: { proposalId: string }): Promise<SetupResult<ProposalSetup>> {
  const loaded = await loadContext(input?.proposalId);
  if (!loaded.ok) return loaded;
  const { user, supabase, row } = loaded.ctx;

  if (row.status !== "active") return fail("This proposal has no active link.", { stale: true });

  const revoked = await revokeLink({ actorId: user.id, proposalId: row.id });
  if (!revoked.ok) return trustedWriteFailure(revoked.error, GENERIC_ERROR);

  refresh();
  const setup = await reloadSetup(supabase, row.id);
  if (!setup) return fail(NOT_FOUND);
  return {
    ok: true,
    data: setup,
    message: "Link revoked. The old link no longer works, and the proposal is a draft again.",
  };
}
