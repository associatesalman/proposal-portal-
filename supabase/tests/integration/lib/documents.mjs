// Disposable document fixtures for feature-full-access.mjs, built in memory:
// minimal but structurally valid DOCX/ODT packages (ZIP), legacy DOC files
// (Compound File Binary), RTF and text, plus hostile variants (macros,
// external references, encryption, zip bombs). ZIP entries are STORED by
// default so the converter test double can read its markers.

import { crc32, deflateRawSync } from "node:zlib";

// --- ZIP ---------------------------------------------------------------------

export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.deflate ? 8 : 0;
    const body = entry.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const flags = entry.encrypted ? 0x0001 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// options: marker, contentType, extraEntries, documentRels (array of
// <Relationship> strings), bodyXml.
export function makeDocx({ marker = "DOUBLE:PAGES=4", contentType, extraEntries = [], documentRels = [], bodyXml = "" } = {}) {
  const main = contentType ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  return makeZip([
    {
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/word/document.xml" ContentType="${main}"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${documentRels.join("")}</Relationships>`,
    },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body><w:p><w:r><w:t>Proposal ${marker}</w:t></w:r></w:p>${bodyXml}</w:body></w:document>`,
    },
    ...extraEntries,
  ]);
}

export const externalImageRel = `<Relationship Id="rId9" Type="${REL}/image" Target="https://attacker.example/pixel.png" TargetMode="External"/>`;
export const hyperlinkRel = `<Relationship Id="rId8" Type="${REL}/hyperlink" Target="https://example.com/terms" TargetMode="External"/>`;
export const includePictureField =
  '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INCLUDEPICTURE "http://attacker.example/x.png" \\d </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';

// options: marker, mimetype, extraEntries, contentXml (body inside office:text).
export function makeOdt({ marker = "DOUBLE:PAGES=2", mimetype = "application/vnd.oasis.opendocument.text", extraEntries = [], bodyXml = "", manifestExtra = "" } = {}) {
  return makeZip([
    { name: "mimetype", data: mimetype },
    {
      name: "META-INF/manifest.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
        `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>` +
        `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">${manifestExtra}</manifest:file-entry></manifest:manifest>`,
    },
    {
      name: "content.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
        'xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2"><office:body><office:text>' +
        `<text:p>Proposal ${marker}</text:p>${bodyXml}</office:text></office:body></office:document-content>`,
    },
    ...extraEntries,
  ]);
}

// --- Compound File Binary (legacy .doc, encrypted Office packages) ----------

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

// entries: [{ name, type: "stream" | "storage", data?: Buffer }]
export function makeCfb(entries) {
  const sector = 512;
  const dirEntries = [{ name: "Root Entry", type: 5, data: null }, ...entries.map((e) => ({ ...e, type: e.type === "storage" ? 1 : 2 }))];
  const dirSectors = Math.ceil(dirEntries.length / 4);
  // Streams are padded to >= 4096 bytes so they live in regular sectors.
  const streams = dirEntries.map((e) => {
    if (e.type !== 2) return null;
    const size = Math.max(4096, e.data.length);
    const padded = Buffer.alloc(Math.ceil(size / sector) * sector);
    e.data.copy(padded);
    return { padded, size };
  });

  const fat = [FATSECT];
  const dirStart = fat.length;
  for (let i = 0; i < dirSectors; i++) fat.push(i === dirSectors - 1 ? ENDOFCHAIN : dirStart + i + 1);
  const starts = streams.map((stream) => {
    if (!stream) return 0;
    const start = fat.length;
    const count = stream.padded.length / sector;
    for (let i = 0; i < count; i++) fat.push(i === count - 1 ? ENDOFCHAIN : start + i + 1);
    return start;
  });
  if (fat.length > 128) throw new Error("fixture too large for one FAT sector");
  while (fat.length < 128) fat.push(FREESECT);

  const header = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c);
  header.writeUInt32LE(dirStart, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(ENDOFCHAIN, 0x3c);
  header.writeUInt32LE(ENDOFCHAIN, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREESECT, 0x4c + i * 4);

  const fatSector = Buffer.alloc(sector);
  fat.forEach((value, i) => fatSector.writeUInt32LE(value, i * 4));

  const dir = Buffer.alloc(dirSectors * sector);
  dirEntries.forEach((entry, i) => {
    const base = i * 128;
    const name = Buffer.from(`${entry.name}\u0000`, "utf16le");
    name.copy(dir, base);
    dir.writeUInt16LE(name.length, base + 0x40);
    dir[base + 0x42] = entry.type;
    dir[base + 0x43] = 1; // black
    dir.writeUInt32LE(NOSTREAM, base + 0x44); // left
    dir.writeUInt32LE(i > 0 && i < dirEntries.length - 1 ? i + 1 : NOSTREAM, base + 0x48); // right sibling
    dir.writeUInt32LE(i === 0 && dirEntries.length > 1 ? 1 : NOSTREAM, base + 0x4c); // child
    dir.writeUInt32LE(entry.type === 2 ? starts[i] : entry.type === 5 ? ENDOFCHAIN : 0, base + 0x74);
    dir.writeUInt32LE(entry.type === 2 ? streams[i].size : 0, base + 0x78);
  });
  for (let i = dirEntries.length; i < dirSectors * 4; i++) {
    dir.writeUInt32LE(NOSTREAM, i * 128 + 0x44);
    dir.writeUInt32LE(NOSTREAM, i * 128 + 0x48);
    dir.writeUInt32LE(NOSTREAM, i * 128 + 0x4c);
  }

  return Buffer.concat([header, fatSector, dir, ...streams.filter(Boolean).map((s) => s.padded)]);
}

// A legacy Word file: a WordDocument stream with a Word 97+ FIB.
export function makeDoc({ marker = "DOUBLE:PAGES=5", encrypted = false, macros = false } = {}) {
  const word = Buffer.alloc(4096);
  word.writeUInt16LE(0xa5ec, 0); // wIdent
  word.writeUInt16LE(0x00c1, 2); // nFib
  word.writeUInt16LE(encrypted ? 0x0100 : 0, 0x0a); // flags: fEncrypted
  Buffer.from(`Proposal ${marker}`, "latin1").copy(word, 0x200);
  const entries = [
    { name: "WordDocument", type: "stream", data: word },
    { name: "1Table", type: "stream", data: Buffer.alloc(4096) },
  ];
  if (macros) entries.push({ name: "Macros", type: "storage" });
  return makeCfb(entries);
}

// What Office writes for a password-protected DOCX.
export function makeEncryptedOoxml() {
  return makeCfb([
    { name: "EncryptionInfo", type: "stream", data: Buffer.alloc(4096, 1) },
    { name: "EncryptedPackage", type: "stream", data: Buffer.alloc(4096, 2) },
  ]);
}

// --- RTF -----------------------------------------------------------------------

export function makeRtf({ marker = "DOUBLE:PAGES=2", extra = "" } = {}) {
  return Buffer.from(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs24 Proposal ${marker}\\par ${extra}}`, "latin1");
}

// A ZIP whose single entry expands far beyond its compressed size.
export function makeZipBombDocx() {
  return makeDocx({
    extraEntries: [{ name: "word/media/filler.bin", data: Buffer.alloc(48 * 1024 * 1024), deflate: true }],
  });
}
