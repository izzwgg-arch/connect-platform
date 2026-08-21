import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateJewishCalendar, closureAround, treatmentForDay, musicMourningOn,
  holidayOn, isDateCovered, daysOfTableRemaining, localYmd, shiftYmd, dayOfWeek,
  DEFAULT_JEWISH_CALENDAR, TABLE_RANGE,
  type JewishCalendarSettings,
} from "./jewishCalendar";

const TZ = "America/New_York";
const on = (overrides: Partial<JewishCalendarSettings> = {}): JewishCalendarSettings =>
  ({ ...DEFAULT_JEWISH_CALENDAR, enabled: true, ...overrides });

/** An instant, given as New York wall-clock. EDT = UTC-4, EST = UTC-5. */
const et = (ymd: string, hhmm: string, offset: 4 | 5 = 4): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = ymd.split("-").map(Number);
  // Build from UTC epoch so an evening hour + offset rolls into the next day
  // instead of producing an invalid "T25:00" string.
  return new Date(Date.UTC(y, mo - 1, d, h + offset, m, 0));
};
const clock = (d: Date | null) => {
  assert.ok(d, "expected an instant");
  return d!.toLocaleString("en-CA", { timeZone: TZ, dateStyle: "short", timeStyle: "short", hour12: false });
};

// ── the table ────────────────────────────────────────────────────────────────
test("the table knows the diaspora calendar, not the Israeli one", () => {
  // The five days an Israeli calendar gets wrong. Each must be full yom tov.
  for (const d of ["2026-09-27", "2026-10-04", "2027-04-23", "2027-04-29", "2027-06-12"]) {
    assert.equal(holidayOn(d)?.kind, "yomtov", `${d} must be yom tov in the diaspora`);
  }
  // Shmini Atzeres and Simchas Torah are SEPARATE days here.
  assert.equal(holidayOn("2026-10-03")?.name, "Shmini Atzeret");
  assert.equal(holidayOn("2026-10-04")?.name, "Simchat Torah");
});

test("the table covers far enough ahead to be worth calling perpetual", () => {
  assert.ok(TABLE_RANGE[1] >= "2080-12-31", `table ends ${TABLE_RANGE[1]}`);
  assert.ok(isDateCovered("2026-09-12") && isDateCovered("2079-01-01"));
  assert.ok(!isDateCovered("2099-01-01"));
  assert.ok(daysOfTableRemaining("2026-08-21") > 365 * 50);
});

test("date helpers do not drift across a month or a DST boundary", () => {
  assert.equal(shiftYmd("2026-09-30", 1), "2026-10-01");
  assert.equal(shiftYmd("2027-01-01", -1), "2026-12-31");
  assert.equal(shiftYmd("2026-11-01", 1), "2026-11-02"); // US DST ends this day
  assert.equal(dayOfWeek("2026-09-12"), 6);              // Saturday
  assert.equal(localYmd(et("2026-09-12", "23:30"), TZ), "2026-09-12");
  // 00:30 UTC on the 13th is still the 12th in New York.
  assert.equal(localYmd(new Date("2026-09-13T00:30:00Z"), TZ), "2026-09-12");
});

// ── the headline case: one closure, three dates ──────────────────────────────
test("Rosh Hashanah on Shabbos is ONE 49½-hour closure, not three days", () => {
  const s = on();
  const c = closureAround("2026-09-12", s);
  assert.ok(c);
  assert.deepEqual(c!.days, ["2026-09-12", "2026-09-13"]);
  // Starts Friday at candle lighting, ends Sunday at nightfall.
  assert.match(clock(c!.startsAt), /^2026-09-11, 18:5/);
  assert.match(clock(c!.endsAt), /^2026-09-13, 20:2/);
  const hours = (c!.endsAt.getTime() - c!.startsAt.getTime()) / 3_600_000;
  assert.ok(hours > 49 && hours < 50, `expected ~49.5 hours, got ${hours.toFixed(1)}`);
});

test("Friday evening of that closure is CLOSED — the whole point of intervals", () => {
  const s = on();
  // 7:30pm Friday: after candle lighting, and a date-list would have missed it.
  const v = evaluateJewishCalendar(s, et("2026-09-11", "19:30"));
  assert.equal(v.closed, true);
  assert.equal(v.holidayName, "Rosh Hashana");
  assert.match(clock(v.reopensAt), /^2026-09-13, 20:2/);
});

test("Sunday morning inside that closure is still closed", () => {
  const v = evaluateJewishCalendar(on(), et("2026-09-13", "10:00"));
  assert.equal(v.closed, true);
  assert.equal(v.kind, "yomtov");
});

test("Sunday night after nightfall is open again", () => {
  const v = evaluateJewishCalendar(on(), et("2026-09-13", "21:00"));
  assert.equal(v.closed, false);
});

test("Friday afternoon before the early-close is open, and says when it shuts", () => {
  const v = evaluateJewishCalendar(on(), et("2026-09-11", "14:00"));
  assert.equal(v.closed, false);
  assert.equal(v.kind, "erev");
  assert.match(clock(v.closesAt), /^2026-09-11, 17:5/); // candles 6:54pm − 60 min
  assert.match(v.reason, /Closing early/);
});

test("between the early-close and candle lighting it is already shut", () => {
  const v = evaluateJewishCalendar(on(), et("2026-09-11", "18:15"));
  assert.equal(v.closed, true);
  assert.match(v.reason, /Closed early/);
});

// ── ordinary Shabbos ─────────────────────────────────────────────────────────
test("an ordinary Shabbos closes at candle lighting and reopens at nightfall", () => {
  const s = on();
  assert.equal(evaluateJewishCalendar(s, et("2026-10-16", "14:00")).closed, false, "Friday afternoon");
  assert.equal(evaluateJewishCalendar(s, et("2026-10-16", "18:30")).closed, true, "after candles");
  assert.equal(evaluateJewishCalendar(s, et("2026-10-17", "12:00")).closed, true, "Shabbos day");
  assert.equal(evaluateJewishCalendar(s, et("2026-10-17", "19:45")).closed, false, "after nightfall");
});

test("the Friday closing time moves with the season — the whole reason for this", () => {
  const s = on();
  const dec = evaluateJewishCalendar(s, et("2026-12-04", "12:00", 5)).closesAt;
  const jun = evaluateJewishCalendar(s, et("2027-06-25", "12:00")).closesAt;
  assert.match(clock(dec), /15:0\d$/);  // ~3:09pm — candles 4:09pm less an hour
  assert.match(clock(jun), /19:1\d$/);  // ~7:14pm
});

test("turning Shabbos off leaves it to the weekly hours", () => {
  const v = evaluateJewishCalendar(on({ closeForShabbos: false }), et("2026-10-17", "12:00"));
  assert.equal(v.closed, false);
});

// ── the other day kinds ──────────────────────────────────────────────────────
test("Chol Hamoed is open by default and settable", () => {
  const d = "2026-09-28"; // Sukkos III (CH"M)
  assert.equal(treatmentForDay(d, on()).treatment, "open");
  assert.equal(treatmentForDay(d, on({ cholHamoed: "early" })).treatment, "early");
  assert.equal(treatmentForDay(d, on({ cholHamoed: "closed" })).treatment, "closed");
});

test("fast days are open by default", () => {
  assert.equal(treatmentForDay("2026-09-14", on()).treatment, "open"); // Tzom Gedaliah
  assert.equal(treatmentForDay("2026-09-14", on({ fastDays: "closed" })).treatment, "closed");
});

test("a per-holiday override beats the blanket switch, both ways", () => {
  // Works Chol Hamoed but shuts for Purim.
  const s = on({ cholHamoed: "open", holidayOverrides: { Purim: "closed" } });
  assert.equal(treatmentForDay("2027-03-23", s).treatment, "closed");
  // A minor holiday is open unless overridden — Chanukah, for a shop that shuts.
  // ⛔ Use a WEEKDAY of Chanukah — 5 Dec 2026 is Chanukah and Shabbos, so it is
  // closed for a reason that has nothing to do with the override.
  assert.equal(treatmentForDay("2026-12-08", on()).treatment, "open");
  assert.equal(treatmentForDay("2026-12-08", on({ holidayOverrides: { Chanukah: "closed" } })).treatment, "closed");
});

test("an override that opens a yom tov still yields to Shabbos", () => {
  // 26 Sep 2026 is Sukkos I AND Shabbos. Opening Sukkos must not open Shabbos.
  const s = on({ holidayOverrides: { Sukkot: "open" } });
  const t = treatmentForDay("2026-09-26", s);
  assert.equal(t.treatment, "closed");
  assert.equal(t.kind, "shabbos");
});

// ── music mourning ───────────────────────────────────────────────────────────
test("Sefirah follows the minhag the customer picked", () => {
  const early = "2027-05-20"; // inside 16 Nissan → 17 Iyyar, before Lag BaOmer
  assert.equal(musicMourningOn(early, on({ sefirah: "early" })).noMusic, true);
  assert.equal(musicMourningOn(early, on({ sefirah: "late" })).noMusic, true);
  assert.equal(musicMourningOn(early, on({ sefirah: "none" })).noMusic, false);
  // Early minhag: music is back after Lag BaOmer; the late minhag is still on.
  const afterLag = "2027-06-01";
  assert.equal(musicMourningOn(afterLag, on({ sefirah: "early" })).noMusic, false);
  assert.equal(musicMourningOn(afterLag, on({ sefirah: "late" })).noMusic, true);
});

test("the Three Weeks and the Nine Days switch music off", () => {
  assert.equal(musicMourningOn("2027-07-25", on()).noMusic, true, "in the Three Weeks");
  assert.equal(musicMourningOn("2027-08-06", on()).noMusic, true, "in the Nine Days");
  assert.equal(musicMourningOn("2027-08-20", on()).noMusic, false, "after Tisha B'Av");
});

test("the Nine Days survive the Three Weeks being switched off", () => {
  // They are nested, so a customer who keeps only the Nine Days must still get
  // them — a naive early-return on threeWeeks=false loses that.
  const s = on({ threeWeeksNoMusic: false, nineDaysNoMusic: true });
  assert.equal(musicMourningOn("2027-07-25", s).noMusic, false, "Three Weeks only — music allowed");
  assert.equal(musicMourningOn("2027-08-06", s).noMusic, true, "Nine Days — music off");
});

test("the verdict carries the music state, and names the reason", () => {
  const v = evaluateJewishCalendar(on(), et("2027-08-06", "10:00"));
  assert.equal(v.noMusic, true);
  assert.equal(v.noMusicReason, "the Nine Days");
});

test("music mourning is independent of whether the phone is closed", () => {
  // A Tuesday in the Three Weeks: open for business, no instrumental music.
  const v = evaluateJewishCalendar(on(), et("2027-07-27", "11:00"));
  assert.equal(v.closed, false);
  assert.equal(v.noMusic, true);
});

// ── failing open ─────────────────────────────────────────────────────────────
test("switched off, the calendar says nothing at all", () => {
  const v = evaluateJewishCalendar(on({ enabled: false }), et("2026-09-12", "12:00"));
  assert.equal(v.closed, false);
  assert.equal(v.noMusic, false);
  assert.equal(v.reason, "");
});

test("past the end of the table it fails OPEN, never closed", () => {
  // A calendar that cannot answer must not shut a working business's phone.
  const v = evaluateJewishCalendar(on(), new Date("2099-09-12T16:00:00Z"));
  assert.equal(v.closed, false);
});

test("unusable coordinates fail open", () => {
  const v = evaluateJewishCalendar(on({ latitude: NaN, longitude: NaN }), et("2026-09-12", "12:00"));
  assert.equal(v.closed, false);
});

test("an unknown timezone does not throw", () => {
  assert.doesNotThrow(() => evaluateJewishCalendar(on({ timezone: "Not/AZone" }), et("2026-09-12", "12:00")));
});

test("turning the early close off removes it without affecting the closure", () => {
  const s = on({ earlyCloseMinutesBeforeCandles: 0 });
  assert.equal(evaluateJewishCalendar(s, et("2026-09-11", "18:15")).closed, false, "open right up to candles");
  assert.equal(evaluateJewishCalendar(s, et("2026-09-11", "19:30")).closed, true, "still closed after candles");
});

test("the reopen delay pushes nightfall out, and only that", () => {
  const plain = evaluateJewishCalendar(on(), et("2026-10-17", "12:00")).reopensAt!;
  const delayed = evaluateJewishCalendar(on({ reopenMinutesAfterNightfall: 30 }), et("2026-10-17", "12:00")).reopensAt!;
  assert.equal(Math.round((delayed.getTime() - plain.getTime()) / 60_000), 30);
});
