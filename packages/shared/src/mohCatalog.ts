/**
 * Pure, side-effect-free helpers for the Connect MOH catalog / assignment model.
 *
 * These functions encode the redesigned rules the API + refresh sync + publish
 * path all share, so the behaviour is unit-testable without a DB, an HTTP call,
 * or a live PBX:
 *
 *   - classifyMohOrigin       — where a class comes from (tenant / main / …)
 *   - computeMohPlayability    — can Asterisk actually play it? (selectable gate)
 *   - decideNativeMohSync      — may we stamp the tenant's native music_group_id?
 *
 * Design intent (grounded in the PBX brain files):
 *   VitalPBX generates one global `musiconhold` namespace. A class named
 *   `moh<groupId>` is owned by the tenant whose id appears in
 *   `musiconhold__50-<tenantId>-main.conf`, but ANY tenant's call can play ANY
 *   loaded class as long as that class has audio (its `directory=` is
 *   non-empty). Therefore *ownership is not the assignment gate — playability
 *   is*. Ownership only governs whether we may rewrite the tenant's native
 *   `music_group_id` (which must never point at a foreign group).
 */

/** VitalPBX numeric tenant id of the PBX-admin / main tenant whose classes form the shared library. */
export const MAIN_PBX_TENANT_ID = "1";

export type MohClassOrigin =
  | "tenant"          // owned by a specific customer tenant (pbxTenantId != 1)
  | "main"            // owned by the PBX-admin/main tenant (pbxTenantId == 1) — shared library
  | "global_default"  // the PBX-wide default class (isDefault or name "default")
  | "connect_upload"  // uploaded + managed by Connect (connect_<slug>_<name>)
  | "unassigned";     // no owning tenant recorded

export type MohUnavailableReason =
  | "deactivated"     // row is inactive (removed on last sync)
  | "not_loaded"      // Asterisk `moh show classes` did not list it
  | "no_files"        // loaded/known but has no playable audio (would be silence)
  | null;             // selectable

/**
 * Classify where a MOH class originates. Never throws; unknown → "unassigned".
 * `isConnectUpload` wins over everything (Connect uploads have no VitalPBX group).
 */
export function classifyMohOrigin(input: {
  pbxTenantId?: string | null;
  isDefault?: boolean | null;
  mohClassName?: string | null;
  isConnectUpload?: boolean | null;
}): MohClassOrigin {
  if (input.isConnectUpload) return "connect_upload";
  const cls = String(input.mohClassName ?? "").trim().toLowerCase();
  if (input.isDefault || cls === "default") return "global_default";
  const pt = String(input.pbxTenantId ?? "").trim();
  if (pt === MAIN_PBX_TENANT_ID) return "main";
  if (pt !== "") return "tenant";
  return "unassigned";
}

/** classType values that are playable even with a 0 file count (streamed / custom app MOH). */
const NON_FILE_PLAYABLE_TYPES = new Set(["stream", "custom", "mp3", "application", "quietmp3"]);

/**
 * Decide whether a class is safe to assign/publish (i.e. Asterisk can actually
 * play it), and if not, why. `loadedInAsterisk === null` means "not probed yet"
 * — we do NOT block on unknown so file-count-based playability keeps working
 * before/without the live `moh show classes` probe being wired to the helper.
 */
export function computeMohPlayability(input: {
  isActive: boolean;
  loadedInAsterisk?: boolean | null;
  fileCount?: number | null;
  classType?: string | null;
}): { selectable: boolean; unavailableReason: MohUnavailableReason; filesPresent: boolean } {
  const files = Number(input.fileCount ?? 0);
  const type = String(input.classType ?? "").trim().toLowerCase();
  const filesPresent = files > 0 || NON_FILE_PLAYABLE_TYPES.has(type);

  if (!input.isActive) return { selectable: false, unavailableReason: "deactivated", filesPresent };
  if (input.loadedInAsterisk === false) return { selectable: false, unavailableReason: "not_loaded", filesPresent };
  if (!filesPresent) return { selectable: false, unavailableReason: "no_files", filesPresent };
  return { selectable: true, unavailableReason: null, filesPresent };
}

export type NativeMohSyncDecision = {
  run: boolean;
  reason:
    | "owned_class"                          // run: class owned by this tenant → safe to stamp native music_group_id
    | "foreign_class_native_sync_suppressed" // skip: main/other-tenant/unassigned → resolver-only
    | "connect_uploaded_moh_no_vitalpbx_music_group" // skip: Connect upload has no VitalPBX group
    | "tenant_pbx_link_missing";             // skip: we don't know the tenant's own pbx id
};

/**
 * The core safety rule. We may rewrite a tenant's native VitalPBX
 * `music_group_id` (inbound routes / extensions / queues) ONLY when the
 * selected class is owned by that same tenant. For main/foreign/unassigned
 * classes we return run:false and rely on the AstDB resolver setting
 * `CHANNEL(musicclass)=<selectedClass>` — which plays the correct (absolute
 * directory) audio without pointing the tenant's native resources at a group
 * they do not own (the exact defect that silenced A-Plus/T2 when moh5 was
 * assigned).
 */
export function decideNativeMohSync(input: {
  classKind: "native" | "connect";
  classPbxTenantId?: string | null;
  tenantPbxTenantId?: string | null;
}): NativeMohSyncDecision {
  if (input.classKind === "connect") {
    return { run: false, reason: "connect_uploaded_moh_no_vitalpbx_music_group" };
  }
  const own = String(input.tenantPbxTenantId ?? "").trim();
  const cls = String(input.classPbxTenantId ?? "").trim();
  if (!own) return { run: false, reason: "tenant_pbx_link_missing" };
  if (cls !== "" && cls === own) return { run: true, reason: "owned_class" };
  return { run: false, reason: "foreign_class_native_sync_suppressed" };
}
