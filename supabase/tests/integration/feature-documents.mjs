// Document uploads, formats and preview links (manual Full Access removed).
//
//   npm run build
//   npm run test:documents                   # HTTP checks
//   CHROME_PATH="..." npm run test:documents  # + headless Chrome checks
//
// Two DEDICATED app servers are started from the current build (the running
// dev server, if any, is not touched):
//   FULL_PORT (3104)   converter = the TEST DOUBLE in lib/libreoffice-double.mjs
//                      (LIBREOFFICE_TEST_DOUBLE), conversion timeout 4 s
//   PLAIN_PORT (3105)  no converter configured (DOCX/DOC/ODT/RTF disabled)
// The double does NOT render documents: it checks how the adapter starts it
// (flags, isolated workspace and profile, no secrets in the environment)
// and writes a PDF with a requested page count, or hangs/crashes/produces
// nothing on request. Real LibreOffice rendering is NOT verified here.
//
// Also checks that manual Full Access is gone: every link is a preview link,
// /p/<token>/document, /download and /original no longer exist, and Full
// Access fields sent to the link action are ignored.
//
// Requests are sent with a TEST-NET client address (x-forwarded-for), so
// the rate-limit counters of 127.0.0.1 used by other suites aren't touched.
// Everything is created by disposable users (lib/portal.mjs) and removed
// again; existing accounts, proposals and files are snapshotted and must be
// unchanged. No payment is ever created.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  externalImageRel,
  hyperlinkRel,
  includePictureField,
  makeDoc,
  makeDocx,
  makeEncryptedOoxml,
  makeOdt,
  makeRtf,
  makeZip,
  makeZipBombDocx,
} from "./lib/documents.mjs";

const FULL_PORT = Number(process.env.FULL_PORT ?? 3104);
const PLAIN_PORT = Number(process.env.PLAIN_PORT ?? 3105);
const FULL_URL = `http://localhost:${FULL_PORT}`;
const PLAIN_URL = `http://localhost:${PLAIN_PORT}`;
process.env.APP_URL = FULL_URL;

const { createHarness, BUCKET } = await import("./lib/portal.mjs");
const h = createHarness("fa");
const { trusted, anon, check, provisionUser, act, createDraft, objectsUnder, runId } = h;

const require = createRequire(`${process.cwd()}/package.json`);
const { encodeReply } = require("next/dist/compiled/react-server-dom-turbopack/client.edge.js");
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

const OUT = join(process.env.TEMP ?? tmpdir(), `portal-documents-${process.pid}`);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOUBLE = resolve("supabase/tests/integration/lib/libreoffice-double.mjs");
const CLIENT_IP = "198.51.100.23";

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  txt: "text/plain",
};

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------
const servers = [];
async function startServer(port, extraEnv) {
  const log = createWriteStream(join(OUT, `server-${port}.log`));
  const env = { ...process.env };
  delete env.LIBREOFFICE_PATH;
  delete env.LIBREOFFICE_TEST_DOUBLE;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: {
      ...env,
      NODE_ENV: "production",
      RATE_LIMIT_ENABLED: "true",
      RATE_LIMIT_LINK_PAGE_IP: "2000/60",
      RATE_LIMIT_LINK_PREVIEW_IP: "2000/60",
      RATE_LIMIT_LINK_MISS_IP: "2000/60",
      RATE_LIMIT_UPLOAD_PREPARE_USER: "2000/60",
      RATE_LIMIT_UPLOAD_COMPLETE_USER: "2000/60",
      RATE_LIMIT_PREVIEW_GENERATE_USER: "2000/60",
      RATE_LIMIT_PROPOSAL_DELETE_USER: "2000/60",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  servers.push(child);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/login`)).status === 200) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`app server on ${port} did not start`);
}
function stopServers() {
  for (const child of servers) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function makePdf(pages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    doc.addPage([595, 842]).drawText(`${label} page ${i} of ${pages}`, { x: 50, y: 780, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

async function pageCount(bytes) {
  return (await PDFDocument.load(bytes)).getPageCount();
}

async function pdfText(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await task.promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push(content.items.map((item) => item.str).join(" "));
  }
  await task.destroy();
  return parts.join("\n");
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function get(base, path, extra = {}) {
  return fetch(`${base}${path}`, { headers: { "x-forwarded-for": CLIENT_IP, ...extra }, redirect: "manual" });
}

async function fetchBytes(base, path) {
  const res = await get(base, path);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

// Dashboard flow: ticket -> direct upload -> verify/convert.
async function upload(user, proposalId, bytes, { format = "pdf", fileName, expectedRevision = null, base = FULL_URL, declaredFormat } = {}) {
  const claim = declaredFormat ?? format;
  const ticket = await act(user, "prepareUploadAction", { proposalId, sizeBytes: bytes.length, format: claim }, base);
  if (!ticket.ok) return { ...ticket, stage: "prepare" };
  const { error } = await anon.storage
    .from(BUCKET)
    .uploadToSignedUrl(ticket.data.path, ticket.data.token, new Blob([bytes], { type: ticket.data.contentType }), {
      contentType: ticket.data.contentType,
    });
  if (error) return { ok: false, stage: "storage", message: error.message };
  const done = await act(
    user,
    "completeUploadAction",
    { proposalId, revision: ticket.data.revision, expectedRevision, fileName: fileName ?? `upload.${claim}`, format: claim },
    base,
  );
  return { ...done, stage: "complete", ticket: ticket.data };
}

async function row(id) {
  const { data } = await trusted
    .from("proposals")
    .select("id, owner_id, status, access_mode, original_storage_path, preview_storage_path, source_storage_path, source_format, source_size_bytes, total_pages, free_preview_pages, original_file_name")
    .eq("id", id)
    .single();
  return data;
}

function tokenOf(link) {
  return new URL(link.data.url).pathname.split("/").pop();
}

async function storedBytes(path) {
  const { data } = await trusted.storage.from(BUCKET).download(path);
  return Buffer.from(await data.arrayBuffer());
}

function convertDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("proposal-convert-")).sort();
}

function strayDoubles() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*libreoffice-double*' }).Count"],
        { encoding: "utf8" },
      );
      return Number(out.trim());
    }
    return execFileSync("sh", ["-c", "pgrep -fc libreoffice-double || true"], { encoding: "utf8" }).trim() === "0" ? 0 : 1;
  } catch {
    return -1;
  }
}

const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const dashboardActionIds = Object.fromEntries(
  Object.entries(manifest)
    .filter(([, v]) => v.filename?.endsWith("dashboard/actions.ts"))
    .map(([id, v]) => [v.exportedName, id]),
);
function parseFlight(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+):([[{].*)$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  const head = JSON.parse(rows.get("0") ?? "{}");
  const ref = typeof head.a === "string" && head.a.startsWith("$@") ? head.a.slice(2) : null;
  return ref ? JSON.parse(rows.get(ref)) : head.a;
}
async function formAct(user, name, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${FULL_URL}/dashboard`, {
    method: "POST",
    headers: { cookie: user.cookie, "next-action": dashboardActionIds[name], accept: "text/x-component", origin: FULL_URL },
    body: await encodeReply([{ status: "idle" }, form]),
    redirect: "manual",
  });
  return parseFlight(await res.text());
}

// What a visitor reads (scripts and markup removed).
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

// Public responses must never carry internal identities or paths.
function leaksInternals(text, { leads, proposal }) {
  const needles = [
    ...leads.flatMap((lead) => [lead.fullName, lead.email, lead.id]),
    proposal.id,
    proposal.owner_id,
    "storage_path",
    "original.pdf",
    "source.",
  ];
  return needles.filter((needle) => needle && text.includes(needle));
}

// Routes that served the whole document before manual Full Access was
// removed (20261103090000). They must not exist for any token.
const REMOVED_ROUTES = ["document", "download", "original"];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
async function main() {
  await startServer(FULL_PORT, {
    LIBREOFFICE_TEST_DOUBLE: DOUBLE,
    DOCUMENT_CONVERSION_TIMEOUT_MS: "4000",
  });
  await startServer(PLAIN_PORT, {});

  const leadA = await provisionUser("lead-a", "team_lead");
  const leadB = await provisionUser("lead-b", "team_lead");
  const admin = await provisionUser("admin", "admin");
  const leads = [leadA, leadB, admin];
  const paymentsBefore = (await trusted.from("payments").select("id", { count: "exact", head: true })).count;

  // 1. Preview link on a 15-page document (12 free, 3 locked) -----------------------
  const title = `Fifteen ${runId}`;
  const draft = await createDraft(leadA, title);
  const pdf15 = await makePdf(15, "Fifteen");
  const up15 = await upload(leadA, draft.id, pdf15, { fileName: "fifteen.pdf" });
  check("15-page PDF uploads and verifies", up15.ok && up15.data.document.totalPages === 15, up15.message);
  check("the setup has no access mode or manual grant any more", up15.ok && !("accessMode" in up15.data) && !("fullAccess" in up15.data));
  const offer = await act(leadA, "saveOfferAction", {
    proposalId: draft.id,
    expectedRevision: up15.data.document.revision,
    freePages: "12",
    price: "49.99",
    currency: "USD",
  });
  check("offer saved: 12 free pages, 3 locked", offer.ok && offer.data.preview.pages === 12, offer.message);
  const previewLink = await act(leadA, "generateLinkAction", { proposalId: draft.id, expectedPreviewRevision: offer.data.preview.revision });
  check("preview link generated", previewLink.ok, previewLink.message);
  const T1 = tokenOf(previewLink);
  const before = await row(draft.id);
  check("the proposal is in preview mode", before.access_mode === "preview");

  {
    const html = await (await get(FULL_URL, `/p/${T1}`)).text();
    const page = visibleText(html);
    check("preview page: 12 of 15 pages free, 3 locked", page.includes("Free preview: 12 of 15 pages") && page.includes("3 pages are locked"), page.slice(0, 400));
    check("preview page has no download controls", !page.includes("Download PDF") && !html.includes("data-downloads"));
    check("preview page names no Team Lead, ids or paths", leaksInternals(html, { leads, proposal: before }).length === 0, leaksInternals(html, { leads, proposal: before }).join(","));
    const { res, bytes } = await fetchBytes(FULL_URL, `/p/${T1}/preview`);
    check("preview token serves only the 12-page preview", res.status === 200 && (await pageCount(bytes)) === 12);
    const previewText = await pdfText(bytes);
    check("the preview PDF contains no locked page", previewText.includes("Fifteen page 12 of 15") && !previewText.includes("Fifteen page 13 of 15"));
    for (const kind of REMOVED_ROUTES) {
      const r = await get(FULL_URL, `/p/${T1}/${kind}`);
      const ct = r.headers.get("content-type") ?? "";
      check(`removed route /p/<token>/${kind} serves no file (404)`, r.status === 404 && !ct.includes("pdf"), `${r.status} ${ct}`);
    }
    const forged = await fetchBytes(FULL_URL, `/p/${T1}/preview?mode=full&access=full&pages=15`);
    check("forged query parameters don't change the preview", forged.res.status === 200 && (await pageCount(forged.bytes)) === 12);
    const forgedPage = await (await get(FULL_URL, `/p/${T1}?mode=full&access=full`)).text();
    check("forged page parameters still show the preview", visibleText(forgedPage).includes("Free preview: 12 of 15 pages") && !forgedPage.includes("data-full-access-view"));
  }

  const revoked = await act(leadA, "revokeLinkAction", { proposalId: draft.id });
  check("link revoked", revoked.ok, revoked.message);
  check("revoked preview link is unavailable", (await (await get(FULL_URL, `/p/${T1}`)).text()).includes("This link isn"));

  // A Full Access request is now just an ignored field: the next link is
  // still a preview link on the same stored document.
  const relink = await act(leadA, "generateLinkAction", {
    proposalId: draft.id,
    expectedPreviewRevision: offer.data.preview.revision,
    expectedRevision: up15.data.document.revision,
    note: "paid by bank transfer",
    mode: "full",
  });
  check("a new link is a preview link even when Full Access fields are sent", relink.ok && /Private link created/.test(relink.message), relink.message);
  const T2 = tokenOf(relink);
  const afterRelink = await row(draft.id);
  check("no re-upload: same document revision", afterRelink.original_storage_path === before.original_storage_path && afterRelink.access_mode === "preview");
  {
    const page = visibleText(await (await get(FULL_URL, `/p/${T2}`)).text());
    check("the new link shows only the 12-page preview and the price", page.includes("Free preview: 12 of 15 pages") && page.includes("3 pages are locked"));
    for (const kind of ["", "/preview"]) {
      const r = await get(FULL_URL, `/p/${T1}${kind}`);
      const ok = kind === "" ? (await r.text()).includes("This link isn") : r.status === 404;
      check(`old token stays invalid: /p/<old>${kind}`, ok);
    }
    const { error: fullRpc } = await anon.rpc("resolve_proposal_full_access", { p_token: T2 });
    check("the Full Access resolver no longer exists", Boolean(fullRpc));
    const { count } = await trusted.from("proposal_full_access_grants").select("id", { count: "exact", head: true }).eq("proposal_id", draft.id);
    check("no grant record is created", count === 0);
    const history = await (await fetch(`${FULL_URL}/dashboard?tab=history&q=${runId}`, { headers: { cookie: leadA.cookie } })).text();
    check("History has no Access column or manual-access label", !history.includes("Manual full access") && !history.includes(">Full Access<"));
  }

  // 2. Authorization: cross-lead denial, CEO access -----------------------------------
  {
    const denied = await Promise.all([
      act(leadB, "loadProposalSetupAction", draft.id),
      act(leadB, "revokeLinkAction", { proposalId: draft.id }),
      act(leadB, "generateLinkAction", { proposalId: draft.id, expectedPreviewRevision: offer.data.preview.revision }),
      act(leadB, "prepareUploadAction", { proposalId: draft.id, sizeBytes: 1000, format: "pdf" }),
    ]);
    check("another Team Lead is refused every document action", denied.every((r) => !r.ok && /could not be found/.test(r.message)), denied.map((r) => r.message).join(" | "));
    check("…and nothing changed", (await row(draft.id)).status === "active");

    const ceoView = await act(admin, "loadProposalSetupAction", draft.id);
    check("the CEO can manage the lead's proposal", ceoView.ok && ceoView.data.link !== null);
    const ceoRevoke = await act(admin, "revokeLinkAction", { proposalId: draft.id });
    const ceoLink = await act(admin, "generateLinkAction", { proposalId: draft.id, expectedPreviewRevision: offer.data.preview.revision });
    check("the CEO revokes and re-issues the preview link", ceoRevoke.ok && ceoLink.ok, `${ceoRevoke.message} ${ceoLink.message}`);
    const T3 = tokenOf(ceoLink);
    check("the CEO's new link works; the lead's link stopped", (await get(FULL_URL, `/p/${T3}/preview`)).status === 200 && (await get(FULL_URL, `/p/${T2}/preview`)).status === 404);
    const html = await (await get(FULL_URL, `/p/${T3}`)).text();
    check("public page never shows the CEO either", leaksInternals(html, { leads, proposal: before }).length === 0);
    check("an active link's document can't be replaced", !(await upload(leadA, draft.id, await makePdf(3, "x"), { expectedRevision: up15.data.document.revision })).ok);
    await act(admin, "revokeLinkAction", { proposalId: draft.id });
  }

  // 3. One-page documents: accepted, but no link -------------------------------------------
  {
    const one = await createDraft(leadA, `One page ${runId}`);
    const up = await upload(leadA, one.id, await makePdf(1, "Single"), { fileName: "single.pdf" });
    check("a one-page PDF is accepted with an explanation", up.ok && up.data.document.totalPages === 1 && /can't get a link/.test(up.message) && !/Full Access/.test(up.message), up.message);
    const offer1 = await act(leadA, "saveOfferAction", { proposalId: one.id, expectedRevision: up.data.document.revision, freePages: "1", price: "10", currency: "USD" });
    check("a one-page document can't get a locked preview", !offer1.ok);
    const linkTry = await act(leadA, "generateLinkAction", { proposalId: one.id, expectedPreviewRevision: randomUUID(), expectedRevision: up.data.document.revision });
    check("…nor any link", !linkTry.ok && (await row(one.id)).status === "draft");
  }

  // 4. Multi-format conversion (server with the converter double) ------------------------
  const tmpBefore = convertDirs();
  const formats = [
    ["docx", makeDocx({ marker: "DOUBLE:PAGES=4" }), 4],
    ["doc", makeDoc({ marker: "DOUBLE:PAGES=5" }), 5],
    ["odt", makeOdt({ marker: "DOUBLE:PAGES=2" }), 2],
    ["rtf", makeRtf({ marker: "DOUBLE:PAGES=3" }), 3],
  ];
  let converted = null;
  for (const [format, bytes, pages] of formats) {
    const d = await createDraft(leadA, `${format.toUpperCase()} ${runId}`);
    const up = await upload(leadA, d.id, bytes, { format, fileName: `Proposal.${format}` });
    check(`${format.toUpperCase()} converts to a ${pages}-page canonical PDF`, up.ok && up.data.document.totalPages === pages && up.data.document.sourceFormat === format && new RegExp(`${format.toUpperCase()} converted to PDF`).test(up.message), up.message);
    if (!up.ok) continue;
    const r = await row(d.id);
    const objects = await objectsUnder(`${leadA.id}/${d.id}`);
    const revision = up.data.document.revision;
    check(`${format.toUpperCase()}: source and canonical PDF stored privately in one revision`, r.source_format === format && r.source_storage_path.endsWith(`/${revision}/source.${format}`) && r.original_storage_path.endsWith(`/${revision}/original.pdf`) && objects.length === 2);
    check(`${format.toUpperCase()}: stored source is byte-identical to the upload`, sha(await storedBytes(r.source_storage_path)) === sha(bytes));
    const text = await pdfText(await storedBytes(r.original_storage_path));
    check(`${format.toUpperCase()}: canonical PDF came from the converter (test double)`, text.includes(`Converted by test double from source.${format}`));
    const offerF = await act(leadA, "saveOfferAction", { proposalId: d.id, expectedRevision: revision, freePages: "1", price: "15", currency: "GBP" });
    const link = await act(leadA, "generateLinkAction", { proposalId: d.id, expectedPreviewRevision: offerF.data?.preview?.revision });
    const token = tokenOf(link);
    const preview = await fetchBytes(FULL_URL, `/p/${token}/preview`);
    check(`${format.toUpperCase()}: preview link serves only the first page of the converted PDF`, offerF.ok && link.ok && preview.res.status === 200 && (await pageCount(preview.bytes)) === 1);
    for (const kind of REMOVED_ROUTES) {
      const res = await get(FULL_URL, `/p/${token}/${kind}`);
      check(`${format.toUpperCase()}: /${kind} serves neither the source nor the PDF (404)`, res.status === 404 && !(res.headers.get("content-type") ?? "").includes(MIME[format]));
    }
    const html = await (await get(FULL_URL, `/p/${token}`)).text();
    check(`${format.toUpperCase()}: client page offers no download`, !html.includes("Download original") && !html.includes("Download PDF"));
    converted ??= { id: d.id, token, revision, bytes, format };
  }

  // TXT: converted natively (no converter involved).
  {
    const d = await createDraft(leadA, `TXT ${runId}`);
    const lines = Array.from({ length: 130 }, (_, i) => `Line ${i + 1}\tof the plain-text proposal ${runId} — café`);
    const txt = Buffer.from(lines.join("\r\n"), "utf8");
    const up = await upload(leadA, d.id, txt, { format: "txt", fileName: "notes.txt", base: PLAIN_URL });
    check("TXT converts natively (no converter on this server)", up.ok && up.data.document.sourceFormat === "txt" && up.data.document.totalPages === 3, up.message);
    const r = await row(d.id);
    const text = await pdfText(await storedBytes(r.original_storage_path));
    check("TXT: the PDF has selectable text, tabs and accents preserved", text.includes(`Line 130`) && text.includes("café") && !text.includes("Converted by test double"));
    const preview = await act(leadA, "saveOfferAction", { proposalId: d.id, expectedRevision: up.data.document.revision, freePages: "1", price: "5", currency: "EUR" }, PLAIN_URL);
    const link = await act(leadA, "generateLinkAction", { proposalId: d.id, expectedPreviewRevision: preview.data?.preview?.revision }, PLAIN_URL);
    const token = tokenOf(link);
    check("converted documents work as preview links", preview.ok && link.ok && (await pageCount((await fetchBytes(FULL_URL, `/p/${token}/preview`)).bytes)) === 1);
    check("a preview token can't download the original source (404)", (await get(FULL_URL, `/p/${token}/original`)).status === 404);
  }

  // Replacing a converted revision removes its superseded files.
  if (converted) {
    await act(leadA, "revokeLinkAction", { proposalId: converted.id });
    const up = await upload(leadA, converted.id, await makePdf(2, "Replacement"), { expectedRevision: converted.revision });
    const objects = await objectsUnder(`${leadA.id}/${converted.id}`);
    check("replacing a converted document removes the old source, PDF and preview", up.ok && objects.length === 1 && objects[0].endsWith(`/${up.data.document.revision}/original.pdf`), objects.join(","));
    check("…and the row no longer has a source", (await row(converted.id)).source_storage_path === null);
  }

  // 5. Unsafe and failing uploads keep the existing document -------------------------------
  {
    const d = await createDraft(leadA, `Rejects ${runId}`);
    const base = await upload(leadA, d.id, await makePdf(3, "Valid"), { fileName: "valid.pdf" });
    const baseRow = await row(d.id);
    const baseObjects = await objectsUnder(`${leadA.id}/${d.id}`);
    const cases = [
      ["DOCX with a VBA project", "docx", makeDocx({ extraEntries: [{ name: "word/vbaProject.bin", data: "x" }] }), /macros/],
      ["macro-enabled content type disguised as DOCX", "docx", makeDocx({ contentType: "application/vnd.ms-word.document.macroEnabled.main+xml" }), /macros/],
      ["DOCX with an external image", "docx", makeDocx({ documentRels: [externalImageRel] }), /external/],
      ["DOCX with an INCLUDEPICTURE field", "docx", makeDocx({ bodyXml: includePictureField }), /external/],
      ["DOCX zip bomb", "docx", makeZipBombDocx(), /unusually large/],
      ["password-protected DOCX", "docx", makeEncryptedOoxml(), /password-protected or encrypted/],
      ["encrypted DOC", "doc", makeDoc({ encrypted: true }), /password-protected or encrypted/],
      ["DOC with macros", "doc", makeDoc({ macros: true }), /macros/],
      ["ODT with Basic macros", "odt", makeOdt({ extraEntries: [{ name: "Basic/Standard/Module1.xml", data: "<x/>" }] }), /macros/],
      ["ODT with a linked external image", "odt", makeOdt({ bodyXml: '<draw:frame><draw:image xlink:href="https://attacker.example/x.png"/></draw:frame>' }), /external/],
      ["ODT spreadsheet named .odt", "odt", makeOdt({ mimetype: "application/vnd.oasis.opendocument.spreadsheet" }), /isn't supported/],
      ["RTF with an embedded OLE object", "rtf", makeRtf({ extra: "{\\object\\objemb{\\*\\objdata 0102}}" }), /external/],
      ["RTF with an INCLUDETEXT field", "rtf", makeRtf({ extra: '{\\field{\\*\\fldinst INCLUDETEXT "C:\\\\secret.txt"}}' }), /external/],
      ["PDF renamed to .docx", "docx", await makePdf(2, "Renamed"), /contents are PDF, not DOCX/],
      ["executable renamed to .docx", "docx", Buffer.concat([Buffer.from("MZ\u0090\u0000\u0003\u0000"), Buffer.alloc(200)]), /isn't supported/],
      ["ZIP archive renamed to .docx", "docx", makeZip([{ name: "readme.txt", data: "hi" }]), /isn't supported/],
      ["executable renamed to .pdf", "pdf", Buffer.concat([Buffer.from("MZ\u0090\u0000"), Buffer.alloc(200)]), /isn't a PDF/],
      ["converter hangs (timeout)", "docx", makeDocx({ marker: "DOUBLE:HANG" }), /took too long/],
      ["converter crashes", "docx", makeDocx({ marker: "DOUBLE:CRASH" }), /couldn't be converted/],
      ["converter writes no output", "docx", makeDocx({ marker: "DOUBLE:NOOUTPUT" }), /couldn't be converted/],
      ["converter writes an invalid PDF", "docx", makeDocx({ marker: "DOUBLE:BADPDF" }), /resulting PDF couldn't be read/],
    ];
    for (const [label, format, bytes, pattern] of cases) {
      const res = await upload(leadA, d.id, bytes, { format, expectedRevision: base.data.document.revision });
      check(`rejects ${label} with a clear message`, !res.ok && pattern.test(res.message ?? ""), res.message);
    }
    const afterRow = await row(d.id);
    const afterObjects = await objectsUnder(`${leadA.id}/${d.id}`);
    check("failed uploads leave the existing document untouched", afterRow.original_storage_path === baseRow.original_storage_path && afterRow.total_pages === 3 && afterRow.source_storage_path === null);
    check("failed uploads leave no orphaned files", JSON.stringify(afterObjects) === JSON.stringify(baseObjects), afterObjects.join(","));

    const hyperlinkOnly = await upload(leadA, d.id, makeDocx({ marker: "DOUBLE:PAGES=2", documentRels: [hyperlinkRel] }), { format: "docx", expectedRevision: base.data.document.revision });
    check("plain hyperlinks are allowed", hyperlinkOnly.ok, hyperlinkOnly.message);

    const docm = await act(leadA, "prepareUploadAction", { proposalId: d.id, sizeBytes: 100, format: "docm" });
    check("macro-enabled formats are refused before upload (docm)", !docm.ok && /PDF, DOCX, DOC, ODT, RTF or TXT/.test(docm.message), docm.message);
    const exe = await act(leadA, "prepareUploadAction", { proposalId: d.id, sizeBytes: 100, format: "exe" });
    check("executables are refused before upload", !exe.ok);

    await sleep(500);
    check("conversion workspaces are always removed (incl. timeout)", JSON.stringify(convertDirs()) === JSON.stringify(tmpBefore), convertDirs().join(","));
    const stray = strayDoubles();
    check("the timed-out converter process tree was killed", stray === 0, String(stray));
  }

  // 6. Server without a converter -----------------------------------------------------------
  {
    const d = await createDraft(leadA, `Plain ${runId}`);
    const setup = await act(leadA, "loadProposalSetupAction", d.id, PLAIN_URL);
    check(
      "without LibreOffice only PDF and TXT are enabled, with a reason",
      setup.ok && JSON.stringify(setup.data.upload.enabled) === JSON.stringify(["pdf", "txt"]) && JSON.stringify(setup.data.upload.unavailable) === JSON.stringify(["docx", "doc", "odt", "rtf"]) && /LibreOffice/.test(setup.data.upload.unavailableReason),
    );
    const fullSetup = await act(leadA, "loadProposalSetupAction", d.id);
    check("with the converter all six formats are enabled", fullSetup.ok && fullSetup.data.upload.enabled.length === 6 && fullSetup.data.upload.unavailable.length === 0);
    for (const format of ["docx", "doc", "odt", "rtf"]) {
      const res = await act(leadA, "prepareUploadAction", { proposalId: d.id, sizeBytes: 1000, format }, PLAIN_URL);
      check(`${format.toUpperCase()} is refused with a helpful message when conversion is unavailable`, !res.ok && /aren't available on this server/.test(res.message) && /LibreOffice/.test(res.message), res.message);
    }
    // A ticket from the converter server can't be completed on this one.
    const ticket = await act(leadA, "prepareUploadAction", { proposalId: d.id, sizeBytes: 500, format: "docx" });
    await anon.storage.from(BUCKET).uploadToSignedUrl(ticket.data.path, ticket.data.token, new Blob([makeDocx()], { type: MIME.docx }), { contentType: MIME.docx });
    const forced = await act(leadA, "completeUploadAction", { proposalId: d.id, revision: ticket.data.revision, expectedRevision: null, fileName: "x.docx", format: "docx" }, PLAIN_URL);
    check("the server re-checks availability on completion and discards the upload", !forced.ok && (await objectsUnder(`${leadA.id}/${d.id}`)).length === 0, forced.message);
    const cjk = await upload(leadA, d.id, Buffer.from("提案書 ✓ 🙂\n第二行", "utf8"), { format: "txt", base: PLAIN_URL });
    check("TXT the built-in font can't show is refused with a clear message", !cjk.ok && /need the document converter/.test(cjk.message), cjk.message);
    const cjkFull = await upload(leadA, d.id, Buffer.from("提案書 DOUBLE:PAGES=1\n第二行", "utf8"), { format: "txt" });
    check("…and falls back to the converter where one is configured", cjkFull.ok && cjkFull.data.document.totalPages === 1, cjkFull.message);
  }

  // 7. Deletion and cleanup safety for source, canonical and preview files --------------------
  {
    const d = await createDraft(leadA, `Delete ${runId}`);
    const up = await upload(leadA, d.id, makeDocx({ marker: "DOUBLE:PAGES=3" }), { format: "docx" });
    const offerDel = await act(leadA, "saveOfferAction", { proposalId: d.id, expectedRevision: up.data.document.revision, freePages: "1", price: "9", currency: "USD" });
    const r = await row(d.id);
    check("fixture: source, canonical PDF and preview stored", offerDel.ok && (await objectsUnder(`${leadA.id}/${d.id}`)).length === 3);
    const scan = await trusted.rpc("storage_cleanup_scan", { p_created_before: new Date(Date.now() + 86400000).toISOString(), p_prefix: `${leadA.id}/${d.id}/`, p_after: "", p_limit: 100 });
    check("cleanup treats the current source, PDF and preview as referenced", scan.data?.length === 3 && scan.data.every((s) => s.classification === "referenced"), JSON.stringify(scan.data?.map((s) => s.classification)));
    const { error: removeErr } = await leadA.client.storage.from(BUCKET).remove([r.source_storage_path]);
    check("the owner can't delete the source file in use", !removeErr && (await objectsUnder(`${leadA.id}/${d.id}`)).length === 3);
    const link = await act(leadA, "generateLinkAction", { proposalId: d.id, expectedPreviewRevision: offerDel.data.preview.revision });
    const token = tokenOf(link);
    const del = await formAct(leadA, "deleteProposalAction", { proposalId: d.id });
    check("deleting removes the source, canonical PDF and preview", del?.status === "success" && (await objectsUnder(`${leadA.id}/${d.id}`)).length === 0, JSON.stringify(del));
    check("…and its link stops working", (await get(FULL_URL, `/p/${token}/preview`)).status === 404);
  }

  const paymentsAfter = (await trusted.from("payments").select("id", { count: "exact", head: true })).count;
  check("no payment records were created anywhere", paymentsAfter === paymentsBefore);

  // 8. Browser (optional: CHROME_PATH) ---------------------------------------------------------
  if (process.env.CHROME_PATH) {
    await browserChecks({ leadA, title, draftId: draft.id, previewRevision: offer.data.preview.revision });
  } else {
    console.log("skip   browser checks (set CHROME_PATH to run them)");
  }
}

async function browserChecks({ leadA, title, draftId, previewRevision }) {
  const { launchBrowser } = await import("./lib/browser.mjs");
  const shots = join(OUT, "screens");
  mkdirSync(shots, { recursive: true });
  const link = await act(leadA, "generateLinkAction", { proposalId: draftId, expectedPreviewRevision: previewRevision });
  const token = tokenOf(link);
  const b = await launchBrowser({ chromePath: process.env.CHROME_PATH, outDir: shots, appUrl: FULL_URL });
  try {
    await b.send("Network.enable");
    await b.send("Network.setExtraHTTPHeaders", { headers: { "X-Forwarded-For": CLIENT_IP } });
    const noOverflow = () => b.evaluate("document.documentElement.scrollWidth <= innerWidth");
    const pageBox = () =>
      b.evaluate(`(() => { const c = document.querySelector('.pdf-page canvas'); const s = document.getElementById('preview-stage');
        if (!c || !s) return null; const cs = getComputedStyle(s);
        return { w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height, ratio: c.width / c.height,
          stageW: s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          stageH: s.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom), vh: innerHeight }; })()`);

    for (const [width, height, mobile, tag] of [[1440, 900, false, "desktop"], [390, 844, true, "mobile"]]) {
      await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await b.navigate(`/p/${token}`);
      check(`${tag}: preview page renders the free pages`, await b.waitFor(`!!document.querySelector('[data-rendered-page] canvas')`, 20000));
      check(`${tag}: page status shows 'Preview page 1 of 12'`, await b.waitFor(`document.querySelector('[data-page-status]').innerText.startsWith('Preview page 1 of 12')`, 5000));
      check(`${tag}: no download controls`, await b.evaluate(`!document.querySelector('[data-downloads]') && !document.body.innerText.includes('Download PDF')`));
      check(`${tag}: locked notice and price shown`, await b.evaluate(`!!document.querySelector('#unlock-heading') && !!document.querySelector('[data-price]')`));
      check(`${tag}: no horizontal scroll`, await noOverflow());
      const fit = await pageBox();
      check(`${tag}: fit width fills the stage without stretching`, fit && Math.abs(fit.w - fit.stageW) <= 2 && Math.abs(fit.w / fit.h - fit.ratio) < 0.02, JSON.stringify(fit));
      await b.screenshot(`doc-01-preview-${tag}`);

      await b.clickSelector('[aria-label="Fit page"]');
      await b.waitFor(`document.querySelector('[aria-label="Fit page"]').getAttribute('aria-pressed') === 'true' && !!document.querySelector('[data-rendered-page]')`, 5000);
      await sleep(400);
      const page = await pageBox();
      check(`${tag}: fit page keeps the whole page within the window`, page && page.h <= page.vh && page.w <= fit.w + 1 && Math.abs(page.w / page.h - page.ratio) < 0.02, JSON.stringify(page));

      await b.clickSelector('[aria-label="Next page"]');
      check(`${tag}: next page`, await b.waitFor(`document.querySelector('[data-page-status]').innerText.startsWith('Preview page 2 of 12') && document.querySelector('[data-rendered-page]')?.dataset.renderedPage === '2'`, 8000));

      await b.clickSelector("[data-fullscreen-toggle]");
      check(`${tag}: full screen toggle enters full screen (or the overlay fallback)`, await b.waitFor(`['native','fallback'].includes(document.querySelector('[data-viewer-state]').dataset.expanded)`, 5000));
      await sleep(600);
      const expanded = await b.evaluate(`(() => { const s = document.querySelector('[data-viewer-state]').getBoundingClientRect(); return { w: s.width, h: s.height, mode: document.querySelector('[data-viewer-state]').dataset.expanded }; })()`);
      check(`${tag}: the viewer fills the screen while expanded`, expanded.w >= width - 2 && expanded.h >= height - 2, JSON.stringify(expanded));
      check(`${tag}: page re-renders after the transition`, await b.waitFor(`!!document.querySelector('[data-rendered-page="2"] canvas') && document.querySelectorAll('.pdf-page canvas').length === 1`, 8000));
      check(`${tag}: exit control is labelled`, await b.evaluate(`document.querySelector('[data-fullscreen-toggle]').getAttribute('aria-label') === 'Exit full screen' && document.querySelector('[data-fullscreen-toggle]').getAttribute('aria-pressed') === 'true'`));
      await b.screenshot(`doc-02-fullscreen-${tag}-${expanded.mode}`);
      await b.clickSelector("[data-fullscreen-toggle]");
      check(`${tag}: full screen exits back to the page`, await b.waitFor(`document.querySelector('[data-viewer-state]').dataset.expanded === 'none'`, 5000));

      if (!mobile) {
        // The fallback overlay (Fullscreen API unavailable) also works.
        await b.navigate(`/p/${token}`);
        await b.waitFor(`!!document.querySelector('[data-rendered-page] canvas')`, 20000);
        await b.evaluate(`Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true }); Object.defineProperty(document, 'webkitFullscreenEnabled', { value: false, configurable: true }); true`);
        await b.clickSelector("[data-fullscreen-toggle]");
        check("fallback: overlay opens when the Fullscreen API is unavailable", await b.waitFor(`document.querySelector('[data-viewer-state]').dataset.expanded === 'fallback' && getComputedStyle(document.querySelector('[data-viewer-state]')).position === 'fixed'`, 5000));
        await b.key("Escape", "Escape", 27);
        check("fallback: Esc closes the overlay", await b.waitFor(`document.querySelector('[data-viewer-state]').dataset.expanded === 'none'`, 5000));
        const removed = await b.evaluate(`fetch('/p/${token}/download').then((r) => ({ status: r.status, type: r.headers.get('content-type') }))`);
        check("browser: the removed download route answers 404", removed.status === 404 && !(removed.type ?? "").includes("pdf"), JSON.stringify(removed));
      }
    }

    // Dashboard: Manage Document dialog has no access-mode controls.
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const [name, value] of leadA.jar) await b.send("Network.setCookie", { name, value, url: FULL_URL, httpOnly: true, sameSite: "Lax" });
    await b.navigate(`/dashboard?tab=history&q=${encodeURIComponent(title)}`);
    const manage = `button[aria-label="Manage Document and link for ${title}"]`;
    check("dashboard: 'Manage Document' button present", await b.waitFor(`!!document.querySelector(${JSON.stringify(manage)}) && !document.querySelector(${JSON.stringify(manage)}).disabled`, 20000));
    check("dashboard: History shows no Full Access label", await b.evaluate(`!document.body.innerText.includes('Manual full access') && !/\\bFull Access\\b/.test(document.body.innerText)`));
    await b.clickSelector(manage);
    check("dialog: titled 'Manage document and link'", await b.waitFor(`document.querySelector('dialog[open]')?.innerText.includes('Manage document and link')`, 10000));
    check("dialog: no access-mode choice, grant or Full Access warning", await b.evaluate(`!document.querySelector('dialog[open] [data-access-mode]') && !document.querySelector('dialog[open] [data-manual-grant]') && !document.querySelector('dialog[open] [data-full-access-warning]') && !/Full Access/.test(document.querySelector('dialog[open]').innerText)`));
    await b.screenshot("doc-03-dialog-desktop");
    await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    check("dialog: no horizontal scroll on a phone", await b.evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    await b.screenshot("doc-04-dialog-mobile");
    console.log(`       screenshots: ${shots}`);
  } finally {
    await b.close();
  }
}

await h.run(async () => {
  try {
    await main();
  } finally {
    stopServers();
  }
});
