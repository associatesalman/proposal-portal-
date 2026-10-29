#!/usr/bin/env node
// Storage cleanup for the private "proposals" bucket.
//
// Finds objects that nothing references any more (abandoned uploads,
// superseded revisions, leftovers of failed operations) and, only with
// --apply, deletes them through the Storage API.
//
//   npm run storage:cleanup                       dry run (default): report only
//   npm run storage:cleanup -- --apply            delete the candidates
//   npm run storage:cleanup -- --older-than-hours 72
//   npm run storage:cleanup -- --prefix <owner-id>/   limit to one folder
//
// Safety rules (see docs/PHASE_7_HARDENING_SUMMARY.md, "Storage cleanup"):
// - Only the "proposals" bucket; only names in the application's layout
//   ({owner}/{proposal}/[{revision}/](original|preview).pdf, and
//   {owner}/{proposal}/{revision}/source.(docx|doc|odt|rtf|txt) for
//   converted uploads). Anything else is reported as "unrecognised" and
//   never deleted.
// - Never a proposal's current original, preview or source file, and never
//   a purchased revision's PDF or source ("referenced").
// - Never anything newer than the age threshold (default 24 h, minimum 2 h).
//   The app refuses to finish an upload more than 1 hour after the object
//   was stored, so an object old enough to be a candidate can never become
//   referenced later.
// - Every batch is re-checked in the database immediately before deletion.
// - Deletions are retried, partial failures are reported, and every applied
//   deletion (or failure) is written to an audit table
//   (public.storage_cleanup_history() lists it).
// - Output contains counts and sizes only. Object names are printed only
//   with --show-paths; secrets and document contents are never printed.
//
// Requires NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_SERVER_URL) and
// SUPABASE_SECRET_KEY, read from the environment or .env.local.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

export const BUCKET = "proposals";
export const DEFAULT_AGE_HOURS = 24;
// Must stay above the app's upload completion window (1 hour,
// UPLOAD_COMPLETION_WINDOW_MS in proposal-setup-actions.ts).
export const MIN_AGE_HOURS = 2;
const PAGE_SIZE = 500;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 3;
const DEFAULT_MAX_OBJECTS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function withRetries(label, call) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await call();
      if (!result.error) return result;
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }
  const code = lastError?.code ?? lastError?.statusCode ?? lastError?.name ?? "unknown";
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts (${code})`);
}

// The cleanup itself. `now` exists for tests (to treat fresh fixtures as
// old); the command line always uses the real clock.
export async function runStorageCleanup(client, options = {}) {
  const {
    apply = false,
    olderThanHours = DEFAULT_AGE_HOURS,
    prefix = "",
    maxObjects = DEFAULT_MAX_OBJECTS,
    now = new Date(),
    log = () => {},
  } = options;

  if (!Number.isFinite(olderThanHours) || olderThanHours < MIN_AGE_HOURS) {
    throw new Error(`--older-than-hours must be at least ${MIN_AGE_HOURS}`);
  }
  const createdBefore = new Date(now.getTime() - olderThanHours * 3600 * 1000).toISOString();
  const runId = randomUUID();

  const counts = { referenced: 0, recent: 0, unrecognised: 0, orphan: 0 };
  const candidates = [];
  let truncated = false;
  let after = "";

  // 1. Scan (keyset pagination by name).
  for (;;) {
    const { data } = await withRetries("scan", () =>
      client.rpc("storage_cleanup_scan", {
        p_created_before: createdBefore,
        p_prefix: prefix,
        p_after: after,
        p_limit: PAGE_SIZE,
      }),
    );
    const rows = data ?? [];
    for (const row of rows) {
      counts[row.classification] = (counts[row.classification] ?? 0) + 1;
      if (row.classification === "orphan") {
        if (candidates.length < maxObjects) candidates.push(row);
        else truncated = true;
      }
    }
    if (rows.length < PAGE_SIZE) break;
    after = rows[rows.length - 1].name;
  }

  const report = {
    runId,
    mode: apply ? "apply" : "dry-run",
    olderThanHours,
    createdBefore,
    prefix: prefix || null,
    counts,
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0),
    truncated,
    deleted: 0,
    deletedBytes: 0,
    skippedOnRecheck: 0,
    failed: 0,
    candidateNames: candidates.map((row) => row.name),
    deletedNames: [],
  };

  if (!apply || candidates.length === 0) return report;

  // 2. Apply, batch by batch: re-check, delete, verify, audit.
  for (let index = 0; index < candidates.length; index += BATCH_SIZE) {
    const batch = candidates.slice(index, index + BATCH_SIZE);
    const audit = [];
    let still;
    try {
      const { data } = await withRetries("recheck", () =>
        client.rpc("storage_cleanup_recheck", {
          p_names: batch.map((row) => row.name),
          p_created_before: createdBefore,
        }),
      );
      still = new Set(data ?? []);
    } catch (error) {
      log(`batch ${index / BATCH_SIZE + 1}: ${error.message}; skipped`);
      report.failed += batch.length;
      continue;
    }

    const targets = batch.filter((row) => still.has(row.name));
    report.skippedOnRecheck += batch.length - targets.length;
    if (targets.length === 0) continue;

    let removed = new Set();
    let failureDetail = null;
    try {
      const { data } = await withRetries("remove", () =>
        client.storage.from(BUCKET).remove(targets.map((row) => row.name)),
      );
      removed = new Set((data ?? []).map((object) => object.name));
    } catch (error) {
      failureDetail = error.message.slice(0, 200);
    }

    for (const row of targets) {
      const ok = removed.has(row.name);
      audit.push({
        name: row.name,
        size_bytes: row.size_bytes,
        created_at: row.created_at,
        outcome: ok ? "deleted" : "failed",
        detail: ok ? null : (failureDetail ?? "not removed by storage"),
      });
      if (ok) {
        report.deleted += 1;
        report.deletedBytes += Number(row.size_bytes ?? 0);
        report.deletedNames.push(row.name);
      } else {
        report.failed += 1;
      }
    }

    try {
      await withRetries("audit", () => client.rpc("storage_cleanup_record", { p_run_id: runId, p_entries: audit }));
    } catch (error) {
      log(`batch ${index / BATCH_SIZE + 1}: audit write failed (${error.message})`);
    }
  }

  // 3. Bounded retention for the rate limiter's expired windows.
  try {
    const { data } = await withRetries("rate-limit prune", () => client.rpc("rate_limit_prune", { p_max: 50000 }));
    report.rateLimitWindowsPruned = data ?? 0;
  } catch (error) {
    log(error.message);
  }

  return report;
}

function parseArgs(argv) {
  const options = { apply: false, olderThanHours: DEFAULT_AGE_HOURS, prefix: "", maxObjects: DEFAULT_MAX_OBJECTS, showPaths: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--older-than-hours") options.olderThanHours = Number(value());
    else if (arg === "--prefix") options.prefix = value();
    else if (arg === "--max-objects") options.maxObjects = Number(value());
    else if (arg === "--show-paths") options.showPaths = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(options.maxObjects) || options.maxObjects < 1 || options.maxObjects > 100000) {
    throw new Error("--max-objects must be a whole number from 1 to 100000");
  }
  return options;
}

const HELP = `Usage: npm run storage:cleanup -- [options]

  --apply                  delete the candidates (default: dry run, nothing changes)
  --older-than-hours <n>   only objects older than n hours (default ${DEFAULT_AGE_HOURS}, minimum ${MIN_AGE_HOURS})
  --prefix <path>          only objects whose name starts with <path>
  --max-objects <n>        at most n candidates per run (default ${DEFAULT_MAX_OBJECTS})
  --show-paths             print candidate object names
  --json                   print the report as JSON`;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(HELP);
    process.exit(2);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const url = process.env.SUPABASE_SERVER_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (environment or .env.local).");
    process.exit(2);
  }
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let report;
  try {
    report = await runStorageCleanup(client, { ...options, log: (line) => console.error(line) });
  } catch (error) {
    console.error(`Storage cleanup failed: ${error.message}`);
    process.exit(1);
  }

  if (!options.showPaths) {
    delete report.candidateNames;
    delete report.deletedNames;
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { counts } = report;
    console.log(`Storage cleanup (${report.mode}), bucket "${BUCKET}"${report.prefix ? `, prefix ${report.prefix}` : ""}`);
    console.log(`  objects older than ${report.olderThanHours} h are eligible (created before ${report.createdBefore})`);
    console.log(`  referenced (kept):     ${counts.referenced}`);
    console.log(`  too recent (kept):     ${counts.recent}`);
    console.log(`  unrecognised (kept):   ${counts.unrecognised}`);
    console.log(`  unreferenced candidates: ${report.candidates} (${formatBytes(report.candidateBytes)})${report.truncated ? " — more remain, run again" : ""}`);
    if (options.showPaths) for (const name of report.candidateNames) console.log(`    ${name}`);
    if (report.mode === "apply") {
      console.log(`  deleted: ${report.deleted} (${formatBytes(report.deletedBytes)}), skipped on re-check: ${report.skippedOnRecheck}, failed: ${report.failed}`);
      console.log(`  audit run id: ${report.runId}`);
    } else if (report.candidates > 0) {
      console.log("  Dry run: nothing was deleted. Re-run with --apply to delete the candidates.");
    }
  }
  if (report.failed > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
