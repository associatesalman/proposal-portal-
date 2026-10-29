// Phase 2 app-level auth checks against a running app + LOCAL Supabase.
//
//   npm run db:start
//   npm run build && npm run start      # in another terminal (uses .env.local)
//   npm run test:app
//
// Signs disposable users in through Supabase Auth with the same cookie format
// the app uses (@supabase/ssr), then requests app routes with those cookies.
// The local secret key is used only to provision/clean up the disposable users.

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

const runId = randomBytes(4).toString("hex");
// Text only the rendered dashboard contains (Phase 2: placeholder; Phase 3+: summary cards).
const DASHBOARD_MARKER = "Total clients";
const trusted = createClient(API_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const userIds = [];
const results = [];

function check(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}${!passed && detail ? ` — ${detail}` : ""}`);
}

async function provisionUser(label, role) {
  const email = `phase2-app-${label}-${runId}@test.local`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await trusted.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  userIds.push(data.user.id);
  const fullName = `App Test ${label} ${runId}`;
  if (role) {
    const { error: pe } = await trusted
      .from("profiles")
      .insert({ id: data.user.id, full_name: fullName, role });
    if (pe) throw new Error(`profile ${label}: ${pe.message}`);
  }
  return { email, password, fullName };
}

// Returns a Cookie header for a signed-in session, in @supabase/ssr format.
async function sessionCookie(user) {
  const jar = new Map();
  const client = createServerClient(API_URL, PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) =>
        cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw new Error(`signIn: ${error.message}`);
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function get(path, cookie) {
  return fetch(`${APP_URL}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Collects the hidden inputs (incl. React's server-action fields) of the
// form that contains `marker`, so it can be submitted like a no-JS browser.
function hiddenFields(html, marker) {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes(marker));
  if (!form) throw new Error(`form containing ${marker} not found`);
  const fields = new FormData();
  for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
    if (!/type="hidden"/.test(tag)) continue;
    const name = tag.match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    fields.append(decodeEntities(name), decodeEntities(tag.match(/value="([^"]*)"/)?.[1] ?? ""));
  }
  return fields;
}

function setCookies(res) {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]);
}

async function submitLogin(email, password) {
  const page = await get("/login");
  const fields = hiddenFields(await page.text(), 'name="password"');
  fields.append("email", email);
  fields.append("password", password);
  return fetch(`${APP_URL}/login`, {
    method: "POST",
    body: fields,
    redirect: "manual",
    headers: { origin: APP_URL },
  });
}

async function main() {
  const admin = await provisionUser("admin", "admin");
  const lead = await provisionUser("lead", "team_lead");
  const noProfile = await provisionUser("no-profile", null);

  {
    const res = await get("/dashboard");
    const location = res.headers.get("location") ?? "";
    check(
      "unauthenticated /dashboard redirects to /login?next=/dashboard",
      res.status === 307 && location.includes("/login?next=%2Fdashboard"),
      `${res.status} ${location}`,
    );
  }
  {
    const res = await get("/dashboard", "sb-127-auth-token=forged");
    check("forged session cookie is treated as unauthenticated", res.status === 307);
  }
  {
    const res = await get("/login");
    const html = await res.text();
    check(
      "/login renders email + password form with no signup option",
      res.status === 200 &&
        html.includes('name="email"') &&
        html.includes('name="password"') &&
        !/sign ?up|register|create account/i.test(html),
    );
  }

  const adminCookie = await sessionCookie(admin);
  {
    const res = await get("/dashboard", adminCookie);
    const html = await res.text();
    check(
      "admin sees dashboard with name and CEO/Admin role",
      res.status === 200 &&
        html.includes(admin.fullName) &&
        html.includes("CEO/Admin") &&
        html.includes(DASHBOARD_MARKER),
    );
  }

  const leadCookie = await sessionCookie(lead);
  {
    const res = await get("/dashboard", leadCookie);
    const html = await res.text();
    check(
      "team lead sees dashboard with name and Team Lead role",
      res.status === 200 && html.includes(lead.fullName) && html.includes("Team Lead"),
    );
  }
  {
    // Authenticated internal users are sent from /login to /dashboard.
    const res = await get("/login", leadCookie);
    const html = await res.text();
    const redirected =
      (res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/dashboard")) ||
      html.includes("/dashboard");
    check("authenticated internal user is redirected from /login to /dashboard", redirected);
    check("…and the login form is not rendered for them", !html.includes('name="password"'));
  }
  {
    const res = await get("/login?next=https://evil.example/phish", leadCookie);
    const html = await res.text();
    // The page streams its redirect; the router payload also echoes the
    // current URL, so inspect the redirect target itself.
    const location = res.headers.get("location") ?? "";
    const targets = [...html.matchAll(/NEXT_REDIRECT;\w+;([^;]+);/g)].map((m) => m[1]);
    check(
      "external next= target is ignored (falls back to /dashboard)",
      !location.includes("evil.example") &&
        targets.length > 0 &&
        targets.every((target) => target === "/dashboard"),
      `targets: ${targets.join(", ")}`,
    );
  }

  // --- Real login form + sign out (server actions, submitted without JS) ---
  {
    const res = await submitLogin(lead.email, "definitely-not-the-password");
    const html = await res.text();
    check(
      "login form: wrong password shows generic error and sets no session",
      html.includes("Invalid email or password.") &&
        !setCookies(res).some((c) => c.includes("auth-token=") && !c.endsWith("=")),
    );
  }
  {
    const res = await submitLogin(`nobody-${runId}@test.local`, "whatever-password");
    const html = await res.text();
    check(
      "login form: unknown email shows the same generic error",
      html.includes("Invalid email or password."),
    );
  }
  {
    const res = await submitLogin(noProfile.email, noProfile.password);
    const html = await res.text();
    check(
      "login form: valid credentials without profile are rejected",
      html.includes("not authorized to use the portal") &&
        !(res.headers.get("location") ?? "").includes("/dashboard"),
    );
  }
  {
    const res = await submitLogin(lead.email, lead.password);
    const location = res.headers.get("location") ?? "";
    const cookies = setCookies(res).filter((c) => !c.endsWith("="));
    check(
      "login form: valid internal account signs in and redirects to /dashboard",
      res.status >= 300 && res.status < 400 && location.endsWith("/dashboard") && cookies.length > 0,
      `${res.status} ${location}`,
    );

    const cookie = cookies.join("; ");
    const dash = await get("/dashboard", cookie);
    const dashHtml = await dash.text();
    check("login form: session cookie opens the dashboard", dashHtml.includes(lead.fullName));

    const signOutFields = hiddenFields(dashHtml, "Sign out");
    const out = await fetch(`${APP_URL}/dashboard`, {
      method: "POST",
      body: signOutFields,
      redirect: "manual",
      headers: { cookie, origin: APP_URL },
    });
    const outLocation = out.headers.get("location") ?? "";
    check(
      "sign out: redirects to /login and clears the session cookie",
      out.status >= 300 &&
        out.status < 400 &&
        outLocation.endsWith("/login") &&
        setCookies(out).some((c) => c.includes("auth-token") && c.endsWith("=")),
      `${out.status} ${outLocation}`,
    );

    // The old cookie must no longer work: the session was revoked server-side.
    const after = await get("/dashboard", cookie);
    const afterHtml = await after.text();
    check(
      "sign out: the previous session cookie no longer opens the dashboard",
      !afterHtml.includes(lead.fullName),
    );
  }

  const noProfileCookie = await sessionCookie(noProfile);
  {
    const res = await get("/dashboard", noProfileCookie);
    const html = await res.text();
    check(
      "user without internal profile is denied the dashboard",
      !html.includes(DASHBOARD_MARKER) &&
        html.includes("/login?error=no_access"),
    );
  }
  {
    const res = await get("/login", noProfileCookie);
    const html = await res.text();
    check(
      "user without profile sees the not-authorized notice on /login",
      res.status === 200 && html.includes("not authorized to use the portal"),
    );
  }
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
} finally {
  for (const id of userIds) await trusted.auth.admin.deleteUser(id);
}

if (fatal) {
  console.error(`\nAborted: ${fatal.message}`);
  process.exit(1);
}
const failed = results.filter((passed) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed === 0 ? 0 : 1);
