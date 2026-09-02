/**
 * Direct FCM HTTP v1 sender for call-critical Android wakes.
 *
 * WHY: call wakes were relayed through Expo's push service; on aggressive OEMs
 * (Samsung app-standby buckets) that relay is deprioritized and pushes die
 * between "expo accepted" and the device. Direct high-priority FCM data
 * messages are the Google-sanctioned Doze-exempt channel for VoIP wakes.
 *
 * SAFETY: this module is INERT unless BOTH (a) a service-account JSON exists at
 * FCM_SERVICE_ACCOUNT_PATH and (b) a device has reported a nativeFcmToken.
 * Callers must fall back to Expo on any error thrown here.
 *
 * Zero new dependencies: OAuth2 JWT-bearer grant signed with node:crypto.
 */
import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const SA_PATH = process.env.FCM_SERVICE_ACCOUNT_PATH || "/opt/connectcomms/env/firebase-service-account.json";

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

let saCache: ServiceAccount | null | undefined;
function loadServiceAccount(): ServiceAccount | null {
  if (saCache !== undefined) return saCache;
  try {
    if (!existsSync(SA_PATH)) { saCache = null; return null; }
    const parsed = JSON.parse(readFileSync(SA_PATH, "utf8"));
    if (parsed?.type === "service_account" && parsed.project_id && parsed.client_email && parsed.private_key) {
      saCache = parsed as ServiceAccount;
    } else {
      saCache = null;
    }
  } catch {
    saCache = null;
  }
  return saCache;
}

export function isFcmDirectConfigured(): boolean {
  return loadServiceAccount() !== null;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let tokenCache: { token: string; expMs: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expMs - 60_000) return tokenCache.token;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claims}.${signature}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!res.ok) throw new Error(`fcm oauth ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("fcm oauth: no access_token");
  tokenCache = { token: body.access_token, expMs: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

/**
 * Flatten a push payload into the FCM data map (string values only), mirroring
 * the shape the app already parses from the Expo relay: `type` as a top-level
 * key for the native fast-path, plus the full payload JSON under `body` for the
 * JS layer. Identical to what IncomingCallFirebaseService handles today.
 */
export function buildFcmDataFromPayload(payload: Record<string, unknown>): Record<string, string> {
  const data: Record<string, string> = { body: JSON.stringify(payload) };
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    data[k] = String(v);
  }
  return data;
}

/**
 * Error thrown by sendFcmDirectData, carrying enough structure for callers to
 * act on Google's token contract without string-matching the message.
 * `unregistered: true` means FCM answered HTTP 404 UNREGISTERED — the token is
 * PERMANENTLY dead per Google's documented contract (app uninstalled / data
 * cleared / token rotated away). A live install re-registers on its next app
 * open (`/mobile/devices/register` sets active:true on every branch), so
 * callers may retire the device row on this signal.
 */
export class FcmSendError extends Error {
  status: number;
  unregistered: boolean;
  constructor(message: string, status: number, unregistered: boolean) {
    super(message);
    this.status = status;
    this.unregistered = unregistered;
  }
}

export type FcmSendOptions = {
  /**
   * Android delivery priority. Defaults to HIGH — the Doze-exempt channel that
   * call-critical pushes (INCOMING_CALL, ring-time WAKEs, INVITE_CANCELED)
   * REQUIRE to beat the ring window. ⛔ Never default this to NORMAL.
   *
   * NORMAL exists for the worker's registration-watchdog recovery wakes ONLY:
   * Android budgets high-priority pushes per app per day (standby buckets,
   * ~10/day for a rarely-opened app) and silently demotes the overflow — the
   * watchdog alone burned ~62 invisible HIGH pushes/day on one device
   * (Relax Tires T25_101, census 2026-09-01), spending the quota the actual
   * ring pushes needed. A recovery wake is not time-critical: a Doze-deferred
   * delivery still revives a truly dead device within minutes, which is all
   * the Luxure 2026-07-30 incident needed.
   */
  priority?: "HIGH" | "NORMAL";
  /** FCM ttl string, e.g. "45s". Defaults to 45s (the invite window). */
  ttl?: string;
};

/** Send one data message. Throws on any failure — caller falls back to Expo. */
export async function sendFcmDirectData(
  deviceToken: string,
  data: Record<string, string>,
  options?: FcmSendOptions,
): Promise<void> {
  const sa = loadServiceAccount();
  if (!sa) throw new Error("fcm direct not configured");
  const accessToken = await getAccessToken(sa);
  const priority = options?.priority ?? "HIGH";
  const ttl = options?.ttl ?? "45s";
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { token: deviceToken, data, android: { priority, ttl } } }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    // FCM v1 answers 404 with errorCode UNREGISTERED for a dead token. Only a
    // 404 counts — a 400 INVALID_ARGUMENT can be OUR bug and must never retire
    // a device row.
    const unregistered = res.status === 404 && /UNREGISTERED/i.test(text);
    throw new FcmSendError(`fcm send ${res.status}: ${text}`, res.status, unregistered);
  }
}
