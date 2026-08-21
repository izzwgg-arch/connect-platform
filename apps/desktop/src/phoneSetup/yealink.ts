/**
 * The Yealink adapter — the only thing in Connect that talks to a desk phone.
 *
 * ⛔⛔ EVERY VERB HERE IS A DOCUMENTED YEALINK MECHANISM. Nothing is reverse
 * engineered and nothing is guessed:
 *   • Action URI    `http(s)://user:pass@PHONE/servlet?key=VALUE`, values separated
 *                   by `;`. `key=Reboot` reboots, `key=AutoP` makes the phone fetch
 *                   its settings now. Gated by `features.action_uri.enable`
 *                   (default 1) and restricted by `features.action_uri_limit_ip`.
 *   • Reset by SIP  `Event: reset`, firmware 81+, enabled by provisioning
 *                   `sip.notify_reset.enable = 1`. ⛔ NOT DONE HERE — that one is
 *                   sent by the PBX, which is exactly why it is the preferred path:
 *                   no office network access and no password at all.
 *
 * ⛔⛔ THE TRANSPORT IS INJECTED. Not for neatness — because every rule in this
 * file (what we send, what counts as locked, what we refuse) has to be provable
 * without a phone on a desk, and because a module that reaches the network on
 * import cannot be unit tested at all.
 *
 * ⛔ NO CREDENTIAL IS EVER RETURNED, LOGGED OR PUT IN AN ERROR. The redaction
 * happens where the string is built, not where it is displayed, so there is no code
 * path that could print one.
 */

export type YealinkCredentials = { username: string; password: string };

export type HttpRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** The one seam to the outside world. */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * ⛔ A phone's web interface is on the office LAN and answers in single-digit
 * milliseconds. Anything past a couple of seconds is a device that is not going to
 * answer, and a long timeout turns one unreachable phone into a stalled wizard.
 */
export const PHONE_HTTP_TIMEOUT_MS = 4000;

/**
 * ⛔⛔ THE DOCUMENTED FACTORY DEFAULT, AND IT IS TRIED EXACTLY ONCE. There is no
 * second entry in this list and there must never be one: a list is a dictionary
 * attack, it locks phones out, and it is indistinguishable from an attacker to
 * anyone watching the customer's network.
 */
export const YEALINK_DEFAULT_CREDENTIALS: YealinkCredentials = { username: "admin", password: "admin" };

/** Action URI values we are prepared to send. Nothing outside this list is expressible. */
const ACTION_KEYS = {
  reboot: "Reboot",
  autop: "AutoP",
} as const;

export type YealinkAction = keyof typeof ACTION_KEYS;

/**
 * Build the request for one action.
 *
 * ⛔⛔ CREDENTIALS GO IN THE Authorization HEADER, NEVER IN THE URL. Yealink's own
 * documentation shows `http://user:pass@ip/...` and that form is poison here: the
 * URL is the thing that ends up in a diagnostics pane, a log line, an error message
 * and an AI prompt. Basic auth in a header keeps the secret out of every one of
 * those, and the phone accepts it identically.
 */
export function buildActionRequest(
  ip: string,
  action: YealinkAction,
  creds: YealinkCredentials | null,
  opts: { https?: boolean } = {},
): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  const scheme = opts.https ? "https" : "http";
  return {
    url: `${scheme}://${host}/servlet?key=${ACTION_KEYS[action]}`,
    method: "GET",
    headers: creds ? { Authorization: basicAuth(creds) } : {},
    timeoutMs: PHONE_HTTP_TIMEOUT_MS,
  };
}

function basicAuth(c: YealinkCredentials): string {
  // Node and Electron both have Buffer; the desktop main process is Node.
  return "Basic " + Buffer.from(`${c.username}:${c.password}`, "utf8").toString("base64");
}

/**
 * ⛔⛔ THE HARD FENCE. Nothing in this adapter may be pointed anywhere except a
 * private IPv4 address on the customer's own network. This is what stops the whole
 * capability from being usable as a general request-sending machine — which is the
 * single thing that would turn "find my phones" into a way to reach anything a
 * compromised account can name.
 */
export function assertPrivateIpv4(ip: string): void {
  if (!isPrivateIpv4(ip)) throw new Error("refused: not a private office address");
}

export function isPrivateIpv4(ip: unknown): boolean {
  return canonicalPrivateIpv4(ip) !== null;
}

/**
 * Parse an address and hand back its ONE canonical dotted form, or null.
 *
 * ⛔⛔ A LEADING ZERO IS REFUSED, AND THAT IS NOT PEDANTRY — IT WAS A REAL BYPASS.
 * `010.0.0.1` reads as decimal ten to a naive check, so it looks like the private
 * 10.0.0.0/8 range and is waved through. But `inet_addr` and the resolvers built on
 * it read a leading-zero octet as OCTAL, so the request actually goes to 8.0.0.1 —
 * a public address. Found by fuzzing this function on 2026-08-21; it let
 * `010.0.0.1` and `192.168.001.001` straight past.
 *
 * ⛔ Callers must build their URL from the value this RETURNS, never from the string
 * they were given. Validating one spelling and then sending another is the whole
 * class of bug.
 */
export function canonicalPrivateIpv4(ip: unknown): string | null {
  const raw = String(ip ?? "");
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const n: number[] = [];
  for (const part of parts) {
    // exactly 1-3 ASCII digits, and no leading zero unless the octet IS zero
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null;
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n.push(v);
  }
  const [a, b] = n;
  const isPrivate = a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
  if (!isPrivate) return null;
  return n.join(".");
}

export type AuthResult =
  | { ok: true }
  /** The phone is there and refused what we sent. */
  | { ok: false; reason: "locked" }
  /** Nothing answered, or it was not a phone. */
  | { ok: false; reason: "unreachable" }
  /** It answered, but not in a way we understand. */
  | { ok: false; reason: "unexpected"; status: number };

/**
 * Does this credential open this phone?
 *
 * ⛔ A 401 is "wrong password", not "broken". Conflating the two is how a wizard
 * tells a customer their phone is faulty when it is simply locked.
 */
export async function testCredentials(
  http: HttpTransport,
  ip: string,
  creds: YealinkCredentials | null,
): Promise<AuthResult> {
  let res: HttpResponse;
  try {
    res = await http(buildStatusRequest(ip, creds));
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "locked" };
  if (res.status >= 200 && res.status < 400) return { ok: true };
  return { ok: false, reason: "unexpected", status: res.status };
}

export function buildStatusRequest(ip: string, creds: YealinkCredentials | null): HttpRequest {
  const host = canonicalPrivateIpv4(ip);
  if (!host) throw new Error("refused: not a private office address");
  return {
    url: `http://${host}/`,
    method: "GET",
    headers: creds ? { Authorization: basicAuth(creds) } : {},
    timeoutMs: PHONE_HTTP_TIMEOUT_MS,
  };
}

export type DeviceFingerprint = {
  vendor: "yealink" | "unknown";
  model: string | null;
  firmware: string | null;
  /**
   * ⛔ How sure we are, stated rather than implied. "banner" means we read it off an
   * unauthenticated response and it is a good guess; "reported" means the phone told
   * us over an authenticated read. A wizard that shows a guessed model as fact will
   * eventually show a customer a picture of the wrong phone.
   */
  confidence: "reported" | "banner" | "none";
};

const MODEL_PATTERN = /\b(SIP-)?(T\d{2}[A-Z]?(?:[_-]?E2)?|CP\d{3}[A-Z]?|AX\d{2}[A-Z]?|W\d{2}[A-Z]?)\b/i;

/**
 * What is this thing, from whatever it said.
 *
 * ⛔ Reads the server banner, the authentication realm and the page title, because
 * different Yealink firmware generations put the model in different ones. Anything
 * unrecognised comes back `unknown` with confidence `none` — never a guess, because
 * downstream this decides which settings profile a phone gets.
 */
export function fingerprintFromResponse(res: HttpResponse): DeviceFingerprint {
  const server = header(res, "server");
  const realm = header(res, "www-authenticate");
  const title = /<title>([^<]{0,120})<\/title>/i.exec(res.body || "")?.[1] ?? "";
  const haystack = `${server} ${realm} ${title}`;

  const isYealink = /yealink/i.test(haystack);
  const model = MODEL_PATTERN.exec(haystack)?.[2] ?? null;
  const firmware = /\b(\d{2,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/.exec(haystack)?.[1] ?? null;

  if (!isYealink && !model) return { vendor: "unknown", model: null, firmware: null, confidence: "none" };
  return {
    vendor: isYealink ? "yealink" : "unknown",
    model: model ? model.toUpperCase().replace(/[_-]/g, "") : null,
    firmware,
    confidence: model || firmware ? "banner" : "none",
  };
}

function header(res: HttpResponse, name: string): string {
  const key = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === name);
  return key ? String(res.headers[key] ?? "") : "";
}

/**
 * ⛔⛔ FIRMWARE 81 IS THE LINE. Below it a phone cannot be reset over SIP, which
 * means every reset for that handset needs office-network access and a password.
 * Knowing this before we start is what lets the wizard ask for a password once
 * rather than discovering it needs one halfway through a reset.
 */
export const MIN_FIRMWARE_FOR_SIP_RESET = 81;

export function supportsSipReset(firmware: string | null | undefined): boolean {
  const major = Number(String(firmware ?? "").split(".")[0]);
  if (!Number.isFinite(major)) return false;
  return major >= MIN_FIRMWARE_FOR_SIP_RESET;
}

/**
 * Where is this phone getting its settings from?
 *
 * ⛔ This is the field that decides everything downstream — whether the phone is
 * already ours, needs a nudge, or is still being pulled back by somebody else. It is
 * also attacker-influenceable text, so it is bounded and stripped before it goes
 * anywhere near a screen or a prompt.
 */
export function classifyProvisioningUrl(
  url: string | null | undefined,
  ourProvisioningHosts: string[],
): "ours" | "other" | "none" {
  const raw = String(url ?? "").trim();
  if (!raw) return "none";
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return "other";
  }
  // ⛔ Exact host match or a dot-boundary suffix. A bare `includes` would treat
  // `loopcom.net.evil.com` as ours.
  for (const ours of ourProvisioningHosts) {
    const h = String(ours || "").toLowerCase().trim();
    if (!h) continue;
    if (host === h || host.endsWith(`.${h}`)) return "ours";
  }
  return "other";
}

export type ActionOutcome =
  | { ok: true }
  | { ok: false; reason: "locked" | "unreachable" | "refused"; status?: number };

/**
 * Send one action to one phone.
 *
 * ⛔ NEVER RETRIED HERE. A reboot that "timed out" may well have been received —
 * the phone stops answering precisely because it is doing what it was told. Retrying
 * from inside the adapter turns one reboot into three. Retries, if any, are the
 * state machine's decision, made against a record that survives a restart.
 */
export async function sendAction(
  http: HttpTransport,
  ip: string,
  action: YealinkAction,
  creds: YealinkCredentials | null,
): Promise<ActionOutcome> {
  let res: HttpResponse;
  try {
    res = await http(buildActionRequest(ip, action, creds));
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "locked", status: res.status };
  if (res.status >= 200 && res.status < 400) return { ok: true };
  return { ok: false, reason: "refused", status: res.status };
}

/**
 * ⛔⛔ THERE IS DELIBERATELY NO `sendArbitraryRequest`, NO `setConfigKey` AND NO
 * `postForm` IN THIS FILE. Those would each be genuinely useful and each would turn
 * this adapter into a general-purpose way to reach anything on a customer's network
 * from the cloud. Every capability is a named verb with a fixed shape; if a new one
 * is needed it gets its own function, its own validation and its own test.
 */
export const ADAPTER_REFUSES_ARBITRARY_REQUESTS = true;
