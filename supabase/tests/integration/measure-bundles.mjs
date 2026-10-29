// Measures the JavaScript and CSS each route actually loads in headless
// Chrome (production build + LOCAL Supabase), for before/after comparisons.
//
//   CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" \
//   APP_URL=http://localhost:3100 npm run measure:bundles -- <out-dir>
//
// Records every script/stylesheet request per route, then downloads each
// file once and reports raw and gzip sizes. A disposable team lead and one
// published proposal are created and removed again.

import { gzipSync } from "node:zlib";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { launchBrowser } from "./lib/browser.mjs";
import { createHarness } from "./lib/portal.mjs";

const CHROME = process.env.CHROME_PATH;
const OUT = process.argv[2];
if (!CHROME || !OUT) {
  console.error("Usage: CHROME_PATH=... node measure-bundles.mjs <out-dir>");
  process.exit(2);
}

const h = createHarness("measure");
const { APP_URL, runId } = h;
let b;

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) doc.addPage([420, 595]).drawText(`Measure page ${i}`, { x: 30, y: 520, size: 24, font });
  return Buffer.from(await doc.save());
}

async function main() {
  const lead = await h.provisionUser("lead", "team_lead");
  const proposal = await h.publishProposal(lead, {
    title: `Measure ${runId}`,
    pdf: await makePdf(),
    offer: { freePages: "1", price: "10.00", currency: "USD" },
  });

  b = await launchBrowser({ chromePath: CHROME, outDir: OUT, appUrl: APP_URL });
  await b.send("Network.enable");
  let current = null;
  const seen = new Map();
  b.on("Network.responseReceived", (p) => {
    if (current && (p.type === "Script" || p.type === "Stylesheet")) seen.get(current).add(`${p.type}|${p.response.url}`);
  });

  async function measure(name, path, readyExpression) {
    current = name;
    seen.set(name, new Set());
    await b.navigate(path);
    await b.waitFor(readyExpression, 20000);
    // Let lazily requested chunks (e.g. the PDF viewer) arrive.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    current = null;
  }

  await measure("/login", "/login", "!!document.querySelector('input[name=email]')");
  for (const [name, value] of lead.jar) {
    await b.send("Network.setCookie", { name, value, url: APP_URL, path: "/" });
  }
  await measure("/dashboard", "/dashboard?tab=proposals", "!!document.querySelector('tbody tr')");
  await measure("/p/[token]", `/p/${proposal.token}`, "!!document.querySelector('[data-rendered-page] canvas')");

  const sizes = new Map();
  for (const url of new Set([...seen.values()].flatMap((set) => [...set].map((e) => e.split("|")[1])))) {
    const body = Buffer.from(await (await fetch(url)).arrayBuffer());
    sizes.set(url, { raw: body.length, gzip: gzipSync(body).length });
  }

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  for (const [route, entries] of seen) {
    const totals = { Script: { raw: 0, gzip: 0, count: 0 }, Stylesheet: { raw: 0, gzip: 0, count: 0 } };
    for (const entry of entries) {
      const [type, url] = entry.split("|");
      totals[type].raw += sizes.get(url).raw;
      totals[type].gzip += sizes.get(url).gzip;
      totals[type].count += 1;
    }
    console.log(
      `${route.padEnd(12)} JS ${String(totals.Script.count).padStart(2)} files ${kb(totals.Script.raw).padStart(9)} raw ${kb(totals.Script.gzip).padStart(8)} gzip | ` +
        `CSS ${totals.Stylesheet.count} files ${kb(totals.Stylesheet.raw).padStart(8)} raw ${kb(totals.Stylesheet.gzip).padStart(7)} gzip`,
    );
  }
  h.check("measured three routes", seen.size === 3);
}

h.run(async () => {
  try {
    await main();
  } finally {
    await b?.close();
  }
});
