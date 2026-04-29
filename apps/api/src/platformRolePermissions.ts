import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";

const SNAPSHOT_ID = "default";

export const PORTAL_PERMISSION_KEYS = [
  "can_view_dashboard",
  "can_view_team",
  "can_edit_team",
  "can_view_chat",
  "can_view_sms",
  "can_send_sms",
  "can_view_calls",
  "can_view_live_calls",
  "can_view_voicemail",
  "can_delete_voicemail",
  "can_view_contacts",
  "can_manage_contacts",
  "can_view_recordings",
  "can_download_recordings",
  "can_view_reports",
  "can_view_settings",
  "can_manage_call_forwarding",
  "can_manage_blfs",
  "can_view_admin",
  "can_manage_integrations",
  "can_manage_voip_ms",
  "can_assign_sms_numbers",
  "can_sync_voip_ms_numbers",
  "can_switch_tenants",
  "can_manage_tenant_settings",
  "can_manage_global_settings",
  "can_view_apps",
  "can_download_apk",
  "can_view_ivr_routing",
  "can_manage_ivr_routing",
  "can_publish_ivr_routing",
  "can_override_ivr_routing",
  "can_manage_ivr_prompts",
  "can_view_moh",
  "can_manage_moh",
  "can_publish_moh",
  "can_override_moh",
  "can_upload_moh",
  "can_view_did_routing",
  "can_manage_did_routing",
  "can_publish_did_routing",
  "can_manage_deploys",
] as const;

const PORTAL_PERMISSION_KEYS_SET = new Set<string>(PORTAL_PERMISSION_KEYS);

const PORTAL_ROLE_BUCKETS = ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as const;
type PortalRoleBucket = (typeof PORTAL_ROLE_BUCKETS)[number];

type PortalUser = { sub?: string; tenantId?: string; email?: string; role?: string };

function user(req: any): PortalUser {
  return req.user as PortalUser;
}

async function requireSuperAdminPortal(req: any, reply: any): Promise<PortalUser | null> {
  const u = user(req);
  if (u.role !== "SUPER_ADMIN") {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return u;
}

export function jwtRoleToPortalPermissionBucket(jwtRole: string | undefined): PortalRoleBucket {
  const r = String(jwtRole || "").toUpperCase();
  if (r === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (["ADMIN", "BILLING", "MESSAGING", "SUPPORT"].includes(r)) return "TENANT_ADMIN";
  return "END_USER";
}

function normalizePermissionList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((x) => String(x).trim()).filter(Boolean))].filter((p) =>
    PORTAL_PERMISSION_KEYS_SET.has(p)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

export async function getEffectivePortalPermissionSetForJwtRole(
  jwtRole: string | undefined
): Promise<string[] | null> {
  const bucket = jwtRoleToPortalPermissionBucket(jwtRole);
  let row: { roles: unknown } | null = null;
  try {
    row = await db.platformRolePermissionSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
  } catch {
    return null;
  }
  if (!row || row.roles == null || typeof row.roles !== "object") return null;
  const rawList = (row.roles as Record<string, unknown>)[bucket];
  const list = normalizePermissionList(rawList);
  return list.length ? list : null;
}

export async function registerPlatformRolePermissionRoutes(app: FastifyInstance) {
  app.get("/admin/role-permissions", async (req, reply) => {
    const admin = await requireSuperAdminPortal(req, reply);
    if (!admin) return;
    try {
      const row = await db.platformRolePermissionSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
      const roles = row?.roles && typeof row.roles === "object" ? (row.roles as Record<string, unknown>) : {};
      const permissions: Partial<Record<PortalRoleBucket, string[]>> = {};
      for (const key of PORTAL_ROLE_BUCKETS) {
        const list = normalizePermissionList(roles[key]);
        if (list.length) permissions[key] = list;
      }
      return { permissions };
    } catch (err: any) {
      app.log.error({ err: err?.message }, "role-permissions: read failed");
      return reply.code(500).send({ error: "db_error" });
    }
  });

  app.post("/admin/role-permissions", async (req, reply) => {
    const admin = await requireSuperAdminPortal(req, reply);
    if (!admin) return;

    const body = z
      .object({
        permissions: z.record(z.string(), z.array(z.string())),
      })
      .parse(req.body || {});

    const normalized: Record<PortalRoleBucket, string[]> = {
      END_USER: [],
      TENANT_ADMIN: [],
      SUPER_ADMIN: [],
    };

    for (const key of Object.keys(body.permissions)) {
      if (!PORTAL_ROLE_BUCKETS.includes(key as PortalRoleBucket)) {
        return reply.code(400).send({ error: "invalid_role", message: `Unknown role key: ${key}` });
      }
    }

    for (const bucket of PORTAL_ROLE_BUCKETS) {
      normalized[bucket] = normalizePermissionList(body.permissions[bucket]);
    }

    const superSet = new Set(normalized.SUPER_ADMIN);
    const allSet = new Set(PORTAL_PERMISSION_KEYS);
    if (!setsEqual(superSet, allSet)) {
      return reply.code(400).send({
        error: "invalid_super_admin_permissions",
        message: "Platform Admin must retain the full permission set (all toggles are locked for that column).",
      });
    }

    try {
      await db.platformRolePermissionSnapshot.upsert({
        where: { id: SNAPSHOT_ID },
        create: { id: SNAPSHOT_ID, roles: normalized },
        update: { roles: normalized },
      });
      return { ok: true };
    } catch (err: any) {
      app.log.error({ err: err?.message }, "role-permissions: write failed");
      return reply.code(500).send({ error: "db_error" });
    }
  });
}
