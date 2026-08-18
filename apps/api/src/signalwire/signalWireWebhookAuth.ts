/**
 * SignalWire inbound webhook authorization — FAIL CLOSED.
 *
 * SignalWire's Compatibility API signs every webhook it sends with
 * `X-SignalWire-Signature`, using the Twilio scheme: HMAC-SHA1 over the full
 * request URL followed by every POST parameter's name+value in sorted key
 * order, base64-encoded. The HMAC key is the project's SIGNING KEY (the
 * dashboard's "Credentials" page; also returned once when a subproject is
 * created). SignalWire's own SDK exposes it as `RestClient.validateRequest(
 * signingKey, signature, url, params)` — the same function Twilio ships.
 *
 * ⛔ Same rule as `voipMsWebhookAuth.ts`, for the same reason: `POST
 * /webhooks/signalwire/sms` is on the JWT bypass list, i.e. PUBLIC. A
 * "no key configured ⇒ allow" branch would let anyone who knows one of our
 * numbers inject a message into that number's log from any sender they like.
 * No key = refuse. No signature header = refuse. Wrong = refuse.
 *
 * ⛔ Not gated on NODE_ENV — the api container sets none (CLAUDE.md, the
 * api-container-no-node-env class).
 *
 * The URL SignalWire signed is the URL IT requested — the public one behind
 * nginx (`https://app…/api/webhooks/signalwire/sms`), not what Fastify sees
 * (`/webhooks/signalwire/sms` on :3001). The caller therefore passes the
 * candidate public URLs and this tries each; a mismatch between the URL we
 * think we published and the one SignalWire actually called is by far the
 * most common reason a correct key still fails to verify, so `explain()`
 * exists to say which of the two it was.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

function secureEq(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** The Twilio/SignalWire signature for one URL + parameter set. */
export function computeSignalWireSignature(signingKey: string, url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return createHmac("sha1", signingKey).update(Buffer.from(data, "utf8")).digest("base64");
}

export interface SignalWireWebhookAuthInput {
  /** The project's signing key, or null when none is configured. */
  signingKey: string | null | undefined;
  /** `X-SignalWire-Signature` header (SignalWire also mirrors it as `X-Twilio-Signature`). */
  signature: string | null | undefined;
  /**
   * Every URL SignalWire might have signed for this request. The public one
   * (scheme + host from X-Forwarded-*, path + query as received) first.
   */
  candidateUrls: string[];
  /** POST body parameters (form-encoded). Empty for GET — the query is in the URL. */
  params: Record<string, string>;
}

/** True only when a key is configured AND the presented signature matches one candidate URL. */
export function isSignalWireWebhookAuthorized(input: SignalWireWebhookAuthInput): boolean {
  const key = String(input.signingKey ?? "").trim();
  if (!key) return false;
  const sig = String(input.signature ?? "").trim();
  if (!sig) return false;
  for (const url of input.candidateUrls) {
    if (!url) continue;
    if (secureEq(computeSignalWireSignature(key, url, input.params), sig)) return true;
  }
  return false;
}

/** Why a request was refused, for the audit row — never the key, never the signature. */
export function explainRefusal(input: SignalWireWebhookAuthInput): "no_signing_key" | "no_signature" | "signature_mismatch" {
  if (!String(input.signingKey ?? "").trim()) return "no_signing_key";
  if (!String(input.signature ?? "").trim()) return "no_signature";
  return "signature_mismatch";
}

/**
 * Rebuild the URL SignalWire called from what nginx forwarded. Fastify sees
 * `/webhooks/signalwire/sms?…` on the container; SignalWire signed
 * `https://<public host>/api/webhooks/signalwire/sms?…`. Both the `/api`-
 * prefixed and bare forms are returned because nginx strips the prefix on some
 * vhosts and not others.
 */
export function candidatePublicUrls(req: {
  headers: Record<string, unknown>;
  url: string;
  hostname?: string;
  protocol?: string;
}): string[] {
  const h = req.headers ?? {};
  const first = (v: unknown) => String(Array.isArray(v) ? v[0] : v ?? "").split(",")[0].trim();
  const proto = first(h["x-forwarded-proto"]) || req.protocol || "https";
  const host = first(h["x-forwarded-host"]) || first(h["host"]) || req.hostname || "";
  const pathAndQuery = String(req.url || "");
  if (!host) return [];
  const bare = `${proto}://${host}${pathAndQuery}`;
  const prefixed = pathAndQuery.startsWith("/api/") ? bare : `${proto}://${host}/api${pathAndQuery}`;
  const out = [prefixed, bare];
  // Some senders sign the https form even when the hop to us was http.
  if (proto !== "https") out.push(prefixed.replace(/^http:/, "https:"), bare.replace(/^http:/, "https:"));
  return Array.from(new Set(out));
}
