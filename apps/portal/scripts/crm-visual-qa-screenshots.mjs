import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.base || "http://127.0.0.1:3006").replace(/\/$/, "");
const outDir = path.resolve(String(args.out || "../../_tmp_diag/crm-visual-qa-screenshots"));
const theme = String(args.theme || "light");
const routes = String(args.routes || "/crm/dashboard,/crm/queue,/crm/contacts")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const allViewports = [
  { name: "desktop", width: 1365, height: 768 },
  { name: "tablet", width: 900, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const viewportFilter = String(args.viewports || "desktop,tablet,mobile")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const viewports = allViewports.filter((viewport) => viewportFilter.includes(viewport.name));
if (viewports.length === 0) {
  throw new Error(`No matching viewports for --viewports ${viewportFilter.join(",")}`);
}

const chromePath = String(args.chrome || findChrome());
const port = Number(args.debugPort || 9444);
const profileDir = path.resolve(String(args.profile || `../../_tmp_diag/crm-visual-qa-chrome-profile-${process.pid}`));

if (!chromePath) {
  throw new Error("Could not find Chrome. Pass --chrome \"C:\\\\Path\\\\to\\\\chrome.exe\".");
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(webSocketUrl);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  async open() {
    while (this.ws.readyState === WebSocket.CONNECTING) await sleep(20);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  await assertPortalReady(`${baseUrl}/crm/queue`);
  await waitJson(`http://127.0.0.1:${port}/json/version`);

  const generated = [];
  for (const route of routes) {
    for (const viewport of viewports) {
      const file = await captureRoute(route, viewport);
      generated.push(file);
      console.log(file);
    }
  }

  if (generated.length === 0) throw new Error("No screenshots generated.");
} finally {
  chrome.kill();
}

async function captureRoute(route, viewport) {
  const target = await newPage("about:blank");
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 700,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      localStorage.setItem('cc-theme', ${JSON.stringify(theme)});
      localStorage.setItem('cc-admin-scope', 'TENANT');
    `,
  });
  await cdp.send("Page.navigate", { url: `${baseUrl}${route}` });
  await waitForPage(cdp, route);
  await cdp.send("Runtime.evaluate", {
    expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; undefined`,
  });
  await sleep(Number(args.settleMs || 1800));

  const text = await cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  });
  const bodyText = String(text.result.value || "");
  if (/Checking session|Validating authentication|Access denied/i.test(bodyText)) {
    throw new Error(`Route did not render authenticated CRM content: ${route}. Body: ${bodyText.replace(/\s+/g, " ").slice(0, 240)}`);
  }

  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const name = `${slugRoute(route)}-${theme}-${viewport.name}-${viewport.width}x${viewport.height}.png`;
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  cdp.close();
  return file;
}

async function waitForPage(cdp, route) {
  const expectedText =
    route.startsWith("/crm/dashboard") ? "Here's what's happening" :
    route.startsWith("/crm/contacts") ? "Contacts" :
    route.startsWith("/crm/queue") ? "My Queue" :
    route.startsWith("/crm/tasks") ? "Follow-ups, callbacks" :
    "CRM";

  for (let i = 0; i < 240; i += 1) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `document.body.innerText.includes(${JSON.stringify(expectedText)})`,
      returnByValue: true,
    });
    if (result.result.value) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${route}`);
}

async function assertPortalReady(url) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // wait
    }
    await sleep(250);
  }
  throw new Error(`Portal dev server is not reachable at ${url}. Run pnpm --dir apps/portal dev:crm-visual-qa first.`);
}

async function newPage(url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!res.ok) throw new Error(`Chrome new page failed: ${res.status}`);
  return res.json();
}

async function waitJson(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {
      // wait
    }
    await sleep(250);
  }
  throw new Error("Chrome debugging endpoint did not start.");
}

function parseArgs(raw) {
  const parsed = {};
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = raw[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = "1";
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function findChrome() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function slugRoute(route) {
  return route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

