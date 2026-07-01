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

/** Ordered, stable reason codes for observability + diagnostics. */
export type MohResolutionReason =
  | "schedule_extension" // (1) an active scheduled extension override
  | "extension_source" // (2) static per-extension setting for this source
  | "extension_default" // (2b) static per-extension default (all types)
  | "tenant_source" // (3) tenant setting for this source
  | "tenant_default" // (3b) tenant default (time/override resolved)
  | "global_default" // (4) system-wide global default
  | "pbx_default"; // (5) nothing configured → let Asterisk use its own MOH

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
  /** Set only when `reason === "schedule_extension"`. */
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
