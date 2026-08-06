/**
 * Portal JWT verification (HS256, same JWT_SECRET as apps/api).
 * Implemented with node:crypto — no extra deps. Payload shape from the api:
 *   { sub: userId, tenantId, email, role, iat, exp? }
 * Role mapping lives in ./authRoles: SUPER_ADMIN and TENANT_ADMIN are admin
 * ("owner") mode; a custom role named "owner" also counts but needs a DB read,
 * so callers top this up with elevateForCustomOwnerRole().
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "./conversation/store";
import { mapUserRole } from "./authRoles";

export interface AgentIdentity {
  tenantId: string;
  clientUserId: string | null;
  role: Role;
  email?: string;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function verifyPortalJwt(token: string, secret = process.env.JWT_SECRET): AgentIdentity | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header: any;
  let payload: any;
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8"));
    payload = JSON.parse(b64urlDecode(p).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null; // never accept alg confusion
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const got = b64urlDecode(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  if (payload.exp != null && Date.now() / 1000 > payload.exp) return null;
  if (!payload.tenantId || !payload.sub) return null;
  return {
    tenantId: String(payload.tenantId),
    clientUserId: String(payload.sub),
    // SUPER_ADMIN *and* TENANT_ADMIN are admin-grade. A custom role named
    // "owner" also counts, but that needs a DB read the JWT cannot provide —
    // callers top it up with elevateForCustomOwnerRole(). Fails closed here.
    role: mapUserRole(payload.role),
    email: payload.email,
  };
}
