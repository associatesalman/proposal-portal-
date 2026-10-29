// Bounded networking for server-side Supabase clients.
//
// Without limits, an unreachable Supabase makes requests hang or retry for a
// long time: auth-js retries a failed token refresh with exponential backoff
// for up to ~30 s per call, and the proxy and the page each made one, so
// /login took ~52 s during an outage. Two mechanisms bound that:
//
// 1. Every request must receive response HEADERS within
//    SUPABASE_FETCH_TIMEOUT_MS (default 10 s). Bodies are not limited, so
//    large PDF downloads and preview streams are not cut off.
// 2. `withAuthDeadline()` gives an auth call (getUser, getClaims, sign-in)
//    SUPABASE_AUTH_TIMEOUT_MS (default 6 s). When it expires, the caller gets
//    "unavailable" and this client's remaining auth requests fail at once
//    without touching the network. That stops auth-js's background retry
//    loop from refreshing (and rotating) the browser's refresh token after
//    the response has already been sent, which would otherwise sign the user
//    out once the service came back.

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_TIMEOUT_MS = 6_000;

function readMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 100 && value <= 120_000 ? value : fallback;
}

export class SupabaseTimeoutError extends Error {
  constructor(message = "Supabase did not respond in time") {
    super(message);
    this.name = "SupabaseTimeoutError";
  }
}

export type BoundedFetch = typeof fetch & {
  // Makes every later request to the auth API fail immediately.
  closeAuth(): void;
};

function isAuthRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.includes("/auth/v1/");
}

export function createBoundedFetch(): BoundedFetch {
  const timeoutMs = readMs("SUPABASE_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
  let authClosed = false;

  const bounded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (authClosed && isAuthRequest(input)) {
      throw new TypeError("fetch failed: auth deadline exceeded");
    }
    const controller = new AbortController();
    const outer = init?.signal;
    const onOuterAbort = () => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new SupabaseTimeoutError()), timeoutMs);
    try {
      // Only the wait for response headers is bounded; the body may stream.
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      // auth-js and postgrest-js treat a TypeError as a network failure
      // (retryable / status 0).
      if (controller.signal.aborted && !outer?.aborted) {
        throw new TypeError("fetch failed: Supabase request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }) as BoundedFetch;

  bounded.closeAuth = () => {
    authClosed = true;
  };
  return bounded;
}

export type Deadline<T> = { ok: true; value: T } | { ok: false; timedOut: true };

// Runs an auth call with a deadline. On timeout the client's auth requests
// are closed (see above) and { ok: false } is returned; the abandoned call
// settles later without network effects.
export async function withAuthDeadline<T>(boundedFetch: BoundedFetch, call: () => Promise<T>): Promise<Deadline<T>> {
  const ms = readMs("SUPABASE_AUTH_TIMEOUT_MS", DEFAULT_AUTH_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Deadline<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
  });
  const run = call().then((value): Deadline<T> => ({ ok: true, value }));
  // An abandoned call may still reject later; never leave that unhandled.
  run.catch(() => {});
  try {
    const result = await Promise.race([run, timeout]);
    if (!result.ok) boundedFetch.closeAuth();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// True for failures that mean "Supabase couldn't be reached or is failing",
// as opposed to a definite answer (invalid session, permission denied).
export function isUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; status?: number; code?: string; message?: string };
  if (e.name === "AuthRetryableFetchError") return true;
  if (e.name === "SupabaseTimeoutError" || e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (typeof e.status === "number" && (e.status === 0 || e.status >= 500)) return true;
  // postgrest-js reports network failures as { code: "", message: "TypeError: fetch failed" }.
  if (typeof e.message === "string" && /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(e.message)) {
    return true;
  }
  return false;
}
