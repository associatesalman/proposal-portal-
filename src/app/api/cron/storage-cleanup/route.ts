import { createHash, timingSafeEqual } from "node:crypto";

import { connection } from "next/server";

import { runScheduledStorageCleanup } from "@/lib/supabase/privileged";

// GET /api/cron/storage-cleanup: the storage cleanup, run by a scheduler
// (Vercel Cron, see vercel.json). Not for people or browsers.
//
// - Disabled (404) unless CRON_SECRET is set to at least 32 characters.
//   Every request must send "Authorization: Bearer <CRON_SECRET>" (what
//   Vercel Cron sends); anything else gets 401. Compared in constant time.
// - DRY RUN by default: reports what would be deleted and deletes nothing.
//   Deletes only when STORAGE_CLEANUP_CRON_APPLY=true. The cleanup logic,
//   age threshold and protections are those of scripts/storage-cleanup.mjs
//   (referenced files and anything newer than the threshold are kept).
// - Safe to run twice (scheduler deliveries may repeat): each run re-scans
//   and re-checks every batch in the database before deleting.
// - The response and logs carry counts only (no object names, no secrets).

export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };
const MIN_SECRET_LENGTH = 32;
const DEFAULT_AGE_HOURS = 24;
const MIN_AGE_HOURS = 2;
const MAX_OBJECTS = 2000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

function ageHours(): number {
  const value = Number(process.env.STORAGE_CLEANUP_OLDER_THAN_HOURS ?? DEFAULT_AGE_HOURS);
  return Number.isFinite(value) && value >= MIN_AGE_HOURS ? value : DEFAULT_AGE_HOURS;
}

export async function GET(request: Request) {
  await connection();

  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  }
  if (!authorized(request, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const apply = process.env.STORAGE_CLEANUP_CRON_APPLY === "true";
  try {
    const summary = await runScheduledStorageCleanup({ apply, olderThanHours: ageHours(), maxObjects: MAX_OBJECTS });
    console.log(
      `[cron] storage cleanup ${summary.mode}: candidates ${summary.candidates}, deleted ${summary.deleted}, ` +
        `failed ${summary.failed}, pending deletions ${summary.pendingDeletions ?? "unknown"}`,
    );
    return Response.json(summary, { status: summary.failed > 0 ? 500 : 200, headers: NO_STORE });
  } catch {
    console.error("[cron] storage cleanup failed");
    return Response.json({ error: "cleanup failed" }, { status: 503, headers: NO_STORE });
  }
}
