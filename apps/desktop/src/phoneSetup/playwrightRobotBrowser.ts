/**
 * The production `RobotBrowser`: playwright-core driving the installed Google
 * Chrome channel, headless, one browser process shared across every phone-web-robot
 * op, closed after five minutes of idleness or when the caller disarms it.
 *
 * ⛔⛔ THIS FILE OWNS THE ORIGIN CAGE. `buildOriginGuard` (phoneWebRobot.ts) is the
 * pure decision; this is the ONE place that wires it into Playwright's own request
 * routing. Every context this file opens gets exactly one `route` handler, and that
 * handler is the whole safety story for a browser that can type things: a request
 * to any host but the phone's own address is aborted before it leaves the process.
 *
 * ⛔ Modelled on `../coworker/browserCompanion/playwrightRuntime.ts` (installed
 * Chrome channel, `require("playwright-core")` behind a narrow declared surface so
 * this file's TypeScript project is not coupled to Playwright's module
 * resolution) — but this is its OWN engine. Nothing here reuses that file's
 * approval machinery, and nothing there calls into this: a browser that fills in a
 * customer's own desk phone has nothing to do with one that fills in a web form on
 * the model's behalf, and the two must never share a code path that could blur
 * which fences apply to which.
 *
 * ⛔ Round 23, 2026-09-17: `ignoreHTTPSErrors: true` on the context is deliberate,
 * not sloppy — a desk phone's web page presents a self-signed, per-device
 * certificate and there is nothing to verify it against (see mainWiring.ts's
 * identical note on the HTTP transport). That is safe only because the origin cage
 * below means every request from this context can only ever reach the ONE private
 * address it was opened for.
 */

import { canonicalPrivateIpv4 } from "./yealink";
import { buildOriginGuard, type RawElement, type RawRead, type RobotBrowser, type RobotPage } from "./phoneWebRobot";

// Keep the runtime dependency behind require, exactly like playwrightRuntime.ts —
// Electron's CommonJS build loads Playwright Core at runtime.
type PWBrowser = { newContext: (opts: Record<string, unknown>) => Promise<PWContext>; close: () => Promise<void> };
type PWContext = {
  route: (pattern: string, handler: (route: PWRoute) => void) => Promise<void>;
  on: (event: string, handler: (...args: any[]) => void) => void;
  newPage: () => Promise<PWPage>;
  close: () => Promise<void>;
};
type PWRoute = { request: () => { url: () => string }; continue: () => Promise<void>; abort: () => Promise<void> };
type PWPage = {
  goto: (url: string, opts: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  evaluate: <T>(fn: (...a: any[]) => T, ...args: any[]) => Promise<T>;
  $$: (selector: string) => Promise<PWElementHandle[]>;
};
type PWElementHandle = { fill: (text: string) => Promise<void>; click: () => Promise<void> };

const { chromium }: { chromium: { launch: (opts: Record<string, unknown>) => Promise<PWBrowser> } } = require("playwright-core");

/** The one selector list every read/fill/click indexes against, kept in ONE place. */
const INTERACTIVE_SELECTOR = "input,select,textarea,button,a[href]";

const IDLE_CLOSE_MS = 5 * 60_000;
const NAV_TIMEOUT_MS = 8_000;

export type PlaywrightRobotBrowserDeps = {
  /** Test seam. Production launches the installed Chrome channel below. */
  launch?: () => Promise<PWBrowser>;
  log?: (line: string) => void;
};

export function createPlaywrightRobotBrowser(deps: PlaywrightRobotBrowserDeps = {}): RobotBrowser & { close(): Promise<void> } {
  let browser: PWBrowser | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const log = (line: string) => deps.log?.(`phone web robot: ${line}`);

  const closeBrowser = async () => {
    const b = browser;
    browser = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    await b?.close().catch(() => undefined);
  };
  const armIdleClose = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void closeBrowser(); }, IDLE_CLOSE_MS);
  };
  const ensureBrowser = async (): Promise<PWBrowser> => {
    if (browser) return browser;
    browser = await (deps.launch ?? (() => chromium.launch({ channel: "chrome", headless: true })))();
    log("launched Chrome");
    return browser;
  };

  return {
    async openPage(ip: string): Promise<RobotPage | null> {
      const host = canonicalPrivateIpv4(ip);
      if (!host) return null;
      armIdleClose();
      let context: PWContext;
      try {
        const b = await ensureBrowser();
        context = await b.newContext({ ignoreHTTPSErrors: true });
      } catch {
        return null;
      }
      const allow = buildOriginGuard(host);
      try {
        // ⛔⛔ THE CAGE — see the header. Nothing this context does can reach a
        // host that is not this one phone's own address.
        await context.route("**/*", (route) => {
          void (allow(route.request().url()) ? route.continue() : route.abort());
        });
      } catch {
        await context.close().catch(() => undefined);
        return null;
      }
      // A JS `confirm()` dialog (the "autoprovision now?" / reset prompt) is
      // auto-accepted here — the driver decided to call this op; the dialog is
      // the phone's own confirmation of a step we already chose to take.
      context.on("dialog", (dialog: { accept: () => Promise<void> }) => void dialog.accept().catch(() => undefined));

      let page: PWPage | null = null;
      for (const scheme of ["https", "http"] as const) {
        try {
          const candidate = await context.newPage();
          await candidate.goto(`${scheme}://${host}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
          page = candidate;
          break;
        } catch { /* try the next scheme */ }
      }
      if (!page) { await context.close().catch(() => undefined); return null; }
      return wrapPage(page, context);
    },
    close: closeBrowser,
  };
}

function wrapPage(page: PWPage, context: PWContext): RobotPage {
  return {
    async goto(path: string) {
      // ⛔ PATH ONLY — resolved against this page's own origin, never a caller-
      // supplied absolute URL, so the cage above is the only place a scheme/host
      // decision is ever made.
      const origin = new URL(page.url()).origin;
      const suffix = path.startsWith("/") ? path : `/${path}`;
      await page.goto(`${origin}${suffix}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    },
    async read(): Promise<RawRead> {
      return page.evaluate((selector: string) => {
        const text = document.body?.innerText || "";
        const elements: RawElement[] = Array.from(document.querySelectorAll(selector)).map((node) => {
          const el = node as HTMLInputElement;
          const tag = el.tagName.toLowerCase();
          const type = tag === "input" ? (el.type || "text").toLowerCase()
            : tag === "button" ? (el.getAttribute("type") || "button").toLowerCase()
            : tag;
          const label = (el.closest("label")?.textContent
            || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "")
            || el.getAttribute("placeholder") || "") as string;
          const value = type === "checkbox" || type === "radio" ? String((el as HTMLInputElement).checked)
            : String((el as HTMLInputElement).value ?? (tag === "button" || tag === "a" ? el.textContent : "") ?? "");
          return { tag, type, name: el.name || "", id: el.id || "", label: label.trim(), value };
        });
        return { url: location.href, title: document.title, text, elements };
      }, INTERACTIVE_SELECTOR);
    },
    async fill(index: number, text: string) {
      const handles = await page.$$(INTERACTIVE_SELECTOR);
      const handle = handles[index];
      if (!handle) throw new Error("stale_index");
      await handle.fill(text);
    },
    async click(index: number) {
      const handles = await page.$$(INTERACTIVE_SELECTOR);
      const handle = handles[index];
      if (!handle) throw new Error("stale_index");
      await handle.click();
    },
    async close() { await context.close().catch(() => undefined); },
  };
}
