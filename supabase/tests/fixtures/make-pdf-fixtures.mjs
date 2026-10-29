// Phase 7 PDF fixture generator (test data only; nothing here is committed
// output). Uses pdfkit, which is NOT a project dependency. Run it from a
// scratch folder so the project's packages stay unchanged:
//
//   mkdir %TEMP%\pdf-fixtures && cd %TEMP%\pdf-fixtures
//   npm init -y && npm install pdfkit@0.17.2
//   copy <project>\supabase\tests\fixtures\make-pdf-fixtures.mjs .
//   node make-pdf-fixtures.mjs          -> .\fixtures\*.pdf
//
// Then: set PDF_FIXTURES_DIR=%TEMP%\pdf-fixtures\fixtures && npm run test:hardening
//
// The Unicode/CJK fixture embeds subsets of locally installed Windows fonts
// (Microsoft YaHei, MS Gothic, Malgun Gothic, Georgia, Consolas); on other
// systems change the font paths. Encryption uses pdfkit's implementation of
// the PDF Standard Security Handler (RC4 40/128-bit, AES-128, AES-256).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import PDFDocument from "pdfkit";

const out = path.join(process.cwd(), "fixtures");
fs.mkdirSync(out, { recursive: true });

function write(name, options, build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, compress: true, ...options });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => {
      const buf = Buffer.concat(chunks);
      fs.writeFileSync(path.join(out, name), buf);
      resolve({ name, bytes: buf.length });
    });
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

// PNG of random RGB noise (incompressible), via zlib.
function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function noisePng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const rand = crypto.createHash("sha256").update(String(seed)).digest();
  let state = rand.readUInt32LE(0) || 1;
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      // Mostly grey "scan" texture with noise: still poorly compressible.
      raw[y * (w * 3 + 1) + 1 + x] = 200 + (state & 0x37);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function textPages(doc, count, label, font) {
  for (let i = 1; i <= count; i++) {
    doc.addPage({ size: "A4" });
    if (font) doc.font(font);
    doc.fontSize(20).text(`${label} page ${i}`, 72, 72);
    doc.fontSize(11).text(
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(18),
      72, 120, { width: 450 },
    );
  }
}

await (async () => {
  const results = [];
  results.push(await write("text-12.pdf", { info: { Title: "Text fixture" } }, (d) => textPages(d, 12, "Text")));

  // Encrypted with real PDF encryption (pdfkit implements the Standard
  // Security Handler): RC4-40 (PDF 1.3), RC4-128 (1.4), AES-128 (1.6),
  // AES-256 (1.7ext3). User password = needs a password to open; owner-only
  // = opens without a password but restricts permissions.
  const enc = [
    ["enc-rc4-40-user.pdf", "1.3", "user-pass"],
    ["enc-rc4-128-user.pdf", "1.4", "user-pass"],
    ["enc-aes-128-user.pdf", "1.6", "user-pass"],
    ["enc-aes-256-user.pdf", "1.7ext3", "user-pass"],
    ["enc-aes-256-owner-only.pdf", "1.7ext3", undefined],
    ["enc-rc4-128-owner-only.pdf", "1.4", undefined],
  ];
  for (const [name, pdfVersion, userPassword] of enc) {
    results.push(await write(name, {
      pdfVersion, userPassword, ownerPassword: "owner-secret",
      permissions: { printing: "lowResolution", modifying: false, copying: false },
    }, (d) => textPages(d, 4, "Encrypted")));
  }

  // Unicode / CJK / unusual fonts (embedded subsets from local system fonts).
  results.push(await write("unicode-cjk.pdf", {}, (d) => {
    const fonts = [
      ["C:/Windows/Fonts/msyh.ttc", "MicrosoftYaHei", "简体中文：提案预览页面 第 {n} 页"],
      ["C:/Windows/Fonts/msgothic.ttc", "MS-Gothic", "日本語：提案書のプレビュー {n} ページ"],
      ["C:/Windows/Fonts/malgun.ttf", null, "한국어: 제안서 미리보기 {n} 페이지"],
      ["C:/Windows/Fonts/georgia.ttf", null, "Ελληνικά, Кириллица, Ünïcödé — “quotes” € £ ¥ {n}"],
      ["C:/Windows/Fonts/consola.ttf", null, "Monospace ∑ ∫ √ ≠ ≤ ≥ → ← ✓ {n}"],
    ];
    fonts.forEach(([file, family, text], i) => {
      d.addPage({ size: "A4" });
      if (family) d.registerFont(`f${i}`, file, family); else d.registerFont(`f${i}`, file);
      d.font(`f${i}`).fontSize(22).text(text.replace("{n}", String(i + 1)), 72, 90, { width: 450 });
      d.fontSize(12).text(text.replace("{n}", "").repeat(6), 72, 160, { width: 450 });
    });
  }));

  // Scanned / image-heavy: every page is one full-page noise image.
  const scanPng = (seed) => noisePng(827, 1170, seed); // ~100 dpi A4
  results.push(await write("scanned-6.pdf", {}, (d) => {
    for (let i = 0; i < 6; i++) {
      d.addPage({ size: "A4", margin: 0 });
      d.image(scanPng(i), 0, 0, { width: 595.28, height: 841.89 });
    }
  }));

  // Page-count edges: exactly 300 and 301 pages.
  results.push(await write("pages-300.pdf", {}, (d) => textPages(d, 300, "Long")));
  results.push(await write("pages-301.pdf", {}, (d) => textPages(d, 301, "Long")));

  // Size edges: about 19.5 MiB (under the 20 MiB limit) and about 21 MiB.
  async function sized(name, targetBytes) {
    let pages = Math.max(2, Math.round(targetBytes / 1_160_000));
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await write(name, {}, (d) => {
        for (let i = 0; i < pages; i++) {
          d.addPage({ size: "A4", margin: 0 });
          d.image(noisePng(1100, 1100, `${name}-${i}`), 0, 0, { width: 595.28, height: 595.28 });
          d.fontSize(14).text(`Large page ${i + 1}`, 40, 700);
        }
      });
      const ratio = targetBytes / r.bytes;
      if (Math.abs(1 - ratio) < 0.02) return r;
      pages = Math.max(2, Math.round(pages * ratio));
    }
    return { name, bytes: fs.statSync(path.join(out, name)).size };
  }
  results.push(await sized("large-19_5mib.pdf", 19.5 * 1024 * 1024));
  results.push(await sized("large-21mib.pdf", 21 * 1024 * 1024));

  for (const r of results) console.log(`${r.name.padEnd(30)} ${(r.bytes / 1048576).toFixed(2)} MiB`);
})();
