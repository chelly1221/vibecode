// Drive the running vibecode WebView2 through the Chrome DevTools Protocol.
// Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222, then:
//   node scripts/cdp.mjs eval "document.title"
//   node scripts/cdp.mjs shot C:\code\vibecode\.tmp\shot.png
//   node scripts/cdp.mjs run script.js            (script runs in the page; may return a Promise)
// Runs with Windows node (node.exe) so 127.0.0.1:9222 is the Windows loopback.
import { readFileSync, writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || "9222";

async function pageTarget() {
  let lastErr;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && !/devtools/.test(t.url));
      if (page) return page;
      lastErr = new Error("no page target: " + JSON.stringify(list));
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw lastErr;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  static async connect() {
    const page = await pageTarget();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }
  close() {
    this.ws.close();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const cdp = await Cdp.connect();
try {
  if (cmd === "eval") {
    console.log(JSON.stringify(await cdp.eval(rest.join(" ")), null, 2));
  } else if (cmd === "shot") {
    console.log("saved", await cdp.screenshot(rest[0]));
  } else if (cmd === "run") {
    // page-helpers.js is injected first so scripts can use window.__vc.*
    const helpers = readFileSync(new URL("./page-helpers.js", import.meta.url), "utf8");
    const src = readFileSync(rest[0], "utf8");
    await cdp.eval(`(() => { ${helpers} })()`);
    console.log(JSON.stringify(await cdp.eval(`(async () => { const vc = window.__vc; ${src} })()`), null, 2));
  } else {
    console.error("usage: cdp.mjs eval <expr> | shot <png> | run <file.js>");
    process.exit(2);
  }
} finally {
  cdp.close();
}
