// Phase 4 end-to-end checks: PDF upload, verification, preview generation,
// offer settings and private links, against a running production build and
// the LOCAL Supabase stack.
//
//   npm run db:start
//   npm run build && npx next start -p 3100     # in another terminal
//   APP_URL=http://localhost:3100 npm run test:pdf
//
// Calls the real server actions over HTTP (ids from the build's
// server-reference manifest) with real session cookies of disposable users,
// uploads with the signed-upload token exactly like the browser does, and
// verifies results through those users' RLS-scoped clients and anonymously.
// The local secret key is used only to provision/clean up the disposable
// users and to inspect storage contents (cleanup checks), never for the
// authorization checks themselves. Existing local data is snapshotted and
// verified untouched at the end.

import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, PDFName, PDFDict, StandardFonts } from "pdf-lib";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const status = JSON.parse(
  execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString(),
);
const API_URL = status.API_URL;
const PUBLISHABLE_KEY = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const SECRET_KEY = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const BUCKET = "proposals";
const MAX_BYTES = 20 * 1024 * 1024; // default PDF_MAX_UPLOAD_MB
const MAX_PAGES = 300; // default PDF_MAX_PAGES

for (const url of [API_URL, APP_URL]) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`Refusing to run against non-local host (${host}).`);
    process.exit(2);
  }
}

const actionIds = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node)
    .filter(([, v]) => v.filename?.endsWith("proposal-setup-actions.ts"))
    .map(([id, v]) => [v.exportedName, id]),
);

const runId = randomBytes(4).toString("hex");
const trusted = createClient(API_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(API_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const created = { users: [] };
const results = [];

function check(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}${!passed && detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Users, sessions, server actions
// ---------------------------------------------------------------------------

async function provisionUser(label, role) {
  const email = `phase4-${label}-${runId}@test.local`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await trusted.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  created.users.push(data.user.id);
  const fullName = `P4 ${label} ${runId}`;
  if (role) {
    const { error: pe } = await trusted.from("profiles").insert({ id: data.user.id, full_name: fullName, role });
    if (pe) throw new Error(`profile ${label}: ${pe.message}`);
  }

  const jar = new Map();
  const client = createServerClient(API_URL, PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error: se } = await client.auth.signInWithPassword({ email, password });
  if (se) throw new Error(`signIn ${label}: ${se.message}`);
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  return { id: data.user.id, email, fullName, client, cookie };
}

// Parses the RSC response of a server action and returns its result value.
function parseActionResponse(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+):([[{].*)$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  const head = JSON.parse(rows.get("0"));
  const ref = typeof head.a === "string" && head.a.startsWith("$@") ? head.a.slice(2) : null;
  return ref ? JSON.parse(rows.get(ref)) : head.a;
}

async function act(user, name, arg) {
  const id = actionIds[name];
  if (!id) throw new Error(`action ${name} not in manifest`);
  const res = await fetch(`${APP_URL}/dashboard`, {
    method: "POST",
    headers: {
      ...(user ? { cookie: user.cookie } : {}),
      origin: APP_URL,
      "next-action": id,
      "content-type": "text/plain;charset=UTF-8",
      accept: "text/x-component",
    },
    body: JSON.stringify([arg]),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, redirectedTo: res.headers.get("location") ?? "", message: `redirect ${res.status}` };
  }
  if (res.status !== 200) return { ok: false, message: `HTTP ${res.status}` };
  return parseActionResponse(await res.text());
}

// Same steps as the dashboard: ticket -> direct upload with the token -> verify.
async function uploadPdf(user, proposalId, bytes, { fileName = "proposal.pdf", declaredSize, expectedRevision } = {}) {
  if (expectedRevision === undefined) {
    const loaded = await act(user, "loadProposalSetupAction", proposalId);
    expectedRevision = loaded.ok ? (loaded.data.document?.revision ?? null) : null;
  }
  const ticket = await act(user, "prepareUploadAction", { proposalId, sizeBytes: declaredSize ?? bytes.length });
  if (!ticket.ok) return { stage: "prepare", ...ticket };
  const { error } = await anon.storage
    .from(BUCKET)
    .uploadToSignedUrl(ticket.data.path, ticket.data.token, new Blob([bytes], { type: "application/pdf" }), {
      contentType: "application/pdf",
    });
  if (error) return { stage: "upload", ok: false, message: error.message, ticket };
  const done = await act(user, "completeUploadAction", {
    proposalId,
    revision: ticket.data.revision,
    expectedRevision,
    fileName,
  });
  return { stage: "complete", ticket, ...done };
}

async function saveOffer(user, proposalId, values, expectedRevision) {
  if (!expectedRevision) {
    const loaded = await act(user, "loadProposalSetupAction", proposalId);
    expectedRevision = loaded.data?.document?.revision;
  }
  return act(user, "saveOfferAction", { proposalId, expectedRevision, ...values });
}

async function generateLink(user, proposalId) {
  const loaded = await act(user, "loadProposalSetupAction", proposalId);
  return act(user, "generateLinkAction", {
    proposalId,
    expectedPreviewRevision: loaded.data?.preview?.revision ?? randomUUID(),
  });
}

function tokenOf(url) {
  return new URL(url).pathname.split("/").pop();
}

async function openLink(token) {
  const res = await fetch(`${APP_URL}/p/${token}`);
  return { res, html: await res.text() };
}

// Phase 5 replaced the Phase 4 placeholder with the client page; its
// preview summary marks a resolved, available link.
const AVAILABLE_TEXT = "Free preview: ";
const UNAVAILABLE_TEXT = "This link isn&#x27;t available";

// ---------------------------------------------------------------------------
// Fixtures (generated, disposable)
// ---------------------------------------------------------------------------

const ATTACHMENT_MARKER = `ATTACHED-SECRET-${runId}`;

// Page i (1-based) is 200+i points wide, so page identity survives copying.
// Includes document metadata, an embedded file and a link annotation on page
// 1 pointing at the last page: none of these may reach the preview.
async function makePdf(pages, label = "doc") {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([200 + i, 300]);
    page.drawText(`${label} page ${i}/${pages}`, { x: 10, y: 150, size: 8, font });
  }
  doc.setTitle(`SECRET-TITLE-${label}-${runId}`);
  doc.setAuthor("Confidential Author");
  await doc.attach(new TextEncoder().encode(ATTACHMENT_MARKER), "secret.txt", { mimeType: "text/plain" });
  if (pages > 1) {
    const last = doc.getPage(pages - 1);
    const annot = doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 50, 50],
      Dest: [last.ref, "Fit"],
    });
    doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
  }
  return doc.save({ useObjectStreams: false });
}

// A PDF whose trailer declares /Encrypt (what readers use to detect a
// password-protected file). Built by editing the trailer of a valid PDF.
async function makeEncryptedPdf() {
  const bytes = await makePdf(3, "enc");
  const text = Buffer.from(bytes).toString("latin1");
  const at = text.lastIndexOf("trailer");
  const patched = text.slice(0, at) + text.slice(at).replace("<<", "<<\n/Encrypt 1 0 R");
  return Buffer.from(patched, "latin1");
}

function corruptPdf() {
  return Buffer.concat([Buffer.from("%PDF-1.7\n%âãÏÓ\n"), randomBytes(4096), Buffer.from("\n%%EOF\n")]);
}

function oversizedPdf() {
  // Valid header, > 20 MiB, < 25 MiB bucket limit: must be rejected by the
  // server's size check before parsing, then removed.
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(MAX_BYTES + 1024 * 1024, 0x20)]);
}

async function inspectPreview(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageDicts = doc.context
    .enumerateIndirectObjects()
    .filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Page")).length;
  return {
    pageCount: doc.getPageCount(),
    widths: doc.getPages().map((p) => Math.round(p.getWidth())),
    pageDicts,
    title: doc.getTitle(),
    author: doc.getAuthor(),
    hasNames: doc.catalog.get(PDFName.of("Names")) !== undefined,
    hasAnnots: doc.getPages().some((p) => p.node.get(PDFName.of("Annots")) !== undefined),
    hasMarker: Buffer.from(bytes).includes(ATTACHMENT_MARKER),
  };
}

// Storage inspection for cleanup checks (secret key, read-only listing).
async function objectsUnder(prefix) {
  const out = [];
  const { data } = await trusted.storage.from(BUCKET).list(prefix, { limit: 1000 });
  for (const entry of data ?? []) {
    const path = `${prefix}/${entry.name}`;
    if (entry.id) out.push(path);
    else out.push(...(await objectsUnder(path)));
  }
  return out.sort();
}

async function proposalRow(user, id) {
  const { data } = await user.client
    .from("proposals")
    .select(
      "id, owner_id, status, original_storage_path, preview_storage_path, total_pages, free_preview_pages, unlock_price_minor, currency, original_file_name, original_size_bytes, link_created_at",
    )
    .eq("id", id)
    .maybeSingle();
  return data;
}

async function createDraft(user, title) {
  const { data: client, error: ce } = await user.client
    .from("clients")
    .insert({ owner_id: user.id, name: `Client of ${title}`, email: `client-${randomBytes(3).toString("hex")}@client.test` })
    .select("id")
    .single();
  if (ce) throw new Error(`client: ${ce.message}`);
  const { data, error } = await user.client
    .from("proposals")
    .insert({ client_id: client.id, owner_id: user.id, title })
    .select("id")
    .single();
  if (error) throw new Error(`proposal: ${error.message}`);
  return data.id;
}

async function prepared(user, title, pages, offer = { freePages: "2", price: "25.00", currency: "EUR" }) {
  const id = await createDraft(user, title);
  const up = await uploadPdf(user, id, await makePdf(pages, title));
  if (!up.ok) throw new Error(`upload ${title}: ${up.message}`);
  const of = await saveOffer(user, id, offer);
  if (!of.ok) throw new Error(`offer ${title}: ${of.message}`);
  return id;
}

// ---------------------------------------------------------------------------
// Existing data snapshot (must be untouched)
// ---------------------------------------------------------------------------

async function snapshot() {
  const [profiles, clients, proposals, users] = await Promise.all([
    trusted.from("profiles").select("id, role, full_name").order("id"),
    trusted.from("clients").select("id, updated_at").order("id"),
    trusted.from("proposals").select("id, updated_at, status").order("id"),
    trusted.auth.admin.listUsers({ perPage: 1000 }),
  ]);
  const testIds = new Set(created.users);
  const keep = (rows) => (rows ?? []).filter((r) => !testIds.has(r.id));
  return JSON.stringify({
    profiles: keep(profiles.data),
    clients: clients.data,
    proposals: proposals.data,
    users: keep(users.data?.users.map((u) => ({ id: u.id, email: u.email })) ?? []).length,
  });
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

async function main() {
  const before = await snapshot();

  const leadA = await provisionUser("lead-a", "team_lead");
  const leadB = await provisionUser("lead-b", "team_lead");
  const leadC = await provisionUser("lead-c", "team_lead");
  const admin = await provisionUser("admin", "admin");
  let tokenA = "";

  // --- Happy path -----------------------------------------------------------
  const propA = await createDraft(leadA, `Proposal A ${runId}`);
  {
    const loaded = await act(leadA, "loadProposalSetupAction", propA);
    check("new draft has no document, preview or link", loaded.ok && !loaded.data.document && !loaded.data.preview && !loaded.data.link);
  }

  const pdfA = await makePdf(10, "A");
  const upA = await uploadPdf(leadA, propA, pdfA, { fileName: "C:\\fakepath\\Acme proposal.pdf" });
  check("valid 10-page PDF uploads and is verified", upA.ok && upA.data.document.totalPages === 10, upA.message);
  check(
    "file name (display only) and size come back; size is the server-measured byte count",
    upA.ok && upA.data.document.fileName === "Acme proposal.pdf" && upA.data.document.sizeBytes === pdfA.length,
  );
  {
    const row = await proposalRow(leadA, propA);
    check(
      "original stored at an immutable revision path bound to owner and proposal",
      row.original_storage_path === `${leadA.id}/${propA}/${upA.ticket.data.revision}/original.pdf`,
      row.original_storage_path,
    );
    check("upload alone doesn't create a preview, offer or link", row.status === "draft" && !row.preview_storage_path && !row.link_created_at);
    check("setup data sent to the browser contains no storage path or owner id", !JSON.stringify(upA.data).includes(leadA.id));
  }

  const offerA = await saveOffer(leadA, propA, { freePages: "3", price: "49.99", currency: "USD" });
  check("offer saves (3 free pages, 49.99 USD)", offerA.ok, offerA.message);
  {
    const row = await proposalRow(leadA, propA);
    check(
      "price stored as integer minor units with the selected currency",
      row.unlock_price_minor === 4999 && row.currency === "USD" && row.free_preview_pages === 3,
      JSON.stringify(row),
    );
    const { data: blob, error } = await leadA.client.storage.from(BUCKET).download(row.preview_storage_path);
    const preview = blob ? await inspectPreview(new Uint8Array(await blob.arrayBuffer())) : null;
    check("preview is a separate PDF with exactly 3 pages", !error && preview?.pageCount === 3 && row.preview_storage_path !== row.original_storage_path);
    check("preview pages are pages 1–3 of the original, in order", preview?.widths.join(",") === "201,202,203", preview?.widths.join(","));
    check("preview contains no other page objects (link annotation to page 10 not followed)", preview?.pageDicts === 3 && !preview?.hasAnnots);
    check(
      "preview drops document metadata and embedded files",
      preview && !preview.title && !preview.author && !preview.hasNames && !preview.hasMarker,
      JSON.stringify(preview),
    );
  }

  const linkA = await generateLink(leadA, propA);
  check(
    "private link is generated from the configured base URL with a 256-bit token",
    linkA.ok && /^http:\/\/localhost:3000\/p\/[A-Za-z0-9_-]{43}$/.test(linkA.data.url),
    linkA.message,
  );
  check("local link is flagged local-only", linkA.ok && linkA.data.localOnly === true);
  const tokenA1 = linkA.ok ? tokenOf(linkA.data.url) : "";
  {
    const row = await proposalRow(leadA, propA);
    check("generating a link activates the proposal", row.status === "active" && Boolean(row.link_created_at));
    const { error } = await leadA.client.from("proposals").select("link_token_hash").eq("id", propA);
    check("even the owner cannot read the stored token hash", Boolean(error));
    const reloaded = await act(leadA, "loadProposalSetupAction", propA);
    check("the raw link cannot be fetched again later", reloaded.ok && !JSON.stringify(reloaded).includes(tokenA1));
  }
  {
    const { res, html } = await openLink(tokenA1);
    check("link page shows the proposal title and its preview summary", res.status === 200 && html.includes(`Proposal A ${runId}`) && html.includes(AVAILABLE_TEXT));
    check(
      "link page is no-store, no-referrer and noindex",
      /no-store/.test(res.headers.get("cache-control") ?? "") &&
        res.headers.get("referrer-policy") === "no-referrer" &&
        /noindex/.test(res.headers.get("x-robots-tag") ?? "") &&
        /<meta name="robots" content="noindex/.test(html),
      `${res.headers.get("cache-control")} | ${res.headers.get("referrer-policy")} | ${res.headers.get("x-robots-tag")}`,
    );
    const row = await proposalRow(leadA, propA);
    // Phase 5 shows the unlock price on the client page by design; owner,
    // storage paths and client details must still never appear.
    check(
      "link page exposes no owner id, storage path or client email",
      !html.includes(leadA.id) &&
        !html.includes(row.original_storage_path) &&
        !html.includes(row.preview_storage_path) &&
        !html.includes("@client.test"),
    );
  }

  // --- Active proposals are locked -------------------------------------------
  {
    const up = await uploadPdf(leadA, propA, await makePdf(4, "late"));
    check("active proposal: PDF replacement is refused", !up.ok && /active link/.test(up.message), up.message);
    const of = await saveOffer(leadA, propA, { freePages: "1", price: "1.00", currency: "USD" });
    check("active proposal: offer change is refused", !of.ok && /active link/.test(of.message), of.message);
    const { error } = await leadA.client.from("proposals").update({ title: "Renamed while active" }).eq("id", propA);
    check("active proposal: title change is blocked in the database", error?.code === "PT423", error?.code);
  }

  // --- Direct API forgery is impossible ---------------------------------------
  {
    const attempts = {
      status: { status: "draft" },
      total_pages: { total_pages: 500 },
      free_preview_pages: { free_preview_pages: 9 },
      preview_storage_path: { preview_storage_path: null },
      unlock_price_minor: { unlock_price_minor: 1 },
      link_token_hash: { link_token_hash: "0".repeat(64) },
    };
    const denied = [];
    for (const [field, patch] of Object.entries(attempts)) {
      const { error } = await leadA.client.from("proposals").update(patch).eq("id", propA);
      if (error?.code === "42501") denied.push(field);
    }
    check("lead cannot write status, page counts, paths, price or token via the API", denied.length === 6, denied.join(","));

    const rpcs = [
      ["proposal_attach_original", { p_actor: leadA.id, p_proposal_id: propA, p_expected_original_path: null, p_path: "x", p_file_name: "x", p_size_bytes: 1, p_total_pages: 999 }],
      ["proposal_save_offer", { p_actor: leadA.id, p_proposal_id: propA, p_expected_original_path: "x", p_preview_path: "x", p_free_pages: 9, p_price_minor: 1, p_currency: "USD" }],
      ["proposal_issue_link", { p_actor: leadA.id, p_proposal_id: propA, p_expected_preview_path: "x", p_token_hash: "0".repeat(64) }],
      ["proposal_revoke_link", { p_actor: leadA.id, p_proposal_id: propA }],
    ];
    let blocked = 0;
    for (const [fn, args] of rpcs) {
      const asLead = await leadA.client.rpc(fn, args);
      const asAnon = await anon.rpc(fn, args);
      if (asLead.error && asAnon.error) blocked++;
    }
    check("trusted write functions are not callable by leads or anonymously", blocked === 4);
    const row = await proposalRow(leadA, propA);
    check("…and the proposal is unchanged", row.status === "active" && row.total_pages === 10 && row.free_preview_pages === 3);
  }

  // --- Revocation and rotation -----------------------------------------------
  {
    const revoked = await act(leadA, "revokeLinkAction", { proposalId: propA });
    check("revoking returns the proposal to draft", revoked.ok && revoked.data.status === "draft" && !revoked.data.link, revoked.message);
    const { html } = await openLink(tokenA1);
    check("revoked link shows the generic unavailable page", html.includes(UNAVAILABLE_TEXT) && !html.includes(`Proposal A ${runId}`));
    const again = await act(leadA, "revokeLinkAction", { proposalId: propA });
    check("revoking twice is refused cleanly", !again.ok);

    const rotated = await generateLink(leadA, propA);
    const tokenA2 = rotated.ok ? tokenOf(rotated.data.url) : "";
    check("a new link can be generated explicitly after revoking", rotated.ok && tokenA2 !== tokenA1, rotated.message);
    const oldPage = await openLink(tokenA1);
    const newPage = await openLink(tokenA2);
    check(
      "after rotation the old link stays dead and the new one works",
      oldPage.html.includes(UNAVAILABLE_TEXT) && newPage.html.includes(`Proposal A ${runId}`),
    );
    tokenA = tokenA2;
  }

  // --- Generic unavailable state ---------------------------------------------
  {
    const random = await openLink(randomBytes(32).toString("base64url"));
    const malformed = await openLink("not-a-token");
    const revoked = await openLink(tokenA1);
    check(
      "random, malformed and revoked tokens render the same unavailable state",
      [random, malformed, revoked].every(
        (page) => page.res.status === 200 && page.html.includes(UNAVAILABLE_TEXT) && !page.html.includes(runId),
      ),
    );
  }

  // --- Validation: invalid uploads leave no usable state or stray files -------
  const propV = await createDraft(leadA, `Validation ${runId}`);
  const baseline = await uploadPdf(leadA, propV, await makePdf(5, "V"));
  await saveOffer(leadA, propV, { freePages: "2", price: "10", currency: "GBP" });
  const rowBefore = await proposalRow(leadA, propV);
  const objectsBefore = await objectsUnder(`${leadA.id}/${propV}`);
  check("validation fixture prepared", baseline.ok && objectsBefore.length === 2, objectsBefore.join(","));

  const rejected = [
    ["corrupt PDF", corruptPdf(), /couldn't be read/],
    ["non-PDF file named .pdf", Buffer.from("Just text pretending to be a PDF"), /isn't a PDF/],
    ["encrypted / password-protected PDF", await makeEncryptedPdf(), /password-protected or encrypted/],
    [`PDF over ${MAX_PAGES} pages`, await makePdf(MAX_PAGES + 1, "many"), /limit is 300/],
  ];
  for (const [label, bytes, pattern] of rejected) {
    const res = await uploadPdf(leadA, propV, bytes, { fileName: "bad.pdf" });
    check(`rejects ${label}`, !res.ok && res.stage === "complete" && pattern.test(res.message), res.message);
  }
  {
    // One-page documents are accepted (they can be shared with Full Access).
    const propOne = await createDraft(leadA, `One page ${runId}`);
    const res = await uploadPdf(leadA, propOne, await makePdf(1, "one"));
    check("accepts a one-page PDF", res.ok, res.message);
  }
  {
    const res = await uploadPdf(leadA, propV, oversizedPdf(), { fileName: "big.pdf" });
    check("rejects an oversized declared upload before issuing an upload ticket", !res.ok && res.stage === "prepare" && /larger than 20 MB/.test(res.message), res.message);
    const lying = await uploadPdf(leadA, propV, oversizedPdf(), { fileName: "big.pdf", declaredSize: 1000 });
    check("rejects an oversized stored file even if the declared size lied", !lying.ok && lying.stage === "complete" && /larger than 20 MB/.test(lying.message), lying.message);
  }
  {
    const ticket = await act(leadA, "prepareUploadAction", { proposalId: propV, sizeBytes: 1000 });
    const res = await act(leadA, "completeUploadAction", {
      proposalId: propV,
      revision: ticket.data.revision,
      expectedRevision: rowBefore.original_storage_path.split("/")[2],
      fileName: "never-uploaded.pdf",
    });
    check("completing without an uploaded file fails cleanly", !res.ok && /didn't reach storage/.test(res.message), res.message);
  }
  {
    const row = await proposalRow(leadA, propV);
    const objects = await objectsUnder(`${leadA.id}/${propV}`);
    check(
      "failed uploads leave the saved document, preview and offer untouched",
      JSON.stringify(row) === JSON.stringify(rowBefore),
    );
    check("failed uploads leave no stray files in storage", JSON.stringify(objects) === JSON.stringify(objectsBefore), objects.join(","));
  }

  // --- Validation: offer fields ----------------------------------------------
  {
    const cases = [
      [{ freePages: "0", price: "10", currency: "USD" }, "freePages"],
      [{ freePages: "5", price: "10", currency: "USD" }, "freePages"],
      [{ freePages: "2.5", price: "10", currency: "USD" }, "freePages"],
      [{ freePages: "abc", price: "10", currency: "USD" }, "freePages"],
      [{ freePages: "2", price: "0", currency: "USD" }, "price"],
      [{ freePages: "2", price: "-5", currency: "USD" }, "price"],
      [{ freePages: "2", price: "49.999", currency: "USD" }, "price"],
      [{ freePages: "2", price: "1,000", currency: "USD" }, "price"],
      [{ freePages: "2", price: "1.5", currency: "JPY" }, "price"],
      [{ freePages: "2", price: "1000001", currency: "USD" }, "price"],
      [{ freePages: "2", price: "10", currency: "" }, "currency"],
      [{ freePages: "2", price: "10", currency: "XYZ" }, "currency"],
    ];
    const wrong = [];
    for (const [values, field] of cases) {
      const res = await saveOffer(leadA, propV, values);
      if (res.ok || !res.fieldErrors?.[field]) wrong.push(`${JSON.stringify(values)}=>${JSON.stringify(res)}`);
    }
    check("invalid preview bounds, prices and currencies are rejected per field", wrong.length === 0, wrong.join(" | "));
    const fiveOfFive = await saveOffer(leadA, propV, { freePages: "5", price: "10", currency: "USD" });
    check("explains that at least one page must stay locked", /must stay locked/.test(fiveOfFive.fieldErrors?.freePages ?? ""));
    const jpy = await saveOffer(leadA, propV, { freePages: "4", price: "1500", currency: "JPY" });
    const row = await proposalRow(leadA, propV);
    check("zero-decimal currency stores whole units (1500 JPY -> 1500)", jpy.ok && row.unlock_price_minor === 1500 && row.currency === "JPY");
    const objects = await objectsUnder(`${leadA.id}/${propV}`);
    check("re-saving the offer replaces the preview and removes the old one", objects.length === 2 && objects.includes(row.preview_storage_path), objects.join(","));
  }

  // --- Stale and concurrent updates -------------------------------------------
  {
    const row = await proposalRow(leadA, propV);
    const expected = row.original_storage_path.split("/")[2];
    const t1 = await act(leadA, "prepareUploadAction", { proposalId: propV, sizeBytes: 5000 });
    const t2 = await act(leadA, "prepareUploadAction", { proposalId: propV, sizeBytes: 5000 });
    const [f1, f2] = [await makePdf(6, "R1"), await makePdf(7, "R2")];
    await anon.storage.from(BUCKET).uploadToSignedUrl(t1.data.path, t1.data.token, new Blob([f1], { type: "application/pdf" }), { contentType: "application/pdf" });
    await anon.storage.from(BUCKET).uploadToSignedUrl(t2.data.path, t2.data.token, new Blob([f2], { type: "application/pdf" }), { contentType: "application/pdf" });
    const [c1, c2] = await Promise.all([
      act(leadA, "completeUploadAction", { proposalId: propV, revision: t1.data.revision, expectedRevision: expected, fileName: "r1.pdf" }),
      act(leadA, "completeUploadAction", { proposalId: propV, revision: t2.data.revision, expectedRevision: expected, fileName: "r2.pdf" }),
    ]);
    const winners = [c1, c2].filter((r) => r.ok);
    const loser = [c1, c2].find((r) => !r.ok);
    check("two concurrent replacements: exactly one wins, the other is told to reload", winners.length === 1 && loser?.stale === true, `${c1.message} / ${c2.message}`);
    const after = await proposalRow(leadA, propV);
    const objects = await objectsUnder(`${leadA.id}/${propV}`);
    check(
      "after the race only the winner's original remains; old document and preview are cleaned up",
      objects.length === 1 && objects[0] === after.original_storage_path && !after.preview_storage_path,
      objects.join(","),
    );

    const stale = await saveOffer(leadA, propV, { freePages: "2", price: "10", currency: "USD" }, expected);
    const objectsAfterStale = await objectsUnder(`${leadA.id}/${propV}`);
    check("offer based on a replaced document is rejected as stale and leaves no preview file", !stale.ok && stale.stale && objectsAfterStale.length === 1, stale.message);

    const staleUpload = await uploadPdf(leadA, propV, await makePdf(3, "S"), { expectedRevision: expected });
    check("upload based on an outdated view is rejected as stale", !staleUpload.ok && staleUpload.stale === true, staleUpload.message);
    check("…and its file is removed", (await objectsUnder(`${leadA.id}/${propV}`)).length === 1);

    await saveOffer(leadA, propV, { freePages: "2", price: "10", currency: "USD" });
    const loaded = await act(leadA, "loadProposalSetupAction", propV);
    const args = { proposalId: propV, expectedPreviewRevision: loaded.data.preview.revision };
    const [g1, g2] = await Promise.all([act(leadA, "generateLinkAction", args), act(leadA, "generateLinkAction", args)]);
    const issued = [g1, g2].filter((r) => r.ok);
    check("two concurrent link generations: exactly one link is issued", issued.length === 1, `${g1.message} / ${g2.message}`);
    if (issued.length === 1) {
      const failedToken = [g1, g2].find((r) => !r.ok)?.data?.url;
      const page = await openLink(tokenOf(issued[0].data.url));
      check("…and that link resolves", page.html.includes(`Validation ${runId}`) && !failedToken);
    }
  }

  // --- Cross-lead isolation ----------------------------------------------------
  {
    const rowA = await proposalRow(leadA, propA);
    const tries = await Promise.all([
      act(leadB, "loadProposalSetupAction", propA),
      act(leadB, "prepareUploadAction", { proposalId: propA, sizeBytes: 1000 }),
      act(leadB, "completeUploadAction", { proposalId: propA, revision: randomUUID(), expectedRevision: null, fileName: "x.pdf" }),
      act(leadB, "saveOfferAction", { proposalId: propA, expectedRevision: rowA.original_storage_path.split("/")[2], freePages: "1", price: "1", currency: "USD" }),
      act(leadB, "generateLinkAction", { proposalId: propA, expectedPreviewRevision: rowA.preview_storage_path.split("/")[2] }),
      act(leadB, "revokeLinkAction", { proposalId: propA }),
    ]);
    check(
      "lead B cannot load, upload to, configure, link or revoke lead A's proposal",
      tries.every((r) => !r.ok && /could not be found/.test(r.message)),
      tries.map((r) => r.message).join(" | "),
    );
    const after = await proposalRow(leadA, propA);
    const { html } = await openLink(tokenA);
    check("lead A's proposal and link are unaffected", JSON.stringify(after) === JSON.stringify(rowA) && html.includes(`Proposal A ${runId}`));

    const storage = leadB.client.storage.from(BUCKET);
    const dl1 = await storage.download(rowA.original_storage_path);
    const dl2 = await storage.download(rowA.preview_storage_path);
    const signed = await storage.createSignedUrl(rowA.original_storage_path, 60);
    const upl = await storage.upload(`${leadA.id}/${propA}/${randomUUID()}/original.pdf`, await makePdf(2, "x"), { contentType: "application/pdf" });
    const signUp = await storage.createSignedUploadUrl(`${leadA.id}/${propA}/${randomUUID()}/original.pdf`);
    await storage.remove([rowA.original_storage_path, rowA.preview_storage_path]);
    const stillThere = await objectsUnder(`${leadA.id}/${propA}`);
    check(
      "lead B cannot read, sign, upload into or delete lead A's PDF objects",
      dl1.error && dl2.error && signed.error && upl.error && signUp.error &&
        stillThere.includes(rowA.original_storage_path) && stillThere.includes(rowA.preview_storage_path),
    );
    const ownDelete = await leadA.client.storage.from(BUCKET).remove([rowA.original_storage_path]);
    check(
      "even the owner cannot delete the document a proposal is using",
      (ownDelete.data ?? []).length === 0 && (await objectsUnder(`${leadA.id}/${propA}`)).includes(rowA.original_storage_path),
    );
  }

  // --- Three leads, three PDFs, three links; many links per lead ---------------
  {
    const titles = { A: `Alpha deck ${runId}`, B: `Bravo review ${runId}`, C: `Charlie pitch ${runId}` };
    const ids = {
      A: await prepared(leadA, titles.A, 4),
      B: await prepared(leadB, titles.B, 6),
      C: await prepared(leadC, titles.C, 8),
    };
    const links = {
      A: await generateLink(leadA, ids.A),
      B: await generateLink(leadB, ids.B),
      C: await generateLink(leadC, ids.C),
    };
    const tokens = Object.fromEntries(Object.entries(links).map(([k, v]) => [k, v.ok ? tokenOf(v.data.url) : ""]));
    check("three leads get three distinct links", new Set(Object.values(tokens)).size === 3 && Object.values(tokens).every(Boolean));
    let exclusive = true;
    for (const key of ["A", "B", "C"]) {
      const { html } = await openLink(tokens[key]);
      for (const other of ["A", "B", "C"]) {
        if (html.includes(titles[other]) !== (other === key)) exclusive = false;
      }
    }
    check("each link resolves only its own proposal's title", exclusive);

    const second = await prepared(leadA, `Alpha follow-up ${runId}`, 3);
    const secondLink = await generateLink(leadA, second);
    const secondToken = secondLink.ok ? tokenOf(secondLink.data.url) : "";
    check(
      "one lead's two proposals get two different links",
      secondLink.ok && secondToken !== tokens.A && secondToken !== tokenA &&
        (await openLink(secondToken)).html.includes(`Alpha follow-up ${runId}`),
    );
  }

  // --- Admin --------------------------------------------------------------------
  {
    const propB = await prepared(leadB, `Admin-managed ${runId}`, 5);
    const loaded = await act(admin, "loadProposalSetupAction", propB);
    check("admin can open a lead's proposal (with owner name)", loaded.ok && loaded.data.ownerName === leadB.fullName);
    const up = await uploadPdf(admin, propB, await makePdf(9, "adm"));
    const row = await proposalRow(leadB, propB);
    check("admin upload stays under the lead's owner folder", up.ok && row.original_storage_path.startsWith(`${leadB.id}/${propB}/`) && row.owner_id === leadB.id);
    const of = await saveOffer(admin, propB, { freePages: "4", price: "99.50", currency: "AED" });
    const link = await generateLink(admin, propB);
    const revoke = await act(admin, "revokeLinkAction", { proposalId: propB });
    check("admin can configure, link and revoke any proposal", of.ok && link.ok && revoke.ok);
  }

  // --- Anonymous access ------------------------------------------------------------
  {
    const rowA = await proposalRow(leadA, propA);
    const tables = await Promise.all(["proposals", "clients", "profiles", "payments", "proposal_list"].map((t) => anon.from(t).select("id").limit(1)));
    check("anon cannot read any table or list view", tables.every((r) => r.error || (r.data ?? []).length === 0));
    const dl = await anon.storage.from(BUCKET).download(rowA.original_storage_path);
    const dlp = await anon.storage.from(BUCKET).download(rowA.preview_storage_path);
    const list = await anon.storage.from(BUCKET).list(leadA.id);
    const pub = await fetch(`${API_URL}/storage/v1/object/public/${BUCKET}/${rowA.preview_storage_path}`);
    check(
      "anon cannot download originals or previews, list the bucket, or use public URLs",
      dl.error && dlp.error && (list.data ?? []).length === 0 && pub.status >= 400,
    );
    const resolved = await anon.rpc("resolve_proposal_link", { p_token: tokenA });
    const guess = await anon.rpc("resolve_proposal_link", { p_token: randomBytes(32).toString("base64url") });
    check(
      "anon link resolution returns only the title, and nothing for unknown tokens",
      resolved.data?.length === 1 && Object.keys(resolved.data[0]).join() === "title" && guess.data?.length === 0,
    );
    const hashGuess = await anon.rpc("resolve_proposal_link", { p_token: "a".repeat(64) });
    check("a token hash is not accepted as a link", (hashGuess.data ?? []).length === 0);
  }

  // --- Unauthenticated actions ---------------------------------------------------------
  {
    const res = await act(null, "prepareUploadAction", { proposalId: propA, sizeBytes: 1000 });
    check("signed-out server action calls are redirected to /login", !res.ok && /\/login/.test(res.redirectedTo ?? ""), res.message);
    // A valid session without an internal profile reaches the action itself.
    const outsider = await provisionUser("no-profile", null);
    const denied = await Promise.all(
      ["loadProposalSetupAction", "prepareUploadAction", "revokeLinkAction"].map((name) =>
        act(outsider, name, name === "loadProposalSetupAction" ? propA : { proposalId: propA, sizeBytes: 1000 }),
      ),
    );
    check(
      "server actions refuse users without an internal profile",
      denied.every((r) => !r.ok && /session has expired/.test(r.message)),
      denied.map((r) => r.message).join(" | "),
    );
  }

  return before;
}

async function cleanup() {
  for (const userId of created.users) {
    const paths = await objectsUnder(userId);
    if (paths.length) await trusted.storage.from(BUCKET).remove(paths);
  }
  if (created.users.length) {
    await trusted.from("proposals").delete().in("owner_id", created.users);
    await trusted.from("clients").delete().in("owner_id", created.users);
    await trusted.from("profiles").delete().in("id", created.users);
  }
  for (const id of created.users) await trusted.auth.admin.deleteUser(id);
}

let fatal = null;
let before = null;
try {
  before = await main();
} catch (error) {
  fatal = error;
} finally {
  await cleanup();
}

if (before) {
  const after = await snapshot();
  check("existing local accounts and data are unchanged", before === after);
  const leftovers = await Promise.all(created.users.map((id) => objectsUnder(id)));
  check("all disposable storage objects were removed", leftovers.every((l) => l.length === 0));
}

if (fatal) {
  console.error(`\nAborted: ${fatal.stack ?? fatal.message}`);
  process.exit(1);
}
const failed = results.filter((passed) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed === 0 ? 0 : 1);
