// Phase 5 headless-Chrome checks for the client proposal page and the PDF.js
// preview viewer, against a production build and the LOCAL Supabase stack.
//
//   CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" \
//   APP_URL=http://localhost:3100 npm run test:client-browser -- <screenshot-dir>
//
// Proposals are prepared through the dashboard's real server actions as
// disposable team leads; the client page is then opened anonymously in a
// throwaway Chrome profile. Every network request the page makes is
// recorded. Network failures, corrupt bytes and a link revoked mid-load are
// simulated with the DevTools Fetch domain (requests to the preview endpoint
// only); a missing preview object is simulated by removing it from storage
// with the local secret key (fixture setup only).

import { PDFDocument, StandardFonts } from "pdf-lib";

import { launchBrowser } from "./lib/browser.mjs";
import { BUCKET, createHarness } from "./lib/portal.mjs";

const CHROME = process.env.CHROME_PATH;
const OUT = process.argv[2];
if (!CHROME || !OUT) {
  console.error("Usage: CHROME_PATH=... node phase5-browser.mjs <screenshot-dir>");
  process.exit(2);
}

const h = createHarness("phase5ui");
const { APP_URL, API_URL, runId, trusted, check } = h;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makePdf(label, pages, free, size = [420, 595]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const scale = size[0] / 420;
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage(size);
    page.drawRectangle({ x: 20 * scale, y: 20 * scale, width: size[0] - 40 * scale, height: 60 * scale, color: { type: "RGB", red: 0.15, green: 0.39, blue: 0.92 } });
    page.drawText(`${label} page ${i}`, { x: 30 * scale, y: size[1] - 75 * scale, size: 24 * scale, font });
    page.drawText(`${i <= free ? "FREEMARK" : "LOCKEDMARK"}-${runId}`, { x: 30 * scale, y: size[1] - 115 * scale, size: 18 * scale, font });
  }
  return Buffer.from(await doc.save());
}

let b;

async function scenario() {
  const lead = await h.provisionUser("lead", "team_lead");
  const leadB = await h.provisionUser("lead-b", "team_lead");
  const A = await h.publishProposal(lead, {
    title: `Alpha UI ${runId}`,
    pdf: await makePdf("Alpha", 5, 2),
    offer: { freePages: "2", price: "1250.50", currency: "EUR" },
  });
  const B = await h.publishProposal(leadB, {
    title: `Bravo UI ${runId}`,
    pdf: await makePdf("Bravo", 4, 3),
    offer: { freePages: "3", price: "1500", currency: "JPY" },
  });
  const C = await h.publishProposal(lead, {
    title: `Charlie UI ${runId}`,
    pdf: await makePdf("Charlie", 3, 1),
    offer: { freePages: "1", price: "19.99", currency: "USD" },
  });
  // Maximum PDF page size (200 in x 200 in): exercises the canvas cap.
  const D = await h.publishProposal(lead, {
    title: `Delta large UI ${runId}`,
    pdf: await makePdf("Delta", 2, 1, [14400, 14400]),
    offer: { freePages: "1", price: "5.00", currency: "GBP" },
  });
  const E = await h.publishProposal(leadB, {
    title: `Echo UI ${runId}`,
    pdf: await makePdf("Echo", 3, 2),
    offer: { freePages: "2", price: "9.00", currency: "USD" },
  });

  b = await launchBrowser({ chromePath: CHROME, outDir: OUT, appUrl: APP_URL });
  await b.send("Network.enable");
  await b.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const requests = [];
  b.on("Network.requestWillBeSent", (p) => requests.push(p.request.url));

  // Fetch interception for the preview endpoint only.
  let interceptMode = null;
  const held = [];
  b.on("Fetch.requestPaused", (p) => {
    if (interceptMode === "fail") {
      void b.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "InternetDisconnected" });
    } else if (interceptMode === "corrupt") {
      const body = Buffer.from("%PDF-1.7\nthis is not a valid PDF body\n%%EOF\n").toString("base64");
      void b.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/pdf" }],
        body,
      });
    } else if (interceptMode === "hold") {
      held.push(p.requestId);
    } else {
      void b.send("Fetch.continueRequest", { requestId: p.requestId });
    }
  });
  async function intercept(mode) {
    interceptMode = mode;
    if (mode) await b.send("Fetch.enable", { patterns: [{ urlPattern: "*/preview", requestStage: "Request" }] });
    else await b.send("Fetch.disable");
  }

  const text = (selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const rendered = (page) => `!!document.querySelector('[data-rendered-page="${page}"] canvas')`;
  const viewerState = (state) => `document.querySelector('[data-viewer-state]')?.dataset.viewerState === '${state}'`;
  const zoomPercent = async () => parseInt(await text("[data-zoom]"), 10);
  const canvasBox = () =>
    b.evaluate(`(() => { const c = document.querySelector('.pdf-page canvas'); const s = document.getElementById('preview-stage');
      return c && { cssWidth: c.getBoundingClientRect().width, width: c.width, height: c.height, stage: s.clientWidth, pad: parseFloat(getComputedStyle(s).paddingLeft) + parseFloat(getComputedStyle(s).paddingRight), stageScroll: s.scrollWidth }; })()`);
  const inkPixels = () =>
    b.evaluate(`(() => { const c = document.querySelector('.pdf-page canvas'); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0; for (let i = 0; i < d.length; i += 64) if (d[i] < 200 || d[i + 1] < 200) ink++; return ink; })()`);
  // Resolves any CSS colour of an element (Tailwind v4 uses oklch) to sRGB.
  const rgbOf = (selector, prop) =>
    b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      c.fillStyle = getComputedStyle(el)[${JSON.stringify(prop)}]; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)]; })()`);
  const isWhite = ([r, g, bl]) => r === 255 && g === 255 && bl === 255;
  const isDark = ([r, g, bl]) => r + g + bl < 160;
  const isBlue = ([r, g, bl]) => bl > r + 25 && bl > g;
  const isDisabled = (label) => b.evaluate(`document.querySelector('[aria-label="${label}"]').disabled`);
  const click = (label) => b.clickSelector(`[aria-label="${label}"]`);

  // --- Desktop: render, content, styling -------------------------------------
  await b.navigate(`/p/${A.token}`);
  check("PDF preview renders page 1 on a canvas", await b.waitFor(rendered(1), 20000));
  check("rendered canvas has visible content (not blank)", (await inkPixels()) > 50);
  const bodyText = await b.evaluate("document.body.innerText");
  check(
    "page shows title, 'Free preview: 2 of 5 pages.', counts, price and payment notice",
    bodyText.includes(`Alpha UI ${runId}`) &&
      bodyText.includes("Free preview: 2 of 5 pages.") &&
      /Preview pages\s*2/.test(bodyText) &&
      /Total pages\s*5/.test(bodyText) &&
      /Locked pages\s*3/.test(bodyText) &&
      bodyText.includes("€1,250.50") &&
      bodyText.includes("Online payment will be available soon."),
  );
  check(
    "no payment/unlock button exists",
    await b.evaluate(`[...document.querySelectorAll('button, a')].every((el) => !/pay|buy|unlock|checkout/i.test(el.textContent))`),
  );
  check("toolbar shows 'Preview page 1 of 2'", (await text("[data-page-status]")).startsWith("Preview page 1 of 2"));
  check(
    "text layer holds the page's selectable text",
    await b.evaluate(`(() => { const t = document.querySelector('.pdf-page .textLayer'); const span = t?.querySelector('span');
      return !!span && t.textContent.includes('Alpha page 1') && t.textContent.includes('FREEMARK') && getComputedStyle(span).userSelect === 'text'; })()`),
  );
  check("browser find-in-page locates preview text", await b.evaluate(`window.find('FREEMARK-${runId}')`));
  check(
    "white background with dark text and blue accents",
    isWhite(await rgbOf("body", "backgroundColor")) &&
      isWhite(await rgbOf("main", "backgroundColor")) &&
      isDark(await rgbOf("h1", "color")) &&
      isBlue(await rgbOf("[aria-labelledby=unlock-heading]", "borderTopColor")) &&
      isBlue(await rgbOf("header span", "backgroundColor")),
  );
  check("previous is disabled on the first page", await isDisabled("Previous page"));
  await b.screenshot("p5-01-desktop");

  // --- Navigation ----------------------------------------------------------------
  await click("Next page");
  check("Next shows preview page 2", await b.waitFor(`${rendered(2)} && document.querySelector('.pdf-page .textLayer')?.textContent.includes('Alpha page 2')`, 15000));
  check("toolbar shows 'Preview page 2 of 2' and Next is disabled", (await text("[data-page-status]")).startsWith("Preview page 2 of 2") && (await isDisabled("Next page")));
  check(
    "last preview page shows how many pages remain locked",
    (await b.evaluate("document.body.innerText")).includes("End of the free preview. The remaining 3 pages are locked."),
  );
  await b.screenshot("p5-02-last-preview-page");
  await click("Previous page");
  check("Previous returns to page 1", await b.waitFor(rendered(1), 15000));

  // --- Keyboard --------------------------------------------------------------------
  await b.evaluate("document.getElementById('preview-stage').focus()");
  await b.key("ArrowRight", "ArrowRight", 39);
  const arrowRight = await b.waitFor(rendered(2), 10000);
  await b.key("ArrowLeft", "ArrowLeft", 37);
  const arrowLeft = await b.waitFor(rendered(1), 10000);
  await b.key("End", "End", 35);
  const end = await b.waitFor(rendered(2), 10000);
  await b.key("Home", "Home", 36);
  const home = await b.waitFor(rendered(1), 10000);
  check("arrow keys, Home and End change pages when the preview has focus", arrowRight && arrowLeft && end && home);
  await b.evaluate(`document.querySelector('[aria-label="Next page"]').focus()`);
  await b.key("Enter", "Enter", 13);
  check("Enter on the focused Next button works", await b.waitFor(rendered(2), 10000));
  await b.evaluate(`document.querySelector('[aria-label="Previous page"]').focus()`);
  await b.key(" ", "Space", 32);
  check("Space on the focused Previous button works", await b.waitFor(rendered(1), 10000));
  await b.evaluate("document.activeElement.blur(); window.scrollTo(0, 0)");
  const focusOrder = [];
  for (let i = 0; i < 8; i++) {
    await b.key("Tab", "Tab", 9);
    focusOrder.push(await b.evaluate("document.activeElement.id || document.activeElement.getAttribute('aria-label') || document.activeElement.tagName"));
  }
  check(
    "controls are reachable with Tab in a sensible order",
    ["Next page", "Zoom out", "Zoom in", "Fit to width", "preview-stage"].every((l) => focusOrder.includes(l)) &&
      focusOrder.indexOf("Zoom in") < focusOrder.indexOf("Fit to width"),
    focusOrder.join(" > "),
  );
  check(
    "every control has an accessible name",
    await b.evaluate(`[...document.querySelectorAll('[role=toolbar] button')].every((el) => (el.getAttribute('aria-label') || el.textContent.trim()).length > 0)`),
  );

  // --- Zoom and fit -----------------------------------------------------------------
  const fitBox = await canvasBox();
  const fitZoom = await zoomPercent();
  check("fit-to-width is the default and fills the stage width", (await b.evaluate(`document.querySelector('[aria-label="Fit to width"]').getAttribute('aria-pressed')`)) === "true" && Math.abs(fitBox.cssWidth - (fitBox.stage - fitBox.pad)) <= 2);
  await click("Zoom in");
  await b.waitFor(`parseInt(document.querySelector('[data-zoom]').textContent) > ${fitZoom}`, 5000);
  await b.waitFor(rendered(1), 10000);
  const zoomedIn = await zoomPercent();
  const zoomBox = await canvasBox();
  check("Zoom in enlarges the page", zoomedIn > fitZoom && zoomBox.cssWidth > fitBox.cssWidth + 10, `${fitZoom}% -> ${zoomedIn}%`);
  check("zoomed page scrolls inside the viewer, not the page", zoomBox.stageScroll > zoomBox.stage && (await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth")));
  await b.screenshot("p5-03-zoomed");
  for (let i = 0; i < 12; i++) if (!(await isDisabled("Zoom in"))) await click("Zoom in");
  await sleep(300);
  check("zoom in stops at 300%", (await zoomPercent()) === 300 && (await isDisabled("Zoom in")));
  for (let i = 0; i < 12; i++) if (!(await isDisabled("Zoom out"))) await click("Zoom out");
  await sleep(300);
  check("zoom out stops at 50%", (await zoomPercent()) === 50 && (await isDisabled("Zoom out")));
  await b.evaluate("document.getElementById('preview-stage').focus()");
  await b.key("+", "Equal", 187);
  await b.waitFor(`parseInt(document.querySelector('[data-zoom]').textContent) > 50`, 5000);
  check("+ key zooms in", (await zoomPercent()) > 50);
  await click("Fit to width");
  await b.waitFor(`parseInt(document.querySelector('[data-zoom]').textContent) === ${fitZoom}`, 5000);
  check("Fit width restores the fitted size", (await zoomPercent()) === fitZoom);

  // --- Rapid navigation and zoom -------------------------------------------------
  const errorsBefore = b.log.length;
  for (let i = 0; i < 10; i++) {
    void click(i % 2 ? "Previous page" : "Next page");
    void click(i % 3 ? "Zoom in" : "Zoom out");
  }
  await sleep(500);
  await click("Fit to width");
  await b.waitFor(`document.querySelector('[data-rendered-page]') && document.querySelector('[data-page-status]').textContent.startsWith('Preview page ' + document.querySelector('[data-rendered-page]').dataset.renderedPage)`, 15000);
  const settled = await b.evaluate(`(() => { const host = document.querySelector('.pdf-page'); const label = document.querySelector('[data-page-status]').textContent;
    const page = Number(label.match(/Preview page (\\d+)/)[1]); return { canvases: host.querySelectorAll('canvas').length, layers: host.querySelectorAll('.textLayer').length,
    rendered: Number(host.dataset.renderedPage), page, text: host.querySelector('.textLayer').textContent }; })()`);
  check(
    "after rapid clicks exactly one canvas and text layer remain, matching the shown page",
    settled.canvases === 1 && settled.layers === 1 && settled.rendered === settled.page && settled.text.includes(`Alpha page ${settled.page}`),
    JSON.stringify({ ...settled, text: undefined }),
  );
  check("no script errors during rapid navigation", b.log.length === errorsBefore, b.log.slice(errorsBefore).join(" | "));

  // --- Requests: only this origin, only the preview ---------------------------------
  const appOrigin = new URL(APP_URL).origin;
  const external = requests.filter((u) => !u.startsWith(appOrigin) && !u.startsWith("data:") && !u.startsWith("blob:"));
  check("no requests to other hosts (no CDN, no storage URLs, no third-party scripts)", external.length === 0, external.join(", "));
  check("no request for an original PDF", requests.every((u) => !/original/i.test(u) && !u.startsWith(API_URL)));
  check("the preview endpoint is the only document fetched", requests.filter((u) => u.endsWith(`/p/${A.token}/preview`)).length >= 1);
  const workerUrl = requests.find((u) => u.includes("pdf.worker"));
  check("PDF.js worker is loaded locally from /pdfjs/<version>/", !!workerUrl && /\/pdfjs\/\d+\.\d+\.\d+\/pdf\.worker\.min\.mjs$/.test(workerUrl), workerUrl);
  const pdfjsVersion = workerUrl?.match(/\/pdfjs\/([^/]+)\//)?.[1];
  const libVersion = await b.evaluate(`(async () => { const r = await fetch('/pdfjs/${pdfjsVersion}/pdf.worker.min.mjs'); return r.ok && (await r.text()).includes('${pdfjsVersion}'); })()`);
  check("the worker matches the bundled library version", libVersion === true);

  // --- Bundle isolation: the dashboard doesn't ship PDF.js ---------------------------
  const scriptUrls = async (html) => [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], APP_URL).href);
  const hasPdfjs = async (urls) => {
    // A string from inside the PDF.js library itself (not the viewer code).
    for (const u of urls) if ((await (await fetch(u)).text()).includes("Setting up fake worker failed")) return true;
    return false;
  };
  const dashHtml = await (await fetch(`${APP_URL}/dashboard`, { headers: { cookie: lead.cookie } })).text();
  const dashScripts = await scriptUrls(dashHtml);
  check("dashboard page loads (signed-in lead) and none of its scripts contain PDF.js", dashHtml.includes(lead.fullName) && dashScripts.length > 0 && !(await hasPdfjs(dashScripts)));
  const clientChunks = await b.evaluate(`performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/_next/static/') && n.endsWith('.js'))`);
  const initialClient = await scriptUrls(await (await fetch(`${APP_URL}/p/${A.token}`)).text());
  check(
    "PDF.js arrives in a chunk loaded on demand by the client page (not in its initial scripts)",
    (await hasPdfjs(clientChunks)) && !(await hasPdfjs(initialClient)),
  );

  // --- One-page preview ------------------------------------------------------------
  await b.navigate(`/p/${C.token}`);
  check("one-page preview renders", await b.waitFor(rendered(1), 20000));
  check(
    "one-page preview: 'Page 1 of 1', both page buttons disabled, 2 pages locked",
    (await text("[data-page-status]")).startsWith("Preview page 1 of 1") &&
      (await isDisabled("Previous page")) &&
      (await isDisabled("Next page")) &&
      (await b.evaluate("document.body.innerText")).includes("The remaining 2 pages are locked."),
  );
  await b.screenshot("p5-04-one-page");

  // --- Very large page ---------------------------------------------------------
  await b.navigate(`/p/${D.token}`);
  check("200 × 200 inch page renders", await b.waitFor(rendered(1), 30000));
  for (let i = 0; i < 8; i++) if (!(await isDisabled("Zoom in"))) await click("Zoom in");
  await b.waitFor(`parseInt(document.querySelector('[data-zoom]').textContent) === 300`, 5000);
  await b.waitFor(rendered(1), 30000);
  await sleep(500);
  const big = await canvasBox();
  check("large page at 300%: canvas backing store stays within the 16.7 MP cap", big.width * big.height <= 4096 * 4096 + 8192, `${big.width}×${big.height}`);
  check("large page: no script errors", !b.log.some((l) => /exception/i.test(l)), b.log.join(" | "));

  // --- Mobile (390 px) ---------------------------------------------------------
  await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await b.navigate(`/p/${A.token}`);
  check("mobile: preview renders", await b.waitFor(rendered(1), 20000));
  const mobile = await canvasBox();
  check(
    "mobile: no horizontal page overflow and the page fits the viewer width",
    (await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth")) && mobile.cssWidth <= mobile.stage,
  );
  check(
    "mobile: toolbar buttons are at least 36 px tall",
    await b.evaluate(`[...document.querySelectorAll('[role=toolbar] button')].every((el) => el.getBoundingClientRect().height >= 36)`),
  );
  await b.screenshot("p5-05-mobile");
  await b.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  await b.screenshot("p5-06-mobile-bottom");
  await b.evaluate("window.scrollTo(0, 0)");
  await click("Zoom in");
  await click("Zoom in");
  await sleep(800);
  check("mobile: zooming in scrolls the viewer, not the page", await b.evaluate("document.documentElement.scrollWidth <= window.innerWidth && document.getElementById('preview-stage').scrollWidth > document.getElementById('preview-stage').clientWidth"));
  await b.send("Emulation.clearDeviceMetricsOverride");

  // --- Dark colour scheme: the client page stays white ---------------------------
  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await b.navigate(`/p/${A.token}`);
  await b.waitFor(rendered(1), 20000);
  check(
    "with a dark OS colour scheme the client page is still white with dark text",
    isWhite(await rgbOf("body", "backgroundColor")) && isDark(await rgbOf("h1", "color")) && isDark(await rgbOf("body", "color")),
  );
  await b.screenshot("p5-07-dark-scheme");
  await b.send("Emulation.setEmulatedMedia", { features: [] });

  // --- Error states ----------------------------------------------------------------
  await intercept("fail");
  await b.navigate(`/p/${A.token}`);
  check("network failure: error state (no endless spinner)", await b.waitFor(viewerState("error"), 15000));
  check(
    "network failure: useful message and a Try again button",
    (await b.evaluate("document.body.innerText")).includes("We couldn't load the preview. Check your connection and try again.") &&
      (await b.evaluate(`[...document.querySelectorAll('button')].some((el) => el.textContent.includes('Try again'))`)),
  );
  await b.screenshot("p5-08-network-error");
  await intercept(null);
  const previewRequestsBefore = requests.filter((u) => u.endsWith("/preview")).length;
  await b.clickText("button", "Try again");
  check("Try again re-requests the preview and renders it", await b.waitFor(rendered(1), 20000));
  check("retry made a new request to the server (access re-checked)", requests.filter((u) => u.endsWith("/preview")).length > previewRequestsBefore);

  await intercept("corrupt");
  await b.navigate(`/p/${A.token}`);
  check("unreadable PDF bytes: render error state", await b.waitFor(viewerState("error"), 15000));
  check("unreadable PDF bytes: says it couldn't be displayed", (await b.evaluate("document.body.innerText")).includes("The preview couldn't be displayed."));
  await intercept(null);
  await b.clickText("button", "Try again");
  check("render error: Try again recovers", await b.waitFor(rendered(1), 20000));

  // Missing preview object (server answers 503).
  const path = B.row.preview_storage_path;
  const { data: saved } = await trusted.storage.from(BUCKET).download(path);
  const savedBytes = Buffer.from(await saved.arrayBuffer());
  await trusted.storage.from(BUCKET).remove([path]);
  await b.navigate(`/p/${B.token}`);
  check("missing preview object: page loads with title, viewer shows an error", (await b.waitFor(viewerState("error"), 15000)) && (await b.evaluate("document.body.innerText")).includes(`Bravo UI ${runId}`));
  check("missing preview object: 'temporarily unavailable' with Try again", (await b.evaluate("document.body.innerText")).includes("The preview is temporarily unavailable. Please try again in a moment."));
  await b.screenshot("p5-09-preview-missing");
  await trusted.storage.from(BUCKET).upload(path, new Blob([savedBytes], { type: "application/pdf" }), { contentType: "application/pdf" });
  await b.clickText("button", "Try again");
  check("after the object is restored, Try again renders the preview", await b.waitFor(rendered(1), 20000));

  // Link revoked after the page has loaded (preview request held until then).
  await intercept("hold");
  await b.navigate(`/p/${E.token}`);
  const loadingSeen = await b.waitFor(`${viewerState("loading")} && document.body.innerText.includes(${JSON.stringify(`Echo UI ${runId}`)})`, 10000);
  check("revoked-after-load: page shows the title while the preview is loading", loadingSeen);
  for (let i = 0; i < 50 && held.length === 0; i++) await sleep(100);
  const revoke = await h.act(leadB, "revokeLinkAction", { proposalId: E.id });
  interceptMode = null;
  for (const requestId of held.splice(0)) await b.send("Fetch.continueRequest", { requestId });
  await b.send("Fetch.disable");
  check("revoked-after-load: revoke succeeded", revoke.ok === true);
  check("revoked-after-load: viewer says the link is no longer available", await b.waitFor(viewerState("unavailable"), 15000));
  await b.screenshot("p5-10-revoked-after-load");
  await b.clickText("button", "Check again");
  check("revoked-after-load: Check again re-checks and stays unavailable", (await b.waitFor(viewerState("unavailable"), 15000)) && !(await b.evaluate(rendered(1))));
  // Same URL as the open page: wait for the reloaded document, not the old one.
  await b.navigate(`/p/${E.token}`);
  check(
    "revoked-after-load: reloading shows the generic unavailable page without the title",
    (await b.waitFor(`document.body.innerText.includes("This link isn't available")`, 15000)) &&
      !(await b.evaluate("document.body.innerText")).includes(`Echo UI ${runId}`),
  );
  await b.screenshot("p5-11-unavailable");

  // Slow preview: the spinner gives up after the 30 s timeout.
  await intercept("hold");
  await b.navigate(`/p/${A.token}`);
  const started = Date.now();
  const timedOut = await b.waitFor(viewerState("error"), 40000);
  check(
    "slow preview: loading ends in a timeout error with Try again (no endless spinner)",
    timedOut && (await b.evaluate("document.body.innerText")).includes("Loading the preview is taking too long."),
    `${Math.round((Date.now() - started) / 1000)} s`,
  );
  interceptMode = null;
  for (const requestId of held.splice(0)) await b.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => {});
  await b.send("Fetch.disable");
  await b.clickText("button", "Try again");
  check("slow preview: Try again then succeeds", await b.waitFor(rendered(1), 20000));

  check("no uncaught exceptions in the browser", !b.log.some((l) => l.startsWith("exception")), b.log.join(" | "));
}

await h.run(async () => {
  try {
    await scenario();
  } finally {
    await b?.close();
  }
});
