import "server-only";

// A minimal reader for Compound File Binary containers (legacy .doc, and
// also the wrapper Office uses for password-protected DOCX). It lists the
// directory's stream/storage names and reads the start of a stream, which
// is all the inspection needs: macro storages, encryption markers, and the
// Word FIB "encrypted" flag. Every chain walk is bounded, so a malformed
// file can't loop or allocate without limit.

export type CfbEntry = { name: string; type: number; start: number; size: number };
export type CfbResult = { ok: true; entries: CfbEntry[]; readStream: (entry: CfbEntry, max: number) => Uint8Array | null } | { ok: false };

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_DIRECTORY_ENTRIES = 10_000;

export function isCfb(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 512 && SIGNATURE.every((value, index) => bytes[index] === value);
}

export function readCfb(bytes: Uint8Array): CfbResult {
  if (!isCfb(bytes)) return { ok: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorShift = view.getUint16(0x1e, true);
  if (sectorShift !== 9 && sectorShift !== 12) return { ok: false };
  const sectorSize = 1 << sectorShift;
  const sectorCount = Math.floor((bytes.byteLength - sectorSize) / sectorSize);
  const fatSectors = view.getUint32(0x2c, true);
  const firstDirectory = view.getUint32(0x30, true);
  const firstDifat = view.getUint32(0x44, true);
  const difatCount = view.getUint32(0x48, true);
  if (fatSectors > sectorCount + 1) return { ok: false };

  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;
  const validSector = (sector: number) => sector < sectorCount;

  // DIFAT: 109 entries in the header, then a chain of DIFAT sectors.
  const fatSectorList: number[] = [];
  for (let i = 0; i < 109 && fatSectorList.length < fatSectors; i++) {
    const sector = view.getUint32(0x4c + i * 4, true);
    if (sector === FREE) break;
    fatSectorList.push(sector);
  }
  let difat = firstDifat;
  for (let walked = 0; fatSectorList.length < fatSectors && difat !== END_OF_CHAIN && walked < difatCount; walked++) {
    if (!validSector(difat)) return { ok: false };
    const base = sectorOffset(difat);
    for (let i = 0; i < sectorSize / 4 - 1 && fatSectorList.length < fatSectors; i++) {
      fatSectorList.push(view.getUint32(base + i * 4, true));
    }
    difat = view.getUint32(base + sectorSize - 4, true);
  }

  const fat: number[] = [];
  for (const sector of fatSectorList) {
    if (!validSector(sector)) return { ok: false };
    const base = sectorOffset(sector);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(view.getUint32(base + i * 4, true));
  }

  // A sector chain, bounded by the number of sectors (no loops).
  function chain(start: number): number[] | null {
    const sectors: number[] = [];
    let sector = start;
    while (sector !== END_OF_CHAIN) {
      if (!validSector(sector) || sector >= fat.length || sectors.length > sectorCount) return null;
      sectors.push(sector);
      sector = fat[sector];
    }
    return sectors;
  }

  const directorySectors = chain(firstDirectory);
  if (!directorySectors) return { ok: false };
  const entries: CfbEntry[] = [];
  for (const sector of directorySectors) {
    const base = sectorOffset(sector);
    for (let offset = 0; offset < sectorSize; offset += 128) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) return { ok: false };
      const type = bytes[base + offset + 0x42];
      if (type === 0) continue; // unused slot
      const nameBytes = Math.min(view.getUint16(base + offset + 0x40, true), 64);
      let name = "";
      for (let i = 0; i + 1 < nameBytes - 1; i += 2) name += String.fromCharCode(view.getUint16(base + offset + i, true));
      entries.push({
        name,
        type,
        start: view.getUint32(base + offset + 0x74, true),
        size: view.getUint32(base + offset + 0x78, true),
      });
    }
  }

  const miniCutoff = view.getUint32(0x38, true);

  // Reads up to `max` bytes of a regular (non-mini) stream.
  function readStream(entry: CfbEntry, max: number): Uint8Array | null {
    if (entry.size < miniCutoff) return null;
    const sectors = chain(entry.start);
    if (!sectors) return null;
    const length = Math.min(entry.size, max);
    const out = new Uint8Array(length);
    let written = 0;
    for (const sector of sectors) {
      if (written >= length) break;
      const take = Math.min(sectorSize, length - written);
      out.set(bytes.subarray(sectorOffset(sector), sectorOffset(sector) + take), written);
      written += take;
    }
    return written === length ? out : null;
  }

  return { ok: true, entries, readStream };
}
