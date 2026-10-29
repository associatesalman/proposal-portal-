import "server-only";

// PDF limits. Defaults are conservative for the planned deployment (Vercel
// Functions + Supabase Storage):
//
// - Uploads go straight from the browser to private Supabase Storage with a
//   signed upload URL, so Vercel's ~4.5 MB request-body limit does not apply.
// - The server then downloads the stored file and parses it with pdf-lib,
//   which holds the whole document (and its parsed objects) in memory. A
//   20 MiB file stays well inside a default 2 GB function, and parsing plus
//   preview generation for <= 300 pages fits the 60 s maxDuration set on the
//   dashboard page.
// - The storage bucket itself rejects anything over 25 MiB, so a larger
//   configured value is clamped to that.
//
// Override with PDF_MAX_UPLOAD_MB / PDF_MAX_PAGES (server-side env vars).

const MiB = 1024 * 1024;
export const BUCKET_FILE_SIZE_LIMIT = 25 * MiB;

const DEFAULT_MAX_UPLOAD_MB = 20;
const DEFAULT_MAX_PAGES = 300;
const PAGES_CEILING = 1000;

export type PdfLimits = { maxBytes: number; maxPages: number };

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function getPdfLimits(): PdfLimits {
  return {
    maxBytes: Math.min(
      readInt("PDF_MAX_UPLOAD_MB", DEFAULT_MAX_UPLOAD_MB, 1, 25) * MiB,
      BUCKET_FILE_SIZE_LIMIT,
    ),
    maxPages: readInt("PDF_MAX_PAGES", DEFAULT_MAX_PAGES, 2, PAGES_CEILING),
  };
}
