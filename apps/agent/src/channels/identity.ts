/**
 * Channel identity resolution (PLAN.md §4 Channel Gateway).
 * Maps a verified sender (email address, phone) to a Connect identity
 * {tenantId, clientUserId, role}. Used by non-portal channels (email, SMS,
 * WhatsApp) where there's no JWT. The sender must match a known User exactly —
 * an unknown sender resolves to null and the channel declines/《escalates rather
 * than guessing a tenant (tenant isolation is absolute).
 */
import type { Role } from "../conversation/store";
import { mapUserRole } from "../authRoles";

export interface ResolvedIdentity {
  tenantId: string;
  clientUserId: string | null;
  role: Role;
  email?: string;
}

export class IdentityResolver {
  constructor(private prisma: any) {}

  async byEmail(email: string): Promise<ResolvedIdentity | null> {
    const addr = normalizeEmail(email);
    if (!addr) return null;
    try {
      const user = await this.prisma.user.findUnique({ where: { email: addr }, select: { id: true, tenantId: true, role: true, email: true, status: true } });
      if (!user || user.status !== "ACTIVE") return null;
      return { tenantId: user.tenantId, clientUserId: user.id, role: mapRole(user.role), email: user.email };
    } catch {
      return null;
    }
  }

  async byPhone(phone: string): Promise<ResolvedIdentity | null> {
    const p = normalizePhone(phone);
    if (!p) return null;
    try {
      const user = await this.prisma.user.findFirst({ where: { phone: p, status: "ACTIVE" }, select: { id: true, tenantId: true, role: true, email: true } });
      if (!user) return null;
      return { tenantId: user.tenantId, clientUserId: user.id, role: mapRole(user.role), email: user.email };
    } catch {
      return null;
    }
  }
}

export function normalizeEmail(raw: string): string | null {
  // Strip display name: "Sarah G <sarah@x.com>" -> sarah@x.com
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.length >= 7 ? digits : null;
}

/** @deprecated Use mapUserRole from ../authRoles — kept as a thin alias so the
 *  admin definition lives in exactly one place. See authRoles.ts for why
 *  TENANT_ADMIN counts and why the custom "owner" role needs a DB read. */
function mapRole(role: string): Role {
  return mapUserRole(role);
}
