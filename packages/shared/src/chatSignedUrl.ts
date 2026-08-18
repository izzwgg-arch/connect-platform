/**
 * HMAC-signed download URLs for Connect chat attachments (VoIP.ms MMS fetch,
 * inline images, etc.). Payload is distinct from MOH signing to avoid cross-use.
 *
 * ⛔⛔ TWO SECURITY DEFECTS WERE FIXED HERE ON 2026-08-18. Do not undo either.
 * See docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md §3.
 *
 * 1. `buildChatDbSignedDownloadUrl` / `verifyChatDbSignedDownload` used
 *    `crypto.createHash` — an UNKEYED digest. No secret was involved at any
 *    point, so anyone who had seen one message payload (which hands out the
 *    attachment id, storageKey and sizeBytes) could mint a permanent,
 *    self-renewing, unauthenticated download URL for that attachment and
 *    republish it. `exp` was unenforceable. They are keyed HMACs now.
 *
 * 2. `signingSecret()` fell back to the literal "dev-signing-secret", which is
 *    published in this repo. Every variable in the old chain was empty or
 *    undefined in production, so that literal WAS the production key — the
 *    signature authorized nothing and any expired URL could simply be re-signed.
 *
 * ⛔ `""` IS FALSY, so an env var "set" to blank silently fell through `||` to
 * the next candidate with no error and no log line. Every candidate below is
 * therefore checked for emptiness AFTER trimming.
 */

import * as crypto from "node:crypto";

/**
 * Domain-separation label for the derived key. Changing this string rotates
 * every chat signature, so treat it as frozen.
 */
const SIGNING_KEY_DERIVATION_LABEL = "connect:chat-url-signing:v1";

/**
 * Resolve the HMAC key for chat signed URLs.
 *
 * ⛔ THE KEY MUST BE IDENTICAL IN EVERY PROCESS THAT MINTS OR VERIFIES ONE.
 * api mints these (message lists, delivery proofs) and verifies all of them,
 * while the worker also mints them (MMS media URLs handed to VoIP.ms, and the
 * 24h "Media: <link>" fallback links texted to customers). If the two disagree,
 * worker-minted links 401 at the api and the failure is completely silent.
 *
 * ⛔ THAT IS EXACTLY WHAT WAS HAPPENING BEFORE THIS FIX, and it is why the old
 * multi-variable chain is gone: `MOH_URL_SIGNING_SECRET` was EMPTY in app-api-1
 * but SET (43 chars) in app-worker-1, so api signed with "dev-signing-secret"
 * while the worker signed with the MOH secret. Every worker-minted chat link was
 * already unverifiable in production — nginx logs show zero successful fetches of
 * either worker-minted scheme in 14 days.
 *
 * So the chain is deliberately short: one dedicated variable, else a key DERIVED
 * from `JWT_SECRET`. `JWT_SECRET` is verified identical across api, telephony and
 * worker, is 64 chars, and is not in git — so the derivation makes every process
 * agree with no new configuration. It is a derivation, never the raw secret, so
 * a leaked chat URL can never expose the JWT signing key.
 *
 * ⛔ Never add a literal fallback here, and never gate this on NODE_ENV —
 * NODE_ENV is undefined in the api container (CLAUDE.md), so such a gate is
 * permanently false.
 */
function signingSecret(): string {
  const explicit = String(process.env.CHAT_URL_SIGNING_SECRET ?? "").trim();
  if (explicit) return explicit;

  const jwtSecret = String(process.env.JWT_SECRET ?? "").trim();
  if (jwtSecret) {
    return crypto.createHmac("sha256", jwtSecret).update(SIGNING_KEY_DERIVATION_LABEL).digest("hex");
  }

  // ⛔ FAIL CLOSED. Refusing is correct: signing with a guessable constant is
  // indistinguishable from not signing at all.
  throw new Error(
    "chat_url_signing_secret_unavailable: set CHAT_URL_SIGNING_SECRET (or JWT_SECRET) — refusing to sign with a known constant",
  );
}

export function chatSignedPayload(storageKey: string, exp: number): string {
  return `chat:${storageKey}:${exp}`;
}

export function buildChatSignedDownloadUrl(publicBaseUrl: string, storageKey: string, expiresInSec: number = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, expiresInSec);
  const sig = crypto.createHmac("sha256", signingSecret()).update(chatSignedPayload(storageKey, exp)).digest("hex");
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/chat/attachments/download/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

export function chatDbSignedPayload(attachmentId: string, storageKey: string, sizeBytes: number, exp: number): string {
  return `chat-db:${attachmentId}:${storageKey}:${sizeBytes}:${exp}`;
}

export function buildChatDbSignedDownloadUrl(
  publicBaseUrl: string,
  attachmentId: string,
  storageKey: string,
  sizeBytes: number,
  expiresInSec: number = 3600,
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, expiresInSec);
  // ⛔ createHmac, NOT createHash — an unkeyed digest here is a forgeable URL.
  const sig = crypto
    .createHmac("sha256", signingSecret())
    .update(chatDbSignedPayload(attachmentId, storageKey, sizeBytes, exp))
    .digest("hex");
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/chat/attachments/download/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

export function chatAttachmentIdSignedPayload(attachmentId: string, exp: number): string {
  return `chat-attachment:${attachmentId}:${exp}`;
}

function safeUrlFileName(fileName?: string | null): string {
  const cleaned = String(fileName || "media").replace(/[/\\?%*:|"<>]/g, "-").trim();
  return cleaned || "media";
}

export function buildChatAttachmentIdSignedDownloadUrl(
  publicBaseUrl: string,
  attachmentId: string,
  expiresInSec: number = 3600,
  fileName?: string | null,
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, expiresInSec);
  const sig = crypto.createHmac("sha256", signingSecret()).update(chatAttachmentIdSignedPayload(attachmentId, exp)).digest("hex");
  const base = publicBaseUrl.replace(/\/+$/, "");
  const suffix = fileName ? `/${encodeURIComponent(safeUrlFileName(fileName))}` : "";
  return `${base}/chat/a/${encodeURIComponent(attachmentId)}${suffix}?e=${exp}&s=${sig}`;
}

export function verifyChatSignedDownload(
  storageKey: string,
  expRaw: string | undefined,
  sigRaw: string | undefined,
): { ok: true } | { ok: false; reason: "expired" | "invalid" } {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof sigRaw !== "string" || sigRaw.length !== 64) {
    return { ok: false, reason: "invalid" };
  }
  const expected = crypto.createHmac("sha256", signingSecret()).update(chatSignedPayload(storageKey, exp)).digest("hex");
  const a = Buffer.from(sigRaw, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  return { ok: true };
}

export function verifyChatDbSignedDownload(
  attachmentId: string,
  storageKey: string,
  sizeBytes: number,
  expRaw: string | undefined,
  sigRaw: string | undefined,
): { ok: true } | { ok: false; reason: "expired" | "invalid" } {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof sigRaw !== "string" || sigRaw.length !== 64) {
    return { ok: false, reason: "invalid" };
  }
  // ⛔ createHmac, NOT createHash — must mirror buildChatDbSignedDownloadUrl.
  const expected = crypto
    .createHmac("sha256", signingSecret())
    .update(chatDbSignedPayload(attachmentId, storageKey, sizeBytes, exp))
    .digest("hex");
  const a = Buffer.from(sigRaw, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  return { ok: true };
}

export function verifyChatAttachmentIdSignedDownload(
  attachmentId: string,
  expRaw: string | undefined,
  sigRaw: string | undefined,
): { ok: true } | { ok: false; reason: "expired" | "invalid" } {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof sigRaw !== "string" || sigRaw.length !== 64) {
    return { ok: false, reason: "invalid" };
  }
  const expected = crypto.createHmac("sha256", signingSecret()).update(chatAttachmentIdSignedPayload(attachmentId, exp)).digest("hex");
  const a = Buffer.from(sigRaw, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  return { ok: true };
}
