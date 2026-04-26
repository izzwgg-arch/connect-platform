/**
 * HMAC-signed download URLs for Connect chat attachments (VoIP.ms MMS fetch,
 * inline images, etc.). Payload is distinct from MOH signing to avoid cross-use.
 */

import * as crypto from "node:crypto";

function signingSecret(): string {
  return (
    (process.env.CHAT_URL_SIGNING_SECRET || process.env.MOH_URL_SIGNING_SECRET || process.env.CDR_INGEST_SECRET || "dev-signing-secret").trim()
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
