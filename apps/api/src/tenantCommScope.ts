import { db } from "@connect/db";
import { hasEffectivePortalPermission } from "./platformRolePermissions";
import { voicemailRowInOwnedScope, type VoicemailOwnedScope } from "./voicemailResourceScope";

export type JwtUserLite = { sub?: string | null; tenantId?: string | null; role?: string | null };

export type DecisionMode = "super-admin" | "tenant" | "contained-owned";

export async function resolveTenantIdFilterSetLite(requestedTenantId: string | null): Promise<string[]> {
  if (!requestedTenantId || requestedTenantId === "global") return [];

  if (requestedTenantId.startsWith("vpbx:")) {
    const vpbxSlug = requestedTenantId.slice(5).trim();
    const ids: string[] = [requestedTenantId];
    let link = await db.tenantPbxLink.findFirst({ where: { pbxTenantId: vpbxSlug } });
    if (!link) {
      const dir = await db.pbxTenantDirectory.findFirst({ where: { tenantSlug: vpbxSlug } });
      if (dir?.vitalTenantId) {
        link = await db.tenantPbxLink.findFirst({ where: { pbxTenantId: dir.vitalTenantId } });
      }
    }
    if (link?.tenantId) ids.push(link.tenantId);
    return ids;
  }

  const ids: string[] = [requestedTenantId];
  const link = await db.tenantPbxLink.findFirst({ where: { tenantId: requestedTenantId } });
  if (link?.pbxTenantId) {
    const dir = await db.pbxTenantDirectory.findFirst({ where: { vitalTenantId: link.pbxTenantId } });
    if (dir?.tenantSlug) ids.push(`vpbx:${dir.tenantSlug}`);
  }
  return ids;
}

export async function getUserExtensionNumbersLite(user: JwtUserLite): Promise<string[]> {
  if (!user?.tenantId || !user?.sub) return [];
  const rows = await db.extension.findMany({
    where: {
      tenantId: user.tenantId,
      ownerUserId: user.sub,
      status: "ACTIVE",
    },
    select: { extNumber: true },
    orderBy: { extNumber: "asc" },
  });
  return [...new Set(rows.map((r) => String(r.extNumber || "").trim()).filter(Boolean))];
}

export async function resolveVoicemailOwnedScopeForJwtUserLite(user: JwtUserLite): Promise<
  | { ok: true; tenantIds: string[]; extensions: string[] }
  | { ok: false; reason: "missing_tenant_or_sub" | "tenant_unresolved" | "no_owned_mailbox" }
> {
  if (!user.tenantId || !user.sub) return { ok: false, reason: "missing_tenant_or_sub" };
  const tenantIds = (await resolveTenantIdFilterSetLite(user.tenantId)) ?? [];
  if (tenantIds.length === 0) return { ok: false, reason: "tenant_unresolved" };
  const extensions = await getUserExtensionNumbersLite(user);
  if (extensions.length === 0) return { ok: false, reason: "no_owned_mailbox" };
  return { ok: true, tenantIds, extensions };
}

function isSuper(user: JwtUserLite): boolean {
  return String(user.role || "").toUpperCase() === "SUPER_ADMIN";
}

export async function voicemailAccessDecisionForRow(
  vm: { tenantId: string | null; extension: string },
  user: JwtUserLite,
): Promise<{ allowed: boolean; mode: DecisionMode; ownedExtensions?: string[] }> {
  if (isSuper(user)) return { allowed: true, mode: "super-admin" };

  try {
    const hasTenant = await hasEffectivePortalPermission(user as any, "can_view_tenant_voicemails" as any);
    if (hasTenant) {
      const tenantIds = user.tenantId ? await resolveTenantIdFilterSetLite(user.tenantId) : [];
      const ok = vm.tenantId != null && tenantIds.includes(vm.tenantId);
      return { allowed: ok, mode: "tenant" };
    }
  } catch { /* fall through */ }

  const scope = await resolveVoicemailOwnedScopeForJwtUserLite(user);
  if (!scope.ok) return { allowed: false, mode: "contained-owned", ownedExtensions: [] };
  const ownedScope: VoicemailOwnedScope = { tenantIds: scope.tenantIds, extensions: scope.extensions };
  const ok = voicemailRowInOwnedScope(vm, ownedScope);
  return { allowed: ok, mode: "contained-owned", ownedExtensions: scope.extensions };
}

export async function recordingAccessDecision(
  rec: { tenantId: string | null; extension: string | null },
  user: JwtUserLite,
): Promise<{ allowed: boolean; mode: DecisionMode; ownedExtensions?: string[] }> {
  if (isSuper(user)) return { allowed: true, mode: "super-admin" };
  if (rec.tenantId && user.tenantId && rec.tenantId !== user.tenantId) return { allowed: false, mode: "contained-owned" };

  let allowTenantWide = false;
  try {
    allowTenantWide = await hasEffectivePortalPermission(user as any, "can_view_tenant_call_recordings" as any);
  } catch { /* noop */ }
  if (allowTenantWide) return { allowed: true, mode: "tenant" };

  let owned: string[] = [];
  try { owned = await getUserExtensionNumbersLite(user); } catch { owned = []; }
  if (rec.extension && owned.length > 0 && !owned.includes(rec.extension)) {
    return { allowed: false, mode: "contained-owned", ownedExtensions: owned };
  }
  return { allowed: true, mode: "contained-owned", ownedExtensions: owned };
}

export async function isExtensionScopedCallViewerForUserLite(user: JwtUserLite): Promise<boolean> {
  if (isSuper(user)) return false;
  try {
    const ok = await hasEffectivePortalPermission(user as any, "can_view_tenant_call_history" as any);
    return !ok;
  } catch {
    return true; // safe fallback: extension-scoped unless permission is confirmed
  }
}

export function buildCdrExtensionVisibilityClauseLite(extensionNumbers: string[]): Record<string, unknown> | null {
  const exts = [...new Set(extensionNumbers.map((ext) => String(ext || "").trim()).filter(Boolean))];
  if (exts.length === 0) return null;
  return { OR: [ { fromNumber: { in: exts } }, { toNumber: { in: exts } } ] } as any;
}
