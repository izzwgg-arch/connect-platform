/**
 * Automatic SIP/WebRTC provisioning for Connect users.
 *
 * This module is additive — the big `/admin/users` handler in server.ts keeps working
 * unchanged. We layer provisioning concerns on top:
 *
 *   - GET  /admin/users/catalog
 *       Modern replacement for the dropdown bits of /admin/users (tenants, roles,
 *       extensions) that filters to real customer tenants + honours the
 *       user-facing-only extension toggle and returns portal-bucket roles.
 *
 *   - GET  /voice/me/softphone-config
 *       Alias of /voice/me/extension with the name called for in the spec, plus
 *       provisionStatus so the portal softphone UI can show "Pending — click
 *       Activate".
 *
 *   - POST /admin/users/:id/phone/provision        — mark provisioned if creds exist
 *   - POST /admin/users/:id/phone/sync             — re-run pbx sync for that tenant
 *   - POST /admin/users/:id/phone/regenerate       — Wire password reset (requires confirm)
 *   - POST /admin/users/:id/phone/disable          — clear webrtcEnabled + DISABLED
 *
 * Password material is never returned from any admin action — only
 * /voice/me/reset-sip-password ever hands back the raw SIP password, and only to
 * the logged-in owner of the extension.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  PORTAL_ROLE_BUCKETS,
  portalBucketFromJwtRole,
  portalBucketLabel,
  type PortalRoleBucket,
} from "./userManagementRoles";

// These types are intentionally loose (`any`) because the actual getUser /
// requirePermission / canManageUsers in server.ts are typed with the server's
// internal JwtUser shape. Trying to redeclare JwtUser here creates a "two
// different types with this name" TS error. This module treats the DI callbacks
// as opaque.
type Deps = {
  getUser: (req: any) => any;
  requirePermission: (req: any, reply: any, check: (actor: any) => boolean) => Promise<any | null>;
  canManageUsers: (actor: any) => boolean;
  resolveManagedTenant: (actor: any, requestedTenantId?: string | null) => Promise<string>;
  /**
   * Kick off a full VitalPBX → Connect extension sync for a tenant. The server
   * passes a wrapper that already knows how to resolve the tenant's pbxInstance
   * and VitalPbxClient, so this module only needs to hand a tenantId.
   */
  syncExtensionsFromPbx: (tenantId: string) => Promise<unknown>;
  /**
   * Best-effort audit — reuses the same audit() helper in server.ts. Types are
   * intentionally relaxed so any subset of fields works (server.ts's version is
   * stricter and rejects some null tenantIds, so we let the caller supply them).
   */
  audit: (entry: {
    tenantId: string;
    actorUserId?: string;
    targetUserId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void> | void;
  /**
   * Wire password reset (callback to server.ts's getWirePbxClient().resetPassword).
   * Kept as a dependency so this module does not have to know about the integrations package.
   */
  resetSipPasswordOnPbx: (pbxExtensionLinkId: string) => Promise<{ sipPassword: string } | null>;
  createWebrtcDeviceOnPbx: (pbxExtensionLinkId: string) => Promise<{ pbxDeviceId: string; sipUsername: string; sipPassword: string } | null>;
  encryptJson: <T>(value: T) => string;
};

const USER_FACING_EXTENSION_PATTERN = /^[0-9]{3,4}$/;
const NON_USER_FACING_NAME_PATTERNS = [
  /provision/i,
  /qa\b/i,
  /test\b/i,
  /\bfax\b/i,
  /paging/i,
  /door\b/i,
  /ring\s*group/i,
  /\bivr\b/i,
  /smoke/i,
  /system/i,
];

const CUSTOMER_TENANT_NAME_PATTERNS_DENY = [
  /smoke/i,
  /sanity/i,
  /\be2e\b/i,
  /fixture/i,
  /dummy/i,
  /scratch/i,
];

function isLikelyUserFacingExtension(ext: {
  extNumber?: string | null;
  displayName?: string | null;
  status?: string | null;
  pbxLink?: { webrtcEnabled?: boolean | null } | null;
}): boolean {
  const num = String(ext.extNumber || "").trim();
  if (!USER_FACING_EXTENSION_PATTERN.test(num)) return false;
  const name = String(ext.displayName || "").trim();
  for (const pat of NON_USER_FACING_NAME_PATTERNS) if (pat.test(name)) return false;
  if (ext.status && String(ext.status).toUpperCase() === "DELETED") return false;
  return true;
}

function tenantNameLooksLikeCustomer(name: string | null | undefined): boolean {
  const n = String(name || "").trim();
  if (!n) return false;
  for (const pat of CUSTOMER_TENANT_NAME_PATTERNS_DENY) if (pat.test(n)) return false;
  return true;
}

export function registerUserExtensionProvisioningRoutes(app: FastifyInstance, deps: Deps): void {
  // -----------------------------------------------------------------------
  // GET /admin/users/catalog
  //   tenants filtered to kind=CUSTOMER (+ approved + sane name)
  //   roles returned as the 3 portal buckets
  //   extensions either user-facing or all (userFacingOnly=true default)
  // -----------------------------------------------------------------------
  app.get("/admin/users/catalog", async (req, reply) => {
    const admin = await deps.requirePermission(req, reply, deps.canManageUsers);
    if (!admin) return;
    const q = z
      .object({
        tenantId: z.string().optional(),
        userFacingOnly: z.union([z.boolean(), z.string()]).optional(),
        includeAllTenantKinds: z.union([z.boolean(), z.string()]).optional(),
      })
      .parse(req.query || {});

    const userFacingOnly =
      q.userFacingOnly === undefined
        ? true
        : typeof q.userFacingOnly === "string"
          ? q.userFacingOnly !== "false"
          : !!q.userFacingOnly;

    const includeAllKinds =
      admin.role === "SUPER_ADMIN" &&
      (typeof q.includeAllTenantKinds === "string"
        ? q.includeAllTenantKinds === "true"
        : !!q.includeAllTenantKinds);

    const tenantWhere: Record<string, unknown> =
      admin.role === "SUPER_ADMIN"
        ? includeAllKinds
          ? {}
          : { kind: "CUSTOMER", isApproved: true }
        : { id: admin.tenantId };

    const tenants = await db.tenant.findMany({
      where: tenantWhere,
      orderBy: { name: "asc" },
      select: { id: true, name: true, kind: true, isApproved: true },
    });

    const filteredTenants = tenants
      .filter((t) => includeAllKinds || tenantNameLooksLikeCustomer(t.name))
      .map((t) => ({
        id: t.id,
        name: t.name,
        kind: (t as { kind?: string }).kind || "CUSTOMER",
        status: t.isApproved === false ? "SUSPENDED" : "ACTIVE",
      }));

    const tenantId = await deps
      .resolveManagedTenant(admin, q.tenantId || filteredTenants[0]?.id || null)
      .catch(() => null);

    const extensions = tenantId
      ? await db.extension.findMany({
          where: { tenantId, status: { not: "DELETED" } },
          orderBy: { extNumber: "asc" },
          include: {
            pbxLink: {
              select: {
                webrtcEnabled: true,
                pbxDeviceName: true,
                provisionStatus: true,
              },
            },
          } as any,
          take: 1000,
        })
      : [];

    const shapedExtensions = extensions.map((e: any) => ({
      id: e.id,
      extNumber: e.extNumber,
      displayName: e.displayName,
      status: e.status,
      ownerUserId: e.ownerUserId,
      pbxUserEmail: e.pbxUserEmail,
      webrtcEnabled: !!e.pbxLink?.webrtcEnabled,
      pbxDeviceName: e.pbxLink?.pbxDeviceName || null,
      provisionStatus: e.pbxLink?.provisionStatus || null,
      isUserFacing: isLikelyUserFacingExtension(e),
    }));

    const visibleExtensions = userFacingOnly
      ? shapedExtensions.filter((e) => e.isUserFacing)
      : shapedExtensions;

    return {
      tenantId,
      tenants: filteredTenants,
      roles: PORTAL_ROLE_BUCKETS.map((b) => ({ id: b, label: portalBucketLabel(b) })),
      extensions: visibleExtensions,
      userFacingOnly,
      totalExtensions: shapedExtensions.length,
      filteredOut: shapedExtensions.length - visibleExtensions.length,
    };
  });

  // -----------------------------------------------------------------------
  // GET /voice/me/softphone-config — alias of /voice/me/extension, with
  // provisioning metadata. Returns ONLY the logged-in user's own extension.
  // No raw SIP password ever leaves this endpoint.
  // -----------------------------------------------------------------------
  app.get("/voice/me/softphone-config", async (req, reply) => {
    const user = deps.getUser(req);
    const row = await db.pbxExtensionLink.findFirst({
      where: { tenantId: user.tenantId, extension: { ownerUserId: user.sub } },
      include: { extension: { select: { extNumber: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!row) return reply.status(404).send({ error: "EXTENSION_NOT_ASSIGNED" });

    return {
      extensionNumber: row.extension.extNumber,
      endpointName: (row as any).pbxDeviceName || row.pbxSipUsername,
      displayName: row.extension.displayName,
      sipUsername: row.pbxSipUsername,
      authUsername: (row as any).pbxDeviceName || row.pbxSipUsername,
      hasSipPassword: !!(row as any).sipPasswordEncrypted,
      webrtcEnabled: !!row.webrtcEnabled,
      provisionStatus: (row as any).provisionStatus || "PENDING",
      provisionSource: (row as any).provisionSource || null,
      lastProvisionedAt: (row as any).lastProvisionedAt || null,
      isSuspended: !!row.isSuspended,
    };
  });

  // -----------------------------------------------------------------------
  // Shared lookup for admin phone actions
  // -----------------------------------------------------------------------
  async function loadLinkForAdminAction(
    req: any,
    reply: any,
  ): Promise<
    | {
        admin: any;
        user: { id: string; tenantId: string; email: string; displayName: string | null };
        link: any;
      }
    | null
  > {
    const admin = await deps.requirePermission(req, reply, deps.canManageUsers);
    if (!admin) return null;
    const { id } = req.params as { id: string };
    const target = await db.user.findUnique({
      where: { id },
      select: { id: true, tenantId: true, email: true, displayName: true },
    });
    if (!target) {
      reply.code(404).send({ error: "user_not_found" });
      return null;
    }
    if (admin.role !== "SUPER_ADMIN" && target.tenantId !== admin.tenantId) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    const extension = await db.extension.findFirst({
      where: { ownerUserId: target.id, tenantId: target.tenantId },
      include: { pbxLink: true } as any,
    });
    if (!extension || !(extension as any).pbxLink) {
      reply.code(404).send({ error: "extension_not_linked_to_pbx" });
      return null;
    }
    return { admin, user: target, link: (extension as any).pbxLink };
  }

  // GET /admin/users/:id/phone/status
  //   Read-only. Returns everything the detail panel needs (status, source,
  //   endpoint name, extension number, last sync). Never includes passwords.
  app.get("/admin/users/:id/phone/status", async (req, reply) => {
    const ctx = await loadLinkForAdminAction(req, reply);
    if (!ctx) return;
    const ext = await db.extension.findFirst({
      where: { ownerUserId: ctx.user.id, tenantId: ctx.user.tenantId },
      select: { extNumber: true },
    });
    return {
      provisionStatus: (ctx.link as any).provisionStatus || "PENDING",
      provisionSource: (ctx.link as any).provisionSource || null,
      hasSipPassword: !!(ctx.link as any).sipPasswordEncrypted,
      webrtcEnabled: !!ctx.link.webrtcEnabled,
      endpointName: (ctx.link as any).pbxDeviceName || ctx.link.pbxSipUsername || null,
      extensionNumber: ext?.extNumber || null,
      lastProvisionedAt: (ctx.link as any).lastProvisionedAt || null,
    };
  });

  // POST /admin/users/:id/phone/provision
  //   Lightweight: validates that the link exists and has a usable SIP secret,
  //   flips provisionStatus to PROVISIONED (or FAILED). Never resets the
  //   extension password — safe for tenants with live desk phones.
  app.post("/admin/users/:id/phone/provision", async (req, reply) => {
    const ctx = await loadLinkForAdminAction(req, reply);
    if (!ctx) return;

    const hasPassword = !!(ctx.link as any).sipPasswordEncrypted;
    const nextStatus = hasPassword ? "PROVISIONED" : "PENDING";
    const nextSource = hasPassword
      ? (ctx.link as any).provisionSource || "PBX_EXISTING"
      : (ctx.link as any).provisionSource || null;

    await db.pbxExtensionLink.update({
      where: { id: ctx.link.id },
      data: {
        provisionStatus: nextStatus as any,
        provisionSource: nextSource as any,
        lastProvisionedAt: hasPassword ? new Date() : (ctx.link as any).lastProvisionedAt,
      } as any,
    });
    await deps.audit({
      tenantId: ctx.user.tenantId,
      actorUserId: ctx.admin.sub,
      targetUserId: ctx.user.id,
      action: "USER_PHONE_PROVISION_MARKED",
      entityType: "PbxExtensionLink",
      entityId: ctx.link.id,
      metadata: { nextStatus, hasPassword },
    });

    return {
      ok: true,
      provisionStatus: nextStatus,
      hasSipPassword: hasPassword,
      endpointName: (ctx.link as any).pbxDeviceName || ctx.link.pbxSipUsername,
    };
  });

  // POST /admin/users/:id/phone/sync
  //   Re-run the full PBX → Connect sync for the user's tenant. Honest about
  //   the result:
  //     - If VitalPBX reports a WebRTC device with a secret → PROVISIONED.
  //     - If VitalPBX only reports a desk/mobile device → NO_WEBRTC_DEVICE_ON_PBX
  //       (admin must flip the WebRTC Client flag in VitalPBX — the v4 public
  //       API does not expose device creation, so we cannot do it for them).
  app.post("/admin/users/:id/phone/sync", async (req, reply) => {
    const ctx = await loadLinkForAdminAction(req, reply);
    if (!ctx) return;

    try {
      await deps.syncExtensionsFromPbx(ctx.user.tenantId);
    } catch (err: any) {
      await deps.audit({
        tenantId: ctx.user.tenantId,
        actorUserId: ctx.admin.sub,
        targetUserId: ctx.user.id,
        action: "USER_PHONE_SYNC_FAILED",
        entityType: "PbxExtensionLink",
        entityId: ctx.link.id,
        metadata: { error: String(err?.message || err) },
      });
      return reply.code(502).send({ error: "pbx_sync_failed", message: String(err?.message || err) });
    }

    let refreshed = await db.pbxExtensionLink.findUnique({ where: { id: ctx.link.id } });
    let hasPassword = !!(refreshed as any)?.sipPasswordEncrypted;
    let webrtcEnabled = !!(refreshed as any)?.webrtcEnabled;
    let createdWebrtcDevice = false;

    // Best-effort attempt: ask WirePBX (which in turn calls the VitalPBX
    // device-create endpoint — may 404 on real VitalPBX 4 installs). If it
    // succeeds, great. If not, we fall through to the truthful error below.
    if (!webrtcEnabled || !hasPassword) {
      try {
        const out = await deps.createWebrtcDeviceOnPbx(ctx.link.id);
        if (out?.sipPassword) {
          const encrypted = deps.encryptJson<string>(out.sipPassword);
          refreshed = await db.pbxExtensionLink.update({
            where: { id: ctx.link.id },
            data: {
              pbxDeviceId: out.pbxDeviceId || (refreshed as any)?.pbxDeviceId || null,
              pbxSipUsername: out.sipUsername || (refreshed as any)?.pbxSipUsername,
              pbxDeviceName: out.sipUsername || (refreshed as any)?.pbxDeviceName || null,
              sipPasswordEncrypted: encrypted,
              sipPasswordIssuedAt: new Date(),
              webrtcEnabled: true,
              provisionStatus: "PROVISIONED" as any,
              provisionSource: "PBX_GENERATED" as any,
              lastProvisionedAt: new Date(),
            } as any,
          });
          hasPassword = true;
          webrtcEnabled = true;
          createdWebrtcDevice = true;
        }
      } catch (err: any) {
        await deps.audit({
          tenantId: ctx.user.tenantId,
          actorUserId: ctx.admin.sub,
          targetUserId: ctx.user.id,
          action: "USER_PHONE_WEBRTC_CREATE_FAILED",
          entityType: "PbxExtensionLink",
          entityId: ctx.link.id,
          metadata: { error: String(err?.message || err) },
        });
      }
    }

    refreshed = await db.pbxExtensionLink.findUnique({ where: { id: ctx.link.id } });
    hasPassword = !!(refreshed as any)?.sipPasswordEncrypted;
    webrtcEnabled = !!(refreshed as any)?.webrtcEnabled;

    // Persist the truthful state: we only call the link PROVISIONED when BOTH
    // a real WebRTC device exists on VitalPBX AND we have its password.
    const ready = webrtcEnabled && hasPassword;
    await db.pbxExtensionLink.update({
      where: { id: ctx.link.id },
      data: {
        provisionStatus: (ready ? "PROVISIONED" : "PENDING") as any,
        provisionSource: (ready ? (createdWebrtcDevice ? "PBX_GENERATED" : "PBX_EXISTING") : null) as any,
        lastProvisionedAt: new Date(),
      } as any,
    });

    if (!ready) {
      const ext = await db.extension.findFirst({
        where: { ownerUserId: ctx.user.id, tenantId: ctx.user.tenantId },
        select: { extNumber: true },
      });
      await deps.audit({
        tenantId: ctx.user.tenantId,
        actorUserId: ctx.admin.sub,
        targetUserId: ctx.user.id,
        action: "USER_PHONE_SYNC_NO_WEBRTC",
        entityType: "PbxExtensionLink",
        entityId: ctx.link.id,
        metadata: { webrtcEnabled, hasPassword },
      });
      const extLabel = ext?.extNumber || "this extension";
      const reason = !webrtcEnabled
        ? "NO_WEBRTC_DEVICE_ON_PBX"
        : "SIP_CREDENTIAL_NOT_SET";
      const message = !webrtcEnabled
        ? `VitalPBX extension ${extLabel} has no WebRTC device. Open VitalPBX → PBX → Extensions → ${extLabel} → Devices and add a new device whose name ends in "_1" (for example T7_${extLabel}_1) with "WebRTC Client: Yes" enabled. Save + Apply Changes, then click Sync SIP again.`
        : `VitalPBX extension ${extLabel} has a WebRTC device, but no SIP secret was returned. Open VitalPBX → Extensions → ${extLabel} → Devices → the "_1" device, regenerate its password, Apply Changes, then click Sync SIP again.`;
      return reply.code(409).send({
        error: reason,
        message,
        provisionStatus: "PENDING",
        webrtcEnabled,
        hasSipPassword: hasPassword,
        endpointName: (refreshed as any)?.pbxDeviceName || (refreshed as any)?.pbxSipUsername || null,
      });
    }

    await deps.audit({
      tenantId: ctx.user.tenantId,
      actorUserId: ctx.admin.sub,
      targetUserId: ctx.user.id,
      action: "USER_PHONE_SYNC_OK",
      entityType: "PbxExtensionLink",
      entityId: ctx.link.id,
    });

    return {
      ok: true,
      provisionStatus: "PROVISIONED",
      hasSipPassword: true,
      webrtcEnabled: true,
      createdWebrtcDevice,
      endpointName: (refreshed as any)?.pbxDeviceName || (refreshed as any)?.pbxSipUsername || null,
    };
  });

  // POST /admin/users/:id/phone/regenerate
  //   DANGEROUS — issues a fresh SIP password on VitalPBX, which will break any
  //   desk phone still using the old password. Requires explicit body:
  //     { confirm: true, acknowledgeBreaksExistingPhones: true }
  //   Never returns the raw password — only the fact that it was reset and
  //   encrypted. The user's portal softphone will pick up the new password on
  //   next reset-sip-password call.
  app.post("/admin/users/:id/phone/regenerate", async (req, reply) => {
    const ctx = await loadLinkForAdminAction(req, reply);
    if (!ctx) return;
    const body = z
      .object({
        confirm: z.literal(true),
        acknowledgeBreaksExistingPhones: z.literal(true),
      })
      .safeParse(req.body || {});
    if (!body.success) {
      return reply.code(400).send({
        error: "confirmation_required",
        message:
          "Regenerating the SIP password will disconnect any desk phone still using the previous secret. Call with { confirm: true, acknowledgeBreaksExistingPhones: true } to proceed.",
      });
    }

    try {
      const out = await deps.resetSipPasswordOnPbx(ctx.link.id);
      if (!out?.sipPassword) {
        return reply.code(502).send({ error: "pbx_reset_returned_empty" });
      }
      const encrypted = deps.encryptJson<string>(out.sipPassword);
      await db.pbxExtensionLink.update({
        where: { id: ctx.link.id },
        data: {
          sipPasswordEncrypted: encrypted,
          sipPasswordIssuedAt: new Date(),
          provisionStatus: "PROVISIONED" as any,
          provisionSource: "PBX_GENERATED" as any,
          lastProvisionedAt: new Date(),
        } as any,
      });
    } catch (err: any) {
      await db.pbxExtensionLink
        .update({
          where: { id: ctx.link.id },
          data: { provisionStatus: "FAILED" as any } as any,
        })
        .catch(() => undefined);
      await deps.audit({
        tenantId: ctx.user.tenantId,
        actorUserId: ctx.admin.sub,
        targetUserId: ctx.user.id,
        action: "USER_PHONE_REGEN_FAILED",
        entityType: "PbxExtensionLink",
        entityId: ctx.link.id,
        metadata: { error: String(err?.message || err) },
      });
      return reply.code(502).send({ error: "pbx_reset_failed", message: String(err?.message || err) });
    }

    await deps.audit({
      tenantId: ctx.user.tenantId,
      actorUserId: ctx.admin.sub,
      targetUserId: ctx.user.id,
      action: "USER_PHONE_REGENERATED",
      entityType: "PbxExtensionLink",
      entityId: ctx.link.id,
    });

    return {
      ok: true,
      provisionStatus: "PROVISIONED",
      provisionSource: "PBX_GENERATED",
      endpointName: (ctx.link as any).pbxDeviceName || ctx.link.pbxSipUsername,
    };
  });

  // POST /admin/users/:id/phone/disable
  //   Keep the PBX extension alive (desk phones unaffected) but block the
  //   portal softphone path: webrtcEnabled=false, provisionStatus=DISABLED.
  app.post("/admin/users/:id/phone/disable", async (req, reply) => {
    const ctx = await loadLinkForAdminAction(req, reply);
    if (!ctx) return;

    await db.pbxExtensionLink.update({
      where: { id: ctx.link.id },
      data: {
        webrtcEnabled: false,
        provisionStatus: "DISABLED" as any,
        lastProvisionedAt: new Date(),
      } as any,
    });
    await deps.audit({
      tenantId: ctx.user.tenantId,
      actorUserId: ctx.admin.sub,
      targetUserId: ctx.user.id,
      action: "USER_PHONE_DISABLED",
      entityType: "PbxExtensionLink",
      entityId: ctx.link.id,
    });
    return { ok: true, provisionStatus: "DISABLED", webrtcEnabled: false };
  });
}

export { PORTAL_ROLE_BUCKETS, portalBucketFromJwtRole };
