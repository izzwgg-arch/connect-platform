// ── IVR migration: VitalPBX call flow → Connect IVR Studio ───────────────────
//
// Pure translation layer for the "take over this menu" button. Given the
// read-only flow map the PBX helper returns (`POST /flow-map`), this module
// works out exactly what Connect would have to create to reproduce a
// VitalPBX IVR — and, just as importantly, what it CANNOT reproduce, so the
// operator sees the gaps before callers do.
//
// Nothing here touches the database, the PBX, or the network. Everything is a
// pure function over the map so the whole translation is unit-testable — this
// is the code that decides where live callers get sent, so it must be provable
// without a PBX in the loop.
//
// ── The one idea that makes menu-at-a-time migration safe ───────────────────
// A tenant's menus form a graph: a DID points at a time condition, which
// points at two menus, whose digits point at extensions, queues and further
// menus. Copying that graph all-at-once would mean a big-bang cutover for the
// whole tenant. Instead, any node Connect has NOT taken over is referenced
// straight back into the PBX's own dialplan, using contexts verified live on
// tenant 2 (2026-08-03):
//
//   PBX-native IVR            → Goto(T<t>_app-ivr,IVR-<id>,1)
//   PBX-native time condition → Goto(T<t>_app-time-condition,TC-<id>,1)
//
// So a half-migrated tenant is not a broken tenant: the Connect menu answers,
// plays its greeting, and hands the caller back to VitalPBX for any branch we
// have not taken over yet. Menus can then be migrated one at a time, in any
// order, and rolled back one at a time.

import { isIvrMenuCode } from "./ivrMenuCodes";

// ── Shapes returned by the PBX helper's /flow-map (read-only) ────────────────

export interface PbxDecodedDestination {
  destinationId: number;
  /** Connect's own vocabulary where known ("extension", "queue", "ring_group",
   *  "ivr", "time_condition", "custom_application"), otherwise the raw
   *  VitalPBX module name ("terminate_call", "vm_direct", "custom_dest", …). */
  type: string;
  /** Row id of the target — NOT the number you dial. Resolve via `directory`. */
  targetId: string | null;
  label: string | null;
}

export interface PbxRecordingRef {
  id: number;
  name: string | null;
  staticPath: string | null;
  durationSec: number | null;
  known: boolean;
}

export interface PbxIvrOption {
  entryId: number;
  digit: string;
  enabled: boolean;
  sort: number | null;
  target: PbxDecodedDestination | null;
}

export interface PbxIvr {
  id: number;
  description: string;
  directDialEnabled: boolean;
  welcome: PbxRecordingRef | null;
  instructions: PbxRecordingRef | null;
  timeoutSec: number | null;
  timeoutTries: number | null;
  timeoutPrompt: PbxRecordingRef | null;
  timeoutRetryPrompt: PbxRecordingRef | null;
  timeoutTarget: PbxDecodedDestination | null;
  invalidTries: number | null;
  invalidPrompt: PbxRecordingRef | null;
  invalidRetryPrompt: PbxRecordingRef | null;
  invalidTarget: PbxDecodedDestination | null;
  options: PbxIvrOption[];
}

export interface PbxTimeGroup {
  id: number;
  description: string;
  /** Raw Asterisk GotoIfTime slots, e.g. "09:30-17:00,mon-thu,*,*". */
  schedules: string[];
}

export interface PbxTimeCondition {
  id: number;
  code: string;
  description: string;
  timezone: string;
  /** "default" = follow the schedule; anything else is a manual override
   *  someone left engaged on the PBX. */
  status: string;
  timeGroup: PbxTimeGroup | null;
  matchTarget: PbxDecodedDestination | null;
  mismatchTarget: PbxDecodedDestination | null;
}

export interface PbxRoute {
  routeId: number;
  did: string;
  description: string;
  target: PbxDecodedDestination | null;
}

export interface PbxDirectoryEntry { id: number; number: string; name: string }

export interface PbxTenantFlowMap {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  enabled: boolean;
  directory: {
    extensions: PbxDirectoryEntry[];
    queues: PbxDirectoryEntry[];
    ringGroups: PbxDirectoryEntry[];
    customApplications: PbxDirectoryEntry[];
  };
  recordings: Array<{ id: number; name: string; originalFilename: string; durationSec: number; staticPath: string | null }>;
  ivrs: PbxIvr[];
  timeGroups: PbxTimeGroup[];
  timeConditions: PbxTimeCondition[];
  routes: PbxRoute[];
}

// ── Connect-side output shapes ──────────────────────────────────────────────

export type ConnectDestinationType =
  | "extension" | "queue" | "ring_group" | "voicemail" | "ivr"
  | "announcement" | "external_number" | "terminate" | "custom";

export interface MappedDestination {
  destinationType: ConnectDestinationType;
  destinationRef: string;
  /** Human label for the studio + the pre-flight summary. */
  label: string;
  /** True when the ref hands the caller back to VitalPBX rather than staying
   *  inside Connect. Not a problem — but the operator should see how much of
   *  the flow is still PBX-owned. */
  handsBackToPbx: boolean;
}

/** A destination we deliberately refuse to guess at. Carried through to the
 *  UI so the operator resolves it by hand instead of discovering it live. */
export interface UnmappedDestination {
  reason: string;
  pbxType: string;
  pbxTargetId: string | null;
  pbxLabel: string | null;
}

export type MapResult =
  | { ok: true; destination: MappedDestination }
  | { ok: false; problem: UnmappedDestination };

export interface MappingContext {
  /** VitalPBX tenant id, e.g. 2 → contexts "T2_cos-all". */
  pbxTenantId: number;
  directory: PbxTenantFlowMap["directory"];
  /** PBX IVR id → Connect route-profile id, for menus already taken over.
   *  Anything absent is referenced back into the PBX dialplan. */
  connectProfileByPbxIvrId?: Record<number, string>;
}

// ── Destination translation ─────────────────────────────────────────────────

function findNumber(rows: PbxDirectoryEntry[], targetId: string | null): PbxDirectoryEntry | null {
  if (targetId == null) return null;
  const id = Number(targetId);
  if (!Number.isFinite(id)) return null;
  return rows.find((r) => r.id === id) ?? null;
}

/**
 * Translate one decoded VitalPBX destination into a Connect destination.
 *
 * Returns a `problem` rather than a best guess whenever the target cannot be
 * resolved exactly. Guessing here would silently misroute live calls, and a
 * misrouted call is far more expensive than a row in a "needs your attention"
 * list.
 */
export function mapPbxDestination(
  target: PbxDecodedDestination | null | undefined,
  ctx: MappingContext,
): MapResult {
  const t = ctx.pbxTenantId;
  if (!target || !target.type) {
    return { ok: false, problem: { reason: "No destination set on the PBX", pbxType: "none", pbxTargetId: null, pbxLabel: null } };
  }
  const fail = (reason: string): MapResult => ({
    ok: false,
    problem: { reason, pbxType: target.type, pbxTargetId: target.targetId, pbxLabel: target.label },
  });

  switch (target.type) {
    case "extension": {
      const row = findNumber(ctx.directory.extensions, target.targetId);
      if (!row) return fail("That extension no longer exists on the PBX");
      return {
        ok: true,
        destination: {
          destinationType: "extension",
          destinationRef: `T${t}_cos-all,${row.number},1`,
          label: row.name ? `${row.number} · ${row.name}` : `Extension ${row.number}`,
          handsBackToPbx: false,
        },
      };
    }
    case "queue": {
      const row = findNumber(ctx.directory.queues, target.targetId);
      if (!row) return fail("That queue no longer exists on the PBX");
      return {
        ok: true,
        destination: {
          destinationType: "queue",
          destinationRef: `T${t}_ext-queues,${row.number},1`,
          label: row.name || `Queue ${row.number}`,
          handsBackToPbx: true,
        },
      };
    }
    case "ring_group": {
      const row = findNumber(ctx.directory.ringGroups, target.targetId);
      if (!row) return fail("That ring group no longer exists on the PBX");
      return {
        ok: true,
        destination: {
          destinationType: "ring_group",
          destinationRef: `T${t}_ext-ringgroups,${row.number},1`,
          label: row.name || `Ring group ${row.number}`,
          handsBackToPbx: true,
        },
      };
    }
    case "custom_application": {
      const row = findNumber(ctx.directory.customApplications, target.targetId);
      if (!row) return fail("That custom application no longer exists on the PBX");
      return {
        ok: true,
        destination: {
          destinationType: "custom",
          destinationRef: `T${t}_cos-all,${row.number},1`,
          label: row.name || `Application ${row.number}`,
          handsBackToPbx: true,
        },
      };
    }
    case "ivr": {
      const pbxIvrId = Number(target.targetId);
      if (!Number.isFinite(pbxIvrId)) return fail("Menu target could not be read from the PBX");
      const connectProfileId = ctx.connectProfileByPbxIvrId?.[pbxIvrId];
      if (connectProfileId) {
        return {
          ok: true,
          destination: {
            destinationType: "ivr",
            destinationRef: `connect-tenant-ivr,${connectProfileId},1`,
            label: target.label ? `Menu: ${target.label}` : `Menu ${pbxIvrId}`,
            handsBackToPbx: false,
          },
        };
      }
      // Not taken over yet — hand the caller back to the PBX's own menu.
      return {
        ok: true,
        destination: {
          destinationType: "custom",
          destinationRef: `T${t}_app-ivr,IVR-${pbxIvrId},1`,
          label: target.label ? `PBX menu: ${target.label}` : `PBX menu ${pbxIvrId}`,
          handsBackToPbx: true,
        },
      };
    }
    case "time_condition": {
      const tcId = Number(target.targetId);
      if (!Number.isFinite(tcId)) return fail("Hours rule could not be read from the PBX");
      return {
        ok: true,
        destination: {
          destinationType: "custom",
          destinationRef: `T${t}_app-time-condition,TC-${tcId},1`,
          label: target.label ? `PBX hours rule: ${target.label}` : `PBX hours rule ${tcId}`,
          handsBackToPbx: true,
        },
      };
    }
    case "terminate_call":
      return {
        ok: true,
        destination: {
          destinationType: "terminate",
          destinationRef: "connect-default-fallback,s,1",
          label: "Hang up",
          handsBackToPbx: false,
        },
      };
    // Voicemail. The index is the EXTENSION ROW ID, and the greeting to play
    // is chosen by the exten prefix. Both verified live 2026-08-03: tenant 10
    // IVR-28 key 1 → vm_direct index 72 → extension_id 72 = ext 101, and the
    // generated dialplan does Goto(sub-extensions-vm,VM-101,1).
    // sub-extensions-vm splits VM- / VMB- / VMU- into the default, busy and
    // unavailable greetings (extensions__20-baseplan.conf).
    case "vm_direct":
    case "vm_busy":
    case "vm_unavailable": {
      const row = findNumber(ctx.directory.extensions, target.targetId);
      if (!row) return fail("That mailbox's extension no longer exists on the PBX");
      const prefix = target.type === "vm_busy" ? "VMB" : target.type === "vm_unavailable" ? "VMU" : "VM";
      const which = target.type === "vm_busy" ? " (busy greeting)" : target.type === "vm_unavailable" ? " (unavailable greeting)" : "";
      return {
        ok: true,
        destination: {
          destinationType: "voicemail",
          destinationRef: `sub-extensions-vm,${prefix}-${row.number},1`,
          label: `Voicemail ${row.number}${row.name ? ` · ${row.name}` : ""}${which}`,
          handsBackToPbx: true,
        },
      };
    }
    // Announcement: play a recording, then continue to its own destination.
    // Verified live: Goto(T2_app-announcement,announcement-3,1).
    case "preannoun": {
      const id = Number(target.targetId);
      if (!Number.isFinite(id)) return fail("Announcement could not be read from the PBX");
      return {
        ok: true,
        destination: {
          destinationType: "announcement",
          destinationRef: `T${t}_app-announcement,announcement-${id},1`,
          label: target.label ? `Announcement: ${target.label}` : `Announcement ${id}`,
          handsBackToPbx: true,
        },
      };
    }
    // DISA (dial-through). Verified live: Goto(T14_app-disa,DISA-2,1).
    case "disa": {
      const id = Number(target.targetId);
      if (!Number.isFinite(id)) return fail("Dial-through could not be read from the PBX");
      return {
        ok: true,
        destination: {
          destinationType: "custom",
          destinationRef: `T${t}_app-disa,DISA-${id},1`,
          label: target.label ? `Dial-through: ${target.label}` : `Dial-through ${id}`,
          handsBackToPbx: true,
        },
      };
    }
    default:
      return fail(`Connect doesn't handle "${target.type}" destinations yet`);
  }
}

// ── Weekly schedule translation ─────────────────────────────────────────────

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface BusinessHoursRule { day: number; open: string; close: string }

export interface ScheduleTranslation {
  rules: BusinessHoursRule[];
  /** Anything the PBX expresses that Connect's schedule model cannot hold. */
  warnings: string[];
}

function expandDayToken(token: string): number[] | null {
  const t = token.trim().toLowerCase();
  if (t === "*" || t === "") return [0, 1, 2, 3, 4, 5, 6];
  const out: number[] = [];
  for (const part of t.split("&")) {
    const range = part.split("-");
    if (range.length === 1) {
      const d = DOW[range[0]];
      if (d === undefined) return null;
      out.push(d);
    } else if (range.length === 2) {
      const from = DOW[range[0]];
      const to = DOW[range[1]];
      if (from === undefined || to === undefined) return null;
      // Asterisk day ranges wrap (e.g. "fri-mon").
      for (let i = 0; i < 7; i++) {
        const d = (from + i) % 7;
        out.push(d);
        if (d === to) break;
      }
    } else return null;
  }
  return Array.from(new Set(out));
}

function normalizeHHMM(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/**
 * Translate a VitalPBX time group's slots into Connect business-hours rules.
 *
 * Connect's schedule model holds ONE open/close window per weekday
 * (`computeCurrentMode` in server.ts does `rules.find(r => r.day === dow)`),
 * so a split shift like "09:00-12:00" + "13:00-17:00" on the same day cannot
 * be represented. Rather than drop the second window — which would put
 * afternoon callers into the after-hours menu without anyone noticing — we
 * widen to the outer span and warn loudly about the gap.
 */
export function translateTimeGroup(group: PbxTimeGroup | null | undefined): ScheduleTranslation {
  const warnings: string[] = [];
  const byDay = new Map<number, BusinessHoursRule>();
  const splitDays = new Set<number>();
  if (!group || group.schedules.length === 0) {
    return { rules: [], warnings: ["This hours rule has no opening times on the PBX — Connect will treat every hour as after-hours."] };
  }

  for (const raw of group.schedules) {
    const slot = String(raw || "").trim();
    if (!slot) continue;
    const parts = slot.split(",");
    const [timeRange, dayToken, monthDayToken, monthToken] = [parts[0] ?? "", parts[1] ?? "*", parts[2] ?? "*", parts[3] ?? "*"];

    if ((monthDayToken && monthDayToken !== "*") || (monthToken && monthToken !== "*")) {
      warnings.push(`"${slot}" only applies on certain dates of the year. Connect's hours repeat every week, so that date limit won't carry over.`);
    }

    const range = timeRange.split("-");
    const open = range.length === 2 ? normalizeHHMM(range[0]) : null;
    const close = range.length === 2 ? normalizeHHMM(range[1]) : null;
    if (!open || !close) {
      warnings.push(`Couldn't read the opening times in "${slot}" — check this day by hand.`);
      continue;
    }
    const days = expandDayToken(dayToken);
    if (!days) {
      warnings.push(`Couldn't read the days in "${slot}" — check this day by hand.`);
      continue;
    }
    for (const day of days) {
      const existing = byDay.get(day);
      if (!existing) {
        byDay.set(day, { day, open, close });
        continue;
      }
      splitDays.add(day);
      byDay.set(day, {
        day,
        open: existing.open < open ? existing.open : open,
        close: existing.close > close ? existing.close : close,
      });
    }
  }

  for (const day of Array.from(splitDays).sort()) {
    const r = byDay.get(day)!;
    warnings.push(
      `${DOW_NAMES[day]} is open in more than one block on the PBX. Connect can only hold one block per day, so it's been set to ${r.open}–${r.close} — the break in the middle will now count as open.`,
    );
  }

  return { rules: Array.from(byDay.values()).sort((a, b) => a.day - b.day), warnings };
}

// ── Prompt refs ─────────────────────────────────────────────────────────────

/**
 * Connect prompt ref for a VitalPBX recording.
 *
 * The Connect dialplan calls `Background(${GREETING})` with a ref resolved
 * under /var/lib/asterisk/sounds, while VitalPBX keeps recordings at
 * /var/lib/vitalpbx/static/<tenant>/recordings/<md5(id)>. The two trees are
 * different, so a copied menu needs the audio published into the Connect
 * prompt catalog under a stable, collision-free name.
 *
 * `custom/<slug>_vpbx<recordingId>` is that name: prefixed with the tenant
 * slug so the existing prompt-catalog tenant assignment (longest leading slug
 * segment) files it against the right tenant, and suffixed with the VitalPBX
 * recording id so re-running an import is idempotent and two recordings that
 * share a display name can't collide.
 */
export function connectPromptRef(tenantSlug: string, recordingId: number): string {
  const slug = String(tenantSlug || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `custom/${slug || "tenant"}_vpbx${recordingId}`;
}

// ── Whole-menu import plan ──────────────────────────────────────────────────

export interface PlannedOption {
  optionDigit: string;
  destinationType: ConnectDestinationType;
  destinationRef: string;
  label: string;
  handsBackToPbx: boolean;
}

export interface PlannedProfile {
  /** VitalPBX IVR this profile reproduces. */
  pbxIvrId: number;
  name: string;
  /** "business_hours" for the menu played during open hours, "after_hours"
   *  for the one behind a time condition's mismatch branch. */
  type: string;
  promptRef: string | null;
  promptRecordingId: number | null;
  timeoutSeconds: number;
  maxRetries: number;
  directDialEnabled: boolean;
  /** Extension codes this menu lists one by one that Connect reproduces ONLY if
   *  dial-by-extension is switched on for the copied menu. Empty when the PBX
   *  already had it on — those land in ImportPlan.keptByDirectDial instead.
   *
   *  ⛔ These are NOT problems. The row's own wording says Connect can do it,
   *  so filing them under "can't reproduce" contradicted itself and disabled
   *  the Copy button on 3 of the 7 customers that have menus (2026-08-24: 29
   *  of the estate's 41 extension shortcuts). ⛔ They are not free either —
   *  planFor copies directDialEnabled AS-IS, so a menu that was off on the PBX
   *  arrives off in Connect and callers lose these codes. It is one switch,
   *  and it is the operator's to make, because turning it on accepts ANY
   *  extension rather than only the ones the PBX menu listed. */
  directDialWouldRestore: string[];
  timeoutDestinationType: ConnectDestinationType | null;
  timeoutDestinationRef: string | null;
  invalidDestinationType: ConnectDestinationType | null;
  invalidDestinationRef: string | null;
  options: PlannedOption[];
}

export interface ImportProblem {
  where: string;
  reason: string;
  pbxType: string;
  pbxLabel: string | null;
}

export interface ImportPlan {
  pbxTenantId: number;
  tenantSlug: string;
  /** The menu the operator clicked "Copy" on. */
  rootPbxIvrId: number;
  profiles: PlannedProfile[];
  /** Hours to write into IvrScheduleConfig, when the root menu sits behind a
   *  time condition (or reaches one through a digit). */
  schedule: { timezone: string; rules: BusinessHoursRule[]; pbxTimeConditionId: number; pbxTimeConditionName: string } | null;
  /** DIDs that currently reach this menu — the numbers "Go live" would flip. */
  dids: Array<{ did: string; description: string; viaTimeCondition: boolean }>;
  /** Recordings that must exist in the Connect prompt catalog first. */
  requiredRecordings: Array<{ recordingId: number; name: string; promptRef: string; staticPath: string | null }>;
  /** Extension shortcuts the PBX lists key-by-key that Connect keeps via
   *  dial-by-extension. Reported so the operator can see they weren't lost —
   *  not a problem, and not something to act on. */
  keptByDirectDial: string[];
  /** Menus whose extension shortcuts survive only if dial-by-extension is
   *  turned on for them. A decision to put in front of the operator — never a
   *  blocker, and never silently decided for them. */
  directDialRestorable: Array<{ pbxIvrId: number; menu: string; codes: string[] }>;
  /** Hidden multi-digit codes (DISA, straight-to-voicemail, queue jumps…)
   *  that the copy carries over as-is: the Connect menu routes them to the
   *  IDENTICAL dialplan target the PBX menu's own literal exten used, so they
   *  keep behaving exactly as they do today. Informational — the operator
   *  should know a secret code exists on a menu they are copying, especially
   *  a DISA code (dial in, enter it, get outbound dial tone as the company). */
  carriedCodes: Array<{ pbxIvrId: number; menu: string; codes: Array<{ code: string; label: string }> }>;
  problems: ImportProblem[];
  warnings: string[];
}

const OPTION_DIGIT_ALIASES: Record<string, string> = { "*": "star", "#": "hash" };

/** Connect stores "*" and "#" as "star"/"hash" (AstDB-key safe). */
export function normalizeOptionDigit(raw: string): string | null {
  const d = String(raw || "").trim();
  if (OPTION_DIGIT_ALIASES[d]) return OPTION_DIGIT_ALIASES[d];
  if (/^\d$/.test(d)) return d;
  return null;
}

function ivrById(map: PbxTenantFlowMap, id: number): PbxIvr | null {
  return map.ivrs.find((i) => i.id === id) ?? null;
}

/**
 * Work out everything Connect must create to take over one VitalPBX menu.
 *
 * Scope is deliberately narrow: the menu itself, plus — when it sits behind a
 * time condition — the after-hours menu on the other side of that condition
 * and the opening hours that choose between them. That is the unit an
 * operator actually thinks in ("take over the Home menu"), and it is the unit
 * that can be rolled back in one click. Menus further down the tree stay on
 * the PBX and are reached by handing the call back, until someone takes those
 * over too.
 */
export function buildImportPlan(
  map: PbxTenantFlowMap,
  rootPbxIvrId: number,
  opts: { connectProfileByPbxIvrId?: Record<number, string> } = {},
): ImportPlan {
  const ctx: MappingContext = {
    pbxTenantId: map.tenantId,
    directory: map.directory,
    connectProfileByPbxIvrId: opts.connectProfileByPbxIvrId,
  };
  const problems: ImportProblem[] = [];
  const warnings: string[] = [];
  const coveredByDirectDial = new Set<string>();
  const requiredRecordings = new Map<number, { recordingId: number; name: string; promptRef: string; staticPath: string | null }>();

  const root = ivrById(map, rootPbxIvrId);
  if (!root) {
    return {
      pbxTenantId: map.tenantId, tenantSlug: map.tenantSlug, rootPbxIvrId,
      profiles: [], schedule: null, dids: [], requiredRecordings: [], keptByDirectDial: [], directDialRestorable: [], carriedCodes: [],
      problems: [{ where: "menu", reason: `Menu ${rootPbxIvrId} isn't on the PBX any more`, pbxType: "ivr", pbxLabel: null }],
      warnings: [],
    };
  }

  const noteRecording = (ref: PbxRecordingRef | null): string | null => {
    if (!ref || ref.id == null) return null;
    const promptRef = connectPromptRef(map.tenantSlug, ref.id);
    if (!requiredRecordings.has(ref.id)) {
      requiredRecordings.set(ref.id, { recordingId: ref.id, name: ref.name ?? `Recording ${ref.id}`, promptRef, staticPath: ref.staticPath });
    }
    if (!ref.known) warnings.push(`The greeting on "${root.description}" points at recording ${ref.id}, which isn't in the PBX's recording list any more.`);
    return promptRef;
  };

  const planFor = (ivr: PbxIvr, type: string): PlannedProfile => {
    const options: PlannedOption[] = [];
    const wouldRestore: string[] = [];
    for (const opt of ivr.options) {
      if (!opt.enabled) continue;
      const digit = normalizeOptionDigit(opt.digit);
      if (!digit) {
        // Multi-digit entries are codes a caller types AT the menu, not
        // keypad options — and most of them are simply the tenant's own
        // extension numbers, which VitalPBX lists one by one.
        //
        // Connect covers exactly that case already: [connect-tenant-ivr] has
        // _XXX and _XXXX direct-dial patterns that route to
        // T<t>_cos-all,<exten>,1 — the identical target this translator emits
        // for an extension key — whenever direct dial is on. So an extension
        // shortcut is NOT lost capability and must not be reported as a
        // problem; doing so buried the 4 real issues on this estate under 92
        // false alarms and would have blocked every copy.
        //
        // Non-extension codes (PIN-style shortcuts like 0478 / 1818 /
        // 55648752, all verified non-extensions on 2026-08-03) are carried
        // over as hidden menu codes below. What IS still lost: codes outside
        // the 3–8 digit range, and extension shortcuts when direct dial
        // stays off.
        const code = String(opt.digit).trim();
        const isTenantExtension = ctx.directory.extensions.some((e) => e.number === code);
        const lengthMatchesDirectDial = code.length === 3 || code.length === 4;
        if (isTenantExtension && lengthMatchesDirectDial) {
          // Reproducible either way — the only question is whether the switch
          // is already on. ⛔ Neither branch is a `problem`: the menu the
          // operator is copying can carry these codes, and saying otherwise
          // both contradicts the row's own wording and blocks the copy.
          if (ivr.directDialEnabled) coveredByDirectDial.add(code);
          else wouldRestore.push(code);
          continue;
        }
        // A non-extension multi-digit code — DISA, straight-to-voicemail,
        // queue jumps. Measured across the estate 2026-08-24 there are 10 and
        // every one is a live feature people use. Since 2026-08-25 Connect
        // menus CARRY these: the code is stored as an option row whose
        // optionDigit is the code itself, published into the per-menu AstDB
        // family as code_<digits>/dest, and matched by [connect-menu]'s
        // _XXX.._XXXXXXXX patterns — routing to the IDENTICAL dialplan target
        // the PBX's own literal exten used. So a mappable code is a carried
        // feature now, never a `problem`.
        if (isIvrMenuCode(code)) {
          const mapped = mapPbxDestination(opt.target, ctx);
          if (mapped.ok) {
            options.push({ optionDigit: code, ...mapped.destination });
            continue;
          }
          // The code itself is fine — its TARGET is the thing we refuse to
          // guess at (deleted extension, unreadable module). Same rule as a
          // single-key option with a broken target.
          problems.push({ where: `${ivr.description} · code "${code}"`, reason: mapped.problem.reason, pbxType: mapped.problem.pbxType, pbxLabel: mapped.problem.pbxLabel });
          continue;
        }
        problems.push({
          where: `${ivr.description} · code "${code}"`,
          // Only codes OUTSIDE the dialplan's 3–8 digit pattern range (or
          // carrying non-digit characters) land here now.
          reason: `Callers can dial ${code} at this menu to jump straight through. Connect carries hidden codes of 3–8 digits, and this one falls outside that, so it won't come across.`,
          pbxType: "option",
          pbxLabel: code,
        });
        continue;
      }
      const mapped = mapPbxDestination(opt.target, ctx);
      if (!mapped.ok) {
        problems.push({ where: `${ivr.description} · key ${opt.digit}`, reason: mapped.problem.reason, pbxType: mapped.problem.pbxType, pbxLabel: mapped.problem.pbxLabel });
        continue;
      }
      options.push({ optionDigit: digit, ...mapped.destination });
    }

    const timeout = mapPbxDestination(ivr.timeoutTarget, ctx);
    const invalid = mapPbxDestination(ivr.invalidTarget, ctx);
    if (!timeout.ok && ivr.timeoutTarget) {
      problems.push({ where: `${ivr.description} · nobody presses anything`, reason: timeout.problem.reason, pbxType: timeout.problem.pbxType, pbxLabel: timeout.problem.pbxLabel });
    }
    if (!invalid.ok && ivr.invalidTarget) {
      problems.push({ where: `${ivr.description} · caller presses a wrong key`, reason: invalid.problem.reason, pbxType: invalid.problem.pbxType, pbxLabel: invalid.problem.pbxLabel });
    }

    return {
      pbxIvrId: ivr.id,
      name: ivr.description || `Menu ${ivr.id}`,
      type,
      promptRef: noteRecording(ivr.welcome),
      promptRecordingId: ivr.welcome?.id ?? null,
      // VitalPBX stores the per-iteration WaitExten timeout; Connect's field
      // means the same thing. Default to Connect's 7s when the PBX has none.
      timeoutSeconds: ivr.timeoutSec && ivr.timeoutSec > 0 ? ivr.timeoutSec : 7,
      maxRetries: ivr.invalidTries && ivr.invalidTries > 0 ? ivr.invalidTries : 3,
      directDialEnabled: ivr.directDialEnabled,
      directDialWouldRestore: wouldRestore,
      timeoutDestinationType: timeout.ok ? timeout.destination.destinationType : null,
      timeoutDestinationRef: timeout.ok ? timeout.destination.destinationRef : null,
      invalidDestinationType: invalid.ok ? invalid.destination.destinationType : null,
      invalidDestinationRef: invalid.ok ? invalid.destination.destinationRef : null,
      options,
    };
  };

  // Does this menu sit behind a time condition, or reach one through a digit?
  // Either way the hours belong to Connect once we take the menu over.
  const reachedTc = map.timeConditions.find((tc) => {
    const feedsRoot = (d: PbxDecodedDestination | null) => d?.type === "ivr" && Number(d.targetId) === rootPbxIvrId;
    if (feedsRoot(tc.matchTarget) || feedsRoot(tc.mismatchTarget)) return true;
    return root.options.some((o) => o.enabled && o.target?.type === "time_condition" && Number(o.target.targetId) === tc.id);
  }) ?? null;

  const profiles: PlannedProfile[] = [planFor(root, "business_hours")];
  let schedule: ImportPlan["schedule"] = null;

  if (reachedTc) {
    if (reachedTc.status && reachedTc.status !== "default") {
      warnings.push(
        `On the PBX, "${reachedTc.description}" is currently forced ${reachedTc.status.includes("unmatch") ? "to after-hours" : "to open"} by hand rather than following the clock. Connect will follow the clock once you go live.`,
      );
    }
    const translated = translateTimeGroup(reachedTc.timeGroup);
    warnings.push(...translated.warnings);
    schedule = {
      timezone: reachedTc.timezone || "America/New_York",
      rules: translated.rules,
      pbxTimeConditionId: reachedTc.id,
      pbxTimeConditionName: reachedTc.description,
    };

    // The two menus the condition chooses between. The open-hours one becomes
    // the business-hours profile; the closed one becomes after-hours.
    const openIvrId = reachedTc.matchTarget?.type === "ivr" ? Number(reachedTc.matchTarget.targetId) : null;
    const closedIvrId = reachedTc.mismatchTarget?.type === "ivr" ? Number(reachedTc.mismatchTarget.targetId) : null;
    for (const [id, type] of [[openIvrId, "business_hours"], [closedIvrId, "after_hours"]] as Array<[number | null, string]>) {
      if (id == null || !Number.isFinite(id) || id === rootPbxIvrId) continue;
      const ivr = ivrById(map, id);
      if (!ivr) {
        problems.push({ where: `hours rule "${reachedTc.description}"`, reason: `It points at menu ${id}, which isn't on the PBX any more`, pbxType: "ivr", pbxLabel: null });
        continue;
      }
      if (profiles.some((p) => p.pbxIvrId === id)) continue;
      profiles.push(planFor(ivr, type));
    }
    if (!closedIvrId) {
      warnings.push(`"${reachedTc.description}" doesn't send after-hours callers to a menu on the PBX, so Connect has no after-hours menu to copy. You can build one in the Studio.`);
    }
  }

  // Which DIDs reach this menu — directly, or through the time condition.
  const tcIds = new Set(reachedTc ? [reachedTc.id] : []);
  const dids = map.routes
    .map((r) => {
      if (r.target?.type === "ivr" && Number(r.target.targetId) === rootPbxIvrId) {
        return { did: r.did, description: r.description, viaTimeCondition: false };
      }
      if (r.target?.type === "time_condition" && tcIds.has(Number(r.target.targetId))) {
        return { did: r.did, description: r.description, viaTimeCondition: true };
      }
      return null;
    })
    .filter((x): x is { did: string; description: string; viaTimeCondition: boolean } => x !== null);

  if (dids.length === 0) {
    warnings.push("No phone number points at this menu today, so going live won't change what callers hear until you point one at it.");
  }

  return {
    pbxTenantId: map.tenantId,
    tenantSlug: map.tenantSlug,
    rootPbxIvrId,
    profiles,
    schedule,
    dids,
    requiredRecordings: Array.from(requiredRecordings.values()),
    keptByDirectDial: Array.from(coveredByDirectDial).sort(),
    // Roll the per-menu lists up for the screen. Built from `profiles` rather
    // than a second pass over the PBX so the two can never disagree about
    // which menus the copy is actually going to write.
    directDialRestorable: profiles
      .filter((p) => p.directDialWouldRestore.length > 0)
      .map((p) => ({ pbxIvrId: p.pbxIvrId, menu: p.name, codes: [...p.directDialWouldRestore].sort() })),
    // Derived from `profiles` (not a second pass over the PBX) for the same
    // reason as directDialRestorable: the screen and the copy can never
    // disagree about which codes are actually going to be written.
    carriedCodes: profiles
      .map((p) => ({
        pbxIvrId: p.pbxIvrId,
        menu: p.name,
        codes: p.options
          .filter((o) => isIvrMenuCode(o.optionDigit))
          .map((o) => ({ code: o.optionDigit, label: o.label }))
          .sort((a, b) => a.code.localeCompare(b.code)),
      }))
      .filter((m) => m.codes.length > 0),
    problems,
    warnings,
  };
}
