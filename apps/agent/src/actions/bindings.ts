/**
 * Params-hash approval binding (X1 spec §3.4, docs/ai-support-agent/specs/X1_MODIFY_EXECUTOR_SPEC.md).
 *
 * Closes the approve-then-mutate hole for the modify/repair tier: an approval
 * token is HMAC-bound to a hash of the EXACT change (capability + tenant +
 * frozen params), so a token can approve exactly one execution of exactly the
 * change the owner saw — never a different change, never twice.
 *
 * A/P-series actions keep the legacy unbound tokens (tokens.ts) unchanged.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Decision } from "./tokens";

/** Capabilities whose approvals MUST be params-hash-bound and single-use. */
export function requiresBinding(capabilityId: string): boolean {
  return /^pbx\.M\d/.test(capabilityId) || /^pbx\.E\d/.test(capabilityId) || capabilityId.startsWith("repair.");
}

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;
}

/** The binding hash. objectId is inside params (schema-required per op), so it is covered. */
export function computeParamsHash(capabilityId: string, tenantId: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(`${capabilityId}|${tenantId}|${canonicalJson(params)}`).digest("hex");
}

function secret(): string {
  return process.env.AGENT_APPROVAL_SECRET || process.env.AGENT_INTERNAL_SECRET || "";
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bound token: HMAC over {actionId, decision, exp, paramsHash}. */
export function makeBoundApprovalToken(actionId: string, decision: Decision, paramsHash: string, ttlMs = 4 * 3600 * 1000): string {
  const exp = Date.now() + ttlMs;
  const body = `${actionId}.${decision}.${exp}.${paramsHash}`;
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${b64url(Buffer.from(body))}.${sig}`;
}

export function verifyBoundApprovalToken(token: string): { actionId: string; decision: Decision; paramsHash: string } | null {
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
  const seg = body.split(".");
  if (seg.length !== 4) return null; // legacy unbound tokens are NOT valid here
  const [actionId, decision, expStr, paramsHash] = seg;
  if (!actionId || (decision !== "approve" && decision !== "deny")) return null;
  if (Number(expStr) < Date.now()) return null;
  if (!/^[0-9a-f]{64}$/.test(paramsHash)) return null;
  return { actionId, decision, paramsHash };
}
