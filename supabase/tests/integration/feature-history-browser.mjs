// Browser checks for the feature update (headless Chrome over CDP): the
// display-name dialog, Proposal History filters, the delete confirmation
// (pointer and keyboard), and the client page's locked-page placeholders,
// on desktop and mobile. Disposable users and proposals only.
//
//   npm run build && npx next start -p 3100            # another terminal
//   APP_URL=http://localhost:3100 CHROME_PATH=... npm run test:history-browser -- <screenshot dir>

import { PDFDocument, StandardFonts } from "pdf-lib";

import { launchBrowser, ready } from "./lib/browser.mjs";
import { createHarness } from "./lib/portal.mjs";

const OUT = process.argv[2];
if (!OUT) {
  console.error("Usage: node feature-history-browser.mjs <screenshot dir>");
  process.exit(2);
}
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const h = createHarness("fhb");
const { APP_URL, runId, trusted, check, provisionUser, createDraft, publishProposal } = h;

async function makePdf(label, pages, free) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([420, 595]);
    page.drawText(`${label} page ${i}`, { x: 30, y: 520, size: 24, font });
    page.drawText(`${i <= free ? "FREEMARK" : "LOCKEDMARK"}-${runId}`, { x: 30, y: 480, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

const OFFER = { freePages: "2", price: "25.00", currency: "USD" };

async function main() {
  const admin = await provisionUser("admin", "admin");
  const lead = await provisionUser("lead", "team_lead");
  const other = await provisionUser("other", "team_lead");
  const issued = await publishProposal(lead, { title: `Browser Offer ${runId}`, pdf: await makePdf("Browser", 9, 2), offer: OFFER });
  const draft = await createDraft(lead, `Browser Draft ${runId}`);
  const doomed = await publishProposal(lead, { title: `Doomed Offer ${runId}`, pdf: await makePdf("Doomed", 3, 1), offer: { ...OFFER, freePages: "1" } });
  const others = await publishProposal(other, { title: `Other Offer ${runId}`, pdf: await makePdf("Other", 3, 1), offer: { ...OFFER, freePages: "1" } });

  const b = await launchBrowser({ chromePath: CHROME, outDir: OUT, appUrl: APP_URL });
  try {
    await b.send("Network.enable");
    await b.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    const requests = [];
    b.on("Network.requestWillBeSent", (p) => requests.push(p.request.url));
    const setViewport = (width, height, mobile = false) =>
      b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const noOverflow = () => b.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1");
    const signIn = async (user) => {
      await b.send("Network.clearBrowserCookies");
      for (const [name, value] of user.jar) await b.send("Network.setCookie", { name, value, url: APP_URL, path: "/" });
    };
    const dialog = "document.querySelector('dialog[open]')";
    const dialogText = `(${dialog}?.innerText ?? '')`;
    const bodyText = () => b.evaluate("document.body.innerText");
    const activeLabel = () => b.evaluate("document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? ''");

    // --- Display name (desktop) ---------------------------------------------
    await setViewport(1280, 900);
    await signIn(lead);
    await b.navigate("/dashboard");
    await b.waitFor(ready("button[aria-label='Edit display name']"), 20000);
    const newName = `Fassih Browser ${runId}`;
    await b.clickSelector("button[aria-label='Edit display name']");
    await b.waitFor(`!!${dialog} && ${dialogText}.includes('Edit display name')`);
    check("the name dialog explains that clients never see the name", (await b.evaluate(dialogText)).includes("Clients never see it"));
    check("the name field is prefilled with the current name", (await b.evaluate(`${dialog}.querySelector('input[name=fullName]').value`)) === lead.fullName);
    await b.typeInto("dialog[open] input[name=fullName]", newName);
    await b.key("Enter");
    const closed = await b.waitFor(`!${dialog}`, 15000);
    check("saving closes the dialog", closed);
    const headerUpdated = await b.waitFor(`document.querySelector('header').innerText.includes(${JSON.stringify(newName)})`, 10000);
    check("the header shows the new name without a reload", headerUpdated);
    await b.screenshot("01-name-updated-desktop");
    await b.navigate("/dashboard");
    check("the new name persists after a reload", await b.waitFor(`document.querySelector('header').innerText.includes(${JSON.stringify(newName)})`, 10000));

    // Keyboard: open with Enter, close with Escape, focus returns.
    await b.waitFor(ready("button[aria-label='Edit display name']"), 20000);
    await b.evaluate("document.querySelector(\"button[aria-label='Edit display name']\").focus()");
    await b.key("Enter", "Enter", 13);
    await b.waitFor(`!!${dialog}`);
    check("the name dialog focuses its field", await b.waitFor("document.activeElement?.name === 'fullName'", 5000));
    await b.key("Escape", "Escape", 27);
    await b.waitFor(`!${dialog}`);
    check("Escape closes it and focus returns to the trigger", await b.waitFor("document.activeElement?.getAttribute('aria-label') === 'Edit display name'", 5000), await activeLabel());

    // --- History filters ---------------------------------------------------------
    await b.navigate("/dashboard");
    await b.clickText("a", "Proposal History");
    await b.waitFor("location.search.includes('tab=history')", 10000);
    await b.waitFor(`document.body.innerText.includes(${JSON.stringify(`Browser Offer ${runId}`)})`, 15000);
    let text = await bodyText();
    check("History lists drafts and issued proposals", text.includes(`Browser Draft ${runId}`) && text.includes(`Browser Offer ${runId}`));
    check("History never lists another lead's proposals", !text.includes(`Other Offer ${runId}`));
    await b.screenshot("02-history-desktop");

    await b.evaluate(`(() => { const s = document.querySelector('select[name=status]'); s.focus(); })()`);
    await b.evaluate(`(() => { const s = document.querySelector('select[name=status]'); s.value = 'draft'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await b.waitFor("location.search.includes('status=draft')", 10000);
    await b.waitFor(`!document.body.innerText.includes(${JSON.stringify(`Browser Offer ${runId}`)})`, 10000);
    check("the status filter narrows the list", (await bodyText()).includes(`Browser Draft ${runId}`));
    await b.navigate("/dashboard?tab=history&status=draft");
    await b.waitFor(`document.body.innerText.includes(${JSON.stringify(`Browser Draft ${runId}`)})`, 10000);
    check(
      "the filter survives a reload",
      (await b.evaluate("document.querySelector('select[name=status]').value")) === "draft" && !(await bodyText()).includes(`Browser Offer ${runId}`),
    );

    // --- Delete confirmation --------------------------------------------------------
    await b.navigate("/dashboard?tab=history");
    const deleteSelector = `button[aria-label='Delete proposal Doomed Offer ${runId}']`;
    await b.waitFor(ready(deleteSelector), 15000);
    await b.clickSelector(deleteSelector);
    await b.waitFor(`!!${dialog}`);
    const confirmText = await b.evaluate(dialogText);
    check(
      "the confirmation names the proposal and its client",
      confirmText.includes(`Doomed Offer ${runId}`) && confirmText.includes(doomed.client.name),
    );
    check(
      "it explains what is removed and what is kept",
      confirmText.includes("can't be undone") && confirmText.includes("client link stops working") && confirmText.includes("client record and other proposals are kept"),
    );
    await b.screenshot("03-delete-confirmation-desktop");
    await b.key("Escape", "Escape", 27);
    await b.waitFor(`!${dialog}`);
    const { data: stillThere } = await trusted.from("proposals").select("id").eq("id", doomed.id).maybeSingle();
    check("cancelling deletes nothing", Boolean(stillThere));

    // Keyboard path: open with Enter, Tab to the destructive button, confirm.
    await b.evaluate(`document.querySelector(${JSON.stringify(deleteSelector)}).focus()`);
    await b.key("Enter", "Enter", 13);
    await b.waitFor(`!!${dialog}`);
    let reached = false;
    for (let i = 0; i < 8 && !reached; i++) {
      await b.key("Tab", "Tab", 9);
      reached = (await b.evaluate("document.activeElement?.textContent?.trim()")) === "Delete permanently";
    }
    check("the destructive button is reachable by keyboard", reached);
    await b.key("Enter", "Enter", 13);
    const toast = "[...document.querySelectorAll('[role=status]')].some((e) => e.textContent.includes('permanently deleted'))";
    const toastSeen = await b.waitFor(toast, 30000);
    const gone = await b.waitFor(`!${dialog} && !document.body.innerText.includes(${JSON.stringify(`Doomed Offer ${runId}`)})`, 30000);
    check("confirming deletes it and the row disappears", gone);
    check("a confirmation message is shown", toastSeen);
    const { data: afterDelete } = await trusted.from("proposals").select("id").eq("id", doomed.id).maybeSingle();
    check("the proposal is gone from the database", !afterDelete);
    await b.screenshot("04-after-delete-desktop");

    // --- CEO view -----------------------------------------------------------------
    await signIn(admin);
    await b.navigate("/dashboard?tab=history");
    await b.waitFor(`document.body.innerText.includes(${JSON.stringify(`Other Offer ${runId}`)})`, 15000);
    text = await bodyText();
    check("the CEO's history spans leads and shows the new owner name", text.includes(`Browser Offer ${runId}`) && text.includes(newName));
    await b.evaluate(`(() => { const s = document.querySelector('select[name=owner]'); s.value = ${JSON.stringify(other.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await b.waitFor(`location.search.includes(${JSON.stringify(other.id)})`, 10000);
    await b.waitFor(`!document.body.innerText.includes(${JSON.stringify(`Browser Offer ${runId}`)})`, 10000);
    check("the CEO's Team Lead filter works on History", (await bodyText()).includes(`Other Offer ${runId}`));
    check(
      "the Team Lead filter lists the updated name",
      await b.evaluate(`[...document.querySelectorAll('select[name=owner] option')].some((o) => o.textContent === ${JSON.stringify(newName)})`),
    );

    // --- Mobile dashboard -----------------------------------------------------------------
    await setViewport(390, 844, true);
    await signIn(lead);
    await b.navigate("/dashboard?tab=history");
    await b.waitFor(`document.body.innerText.includes(${JSON.stringify(`Browser Offer ${runId}`)})`, 15000);
    check("mobile History has no horizontal overflow", await noOverflow());
    check("the mobile tab reads 'History'", await b.evaluate("[...document.querySelectorAll('nav a')].some((a) => a.innerText.trim().startsWith('History'))"));
    check("the name button is visible on mobile", await b.evaluate(ready("button[aria-label='Edit display name']")));
    await b.screenshot("05-history-mobile");
    await b.clickSelector(`button[aria-label='Delete proposal Browser Offer ${runId}']`);
    await b.waitFor(`!!${dialog}`);
    check(
      "the mobile confirmation fits the screen",
      await b.evaluate(`(() => { const r = ${dialog}.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; })()`),
    );
    await b.screenshot("06-delete-confirmation-mobile");
    await b.key("Escape", "Escape", 27);
    await b.waitFor(`!${dialog}`);

    // --- Client page placeholders --------------------------------------------------------
    for (const [label, width, height, mobile] of [["desktop", 1280, 900, false], ["mobile", 390, 844, true]]) {
      await setViewport(width, height, mobile);
      await b.send("Network.clearBrowserCookies");
      requests.length = 0;
      await b.navigate(`/p/${issued.token}`);
      await b.waitFor("document.querySelector('[data-viewer-state]')?.dataset.viewerState === 'ready' && !!document.querySelector('[data-rendered-page]')", 20000);
      const status = await b.evaluate("document.querySelector('[data-page-status]').innerText");
      check(`${label}: the toolbar separates preview and document page numbers`, /Preview page 1 of 2/.test(status) && /Document page 1 of 9/.test(status), status);
      const cards = await b.evaluate("[...document.querySelectorAll('[data-locked-page]')].map((e) => Number(e.dataset.lockedPage))");
      check(`${label}: six placeholders for pages 3–8`, JSON.stringify(cards) === "[3,4,5,6,7,8]", JSON.stringify(cards));
      check(
        `${label}: placeholders contain no canvas, image or locked text`,
        await b.evaluate("(() => { const s = document.querySelector('[data-locked-pages]'); return !s.querySelector('canvas, img, object, iframe, embed') && !s.innerText.includes('LOCKEDMARK'); })()"),
      );
      check(`${label}: each placeholder shows a lock and 'Locked page'`, await b.evaluate("[...document.querySelectorAll('[data-locked-page]')].every((e) => e.querySelector('svg') && e.innerText.includes('Locked page'))"));
      check(`${label}: no horizontal overflow`, await noOverflow());
      await b.evaluate("document.querySelector('[data-locked-pages]').scrollIntoView({ block: 'start' })");
      await b.screenshot(`07-client-placeholders-${label}`);

      // Keyboard: the Next control pages through the placeholders.
      await b.evaluate("document.querySelector(\"button[aria-label='Next locked pages']\").focus()");
      await b.key("Enter", "Enter", 13);
      await b.waitFor("document.querySelector('[data-locked-page]')?.dataset.lockedPage === '9'", 5000);
      const second = await b.evaluate("[...document.querySelectorAll('[data-locked-page]')].map((e) => Number(e.dataset.lockedPage))");
      check(`${label}: Next shows the remaining locked page`, JSON.stringify(second) === "[9]", JSON.stringify(second));
      check(
        `${label}: Next is then disabled and Previous enabled`,
        await b.evaluate("document.querySelector(\"button[aria-label='Next locked pages']\").disabled && !document.querySelector(\"button[aria-label='Previous locked pages']\").disabled"),
      );
      check(`${label}: the range label names document pages`, (await b.evaluate("document.querySelector('[data-locked-range]').innerText")).includes("Document pages 9 of 9"));

      // Free-page navigation still works.
      await b.clickSelector("button[aria-label='Next page']");
      check(`${label}: free-page navigation still works`, await b.waitFor("document.querySelector('[data-page-status]').innerText.startsWith('Preview page 2 of 2')", 10000));

      const documentRequests = requests.filter((url) => /\.pdf|\/preview|original/.test(new URL(url).pathname) && !url.includes("/pdfjs/"));
      check(
        `${label}: the only document request is the free preview`,
        documentRequests.length >= 1 && documentRequests.every((url) => new URL(url).pathname === `/p/${issued.token}/preview`),
        JSON.stringify(documentRequests.map((u) => new URL(u).pathname.replace(issued.token, "<token>"))),
      );
      check(`${label}: the page shows the price and payment notice`, (await bodyText()).includes("Online payment will be available soon."));
    }

    // Untouched by the browser run.
    const { data: keep } = await trusted.from("proposals").select("id").in("id", [issued.id, draft.id, others.id]);
    check("other proposals were not affected", (keep ?? []).length === 3);
  } finally {
    await b.close();
  }
}

await h.run(main);
