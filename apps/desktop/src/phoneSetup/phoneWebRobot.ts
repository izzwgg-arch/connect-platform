/**
 * The phone WEB ROBOT — a real (caged) browser doing what an Action URI cannot.
 *
 * ⛔⛔ WHY THIS EXISTS (round 23, 2026-09-17, Izzy: "a robot and a browser hidden
 * inside the wizard... The only thing the customer will have to do is factory reset
 * the phones"). A live prototype logged into a factory-reset Yealink T42S's own web
 * page — the page whose login POST the phone's own JavaScript encrypts, the page
 * that sometimes forces a password change mid-flow, the page whose reset control is
 * a button with no documented URL at all — overwrote the PREVIOUS provider's
 * `AutoProvisionServerURL` with the tenant's Loopcom folder, verified the save by
 * re-reading the field, triggered an immediate re-provision, and the phone
 * registered in 65 seconds. None of that is expressible as one HTTP verb the way
 * `yealink.ts`'s Action URI adapter is — a real page needs a real (but caged)
 * browser. This module is that cage.
 *
 * ⛔⛔ THE FENCES, enforced HERE and independent of any caller (capability.ts
 * applies its own address/rate fences too — this module does not trust that it was
 * the only door):
 *   • the target must be a private LAN address (`canonicalPrivateIpv4`);
 *   • the browser context is caged to that ONE origin — see `buildOriginGuard`,
 *     wired into Playwright's request routing by `playwrightRobotBrowser.ts`. A
 *     request to any other host is aborted before it leaves the process;
 *   • any string this module TYPES that contains `://` must pass
 *     `isLoopcomProvisioningUrl` first, or the op refuses `fenced_url_refused`
 *     without typing anything — this applies to the deterministic `web_provision`
 *     script and to the free-form `web_act` fill action alike;
 *   • credentials are the vendor default, a `credentialRef` resolved through the
 *     same vault every other phone op uses, or a password THIS PROCESS minted —
 *     never a literal typed into a password field by `web_act`, and never logged;
 *   • a login attempt spends the SAME per-phone lockout budget
 *     (`MAX_LOGIN_FAILURES_PER_PHONE` in capability.ts) as every other login this
 *     app makes — a page that never offered a login form is not a failed login;
 *   • no file input is ever touched — such elements are dropped from every
 *     snapshot before a `ref` can be issued for one;
 *   • every op is capped at `MAX_PAGE_ACTIONS_PER_OP` page actions and
 *     `MAX_MS_PER_OP` milliseconds — a page that will not resolve cannot hang the
 *     wizard, and a runaway improvisation loop cannot hammer the phone forever.
 *
 * ⛔ Pure by injection, like every other file in this directory: the browser itself
 * (`RobotBrowser`) arrives as an option, so every rule here is provable without a
 * handset or a real Chrome process.
 */

import { randomBytes } from "node:crypto";
import {
  canonicalPrivateIpv4, identityFromBanner, isLoopcomProvisioningUrl, YEALINK_DEFAULT_CREDENTIALS,
  type YealinkCredentials,
} from "./yealink";
import { normalizeMac } from "./pnp";
import { GRANDSTREAM_DEFAULT_CREDENTIALS, gsProbe, gsProvision, gsReset } from "./grandstreamWebRobot";
import type { HttpTransport } from "./yealink";

/**
 * Which robot family a request names. ⛔ The VENDOR decides, never the page: the
 * Yealink family drives a web page, the Grandstream family (2026-09-18) talks to the
 * phone's own cgi surface. A vendor with no family runs the Yealink page road, which
 * honestly answers `family: "unknown"` when the page is not a Yealink login.
 */
export function robotFamilyFor(vendor: unknown): "yealink" | "grandstream" {
  return /grandstream/i.test(String(vendor ?? "")) ? "grandstream" : "yealink";
}

/* ── the shapes a browser must offer, and nothing more ─────────────────────── */

/** One element as the underlying page actually described it — never sanitized yet. */
export type RawElement = {
  tag: string;
  type: string;
  name: string;
  id: string;
  label: string;
  value: string;
  options?: string[];
};

export type RawRead = { url: string; title: string; text: string; elements: RawElement[] };

/**
 * ⛔⛔ Round-23 fence HARDENING (2026-09-17, review). The first cut keyed the URL
 * fence on "://" alone — and a bare `evil.example/x` typed into the server field
 * would have sailed straight past it, because Yealink prepends a default scheme to
 * a schemeless server value. So: anything HOST-SHAPED counts as a server target,
 * conservative on purpose. Refusing an odd legitimate string costs one give_up;
 * typing a stranger's host into a provisioning field costs a phone that downloads
 * its SIP credentials from that stranger.
 */
export function looksLikeServerTarget(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (t.includes("://")) return true;
  // A bare IPv4, with or without a port/path.
  if (/^\d{1,3}(\.\d{1,3}){3}([:/].*)?$/.test(t)) return true;
  // A bare hostname (dot-separated labels ending in letters), with or without a port/path.
  if (/^([a-z0-9_-]+\.)+[a-z]{2,}([:/].*)?$/.test(t)) return true;
  return false;
}

/** Field names/ids/labels that make a fill provisioning-sensitive whatever its text says. */
export const SERVER_FIELD_RE = /(url|server|provision|autop|dhcp|option|tftp)/i;

/**
 * One page, caged to one phone's origin. `goto` takes a PATH — never a URL — so a
 * page cannot be steered anywhere but the origin `RobotBrowser.openPage` opened.
 */
export interface RobotPage {
  goto(path: string): Promise<void>;
  read(): Promise<RawRead>;
  /**
   * `index` addresses an element by its position in the MOST RECENT `read()`'s
   * (unsanitized) element list — never a selector string, so nothing this module
   * types can become a selector-injection surface.
   */
  fill(index: number, text: string): Promise<void>;
  /** Clicking may navigate and/or raise a JS confirm dialog; the page auto-accepts it. */
  click(index: number): Promise<void>;
  close(): Promise<void>;
}

export interface RobotBrowser {
  /** Open a page caged to exactly this phone's origin. Null when nothing answered. */
  openPage(ip: string): Promise<RobotPage | null>;
}

/**
 * The pure decision behind the origin cage: is this request allowed to leave the
 * browser context?  `playwrightRobotBrowser.ts` wires this into `context.route` —
 * kept here, and exported, so the decision itself is unit-testable with no
 * Playwright process at all.
 */
export function buildOriginGuard(ip: string): (url: string) => boolean {
  const host = canonicalPrivateIpv4(ip);
  return (url: string): boolean => {
    if (!host) return false;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    return parsed.hostname === host;
  };
}

/* ── the sanitized snapshot contract (shared with the server/driver side) ──── */

export type SanitizedElement = {
  ref: string; tag: string; type: string; name: string; id: string; label: string; value: string; options?: string[];
};

export type RobotSnapshot = { url: string; title: string; text: string; elements: SanitizedElement[] };

const MAX_SNAPSHOT_TEXT = 1200;
const MAX_SNAPSHOT_ELEMENTS = 80;

function randomRef(): string {
  return randomBytes(4).toString("hex");
}

function collapseText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SNAPSHOT_TEXT);
}

/** ⛔ No file input is ever visible to a ref-based caller — see the header. */
function isFileInput(e: RawElement): boolean {
  return String(e.type || "").toLowerCase() === "file";
}
function isSecretField(e: RawElement): boolean {
  const type = String(e.type || "").toLowerCase();
  return type === "password" || type === "hidden";
}

function sanitizeElement(e: RawElement): SanitizedElement {
  return {
    ref: randomRef(), tag: e.tag, type: e.type, name: e.name, id: e.id, label: e.label,
    value: isSecretField(e) ? "" : String(e.value ?? "").slice(0, 300),
    ...(e.options ? { options: e.options } : {}),
  };
}

/**
 * Turn a raw read into the shared contract. Returns the visible (non-file)
 * elements alongside their sanitized twins so a caller can map a freshly minted
 * `ref` back to the index a `RobotPage.fill`/`click` needs.
 */
function sanitizeRead(raw: RawRead): { snapshot: RobotSnapshot; visible: RawElement[] } {
  const visible = raw.elements.filter((e) => !isFileInput(e)).slice(0, MAX_SNAPSHOT_ELEMENTS);
  return { snapshot: { url: raw.url, title: raw.title, text: collapseText(raw.text), elements: visible.map(sanitizeElement) }, visible };
}

/* ── the budget: a page that will not resolve cannot hang the wizard ───────── */

export const MAX_PAGE_ACTIONS_PER_OP = 25;
export const MAX_MS_PER_OP = 90_000;

export class BudgetExceededError extends Error {}

class Budget {
  private actions = 0;
  private readonly startedAt: number;
  constructor(private readonly now: () => number) { this.startedAt = now(); }
  private check(): void {
    if (this.actions > MAX_PAGE_ACTIONS_PER_OP) throw new BudgetExceededError("actions");
    if (this.now() - this.startedAt > MAX_MS_PER_OP) throw new BudgetExceededError("time");
  }
  /** Every `RobotPage` call goes through this — one call, one unit, checked before AND after. */
  async spend<T>(fn: () => Promise<T>): Promise<T> {
    this.actions += 1;
    this.check();
    const result = await fn();
    this.check();
    return result;
  }
}

/* ── crypto-random passwords this process mints, never a caller-chosen value ── */

// ⛔ No ambiguous glyphs (0/O, 1/l/I) — a generated password nobody ever reads off
// a screen still has to survive being retyped once during support, and a phone's
// own web form may reject characters outside this set.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generatePassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

/* ── what this device's login page looks like — "v86" per the round-23 handoff ── */

// ⛔ These are the REAL field ids the live prototype proved against a factory-reset
// T42S (fw 66.86.0.15): `#idUsername`, `#idPassword`, the save control `#btn_confirm1`
// on the autop page and the trigger `#btnAutopNow`. Never guessed, never widened.
const LOGIN_USERNAME_ID = "idUsername";
const LOGIN_PASSWORD_ID = "idPassword";
const AUTOP_URL_FIELD = "AutoProvisionServerURL";
const AUTOP_USER_FIELD = "AutoProvisionUser";
const AUTOP_PASSWORD_FIELD = "AutoProvisionPassword";
const AUTOP_SAVE_ID = "btn_confirm1";
const AUTOP_TRIGGER_ID = "btnAutopNow";

export const LOGIN_PATH = "/servlet?m=mod_listener&p=login&q=loginForm&jumpto=status";
export const AUTOP_PATH = "/servlet?m=mod_data&p=settings-autop&q=load";
/** Settings → Upgrade — where the v86 web UI's "Reset to Factory Setting" button lives. */
export const RESET_PATH = "/servlet?m=mod_data&p=settings-upgrade&q=load";

type Screen = "login" | "status" | "autop" | "forced_password_change" | "reset_upgrade" | "unknown";

function idOrName(e: RawElement): string { return String(e.id || e.name || ""); }
function fieldIndex(elements: RawElement[], idOrNameValue: string): number {
  return elements.findIndex((e) => idOrName(e) === idOrNameValue);
}
function firstSubmitIndex(elements: RawElement[]): number {
  return elements.findIndex((e) => String(e.type || "").toLowerCase() === "submit");
}
function passwordTypeIndices(elements: RawElement[]): number[] {
  return elements.reduce<number[]>((acc, e, i) => { if (String(e.type || "").toLowerCase() === "password") acc.push(i); return acc; }, []);
}

/**
 * ⛔ Classified defensively from what the page actually offers — never a URL
 * pattern, which a hostile or unfamiliar firmware could spoof, and never assumed.
 * A page this does not recognise is `unknown`, honestly, every time.
 */
function classifyScreen(read: RawRead): Screen {
  if (fieldIndex(read.elements, AUTOP_URL_FIELD) !== -1) return "autop";
  if (read.elements.some((e) => /reset to factory/i.test(`${e.label} ${e.name} ${e.value}`))) return "reset_upgrade";
  const hasUsername = fieldIndex(read.elements, LOGIN_USERNAME_ID) !== -1;
  const passwordCount = passwordTypeIndices(read.elements).length;
  if (hasUsername && passwordCount >= 1) return "login";
  if (!hasUsername && passwordCount >= 2) return "forced_password_change";
  if (/Firmware Version/i.test(read.text) && /MAC Address/i.test(read.text)) return "status";
  return "unknown";
}

function parseStatusText(text: string): { model: string | null; firmware: string | null; serial: string | null; mac: string | null } {
  // ⛔ ONE naming rule, shared with every other identification path in this app —
  // see yealink.ts's own comment on why two parsers is how one phone gets two answers.
  const id = identityFromBanner(text);
  const mac = /MAC Address\D*([0-9A-Fa-f]{2}(?:[:.-]?[0-9A-Fa-f]{2}){5})/i.exec(text)?.[1] ?? null;
  const serial = /Machine ID\D*([A-Za-z0-9]{4,32})/i.exec(text)?.[1] ?? null;
  return { model: id.model, firmware: id.firmware, serial, mac: normalizeMac(mac) };
}

/* ── credentials: default, a vault reference, or one this process mints ────── */

export type ResolveCredential = (ref: string) => Promise<YealinkCredentials | null>;
export type StoreCredential = (creds: YealinkCredentials) => Promise<string>;
export type LoginOutcomeNote = { ok: boolean; reason?: string };

/**
 * A `web_act` improvisation's open page, kept alive ACROSS multiple `web_act`
 * calls — see `WEB_ACT_SESSION_IDLE_MS` below for why. Never touched by
 * probe/provision/reset directly; they only ever `evictWebActSession` one before
 * opening their own page, so exactly one thing is ever driving a given phone's
 * page at a time.
 */
export type WebActSession = {
  page: RobotPage;
  refs: Map<string, number>;
  visible: RawElement[];
  lastSnapshot: RobotSnapshot;
  lastUsedAt: number;
};
export type WebActSessionStore = Map<string, WebActSession>;

export type RobotDeps = {
  browser: RobotBrowser;
  /** The plain HTTP transport, for the cgi family (Grandstream). */
  http: HttpTransport;
  resolveCredential: ResolveCredential;
  /** The SAME per-phone lockout gate every other login in this app spends. */
  loginBlocked: (ip: string) => boolean;
  noteLogin: (ip: string, outcome: LoginOutcomeNote) => void;
  /** Mint a new vault entry for a password THIS PROCESS generated. */
  storeCredential: StoreCredential;
  now: () => number;
  log: (line: string) => void;
  /**
   * `web_act`'s open pages, one per phone address, created once per capability
   * instance and handed to every call — see the header on `WebActSession`.
   */
  webActSessions: WebActSessionStore;
};

/**
 * ⛔⛔ WHY A `web_act` PAGE OUTLIVES ONE CALL. The improvisation loop is driven by
 * an AI agent making SEPARATE tool calls — it reads a page in one call, reasons
 * about what it saw, and only THEN issues a second call with `fill`/`click`
 * actions that reference the `ref`s that first call handed back. If this module
 * closed the page at the end of every call, those `ref`s would already be
 * meaningless by the time the second call arrived, and the loop could never
 * actually improvise anything past a single read. So the page (and its most
 * recent refs) is kept OPEN and reused across calls for the SAME phone address,
 * for as long as the loop keeps coming back — and closed the moment it does not,
 * via this idle timeout, or the moment ANY other op targets the same phone (see
 * `evictWebActSession`, called by probe/provision/reset before they open their
 * own page — exactly one thing drives a phone's page at a time).
 */
export const WEB_ACT_SESSION_IDLE_MS = 2 * 60_000;

/** Close and forget one phone's `web_act` session, if it has one. Safe to call when it does not. */
export async function evictWebActSession(store: WebActSessionStore, ip: string): Promise<void> {
  const session = store.get(ip);
  if (!session) return;
  store.delete(ip);
  await session.page.close().catch(() => undefined);
}

type CredsResolved = { ok: true; creds: YealinkCredentials; usedDefault: boolean } | { ok: false; refused: "credential_not_available" };

async function resolveCreds(deps: RobotDeps, credentialRef: string | null | undefined, fallback: YealinkCredentials = YEALINK_DEFAULT_CREDENTIALS): Promise<CredsResolved> {
  if (!credentialRef) return { ok: true, creds: fallback, usedDefault: true };
  const creds = await deps.resolveCredential(credentialRef);
  // ⛔ A reference that resolves to nothing is a refusal, never a silent
  // unauthenticated attempt — see capability.ts's identical rule for every other op.
  if (!creds) return { ok: false, refused: "credential_not_available" };
  return { ok: true, creds, usedDefault: false };
}

/* ── shared login flow, used by probe / provision / reset alike ────────────── */

type LoginResult =
  | { ok: true; forcedPasswordChange: boolean; usedCreds: YealinkCredentials; credentialRefCreated?: string }
  | { ok: false; refused: string; snapshot?: RobotSnapshot };

/**
 * Fill and submit the login form already on-screen, and handle the two honest
 * outcomes a real Yealink v86 page can hand back: straight through to status, or a
 * forced password change first. Anything else is `unknown_screen` or `login_failed`
 * — never guessed, and a wrong password always spends the shared lockout budget.
 */
async function loginIfNeeded(
  deps: RobotDeps, page: RobotPage, budget: Budget, ip: string, creds: YealinkCredentials, setPassword: boolean,
): Promise<LoginResult> {
  const before = await budget.spend(() => page.read());
  const userIdx = fieldIndex(before.elements, LOGIN_USERNAME_ID);
  const passIdx = fieldIndex(before.elements, LOGIN_PASSWORD_ID);
  const submitIdx = firstSubmitIndex(before.elements);
  if (userIdx === -1 || passIdx === -1 || submitIdx === -1) {
    return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(before).snapshot };
  }
  await budget.spend(() => page.fill(userIdx, creds.username));
  await budget.spend(() => page.fill(passIdx, creds.password));
  await budget.spend(() => page.click(submitIdx));
  const after = await budget.spend(() => page.read());
  const screen = classifyScreen(after);

  if (screen === "status" || /p=status/i.test(after.url)) {
    deps.noteLogin(ip, { ok: true });
    return { ok: true, forcedPasswordChange: false, usedCreds: creds };
  }

  if (screen === "forced_password_change") {
    if (!setPassword) return { ok: false, refused: "password_change_required", snapshot: sanitizeRead(after).snapshot };
    const pwIndices = passwordTypeIndices(after.elements);
    const changeSubmit = firstSubmitIndex(after.elements);
    if (pwIndices.length < 2 || changeSubmit === -1) {
      return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(after).snapshot };
    }
    const generated = generatePassword();
    await budget.spend(() => page.fill(pwIndices[0], generated));
    await budget.spend(() => page.fill(pwIndices[1], generated));
    await budget.spend(() => page.click(changeSubmit));
    const after2 = await budget.spend(() => page.read());
    const screen2 = classifyScreen(after2);
    if (screen2 !== "status" && !/p=status/i.test(after2.url)) {
      return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(after2).snapshot };
    }
    deps.noteLogin(ip, { ok: true });
    const usedCreds: YealinkCredentials = { username: creds.username, password: generated };
    // ⛔ Stored via the SAME vault every other credential in this app lives in —
    // never logged, never returned as a value, only as the reference.
    const credentialRefCreated = await deps.storeCredential(usedCreds);
    return { ok: true, forcedPasswordChange: true, usedCreds, credentialRefCreated };
  }

  // Still on a login-shaped page (or somewhere unreadable): the phone refused the
  // password. This is the ONE outcome that spends the shared lockout budget.
  deps.noteLogin(ip, { ok: false, reason: "locked" });
  return { ok: false, refused: "login_failed", snapshot: sanitizeRead(after).snapshot };
}

/* ── op 1: web_probe ─────────────────────────────────────────────────────── */

export type WebProbeRequest = { ip: string; credentialRef?: string | null; vendor?: string | null };
export type WebProbeResult =
  | {
      ok: true; op: "web_probe"; family: "yealink_v86" | "grandstream_cgi" | "unknown"; loginWorked: boolean; usedDefault: boolean;
      forcedPasswordChange: boolean; model: string | null; firmware: string | null; serial: string | null;
      provisioningUrl: string | null; snapshot?: RobotSnapshot;
    }
  | { ok: false; refused: string; snapshot?: RobotSnapshot };

export async function runWebProbe(deps: RobotDeps, req: WebProbeRequest): Promise<WebProbeResult> {
  const ip = canonicalPrivateIpv4(req.ip);
  if (!ip) return { ok: false, refused: "not_a_private_address" };
  if (robotFamilyFor(req.vendor) === "grandstream") {
    const gcr = await resolveCreds(deps, req.credentialRef, GRANDSTREAM_DEFAULT_CREDENTIALS);
    if (!gcr.ok) return gcr;
    await evictWebActSession(deps.webActSessions, ip);
    return gsProbe(deps, { ip, creds: gcr.creds, usedDefault: gcr.usedDefault });
  }
  const cr = await resolveCreds(deps, req.credentialRef);
  if (!cr.ok) return cr;
  // ⛔ Exactly one thing drives a phone's page at a time — a lingering `web_act`
  // session for THIS phone is closed before this deterministic op opens its own.
  await evictWebActSession(deps.webActSessions, ip);
  const page = await deps.browser.openPage(ip);
  if (!page) return { ok: false, refused: "unreachable" };
  const budget = new Budget(deps.now);
  try {
    await budget.spend(() => page.goto(LOGIN_PATH));
    const initial = await budget.spend(() => page.read());
    if (classifyScreen(initial) !== "login") {
      await page.close();
      return {
        ok: true, op: "web_probe", family: "unknown", loginWorked: false, usedDefault: cr.usedDefault,
        forcedPasswordChange: false, model: null, firmware: null, serial: null, provisioningUrl: null,
        snapshot: sanitizeRead(initial).snapshot,
      };
    }
    // ⛔ A page that never offered a login form is not a failed login — so the
    // shared lockout gate is only consulted once we KNOW there is one to try.
    if (deps.loginBlocked(ip)) {
      await page.close();
      return {
        ok: true, op: "web_probe", family: "yealink_v86", loginWorked: false, usedDefault: cr.usedDefault,
        forcedPasswordChange: false, model: null, firmware: null, serial: null, provisioningUrl: null,
      };
    }
    const login = await loginIfNeeded(deps, page, budget, ip, cr.creds, false);
    if (!login.ok) {
      await page.close();
      return {
        ok: true, op: "web_probe", family: "yealink_v86", loginWorked: false, usedDefault: cr.usedDefault,
        forcedPasswordChange: login.refused === "password_change_required", model: null, firmware: null, serial: null,
        provisioningUrl: null, snapshot: login.snapshot,
      };
    }
    const statusRead = await budget.spend(() => page.read());
    const status = parseStatusText(statusRead.text);
    await budget.spend(() => page.goto(AUTOP_PATH));
    const autopRead = await budget.spend(() => page.read());
    const urlIdx = fieldIndex(autopRead.elements, AUTOP_URL_FIELD);
    await page.close();
    return {
      ok: true, op: "web_probe", family: "yealink_v86", loginWorked: true, usedDefault: cr.usedDefault,
      forcedPasswordChange: login.forcedPasswordChange, model: status.model, firmware: status.firmware, serial: status.serial,
      provisioningUrl: urlIdx === -1 ? null : (autopRead.elements[urlIdx].value || null),
    };
  } catch (err) {
    await page.close().catch(() => undefined);
    if (err instanceof BudgetExceededError) return { ok: false, refused: "budget_exhausted" };
    throw err;
  }
}

/* ── op 2: web_provision ─────────────────────────────────────────────────── */

export type WebProvisionRequest = {
  ip: string; mac: string; url: string; credentialRef?: string | null; setPassword?: boolean; vendor?: string | null;
};
export type WebProvisionResult =
  | { ok: true; op: "web_provision"; provisioned: true; urlVerified: true; credentialRefCreated?: string }
  | { ok: false; refused: string; snapshot?: RobotSnapshot };

export async function runWebProvision(deps: RobotDeps, req: WebProvisionRequest): Promise<WebProvisionResult> {
  const ip = canonicalPrivateIpv4(req.ip);
  if (!ip) return { ok: false, refused: "not_a_private_address" };
  // ⛔⛔ THE URL FENCE, before a page is even opened, before anything is typed.
  if (!isLoopcomProvisioningUrl(req.url)) return { ok: false, refused: "fenced_url_refused" };
  const targetMac = normalizeMac(req.mac);
  if (!targetMac) return { ok: false, refused: "bad_hardware_address" };
  if (robotFamilyFor(req.vendor) === "grandstream") {
    const gcr = await resolveCreds(deps, req.credentialRef, GRANDSTREAM_DEFAULT_CREDENTIALS);
    if (!gcr.ok) return gcr;
    await evictWebActSession(deps.webActSessions, ip);
    return gsProvision(deps, { ip, mac: targetMac, url: req.url, creds: gcr.creds });
  }
  const cr = await resolveCreds(deps, req.credentialRef);
  if (!cr.ok) return cr;
  if (deps.loginBlocked(ip)) return { ok: false, refused: "too_many_login_attempts" };
  await evictWebActSession(deps.webActSessions, ip);
  const page = await deps.browser.openPage(ip);
  if (!page) return { ok: false, refused: "unreachable" };
  const budget = new Budget(deps.now);
  try {
    await budget.spend(() => page.goto(LOGIN_PATH));
    const initial = await budget.spend(() => page.read());
    if (classifyScreen(initial) !== "login") {
      await page.close();
      return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(initial).snapshot };
    }
    const login = await loginIfNeeded(deps, page, budget, ip, cr.creds, Boolean(req.setPassword));
    if (!login.ok) { await page.close(); return login; }

    // ⛔⛔ THE WRONG-DEVICE CHECK, before anything is written. Read what the PHONE
    // says its own MAC is; never provision a phone other than the one the wizard
    // means, no matter what the caller believes it is talking to.
    const statusRead = await budget.spend(() => page.read());
    const status = parseStatusText(statusRead.text);
    if (status.mac && status.mac !== targetMac) { await page.close(); return { ok: false, refused: "wrong_device" }; }

    await budget.spend(() => page.goto(AUTOP_PATH));
    const autopRead = await budget.spend(() => page.read());
    const urlIdx = fieldIndex(autopRead.elements, AUTOP_URL_FIELD);
    const userIdx = fieldIndex(autopRead.elements, AUTOP_USER_FIELD);
    const passIdx = fieldIndex(autopRead.elements, AUTOP_PASSWORD_FIELD);
    const saveIdx = fieldIndex(autopRead.elements, AUTOP_SAVE_ID);
    if (urlIdx === -1 || saveIdx === -1) {
      await page.close();
      return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(autopRead).snapshot };
    }
    await budget.spend(() => page.fill(urlIdx, req.url));
    if (userIdx !== -1) await budget.spend(() => page.fill(userIdx, ""));
    if (passIdx !== -1) await budget.spend(() => page.fill(passIdx, ""));
    await budget.spend(() => page.click(saveIdx));

    // ⛔⛔ VERIFY THE SAVE BY RE-READING. An accepted click is not a save — the
    // prototype's own discipline (round 23).
    const verify = await budget.spend(() => page.read());
    const verifyIdx = fieldIndex(verify.elements, AUTOP_URL_FIELD);
    if (verifyIdx === -1 || String(verify.elements[verifyIdx].value ?? "") !== req.url) {
      await page.close();
      return { ok: false, refused: "save_not_verified", snapshot: sanitizeRead(verify).snapshot };
    }

    // ⛔ The proven live step: trigger an immediate re-provision. `RobotPage.click`
    // auto-accepts the "Do you want to autoprovision now?" confirm dialog.
    const triggerIdx = fieldIndex(verify.elements, AUTOP_TRIGGER_ID);
    if (triggerIdx === -1) { await page.close(); return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(verify).snapshot }; }
    await budget.spend(() => page.click(triggerIdx));
    await page.close();
    return {
      ok: true, op: "web_provision", provisioned: true, urlVerified: true,
      ...(login.credentialRefCreated ? { credentialRefCreated: login.credentialRefCreated } : {}),
    };
  } catch (err) {
    await page.close().catch(() => undefined);
    if (err instanceof BudgetExceededError) return { ok: false, refused: "budget_exhausted" };
    throw err;
  }
}

/* ── op 3: web_reset ─────────────────────────────────────────────────────── */

export type WebResetRequest = { ip: string; credentialRef?: string | null; vendor?: string | null };
export type WebResetResult =
  | { ok: true; op: "web_reset"; sent: true }
  | { ok: false; refused: string; snapshot?: RobotSnapshot };

export async function runWebReset(deps: RobotDeps, req: WebResetRequest): Promise<WebResetResult> {
  const ip = canonicalPrivateIpv4(req.ip);
  if (!ip) return { ok: false, refused: "not_a_private_address" };
  if (robotFamilyFor(req.vendor) === "grandstream") {
    const gcr = await resolveCreds(deps, req.credentialRef, GRANDSTREAM_DEFAULT_CREDENTIALS);
    if (!gcr.ok) return gcr;
    await evictWebActSession(deps.webActSessions, ip);
    return gsReset(deps, { ip, creds: gcr.creds });
  }
  const cr = await resolveCreds(deps, req.credentialRef);
  if (!cr.ok) return cr;
  if (deps.loginBlocked(ip)) return { ok: false, refused: "too_many_login_attempts" };
  await evictWebActSession(deps.webActSessions, ip);
  const page = await deps.browser.openPage(ip);
  if (!page) return { ok: false, refused: "unreachable" };
  const budget = new Budget(deps.now);
  try {
    await budget.spend(() => page.goto(LOGIN_PATH));
    const initial = await budget.spend(() => page.read());
    if (classifyScreen(initial) !== "login") {
      await page.close();
      return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(initial).snapshot };
    }
    // ⛔ web_reset never mints a password — a forced password-change page here is
    // reported honestly, never improvised past.
    const login = await loginIfNeeded(deps, page, budget, ip, cr.creds, false);
    if (!login.ok) { await page.close(); return login; }

    await budget.spend(() => page.goto(RESET_PATH));
    const upgrade = await budget.spend(() => page.read());
    // ⛔ Discovered defensively, like round 22's release-form link — never a fixed
    // id, because the button's markup is not documented anywhere we can cite.
    const resetIdx = upgrade.elements.findIndex((e) => /reset to factory/i.test(`${e.label} ${e.name} ${e.value}`));
    if (resetIdx === -1) {
      await page.close();
      return { ok: false, refused: "unknown_screen", snapshot: sanitizeRead(upgrade).snapshot };
    }
    // ⛔⛔ NEVER AUTO-INVOKED BY THE ROBOT ITSELF. Reaching this line already
    // required the caller to have dispatched `web_reset` explicitly — the same
    // reset-first-is-consent rule as every other reset path in this app.
    await budget.spend(() => page.click(resetIdx)); // auto-accepts the confirm dialog
    await page.close();
    // ⛔ `sent` is deliberately the only claim, mirroring factory_reset's own
    // honesty: a phone told to wipe itself stops answering because it is doing
    // what it was told, so there is no "confirmed" to give.
    return { ok: true, op: "web_reset", sent: true };
  } catch (err) {
    await page.close().catch(() => undefined);
    if (err instanceof BudgetExceededError) return { ok: false, refused: "budget_exhausted" };
    throw err;
  }
}

/* ── op 4: web_act — the agent-advised improvisation loop ───────────────────── */

export type RobotActionInput =
  | { kind: "goto"; path: string }
  | { kind: "fill"; ref: string; text: string }
  | { kind: "click"; ref: string }
  | { kind: "read" };

export type WebActRequest = {
  ip: string; actions: RobotActionInput[]; credentialRef?: string | null;
  /** The ONE folder a fill may ever aim a phone at. Absent = no URL/host-shaped text may be typed at all. */
  allowedUrl?: string | null;
};
export type WebActOutcome = { ok: true; kind: RobotActionInput["kind"] } | { ok: false; kind: RobotActionInput["kind"]; refused: string };
export type WebActResult =
  | { ok: true; op: "web_act"; snapshot: RobotSnapshot; outcomes: WebActOutcome[] }
  | { ok: false; refused: string; snapshot?: RobotSnapshot };

const EMPTY_SNAPSHOT: RobotSnapshot = { url: "", title: "", text: "", elements: [] };

export async function runWebAct(deps: RobotDeps, req: WebActRequest): Promise<WebActResult> {
  const ip = canonicalPrivateIpv4(req.ip);
  if (!ip) return { ok: false, refused: "not_a_private_address" };
  if (!Array.isArray(req.actions) || req.actions.length === 0) return { ok: false, refused: "no_actions" };
  const cr = await resolveCreds(deps, req.credentialRef);
  if (!cr.ok) return cr;
  if (deps.loginBlocked(ip)) return { ok: false, refused: "too_many_login_attempts" };

  // ⛔⛔ REUSE THE OPEN SESSION IF THERE IS ONE — see `WebActSession`'s header for
  // why. An idle session (the loop has not come back for a while) is discarded
  // rather than trusted; a fresh page means fresh refs, which is the same honest
  // "re-plan from what IS" a stale ref already enforces.
  let session = deps.webActSessions.get(ip);
  if (session && deps.now() - session.lastUsedAt > WEB_ACT_SESSION_IDLE_MS) {
    await evictWebActSession(deps.webActSessions, ip);
    session = undefined;
  }
  let page: RobotPage;
  let refs: Map<string, number>;
  let visible: RawElement[];
  let lastSnapshot: RobotSnapshot;
  if (session) {
    ({ page, refs, visible, lastSnapshot } = session);
  } else {
    const opened = await deps.browser.openPage(ip);
    if (!opened) return { ok: false, refused: "unreachable" };
    page = opened;
    refs = new Map();
    visible = [];
    lastSnapshot = EMPTY_SNAPSHOT;
  }
  const budget = new Budget(deps.now);
  const outcomes: WebActOutcome[] = [];
  const clearRefs = () => { refs = new Map(); visible = []; };
  let lastActionWasRead = false;

  // ⛔ A hard outer bound on the array itself — independent of the budget, which
  // only counts actions that actually touch the page. Without this, an array of
  // millions of already-refused entries (a stale ref, say) would still cost real
  // CPU/memory in THIS process even though it never reaches the phone.
  const MAX_ARRAY_ENTRIES = MAX_PAGE_ACTIONS_PER_OP * 8;
  try {
    for (const action of req.actions.slice(0, MAX_ARRAY_ENTRIES)) {
      lastActionWasRead = false;
      if (action.kind === "goto") {
        // ⛔ PATH ONLY. A full URL (anything with `://`) never reaches `page.goto`.
        if (typeof action.path !== "string" || action.path.includes("://")) {
          outcomes.push({ ok: false, kind: "goto", refused: "path_only" });
          continue;
        }
        await budget.spend(() => page.goto(action.path));
        clearRefs();
        outcomes.push({ ok: true, kind: "goto" });
      } else if (action.kind === "read") {
        const raw = await budget.spend(() => page.read());
        const { snapshot, visible: v } = sanitizeRead(raw);
        visible = v;
        refs = new Map(snapshot.elements.map((el, i) => [el.ref, i]));
        lastSnapshot = snapshot;
        lastActionWasRead = true;
        outcomes.push({ ok: true, kind: "read" });
      } else if (action.kind === "fill") {
        const idx = refs.get(action.ref);
        if (idx === undefined) { outcomes.push({ ok: false, kind: "fill", refused: "stale_ref" }); clearRefs(); continue; }
        const el = visible[idx];
        const text = String(action.text ?? "");
        // ⛔ A literal into a password field is refused — only the credential this
        // call resolved (default/credentialRef) may go there. `web_act` never mints
        // a password, so "generated" does not apply to this op.
        if (String(el.type || "").toLowerCase() === "password" && text !== cr.creds.password) {
          outcomes.push({ ok: false, kind: "fill", refused: "password_literal_refused" });
          continue;
        }
        // ⛔⛔ THE URL FENCE, round-23 HARDENED (see looksLikeServerTarget's header):
        // anything host-shaped ANYWHERE, and ANY non-empty text into a field whose
        // own name/id/label says it is a server/URL field, must be EXACTLY the one
        // folder this op was told is allowed — and that folder must itself pass the
        // Loopcom fence. No allowed folder handed in = no typing of either kind.
        const fieldWords = [el.name, el.id, el.label].filter(Boolean).join(" ");
        const serverishField = SERVER_FIELD_RE.test(fieldWords);
        if (looksLikeServerTarget(text) || (serverishField && text.trim() !== "")) {
          const allowed = typeof req.allowedUrl === "string" && isLoopcomProvisioningUrl(req.allowedUrl)
            ? req.allowedUrl.trim() : null;
          if (!allowed || text.trim() !== allowed) {
            outcomes.push({ ok: false, kind: "fill", refused: "fenced_url_refused" });
            continue;
          }
        }
        await budget.spend(() => page.fill(idx, text));
        outcomes.push({ ok: true, kind: "fill" });
      } else if (action.kind === "click") {
        const idx = refs.get(action.ref);
        if (idx === undefined) { outcomes.push({ ok: false, kind: "click", refused: "stale_ref" }); clearRefs(); continue; }
        await budget.spend(() => page.click(idx));
        clearRefs();
        outcomes.push({ ok: true, kind: "click" });
      } else {
        outcomes.push({ ok: false, kind: (action as { kind: string }).kind as never, refused: "unsupported_action" });
      }
    }
  } catch (err) {
    // ⛔ An op that threw leaves the page's state unknown — never trusted for a
    // NEXT call. Discard the session entirely; the next `web_act` starts fresh.
    deps.webActSessions.delete(ip);
    await page.close().catch(() => undefined);
    if (err instanceof BudgetExceededError) return { ok: false, refused: "budget_exhausted", snapshot: lastSnapshot };
    throw err;
  }

  // ⛔ Only re-read if the caller's last action was not already a `read` — no
  // sense spending a page action nobody asked for just to answer the call.
  if (!lastActionWasRead) {
    const finalRaw = await page.read().catch(() => null);
    if (finalRaw) {
      const { snapshot, visible: v } = sanitizeRead(finalRaw);
      visible = v;
      refs = new Map(snapshot.elements.map((el, i) => [el.ref, i]));
      lastSnapshot = snapshot;
    }
  }
  // ⛔⛔ KEEP THE PAGE OPEN. The NEXT `web_act` call for this same phone reuses it
  // and these exact refs — see `WebActSession`'s header. It is closed only by
  // `evictWebActSession` (idle timeout, or another op taking over this phone).
  deps.webActSessions.set(ip, { page, refs, visible, lastSnapshot, lastUsedAt: deps.now() });
  return { ok: true, op: "web_act", snapshot: lastSnapshot, outcomes };
}
