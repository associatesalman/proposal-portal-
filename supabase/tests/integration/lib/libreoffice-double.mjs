// Test double for headless LibreOffice (soffice), used ONLY by
// feature-documents.mjs through LIBREOFFICE_TEST_DOUBLE. It lets the
// tests exercise the app's converter adapter (src/lib/documents/
// libreoffice.ts): arguments, isolated workspace, hardened profile, minimal
// environment, timeouts, failures, output limits and cleanup. It does NOT
// render documents: real DOCX/DOC/ODT/RTF rendering needs LibreOffice.
//
// Behaviour is chosen by markers in the (uncompressed) input bytes:
//   DOUBLE:PAGES=<n>   write a valid PDF with n pages (default 3)
//   DOUBLE:HANG        never finish (the adapter must kill it)
//   DOUBLE:CRASH       exit with an error and no output
//   DOUBLE:NOOUTPUT    exit successfully without writing a PDF
//   DOUBLE:BADPDF      write bytes that aren't a PDF
//
// Before doing anything it verifies how it was started and exits with
// code 90+ if something is wrong, which the app reports as a failed
// conversion (so the success-path tests prove these properties).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument, StandardFonts } from "pdf-lib";

const args = process.argv.slice(2);
const fail = (code, why) => {
  process.stderr.write(`double: ${why}\n`);
  process.exit(code);
};

const required = ["--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo", "--nofirststartwizard"];
for (const flag of required) if (!args.includes(flag)) fail(90, `missing ${flag}`);
const convert = args.indexOf("--convert-to");
if (convert < 0 || args[convert + 1] !== "pdf:writer_pdf_Export") fail(91, "wrong --convert-to");
const outIndex = args.indexOf("--outdir");
if (outIndex < 0) fail(92, "no --outdir");
const outdir = args[outIndex + 1];
const input = args[args.length - 1];
const workspace = process.cwd();

// Everything lives in this conversion's own temporary workspace.
const inside = (target) => path.resolve(target).startsWith(workspace + path.sep);
if (!path.basename(workspace).startsWith("proposal-convert-")) fail(93, "not an isolated workspace");
if (!inside(outdir) || !inside(input)) fail(94, "paths outside the workspace");
if (!/^source\.(docx|doc|odt|rtf|txt)$/.test(path.basename(input))) fail(95, "unexpected input name");

// A throw-away profile with macros disabled and link updates off.
const profileArg = args.find((arg) => arg.startsWith("-env:UserInstallation="));
if (!profileArg) fail(96, "no isolated profile");
const profileDir = fileURLToPath(profileArg.slice("-env:UserInstallation=".length));
if (!inside(profileDir)) fail(96, "profile outside the workspace");
const xcu = path.join(profileDir, "user", "registrymodifications.xcu");
if (!existsSync(xcu)) fail(97, "no profile settings");
const settings = readFileSync(xcu, "utf8");
for (const needle of [
  'MacroSecurityLevel" oor:op="fuse"><value>3<',
  'DisableMacrosExecution" oor:op="fuse"><value>true<',
  'BlockUntrustedRefererLinks" oor:op="fuse"><value>true<',
  'name="Link" oor:op="fuse"><value>2<',
]) {
  if (!settings.includes(needle)) fail(97, `profile setting missing: ${needle}`);
}

// No secrets from the app's environment.
for (const name of Object.keys(process.env)) {
  if (/SUPABASE|SECRET|PAYPAL|KEY|TOKEN|PASSWORD/i.test(name)) fail(98, `environment leaks ${name}`);
}

const bytes = readFileSync(input);
const text = bytes.toString("latin1");

if (text.includes("DOUBLE:HANG")) {
  setInterval(() => undefined, 1000);
} else if (text.includes("DOUBLE:CRASH")) {
  fail(3, "simulated crash");
} else if (text.includes("DOUBLE:NOOUTPUT")) {
  process.exit(0);
} else {
  const output = path.join(outdir, path.basename(input).replace(/\.[a-z]+$/, ".pdf"));
  if (text.includes("DOUBLE:BADPDF")) {
    writeFileSync(output, "this is not a pdf");
    process.exit(0);
  }
  const pages = Number(/DOUBLE:PAGES=(\d{1,3})/.exec(text)?.[1] ?? 3);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Converted by test double from ${path.basename(input)}, page ${i} of ${pages}`, { x: 50, y: 780, size: 14, font });
  }
  writeFileSync(output, await doc.save());
  process.exit(0);
}
