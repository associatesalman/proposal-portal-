// Phase 6 headless-Chrome checks for the white/blue redesign: design tokens,
// light/dark OS preference, reduced motion, focus behaviour, dialogs, the
// Manage Document steps, role views, search/filter/pagination, sign-out robustness,
// responsive layouts (1280 / 768 / 390 px), contrast and touch targets.
// Runs against a production build and the LOCAL Supabase stack.
//
//   CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" \
//   APP_URL=http://localhost:3100 npm run test:ui -- <screenshot-dir>
//
// Disposable users and records are created through the real UI or as those
// users (RLS), and removed afterwards; existing local data is verified
// unchanged. A slow save is simulated by holding the server-action request
// with the DevTools Fetch domain.

import { mkdirSync, writeFileSync } from "node:fs";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { launchBrowser, ready } from "./lib/browser.mjs";
import { createHarness } from "./lib/portal.mjs";

const CHROME = process.env.CHROME_PATH;
const OUT = process.argv[2];
if (!CHROME || !OUT) {
  console.error("Usage: CHROME_PATH=... node phase6-ui.mjs <screenshot-dir>");
  process.exit(2);
}

const h = createHarness("phase6ui");
const { APP_URL, runId, check } = h;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PDFJS_MARKER = "Setting up fake worker failed";

async function makePdf(label, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    doc.addPage([420, 595]).drawText(`${label} page ${i}`, { x: 30, y: 520, size: 24, font });
  }
  return Buffer.from(await doc.save());
}

let b;

// In-page helpers (installed after each navigation).
const PAGE_HELPERS = `(() => {
  if (window.__p6) return;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgb = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, bl]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
  const background = (el) => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c[3] > 0.5) return c; } return [255, 255, 255, 1]; };
  window.__p6 = {
    rgb,
    contrast(el) { const fg = rgb(getComputedStyle(el).color); const bg = background(el); const [a, c] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (c + 0.05); },
    isWhite(css) { const [r, g, bl] = rgb(css); return r >= 250 && g >= 250 && bl >= 250; },
  };
})()`;

async function scenario() {
  const lead = await h.provisionUser("lead", "team_lead");
  const admin = await h.provisionUser("admin", "admin");
  const other = await h.provisionUser("other", "team_lead");

  // 12 clients for pagination (PAGE_SIZE 10), created as the lead (RLS).
  await lead.client.from("clients").insert(
    Array.from({ length: 12 }, (_, i) => ({
      owner_id: lead.id,
      name: `P6 Client ${String(i + 1).padStart(2, "0")} ${runId}`,
      email: `p6-${i}-${runId}@client.test`,
    })),
  );
  await other.client.from("clients").insert({ owner_id: other.id, name: `Other P6 ${runId}`, email: `o6-${runId}@client.test` });
  const published = await h.publishProposal(lead, {
    title: `P6 Published ${runId}`,
    pdf: await makePdf("Published", 4),
    offer: { freePages: "2", price: "49.99", currency: "USD" },
  });
  const uploadDraft = await h.createDraft(lead, `P6 Upload ${runId}`);
  const pdfPath = `${OUT}/p6-upload-${runId}.pdf`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(pdfPath, await makePdf("Upload", 5));

  b = await launchBrowser({ chromePath: CHROME, outDir: OUT, appUrl: APP_URL });
  // Screenshots show the settled page: wait (up to 3 s) for running
  // entrance animations; spinners, which repeat, are ignored.
  const rawScreenshot = b.screenshot;
  b.screenshot = async (name) => {
    await b.evaluate(`Promise.race([
      Promise.all(document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).then(() => true)`);
    return rawScreenshot(name);
  };
  await b.send("Network.enable");
  await b.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const requests = [];
  const scripts = new Map(); // url -> routes that loaded it
  let route = null;
  b.on("Network.requestWillBeSent", (p) => requests.push({ url: p.request.url, route }));
  b.on("Network.responseReceived", (p) => {
    if (p.type === "Script" && route) scripts.set(p.response.url, new Set([...(scripts.get(p.response.url) ?? []), route]));
  });

  const helpers = () => b.evaluate(PAGE_HELPERS);
  const go = async (path, readyExpression) => {
    route = path.split("?")[0].startsWith("/p/") ? "/p/[token]" : path.split("?")[0];
    await b.navigate(path);
    const ok = await b.waitFor(readyExpression, 20000);
    await helpers();
    return ok;
  };
  const setViewport = (width, height, mobile = false) =>
    b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  const media = (features) => b.send("Emulation.setEmulatedMedia", { features });
  const noOverflow = () => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1");
  const signInCookies = async (user) => {
    await b.send("Network.clearBrowserCookies");
    for (const [name, value] of user.jar) await b.send("Network.setCookie", { name, value, url: APP_URL, path: "/" });
  };
  const dialog = "document.querySelector('dialog[open]')";
  const dialogText = `(${dialog}?.innerText ?? '')`;

  // --- Login ------------------------------------------------------------------
  // Bolder scale: two columns on desktop, a large panel, 56 px fields.
  const rect = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), fs: parseFloat(getComputedStyle(e).fontSize) }; })()`;
  await setViewport(1440, 900);
  await go("/login", ready("[data-password-toggle]"));
  const loginDesktop = await b.evaluate(`({ h1: ${rect("h1")}, h2: ${rect("main h2")}, panel: ${rect("main h2")} && (() => { const r = document.querySelector('main h2').closest('.rounded-2xl').getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; })(),
    email: ${rect("#email")}, password: ${rect("#password")}, submit: ${rect("button[type=submit]")}, art: document.querySelector('.login-art')?.checkVisibility() ?? false })`);
  check(
    "login (1440): two columns — heading and artwork left, panel 460–520 px wide on the right",
    loginDesktop.art && loginDesktop.panel.x > loginDesktop.h1.x + loginDesktop.h1.w - 1 && loginDesktop.panel.w >= 460 && loginDesktop.panel.w <= 520,
    JSON.stringify(loginDesktop),
  );
  check(
    "login (1440): large portal heading (≥ 48 px), 'Welcome back' 32–40 px, 52–56 px fields, full-width 56 px Sign in",
    loginDesktop.h1.fs >= 48 && loginDesktop.h2.fs >= 32 && loginDesktop.h2.fs <= 40 && [loginDesktop.email.h, loginDesktop.password.h].every((v) => v >= 52 && v <= 56) &&
      loginDesktop.submit.h >= 52 && loginDesktop.submit.w === loginDesktop.email.w,
    JSON.stringify(loginDesktop),
  );
  check(
    "login: the form is usable at once while it animates in (fields enabled, nothing blocks clicks)",
    await b.evaluate(`(() => { const r = document.getElementById('email').getBoundingClientRect(); const hit = document.elementFromPoint(r.x + 20, r.y + r.height / 2); return hit === document.getElementById('email') && !document.getElementById('email').disabled; })()`),
  );
  await sleep(3000);
  check(
    "login: entrance and artwork animations have finished within 3 s (nothing loops)",
    await b.evaluate("document.getAnimations().every((a) => a.playState === 'finished' && a.effect.getTiming().iterations !== Infinity)"),
  );
  await b.screenshot("p6-00-login-desktop-1440");

  // Connection failure: the sign-in POST never reaches the server.
  let failLoginPosts = true;
  b.on("Fetch.requestPaused", (p) => {
    if (!failLoginPosts) return;
    if (p.request.method === "POST") void b.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionRefused" });
    else void b.send("Fetch.continueRequest", { requestId: p.requestId });
  });
  await b.send("Fetch.enable", { patterns: [{ urlPattern: "*/login*", requestStage: "Request" }] });
  await b.typeInto("#email", lead.email);
  await b.typeInto("#password", "any-password");
  await b.key("Enter", "Enter", 13);
  check(
    "login: a connection failure shows a connection message, keeps the email and re-enables the form",
    await b.waitFor(`document.getElementById('login-message').innerText.includes("Can't connect") && document.getElementById('email').value === ${JSON.stringify(lead.email)} && !document.querySelector('button[type=submit]').disabled`, 15000),
    await b.evaluate("document.getElementById('login-message').innerText"),
  );
  await b.screenshot("p6-00c-login-connection-error");
  await b.send("Fetch.disable");
  failLoginPosts = false;

  // Phone: stacked, artwork hidden, the form in view without scrolling.
  await setViewport(390, 844, true);
  await go("/login", ready("[data-password-toggle]"));
  const loginMobile = await b.evaluate(`({ art: document.querySelector('.login-art')?.checkVisibility() ?? false, submit: ${rect("button[type=submit]")}, h1: ${rect("h1")} })`);
  check(
    "login (390): artwork hidden, Sign in visible without scrolling, no horizontal overflow",
    !loginMobile.art && loginMobile.submit.y + loginMobile.submit.h <= 844 && (await noOverflow()),
    JSON.stringify(loginMobile),
  );
  await b.screenshot("p6-00b-login-mobile");

  await setViewport(1280, 900);
  await go("/login", ready("[data-password-toggle]"));
  check(
    "login: password toggle becomes usable after load (truthful disabled state before)",
    await b.evaluate("!document.querySelector('[data-password-toggle]').disabled"),
  );
  check(
    "login: white page, blue primary button (#2563EB), dark navy heading (#0B1E44)",
    await b.evaluate(`__p6.isWhite(getComputedStyle(document.body).backgroundColor) &&
      JSON.stringify(__p6.rgb(getComputedStyle(document.querySelector('button[type=submit]')).backgroundColor).slice(0, 3)) === '[37,99,235]' &&
      JSON.stringify(__p6.rgb(getComputedStyle(document.querySelector('h1')).color).slice(0, 3)) === '[11,30,68]'`),
  );
  await b.clickSelector("[data-password-toggle]");
  check(
    "login: show/hide password toggles the field type and aria-pressed",
    await b.evaluate("document.getElementById('password').type === 'text' && document.querySelector('[data-password-toggle]').getAttribute('aria-pressed') === 'true'"),
  );
  await b.clickSelector("[data-password-toggle]");
  await b.typeInto("#email", lead.email);
  await b.typeInto("#password", "definitely-wrong-password");
  await b.key("Enter", "Enter", 13);
  check(
    "login: wrong password shows an alert and keeps the email",
    await b.waitFor("document.getElementById('login-message').innerText.includes('Invalid email or password.') && document.getElementById('email').value.length > 0", 15000),
  );
  await b.screenshot("p6-01-login-error");
  check("login: no horizontal overflow (1280)", await noOverflow());

  // Real sign-in through the form (lead).
  await b.waitFor(ready("[data-password-toggle]"), 10000);
  await b.typeInto("#password", lead.password);
  await b.key("Enter", "Enter", 13);
  check("lead signs in through the form", await b.waitFor("location.pathname === '/dashboard'", 15000));

  // --- Lead dashboard -----------------------------------------------------------
  await go("/dashboard", ready("button[aria-haspopup=dialog]"));
  route = "/dashboard";
  check(
    "lead: dashboard shows the user's name and role, and no admin controls",
    await b.evaluate(`document.body.innerText.includes(${JSON.stringify(lead.fullName)}) && document.body.innerText.includes('Team Lead') &&
      !document.querySelector('select[name=owner]') && ![...document.querySelectorAll('th')].some((th) => th.textContent.trim() === 'Owner')`),
  );
  check(
    "lead: summary cards show real totals (12 + 2 draft/proposal clients = 14 clients, 2 proposals, 1 draft)",
    await b.evaluate(`(() => { const v = [...document.querySelectorAll('[aria-labelledby=summary-heading] dd')].map((d) => d.textContent.trim()); return v.join(',') === '14,2,1'; })()`),
    await b.evaluate(`[...document.querySelectorAll('[aria-labelledby=summary-heading] dd')].map((d) => d.textContent.trim()).join(',')`),
  );
  check(
    "tabs: active tab is marked aria-current and shown in blue",
    await b.evaluate(`(() => { const a = document.querySelector('nav[aria-label="Dashboard sections"] a[aria-current=page]'); const c = __p6.rgb(getComputedStyle(a).color); return a.textContent.includes('Clients') && c[2] > c[0] + 100; })()`),
  );
  check("pagination: 14 clients → 'Showing 1–10 of 14 clients'", await b.evaluate("document.body.innerText.includes('Showing 1–10 of 14 clients')"));
  await b.screenshot("p6-02-lead-clients-desktop");
  check(
    "laptop (1280×900): the first records are visible without scrolling",
    await b.evaluate("(() => { const rows = [...document.querySelectorAll('tbody tr')]; return rows.length >= 2 && rows[1].getBoundingClientRect().bottom <= innerHeight; })()"),
  );

  // Bolder dashboard scale at 1440 px.
  await setViewport(1440, 900);
  await sleep(300);
  const scale = await b.evaluate(`(() => {
    const px = (el, prop = 'fontSize') => el ? parseFloat(getComputedStyle(el)[prop]) : null;
    const cards = [...document.querySelectorAll('[aria-labelledby=summary-heading] dl > div')];
    const icons = cards.map((c) => c.querySelector('dt > span')).filter(Boolean);
    const addClient = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Add client'));
    const rows = [...document.querySelectorAll('tbody tr')];
    return {
      h1: px(document.querySelector('h1')), h2: px(document.getElementById('summary-heading')), body: px(document.querySelector('main p.text-muted')),
      values: [...document.querySelectorAll('[aria-labelledby=summary-heading] dd')].map((d) => px(d)),
      cardHeights: cards.map((c) => Math.round(c.getBoundingClientRect().height)), cardPadding: px(cards[0], 'paddingTop'),
      icons: icons.map((i) => Math.round(i.getBoundingClientRect().width)),
      button: Math.round(addClient.getBoundingClientRect().height), search: Math.round(document.querySelector('input[name=q]').getBoundingClientRect().height),
      rowHeights: rows.slice(0, 5).map((r) => Math.round(r.getBoundingClientRect().height)),
      main: Math.round(document.querySelector('main').getBoundingClientRect().width),
      cardCursor: getComputedStyle(cards[0]).cursor,
    };
  })()`);
  check(
    "dashboard (1440): title 40–48 px, section heading 24–30 px, 16 px+ body text",
    scale.h1 >= 40 && scale.h1 <= 48 && scale.h2 >= 24 && scale.h2 <= 30 && scale.body >= 16,
    JSON.stringify(scale),
  );
  check(
    "dashboard (1440): summary values 44–56 px, cards 160–190 px tall with 24–32 px padding, 48–56 px icons, not clickable-looking",
    scale.values.length === 3 && scale.values.every((v) => v >= 44 && v <= 56) && scale.cardHeights.every((v) => v >= 160 && v <= 190) &&
      scale.cardPadding >= 24 && scale.cardPadding <= 32 && scale.icons.length === 3 && scale.icons.every((v) => v >= 48 && v <= 56) && scale.cardCursor !== "pointer",
    JSON.stringify(scale),
  );
  check(
    "dashboard (1440): 48 px primary button and search, table rows 64–76 px, container ≤ 1440 px",
    scale.button === 48 && scale.search === 48 && scale.rowHeights.every((v) => v >= 64 && v <= 76) && scale.main <= 1440,
    JSON.stringify(scale),
  );
  check(
    "dashboard: summary cards and records animate in once and have finished",
    await b.evaluate("(() => { const els = [...document.querySelectorAll('.animate-enter')]; return els.length >= 5 && els.every((el) => el.getAnimations().every((a) => a.playState === 'finished')); })()"),
    await b.evaluate("JSON.stringify([...document.querySelectorAll('.animate-enter')].map((el) => [el.tagName, el.getAnimations().map((a) => a.animationName + ':' + a.playState)]))"),
  );
  await b.screenshot("p6-02b-lead-dashboard-1440");
  await setViewport(1280, 900);

  // Visible keyboard focus on the tabs.
  await b.evaluate("document.activeElement?.blur(); window.scrollTo(0, 0)");
  let tabFocus = null;
  for (let i = 0; i < 12 && !tabFocus; i++) {
    await b.key("Tab", "Tab", 9);
    tabFocus = await b.evaluate(`(() => { const el = document.activeElement; if (!el?.closest('nav[aria-label="Dashboard sections"]')) return null; const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: __p6.rgb(s.outlineColor) }; })()`);
  }
  check(
    "keyboard focus on a tab shows a visible blue outline",
    !!tabFocus && tabFocus.style !== "none" && tabFocus.width >= 2 && tabFocus.color[2] > tabFocus.color[0] + 100,
    JSON.stringify(tabFocus),
  );

  // Pagination: next page.
  await b.clickText("a", "Next");
  check(
    "pagination: Next shows page 2 ('Showing 11–14 of 14 clients')",
    await b.waitFor("location.search.includes('page=2') && document.body.innerText.includes('Showing 11–14 of 14 clients')", 10000),
  );
  check(
    "pagination: unavailable Next stays in place (disabled), Previous is a link",
    await b.evaluate(`!!document.querySelector('nav[aria-label="clients pagination"] a[rel=prev]') && !document.querySelector('nav[aria-label="clients pagination"] a[rel=next]') &&
      [...document.querySelectorAll('nav[aria-label="clients pagination"] span[aria-hidden=true]')].some((s) => s.textContent.includes('Next'))`),
  );

  // Search keeps focus in the field while results update.
  await b.typeInto("input[name=q]", `Client 07 ${runId}`);
  await b.evaluate("void (window.__searchInput = document.querySelector('input[name=q]'), window.__summaryCard = document.querySelector('[aria-labelledby=summary-heading] dl > div'))");
  await b.key("Enter", "Enter", 13);
  check(
    "search: results update without a page parameter",
    await b.waitFor(`location.search.includes('q=') && !location.search.includes('page=') && document.body.innerText.includes('Showing 1–1 of 1 clients')`, 10000),
  );
  check(
    "search: the same input keeps focus and its value (not remounted)",
    await b.evaluate(`document.activeElement === window.__searchInput && window.__searchInput.isConnected && window.__searchInput.value === ${JSON.stringify(`Client 07 ${runId}`)}`),
  );
  check(
    "search: the summary cards are not remounted, so their entrance doesn't replay",
    await b.evaluate("window.__summaryCard.isConnected && window.__summaryCard === document.querySelector('[aria-labelledby=summary-heading] dl > div') && window.__summaryCard.getAnimations().every((a) => a.playState === 'finished')"),
  );
  await b.clickText("button", "Clear search");
  check(
    "search: Clear search resets the list and returns focus to the field",
    await b.waitFor("!location.search.includes('q=') && document.body.innerText.includes('Showing 1–10 of 14 clients')", 10000) &&
      (await b.evaluate("document.activeElement === document.querySelector('input[name=q]') && document.activeElement.value === ''")),
  );

  // Add client: dialog focus, Escape, restoration, toast, count refresh.
  await b.clickText("button", "Add client");
  check("Add client opens a dialog with focus on the first field", await b.waitFor(`!!${dialog} && document.activeElement?.name === 'name'`, 5000));
  check(
    "dialog: visible Close button with an accessible name",
    await b.evaluate(`(() => { const c = ${dialog}.querySelector('button[aria-label=Close]'); return !!c && c.checkVisibility() && c.getBoundingClientRect().width >= 32; })()`),
  );
  await b.key("Escape", "Escape", 27);
  check("dialog: Escape closes it", await b.waitFor(`!${dialog}`));
  check("dialog: focus returns to the trigger", await b.evaluate("document.activeElement?.textContent.includes('Add client')"));

  await b.clickText("button", "Add client");
  check("dialog: reopens on a click made right after Escape", await b.waitFor(`!!${dialog}`, 3000));
  check(
    "client form: 24 px+ dialog heading, 48 px fields and buttons",
    await b.evaluate(`(() => { const d = ${dialog}; const h = (el) => el.offsetHeight;
      return parseFloat(getComputedStyle(d.querySelector('h2')).fontSize) >= 24 && [...d.querySelectorAll('input:not([type=hidden])')].every((i) => h(i) === 48) && [...d.querySelectorAll('form button')].every((x) => h(x) === 48); })()`),
  );
  await sleep(300);
  await b.screenshot("p6-03a-client-form");
  await b.typeInto("dialog[open] input[name=name]", `P6 Added ${runId}`);
  await b.typeInto("dialog[open] input[name=email]", "not-an-email");
  await b.evaluate(`${dialog}.querySelector('form').noValidate = true`);
  await b.clickSelector("dialog[open] button[type=submit]");
  check(
    "dialog: server validation error is shown and entered values are kept",
    await b.waitFor(`${dialogText}.includes('Enter a valid email address.') && document.querySelector('dialog[open] input[name=name]').value === ${JSON.stringify(`P6 Added ${runId}`)}`, 10000),
  );
  check(
    "dialog: the invalid field is aria-invalid and described by its error",
    await b.evaluate(`(() => { const el = document.querySelector('dialog[open] input[name=email]'); return el.getAttribute('aria-invalid') === 'true' && (el.getAttribute('aria-describedby') ?? '').split(' ').some((id) => document.getElementById(id)?.textContent.includes('valid email')); })()`),
  );
  await b.screenshot("p6-03-dialog-validation");

  // Slow save: hold the server-action POST; Escape and Close must not discard it.
  const held = [];
  let holdPosts = false;
  b.on("Fetch.requestPaused", (p) => {
    if (holdPosts && p.request.method === "POST") held.push(p.requestId);
    else void b.send("Fetch.continueRequest", { requestId: p.requestId });
  });
  await b.send("Fetch.enable", { patterns: [{ urlPattern: "*/dashboard*", requestStage: "Request" }] });
  holdPosts = true;
  await b.typeInto("dialog[open] input[name=email]", `p6-added-${runId}@client.test`);
  await b.clickSelector("dialog[open] button[type=submit]");
  for (let i = 0; i < 50 && held.length === 0; i++) await sleep(100);
  const pendingUi = await b.waitFor(`${dialog}?.querySelector('button[type=submit]')?.textContent.includes('Adding') && ${dialog}.querySelector('fieldset').disabled`, 5000);
  check("dialog: pending state disables the form and shows 'Adding…'", pendingUi);
  check(
    "dialog: while saving it is aria-busy and marked closedby=none",
    await b.evaluate(`${dialog}?.getAttribute('aria-busy') === 'true' && ${dialog}.getAttribute('closedby') === 'none'`),
  );
  await b.key("Escape", "Escape", 27);
  await sleep(300);
  const blocked = await b.evaluate(`JSON.stringify({ open: !!${dialog}, closeDisabled: ${dialog}?.querySelector('button[aria-label=Close]')?.disabled ?? null })`);
  check("dialog: Escape and Close are blocked while saving (no lost result)", blocked === '{"open":true,"closeDisabled":true}', blocked);
  holdPosts = false;
  for (const requestId of held.splice(0)) await b.send("Fetch.continueRequest", { requestId });
  await b.send("Fetch.disable");
  check("dialog: closes after the save completes", await b.waitFor(`!${dialog}`, 15000));
  check(
    "toast: success is announced in the polite live region and can be dismissed",
    await b.waitFor(`document.querySelector('[role=status][aria-live=polite] [data-toast=success]')?.innerText.includes('added')`, 5000) &&
      (await b.evaluate("!!document.querySelector('[data-toast] button[aria-label=\"Dismiss notification\"]')")),
  );
  await b.screenshot("p6-04-toast");
  check(
    "counts refresh after adding a client (15)",
    await b.waitFor(`document.querySelector('[aria-labelledby=summary-heading] dd')?.textContent.trim() === '15'`, 10000),
  );
  await b.clickSelector("[data-toast] button[aria-label='Dismiss notification']");
  check("toast: Dismiss removes it", await b.waitFor("!document.querySelector('[data-toast]')", 3000));

  // Edit client.
  await go(`/dashboard?q=${encodeURIComponent(`P6 Added ${runId}`)}`, ready("button[aria-label^='Edit client']"));
  await b.clickSelector(`button[aria-label="Edit client P6 Added ${runId}"]`);
  await b.waitFor(`!!${dialog}`);
  check("edit client: dialog is prefilled", await b.evaluate(`document.querySelector('dialog[open] input[name=name]').value === ${JSON.stringify(`P6 Added ${runId}`)}`));
  await b.typeInto("dialog[open] input[name=name]", `P6 Edited ${runId}`);
  await b.clickSelector("dialog[open] button[type=submit]");
  // The new name no longer matches the active search, so the row leaves the
  // list; the confirmation must still appear.
  check(
    "edit client: saves; confirmation still shows when the row leaves the filtered list",
    await b.waitFor(`!${dialog} && document.querySelector('[data-toast=success]')?.innerText.includes('P6 Edited ${runId}')`, 15000),
  );
  await go(`/dashboard?q=${encodeURIComponent(`P6 Edited ${runId}`)}`, "!!document.querySelector('tbody tr')");
  check("edit client: the renamed client is listed", await b.evaluate(`document.querySelector('tbody').innerText.includes('P6 Edited ${runId}')`));

  // Proposals tab: New proposal, rename draft.
  await b.clickText("a", "Proposals");
  await b.waitFor("location.search.includes('tab=proposals')", 10000);
  await b.waitFor(ready("button[aria-label^='Manage Document']"), 15000);
  check(
    "proposals tab: the toolbar action switches to New proposal",
    await b.evaluate("[...document.querySelectorAll('button')].some((x) => x.textContent.includes('New proposal')) && ![...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Add client')"),
  );
  await b.clickText("button", "New proposal");
  await b.waitFor(`!!${dialog}`);
  await b.evaluate(`(() => { const s = document.querySelector('dialog[open] select[name=clientId]'); s.value = s.options[1].value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await b.typeInto("dialog[open] input[name=title]", `P6 Draft ${runId}`);
  await b.clickSelector("dialog[open] button[type=submit]");
  check(
    "new proposal: draft is created and listed as Draft / Not uploaded",
    await b.waitFor(`!${dialog} && (() => { const row = [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('P6 Draft ${runId}')); return !!row && row.innerText.includes('Draft') && row.innerText.includes('Not uploaded'); })()`, 15000),
  );
  await b.clickSelector(`button[aria-label="Edit draft P6 Draft ${runId}"]`);
  await b.waitFor(`!!${dialog}`);
  await b.typeInto("dialog[open] input[name=title]", `P6 Draft Renamed ${runId}`);
  await b.clickSelector("dialog[open] button[type=submit]");
  check("rename draft: saves and the row updates", await b.waitFor(`!${dialog} && document.body.innerText.includes('P6 Draft Renamed ${runId}')`, 15000));
  await b.screenshot("p6-05-lead-proposals-desktop");

  // --- Manage Document: three steps -----------------------------------------------
  const manage = `button[aria-label="Manage Document and link for P6 Upload ${runId}"]`;
  await b.clickSelector(manage);
  await b.waitFor(`${dialogText}.includes('No document uploaded yet.')`, 10000);
  const stepStates = () =>
    b.evaluate(`[...${dialog}.querySelectorAll('ol[aria-label="Setup progress"] li')].map((li) => ({ '(done)': 'done', '(next)': 'current', '(to do)': 'todo' })[li.querySelector('.sr-only')?.textContent] ?? '?').join(',')`);
  check("manage document: stepper starts at step 1 (Upload document)", (await stepStates()) === "current,todo,todo", await stepStates());
  await b.screenshot("p6-06-manage-step1");
  check(
    "manage document: larger dialog heading (≥ 24 px) and readable step indicators (≥ 28 px markers, ≥ 14 px labels)",
    await b.evaluate(`(() => { const d = ${dialog}; const title = parseFloat(getComputedStyle(d.querySelector('h2')).fontSize);
      const lis = [...d.querySelectorAll('ol[aria-label="Setup progress"] li')]; const markers = lis.map((li) => li.querySelector('p > span[aria-hidden]').getBoundingClientRect().width);
      const labels = lis.map((li) => parseFloat(getComputedStyle(li.querySelector('p')).fontSize));
      return title >= 24 && markers.every((m) => m >= 28) && labels.every((l) => l >= 14); })()`),
  );
  await b.setFile("dialog[open] input[type=file]", pdfPath);
  await b.clickText("button", "Upload document", dialog);
  check(
    "manage document: real upload phases are shown (no percentage)",
    await b.waitFor(`(${dialogText}.includes('Uploading to private storage') || ${dialogText}.includes('Checking the file')) && !/\\d+\\s?%/.test(${dialogText})`, 5000),
  );
  check(
    "manage document: verified file shows name, size and page count",
    await b.waitFor(`${dialogText}.includes('PDF verified: 5 pages.') && ${dialogText}.includes('p6-upload-${runId}.pdf') && /(B|KB|MB) · 5 pages/.test(${dialogText})`, 20000),
  );
  check("manage document: stepper moves to step 2", (await stepStates()) === "done,current,todo", await stepStates());
  await b.typeInto("dialog[open] input[type=number]", "2");
  check(
    "manage document: free and locked pages are explained as you type",
    await b.waitFor(`${dialogText}.includes('Free: pages 1–2') && ${dialogText}.includes('Locked: pages 3–5 (3 of 5)')`, 3000),
  );
  await b.evaluate(`(() => { const s = ${dialog}.querySelector('select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'GBP'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await b.typeInto("dialog[open] input[inputmode=decimal]", "12.5");
  check("manage document: price preview shows the formatted amount", await b.waitFor(`${dialog}.querySelector('[data-price-preview]')?.textContent === '£12.50'`, 3000));
  await b.clickText("button", "Save offer and generate preview", dialog);
  check("manage document: offer saves and the stepper moves to step 3", await b.waitFor(`${dialogText}.includes('Offer saved.')`, 20000) && (await stepStates()) === "done,done,current");
  await b.send("Browser.grantPermissions", { origin: new URL(APP_URL).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  await b.clickText("button", "Generate private link", dialog);
  check("manage document: link is generated and shown once", await b.waitFor(`!!${dialog}.querySelector('[data-issued-link] input[readonly]')?.value.includes('/p/')`, 15000));
  check("manage document: all steps done; active-link editing restriction is explained", (await stepStates()) === "done,done,done" && (await b.evaluate(`${dialogText}.includes("can't be changed") && ${dialog}.querySelector('input[type=file]').disabled`)));
  check("manage document: localhost links are flagged as local-only", await b.evaluate(`${dialogText}.includes('Local-only link')`));
  await b.clickText("button", "Copy link", dialog);
  check("manage document: Copy link confirms in a status message", await b.waitFor(`${dialogText}.includes('Link copied to the clipboard.')`, 5000));
  await b.screenshot("p6-07-manage-link");
  await b.clickText("button", "Revoke link…", dialog);
  check(
    "manage document: revoke asks for confirmation and focuses 'Keep link'",
    await b.waitFor(`!!${dialog}.querySelector('[data-revoke-confirm]') && document.activeElement?.textContent.includes('Keep link')`, 3000),
  );
  check(
    "manage document: confirmation says the old link stops working",
    await b.evaluate(`${dialog}.querySelector('[data-revoke-confirm]').innerText.includes('the old one never works again')`),
  );
  await b.screenshot("p6-08-revoke-confirm");
  await b.clickText("button", "Revoke link", `${dialog}.querySelector('[data-revoke-confirm]')`);
  check("manage document: revoked; back to a draft and step 3", await b.waitFor(`${dialogText}.includes('Link revoked.')`, 15000) && (await stepStates()) === "done,done,current");
  await b.key("Escape", "Escape", 27);
  check("manage document: closes and returns focus to its button", await b.waitFor(`!${dialog}`) && (await b.evaluate(`document.activeElement?.matches(${JSON.stringify(manage)})`)));
  await sleep(400);
  check("manage document: the issued link is removed from the page after closing", !(await b.evaluate("!!document.querySelector('[data-issued-link]')")));

  // --- Responsive layouts and OS preferences ---------------------------------
  for (const [width, height, mobile, tag] of [[768, 1024, true, "tablet"], [390, 844, true, "mobile"]]) {
    await setViewport(width, height, mobile);
    await go("/dashboard?tab=proposals", ready("button[aria-label^='Manage Document']"));
    check(`${tag}: dashboard has no horizontal page scroll`, await noOverflow());
    await b.screenshot(`p6-09-dashboard-${tag}`);
    await b.clickSelector(`button[aria-label="Manage Document and link for P6 Published ${runId}"]`);
    await b.waitFor(`${dialogText}.includes('Link active since')`, 10000);
    check(
      `${tag}: dialog fits the viewport and its body scrolls`,
      await b.evaluate(`(() => { const d = ${dialog}; const r = d.getBoundingClientRect(); const body = d.lastElementChild; return r.width <= innerWidth && r.height <= innerHeight && getComputedStyle(body).overflowY === 'auto'; })()`),
    );
    await b.screenshot(`p6-10-manage-${tag}`);
    await b.key("Escape", "Escape", 27);
    await b.waitFor(`!${dialog}`);
  }
  // Touch targets on the 390 px layout (dashboard controls). A closing dialog
  // stays rendered during its exit fade, so its contents are skipped.
  const smallTargets = await b.evaluate(`[...document.querySelectorAll('main button, main a, main select, main input:not([type=hidden]), header button')]
    .filter((el) => el.checkVisibility() && !el.closest('dialog:not([open])')).map((el) => ({ t: (el.getAttribute('aria-label') || el.textContent || el.name || '').trim().slice(0, 30), h: el.offsetHeight }))
    .filter((x) => x.h < 36)`);
  check("mobile: interactive controls are at least 36 px tall", smallTargets.length === 0, JSON.stringify(smallTargets));
  check(
    "mobile: tabs and the toolbar action fit inside the records panel on one row (nothing clipped)",
    await b.evaluate(`(() => { const panel = document.querySelector('section[aria-labelledby=records-heading]').getBoundingClientRect();
      const action = [...document.querySelectorAll('section[aria-labelledby=records-heading] button')].find((x) => /New proposal|Add client/.test(x.textContent)).getBoundingClientRect();
      const tabs = document.querySelector('nav[aria-label="Dashboard sections"]').getBoundingClientRect();
      return action.right <= panel.right - 4 && action.left >= tabs.right && Math.abs(action.bottom - tabs.bottom) < 20; })()`),
  );
  check(
    "mobile: row actions are visible without hover",
    await b.evaluate(`[...document.querySelectorAll('button[aria-label^="Manage Document"]')].every((el) => el.checkVisibility() && getComputedStyle(el).opacity === '1')`),
  );

  await setViewport(1280, 900);
  // Dark OS preference: still white.
  await media([{ name: "prefers-color-scheme", value: "dark" }]);
  for (const path of ["/dashboard", `/p/${published.token}`]) {
    await go(path, path === "/dashboard" ? ready("button[aria-haspopup=dialog]") : "!!document.querySelector('[data-rendered-page] canvas')");
    check(
      `dark OS preference: ${path.startsWith("/p/") ? "client page" : "dashboard"} stays white with dark text`,
      await b.evaluate(`__p6.isWhite(getComputedStyle(document.body).backgroundColor) && getComputedStyle(document.documentElement).colorScheme === 'light' && __p6.contrast(document.querySelector('h1')) > 12`),
    );
  }
  await b.screenshot("p6-11-client-dark-pref");
  await media([{ name: "prefers-color-scheme", value: "light" }]);

  // Reduced motion: transitions finish at once; dialogs still work.
  await media([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await go("/dashboard", ready("button[aria-haspopup=dialog]"));
  check(
    "reduced motion: transitions are effectively instant",
    await b.evaluate("parseFloat(getComputedStyle(document.querySelector('header button')).transitionDuration) <= 0.002"),
  );
  check(
    "reduced motion: dashboard entrances have no delay and finish at once",
    await b.evaluate("[...document.querySelectorAll('.animate-enter')].every((el) => { const s = getComputedStyle(el); return parseFloat(s.animationDuration) <= 0.002 && parseFloat(s.animationDelay) === 0; })"),
  );
  await b.clickText("button", "Add client");
  check("reduced motion: dialog opens immediately and is usable", await b.waitFor(`!!${dialog} && getComputedStyle(${dialog}).opacity === '1' && document.activeElement?.name === 'name'`, 1000));
  await b.key("Escape", "Escape", 27);
  await b.waitFor(`!${dialog}`);
  await b.send("Network.clearBrowserCookies");
  await go("/login", ready("[data-password-toggle]"));
  check(
    "reduced motion: login panel and artwork are fully shown at once",
    await b.evaluate("document.getAnimations().every((a) => a.playState === 'finished' || a.effect.getComputedTiming().duration <= 1) && getComputedStyle(document.querySelector('main h2').closest('.animate-enter')).opacity === '1'"),
  );
  await signInCookies(lead);
  await go("/dashboard", ready("button[aria-haspopup=dialog]"));
  await media([]);
  check(
    "motion (default): buttons transition in ~150 ms, dialogs ~200 ms",
    await b.evaluate(`(() => { const btn = parseFloat(getComputedStyle(document.querySelector('header button')).transitionDuration); const dlg = getComputedStyle(document.querySelector('dialog.ui-dialog')).transitionDuration.split(',').map(parseFloat); return btn >= 0.12 && btn <= 0.18 && dlg.every((d) => d >= 0.18 && d <= 0.24); })()`),
  );

  // Contrast of representative text on the dashboard.
  const contrast = await b.evaluate(`(() => {
    const pick = (sel) => document.querySelector(sel);
    const items = {
      heading: pick('h1'), muted: pick('main p.text-muted'), tableHeader: pick('thead th'), subtleHint: pick('[aria-labelledby=summary-heading] dt'),
      primaryButton: [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Add client')),
      activeTab: pick('a[aria-current=page]'), pagination: pick('nav[aria-label$=pagination] p'),
    };
    return Object.fromEntries(Object.entries(items).filter(([, el]) => el).map(([k, el]) => [k, Math.round(__p6.contrast(el) * 100) / 100]));
  })()`);
  check("contrast: representative text meets WCAG AA (≥ 4.5:1)", Object.values(contrast).every((v) => v >= 4.5), JSON.stringify(contrast));

  // --- Admin view ----------------------------------------------------------------
  await signInCookies(admin);
  await go("/dashboard", ready("button[aria-haspopup=dialog]"));
  check(
    "admin: sees owner names and the team lead filter",
    await b.evaluate(`!!document.querySelector('select[name=owner]') && [...document.querySelectorAll('th')].some((th) => th.textContent.trim() === 'Owner') && document.body.innerText.includes('CEO/Admin')`),
  );
  await b.evaluate("document.querySelector('select[name=owner]').focus()");
  await b.evaluate(`(() => { const s = document.querySelector('select[name=owner]'); s.value = ${JSON.stringify(other.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); window.__ownerSelect = s; })()`);
  check(
    "admin: filter applies, totals follow, and focus stays on the same select",
    await b.waitFor(`location.search.includes('owner=${other.id}') && document.body.innerText.includes('Overall totals for ${other.fullName}')`, 10000) &&
      (await b.evaluate("document.activeElement === window.__ownerSelect && window.__ownerSelect.isConnected")),
  );
  check(
    "admin: filtered list shows only that lead's clients",
    await b.evaluate(`[...document.querySelectorAll('td[data-label=Client]')].length > 0 && [...document.querySelectorAll('td[data-label=Client]')].every((td) => td.textContent.includes('Other P6'))`),
  );
  await b.screenshot("p6-12-admin-filtered");

  // --- Client page --------------------------------------------------------------
  await b.send("Network.clearBrowserCookies");
  await go(`/p/${published.token}`, "!!document.querySelector('[data-rendered-page=\"1\"] canvas')");
  check(
    "client page: title, counts, locked notice, price and payment notice",
    await b.evaluate(`document.querySelector('h1').textContent.includes('P6 Published ${runId}') && document.querySelector('[data-preview-summary]').textContent.includes('Free preview: 2 of 4 pages.') &&
      document.querySelector('[data-price]').textContent === 'US$49.99' && document.querySelector('[data-payment-notice]').textContent === 'Online payment will be available soon.'`),
  );
  check(
    "client page: no checkout or unlock action exists",
    await b.evaluate("![...document.querySelectorAll('button, a')].some((el) => /pay|unlock|checkout|buy/i.test(el.textContent))"),
  );
  await b.clickSelector('[aria-label="Next page"]');
  check("client page: next page renders page 2", await b.waitFor("!!document.querySelector('[data-rendered-page=\"2\"] canvas')", 10000));
  await b.clickSelector('[aria-label="Zoom in"]');
  check("client page: zoom in leaves fit-width mode", await b.waitFor(`document.querySelector('[aria-label="Fit to width"]').getAttribute('aria-pressed') === 'false'`, 5000));
  await setViewport(390, 844, true);
  await go(`/p/${published.token}`, "!!document.querySelector('[data-rendered-page=\"1\"] canvas')");
  check("client page (390 px): no horizontal page scroll", await noOverflow());
  await b.screenshot("p6-13-client-mobile");
  await setViewport(1280, 900);

  // --- Sign out -------------------------------------------------------------------
  await signInCookies(lead);
  await go("/dashboard", "!!document.querySelector('header form[data-sign-out] button[type=submit]')?.checkVisibility()");
  // Clicked as soon as it is visible: no wait for hydration.
  await b.clickSelector("header form[data-sign-out] button[type=submit]");
  check("sign out: clicking as soon as the button is visible returns to /login", await b.waitFor("location.pathname === '/login'", 15000));
  await go("/dashboard", "location.pathname === '/login'");
  check("sign out: the session is gone (dashboard redirects to /login)", await b.evaluate("location.pathname === '/login'"));

  // Without JavaScript the sign-out form is still a working POST form.
  const html = await (await fetch(`${APP_URL}/dashboard`, { headers: { cookie: other.cookie } })).text();
  const actionField = /<form(?=[^>]*data-sign-out)(?=[^>]*encType="multipart\/form-data")(?=[^>]*method="POST")[^>]*><input type="hidden" name="(\$ACTION_ID_[0-9a-f]+)"\/><button type="submit"[^>]*>(?:(?!<\/button>)[\s\S])*Sign out<\/button>/.exec(html)?.[1];
  let noJs = null;
  if (actionField) {
    const form = new FormData();
    form.set(actionField, "");
    const res = await fetch(`${APP_URL}/dashboard`, { method: "POST", body: form, headers: { cookie: other.cookie, origin: APP_URL }, redirect: "manual" });
    noJs = { status: res.status, location: res.headers.get("location"), cleared: /sb-[^=]+-auth-token=;/.test(res.headers.get("set-cookie") ?? "") };
  }
  check(
    "sign out without JavaScript: the server HTML form POST returns 303 to /login and clears the session cookie",
    noJs?.status === 303 && noJs.location === "/login" && noJs.cleared,
    JSON.stringify(noJs),
  );

  // --- Bundles and requests -------------------------------------------------------
  const pdfjsOn = new Set();
  for (const [url, routes] of scripts) {
    if (!url.startsWith(APP_URL)) continue;
    const text = await (await fetch(url)).text();
    if (text.includes(PDFJS_MARKER)) routes.forEach((r) => pdfjsOn.add(r));
  }
  check("PDF.js is loaded only on the client page (not on /login or /dashboard)", pdfjsOn.size === 1 && pdfjsOn.has("/p/[token]"), [...pdfjsOn].join(","));
  // The only other host is the local Supabase API (the PDF upload goes
  // straight to private storage with a signed upload token).
  const external = requests.filter(
    (r) => !r.url.startsWith(APP_URL) && !r.url.startsWith(`${h.API_URL}/storage/v1/object/upload/sign/`) && !r.url.startsWith("data:") && !r.url.startsWith("blob:"),
  );
  check("no requests to other hosts (fonts, CDNs, analytics); only the local storage upload", external.length === 0, external.slice(0, 3).map((r) => r.url).join(" "));
  check("no uncaught browser errors", b.log.filter((l) => l.startsWith("exception")).length === 0, b.log.slice(0, 3).join(" | "));
  void uploadDraft;
}

h.run(async () => {
  try {
    await scenario();
  } finally {
    await b?.close();
  }
});
