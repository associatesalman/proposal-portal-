// Storage object paths in the private "proposals" bucket. Every upload gets
// its own revision folder, so a replacement never overwrites the document a
// proposal currently points at:
//   {owner_id}/{proposal_id}/{revision}/original.pdf
//   {owner_id}/{proposal_id}/{revision}/preview.pdf
//   {owner_id}/{proposal_id}/{revision}/source.<docx|doc|odt|rtf|txt>
// (the source is the uploaded file when it wasn't a PDF; original.pdf is
// then its server-side conversion, the canonical PDF).
// Phase 2 also allowed {owner_id}/{proposal_id}/original.pdf ("legacy").

import type { SourceFormat } from "@/lib/documents/formats";

export const PROPOSALS_BUCKET = "proposals";

export type DocumentKind = "original" | "preview";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LEGACY_REVISION = "legacy";

export function documentPath(
  ownerId: string,
  proposalId: string,
  revision: string,
  kind: DocumentKind,
): string {
  if (revision === LEGACY_REVISION) return `${ownerId}/${proposalId}/${kind}.pdf`;
  if (!UUID.test(revision)) throw new Error("invalid revision");
  return `${ownerId}/${proposalId}/${revision}/${kind}.pdf`;
}

// The uploaded source file of a non-PDF revision (never a legacy path).
export function sourcePath(ownerId: string, proposalId: string, revision: string, format: SourceFormat): string {
  if (!UUID.test(revision)) throw new Error("invalid revision");
  return `${ownerId}/${proposalId}/${revision}/source.${format}`;
}

// The revision folder of a stored path: the opaque version token the
// dashboard sends back to detect stale edits. Never the full path.
export function revisionOf(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split("/");
  if (parts.length === 3) return LEGACY_REVISION;
  return parts.length === 4 && UUID.test(parts[2]) ? parts[2] : null;
}
