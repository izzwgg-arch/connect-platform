/**
 * panelClient.ts — TypeScript port of tools/connect-robot/connect-lib.js.
 *
 * Automates the Connect/VitalPBX PANEL (browser-replay over HTTP) for the
 * onboarding pipeline. This is deliberately the same approach as the proven
 * connect-robot tool: login → CSRF → urlencoded module POSTs, one isolated
 * cookie jar per session so parallel builds never collide on the per-session
 * "current tenant" cookie.
 *
 * Configuration (env — same credentials as /etc/connect-robot/credentials.env):
 *   ONBOARDING_PANEL_BASE_URL   e.g. https://m.connectcomunications.com
 *   ONBOARDING_ROBOT_USER/_PASS single robot account, and/or
 *   ONBOARDING_ROBOT_<n>_USER/_PASS (n = 1..15) for a parallel pool.
 *
 * NOTE ON PBX SAFETY: this module performs panel writes ONLY as part of the
 * owner-mandated onboarding flow, and only when ONBOARDING_PBX_AUTO_SETUP="on"
 * (checked by the orchestrator, not here). It does not touch the VitalPBX REST
 * API and does not weaken the VitalPbxClient read-only safeguard.
 */

// Present as a real browser — some panels refuse non-browser requests.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type RobotAccount = { id: string; user: string; pass: string };
export type PanelConfig = { baseUrl: string; accounts: RobotAccount[]; mainTenant: string };

/** Default main-tenant path hash (matches tools/connect-robot/provision-tenant.js). */
const MAIN_TENANT_DEFAULT = "2dc3974017c1bc65";

export function loadPanelConfig(env: NodeJS.ProcessEnv = process.env): PanelConfig | null {
  const baseUrl = String(env.ONBOARDING_PANEL_BASE_URL || env.CONNECT_PANEL_BASE_URL || "").replace(/\/+$/, "");
  const accounts: RobotAccount[] = [];
  if (env.ONBOARDING_ROBOT_USER && env.ONBOARDING_ROBOT_PASS) {
    accounts.push({ id: "robot", user: String(env.ONBOARDING_ROBOT_USER), pass: String(env.ONBOARDING_ROBOT_PASS) });
  }
  for (let i = 1; i <= 15; i++) {
    const u = env[`ONBOARDING_ROBOT_${i}_USER`];
    const p = env[`ONBOARDING_ROBOT_${i}_PASS`];
    if (u && p) accounts.push({ id: `robot-${i}`, user: String(u), pass: String(p) });
  }
  if (!baseUrl || !accounts.length) return null;
  return { baseUrl, accounts, mainTenant: String(env.ONBOARDING_PANEL_MAIN_TENANT || MAIN_TENANT_DEFAULT) };
}

const decodeEntities = (t: string) =>
  t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');

export class PanelStepError extends Error {
  step: string;
  constructor(step: string, msg: string) {
    super(`[${step}] ${msg}`);
    this.step = step;
  }
}

export type PanelResponse = { json: any; text: string };

const setCookies = (res: Response): string[] =>
  typeof (res.headers as any).getSetCookie === "function"
    ? (res.headers as any).getSetCookie()
    : res.headers.get("set-cookie")
      ? [res.headers.get("set-cookie") as string]
      : [];

export class PanelSession {
  base: string;
  account: RobotAccount;
  jar: Record<string, string> = {};
  csrf: string | null = null;
  homeTenant: string | null = null;

  constructor(baseUrl: string, account: RobotAccount) {
    this.base = baseUrl;
    this.account = account;
  }

  private merge(res: Response) {
    for (const c of setCookies(res)) {
      const p = c.split(";")[0];
      const i = p.indexOf("=");
      if (i > 0) this.jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
  }

  private cookieHeader() {
    return Object.entries(this.jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async fetchPanel(pathPart: string, opts: RequestInit = {}): Promise<Response> {
    (opts as any).redirect = "manual";
    opts.headers = Object.assign(
      {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: this.base + "/index.php",
        Origin: this.base,
        Cookie: this.cookieHeader(),
      },
      (opts.headers as any) || {},
    );
    const res = await fetch(this.base + pathPart, opts);
    this.merge(res);
    return res;
  }

  /** Sign in. Throws on bad credentials. */
  async login(): Promise<this> {
    await this.fetchPanel("/index.php", { method: "GET" }); // prime the sid cookie
    const body = new URLSearchParams({ userid: this.account.user, userpass: this.account.pass, loginForm: "1" });
    const res = await this.fetchPanel("/index.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body,
    });
    let notif: any = null;
    try {
      notif = JSON.parse(await res.text())?.notification || null;
    } catch {
      /* non-JSON login response is fine */
    }
    if (notif && notif.type === "error") {
      throw new Error(`[${this.account.id}] login rejected: ${notif.title} — ${notif.text}`);
    }
    if (!this.jar.sid) throw new Error(`[${this.account.id}] login failed: no session cookie`);
    this.homeTenant = this.jar.vpbx_tenant || null;
    return this;
  }

  /** Switch which tenant this session operates in — it's just a cookie. */
  setTenant(tenantPathHash: string): this {
    this.jar.vpbx_tenant = tenantPathHash;
    this.csrf = null;
    return this;
  }

  /** Security token needed by module saves. Loaded from a module's rendered form. */
  async ensureCsrf(moduleClass = "tenants"): Promise<string | null> {
    const body = new URLSearchParams({ class: moduleClass, method: "getContent", mode: "read" });
    const raw = await (
      await this.fetchPanel("/index.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
        body,
      })
    ).text();
    let src = raw;
    try {
      const j = JSON.parse(raw);
      if (j.html) src = j.html;
    } catch {
      /* raw HTML */
    }
    const m =
      src.match(/value=["']([a-f0-9]{20,64})["'][^>]{0,60}name=["']csfr_token["']/i) || // value before name (this panel)
      src.match(/name=["']csfr_token["'][^>]{0,120}value=["']([a-f0-9]{20,64})["']/i) || // name before value (fallback)
      src.match(/form-group-csfr_token["'][^>]{0,40}value=["']([a-f0-9]{20,64})["']/i);
    this.csrf = m ? m[1] : null;
    return this.csrf;
  }

  /** Generic urlencoded module POST → parsed panel JSON response. */
  async post(pairs: Array<[string, string | number | null | undefined]>): Promise<PanelResponse> {
    const body = new URLSearchParams();
    for (const [k, v] of pairs) body.append(k, v == null ? "" : String(v));
    const res = await this.fetchPanel("/index.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { json, text };
  }

  /** Multipart module POST (CSV import). */
  async postForm(fd: FormData): Promise<PanelResponse> {
    const res = await this.fetchPanel("/index.php", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest" },
      body: fd as any,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { json, text };
  }

  /** Load a rendered module form (returns its HTML). */
  async loadForm(cls: string, mode: string, data?: string | number | null): Promise<string> {
    const pairs: Array<[string, string]> = [
      ["class", cls],
      ["method", "getContent"],
      ["mode", mode],
    ];
    if (data != null) pairs.push(["data", String(data)]);
    const { text } = await this.post(pairs);
    try {
      const j = JSON.parse(text);
      if (j.html != null) return j.html;
    } catch {
      /* raw HTML */
    }
    return text;
  }
}

// ── Response validation (the panel hides errors inside "success" responses) ──

export function dialogErrors(r: PanelResponse): string | null {
  if (!(r.json && r.json.action === "dialog")) return null;
  const items = (r.json.html || "").match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
  const errs = items
    .map((x: string) => decodeEntities(x.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return errs.length ? errs.join(" | ") : "panel returned an error dialog";
}

export function assertSaved(step: string, r: PanelResponse): void {
  const dlg = dialogErrors(r);
  if (dlg) throw new PanelStepError(step, dlg);
  if (r.json && r.json.notification && r.json.notification.type === "error") {
    throw new PanelStepError(step, decodeEntities(r.json.notification.text || "error"));
  }
  if (!(r.json && r.json.state === "success")) {
    throw new PanelStepError(step, "unexpected response: " + r.text.slice(0, 200));
  }
}

export async function applyChanges(s: PanelSession, step: string): Promise<void> {
  const r = await s.post([
    ["call", "generateConfigurations"],
    ["data", "0"],
  ]);
  if (!(r.json && r.json.state === "success")) {
    throw new PanelStepError(step, "Apply Changes failed: " + r.text.slice(0, 200));
  }
}

/** Value of the first <option> whose text matches. */
export function findOption(html: string, matcher: (text: string, value: string) => boolean): string | null {
  for (const m of html.matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    if (matcher(decodeEntities(m[2]).trim(), m[1])) return m[1];
  }
  return null;
}

/**
 * Read a rendered form back as [name,value] pairs, exactly as a browser would
 * submit it: unchecked checkboxes are OMITTED, multi-selects contribute one
 * pair per selected option.
 */
export function parseFormPairs(html: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const n = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    if (!n || n.includes("{{")) continue;
    const type = ((tag.match(/type=["']([^"']+)["']/i) || [])[1] || "text").toLowerCase();
    const val = (tag.match(/value=["']([^"']*)["']/i) || [])[1] || "";
    if (type === "checkbox" || type === "radio") {
      if (/\bchecked\b/i.test(tag)) pairs.push([n, val || "1"]);
    } else pairs.push([n, val]);
  }
  for (const m of html.matchAll(/<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    const n = m[1];
    if (n.includes("{{")) continue;
    const isMulti = /\bmultiple\b/i.test(m[0]);
    let any = false;
    for (const o of m[2].matchAll(/<option\b[^>]*>/gi)) {
      if (/\bselected\b/i.test(o[0])) {
        pairs.push([n, (o[0].match(/value=["']([^"']*)["']/i) || [])[1] || ""]);
        any = true;
        if (!isMulti) break;
      }
    }
    if (!any && !isMulti) pairs.push([n, (m[2].match(/<option[^>]*value=["']([^"']*)["']/i) || [])[1] || ""]);
  }
  return pairs;
}

export const upsertPair = (pairs: Array<[string, string]>, k: string, v: string): void => {
  const i = pairs.findIndex(([n]) => n === k);
  if (i >= 0) pairs[i] = [k, v];
  else pairs.push([k, v]);
};

export const dropPairs = (pairs: Array<[string, string]>, ...keys: string[]): Array<[string, string]> =>
  pairs.filter(([n]) => !keys.includes(n));

export { decodeEntities };
