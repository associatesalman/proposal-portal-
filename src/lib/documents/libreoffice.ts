import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { SourceFormat } from "./formats";

// Server-side conversion with headless LibreOffice (an OPTIONAL dependency:
// it is not part of this app and does not exist on Vercel's serverless
// runtime; see docs/FEATURE_FULL_ACCESS_MULTIFORMAT.md). Configure it with
// LIBREOFFICE_PATH, the absolute path of the soffice executable.
//
// Every conversion:
//   - runs in its own fresh temporary directory (input, output and a
//     throw-away LibreOffice profile), removed afterwards whatever happens;
//   - spawns the executable directly with an argument array (no shell, so
//     nothing in a file name or path is ever interpreted), with a minimal
//     environment and a fixed input name (source.<ext>);
//   - uses a profile that disables macros (security level "very high",
//     macro execution off), never updates links and blocks untrusted
//     referer links, so documents can't run code or fetch resources;
//   - is killed (whole process tree) after DOCUMENT_CONVERSION_TIMEOUT_MS;
//   - has its output size capped (MAX_OUTPUT_BYTES) before it is read;
//   - waits for a slot: at most DOCUMENT_CONVERSION_CONCURRENCY run at once
//     on this server instance, so memory use stays bounded.
// Memory is not limited per process by this code: run the app in a
// container/VM with a memory limit (documented).
//
// LIBREOFFICE_TEST_DOUBLE (tests only): a .mjs inside supabase/tests/ run
// with this Node binary instead of soffice, to test the adapter itself
// (timeouts, failures, output limits, cleanup). Refused on Vercel.

export type ConverterConfig =
  | { kind: "libreoffice"; executable: string }
  | { kind: "double"; script: string };

export type ConversionResult =
  | { ok: true; pdf: Uint8Array }
  | { ok: false; reason: "unavailable" | "timeout" | "failed" | "no_output" | "too_large" | "busy" };

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024; // the storage bucket's file limit
const QUEUE_WAIT_MS = 30_000;

let configCache: { key: string; value: ConverterConfig | null } | null = null;

export function converterConfig(): ConverterConfig | null {
  const executable = process.env.LIBREOFFICE_PATH?.trim() ?? "";
  const double = process.env.LIBREOFFICE_TEST_DOUBLE?.trim() ?? "";
  const key = `${executable}\u0000${double}`;
  if (configCache?.key === key) return configCache.value;

  let value: ConverterConfig | null = null;
  if (double) {
    const testsDir = path.resolve(process.cwd(), "supabase", "tests") + path.sep;
    const resolved = path.resolve(double);
    if (!process.env.VERCEL && resolved.startsWith(testsDir) && resolved.endsWith(".mjs")) {
      value = { kind: "double", script: resolved };
    } else {
      console.error("[documents] LIBREOFFICE_TEST_DOUBLE ignored (tests only)");
    }
  } else if (executable) {
    if (path.isAbsolute(executable)) value = { kind: "libreoffice", executable };
    else console.error("[documents] LIBREOFFICE_PATH must be an absolute path; conversion disabled");
  }
  configCache = { key, value };
  return value;
}

export function conversionTimeoutMs(): number {
  const raw = Number(process.env.DOCUMENT_CONVERSION_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 1000 ? Math.min(raw, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function concurrency(): number {
  const raw = Number(process.env.DOCUMENT_CONVERSION_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 8) : 1;
}

// --- A small in-process semaphore -----------------------------------------

let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<boolean> {
  if (running < concurrency()) {
    running++;
    return true;
  }
  return new Promise((resolve) => {
    const grant = () => {
      clearTimeout(timer);
      running++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(grant);
      if (index >= 0) waiting.splice(index, 1);
      resolve(false);
    }, QUEUE_WAIT_MS);
    waiting.push(grant);
  });
}

function release() {
  running--;
  const next = waiting.shift();
  if (next) next();
}

// --- Profile ----------------------------------------------------------------

const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseOpenCL" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Field" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Internet"><prop oor:name="ooInetProxyType" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`;

// --- Conversion -------------------------------------------------------------

export async function convertWithLibreOffice(
  bytes: Uint8Array,
  format: SourceFormat,
): Promise<ConversionResult> {
  const config = converterConfig();
  if (!config) return { ok: false, reason: "unavailable" };
  if (!(await acquire())) return { ok: false, reason: "busy" };

  let workspace: string | null = null;
  try {
    workspace = await mkdtemp(path.join(tmpdir(), "proposal-convert-"));
    const input = path.join(workspace, "in");
    const output = path.join(workspace, "out");
    const profile = path.join(workspace, "profile");
    await Promise.all([mkdir(input), mkdir(output), mkdir(path.join(profile, "user"), { recursive: true })]);
    await writeFile(path.join(profile, "user", "registrymodifications.xcu"), PROFILE, "utf8");
    const source = path.join(input, `source.${format}`);
    await writeFile(source, bytes);

    const args = [
      "--headless",
      "--invisible",
      "--norestore",
      "--nolockcheck",
      "--nodefault",
      "--nologo",
      "--nofirststartwizard",
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      output,
      source,
    ];
    const command = config.kind === "double" ? process.execPath : config.executable;
    const commandArgs = config.kind === "double" ? [config.script, ...args] : args;

    const exit = await run(command, commandArgs, workspace, conversionTimeoutMs());
    if (exit === "timeout") return { ok: false, reason: "timeout" };
    if (exit === "spawn_error") return { ok: false, reason: "unavailable" };

    const result = path.join(output, "source.pdf");
    const info = await stat(result).catch(() => null);
    if (!info || !info.isFile() || info.size === 0) return { ok: false, reason: exit === 0 ? "no_output" : "failed" };
    if (info.size > MAX_OUTPUT_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, pdf: new Uint8Array(await readFile(result)) };
  } catch (error) {
    console.error("[documents] conversion workspace error", (error as { code?: string })?.code ?? "unknown");
    return { ok: false, reason: "failed" };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    release();
  }
}

function run(command: string, args: string[], workspace: string, timeoutMs: number) {
  return new Promise<number | "timeout" | "spawn_error">((resolve) => {
    const windows = process.platform === "win32";
    const child = spawn(command, args, {
      shell: false,
      cwd: workspace,
      windowsHide: true,
      // Its own process group on POSIX, so the whole tree can be killed.
      detached: !windows,
      stdio: ["ignore", "ignore", "ignore"],
      env: childEnv(workspace, windows),
    });

    let settled = false;
    let timedOut = false;
    const finish = (value: number | "timeout" | "spawn_error") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(value);
    };
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, windows);
      // Wait (briefly) for the process to be gone so its files can be removed.
      grace = setTimeout(() => finish("timeout"), 5000);
    }, timeoutMs);

    child.once("error", () => finish("spawn_error"));
    child.once("exit", (code) => finish(timedOut ? "timeout" : (code ?? 1)));
  });
}

// A minimal environment: no secrets from this process reach the converter.
function childEnv(workspace: string, windows: boolean): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    ...(windows ? { SystemRoot: process.env.SystemRoot ?? "C:\Windows" } : {}),
    HOME: workspace,
    USERPROFILE: workspace,
    TMPDIR: workspace,
    TEMP: workspace,
    TMP: workspace,
    LANG: "C.UTF-8",
    SAL_USE_VCLPLUGIN: "svp",
    NODE_ENV: "production",
  };
}

function killTree(pid: number | undefined, windows: boolean) {
  if (!pid) return;
  try {
    if (windows) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}
