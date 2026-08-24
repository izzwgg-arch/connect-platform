/**
 * The Workbench browser — how a page gets looked at from the support desk.
 *
 * Izzy, 2026-08-24: *"even a browser, so the agent can see what things look
 * like."* This module is the SERVER half of that. There are two halves and they
 * are deliberately different, because "look at a page" means two different
 * things depending on who is looking:
 *
 *   - A PERSON gets pixels: the portal renders the page in an iframe. That
 *     works with no infrastructure at all because nginx sends
 *     `X-Frame-Options: SAMEORIGIN` and the CSP allows `frame-src 'self'`, so
 *     our own pages frame and nothing else does. No code here is involved.
 *   - The AGENT gets the page: status, timing, title, headings, visible text,
 *     links, forms, scripts and stylesheets. That is what this module returns.
 *
 * ⛔⛔ IT DOES NOT TAKE SCREENSHOTS, AND THE HONEST REASON IS WORTH KEEPING:
 * pixels need a headless browser, and `app-api-1` has no chromium (checked, not
 * assumed — `command -v chromium chromium-browser google-chrome` is empty).
 * Adding puppeteer pulls ~170 MB of Chromium into an image that every api
 * deploy rebuilds. That is its own decision with its own cost, and it is not
 * this one. What the agent gets instead is what a person actually diagnoses
 * with: did it answer 200, does the markup contain the string I expect, did the
 * bundle ship, what does the page say. Do not describe this tool as seeing a
 * page's appearance — it reads a page's content.
 *
 * ⛔⛔ THE FENCE IS THE POINT OF THIS FILE. `app-api-1` sits on the docker
 * network beside Postgres, Redis, the telephony service and the PBX's MySQL
 * credential. An unrestricted fetch tool inside it is a server-side request
 * forgery hole pointed straight at production. So:
 *   1. an explicit HOST allowlist, never a blocklist and never a regex over the
 *      whole URL;
 *   2. https/http only — no file:, no data:, no gopher:;
 *   3. no credentials, no cookies, no Authorization header, EVER — the browser
 *      sees exactly what a signed-out visitor sees, which is also why it is
 *      safe to let the agent point it at the public hostnames;
 *   4. redirects are followed by hand, at most twice, and the destination of
 *      EACH hop is re-validated against the allowlist — an allowed host that
 *      302s to the metadata service must not carry us there;
 *   5. the response body is capped while it is being read, not after.
 *
 * ⛔ Rule 4 is the one that looks paranoid and is not: this repo has already
 * shipped an SSRF where the string that was validated was not the string that
 * was dialled (the desk-phone octal-octet bypass, 2026-08-22). Validate and
 * fetch the same value, every hop.
 */

import { PLATFORM_PORTAL_HOSTS } from "./publicOrigins";

/**
 * Hosts the workbench may look at.
 *
 * ⛔ The two public hostnames are here BECAUSE they are public: a request to
 * them leaves our network, comes back through nginx, and lands on exactly the
 * gates a customer's browser hits. That is the safest possible way to let an
 * agent look at our own product — it cannot reach anything a stranger could
 * not.
 *
 * ⛔ `portal:3000` is the portal container on the docker network. It is the
 * portal, not the api: it renders pages and holds no privileged door, so
 * reaching it buys page rendering without buying an internal API surface.
 *
 * ⛔⛔ `api:3001` IS DELIBERATELY ABSENT AND MUST STAY ABSENT. Every
 * `/internal/*` door authenticates with a shared secret and nothing else; a
 * fetch tool that could reach the api's own origin from inside the network is a
 * confused-deputy attack waiting for a model to be talked into it. Reaching the
 * api through the PUBLIC hostname is fine and already covered above, because
 * that path enforces JWTs and the nginx `/api/internal/` deny.
 */
export const BROWSABLE_HOSTS: readonly string[] = [
  // ⛔ Derived from publicOrigins.ts, never re-typed. That module is the ONE
  // place on the platform that names a hostname (a guard in
  // publicOrigins.test.ts enforces it), so a vhost added there is browsable
  // here the same day and the two lists cannot drift.
  ...PLATFORM_PORTAL_HOSTS,
  // The portal container on the docker network. Not in PLATFORM_PORTAL_HOSTS
  // because it is not a hostname the portal is SERVED on publicly — it is the
  // internal render target, and it holds no privileged door.
  "portal:3000",
];

export const MAX_PAGE_BYTES = 400_000;
export const PAGE_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 2;

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Is this a URL the workbench may open?
 *
 * ⛔ Compares `host` (hostname + port), not `hostname`, so `portal:3000` cannot
 * be satisfied by reaching `portal` on some other port. And it returns the
 * PARSED URL so the caller fetches the object we validated rather than the
 * string it came from.
 */
export function checkBrowsableUrl(raw: string): UrlCheck {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "Type a web address to open." };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "That isn't a web address the browser can open." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `Refused — the browser only opens http and https addresses, not "${url.protocol}"` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Refused — a web address with a username or password in it is never opened." };
  }

  const host = url.host.toLowerCase();
  if (!(BROWSABLE_HOSTS as readonly string[]).includes(host)) {
    return {
      ok: false,
      reason:
        `Refused — the browser only opens Loopcom's own pages. ` +
        `"${host}" isn't one of them (${BROWSABLE_HOSTS.join(", ")}).`,
    };
  }
  return { ok: true, url };
}

/** Everything the agent gets to know about a page it opened. */
export type PageView = {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  ms: number;
  truncated: boolean;
  title: string | null;
  /** h1/h2/h3 in document order — the page's own outline. */
  headings: Array<{ level: number; text: string }>;
  /** Visible text with script/style stripped and whitespace collapsed. */
  text: string;
  links: Array<{ text: string; href: string }>;
  /** Present so the agent can tell "the page rendered nothing" from "the page
   *  is a client-rendered shell", which on this platform is the difference
   *  between a broken deploy and a normal /login. */
  scripts: string[];
  forms: Array<{ action: string; method: string; fields: string[] }>;
  /** Set when the markup is an empty client-side shell — the documented trap
   *  where `curl | grep` on /login proves nothing either way. */
  clientRendered: boolean;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => {
      const n = Number(d);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : _m;
    });
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the page apart into the things a diagnostician asks about.
 *
 * Deliberately regex-based and forgiving rather than a real DOM parse: this
 * runs on our own pages, the answers are advisory, and adding an HTML parser
 * to `apps/api` for this would be a new dependency in the service that has
 * twice been killed at boot by one (`undici`).
 */
export function parsePage(html: string): Omit<PageView, "url" | "finalUrl" | "status" | "ok" | "contentType" | "bytes" | "ms" | "truncated"> {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || null : null;

  const headings: Array<{ level: number; text: string }> = [];
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(m[2]);
    if (text) headings.push({ level: Number(m[1]), text: text.slice(0, 200) });
    if (headings.length >= 40) break;
  }

  const links: Array<{ text: string; href: string }> = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2]);
    links.push({ text: text.slice(0, 120), href: m[1].slice(0, 400) });
    if (links.length >= 60) break;
  }

  const scripts: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*?src\s*=\s*["']([^"']+)["']/gi)) {
    scripts.push(m[1].slice(0, 300));
    if (scripts.length >= 40) break;
  }

  const forms: Array<{ action: string; method: string; fields: string[] }> = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = m[1];
    const action = attrs.match(/action\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const method = (attrs.match(/method\s*=\s*["']([^"']*)["']/i)?.[1] ?? "get").toLowerCase();
    const fields: string[] = [];
    for (const f of m[2].matchAll(/<(?:input|select|textarea)\b[^>]*?name\s*=\s*["']([^"']+)["']/gi)) {
      fields.push(f[1].slice(0, 80));
      if (fields.length >= 30) break;
    }
    forms.push({ action: action.slice(0, 300), method, fields });
    if (forms.length >= 10) break;
  }

  const text = stripTags(html);

  // ⛔ The documented /login trap: a Next client-rendered page serves a small
  // shell with real content only after hydration, so "the text is empty" is
  // NORMAL there and is not evidence of a broken deploy. Say so in the result
  // rather than letting the model conclude the page is blank.
  const clientRendered = text.length < 400 && scripts.length > 0;

  return { title, headings, text: text.slice(0, 20_000), links, scripts, forms, clientRendered };
}

/**
 * Open a page and describe it.
 *
 * ⛔ Redirects are followed BY HAND (`redirect: "manual"`) so every hop is
 * re-validated. Handing `redirect: "follow"` to fetch would validate the first
 * URL and dial whatever the server pointed us at afterwards — the exact
 * validate-one-thing-dial-another shape that produced this repo's SSRF.
 */
export async function openPage(
  raw: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: true; page: PageView } | { ok: false; reason: string }> {
  const first = checkBrowsableUrl(raw);
  if (!first.ok) return { ok: false, reason: first.reason };

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS;
  const started = Date.now();

  let current = first.url;
  let hops = 0;

  for (;;) {
    let res: Response;
    try {
      res = await doFetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        // ⛔ No Authorization, no Cookie, ever. The browser is a stranger.
        headers: { "User-Agent": "Loopcom-Workbench/1.0", Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      const why = String(e?.message ?? e);
      return {
        ok: false,
        reason: why.includes("aborted") || why.includes("timeout")
          ? `The page didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`
          : `Couldn't open that page: ${why.slice(0, 200)}`,
      };
    }

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hops >= MAX_REDIRECTS) {
        return { ok: false, reason: `Refused — that address redirected more than ${MAX_REDIRECTS} times.` };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, reason: "That page redirected somewhere the browser couldn't read." };
      }
      // ⛔ Re-validate EVERY hop against the allowlist.
      const check = checkBrowsableUrl(next.toString());
      if (!check.ok) {
        return { ok: false, reason: `That page redirected off Loopcom. ${check.reason}` };
      }
      current = check.url;
      hops += 1;
      continue;
    }

    // Read the body with a hard cap applied WHILE reading, so a huge response
    // can never be pulled into memory just to be trimmed afterwards.
    const contentType = res.headers.get("content-type") ?? "";
    let body = "";
    let bytes = 0;
    let truncated = false;
    const reader = (res.body as any)?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
        if (bytes > MAX_PAGE_BYTES) {
          truncated = true;
          body += decoder.decode(value, { stream: false });
          try { await reader.cancel(); } catch { /* already closing */ }
          break;
        }
        body += decoder.decode(value, { stream: true });
      }
    } else {
      body = await res.text();
      bytes = body.length;
      if (bytes > MAX_PAGE_BYTES) {
        body = body.slice(0, MAX_PAGE_BYTES);
        truncated = true;
      }
    }

    const parsed = parsePage(body);
    return {
      ok: true,
      page: {
        url: first.url.toString(),
        finalUrl: current.toString(),
        status: res.status,
        ok: res.ok,
        contentType,
        bytes,
        ms: Date.now() - started,
        truncated,
        ...parsed,
      },
    };
  }
}
