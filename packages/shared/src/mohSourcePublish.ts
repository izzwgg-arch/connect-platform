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
  buildExtensionSourceMohKeys,
  buildTenantSourceMohKeys,
  normalizeMohCallSource,
  type MohAstDbKey,
  type MohCallSource,
  type MohSourcePolicyRow,
} from "./mohCallSource";
import { normalizeMohRuntimeClass } from "./mohRuntimeClass";

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
