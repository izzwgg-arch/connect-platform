/**
 * The Grandstream adapter — reset and restart a Grandstream phone over the office LAN, using the
 * password the customer typed into the wizard.
 *
 * ⛔⛔ EVERY VERB HERE IS READ OFF THE PHONE'S OWN WEB APPLICATION, not guessed. The GXP2170's
 * GWT bundle (`/webapp/<permutation>.cache.js`, read 2026-09-14 off Izzy's real handset at
 * 192.168.6.171) builds its login in TWO steps, and the second one hashes:
 *
 *   1. `POST /cgi-bin/access`   body `access=<hex(sha256(username))>`
 *      → `{ "response": "success", "body": "<token>" }`          (its `LDb()`)
 *   2. `POST /cgi-bin/dologin`  body `username=<username>&password=<hex(sha256(password + token))>`
 *      → `{ "response": "success", "body": { "sid": "<sid>" } }` (its `ODb()`, hashing via
 *        `Oxb(a) = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(a))`)
 *   3. `POST /cgi-bin/api-sys_operation` body `request=REBOOT|RESET&sid=<sid>`
 *
 * ⛔⛔ AND EVERY ONE OF THOSE NEEDS A `Referer` HEADER. Without it the phone's lighttpd answers
 * 403 Forbidden to all of these CGI paths — proven live: the same POST failed 403 bare and
 * succeeded 200 with a Referer. The FIRST version of this adapter (rc.15) sent the password in
 * PLAIN TEXT with no token and no Referer, so Izzy's correct password was rejected four times.
 *
 * ⛔ SETTINGS ARE NOT WRITTEN HERE. A factory-reset Grandstream asks for its settings over SIP PnP,
 * which the resident listener already answers — so there is no HTTP config write in this file, and
 * therefore none of the P237/P212 provisioning-field trap.
 *
 * ⛔ THE TRANSPORT IS INJECTED and the ADDRESS IS FENCED to a private IPv4 (`canonicalPrivateIpv4`),
 * exactly like the Yealink adapter.
 *
 * ⛔ NO CREDENTIAL IS EVER RETURNED, LOGGED OR PUT IN AN ERROR. The password is hashed where the
 * request is built and never echoed; the token and sid are session handles, used and dropped.
 */

import { createHash } from "node:crypto";
import {
  canonicalPrivateIpv4,
  requestWithSchemeFallback,
  PHONE_HTTP_TIMEOUT_MS,
  type ActionOutcome,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type YealinkCredentials,
} from "./yealink";

/** What a Grandstream login hands back: a session id and any cookie that carries it. */
export type GrandstreamSession = { sid: string; cookie: string };

const FORM = "application/x-www-form-urlencoded";

/** The phone's own hash: hex(sha256(value)) — its `Oxb()`. */
export function grandstreamHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The headers every one of these CGI calls needs.
 *
 * ⛔ The `Referer` is NOT decoration: without it the phone answers 403 Forbidden to
 * `/cgi-bin/access`, `/cgi-bin/dologin` and `/cgi-bin/api-sys_operation`. Proven live 2026-09-14.
 */
function cgiHeaders(host: string, https: boolean, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": FORM,
    Referer: `${https ? "https" : "http"}://${host}/`,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/** Step 1: ask for this username's login token. ⛔ Carries NO password — only a hash of the username. */
export function buildGrandstreamAccessRequest(
  ip: string,
  username: string,
  opts: { https?: boolean } = {},
): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  return {
    url: `${opts.https ? "https" : "http"}://${host}/cgi-bin/access`,
    method: "POST",
    headers: cgiHeaders(host, Boolean(opts.https)),
    body: `access=${encodeURIComponent(grandstreamHash(username))}`,
    timeoutMs: PHONE_HTTP_TIMEOUT_MS,
  };
}

/** The token is the `body` STRING of a successful access response. Anything else is no token. */
export function parseGrandstreamToken(res: HttpResponse | null): string | null {
  if (!res || res.status < 200 || res.status >= 300) return null;
  try {
    const parsed = JSON.parse(String(res.body ?? "").slice(0, 4096));
    const token = parsed?.body;
    return typeof token === "string" && /^[\x21-\x7e]{1,128}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The one non-secret cookie pair from a Set-Cookie header (`name=value`, before the first `;`). */
function sessionCookie(res: HttpResponse): string {
  const key = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === "set-cookie");
  const raw = key ? String(res.headers[key] ?? "") : "";
  const first = raw.split(/,(?=[^;]+=)/)[0] ?? raw;
  const pair = first.split(";")[0]?.trim() ?? "";
  return /^[^=\s]+=[^;\s]+$/.test(pair) ? pair : "";
}

/**
 * Step 2: the login itself.
 *
 * ⛔ The password NEVER goes on the wire in the clear: it is `hex(sha256(password + token))`, which
 * is exactly what the phone's own page sends. The plain password is not even in this request body.
 */
export function buildGrandstreamLoginRequest(
  ip: string,
  creds: YealinkCredentials,
  token: string,
  opts: { https?: boolean; cookie?: string } = {},
): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  const username = creds.username || "admin";
  const hashed = grandstreamHash(`${creds.password}${token}`);
  return {
    url: `${opts.https ? "https" : "http"}://${host}/cgi-bin/dologin`,
    method: "POST",
    headers: cgiHeaders(host, Boolean(opts.https), opts.cookie),
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(hashed)}`,
    timeoutMs: PHONE_HTTP_TIMEOUT_MS,
  };
}

/**
 * Read the session out of a login response, or null when the password was refused.
 *
 * ⛔ A non-empty `sid` is the ONLY proof of a successful login — the same "only a non-empty value
 * means anything" rule the unauthenticated model read follows.
 */
export function parseGrandstreamLogin(res: HttpResponse | null): GrandstreamSession | null {
  if (!res || res.status < 200 || res.status >= 300) return null;
  const text = String(res.body ?? "").slice(0, 4096);
  let sid: unknown = null;
  try {
    const parsed = JSON.parse(text);
    sid = parsed?.body?.sid ?? parsed?.sid ?? null;
  } catch {
    sid = /"sid"\s*:\s*"([0-9a-zA-Z]+)"/.exec(text)?.[1] ?? null;
  }
  if (typeof sid !== "string" || !/^[0-9a-zA-Z]{1,64}$/.test(sid)) return null;
  return { sid, cookie: sessionCookie(res) };
}

/** The system operations this adapter is prepared to send. Nothing outside this map exists. */
const SYS_OPERATIONS = { reboot: "REBOOT", reset: "RESET" } as const;
export type GrandstreamOperation = keyof typeof SYS_OPERATIONS;

/**
 * Step 3: reboot or factory reset, carrying the session.
 *
 * ⛔ `RESET` is a FACTORY RESET — the most destructive value on this surface. It reaches this
 * builder only after the capability's reset fence has passed, exactly like Yealink's `Reset` key.
 */
export function buildGrandstreamOperationRequest(
  ip: string,
  session: GrandstreamSession,
  op: GrandstreamOperation,
  opts: { https?: boolean } = {},
): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  return {
    url: `${opts.https ? "https" : "http"}://${host}/cgi-bin/api-sys_operation`,
    method: "POST",
    headers: cgiHeaders(host, Boolean(opts.https), session.cookie || undefined),
    body: `request=${SYS_OPERATIONS[op]}&sid=${encodeURIComponent(session.sid)}`,
    timeoutMs: PHONE_HTTP_TIMEOUT_MS,
  };
}

/** Log in (token → hashed password → sid), or say why not. Shared by the operations and the test. */
async function logIn(
  http: HttpTransport,
  ip: string,
  creds: YealinkCredentials,
): Promise<{ ok: true; session: GrandstreamSession; https: boolean } | { ok: false; reason: "locked" | "unreachable" | "refused"; status?: number }> {
  const username = creds.username || "admin";
  let accessReq: HttpRequest;
  try { accessReq = buildGrandstreamAccessRequest(ip, username); }
  catch { return { ok: false, reason: "refused" }; }
  const accessRes = await requestWithSchemeFallback(
    http, accessReq, () => buildGrandstreamAccessRequest(ip, username, { https: true }),
  );
  if (!accessRes) return { ok: false, reason: "unreachable" };
  if (accessRes.status === 401 || accessRes.status === 403) return { ok: false, reason: "locked", status: accessRes.status };
  const token = parseGrandstreamToken(accessRes);
  // ⛔ No token means this phone's login is a shape we have not read. It is NOT a wrong password,
  // and it must never be reported as one — nothing was sent that could lock the phone out.
  if (!token) return { ok: false, reason: "refused", status: accessRes.status };

  const https = accessReq.url.startsWith("https:");
  const cookie = sessionCookie(accessRes) || undefined;
  let loginReq: HttpRequest;
  try { loginReq = buildGrandstreamLoginRequest(ip, creds, token, { https, cookie }); }
  catch { return { ok: false, reason: "refused" }; }
  const loginRes = await requestWithSchemeFallback(
    http, loginReq, () => buildGrandstreamLoginRequest(ip, creds, token, { https: true, cookie }),
  );
  if (!loginRes) return { ok: false, reason: "unreachable" };
  if (loginRes.status === 401 || loginRes.status === 403) return { ok: false, reason: "locked", status: loginRes.status };
  const session = parseGrandstreamLogin(loginRes);
  if (!session) return { ok: false, reason: "locked" };
  return { ok: true, session: { sid: session.sid, cookie: session.cookie || cookie || "" }, https };
}

/**
 * Log in, then send one system operation.
 *
 * ⛔ NEVER RETRIED HERE. A reboot or reset that "timed out" may well have been received — the phone
 * stops answering because it is doing what it was told. Retries are the state machine's decision.
 */
export async function sendGrandstreamOperation(
  http: HttpTransport,
  ip: string,
  op: GrandstreamOperation,
  creds: YealinkCredentials | null,
): Promise<ActionOutcome> {
  // No password, no session — a Grandstream operation cannot be sent unauthenticated.
  if (!creds || !creds.password) return { ok: false, reason: "locked" };

  const auth = await logIn(http, ip, creds);
  if (!auth.ok) return { ok: false, reason: auth.reason, ...(auth.status ? { status: auth.status } : {}) };

  let opReq: HttpRequest;
  try { opReq = buildGrandstreamOperationRequest(ip, auth.session, op, { https: auth.https }); }
  catch { return { ok: false, reason: "refused" }; }
  const opRes = await requestWithSchemeFallback(
    http, opReq, () => buildGrandstreamOperationRequest(ip, auth.session, op, { https: true }),
  );
  if (!opRes) return { ok: false, reason: "unreachable" };
  if (opRes.status === 401 || opRes.status === 403) return { ok: false, reason: "locked", status: opRes.status };
  if (opRes.status >= 200 && opRes.status < 400) return { ok: true };
  return { ok: false, reason: "refused", status: opRes.status };
}

/**
 * Does this password open this Grandstream? A login that returns a session is accepted; a 401/403
 * or a session-less answer is `locked`; nothing answering is `unreachable`.
 */
export async function testGrandstreamCredentials(
  http: HttpTransport,
  ip: string,
  creds: YealinkCredentials | null,
): Promise<{ ok: true } | { ok: false; reason: "locked" | "unreachable" | "unexpected"; status?: number }> {
  if (!creds || !creds.password) return { ok: false, reason: "locked" };
  const auth = await logIn(http, ip, creds);
  if (auth.ok) return { ok: true };
  if (auth.reason === "unreachable") return { ok: false, reason: "unreachable" };
  if (auth.reason === "refused") return { ok: false, reason: "unexpected", status: auth.status };
  return { ok: false, reason: "locked", status: auth.status };
}
