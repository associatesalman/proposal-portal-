// Minimal headless-Chrome driver over the DevTools protocol (Node's global
// WebSocket), for local UI checks. Uses a throwaway profile directory.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function launchBrowser({ chromePath, outDir, appUrl }) {
  mkdirSync(outDir, { recursive: true });
  const profileDir = join(outDir, "chrome-profile");
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    chromePath,
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
  const pending = new Map();
  const log = [];
  // CDP event subscribers: method -> handlers.
  const listeners = new Map();

  for (let i = 0; i < 50 && !ws; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
      }
    } catch {
      ws = undefined;
    }
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error("Could not connect to headless Chrome");

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      log.push(`exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      log.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
    for (const handler of listeners.get(msg.method) ?? []) handler(msg.params);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  function on(method, handler) {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(handler);
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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

  async function navigate(pathOrUrl) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${appUrl}${pathOrUrl}`;
    await send("Page.navigate", { url });
    await sleep(300);
    await waitFor("document.readyState === 'complete'");
  }

  async function screenshot(name) {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  }

  async function key(keyName, code = keyName, keyCode = 0) {
    // Enter needs `text` so Chrome performs the default action (form submit).
    const text = keyName === "Enter" ? "\r" : undefined;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
  }

  async function typeInto(selector, text) {
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

  // Clicks the first matching element (within `scope`, default document)
  // whose text includes `text`.
  // Waits for a visible, enabled match (JS-only controls render disabled
  // until they work).
  async function clickText(tag, text, scope = "document") {
    const id = `cdp-${randomBytes(3).toString("hex")}`;
    const match = `[...${scope}.querySelectorAll(${JSON.stringify(tag)})]
        .find((e) => e.textContent.trim().includes(${JSON.stringify(text)}) && e.checkVisibility() && !e.disabled)`;
    await waitFor(`!!${match}`, 15000);
    const found = await evaluate(`(() => {
      const el = ${match};
      if (!el) return false;
      el.id ||= ${JSON.stringify(id)};
      return el.id;
    })()`);
    if (!found) throw new Error(`no enabled ${tag} with text ${text}`);
    await clickSelector(`[id=${JSON.stringify(found)}]`);
  }

  async function setFile(selector, filePath) {
    const { result } = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!result.objectId) throw new Error(`no element ${selector}`);
    await send("DOM.setFileInputFiles", { files: [filePath], objectId: result.objectId });
  }

  async function close() {
    try {
      ws.close();
    } catch {
      // ignore
    }
    chrome.kill();
    await sleep(500);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Chrome may still hold files briefly; the folder is disposable.
    }
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");

  return { send, on, evaluate, waitFor, navigate, screenshot, key, typeInto, clickSelector, clickText, setFile, close, log };
}

// True once the element is visible and enabled. Controls that need
// JavaScript (dialog triggers, the password toggle) are rendered disabled
// until they work, so this is an observable readiness check.
export const ready = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.checkVisibility() && !el.disabled; })()`;
