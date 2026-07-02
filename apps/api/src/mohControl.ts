// ============================================================================
// MOH control-mode + admin-schedule server helpers.
//
// Adds the "who controls MOH" dimension (Connect-managed vs native VitalPBX)
// at tenant and extension scope, plus loading/active-evaluation of the admin
// (multi-tenant) schedule overlay. Everything here is either PURE or a thin,
// well-typed DB read — the AstDB writes themselves stay in server.ts's
// `publishMohToAstDb` so all telephony transport / retry semantics are shared.
//
// Priority (Option C, approved 2026-07-01), highest first:
//   1. Admin multi-tenant active schedule  (global takeover; beats ext pins)
//   2. Extension active schedule
//   3. Extension static override
//   4. Tenant active schedule (folded → per-scope)
//   5. Tenant static override
//   6. Global/admin default (if enabled)
//   7. PBX / native control
// ============================================================================

import {
  buildAdminOverlayKeysForTenant,
  computeActiveAdminOverrides,
  type ActiveAdminOverride,
  type AdminScheduleRow,
  type MohAstDbKey,
} from "@connect/shared";

// ─────────────────────────────────────────────────────────────────────────────
// Control-mode value objects
// ─────────────────────────────────────────────────────────────────────────────

export type TenantMohControlMode = "connect" | "pbx";
export type ExtensionMohControlMode = "inherit" | "connect" | "pbx";

export function normalizeTenantControlMode(v: unknown): TenantMohControlMode {
  return String(v ?? "").trim().toLowerCase() === "pbx" ? "pbx" : "connect";
}

export function normalizeExtensionControlMode(v: unknown): ExtensionMohControlMode {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "pbx" ? "pbx" : s === "connect" ? "connect" : "inherit";
}

/** Resolve an extension's effective control mode given the tenant default. */
export function effectiveExtensionControlMode(
  tenant: TenantMohControlMode,
  ext: ExtensionMohControlMode,
): TenantMohControlMode {
  if (ext === "connect") return "connect";
  if (ext === "pbx") return "pbx";
  return tenant; // inherit
}

/** Permission predicate for control-mode + admin-schedule management. */
export function canManageMohControl(
  user: { role?: string | null; tenantId?: string | null } | null | undefined,
  tenantId: string,
): boolean {
  const role = String(user?.role || "").toUpperCase();
  if (role === "SUPER_ADMIN") return true;
  if (role === "ADMIN") return typeof user?.tenantId === "string" && user.tenantId === tenantId;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PBX-control tombstones — hand a tenant/extension back to native MOH cleanly
// ─────────────────────────────────────────────────────────────────────────────

function stableSort(keys: MohAstDbKey[]): MohAstDbKey[] {
  return keys.sort((a, b) => {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Build empty-string tombstones for every previously-written key that we want
 * to remove when a tenant/extension is switched to native PBX control. Unlike
 * `computeForwardKeyClears` (which only clears additive/override families), this
 * clears EVERYTHING — including the tenant default `moh_class`, `hold_mode`, and
 * announcement keys — so Asterisk falls back entirely to its own MOH. Keys that
 * must survive (e.g. an active admin overlay) are passed in `keepKeys` and are
 * never tombstoned. Already-empty values are skipped (no-op).
 */
export function computePbxControlTombstones(
  previousKeys: ReadonlyArray<MohAstDbKey>,
  keepKeys: ReadonlyArray<MohAstDbKey> = [],
): MohAstDbKey[] {
  const keep = new Set<string>();
  for (const k of keepKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    keep.add(`${k.family}\u0000${k.key}`);
  }
  const out: MohAstDbKey[] = [];
  const seen = new Set<string>();
  for (const k of previousKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    const id = `${k.family}\u0000${k.key}`;
    if (keep.has(id) || seen.has(id)) continue;
    if (typeof k.value === "string" && k.value.length === 0) continue;
    seen.add(id);
    out.push({ family: k.family, key: k.key, value: "" });
  }
  return stableSort(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-schedule DB loading + active evaluation
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal Prisma surface used to load admin schedules + their targets. */
export interface AdminSchedulePrismaRow {
  id: string;
  enabled: boolean;
  scheduleKind: string;
  timezone: string;
  vitalPbxMohClassName: string;
  priority: number;
  startAt: Date | null;
  endAt: Date | null;
  startWeekday: number | null;
  startTime: string | null;
  endWeekday: number | null;
  endTime: string | null;
  targets: Array<{ tenantId: string; extension: string }>;
}

/**
 * Load enabled, non-deleted admin schedules from the DB, resolve each target's
 * tenant to its AstDB slug (via `slugForTenantId`, which MUST be the same slug
 * the tenant-default publish uses), and compute the active overrides at `now`.
 * Targets whose tenant slug cannot be resolved are dropped (fail-safe).
 */
export async function loadActiveAdminOverrides(
  db: any,
  now: Date,
  slugForTenantId: (tenantId: string) => Promise<string | null>,
): Promise<ActiveAdminOverride[]> {
  const rows: AdminSchedulePrismaRow[] = await db.mohAdminSchedule.findMany({
    where: { enabled: true, isDeleted: false },
    include: { targets: true },
  });
  if (!rows || rows.length === 0) return [];

  const tenantIds = new Set<string>();
  for (const r of rows) for (const t of r.targets) tenantIds.add(t.tenantId);
  const slugByTenant = new Map<string, string>();
  for (const tid of tenantIds) {
    try {
      const s = await slugForTenantId(tid);
      if (s) slugByTenant.set(tid, s);
    } catch {
      /* skip unresolvable tenant */
    }
  }

  const scheduleRows: AdminScheduleRow[] = rows.map((r) => ({
    id: r.id,
    enabled: r.enabled,
    scheduleKind: r.scheduleKind,
    timezone: r.timezone,
    vitalPbxMohClassName: r.vitalPbxMohClassName,
    priority: r.priority,
    startAt: r.startAt,
    endAt: r.endAt,
    startWeekday: r.startWeekday,
    startTime: r.startTime,
    endWeekday: r.endWeekday,
    endTime: r.endTime,
    targets: r.targets
      .map((t) => ({ tenantSlug: slugByTenant.get(t.tenantId) ?? "", extension: t.extension || "" }))
      .filter((t) => t.tenantSlug.length > 0),
  }));

  return computeActiveAdminOverrides(scheduleRows, now);
}

/** Filter a flat list of active admin overrides down to one tenant slug. */
export function adminOverridesForSlug(all: ReadonlyArray<ActiveAdminOverride>, slug: string): ActiveAdminOverride[] {
  return all.filter((o) => o.tenantSlug === slug);
}

/** Build the admin-overlay AstDB keys for one tenant (already slug-filtered ok). */
export function buildAdminOverlayKeys(slug: string, overrides: ReadonlyArray<ActiveAdminOverride>): MohAstDbKey[] {
  return buildAdminOverlayKeysForTenant(slug, overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// Live verification result classification
// ─────────────────────────────────────────────────────────────────────────────

export type MohVerifyStatus = "verified" | "drift" | "unverified";

/**
 * Classify a post-publish live read-back. `desiredClass` is what Connect just
 * published (null/"" for a PBX-control handoff — nothing to verify → "verified"
 * trivially). `loadedClasses` is the set of class names Asterisk reported via
 * `moh show classes`; `probeOk=false` means the helper was unreachable / not
 * deployed → "unverified" (never a failure). A desired class that is NOT loaded
 * is "drift" (surfaced in health, non-fatal).
 */
export function classifyMohVerify(input: {
  desiredClass: string | null | undefined;
  probeOk: boolean;
  loadedClasses: ReadonlySet<string> | null | undefined;
}): { status: MohVerifyStatus; observed: string | null } {
  const desired = String(input.desiredClass ?? "").trim();
  if (!desired) return { status: "verified", observed: null };
  if (!input.probeOk || !input.loadedClasses) return { status: "unverified", observed: null };
  if (input.loadedClasses.has(desired)) return { status: "verified", observed: desired };
  return { status: "drift", observed: null };
}
