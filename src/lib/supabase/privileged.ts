import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getServerSupabaseConfig } from "@/lib/supabase/config";
import { createBoundedFetch } from "@/lib/supabase/fetch";
import type { SourceFormat } from "@/lib/documents/formats";
import { PROPOSALS_BUCKET } from "@/lib/proposals/paths";
import type { Database } from "@/types/database";

// The only place the Supabase secret key is used for application data. It
// exposes a few narrow operations, never a general client:
//
//   - record a verified document revision: canonical PDF + optional source
//     file  (proposal_attach_document)
//   - record a generated preview and offer  (proposal_save_offer)
//   - activate / revoke a private link  (proposal_issue_link /
//     proposal_revoke_link)
//   - stream the preview PDF of the proposal a client link resolves to
//     (resolve_proposal_preview_object + one storage read), Phase 5
//   - permanently delete a proposal: mark + revoke, remove the objects in
//     its own storage folder, delete the row (proposal_*_deletion)
//   - run the storage cleanup on a schedule (runStorageCleanup from
//     scripts/storage-cleanup.mjs), counts only
//
// Browser roles cannot write these columns at all, so the database only
// accepts PDF facts that server code has verified. Callers must have
// already authenticated the user (getInternalUser) and checked access
// through the user's RLS-scoped client. Each SQL function also re-checks
// that `actorId` is the proposal's owner or an admin.
//
// Dashboard CRUD (clients, titles, lists) must keep using the RLS-scoped
// client from "@/lib/supabase/server".
//
// (The key is also used, without this client, by the rate limiter in
// src/lib/security/rate-limit.ts, which can only call rate_limit_consume.)
//
// Payments use the same client from src/lib/supabase/privileged-payments.ts,
// which is limited to the service_role-only payment_* functions and to
// streaming a purchased document after payment_document_for_session.

export function privilegedClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY is not set. Add the server-only secret key to .env.local " +
        "(see docs/PHASE_4_SUMMARY.md).",
    );
  }
  const { url } = getServerSupabaseConfig();
  return createClient<Database>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // Waits for response headers are bounded; streamed bodies are not cut off.
    global: { fetch: createBoundedFetch() },
  });
}

export type TrustedWriteError = { code: string };
type Result<T> = { ok: true; data: T } | { ok: false; error: TrustedWriteError };

function failure(error: { code?: string }): { ok: false; error: TrustedWriteError } {
  return { ok: false, error: { code: error.code ?? "unknown" } };
}

// Records a verified document revision: the canonical PDF and, for a
// non-PDF upload, its source file (same revision folder).
export async function recordVerifiedOriginal(args: {
  actorId: string;
  proposalId: string;
  expectedOriginalPath: string | null;
  path: string;
  source: { path: string; format: SourceFormat; sizeBytes: number } | null;
  fileName: string;
  sizeBytes: number;
  totalPages: number;
}): Promise<
  Result<{ previousOriginalPath: string | null; previousPreviewPath: string | null; previousSourcePath: string | null }>
> {
  const { data, error } = await privilegedClient().rpc("proposal_attach_document", {
    p_actor: args.actorId,
    p_proposal_id: args.proposalId,
    p_expected_original_path: args.expectedOriginalPath,
    p_path: args.path,
    p_source_path: args.source?.path ?? null,
    p_source_format: args.source?.format ?? null,
    p_source_size_bytes: args.source?.sizeBytes ?? null,
    p_file_name: args.fileName,
    p_size_bytes: args.sizeBytes,
    p_total_pages: args.totalPages,
  });
  if (error) return failure(error);
  const row = data?.[0];
  return {
    ok: true,
    data: {
      previousOriginalPath: row?.previous_original_path ?? null,
      previousPreviewPath: row?.previous_preview_path ?? null,
      previousSourcePath: row?.previous_source_path ?? null,
    },
  };
}

export async function recordPreviewAndOffer(args: {
  actorId: string;
  proposalId: string;
  expectedOriginalPath: string;
  previewPath: string;
  freePages: number;
  priceMinor: number;
  currency: string;
}): Promise<Result<{ previousPreviewPath: string | null }>> {
  const { data, error } = await privilegedClient().rpc("proposal_save_offer", {
    p_actor: args.actorId,
    p_proposal_id: args.proposalId,
    p_expected_original_path: args.expectedOriginalPath,
    p_preview_path: args.previewPath,
    p_free_pages: args.freePages,
    p_price_minor: args.priceMinor,
    p_currency: args.currency,
  });
  if (error) return failure(error);
  return { ok: true, data: { previousPreviewPath: data?.[0]?.previous_preview_path ?? null } };
}

export async function activateLink(args: {
  actorId: string;
  proposalId: string;
  expectedPreviewPath: string;
  tokenHash: string;
}): Promise<Result<{ createdAt: string }>> {
  const { data, error } = await privilegedClient().rpc("proposal_issue_link", {
    p_actor: args.actorId,
    p_proposal_id: args.proposalId,
    p_expected_preview_path: args.expectedPreviewPath,
    p_token_hash: args.tokenHash,
  });
  if (error) return failure(error);
  return { ok: true, data: { createdAt: data } };
}

export async function revokeLink(args: {
  actorId: string;
  proposalId: string;
}): Promise<Result<null>> {
  const { error } = await privilegedClient().rpc("proposal_revoke_link", {
    p_actor: args.actorId,
    p_proposal_id: args.proposalId,
  });
  if (error) return failure(error);
  return { ok: true, data: null };
}

export type DeletionResult =
  | { ok: true; removedObjects: number }
  // begin: nothing changed (not found / payment records / unavailable).
  // storage / finish: the proposal stays marked as deleting (no public
  // access, frozen) and the same call can be retried safely.
  | { ok: false; stage: "begin" | "storage" | "finish"; error: TrustedWriteError };

const REMOVE_BATCH = 100;
const STORAGE_ROUNDS = 3;

// Permanent proposal deletion. Callers must have authenticated the user and
// loaded the proposal through the user's RLS-scoped client. The SQL
// functions re-check that `actorId` is the owner or an admin.
//
//   1. proposal_begin_deletion: mark as deleting and revoke the link in one
//      statement (refused with PT412 when payment records exist);
//   2. remove every object under the proposal's own storage folder, as
//      listed by the database (never paths from the request), re-listing
//      until none remain;
//   3. proposal_finish_deletion: delete the row, only if storage is empty.
// Every step is idempotent, so a failed run is completed by running again.
export async function deleteProposalPermanently(args: {
  actorId: string;
  proposalId: string;
}): Promise<DeletionResult> {
  const client = privilegedClient();
  const ids = { p_actor: args.actorId, p_proposal_id: args.proposalId };

  const { data: begun, error: beginError } = await client.rpc("proposal_begin_deletion", ids);
  const ownerId = begun?.[0]?.owner_id;
  if (beginError || !ownerId) return { ok: false, stage: "begin", error: { code: beginError?.code ?? "unknown" } };
  const folder = `${ownerId}/${args.proposalId}/`;

  let removedObjects = 0;
  for (let round = 0; ; round++) {
    const { data: names, error: listError } = await client.rpc("proposal_deletion_objects", ids);
    if (listError) return failure(listError, "storage");
    // The database already limits the list to this folder; checked again here.
    const targets = (names ?? []).filter((name) => name.startsWith(folder));
    if (targets.length !== (names ?? []).length) return { ok: false, stage: "storage", error: { code: "path" } };
    if (targets.length === 0) break;
    if (round >= STORAGE_ROUNDS) return { ok: false, stage: "storage", error: { code: "remaining" } };

    for (let i = 0; i < targets.length; i += REMOVE_BATCH) {
      const { data: removed, error: removeError } = await client.storage
        .from(PROPOSALS_BUCKET)
        .remove(targets.slice(i, i + REMOVE_BATCH));
      if (removeError) return failure(removeError, "storage");
      removedObjects += removed?.length ?? 0;
    }
  }

  const { error: finishError } = await client.rpc("proposal_finish_deletion", ids);
  if (finishError) return failure(finishError, "finish");
  return { ok: true, removedObjects };

  function failure(error: { code?: string; statusCode?: string }, stage: "storage" | "finish"): DeletionResult {
    return { ok: false, stage, error: { code: error.code ?? error.statusCode ?? "unknown" } };
  }
}

export type PreviewObject =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  // No active, prepared proposal matches the token (unknown, malformed,
  // revoked, inactive). Callers must answer exactly like for any other
  // invalid link.
  | { ok: false; reason: "unavailable" }
  // The link is valid but the preview object is missing or storage failed.
  | { ok: false; reason: "missing" | "error" };

// Client preview delivery (anonymous, token-authorized). The token is
// checked in the database FIRST: storage is read only for the preview path
// that resolve_proposal_preview_object returns for an active proposal whose
// stored hash matches. The path never comes from the request, and the
// function cannot return an original's path. Callers must not log `token`.
export async function openPreviewForLink(token: string): Promise<PreviewObject> {
  const client = privilegedClient();
  const { data: path, error } = await client.rpc("resolve_proposal_preview_object", { p_token: token });
  if (error) return { ok: false, reason: "error" };
  if (!path || !path.endsWith("/preview.pdf")) return { ok: false, reason: "unavailable" };

  const { data: stream, error: storageError } = await client.storage
    .from(PROPOSALS_BUCKET)
    .download(path)
    .asStream();
  if (storageError || !stream) {
    const status = (storageError as { status?: number } | null)?.status;
    const code = (storageError as { code?: string } | null)?.code;
    return { ok: false, reason: status === 404 || code === "NoSuchKey" ? "missing" : "error" };
  }
  return { ok: true, stream: stream as ReadableStream<Uint8Array> };
}

export type ScheduledCleanupSummary = {
  mode: "dry-run" | "apply";
  olderThanHours: number;
  counts: Record<string, number>;
  candidates: number;
  candidateBytes: number;
  truncated: boolean;
  deleted: number;
  skippedOnRecheck: number;
  failed: number;
  // Proposals left in "Deletion pending" (a deletion that didn't finish).
  // Completed by "Retry deletion" in Proposal History, never by this job.
  pendingDeletions: number | null;
};

// Scheduled storage cleanup (src/app/api/cron/storage-cleanup/route.ts).
// Reuses runStorageCleanup from scripts/storage-cleanup.mjs unchanged: same
// age threshold, referenced/in-progress protection, per-batch re-check and
// audit trail. Returns counts only, never object names.
export async function runScheduledStorageCleanup(args: {
  apply: boolean;
  olderThanHours: number;
  maxObjects: number;
}): Promise<ScheduledCleanupSummary> {
  const { runStorageCleanup } = await import("../../../scripts/storage-cleanup.mjs");
  const client = privilegedClient();
  const report = await runStorageCleanup(client, args);

  const { count, error } = await client
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .not("deletion_requested_at", "is", null);

  return {
    mode: report.mode === "apply" ? "apply" : "dry-run",
    olderThanHours: report.olderThanHours,
    counts: report.counts,
    candidates: report.candidates,
    candidateBytes: report.candidateBytes,
    truncated: report.truncated,
    deleted: report.deleted,
    skippedOnRecheck: report.skippedOnRecheck,
    failed: report.failed,
    pendingDeletions: error ? null : (count ?? 0),
  };
}
