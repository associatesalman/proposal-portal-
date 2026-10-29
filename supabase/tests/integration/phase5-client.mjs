// Phase 5 checks: client proposal page and secure preview delivery, against
// a running production build and the LOCAL Supabase stack.
//
//   npm run db:start
//   npm run build && npx next start -p 3100 > server.log   # another terminal
//   APP_URL=http://localhost:3100 SERVER_LOG=server.log npm run test:client
//
// Fixtures are generated PDFs with distinctive text on every page: free
// pages say FREEMARK, locked pages say LOCKEDMARK. The delivered preview
// bytes are parsed with PDF.js (the library the viewer uses) and every
// page's text is checked. Proposals are prepared through the dashboard's
// real server actions as disposable team leads; the client side is
// exercised anonymously (plain fetch, publishable key), exactly as a
// client's browser would.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { BUCKET, createHarness } from "./lib/portal.mjs";

const h = createHarness("phase5");
const { APP_URL, API_URL, PUBLISHABLE_KEY, runId, trusted, anon, check } = h;

const require = createRequire(`${process.cwd()}/package.json`);
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

const UNAVAILABLE_PAGE = "This link isn&#x27;t available";

// ---------------------------------------------------------------------------
// Fixtures and inspection
// ---------------------------------------------------------------------------

// Page i says "<label> page i FREEMARK-<run>" when i <= free, otherwise
// "<label> page i LOCKEDMARK-<run>", in large text so it is easy to see.
async function makePdf(label, pages, free) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([420, 595]);
    const kind = i <= free ? "FREEMARK" : "LOCKEDMARK";
    page.drawText(`${label} page ${i}`, { x: 30, y: 520, size: 24, font });
    page.drawText(`${kind}-${runId}`, { x: 30, y: 480, size: 18, font });
  }
  doc.setTitle(`ORIGINAL-TITLE-${label}-${runId}`);
  return Buffer.from(await doc.save());
}

async function pdfText(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const text = await page.getTextContent();
    pages.push(text.items.map((item) => item.str).join(" "));
  }
  await task.destroy();
  return pages;
}

// Every stream inflated (where possible) plus the raw bytes, as latin1 text,
// for byte-level searches that don't depend on a PDF parser.
function allDecodedContent(bytes) {
  const text = bytes.toString("latin1");
  const parts = [text];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    try {
      parts.push(inflateSync(bytes.subarray(start, end)).toString("latin1"));
    } catch {
      // not Flate-encoded
    }
  }
  return parts.join("\n");
}

function hexOf(text) {
  return Buffer.from(text, "latin1").toString("hex").toUpperCase();
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function getPage(token) {
  const res = await fetch(`${APP_URL}/p/${token}`, { redirect: "manual" });
  return { res, html: await res.text() };
}

async function getPreview(token, suffix = "") {
  const res = await fetch(`${APP_URL}/p/${token}/preview${suffix}`, { redirect: "manual" });
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

const randomToken = () => randomBytes(32).toString("base64url");

// Visible text of a server-rendered page (tags and React's text separators
// removed, whitespace collapsed).
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

await h.run(async () => {
  const leadA = await h.provisionUser("lead-a", "team_lead");
  const leadB = await h.provisionUser("lead-b", "team_lead");
  const leadC = await h.provisionUser("lead-c", "team_lead");

  const originals = {
    A: await makePdf("Alpha", 5, 2),
    B: await makePdf("Bravo", 4, 3),
    C: await makePdf("Charlie", 3, 1),
  };
  const A = await h.publishProposal(leadA, {
    title: `Alpha proposal ${runId}`,
    pdf: originals.A,
    fileName: `alpha-original-${runId}.pdf`,
    offer: { freePages: "2", price: "25.00", currency: "EUR" },
  });
  const B = await h.publishProposal(leadB, {
    title: `Bravo proposal ${runId}`,
    pdf: originals.B,
    fileName: `bravo-original-${runId}.pdf`,
    offer: { freePages: "3", price: "1500", currency: "JPY" },
  });
  const C = await h.publishProposal(leadC, {
    title: `Charlie proposal ${runId}`,
    pdf: originals.C,
    fileName: `charlie-original-${runId}.pdf`,
    offer: { freePages: "1", price: "19.99", currency: "USD" },
  });
  const all = { A, B, C };
  const tokens = [A.token, B.token, C.token];

  // --- Client page --------------------------------------------------------
  {
    const { res, html } = await getPage(A.token);
    check("valid link: page loads (200)", res.status === 200);
    check("page shows the proposal title", html.includes(`Alpha proposal ${runId}`));
    check("page shows 'Free preview: 2 of 5 pages.'", visibleText(html).includes("Free preview: 2 of 5 pages."));
    check(
      "page shows preview, total and locked page counts",
      /Preview pages<\/dt><dd[^>]*>2</.test(html) && /Total pages<\/dt><dd[^>]*>5</.test(html) && /Locked pages<\/dt><dd[^>]*>3</.test(html),
    );
    check("locked notice names the locked range (pages 3–5)", html.includes("Pages 3–5 of 5 are not included in this preview."));
    check("price is formatted with its currency (€25.00, EUR)", html.includes("€25.00") && html.includes("EUR"));
    check("payment is announced as not available yet", html.includes("Online payment will be available soon."));
    check(
      "no payment button or form is rendered",
      !/<form/i.test(html) && !/<button[^>]*>[^<]*(pay|buy|unlock|checkout)/i.test(html),
    );
    check("page points the viewer at its own preview endpoint", html.includes(`/p/${A.token}/preview`));
    check(
      "page response is private, no-store, no-referrer, noindex",
      /no-store/.test(res.headers.get("cache-control") ?? "") &&
        res.headers.get("referrer-policy") === "no-referrer" &&
        /noindex/.test(res.headers.get("x-robots-tag") ?? "") &&
        /<meta name="robots" content="noindex/.test(html),
    );
    const leaks = [
      ["proposal id", A.id],
      ["owner id", A.row.owner_id],
      ["client email", A.client.email],
      ["client name", A.client.name],
      ["owner name", leadA.fullName],
      ["original storage path", A.row.original_storage_path],
      ["preview storage path", A.row.preview_storage_path],
      ["original file name", A.row.original_file_name],
      ["token hash", sha(A.token)],
      ["storage API URL", API_URL],
      ["original.pdf", "original.pdf"],
      ["storage object route", "/storage/v1/"],
    ].filter(([, value]) => html.includes(value));
    check("page exposes no ids, client/owner details, paths, hashes or storage URLs", leaks.length === 0, leaks.map(([n]) => n).join(", "));
  }
  {
    const { html } = await getPage(B.token);
    check("JPY price shows whole yen (¥1,500, JPY)", html.includes("¥1,500") && html.includes("JPY"));
    const text = visibleText(html);
    check("one locked page uses the singular notice", text.includes("Page 4 of 4 is not included in this preview.") && text.includes("1 page is locked"));
  }

  // --- Preview delivery -----------------------------------------------------
  const previews = {};
  for (const [key, p] of Object.entries(all)) {
    const { res, bytes } = await getPreview(p.token);
    previews[key] = { res, bytes };
  }
  {
    const { res, bytes } = previews.A;
    check("preview endpoint returns a PDF (200, application/pdf)", res.status === 200 && res.headers.get("content-type") === "application/pdf" && bytes.subarray(0, 5).toString() === "%PDF-");
    check(
      "preview response is private, no-store, no-referrer, noindex, nosniff, same-origin",
      /no-store/.test(res.headers.get("cache-control") ?? "") &&
        !/public/.test(res.headers.get("cache-control") ?? "") &&
        res.headers.get("referrer-policy") === "no-referrer" &&
        /noindex/.test(res.headers.get("x-robots-tag") ?? "") &&
        res.headers.get("x-content-type-options") === "nosniff" &&
        res.headers.get("cross-origin-resource-policy") === "same-origin",
    );
    check("preview is inline, not an attachment of the original's name", (res.headers.get("content-disposition") ?? "") === 'inline; filename="preview.pdf"');
  }

  const expected = { A: [5, 2, "Alpha"], B: [4, 3, "Bravo"], C: [3, 1, "Charlie"] };
  for (const [key, [total, free, label]] of Object.entries(expected)) {
    const { bytes } = previews[key];
    const pages = await pdfText(bytes);
    check(`${label}: delivered preview has exactly ${free} page(s)`, pages.length === free, `got ${pages.length}`);
    check(
      `${label}: preview pages are pages 1–${free} with their free-page text`,
      pages.every((text, i) => text.includes(`${label} page ${i + 1}`) && text.includes(`FREEMARK-${runId}`)),
    );
    check(`${label}: no locked-page text in the delivered preview (PDF.js text)`, pages.every((text) => !text.includes("LOCKEDMARK")));
    const decoded = allDecodedContent(bytes);
    const lockedLabels = Array.from({ length: total - free }, (_, i) => `${label} page ${free + i + 1}`);
    check(
      `${label}: no locked-page text in the raw or inflated bytes (literal or hex)`,
      !decoded.includes("LOCKEDMARK") &&
        !decoded.includes(hexOf("LOCKEDMARK")) &&
        lockedLabels.every((l) => !decoded.includes(l) && !decoded.includes(hexOf(l))),
    );
    check(`${label}: preview carries no original title metadata`, !decoded.includes(`ORIGINAL-TITLE-${label}`));
    check(`${label}: delivered bytes are not the original`, sha(bytes) !== sha(originals[key]) && bytes.length !== originals[key].length);
  }
  {
    const control = await pdfText(originals.A);
    check("control: the original does contain LOCKEDMARK text (the check above is meaningful)", control.some((t) => t.includes("LOCKEDMARK")));
  }
  {
    const shas = new Set(Object.values(previews).map((p) => sha(p.bytes)));
    const own = await Promise.all(
      Object.entries(previews).map(async ([key, p]) => {
        const text = (await pdfText(p.bytes)).join(" ");
        const others = Object.values(expected).map(([, , l]) => l).filter((l) => l !== expected[key][2]);
        return text.includes(expected[key][2]) && others.every((l) => !text.includes(l));
      }),
    );
    check("three links deliver three different previews", shas.size === 3);
    check("each link's preview contains only its own proposal's pages", own.every(Boolean));
    const stored = await Promise.all(
      Object.values(all).map(async (p) => {
        const { data } = await trusted.storage.from(BUCKET).download(p.row.preview_storage_path);
        return sha(Buffer.from(await data.arrayBuffer()));
      }),
    );
    check("each delivered preview is byte-identical to that proposal's stored preview object", Object.values(previews).every((p, i) => sha(p.bytes) === stored[i]));
  }

  // --- Tampering: the token is the only input ------------------------------
  {
    const shaA = sha(previews.A.bytes);
    const attempts = [
      `?path=${encodeURIComponent(B.row.original_storage_path)}`,
      `?path=${encodeURIComponent(B.row.preview_storage_path)}`,
      `?id=${B.id}&proposal=${B.id}&token=${B.token}`,
      `?kind=original&file=original.pdf`,
    ];
    const results = await Promise.all(attempts.map((q) => getPreview(A.token, q)));
    check(
      "query parameters (path, id, token, kind) are ignored: link A still gets exactly A's preview",
      results.every(({ res, bytes }) => res.status === 200 && sha(bytes) === shaA),
    );
    const routes = [
      `/p/${A.token}/original`,
      `/p/${A.token}/preview/original`,
      `/p/${A.token}/preview/../original`,
      `/p/${A.token}/document`,
      `/p/${encodeURIComponent(A.row.original_storage_path)}/preview`,
      `/p/${encodeURIComponent(B.row.preview_storage_path)}`,
      `/p/${B.id}/preview`,
      `/p/${sha(A.token)}/preview`,
      `/api/access/${A.token}/document`,
      `/api/access/${A.token}/preview`,
    ];
    const routeResults = await Promise.all(
      routes.map(async (r) => {
        const res = await fetch(`${APP_URL}${r}`, { redirect: "manual" });
        const body = Buffer.from(await res.arrayBuffer());
        return { r, status: res.status, pdf: body.subarray(0, 5).toString() === "%PDF-", body };
      }),
    );
    const served = routeResults.filter((x) => x.pdf || x.status === 200 && x.body.includes(`Alpha proposal ${runId}`) && !x.r.endsWith("/preview"));
    check("guessed routes (original, document, path- or id-based) never serve a PDF", routeResults.every((x) => !x.pdf), served.map((x) => x.r).join(", "));
    const flipped = A.token.slice(0, -1) + (A.token.endsWith("A") ? "B" : "A");
    const flippedPreview = await getPreview(flipped);
    const flippedPage = await getPage(flipped);
    check("a one-character change to the token gets the generic 404 / unavailable page", flippedPreview.res.status === 404 && flippedPage.html.includes(UNAVAILABLE_PAGE) && !flippedPage.html.includes(runId));
    const post = await fetch(`${APP_URL}/p/${A.token}/preview`, { method: "POST", body: B.row.original_storage_path });
    check("non-GET methods are rejected (405)", post.status === 405);
  }

  // --- Anonymous storage and database access stays closed -------------------
  {
    const paths = Object.values(all).flatMap((p) => [p.row.original_storage_path, p.row.preview_storage_path]);
    const downloads = await Promise.all(paths.map((p) => anon.storage.from(BUCKET).download(p)));
    check("anon cannot download any original or preview object", downloads.every((d) => d.error && !d.data));
    const signed = await Promise.all(paths.map((p) => anon.storage.from(BUCKET).createSignedUrl(p, 60)));
    check("anon cannot create signed URLs for originals or previews", signed.every((s) => s.error && !s.data?.signedUrl));
    const publicUrls = await Promise.all(
      paths.map((p) => fetch(`${API_URL}/storage/v1/object/public/${BUCKET}/${p}`).then((r) => r.status)),
    );
    check("public object URLs don't work (bucket stays private)", publicUrls.every((s) => s >= 400));
    const authed = await Promise.all(
      paths.map((p) =>
        fetch(`${API_URL}/storage/v1/object/authenticated/${BUCKET}/${p}`, {
          headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${PUBLISHABLE_KEY}` },
        }).then((r) => r.status),
      ),
    );
    check("anon key can't read objects through the authenticated object route", authed.every((s) => s >= 400));
    const { data: listed } = await anon.storage.from(BUCKET).list(A.row.owner_id);
    check("anon can't list the bucket", !listed || listed.length === 0);

    const pathRpc = await anon.rpc("resolve_proposal_preview_object", { p_token: A.token });
    check("anon can't call the preview-path resolver", !!pathRpc.error && !pathRpc.data);
    const leadPathRpc = await leadB.client.rpc("resolve_proposal_preview_object", { p_token: A.token });
    check("signed-in leads can't call the preview-path resolver either", !!leadPathRpc.error && !leadPathRpc.data);
    const offer = await anon.rpc("resolve_proposal_offer", { p_token: A.token });
    check(
      "anon offer resolver returns only the five display fields",
      !offer.error &&
        offer.data?.length === 1 &&
        JSON.stringify(Object.keys(offer.data[0]).sort()) ===
          JSON.stringify(["currency", "free_preview_pages", "title", "total_pages", "unlock_price_minor"]),
    );
    const byHash = await anon.rpc("resolve_proposal_offer", { p_token: sha(A.token) });
    check("the offer resolver doesn't accept a token hash", !byHash.error && byHash.data.length === 0);
    const tables = await Promise.all(
      ["proposals", "clients", "profiles", "payments", "proposal_list", "client_list"].map((t) =>
        anon.from(t).select("*").limit(1),
      ),
    );
    check("anon still can't read any table or view", tables.every((r) => r.error || (r.data ?? []).length === 0));

    // Every public response seen so far: no original bytes, paths or signed URLs.
    const bodies = [
      ...(await Promise.all(tokens.map(async (t) => (await getPage(t)).html))),
      ...Object.values(previews).map((p) => p.bytes.toString("latin1")),
    ].join("\n");
    check(
      "public responses contain no original paths, storage URLs or signed-URL tokens",
      !bodies.includes("original.pdf") &&
        !bodies.includes("/storage/v1/") &&
        !/[?&]token=ey/.test(bodies) &&
        Object.values(all).every((p) => !bodies.includes(p.row.original_storage_path)),
    );
  }

  // --- Invalid / inactive / revoked ------------------------------------------
  {
    const invalid = ["short", "x".repeat(44), `${"A".repeat(42)}!`, randomToken(), randomToken()];
    const pages = await Promise.all(invalid.map((t) => getPage(encodeURIComponent(t))));
    const previewsInvalid = await Promise.all(invalid.map((t) => getPreview(encodeURIComponent(t))));
    check(
      "malformed and unknown tokens: generic unavailable page, no details",
      pages.every(({ res, html }) => res.status === 200 && html.includes(UNAVAILABLE_PAGE) && !html.includes("Free preview")),
    );
    const bodies = new Set(previewsInvalid.map((p) => `${p.res.status}:${p.bytes.toString()}`));
    check("malformed and unknown tokens: identical generic 404 from the preview endpoint", bodies.size === 1 && previewsInvalid[0].res.status === 404);

    // Revocation: blocks the next preview request and the page on reload.
    const before = await getPreview(C.token);
    const revoke = await h.act(leadC, "revokeLinkAction", { proposalId: C.id });
    const afterPreview = await getPreview(C.token);
    const afterPage = await getPage(C.token);
    check("before revocation the preview is served", before.res.status === 200);
    check("revoking succeeds and returns the proposal to draft", revoke.ok === true && (await h.proposalRow(leadC, C.id)).status === "draft");
    check(
      "after revocation the very next preview request gets the same generic 404",
      afterPreview.res.status === 404 && `${afterPreview.res.status}:${afterPreview.bytes.toString()}` === [...bodies][0],
    );
    check("after revocation the page shows the generic unavailable state on reload", afterPage.html.includes(UNAVAILABLE_PAGE) && !afterPage.html.includes(`Charlie proposal ${runId}`));
    const offerAfter = await anon.rpc("resolve_proposal_offer", { p_token: C.token });
    check("after revocation the offer resolver returns nothing", !offerAfter.error && offerAfter.data.length === 0);

    // A draft that never had a link (inactive) can't be reached either.
    const draft = await h.createDraft(leadC, `Never linked ${runId}`);
    const draftAttempt = await getPage(draft.id);
    check("inactive draft: unreachable by id", draftAttempt.html.includes(UNAVAILABLE_PAGE));

    // Re-issuing creates a new token; the old one stays dead.
    const loaded = await h.act(leadC, "loadProposalSetupAction", C.id);
    const relink = await h.act(leadC, "generateLinkAction", {
      proposalId: C.id,
      expectedPreviewRevision: loaded.data.preview.revision,
    });
    const newToken = new URL(relink.data.url).pathname.split("/").pop();
    const fresh = await getPreview(newToken);
    const stale = await getPreview(C.token);
    check("a regenerated link serves the preview; the old link stays unavailable", fresh.res.status === 200 && stale.res.status === 404);
    tokens.push(newToken);
  }

  // --- Missing preview object and recovery ---------------------------------
  {
    const path = B.row.preview_storage_path;
    const { data: saved } = await trusted.storage.from(BUCKET).download(path);
    const savedBytes = Buffer.from(await saved.arrayBuffer());
    // Fixture manipulation only (secret key): simulate a lost object.
    await trusted.storage.from(BUCKET).remove([path]);
    const missing = await getPreview(B.token);
    const pageStill = await getPage(B.token);
    check(
      "missing preview object: 503 with Retry-After and a generic message",
      missing.res.status === 503 &&
        missing.res.headers.get("retry-after") === "5" &&
        missing.bytes.toString() === "The preview is temporarily unavailable." &&
        /no-store/.test(missing.res.headers.get("cache-control") ?? ""),
    );
    check("missing preview object: response reveals no path or storage detail", !missing.bytes.toString().includes(path) && !/storage|bucket|NoSuchKey/i.test(missing.bytes.toString()));
    check("missing preview object: the page itself still loads (viewer shows the retry state)", pageStill.res.status === 200 && pageStill.html.includes(`Bravo proposal ${runId}`));
    await trusted.storage.from(BUCKET).upload(path, new Blob([savedBytes], { type: "application/pdf" }), {
      contentType: "application/pdf",
    });
    const recovered = await getPreview(B.token);
    check("after the object is restored, a retry gets the preview again", recovered.res.status === 200 && sha(recovered.bytes) === sha(savedBytes));
  }

  // --- Logs ----------------------------------------------------------------
  if (process.env.SERVER_LOG) {
    const log = readFileSync(process.env.SERVER_LOG, "utf8");
    check("server log contains no link tokens", tokens.every((t) => !log.includes(t)));
    check("server log contains no storage paths", Object.values(all).every((p) => !log.includes(p.row.original_storage_path) && !log.includes(p.row.preview_storage_path)));
  } else {
    console.log("skip   server log checks (set SERVER_LOG to the server's output file)");
  }
});
