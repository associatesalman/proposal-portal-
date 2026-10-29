// Shared harness for the Phase 5 checks (same approach as phase4-pdf-links):
// disposable users with real sessions, the dashboard's real server actions
// called over HTTP (ids from the build's server-reference manifest), and a
// snapshot of existing local data that must stay untouched.
//
// The local secret key is used only to provision/clean up disposable users
// and to set up or inspect fixtures, never for authorization checks.

import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const BUCKET = "proposals";

export function createHarness(prefix) {
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

  const actionIds = Object.fromEntries(
    Object.entries(JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")).node)
      .filter(([, v]) => v.filename?.endsWith("proposal-setup-actions.ts"))
      .map(([id, v]) => [v.exportedName, id]),
  );

  const runId = randomBytes(4).toString("hex");
  const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
  const trusted = createClient(API_URL, SECRET_KEY, noSession);
  const anon = createClient(API_URL, PUBLISHABLE_KEY, noSession);
  const created = { users: [] };
  const results = [];

  function check(name, passed, detail = "") {
    results.push(passed);
    console.log(`${passed ? "ok    " : "FAIL  "} ${name}${!passed && detail ? ` — ${detail}` : ""}`);
  }

  async function provisionUser(label, role) {
    const email = `${prefix}-${label}-${runId}@test.local`;
    const password = randomBytes(18).toString("base64url");
    const { data, error } = await trusted.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser ${label}: ${error.message}`);
    created.users.push(data.user.id);
    const fullName = `${prefix.toUpperCase()} ${label} ${runId}`;
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
    return { id: data.user.id, email, password, fullName, client, cookie, jar };
  }

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

  // `baseUrl`: another app server started from the same build (optional).
  async function act(user, name, arg, baseUrl = APP_URL) {
    const id = actionIds[name];
    if (!id) throw new Error(`action ${name} not in manifest`);
    const res = await fetch(`${baseUrl}/dashboard`, {
      method: "POST",
      headers: {
        cookie: user.cookie,
        origin: baseUrl,
        "next-action": id,
        "content-type": "text/plain;charset=UTF-8",
        accept: "text/x-component",
      },
      body: JSON.stringify([arg]),
      redirect: "manual",
    });
    if (res.status !== 200) return { ok: false, message: `HTTP ${res.status}` };
    return parseActionResponse(await res.text());
  }

  async function createDraft(user, title) {
    const { data: client, error: ce } = await user.client
      .from("clients")
      .insert({
        owner_id: user.id,
        name: `Client of ${title}`,
        email: `client-${randomBytes(3).toString("hex")}@client.test`,
      })
      .select("id, email, name")
      .single();
    if (ce) throw new Error(`client: ${ce.message}`);
    const { data, error } = await user.client
      .from("proposals")
      .insert({ client_id: client.id, owner_id: user.id, title })
      .select("id")
      .single();
    if (error) throw new Error(`proposal: ${error.message}`);
    return { id: data.id, client };
  }

  // Dashboard flow: draft -> upload (signed ticket) -> offer -> link.
  async function publishProposal(user, { title, pdf, fileName = "proposal.pdf", offer }) {
    const draft = await createDraft(user, title);
    const proposalId = draft.id;
    const ticket = await act(user, "prepareUploadAction", { proposalId, sizeBytes: pdf.length });
    if (!ticket.ok) throw new Error(`prepare ${title}: ${ticket.message}`);
    const { error } = await anon.storage
      .from(BUCKET)
      .uploadToSignedUrl(ticket.data.path, ticket.data.token, new Blob([pdf], { type: "application/pdf" }), {
        contentType: "application/pdf",
      });
    if (error) throw new Error(`upload ${title}: ${error.message}`);
    const done = await act(user, "completeUploadAction", {
      proposalId,
      revision: ticket.data.revision,
      expectedRevision: null,
      fileName,
    });
    if (!done.ok) throw new Error(`complete ${title}: ${done.message}`);
    const saved = await act(user, "saveOfferAction", {
      proposalId,
      expectedRevision: done.data.document.revision,
      ...offer,
    });
    if (!saved.ok) throw new Error(`offer ${title}: ${saved.message}`);
    const link = await act(user, "generateLinkAction", {
      proposalId,
      expectedPreviewRevision: saved.data.preview?.revision ?? randomUUID(),
    });
    if (!link.ok) throw new Error(`link ${title}: ${link.message}`);
    const token = new URL(link.data.url).pathname.split("/").pop();
    const row = await proposalRow(user, proposalId);
    return { id: proposalId, client: draft.client, token, row, user };
  }

  async function proposalRow(user, id) {
    const { data } = await user.client
      .from("proposals")
      .select(
        "id, owner_id, status, original_storage_path, preview_storage_path, total_pages, free_preview_pages, unlock_price_minor, currency, original_file_name",
      )
      .eq("id", id)
      .maybeSingle();
    return data;
  }

  async function objectsUnder(path) {
    const out = [];
    const { data } = await trusted.storage.from(BUCKET).list(path, { limit: 1000 });
    for (const entry of data ?? []) {
      const child = `${path}/${entry.name}`;
      if (entry.id) out.push(child);
      else out.push(...(await objectsUnder(child)));
    }
    return out.sort();
  }

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
      users: keep(users.data?.users.map((u) => ({ id: u.id, email: u.email })) ?? []),
    });
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

  // Runs `main`, always cleans up, verifies existing data, prints a summary
  // and exits with the right code.
  async function run(main) {
    let fatal = null;
    let before = null;
    try {
      before = await snapshot();
      await main();
    } catch (error) {
      fatal = error;
    } finally {
      await cleanup();
    }
    if (before) {
      // Disposable rows are gone again, so everything must match exactly.
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
  }

  return {
    APP_URL,
    API_URL,
    PUBLISHABLE_KEY,
    runId,
    trusted,
    anon,
    check,
    provisionUser,
    act,
    createDraft,
    publishProposal,
    proposalRow,
    objectsUnder,
    run,
  };
}
