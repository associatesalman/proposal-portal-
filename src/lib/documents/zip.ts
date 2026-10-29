import "server-only";

import { inflateRawSync } from "node:zlib";

// A minimal, defensive ZIP reader for inspecting DOCX/ODT packages BEFORE
// they reach the converter. It reads only the central directory (names,
// sizes, flags) and inflates small XML parts on request, each with a hard
// output cap, so a crafted archive can't exhaust memory ("zip bombs").
//
// Refused outright: ZIP64, multi-disk archives, encrypted entries,
// compression methods other than stored/deflate, absolute or ".." paths,
// too many entries, or a declared total/ratio past the limits below.

export const ZIP_LIMITS = {
  maxEntries: 2000,
  // Sum of declared uncompressed sizes.
  maxTotalUncompressed: 300 * 1024 * 1024,
  // Per-entry expansion ratio, checked for entries above 1 MiB.
  maxRatio: 150,
  // Largest single part we ever inflate for inspection.
  maxInspectBytes: 64 * 1024 * 1024,
};

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export type ZipResult =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; reason: "not_zip" | "encrypted" | "unsafe" };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZipDirectory(bytes: Uint8Array): ZipResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22 || view.getUint32(0, true) !== LOCAL) return { ok: false, reason: "not_zip" };

  // End of central directory: within the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, reason: "not_zip" };

  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0) return { ok: false, reason: "unsafe" };
  // 0xFFFF / 0xFFFFFFFF mean ZIP64, which no document needs here.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return { ok: false, reason: "unsafe" };
  if (count === 0 || count > ZIP_LIMITS.maxEntries) return { ok: false, reason: "unsafe" };
  if (offset + size > eocd) return { ok: false, reason: "not_zip" };

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let cursor = offset;
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (let n = 0; n < count; n++) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CENTRAL) return { ok: false, reason: "not_zip" };
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > eocd) return { ok: false, reason: "not_zip" };
    const name = decoder.decode(bytes.subarray(cursor + 46, nameEnd));

    // Bit 0: encrypted; bit 6: strong encryption.
    if (flags & 0x0001 || flags & 0x0040) return { ok: false, reason: "encrypted" };
    if (method !== 0 && method !== 8) return { ok: false, reason: "unsafe" };
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) return { ok: false, reason: "unsafe" };
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\u0000") ||
      name.split("/").some((part) => part === "..")
    ) {
      return { ok: false, reason: "unsafe" };
    }
    if (names.has(name)) return { ok: false, reason: "unsafe" };
    names.add(name);
    if (uncompressedSize > 1024 * 1024 && uncompressedSize > compressedSize * ZIP_LIMITS.maxRatio) {
      return { ok: false, reason: "unsafe" };
    }
    total += uncompressedSize;
    if (total > ZIP_LIMITS.maxTotalUncompressed) return { ok: false, reason: "unsafe" };
    if (localHeaderOffset + 30 > offset) return { ok: false, reason: "not_zip" };

    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    cursor = nameEnd + extraLength + commentLength;
  }

  return { ok: true, entries };
}

// Inflates one entry (bounded). Returns null if it can't be read safely.
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes = ZIP_LIMITS.maxInspectBytes): Uint8Array | null {
  if (entry.uncompressedSize > maxBytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.byteLength || view.getUint32(at, true) !== LOCAL) return null;
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) return null;
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return data.byteLength === entry.uncompressedSize ? data : null;
  try {
    const inflated = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
    return inflated.byteLength === entry.uncompressedSize ? new Uint8Array(inflated) : null;
  } catch {
    return null;
  }
}

export function readZipText(bytes: Uint8Array, entry: ZipEntry): string | null {
  const data = readZipEntry(bytes, entry);
  return data ? new TextDecoder("utf-8", { fatal: false }).decode(data) : null;
}
