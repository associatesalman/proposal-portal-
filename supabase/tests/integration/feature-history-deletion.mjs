// Feature update checks: Team Lead display names, the private client view
// (no internal identity, synthetic locked-page placeholders, free-only
// preview bytes), Proposal History visibility and safe permanent deletion.
// Runs against a production build and the LOCAL Supabase stack:
//
//   npm run build && npx next start -p 3100            # another terminal
//   APP_URL=http://localhost:3100 npm run test:history
//
// Everything is created by disposable users (harness in lib/portal.mjs) and
// removed again; existing accounts, proposals and files are snapshotted and
// must be unchanged at the end. Only disposable proposals are deleted.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createServerClient } from "@supabase/ssr";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { runStorageCleanup } from "../../../scripts/storage-cleanup.mjs";
import { BUCKET, createHarness } from "./lib/portal.mjs";

const h = createHarness("fh");
const { APP_URL, API_URL, PUBLISHABLE_KEY, runId, trusted, anon, check, provisionUser, act, createDraft, publishProposal, objectsUnder } = h;

const require = createRequire(`${process.cwd()}/package.json`);
const { encodeReply } = require("next/dist/compiled/react-server-dom-turbopack/client.edge.js");
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node;
const dashboardActionIds = Object.fromEntries(
  Object.entries(manifest)
    .filter(([, v]) => v.filename?.endsWith("dashboard/actions.ts"))
    .map(([id, v]) => [v.exportedName, id]),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Calls a dashboard form action (useActionState signature) exactly like the
// browser does: [previousState, FormData] encoded with React's encodeReply.
async function formAct(user, name, fields) {
  const id = dashboardActionIds[name];
  if (!id) throw new Error(`action ${name} not in manifest`);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const body = await encodeReply([{ status: "idle" }, form]);
  const res = await fetch(`${APP_URL}/dashboard`, {
    method: "POST",
    headers: { ...(user?.cookie ? { cookie: user.cookie } : {}), "next-action": id, accept: "text/x-component", origin: APP_URL },
    body,
    redirect: "manual",
  });
  if (res.status !== 200) return { status: "error", message: `HTTP ${res.status}` };
  return parseFlight(await res.text()) ?? { status: "error", message: "no result" };
}

// The dashboard streams Suspense boundaries; reassemble them as the browser does.
// React numbers segments in hex (S:9, S:a, ...).
function assembleStreamedHtml(html) {
  const segments = new Map();
  html = html.replace(
    /<(?:div hidden|table hidden><tbody|table hidden><tr) id="S:([0-9a-f]+)">([\s\S]*?)<\/(?:div|tbody><\/table|tr><\/table)><script>\$RS\("S:\1","P:\1"\)<\/script>/g,
    (_, n, content) => {
      segments.set(n, content);
      return "";
    },
  );
  for (let pass = 0; pass < 10 && html.includes('<template id="P:'); pass++) {
    html = html.replace(/<template id="P:([0-9a-f]+)"><\/template>/g, (placeholder, n) => segments.get(n) ?? placeholder);
  }
  return html;
}

const decode = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const textOf = (fragment) => decode(fragment.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function dashboard(user, query = "") {
  const res = await fetch(`${APP_URL}/dashboard${query}`, { headers: { cookie: user.cookie }, redirect: "manual" });
  return assembleStreamedHtml(await res.text());
}

const rows = (html) => [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]).filter((r) => r.includes("data-label"));
const rowFor = (html, text) => rows(html).find((r) => decode(r).includes(text));
const cell = (row, label) => textOf(row?.match(new RegExp(`data-label="${label}"[^>]*>([\\s\\S]*?)</td>`))?.[1] ?? "");

// A brand-new session for the same user (logout/login).
async function freshSession(user) {
  const jar = new Map();
  const client = createServerClient(API_URL, PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`re-login: ${error.message}`);
  return { ...user, client, cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") };
}

// Page i says FREEMARK on free pages and LOCKEDMARK on locked ones; the
// document's own info dictionary names the author.
async function makePdf(label, pages, free, author) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([420, 595]);
    page.drawText(`${label} page ${i}`, { x: 30, y: 520, size: 24, font });
    page.drawText(`${i <= free ? "FREEMARK" : "LOCKEDMARK"}-${runId}`, { x: 30, y: 480, size: 18, font });
  }
  doc.setTitle(`ORIGINAL-TITLE-${runId}`);
  doc.setAuthor(author);
  return Buffer.from(await doc.save());
}

async function pdfText(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  const info = (await pdf.getMetadata()).info ?? {};
  await task.destroy();
  return { pages, info };
}

async function clientPage(token, headers = {}) {
  const res = await fetch(`${APP_URL}/p/${token}`, { headers, redirect: "manual" });
  return { res, text: await res.text() };
}

async function linkWorks(token) {
  const [{ text }, preview] = await Promise.all([
    clientPage(token),
    fetch(`${APP_URL}/p/${token}/preview`, { redirect: "manual" }),
  ]);
  await preview.arrayBuffer();
  return { page: assembleStreamedHtml(text).includes("data-preview-summary"), preview: preview.status === 200 };
}

const folderOf = (user, proposalId) => `${user.id}/${proposalId}`;

async function exists(id) {
  const { data } = await trusted.from("proposals").select("id").eq("id", id).maybeSingle();
  return Boolean(data);
}

async function uploadWithTicket(ticket, bytes) {
  const { error } = await anon.storage
    .from(BUCKET)
    .uploadToSignedUrl(ticket.path, ticket.token, new Blob([bytes], { type: "application/pdf" }), {
      contentType: "application/pdf",
    });
  return error ? { ok: false, message: error.message } : { ok: true };
}

const OFFER = { freePages: "2", price: "25.00", currency: "USD" };

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  const admin = await provisionUser("admin", "admin");
  const leadA = await provisionUser("lead-a", "team_lead");
  const leadB = await provisionUser("lead-b", "team_lead");
  const paymentIds = [];

  try {
    // 1. Display names ------------------------------------------------------
    const newName = `Fassih Test ${runId}`;
    {
      const renamed = await formAct(leadA, "updateDisplayNameAction", { fullName: `  ${newName}  ` });
      check("a team lead can update their display name", renamed.status === "success", JSON.stringify(renamed));
      const { data: profile } = await trusted.from("profiles").select("full_name, role").eq("id", leadA.id).single();
      check("the name is stored trimmed; the role is unchanged", profile.full_name === newName && profile.role === "team_lead");

      const header = (await dashboard(leadA)).match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
      check("the dashboard header shows the new name", decode(header).includes(newName) && !decode(header).includes(leadA.fullName));
      check("name and role are shown as separate elements", header.includes(`>${newName}</p>`) && header.includes(">Team Lead</span>"));

      const adminHtml = await dashboard(admin);
      check(
        "the CEO's Team Lead filter lists the new name",
        new RegExp(`<option value="${leadA.id}"[^>]*>${newName}</option>`).test(adminHtml),
      );

      // Forged extra fields are ignored: only the own full_name changes.
      const forged = await formAct(leadA, "updateDisplayNameAction", {
        fullName: newName,
        role: "admin",
        id: leadB.id,
        ownerId: leadB.id,
      });
      const { data: afterForge } = await trusted.from("profiles").select("id, full_name, role").in("id", [leadA.id, leadB.id]);
      const a = afterForge.find((p) => p.id === leadA.id);
      const b = afterForge.find((p) => p.id === leadB.id);
      check(
        "forged role/id fields can't change a role or another profile",
        forged.status === "success" && a.role === "team_lead" && b.full_name === leadB.fullName && b.role === "team_lead",
      );

      for (const [label, value] of [
        ["empty", "   "],
        ["control character", "Bad\u0007Name"],
        ["too long", "x".repeat(101)],
      ]) {
        const result = await formAct(leadA, "updateDisplayNameAction", { fullName: value });
        check(`a ${label} name is rejected by the server`, result.status === "error" && Boolean(result.fieldErrors?.fullName));
      }
      const signedOut = await formAct(null, "updateDisplayNameAction", { fullName: "Anon" });
      check("signed-out requests can't update a name", signedOut.status === "error");

      // Direct API attempts with the lead's own session (RLS + column grants).
      const roleChange = await leadA.client.from("profiles").update({ role: "admin" }).eq("id", leadA.id).select("id");
      check("the API refuses a role change", Boolean(roleChange.error));
      const otherRow = await leadA.client.from("profiles").update({ full_name: "Hijack" }).eq("id", leadB.id).select("id");
      check("the API can't rename another user", !otherRow.error && (otherRow.data ?? []).length === 0);
      const adminOther = await admin.client.from("profiles").update({ full_name: "Hijack" }).eq("id", leadA.id).select("id");
      check("the CEO can't rename a team lead through the API", !adminOther.error && (adminOther.data ?? []).length === 0);
      const { data: still } = await trusted.from("profiles").select("full_name, role").eq("id", leadA.id).single();
      check("the lead's profile is still the self-chosen name and role", still.full_name === newName && still.role === "team_lead");
    }

    // 2. Public client view: identity, placeholders, preview bytes ------------
    const pdf9 = await makePdf("Alpha", 9, 2, newName);
    const alpha = await publishProposal(leadA, { title: `Alpha Offer ${runId}`, pdf: pdf9, offer: OFFER });
    const bravo = await publishProposal(leadB, { title: `Bravo Offer ${runId}`, pdf: await makePdf("Bravo", 3, 1, leadB.fullName), offer: { ...OFFER, freePages: "1" } });
    {
      const { res, text } = await clientPage(alpha.token);
      const html = assembleStreamedHtml(text);
      const rsc = await (await fetch(`${APP_URL}/p/${alpha.token}`, { headers: { RSC: "1" } })).text();
      const preview = await fetch(`${APP_URL}/p/${alpha.token}/preview`);
      const previewBytes = Buffer.from(await preview.arrayBuffer());
      const headerValues = [...res.headers.values(), ...preview.headers.values()].join("\n");
      const forbidden = {
        "Team Lead name": newName,
        "original provisioned name": leadA.fullName,
        "Team Lead email": leadA.email,
        "owner id": leadA.id,
        "proposal id": alpha.id,
        "client id": alpha.client.id,
        "client name": alpha.client.name,
        "client email": alpha.client.email,
        "storage path": `${leadA.id}/`,
        "another proposal": `Bravo Offer ${runId}`,
        "the CEO's name": admin.fullName,
        "the real lead's name": "Fassih Team Lead",
      };
      for (const [label, value] of Object.entries(forbidden)) {
        check(
          `client page never exposes the ${label} (HTML, RSC payload, headers)`,
          !text.includes(value) && !html.includes(value) && !rsc.includes(value) && !headerValues.includes(value),
        );
      }
      check("client page metadata title is generic", /<title>Proposal<\/title>/.test(html));

      const offer = await anon.rpc("resolve_proposal_offer", { p_token: alpha.token });
      check(
        "the public resolver returns only display fields",
        JSON.stringify(Object.keys(offer.data?.[0] ?? {}).sort()) ===
          JSON.stringify(["currency", "free_preview_pages", "title", "total_pages", "unlock_price_minor"]),
      );

      const { pages, info } = await pdfText(previewBytes);
      check("preview bytes contain only the free pages", pages.length === 2 && pages.every((p) => p.includes(`FREEMARK-${runId}`)));
      check("preview bytes contain no locked page text", !pages.some((p) => p.includes("LOCKEDMARK")));
      check(
        "the generated preview doesn't copy the original's document info (author)",
        !String(info.Author ?? "").includes(newName) && !previewBytes.toString("latin1").includes(newName),
      );

      // Synthetic placeholders: page-shaped cards from the counts only.
      const placeholders = html.match(/<section[^>]*data-locked-pages[\s\S]*?<\/section>/)?.[0] ?? "";
      const cards = [...placeholders.matchAll(/data-locked-page="(\d+)"/g)].map((m) => Number(m[1]));
      check("locked pages are shown as placeholders, a few at a time", JSON.stringify(cards) === JSON.stringify([3, 4, 5, 6, 7, 8]), JSON.stringify(cards));
      check(
        "placeholders show document page numbers, a lock and 'Locked page'",
        /Page (?:<!-- -->)?3(?:<!-- -->)? <span[^>]*>of (?:<!-- -->)?9/.test(placeholders) &&
          (placeholders.match(/Locked page</g) ?? []).length === 6 &&
          placeholders.includes("Full access isn&#x27;t available yet."),
      );
      check(
        "placeholders contain no locked text, images, canvases or document URLs",
        !placeholders.includes("LOCKEDMARK") && !/<img|<canvas|<object|<iframe|preview|\.pdf/i.test(placeholders),
      );
      check("placeholder navigation offers the remaining locked pages", placeholders.includes("Next locked pages") && /Document pages (?:<!-- -->)?3/.test(placeholders));
      check("price and the payment-unavailable notice are kept", html.includes("data-price") && html.includes("Online payment will be available soon."));
      check("no checkout or unlock action exists", !/checkout|unlock now|<form/i.test(html.match(/<main[\s\S]*<\/main>/)?.[0] ?? ""));
    }

    // 3. Proposal History: visibility, filters, persistence -------------------
    const draftA = await createDraft(leadA, `Alpha Draft ${runId}`);
    const draftB = await createDraft(leadB, `Bravo Draft ${runId}`);
    {
      const historyA = await dashboard(leadA, "?tab=history");
      check("History tab is present and selected", /aria-current="page"[^>]*>[\s\S]{0,200}Proposal History/.test(historyA));
      const aRow = rowFor(historyA, `Alpha Offer ${runId}`);
      check("lead A's history lists their issued proposal", Boolean(aRow));
      check("lead A's history lists their draft", Boolean(rowFor(historyA, `Alpha Draft ${runId}`)));
      check("lead A's history doesn't contain lead B's proposals", !historyA.includes(`Bravo Offer ${runId}`) && !historyA.includes(`Bravo Draft ${runId}`));
      check("lead A's history has no Owner column", !/data-label="Owner"/.test(historyA));
      check("history shows status, PDF readiness, created and link-issued dates", cell(aRow, "Status") === "Active" && cell(aRow, "Document") === "Preview ready" && /\d{4}/.test(cell(aRow, "Created")) && /\d{4}/.test(cell(aRow, "Link issued")));
      check("a draft shows no link date", /No active link/.test(cell(rowFor(historyA, `Alpha Draft ${runId}`), "Link issued")));
      check("history explains that old links can't be recovered", decode(historyA).includes("an earlier link can't be shown or recovered"));

      const forgedOwner = await dashboard(leadA, `?tab=history&owner=${leadB.id}`);
      check("a team lead's owner parameter is ignored (no cross-lead history)", !forgedOwner.includes(`Bravo Offer ${runId}`) && forgedOwner.includes(`Alpha Offer ${runId}`));

      const drafts = await dashboard(leadA, "?tab=history&status=draft");
      check("status filter: drafts only", Boolean(rowFor(drafts, `Alpha Draft ${runId}`)) && !rowFor(drafts, `Alpha Offer ${runId}`));
      const active = await dashboard(leadA, "?tab=history&status=active");
      check("status filter: active only", Boolean(rowFor(active, `Alpha Offer ${runId}`)) && !rowFor(active, `Alpha Draft ${runId}`));

      const historyAdmin = await dashboard(admin, "?tab=history");
      const adminRow = rowFor(historyAdmin, `Alpha Offer ${runId}`);
      check("the CEO's history spans team leads", Boolean(adminRow) && Boolean(rowFor(historyAdmin, `Bravo Offer ${runId}`)));
      check("the CEO sees the updated owner name", cell(adminRow, "Owner") === newName);
      const onlyB = await dashboard(admin, `?tab=history&owner=${leadB.id}`);
      check("the CEO can filter history by team lead", Boolean(rowFor(onlyB, `Bravo Offer ${runId}`)) && !rowFor(onlyB, `Alpha Offer ${runId}`));

      const again = await dashboard(await freshSession(leadA), "?tab=history");
      check("history persists across refresh and logout/login", Boolean(rowFor(again, `Alpha Offer ${runId}`)) && Boolean(rowFor(again, `Alpha Draft ${runId}`)));
    }

    // 4. Cross-lead isolation for management and deletion ---------------------
    {
      const del = await formAct(leadA, "deleteProposalAction", { proposalId: bravo.id });
      check("lead A can't delete lead B's proposal", del.status === "error" && /could not be found/.test(del.message));
      const edit = await formAct(leadA, "updateProposalTitleAction", { proposalId: draftB.id, title: "Hijacked" });
      check("lead A can't edit lead B's proposal", edit.status === "error" && /could not be found/.test(edit.message));
      const manage = await act(leadA, "loadProposalSetupAction", bravo.id);
      check("lead A can't manage lead B's proposal", manage.ok === false);
      const guessed = await formAct(leadA, "deleteProposalAction", { proposalId: randomUUID() });
      check("a guessed id is 'not found'", guessed.status === "error" && /could not be found/.test(guessed.message));
      const malformed = await formAct(leadA, "deleteProposalAction", { proposalId: "../../etc" });
      check("a malformed id is 'not found'", malformed.status === "error" && /could not be found/.test(malformed.message));
      const signedOut = await formAct(null, "deleteProposalAction", { proposalId: alpha.id });
      check("signed-out deletion is refused", signedOut.status === "error" && (await exists(alpha.id)));
      check("lead B's proposal and files are intact", (await exists(bravo.id)) && (await objectsUnder(folderOf(leadB, bravo.id))).length === 2 && (await linkWorks(bravo.token)).page);
    }

    // 5. Payment-protected proposals can't be deleted --------------------------
    const paid = await publishProposal(leadA, { title: `Paid Offer ${runId}`, pdf: await makePdf("Paid", 3, 1, newName), offer: { ...OFFER, freePages: "1" } });
    {
      const { data: payment, error } = await trusted
        .from("payments")
        .insert({ proposal_id: paid.id, provider: "fake", amount_minor: 2500, currency: "USD" })
        .select("id")
        .single();
      if (error) throw new Error(`payment fixture: ${error.message}`);
      paymentIds.push(payment.id);
      const before = await objectsUnder(folderOf(leadA, paid.id));
      const result = await formAct(leadA, "deleteProposalAction", { proposalId: paid.id });
      check("a proposal with payment records is refused clearly", result.status === "error" && /payment records/.test(result.message));
      const { data: row } = await trusted.from("proposals").select("status, deletion_requested_at").eq("id", paid.id).single();
      check("the refused proposal is unchanged (still active, not marked)", row.status === "active" && row.deletion_requested_at === null);
      check("its link and files are untouched", (await linkWorks(paid.token)).page && JSON.stringify(await objectsUnder(folderOf(leadA, paid.id))) === JSON.stringify(before));
      const adminTry = await formAct(admin, "deleteProposalAction", { proposalId: paid.id });
      check("the CEO is refused too", adminTry.status === "error" && /payment records/.test(adminTry.message));
      const historyRow = rowFor(await dashboard(leadA, "?tab=history"), `Paid Offer ${runId}`);
      check("history shows it as kept, without a Delete button", /Kept: has payments/.test(historyRow ?? "") && !/aria-label="Delete proposal/.test(historyRow ?? ""));
      const { count } = await trusted.from("payments").select("id", { count: "exact", head: true }).eq("proposal_id", paid.id);
      check("the payment record is untouched", count === 1);
    }

    // 6. Successful deletion: link dies immediately, every object goes --------
    {
      // Re-issue the link (the first one is gone for good) and leave an
      // abandoned upload, so old revisions and stray uploads are covered.
      const firstToken = alpha.token;
      const revoked = await act(leadA, "revokeLinkAction", { proposalId: alpha.id });
      if (!revoked.ok) throw new Error(`revoke: ${revoked.message}`);
      const stray = await act(leadA, "prepareUploadAction", { proposalId: alpha.id, sizeBytes: pdf9.length });
      if (!stray.ok) throw new Error(`stray ticket: ${stray.message}`);
      await uploadWithTicket(stray.data, pdf9);
      const relinked = await act(leadA, "generateLinkAction", { proposalId: alpha.id, expectedPreviewRevision: revoked.data.preview.revision });
      if (!relinked.ok) throw new Error(`relink: ${relinked.message}`);
      const token = new URL(relinked.data.url).pathname.split("/").pop();
      check("a regenerated link replaces the old one (the old link stays dead)", !(await linkWorks(firstToken)).page && (await linkWorks(token)).page);

      const folder = folderOf(leadA, alpha.id);
      const objectsBefore = await objectsUnder(folder);
      const otherBefore = await objectsUnder(folderOf(leadA, paid.id));
      check("before deletion: original, preview and the abandoned upload are stored", objectsBefore.length === 3, JSON.stringify(objectsBefore));

      const result = await formAct(leadA, "deleteProposalAction", { proposalId: alpha.id });
      check("deletion reports success only after finishing", result.status === "success" && /permanently deleted/.test(result.message), JSON.stringify(result));
      const after = await linkWorks(token);
      check("the client link stops working immediately (page and preview)", !after.page && !after.preview);
      check("every object of the proposal is removed", (await objectsUnder(folder)).length === 0);
      check("the proposal record is removed", !(await exists(alpha.id)));
      const { data: clientRow } = await trusted.from("clients").select("id").eq("id", alpha.client.id).maybeSingle();
      check("the client record is kept", Boolean(clientRow));
      check(
        "other proposals and their files are untouched",
        (await exists(paid.id)) && (await exists(draftA.id)) && (await exists(bravo.id)) &&
          JSON.stringify(await objectsUnder(folderOf(leadA, paid.id))) === JSON.stringify(otherBefore) &&
          (await objectsUnder(folderOf(leadB, bravo.id))).length === 2,
      );
      const repeat = await formAct(leadA, "deleteProposalAction", { proposalId: alpha.id });
      check("repeating the deletion is a clean 'not found'", repeat.status === "error" && /could not be found/.test(repeat.message));
      check("history no longer lists it", !rowFor(await dashboard(leadA, "?tab=history"), `Alpha Offer ${runId}`));
    }

    // 7. Interrupted deletion: frozen, hidden, and safely retryable -----------
    {
      const gamma = await publishProposal(leadA, { title: `Gamma Offer ${runId}`, pdf: await makePdf("Gamma", 4, 2, newName), offer: OFFER });
      const lateTicket = await act(leadA, "prepareUploadAction", { proposalId: gamma.id, sizeBytes: 1000 });
      check("upload tickets need a draft (active proposals are locked)", lateTicket.ok === false);

      // Simulate a crash right after step 1 (mark + revoke) of the workflow.
      const begun = await trusted.rpc("proposal_begin_deletion", { p_actor: leadA.id, p_proposal_id: gamma.id });
      if (begun.error) throw new Error(`begin: ${begun.error.message}`);
      check("an interrupted deletion has already disabled the link", !(await linkWorks(gamma.token)).page);

      const history = await dashboard(leadA, "?tab=history");
      const row = rowFor(history, `Gamma Offer ${runId}`);
      check("history shows 'Deletion pending' with a retry", cell(row, "Status") === "Deletion pending" && /Retry deleting proposal/.test(row ?? ""));
      check("Manage Document is hidden for a deleting proposal", !/Manage Document/.test(row ?? ""));
      check("the Proposals tab marks it as being deleted", /Being deleted/.test(rowFor(await dashboard(leadA, "?tab=proposals"), `Gamma Offer ${runId}`) ?? ""));

      const relink = await act(leadA, "generateLinkAction", { proposalId: gamma.id, expectedPreviewRevision: randomUUID() });
      const upload = await act(leadA, "prepareUploadAction", { proposalId: gamma.id, sizeBytes: 1000 });
      const offer = await act(leadA, "saveOfferAction", { proposalId: gamma.id, expectedRevision: randomUUID(), ...OFFER });
      const title = await formAct(leadA, "updateProposalTitleAction", { proposalId: gamma.id, title: "Renamed" });
      check("no new link while deleting", relink.ok === false && /being deleted/.test(relink.message));
      check("no new upload while deleting", upload.ok === false && /being deleted/.test(upload.message));
      check("no offer edit while deleting", offer.ok === false && /being deleted/.test(offer.message));
      check("no title edit while deleting", title.status === "error" && /being deleted/.test(title.message));
      const reactivate = await trusted.from("proposals").update({ status: "active" }).eq("id", gamma.id);
      check("even the service role can't make it public again", Boolean(reactivate.error));

      const retry = await formAct(leadA, "deleteProposalAction", { proposalId: gamma.id });
      check("retrying finishes the deletion", retry.status === "success", JSON.stringify(retry));
      check("after the retry, nothing of it remains", !(await exists(gamma.id)) && (await objectsUnder(folderOf(leadA, gamma.id))).length === 0);
    }

    // 8. In-flight uploads and concurrent actions ------------------------------
    {
      // A ticket issued BEFORE deletion starts, used after it finished.
      const delta = await createDraft(leadA, `Delta Draft ${runId}`);
      const pdf = await makePdf("Delta", 3, 1, newName);
      const ticket = await act(leadA, "prepareUploadAction", { proposalId: delta.id, sizeBytes: pdf.length });
      if (!ticket.ok) throw new Error(`delta ticket: ${ticket.message}`);
      const deleted = await formAct(leadA, "deleteProposalAction", { proposalId: delta.id });
      check("a draft with an outstanding upload ticket can be deleted", deleted.status === "success");
      const late = await uploadWithTicket(ticket.data, pdf);
      const lateObjects = await objectsUnder(folderOf(leadA, delta.id));
      console.log(`       (observed: a signed upload URL issued before deletion ${late.ok ? "still uploads" : "is refused"} after it)`);
      if (late.ok) {
        check("a late upload lands only in the deleted proposal's folder", lateObjects.length === 1);
        const dry = await runStorageCleanup(trusted, { prefix: `${folderOf(leadA, delta.id)}/`, olderThanHours: 24, now: new Date(Date.now() + 25 * 3600 * 1000) });
        check("the cleanup utility classifies the late upload as an orphan", dry.counts.orphan === 1 && dry.candidateNames?.[0] === lateObjects[0], JSON.stringify(dry.counts));
        const applied = await runStorageCleanup(trusted, { prefix: `${folderOf(leadA, delta.id)}/`, olderThanHours: 24, now: new Date(Date.now() + 25 * 3600 * 1000), apply: true });
        check("the cleanup utility removes it", applied.deleted === 1 && (await objectsUnder(folderOf(leadA, delta.id))).length === 0);
      } else {
        check("a late upload is refused", lateObjects.length === 0);
      }
      const complete = await act(leadA, "completeUploadAction", { proposalId: delta.id, revision: ticket.data.revision, expectedRevision: null, fileName: "x.pdf" });
      check("completing a late upload is refused", complete.ok === false);

      // Deletion racing link generation, uploads and title edits.
      for (let round = 1; round <= 3; round++) {
        const target = await publishProposal(leadA, { title: `Race ${round} ${runId}`, pdf, offer: { ...OFFER, freePages: "1" } });
        const revoked = await act(leadA, "revokeLinkAction", { proposalId: target.id });
        if (!revoked.ok) throw new Error(`race revoke: ${revoked.message}`);
        const racers = [
          () => act(leadA, "generateLinkAction", { proposalId: target.id, expectedPreviewRevision: revoked.data.preview.revision }),
          () => act(leadA, "prepareUploadAction", { proposalId: target.id, sizeBytes: pdf.length }),
          () => formAct(leadA, "updateProposalTitleAction", { proposalId: target.id, title: `Race ${round} renamed` }),
          () => formAct(leadA, "deleteProposalAction", { proposalId: target.id }),
        ];
        if (round === 2) racers.reverse();
        const results = await Promise.all(racers.map((run) => run()));
        const [link, ticketResult] = round === 2 ? [results[3], results[2]] : [results[0], results[1]];
        const deletion = round === 2 ? results[0] : results[3];
        if (ticketResult.ok) await uploadWithTicket(ticketResult.data, pdf);
        let finished = deletion.status === "success";
        if (!finished) {
          // A racing upload may land between listing and the final step: the
          // workflow stops (retryable) and a retry completes it.
          const again = await formAct(leadA, "deleteProposalAction", { proposalId: target.id });
          finished = again.status === "success";
        }
        if (finished && (await objectsUnder(folderOf(leadA, target.id))).length > 0) {
          // A late upload after the row was removed is an orphan for cleanup.
          await runStorageCleanup(trusted, { prefix: `${folderOf(leadA, target.id)}/`, olderThanHours: 24, now: new Date(Date.now() + 25 * 3600 * 1000), apply: true });
        }
        const linkToken = link.ok ? new URL(link.data.url).pathname.split("/").pop() : null;
        check(
          `race ${round}: deletion completes and no racing action makes it public`,
          finished && !(await exists(target.id)) && (!linkToken || !(await linkWorks(linkToken)).page) &&
            (await objectsUnder(folderOf(leadA, target.id))).length === 0,
          JSON.stringify({ deletion: deletion.message, link: link.ok, ticket: ticketResult.ok }),
        );
      }

      // Two deletions at once: one does the work, the other sees it finished.
      const twin = await publishProposal(leadA, { title: `Twin ${runId}`, pdf, offer: { ...OFFER, freePages: "1" } });
      const [first, second] = await Promise.all([
        formAct(leadA, "deleteProposalAction", { proposalId: twin.id }),
        formAct(admin, "deleteProposalAction", { proposalId: twin.id }),
      ]);
      const outcomes = [first, second].map((r) => r.status);
      check(
        "concurrent deletions: both report a finished deletion, nothing remains",
        outcomes.every((o) => o === "success") && !(await exists(twin.id)) && (await objectsUnder(folderOf(leadA, twin.id))).length === 0,
        JSON.stringify([first.message, second.message]),
      );
    }

    // 9. The CEO deletes a team lead's proposal --------------------------------
    {
      const result = await formAct(admin, "deleteProposalAction", { proposalId: bravo.id });
      check("the CEO can delete a team lead's proposal", result.status === "success");
      check(
        "only that proposal is removed",
        !(await exists(bravo.id)) && (await exists(draftB.id)) && (await objectsUnder(folderOf(leadB, bravo.id))).length === 0 && !(await linkWorks(bravo.token)).page,
      );
    }
  } finally {
    // Payment fixtures first: the payments FK restricts proposal deletion.
    if (paymentIds.length) await trusted.from("payments").delete().in("id", paymentIds);
  }
}

await h.run(main);
