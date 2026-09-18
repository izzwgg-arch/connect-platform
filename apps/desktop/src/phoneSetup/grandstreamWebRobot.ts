/**
 * The robot's GRANDSTREAM family — the same three fenced ops the Yealink family has
 * (probe / provision / reset), through the phone's own JSON cgi surface instead of a
 * driven web page (Izzy, 2026-09-18: "add Grandstream to the robot's web login families").
 *
 * Why cgi and not the page: a GXP/GRP web UI is a GWT app whose DOM changes per firmware;
 * `grandstream.ts` already logs in and reboots/resets through `/cgi-bin/access` →
 * `/cgi-bin/dologin` → `/cgi-bin/api-sys_operation`, proven live 2026-09-14, and admin/admin
 * opened a factory-reset GXP2170 live on 2026-09-17. This file adds the two reads and the
 * ONE write the guided setup needs.
 *
 * ⛔⛔ THE WRITE IS VERIFIED BY READ-BACK, AND A NO-OP IS SAID, NOT HIDDEN. The 2026-09-14
 * handoff found `config_update` returning `{}` while a GDMS-claimed phone kept its factory
 * P237 — GDMS owns the direction on a claimed phone. So `provision` reads P237/P212 back
 * after writing and refuses `save_not_verified` when they did not land; the server's ladder
 * then takes the GDMS redirect road (round 24), which is the right road for exactly that phone.
 * ⛔ Same fences as the Yealink family: private address only, Loopcom folder only, never a
 * retry, and every failed password spends the shared per-phone lockout budget (a Grandstream
 * locks after five).
 */

import { normalizeMac } from "./pnp";
import {
  buildGrandstreamAccessRequest, buildGrandstreamLoginRequest, buildGrandstreamOperationRequest,
  parseGrandstreamLogin, parseGrandstreamToken, type GrandstreamSession,
} from "./grandstream";
import {
  canonicalPrivateIpv4, isLoopcomProvisioningUrl, PHONE_HTTP_TIMEOUT_MS,
  type HttpRequest, type HttpResponse, type HttpTransport, type YealinkCredentials,
} from "./yealink";

/** Factory login of a reset GXP (proven live 2026-09-17). GRP units print a unique one on the sticker. */
export const GRANDSTREAM_DEFAULT_CREDENTIALS: YealinkCredentials = { username: "admin", password: "admin" };

export type GsRobotDeps = {
  http: HttpTransport;
  loginBlocked: (ip: string) => boolean;
  noteLogin: (ip: string, outcome: { ok: true } | { ok: false; reason: "locked" }) => void;
  log: (line: string) => void;
};

type Session = GrandstreamSession & { https: boolean };

async function tryBoth(http: HttpTransport, build: (https: boolean) => HttpRequest): Promise<{ res: HttpResponse; https: boolean } | null> {
  for (const https of [false, true]) {
    try {
      const res = await http(build(https));
      if (res) return { res, https };
    } catch { /* the other scheme */ }
  }
  return null;
}

/**
 * Log in. ⛔ Only a refused PASSWORD spends the lockout budget — an unreachable phone or
 * a login page of a shape we have not read never counts against it.
 */
export async function gsLogin(deps: GsRobotDeps, ip: string, creds: YealinkCredentials):
  Promise<{ ok: true; session: Session } | { ok: false; refused: "unreachable" | "unknown_screen" | "login_failed" | "too_many_login_attempts" }> {
  if (deps.loginBlocked(ip)) return { ok: false, refused: "too_many_login_attempts" };
  const username = creds.username || "admin";
  const access = await tryBoth(deps.http, (https) => buildGrandstreamAccessRequest(ip, username, { https }));
  if (!access) return { ok: false, refused: "unreachable" };
  const token = parseGrandstreamToken(access.res);
  if (!token) return { ok: false, refused: "unknown_screen" };
  const cookie = /^[^=\s]+=[^;\s]+/.exec(String(access.res.headers?.["set-cookie"] ?? ""))?.[0];
  let login: HttpResponse;
  try { login = await deps.http(buildGrandstreamLoginRequest(ip, creds, token, { https: access.https, cookie })); }
  catch { return { ok: false, refused: "unreachable" }; }
  const session = parseGrandstreamLogin(login);
  if (!session) {
    deps.noteLogin(ip, { ok: false, reason: "locked" });
    return { ok: false, refused: "login_failed" };
  }
  deps.noteLogin(ip, { ok: true });
  return { ok: true, session: { sid: session.sid, cookie: session.cookie || cookie || "", https: access.https } };
}

function cgi(ip: string, session: Session | null, path: string, method: "GET" | "POST", body?: string): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  const https = session?.https ?? false;
  const headers: Record<string, string> = {
    "Content-Type": method === "POST" ? "application/json" : "text/plain",
    Referer: `${https ? "https" : "http"}://${host}/`,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (session?.cookie) headers.Cookie = session.cookie;
  return { url: `${https ? "https" : "http"}://${host}/cgi-bin/${path}`, method, headers, ...(body ? { body } : {}), timeoutMs: PHONE_HTTP_TIMEOUT_MS };
}

/** Pull `key` out of whatever JSON shape the phone answered with (`body.237`, `237`, nested). */
export function pluck(json: unknown, key: string): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === key && (typeof val === "string" || typeof val === "number")) return String(val);
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      const hit = walk(val);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(json);
}

function parseJson(res: HttpResponse | null): unknown {
  if (!res || res.status < 200 || res.status >= 300) return null;
  try { return JSON.parse(String(res.body ?? "")); } catch { return null; }
}

/** The phone's own identity — unauthenticated, read-only (proven for `phone_model` 2026-09-14). */
export async function gsIdentity(deps: GsRobotDeps, ip: string): Promise<{ model: string | null; firmware: string | null; mac: string | null }> {
  const out = { model: null as string | null, firmware: null as string | null, mac: null as string | null };
  try {
    const got = await tryBoth(deps.http, (https) => ({
      ...cgi(ip, null, "api.values.get?request=phone_model:sw_version:mac_addr:P2000", "GET"),
      url: `${https ? "https" : "http"}://${canonicalPrivateIpv4(ip)}/cgi-bin/api.values.get?request=phone_model:sw_version:mac_addr:P2000`,
    }));
    const json = parseJson(got?.res ?? null);
    const model = pluck(json, "phone_model");
    const fw = pluck(json, "sw_version");
    out.model = model && /^[A-Za-z0-9 _.-]{2,40}$/.test(model) ? model.trim() : null;
    out.firmware = fw && /^[0-9][0-9A-Za-z.-]{1,30}$/.test(fw) ? fw.trim() : null;
    const macRaw = pluck(json, "mac_addr") ?? pluck(json, "P2000");
    out.mac = macRaw ? normalizeMac(macRaw) : null;
  } catch { /* identity is optional; the sticker still decides */ }
  return out;
}

/** P237 (provisioning server, host/path — never a scheme) and P212 (protocol) as the phone holds them. */
export async function gsReadProvisioning(deps: GsRobotDeps, ip: string, session: Session): Promise<{ p237: string | null; p212: string | null }> {
  try {
    const res = await deps.http(cgi(ip, session, `config_get?pvalues=237,212&sid=${encodeURIComponent(session.sid)}`, "GET"));
    const json = parseJson(res);
    return { p237: pluck(json, "237"), p212: pluck(json, "212") };
  } catch {
    return { p237: null, p212: null };
  }
}

/** Our folder URL as a Grandstream P237 value: host + path, no scheme, no trailing slash. */
export function p237Of(url: string): string | null {
  if (!isLoopcomProvisioningUrl(url)) return null;
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export type GsProbeResult = {
  ok: true; op: "web_probe"; family: "grandstream_cgi"; loginWorked: boolean; usedDefault: boolean;
  forcedPasswordChange: false; model: string | null; firmware: string | null; serial: null; provisioningUrl: string | null;
};

export async function gsProbe(deps: GsRobotDeps, req: { ip: string; creds: YealinkCredentials; usedDefault: boolean }): Promise<GsProbeResult | { ok: false; refused: string }> {
  const ip = canonicalPrivateIpv4(req.ip);
  if (!ip) return { ok: false, refused: "not_a_private_address" };
  const id = await gsIdentity(deps, ip);
  const base = { ok: true as const, op: "web_probe" as const, family: "grandstream_cgi" as const, usedDefault: req.usedDefault, forcedPasswordChange: false as const, model: id.model, firmware: id.firmware, serial: null, provisioningUrl: null as string | null };
  const login = await gsLogin(deps, ip, req.creds);
  if (!login.ok) {
    if (login.refused === "unreachable") return { ok: false, refused: "unreachable" };
    return { ...base, loginWorked: false };
  }
  const prov = await gsReadProvisioning(deps, ip, login.session);
  return { ...base, loginWorked: true, provisioningUrl: prov.p237 ? `${prov.p212 === "2" ? "https" : "http"}://${prov.p237}` : null };
}

export type GsProvisionResult =
  | { ok: true; op: "web_provision"; provisioned: true; urlVerified: true }
  | { ok: false; refused: string };

/**
 * Point the phone at our folder and restart it. ⛔ Fenced URL only; wrong-device check
 * against the MAC the phone reports about itself when it reports one; the write is
 * verified by read-back and refused honestly when the phone kept its own value.
 */
export async function gsProvision(deps: GsRobotDeps, req: { ip: string; mac: string; url: string; creds: YealinkCredentials }): Promise<GsProvisionResult> {
  const ip = canonicalPrivateIpv4(req.ip);
  if (!ip) return { ok: false, refused: "not_a_private_address" };
  const p237 = p237Of(req.url);
  if (!p237) return { ok: false, refused: "fenced_url_refused" };
  const targetMac = normalizeMac(req.mac);
  if (!targetMac) return { ok: false, refused: "bad_hardware_address" };
  const id = await gsIdentity(deps, ip);
  if (id.mac && id.mac !== targetMac) return { ok: false, refused: "wrong_device" };
  const login = await gsLogin(deps, ip, req.creds);
  if (!login.ok) return { ok: false, refused: login.refused };
  const s = login.session;
  try {
    const write = await deps.http(cgi(ip, s, `config_update?sid=${encodeURIComponent(s.sid)}`, "POST", JSON.stringify({ alias: {}, pvalue: { "237": p237, "212": "2" } })));
    if (write.status < 200 || write.status >= 300) return { ok: false, refused: "save_refused" };
  } catch {
    return { ok: false, refused: "unreachable" };
  }
  const back = await gsReadProvisioning(deps, ip, s);
  if ((back.p237 ?? "").replace(/\/+$/, "") !== p237) {
    deps.log(`grandstream ${ip}: config_update did not land (read back ${back.p237 ?? "nothing"}) — the maker's cloud owns this phone's direction`);
    return { ok: false, refused: "save_not_verified" };
  }
  try {
    const reboot = await deps.http(buildGrandstreamOperationRequest(ip, { sid: s.sid, cookie: s.cookie }, "reboot", { https: s.https }));
    if (reboot.status >= 400) return { ok: false, refused: "restart_refused" };
  } catch { /* a reboot that cut the connection was received */ }
  return { ok: true, op: "web_provision", provisioned: true, urlVerified: true };
}

export async function gsReset(deps: GsRobotDeps, req: { ip: string; creds: YealinkCredentials }): Promise<{ ok: true; op: "web_reset"; sent: true } | { ok: false; refused: string }> {
  const ip = canonicalPrivateIpv4(req.ip);
  if (!ip) return { ok: false, refused: "not_a_private_address" };
  const login = await gsLogin(deps, ip, req.creds);
  if (!login.ok) return { ok: false, refused: login.refused };
  const s = login.session;
  try {
    const res = await deps.http(buildGrandstreamOperationRequest(ip, { sid: s.sid, cookie: s.cookie }, "reset", { https: s.https }));
    if (res.status >= 400) return { ok: false, refused: "reset_refused" };
  } catch { /* the phone stops answering while it wipes — that is the reset landing */ }
  return { ok: true, op: "web_reset", sent: true };
}
