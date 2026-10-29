// Manual Full Access links, document downloads and multi-format uploads.
//
//   npm run build
//   npm run test:full-access                 # HTTP checks
//   CHROME_PATH="..." npm run test:full-access   # + headless Chrome checks
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

const OUT = join(process.env.TEMP ?? tmpdir(), `portal-full-access-${process.pid}`);
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
      RATE_LIMIT_LINK_DOCUMENT_IP: "2000/60",
      RATE_LIMIT_LINK_DOWNLOAD_IP: "2000/60",
      RATE_LIMIT_LINK_DOWNLOAD_TOKEN: "2000/60",
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

// Public responses must never carry internal identities, notes or paths.
function leaksInternals(text, { leads, proposal, note }) {
  const needles = [
    ...leads.flatMap((lead) => [lead.fullName, lead.email, lead.id]),
    proposal.id,
    proposal.owner_id,
    "storage_path",
    "original.pdf",
    "Manual full access",
    "granted",
    ...(note ? [note] : []),
  ];
  return needles.filter((needle) => needle && text.includes(needle));
}

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

  // 1. The 15/12/3 manual workflow ------------------------------------------------
  const title = `Fifteen ${runId}`;
  const draft = await createDraft(leadA, title);
  const pdf15 = await makePdf(15, "Fifteen");
  const up15 = await upload(leadA, draft.id, pdf15, { fileName: "fifteen.pdf" });
  check("15-page PDF uploads and verifies", up15.ok && up15.data.document.totalPages === 15, up15.message);
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

  {
    const page = visibleText(await (await get(FULL_URL, `/p/${T1}`)).text());
    check("preview page: 12 of 15 pages free, 3 locked", page.includes("Free preview: 12 of 15 pages") && page.includes("3 pages are locked"), page.slice(0, 400));
    check("preview page has no download controls", !page.includes("Download PDF") && !page.includes("data-downloads"));
    const { res, bytes } = await fetchBytes(FULL_URL, `/p/${T1}/preview`);
    check("preview token serves only the 12-page preview", res.status === 200 && (await pageCount(bytes)) === 12);
    for (const kind of ["document", "download", "original"]) {
      const r = await get(FULL_URL, `/p/${T1}/${kind}`);
      check(`preview token cannot fetch /${kind} (404)`, r.status === 404, String(r.status));
    }
    const forged = await fetchBytes(FULL_URL, `/p/${T1}/preview?mode=full&access=full&pages=15`);
    check("forged query parameters don't change the preview", forged.res.status === 200 && (await pageCount(forged.bytes)) === 12);
    const forgedDoc = await get(FULL_URL, `/p/${T1}/document?mode=full&path=${encodeURIComponent(before.original_storage_path)}`);
    check("forged mode/path parameters can't unlock the full document", forgedDoc.status === 404, String(forgedDoc.status));
    const forgedPage = await (await get(FULL_URL, `/p/${T1}?mode=full&access=full`)).text();
    check("forged page parameters still show the preview", visibleText(forgedPage).includes("Free preview: 12 of 15 pages") && !forgedPage.includes("data-full-access-view"));
  }

  // Mode can't change behind the active link.
  {
    const res = await act(leadA, "setAccessModeAction", { proposalId: draft.id, mode: "full" });
    check("access mode can't change while the link is active", !res.ok && /Revoke the active link/.test(res.message), res.message);
    check("…and the database still says preview", (await row(draft.id)).access_mode === "preview");
  }

  const revoked = await act(leadA, "revokeLinkAction", { proposalId: draft.id });
  check("client paid outside the portal: old link revoked", revoked.ok, revoked.message);
  check("revoked preview link is unavailable", (await (await get(FULL_URL, `/p/${T1}`)).text()).includes("This link isn"));

  const modeSet = await act(leadA, "setAccessModeAction", { proposalId: draft.id, mode: "full" });
  check("Full Access selected for the same stored document", modeSet.ok && modeSet.data.accessMode === "full", modeSet.message);
  const afterMode = await row(draft.id);
  check("no re-upload: same document revision and file", afterMode.original_storage_path === before.original_storage_path && afterMode.total_pages === 15);

  const note = `Paid by bank transfer, INV-${runId}`;
  const fullLink = await act(leadA, "generateLinkAction", { proposalId: draft.id, expectedRevision: up15.data.document.revision, note: `  ${note}  ` });
  check("new Full Access link generated", fullLink.ok && /Full Access link created/.test(fullLink.message), fullLink.message);
  const T2 = tokenOf(fullLink);
  check("the new token differs from the old one", T2 !== T1);

  {
    const html = await (await get(FULL_URL, `/p/${T2}`)).text();
    check("full link page shows all 15 pages", html.includes("data-full-access-view") && visibleText(html).includes("Full document: 15 pages"));
    const text = visibleText(html);
    check("full link page has no locked pages, paywall or payment notice", !/locked|unlock|price/i.test(text) && !text.includes("Online payment") && !text.includes("Pay with PayPal") && !html.includes("data-price") && !html.includes("unlock-heading"), text.slice(0, 300));
    check("full link page names no Team Lead, note, ids or paths", leaksInternals(html, { leads, proposal: afterMode, note }).length === 0, leaksInternals(html, { leads, proposal: afterMode, note }).join(","));

    const doc = await fetchBytes(FULL_URL, `/p/${T2}/document`);
    check("full document: 200, PDF, inline, no-store, nosniff", doc.res.status === 200 && doc.res.headers.get("content-type") === "application/pdf" && /^inline;/.test(doc.res.headers.get("content-disposition") ?? "") && (doc.res.headers.get("cache-control") ?? "").includes("no-store") && doc.res.headers.get("x-content-type-options") === "nosniff");
    check("full document has all 15 pages and is the stored revision", (await pageCount(doc.bytes)) === 15 && sha(doc.bytes) === sha(await storedBytes(before.original_storage_path)));
    check("full document: no-referrer, same-origin resource policy, noindex", doc.res.headers.get("referrer-policy") === "no-referrer" && doc.res.headers.get("cross-origin-resource-policy") === "same-origin" && (doc.res.headers.get("x-robots-tag") ?? "").includes("noindex"));

    const dl = await fetchBytes(FULL_URL, `/p/${T2}/download`);
    const disposition = dl.res.headers.get("content-disposition") ?? "";
    check("Download PDF: attachment with a safe title-based .pdf name", dl.res.status === 200 && disposition.startsWith("attachment;") && disposition.includes(`filename="Fifteen ${runId}.pdf"`) && disposition.includes("filename*=UTF-8''"), disposition);
    check("Download PDF delivers the complete 15-page document", (await pageCount(dl.bytes)) === 15);
    check("no original download for a PDF upload (404)", (await get(FULL_URL, `/p/${T2}/original`)).status === 404);
    check("a Full Access token cannot fetch the preview (404)", (await get(FULL_URL, `/p/${T2}/preview`)).status === 404);
    const forged = await fetchBytes(FULL_URL, `/p/${T2}/document?revision=${randomUUID()}&path=../../etc/passwd&token=${T1}`);
    check("forged query parameters on a full link change nothing", forged.res.status === 200 && sha(forged.bytes) === sha(doc.bytes));
    for (const kind of ["", "/preview", "/document", "/download"]) {
      const r = await get(FULL_URL, `/p/${T1}${kind}`);
      const ok = kind === "" ? (await r.text()).includes("This link isn") : r.status === 404;
      check(`old token stays invalid: /p/<old>${kind}`, ok);
    }

    const { data: display } = await anon.rpc("resolve_proposal_full_access", { p_token: T2 });
    check("anon resolver returns display fields only", display?.length === 1 && JSON.stringify(Object.keys(display[0]).sort()) === JSON.stringify(["source_format", "title", "total_pages"]));
    const { error: objErr } = await anon.rpc("resolve_proposal_full_object", { p_token: T2 });
    check("anon cannot resolve Full Access storage paths", Boolean(objErr));
  }

  {
    const { data: grants } = await trusted.from("proposal_full_access_grants").select("*").eq("proposal_id", draft.id);
    const g = grants?.[0];
    check("manual grant recorded: who, when, revision, pages, trimmed note", grants?.length === 1 && g.granted_by === leadA.id && g.granted_by_name === leadA.fullName && g.revision_id === up15.data.document.revision && g.total_pages === 15 && g.note === note && g.ended_at === null);
    const { count } = await trusted.from("payments").select("id", { count: "exact", head: true }).eq("proposal_id", draft.id);
    check("no payment record exists for the manual grant", count === 0);
    const setup = await act(leadA, "loadProposalSetupAction", draft.id);
    check("dashboard shows the manual grant with its note", setup.ok && setup.data.fullAccess?.note === note && setup.data.fullAccess?.grantedByName === leadA.fullName);
    const history = await (await fetch(`${FULL_URL}/dashboard?tab=history&q=${runId}`, { headers: { cookie: leadA.cookie } })).text();
    check("History shows Full Access and 'Manual full access'", history.includes("Full Access") && history.includes("Manual full access"));
    check("History never labels it a verified PayPal payment", !history.includes("Verified PayPal"));
    const paymentsTab = await (await fetch(`${FULL_URL}/dashboard?tab=payments&q=${runId}`, { headers: { cookie: leadA.cookie } })).text();
    check("Payments tab lists no payment for it", !paymentsTab.includes(title));
  }

  // 2. Authorization: cross-lead denial, CEO access -----------------------------------
  {
    const denied = await Promise.all([
      act(leadB, "loadProposalSetupAction", draft.id),
      act(leadB, "setAccessModeAction", { proposalId: draft.id, mode: "preview" }),
      act(leadB, "revokeLinkAction", { proposalId: draft.id }),
      act(leadB, "generateLinkAction", { proposalId: draft.id, expectedRevision: up15.data.document.revision }),
      act(leadB, "prepareUploadAction", { proposalId: draft.id, sizeBytes: 1000, format: "pdf" }),
    ]);
    check("another Team Lead is refused every document action", denied.every((r) => !r.ok && /could not be found/.test(r.message)), denied.map((r) => r.message).join(" | "));
    check("…and nothing changed", (await row(draft.id)).status === "active");

    const ceoView = await act(admin, "loadProposalSetupAction", draft.id);
    check("the CEO can manage the lead's proposal", ceoView.ok && ceoView.data.accessMode === "full" && ceoView.data.fullAccess !== null);
    const ceoRevoke = await act(admin, "revokeLinkAction", { proposalId: draft.id });
    const ceoLink = await act(admin, "generateLinkAction", { proposalId: draft.id, expectedRevision: up15.data.document.revision });
    check("the CEO revokes and re-grants Full Access", ceoRevoke.ok && ceoLink.ok, `${ceoRevoke.message} ${ceoLink.message}`);
    const T3 = tokenOf(ceoLink);
    const { data: grants } = await trusted.from("proposal_full_access_grants").select("granted_by, ended_by, ended_at").eq("proposal_id", draft.id).order("granted_at");
    check("grant history: lead's grant ended by the CEO, new open grant by the CEO", grants.length === 2 && grants[0].ended_by === admin.id && grants[0].ended_at && grants[1].granted_by === admin.id && grants[1].ended_at === null);
    check("the CEO's new link works; the lead's link stopped", (await get(FULL_URL, `/p/${T3}/document`)).status === 200 && (await get(FULL_URL, `/p/${T2}/document`)).status === 404);
    const html = await (await get(FULL_URL, `/p/${T3}`)).text();
    check("public page never shows the CEO either", leaksInternals(html, { leads, proposal: afterMode, note }).length === 0);
    check("an active Full Access document can't be replaced", !(await upload(leadA, draft.id, await makePdf(3, "x"), { expectedRevision: up15.data.document.revision })).ok);
    await act(admin, "revokeLinkAction", { proposalId: draft.id });
  }

  // 3. One-page Full Access -------------------------------------------------------------
  {
    const one = await createDraft(leadA, `One page ${runId}`);
    const up = await upload(leadA, one.id, await makePdf(1, "Single"), { fileName: "single.pdf" });
    check("a one-page PDF is accepted", up.ok && up.data.document.totalPages === 1 && /Full Access/.test(up.message), up.message);
    const offer1 = await act(leadA, "saveOfferAction", { proposalId: one.id, expectedRevision: up.data.document.revision, freePages: "1", price: "10", currency: "USD" });
    check("a one-page document can't get a locked preview", !offer1.ok);
    const previewTry = await act(leadA, "generateLinkAction", { proposalId: one.id, expectedPreviewRevision: randomUUID() });
    check("…nor a preview link", !previewTry.ok);
    await act(leadA, "setAccessModeAction", { proposalId: one.id, mode: "full" });
    const link = await act(leadA, "generateLinkAction", { proposalId: one.id, expectedRevision: up.data.document.revision });
    check("one-page Full Access link generated (no preview or price)", link.ok, link.message);
    const token = tokenOf(link);
    const html = await (await get(FULL_URL, `/p/${token}`)).text();
    const doc = await fetchBytes(FULL_URL, `/p/${token}/download`);
    check("one-page Full Access link shows and downloads the page", /Full document: 1 page ?\./.test(visibleText(html)) && doc.res.status === 200 && (await pageCount(doc.bytes)) === 1);
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
    await act(leadA, "setAccessModeAction", { proposalId: d.id, mode: "full" });
    const link = await act(leadA, "generateLinkAction", { proposalId: d.id, expectedRevision: revision });
    const token = tokenOf(link);
    const original = await fetchBytes(FULL_URL, `/p/${token}/original`);
    const disposition = original.res.headers.get("content-disposition") ?? "";
    check(`${format.toUpperCase()}: Download original returns the exact upload with the right type`, original.res.status === 200 && original.res.headers.get("content-type") === MIME[format] && disposition.startsWith("attachment;") && disposition.includes(`.${format}"`) && sha(original.bytes) === sha(bytes) && original.res.headers.get("x-content-type-options") === "nosniff", `${original.res.headers.get("content-type")} ${disposition}`);
    const pdfDl = await fetchBytes(FULL_URL, `/p/${token}/download`);
    check(`${format.toUpperCase()}: Download PDF returns the ${pages}-page canonical PDF`, pdfDl.res.status === 200 && (await pageCount(pdfDl.bytes)) === pages);
    const html = await (await get(FULL_URL, `/p/${token}`)).text();
    check(`${format.toUpperCase()}: client page offers 'Download original (${format.toUpperCase()})'`, html.includes(`Download original (${format.toUpperCase()})`), visibleText(html).slice(0, 300));
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
    check("converted documents also work as preview links", preview.ok && link.ok && (await pageCount((await fetchBytes(FULL_URL, `/p/${token}/preview`)).bytes)) === 1);
    check("a preview token can't download the original source (404)", (await get(FULL_URL, `/p/${token}/original`)).status === 404);
  }

  // Replacing a converted revision removes its superseded files.
  if (converted) {
    await act(leadA, "revokeLinkAction", { proposalId: converted.id });
    const up = await upload(leadA, converted.id, await makePdf(2, "Replacement"), { expectedRevision: converted.revision });
    const objects = await objectsUnder(`${leadA.id}/${converted.id}`);
    check("replacing a converted document removes the old source and PDF", up.ok && objects.length === 1 && objects[0].endsWith(`/${up.data.document.revision}/original.pdf`), objects.join(","));
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
    await act(leadA, "setAccessModeAction", { proposalId: d.id, mode: "full" });
    await act(leadA, "generateLinkAction", { proposalId: d.id, expectedRevision: up.data.document.revision, note: "to be deleted" });
    const del = await formAct(leadA, "deleteProposalAction", { proposalId: d.id });
    check("deleting removes the source, canonical PDF and preview", del?.status === "success" && (await objectsUnder(`${leadA.id}/${d.id}`)).length === 0, JSON.stringify(del));
    const { count } = await trusted.from("proposal_full_access_grants").select("id", { count: "exact", head: true }).eq("proposal_id", d.id);
    check("…and its grant records", count === 0);
  }

  const paymentsAfter = (await trusted.from("payments").select("id", { count: "exact", head: true })).count;
  check("no payment records were created anywhere", paymentsAfter === paymentsBefore);

  // 8. Browser (optional: CHROME_PATH) ---------------------------------------------------------
  if (process.env.CHROME_PATH) {
    await browserChecks({ leadA, title, draftId: draft.id, revision: up15.data.document.revision });
  } else {
    console.log("skip   browser checks (set CHROME_PATH to run them)");
  }
}

async function browserChecks({ leadA, title, draftId, revision }) {
  const { launchBrowser } = await import("./lib/browser.mjs");
  const shots = join(OUT, "screens");
  mkdirSync(shots, { recursive: true });
  const link = await act(leadA, "generateLinkAction", { proposalId: draftId, expectedRevision: revision, note: "browser run" });
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
      const rendered = await b.waitFor(`!!document.querySelector('[data-full-access-view] [data-rendered-page] canvas')`, 20000);
      check(`${tag}: Full Access page renders the document`, rendered);
      check(`${tag}: page status shows 'Page 1 of 15'`, await b.waitFor(`document.querySelector('[data-page-status]').innerText.startsWith('Page 1 of 15')`, 5000));
      check(`${tag}: selectable text layer present`, await b.waitFor(`document.querySelectorAll('.textLayer span').length > 0`, 5000));
      check(`${tag}: Download PDF visible`, await b.evaluate(`(() => { const a = document.querySelector('[data-download=pdf]'); return !!a && a.checkVisibility() && a.getAttribute('href') === '/p/${token}/download'; })()`));
      check(`${tag}: no locked placeholders or payment panel`, await b.evaluate(`!document.querySelector('#unlock-heading') && !document.body.innerText.includes('Online payment') && !/locked/i.test(document.body.innerText)`));
      check(`${tag}: no horizontal scroll`, await noOverflow());
      const fit = await pageBox();
      check(`${tag}: fit width fills the stage without stretching`, fit && Math.abs(fit.w - fit.stageW) <= 2 && Math.abs(fit.w / fit.h - fit.ratio) < 0.02, JSON.stringify(fit));
      await b.screenshot(`fa-01-full-${tag}`);

      await b.clickSelector('[aria-label="Fit page"]');
      await b.waitFor(`document.querySelector('[aria-label="Fit page"]').getAttribute('aria-pressed') === 'true' && !!document.querySelector('[data-rendered-page]')`, 5000);
      await sleep(400);
      const page = await pageBox();
      check(`${tag}: fit page keeps the whole page within the window`, page && page.h <= page.vh && page.w <= fit.w + 1 && Math.abs(page.w / page.h - page.ratio) < 0.02, JSON.stringify(page));

      await b.clickSelector('[aria-label="Next page"]');
      check(`${tag}: next page`, await b.waitFor(`document.querySelector('[data-page-status]').innerText.startsWith('Page 2 of 15') && document.querySelector('[data-rendered-page]')?.dataset.renderedPage === '2'`, 8000));

      await b.clickSelector("[data-fullscreen-toggle]");
      check(`${tag}: full screen toggle enters full screen (or the overlay fallback)`, await b.waitFor(`['native','fallback'].includes(document.querySelector('[data-viewer-state]').dataset.expanded)`, 5000));
      await sleep(600);
      const expanded = await b.evaluate(`(() => { const s = document.querySelector('[data-viewer-state]').getBoundingClientRect(); return { w: s.width, h: s.height, mode: document.querySelector('[data-viewer-state]').dataset.expanded }; })()`);
      check(`${tag}: the viewer fills the screen while expanded`, expanded.w >= width - 2 && expanded.h >= height - 2, JSON.stringify(expanded));
      check(`${tag}: page re-renders after the transition`, await b.waitFor(`!!document.querySelector('[data-rendered-page="2"] canvas') && document.querySelectorAll('.pdf-page canvas').length === 1`, 8000));
      check(`${tag}: exit control is labelled`, await b.evaluate(`document.querySelector('[data-fullscreen-toggle]').getAttribute('aria-label') === 'Exit full screen' && document.querySelector('[data-fullscreen-toggle]').getAttribute('aria-pressed') === 'true'`));
      await b.screenshot(`fa-02-fullscreen-${tag}-${expanded.mode}`);
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

        const download = await b.evaluate(`fetch('/p/${token}/download').then((r) => ({ status: r.status, disposition: r.headers.get('content-disposition'), type: r.headers.get('content-type') }))`);
        check("browser: Download PDF link serves an attachment", download.status === 200 && download.type === "application/pdf" && download.disposition.startsWith("attachment;"), JSON.stringify(download));
      }
    }

    // A preview link shows no download controls.
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const previewProposal = await createDraft(leadA, `Browser preview ${runId}`);
    const up = await upload(leadA, previewProposal.id, await makePdf(4, "Prev"));
    const offer = await act(leadA, "saveOfferAction", { proposalId: previewProposal.id, expectedRevision: up.data.document.revision, freePages: "2", price: "12", currency: "USD" });
    const previewLink = await act(leadA, "generateLinkAction", { proposalId: previewProposal.id, expectedPreviewRevision: offer.data.preview.revision });
    await b.navigate(`/p/${tokenOf(previewLink)}`);
    await b.waitFor(`!!document.querySelector('[data-rendered-page] canvas')`, 20000);
    check("preview link: no download controls in the viewer", await b.evaluate(`!document.querySelector('[data-downloads]') && !document.body.innerText.includes('Download PDF')`));
    check("preview link: full screen and fit page also available", await b.evaluate(`!!document.querySelector('[data-fullscreen-toggle]') && !!document.querySelector('[aria-label="Fit page"]')`));
    await b.screenshot("fa-03-preview-desktop");

    // Dashboard: Manage Document dialog.
    for (const [name, value] of leadA.jar) await b.send("Network.setCookie", { name, value, url: FULL_URL, httpOnly: true, sameSite: "Lax" });
    await b.navigate(`/dashboard?tab=history&q=${encodeURIComponent(title)}`);
    const manage = `button[aria-label="Manage Document and link for ${title}"]`;
    check("dashboard: 'Manage Document' button present", await b.waitFor(`!!document.querySelector(${JSON.stringify(manage)}) && !document.querySelector(${JSON.stringify(manage)}).disabled`, 20000));
    check("dashboard: History shows Full Access and the manual grant", await b.evaluate(`document.body.innerText.includes('Full Access') && document.body.innerText.includes('Manual full access')`));
    await b.clickSelector(manage);
    check("dialog: titled 'Manage document and link'", await b.waitFor(`document.querySelector('dialog[open]')?.innerText.includes('Manage document and link')`, 10000));
    check("dialog: shows the manual grant and its internal note", await b.waitFor(`!!document.querySelector('dialog[open] [data-manual-grant]') && document.querySelector('dialog[open] [data-manual-grant]').innerText.includes('browser run')`, 10000));
    check("dialog: mode can't be changed while the link is active", await b.evaluate(`document.querySelector('dialog[open] [data-access-mode] input[value=preview]').matches(':disabled')`));
    check("dialog: Full Access warning is shown", await b.evaluate(`document.querySelector('dialog[open] [data-full-access-warning]').innerText.includes('Anyone holding this full-access link can read and download the complete document')`));
    await b.screenshot("fa-04-dialog-desktop");
    await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    check("dialog: no horizontal scroll on a phone", await b.evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    await b.screenshot("fa-05-dialog-mobile");
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
