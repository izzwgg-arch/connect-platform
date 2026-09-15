import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { Journal } from "./runtime/journal";
import { PlaywrightRuntime } from "./browserCompanion/playwrightRuntime";

const { chromium }: { chromium: { launchPersistentContext: (profile: string, options: Record<string, unknown>) => Promise<any> } } = require("playwright-core");

async function site() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/form") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>Loopcom proof</title><h1>Customer export</h1><form action="/submit" method="post"><label>Contact <input name="contact"></label><label>Company <input name="company"></label><input type="file" name="source"><button type="submit">Send report</button></form><a href="/report.csv">Download CSV</a>`);
      return;
    }
    if (url.pathname === "/report.csv") {
      res.setHeader("content-type", "text/csv");
      res.setHeader("content-disposition", "attachment; filename=report.csv");
      res.end("customer,amount\nLoopcom,125\n");
      return;
    }
    if (url.pathname === "/submit") { res.end("submitted"); return; }
    res.statusCode = 404; res.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("server address unavailable");
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function ref(read: any, name: string, type?: string) {
  const found = read.elements.find((element: any) => String(element.name).includes(name) && (!type || element.type === type));
  assert.ok(found, `missing element ${name}`);
  return found.ref as string;
}

test("Loopcom Playwright runtime uses an isolated Chrome profile and one-use approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "loopcom-playwright-"));
  const workspace = path.join(root, "workspace");
  const portal = await site();
  const runtime = new PlaywrightRuntime({
    userData: root,
    env: () => ({ workspace, roots: [root, workspace], home: root }),
    journal: new Journal(path.join(root, "journal")),
    onStop: () => undefined,
    launchContext: (profile) => chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, acceptDownloads: true }),
  });
  try {
    const opening = await runtime.prepare("open", { url: `${portal.base}/form` }, "task-a", new AbortController().signal, "conversation-a");
    assert.equal(opening.ok, true);
    const opened: any = await runtime.execute("open", { url: `${portal.base}/form` }, "task-a", new AbortController().signal, "conversation-a", String(opening.authorization));
    assert.equal(opened.ok, true);
    assert.equal(runtime.status().mode, "isolated_installed_chrome");

    const hidden = await runtime.execute("tabs", {}, "task-b", new AbortController().signal, "conversation-b");
    assert.deepEqual(hidden.tabs, []);
    const foreign = await runtime.execute("read", { tabId: opened.tabId }, "task-b", new AbortController().signal, "conversation-b");
    assert.equal(foreign.error, "tab_not_owned");

    const first: any = await runtime.execute("read", { tabId: opened.tabId }, "task-a", new AbortController().signal, "conversation-a");
    assert.match(first.text, /Customer export/);
    assert.equal(first.elements.some((element: any) => element.type === "file"), true);
    const contact = ref(first, "Contact", "text");
    const fillArgs = { tabId: opened.tabId, action: "fill", ref: contact, value: "Ada Lovelace" };
    const fillApproval = await runtime.prepare("act", fillArgs, "task-a", new AbortController().signal, "conversation-a");
    const companyArgs = { tabId: opened.tabId, action: "fill", ref: ref(first, "Company", "text"), value: "Loopcom" };
    const companyApproval = await runtime.prepare("act", companyArgs, "task-a", new AbortController().signal, "conversation-a");
    assert.equal((await runtime.execute("act", companyArgs, "task-a", new AbortController().signal, "conversation-a", String(companyApproval.authorization))).ok, true);
    const staleApproval: any = await runtime.execute("act", fillArgs, "task-a", new AbortController().signal, "conversation-a", String(fillApproval.authorization));
    assert.equal(staleApproval.error, "page_changed");
    const afterCompany: any = await runtime.execute("read", { tabId: opened.tabId }, "task-a", new AbortController().signal, "conversation-a");
    const currentFillArgs = { ...fillArgs, ref: ref(afterCompany, "Contact", "text") };
    const currentApproval = await runtime.prepare("act", currentFillArgs, "task-a", new AbortController().signal, "conversation-a");
    const filled: any = await runtime.execute("act", currentFillArgs, "task-a", new AbortController().signal, "conversation-a", String(currentApproval.authorization));
    assert.equal(filled.ok, true, JSON.stringify(filled));
    const replay: any = await runtime.execute("act", currentFillArgs, "task-a", new AbortController().signal, "conversation-a", String(currentApproval.authorization));
    assert.equal(replay.error, "approval_expired");

    const refreshed: any = await runtime.execute("read", { tabId: opened.tabId }, "task-a", new AbortController().signal, "conversation-a");
    const downloadArgs = { tabId: opened.tabId, ref: ref(refreshed, "Download CSV") };
    const downloadApproval = await runtime.prepare("download", downloadArgs, "task-a", new AbortController().signal, "conversation-a");
    const downloaded: any = await runtime.execute("download", downloadArgs, "task-a", new AbortController().signal, "conversation-a", String(downloadApproval.authorization));
    assert.equal(downloaded.ok, true);
    assert.equal(await readFile(downloaded.path, "utf8"), "customer,amount\nLoopcom,125\n");
  } finally {
    await runtime.stop();
    await portal.close();
    await rm(root, { recursive: true, force: true });
  }
});
