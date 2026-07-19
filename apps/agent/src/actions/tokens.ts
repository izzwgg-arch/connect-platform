/**
 * Signed approval tokens for one-tap email Approve/Deny links (PLAN.md §6).
 * HMAC-SHA256 over {actionId, decision, exp}. No DB lookup needed to verify
 * authenticity, but the action's status is still re-checked at redemption so a
 * token can't approve something already decided/expired.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type Decision = "approve" | "deny";

function secret(): string {
  return process.env.AGENT_APPROVAL_SECRET || process.env.AGENT_INTERNAL_SECRET || "";
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makeApprovalToken(actionId: string, decision: Decision, ttlMs = 4 * 3600 * 1000): string {
  const exp = Date.now() + ttlMs;
  const body = `${actionId}.${decision}.${exp}`;
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${b64url(Buffer.from(body))}.${sig}`;
}

export function verifyApprovalToken(token: string): { actionId: string; decision: Decision } | null {
  const s = secret();
  if (!s) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [bodyB64, sig] = parts;
  let body: string;
  try {
    body = Buffer.from(bodyB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
  const expected = b64url(createHmac("sha256", s).update(body).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [actionId, decision, expStr] = body.split(".");
  if (!actionId || (decision !== "approve" && decision !== "deny")) return null;
  if (Number(expStr) < Date.now()) return null;
  return { actionId, decision };
}
