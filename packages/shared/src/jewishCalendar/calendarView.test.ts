import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMonthView, buildHolidaySpans, nextChange } from "./calendarView";
import { DEFAULT_JEWISH_CALENDAR, type JewishCalendarSettings } from "./jewishCalendar";
import { holidayDisplayName, holidayNamePair, isCommonHoliday, normaliseHolidayKey } from "./holidayNames";

const on = (o: Partial<JewishCalendarSettings> = {}): JewishCalendarSettings =>
  ({ ...DEFAULT_JEWISH_CALENDAR, enabled: true, ...o });

// ── the approved names ───────────────────────────────────────────────────────
test("the Yiddish Labs round trip is what shows on screen", () => {
  assert.equal(holidayDisplayName("Sukkot"), "Succos");
  assert.equal(holidayDisplayName("Shavuot"), "Shavuos");
  assert.equal(holidayDisplayName("Simchat Torah"), "Simchas Torah");
  assert.equal(holidayDisplayName("Shmini Atzeret"), "Shemini Atzeres");
  assert.equal(holidayDisplayName("Shabbat"), "Shabbos");
});

test("Yiddish returns Hebrew script, English does not", () => {
  assert.match(holidayDisplayName("Sukkot", "yi"), /[֐-׿]/);
  assert.doesNotMatch(holidayDisplayName("Sukkot", "en"), /[֐-׿]/);
});

test("the human overrides survived — Yom Tov is not the machine's answer", () => {
  // The round trip translated it literally, to "Good day". If this ever reads
  // that again, the table has been regenerated from the machine output.
  assert.equal(holidayDisplayName("Yom Tov"), "Yom Tov");
  assert.equal(holidayDisplayName("Nightfall"), "Nightfall");
});

test("apostrophe style does not lose a name", () => {
  // The approved set uses a curly apostrophe, the generated table a straight one.
  assert.ok(holidayNamePair("Ta'anit Esther"), "straight apostrophe must match");
  assert.ok(holidayNamePair("Ta’anit Esther"), "curly apostrophe must match");
  assert.equal(normaliseHolidayKey("Tish’a B’Av"), "Tish'a B'Av");
});

test("an untranslated holiday falls back to English, never a guess", () => {
  assert.equal(holidayNamePair("Chag HaBanot"), null);
  assert.equal(holidayDisplayName("Chag HaBanot", "yi"), "Chag HaBanot");
});

test("the settings list hides the obscure days the table still carries", () => {
  assert.ok(isCommonHoliday("Purim") && isCommonHoliday("Pesach"));
  assert.ok(!isCommonHoliday("Chag HaBanot") && !isCommonHoliday("Rosh Hashana LaBehemot"));
});

// ── month view ───────────────────────────────────────────────────────────────
test("the month grid says what the phone does on each day", () => {
  const days = buildMonthView(2026, 9, on());
  assert.equal(days.length, 30);
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));

  assert.match(byDate["2026-09-12"].verdict, /^Closed/);          // Rosh Hashanah
  assert.equal(byDate["2026-09-12"].label, "Rosh Hashanah");
  assert.match(byDate["2026-09-21"].verdict, /^Closed/);          // Yom Kippur
  assert.equal(byDate["2026-09-28"].verdict, "Normal hours");     // Chol Hamoed, open
  assert.match(byDate["2026-09-11"].verdict, /Closing early/);    // erev Rosh Hashanah
  assert.ok(byDate["2026-09-11"].candleLighting, "erev must carry a candle time");
});

test("Shabbos is labelled even though no holiday row exists for it", () => {
  const byDate = Object.fromEntries(buildMonthView(2026, 10, on()).map((d) => [d.date, d]));
  assert.equal(byDate["2026-10-17"].kind, "shabbos");
  assert.equal(byDate["2026-10-17"].label, "Shabbos");
  assert.match(byDate["2026-10-17"].verdict, /^Closed/);
});

test("the grid follows the language without changing anything else", () => {
  const en = buildMonthView(2026, 10, on(), { lang: "en" });
  const yi = buildMonthView(2026, 10, on(), { lang: "yi" });
  assert.equal(en.length, yi.length);
  for (let i = 0; i < en.length; i++) {
    // ⛔ The LABEL and the VERDICT both carry the holiday name, so both change
    // language. Everything factual — the date, the times — must not.
    assert.equal(en[i].date, yi[i].date);
    assert.equal(en[i].candleLighting, yi[i].candleLighting);
    assert.equal(en[i].nightfall, yi[i].nightfall);
    assert.equal(en[i].treatment, yi[i].treatment);
    assert.equal(en[i].noMusic, yi[i].noMusic);
  }
  const st = yi.find((d) => d.date === "2026-10-04")!;
  assert.match(st.label!, /[֐-׿]/);
});

test("music mourning shows on the grid", () => {
  const days = buildMonthView(2027, 8, on());   // August 2027 holds the Nine Days
  assert.ok(days.some((d) => d.noMusic && d.noMusicReason === "the Nine Days"));
});

// ── holiday list ─────────────────────────────────────────────────────────────
test("the list merges consecutive days into one holiday", () => {
  const spans = buildHolidaySpans("2026-09-01", on(), { months: 2 });
  const rh = spans.find((x) => x.key === "Rosh Hashana")!;
  assert.equal(rh.dayCount, 2);
  assert.equal(rh.firstDay, "2026-09-12");
  assert.equal(rh.lastDay, "2026-09-13");
  assert.equal(rh.label, "Rosh Hashanah");
  assert.match(rh.note!, /2 days/);
  assert.match(rh.note!, /Shabbos/);            // it falls on Shabbos in 5787
  assert.ok(rh.startsAt && rh.endsAt, "a closed span carries its instants");
});

test("Shmini Atzeres and Simchas Torah are SEPARATE rows — the diaspora tell", () => {
  const spans = buildHolidaySpans("2026-09-01", on(), { months: 2 });
  const keys = spans.map((s) => s.key);
  assert.ok(keys.includes("Shmini Atzeret"));
  assert.ok(keys.includes("Simchat Torah"));
});

test("Chol Hamoed is its own row, so closing Sukkos does not close all nine days", () => {
  const spans = buildHolidaySpans("2026-09-01", on(), { months: 2 });
  const sukkos = spans.filter((x) => x.key === "Sukkot");
  assert.equal(sukkos.length, 2, "yom tov days and chol hamoed are separate rows");
  assert.equal(sukkos[0].kind, "yomtov");
  assert.equal(sukkos[0].dayCount, 2);
  assert.equal(sukkos[1].kind, "cholhamoed");
});

test("the list covers a year and stays to the holidays a business cares about", () => {
  const spans = buildHolidaySpans("2026-09-01", on(), { months: 12 });
  const keys = new Set(spans.map((s) => s.key));
  for (const must of ["Rosh Hashana", "Yom Kippur", "Pesach", "Shavuot", "Purim", "Chanukah"]) {
    assert.ok(keys.has(must), `${must} must be in the year ahead`);
  }
  assert.ok(!keys.has("Chag HaBanot"), "obscure days stay out of the settings list");
});

test("an override is flagged on the row that carries it", () => {
  const spans = buildHolidaySpans("2026-09-01", on({ holidayOverrides: { Purim: "closed" } }), { months: 12 });
  const purim = spans.find((x) => x.key === "Purim")!;
  assert.equal(purim.overridden, true);
  assert.equal(purim.treatment, "closed");
  assert.equal(spans.find((x) => x.key === "Chanukah")!.overridden, false);
});

// ── what happens next ────────────────────────────────────────────────────────
test("the next change is the early close, then the reopening", () => {
  const s = on();
  const before = nextChange(s, new Date("2026-09-11T14:00:00Z"))!;   // 10am ET Friday
  assert.match(before.what, /Closing early/);
  const during = nextChange(s, new Date("2026-09-12T16:00:00Z"))!;   // Shabbos/yom tov
  assert.match(during.what, /reopening/);
});

test("with the calendar off there is nothing to report", () => {
  assert.equal(nextChange(on({ enabled: false }), new Date("2026-09-11T14:00:00Z")), null);
});

test("the verdict speaks the same name as the label", () => {
  // ⛔ Caught by probing the live route: the cell said "Succos" while the verdict
  // beside it said "Closed — Sukkot", because the resolver works in the table's
  // raw hebcal keys and the verdict was built straight from them.
  const byDate = Object.fromEntries(buildMonthView(2026, 9, on()).map((d) => [d.date, d]));
  const sukkos = byDate["2026-09-27"];
  assert.equal(sukkos.label, "Succos");
  assert.match(sukkos.verdict, /Succos/, `verdict should say Succos: ${sukkos.verdict}`);
  assert.doesNotMatch(sukkos.verdict, /Sukkot/, "the raw hebcal name must not reach the screen");

  const erev = byDate["2026-09-11"];
  assert.match(erev.verdict, /Rosh Hashanah/, `erev verdict: ${erev.verdict}`);
});

test("in Yiddish the verdict carries the Yiddish name too", () => {
  const byDate = Object.fromEntries(buildMonthView(2026, 9, on(), { lang: "yi" }).map((d) => [d.date, d]));
  assert.match(byDate["2026-09-27"].verdict, /[֐-׿]/, "the verdict should carry Hebrew script");
});
