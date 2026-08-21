/**
 * Loading a tenant's Jewish calendar, and turning the stored row into the pure
 * settings object the shared resolver takes.
 *
 * ⛔ ONE LOADER, ONE MAPPER. `computeCurrentMode` is called from five places in
 * server.ts; every one of them has to hand it the same calendar or the menu the
 * sweep publishes will disagree with the menu the publish route computes. That
 * exact shape of bug — two paths, one fixed — is what shipped the IVR publish
 * half-broken in August, so the loader lives here rather than inline.
 *
 * ⛔ The timezone comes from the SCHEDULE row, not the calendar row: a tenant has
 * one timezone and it already lives on IvrScheduleConfig / MohScheduleConfig.
 * Storing a second copy is how the two drift.
 */
import {
  DEFAULT_JEWISH_CALENDAR,
  type JewishCalendarSettings,
  type SefirahMinhag,
  type DayTreatment,
  type NightfallShita,
} from "@connect/shared";

/** The row as stored, loosely typed so a stale generated client cannot break a call site. */
export interface JewishCalendarRow {
  enabled?: boolean | null;
  latitude?: number | null;
  longitude?: number | null;
  nightfallShita?: string | null;
  candleLightingMinutes?: number | null;
  closeForShabbos?: boolean | null;
  closeForYomTov?: boolean | null;
  earlyCloseMinutesBeforeCandles?: number | null;
  reopenMinutesAfterNightfall?: number | null;
  reopenNextMorning?: boolean | null;
  cholHamoed?: string | null;
  fastDays?: string | null;
  holidayOverrides?: unknown;
  sefirah?: string | null;
  threeWeeksNoMusic?: boolean | null;
  nineDaysNoMusic?: boolean | null;
  acappellaMohProfileId?: string | null;
}

const SHITOS = new Set<NightfallShita>(["satmar", "chabad", "rmoshe", "medium"]);
const TREATMENTS = new Set<DayTreatment>(["open", "early", "closed"]);
const MINHAGIM = new Set<SefirahMinhag>(["none", "early", "late", "whole"]);

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

/**
 * Row + timezone → the settings the resolver takes.
 *
 * ⛔ Every field falls back to the shared default rather than trusting the row.
 * A junk string in `nightfallShita` must not throw and must not silently pick
 * the EARLIEST opinion — it falls back to Satmar, which is the safe direction.
 */
export function toJewishCalendarSettings(
  row: JewishCalendarRow | null | undefined,
  timezone: string,
): JewishCalendarSettings {
  const d = DEFAULT_JEWISH_CALENDAR;
  if (!row) return { ...d, enabled: false, timezone: timezone || d.timezone };

  const shita = String(row.nightfallShita ?? "") as NightfallShita;
  const chol = String(row.cholHamoed ?? "") as DayTreatment;
  const fast = String(row.fastDays ?? "") as DayTreatment;
  const sefirah = String(row.sefirah ?? "") as SefirahMinhag;

  let overrides: Record<string, DayTreatment> = {};
  const raw = row.holidayOverrides;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const t = String(v ?? "") as DayTreatment;
      if (TREATMENTS.has(t)) overrides[k] = t;
    }
  }

  return {
    enabled: bool(row.enabled, false),
    latitude: num(row.latitude, d.latitude),
    longitude: num(row.longitude, d.longitude),
    timezone: timezone || d.timezone,
    nightfallShita: SHITOS.has(shita) ? shita : d.nightfallShita,
    candleLightingMinutes: num(row.candleLightingMinutes, d.candleLightingMinutes),
    closeForShabbos: bool(row.closeForShabbos, d.closeForShabbos),
    closeForYomTov: bool(row.closeForYomTov, d.closeForYomTov),
    earlyCloseMinutesBeforeCandles: Math.max(0, num(row.earlyCloseMinutesBeforeCandles, d.earlyCloseMinutesBeforeCandles)),
    reopenMinutesAfterNightfall: Math.max(0, num(row.reopenMinutesAfterNightfall, d.reopenMinutesAfterNightfall)),
    reopenNextMorning: bool(row.reopenNextMorning, d.reopenNextMorning),
    cholHamoed: TREATMENTS.has(chol) ? chol : d.cholHamoed,
    fastDays: TREATMENTS.has(fast) ? fast : d.fastDays,
    holidayOverrides: overrides,
    sefirah: MINHAGIM.has(sefirah) ? sefirah : d.sefirah,
    threeWeeksNoMusic: bool(row.threeWeeksNoMusic, d.threeWeeksNoMusic),
    nineDaysNoMusic: bool(row.nineDaysNoMusic, d.nineDaysNoMusic),
  };
}

/**
 * Load one tenant's calendar. Returns settings with `enabled:false` when there
 * is no row, when the table is missing, or on any read error — so a database
 * hiccup can never close a customer's phone.
 *
 * ⛔ Deliberately NOT `.catch(() => null)` into a truthy default. Failing toward
 * "no calendar" is the safe direction here, and it is the opposite of the
 * fail-open rule for security gates — this gate decides whether to CLOSE.
 */
export async function loadJewishCalendar(
  db: any, tenantId: string, timezone: string,
): Promise<JewishCalendarSettings> {
  try {
    const row = await db?.tenantJewishCalendar?.findUnique?.({ where: { tenantId } });
    return toJewishCalendarSettings(row ?? null, timezone);
  } catch {
    return toJewishCalendarSettings(null, timezone);
  }
}
