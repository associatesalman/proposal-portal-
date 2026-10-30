#!/usr/bin/env node
// Runs a command (build, start) for a PayPal SANDBOX test against the LOCAL
// Supabase stack, without editing .env.local (which may point at hosted).
//
//   node scripts/sandbox-local.mjs npm run build
//   node scripts/sandbox-local.mjs node node_modules/next/dist/bin/next start -p 3106
//
// Process environment, which Next.js gives precedence over .env files:
//   - NEXT_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY / SUPABASE_SECRET_KEY from
//     `npx supabase status` (the local stack; refused if not 127.0.0.1), so
//     sandbox payment records never reach the hosted database;
//   - every KEY=value line of .env.sandbox.local (git-ignored; e.g.
//     NEXT_PUBLIC_APP_URL=https://<tunnel>, PAYMENTS_ENABLED=true,
//     PAYPAL_WEBHOOK_ID=<sandbox webhook id>).
// PayPal credentials stay in .env.local. Refuses to run unless the effective
// PAYPAL_ENVIRONMENT is "sandbox" and PAYPAL_API_BASE_URL is unset. Prints
// variable names only, never values.

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const OVERRIDES = ".env.sandbox.local";

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const status = JSON.parse(execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString());
if (new URL(status.API_URL).hostname !== "127.0.0.1") {
  console.error("sandbox-local: the Supabase CLI did not report the local stack; refusing.");
  process.exit(1);
}

const local = parseEnvFile(".env.local");
const overrides = parseEnvFile(OVERRIDES);
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) {
  if (name in overrides) {
    console.error(`sandbox-local: ${name} must not be set in ${OVERRIDES} (the local stack is used); refusing.`);
    process.exit(1);
  }
}

const effective = { ...local, ...overrides };
if ((effective.PAYPAL_ENVIRONMENT ?? "").trim() !== "sandbox") {
  console.error("sandbox-local: PAYPAL_ENVIRONMENT must be sandbox; refusing.");
  process.exit(1);
}
if ((effective.PAYPAL_API_BASE_URL ?? "").trim()) {
  console.error("sandbox-local: PAYPAL_API_BASE_URL is for automated tests only; refusing.");
  process.exit(1);
}

const env = {
  ...process.env,
  ...overrides,
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: status.SECRET_KEY,
};
console.log(`sandbox-local: local Supabase; overrides from ${OVERRIDES}: ${Object.keys(overrides).join(", ") || "(none)"}`);

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node scripts/sandbox-local.mjs <command> [args...]");
  process.exit(1);
}
// Windows needs a shell to run npm/npx (.cmd). Pass one command line rather
// than an argument array, which Node deprecates with shell: true (DEP0190).
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const child =
  process.platform === "win32"
    ? spawn([cmd, ...args].map(quote).join(" "), { env, stdio: "inherit", shell: true })
    : spawn(cmd, args, { env, stdio: "inherit" });
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
