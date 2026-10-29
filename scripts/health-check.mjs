#!/usr/bin/env node
// Local health check: is everything the portal needs reachable?
//
//   npm run health                  Supabase services + the app at NEXT_PUBLIC_APP_URL
//   npm run health -- --app-url http://localhost:3100
//
// Checks Supabase Auth, the REST API (database), Storage and, if it is
// running, the app itself, each with a short timeout. Prints status and
// timings only: no keys, tokens or cookies are ever printed. Exit code 0
// when all required services respond, 1 otherwise.
//
// It does not start or stop anything. To start the local stack:
//   npm run db:start      (Supabase containers for this project only)
//   npm run dev           (or: npm run build && npm run start)

import { existsSync } from "node:fs";

const TIMEOUT_MS = 5000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function probe(label, url, init = {}, { required = true, ok = (res) => res.ok } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = Math.round(performance.now() - started);
    const passed = ok(res);
    await res.body?.cancel();
    return { label, passed, required, detail: `HTTP ${res.status}, ${ms} ms` };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const reason = error?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS} ms` : "unreachable";
    return { label, passed: false, required, detail: `${reason} (${ms} ms)` };
  }
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const supabaseUrl = (process.env.SUPABASE_SERVER_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const appUrl = (argValue("--app-url") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");

  if (!supabaseUrl || !publishableKey) {
    console.log("FAIL  configuration: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set (.env.local)");
    process.exit(1);
  }
  const keyHeaders = { apikey: publishableKey };

  const results = await Promise.all([
    probe("Supabase Auth", `${supabaseUrl}/auth/v1/health`, { headers: keyHeaders }),
    // Any HTTP answer from PostgREST means the database is reachable; 5xx
    // means PostgREST is up but the database isn't.
    probe("Supabase database (REST)", `${supabaseUrl}/rest/v1/`, { headers: keyHeaders }, { ok: (res) => res.status < 500 }),
    probe("Supabase Storage", `${supabaseUrl}/storage/v1/status`, { headers: keyHeaders }, { ok: (res) => res.status < 500 }),
    probe("Portal app (/login)", `${appUrl}/login`, {}, { required: false, ok: (res) => res.status === 200 }),
  ]);

  console.log(`Supabase: ${new URL(supabaseUrl).host}   App: ${new URL(appUrl).host}`);
  for (const { label, passed, required, detail } of results) {
    const mark = passed ? "ok  " : required ? "FAIL" : "warn";
    console.log(`${mark}  ${label.padEnd(26)} ${detail}`);
  }
  if (!process.env.SUPABASE_SECRET_KEY) {
    console.log("warn  SUPABASE_SECRET_KEY is not set: PDF uploads, links and rate limiting need it");
  }

  const failed = results.filter((r) => r.required && !r.passed);
  if (failed.length > 0) {
    console.log("\nSupabase isn't fully reachable. If the local stack is stopped, start it with `npm run db:start`,");
    console.log("then check `npx supabase status`. The portal shows a \"temporarily unavailable\" state meanwhile.");
    process.exit(1);
  }
  if (!results[3].passed) console.log("\nThe app isn't answering at that address. Start it with `npm run dev` or `npm run start`.");
}

await main();
