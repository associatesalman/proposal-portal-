import "server-only";

import { PDFDocument, StandardFonts } from "pdf-lib";

// Built-in plain-text to PDF conversion (no external tools). Lays the text
// out in a monospaced font on A4 pages, preserving line breaks, wrapping
// long lines and expanding tabs; a form feed starts a new page. The PDF's
// text stays selectable.
//
// The standard PDF fonts only cover Windows-1252 ("WinAnsi") characters. A
// text with other characters (e.g. CJK, Arabic, emoji) can't be rendered
// here: the caller then uses LibreOffice if it is configured, or refuses
// the file with a clear message.

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const FONT_SIZE = 10;
const LINE_HEIGHT = 13;
const TAB = 4;

export type TextConversion =
  | { ok: true; pdf: Uint8Array; pages: number }
  | { ok: false; reason: "unencodable" | "too_many_pages" };

export async function textToPdf(text: string, title: string, maxPages: number): Promise<TextConversion> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const charWidth = font.widthOfTextAtSize("M", FONT_SIZE);
  const perLine = Math.floor((PAGE_WIDTH - 2 * MARGIN) / charWidth);
  const perPage = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT);

  const normalized = text
    .replace(/\r\n?/g, "\n")
    // Other control characters have no glyph.
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "");

  // Pages of lines; "\f" forces a page break.
  const pages: string[][] = [[]];
  const newPage = () => pages.push([]);
  for (const block of normalized.split("\f")) {
    if (pages[pages.length - 1].length > 0) newPage();
    for (const rawLine of block.split("\n")) {
      for (const line of wrap(expandTabs(rawLine), perLine)) {
        if (pages[pages.length - 1].length >= perPage) newPage();
        if (pages.length > maxPages) return { ok: false, reason: "too_many_pages" };
        pages[pages.length - 1].push(line);
      }
    }
  }
  // Drop a trailing empty page left by a final form feed.
  if (pages.length > 1 && pages[pages.length - 1].every((line) => line === "")) pages.pop();

  for (const lines of pages) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN - FONT_SIZE;
    for (const line of lines) {
      if (line) {
        try {
          page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font });
        } catch {
          return { ok: false, reason: "unencodable" };
        }
      }
      y -= LINE_HEIGHT;
    }
  }

  doc.setTitle(title.slice(0, 300));
  doc.setProducer("Proposal Portal");
  doc.setCreator("Proposal Portal");
  const pdf = await doc.save();
  return { ok: true, pdf, pages: doc.getPageCount() };
}

function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const char of line) {
    if (char === "\t") out += " ".repeat(TAB - (out.length % TAB));
    else out += char;
  }
  return out;
}

// Wraps at the last space before the limit when there is one, otherwise
// hard-wraps (long URLs, base64, ...).
function wrap(line: string, width: number): string[] {
  const chars = Array.from(line);
  if (chars.length <= width) return [line];
  const out: string[] = [];
  let rest = chars;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).join("").trimEnd());
    rest = rest.slice(cut);
    while (rest[0] === " ") rest = rest.slice(1);
  }
  out.push(rest.join(""));
  return out;
}
