/**
 * Per-call-source Music-On-Hold (MOH) policy — shared taxonomy, AstDB key
 * layout, dialplan source classifier, and the pure resolution engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * The pre-existing MOH stack ("Option A") resolves ONE effective tenant class
 * (time/override based) and ONE per-extension class, and publishes them to
 * Asterisk AstDB. It has no concept of *why* a call reached an extension —
 * inbound-direct vs IVR vs ring-group vs queue vs internal vs outbound vs
 * transfer vs parked vs mobile. This module adds that dimension WITHOUT
 * touching call routing:
 *
 *   • Connect resolves the effective class *per source* at publish/reconcile
 *     time (folding in scheduled overrides + global default) and writes
 *     additive AstDB keys.
 *   • The dialplan reads a source-scoped key with a strict fall-through to the
 *     existing tenant/extension default keys, so a tenant with NO per-source
 *     policy behaves exactly as today (zero regression, fail-safe).
 *
 * Everything here is PURE (no I/O). The publish path, worker reconcile, API
 * diagnostics, and installer test all consume these helpers so the four
 * layers can never drift.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Call-source taxonomy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical MOH call-source/type tokens. These strings are used verbatim as
 * AstDB key segments and as the `MOH_SRC` dialplan variable value, so they
 * MUST stay lowercase `[a-z_]` and MUST NOT change once shipped (they are a
 * runtime contract with the installed dialplan).
 */
export const MOH_CALL_SOURCES = [
  "inbound_direct", // inbound DID routed straight to an extension
  "inbound_ivr", // inbound that passed through an IVR before the extension
  "inbound_ringgroup", // inbound (or internal) that fanned out via a ring group
  "inbound_queue", // call sitting in / delivered from a queue
  "internal", // extension-to-extension on the same tenant
  "outbound", // extension placing an external call
  "transfer", // attended or blind transfer leg
  "parked", // parked / retrieved-from-park
  "mobile_app", // mobile/softphone leg entering normal extension routing
] as const;

export type MohCallSource = (typeof MOH_CALL_SOURCES)[number];

const MOH_CALL_SOURCE_SET: ReadonlySet<string> = new Set(MOH_CALL_SOURCES);

/** Runtime guard for a canonical source token. */
export function isMohCallSource(value: unknown): value is MohCallSource {
  return typeof value === "string" && MOH_CALL_SOURCE_SET.has(value);
}

/**
 * Trim + lowercase + validate a source token. Returns the canonical token or
 * `null` when the input is not a known source. Callers treat `null` as "no
 * source-specific policy" (fall through to defaults).
 */
export function normalizeMohCallSource(value: unknown): MohCallSource | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return MOH_CALL_SOURCE_SET.has(v) ? (v as MohCallSource) : null;
}

/**
 * Human labels for the UI. Kept here (not in the portal) so the API diagnostics
 * endpoint and the portal render identical wording.
 */
export const MOH_CALL_SOURCE_LABELS: Record<MohCallSource, string> = {
  inbound_direct: "Inbound — direct to extension",
  inbound_ivr: "Inbound — via IVR",
  inbound_ringgroup: "Inbound — via ring group",
  inbound_queue: "Inbound — via queue",
  internal: "Internal (extension to extension)",
  outbound: "Outbound (placed by extension)",
  transfer: "Transferred call",
  parked: "Parked / resumed",
  mobile_app: "Mobile app / softphone",
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. AstDB key layout (additive — never collides with existing keys)
// ─────────────────────────────────────────────────────────────────────────────
//
// Existing keys (unchanged, remain the fallback):
//   connect/t_<slug>/moh_class                              tenant default
//   connect/t_<slug>/active_moh_class                       tenant default alias
//   connect/t_<slug>/extensions/<ext>/moh_class             extension default
//   connect/t_<slug>/extensions/<ext>/active_moh_class      extension default alias
//
// New per-source keys (this module):
//   family connect/t_<slug>/moh/src                key <source>   tenant per-source
//   family connect/t_<slug>/extensions/<ext>/moh/src  key <source>  extension per-source
//
// The dialplan reads `${DB(<family>/<source>)}`. Empty string is a tombstone
// (fall through to the next level). Using a dedicated `/moh/src` sub-family
// means a per-source value can never be confused with the plain `moh_class`
// key and a `moh reload`-style diff stays readable.

const SLUG_RE = /^[0-9A-Za-z_-]{1,64}$/;
const EXT_RE = /^[0-9A-Za-z_-]{1,32}$/;

function assertSlug(slug: string): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new Error(`mohCallSource: invalid tenant slug ${JSON.stringify(slug)}`);
  }
  return slug;
}

function assertExtension(ext: string): string {
  if (typeof ext !== "string" || !EXT_RE.test(ext)) {
    throw new Error(`mohCallSource: invalid extension ${JSON.stringify(ext)}`);
  }
  return ext;
}

/** AstDB family holding a tenant's per-source classes: `connect/t_<slug>/moh/src`. */
export function tenantSourceMohFamily(slug: string): string {
  return `connect/t_${assertSlug(slug)}/moh/src`;
}

/** AstDB family holding an extension's per-source classes. */
export function extensionSourceMohFamily(slug: string, extension: string): string {
  return `connect/t_${assertSlug(slug)}/extensions/${assertExtension(extension)}/moh/src`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. Admin (multi-tenant) schedule overlay — HIGHEST priority
// ─────────────────────────────────────────────────────────────────────────────
//
// An ADMIN multi-tenant schedule is an intentionally global takeover for the
// selected tenants (e.g. a Yom Tov / holiday playlist that must override even
// an explicitly pinned extension). It is written to a DEDICATED overlay key
// family that the dialplan resolver reads BEFORE the per-tenant/extension keys,
// so it beats extension static overrides and extension per-tenant schedules
// while active. When the admin window ends, Connect writes empty-string
// tombstones for the overlay keys ONLY, and the resolver falls straight back
// through to the untouched extension/tenant keys — so the exact prior effective
// state is restored without ever erasing extension overrides, tenant defaults,
// PBX-control settings, or per-tenant schedules.
//
//   family connect/t_<slug>/moh/admin_src               key <source>   tenant admin per-source
//   key    connect/t_<slug>                             admin_moh_class  tenant admin default (all sources)
//   family connect/t_<slug>/extensions/<ext>/moh/admin_src  key <source> extension admin per-source
//   key    connect/t_<slug>/extensions/<ext>            admin_moh_class  extension admin default

/** AstDB family holding a tenant's admin-overlay per-source classes. */
export function tenantAdminSourceMohFamily(slug: string): string {
  return `connect/t_${assertSlug(slug)}/moh/admin_src`;
}

/** AstDB family holding an extension's admin-overlay per-source classes. */
export function extensionAdminSourceMohFamily(slug: string, extension: string): string {
  return `connect/t_${assertSlug(slug)}/extensions/${assertExtension(extension)}/moh/admin_src`;
}

/** AstDB (family,key) for a tenant's admin-overlay default class (covers all sources). */
export function tenantAdminDefaultKey(slug: string): { family: string; key: string } {
  return { family: `connect/t_${assertSlug(slug)}`, key: "admin_moh_class" };
}

/** AstDB (family,key) for an extension's admin-overlay default class. */
export function extensionAdminDefaultKey(slug: string, extension: string): { family: string; key: string } {
  return { family: `connect/t_${assertSlug(slug)}/extensions/${assertExtension(extension)}`, key: "admin_moh_class" };
}

/**
 * All AstDB (family,key) segments that make up the admin overlay for a given
 * (slug, optional extension). Used to compute tombstones that clear an admin
 * takeover deterministically. `key` here is the AstDB key; `family` the family.
 * Includes every per-source key plus the default key so a clear is exhaustive.
 */
export function adminOverlayKeyIdsForTenant(slug: string): Array<{ family: string; key: string }> {
  const out: Array<{ family: string; key: string }> = [];
  const srcFam = tenantAdminSourceMohFamily(slug);
  for (const s of MOH_CALL_SOURCES) out.push({ family: srcFam, key: s });
  out.push(tenantAdminDefaultKey(slug));
  return out;
}

/** As `adminOverlayKeyIdsForTenant`, scoped to a single extension. */
export function adminOverlayKeyIdsForExtension(slug: string, extension: string): Array<{ family: string; key: string }> {
  const out: Array<{ family: string; key: string }> = [];
  const srcFam = extensionAdminSourceMohFamily(slug, extension);
  for (const s of MOH_CALL_SOURCES) out.push({ family: srcFam, key: s });
  out.push(extensionAdminDefaultKey(slug, extension));
  return out;
}

/** True iff a family is one of the admin-overlay families (`.../moh/admin_src`). */
export function isAdminOverlayFamily(family: string): boolean {
  return /\/moh\/admin_src$/.test(family);
}

/** True iff a (family,key) is an admin-overlay DEFAULT key (`admin_moh_class`). */
export function isAdminOverlayDefaultKey(family: string, key: string): boolean {
  return key === "admin_moh_class" && /^connect\/t_[0-9A-Za-z_-]{1,64}(\/extensions\/[0-9A-Za-z_-]{1,32})?$/.test(family);
}

/** An AstDB key triple compatible with `/telephony/internal/ivr-publish`. */
export interface MohAstDbKey {
  family: string;
  key: string;
  value: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Dialplan source classifier
// ─────────────────────────────────────────────────────────────────────────────
//
// The installed dialplan computes a small set of boolean/string signals from
// channel variables it already has access to, then calls the same priority
// order encoded here. This function is the SINGLE SOURCE OF TRUTH for that
// mapping; `install-connect-tenant-moh-dialplan.sh` mirrors it line-for-line
// and a shared test asserts the token set matches, so the shell and TS can
// never diverge.

/**
 * Signals the dialplan can cheaply derive at the MOH-resolution point. All
 * optional; absent/false means "unknown", which is safe — the classifier
 * returns the most conservative bucket and the resolver falls back to the
 * tenant default.
 */
export interface DialplanMohSignals {
  /**
   * An Asterisk-native transfer is in progress: BLINDTRANSFER set (blind) OR
   * ATTENDEDTRANSFER set (attended). NOTE: do NOT derive this from VitalPBX's
   * __TRANSFERED_CALL — baseplan sets that =TRUE on every local extension dial,
   * so it is not a transfer signal.
   */
  transfer?: boolean;
  /** Call is being parked or retrieved from a parking lot. */
  parked?: boolean;
  /** __CALL_ORIGIN indicates a ring-group fan-out. */
  ringGroup?: boolean;
  /** Channel is inside a queue context / delivered from a queue. */
  queue?: boolean;
  /** __CALL_ORIGIN=RESTRICTED_IVR_CALL, or the leg came from a Connect/native IVR. */
  ivr?: boolean;
  /** Inbound call that arrived on an external trunk (DID). */
  fromTrunk?: boolean;
  /** Leg is dialing an external number over a trunk (outbound). */
  toTrunk?: boolean;
  /** Leg originated from a registered softphone/mobile app endpoint. */
  mobileApp?: boolean;
}

/**
 * Classify a call into a single MOH source using a fixed priority order.
 *
 * Priority (first match wins) — chosen so the MOST specific / operator-visible
 * intent dominates, and so that a signal we are highly confident about
 * (transfer, park, queue, ring-group) beats coarse direction heuristics:
 *
 *   1. transfer        — an active transfer overrides everything else
 *   2. parked          — parking is an explicit, unambiguous state
 *   3. inbound_ringgroup — matches the installed dialplan order (ring-group
 *   4. inbound_queue     before queue, before IVR)
 *   5. inbound_ivr     — passed through an IVR
 *   6. inbound_direct  — arrived on a trunk, none of the above
 *   7. outbound        — dialing out on a trunk
 *   8. mobile_app      — softphone/mobile leg with no other signal
 *   9. internal        — default: extension-to-extension
 *
 * This order mirrors the installed resolver in
 * scripts/pbx/install-connect-tenant-moh-dialplan.sh (override → transfer →
 * ring-group → queue → IVR → __CALL_TYPE base classes) so the shell and TS
 * cannot drift.
 *
 * NOTE: queue/ring-group are classified for observability + for the *caller*
 * leg's hold music BEFORE the queue's own native MOH takes over. `Queue()`
 * itself ignores CHANNEL(musicclass); queue hold is controlled by the native
 * `music_group_id` path (see syncNativeInboundRoutesMoh). This classifier does
 * not attempt to change that — it only labels the leg.
 */
export function classifyDialplanMohSource(signals: DialplanMohSignals | null | undefined): MohCallSource {
  const s = signals ?? {};
  if (s.transfer) return "transfer";
  if (s.parked) return "parked";
  if (s.ringGroup) return "inbound_ringgroup";
  if (s.queue) return "inbound_queue";
  if (s.ivr) return "inbound_ivr";
  if (s.fromTrunk) return "inbound_direct";
  if (s.toTrunk) return "outbound";
  if (s.mobileApp) return "mobile_app";
  return "internal";
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Resolution engine (Requirement 4 priority)
// ─────────────────────────────────────────────────────────────────────────────

/** Ordered, stable reason codes for observability + diagnostics.
 *
 * Priority (Option C, chosen 2026-07-01):
 *   1. admin_schedule_extension / admin_schedule_tenant — an ACTIVE admin
 *      multi-tenant schedule is a global takeover for the selected tenants and
 *      beats even an explicitly pinned extension.
 *   2. schedule_extension  — an active per-tenant extension schedule.
 *   3. extension_source / extension_default — static per-extension override.
 *   4. tenant_source / tenant_default — per-tenant schedule (folded upstream)
 *      and static tenant default share these levels: a per-tenant schedule is
 *      folded into the tenant keys before resolution, so a normal tenant
 *      schedule stays per-scope and never surprises a pinned extension.
 *   5. global_default — system-wide default if enabled.
 *   6. pbx_default — nothing configured → let Asterisk use its own MOH.
 */
export type MohResolutionReason =
  | "admin_schedule_extension" // (1a) active admin schedule targeting this extension
  | "admin_schedule_tenant" // (1b) active admin schedule targeting this tenant (beats ext pins)
  | "schedule_extension" // (2) an active per-tenant scheduled extension override
  | "extension_source" // (3) static per-extension setting for this source
  | "extension_default" // (3b) static per-extension default (all types)
  | "tenant_source" // (4) tenant setting for this source (tenant schedule folded here)
  | "tenant_default" // (4b) tenant default (time/override resolved)
  | "global_default" // (5) system-wide global default
  | "pbx_default"; // (6) nothing configured → let Asterisk use its own MOH

/**
 * Candidate classes at each priority level for a single (extension?, source)
 * decision. Callers supply already-computed values:
 *   - `scheduledExtensionClass`: the class from an ACTIVE scheduled extension
 *     override matching this source (or the ext's "all-types" schedule),
 *     already evaluated timezone-safe by the caller. Empty/null = no active
 *     schedule.
 *   - `extensionSourceClass` / `extensionDefaultClass`: static per-extension.
 *   - `tenantSourceClass`: static tenant per-source.
 *   - `tenantDefaultClass`: the tenant's currently-effective default class
 *     (this is the existing time/override-resolved `moh_class`).
 *   - `globalDefaultClass`: system-wide fallback.
 *
 * Any empty string / null / whitespace-only value is treated as "not set" and
 * skipped, so a tombstone never applies as a literal "".
 */
export interface MohResolutionInputs {
  source: MohCallSource;
  /** Active admin multi-tenant schedule value targeting this specific extension. */
  adminScheduleExtensionClass?: string | null;
  adminScheduleExtensionRuleId?: string | null;
  /** Active admin multi-tenant schedule value targeting this tenant (all extensions). */
  adminScheduleTenantClass?: string | null;
  adminScheduleTenantRuleId?: string | null;
  scheduledExtensionClass?: string | null;
  scheduledExtensionRuleId?: string | null;
  extensionSourceClass?: string | null;
  extensionDefaultClass?: string | null;
  tenantSourceClass?: string | null;
  tenantDefaultClass?: string | null;
  globalDefaultClass?: string | null;
}

export interface MohResolution {
  /** The resolved runtime class, or `null` to mean "use Asterisk's PBX default". */
  class: string | null;
  reason: MohResolutionReason;
  source: MohCallSource;
  /** Set only when `reason` is an admin/extension schedule reason. */
  ruleId?: string | null;
}

function firstNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length > 0 ? v : null;
}

/**
 * Resolve the effective MOH class for a (extension?, source) using the exact
 * Requirement-4 priority. Pure and total: always returns a resolution, never
 * throws. A `null` class means "no Connect policy — Asterisk keeps its own
 * default MOH", which is the fail-safe behavior (Requirement 10: if lookup
 * fails, the call continues with default MOH, never fails).
 */
export function resolveEffectiveMohClass(inp: MohResolutionInputs): MohResolution {
  const source = inp.source;

  // (1) Admin multi-tenant schedule — global takeover for selected tenants.
  //     Extension-targeted admin beats tenant-targeted admin (more specific),
  //     and both beat an explicitly pinned extension override below.
  const admExt = firstNonEmpty(inp.adminScheduleExtensionClass);
  if (admExt) {
    return { class: admExt, reason: "admin_schedule_extension", source, ruleId: inp.adminScheduleExtensionRuleId ?? null };
  }
  const admTen = firstNonEmpty(inp.adminScheduleTenantClass);
  if (admTen) {
    return { class: admTen, reason: "admin_schedule_tenant", source, ruleId: inp.adminScheduleTenantRuleId ?? null };
  }

  // (2) Per-tenant extension schedule.
  const sched = firstNonEmpty(inp.scheduledExtensionClass);
  if (sched) {
    return { class: sched, reason: "schedule_extension", source, ruleId: inp.scheduledExtensionRuleId ?? null };
  }

  const extSrc = firstNonEmpty(inp.extensionSourceClass);
  if (extSrc) return { class: extSrc, reason: "extension_source", source };

  const extDef = firstNonEmpty(inp.extensionDefaultClass);
  if (extDef) return { class: extDef, reason: "extension_default", source };

  const tenSrc = firstNonEmpty(inp.tenantSourceClass);
  if (tenSrc) return { class: tenSrc, reason: "tenant_source", source };

  const tenDef = firstNonEmpty(inp.tenantDefaultClass);
  if (tenDef) return { class: tenDef, reason: "tenant_default", source };

  const glob = firstNonEmpty(inp.globalDefaultClass);
  if (glob) return { class: glob, reason: "global_default", source };

  return { class: null, reason: "pbx_default", source };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Publish-key builders
// ─────────────────────────────────────────────────────────────────────────────

/** A per-source policy row (tenant- or extension-scoped) as stored by Connect. */
export interface MohSourcePolicyRow {
  source: MohCallSource;
  vitalPbxMohClassName: string;
  enabled: boolean;
}

/**
 * Build the additive tenant per-source AstDB keys for a publish. Emits one key
 * per enabled, valid row under family `connect/t_<slug>/moh/src`. Invalid /
 * disabled / empty rows are dropped (fail-closed). Output is sorted by source
 * ASC for byte-stable audit output.
 *
 * IMPORTANT: this does NOT fold in schedule/global — callers that want the
 * schedule-resolved value should pass the resolved class as the row's
 * `vitalPbxMohClassName`. The plain builder is used for the static policy;
 * `buildResolvedSourceKeys` handles schedule folding.
 */
export function buildTenantSourceMohKeys(
  slug: string,
  rows: ReadonlyArray<MohSourcePolicyRow>,
): MohAstDbKey[] {
  const family = tenantSourceMohFamily(slug);
  return buildSourceKeysForFamily(family, rows);
}

/** Build the additive extension per-source AstDB keys for a publish. */
export function buildExtensionSourceMohKeys(
  slug: string,
  extension: string,
  rows: ReadonlyArray<MohSourcePolicyRow>,
): MohAstDbKey[] {
  const family = extensionSourceMohFamily(slug, extension);
  return buildSourceKeysForFamily(family, rows);
}

/**
 * Build the admin-overlay AstDB keys for a single (tenant or extension) target.
 * An admin schedule normally applies one class to ALL sources, so we emit the
 * default `admin_moh_class` key. When `perSource` is provided we ALSO emit the
 * per-source overlay keys (rare — a source-specific admin schedule). Empty
 * class is dropped (a disabled/blank admin schedule writes nothing here; the
 * caller tombstones separately).
 */
export function buildTenantAdminOverlayKeys(slug: string, cls: string): MohAstDbKey[] {
  const v = firstNonEmpty(cls);
  if (!v) return [];
  const def = tenantAdminDefaultKey(slug);
  return [{ family: def.family, key: def.key, value: v }];
}

/** Build the admin-overlay keys for a specific extension target. */
export function buildExtensionAdminOverlayKeys(slug: string, extension: string, cls: string): MohAstDbKey[] {
  const v = firstNonEmpty(cls);
  if (!v) return [];
  const def = extensionAdminDefaultKey(slug, extension);
  return [{ family: def.family, key: def.key, value: v }];
}

/**
 * Predicate: is a (family,key) safe to TOMBSTONE ("") on a forward publish when
 * it is no longer desired? Only additive/override key families qualify — never
 * the tenant announcement/hold-mode keys, which are always rewritten with a
 * fresh value in the same publish. Clearable:
 *   - per-source families (`.../moh/src`, `.../moh/admin_src`)
 *   - per-extension class keys (`moh_class`, `active_moh_class`, `admin_moh_class`)
 *   - tenant/extension admin default (`admin_moh_class`)
 *   - reverse-map keys (`connect/pbx_tenant_map/<id>` `moh_class`|`slug`)
 */
export function isClearableForwardKey(family: string, key: string): boolean {
  if (typeof family !== "string" || typeof key !== "string") return false;
  if (/\/moh\/src$/.test(family) || /\/moh\/admin_src$/.test(family)) return true;
  if (/^connect\/t_[0-9A-Za-z_-]{1,64}\/extensions\/[0-9A-Za-z_-]{1,32}$/.test(family)) {
    return key === "moh_class" || key === "active_moh_class" || key === "admin_moh_class";
  }
  if (isAdminOverlayDefaultKey(family, key)) return true;
  if (/^connect\/pbx_tenant_map\/\d{1,10}$/.test(family)) {
    return key === "moh_class" || key === "slug";
  }
  return false;
}

/**
 * Compute empty-string tombstones for keys that a PREVIOUS publish wrote but the
 * NEXT publish no longer includes. This is the forward-cleanup that guarantees
 * no stale AstDB keys survive a tenant class switch (A→B→A), a removed
 * source/extension policy, a PBX-control switch, or an ended admin schedule.
 *
 * Only `isClearableForwardKey` (family,key) pairs are ever tombstoned — the
 * always-rewritten tenant announcement/hold keys are left to the next publish's
 * fresh values. Output is byte-stable (sorted by family then key).
 */
export function computeForwardKeyClears(
  prevKeys: ReadonlyArray<MohAstDbKey>,
  nextKeys: ReadonlyArray<MohAstDbKey>,
): MohAstDbKey[] {
  const next = new Set<string>();
  for (const k of nextKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    next.add(`${k.family}\u0000${k.key}`);
  }
  const out: MohAstDbKey[] = [];
  const seen = new Set<string>();
  for (const k of prevKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    const id = `${k.family}\u0000${k.key}`;
    if (next.has(id) || seen.has(id)) continue;
    if (!isClearableForwardKey(k.family, k.key)) continue;
    // A value that is already "" is already a tombstone — no need to re-clear.
    if (typeof k.value === "string" && k.value.length === 0) continue;
    seen.add(id);
    out.push({ family: k.family, key: k.key, value: "" });
  }
  out.sort((a, b) => {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}

function buildSourceKeysForFamily(family: string, rows: ReadonlyArray<MohSourcePolicyRow>): MohAstDbKey[] {
  const out: MohAstDbKey[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || row.enabled === false) continue;
    const source = normalizeMohCallSource(row.source);
    if (!source) continue;
    const cls = firstNonEmpty(row.vitalPbxMohClassName);
    if (!cls) continue;
    if (seen.has(source)) continue;
    seen.add(source);
    out.push({ family, key: source, value: cls });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * Compute empty-string tombstone keys to clear per-source keys that a publish
 * being rolled back had ADDED. Mirrors the tenant/extension default rollback
 * contract: AstDB has no delete over the publish channel, so we write "" and
 * the dialplan treats empty as "fall through". `targetKeys` = keys the
 * rolled-back publish wrote; `prevKeys` = state before it. Returns clears for
 * every `(family,key)` under a `/moh/src` family present in target but not prev.
 */
export function computeSourceKeysClearForRollback(
  targetKeys: ReadonlyArray<MohAstDbKey>,
  prevKeys: ReadonlyArray<MohAstDbKey>,
): MohAstDbKey[] {
  const prev = new Set<string>();
  for (const k of prevKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    prev.add(`${k.family}\u0000${k.key}`);
  }
  const out: MohAstDbKey[] = [];
  const seen = new Set<string>();
  for (const k of targetKeys) {
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    if (!/\/moh\/src$/.test(k.family)) continue;
    const id = `${k.family}\u0000${k.key}`;
    if (prev.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ family: k.family, key: k.key, value: "" });
  }
  out.sort((a, b) => {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}
