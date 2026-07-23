/**
 * X2 — the real G3 scope resolver for the Modify Executor (X1 shipped an
 * always-refuse stub; this replaces it).
 *
 * Proves, against the Connect DB mirror (NEVER against chat/LLM claims), that
 * the (vital PBX tenant, objectType, objectId) triple belongs to the requester:
 *   - customer: requester's User row → their Connect tenant → TenantPbxLink →
 *     the vital tenant id MUST equal the op's tenantId, then the object must
 *     exist under that Connect tenant.
 *   - owner (Izzy): may target any KNOWN tenant (TenantPbxLink row must exist)
 *     and the object must exist under it.
 *
 * FAIL-CLOSED: unknown objectType ⇒ false. Each M/E roadmap item adds its own
 * objectType mapping here under its own spec + certification — never earlier.
 */
import type { ScopeCheck } from "./modifyExecutor";

/** objectTypes with a proven mirror lookup. Grows one item at a time (M1, M3, …). */
export const MAPPED_OBJECT_TYPES = ["tenant", "extension", "inbound_did", "moh_tenant"] as const;

export function makeScopeCheck(prisma: any): ScopeCheck {
  return async ({ tenantId, objectType, objectId, requestedBy, requestedRole, params }) => {
    try {
      // 1) Resolve the requester → allowed Connect tenant (or owner override).
      const [, userId] = requestedBy.split(":", 2);
      let connectTenantId: string | null = null;

      if (requestedRole === "owner") {
        // Platform owner: any KNOWN tenant, but it must actually be linked.
        const link = await prisma.tenantPbxLink.findFirst({ where: { pbxTenantId: String(tenantId) }, select: { tenantId: true } });
        if (!link) return false;
        connectTenantId = link.tenantId;
      } else {
        if (!userId) return false;
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true, status: true } });
        if (!user || user.status !== "ACTIVE") return false;
        const link = await prisma.tenantPbxLink.findUnique({ where: { tenantId: user.tenantId }, select: { pbxTenantId: true } });
        // The op's vital tenant MUST be the requester's own linked PBX tenant.
        if (!link?.pbxTenantId || String(link.pbxTenantId) !== String(tenantId)) return false;
        connectTenantId = user.tenantId;
      }

      // 2) The object must exist under that Connect tenant, per mapped type.
      switch (objectType) {
        case "tenant":
          return String(objectId) === String(tenantId);
        case "moh_tenant": {
          // M1: the tenant's MOH slot IS the object (objectId === vital tenant),
          // and when a profile is referenced it must belong to this tenant.
          if (String(objectId) !== String(tenantId)) return false;
          const profileId = params?.profileId;
          if (profileId != null) {
            const profile = await prisma.mohProfile.findFirst({
              where: { id: String(profileId), tenantId: connectTenantId },
              select: { id: true },
            });
            if (!profile) return false;
          }
          return true;
        }
        case "extension": {
          const ext = await prisma.extension.findFirst({
            where: { tenantId: connectTenantId, extNumber: String(objectId) },
            select: { id: true },
          });
          return !!ext;
        }
        case "inbound_did": {
          const digits = String(objectId).replace(/[^\d+]/g, "");
          const byE164 = await prisma.pbxTenantInboundDid.findFirst({
            where: { vitalTenantId: String(tenantId), e164: digits, active: true },
            select: { id: true },
          });
          if (byE164) return true;
          const owned = await prisma.phoneNumber.findFirst({
            where: { tenantId: connectTenantId, phoneNumber: digits, status: "ACTIVE" },
            select: { id: true },
          });
          return !!owned;
        }
        default:
          return false; // fail-closed: unmapped objectType
      }
    } catch {
      return false; // fail-closed on any DB error
    }
  };
}
