// Copies the PDF.js worker and the data files it loads at runtime from the
// installed pdfjs-dist into public/pdfjs/<version>/, so the client viewer
// loads everything from this origin (no CDN) and always gets files that
// match the library version it was bundled with. Runs before dev and build
// (package.json predev/prebuild). The output folder is gitignored.
//
// Copied: the legacy-build worker (the viewer uses the legacy build for
// older client browsers), standard fonts (PDFs with non-embedded base-14
// fonts), CMaps (CJK text), ICC profiles and the image-decoder wasm. The
// JavaScript sandbox (quickjs) is NOT copied: PDF scripting stays off.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "pdfjs-dist");
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const outRoot = join(root, "public", "pdfjs");
const out = join(outRoot, version);

// Drop folders of other versions so stale workers can't be picked up.
if (existsSync(outRoot)) {
  for (const entry of readdirSync(outRoot)) {
    if (entry !== version) rmSync(join(outRoot, entry), { recursive: true, force: true });
  }
}
mkdirSync(out, { recursive: true });

cpSync(join(pkgDir, "legacy", "build", "pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));
for (const dir of ["standard_fonts", "cmaps", "iccs"]) {
  cpSync(join(pkgDir, dir), join(out, dir), { recursive: true });
}
cpSync(join(pkgDir, "wasm"), join(out, "wasm"), {
  recursive: true,
  filter: (src) => !/quickjs/i.test(src),
});

console.log(`pdfjs-dist ${version} assets -> public/pdfjs/${version}/`);
