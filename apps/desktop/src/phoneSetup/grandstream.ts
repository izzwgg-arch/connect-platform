/**
 * The Grandstream adapter — reset and restart a Grandstream phone over the office LAN,
 * using the password the customer typed into the wizard.
 *
 * ⛔⛔ EVERY VERB HERE IS A DOCUMENTED GRANDSTREAM MECHANISM, and it is a SEPARATE surface
 * from Yealink — they share nothing. Grandstream is session-based:
 *   1. `POST /cgi-bin/dologin` with the admin password returns a session id (`sid`) and a
 *      cookie; every later call carries both.
 *   2. `POST /cgi-bin/api-sys_operation` with `request=REBOOT` or `request=RESET` (+ the sid)
 *      restarts or factory-resets the phone.
 * Source: Grandstream HTTP API (dologin → api-sys_operation), cross-checked against the
 * unauthenticated model/metaconfig reads captured off Izzy's real GXP2170 (2026-09-10).
 *
 * ⛔ SETTINGS ARE NOT WRITTEN HERE. A factory-reset Grandstream asks for its settings over
 * SIP PnP, which the resident listener already answers — so there is no HTTP config write in
 * this file, and therefore none of the P237/P212 provisioning-field trap. This adapter only
 * clears the phone and restarts it; delivery stays on the PnP path that is already proven.
 *
 * ⛔ THE TRANSPORT IS INJECTED and the ADDRESS IS FENCED. Every request is built against the
 * private-IPv4 canonical form (`canonicalPrivateIpv4`), exactly like the Yealink adapter, so a
 * compromised head can never point this at anything but a phone on the customer's own network.
 *
 * ⛔ NO CREDENTIAL IS EVER RETURNED, LOGGED OR PUT IN AN ERROR. The password is form-encoded
 * into the login body where the request is built, never echoed, and the sid/cookie a login
 * returns are session handles that are used and dropped, never logged.
 */

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

/** What a Grandstream login hands back: a session id and the cookie that carries it. */
export type GrandstreamSession = { sid: string; cookie: string };

const FORM = "application/x-www-form-urlencoded";

/**
 * Build the login request.
 *
 * ⛔ The password goes in the FORM BODY, never in the URL — the URL is the thing that reaches
 * a log line, a diagnostics pane and an AI prompt. `username=admin` is included because current
 * GXP firmware accepts it and older firmware ignores it; the phone reads the password either way.
 */
export function buildGrandstreamLoginRequest(
  ip: string,
  password: string,
  opts: { https?: boolean } = {},
): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  return {
    url: `${opts.https ? "https" : "http"}://${host}/cgi-bin/dologin`,
    method: "POST",
    headers: { "Content-Type": FORM },
    body: `username=admin&password=${encodeURIComponent(password)}`,
    timeoutMs: PHONE_HTTP_TIMEOUT_MS,
  };
}

/** The one non-secret cookie pair from a Set-Cookie header (`name=value`, before the first `;`). */
function sessionCookie(res: HttpResponse): string {
  const key = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === "set-cookie");
  const raw = key ? String(res.headers[key] ?? "") : "";
  // node's transport joins multiple Set-Cookie headers with ", "; take the first pair.
  const first = raw.split(/,(?=[^;]+=)/)[0] ?? raw;
  const pair = first.split(";")[0]?.trim() ?? "";
  return /^[^=\s]+=[^;\s]+$/.test(pair) ? pair : "";
}

/**
 * Read the session out of a login response, or null when the password was refused.
 *
 * ⛔ A non-empty `sid` is the ONLY proof of a successful login: Grandstream answers
 * `{ "response": "success", "body": { "sid": "..." } }` on success and, on a bad password,
 * either a non-200 or a body with an error and no sid. An empty sid is a failed login, never a
 * usable session — the same "only a non-empty value means anything" rule as the model read.
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
 * Build a system-operation request (reboot or factory reset), carrying the session.
 *
 * ⛔ `RESET` here is a FACTORY RESET — the most destructive value on this surface. It reaches
 * this builder only after the capability's four-way reset fence has passed, exactly like the
 * Yealink `Reset` action key.
 */
export function buildGrandstreamOperationRequest(
  ip: string,
  session: GrandstreamSession,
  op: GrandstreamOperation,
  opts: { https?: boolean } = {},
): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  const headers: Record<string, string> = { "Content-Type": FORM };
  if (session.cookie) headers.Cookie = session.cookie;
  return {
    url: `${opts.https ? "https" : "http"}://${host}/cgi-bin/api-sys_operation`,
    method: "POST",
    headers,
    body: `request=${SYS_OPERATIONS[op]}&sid=${encodeURIComponent(session.sid)}`,
    timeoutMs: PHONE_HTTP_TIMEOUT_MS,
  };
}

/**
 * Log in, then send one system operation. HTTP first, HTTPS on a refused connection — the same
 * scheme fallback the Yealink adapter uses, because current Grandstream firmware also ships with
 * plain HTTP sometimes off.
 *
 * ⛔ NEVER RETRIED HERE. A reboot or reset that "timed out" may well have been received — the
 * phone stops answering because it is doing what it was told. Retries, if any, are the state
 * machine's decision against a durable record, never this adapter's.
 *
 * ⛔ A 401/403 on EITHER call — the login or the operation — is the phone refusing our password:
 * `locked`, and nothing happened. That is the answer that sends the wizard to the password step.
 */
export async function sendGrandstreamOperation(
  http: HttpTransport,
  ip: string,
  op: GrandstreamOperation,
  creds: YealinkCredentials | null,
): Promise<ActionOutcome> {
  // No password, no session — a Grandstream operation cannot be sent unauthenticated.
  if (!creds || !creds.password) return { ok: false, reason: "locked" };

  let loginReq: HttpRequest;
  try { loginReq = buildGrandstreamLoginRequest(ip, creds.password); }
  catch { return { ok: false, reason: "refused" }; }
  const loginRes = await requestWithSchemeFallback(
    http, loginReq, () => buildGrandstreamLoginRequest(ip, creds.password, { https: true }),
  );
  if (!loginRes) return { ok: false, reason: "unreachable" };
  if (loginRes.status === 401 || loginRes.status === 403) return { ok: false, reason: "locked", status: loginRes.status };
  const session = parseGrandstreamLogin(loginRes);
  // A 200 with no usable sid is a refused password, not a broken phone.
  if (!session) return { ok: false, reason: "locked" };

  const secure = isHttpsUrl(loginReq.url) || isHttpsUrl(loginRes.headers?.location);
  let opReq: HttpRequest;
  try { opReq = buildGrandstreamOperationRequest(ip, session, op, { https: secure }); }
  catch { return { ok: false, reason: "refused" }; }
  const opRes = await requestWithSchemeFallback(
    http, opReq, () => buildGrandstreamOperationRequest(ip, session, op, { https: true }),
  );
  if (!opRes) return { ok: false, reason: "unreachable" };
  if (opRes.status === 401 || opRes.status === 403) return { ok: false, reason: "locked", status: opRes.status };
  if (opRes.status >= 200 && opRes.status < 400) return { ok: true };
  return { ok: false, reason: "refused", status: opRes.status };
}

function isHttpsUrl(u: string | undefined): boolean {
  return typeof u === "string" && u.startsWith("https:");
}

/**
 * Does this password open this Grandstream? A login that returns a session is accepted; a
 * 401/403 or a session-less 200 is `locked`; nothing answering is `unreachable`.
 */
export async function testGrandstreamCredentials(
  http: HttpTransport,
  ip: string,
  creds: YealinkCredentials | null,
): Promise<{ ok: true } | { ok: false; reason: "locked" | "unreachable" | "unexpected"; status?: number }> {
  if (!creds || !creds.password) return { ok: false, reason: "locked" };
  let req: HttpRequest;
  try { req = buildGrandstreamLoginRequest(ip, creds.password); }
  catch { return { ok: false, reason: "unexpected", status: 0 }; }
  const res = await requestWithSchemeFallback(http, req, () => buildGrandstreamLoginRequest(ip, creds.password, { https: true }));
  if (!res) return { ok: false, reason: "unreachable" };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "locked", status: res.status };
  return parseGrandstreamLogin(res) ? { ok: true } : { ok: false, reason: "locked" };
}
