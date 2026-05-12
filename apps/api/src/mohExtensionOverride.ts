// Per-extension MOH override helpers.
//
// Phase 1 (2026-05-11) — schema + pure helpers only. Inert at runtime.
// Phase 2 (2026-05-11) — adds API-layer helpers (list / upsert / delete /
//   tenant-scoped extension lookup / permission predicate) consumed by the
//   `/voice/moh/extension-overrides` routes registered in `server.ts`.
// Phase 3A (2026-05-11) — adds publish-path helpers
//   (`buildExtensionOverrideKeys`, `extractExtensionSnapshotFromKeys`,
//   `computeExtensionKeysClearForRollback`) consumed by `doMohPublish` and
//   `POST /voice/moh/rollback/:publishId`. The MOH publish path now writes
//   per-extension AstDB keys, but **no consumer reads them yet** — the PBX
//   dialplan resolver lands in Phase 3B.
//
// What is STILL inert at runtime after Phase 3A:
//   - No helper in this module performs network I/O. All AstDB writes go
//     through `publishMohToAstDb` in `server.ts`, which calls the existing
//     `/telephony/internal/ivr-publish` endpoint.
//   - The PBX dialplan resolver does NOT yet consume
//     `connect/t_<slug>/extensions/<ext>/moh_class`. Asterisk reads only
//     tenant-scope keys today; per-extension keys sit in AstDB unread.
//   - No PBX scripts, dialplan contexts, trunk wrappers, or installer
//     templates were modified.
//
// Phase 3A is therefore "publish writes to AstDB but nobody reads it yet":
// the publish path persists per-extension override intent into AstDB
// alongside tenant-default keys, but live calls remain on the tenant
// default class until Phase 3B introduces a dialplan resolver that reads
// the new key family.
//
// Design rationale (from the Phase 0 design returned 2026-05-11):
//   - The runtime tenant identity comes from `CHANNEL(name)` (`PJSIP/T<id>_<ext>-...`).
//   - The per-extension AstDB key family is `connect/t_<slug>/extensions/<ext>/...`.
//   - `extension` is treated as an opaque string token (no FK to `Extension`)
//     because the channel-name token is the AstDB key segment and must round-trip
//     verbatim. Validation happens at this layer.
//
// IMPORTANT: nothing in THIS MODULE performs network I/O. The publish path
// in `server.ts` calls these pure helpers and then calls `publishMohToAstDb`
// once with the combined tenant-default + per-extension key list.

/** A row read from `MohExtensionOverride` for snapshot/key-building purposes. */
export interface MohExtensionOverrideRow {
  extension: string;
  vitalPbxMohClassName: string;
  enabled: boolean;
}

/** A snapshot entry persisted on `MohPublishRecord.extensionOverridesSnapshot`. */
export interface MohExtensionOverrideSnapshotEntry {
  extension: string;
  vitalPbxMohClassName: string;
}

/** Minimal Prisma-like client surface used by `readEnabledExtensionOverridesForTenant`. */
export interface MohExtensionOverridePrismaClient {
  mohExtensionOverride: {
    findMany(args: {
      where: { tenantId: string; enabled: true };
      orderBy: { extension: "asc" };
      select: { extension: true; vitalPbxMohClassName: true; enabled: true };
    }): Promise<MohExtensionOverrideRow[]>;
  };
}

/**
 * Maximum extension length. Asterisk dialplan allows long EXTEN values, but
 * channel-name tokens used as AstDB key segments are bounded by VitalPBX's
 * extension naming convention. 32 chars is a safe ceiling for the canary
 * deployment; if a tenant ever needs longer, this can be raised — the
 * runtime resolver does not depend on this constant.
 */
export const MOH_EXTENSION_MAX_LENGTH = 32;

/**
 * Regex for an extension token that is safe to embed in an AstDB key path:
 * digits, ASCII letters, underscore, hyphen. No whitespace, no `/`, no `.`.
 * Length 1..MOH_EXTENSION_MAX_LENGTH.
 */
const EXTENSION_RE = new RegExp(`^[0-9A-Za-z_-]{1,${MOH_EXTENSION_MAX_LENGTH}}$`);

/**
 * Trim and validate an extension token. Returns the normalized token or `null`
 * if the input is unusable. Phase-1 validation only — the API layer (Phase 2)
 * will additionally cross-check against `Extension` rows for the tenant.
 */
export function normalizeExtension(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!EXTENSION_RE.test(trimmed)) return null;
  return trimmed;
}

/** Strict boolean predicate form of `normalizeExtension`. */
export function isValidExtension(input: unknown): boolean {
  return normalizeExtension(input) !== null;
}

/**
 * Slug validation mirrors the existing tenant-slug convention used by
 * `connect/t_<slug>/...` keys: ASCII letters, digits, underscore, hyphen.
 * Empty / whitespace / path-separator-bearing slugs are rejected so we
 * never produce a corrupt AstDB key path.
 */
const SLUG_RE = /^[0-9A-Za-z_-]{1,64}$/;

function assertSlug(slug: string): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new Error(`mohExtensionOverride: invalid tenant slug ${JSON.stringify(slug)}`);
  }
  return slug;
}

function assertExtension(extension: string): string {
  const normalized = normalizeExtension(extension);
  if (normalized === null) {
    throw new Error(`mohExtensionOverride: invalid extension ${JSON.stringify(extension)}`);
  }
  return normalized;
}

/**
 * Build the AstDB *family* path for the per-extension override under a tenant
 * slug. AstDB lookups in dialplan use `${DB(family/key)}`, so we expose family
 * and key separately to mirror `mohReverseMapPublish` style.
 */
export function extensionMohClassFamily(slug: string, extension: string): string {
  return `connect/t_${assertSlug(slug)}/extensions/${assertExtension(extension)}`;
}

/**
 * Full AstDB path for the primary per-extension class key:
 * `connect/t_<slug>/extensions/<extension>/moh_class`.
 */
export function extensionMohClassKey(slug: string, extension: string): string {
  return `${extensionMohClassFamily(slug, extension)}/moh_class`;
}

/**
 * Full AstDB path for the fallback per-extension class key:
 * `connect/t_<slug>/extensions/<extension>/active_moh_class`.
 *
 * Mirrors the tenant-level fallback convention so the resolver code can read
 * primary-then-fallback uniformly.
 */
export function extensionActiveMohClassKey(slug: string, extension: string): string {
  return `${extensionMohClassFamily(slug, extension)}/active_moh_class`;
}

/**
 * Project a list of override rows into the snapshot shape persisted on
 * `MohPublishRecord.extensionOverridesSnapshot` for rollback. Only enabled
 * rows are included; the result is sorted by extension ASC for deterministic
 * audit output and stable diffs.
 *
 * Rows whose `extension` fails normalization are dropped (defense-in-depth —
 * a future phase that lets users free-form an extension must validate at
 * write time, but this guard prevents corrupt rows from reaching AstDB).
 */
export function buildExtensionOverrideSnapshot(
  rows: ReadonlyArray<MohExtensionOverrideRow>,
): MohExtensionOverrideSnapshotEntry[] {
  const out: MohExtensionOverrideSnapshotEntry[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const ext = normalizeExtension(row.extension);
    if (ext === null) continue;
    if (typeof row.vitalPbxMohClassName !== "string" || row.vitalPbxMohClassName.length === 0) {
      continue;
    }
    out.push({ extension: ext, vitalPbxMohClassName: row.vitalPbxMohClassName });
  }
  out.sort((a, b) => (a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0));
  return out;
}

/**
 * Read every enabled per-extension override for a tenant, in deterministic
 * `extension ASC` order. Pure read — no AstDB / AMI / network side effect.
 */
export async function readEnabledExtensionOverridesForTenant(
  prisma: MohExtensionOverridePrismaClient,
  tenantId: string,
): Promise<MohExtensionOverrideRow[]> {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    return [];
  }
  return prisma.mohExtensionOverride.findMany({
    where: { tenantId, enabled: true },
    orderBy: { extension: "asc" },
    select: { extension: true, vitalPbxMohClassName: true, enabled: true },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: API-layer helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Full row shape returned to API clients (the GET payload). */
export interface MohExtensionOverrideApiRow {
  id: string;
  tenantId: string;
  extension: string;
  vitalPbxMohClassName: string;
  mohProfileId: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

/** Prisma surface needed for `listExtensionOverridesForTenant`. */
export interface ListOverridesPrisma {
  mohExtensionOverride: {
    findMany(args: {
      where: { tenantId: string };
      orderBy: { extension: "asc" };
    }): Promise<MohExtensionOverrideApiRow[]>;
  };
}

/**
 * List ALL overrides for a tenant (enabled and disabled), sorted by extension
 * ASC. The API layer returns disabled rows so the portal can render a toggle;
 * the publish path uses `readEnabledExtensionOverridesForTenant` instead and
 * therefore disabled rows never leak into AstDB.
 */
export async function listExtensionOverridesForTenant(
  prisma: ListOverridesPrisma,
  tenantId: string,
): Promise<MohExtensionOverrideApiRow[]> {
  if (typeof tenantId !== "string" || tenantId.length === 0) return [];
  return prisma.mohExtensionOverride.findMany({
    where: { tenantId },
    orderBy: { extension: "asc" },
  });
}

/** Inputs accepted by `upsertExtensionOverride`. */
export interface UpsertExtensionOverrideInput {
  tenantId: string;
  extension: string;
  vitalPbxMohClassName: string;
  mohProfileId?: string | null;
  enabled?: boolean;
  actorUserId?: string | null;
}

/** Result returned by `upsertExtensionOverride`. */
export interface UpsertExtensionOverrideResult {
  override: MohExtensionOverrideApiRow;
  /** `true` when no row existed before, `false` when an existing row was updated. */
  created: boolean;
}

/** Prisma surface needed for `upsertExtensionOverride`. */
export interface UpsertOverridePrisma {
  mohExtensionOverride: {
    findUnique(args: {
      where: { tenantId_extension: { tenantId: string; extension: string } };
    }): Promise<MohExtensionOverrideApiRow | null>;
    upsert(args: {
      where: { tenantId_extension: { tenantId: string; extension: string } };
      create: {
        tenantId: string;
        extension: string;
        vitalPbxMohClassName: string;
        mohProfileId: string | null;
        enabled: boolean;
        createdBy: string | null;
        updatedBy: string | null;
      };
      update: {
        vitalPbxMohClassName: string;
        mohProfileId: string | null;
        enabled: boolean;
        updatedBy: string | null;
      };
    }): Promise<MohExtensionOverrideApiRow>;
  };
}

/**
 * Upsert a single per-extension override. The caller is responsible for:
 *   - permission gating (`canManageExtensionOverrideFor`),
 *   - tenant-scope verification (`assertExtensionExistsForTenant`),
 *   - MOH-class readiness validation (`assertSyncedMohRuntimeClass` from
 *     `server.ts` — re-uses the same readiness pipeline as `/voice/moh/profiles`).
 *
 * `extension` is normalized via `normalizeExtension`. The function throws
 * `invalid_extension` if normalization fails — defense-in-depth, since the
 * route also validates earlier.
 *
 * No AstDB / AMI side effect. DB-only.
 */
export async function upsertExtensionOverride(
  prisma: UpsertOverridePrisma,
  input: UpsertExtensionOverrideInput,
): Promise<UpsertExtensionOverrideResult> {
  const tenantId = String(input.tenantId || "").trim();
  if (!tenantId) {
    throw Object.assign(new Error("invalid_tenant"), { statusCode: 400 });
  }
  const extension = normalizeExtension(input.extension);
  if (extension === null) {
    throw Object.assign(new Error("invalid_extension"), { statusCode: 400 });
  }
  const vitalPbxMohClassName = String(input.vitalPbxMohClassName || "").trim();
  if (!vitalPbxMohClassName) {
    throw Object.assign(new Error("invalid_moh_runtime_class"), { statusCode: 400 });
  }
  const mohProfileId = input.mohProfileId ?? null;
  const enabled = input.enabled === false ? false : true;
  const actor = input.actorUserId ?? null;

  const existing = await prisma.mohExtensionOverride.findUnique({
    where: { tenantId_extension: { tenantId, extension } },
  });

  const override = await prisma.mohExtensionOverride.upsert({
    where: { tenantId_extension: { tenantId, extension } },
    create: {
      tenantId,
      extension,
      vitalPbxMohClassName,
      mohProfileId,
      enabled,
      createdBy: actor,
      updatedBy: actor,
    },
    update: {
      vitalPbxMohClassName,
      mohProfileId,
      enabled,
      updatedBy: actor,
    },
  });

  return { override, created: existing === null };
}

/** Prisma surface needed for `deleteExtensionOverrideForTenant`. */
export interface DeleteOverridePrisma {
  mohExtensionOverride: {
    deleteMany(args: {
      where: { tenantId: string; extension: string };
    }): Promise<{ count: number }>;
  };
}

/**
 * Delete the override for `(tenantId, extension)`. Uses `deleteMany` so a
 * miss returns `{ count: 0 }` rather than a P2025 throw — the API layer
 * surfaces this as `200 { ok: true, deleted: 0 }`.
 *
 * The `where` clause includes BOTH `tenantId` AND `extension`, so a
 * compromised JWT for tenant A can never delete tenant B's row even if it
 * guesses the extension token.
 */
export async function deleteExtensionOverrideForTenant(
  prisma: DeleteOverridePrisma,
  tenantId: string,
  extension: string,
): Promise<{ deleted: number }> {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw Object.assign(new Error("invalid_tenant"), { statusCode: 400 });
  }
  const normalized = normalizeExtension(extension);
  if (normalized === null) {
    throw Object.assign(new Error("invalid_extension"), { statusCode: 400 });
  }
  const r = await prisma.mohExtensionOverride.deleteMany({
    where: { tenantId, extension: normalized },
  });
  return { deleted: r.count };
}

/** Prisma surface needed for `assertExtensionExistsForTenant`. */
export interface ExtensionLookupPrisma {
  extension: {
    findFirst(args: {
      where: { tenantId: string; extNumber: string };
      select: { id: true; tenantId: true; extNumber: true; status: true };
    }): Promise<{ id: string; tenantId: string; extNumber: string; status: string } | null>;
  };
}

/**
 * Verify that an extension exists for the given tenant and is not soft-deleted.
 * Throws `extension_not_found` (statusCode 404) on miss or `status === "DELETED"`.
 *
 * Suspended extensions ARE allowed — admins can pre-stage MOH for an
 * extension that is currently suspended; the publish path only fires when the
 * extension is reachable via PJSIP, so a suspended extension override is a
 * safe no-op until the extension is restored.
 */
export async function assertExtensionExistsForTenant(
  prisma: ExtensionLookupPrisma,
  tenantId: string,
  extension: string,
): Promise<void> {
  const normalized = normalizeExtension(extension);
  if (normalized === null) {
    throw Object.assign(new Error("invalid_extension"), { statusCode: 400 });
  }
  const row = await prisma.extension.findFirst({
    where: { tenantId, extNumber: normalized },
    select: { id: true, tenantId: true, extNumber: true, status: true },
  });
  if (!row) {
    throw Object.assign(new Error("extension_not_found"), { statusCode: 404 });
  }
  if (String(row.status || "").toUpperCase() === "DELETED") {
    throw Object.assign(new Error("extension_not_found"), { statusCode: 404 });
  }
}

/** Minimal user shape used by the permission predicate. */
export interface ExtensionOverrideUser {
  role: string | null | undefined;
  tenantId: string | null | undefined;
}

/**
 * Pure permission predicate: can `user` create/update/delete an
 * `MohExtensionOverride` for `tenantId`?
 *
 * Mirrors the pair `requirePermission(canManageMoh)` + `assertMohTenantAccess`
 * already used by `/voice/moh/profiles`:
 *   - role must be `SUPER_ADMIN` or `ADMIN`,
 *   - non-super-admins can only act on their own tenant.
 *
 * Returning a boolean (rather than throwing) keeps this testable without
 * Fastify; the route layer maps `false` → `403 forbidden`.
 */
export function canManageExtensionOverrideFor(
  user: ExtensionOverrideUser,
  tenantId: string,
): boolean {
  const role = String(user?.role || "").toUpperCase();
  if (role !== "SUPER_ADMIN" && role !== "ADMIN") return false;
  if (role === "SUPER_ADMIN") return true;
  return typeof user.tenantId === "string" && user.tenantId === tenantId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3A: publish-path helpers (still pure; no network I/O).
// ─────────────────────────────────────────────────────────────────────────────

/** AstDB key triple for the telephony publish endpoint. */
export interface MohAstDbKey {
  family: string;
  key: string;
  value: string;
}

/**
 * Match either:
 *   `connect/t_<slug>/extensions/<ext>` (per-extension family for keys)
 * Capture group 1 = slug; group 2 = extension token.
 *
 * Restricting to the same character classes as `EXTENSION_RE` and `SLUG_RE`
 * prevents corrupt families from being accidentally matched (e.g. a future
 * namespace mistake that produces non-canonical slugs or extension tokens).
 */
const EXTENSION_FAMILY_RE = /^connect\/t_([0-9A-Za-z_-]{1,64})\/extensions\/([0-9A-Za-z_-]{1,32})$/;

/**
 * Build the per-extension AstDB key list to append to a tenant MOH publish.
 *
 * Emits, for every enabled override row whose `extension` normalizes and
 * whose `vitalPbxMohClassName` is non-empty, exactly two key triples:
 *   - `connect/t_<slug>/extensions/<ext>` `moh_class`
 *   - `connect/t_<slug>/extensions/<ext>` `active_moh_class`
 *
 * Both keys carry the same value — the dialplan resolver (Phase 3B) reads
 * `moh_class` first; `active_moh_class` is the fallback alias mirroring the
 * tenant-scope convention.
 *
 * Output is sorted by extension ASC, then by key ASC, for byte-stable audit
 * output and deterministic AstDB write ordering.
 *
 * Fails closed: invalid rows are silently dropped (matches the contract of
 * `buildExtensionOverrideSnapshot`). The CRUD route layer (Phase 2) is
 * responsible for rejecting bad input at write time, so a dropped row here
 * indicates corrupt DB data rather than user-facing input.
 */
export function buildExtensionOverrideKeys(
  slug: string,
  rows: ReadonlyArray<MohExtensionOverrideRow>,
): MohAstDbKey[] {
  const safeSlug = assertSlug(slug);
  const out: MohAstDbKey[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const ext = normalizeExtension(row.extension);
    if (ext === null) continue;
    const cls = typeof row.vitalPbxMohClassName === "string" ? row.vitalPbxMohClassName.trim() : "";
    if (cls.length === 0) continue;
    const family = `connect/t_${safeSlug}/extensions/${ext}`;
    out.push({ family, key: "moh_class",        value: cls });
    out.push({ family, key: "active_moh_class", value: cls });
  }
  out.sort((a, b) => {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });
  return out;
}

/**
 * Recover an extension-override snapshot from a flat AstDB key list. Used by
 * the rollback handler to reconstruct what would have been
 * `extensionOverridesSnapshot` for the restored state, given only the
 * `previousKeysSnapshot` of the publish being rolled back.
 *
 * Reads only `moh_class` keys under `connect/t_<slug>/extensions/<ext>` with
 * a non-empty value. Empty-string values are treated as tombstones (the
 * rollback "clear" entries written by `computeExtensionKeysClearForRollback`)
 * and excluded from the snapshot.
 *
 * Sorted by extension ASC for stability.
 */
export function extractExtensionSnapshotFromKeys(
  keys: ReadonlyArray<MohAstDbKey>,
): MohExtensionOverrideSnapshotEntry[] {
  const out: MohExtensionOverrideSnapshotEntry[] = [];
  for (const k of keys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    if (k.key !== "moh_class") continue;
    const m = EXTENSION_FAMILY_RE.exec(k.family);
    if (!m) continue;
    const ext = m[2];
    const value = typeof k.value === "string" ? k.value : "";
    if (value.length === 0) continue;
    out.push({ extension: ext, vitalPbxMohClassName: value });
  }
  out.sort((a, b) => (a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0));
  return out;
}

/**
 * For the rollback path: compute "clear" entries for extension keys that the
 * target publish ADDED relative to the prior state.
 *
 * Inputs:
 *   - `targetKeys` = the rollback target's `keysWritten` (state AFTER the
 *      publish being rolled back).
 *   - `prevKeys`   = the rollback target's `previousKeysSnapshot` (state
 *      BEFORE the publish being rolled back).
 *
 * For every `(family, key)` pair in `targetKeys` whose family matches
 * `connect/t_<slug>/extensions/<ext>` and whose `(family, key)` does NOT
 * appear in `prevKeys`, emit `{ family, key, value: "" }`.
 *
 * Empty-string is the tombstone value: AstDB has no native delete via the
 * existing `/telephony/internal/ivr-publish` channel, and the future
 * dialplan resolver will treat empty `moh_class` as "no override" (Phase 3B
 * contract). For Phase 3A this is purely audit-and-future-proofing — no
 * code reads these keys yet.
 *
 * Pre-existing keys that the target publish also wrote (i.e., present in
 * BOTH `targetKeys` and `prevKeys`) are not cleared — `prevKeys` will be
 * replayed verbatim by the rollback caller and will overwrite them.
 *
 * Pure: no I/O.
 */
export function computeExtensionKeysClearForRollback(
  targetKeys: ReadonlyArray<MohAstDbKey>,
  prevKeys: ReadonlyArray<MohAstDbKey>,
): MohAstDbKey[] {
  const prevSet = new Set<string>();
  for (const k of prevKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    prevSet.add(`${k.family}\u0000${k.key}`);
  }
  const out: MohAstDbKey[] = [];
  const seen = new Set<string>();
  for (const k of targetKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    if (!EXTENSION_FAMILY_RE.test(k.family)) continue;
    const id = `${k.family}\u0000${k.key}`;
    if (prevSet.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ family: k.family, key: k.key, value: "" });
  }
  out.sort((a, b) => {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });
  return out;
}
