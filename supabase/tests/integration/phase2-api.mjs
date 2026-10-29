// Phase 2 API-level authorization checks against a LOCAL Supabase stack.
//
//   npm run db:start          # local stack with migrations applied
//   npm run test:integration
//
// Uses real Auth (email/password sign-in), PostgREST and the Storage API.
// The local secret key is used ONLY to provision and clean up disposable
// users/fixtures (the equivalent of trusted admin SQL / later server code).
// Every isolation check runs with a signed-in user's or anon's session, which
// is subject to RLS. Refuses to run against anything but localhost.

import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const status = JSON.parse(
  execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString(),
);
const API_URL = status.API_URL;
const PUBLISHABLE_KEY = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const SECRET_KEY = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;

const host = new URL(API_URL).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  console.error(`Refusing to run against non-local Supabase (${host}).`);
  process.exit(2);
}

const BUCKET = "proposals";
const runId = randomBytes(4).toString("hex");
const results = [];

function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}${!passed && detail ? ` — ${detail}` : ""}`);
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const trusted = createClient(API_URL, SECRET_KEY, clientOptions);
const anon = createClient(API_URL, PUBLISHABLE_KEY, clientOptions);

const pdf = (label) =>
  new Blob([`%PDF-1.4\n% disposable test object ${label}\n%%EOF\n`], { type: "application/pdf" });

const created = { userIds: [], objectPaths: [], proposalIds: [], clientIds: [] };

async function provisionUser(label, role) {
  const email = `phase2-${label}-${runId}@test.local`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await trusted.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // Deliberately try to smuggle an admin role through metadata; it must be ignored.
    user_metadata: { role: "admin" },
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  created.userIds.push(data.user.id);
  if (role) {
    const { error: profileError } = await trusted
      .from("profiles")
      .insert({ id: data.user.id, full_name: `Test ${label}`, role });
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  return { id: data.user.id, email, password };
}

async function signIn(user) {
  const client = createClient(API_URL, PUBLISHABLE_KEY, clientOptions);
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw new Error(`signIn ${user.email}: ${error.message}`);
  return client;
}

// Lead creates client + proposal through their own session; trusted code then
// records the storage path (server-controlled column) and uploads the original.
async function createLeadFixture(client, ownerId, label) {
  const { data: c, error: ce } = await client
    .from("clients")
    .insert({ owner_id: ownerId, name: `Client ${label}`, email: `${label}@client.test` })
    .select("id")
    .single();
  if (ce) throw new Error(`client ${label}: ${ce.message}`);
  created.clientIds.push(c.id);

  const { data: p, error: pe } = await client
    .from("proposals")
    .insert({
      client_id: c.id,
      owner_id: ownerId,
      title: `Proposal ${label}`,
      // Since Phase 4 offer values are set only by trusted server code.
    })
    .select("id")
    .single();
  if (pe) throw new Error(`proposal ${label}: ${pe.message}`);
  created.proposalIds.push(p.id);

  const originalPath = `${ownerId}/${p.id}/original.pdf`;
  const { error: ue } = await trusted.storage.from(BUCKET).upload(originalPath, pdf(label), {
    contentType: "application/pdf",
  });
  if (ue) throw new Error(`upload ${label}: ${ue.message}`);
  created.objectPaths.push(originalPath);

  const { error: se } = await trusted
    .from("proposals")
    // Since Phase 4 a stored original must come with its page count.
    .update({ original_storage_path: originalPath, total_pages: 1 })
    .eq("id", p.id);
  if (se) throw new Error(`path ${label}: ${se.message}`);

  return { clientId: c.id, proposalId: p.id, originalPath };
}

async function cleanup() {
  if (created.objectPaths.length) {
    await trusted.storage.from(BUCKET).remove(created.objectPaths);
  }
  if (created.proposalIds.length) {
    await trusted.from("payments").delete().in("proposal_id", created.proposalIds);
    await trusted.from("proposals").delete().in("id", created.proposalIds);
  }
  if (created.userIds.length) {
    await trusted.from("clients").delete().in("owner_id", created.userIds);
  }
  for (const id of created.userIds) {
    await trusted.auth.admin.deleteUser(id);
  }
}

async function main() {
  // --- Provision disposable accounts --------------------------------------
  const adminUser = await provisionUser("admin", "admin");
  const leadAUser = await provisionUser("lead-a", "team_lead");
  const leadBUser = await provisionUser("lead-b", "team_lead");
  const noProfileUser = await provisionUser("no-profile", null);

  const admin = await signIn(adminUser);
  const leadA = await signIn(leadAUser);
  const leadB = await signIn(leadBUser);

  const a = await createLeadFixture(leadA, leadAUser.id, `a-${runId}`);
  const b = await createLeadFixture(leadB, leadBUser.id, `b-${runId}`);

  // A payment row for each proposal, written by trusted code only.
  for (const proposalId of [a.proposalId, b.proposalId]) {
    const { error } = await trusted.from("payments").insert({
      proposal_id: proposalId,
      provider: "test",
      provider_payment_id: `pay_${randomUUID()}`,
      amount_minor: 1000,
      currency: "USD",
    });
    if (error) throw new Error(`payment fixture: ${error.message}`);
  }

  // --- Public signup is disabled --------------------------------------------
  {
    const { data, error } = await anon.auth.signUp({
      email: `phase2-signup-${runId}@test.local`,
      password: randomBytes(18).toString("base64url"),
    });
    if (data?.user?.id) created.userIds.push(data.user.id);
    check("public signup is rejected by Supabase Auth", Boolean(error) && !data?.user);
  }

  // --- Anonymous ---------------------------------------------------------
  for (const table of ["profiles", "clients", "proposals", "payments"]) {
    const { data, error } = await anon.from(table).select("id");
    check(`anon cannot read ${table}`, Boolean(error) || (data ?? []).length === 0);
  }
  {
    const { data, error } = await anon.storage.from(BUCKET).download(a.originalPath);
    check("anon cannot download an original PDF", Boolean(error) && !data);
  }
  {
    const { data, error } = await anon.storage.from(BUCKET).createSignedUrl(a.originalPath, 60);
    check("anon cannot create a signed URL", Boolean(error) && !data?.signedUrl);
  }
  {
    const { error } = await anon.storage
      .from(BUCKET)
      .upload(`${leadAUser.id}/${a.proposalId}/preview.pdf`, pdf("anon"));
    check("anon cannot upload into the proposals bucket", Boolean(error));
  }
  {
    const res = await fetch(`${API_URL}/storage/v1/object/public/${BUCKET}/${a.originalPath}`);
    check("bucket has no public URL access", res.status >= 400);
  }

  // --- Authenticated user without a profile ------------------------------
  {
    const noProfile = await signIn(noProfileUser);
    const { data: profiles } = await noProfile.from("profiles").select("id");
    const { data: clients } = await noProfile.from("clients").select("id");
    const { data: proposals } = await noProfile.from("proposals").select("id");
    check(
      "user without profile can authenticate but sees no records",
      (profiles ?? []).length === 0 &&
        (clients ?? []).length === 0 &&
        (proposals ?? []).length === 0,
    );
  }

  // --- Lead A isolation -------------------------------------------------
  {
    const { data } = await leadA.from("clients").select("id");
    check(
      "lead A reads only own clients",
      (data ?? []).length === 1 && data[0].id === a.clientId,
    );
  }
  {
    const { data } = await leadA.from("proposals").select("id");
    check(
      "lead A reads only own proposals",
      (data ?? []).length === 1 && data[0].id === a.proposalId,
    );
  }
  {
    const { data } = await leadA.from("payments").select("proposal_id");
    check(
      "lead A reads only payments for own proposals",
      (data ?? []).length === 1 && data[0].proposal_id === a.proposalId,
    );
  }
  {
    const { data } = await leadA
      .from("proposals")
      .update({ title: "hijacked" })
      .eq("id", b.proposalId)
      .select("id");
    check("lead A cannot update lead B's proposal", (data ?? []).length === 0);
  }
  {
    const { data } = await leadA.from("clients").delete().eq("id", b.clientId).select("id");
    check("lead A cannot delete lead B's client", (data ?? []).length === 0);
  }
  {
    const { error } = await leadA
      .from("clients")
      .update({ owner_id: leadBUser.id })
      .eq("id", a.clientId);
    check("lead A cannot reassign ownership of own client", Boolean(error));
  }
  {
    const { error } = await leadA.from("clients").insert({
      owner_id: leadBUser.id,
      name: "Planted",
      email: "planted@client.test",
    });
    check("lead A cannot create a client owned by lead B", Boolean(error));
  }
  {
    const { error } = await leadA.from("proposals").insert({
      client_id: b.clientId,
      owner_id: leadAUser.id,
      title: "Attach",
    });
    check("lead A cannot attach a proposal to lead B's client", Boolean(error));
  }
  {
    const { error } = await leadA
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", leadAUser.id);
    const { data: me } = await leadA.from("profiles").select("role").eq("id", leadAUser.id).single();
    check("lead A cannot promote self to admin", Boolean(error) && me?.role === "team_lead");
  }
  {
    // Metadata cannot grant admin either: lead A was created with user_metadata.role = admin.
    const { data } = await leadA.from("profiles").select("id");
    check("auth user metadata does not grant admin", (data ?? []).length === 1);
  }
  {
    const insert = await leadA.from("payments").insert({
      proposal_id: a.proposalId,
      provider: "test",
      amount_minor: 1,
      currency: "USD",
    });
    const update = await leadA
      .from("payments")
      .update({ status: "succeeded" })
      .eq("proposal_id", a.proposalId);
    const del = await leadA.from("payments").delete().eq("proposal_id", a.proposalId);
    check(
      "internal browser user cannot insert/update/delete payments",
      Boolean(insert.error) && Boolean(update.error) && Boolean(del.error),
    );
  }

  // --- Storage isolation ------------------------------------------------
  {
    const { data, error } = await leadA.storage.from(BUCKET).download(a.originalPath);
    check("lead A can download own original", !error && Boolean(data));
  }
  {
    const { data, error } = await leadA.storage.from(BUCKET).download(b.originalPath);
    check("lead A cannot download lead B's original", Boolean(error) && !data);
  }
  {
    const { data, error } = await leadA.storage.from(BUCKET).createSignedUrl(b.originalPath, 60);
    check("lead A cannot sign a URL for lead B's original", Boolean(error) && !data?.signedUrl);
  }
  {
    const { data } = await leadA.storage.from(BUCKET).list(leadBUser.id);
    check("lead A cannot list lead B's folder", (data ?? []).length === 0);
  }
  {
    const { error } = await leadA.storage
      .from(BUCKET)
      .upload(`${leadBUser.id}/${b.proposalId}/preview.pdf`, pdf("x"));
    check("lead A cannot upload into lead B's proposal path", Boolean(error));
  }
  {
    const { error } = await leadA.storage
      .from(BUCKET)
      .upload(`${leadAUser.id}/${b.proposalId}/preview.pdf`, pdf("x"));
    check("own prefix + lead B's proposal id is rejected", Boolean(error));
  }
  {
    const { error } = await leadA.storage
      .from(BUCKET)
      .upload(`${leadAUser.id}/${randomUUID()}/original.pdf`, pdf("x"));
    check("own prefix + non-existent proposal id is rejected", Boolean(error));
  }
  {
    await leadA.storage.from(BUCKET).remove([b.originalPath]);
    const { data, error } = await leadB.storage.from(BUCKET).download(b.originalPath);
    check("lead A cannot delete lead B's object", !error && Boolean(data));
  }
  {
    const previewPath = `${leadAUser.id}/${a.proposalId}/preview.pdf`;
    const { error } = await leadA.storage
      .from(BUCKET)
      .upload(previewPath, pdf("a-preview"), { contentType: "application/pdf" });
    if (!error) created.objectPaths.push(previewPath);
    check("lead A can upload an object for own proposal", !error, error?.message);
  }

  // --- Admin ---------------------------------------------------------------
  {
    const { data: clients } = await admin.from("clients").select("id").in("id", [a.clientId, b.clientId]);
    const { data: proposals } = await admin
      .from("proposals")
      .select("id")
      .in("id", [a.proposalId, b.proposalId]);
    const { data: payments } = await admin
      .from("payments")
      .select("id")
      .in("proposal_id", [a.proposalId, b.proposalId]);
    check(
      "admin reads clients, proposals and payments across leads",
      clients?.length === 2 && proposals?.length === 2 && payments?.length === 2,
    );
  }
  {
    const { data } = await admin
      .from("proposals")
      .update({ title: "Edited by admin" })
      .eq("id", b.proposalId)
      .select("id");
    check("admin can update a lead's proposal", (data ?? []).length === 1);
  }
  {
    const { data, error } = await admin.storage.from(BUCKET).download(b.originalPath);
    check("admin can download any lead's original", !error && Boolean(data));
  }
  {
    const { error } = await admin.from("payments").insert({
      proposal_id: a.proposalId,
      provider: "test",
      amount_minor: 1,
      currency: "USD",
    });
    check("admin cannot write payments from the browser", Boolean(error));
  }
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.passed).length;
if (fatal) {
  console.error(`\nAborted: ${fatal.message}`);
  process.exit(1);
}
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed === 0 ? 0 : 1);
