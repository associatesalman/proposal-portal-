// Phase 3 browser checks: real (headless) Chrome driven over the DevTools
// protocol, against a running app + LOCAL Supabase.
//
//   npm run build && npm run start
//   CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" \
//     node supabase/tests/integration/phase3-browser.mjs <screenshot-dir>
//
// Uses a throwaway Chrome profile inside <screenshot-dir>. Disposable users
// are provisioned with the local secret key and removed afterwards; all UI
// actions run as those users through the real login form.

import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createClient } from "@supabase/supabase-js";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH;
const OUT = process.argv[2];
if (!CHROME || !OUT) {
  console.error("Usage: CHROME_PATH=... node phase3-browser.mjs <screenshot-dir>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const status = JSON.parse(
  execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString(),
);
for (const url of [status.API_URL, APP_URL]) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`non-local host ${host}`);
}
const trusted = createClient(status.API_URL, status.SECRET_KEY ?? status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const runId = randomBytes(3).toString("hex");
const userIds = [];
const results = [];
function check(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "ok    " : "FAIL  "} ${name}${!passed && detail ? ` — ${detail}` : ""}`);
}

async function provision(label, role) {
  const email = `p3ui-${label}-${runId}@test.local`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await trusted.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user.id);
  const fullName = `UI ${label} ${runId}`;
  await trusted.from("profiles").insert({ id: data.user.id, full_name: fullName, role });
  return { id: data.user.id, email, password, fullName };
}

// --- Minimal CDP client --------------------------------------------------------

const profileDir = join(OUT, "chrome-profile");
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let nextId = 1;
const browserLog = [];
const pending = new Map();

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pageTarget = targets.find((t) => t.type === "page");
      if (pageTarget) {
        ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.method === "Runtime.exceptionThrown") {
            browserLog.push(`exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
          } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
            browserLog.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
          }
          if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        };
        return;
      }
    } catch {
      // Chrome not up yet.
    }
    await sleep(200);
  }
  throw new Error("Could not connect to headless Chrome");
}

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      // Page mid-navigation.
    }
    await sleep(100);
  }
  return false;
}

async function navigate(path) {
  await send("Page.navigate", { url: `${APP_URL}${path}` });
  await sleep(300);
  await waitFor("document.readyState === 'complete'");
}

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}

async function key(keyName, code = keyName, keyCode = 0, modifiers = 0) {
  // Enter needs `text` so Chrome performs the default action (implicit form submit).
  const text = keyName === "Enter" ? "\r" : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
}

async function typeInto(selector, text) {
  if (!(await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 10000))) {
    throw new Error(`no element ${selector} to type into`);
  }
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); })()`);
  await send("Input.insertText", { text });
}

async function clickSelector(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`no element ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
}

// Only visible, enabled elements count: controls that need JavaScript are
// rendered disabled until they work (observable readiness, Phase 6).
const byText = (tag, text) =>
  `[...document.querySelectorAll(${JSON.stringify(tag)})].find((el) => el.textContent.trim().includes(${JSON.stringify(text)}) && el.checkVisibility() && !el.disabled)`;

async function clickText(tag, text) {
  const id = `cdp-${randomBytes(3).toString("hex")}`;
  await waitFor(`!!${byText(tag, text)}`, 15000);
  const found = await evaluate(`(() => { const el = ${byText(tag, text)}; if (!el) return false; el.id ||= ${JSON.stringify(id)}; return el.id; })()`);
  if (!found) throw new Error(`no visible, enabled ${tag} with text ${text}`);
  await clickSelector(`[id=${JSON.stringify(found)}]`);
}

const openDialog = "document.querySelector('dialog[open]')";

// True once the element is visible and enabled (the password toggle is
// disabled until the login form is interactive).
const ready = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.checkVisibility() && !el.disabled; })()`;

async function login(user) {
  await navigate("/login");
  await waitFor(ready("[data-password-toggle]"), 15000);
  await typeInto("input[name=email]", user.email);
  await typeInto("input[name=password]", user.password);
  const typed = await evaluate(
    `document.querySelector('input[name=email]').value === ${JSON.stringify(user.email)} && document.querySelector('input[name=password]').value.length > 0`,
  );
  if (!typed) throw new Error("typing into the login form failed");
  await key("Enter", "Enter", 13);
  const ok = await waitFor(
    "location.pathname === '/dashboard' && !!document.querySelector('[aria-labelledby=summary-heading]')",
    15000,
  );
  if (!ok) {
    const state = await evaluate("location.href + ' | ' + document.body.innerText.slice(0, 300).replace(/\\s+/g, ' ')");
    browserLog.push(`after login submit: ${state}`);
  }
  return ok;
}

// --- Scenario ----------------------------------------------------------------

async function main() {
  const lead = await provision("lead", "team_lead");
  const other = await provision("other", "team_lead");
  const admin = await provision("admin", "admin");
  await trusted.from("clients").insert({ owner_id: other.id, name: `Other Lead Client ${runId}`, email: `o-${runId}@x.test` });

  await connect();
  await send("Page.enable");
  await send("Runtime.enable");

  // Unauthenticated → login
  await navigate("/dashboard");
  check("signed-out browser lands on /login", await waitFor("location.pathname === '/login'"));

  // Login through the real form
  check("lead logs in through the form and reaches the dashboard", await login(lead));
  await screenshot("01-lead-empty-desktop");
  check(
    "empty state and zero totals render",
    await evaluate(`document.body.innerText.includes('No clients yet') && document.body.innerText.includes('Your overall totals')`),
  );

  // Add client dialog: open, focus inside, Escape closes and restores focus
  await clickText("button", "Add client");
  check("Add client opens a modal dialog", await waitFor(`!!${openDialog}`));
  check(
    "focus moves into the dialog",
    await evaluate(`${openDialog}?.contains(document.activeElement)`),
  );
  for (let i = 0; i < 8; i++) await key("Tab", "Tab", 9);
  check(
    "Tab keeps focus inside the modal",
    await evaluate(`${openDialog}?.contains(document.activeElement)`),
  );
  await screenshot("02-add-client-dialog");
  await key("Escape", "Escape", 27);
  check("Escape closes the dialog", await waitFor(`!${openDialog}`));
  check(
    "focus returns to the Add client button",
    await evaluate(`document.activeElement?.textContent?.includes('Add client')`),
  );

  // Server-side validation with value preservation (whitespace-only name passes native `required`)
  await clickText("button", "Add client");
  await waitFor(`!!${openDialog}`);
  await typeInto("dialog[open] input[name=name]", "   ");
  await typeInto("dialog[open] input[name=email]", `keep-${runId}@client.test`);
  await clickSelector("dialog[open] button[type=submit]");
  check(
    "server validation error shows inline",
    await waitFor(`${openDialog}?.innerText.includes('Enter a client name.')`),
  );
  check(
    "entered email is preserved after the validation error",
    await evaluate(`document.querySelector('dialog[open] input[name=email]').value === ${JSON.stringify(`keep-${runId}@client.test`)}`),
  );
  check(
    "invalid field is marked aria-invalid and described by its error",
    await evaluate(`(() => { const el = document.querySelector('dialog[open] input[name=name]'); const id = el.getAttribute('aria-describedby'); return el.getAttribute('aria-invalid') === 'true' && !!id && document.getElementById(id)?.textContent.includes('Enter a client name.'); })()`),
  );
  await screenshot("03-validation-error");

  // Valid submission
  await typeInto("dialog[open] input[name=name]", `Acme UI ${runId}`);
  await clickSelector("dialog[open] button[type=submit]");
  check("successful submit closes the dialog", await waitFor(`!${openDialog}`));
  check(
    "success feedback is announced",
    await waitFor(`document.querySelector('[role=status][aria-live=polite]')?.innerText.includes('added')`),
  );
  check(
    "new client appears with refreshed totals (no reload)",
    await waitFor(`document.body.innerText.includes('Acme UI ${runId}') && document.querySelector('dd')?.textContent.trim() === '1'`),
  );
  await screenshot("04-client-added");

  // Reopen: fresh form (no stale error)
  await clickText("button", "Add client");
  await waitFor(`!!${openDialog}`);
  check(
    "reopened dialog starts clean",
    await evaluate(`!${openDialog}.innerText.includes('Enter a client name.') && document.querySelector('dialog[open] input[name=name]').value === ''`),
  );
  await key("Escape", "Escape", 27);
  await waitFor(`!${openDialog}`);

  // Edit client
  await clickSelector(`button[aria-label="Edit client Acme UI ${runId}"]`);
  await waitFor(`!!${openDialog}`);
  check(
    "edit dialog is prefilled",
    await evaluate(`document.querySelector('dialog[open] input[name=name]').value === 'Acme UI ${runId}'`),
  );
  await typeInto("dialog[open] input[name=name]", `Acme UI Renamed ${runId}`);
  await clickSelector("dialog[open] button[type=submit]");
  check(
    "client edit saves and the row updates",
    await waitFor(`!${openDialog} && document.body.innerText.includes('Acme UI Renamed ${runId}')`),
  );

  // Proposals tab + new draft
  await clickText("a", "Proposals");
  await waitFor("location.search.includes('tab=proposals')");
  await clickText("button", "New proposal");
  await waitFor(`!!${openDialog}`);
  const clientValue = await evaluate(
    `[...document.querySelectorAll('dialog[open] select[name=clientId] option')].find((o) => o.textContent.includes('Acme UI Renamed'))?.value`,
  );
  await evaluate(
    `(() => { const s = document.querySelector('dialog[open] select[name=clientId]'); s.value = ${JSON.stringify(clientValue)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  check(
    "lead's client dropdown excludes other leads' clients",
    await evaluate(`![...document.querySelectorAll('dialog[open] select[name=clientId] option')].some((o) => o.textContent.includes('Other Lead Client'))`),
  );
  await typeInto("dialog[open] input[name=title]", `UI Draft ${runId}`);
  await clickSelector("dialog[open] button[type=submit]");
  check(
    "draft is created and listed as Draft / Not uploaded",
    await waitFor(`!${openDialog} && (() => { const row = [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('UI Draft ${runId}')); return !!row && row.innerText.includes('Draft') && row.innerText.includes('Not uploaded'); })()`),
  );
  await screenshot("05-proposals-desktop");

  // Search + pagination reset (URL has no page param after searching)
  await typeInto("input[name=q]", "UI Draft");
  await key("Enter", "Enter", 13);
  check(
    "search updates the URL without a page parameter",
    await waitFor("location.search.includes('q=UI+Draft') && !location.search.includes('page=')"),
  );

  // Mobile layout
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await navigate("/dashboard");
  await waitFor("!!document.querySelector('tbody tr')");
  check(
    "mobile: no horizontal page overflow",
    await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
  );
  check(
    "mobile: table header is visually hidden and rows stack",
    await evaluate("getComputedStyle(document.querySelector('thead')).position === 'absolute' && ['block', 'grid'].includes(getComputedStyle(document.querySelector('tbody tr')).display)"),
  );
  await screenshot("06-clients-mobile");
  await clickText("button", "Add client");
  await waitFor(`!!${openDialog}`);
  check(
    "mobile: dialog fits the viewport",
    await evaluate(`${openDialog}.getBoundingClientRect().width <= window.innerWidth`),
  );
  await screenshot("07-dialog-mobile");
  await key("Escape", "Escape", 27);
  await send("Emulation.clearDeviceMetricsOverride");

  // Sign out
  await navigate("/dashboard");
  // Clicked as soon as it is visible: Sign out is a plain form POST and works
  // before hydration too (streamed markup is hidden until it is revealed, so
  // waiting for visibility, not for React, is what matters).
  await clickText("button", "Sign out");
  check("Sign out returns to /login", await waitFor("location.pathname === '/login'"));

  // Admin: owner column + filter select auto-submits
  check("admin logs in", await login(admin));
  check("admin sees the Owner column", await evaluate(`[...document.querySelectorAll('th')].some((th) => th.textContent.trim() === 'Owner')`));
  await evaluate(
    `(() => { const s = document.querySelector('select[name=owner]'); s.value = ${JSON.stringify(other.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  check(
    "admin owner filter applies on change",
    await waitFor(`location.search.includes('owner=${other.id}') && document.body.innerText.includes('Overall totals for ${other.fullName}')`),
  );
  check(
    "filtered admin list shows only that lead's clients",
    await evaluate(`[...document.querySelectorAll('td[data-label=Client]')].every((td) => td.textContent.includes('Other Lead Client'))`),
  );
  await screenshot("08-admin-filtered");
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill();
  await sleep(500);
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {}
  if (userIds.length) {
    await trusted.from("proposals").delete().in("owner_id", userIds);
    await trusted.from("clients").delete().in("owner_id", userIds);
    for (const id of userIds) await trusted.auth.admin.deleteUser(id);
  }
}

if (browserLog.length) {
  console.log(`\nBrowser console (${browserLog.length}):\n  ${browserLog.slice(0, 20).join("\n  ")}`);
}
if (fatal) {
  console.error(`\nAborted: ${fatal.message}`);
  process.exit(1);
}
const failed = results.filter((passed) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
