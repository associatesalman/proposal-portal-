import "server-only";

import { inspectPdf } from "@/lib/proposals/pdf";

import { DOCUMENT_FORMATS, formatInfo, type DocumentFormat, type UploadFormats } from "./formats";
import { inspectDocument } from "./inspect";
import { converterConfig, convertWithLibreOffice } from "./libreoffice";
import { textToPdf } from "./txt";

// Turns a verified upload into the revision's canonical PDF:
//   PDF   -> checked and used as-is;
//   TXT   -> rendered natively (txt.ts), or by LibreOffice for characters
//            the built-in font can't show (if configured);
//   DOCX, DOC, ODT, RTF -> LibreOffice (libreoffice.ts), only if configured.
// The result is always re-checked as a PDF (header, parse, no encryption,
// at least one page) before anyone can use it.

export const CONVERTER_MISSING =
  "Word, OpenDocument and RTF uploads need the document converter (LibreOffice), which isn't set up on this server. Upload a PDF instead, or ask your administrator to configure it.";

export function uploadFormats(): UploadFormats {
  const converter = converterConfig() !== null;
  const enabled = DOCUMENT_FORMATS.filter((format) => converter || !format.needsConverter).map((format) => format.id);
  const unavailable = DOCUMENT_FORMATS.filter((format) => !enabled.includes(format.id)).map((format) => format.id);
  return { enabled, unavailable, unavailableReason: unavailable.length > 0 ? CONVERTER_MISSING : null };
}

export function isFormatEnabled(format: DocumentFormat): boolean {
  return uploadFormats().enabled.includes(format);
}

export type CanonicalResult =
  | { ok: true; pdf: Uint8Array; pageCount: number; converted: boolean }
  | { ok: false; message: string; retryable?: boolean };

export async function toCanonicalPdf(
  bytes: Uint8Array,
  claimed: DocumentFormat,
  options: { title: string; maxPages: number },
): Promise<CanonicalResult> {
  const label = formatInfo(claimed).extension.toUpperCase();
  const inspection = inspectDocument(bytes, claimed);
  if (!inspection.ok) {
    if (claimed === "pdf" && inspection.reason !== "encrypted") {
      return { ok: false, message: "This file isn't a PDF. Choose a PDF document." };
    }
    switch (inspection.reason) {
      case "mismatch":
        return {
          ok: false,
          message: inspection.detected
            ? `This file's contents are ${formatInfo(inspection.detected).extension.toUpperCase()}, not ${label}. Rename it with the correct extension, or export it again.`
            : `This file isn't a valid ${label} document.`,
        };
      case "encrypted":
        return {
          ok: false,
          message: "This document is password-protected or encrypted. Remove the protection and upload it again.",
        };
      case "macros":
        return {
          ok: false,
          message: "This document contains macros or active content, which aren't accepted. Save it as a regular document (without macros) and upload it again.",
        };
      case "external":
        return {
          ok: false,
          message: "This document links to external files, embedded objects or data sources, which aren't accepted. Embed the content instead (or save it as PDF) and upload it again.",
        };
      case "unsafe":
        return { ok: false, message: "This document's structure isn't accepted (it is unusually large when unpacked, or malformed). Save it again or upload a PDF." };
      case "not_text":
        return { ok: false, message: "This text file is empty." };
      case "unsupported":
        return {
          ok: false,
          message: "This file type isn't supported. Upload a PDF, DOCX, DOC, ODT, RTF or TXT document.",
        };
      default:
        return { ok: false, message: `This ${label} file couldn't be read. It may be damaged. Save it again and retry.` };
    }
  }

  let pdf: Uint8Array;
  let converted = false;

  if (inspection.format === "pdf") {
    pdf = bytes;
  } else if (inspection.format === "txt") {
    const text = await textToPdf(inspection.text ?? "", options.title, options.maxPages);
    if (text.ok) {
      pdf = text.pdf;
      converted = true;
    } else if (text.reason === "too_many_pages") {
      return { ok: false, message: `This text is longer than ${options.maxPages} pages. Split it or shorten it.` };
    } else if (converterConfig()) {
      const result = await convertWithLibreOffice(bytes, "txt");
      if (!result.ok) return conversionFailure(result.reason, label);
      pdf = result.pdf;
      converted = true;
    } else {
      return {
        ok: false,
        message: "This text uses characters (for example non-Latin scripts or emoji) that need the document converter, which isn't set up on this server. Save it as PDF and upload that instead.",
      };
    }
  } else {
    if (!converterConfig()) return { ok: false, message: CONVERTER_MISSING };
    const result = await convertWithLibreOffice(bytes, inspection.format);
    if (!result.ok) return conversionFailure(result.reason, label);
    pdf = result.pdf;
    converted = true;
  }

  const checked = await inspectPdf(pdf);
  if (!checked.ok) {
    if (!converted) {
      const messages = {
        not_pdf: "This file isn't a PDF. Choose a PDF document.",
        encrypted:
          "This PDF is password-protected or encrypted. Remove the protection in your PDF tool and upload it again.",
        corrupt: "This PDF couldn't be read. It may be damaged. Export it again and retry.",
      } as const;
      return { ok: false, message: messages[checked.reason] };
    }
    return { ok: false, message: `The ${label} document was converted, but the resulting PDF couldn't be read. Save it as PDF yourself and upload that instead.` };
  }
  return { ok: true, pdf, pageCount: checked.pageCount, converted };
}

function conversionFailure(
  reason: "unavailable" | "timeout" | "failed" | "no_output" | "too_large" | "busy",
  label: string,
): CanonicalResult {
  switch (reason) {
    case "unavailable":
      console.error("[documents] converter could not be started");
      return { ok: false, message: CONVERTER_MISSING };
    case "timeout":
      return {
        ok: false,
        message: `Converting this ${label} document took too long and was stopped. Simplify it or save it as PDF and upload that instead.`,
      };
    case "too_large":
      return { ok: false, message: `This ${label} document converts to a PDF larger than 25 MB. Reduce image sizes or upload a smaller document.` };
    case "busy":
      return { ok: false, message: "The document converter is busy. Try again in a minute.", retryable: true };
    default:
      return {
        ok: false,
        message: `This ${label} document couldn't be converted to PDF. It may be damaged or use features the converter can't read. Save it as PDF and upload that instead.`,
      };
  }
}
