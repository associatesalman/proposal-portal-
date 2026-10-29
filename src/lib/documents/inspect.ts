import "server-only";

import { readCfb, isCfb } from "./cfb";
import type { DocumentFormat } from "./formats";
import { readZipDirectory, readZipText, type ZipEntry } from "./zip";

// Identifies an uploaded file from its BYTES and checks it is safe to hand
// to the converter. The file name's extension is only a claim: it must
// match what the bytes are.
//
// Refused before conversion:
//   - anything outside the allowlist (archives, executables, spreadsheets,
//     images, other OpenDocument types, ...);
//   - encrypted / password-protected files;
//   - macros or active content (VBA projects, macro-enabled content types,
//     ActiveX, ODF Basic/Scripts, script event listeners);
//   - references to external resources that conversion could fetch
//     (external images/objects/templates/sub-documents in DOCX
//     relationships, linked images/objects/sections in ODT, DDE and
//     INCLUDEPICTURE/INCLUDETEXT-style fields in DOCX/RTF, RTF OLE objects).
//     Plain hyperlinks are fine: they are only rendered as links.
//   - archives past the ZIP limits (zip.ts).
// LibreOffice also runs with macros disabled and link updates off
// (libreoffice.ts), so these checks are not the only line of defence.

export type InspectFailure =
  | "unsupported"
  | "mismatch"
  | "encrypted"
  | "macros"
  | "external"
  | "corrupt"
  | "unsafe"
  | "not_text";

export type Inspection =
  | { ok: true; format: DocumentFormat; text?: string }
  | { ok: false; reason: InspectFailure; detected?: DocumentFormat };

const ODT_MIME = "application/vnd.oasis.opendocument.text";

// Field instructions that fetch or embed other files or programs.
const EXTERNAL_FIELD = /\b(INCLUDEPICTURE|INCLUDETEXT|DDEAUTO|DDE|LINK|IMPORT|INCLUDE)\b/i;

function startsWith(bytes: Uint8Array, text: string, at = 0) {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function hasPdfHeader(bytes: Uint8Array) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

export function inspectDocument(bytes: Uint8Array, claimed: DocumentFormat): Inspection {
  const detected = detect(bytes);
  if (!detected.ok) return detected;
  if (detected.format !== claimed) return { ok: false, reason: "mismatch", detected: detected.format };
  return detected;
}

function detect(bytes: Uint8Array): Inspection {
  if (bytes.byteLength === 0) return { ok: false, reason: "corrupt" };
  if (hasPdfHeader(bytes)) return { ok: true, format: "pdf" };
  if (startsWith(bytes, "PK\u0003\u0004")) return inspectZip(bytes);
  if (isCfb(bytes)) return inspectCfb(bytes);
  if (startsWith(bytes, "{\\rtf")) return inspectRtf(bytes);
  return inspectText(bytes);
}

// --- DOCX / ODT -----------------------------------------------------------

function inspectZip(bytes: Uint8Array): Inspection {
  const zip = readZipDirectory(bytes);
  if (!zip.ok) {
    return { ok: false, reason: zip.reason === "encrypted" ? "encrypted" : zip.reason === "unsafe" ? "unsafe" : "corrupt" };
  }
  const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));

  const mimetype = byName.get("mimetype");
  if (mimetype) {
    const value = readZipText(bytes, mimetype)?.trim();
    if (value === ODT_MIME) return inspectOdt(bytes, zip.entries, byName);
    return { ok: false, reason: "unsupported" };
  }
  if (byName.has("[Content_Types].xml") && byName.has("word/document.xml")) {
    return inspectDocx(bytes, zip.entries, byName);
  }
  return { ok: false, reason: "unsupported" };
}

function inspectDocx(bytes: Uint8Array, entries: ZipEntry[], byName: Map<string, ZipEntry>): Inspection {
  const contentTypes = readZipText(bytes, byName.get("[Content_Types].xml")!);
  if (contentTypes === null) return { ok: false, reason: "corrupt" };
  if (/macroEnabled|vbaProject|vbaData/i.test(contentTypes)) return { ok: false, reason: "macros" };
  if (/template\.main\+xml/i.test(contentTypes)) return { ok: false, reason: "unsupported" };

  for (const entry of entries) {
    if (/(^|\/)vba[^/]*\.(bin|xml)$/i.test(entry.name) || /^word\/activeX\//i.test(entry.name)) {
      return { ok: false, reason: "macros" };
    }
  }

  // Relationships: external targets other than hyperlinks would make the
  // converter fetch a remote/local file (images, templates, frames, ...).
  for (const entry of entries.filter((item) => item.name.endsWith(".rels")).slice(0, 500)) {
    const xml = readZipText(bytes, entry);
    if (xml === null) return { ok: false, reason: "corrupt" };
    for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (!/TargetMode\s*=\s*["']External["']/i.test(tag)) continue;
      const type = /Type\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
      if (!/\/hyperlink$/i.test(type)) return { ok: false, reason: "external" };
    }
  }

  // Field codes in the body, headers, footers and notes.
  const parts = entries.filter((entry) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(entry.name));
  for (const entry of parts) {
    const xml = readZipText(bytes, entry);
    if (xml === null) return { ok: false, reason: "unsafe" };
    for (const match of xml.matchAll(/<w:instrText\b[^>]*>([^<]*)<|w:instr\s*=\s*"([^"]*)"/g)) {
      if (EXTERNAL_FIELD.test(match[1] ?? match[2] ?? "")) return { ok: false, reason: "external" };
    }
    if (/<w:altChunk\b/i.test(xml)) return { ok: false, reason: "external" };
  }

  return { ok: true, format: "docx" };
}

function inspectOdt(bytes: Uint8Array, entries: ZipEntry[], byName: Map<string, ZipEntry>): Inspection {
  for (const entry of entries) {
    if (/^(Basic|Scripts)\//i.test(entry.name)) return { ok: false, reason: "macros" };
  }
  if (!byName.has("content.xml")) return { ok: false, reason: "corrupt" };
  const manifest = byName.get("META-INF/manifest.xml");
  if (manifest) {
    const xml = readZipText(bytes, manifest);
    if (xml === null) return { ok: false, reason: "corrupt" };
    // Encrypted ODF entries are declared in the manifest.
    if (/<manifest:encryption-data\b/i.test(xml)) return { ok: false, reason: "encrypted" };
  }

  for (const name of ["content.xml", "styles.xml"]) {
    const entry = byName.get(name);
    if (!entry) continue;
    const xml = readZipText(bytes, entry);
    if (xml === null) return { ok: false, reason: "unsafe" };
    if (/<(script:event-listener|office:script)\b/i.test(xml)) return { ok: false, reason: "macros" };
    if (/<(office:dde-source|text:dde-connection-decl|table:dde-link)\b/i.test(xml)) return { ok: false, reason: "external" };
    const linked =
      /<(draw:image|draw:object|draw:object-ole|draw:plugin|draw:applet|draw:floating-frame|text:section-source|table:table-source)\b[^>]*xlink:href\s*=\s*"([^"]*)"/gi;
    for (const match of xml.matchAll(linked)) {
      const href = match[2].trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("\\") || href.startsWith("..")) {
        return { ok: false, reason: "external" };
      }
    }
  }
  return { ok: true, format: "odt" };
}

// --- DOC (and encrypted Office files) -------------------------------------

function inspectCfb(bytes: Uint8Array): Inspection {
  const cfb = readCfb(bytes);
  if (!cfb.ok) return { ok: false, reason: "corrupt" };
  const names = new Set(cfb.entries.map((entry) => entry.name));
  // Password-protected DOCX/XLSX/... are CFB wrappers around an encrypted package.
  if (names.has("EncryptionInfo") || names.has("EncryptedPackage")) return { ok: false, reason: "encrypted" };
  const word = cfb.entries.find((entry) => entry.name === "WordDocument" && entry.type === 2);
  if (!word) return { ok: false, reason: "unsupported" };
  if (["Macros", "_VBA_PROJECT_CUR", "VBA", "_VBA_PROJECT"].some((name) => names.has(name))) {
    return { ok: false, reason: "macros" };
  }
  const fib = cfb.readStream(word, 64);
  if (!fib || fib.byteLength < 0x20) return { ok: false, reason: "corrupt" };
  const view = new DataView(fib.buffer, fib.byteOffset, fib.byteLength);
  const ident = view.getUint16(0, true);
  if (ident !== 0xa5ec && ident !== 0xa5dc) return { ok: false, reason: "unsupported" };
  // FIB flags: fEncrypted (bit 8) or fObfuscated (bit 15).
  const flags = view.getUint16(0x0a, true);
  if (flags & 0x0100 || flags & 0x8000) return { ok: false, reason: "encrypted" };
  return { ok: true, format: "doc" };
}

// --- RTF ------------------------------------------------------------------

function inspectRtf(bytes: Uint8Array): Inspection {
  const text = new TextDecoder("latin1").decode(bytes);
  if (/\\(object|objdata|objlink|objautlink|objemb|objocx)\b/.test(text)) return { ok: false, reason: "external" };
  for (const match of text.matchAll(/\\fldinst\b([^}]{0,500})/g)) {
    if (EXTERNAL_FIELD.test(match[1])) return { ok: false, reason: "external" };
  }
  return { ok: true, format: "rtf" };
}

// --- TXT ------------------------------------------------------------------

function inspectText(bytes: Uint8Array): Inspection {
  let control = 0;
  for (const byte of bytes) {
    if (byte === 0) return { ok: false, reason: "unsupported" };
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) control++;
  }
  if (control > Math.max(4, bytes.byteLength / 200)) return { ok: false, reason: "unsupported" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: read it as Windows-1252, the usual legacy encoding.
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  text = text.replace(/^﻿/, "");
  if (!text.trim()) return { ok: false, reason: "not_text" };
  return { ok: true, format: "txt", text };
}
