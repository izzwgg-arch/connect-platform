/**
 * IVR mode + active-menu selection — extracted from server.ts so the logic
 * that decides WHAT CALLERS HEAR is unit-testable in isolation. This exact
 * logic silently published an empty menu for months of potential decay
 * (2026-08-05: type-only matching ignored the Studio schedule's per-mode menu
 * ids) — it must never again live somewhere tests can't reach.
 */

import type { JewishCalendarSettings } from "@connect/shared";
import { evaluateJewishCalendar } from "@connect/shared";

export type IvrMode = "business" | "afterhours" | "holiday" | "override";

export interface IvrScheduleSelection {
  defaultProfileId?: string | null;
  afterHoursProfileId?: string | null;
  holidayProfileId?: string | null;
}

/** Compute the current routing mode from a schedule config + override state. */
export function computeCurrentMode(
  config: { timezone: string; businessHoursRules: any; holidayDates: any },
  override: { isActive: boolean; expiresAt: Date | null } | null,
  now: Date = new Date(),
  jewish?: JewishCalendarSettings | null,
): IvrMode {
  // 1. Manual override (check expiry)
  if (override?.isActive && (!override.expiresAt || override.expiresAt > now)) return "override";

  // 2. The Jewish calendar, if the tenant has one.
  //
  //    ⛔ THIS RUNS BEFORE THE holidayDates LIST AND IT IS AN INTERVAL, NOT A
  //    DATE. Yom tov begins at candle lighting the evening before and ends at
  //    nightfall — Rosh Hashanah on Shabbos is one 49½-hour closure across
  //    three Gregorian dates. A whole-day match leaves Friday evening
  //    answering normally, which is the bug this whole feature exists to end.
  //
  //    ⛔ It fails OPEN: switched off, past the end of the generated table, or
  //    with unusable coordinates it returns "not closed" and the ordinary
  //    weekly hours below decide. A calendar that cannot answer must never shut
  //    a working business's phone.
  if (jewish?.enabled) {
    try {
      if (evaluateJewishCalendar(jewish, now).closed) return "holiday";
    } catch {
      // Never let a calendar fault decide what callers hear.
    }
  }

  // 3. Hand-typed holiday dates — the pre-calendar mechanism, still honoured
  //    verbatim so tenants already using it are untouched.
  const tz = config.timezone || "UTC";
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now); // "YYYY-MM-DD"
  const holidays: string[] = Array.isArray(config.holidayDates) ? config.holidayDates : [];
  if (holidays.includes(localDate)) return "holiday";

  // 4. Weekly business hours — numeric day-of-week (0=Sun…6=Sat) in tenant tz
  const rules: Array<{ day: number; open: string; close: string }> =
    Array.isArray(config.businessHoursRules) ? config.businessHoursRules : [];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const dowStr = parts.find((p) => p.type === "weekday")?.value ?? "";
  const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = DOW_MAP[dowStr] ?? now.getDay();
  const hourStr  = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minStr   = parts.find((p) => p.type === "minute")?.value ?? "0";
  const minuteOfDay = parseInt(hourStr, 10) * 60 + parseInt(minStr, 10);
  const parseHHMM = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const rule = rules.find((r) => r.day === dow);
  if (rule && minuteOfDay >= parseHHMM(rule.open) && minuteOfDay < parseHHMM(rule.close)) return "business";

  return "afterhours";
}

/** Map a computeCurrentMode() result to the profile.type that should serve it. */
export function ivrModeToProfileType(mode: string): string | null {
  switch (mode) {
    case "business":   return "business_hours";
    case "afterhours": return "after_hours";
    case "holiday":    return "holiday";
    case "override":   return "manual_override";
    default:           return null;
  }
}

/** Pick the route profile that should serve the current mode.
 *
 *  The Studio's schedule config names WHICH menu serves each mode by id —
 *  that choice wins. The legacy type-based match remains as the fallback for
 *  pre-Studio tenants whose profiles are typed business_hours/after_hours/
 *  holiday. Without the id-based path, a Studio tenant (where every menu is
 *  type business_hours) published an EMPTY menu outside business hours and an
 *  arbitrary first-created menu during them — callers got the generic
 *  "one moment please" fallback instead of the configured menu.
 *
 *  A mode with no menu selected falls back toward the default menu — playing
 *  the business menu after hours beats playing nothing. Override mode falls
 *  back to an "emergency"-typed profile, matching the legacy dest_override
 *  behavior. */
/** Resolve which menu a NUMBER's didmap pointer should name right now.
 *
 *  ⛔ The per-number path in the dialplan is UNCONDITIONAL:
 *
 *    Set(DID_MENU=${DB(connect/didmap/<did>/profile_id)})
 *    Goto(connect-menu,m${DID_MENU},1)
 *
 *  The mode is never consulted there — mode-selected keys only govern the
 *  legacy no-assignment path. So a number assigned to the Main Menu played the
 *  Main Menu around the clock, and closing time changed nothing. That is the
 *  trainer's "Closed hours working, but does not have priority. Need to publish
 *  everytime store is closed" — five red rows from one cause: he was re-pointing
 *  the number by hand at every open/close because nothing else would.
 *
 *  Fixed on the API side, not the PBX: every didmap writer resolves the pointer
 *  THROUGH the mode. The number's assigned menu is its business-hours menu; off
 *  hours, the schedule's menu for the current mode wins.
 *
 *  Deliberate choices:
 *  - business mode → always the assignment. An owner who deliberately points a
 *    second number at the after-hours menu keeps that at all times of day.
 *  - a mode with no schedule menu → the assignment, NOT ivrFindActiveProfile's
 *    tenant-wide fallback chain. For an explicitly assigned number, "no closed
 *    menu chosen" must keep playing ITS menu, never drift to the tenant's
 *    first-created one.
 *  - override → a manual_override/emergency-typed menu if one exists. An
 *    emergency switch that assigned numbers ignore is the same bug again.
 *  - a substituted id must exist in `profiles`; a stale schedule id falls back
 *    to the assignment rather than pointing callers at a deleted menu.
 */
export function resolveDidmapProfileId<T extends { id?: string; type: string }>(
  assignedProfileId: string | null | undefined,
  mode: string,
  profiles: T[],
  schedule?: IvrScheduleSelection | null,
): string {
  const assigned = String(assignedProfileId ?? "").trim();
  if (!assigned) return "";
  if (mode === "business") return assigned;

  const exists = (id: string | null | undefined): string | null =>
    id && profiles.some((p) => p.id === id) ? id : null;

  if (mode === "afterhours") {
    return exists(schedule?.afterHoursProfileId) ?? assigned;
  }
  if (mode === "holiday") {
    return exists(schedule?.holidayProfileId) ?? exists(schedule?.afterHoursProfileId) ?? assigned;
  }
  if (mode === "override") {
    const p = profiles.find((x) => x.type === "manual_override") ?? profiles.find((x) => x.type === "emergency");
    return exists(p?.id) ?? assigned;
  }
  return assigned;
}

export function ivrFindActiveProfile<T extends { id?: string; type: string }>(
  mode: string,
  profiles: T[],
  schedule?: IvrScheduleSelection | null,
): T | null {
  if (schedule) {
    const byId = (id: string | null | undefined): T | null =>
      id ? profiles.find((p) => p.id === id) ?? null : null;
    if (mode === "business") {
      const p = byId(schedule.defaultProfileId);
      if (p) return p;
    } else if (mode === "afterhours") {
      const p = byId(schedule.afterHoursProfileId) ?? byId(schedule.defaultProfileId);
      if (p) return p;
    } else if (mode === "holiday") {
      const p = byId(schedule.holidayProfileId) ?? byId(schedule.afterHoursProfileId) ?? byId(schedule.defaultProfileId);
      if (p) return p;
    }
  }
  const wanted = ivrModeToProfileType(mode);
  if (!wanted) return null;
  const direct = profiles.find((p) => p.type === wanted) ?? null;
  if (direct) return direct;
  if (mode === "override") return profiles.find((p) => p.type === "emergency") ?? null;

  // ⛔ LAST RESORT: the tenant's main menu, rather than nothing.
  //
  // Without this, a brand-new customer could not go live at all. Every menu the
  // Studio creates is typed `business_hours`; a fresh tenant has no opening
  // hours set, so the mode is ALWAYS "afterhours"; the schedule has no menu
  // chosen for it yet, so the id lookup misses and the type lookup misses. The
  // publish then refuses with "no menu is selected to play right now" — a
  // deadlock that no amount of editing the MENU can clear, because the thing
  // that needs fixing is a schedule screen further down the page. Setting up
  // your first phone menu and being told you cannot use it is not a guard, it
  // is a wall.
  //
  // This can never override a deliberate choice: it only runs after BOTH the
  // schedule's per-mode ids and the type match have come back empty. So the
  // 2026-08-05 failure it must not undo — an explicit per-mode menu being
  // ignored — is structurally out of reach here.
  //
  // Playing the customer's own menu at the wrong time of day beats playing the
  // generic built-in filler, which is what "no menu" actually sounds like to a
  // caller.
  if (mode === "business" || mode === "afterhours" || mode === "holiday") {
    return profiles.find((p) => p.type === "business_hours") ?? profiles[0] ?? null;
  }
  return null;
}
