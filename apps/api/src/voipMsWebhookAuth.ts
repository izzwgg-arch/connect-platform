/**
 * VoIP.ms inbound SMS webhook authorization — FAIL CLOSED.
 *
 * ⛔⛔ THIS USED TO FAIL OPEN, AND IT WAS LIVE.
 *   let authorized = !cfg.webhookSecretEncrypted;              // no secret ⇒ authorized
 *   if (!authorized && cfg.webhookSecretEncrypted) return 401; // the 401 was itself
 *                                                              // gated on the secret existing
 * `GlobalVoipMsConfig.webhookSecretEncrypted` has never been set in production, so
 * `POST /webhooks/voipms/sms` (public — it is on the JWT bypass list) accepted
 * anything. Anyone who knew a customer's public DID could inject a message into
 * that customer's SMS inbox from any sender they choose, complete with push
 * notifications to every participant and a CRM timeline entry — a ready-made
 * phishing channel against a customer's own staff.
 * See docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md §2.
 *
 * ⛔ DO NOT reintroduce a "no secret configured ⇒ allow" branch, and do NOT gate
 * this on NODE_ENV — NODE_ENV is undefined in the api container, so a NODE_ENV
 * gate is permanently false (CLAUDE.md, the api-container-no-node-env class).
 *
 * ⛔ WHY FAILING CLOSED DOES NOT STOP REAL INBOUND SMS. Real inbound messages do
 * not arrive here at all — they arrive through the worker's `voipMsInboundSyncJob`
 * poll (CLAUDE.md, the SMS activation runbook). Verified 2026-08-18 against 14
 * days of nginx access logs: all 127 webhook POSTs came from VoIP.ms carrying
 * their own UNSUBSTITUTED template placeholders in the query string
 * (`from={FROM}&to={TO}&message={MESSAGE}`), i.e. the callback template at
 * VoIP.ms was never configured to interpolate. Zero requests carried real data —
 * so zero real messages have ever been ingested through this door.
 *
 * Once a secret IS configured (PUT /admin/apps/voip-ms/credentials with
 * `webhookSecret`), VoIP.ms may present it as the `x-voipms-signature` header or
 * as a `token`/`signature` query/body parameter; any one of the three matching
 * authorizes the request.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time compare for equal-length inputs. Length is compared first
 * because `timingSafeEqual` throws on a length mismatch; that leaks only the
 * length of the presented value, never the secret's bytes.
 *
 * ⛔ The helper this replaces was named `constantTimeEq` but used `Buffer.equals`,
 * which is NOT constant time. Keep `timingSafeEqual`.
 */
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

export interface VoipMsWebhookAuthInput {
  /**
   * The decrypted shared secret, or null/undefined when none is configured or
   * decryption failed. Either of those means REFUSE.
   */
  secret: string | null | undefined;
  /** `x-voipms-signature` request header. */
  headerSignature?: string | null;
  /** `token` query/body parameter. */
  tokenParam?: string | null;
  /** `signature` query/body parameter. */
  signatureParam?: string | null;
}

/**
 * Returns true only when a secret is configured AND the caller presented it.
 * Every other case — no secret, blank secret, whitespace-only secret, failed
 * decryption, wrong value, missing value — returns false.
 */
export function isVoipMsWebhookAuthorized(input: VoipMsWebhookAuthInput): boolean {
  const secret = String(input.secret ?? "").trim();
  // ⛔ FAIL CLOSED — an unconfigured secret authorizes nobody.
  if (!secret) return false;
  return (
    secureEq(String(input.headerSignature ?? ""), secret) ||
    secureEq(String(input.tokenParam ?? ""), secret) ||
    secureEq(String(input.signatureParam ?? ""), secret)
  );
}
