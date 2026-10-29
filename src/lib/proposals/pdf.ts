import "server-only";

import { PDFDict, PDFDocument, PDFName } from "pdf-lib";

// Server-side PDF checks and preview generation with pdf-lib. The browser's
// file name and MIME type are never trusted: only the stored bytes are.

export type PdfInspection =
  | { ok: true; pageCount: number }
  | { ok: false; reason: "not_pdf" | "encrypted" | "corrupt" };

// PDF readers accept the header anywhere in the first 1024 bytes.
const HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const HEADER_WINDOW = 1024;

export function hasPdfHeader(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length - HEADER.length, HEADER_WINDOW);
  for (let i = 0; i <= end; i++) {
    if (HEADER.every((byte, j) => bytes[i + j] === byte)) return true;
  }
  return false;
}

class EncryptedPdfError extends Error {}

async function loadStrict(bytes: Uint8Array): Promise<PDFDocument> {
  // pdf-lib's own EncryptedPDFError can't be detected with instanceof (its
  // CommonJS build throws a plain Error), so encryption is detected from the
  // parsed trailer instead. Any /Encrypt entry rejects the file right after
  // parsing; encrypted content is never read, decrypted or processed.
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt !== undefined) {
    throw new EncryptedPdfError();
  }
  return doc;
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  if (!hasPdfHeader(bytes)) return { ok: false, reason: "not_pdf" };
  try {
    const doc = await loadStrict(bytes);
    const pageCount = doc.getPageCount();
    if (!Number.isInteger(pageCount) || pageCount < 1) return { ok: false, reason: "corrupt" };
    return { ok: true, pageCount };
  } catch (error) {
    if (error instanceof EncryptedPdfError) return { ok: false, reason: "encrypted" };
    return { ok: false, reason: "corrupt" };
  }
}

// Page-level entries that can reference other pages, embed files or run
// actions. They are removed before copying so their objects are never
// pulled into the preview file.
const STRIPPED_PAGE_KEYS = ["Annots", "AA", "B", "Thumb", "Metadata", "PieceInfo"];

// Builds a NEW PDF containing only pages 1..freePages. Document-level data
// (outline, named destinations, embedded files, forms, info dictionary,
// XMP metadata) is not copied because only page objects are transferred.
// Throws if the result doesn't contain exactly `freePages` pages.
export async function buildPreviewPdf(original: Uint8Array, freePages: number): Promise<Uint8Array> {
  const source = await loadStrict(original);
  if (!Number.isInteger(freePages) || freePages < 1 || freePages >= source.getPageCount()) {
    throw new Error("free page count out of range");
  }

  const indices = Array.from({ length: freePages }, (_, i) => i);
  for (const index of indices) {
    const node = source.getPage(index).node;
    for (const key of STRIPPED_PAGE_KEYS) node.delete(PDFName.of(key));
  }

  const preview = await PDFDocument.create({ updateMetadata: false });
  const pages = await preview.copyPages(source, indices);
  for (const page of pages) preview.addPage(page);

  // Defence in depth: no page object other than the copied ones may have
  // been pulled in through shared resources.
  const pageObjects = preview.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFDict && object.get(PDFName.of("Type")) === PDFName.of("Page"));
  if (pageObjects.length !== freePages) {
    throw new Error("preview contains unexpected page objects");
  }

  const bytes = await preview.save({ useObjectStreams: true });

  const check = await PDFDocument.load(bytes, { updateMetadata: false });
  if (check.getPageCount() !== freePages) {
    throw new Error("preview page count mismatch");
  }
  return bytes;
}
