/**
 * Natural-language timing extraction for hold-music requests (owner mandate
 * 2026-07-26 #3: timed + scheduled MOH changes from chat).
 *
 * Pure and deterministic (injectable `now`), timezone-aware via Intl only —
 * no date libraries. Conservative: anything it cannot parse unambiguously
 * returns { kind: "none" } and the change is applied without a timer.
 *
 * Shapes produced:
 *   duration — "in 15 minutes", "for 2 hours"            → override expiry
 *   until    — "until 5pm", "until monday 9am"           → override expiry
 *   window   — "tomorrow from 3pm to 5pm", "on july 30 …" → one_time rule
 *   weekly   — "every friday from 3pm to 5pm"            → weekly rule
 */

export type MohTiming =
  | { kind: "none" }
  | { kind: "duration"; minutes: number; label: string }
  | { kind: "until"; endAt: Date; label: string }
  | { kind: "window"; startAt: Date; endAt: Date; label: string }
  | { kind: "weekly"; weekday: number; startTime: string; endTime: string; label: string };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Minutes-from-UTC offset of `tz` at instant `utc` (DST-correct). */
function tzOffsetMs(tz: string, utc: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  return Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second")) - utc.getTime();
}

/** Convert a wall-clock time in `tz` to the UTC instant (two-pass, DST-safe). */
export function zonedTimeToUtc(tz: string, y: number, mo: number, d: number, hh: number, mm: number): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const off = tzOffsetMs(tz, new Date(guess));
  const off2 = tzOffsetMs(tz, new Date(guess - off));
  return new Date(guess - off2);
}

/** The wall-clock components of `now` in `tz`. */
export function nowInZone(tz: string, now: Date): { y: number; mo: number; d: number; hh: number; mm: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = get("hour") === 24 ? 0 : get("hour");
  return { y: get("year"), mo: get("month"), d: get("day"), hh: hour, mm: get("minute"), dow: DOW[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? 0 };
}

interface ClockTime { hh: number; mm: number; explicitMeridiem: boolean }

/** "3pm" / "3:30" / "15:00" / "3" → 24h clock. No meridiem + hour 1–7 ⇒ PM. */
function parseClock(raw: string, defaultMeridiem?: "am" | "pm"): ClockTime | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (hh > 23 || mm > 59) return null;
  const mer = m[3] ? (m[3].startsWith("p") ? "pm" : "am") : defaultMeridiem;
  if (mer === "pm" && hh >= 1 && hh <= 11) hh += 12;
  else if (mer === "am" && hh === 12) hh = 0;
  else if (!mer && hh >= 1 && hh <= 7) hh += 12; // "from 3 to 5" ⇒ afternoon
  return { hh, mm, explicitMeridiem: !!m[3] };
}

const TIME_TOKEN = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?`;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Resolve a date phrase to {y,mo,d} in tz. Returns null when unrecognized. */
function parseDayPhrase(phrase: string, tz: string, now: Date): { y: number; mo: number; d: number } | null {
  const t = phrase.trim().toLowerCase();
  const z = nowInZone(tz, now);
  const addDays = (n: number) => {
    const base = new Date(Date.UTC(z.y, z.mo - 1, z.d + n));
    return { y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate() };
  };
  if (t === "today" || t === "tonight") return addDays(0);
  if (t === "tomorrow") return addDays(1);
  const wd = WEEKDAYS.findIndex((w) => t === w || t === `this ${w}` || t === `next ${w}` || t === `on ${w}`);
  if (wd >= 0) {
    let delta = (wd - z.dow + 7) % 7;
    if (delta === 0 && !t.startsWith("next")) delta = 0; // today, if the time is still ahead — caller adjusts
    else if (delta === 0) delta = 7;
    if (t.startsWith("next") && delta < 7) delta += 0; // "next friday" = the coming friday (colloquial)
    return addDays(delta);
  }
  // "july 30" / "july 30th" / "30 july"
  let m = t.match(/^(?:on\s+)?([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m && MONTHS[m[1]]) {
    const mo = MONTHS[m[1]]; const d = Number(m[2]);
    if (d >= 1 && d <= 31) {
      const y = mo < z.mo || (mo === z.mo && d < z.d) ? z.y + 1 : z.y;
      return { y, mo, d };
    }
  }
  m = t.match(/^(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/);
  if (m && MONTHS[m[2]]) {
    const mo = MONTHS[m[2]]; const d = Number(m[1]);
    if (d >= 1 && d <= 31) {
      const y = mo < z.mo || (mo === z.mo && d < z.d) ? z.y + 1 : z.y;
      return { y, mo, d };
    }
  }
  // "7/30" / "7-30" (US month/day)
  m = t.match(/^(?:on\s+)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const mo = Number(m[1]); const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = m[3] ? Number(m[3]) : mo < z.mo || (mo === z.mo && d < z.d) ? z.y + 1 : z.y;
      if (y < 100) y += 2000;
      return { y, mo, d };
    }
  }
  return null;
}

const DAY_PHRASE = String.raw`today|tonight|tomorrow|(?:this\s+|next\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|[a-z]+\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[a-z]+|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?`;

function fmtClock(c: ClockTime): string {
  const h12 = c.hh % 12 === 0 ? 12 : c.hh % 12;
  const mer = c.hh < 12 ? "AM" : "PM";
  return `${h12}${c.mm ? `:${String(c.mm).padStart(2, "0")}` : ""} ${mer}`;
}

/** Spelled-out counts clients actually type ("for twenty minutes" — live 2026-07-27). */
const WORD_NUMS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  "twenty-five": 25, "twenty five": 25, "forty-five": 45, "forty five": 45,
};
const WORD_NUM_ALT = Object.keys(WORD_NUMS).sort((a, b) => b.length - a.length).join("|");

function durationToMinutes(numRaw: string, unit: string): number | null {
  const w = WORD_NUMS[numRaw.trim()];
  const n =
    w != null ? w : numRaw === "a" || numRaw === "an" ? 1 : numRaw === "half an" || numRaw === "half a" ? 0.5 : Number(numRaw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const isHours = /^h/.test(unit);
  return Math.max(1, Math.round(isHours ? n * 60 : n));
}

/**
 * Extract timing from a hold-music request. `tz` is the tenant's schedule
 * timezone. Precedence: weekly ("every …") → window (day + time range) →
 * until → duration → none.
 */
export function parseMohTiming(text: string, tz: string, now: Date = new Date()): MohTiming {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const z = nowInZone(tz, now);

  // ── weekly: "every friday from 3pm to 5pm" / "every friday 3-5pm" ──
  {
    const m = t.match(
      new RegExp(String.raw`\bevery\s+(${WEEKDAYS.join("|")})s?\b.*?(?:from\s+)?(${TIME_TOKEN})\s*(?:to|until|till|through|-|–)\s*(${TIME_TOKEN})`),
    );
    if (m) {
      const weekday = WEEKDAYS.indexOf(m[1]);
      const end = parseClock(m[3]);
      const start = end ? parseClock(m[2], end.explicitMeridiem && end.hh >= 12 ? "pm" : undefined) : null;
      if (start && end && (end.hh * 60 + end.mm) > (start.hh * 60 + start.mm)) {
        const hhmm = (c: ClockTime) => `${String(c.hh).padStart(2, "0")}:${String(c.mm).padStart(2, "0")}`;
        return {
          kind: "weekly", weekday, startTime: hhmm(start), endTime: hhmm(end),
          label: `every ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} from ${fmtClock(start)} to ${fmtClock(end)}`,
        };
      }
    }
  }

  // ── window: "<day> from 3pm to 5pm" / "on july 30 at 3pm until 5pm" ──
  {
    const m = t.match(
      new RegExp(String.raw`\b(?:on\s+)?(${DAY_PHRASE})\b[^\d]{0,40}?(?:from|at|between)\s+(${TIME_TOKEN})\s*(?:to|until|till|through|and|-|–)\s*(${TIME_TOKEN})`),
    );
    if (m) {
      const day = parseDayPhrase(m[1], tz, now);
      const end = parseClock(m[3]);
      const start = end ? parseClock(m[2], end.explicitMeridiem && end.hh >= 12 ? "pm" : undefined) : null;
      if (day && start && end) {
        let startAt = zonedTimeToUtc(tz, day.y, day.mo, day.d, start.hh, start.mm);
        let endAt = zonedTimeToUtc(tz, day.y, day.mo, day.d, end.hh, end.mm);
        // Weekday phrase resolving to "today" with a start already past ⇒ next week.
        if (endAt.getTime() <= now.getTime() && WEEKDAYS.some((w) => m[1].includes(w))) {
          startAt = new Date(startAt.getTime() + 7 * 86400_000);
          endAt = new Date(endAt.getTime() + 7 * 86400_000);
        }
        if (endAt.getTime() > startAt.getTime() && endAt.getTime() > now.getTime()) {
          return {
            kind: "window", startAt, endAt,
            label: `${m[1]} from ${fmtClock(start)} to ${fmtClock(end)} (${day.mo}/${day.d})`,
          };
        }
      }
    }
    // time range with no day phrase ⇒ today: "from 3pm to 5pm" / "at 3pm until 5pm"
    const m2 = t.match(new RegExp(String.raw`\b(?:from|between|at)\s+(${TIME_TOKEN})\s*(?:to|until|till|through|and|-|–)\s*(${TIME_TOKEN})`));
    if (m2) {
      const end = parseClock(m2[2]);
      const start = end ? parseClock(m2[1], end.explicitMeridiem && end.hh >= 12 ? "pm" : undefined) : null;
      if (start && end) {
        let startAt = zonedTimeToUtc(tz, z.y, z.mo, z.d, start.hh, start.mm);
        let endAt = zonedTimeToUtc(tz, z.y, z.mo, z.d, end.hh, end.mm);
        if (endAt.getTime() <= now.getTime()) {
          startAt = new Date(startAt.getTime() + 86400_000);
          endAt = new Date(endAt.getTime() + 86400_000);
        }
        if (endAt.getTime() > startAt.getTime()) {
          return { kind: "window", startAt, endAt, label: `from ${fmtClock(start)} to ${fmtClock(end)}` };
        }
      }
    }
  }

  // ── until: "until 5pm" / "until monday 9am" / "until tomorrow" ──
  {
    const m = t.match(new RegExp(String.raw`\b(?:until|till|til)\s+(?:(${DAY_PHRASE})\s+)?(?:at\s+)?(${TIME_TOKEN})\b`))
      ?? null;
    if (m) {
      const clock = parseClock(m[2]);
      if (clock) {
        const day = m[1] ? parseDayPhrase(m[1], tz, now) : { y: z.y, mo: z.mo, d: z.d };
        if (day) {
          let endAt = zonedTimeToUtc(tz, day.y, day.mo, day.d, clock.hh, clock.mm);
          if (!m[1] && endAt.getTime() <= now.getTime()) endAt = new Date(endAt.getTime() + 86400_000);
          if (endAt.getTime() > now.getTime()) {
            return { kind: "until", endAt, label: `until ${m[1] ? `${m[1]} ` : ""}${fmtClock(clock)}` };
          }
        }
      }
    }
    const md = t.match(new RegExp(String.raw`\b(?:until|till|til)\s+(${DAY_PHRASE})\b`));
    if (md) {
      const day = parseDayPhrase(md[1], tz, now);
      if (day) {
        // "until monday" ⇒ monday 9am local (start of business).
        const endAt = zonedTimeToUtc(tz, day.y, day.mo, day.d, 9, 0);
        if (endAt.getTime() > now.getTime()) return { kind: "until", endAt, label: `until ${md[1]} 9 AM` };
      }
    }
  }

  // ── duration: "in 15 minutes" / "for 2 hours" / "for an hour" ──
  {
    const m = t.match(
      new RegExp(String.raw`\b(?:in|for|after)\s+(?:the next\s+)?(\d+(?:\.\d+)?|an?|half an|half a|${WORD_NUM_ALT})\s*(minutes?|mins?|min\b|hours?|hrs?|hr\b)\b`),
    );
    if (m) {
      const minutes = durationToMinutes(m[1], m[2]);
      if (minutes != null) {
        const label = minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
        return { kind: "duration", minutes, label };
      }
    }
  }

  return { kind: "none" };
}
