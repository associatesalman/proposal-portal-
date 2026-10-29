// Phase 4 browser checks: the "Manage Document" dialog in real (headless) Chrome
// against a running app + LOCAL Supabase.
//
//   npm run build && npx next start -p 3100
//   CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" \
//     APP_URL=http://localhost:3100 npm run test:pdf-browser -- <screenshot-dir>
//
// A disposable team lead signs in through the login form, uploads PDFs with
// the real file input, saves the offer, generates and copies a link, opens
// it, and revokes it. Fixtures and users are removed afterwards.

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";

import { launchBrowser, ready } from "./lib/browser.mjs";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH;
const OUT = process.argv[2];
if (!CHROME || !OUT) {
  console.error("Usage: CHROME_PATH=... node phase4-browser.mjs <screenshot-dir>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const status = JSON.parse(
  execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString(),
);
for (const url of [status.API_URL, APP_URL]) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`non-local host ${host}`);
}
const trusted = createClient(status.API_URL, status.SECRET_KEY ?? status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const runId = randomBytes(3).toString("hex");
const userIds = [];
const results = [];
function check(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}${!passed && detail ? ` — ${detail}` : ""}`);
}

async function provision(label, role) {
  const email = `p4ui-${label}-${runId}@test.local`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await trusted.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user.id);
  const fullName = `UI4 ${label} ${runId}`;
  await trusted.from("profiles").insert({ id: data.user.id, full_name: fullName, role });
  return { id: data.user.id, email, password, fullName };
}

async function writePdf(name, pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  const path = join(OUT, name);
  writeFileSync(path, await doc.save());
  return path;
}

const dialog = "document.querySelector('dialog[open]')";
const dialogText = `(${dialog}?.innerText ?? '')`;

async function main(b) {
  const lead = await provision("lead", "team_lead");
  const { data: client } = await trusted
    .from("clients")
    .insert({ owner_id: lead.id, name: `UI Client ${runId}`, email: `ui-${runId}@client.test` })
    .select("id")
    .single();
  const title = `UI Proposal ${runId}`;
  await trusted.from("proposals").insert({ client_id: client.id, owner_id: lead.id, title });

  const notPdf = join(OUT, "not-a-pdf.pdf");
  writeFileSync(notPdf, "Just text pretending to be a PDF");
  const sixPages = await writePdf("six-pages.pdf", 6);

  // Login through the form.
  await b.navigate("/login");
  await b.waitFor(ready("[data-password-toggle]"), 15000);
  await b.typeInto("input[name=email]", lead.email);
  await b.typeInto("input[name=password]", lead.password);
  await b.key("Enter", "Enter", 13);
  check("lead signs in", await b.waitFor("location.pathname === '/dashboard'", 15000));

  await b.navigate("/dashboard?tab=proposals");
  const manage = `button[aria-label="Manage Document and link for ${title}"]`;
  await b.waitFor(ready(manage), 15000);
  await b.clickSelector(manage);
  check("Manage Document opens a modal dialog", await b.waitFor(`!!${dialog}`));
  check("dialog loads the draft (no PDF yet)", await b.waitFor(`${dialogText}.includes('No document uploaded yet.')`, 10000));
  check(
    "offer and link steps are disabled until a PDF exists",
    await b.evaluate(`(() => {
      const d = ${dialog};
      const gen = [...d.querySelectorAll('button')].find((x) => x.textContent.includes('Generate private link'));
      return d.querySelector('fieldset:not([data-access-mode])').disabled && gen.disabled;
    })()`),
  );
  await b.screenshot("p4-01-dialog-empty");

  // A file that isn't really a PDF -> inline server error. (One-page
  // documents are allowed now: they can be shared with Full Access.)
  await b.setFile("dialog[open] input[type=file]", notPdf);
  await b.clickText("button", "Upload document", dialog);
  check(
    "a non-PDF file named .pdf shows an inline error",
    await b.waitFor(`${dialogText}.includes("isn't a PDF")`, 20000),
  );
  check(
    "file input is marked invalid and described by the error",
    await b.evaluate(`(() => {
      const input = ${dialog}.querySelector('input[type=file]');
      const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
      return input.getAttribute('aria-invalid') === 'true' && ids.some((id) => document.getElementById(id)?.textContent.includes("isn't a PDF"));
    })()`),
  );
  await b.screenshot("p4-02-not-pdf-error");

  // Valid upload.
  await b.setFile("dialog[open] input[type=file]", sixPages);
  await b.clickText("button", "Upload document", dialog);
  check(
    "pending state is shown while uploading/checking",
    await b.waitFor(`${dialogText}.includes('Uploading to private storage') || ${dialogText}.includes('Checking the file')`, 5000),
  );
  check("valid PDF is verified (6 pages)", await b.waitFor(`${dialogText}.includes('PDF verified: 6 pages.')`, 20000));
  check(
    "file name, size and verified page count are shown",
    // Phase 6 layout: "<file name>" then "<size> · <n> pages" and a Verified badge.
    await b.evaluate(`${dialogText}.includes('six-pages.pdf') && /\\d+(\\.\\d+)? (B|KB|MB) · 6 pages/.test(${dialogText}) && ${dialogText}.includes('Verified')`),
  );
  await b.screenshot("p4-03-uploaded");

  // Offer: missing currency -> field error; then valid.
  await b.typeInto(`dialog[open] input[type=number]`, "2");
  await b.typeInto(`dialog[open] input[inputmode=decimal]`, "19.99");
  await b.clickText("button", "Save offer and generate preview", dialog);
  check("missing currency shows a field error", await b.waitFor(`${dialogText}.includes('Select a currency.')`, 10000));
  await b.evaluate(`(() => {
    const select = ${dialog}.querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'USD');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await b.typeInto(`dialog[open] input[type=number]`, "6");
  await b.clickText("button", "Save offer and generate preview", dialog);
  check(
    "free pages = total pages is rejected with an explanation",
    await b.waitFor(`${dialogText}.includes('must stay locked')`, 10000),
  );
  await b.typeInto(`dialog[open] input[type=number]`, "2");
  await b.clickText("button", "Save offer and generate preview", dialog);
  check("offer saves and the preview is generated", await b.waitFor(`${dialogText}.includes('Offer saved.')`, 20000));
  check("offer summary shows pages and formatted price", await b.evaluate(`${dialogText}.includes('Free: pages 1–2') && ${dialogText}.includes('Locked: pages 3–6') && ${dialogText}.includes('US$19.99')`));
  await b.screenshot("p4-04-offer-saved");

  // Generate and copy the link.
  await b.send("Browser.grantPermissions", {
    origin: new URL(APP_URL).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch(() => {});
  await b.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await b.clickText("button", "Generate private link", dialog);
  check("link is generated and shown once", await b.waitFor(`!!${dialog}.querySelector('input[readonly]')?.value.includes('/p/')`, 15000));
  check("local-only warning is shown for a localhost link", await b.evaluate(`${dialogText}.includes('Local-only link')`));
  const url = await b.evaluate(`${dialog}.querySelector('input[readonly]').value`);
  await b.clickText("button", "Copy link", dialog);
  const copied = await b.waitFor(`${dialogText}.includes('Link copied to the clipboard.')`, 5000);
  const clipboard = copied ? await b.evaluate("navigator.clipboard.readText().catch(() => '')") : "";
  check("Copy puts the link on the clipboard", copied && clipboard === url, `copied=${copied}`);
  check("PDF and offer controls lock while the link is active", await b.evaluate(`${dialog}.querySelector('input[type=file]').disabled && ${dialog}.querySelector('fieldset:not([data-access-mode])').disabled`));
  await b.screenshot("p4-05-link-generated");

  // Escape closes, focus returns, list shows Active / Preview ready.
  await b.key("Escape", "Escape", 27);
  check("Escape closes the dialog", await b.waitFor(`!${dialog}`));
  check("focus returns to the Manage Document button", await b.evaluate(`document.activeElement?.matches(${JSON.stringify(manage)})`));
  check(
    "list shows Active status and Preview ready",
    await b.waitFor(`(() => {
      const row = [...document.querySelectorAll('tr')].find((r) => r.innerText.includes(${JSON.stringify(title)}));
      return !!row && row.innerText.includes('Active') && row.innerText.includes('Preview ready');
    })()`, 10000),
  );
  await b.screenshot("p4-06-list-active");

  // Reopening never shows the raw link again.
  await b.clickSelector(manage);
  await b.waitFor(`${dialogText}.includes('Link active since')`, 10000);
  check("reopened dialog doesn't show the raw link", !(await b.evaluate(`${dialogText}.includes(${JSON.stringify(url)}) || !!${dialog}.querySelector('input[readonly]')`)));
  await b.key("Escape", "Escape", 27);
  await b.waitFor(`!${dialog}`);

  // The link destination.
  const linkPath = new URL(url).pathname;
  await b.navigate(linkPath);
  check(
    "link destination shows the title and the client preview page (Phase 5)",
    await b.waitFor(`document.body.innerText.includes(${JSON.stringify(title)}) && document.body.innerText.includes('Free preview:')`, 10000) &&
      !(await b.evaluate(`document.body.innerText.includes('ui-${runId}@client.test')`)),
  );
  await b.screenshot("p4-07-link-page");

  // Revoke.
  await b.navigate("/dashboard?tab=proposals");
  await b.waitFor(ready(manage), 15000);
  await b.clickSelector(manage);
  await b.waitFor(`${dialogText}.includes('Link active since')`, 10000);
  await b.clickText("button", "Revoke link…", dialog);
  check("revoking asks for confirmation", await b.waitFor(`${dialogText}.includes('Revoking stops this link immediately')`));
  await b.screenshot("p4-08-revoke-confirm");
  await b.clickText("button", "Revoke link", `${dialog}.querySelector('[data-revoke-confirm]')`);
  check("link is revoked and the proposal is a draft again", await b.waitFor(`${dialogText}.includes('Link revoked.')`, 15000));
  check("controls unlock after revoking", await b.evaluate(`!${dialog}.querySelector('input[type=file]').disabled`));
  await b.key("Escape", "Escape", 27);
  await b.navigate(linkPath);
  check("revoked link shows the unavailable page", await b.waitFor(`document.body.innerText.includes("This link isn’t available") || document.body.innerText.includes("This link isn't available")`, 10000));
  await b.screenshot("p4-09-link-revoked");

  // Mobile layout of the dialog.
  await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await b.navigate("/dashboard?tab=proposals");
  await b.waitFor(ready(manage), 15000);
  await b.clickSelector(manage);
  await b.waitFor(`${dialogText}.includes('PDF document')`, 10000);
  check(
    "mobile: dialog fits the viewport width and scrolls vertically",
    await b.evaluate(`(() => {
      const d = ${dialog};
      const r = d.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth && d.scrollHeight >= d.clientHeight;
    })()`),
  );
  await b.screenshot("p4-10-mobile-dialog");
  await b.send("Emulation.clearDeviceMetricsOverride");
}

let fatal = null;
let browser = null;
try {
  browser = await launchBrowser({ chromePath: CHROME, outDir: OUT, appUrl: APP_URL });
  await main(browser);
} catch (error) {
  fatal = error;
} finally {
  if (browser) await browser.close();
  for (const id of userIds) {
    const { data: folders } = await trusted.storage.from("proposals").list(id);
    for (const folder of folders ?? []) {
      const { data: revisions } = await trusted.storage.from("proposals").list(`${id}/${folder.name}`);
      for (const revision of revisions ?? []) {
        const prefix = `${id}/${folder.name}/${revision.name}`;
        const { data: files } = await trusted.storage.from("proposals").list(prefix);
        await trusted.storage.from("proposals").remove((files ?? []).map((f) => `${prefix}/${f.name}`));
      }
    }
    await trusted.from("proposals").delete().eq("owner_id", id);
    await trusted.from("clients").delete().eq("owner_id", id);
    await trusted.from("profiles").delete().eq("id", id);
    await trusted.auth.admin.deleteUser(id);
  }
}

if (browser?.log.length) console.log(`\nBrowser console (${browser.log.length}):\n  ${browser.log.slice(0, 15).join("\n  ")}`);
if (fatal) {
  console.error(`\nAborted: ${fatal.stack ?? fatal.message}`);
  process.exit(1);
}
const failed = results.filter((passed) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
