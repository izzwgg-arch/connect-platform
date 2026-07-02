/**
 * Per-source MOH publish folding — pure logic shared by the API publish path
 * and the worker reconcile loop.
 *
 * Given a tenant's static per-source policies (tenant- and extension-scoped)
 * and the currently-active scheduled overrides (already time-filtered by the
 * caller with the tenant timezone), this computes the additive AstDB key set
 * to write under the `/moh/src` families, plus the global-default key.
 *
 * Precedence folded into each published `.../moh/src/<source>` value:
 *   1. active scheduled override for THIS specific source   (specificity wins)
 *   2. active scheduled override with callSource = "all"
 *   3. static per-source policy for THIS source
 *
 * The dialplan then resolves at call time (ext+src → ext default → tenant+src
 * → tenant default → global default → PBX default). Because scheduling and the
 * global default are folded here — not read live in the dialplan — the call
 * path stays pure AstDB reads (no HTTP, fail-safe).
 *
 * Everything here is PURE. No DB, no AstDB, no network.
 */

import {
  MOH_CALL_SOURCES,
  buildExtensionAdminOverlayKeys,
  buildExtensionSourceMohKeys,
  buildTenantAdminOverlayKeys,
  buildTenantSourceMohKeys,
  normalizeMohCallSource,
  tenantDefaultClassKeys,
  type MohAstDbKey,
  type MohCallSource,
  type MohSourcePolicyRow,
} from "./mohCallSource";
import { isValidMohRuntimeClass, normalizeMohRuntimeClass } from "./mohRuntimeClass";

/** AstDB family + key for the system-wide global default class. */
export const MOH_GLOBAL_DEFAULT_FAMILY = "connect/system";
export const MOH_GLOBAL_DEFAULT_KEY = "moh_default_class";

/** Build the (single) global-default AstDB key. Empty class → tombstone (""). */
export function buildGlobalDefaultKey(vitalPbxMohClassName: string | null | undefined): MohAstDbKey {
  const cls = normalizeMohRuntimeClass(vitalPbxMohClassName);
  return { family: MOH_GLOBAL_DEFAULT_FAMILY, key: MOH_GLOBAL_DEFAULT_KEY, value: cls };
}

/** A static per-source policy row loaded from `MohSourcePolicy`. */
export interface StaticSourcePolicy {
  scope: "tenant" | "extension";
  extension: string; // "" for tenant scope
  source: string; // canonical source token (validated here)
  vitalPbxMohClassName: string;
  enabled: boolean;
}

/**
 * An active scheduled override, already time-filtered by the caller. `source`
 * is either a concrete `MohCallSource` or the literal `"all"`.
 */
export interface ActiveScheduleOverride {
  scope: "tenant" | "extension";
  extension: string; // "" for tenant scope
  source: MohCallSource | "all";
  vitalPbxMohClassName: string;
  ruleId: string;
  priority: number;
}

export interface SourcePublishInput {
  slug: string;
  staticPolicies: ReadonlyArray<StaticSourcePolicy>;
  activeOverrides: ReadonlyArray<ActiveScheduleOverride>;
}

/** A grouping key for (scope, extension). */
function targetKey(scope: string, extension: string): string {
  return `${scope}\u0000${extension}`;
}

function firstNonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Fold static policies + active schedule overrides into the additive per-source
 * AstDB key set. Returns keys sorted by family then key (byte-stable audit).
 *
 * The returned keys cover ONLY sources that have a resolved value; sources with
 * nothing configured are omitted (the dialplan falls through). No default
 * `moh_class` keys are emitted here — those are owned by the existing tenant /
 * extension-override publish path and remain the fallback.
 */
export function buildSourcePublishKeys(input: SourcePublishInput): MohAstDbKey[] {
  const { slug } = input;

  // Group static policies by (scope, extension).
  const staticByTarget = new Map<string, Map<MohCallSource, string>>();
  for (const p of input.staticPolicies) {
    if (!p || p.enabled === false) continue;
    const source = normalizeMohCallSource(p.source);
    if (!source) continue;
    const cls = firstNonEmpty(p.vitalPbxMohClassName);
    if (!cls) continue;
    const scope = p.scope === "extension" ? "extension" : "tenant";
    const ext = scope === "extension" ? String(p.extension || "") : "";
    if (scope === "extension" && ext.length === 0) continue;
    const tk = targetKey(scope, ext);
    let m = staticByTarget.get(tk);
    if (!m) {
      m = new Map();
      staticByTarget.set(tk, m);
    }
    if (!m.has(source)) m.set(source, cls);
  }

  // Group active overrides by (scope, extension), keeping the best (highest
  // priority) per source bucket, and separately the best "all" override.
  interface OverrideBucket {
    specific: Map<MohCallSource, { cls: string; priority: number }>;
    all: { cls: string; priority: number } | null;
  }
  const ovrByTarget = new Map<string, OverrideBucket>();
  for (const o of input.activeOverrides) {
    if (!o) continue;
    const cls = firstNonEmpty(o.vitalPbxMohClassName);
    if (!cls) continue;
    const scope = o.scope === "extension" ? "extension" : "tenant";
    const ext = scope === "extension" ? String(o.extension || "") : "";
    if (scope === "extension" && ext.length === 0) continue;
    const priority = Number.isFinite(o.priority) ? o.priority : 0;
    const tk = targetKey(scope, ext);
    let b = ovrByTarget.get(tk);
    if (!b) {
      b = { specific: new Map(), all: null };
      ovrByTarget.set(tk, b);
    }
    if (o.source === "all") {
      if (!b.all || priority > b.all.priority) b.all = { cls, priority };
    } else {
      const source = normalizeMohCallSource(o.source);
      if (!source) continue;
      const cur = b.specific.get(source);
      if (!cur || priority > cur.priority) b.specific.set(source, { cls, priority });
    }
  }

  // Union of all targets we need to emit for.
  const allTargets = new Set<string>([...staticByTarget.keys(), ...ovrByTarget.keys()]);

  const out: MohAstDbKey[] = [];
  for (const tk of allTargets) {
    const [scope, ext] = tk.split("\u0000");
    const statics = staticByTarget.get(tk) ?? new Map<MohCallSource, string>();
    const ovr = ovrByTarget.get(tk) ?? { specific: new Map(), all: null };

    const rows: MohSourcePolicyRow[] = [];
    for (const source of MOH_CALL_SOURCES) {
      // Precedence: schedule-specific > schedule-all > static.
      const spec = ovr.specific.get(source);
      const chosen = spec?.cls ?? ovr.all?.cls ?? statics.get(source) ?? null;
      if (!chosen) continue;
      rows.push({ source, vitalPbxMohClassName: chosen, enabled: true });
    }
    if (rows.length === 0) continue;

    if (scope === "extension") {
      out.push(...buildExtensionSourceMohKeys(slug, ext, rows));
    } else {
      out.push(...buildTenantSourceMohKeys(slug, rows));
    }
  }

  out.sort((a, b) => {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule-active evaluation (timezone-safe)
// ─────────────────────────────────────────────────────────────────────────────

/** A schedule rule row as stored in `MohScheduleRule` (with targeting fields). */
export interface ScheduleRuleRow {
  id: string;
  profileId: string;
  ruleType: string; // "weekly" | "holiday" | "one_time"
  weekday: number | null;
  startTime: string | null;
  endTime: string | null;
  startAt: Date | null;
  endAt: Date | null;
  priority: number;
  isActive: boolean;
  scope: string; // "tenant" | "extension"
  extension: string; // "" for tenant
  callSource: string; // "" / "all" or a MohCallSource token
}

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when a single rule is active at `now` in timezone `tz`. */
export function isScheduleRuleActive(rule: ScheduleRuleRow, tz: string, now: Date): boolean {
  if (!rule.isActive) return false;
  if (rule.ruleType === "one_time") {
    return !!(rule.startAt && rule.endAt && new Date(rule.startAt) <= now && new Date(rule.endAt) > now);
  }
  if (rule.ruleType === "holiday") {
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    return rule.startTime === localDate;
  }
  if (rule.ruleType === "weekly") {
    if (!rule.startTime || !rule.endTime) return false;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = DOW[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? now.getDay();
    const hh = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const mm = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    const mofDay = hh * 60 + mm;
    return rule.weekday === dow && mofDay >= toMinutes(rule.startTime) && mofDay < toMinutes(rule.endTime);
  }
  return false;
}

/**
 * Evaluate which schedule rules are active now and project them into
 * `ActiveScheduleOverride`s. `classForProfileId` maps a rule's profile to a
 * runtime class (returns null to skip). Rules with an empty/invalid class or
 * an unknown non-"all" callSource are dropped. Deterministic ordering: sorted
 * by (scope, extension, source, -priority).
 */
export function computeActiveScheduleOverrides(
  rules: ReadonlyArray<ScheduleRuleRow>,
  classForProfileId: (profileId: string) => string | null,
  tz: string,
  now: Date,
): ActiveScheduleOverride[] {
  const out: ActiveScheduleOverride[] = [];
  for (const rule of rules) {
    if (!isScheduleRuleActive(rule, tz || "UTC", now)) continue;
    const cls = firstNonEmpty(classForProfileId(rule.profileId));
    if (!cls) continue;
    const scope = rule.scope === "extension" ? "extension" : "tenant";
    const ext = scope === "extension" ? String(rule.extension || "") : "";
    if (scope === "extension" && ext.length === 0) continue;

    const rawSource = String(rule.callSource || "").trim().toLowerCase();
    let source: MohCallSource | "all";
    if (rawSource === "" || rawSource === "all") {
      source = "all";
    } else {
      const norm = normalizeMohCallSource(rawSource);
      if (!norm) continue;
      source = norm;
    }
    out.push({
      scope,
      extension: ext,
      source,
      vitalPbxMohClassName: cls,
      ruleId: rule.id,
      priority: Number.isFinite(rule.priority) ? rule.priority : 0,
    });
  }
  out.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    if (a.extension !== b.extension) return a.extension < b.extension ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return b.priority - a.priority;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin (multi-tenant) schedule overlay — highest-priority takeover
// ─────────────────────────────────────────────────────────────────────────────
//
// An admin schedule is a single object that targets many tenants (and optionally
// specific extensions). While active it writes the admin-overlay AstDB keys,
// which the dialplan resolver reads before any per-tenant/extension key — so it
// beats extension pins. It is time-evaluated here (timezone-safe) exactly like
// per-tenant rules, but with support for one-time absolute windows AND recurring
// windows that may span multiple weekdays (e.g. Fri 14:00 → Sun 23:00).

/** A target of an admin schedule: a tenant, optionally narrowed to one extension. */
export interface AdminScheduleTargetRow {
  tenantSlug: string;
  extension: string; // "" = whole tenant
}

/** An admin schedule row (mirrors `MohAdminSchedule` + its targets). */
export interface AdminScheduleRow {
  id: string;
  enabled: boolean;
  scheduleKind: string; // "one_time" | "recurring"
  timezone: string;
  vitalPbxMohClassName: string;
  priority: number;
  // one_time
  startAt: Date | null;
  endAt: Date | null;
  // recurring (minute-of-week window, wrap-around supported)
  startWeekday: number | null; // 0=Sun..6=Sat
  startTime: string | null; // "HH:MM"
  endWeekday: number | null;
  endTime: string | null;
  targets: ReadonlyArray<AdminScheduleTargetRow>;
}

function minuteOfWeek(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "UTC",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = DOW[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? now.getUTCDay();
  const hh = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return dow * 1440 + hh * 60 + mm;
}

/** True when an admin schedule is active at `now`. Handles one-time absolute
 *  windows and recurring minute-of-week windows (with wrap across Sat→Sun). */
export function isAdminScheduleActive(sched: AdminScheduleRow, now: Date): boolean {
  if (!sched.enabled) return false;
  if (sched.scheduleKind === "one_time") {
    return !!(sched.startAt && sched.endAt && new Date(sched.startAt) <= now && new Date(sched.endAt) > now);
  }
  if (sched.scheduleKind === "recurring") {
    if (
      sched.startWeekday == null ||
      sched.endWeekday == null ||
      !sched.startTime ||
      !sched.endTime
    ) {
      return false;
    }
    const nowMow = minuteOfWeek(now, sched.timezone || "UTC");
    const startMow = sched.startWeekday * 1440 + toMinutes(sched.startTime);
    const endMow = sched.endWeekday * 1440 + toMinutes(sched.endTime);
    if (startMow === endMow) return false;
    if (startMow < endMow) return nowMow >= startMow && nowMow < endMow;
    // wrap-around window (e.g. Fri 22:00 → Mon 06:00)
    return nowMow >= startMow || nowMow < endMow;
  }
  return false;
}

/** One resolved admin takeover for a single (tenant, extension?) target. */
export interface ActiveAdminOverride {
  tenantSlug: string;
  extension: string; // "" = whole tenant
  vitalPbxMohClassName: string;
  scheduleId: string;
  priority: number;
}

/**
 * Evaluate all admin schedules at `now` and project the active ones into a flat
 * list of per-target takeovers. `classForSchedule` may remap a schedule's class
 * per-tenant (returns null to skip a target). Highest priority wins per target.
 * Deterministic ordering by (tenantSlug, extension, -priority).
 */
export function computeActiveAdminOverrides(
  schedules: ReadonlyArray<AdminScheduleRow>,
  now: Date,
  classForSchedule?: (sched: AdminScheduleRow, target: AdminScheduleTargetRow) => string | null,
): ActiveAdminOverride[] {
  const best = new Map<string, ActiveAdminOverride>();
  for (const sched of schedules) {
    if (!isAdminScheduleActive(sched, now)) continue;
    const priority = Number.isFinite(sched.priority) ? sched.priority : 0;
    for (const t of sched.targets) {
      const slug = firstNonEmpty(t.tenantSlug);
      if (!slug) continue;
      const ext = String(t.extension || "");
      const cls = firstNonEmpty(
        classForSchedule ? classForSchedule(sched, t) : sched.vitalPbxMohClassName,
      );
      if (!cls) continue;
      const key = `${slug}\u0000${ext}`;
      const cur = best.get(key);
      if (!cur || priority > cur.priority) {
        best.set(key, { tenantSlug: slug, extension: ext, vitalPbxMohClassName: cls, scheduleId: sched.id, priority });
      }
    }
  }
  const out = [...best.values()];
  out.sort((a, b) => {
    if (a.tenantSlug !== b.tenantSlug) return a.tenantSlug < b.tenantSlug ? -1 : 1;
    if (a.extension !== b.extension) return a.extension < b.extension ? -1 : 1;
    return b.priority - a.priority;
  });
  return out;
}

/**
 * Build the admin-overlay AstDB keys for ONE tenant given the active admin
 * overrides for that tenant (filter upstream by slug). Emits the extension
 * admin-default key for extension-scoped targets and the tenant admin-default
 * key for whole-tenant targets. Byte-stable output.
 */
export function buildAdminOverlayKeysForTenant(
  slug: string,
  activeOverridesForTenant: ReadonlyArray<ActiveAdminOverride>,
): MohAstDbKey[] {
  const out: MohAstDbKey[] = [];
  const seen = new Set<string>();
  for (const o of activeOverridesForTenant) {
    if (firstNonEmpty(o.tenantSlug) !== slug) continue;
    const cls = firstNonEmpty(o.vitalPbxMohClassName);
    if (!cls) continue;
    const ext = String(o.extension || "");
    const keys = ext.length > 0 ? buildExtensionAdminOverlayKeys(slug, ext, cls) : buildTenantAdminOverlayKeys(slug, cls);
    for (const k of keys) {
      const id = `${k.family}\u0000${k.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(k);
    }
  }
  out.sort((a, b) => {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin schedule end-of-window fallback (design choice C, 2026-07-01)
// ─────────────────────────────────────────────────────────────────────────────
//
// When an admin multi-tenant schedule window ends, the reconciler must decide
// what the target returns to. Two modes are supported per schedule:
//   • "restore_previous" (DEFAULT): tombstone ONLY the admin-overlay keys so the
//     exact prior effective state (extension pins, tenant defaults, PBX-control)
//     re-takes effect with zero stale keys. No class is written.
//   • "explicit": in addition to clearing the overlay, the target is pointed at
//     an explicit class. This is a PURE decision — the caller (reconciler) owns
//     the AstDB write. Empty/whitespace fallbackClass fails safe → restore_previous.
//
// NOTE ON THE MODE TOKEN: the persisted/API value for the explicit mode is
// "explicit" (see apps/api adminScheduleBodySchema). "fallback_class" is accepted
// as a tolerated alias so older callers/tests keep working. Both mean "set_class".
//
// These functions are intentionally pure and write-free so they can be
// unit-tested and reused by both the API and the worker reconcile loop.

export type AdminFallbackPlan =
  | { action: "restore_previous" }
  | { action: "set_class"; vitalPbxMohClassName: string };

/** The set of `fallbackMode` tokens that mean "apply the explicit fallbackClass". */
const EXPLICIT_FALLBACK_MODES = new Set(["explicit", "fallback_class"]);

export function resolveAdminScheduleFallback(input: {
  fallbackMode: string | null | undefined;
  fallbackClass: string | null | undefined;
}): AdminFallbackPlan {
  const mode = String(input.fallbackMode ?? "").trim().toLowerCase();
  const cls = firstNonEmpty(input.fallbackClass);
  if (EXPLICIT_FALLBACK_MODES.has(mode) && cls) {
    return { action: "set_class", vitalPbxMohClassName: cls };
  }
  return { action: "restore_previous" };
}

/**
 * Validity-gated version used by the LIVE reconcile path. Layers the existing
 * publish validation (`isValidMohRuntimeClass`, overridable for tests) on top of
 * `resolveAdminScheduleFallback` so a broken/invalid explicit fallback is never
 * silently published — it FAILS SAFE to `restore_previous` and surfaces the
 * refused class for a warning log. Missing/empty class also fails safe. This is
 * the design-C safety contract: "do not silently publish a broken state".
 */
export type AdminFallbackResolution =
  | { action: "restore_previous"; refusedClass?: string }
  | { action: "set_class"; vitalPbxMohClassName: string };

export function planAdminScheduleFallback(input: {
  fallbackMode: string | null | undefined;
  fallbackClass: string | null | undefined;
  /** Playability/validity gate; defaults to the runtime-class syntactic validator. */
  isValidClass?: (cls: string) => boolean;
}): AdminFallbackResolution {
  const base = resolveAdminScheduleFallback({ fallbackMode: input.fallbackMode, fallbackClass: input.fallbackClass });
  if (base.action !== "set_class") return { action: "restore_previous" };
  const validate = input.isValidClass ?? isValidMohRuntimeClass;
  if (!validate(base.vitalPbxMohClassName)) {
    return { action: "restore_previous", refusedClass: base.vitalPbxMohClassName };
  }
  return { action: "set_class", vitalPbxMohClassName: base.vitalPbxMohClassName };
}

/**
 * Build the tenant-default class keys the explicit-fallback path writes when a
 * takeover ends (points the tenant's Connect-managed default at the fallback
 * class). Extension static overrides are read BEFORE these keys, so they still
 * win after the overlay is gone — the fallback is the tenant-level post-schedule
 * baseline, never a permanent extension override. Value is normalized here.
 */
export function buildAdminFallbackTenantClassKeys(slug: string, vitalPbxMohClassName: string): MohAstDbKey[] {
  const cls = normalizeMohRuntimeClass(vitalPbxMohClassName);
  if (!cls) return [];
  return tenantDefaultClassKeys(slug, cls);
}

/** One ending activation's schedule fallback config, for tenant-level selection. */
export interface AdminFallbackCandidate {
  scheduleId: string;
  fallbackMode: string | null | undefined;
  fallbackClass: string | null | undefined;
  priority: number;
}

export interface AdminFallbackSelection {
  /** Tenant-level Connect class to publish, or null for restore_previous. */
  appliedClass: string | null;
  /** Explicit fallback classes refused by validation (for warning logs). */
  refusedClasses: string[];
  /** True when a valid explicit fallback was skipped because the tenant is PBX-controlled. */
  skippedForPbx: boolean;
}

/**
 * Pure selection of the tenant-level explicit-fallback class among the
 * activations ending this cycle. Encapsulates the three safety gates so the
 * worker stays a thin caller and every branch is unit-tested:
 *   • invalid/missing class  → refused (fail safe to restore_previous)
 *   • tenant is PBX-controlled → skipped (never force Connect control)
 *   • otherwise the highest-priority valid explicit fallback wins.
 */
export function selectAdminFallbackTenantClass(input: {
  tenantControlMode: string | null | undefined;
  candidates: ReadonlyArray<AdminFallbackCandidate>;
  isValidClass?: (cls: string) => boolean;
}): AdminFallbackSelection {
  const isPbx = String(input.tenantControlMode ?? "connect").trim().toLowerCase() === "pbx";
  const refusedClasses: string[] = [];
  let skippedForPbx = false;
  let best: { cls: string; priority: number } | null = null;
  for (const c of input.candidates) {
    const plan = planAdminScheduleFallback({ fallbackMode: c.fallbackMode, fallbackClass: c.fallbackClass, isValidClass: input.isValidClass });
    if (plan.action !== "set_class") {
      if (plan.refusedClass) refusedClasses.push(plan.refusedClass);
      continue;
    }
    if (isPbx) {
      skippedForPbx = true;
      continue;
    }
    const priority = Number.isFinite(c.priority) ? c.priority : 0;
    if (!best || priority > best.priority) best = { cls: plan.vitalPbxMohClassName, priority };
  }
  return { appliedClass: best ? best.cls : null, refusedClasses, skippedForPbx };
}
