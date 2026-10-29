// The document formats proposals accept: an explicit allowlist. Anything
// else (executables, archives, macro-enabled Office files, spreadsheets,
// images, ...) is refused. Shared by the dashboard (file picker hints) and
// the server (which never trusts the extension or declared type: every
// upload is identified from its bytes, see detect.ts).
//
// PDF is stored as-is. Every other format is kept privately as the
// revision's source file and converted on the server to a canonical PDF,
// which is what is viewed, counted, previewed and downloaded as PDF.

export type DocumentFormat = "pdf" | "docx" | "doc" | "odt" | "rtf" | "txt";
export type SourceFormat = Exclude<DocumentFormat, "pdf">;

export type FormatInfo = {
  id: DocumentFormat;
  label: string;
  extension: string;
  // The type uploads are declared with (storage bucket allowlist) and the
  // type downloads of the original are served with.
  mime: string;
  // Converted with LibreOffice (server-side, optional dependency).
  needsConverter: boolean;
};

export const DOCUMENT_FORMATS: readonly FormatInfo[] = [
  { id: "pdf", label: "PDF", extension: "pdf", mime: "application/pdf", needsConverter: false },
  {
    id: "docx",
    label: "Word (DOCX)",
    extension: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    needsConverter: true,
  },
  { id: "doc", label: "Word 97–2003 (DOC)", extension: "doc", mime: "application/msword", needsConverter: true },
  {
    id: "odt",
    label: "OpenDocument Text (ODT)",
    extension: "odt",
    mime: "application/vnd.oasis.opendocument.text",
    needsConverter: true,
  },
  { id: "rtf", label: "Rich Text (RTF)", extension: "rtf", mime: "application/rtf", needsConverter: true },
  // Plain text is converted natively when it fits the built-in font, so it
  // works without LibreOffice (see txt.ts).
  { id: "txt", label: "Plain text (TXT)", extension: "txt", mime: "text/plain", needsConverter: false },
];

export function formatInfo(id: DocumentFormat): FormatInfo {
  return DOCUMENT_FORMATS.find((format) => format.id === id)!;
}

export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return typeof value === "string" && DOCUMENT_FORMATS.some((format) => format.id === value);
}

export function isSourceFormat(value: unknown): value is SourceFormat {
  return isDocumentFormat(value) && value !== "pdf";
}

// The format a file NAME claims (a hint only).
export function formatFromFileName(name: string): DocumentFormat | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  if (!match) return null;
  const extension = match[1].toLowerCase();
  return DOCUMENT_FORMATS.find((format) => format.extension === extension)?.id ?? null;
}

export function formatLabel(id: string | null | undefined): string {
  if (!id || id === "pdf") return "PDF";
  return isDocumentFormat(id) ? formatInfo(id).extension.toUpperCase() : id.toUpperCase();
}

// What the upload step offers, decided on the server (converter present or
// not) and passed to the dashboard.
export type UploadFormats = {
  enabled: DocumentFormat[];
  unavailable: DocumentFormat[];
  // Why the unavailable ones are off (shown to the user).
  unavailableReason: string | null;
};
