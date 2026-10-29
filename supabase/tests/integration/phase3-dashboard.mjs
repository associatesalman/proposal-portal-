// Phase 3 dashboard workflow checks against a running app + LOCAL Supabase.
//
//   npm run db:start
//   npm run build && npm run start      # in another terminal (uses .env.local)
//   npm run test:dashboard
//
// Disposable users sign in through Supabase Auth (same cookie format as the
// app). Dashboard forms are submitted exactly as rendered (server actions,
// no-JS submission), sometimes with forged fields injected. Results are
// verified through authenticated, RLS-scoped reads. The local secret key is
// used only to provision/clean up disposable users and to archive one
// proposal as a fixture (no UI exists for that yet).

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const status = JSON.parse(
  execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString(),
);
const API_URL = status.API_URL;
const PUBLISHABLE_KEY = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const SECRET_KEY = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;

for (const url of [API_URL, APP_URL]) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`Refusing to run against non-local host (${host}).`);
    process.exit(2);
  }
}

const runId = randomBytes(3).toString("hex");
const trusted = createClient(API_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const created = { userIds: [] };
const results = [];

function check(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}${!passed && detail ? ` — ${detail}` : ""}`);
}

// --- Users -------------------------------------------------------------------

async function provisionUser(label, role) {
  const email = `p3-${label}-${runId}@test.local`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await trusted.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  created.userIds.push(data.user.id);
  const fullName = `P3 ${label} ${runId}`;
  const { error: pe } = await trusted
    .from("profiles")
    .insert({ id: data.user.id, full_name: fullName, role });
  if (pe) throw new Error(`profile ${label}: ${pe.message}`);

  // Cookie session (as the app's browser would hold) + an RLS-scoped API client.
  const jar = new Map();
  const ssr = createServerClient(API_URL, PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) =>
        cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error: se } = await ssr.auth.signInWithPassword({ email, password });
  if (se) throw new Error(`signIn ${label}: ${se.message}`);
  const api = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await api.auth.signInWithPassword({ email, password });

  return {
    id: data.user.id,
    fullName,
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    api,
  };
}

// --- HTTP helpers ------------------------------------------------------------

async function page(user, path = "/dashboard") {
  const res = await fetch(`${APP_URL}${path}`, { headers: { cookie: user.cookie } });
  return assembleStreamedHtml(await res.text());
}

// React streams parts of a page as hidden segments (<div hidden id="S:n"> or
// <table hidden><tbody id="S:n"> …) that a script moves into their
// <template id="P:n"> placeholders. Which parts get streamed separately is up
// to React, so the checks parse the page as the browser assembles it.
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

function decode(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function formHtml(html, formId) {
  const match = html.match(new RegExp(`<form\\b[^>]*id="${formId}"[^>]*>[\\s\\S]*?</form>`));
  return match?.[0] ?? null;
}

// Submits a rendered dashboard form: its hidden inputs (incl. React's
// server-action fields) plus `fields`. Fields named in `fields` replace
// any hidden input of the same name (used to forge ids).
async function submit(user, path, formId, fields) {
  const html = await page(user, path);
  const form = formHtml(html, formId);
  if (!form) throw new Error(`form ${formId} not found on ${path}`);
  const data = new FormData();
  for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
    if (!/type="hidden"/.test(tag)) continue;
    const name = decode(tag.match(/name="([^"]*)"/)?.[1] ?? "");
    if (!name || name in fields) continue;
    data.append(name, decode(tag.match(/value="([^"]*)"/)?.[1] ?? ""));
  }
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    body: data,
    redirect: "manual",
    headers: { cookie: user.cookie, origin: APP_URL },
  });
  return res.text();
}

function summary(html) {
  const read = (label) =>
    // Since Phase 6 the <dt> starts with a decorative icon before the label.
    Number(html.match(new RegExp(`<dt[^>]*>(?:<[^>]*>|\\s)*${label}</dt><dd[^>]*>([\\d,]+)</dd>`))?.[1]?.replace(/,/g, ""));
  return { clients: read("Total clients"), proposals: read("Total proposals"), drafts: read("Draft proposals") };
}

function rowFor(html, text) {
  return [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]).find((r) => r.includes(text));
}

function cell(row, label) {
  return row?.match(new RegExp(`data-label="${label}"[^>]*>([\\s\\S]*?)</td>`))?.[1] ?? "";
}

function tableNames(html, label = "Client") {
  return [...html.matchAll(new RegExp(`data-label="${label}"[^>]*>([\\s\\S]*?)</td>`, "g"))].map((m) =>
    textOf(m[1]),
  );
}

function textOf(fragment) {
  return decode(fragment.replace(/<[^>]+>/g, "")).trim();
}

// --- Checks ------------------------------------------------------------------

async function main() {
  const admin = await provisionUser("admin", "admin");
  const leadA = await provisionUser("lead-a", "team_lead");
  const leadB = await provisionUser("lead-b", "team_lead");

  // Lead B's data, created through B's own session (RLS).
  const { data: bClient } = await leadB.api
    .from("clients")
    .insert({ owner_id: leadB.id, name: `Bravo Secret ${runId}`, email: `b-${runId}@bravo.test` })
    .select("id")
    .single();
  const { data: bProposal } = await leadB.api
    .from("proposals")
    .insert({ client_id: bClient.id, owner_id: leadB.id, title: `Bravo Pitch ${runId}` })
    .select("id")
    .single();

  // 1. Empty state + permission-scoped counts
  {
    const html = await page(leadA);
    const s = summary(html);
    check(
      "lead A starts with an empty dashboard and zero totals",
      html.includes("No clients yet") && s.clients === 0 && s.proposals === 0 && s.drafts === 0,
      JSON.stringify(s),
    );
    check("lead A dashboard shows name and Team Lead role", html.includes(leadA.fullName) && html.includes("Team Lead"));
    check("lead A sees no Owner column", !/<th[^>]*>Owner<\/th>/.test(html));
  }

  // 2. Lead creates a client; forged ownerId is ignored
  const acmeName = `Acme ${runId}`;
  {
    const html = await submit(leadA, "/dashboard", "client-form-create", {
      name: `  ${acmeName}  `,
      email: ` Ops-${runId}@ACME.test `,
      ownerId: leadB.id,
    });
    const { data } = await admin.api.from("clients").select("id, owner_id, name, email").eq("name", acmeName);
    check(
      "lead A creates a client (name trimmed, email normalised)",
      html.includes(`Client “${acmeName}” added.`) && data?.length === 1 && data[0].email === `ops-${runId}@acme.test`,
    );
    check("submitted ownerId cannot override server ownership", data?.[0]?.owner_id === leadA.id);
  }
  const { data: acme } = await leadA.api.from("clients").select("id").eq("name", acmeName).single();

  // 3. Persists after refresh
  {
    const html = await page(leadA);
    check("client persists after refresh", html.includes(acmeName) && summary(html).clients === 1);
  }

  // 4. Invalid input creates nothing and preserves values
  {
    const before = (await leadA.api.from("clients").select("id")).data.length;
    const html = await submit(leadA, "/dashboard", "client-form-create", { name: "    ", email: "not-an-email" });
    const after = (await leadA.api.from("clients").select("id")).data.length;
    check(
      "invalid client input shows inline errors and creates no record",
      html.includes("Enter a client name.") && html.includes("Enter a valid email address.") && before === after,
    );
    // The action result travels in the streamed RSC payload; the form
    // re-renders from it in the browser (not observable without JS).
    check(
      "validation error result carries the submitted values for re-display",
      /\\?"email\\?":\\?"not-an-email\\?"/.test(html),
    );

    const tooLong = await submit(leadA, "/dashboard", "client-form-create", {
      name: "x".repeat(201),
      email: `long-${runId}@acme.test`,
    });
    const afterLong = (await leadA.api.from("clients").select("id")).data.length;
    check("over-long client name is rejected", tooLong.includes("Use 200 characters or fewer.") && afterLong === after);
  }

  // 5. Edit own client
  const acmeRenamed = `Acme Renamed ${runId}`;
  {
    const html = await submit(leadA, "/dashboard", `client-form-edit-${acme.id}`, {
      name: acmeRenamed,
      email: `ops-${runId}@acme.test`,
    });
    const { data } = await leadA.api.from("clients").select("name").eq("id", acme.id).single();
    check("lead A edits own client", html.includes(`Client “${acmeRenamed}” updated.`) && data.name === acmeRenamed);
    check("edited client persists after refresh", (await page(leadA)).includes(acmeRenamed));
  }

  // 6. Forged client id (lead B's) through lead A's edit form
  {
    const html = await submit(leadA, "/dashboard", `client-form-edit-${acme.id}`, {
      clientId: bClient.id,
      name: "Hijacked",
      email: "hijack@evil.test",
    });
    const { data } = await leadB.api.from("clients").select("name").eq("id", bClient.id).single();
    check(
      "forged client id cannot edit lead B's client",
      html.includes("could not be found") && data.name === `Bravo Secret ${runId}`,
      `name now: ${data.name}; alert: ${html.match(/role="alert"[^>]*>[^<]*/)?.[0]}`,
    );
    const random = await submit(leadA, "/dashboard", `client-form-edit-${acme.id}`, {
      clientId: "00000000-0000-4000-8000-000000000000",
      name: "Ghost",
      email: "ghost@x.test",
    });
    const malformed = await submit(leadA, "/dashboard", `client-form-edit-${acme.id}`, {
      clientId: "not-a-uuid'; drop table clients;--",
      name: "Ghost",
      email: "ghost@x.test",
    });
    check(
      "nonexistent and malformed client ids fail safely",
      random.includes("could not be found") && malformed.includes("could not be found"),
    );
  }

  // 7. Draft proposal for own client
  const draftTitle = `Spring Review ${runId}`;
  {
    const html = await submit(leadA, "/dashboard?tab=proposals", "proposal-form-create", {
      clientId: acme.id,
      title: draftTitle,
    });
    // Explicit columns: since Phase 4 the token hash column is not readable by leads.
    const { data } = await leadA.api
      .from("proposals")
      .select("id, owner_id, client_id, status, original_storage_path, preview_storage_path, total_pages, free_preview_pages, unlock_price_minor, currency")
      .eq("title", draftTitle);
    const p = data?.[0];
    check(
      "lead A creates a draft for own client",
      html.includes(`Draft “${draftTitle}” created.`) && data?.length === 1,
    );
    check(
      "new draft: status draft, owner from client, no PDF/pages/offer",
      p?.status === "draft" &&
        p.owner_id === leadA.id &&
        p.original_storage_path === null &&
        p.preview_storage_path === null &&
        p.total_pages === null &&
        p.free_preview_pages === null &&
        p.unlock_price_minor === null &&
        p.currency === null,
    );
    const list = await page(leadA, "/dashboard?tab=proposals");
    const row = rowFor(list, draftTitle);
    check(
      "proposal list shows Draft status and 'Not uploaded' separately",
      textOf(cell(row, "Status")) === "Draft" && textOf(cell(row, "Document")) === "Not uploaded",
    );
  }
  const { data: draft } = await leadA.api.from("proposals").select("id").eq("title", draftTitle).single();

  // 8. Proposal for lead B's client is rejected
  {
    const html = await submit(leadA, "/dashboard?tab=proposals", "proposal-form-create", {
      clientId: bClient.id,
      title: `Planted ${runId}`,
      ownerId: leadA.id,
      owner_id: leadA.id,
    });
    const { data } = await admin.api.from("proposals").select("id").eq("title", `Planted ${runId}`);
    check(
      "lead A cannot create a proposal for lead B's client",
      html.includes("Select a client you have access to.") && data.length === 0,
    );
  }

  // 9. Draft title edit
  const renamedDraft = `Spring Review v2 ${runId}`;
  {
    const html = await submit(leadA, "/dashboard?tab=proposals", `proposal-form-edit-${draft.id}`, {
      title: renamedDraft,
    });
    const { data } = await leadA.api.from("proposals").select("title").eq("id", draft.id).single();
    check("draft title edit works", html.includes("Draft renamed") && data.title === renamedDraft);
  }

  // 10. Non-draft editing is rejected server-side
  {
    const { data: second } = await leadA.api
      .from("proposals")
      .insert({ client_id: acme.id, owner_id: leadA.id, title: `To Archive ${runId}` })
      .select("id")
      .single();
    await trusted.from("proposals").update({ status: "archived" }).eq("id", second.id);

    const list = await page(leadA, "/dashboard?tab=proposals");
    const row = rowFor(list, `To Archive ${runId}`);
    check(
      "archived proposal is listed without an edit action",
      textOf(cell(row, "Status")) === "Archived" &&
        !list.includes(`proposal-form-edit-${second.id}`) &&
        cell(row, "Actions").includes("Not editable"),
    );

    const html = await submit(leadA, "/dashboard?tab=proposals", `proposal-form-edit-${draft.id}`, {
      proposalId: second.id,
      title: "Sneaky rename",
    });
    const { data } = await leadA.api.from("proposals").select("title").eq("id", second.id).single();
    check(
      "editing a non-draft is rejected server-side",
      html.includes("Only draft proposals can be edited.") && data.title === `To Archive ${runId}`,
    );
  }

  // 11. Forged proposal id (lead B's)
  {
    const html = await submit(leadA, "/dashboard?tab=proposals", `proposal-form-edit-${draft.id}`, {
      proposalId: bProposal.id,
      title: "Hijacked",
    });
    const { data } = await leadB.api.from("proposals").select("title").eq("id", bProposal.id).single();
    check(
      "forged proposal id cannot edit lead B's proposal",
      html.includes("could not be found") && data.title === `Bravo Pitch ${runId}`,
    );
  }

  // 12. Isolation in lead A's rendered pages (including owner param forging)
  {
    const pages = await Promise.all([
      page(leadA),
      page(leadA, "/dashboard?tab=proposals"),
      page(leadA, `/dashboard?owner=${leadB.id}`),
      page(leadA, `/dashboard?tab=proposals&owner=${leadB.id}&q=Bravo`),
    ]);
    const leaked = pages.some(
      (html) => html.includes(`Bravo Secret ${runId}`) || html.includes(`Bravo Pitch ${runId}`) || html.includes(leadB.fullName),
    );
    check("lead A's dashboard never renders lead B's records or name", !leaked);
    const s = summary(pages[2]);
    check(
      "owner param is ignored for team leads (counts stay their own)",
      s.clients === 1 && s.proposals === 2 && s.drafts === 1,
      JSON.stringify(s),
    );
    check(
      "lead's search for another lead's client shows 'No search results'",
      pages[3].includes("No search results"),
    );
  }

  // 13. Proposal counts per client
  {
    const html = await page(leadA);
    check("client proposal count reflects own proposals", textOf(cell(rowFor(html, acmeRenamed), "Proposals")) === "2");
  }

  // 14. Admin creates a client for a selected team lead
  const adminMade = `Admin For B ${runId}`;
  {
    const html = await submit(admin, "/dashboard", "client-form-create", {
      name: adminMade,
      email: `admin-made-${runId}@client.test`,
      ownerId: leadB.id,
    });
    const { data } = await admin.api.from("clients").select("owner_id").eq("name", adminMade);
    check(
      "admin creates a client for a selected team lead",
      html.includes(`Client “${adminMade}” added.`) && data?.[0]?.owner_id === leadB.id,
    );

    const missing = await submit(admin, "/dashboard", "client-form-create", {
      name: `No Owner ${runId}`,
      email: `no-owner-${runId}@client.test`,
      ownerId: "",
    });
    const self = await submit(admin, "/dashboard", "client-form-create", {
      name: `Admin Owned ${runId}`,
      email: `admin-owned-${runId}@client.test`,
      ownerId: admin.id,
    });
    const { data: none } = await admin.api
      .from("clients")
      .select("id")
      .in("name", [`No Owner ${runId}`, `Admin Owned ${runId}`]);
    check(
      "admin must pick an existing team lead (missing / non-lead owner rejected)",
      missing.includes("Select a team lead.") && self.includes("Select an existing team lead.") && none.length === 0,
    );
  }

  // 15. Admin sees across leads and can filter by owner
  {
    const html = await page(admin);
    check(
      "admin sees clients across leads with owner names",
      html.includes(acmeRenamed) && html.includes(`Bravo Secret ${runId}`) && /<th[^>]*>Owner<\/th>/.test(html),
    );
    const filtered = await page(admin, `/dashboard?owner=${leadB.id}`);
    const s = summary(filtered);
    // Only table rows are checked: the New proposal dialog deliberately
    // lists every client the admin may use.
    const rows = tableNames(filtered);
    check(
      "admin owner filter limits list and counts to that lead",
      rows.includes(`Bravo Secret ${runId}`) &&
        !rows.includes(acmeRenamed) &&
        tableNames(filtered, "Owner").every((owner) => owner === leadB.fullName) &&
        s.clients === 2 &&
        s.proposals === 1 &&
        s.drafts === 1,
      JSON.stringify(s),
    );
    const searched = await page(admin, `/dashboard?owner=${leadB.id}&q=${encodeURIComponent("Admin For B")}`);
    const ss = summary(searched);
    check(
      "search narrows the list but not the summary totals",
      tableNames(searched).join("|") === adminMade && ss.clients === 2,
    );
    const proposals = await page(admin, `/dashboard?tab=proposals&owner=${leadA.id}`);
    check(
      "admin proposal view filtered to lead A shows A's drafts with owner",
      proposals.includes(renamedDraft) && !proposals.includes(`Bravo Pitch ${runId}`) && proposals.includes(leadA.fullName),
    );
    const byClient = await page(admin, `/dashboard?tab=proposals&q=${encodeURIComponent(`Bravo Secret ${runId}`)}`);
    check(
      "proposal search matches client name",
      byClient.includes(`Bravo Pitch ${runId}`) && !byClient.includes(renamedDraft),
    );
  }

  // 16. Admin creates a draft for a lead's client (ownership from the client)
  {
    const title = `Admin Draft ${runId}`;
    const html = await submit(admin, "/dashboard?tab=proposals", "proposal-form-create", {
      clientId: bClient.id,
      title,
    });
    const { data } = await admin.api.from("proposals").select("owner_id").eq("title", title);
    check(
      "admin draft takes the client's owner",
      html.includes(`Draft “${title}” created.`) && data?.[0]?.owner_id === leadB.id,
    );
  }

  // 17. Pagination + search together (lead A, 12 clients)
  {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      owner_id: leadA.id,
      name: `Paged ${String(i + 1).padStart(2, "0")} ${runId}`,
      email: `paged-${i}-${runId}@client.test`,
    }));
    await leadA.api.from("clients").insert(rows);
    await leadA.api.from("clients").insert({ owner_id: leadA.id, name: `Zeta ${runId}`, email: `zeta-${runId}@client.test` });

    const page1 = await page(leadA);
    const page2 = await page(leadA, "/dashboard?page=2");
    const count = (html) => tableNames(html).length;
    check(
      "pagination: 12 clients → 10 on page 1, 2 on page 2",
      count(page1) === 10 && count(page2) === 2 && page2.includes("Showing 11–12 of 12 clients"),
      `${count(page1)} / ${count(page2)}`,
    );
    const searchPage1 = await page(leadA, `/dashboard?q=Paged`);
    check(
      "search + pagination: 10 matches fit on one page",
      count(searchPage1) === 10 &&
        searchPage1.includes("Showing 1–10 of 10 clients") &&
        !tableNames(searchPage1).includes(`Zeta ${runId}`),
    );
    const past = await page(leadA, `/dashboard?q=Paged&page=5`);
    check("page past the end is handled", past.includes("No records on this page"));
    const wildcard = await page(leadA, `/dashboard?q=${encodeURIComponent("%")}`);
    check("LIKE wildcards in search are matched literally", wildcard.includes("No search results"));
  }

  // 18. Signed-out visitor still cannot reach the dashboard
  {
    const res = await fetch(`${APP_URL}/dashboard`, { redirect: "manual" });
    check("signed-out visitor is redirected to /login", res.status === 307);
  }
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
} finally {
  if (created.userIds.length) {
    await trusted.from("proposals").delete().in("owner_id", created.userIds);
    await trusted.from("clients").delete().in("owner_id", created.userIds);
    for (const id of created.userIds) await trusted.auth.admin.deleteUser(id);
  }
}

if (fatal) {
  console.error(`\nAborted: ${fatal.message}`);
  process.exit(1);
}
const failed = results.filter((passed) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed === 0 ? 0 : 1);
