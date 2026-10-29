// Deployment preparation: the scheduled storage-cleanup endpoint
// (/api/cron/storage-cleanup) and the production security headers.
//
//   npm run build
//   npm run test:cron
//
// - Starts DEDICATED app servers on APP_PORT (default 3102) from the current
//   build, one at a time, each with its own test-only CRON_SECRET (random,
//   never printed). Nothing shared is stopped or reconfigured.
// - Never deletes local files: the apply-mode server uses an age threshold
//   of ~100 years, so no object is eligible. That run proves the apply path
//   is wired up and that fresh (in-progress) uploads are kept, without
//   touching any existing object. A disposable user's fixture object is
//   removed at the end by the harness.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import { BUCKET, createHarness } from "./lib/portal.mjs";

const APP_PORT = Number(process.env.APP_PORT ?? 3102);
const APP_URL = `http://localhost:${APP_PORT}`;
process.env.APP_URL = APP_URL;
const OUT = join(process.env.TEMP ?? "/tmp", `portal-deploy-${process.pid}`);
mkdirSync(OUT, { recursive: true });
const ENDPOINT = `${APP_URL}/api/cron/storage-cleanup`;

const h = createHarness("dc");
const { check, trusted, provisionUser, objectsUnder } = h;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
async function startServer(name, env) {
  const log = createWriteStream(join(OUT, `${name}.log`));
  const base = { ...process.env, NODE_ENV: "production" };
  delete base.CRON_SECRET;
  delete base.STORAGE_CLEANUP_CRON_APPLY;
  delete base.STORAGE_CLEANUP_OLDER_THAN_HOURS;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)], {
    env: { ...base, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${APP_URL}/login`)).status === 200) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("dedicated app server did not start");
}
function stopServer() {
  if (!server?.pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill("SIGTERM");
  } catch {
    // already gone
  }
  server = null;
}

const call = (headers = {}, init = {}) => fetch(ENDPOINT, { redirect: "manual", ...init, headers });

await h.run(async () => {
  try {
    // A disposable user's fresh, unreferenced object: must be kept by any run.
    const owner = await provisionUser("owner", "team_lead");
    const fixture = `${owner.id}/${randomUUID()}/original.pdf`;
    const { error: uploadError } = await trusted.storage
      .from(BUCKET)
      .upload(fixture, new Blob(["%PDF-1.7\n%fixture\n"], { type: "application/pdf" }));
    if (uploadError) throw new Error(`fixture upload: ${uploadError.message}`);

    // 1. No CRON_SECRET (and a too-short one): the endpoint is disabled.
    await startServer("disabled", {});
    let res = await call({ authorization: "Bearer anything" });
    check("without CRON_SECRET the endpoint answers 404", res.status === 404, String(res.status));
    stopServer();
    await startServer("short", { CRON_SECRET: "short-secret" });
    res = await call({ authorization: "Bearer short-secret" });
    check("a CRON_SECRET shorter than 32 characters keeps it disabled", res.status === 404, String(res.status));
    stopServer();

    // 2. Dry-run server (the default).
    const secret = randomBytes(32).toString("base64url");
    await startServer("dry-run", { CRON_SECRET: secret });
    const denied = [
      ["no Authorization header", {}],
      ["wrong secret", { authorization: `Bearer ${randomBytes(32).toString("base64url")}` }],
      ["secret without Bearer", { authorization: secret }],
      ["Basic scheme", { authorization: `Basic ${secret}` }],
      ["secret with a suffix", { authorization: `Bearer ${secret}x` }],
      ["secret in another header", { "x-cron-secret": secret }],
    ];
    for (const [label, headers] of denied) {
      res = await call(headers);
      check(`401 for ${label}`, res.status === 401, String(res.status));
    }
    res = await fetch(`${ENDPOINT}?secret=${encodeURIComponent(secret)}`);
    check("401 for the secret in the query string", res.status === 401, String(res.status));
    res = await call({ authorization: `Bearer ${secret}` }, { method: "POST" });
    check("POST is not accepted", res.status === 405, String(res.status));

    const before = await objectsUnder(owner.id);
    res = await call({ authorization: `Bearer ${secret}` });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      // checked below
    }
    check("correct secret runs the cleanup (200)", res.status === 200, `${res.status} ${text.slice(0, 120)}`);
    check("default mode is dry-run", body.mode === "dry-run", body.mode);
    check("default age threshold is 24 h", body.olderThanHours === 24, String(body.olderThanHours));
    check("fresh unreferenced upload is counted as too recent", (body.counts?.recent ?? 0) >= 1, JSON.stringify(body.counts));
    check("dry run deletes nothing", body.deleted === 0 && body.failed === 0, JSON.stringify(body));
    check("pending deletions are reported", Number.isInteger(body.pendingDeletions), String(body.pendingDeletions));
    check("response carries no object names or ids", !text.includes(owner.id) && !/\.pdf/.test(text) && !("candidateNames" in body));
    check("response is no-store", /no-store/.test(res.headers.get("cache-control") ?? ""), res.headers.get("cache-control"));
    check("fixture object still exists", (await objectsUnder(owner.id)).length === before.length && before.length === 1);
    stopServer();

    // 3. Apply mode, with a threshold no object can meet (nothing local is deleted).
    await startServer("apply", { CRON_SECRET: secret, STORAGE_CLEANUP_CRON_APPLY: "true", STORAGE_CLEANUP_OLDER_THAN_HOURS: "876000" });
    res = await call({ authorization: `Bearer ${secret}` });
    body = await res.json().catch(() => ({}));
    check("apply mode is used only when STORAGE_CLEANUP_CRON_APPLY=true", res.status === 200 && body.mode === "apply", `${res.status} ${body.mode}`);
    check("apply run had no eligible objects and deleted nothing", body.candidates === 0 && body.deleted === 0, JSON.stringify(body));
    check("fresh upload kept in apply mode", (await objectsUnder(owner.id)).length === 1);
    res = await call({ authorization: `Bearer ${secret}` });
    check("a repeated (duplicate) delivery is harmless", res.status === 200);

    // 4. Production headers on the same server.
    const login = await fetch(`${APP_URL}/login`);
    const csp = login.headers.get("content-security-policy") ?? "";
    check("CSP set, no 'unsafe-eval' in production", csp.includes("default-src 'self'") && !csp.includes("'unsafe-eval'"), csp);
    check("frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
    check("login is no-store", /no-store/.test(login.headers.get("cache-control") ?? ""));
    check("app sets no HSTS of its own (left to the HTTPS edge)", login.headers.get("strict-transport-security") === null);
    const link = await fetch(`${APP_URL}/p/${"A".repeat(43)}`);
    check("client link: no-referrer", link.headers.get("referrer-policy") === "no-referrer", link.headers.get("referrer-policy"));
    check("client link: noindex", /noindex/.test(link.headers.get("x-robots-tag") ?? ""));
    check("client link: no-store", /no-store/.test(link.headers.get("cache-control") ?? ""));
    const preview = await fetch(`${APP_URL}/p/${"A".repeat(43)}/preview`);
    check("preview endpoint: no-store and noindex", /no-store/.test(preview.headers.get("cache-control") ?? "") && /noindex/.test(preview.headers.get("x-robots-tag") ?? ""));
  } finally {
    stopServer();
  }
});
